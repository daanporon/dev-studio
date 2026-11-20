// fulfil/rebind.ts — kinds `rebind` and `unbind` (U71): a squad's Run counts exactly its members as
// live workers. reconcilers/members.ts finds the gaps; relay.ts rebinds the Lead at once when a
// forward finds no live terminal.
//
// rebind (a member is up, the Run doesn't count it): from the loop's pane, a fresh role task with
// the spec of the member's last role task in the Run and the squad's task as parent (`task-create`),
// dispatched to the member's live agent terminal with `--inject` (`dispatch`). The squad's task is
// never dispatched itself: Orca refuses that umbrella task (task_not_startable). The loop.db rows
// that name the old terminal move to the new one in the same step (the unforwarded `relayed` rows
// it sent, its `observed_terminals` row), and an open dispatch on the old terminal is fenced after
// the new one is up: the worktree's newest dispatch never settles under liveness's crash watch
// (U64), and a fence that fails is tried again by the next rebind of that worktree before anything
// else (its write-ahead row, `rebind-fence:<dispatch>`, stays unsettled). Every step is a
// write-ahead call keyed by worktree, terminal and the task it copies, so a retry replays it under
// the same id (one task, one dispatch), and a later rebind of the same terminal (its copy completed
// in turn) makes a new one. Before acting, the Run is read again: a member already live on one of
// its terminals is done, one with no live terminal is dropped (liveness's), and one the loop is
// starting or restart-role.sh is restarting waits for that to settle.
//
// A standing role (Lead, Thinker: STANDING in drivers/types.ts) never calls worker_done, so a
// rebind dispatch left open on its terminal stays active forever, and Orca files the terminal's
// Run mail under `run:<id>` instead of delivering it (U89). Once the bind is seen (the member
// live on the rebound terminal), the loop settles that dispatch itself (`dispatch-abandon`, event
// `member_rebound_settled`): Builders keep their open dispatch until they report done. A settle
// that fails is retried under its write-ahead row, then one card; reconcilers/members.ts settles
// drift the loop did not see inline (a restart between the dispatch and the settle), and reads a
// settled rebind dispatch as bound, never as a reason for a second task.
//
// unbind (a live Run worker that is no longer a member): its dispatch is fenced (`dispatch-abandon`)
// after UNBIND_GRACE, since a role start dispatches before the squad file names the worktree. A
// worktree that becomes a member meanwhile drops the action.
//
// A refused call is a retry, never done: the actuator classifies it (refusals.ts). Orca's "already
// has an active dispatch" is permanent, so one card and no further rebind of the worktree until
// what the bind depends on changes (fingerprint: the member's worktree, its start, whether it redoes
// a task and its newest dispatch's id and status; never the terminal or task Orca lists first, which
// flip from read to read, U150).
// Events: member_rebound, member_unbound.
import { paused } from "../pause/pause.ts";
import { alert, resolveAlert, type Exec, type Fulfiller, type LoopActuator, type Result } from "../core/actuator.ts";
import { STANDING } from "../drivers/types.ts";
import { errOf } from "../io/orca.ts";
import type { Action } from "../core/plugins.ts";
import { agentsOf, finished, loopPanes, markLive, markSettled, rebounds, settled, memberRow, parseAgents, parseWorkers, reboundDispatch, redoSubject, settledDispatch, settledTask, settledTaskHandle, settleSubject, starting, unfenced } from "../reconcilers/members.ts";
import type { Row, Store } from "../core/store.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

export const UNBIND_GRACE = 300;

type P = ActionPayload<"rebind">;
const CARD = "giveup";

// When the action's claim was first taken (its episode's start).
function since(store: Store, a: Action): number | null {
  const row = store.get("episodes", { project: a.project, subject: a.subject, kind: `action:${a.kind}` });
  return row?.episode_key === a.episode && row.started_at != null ? Number(row.started_at) : null;
}

