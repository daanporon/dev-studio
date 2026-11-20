import { stopping } from "../squad/cancel.ts";
// members.ts — every member of a squad whose Run the loop holds is a live worker of that Run (U71).
// Orca delivers `@worktree` mail (the relay's forwards, a `ds reply`) only to a worktree with an
// open (`dispatched`) dispatch, so a member that is up but not dispatched in the Run is deaf to it.
// That happens after a restart, a resume or a crash (the new terminal has no dispatch), and when a
// standing member's role task completed, or any member's failed otherwise than by its own report, while its terminal stays up (a
// Builder whose task completed has finished: `finished`). Each tick, per held squad:
//   reality  each member's live agent terminal in its worktree (backend `agent-handles`: an agent
//            identity, connected, writable), never a pane the loop owns (`coordinators`, a
//            `ds-loop …` title)
//   the Run  that worktree's row in `run-workers` (live yes/no, its dispatch, terminal and task)
// A member with a live agent terminal the Run doesn't count as live on one of its terminals gets
// one `rebind` (fulfil/rebind.ts gives it a fresh copy of its last role task). A member with no
// live terminal is liveness's; one the loop is starting (an open wish) is that start's; one that
// never had a task in this Run has nothing to copy and is fulfil/member.ts's. A live Run worker
// whose worktree is no longer a member (a retired Builder, a closed worktree) gets one `unbind`,
// which fences its dispatch. This reconciler reads Orca itself (two reads a tick, the terminal
// list once per project): a read that fails is no evidence, and leaves its squads alone. A live
// member with an old dispatch a rebind failed to fence gets a `rebind` too, which fences it.
// U89: a rebind dispatch left open on a standing role's terminal is settled once (fulfil/rebind.ts
// settles it inline; this reconciler settles drift it did not see), and a standing role whose
// newest dispatch is a settled rebind on its live terminal is bound: no rebind, no redo, no card.
//
// U79, stray shells: a plain terminal (no agent) in the worktree of a member that is up is a
// stray (`@worktree:` mail used to land in one). Every STRAY_EVERY seconds per project (backend
// `terminal-shells`, a /proc scan) each that printed nothing for STRAY_QUIET (one in use is left
// alone) gets a `stray` action, episode its state: an idle one is
// closed (fulfil/stray.ts, `stray_terminal_closed`), a busy one, or one whose close fails, gets
// one card (kind stray_terminal). A busy `Setup` tab is Orca's worktree setup, not a stray yet; a
// pane the loop owns is never one. A card is cleared once its terminal is gone (a close clears its own).
import { paused } from "../pause/pause.ts";
import { lock } from "../squad/member-state.ts";
import { STANDING } from "../drivers/types.ts";
import { shell, type Orca, type Out } from "../io/orca.ts";
import { pmap, readSlots } from "../core/tick.ts";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";

export type Worker = { wt: string; live: boolean; dispatch: string | null; handle: string | null; task: string | null; status: string | null; reported?: boolean };
// busy: the agent-handles 4th column (`busy` mid-turn, `idle` at its prompt); null when the backend
// printed none (the duplicate check then falls back to the worktree's observed state).
export type Agent = { wt: string; handle: string; title: string; busy: boolean | null };

const dash = (v: string | undefined) => (!v || v === "-" ? null : v);

// run-workers: "<wt>\t<live yes|no>\t<dispatch|->\t<handle|->\t<task|->\t<status|->\t<reported yes|no>" per
// worktree. reported (U215): the newest dispatch ended through the worker's own worker_done, completed or
// failed; an old 6-column line reads as not reported.
export function parseWorkers(out: string): Worker[] {
  return out.split("\n").filter(Boolean).map((l) => {
    const [wt, live, dispatch, handle, task, status, reported] = l.split("\t");
    return { wt, live: live === "yes", dispatch: dash(dispatch), handle: dash(handle), task: dash(task), status: dash(status), reported: reported === "yes" };
  });
}

// A Builder or Tester whose role task ended through its own worker_done has finished, not dropped out
// of the Run, whatever the outcome: a failed report (a Tester that found a bug) is finished too (U215).
// A copy of its task would type its whole brief back in and start the unit over. A dispatch that failed
// any other way (process stopped, crash) is not a report and still rebinds. Only a standing role
// (drivers/types.ts STANDING) lives past its task, so only it is rebound after one.
export const finished = (m: Row, w: Worker | undefined) => (w?.status === "completed" || w?.reported === true) && !STANDING.has(String(m.role));

