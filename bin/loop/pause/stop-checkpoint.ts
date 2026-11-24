// stop-checkpoint.ts — U266: a planned restart asks for a journal checkpoint first, as a pause does
// (U150), so the next session reads where this one stood instead of starting from an old journal.
//
//   stop (decider)                        checkpoint first?
//   restart wish, mode idle               yes
//   fallback (moving back up, row `up`)   yes
//   pin (the operator's model/account)    yes
//   account (its account switched off)    yes (provider-billing-fallback U5)
//   rss (over restart_rss_gb)             yes
//   restart mode now, hung, phase, limit  no — they go ahead as before
//
// The decider's compare() returns `checkpoint` instead of `stop` while the owed stop has no settled
// row here (it needs the room the stop needs); ask() then runs one step per tick, on the idle agent:
//   1. no row for this stop: a new `stop_checkpoints` row with a fresh generation (`stop-<uuid>`)
//   2. not asked yet: one wake() poke carrying the generation and the exact helper command
//      (bin/role/pause-checkpoint.sh, which writes `checkpoint <generation>: …` to the journal)
//   3. the journal holds that line (pause.ts checkpointHash): `verified`, and the stop goes this tick
//   4. CHECKPOINT_S after the ask (or after the row, if no poke could go out) with no line: the
//      journal gets `checkpoint failed <generation>: …` and the row is `failed`; the stop goes this tick
// A row still asking whose stop is no longer owed (wish cleared, pin removed, move no longer due) is
// `dropped` once the agent is idle again (a fallback move is only seen on an idle member) or gone;
// nothing is stopped and a written checkpoint stays an ordinary journal line. Each settled step logs
// one `stop_checkpoint` event (member, why, generation, result).
import { randomUUID } from "node:crypto";
import { CHECKPOINT_S, checkpointFailed, checkpointHash, journalPath, quote, type Target } from "./pause.ts";
import type { Action, TickCtx } from "../core/plugins.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import type { Switch } from "../capacity/switches.ts";
import { wake } from "./wake.ts";

export type Owed = { why: "restart" | "rss" | "fallback" | "pin" | "account"; key: string };
type StopFacts = { stopDue?: "now" | "idle" | null; stopWhy?: string; switchStop?: Switch | null };

// The stop this member owes a checkpoint for, in compare()'s order: an idle stop (restart, rss) wins
// over a switch, a `now` stop has none. The key names the stop, not the tick: it stays the same until
// the stop has acted (a fallback's rung pair may change between picks; its window marker does not).
export function owed(store: Store, m: Row, f: StopFacts): Owed | null {
  if (f.stopDue === "now") return null;
  if (f.stopDue === "idle" && f.stopWhy === "restart") return { why: "restart", key: `restart:${Number(m.restart_at ?? 0)}` };
  if (f.stopDue === "idle" && f.stopWhy === "rss")
    return { why: "rss", key: `rss:${Number(store.get("episodes", { project: m.project, subject: `member:${m.id}`, kind: "rss_restart" })?.started_at ?? 0)}` };
  if (f.stopDue) return null;
  const sw = f.switchStop;
  if (sw?.why === "fallback") return { why: "fallback", key: sw.episode.replace(/^stop:fallback:rung\d+->\d+/, "fallback") };
  if (sw?.why === "pin") return { why: "pin", key: sw.episode.replace(/^stop:/, "") };
  if (sw?.why === "account") return { why: "account", key: sw.episode.replace(/^stop:/, "") };
  return null;
}

export function latest(store: Store, memberId: number): Row | null {
  return store.db.query("SELECT * FROM stop_checkpoints WHERE member_id = ? ORDER BY id DESC LIMIT 1").get(memberId) as Row | null;
}

// The why compare() must turn into `checkpoint`: the owed stop's, unless its row has settled.
export function pendingWhy(store: Store, m: Row, f: StopFacts): string | null {
  const o = owed(store, m, f);
  if (!o) return null;
  const row = latest(store, Number(m.id));
  return row && row.stop_key === o.key && (row.state === "verified" || row.state === "failed") ? null : o.why;
}

const target = (m: Row): Target => ({ scope: "member", project: String(m.project), squad: String(m.squad), role: String(m.role), suffix: String(m.suffix ?? "") });

function settle(store: Store, m: Row, row: Row, result: "verified" | "failed" | "dropped", at: number, set: Row = {}) {
  store.tx(() => {
    store.upsert("stop_checkpoints", { id: row.id }, { state: result, settled_at: at, ...set });
    store.event("stop_checkpoint", { project: String(m.project), squad: String(m.squad), member: (m.wt as string | null) ?? null,
      payload: { id: Number(m.id), why: row.why, generation: row.generation, result } });
  });
}

