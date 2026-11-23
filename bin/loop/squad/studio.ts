// studio.ts — U261: the project's running Studio as a loop member (squad `_studio`, role `studio`).
//
// The operator starts the Studio; the loop only adopts it. Every Orca observer tick looks at the
// terminals Orca lists in the project's Studio worktree (observed_terminals) and records ONE of them
// on the member row (members.handle): a recorded handle that is still listed wins; otherwise the one
// terminal whose agent is the Studio's (the projects doc's `studio_agent`, default claude) and whose
// title is not a `ds-loop …` pane. None or several: nothing is adopted and reconcilers/studio.ts shows
// one `studio.adopt` card naming the terminals. A handle Orca no longer lists is cleared, and the
// next tick searches again.
//
// The recorded handle is the only Studio terminal the loop may read or type into (R14): no other
// terminal in that worktree, and never by worktree id (agent_terminal would pick any of them).
// studioReady() is the guard every typing path into the Studio must pass first.
import { memberReady, type Ready } from "./member-ready.ts";
import type { Row, Store } from "../core/store.ts";

export const STUDIO_SQUAD = "_studio";
// U264: the subject of a Studio move's episodes and cards (reconcilers/limits.ts, fulfil/studio.ts).
export const MOVE = "studio.move";
// studio-hung-agent-broken U2: the broken Studio's card (reconcilers/liveness.ts) and its answers. "Restart Studio"
// records RESTART_APPROVED (fulfil/studio.ts dismiss), which reconcilers/studio.ts turns into one studio-move, why "restart".
export const STUDIO_CARD_TITLE = "Studio not responding";
export const RESTART_STUDIO = "Restart Studio";
export const STUDIO_FINE = "It's fine";
export const RESTART_APPROVED = "studio:restart-approved";

export type StudioTerm = { handle: string; title: string | null; identity: string | null };
export type StudioView = { wt: string; agent: string; member: Row | null; terms: StudioTerm[]; candidates: StudioTerm[]; recorded: string | null };

const parse = (s: unknown): Row => { try { const o = JSON.parse(String(s ?? "")); return o && typeof o === "object" ? o : {}; } catch { return {}; } };

// The Studio's agent: what /ds-up launched it as (dispatcher.json's studio_agent), else claude.
export function studioAgent(proj: Row | null): string {
  const doc = parse(proj?.doc);
  return String(doc.studio_agent || doc.agent || "claude");
}

// The Studio's terminals: the agent's own kind, not a `ds-loop …` pane (a codex morning briefing, a
// loop restart), however many shells sit beside it.
export function studioCandidates(terms: StudioTerm[], agent: string): StudioTerm[] {
  return terms.filter((t) => t.identity === agent && !/^ds-loop\b/.test(t.title ?? ""));
}

export function studioMember(store: Store, project: string, wt: string): Row | null {
  return store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? ORDER BY id DESC").get(project, STUDIO_SQUAD, wt) as Row | null;
}

// What the loop knows of the project's Studio: its worktree, agent, member row, the terminals Orca
// lists there and the ones that could be it. null when the project has no Studio worktree.
export function studioView(store: Store, project: string): StudioView | null {
  const proj = store.get("projects", { label: project });
  const wt = (proj?.studio_wt as string | null) || "";
  if (!wt) return null;
  const agent = studioAgent(proj);
  const terms = (store.db.query("SELECT handle, title, doc FROM observed_terminals WHERE project = ? AND wt = ? AND gone_at IS NULL ORDER BY handle")
    .all(project, wt) as Row[]).map((r) => ({ handle: String(r.handle), title: (r.title as string | null) ?? null, identity: (parse(r.doc).identity as string | null) ?? null }));
  const member = studioMember(store, project, wt);
  // /ds-up may hand over the handle it started (dispatcher.json studio_handle, U262).
  const recorded = (member?.handle as string | null) || (parse(proj?.doc).studio_handle as string | null) || null;
  return { wt, agent, member, terms, candidates: studioCandidates(terms, agent), recorded };
}

// The handle to hold this tick: the recorded one while it is still a candidate (listed, running the
// Studio's agent, no ds-loop pane: a tab whose Studio quit to a shell is let go), else the single candidate.
export function pickHandle(v: StudioView): string | null {
  if (v.recorded && v.candidates.some((t) => t.handle === v.recorded)) return v.recorded;
  return v.candidates.length === 1 ? v.candidates[0]!.handle : null;
}