// agent-handles: "<wt>\t<handle>\t<title>[\t<idle|busy>]" per live agent terminal, newest first
// within a worktree. A `claude -p` child (a review beside the member's own agent, U90) is a process
// in the worktree, never the member's session: never counted as one (U97).
export const isClaudeP = (title: string) => /(?:^|\s)claude\s+-p(?:\s|$)/.test(title) || title.includes("claude -p");
export function parseAgents(out: string): Agent[] {
  return out.split("\n").filter(Boolean).map((l) => {
    const [wt, handle, title = "", state = ""] = l.split("\t");
    return { wt, handle, title, busy: state === "busy" ? true : state === "idle" ? false : null };
  }).filter((a) => a.wt && a.handle);
}

// Every pane the loop owns in a project (each squad's coordinator, the restart pane outside them).
export const isLoopPane = (handle: string, title: string, panes: Set<string>) => panes.has(handle) || /^ds-loop\b/.test(title);
export function loopPanes(store: Store, project: string): Set<string> {
  return new Set((store.db.query("SELECT handle FROM coordinators WHERE project = ?").all(project) as Row[]).map((r) => String(r.handle)));
}

// A worktree's live agent terminals, newest first, without the loop's own panes and without a
// `claude -p` child beside the member's own agent. One entry per handle (a list that names a
// terminal twice is still one session).
export function agentsOf(agents: Agent[], wt: string, panes: Set<string>): Agent[] {
  const seen = new Set<string>();
  return agents.filter((a) => a.wt === wt && !isLoopPane(a.handle, a.title, panes) && !isClaudeP(a.title)
    && !seen.has(a.handle) && !!seen.add(a.handle));
}

// terminal-shells: "<wt>\t<handle>\t<idle|busy|unknown>\t<last output s|->\t<title>" per plain
// terminal; unknown counts as busy, no output yet as quiet since ever.
export type Shell = { wt: string; handle: string; state: "idle" | "busy"; out: number | null; title: string };
export function parseShells(out: string): Shell[] {
  return out.split("\n").filter((l) => l.trim()).map((l) => {
    const [wt, handle, state, last, ...title] = l.split("\t");
    const n = Number(last);
    return { wt, handle, state: state === "idle" ? "idle" as const : "busy" as const, out: last && last !== "-" && Number.isFinite(n) ? n : null, title: title.join("\t") };
  }).filter((t) => t.wt && /^term_/.test(t.handle));
}
// A shell with output in the last STRAY_QUIET seconds is in use: neither closed nor carded yet.
export const STRAY_QUIET = 600;
export const quiet = (t: Shell, now: number) => t.out === null || now - t.out >= STRAY_QUIET;
export const STRAY_EVERY = 60;
export const STRAY_KIND = "stray_terminal";
const strayAt = new WeakMap<Store, Map<string, number>>();

// U97, duplicate agents: a member worktree with more than one live agent terminal keeps the newest
// (agentsOf order: the one the loop started last); each older one gets one `duplicate` action
// (fulfil/duplicate.ts). A busy older one is carded once it has stayed busy DUPLICATE_CARD_AFTER.
export const DUPLICATE_KIND = "duplicate_agent";
export const DUPLICATE_CARD_AFTER = 1800;
const dupAt = new WeakMap<Store, Map<string, number>>();

// The member rows a worktree has in a squad (none for a retired or closed one).
export function memberRow(store: Store, project: string, squad: string, wt: string): Row | null {
  return store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
    .get(project, squad, wt) as Row | null;
}

// A member some lifecycle act has under way (member-state.ts lock: a start, switch, retire or rebind
// claim acted or running, or its Orca call open), a start waiting to be acted again (a boot reset,
// a wait or retry), or a restart-role.sh restart (members.restarting, U64) newer than the member's
// last start and younger than RESTART_HOLD: the member is that act's until it settles. A restart
// that never stamped its start stops holding after RESTART_HOLD. `except`: the caller's own claim kind.
export const RESTART_HOLD = 600;
export function starting(m: Row, now: number, store: Store, except: string[] = []): boolean {
  if (lock(store, m, except) || store.db.query(`SELECT 1 FROM episodes WHERE project = ? AND kind IN ('action:member', 'action:role')
    AND state = 'pending' AND ended_at IS NULL AND action IS NOT NULL AND subject = ?`).get(String(m.project ?? ""), `member:${m.id}`)) return true;
  const r = m.restarting ? Date.parse(String(m.restarting)) / 1000 : NaN, last = Date.parse(String(m.started ?? m.since ?? "")) / 1000;
  return Number.isFinite(r) && !(r <= last) && now - r < RESTART_HOLD;
}

