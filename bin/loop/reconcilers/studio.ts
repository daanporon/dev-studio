// reconcilers/studio.ts — U261: one `studio.adopt` card while the project's running Studio has no
// adopted terminal (bin/loop/squad/studio.ts adopts it in the Orca observer). The Studio's worktree is live
// but no single terminal there runs the Studio's agent outside a `ds-loop …` pane: none, or several
// alike. The loop then reads and types into none of them; the card names the terminals so the
// operator can close the extra one (or start the Studio). One card per Studio worktree however the
// terminals change while it stands; adopted (or the worktree gone), the card is cleared.
//
// elsewhere-no-other-work U1: the Studio's reload (reloadStudio below). decide.ts skips role studio, so
// a reload wish on the `_studio` member (update-squads writes one after an update that needs reload or
// restart) is typed here, the way compaction.ts types the Studio's /compact: through wake() into the
// adopted handle only, and only while studioReady() holds. A session adopted after reload_at satisfies
// the wish without an ack, as decide.ts's fresh process start does for a member.
//
// studio-hung-agent-broken U2: the operator's Restart Studio (restartStudio below). The broken Studio's card
// (liveness.ts) answered "Restart Studio" leaves an open studio:restart-approved (fulfil/studio.ts dismiss); it
// becomes exactly one studio-move, why "restart", on the Studio's own agent, account, model and effort, which
// skips studioReady() (fulfil/studio.ts move). The move ends the approval whatever comes of it; one that no
// longer fits (no adopted handle, or not the terminal the card named) is ended with no move. The loop files
// this move only on that answer, never on its own.
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import { quote } from "../pause/pause.ts";
import { wake } from "../pause/wake.ts";
import { MOVE, RESTART_APPROVED, START_WANTED, STUDIO_SQUAD, studioReady, studioView, type StartPick } from "../squad/studio.ts";
import { alertAction } from "./alerts.ts";

const KEY = "studio.adopt";

