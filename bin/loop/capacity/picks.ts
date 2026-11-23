// picks.ts — the account pick for every member the decider would start, each tick (U9, U152).
//
// The decider (decide.ts) hands over its start candidates (a member wanted running with no agent and
// no lock, or a live one owed a phase switch), oldest wish first. Each gets a `picks` row: what
// bin/loop/capacity/pick.ts would start it on, or no place. The host-wide start budget (DS_LOOP_START_SLOTS,
// default 4) is the number of starts in flight (a start claim acted or running) plus the candidates
// holding a pick: past it a member is `queued` and reserves no load, so ten members wanted at once
// never land on an account that has room for two. Members picked earlier in the tick count as load
// on their account for the ones after them. A pinned agent or model in the wish's payload holds
// only while that wish is not yet acted on (want_result empty).
//
// A Builder over its project's max_builders (U145) gets no slot and reason `WAIT slot: …`: it waits,
// with no wait_until, and is picked again next tick; so does one under the host brake (U4, `WAIT host: …`). One no account has room for reads `no account
// free` with the pick's wait_until and wait_known (U1: the board's Flow shows a known reset time).
//
// U270: a member whose start episode is pending a retry more than a minute away (a failed start's 15-minute wait)
// earns no slot, reason `waiting: start retry at <time>`, and earns one again once the retry is due: failed starts
// waiting out their retry never hold the host's start budget.
//
// U180: a Thinker owed a fallback stop (decide.ts hands those in) gets a slot only when its pick still
// lands above the rung it runs on, with every earlier pick of the tick (other fallback stops among them)
// counted as load: three Thinkers aiming at room for one stop one, not three. Without the slot there is
// no stop. A member holding a fallback reservation (fulfil/member.ts) keeps its reserved account while
// that rung still fits (the pick's `keep`). A pick past the start budget is `queued` (in its event too),
// with no agent: the board reads it as queued, not as a pick.
//
// One `pick` event per (project, role) per tick, and only when a pick of that role changed (agent,
// model, account, wait or slot), so a member that keeps waiting does not fill the event log.
// An override whose member's work is done is cleared here (cleared_at, an `override_cleared` event).
import { paused } from "../pause/pause.ts";
import type { TickCtx } from "../core/plugins.ts";
import { overrideOf, pick, reservationOf, workDone } from "./pick.ts";
import { phaseFor, phaseMayWrite } from "../reconcilers/phases.ts";
import { candidates, type Wanting } from "../core/decide.ts";
import type { Row, Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { startWait } from "./slot.ts";
import { withWalkMemo } from "./walk-memo.ts";

export const startSlots = () => envInt("DS_LOOP_START_SLOTS", 4);
// A start retry further away than this gives its slot up (U270).
const RETRY_HOLD = 60;

// The start budget as the picks table holds it.
export function slotBudget(store: Store): { max: number; used: number; free: number } {
  const used = (store.db.query("SELECT COUNT(*) AS n FROM picks WHERE slot = 1").get() as { n: number }).n, max = startSlots();
  return { max, used, free: Math.max(0, max - used) };
}

function clearDone(store: Store, at: number): void {
  // U24: a squad override ends with its squad. Member, role and project ones are never cleared here.
  for (const o of store.db.query("SELECT * FROM overrides WHERE cleared_at IS NULL AND scope = 'squad'").all() as Row[]) {
    const [project, ...rest] = String(o.member).split("/");
    const sq = store.get("squads", { project, topic: rest.join("/") });
    if (!sq || !["closed", "gone"].includes(String(sq.status ?? ""))) continue;
    if (store.setIf("overrides", Number(o.id), "cleared_at", at, null)) {
      store.event("override_cleared", { project, squad: rest.join("/"), payload: { override: o.id, reason: "squad closed" } });
    }
  }
  for (const o of store.db.query("SELECT * FROM overrides WHERE cleared_at IS NULL AND COALESCE(scope, 'member') = 'member'").all() as Row[]) {
    const id = String(o.member);
    const m = (/^\d+$/.test(id) ? store.db.query("SELECT * FROM members WHERE id = ?").get(Number(id))
      : store.db.query("SELECT * FROM members WHERE wt = ? OR (project || '/' || squad || '/' || role || CASE WHEN suffix != '' THEN '/' || suffix ELSE '' END) = ? ORDER BY id DESC").get(id, id)) as Row | null;
    if (!m || paused(store, m as { project: string }) || !workDone(store, m)) continue;
    if (store.setIf("overrides", Number(o.id), "cleared_at", at, null)) {
      store.event("override_cleared", { project: String(m.project), squad: String(m.squad), member: (m.wt as string | null) ?? id, payload: { override: o.id, reason: "work done" } });
    }
  }
}

const sig = (p: Row | null) => (p ? [p.agent, p.model, p.account, p.slot].join("|") : "");

const queued = (r: Row) => String(r.reason ?? "").startsWith("queued:");

// Returns the members that may start now: those holding a slot, and those whose pick is an error
// (no roles.conf row, an unknown override): their start fails visibly rather than waiting forever.
export function reconcile({ store, now: at }: TickCtx, { eligible, moves }: Wanting = candidates(store, at)): Set<number> {
  const go = new Set<number>();
  clearDone(store, at);
  const inFlight = (store.db.query(`SELECT COUNT(*) AS n FROM episodes WHERE kind = 'action:member' AND state IN ('acted', 'running')
    AND subject NOT IN (SELECT 'member:' || value FROM json_each(?))`).get(JSON.stringify(eligible.map((m) => m.id))) as { n: number }).n;
  // U243: every read (phase, tier, reservation, override, pick()) runs here, outside the write lock. pick() reads
  // the slot-1 picks earned earlier in this walk, so the walk runs against a temp copy of `picks` (it shadows the
  // real table on this connection and lives in the temp database, not in the file the lock guards); the
  // transaction below only writes the result.
  const max = startSlots();
  let used = inFlight;
  const ids = JSON.stringify(eligible.map((m) => m.id));
  const plan: { m: Row; id: number; phase: string; row: Row; override: unknown }[] = [];
  const retryAt = new Map((store.db.query(`SELECT subject, next_at FROM episodes WHERE kind = 'action:member' AND state = 'pending'
    AND next_at > ? AND subject IN (SELECT 'member:' || value FROM json_each(?))`).all(at + RETRY_HOLD, ids) as { subject: string; next_at: number }[])
    .map((r) => [r.subject, Number(r.next_at)]));
  store.db.run("DROP TABLE IF EXISTS temp.picks");
  store.db.run("CREATE TEMP TABLE picks AS SELECT * FROM main.picks WHERE member IN (SELECT value FROM json_each(?))", [ids]);
  store.db.run("UPDATE temp.picks SET slot = 0");   // re-earned in order below
  // U3 (loop-tick-8s): the facts every pick() and slot() of this walk read again (each Builder's lock, pause and
  // presence, the reservations, the limits rows, the units and lanes) are read once (walk-memo.ts); a slot a pick
  // earlier in the walk took is still read live from the temp copy.
  try { withWalkMemo(store, at, () => {
    for (const m of eligible) {
      const project = String(m.project), role = String(m.role), id = Number(m.id);
      const unit = store.db.query("SELECT tier FROM units WHERE project = ? AND squad = ? AND slug = ?").get(project, String(m.squad), String(m.suffix ?? "")) as { tier: string | null } | null;
      const tier = (m.tier as string | null) ?? unit?.tier ?? null;
      // U92: the phase is reality's, not a stale stored row's; write it first.
      // U154: monotonic — babysit never goes back (a closed and reopened PR is no second restart).
      const reality = String(m.role) === "builder" ? phaseFor(store, project, m) : ((m.phase as string | null) ?? "build");
      const phase = String(m.role) === "builder" && !phaseMayWrite(m, reality) ? String(m.phase) : reality;
      let w: { agent?: string; model?: string; effort?: string } = {};
      try { w = m.want_payload && m.want_result == null ? JSON.parse(String(m.want_payload)) : {}; } catch { /* not JSON: nothing fixed */ }
      const row: Row = { project, squad: m.squad, role, tier, phase, agent: null, model: null, effort: null, account: null, fallback: null, wait_until: null, wait_known: null, slot: 0, reason: null, picked_at: at };
      const move = moves.get(id), held = reservationOf(store, id, at);
      const retry = retryAt.get(`member:${id}`);
      if (retry !== undefined) row.reason = `waiting: start retry at ${new Date(retry * 1000).toISOString().slice(0, 19)}Z`;
      else if (used >= max) row.reason = `queued: ${used} of ${max} start slots in flight`;
      else {
        const p = pick(store, { project, role, tier, phase, squad: String(m.squad), member: id, agent: w.agent ?? null, model: w.model ?? null, effort: w.effort ?? null,
          keep: held ? { agent: held.agent, model: held.model, account: held.account ?? "-" } : undefined }, at);
        if (move?.from && ("error" in p || "wait" in p || p.rung >= move.from))
          row.reason = `fallback: no higher rung than ${move.from} fits after this tick's moves`;
        else if ("error" in p) { row.reason = p.error; go.add(id); }
        else if ("wait" in p) {
          // U1: an account wait keeps when room comes back (wait_known 1: a real reset); a slot or host-brake wait has none.
          if (startWait(p)) row.reason = p.reason;
          else Object.assign(row, { reason: "no account free", wait_until: p.wait, wait_known: p.known ? 1 : 0 });
        }
        else {
          Object.assign(row, { agent: p.agent, model: p.model, effort: p.effort, account: p.account, fallback: p.fallback ? 1 : 0, slot: 1, reason: p.reason });
          used++; go.add(id);
        }
      }
      store.upsert("picks", { member: id }, row);   // the temp copy: later picks of this walk see it
      plan.push({ m, id, phase, row, override: overrideOf(store, m)?.id ?? null });
    }
  }); } finally { store.db.run("DROP TABLE IF EXISTS temp.picks"); }
  store.tx(() => {
    const before = new Map((store.db.query("SELECT * FROM picks").all() as Row[]).map((p) => [Number(p.member), p]));
    store.db.run("DELETE FROM picks WHERE member NOT IN (SELECT value FROM json_each(?))", [ids]);
    store.db.run("UPDATE picks SET slot = 0");
    const changed = new Map<string, Row[]>();     // `<project>\t<role>` -> its picks this tick
    for (const { m, id, phase, row, override } of plan) {
      const project = String(m.project), role = String(m.role);
      if (String(m.role) === "builder" && (m.phase ?? null) !== phase)
        store.setIf("members", id, "phase", phase, (m.phase as string | null) ?? null);
      store.upsert("picks", { member: id }, row);
      const now = store.get("picks", { member: id });
      const k = `${project}\t${role}`;
      if (!changed.has(k)) changed.set(k, []);
      changed.get(k)!.push({ ...now!, wt: m.wt, override, moved: sig(before.get(id) ?? null) !== sig(now) });
    }
    for (const [k, rows] of changed) {
      if (!rows.some((r) => r.moved)) continue;
      const [project, role] = k.split("\t"), first = rows.find((r) => r.moved)!;
      store.event("pick", { project, squad: String(first.squad), member: (first.wt as string | null) ?? null, payload: {
        role, tier: first.tier, phase: first.phase, agent: first.agent, model: first.model, account: first.account, wait: first.wait_until, reason: first.reason,
        ...(queued(first) ? { queued: true } : {}),
        picks: rows.map((r) => ({ member: r.member, tier: r.tier, agent: r.agent, model: r.model, account: r.account, wait: r.wait_until, slot: r.slot, override: r.override, reason: r.reason, ...(queued(r) ? { queued: true } : {}) })),
      } });
    }
  });
  return go;
}