// The old dispatches of a worktree a rebind meant to fence and whose fence never went through
// (fulfil/rebind.ts's `rebind-fence:<dispatch>` call has no completed row), less one that is the
// worktree's live dispatch on one of its live terminals again.
export function unfenced(store: Store, project: string, wt: string, w: Worker | undefined, mine: Agent[]): string[] {
  const keep = w?.live && w.handle && mine.some((a) => a.handle === w.handle) ? w.dispatch : null;
  return (store.db.query(`SELECT key FROM orca_calls WHERE project = ? AND member = ? AND key LIKE 'rebind-fence:%' GROUP BY key
    HAVING SUM(state = 'completed') = 0 ORDER BY MIN(id)`).all(project, wt) as Row[])
    .map((r) => String(r.key).slice("rebind-fence:".length)).filter((d) => d !== keep);
}

// U80, a rebind that did not take. Every rebind that ran a new task writes `member_rebound` (with
// the tick time `at`). A member still not live on the terminal it was rebound to, after a rebind
// to that terminal, is redone with a new task (episode `…|redo:<rebind task>`) after REDO_WAIT[n-1]
// seconds, n counting its rebinds to this terminal since it was last live. The 4th failure
// (3 redos that did not take) gets one `giveup` action (a card), then nothing until the member is
// live (`markLive` ends the count) or on another terminal (a restart).
export const REDO_WAIT = [60, 300, 900];
export const REDO_KIND = "redo";
export type Rebound = { task: string; from: string | null; handle: string; at: number };
export const redoSubject = (wt: string) => `redo:${wt}`;

// U89: a rebind dispatch the loop settled itself once the bind was seen (`dispatch-abandon` after
// the member went live on the rebound terminal; fulfil/rebind.ts, the relay). A standing role
// whose newest dispatch is one of these is bound: no second task is dispatched onto it, and the
// crash watch does not read it as this start's settle (liveness.ts). `settle:<wt>` is the card
// subject when a settle never went through.
export const SETTLED_KIND = "member_rebound_settled";
export const settleSubject = (wt: string) => `settle:${wt}`;
const dispatchLike = (dispatch: string) => `%"dispatch":${JSON.stringify(dispatch)}%`;
const taskLike = (task: string) => `%"task":${JSON.stringify(task)}%`;
const hasEvent = (store: Store, kind: string, project: string, squad: string, wt: string, like: string): boolean =>
  !!store.db.query("SELECT 1 FROM events WHERE kind = ? AND project = ? AND squad = ? AND member = ? AND payload LIKE ?").get(kind, project, squad, wt, like);
const eventHandle = (store: Store, kind: string, project: string, squad: string, wt: string, like: string): string | null => {
  for (const e of store.db.query("SELECT payload FROM events WHERE kind = ? AND project = ? AND squad = ? AND member = ? AND payload LIKE ? ORDER BY id").all(kind, project, squad, wt, like) as Row[]) {
    try {
      const h = (JSON.parse(String(e.payload)) as { handle?: unknown }).handle;
      if (typeof h === "string" && h) return h;
    } catch { /* not one of ours */ }
  }
  return null;
};
// A dispatch the loop's own rebind made for this member.
export function reboundDispatch(store: Store, project: string, squad: string, wt: string, dispatch: string | null): boolean {
  return !!dispatch && hasEvent(store, "member_rebound", project, squad, wt, dispatchLike(dispatch));
}
// ... and the loop already settled.
export function settledDispatch(store: Store, project: string, squad: string, wt: string, dispatch: string | null): boolean {
  return !!dispatch && hasEvent(store, SETTLED_KIND, project, squad, wt, dispatchLike(dispatch));
}
// run-workers names no dispatch for a worktree with none open (`no -`), in the fake and the real
// adapter alike — so a settled member is recognised by its newest task, which both keep. A task
// the loop's rebind made and already settled …
export function settledTask(store: Store, project: string, squad: string, wt: string, task: string | null): boolean {
  return !!task && hasEvent(store, SETTLED_KIND, project, squad, wt, taskLike(task));
}
// … and the terminal it bound, or null.
export function settledTaskHandle(store: Store, project: string, squad: string, wt: string, task: string | null): string | null {
  return task ? eventHandle(store, SETTLED_KIND, project, squad, wt, taskLike(task)) : null;
}