// Rebind one member of a squad's Run to its live agent terminal. Shared by the fulfiller and relay.ts.
export async function rebind(act: LoopActuator, store: Store, o: { project: string; squad: string; wt: string; at: number; redo?: string }): Promise<Result> {
  const { project, squad, wt, at, redo } = o;
  if (paused(store, { project, squad, member: wt })) return { wait: "paused" };
  const sq = store.db.query("SELECT run_id, task_id FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Row | null;
  const run = sq?.run_id ? String(sq.run_id) : "";
  if (!run) return { dropped: `${squad} has no Run` };
  const m = memberRow(store, project, squad, wt);
  if (!m) return { dropped: `${wt} is not a member of ${squad}` };
  if (starting(m, at, store, ["action:rebind"])) return { wait: `${wt} is being started`, at: at + 30 };
  if (act.held(project, squad)) return { wait: `a restart holds ${squad}'s Run`, at: at + 30 };

  const ah = await act.orca.run("agent-handles", []);
  if (ah.code !== 0) return { retry: errOf(ah, "agent-handles") };
  const mine = agentsOf(parseAgents(ah.out), wt, loopPanes(store, project));
  if (!mine.length) return { dropped: `${wt} has no live agent terminal` };
  const rw = await act.orca.run("run-workers", [run]);
  if (rw.code !== 0) return { retry: errOf(rw, "run-workers") };
  const w = parseWorkers(rw.out).find((x) => x.wt === wt);
  for (const old of unfenced(store, project, wt, w, mine)) {
    const f = await fence(act, store, project, squad, wt, old, at);
    if (f) return { retry: f };
  }
  if (w?.live && w.handle && mine.some((t) => t.handle === w.handle)) {
    // U89: live through a rebind dispatch the loop left open is a bind, not a settle to keep:
    // the standing role never ends it, and while it is open Orca files the terminal's Run mail
    // under `run:<id>`. Settle it now so the relay's same-pass retry lands on the terminal.
    if (w.dispatch && STANDING.has(String(m.role)) && reboundDispatch(store, project, squad, wt, w.dispatch)
      && !settledDispatch(store, project, squad, wt, w.dispatch)) {
      const settled = await settleBind(act, store, { project, squad, wt, handle: w.handle, dispatch: w.dispatch, task: w.task, at });
      if ("retry" in settled) return settled;
    }
    // U80: its card goes first, then its count ends (a failed resolve is tried again).
    const seen = rebounds(store, project, squad, wt);
    if (seen.length && settled(seen.at(-1), at)) {
      const r = await resolveAlert(store, project, redoSubject(wt), CARD);
      if (r.code !== 0) return { retry: errOf(r, "alerts.sh") };
      markLive(store, project, squad, wt, at);
    }
    return { done: true, result: `live on ${w.handle}` };
  }
  if (!w?.task) return { failed: `${wt} has no role task in ${run} to copy` };
  if (finished(m, w)) return { dropped: `${wt} finished its role task ${w.task}` };
  // U89: bound through a settled rebind on the live terminal (a stale claim replayed after the
  // settle, a Relay retry): no second task. The reconciler stops emitting these; this stops
  // acting on them. The redo count ends, so a bound member is never redone or carded for it.
  if (STANDING.has(String(m.role)) && !w.live && settledTask(store, project, squad, wt, w.task)
    && mine.length && settledTaskHandle(store, project, squad, wt, w.task) === mine[0].handle) {
    markSettled(store, project, squad, wt, at);
    return { done: true, result: `settled on ${mine[0].handle}` };
  }

  const handle = mine[0].handle, key = `rebind:${wt}:${handle}:${w.task}${redo ? `:redo:${redo}` : ""}`;
  const step = (name: string, op: string, args: string[]) => act.seat(store, project, squad, `${key}:${name}`, wt, at).call(op, args);
  const spec = await act.orca.run("task-spec", [run, w.task]);
  if (spec.code !== 0 || !spec.out.trim()) return { retry: errOf(spec, "task-spec") };
  const title = `${m.role}${m.suffix ? ` ${m.suffix}` : ""} of ${squad} (rebound)`;
  const t = await step("task", "task-create", [run, spec.out.replace(/\n$/, ""), title, ...(sq?.task_id ? [String(sq.task_id)] : [])]);
  const task = t.out.trim().split("\n").pop() ?? "";
  if (t.code !== 0 || !/^task_/.test(task)) return { retry: t.code !== 0 ? errOf(t, "task-create") : `task-create printed no task id: ${t.out.trim()}` };
  if (task === sq?.task_id) return { failed: `task-create gave back the squad's own task ${task}` };
  const d = await step("dispatch", "dispatch", [task, handle, run]);
  const dispatch = d.out.trim();
  if (d.code !== 0 || !dispatch) return { retry: d.code !== 0 ? errOf(d, "dispatch") : "dispatch printed no dispatch id" };

  // A replay of completed calls changed nothing: the dispatch already has its event, so no second.
  const replay = !!store.db.query("SELECT 1 FROM events WHERE kind = 'member_rebound' AND member = ? AND payload LIKE ?").get(wt, `%"dispatch":${JSON.stringify(dispatch)}%`);
  const was = w.handle && w.handle !== handle ? w.handle : null, old = w.live && w.dispatch ? w.dispatch : null;
  if (!replay) store.tx(() => {
    if (was) {
      store.db.run("UPDATE relayed SET from_handle = ? WHERE project = ? AND squad = ? AND from_handle = ? AND forwarded_at IS NULL", [handle, project, squad, was]);
      const known = store.db.query("SELECT 1 FROM observed_terminals WHERE project = ? AND handle = ?").get(project, handle);
      if (known) store.db.run("UPDATE observed_terminals SET gone_at = ? WHERE project = ? AND handle = ? AND gone_at IS NULL", [at, project, was]);
      else store.db.run("UPDATE observed_terminals SET handle = ? WHERE project = ? AND handle = ?", [handle, project, was]);
    }
    store.event("member_rebound", { project, squad, member: wt, payload: { run, wt, handle, was, task, from: w.task, dispatch, fenced: old, at } });
  });
  if (old) {
    const f = await fence(act, store, project, squad, wt, old, at);
    if (f) return { retry: `${wt} is back on ${handle} (${dispatch}); ${f}` };
  }
  // U89: a standing role's bind is seen (live on the rebound terminal): settle the dispatch the
  // loop just made, so no open dispatch is left on the terminal. A Builder keeps its dispatch
  // until it reports done. The bind not seen yet is the drift the reconciler settles next tick.
  // The old dispatch is fenced first, so a refused settle never strands its fence.
  if (!replay && STANDING.has(String(m.role))) {
    const rw2 = await act.orca.run("run-workers", [run]);
    if (rw2.code !== 0) return { retry: errOf(rw2, "run-workers") };
    const live = parseWorkers(rw2.out).find((x) => x.wt === wt);
    if (live?.live && live.handle === handle && live.dispatch === dispatch) {
      const settled = await settleBind(act, store, { project, squad, wt, handle, dispatch, task, at });
      if ("retry" in settled) return { retry: `${wt} is back on ${handle} (${dispatch}); ${settled.retry}` };
    }
  }
  return { done: true, result: dispatch };
}

// U89: settle a rebind dispatch the loop left open on a standing role's terminal, once. Only a
// dispatch the loop's own rebind made is ever settled (its member_rebound names it); a start
// dispatch is the member's own and stays. The event is the record the reconciler and the crash
// watch read: a second settle of the same dispatch writes no second event. Shared by the
// fulfiller (inline after the bind is seen, the reconciler's settle action, the relay).
export async function settleBind(act: LoopActuator, store: Store, o: { project: string; squad: string; wt: string; handle: string | null; dispatch: string; task: string | null; at: number }): Promise<Result> {
  const { project, squad, wt, dispatch, at } = o;
  if (paused(store, { project, squad, member: wt })) return { wait: "paused" };
  const sq = store.db.query("SELECT run_id FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Row | null;
  const run = sq?.run_id ? String(sq.run_id) : "";
  if (!run) return { dropped: `${squad} has no Run` };
  if (!settledDispatch(store, project, squad, wt, dispatch)) {
    const rw = await act.orca.run("run-workers", [run]);
    if (rw.code !== 0) return { retry: errOf(rw, "run-workers") };
    const w = parseWorkers(rw.out).find((x) => x.wt === wt);
    if (w?.live && w.dispatch === dispatch) {
      const f = await act.seat(store, project, squad, `rebind-settle:${dispatch}`, wt, at).call("dispatch-abandon", [dispatch]);
      if (f.code !== 0) return { retry: errOf(f, "dispatch-abandon") };
    }
    // The settled task rides along so the reconciler reads the member as bound: run-workers
    // names no dispatch once settled, so only the newest task identifies the settled rebind.
    // A caller that names no task gets the live row's, and only when it is this dispatch.
    const task = o.task ?? (w?.dispatch === dispatch ? w.task : null);
    store.event("member_rebound_settled", { project, squad, member: wt, payload: { run, wt, handle: o.handle, task, dispatch, at } });
  }
  // A settle that once failed and carded is clear now.
  const r = await resolveAlert(store, project, settleSubject(wt), `settle|${dispatch}`);
  if (r.code !== 0) return { retry: errOf(r, "alerts.sh") };
  return { done: true, result: dispatch };
}

// U89: the member's open rebind dispatch, settled once. null when there is nothing open to
// settle (not live, no loop-made dispatch, already settled, or not a standing role): settling a
// start dispatch would read as this start's crash. The relay calls this when Orca files its send
// under `run:<id>`, then retries the send in the same pass.
export async function settleOpen(act: LoopActuator, store: Store, o: { project: string; squad: string; wt: string; at: number }): Promise<Result | null> {
  const { project, squad, wt, at } = o;
  if (paused(store, { project, squad, member: wt })) return { wait: "paused" };
  const sq = store.db.query("SELECT run_id FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Row | null;
  const run = sq?.run_id ? String(sq.run_id) : "";
  if (!run) return null;
  const rw = await act.orca.run("run-workers", [run]);
  if (rw.code !== 0) return { retry: errOf(rw, "run-workers") };
  const w = parseWorkers(rw.out).find((x) => x.wt === wt);
  if (!w?.live || !w.dispatch || !w.handle) return null;
  const m = memberRow(store, project, squad, wt);
  if (!m || !STANDING.has(String(m.role))) return null;
  if (!reboundDispatch(store, project, squad, wt, w.dispatch) || settledDispatch(store, project, squad, wt, w.dispatch)) return null;
  return settleBind(act, store, { project, squad, wt, handle: w.handle, dispatch: w.dispatch, task: w.task, at });
}

// Fence one old dispatch of a rebound member (dispatch-abandon); the error, or null once it's fenced.
async function fence(act: LoopActuator, store: Store, project: string, squad: string, wt: string, dispatch: string, at: number): Promise<string | null> {
  const f = await act.seat(store, project, squad, `rebind-fence:${dispatch}`, wt, at).call("dispatch-abandon", [dispatch]);
  return f.code === 0 ? null : errOf(f, "dispatch-abandon");
}

async function unbind(a: Action, x: Exec): Promise<Result> {
  const { store, now: at, act } = x, p = payloadOf<"rebind">(a), squad = a.squad ?? "";
  if (!p.wt || !p.dispatch) return { failed: "an unbind needs the worktree and its dispatch" };
  const first = since(store, a) ?? at;
  if (at < first + UNBIND_GRACE) return { wait: `${p.wt} may be a member being added`, at: first + UNBIND_GRACE };
  const run = String((store.db.query("SELECT run_id FROM squads WHERE project = ? AND topic = ?").get(a.project, squad) as Row | null)?.run_id ?? "");
  const rw = await act.orca.run("run-workers", [run]);
  if (rw.code !== 0) return { retry: errOf(rw, "run-workers") };
  const w = parseWorkers(rw.out).find((x) => x.wt === p.wt);
  if (!w?.live || w.dispatch !== p.dispatch) return { done: true, result: "not live any more" };
  const f = await act.seat(store, a.project, squad, `unbind:${p.dispatch}`, p.wt, at).call("dispatch-abandon", [p.dispatch]);
  if (f.code !== 0) return { retry: errOf(f, "dispatch-abandon") };
  store.event("member_unbound", { project: a.project, squad, member: p.wt, payload: { run, wt: p.wt, dispatch: p.dispatch } });
  return { done: true, result: p.dispatch };
}

// U80: three redos did not take. One card names the member, the failed tasks and the status Orca
// gave the last one; no more rebinds until the member is live (rebind() marks it) or restarted.
async function giveup(a: Action, x: Exec, p: P & { wt: string }): Promise<Result> {
  const squad = a.squad ?? "", tasks = (p.tasks ?? []).join(", ") || "none";
  const o = await alert(x.store, a.project, redoSubject(p.wt), CARD,
    `${p.wt} (${squad}) is up on ${p.handle ?? "its terminal"} but not in its Run: the loop rebound it ${p.count ?? "several"} times and none took. Failed rebind tasks: ${tasks}. Orca's status for the last one: ${p.status ?? "unknown"}. The loop stops rebinding it until it is live again or restarted.`,
    { title: `Rebind failed: ${squad}`, fields: { kind: "rebind_failed", wt: p.wt, handle: p.handle } });
  if (o.code !== 0) return { retry: errOf(o, "alerts.sh") };
  x.store.event("member_rebind_gave_up", { project: a.project, squad, member: p.wt, payload: { wt: p.wt, tasks: p.tasks, status: p.status } });
  return { done: true };
}

// U89: a settle that never went through (every retry refused). One card names the member and the
// dispatch, so the open dispatch does not sit on the terminal unnoticed: while it is open Orca
// files the terminal's Run mail under `run:<id>`. A later settle resolves it (settleBind).
async function settleGiveup(a: Action, x: Exec, p: P & { wt: string }): Promise<Result> {
  const squad = a.squad ?? "";
  const o = await alert(x.store, a.project, settleSubject(p.wt), `settle|${p.settle ?? "?"}`,
    `${p.wt} (${squad}) is bound on ${p.handle ?? "its terminal"} but the loop could not settle the rebind dispatch ${p.settle ?? "there"}: Run mail to it may be filed under its run instead of delivered. The loop tries no further settles for it; settle it by hand (dispatch-abandon) or restart the member.`,
    { title: `Settle failed: ${squad}`, fields: { kind: "rebind_settle_failed", wt: p.wt, handle: p.handle, dispatch: p.settle } });
  if (o.code !== 0) return { retry: errOf(o, "alerts.sh") };
  x.store.event("member_rebind_settle_gave_up", { project: a.project, squad, member: p.wt, payload: { wt: p.wt, handle: p.handle, dispatch: p.settle } });
  return { done: true };
}

const fulfiller: Fulfiller = {
  name: "rebind",
  kinds: ["rebind", "unbind"],
  run: () => [],
  stale(a, x) {
    const p = payloadOf<"rebind">(a);
    return a.kind === "unbind" && !!p.wt && memberRow(x.store, a.project, a.squad ?? "", p.wt) != null;
  },
  async exec(a, x) {
    if (a.kind === "unbind") return unbind(a, x);
    const p = payloadOf<"rebind">(a);
    if (!p.wt) return { failed: "a rebind needs the member's worktree" };
    if (p.giveup) return giveup(a, x, p as P & { wt: string });
    if (p.settle) {
      if (!reboundDispatch(x.store, a.project, a.squad ?? "", p.wt, p.settle)) return { failed: `refusing to settle ${p.settle}: the loop's rebind did not make it` };
      return settleBind(x.act, x.store, { project: a.project, squad: a.squad ?? "", wt: p.wt, handle: p.handle ?? null, dispatch: p.settle, task: p.task ?? null, at: x.now });
    }
    return rebind(x.act, x.store, { project: a.project, squad: a.squad ?? "", wt: p.wt, at: x.now, redo: p.redo });
  },
  fingerprint(a, x) {
    const p = payloadOf<"rebind">(a);
    if (a.kind !== "rebind" || !p.wt || p.settle || p.giveup || /^(fence|live)\|/.test(a.episode)) return { episode: a.episode, payload: a.payload ?? null };
    const m = memberRow(x.store, a.project, a.squad ?? "", p.wt);
    // The worktree's newest dispatch in the Run (by time, so stable between reads): the active
    // dispatch Orca refuses over ending is a new fingerprint, and the rebind is tried again. So is
    // a new main agent (U149's process walk, kept when a read fails): a terminal replaced by hand
    // never inherits the old one's refusal.
    const d = x.store.db.query("SELECT dispatch_id, dispatch, pid, started_at FROM observed_workers WHERE project = ? AND wt = ?").get(a.project, p.wt) as Row | null;
    return { bind: p.wt, redo: p.redo != null, member: m && { id: m.id, placed_at: m.placed_at, started: m.started, agent: m.agent, account: m.account },
      dispatch: d && { id: d.dispatch_id, status: d.dispatch }, process: d && { pid: d.pid, started: d.started_at } };
  },
  async giveUp(a, x, why) {
    const p = payloadOf<"rebind">(a);
    // Its own card written: no refusal card beside it (else the actuator's, retried by ready()).
    if (a.kind === "rebind" && p.settle && p.wt) return "done" in await settleGiveup(a, x, p as P & { wt: string });
  },
};
export default fulfiller;
