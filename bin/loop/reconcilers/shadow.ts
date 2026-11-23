// shadow.ts — the shadow reconciler (orca-backend-alternatives U10). Each tick it pairs the old Orca
// input with the new one at every decision point (squad/shadow.ts) and logs each disagreement once:
//   - a pair that disagrees opens an episode (kind `shadow`, subject `<point>:member:<id>` or
//     `member:wt:<wt>`), its first tick in `count`;
//   - still disagreeing TRANSIENT_TICKS ticks later: one `shadow_disagree` event (`transient: false`),
//     counted until `ds shadow explain <event> <why>`;
//   - agreeing again before that: one `shadow_disagree` event with `transient: true`, not counted.
// A member whose generation changed with no finish row for the old one and no stop the loop made
// itself crashed: one `shadow_crash` event (the report counts them). The first run in a project logs
// `shadow_started`, where `ds shadow report` starts by default. It returns no action: behaviour is
// not changed.
import type { Reconciler, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { lastStart } from "../squad/member-state.ts";
import { runWorkers } from "../squad/run-reads.ts";
import { nameOf, pairs, TRANSIENT_TICKS, tracked, type Pair } from "../squad/shadow.ts";

export const KIND = "shadow";
const GEN_KIND = "shadow-gen";

function log(store: Store, project: string, p: Pair, o: { transient: boolean; ticks: number; first_at: number }): number {
  return store.fact("shadow_disagree", [], { project, squad: p.squad, member: p.wt || undefined, payload: {
    point: p.point, old: p.old, new: p.new, member: p.member, ...(p.id != null ? { id: p.id } : {}), ...(p.gen ? { gen: p.gen } : {}),
    ...(p.wt ? { wt: p.wt } : {}), transient: o.transient, ticks: o.ticks, first_at: o.first_at } });
}

const firstPair = (e: Row): Pair => JSON.parse(String(e.result));

// An open episode that agrees again (or no longer applies): a pending one was transient, a logged one is over.
function resolve(store: Store, project: string, e: Row, tick: number, now: number): void {
  const key = { project, subject: String(e.subject), kind: KIND };
  if (e.state === "pending") log(store, project, firstPair(e), { transient: true, ticks: tick - Number(e.count), first_at: Number(e.started_at) });
  store.upsert("episodes", key, { ended_at: now, state: e.state === "pending" ? "transient" : "resolved", observed_at: now });
}

function step(store: Store, project: string, p: Pair, tick: number, now: number): void {
  const key = { project, subject: p.subject, kind: KIND };
  const e = store.get("episodes", key), open = !!e && e.ended_at == null;
  if (p.old === p.new) { if (open) resolve(store, project, e!, tick, now); return; }
  if (!open) {
    store.upsert("episodes", key, { squad: p.squad, started_at: now, ended_at: null, count: tick, state: "pending",
      episode_key: `${p.old}|${p.new}`, result: JSON.stringify(p), source: "loop", observed_at: now });
    return;
  }
  if (e!.state === "pending" && tick - Number(e!.count) >= TRANSIENT_TICKS) {
    store.tx(() => {
      log(store, project, p, { transient: false, ticks: tick - Number(e!.count), first_at: Number(e!.started_at) });
      store.upsert("episodes", key, { state: "logged", observed_at: now });
    });
  }
}

// The open episodes this tick computed no pair for: over when the member left, or when its squad's Run
// was read this tick (the point no longer applies). With no Run read, the point is unknown: kept.
function sweep(store: Store, project: string, seen: Set<string>, ids: Set<number>, tick: number, now: number): void {
  const open = store.db.query("SELECT * FROM episodes WHERE project = ? AND kind = ? AND ended_at IS NULL").all(project, KIND) as Row[];
  for (const e of open) {
    if (seen.has(String(e.subject))) continue;
    const id = /member:(\d+)$/.exec(String(e.subject))?.[1];
    const left = id != null && !ids.has(Number(id));
    if (left || runWorkers(project, String(e.squad ?? ""), tick)) resolve(store, project, e, tick, now);
  }
}

// A loop stop of this member since `since`: its own stop, a suspend, a pause close or a member close.
function loopStop(store: Store, m: Row, since: number): boolean {
  return !!store.db.query(`SELECT 1 FROM events WHERE project = ? AND at >= ? AND (
      (kind = 'member_stopped' AND json_extract(payload, '$.id') = ?)
      OR (kind IN ('member_suspended', 'pause_closed', 'member_closed') AND squad = ? AND member = ?)) LIMIT 1`)
    .get(String(m.project), since, Number(m.id), String(m.squad), String(m.wt ?? ""));
}

// A new generation of a member: a crash when the old one wrote no finish row and the loop did not stop it.
function generations(store: Store, project: string, members: Row[], now: number): void {
  for (const m of members) {
    const key = { project, subject: `member:${m.id}`, kind: GEN_KIND };
    const e = store.get("episodes", key), gen = String(m.gen);
    if (e && e.episode_key === gen) continue;
    if (e) {
      const prev = String(e.episode_key);
      const finished = store.db.query("SELECT 1 FROM finishes WHERE project = ? AND member = ? AND gen = ? LIMIT 1").get(project, nameOf(m), prev);
      if (!finished && !loopStop(store, m, Number(e.started_at ?? 0)))
        store.fact("shadow_crash", [], { project, squad: String(m.squad), member: String(m.wt), payload: { member: nameOf(m), id: Number(m.id), gen: prev, next: gen } });
    }
    store.upsert("episodes", key, { squad: String(m.squad), episode_key: gen, started_at: lastStart(m), state: "seen", source: "loop", observed_at: now });
  }
}

// The stores and projects whose shadow_started is known to be written: one read per process, not per tick.
const started = new WeakMap<Store, Set<string>>();
function markStarted(store: Store, project: string): void {
  const seen = started.get(store) ?? new Set<string>();
  started.set(store, seen);
  if (seen.has(project)) return;
  if (!store.db.query("SELECT 1 FROM events WHERE kind = 'shadow_started' AND project = ? LIMIT 1").get(project))
    store.fact("shadow_started", [], { project, payload: {} });
  seen.add(project);
}

export function shadowTick(store: Store, project: string, tick: number, now: number): void {
  markStarted(store, project);
  const members = tracked(store, project);
  generations(store, project, members, now);
  const seen = new Set<string>();
  for (const p of pairs(store, project, tick, now)) { seen.add(p.subject); step(store, project, p, tick, now); }
  sweep(store, project, seen, new Set(members.map((m) => Number(m.id))), tick, now);
}

const shadow: Reconciler = {
  name: "shadow",
  run(ctx: TickCtx) {
    shadowTick(ctx.store, ctx.project, ctx.tick, ctx.now);
    return [];
  },
};
export default shadow;