// The member's rebinds since it was last seen live, oldest first.
export function rebounds(store: Store, project: string, squad: string, wt: string): Rebound[] {
  const since = Number(store.get("episodes", { project, subject: redoSubject(wt), kind: REDO_KIND })?.ended_at ?? 0);
  const out: Rebound[] = [];
  for (const e of store.db.query("SELECT payload FROM events WHERE kind = 'member_rebound' AND project = ? AND squad = ? AND member = ? ORDER BY id").all(project, squad, wt) as Row[]) {
    try {
      const p = JSON.parse(String(e.payload)) as Record<string, unknown>;
      if (typeof p.task === "string" && Number(p.at) > since) out.push({ task: p.task, from: typeof p.from === "string" ? p.from : null, handle: String(p.handle ?? ""), at: Number(p.at) });
    } catch { /* not one of ours */ }
  }
  return out;
}

// A rebind's dispatch reads live until Orca fails it, so a member counts as live again only once it
// has stayed live REDO_WAIT[0] past its last rebind.
export const settled = (r: Rebound | undefined, now: number) => !r || now >= r.at + REDO_WAIT[0];

// The member is live: its redo count starts over. True when it had rebinds to clear.
export function markLive(store: Store, project: string, squad: string, wt: string, at: number): boolean {
  if (!rebounds(store, project, squad, wt).length) return false;
  store.upsert("episodes", { project, subject: redoSubject(wt), kind: REDO_KIND }, { squad, ended_at: at, state: "live", source: "loop", observed_at: at });
  return true;
}

// U89: the bind took without the member going live (its rebind dispatch settled on its terminal).
// The redo count ends, so a bound member is never redone or carded for it.
export function markSettled(store: Store, project: string, squad: string, wt: string, at: number): boolean {
  if (!rebounds(store, project, squad, wt).length) return false;
  store.upsert("episodes", { project, subject: redoSubject(wt), kind: REDO_KIND }, { squad, ended_at: at, state: "settled", source: "loop", observed_at: at });
  return true;
}

// The squads whose Run the loop's pane holds (seats() binds it every tick).
function held(store: Store, project: string): Row[] {
  return store.db.query(`SELECT s.topic, s.run_id FROM coordinators c JOIN squads s ON s.project = c.project AND s.topic = c.squad
    WHERE c.project = ? AND c.squad != '' AND COALESCE(s.run_id, '') != '' AND c.run_id = s.run_id
      AND COALESCE(s.status, '') NOT IN ('suspended', 'closed', 'gone') ORDER BY s.topic`).all(project) as Row[];
}