// Adopt (or re-adopt, or release) the project's Studio from this tick's terminal rows. The observer
// calls it only after a terminal listing that succeeded. No member row is made until a handle is
// found; once made the row stays (handle NULL while none is held), so its account history and
// limited stamp survive a restart of the Studio. Returns the handle held, or null.
export function adoptStudio(store: Store, project: string, now: number): string | null {
  const v = studioView(store, project);
  if (!v) return null;
  const handle = pickHandle(v), m = v.member;
  if (!m && !handle) return null;
  const ow = store.db.query("SELECT gone_at, walk, agent, account, live_model FROM observed_workers WHERE project = ? AND wt = ?").get(project, v.wt) as Row | null;
  // The walk is filtered to the Studio's agent (observers/orca.ts), so its account and model are the Studio's.
  const ran = ow?.walk === "running" && ow.agent === v.agent;
  const want: Row = { agent: v.agent, handle, status: ow && ow.gone_at == null ? "running" : "gone",
    account: (ran && ow!.account) || m?.account || null, model: (ran && ow!.live_model) || m?.model || null };
  // U4: another terminal than the recorded one is not the start whose generation the row holds.
  if (m && handle !== ((m.handle as string | null) ?? null)) want.gen = null;
  const ctx = { project, squad: STUDIO_SQUAD, member: v.wt };
  if (!m) {
    store.fact("studio_adopted", [{ table: "members", key: { project, squad: STUDIO_SQUAD, wt: v.wt },
      set: { role: "studio", suffix: "", ...want, observed_at: now, updated_at: now } }], { ...ctx, payload: { handle, agent: v.agent, previous: null } });
    return handle;
  }
  const diff = Object.keys(want).filter((k) => (m[k] ?? null) !== (want[k] ?? null));
  if (!diff.length) return handle;
  const rows = [{ table: "members", key: { id: m.id }, set: { ...Object.fromEntries(diff.map((k) => [k, want[k]])), observed_at: now, updated_at: now } }];
  const previous = (m.handle as string | null) ?? null;
  if (handle !== previous && handle) store.fact("studio_adopted", rows, { ...ctx, payload: { handle, agent: v.agent, previous } });
  else if (handle !== previous) store.fact("studio_released", rows, { ...ctx, payload: { previous, candidates: v.candidates.map((t) => t.handle) } });
  else store.upsert("members", rows[0]!.key, rows[0]!.set);
  return handle;
}

// The Studio's first message, the same from /ds-up (U262) and a move (U264). A move (`moved`: why) adds
// the journal briefing, so the fresh tab picks up what the old one wrote down before it went idle.
export function studioPrompt(root: string, label: string, repo: string, stateDir: string, moved?: string): string {
  const base = `You are the Studio for project '${label}'. Read ${root}/studio/studio.md and follow it. Your project repo is '${repo}' and your state is ${stateDir}.`;
  return moved ? `${base} The loop moved you to a fresh terminal (${moved}): first read your journal with ${root}/bin/role/journal.sh ${label} studio studio briefing and carry on from it.` : base;
}

// The command a card gives for starting the Studio by hand on <model>@<account> ("-": the default).
export function studioRestartCmd(wt: string, model: string | null | undefined, account: string): string {
  let cmd = `cd ${wt.replace(/^[^:]*::/, "")} && claude${model && model !== "-" ? ` --model ${model}` : ""}`;
  if (account !== "-") cmd += `  # switch the terminal to account ${account} first`;
  return cmd;
}

export { promptDraft } from "./member-ready.ts";

// KTD7: may the loop type into the Studio now? Only into the adopted handle, and only when
// memberReady() holds on it (member-ready.ts: quiet for `quietS`, an empty prompt read since the last
// output, no picker or menu, no unread mail, no typed action ahead of `before`), plus the Studio's own:
// no request filed for the Studio (requests/_studio/ or a queued board `studio` row) and no open
// question it asked. `screenNoise` is memberReady's (board chat only). Orca's worker state is not
// consulted: the worktree also holds ds-loop panes and shells.
export function studioReady(store: Store, project: string, now: number, quietS = 120, before: number | null = null, screenNoise?: "ignore"): Ready {
  const no = (why: string) => ({ ready: false, why });
  const v = studioView(store, project);
  if (!v) return no("no Studio worktree");
  const h = v.member?.handle as string | null;
  if (!h) return no("no Studio terminal adopted");
  const r = memberReady(store, project, v.wt, now, { quietS, handle: h, agent: v.agent, before, screenNoise });
  if (!r.ready) return r;
  const req = `file:${project}/_studio/`;
  if (store.db.query("SELECT 1 FROM requests WHERE project = ? AND done_at IS NULL AND (substr(key, 1, ?) = ? OR kind = 'studio') LIMIT 1").get(project, req.length, req)) return no("a request waits for the Studio");
  if (store.db.query("SELECT 1 FROM questions WHERE project = ? AND status = 'open' AND (squad = ? OR asker IN (?, ?) OR card_wt = ?) LIMIT 1").get(project, STUDIO_SQUAD, v.wt, h, v.wt)) return no("an open question from the Studio");
  return { ready: true, why: "idle" };
}
