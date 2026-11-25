// fulfil/pause.ts — kind `pause-control`: one member's pause, step by step from this tick's facts:
// deliver the pause instruction, wait for its journal checkpoint, close the agent terminals, release
// the dispatch. U150: a checkpoint that has not come CHECKPOINT_S after delivery is not waited on
// forever; the loop closes anyway and writes "checkpoint failed" in the role's journal. A release
// Orca answers with release_unknown (the recorded terminal no longer resolves, so nobody can prove
// the process gone), once orca.sh has released every other dispatch of the worktree, is recorded
// once as a `refusals` row of class unknown and the pause finishes; it is never tried again. Any
// other failed release (or fence, or listing) is a raw retry the actuator classifies.
// U12b: a squad off Orca has no dispatch. Its snapshot is the member row and the contract observer's rows
// (the finish row of the member's generation stands for a completed task); the instruction is a
// `terminal.send`, each agent terminal is closed through the seat by id, and there is nothing to release.
import { type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { CHECKPOINT_S, checkpointFailed as journalFailed, checkpointHash, ensureTransition, journalPath, intents, latestMember, memberKey, pauseControlBlock, quote, type Target } from "../pause/pause.ts";
import { fingerprint, refuse } from "../io/refusals.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import type { Action, TickCtx } from "../core/plugins.ts";
import type { ContractSeat } from "../drivers/types.ts";
import { startInFlight } from "../squad/member-state.ts";
import { onContract } from "../squad/backend.ts";
import { finishOf } from "../squad/finish-read.ts";
import { localPath } from "../drivers/contract.ts";

type Snapshot = { terminals: string[]; idle: boolean; helpers: boolean; spell: string; dispatch: string | null; completed: boolean };
type Step = { op: "deliver" | "close" | "release"; snap: Snapshot; resend?: number };
// orca.sh pause-release's last line when it walked every dispatch and only release_unknown ones
// were left; no other failure (a fence, a listing) prints it.
const RELEASE_UNKNOWN = /pause: release_unknown only; every other dispatch released\s*$/;
const doc = (r: Row | null) => JSON.parse(String(r?.doc ?? "{}"));
const idleKey = (m: Row, row: Row) => ({ project: m.project, subject: `pause-wait:${row.generation}`, kind: "pause-idle" });
function set(store: Store, m: Row, values: Row) { store.upsert("pause_members", memberKey(m), values); }

// Only facts from this tick authorize a mutation. A failed observer leaves its old rows in place.
function observed(ctx: TickCtx, m: Row): Snapshot {
  const { store, now } = ctx, worker = store.get("observed_workers", { project: m.project, wt: m.wt });
  if (!worker || (worker.observed_at !== now && worker.gone_at !== now)) throw new Error("worker observations missing or stale");
  const facts = doc(worker);
  if (facts.terminals_seen_at !== now) throw new Error("terminal observations missing or stale");
  const contract = onContract(store, String(m.project), String(m.squad));
  if (!contract && worker.dispatch_seen_at !== now) throw new Error("dispatch observations missing or stale");
  const rows = store.db.query("SELECT * FROM observed_terminals WHERE project = ? AND wt = ? AND gone_at IS NULL").all(String(m.project), String(m.wt)) as Row[];
  if (rows.some((r) => r.observed_at !== now || typeof doc(r).agent !== "boolean")) throw new Error("terminal identity observations missing or stale");
  const terminals = rows.filter((r) => doc(r).agent).map((r) => String(r.handle));
  const states = facts.agent_states;
  if (terminals.length && (worker.gone_at != null || !Array.isArray(states) || !states.length || states.some((s: unknown) => !["working", "waiting", "idle", "done"].includes(String(s)))))
    throw new Error("agent state observations missing or conflicting");
  if (!terminals.length && worker.gone_at == null && Array.isArray(states) && states.some((s: unknown) => s === "working" || s === "waiting")) throw new Error("agent and terminal observations conflict");
  // helpers: not proven free of sub-agents. Only U149's process walk of this very tick proves it (it
  // runs every DS_LOOP_LIVE_ACCOUNT_S and keeps the old columns when it fails).
  const walked = worker.account_at === now && worker.walk != null && worker.walk !== "unknown";
  return { terminals, idle: !!terminals.length && states.every((s: string) => s === "idle" || s === "done"), helpers: !walked || worker.sub_agents != null,
    spell: String(worker.since ?? "idle"),
    ...(contract ? { dispatch: null, completed: !!finishOf(store, m) }
      : { dispatch: worker.dispatch_id == null ? null : String(worker.dispatch_id), completed: worker.dispatch === "completed" }) };
}
function validCheckpoint(row: Row): boolean {
  return row.acknowledged_at != null && checkpointHash(String(row.checkpoint), String(row.generation)) === row.checkpoint_hash;
}
// No checkpoint by the deadline. Read from the row, so a pause the deadline closed still says so when
// its release finishes on a later tick.
const late = (ctx: TickCtx, row: Row) => row.delivered_at != null && row.acknowledged_at == null && ctx.now >= Number(row.delivered_at) + CHECKPOINT_S;
// `closed`: the loop closed the agent terminals in this pause (this tick or an earlier one), not
// found them already gone; only then does a late finish say it closed without the checkpoint.
function finish(ctx: TickCtx, m: Row, row: Row, snap: Snapshot, how: { closed: boolean; unknown?: string }) {
  let checkpoint = false;
  try { checkpoint = validCheckpoint(row); } catch {}
  const failed = !checkpoint && how.closed && late(ctx, row);
  const reason = checkpoint ? "journal checkpoint verified; agent terminals closed"
    : failed ? `checkpoint failed: none within ${CHECKPOINT_S / 60} minutes of the pause instruction; agent terminals closed anyway`
    : "agent already absent; no fresh pause checkpoint obtained";
  if (failed) checkpointFailed(ctx, m, row);
  set(ctx.store, m, { state: "paused", closed_at: ctx.now, task_completed: snap.completed || row.task_completed,
    reason: how.unknown ? `${reason}; dispatch release unknown: ${how.unknown}` : reason });
  ctx.store.event("pause_closed", { project: String(m.project), squad: String(m.squad), member: m.wt as string | null,
    payload: { generation: row.generation, checkpoint: checkpoint ? row.checkpoint : null, ...(failed ? { checkpoint_failed: true } : {}),
      ...(how.unknown ? { release: "unknown" } : {}) } });
}

// The role's journal says the pause closed without its checkpoint, so whoever resumes it reads that
// the last entry before the pause is not one.
function checkpointFailed(ctx: TickCtx, m: Row, row: Row) {
  try {
    journalFailed(ctx.store, m as Target, String(row.generation), ctx.now, "pause instruction; the loop closed the agent terminals");
  } catch (e) {
    ctx.store.event("plugin_error", { project: String(m.project), payload: { plugin: "pause", error: `checkpoint failed journal line: ${(e as Error).message}` } });
  }
}
function next(ctx: TickCtx, m: Row, row: Row): Step | null {
  const wait = (reason: string) => { if (row.reason !== reason) set(ctx.store, m, { reason }); return null; };
  if (startInFlight(ctx.store, m)) return wait("resolving in-flight start before checkpoint");
  if (!m.wt) {
    // Nothing launched and nothing to observe. closed_at stays empty, so Resume returns the member to
    // active and its pending wish makes the one start.
    set(ctx.store, m, { state: "paused", reason: "no agent or worktree existed; nothing to checkpoint" });
    ctx.store.event("pause_closed", { project: String(m.project), squad: String(m.squad), member: null, payload: { generation: row.generation, checkpoint: null } });
    return null;
  }
  let snap: Snapshot;
  try { snap = observed(ctx, m); } catch (e) { return wait(`cannot verify agent state: ${(e as Error).message}`); }
  if (!snap.terminals.length) {
    if (snap.dispatch) return { op: "release", snap };
    finish(ctx, m, row, snap, { closed: row.closed_at != null }); return null;
  }
  if (row.delivered_at == null) return { op: "deliver", snap };
  const expected = JSON.parse(String(row.terminals ?? "[]")) as string[];
  if (snap.terminals.some((h) => !expected.includes(h)) || (snap.dispatch && snap.dispatch !== row.dispatch))
    return wait("agent session changed; checkpoint does not authorize this session");
  if (row.acknowledged_at == null) {
    if (!snap.terminals.includes(String(row.session))) return wait("agent session changed; pause instruction recipient is absent");
    // Past the deadline: close without the checkpoint, but only an idle agent with no live sub-agents
    // (pause-close never ends one mid-step or under its helpers); otherwise the first tick it is.
    // A background shell of an idle agent is not observable here; the pause instruction asked it to finish.
    if (late(ctx, row))
      return snap.idle && !snap.helpers ? { op: "close", snap }
        : wait(`no checkpoint ${CHECKPOINT_S / 60} minutes after the pause instruction; closing once the agent is idle and a fresh process walk shows no live sub-agents`);
    const key = idleKey(m, row), spell = ctx.store.get("episodes", key), count = Number(spell?.count ?? 0);
    if (!snap.idle) {
      if (spell?.state !== "busy") ctx.store.upsert("episodes", key, { state: "busy", count, source: "loop", observed_at: ctx.now });
      return wait("pause instruction delivered; awaiting journal checkpoint");
    }
    if (spell?.state !== `idle:${snap.spell}`) return { op: "deliver", snap, resend: count + 1 };
    return wait("pause instruction delivered; awaiting journal checkpoint");
  }
  try { if (!validCheckpoint(row)) return wait("journal checkpoint changed; acknowledge the checkpoint again"); }
  catch (e) { return wait(`checkpoint unavailable: ${(e as Error).message}`); }
  if (!snap.idle) return wait("checkpoint recorded; agent or local commands still busy");
  return { op: "close", snap };
}

type Out = { code: number; out: string; err: string };
const said = (r: { ok: boolean; error?: string }): Out => ({ code: r.ok ? 0 : 1, out: "", err: r.error ?? "" });
async function contractSend(c: ContractSeat, id: string, text: string): Promise<Out> {
  const r = await c.ask("terminal.send", { id, text, submit: true });
  return r.ok ? said({ ok: true }) : said({ ok: false, error: `terminal.send: ${r.error.message}` });
}
async function contractClose(c: ContractSeat, wt: string, id: string): Promise<Out> {
  const path = localPath(wt);
  return path ? said(await c.close(path.replace(/\/+$/, ""), id)) : said({ ok: false, error: `${wt} is no local worktree` });
}

const pauseLifecycle: Fulfiller = {
  name: "pause", kinds: ["pause-control"],
  run(ctx) {
    const { store, project, now } = ctx, out: Action[] = [];
    const members = store.db.query("SELECT * FROM members WHERE project = ? AND role != 'studio' ORDER BY id DESC").all(project) as Row[];
    const seen = new Set<string>();
    for (const m of members) {
      const key = JSON.stringify(memberKey(m)); if (seen.has(key)) continue; seen.add(key);
      if (m.want === "gone") continue;
      const squad = store.get("squads", { project, topic: m.squad });
      // U158: a suspended squad's members are paused by its suspend wish, so the pause flow
      // runs for them too (checkpoint, 5 minutes, close); only ended squads are skipped.
      if (!squad || ["closed", "gone", "archived", "cancelled"].includes(String(squad.status)) || String(squad.want) === "gone") continue;
      const row = intents(store, m as Target).length ? ensureTransition(store, m as Target, now) : store.get("pause_members", memberKey(m));
      if (row?.state !== "pausing" || !next(ctx, m, row)) continue;
      out.push({ project, squad: String(m.squad), member: m.wt as string | null, subject: `pause:${row.generation}:${m.id}`,
        kind: "pause-control", episode: String(row.generation), payload: { id: m.id } });
    }
    return out;
  },
  stale: (a, x) => !!pauseControlBlock(x.store, a),
  async exec(a, x: Exec): Promise<Result> {
    const { store, now } = x, m = store.get("members", { id: (a.payload as Row).id })!, t = m as Target;
    const current = () => !pauseControlBlock(store, a), row = store.get("pause_members", memberKey(m))!;
    const step = next(x, m, row);
    if (!step) return store.get("pause_members", memberKey(m))?.state === "paused" ? { done: true } : { wait: String(store.get("pause_members", memberKey(m))?.reason) };
    const wait = (reason: string): Result => { if (current()) set(store, m, { reason }); return { wait: reason }; };
    const run = String(store.get("squads", { project: m.project, topic: m.squad })?.run_id ?? "");
    let unknown: string | undefined;
    const release = async (): Promise<Result | null> => {
      const seat = x.act.seat(store, a.project, a.squad ?? null, `pause-release:${a.episode}`, String(m.wt), now);
      const freed = await seat.call("pause-release", [run, String(m.wt)]);
      if (!current()) return { dropped: "pause cancelled during release" };
      if (freed.code === 0) return null;
      const text = freed.err || freed.out || "pause release failed";
      if (!RELEASE_UNKNOWN.test(text)) { set(store, m, { reason: `dispatch release pending: ${text}` }); return { retry: text }; }
      const subject = `pause-release:${m.id}`;
      refuse(store, { project: a.project, squad: a.squad, member: a.member, subject, kind: "pause-release", text, at: now,
        fingerprint: fingerprint("pause-release", subject, { generation: a.episode, run, wt: m.wt, dispatch: step.snap.dispatch }) }, "unknown");
      unknown = step.snap.dispatch ?? "its dispatch";
      return null;
    };
    if (step.op === "deliver") {
      const session = row.session == null ? step.snap.terminals[0] : String(row.session), dispatch = step.snap.dispatch ?? "-";
      if (row.delivered_at == null) set(store, m, { session, dispatch, task_completed: step.snap.completed, terminals: step.snap.terminals });
      const command = `DS_STATE_ROOT=${quote(store.root)} ${[`${ROOT}/bin/role/pause-checkpoint.sh`, String(m.project), String(m.squad), String(m.role), String(m.suffix || "-"), a.episode, "<progress; unfinished work; decisions; test results; branch and PR/CI reference; how to continue>"].map(quote).join(" ")} --commands-finished`;
      const text = `dev-studio pause control: pause generation ${a.episode}, role ${m.role}${m.suffix ? `-${m.suffix}` : ""}, session ${session}, dispatch ${dispatch}. Finish the current step without starting another feature, review or repair cycle. Wait for every local/background command you own to finish; remote CI may continue. Write your checkpoint to ${journalPath(store, t)} and acknowledge ONLY with: ${command}. This is not worker_done, unit completion or task completion. After successful acknowledgment stop at your prompt; the loop verifies idle and closes only agent terminals, retaining your worktree. A failed helper leaves you Pausing; report its failure to the Lead.`;
      const seat = x.act.seat(store, a.project, a.squad ?? null, `pause-deliver:${a.episode}:${step.resend ?? 0}`, String(m.wt), now);
      const sent = seat.contract ? await contractSend(seat.contract, session, text) : await seat.call("pause-deliver", [String(m.wt), session, text, run]);
      if (!current()) return { dropped: "pause cancelled during delivery" };
      if (sent.code !== 0) return { retry: sent.err || sent.out || "pause instruction not delivered" };
      if (step.resend) store.upsert("episodes", idleKey(m, row), { state: `idle:${step.snap.spell}`, count: step.resend, source: "loop", observed_at: now });
      set(store, m, { delivered_at: row.delivered_at ?? now, reason: "pause instruction delivered; awaiting journal checkpoint" });
      return { wait: "awaiting journal checkpoint" };
    }
    if (step.op === "close") {
      for (const terminal of step.snap.terminals) {
        if (!current()) return { dropped: "pause cancelled before closure" };
        const seat = x.act.seat(store, a.project, a.squad ?? null, `pause-close:${a.episode}:${terminal}`, String(m.wt), now);
        const closed = seat.contract ? await contractClose(seat.contract, String(m.wt), terminal)
          : await seat.call("pause-close", [String(m.wt), terminal, run, String(row.terminals)]);
        if (!current()) {
          store.tx(() => {
            const latest = store.get("pause_members", memberKey(m));
            if (closed.code === 0 && latest?.state === "active" && latestMember(store, m) && store.get("members", { id: m.id })?.want !== "gone")
              set(store, m, { state: "resuming", closed_at: now, reason: "resume raced terminal closure; awaiting fresh placement" });
          });
          return { dropped: "pause cancelled during closure" };
        }
        if (closed.code !== 0) return wait(`terminal closure not verified: ${closed.err || closed.out}`);
        set(store, m, { closed_at: now });
      }
    }
    if (step.snap.dispatch) { const pending = await release(); if (pending) return pending; }
    finish(x, m, row, step.snap, { closed: step.op === "close" || row.closed_at != null, unknown });
    return { done: true };
  },
  giveUp(a, x, why) {
    const m = x.store.get("members", { id: (a.payload as Row).id });
    if (m && !pauseControlBlock(x.store, a)) set(x.store, m, { reason: `pause failed: ${why}; resume and pause again after repairing it` });
  },
};
export default pauseLifecycle;