export async function reconcile(ctx: TickCtx, orca: Orca): Promise<Action[]> {
  const { store, project } = ctx, squads = held(store, project);
  // With no squad held or no agent list, no member is up: strays only clears the cards of gone terminals.
  if (!squads.length) return strays(ctx, orca, new Map(), loopPanes(store, project));
  // U239: the reads go out together: agent-handles, terminal-shells (when strays is due) and each held
  // Run's run-workers (a bounded few at once). They are used below in the same order as before.
  const shellsP = strayDue(ctx) ? orca.run("terminal-shells", []).catch((): Out => ({ code: 1, out: "", err: "" })) : undefined;
  const ahP = orca.run("agent-handles", []);
  const rwP = pmap(squads, readSlots(), (s) => orca.run("run-workers", [String(s.run_id)]));
  const ah = await ahP;
  if (ah.code !== 0) { void rwP.catch(() => {}); return strays(ctx, orca, new Map(), loopPanes(store, project), shellsP); }
  const rws = await rwP;
  const agents = parseAgents(ah.out), panes = loopPanes(store, project), out: Action[] = [], up = new Map<string, string>();
  for (const [i, s] of squads.entries()) {
    const squad = String(s.topic);
    const rw = rws[i];
    if (rw.code !== 0) continue;
    const workers = parseWorkers(rw.out);
    const squadType = String((store.db.query("SELECT type FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Row | null)?.type ?? "feature");
    const members = store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt IS NOT NULL AND COALESCE(status, '') != 'gone' ORDER BY id")
      .all(project, squad) as Row[];
    for (const m of members) {
      if (stopping(store, project, String(m.wt)) || paused(store, m as { project: string })) continue;
      const wt = String(m.wt), mine = agentsOf(agents, wt, panes);
      // U238: a feature squad's Tester whose pass ended through its own worker_done (no open dispatch, the
      // newest one reported) is closed like a done Builder; a testing squad's Tester is standing and stays.
      if (m.role === "tester" && m.want !== "gone" && squadType === "feature" && !starting(m, ctx.now, ctx.store)) {
        const tw = workers.find((x) => x.wt === wt);
        if (tw && !tw.live && !tw.dispatch && tw.reported === true) {
          if (store.want("member", String(m.id), "gone", { by: "loop", why: "tester pass finished" }).changed)
            store.event("tester_pass_done", { project, squad, member: wt, payload: { suffix: m.suffix ?? "", at: ctx.now } });
          continue;
        }
      }
      if (!mine.length || starting(m, ctx.now, ctx.store)) continue;
      const w = workers.find((x) => x.wt === wt), standing = STANDING.has(String(m.role));
      // U89 drift: a standing role bound through a rebind dispatch the loop left open (a restart
      // between the dispatch and the settle, a settle refused) gets that dispatch settled once,
      // and the relay retries. No second task is dispatched onto it.
      if (w?.live && w.handle && w.dispatch && standing && mine.some((a) => a.handle === w.handle)
        && reboundDispatch(store, project, squad, wt, w.dispatch) && !settledDispatch(store, project, squad, wt, w.dispatch)) {
        out.push({ project, squad, member: wt, subject: `rebind:${wt}`, kind: "rebind", episode: `settle|${w.dispatch}`,
          payload: { wt, handle: w.handle, settle: w.dispatch, task: w.task } });
        continue;
      }
      if (w?.live && w.handle && mine.some((a) => a.handle === w.handle)) {
        // Live, but an old dispatch a rebind failed to fence is still open: the rebind fences it.
        const left = unfenced(store, project, wt, w, mine);
        if (left.length) out.push({ project, squad, member: wt, subject: `rebind:${wt}`, kind: "rebind", episode: `fence|${left.join(",")}`, payload: { wt, handle: w.handle } });
        else {
          // U80: live again, so its redo count ends (the rebind action marks it).
          const last = rebounds(store, project, squad, wt).at(-1);
          if (last && ctx.now >= last.at + REDO_WAIT[0]) out.push({ project, squad, member: wt, subject: `rebind:${wt}`, kind: "rebind", episode: `live|${last.task}`, payload: { wt, handle: w.handle } });
        }
        continue;
      }
      if (!w?.task || finished(m, w)) continue;
      const handle = mine[0].handle;
      // U89 bound: the newest task is a rebind the loop settled on this terminal. The bind
      // took: no rebind and no redo — a second task would leave a second open dispatch. The redo
      // count ends without going live, so a bound member is never redone or carded for it.
      if (standing && !w?.live && settledTask(store, project, squad, wt, w?.task ?? null)
        && settledTaskHandle(store, project, squad, wt, w?.task ?? null) === handle) {
        markSettled(store, project, squad, wt, ctx.now);
        continue;
      }
      // U80: rebinds to this terminal that did not take are redone with a new task, with a backoff.
      const tried = rebounds(store, project, squad, wt).filter((r) => r.handle === handle), last = tried.at(-1);
      if (last && tried.length > REDO_WAIT.length) {
        out.push({ project, squad, member: wt, subject: `rebind:${wt}`, kind: "rebind", episode: `giveup|${last.task}`,
          payload: { wt, handle, giveup: true, count: tried.length, tasks: tried.map((r) => r.task), status: w.status } });
        continue;
      }
      if (last && ctx.now < last.at + REDO_WAIT[tried.length - 1]) continue;
      out.push({ project, squad, member: wt, subject: `rebind:${wt}`, kind: "rebind", episode: `${handle}|${w.dispatch ?? "-"}|${w.task}${last ? `|redo:${last.task}` : ""}`,
        payload: last ? { wt, handle, redo: last.task } : { wt, handle } });
    }
    // U97: a worktree with two live sessions of the member's agent (a start the backend guard
    // could not prevent: a hand start, a start from before the guard). Keep the newest (agentsOf
    // order, newest output first: the one the loop started last just printed its brief); every
    // older one gets one duplicate action. A newest the Run does not list as the member's worker
    // is not trusted either: one card, nothing closed.
    const dups = dupAt.get(store) ?? new Map<string, number>();
    dupAt.set(store, dups);
    for (const m of members) {
      if (stopping(store, project, String(m.wt)) || paused(store, m as { project: string })) continue;
      const wt = String(m.wt), mine = agentsOf(agents, wt, panes);
      if (mine.length < 2 || starting(m, ctx.now, ctx.store)) continue;
      const w = workers.find((x) => x.wt === wt), newest = mine[0];
      if (w?.live && w.handle && w.handle !== newest.handle) {
        out.push({ project, squad, member: wt, subject: `duplicate:${wt}`, kind: "duplicate",
          episode: `mismatch|${newest.handle}|${w.handle}`,
          payload: { wt, handle: newest.handle, newest: newest.handle, runHandle: w.handle, mismatch: true } });
        continue;
      }
      const observed = store.db.query("SELECT state FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, wt) as Row | null;
      for (const older of mine.slice(1)) {
        const busy = older.busy ?? (observed?.state === "working");
        if (busy && !dups.has(older.handle)) dups.set(older.handle, ctx.now);
        if (!busy) dups.delete(older.handle);
        out.push({ project, squad, member: wt, subject: `duplicate:${older.handle}`, kind: "duplicate", episode: older.handle,
          payload: { wt, handle: older.handle, newest: newest.handle, first: busy ? dups.get(older.handle)! : null } });
      }
    }
    const wts = new Set(members.map((m) => String(m.wt)));
    for (const w of workers) {
      if (stopping(store, project, w.wt)) continue;
      if (!w.live || !w.dispatch || wts.has(w.wt) || paused(store, { project, squad, member: w.wt })) continue;
      out.push({ project, squad, member: w.wt, subject: `unbind:${w.wt}`, kind: "unbind", episode: w.dispatch, payload: { wt: w.wt, dispatch: w.dispatch } });
    }
    for (const m of members) {
      if (stopping(store, project, String(m.wt)) || paused(store, m as { project: string })) continue;
      const wt = String(m.wt);
      if (agentsOf(agents, wt, panes).length && !starting(m, ctx.now, ctx.store)) up.set(wt, squad);
    }
  }
  return [...out, ...await strays(ctx, orca, up, panes, shellsP)];
}

// U79: the stray shells in the worktrees of members that are up (wt -> squad), and the stray cards to clear.
function strayDue(ctx: TickCtx): boolean {
  return ctx.now - (strayAt.get(ctx.store)?.get(ctx.project) ?? -Infinity) >= STRAY_EVERY;
}
async function strays(ctx: TickCtx, orca: Orca, up: Map<string, string>, panes: Set<string>, early?: Promise<Out>): Promise<Action[]> {
  const { store, project, now } = ctx, last = strayAt.get(store) ?? new Map<string, number>();
  strayAt.set(store, last);
  if (!strayDue(ctx)) return [];
  const cards: { id: string; handle: string; since: string }[] = [];
  for (const r of store.db.query("SELECT id, doc FROM observed_alerts WHERE project = ? ORDER BY rowid").all(project) as Row[]) {
    let a: Row;
    try { a = JSON.parse(String(r.doc)) as Row; } catch { continue; }
    if (a.kind === STRAY_KIND && typeof a.handle === "string") cards.push({ id: String(r.id), handle: a.handle, since: String(a.since ?? "") });
  }
  if (!up.size && !cards.length) return [];
  const ts = await (early ?? orca.run("terminal-shells", []));
  if (ts.code !== 0) return [];
  last.set(project, now);
  const out: Action[] = [], shells = parseShells(ts.out);
  for (const t of shells) {
    const squad = up.get(t.wt);
    if (!squad || isLoopPane(t.handle, t.title, panes) || !quiet(t, now) || (t.state === "busy" && /^Setup\b/.test(t.title))) continue;
    out.push({ project, squad, member: t.wt, subject: `stray:${t.handle}`, kind: "stray", episode: t.state, payload: { wt: t.wt, handle: t.handle, state: t.state, title: t.title } });
  }
  const live = new Set(shells.map((t) => t.handle));
  for (const c of cards) {
    if (live.has(c.handle)) continue;
    out.push({ project, squad: null, subject: `drop:${c.id}`, kind: "alert-clear", episode: `drop@${c.since}`, payload: { id: c.id, why: "its terminal is gone" } });
  }
  return out;
}

// orca: the fake in tests; the backend by default (resolved per tick, so $BACKEND is read late).
export function members(orca?: Orca): Reconciler {
  return { name: "members", run: (ctx) => reconcile(ctx, orca ?? shell()) };
}
export default members();