export function adoptCard(ctx: TickCtx): Action[] {
  const { store, project } = ctx;
  const v = studioView(store, project);
  const sent = store.get("episodes", { project, subject: KEY, kind: "action:alert" });
  const done = store.get("episodes", { project, subject: KEY, kind: "action:alert-clear" });
  const standing = typeof sent?.episode_key === "string" && done?.episode_key !== `cleared@${sent.episode_key}`;
  const live = !!v && !!store.db.query("SELECT 1 FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, v.wt);
  const held = !!v?.member?.handle && v.candidates.some((t) => t.handle === v.member!.handle);
  if (!v || !live || held) {
    if (!standing) return [];
    return [{ project, squad: null, member: v?.wt ?? null, subject: KEY, kind: "alert-clear", episode: `cleared@${sent!.episode_key}`,
      payload: { target: "project", prefix: `sweep-${KEY}-` } }];
  }
  if (standing) return [];
  // A cleared episode is over: losing the Studio again is a new one.
  const episode = done ? `adopt|${v.wt}|${done.started_at}` : `adopt|${v.wt}`;
  const name = (t: { handle: string; title: string | null; identity: string | null }) => `${t.handle} (${t.title ?? "untitled"}${t.identity ? `, ${t.identity}` : ""})`;
  const text = v.candidates.length > 1
    ? `The Studio worktree runs ${v.candidates.length} ${v.agent} terminals: ${v.candidates.map(name).join(", ")} — the loop adopts none of them and types into none; close the extra one`
    : `No ${v.agent} terminal outside a ds-loop pane in the Studio worktree${v.terms.length ? ` (terminals: ${v.terms.map(name).join(", ")})` : " (no terminals)"} — the loop has no Studio terminal to track; start the Studio there`;
  return alertAction(store, { project, squad: null, key: KEY, episode, title: "Studio terminal not adopted", text,
    option: "done — one Studio terminal runs", why: "the loop only tracks the one Studio terminal it can tell apart" });
}

// The reload line typed into the Studio: its own two instruction files (no roles/studio.md, no role
// children), ending with the ack command that names the Studio member, as reloadText (decide.ts) does.
export function studioReloadText(store: Store, project: string): string {
  const cmd = `DS_STATE_ROOT=${quote(store.root)} ${[`${ROOT}/bin/ds`, "reload", "ack", project, STUDIO_SQUAD, "studio", "-"].map(quote).join(" ")}`;
  return `dev-studio reload: re-read ${ROOT}/AGENTS.md and ${ROOT}/studio/studio.md, then continue. This is not worker_done. ` +
    `Confirm ONLY from this terminal with: ${cmd}`;
}

// When the Studio session in `handle` was adopted: the newest studio_adopted or studio_moved event that
// gave the member this handle (a Studio that quits to a shell is let go, so a re-adoption is a new session).
export function adoptedAt(store: Store, project: string, handle: string): number {
  const r = store.db.query(`SELECT MAX(at) AS at FROM events WHERE kind IN ('studio_adopted', 'studio_moved') AND project = ? AND squad = ?
    AND json_extract(payload, '$.handle') = ?`).get(project, STUDIO_SQUAD, handle) as { at: number | null } | null;
  return Number(r?.at ?? 0);
}

export function reloadStudio(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx;
  const v = studioView(store, project), m = v?.member as Row | null | undefined;
  if (!v || !m || m.status === "gone") return [];
  const at = Number(m.reload_at ?? 0);
  if (!at || Number(m.reloaded_at ?? 0) >= at) return [];
  const handle = (m.handle as string | null) || null;
  if (!handle) return [];
  const adopted = adoptedAt(store, project, handle);
  if (adopted > at) { store.setIf("members", Number(m.id), "reloaded_at", adopted, m.reloaded_at ?? null); return []; }
  if (!studioReady(store, project, now).ready) return [];
  return wake(ctx, v.wt, studioReloadText(store, project), "reload", `reload:${at}`, { handle }).actions;
}

export function restartStudio(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx;
  const key = { project, subject: MOVE, kind: RESTART_APPROVED };
  const ok = store.get("episodes", key);
  if (!ok || ok.ended_at != null) return [];
  // A move already claimed (a limit move, or this restart) settles first.
  const claim = store.get("episodes", { project, subject: MOVE, kind: "action:studio-move" });
  if (claim && claim.ended_at == null && ["pending", "acted", "running"].includes(String(claim.state))) return [];
  const v = studioView(store, project), m = v?.member as Row | null | undefined, handle = (m?.handle as string | null) || null;
  const named = (ok.result as string | null) || null, episode = `restart|${handle}@${ok.started_at}`;
  // This restart's own claim already ended (a move the actuator gave up on ends without move()'s own end): try once.
  const tried = claim?.episode_key === episode && claim.ended_at != null;
  if (tried || !v || !m || m.status === "gone" || !handle || (named && named !== handle)) {
    store.upsert("episodes", key, { ended_at: now, state: "ended", observed_at: now });
    return [];
  }
  const agent = String(m.agent || v.agent), account = String(m.account || "-");
  return [{ project, squad: null, member: v.wt, subject: MOVE, kind: "studio-move", episode,
    payload: { handle, agent, account, model: String(m.model || "-"), effort: String(m.effort || "-"), from: `${agent}:${account}`, why: "restart" } }];
}

// U53 (project-start): `ds up`'s first start of the Studio (START_WANTED, squad/studio.ts wantStudioStart) becomes
// exactly one studio-move, why "start", on the pick the wish holds: no tab to close, no studioReady() guard. It
// waits while the project's Studio worktree is not known yet or another move is claimed; a Studio already running
// there (a held handle, or a candidate terminal), or this start's own claim ended, ends the wish with no move.
export function startStudio(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx;
  const key = { project, subject: MOVE, kind: START_WANTED };
  const w = store.get("episodes", key);
  if (!w || w.ended_at != null) return [];
  const claim = store.get("episodes", { project, subject: MOVE, kind: "action:studio-move" });
  if (claim && claim.ended_at == null && ["pending", "acted", "running"].includes(String(claim.state))) return [];
  const v = studioView(store, project);
  if (!v) return [];
  const episode = String(w.episode_key ?? `start@${w.started_at}`);
  const tried = claim?.episode_key === episode && claim.ended_at != null;
  const running = (!!v.member?.handle && v.candidates.some((t) => t.handle === v.member!.handle)) || v.candidates.length > 0;
  if (tried || running) {
    store.upsert("episodes", key, { ended_at: now, state: running ? "running" : "ended", observed_at: now });
    return [];
  }
  let pick: StartPick = {};
  try { const o = JSON.parse(String(w.result ?? "{}")); if (o && typeof o === "object") pick = o; } catch { /* no pick: the defaults */ }
  const agent = v.agent, account = pick.account || "-";
  return [{ project, squad: null, member: v.wt, subject: MOVE, kind: "studio-move", episode,
    payload: { agent, account, model: pick.model || "-", effort: pick.effort || "-", from: `${agent}:${account}`, why: "start" } }];
}

export default { name: "studio", run: (ctx: TickCtx) => [...adoptCard(ctx), ...reloadStudio(ctx), ...restartStudio(ctx), ...startStudio(ctx)] } satisfies Reconciler;