const WHY: Record<Owed["why"], string> = {
  restart: "a restart was asked for",
  rss: "its memory use is over restart_rss_gb",
  fallback: "to move it back up to a better model",
  pin: "to move it onto the model or account the operator pinned",
  account: "to move it off an account the operator switched off",
};

export function askText(store: Store, m: Row, why: Owed["why"], generation: string): string {
  const command = `DS_STATE_ROOT=${quote(store.root)} ${[`${ROOT}/bin/role/pause-checkpoint.sh`, String(m.project), String(m.squad), String(m.role), String(m.suffix || "-"), generation,
    "<progress; unfinished work; decisions; test results; branch and PR/CI reference; next step>"].map(quote).join(" ")} --commands-finished`;
  return `dev-studio stop checkpoint: the loop will restart this session (${WHY[why]}), generation ${generation}, role ${m.role}${m.suffix ? `-${m.suffix}` : ""}. ` +
    "Finish the current step without starting another feature, review or repair cycle, and wait for the local commands you own to finish. " +
    `Write your checkpoint to ${journalPath(store, target(m))} with ONLY: ${command}. This is not worker_done. ` +
    "Then stop at your prompt: the loop restarts you once you are idle, and your next session reads this checkpoint in its journal briefing.";
}

// One step of the owed stop's checkpoint (the decider's `checkpoint` act, on an idle agent).
// `settled`: the row is verified or failed, so the stop may go now.
export function ask(ctx: TickCtx, m: Row, o: Owed): { settled: boolean; actions: Action[] } {
  const wait = (actions: Action[] = []) => ({ settled: false, actions }), go = { settled: true, actions: [] };
  const { store, now } = ctx;
  let row = latest(store, Number(m.id));
  if (!row || row.stop_key !== o.key || row.state === "dropped") {
    if (row?.state === "asking") settle(store, m, row, "dropped", now);
    const generation = `stop-${randomUUID()}`;
    store.db.run(`INSERT INTO stop_checkpoints (member_id, project, squad, role, suffix, stop_key, why, generation, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'asking', ?)`, [Number(m.id), String(m.project), String(m.squad), String(m.role), String(m.suffix ?? ""), o.key, o.why, generation, now]);
    row = latest(store, Number(m.id))!;
  }
  if (row.state !== "asking") return row.state === "verified" || row.state === "failed" ? go : wait();
  const generation = String(row.generation);
  let hash: string | null = null;
  try { hash = checkpointHash(journalPath(store, target(m)), generation); } catch { /* not written yet */ }
  if (hash) { settle(store, m, row, "verified", now, { checkpoint_hash: hash }); return go; }
  if (now >= Number(row.asked_at ?? row.created_at) + CHECKPOINT_S) {
    try { checkpointFailed(store, target(m), generation, now, "stop checkpoint instruction; the loop restarted the agent anyway"); }
    catch (e) { store.event("plugin_error", { project: String(m.project), payload: { plugin: "stop-checkpoint", error: `checkpoint failed journal line: ${(e as Error).message}` } }); }
    settle(store, m, row, "failed", now);
    return go;
  }
  if (row.asked_at != null || !m.wt) return wait();
  const w = wake({ ...ctx, project: String(m.project) }, String(m.wt), askText(store, m, o.why, generation), "stop-checkpoint", generation);
  if (w.status === "sent") store.upsert("stop_checkpoints", { id: row.id }, { asked_at: now });
  return wait(w.actions);
}

// Rows still asking whose stop is no longer owed: dropped once the agent is idle or gone. `seen` maps
// a member id to its owed stop and whether it is idle (or has no agent); a member not in it drops.
export function sweep(ctx: TickCtx, seen: Map<number, { m: Row; owed: Owed | null; idle: boolean }>): void {
  const { store, now } = ctx;
  for (const row of store.db.query("SELECT * FROM stop_checkpoints WHERE state = 'asking' ORDER BY id").all() as Row[]) {
    const s = seen.get(Number(row.member_id));
    if (s && s.owed?.key === row.stop_key) continue;
    if (s && !s.idle) continue;
    const m = s?.m ?? store.get("members", { id: row.member_id }) ?? { id: row.member_id, project: row.project, squad: row.squad, wt: null };
    settle(store, m, row, "dropped", now);
  }
}

// The pending stop checkpoint of a member, for the board (export-json): null unless one is asking.
// The board opens loop.db read-only and may run ahead of the loop's migrations: no table, none pending.
const migrated = new WeakMap<Store, boolean>();
export function pendingOf(store: Store, memberId: number): { why: string; generation: string; since: number; asked_at: number | null } | null {
  if (!migrated.has(store)) migrated.set(store, !!store.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stop_checkpoints'").get());
  if (!migrated.get(store)) return null;
  const row = latest(store, memberId);
  return row?.state === "asking" ? { why: String(row.why), generation: String(row.generation), since: Number(row.created_at), asked_at: row.asked_at == null ? null : Number(row.asked_at) } : null;
}
