// queued-builder.ts — a Builder that has not started follows its unit (hold-cancels-queue-undo-approval U1).
//
// A queued Builder is a member wish the loop (reconcilers/ready.ts ensureBuilder) or a Lead
// (`ds request builder --unit`) wrote that never ran: role builder, wished running, status `wanted`,
// no worktree, never placed, no pause row. Such a wish holds no work, so when its unit should not
// start any more it is withdrawn: wished gone and settled `gone` at once (the row is kept), so the
// unit's next ready tick writes a fresh wish.
//
//   queuedWhy(store, m)    why this queued wish must go, or null: any wish whose unit is cancelled or
//                          done; a loop wish (`want_by` loop) whose planned unit is not ready (held,
//                          waiting, a blocking question, deps no longer met) or whose plan is not approved. A Lead's
//                          wish bypasses hold and approval, as it did before; a hold or cancel placed
//                          after it withdraws it through the command (squad-state.ts).
//   withdraw(store, m, …)  the wish gone + status gone + one `builder_wish_withdrawn` event.
//   unitWishes(…)          a unit's queued wishes (squad-state's set-unit-hold on and cancel-unit).
//   settleWithdrawn(…)     a builder wished gone that has no worktree and no start out (a hand
//                          `want gone`, or a row from before this unit) is settled `gone`.
// Callers: ready.ts every tick, fulfil/member.ts before a start, squad-state.ts in the command's write.
import type { Row, Store } from "../core/store.ts";
import { now } from "../core/store.ts";
import { approvedPlans, readyUnits } from "../reconcilers/ready.ts";
import { entryOf, waiting } from "../messages/questions.ts";
import { memberKey } from "../pause/pause.ts";
import { lastStart, lock } from "./member-state.ts";

export type WithdrawWhy = "held" | "cancelled" | "done" | "not ready" | "plan not approved";

const UNIT_COLS = "id, slug, status, deps, ext_deps, hold, wait_until, superseded_by, into_merged, tier, plan";

function wishUnit(m: Row): string {
  try {
    const p = JSON.parse(String(m.want_payload ?? "{}"));
    if (p && typeof p.unit === "string" && p.unit) return p.unit;
  } catch { /* a torn payload names no unit */ }
  return String(m.suffix ?? "");
}

// A start call of this member sent and not settled (a wt-less member's calls carry no worktree, so
// lock() cannot see them).
const callOut = (store: Store, m: Row): boolean =>
  !!store.db.query("SELECT 1 FROM orca_calls WHERE key LIKE ? AND state IN ('sent', 'pending') LIMIT 1").get(`start:${Number(m.id)}:%`);
// A start of this member out right now: its action claimed or running, or a start call out.
const inFlight = (store: Store, m: Row): boolean => lock(store, m) || callOut(store, m);

// A paused or resuming member belongs to the pause flow.
function pauseOwned(store: Store, m: Row): boolean {
  const p = store.get("pause_members", memberKey(m));
  return !!p && p.state !== "active";
}
// The squad's builder rows wished running and still `wanted`: the candidates for a queued wish.
const wantedBuilders = (store: Store, project: string, squad: string): Row[] =>
  store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = 'builder' AND want = 'running' AND COALESCE(status, '') = 'wanted'").all(project, squad) as Row[];

// A wish that never ran. `startOut` false: the caller is the start itself (fulfil/member.ts holds its
// own claim and has checked its own call), so only another start call out keeps it.
export function queued(store: Store, m: Row, startOut = true): boolean {
  if (m.role !== "builder" || m.want !== "running" || m.wt || String(m.status ?? "") !== "wanted" || lastStart(m) > 0) return false;
  if (pauseOwned(store, m)) return false;
  return !(startOut ? inFlight(store, m) : callOut(store, m));
}

// Why this member's queued wish must go now, or null to keep it (or it is not a queued wish).
export function queuedWhy(store: Store, m: Row, startOut = true, at = now()): WithdrawWhy | null {
  if (!queued(store, m, startOut)) return null;
  const project = String(m.project), squad = String(m.squad), slug = wishUnit(m);
  const u = store.db.query(`SELECT ${UNIT_COLS} FROM units WHERE project = ? AND squad = ? AND slug = ?`).get(project, squad, slug) as Row | null;
  if (!u) return null;
  if (u.status === "cancelled") return "cancelled";
  if (u.status === "done") return "done";
  // A Lead's wish bypasses hold and approval; a unit the Lead moved on by hand (dispatched, in review)
  // keeps the Builder it is waiting for.
  if (m.want_by !== "loop" || u.status !== "planned") return null;
  const units = store.db.query(`SELECT ${UNIT_COLS} FROM units WHERE project = ? AND squad = ?`).all(project, squad) as Parameters<typeof readyUnits>[2];
  const questions = waiting(store, project, squad).map(entryOf);
  if (!readyUnits(store, project, units, at, questions).some((r) => r.slug === slug)) return u.hold ? "held" : "not ready";
  const sq = store.get("squads", { project, topic: squad });
  let doc: { approved_plans?: unknown } = {};
  try { doc = JSON.parse(String(sq?.doc ?? "{}")); } catch { /* no approvals */ }
  if (!approvedPlans(store.root, doc.approved_plans, (u.plan as string | null) ?? null)) return "plan not approved";
  return null;
}

// The wish gone and the row settled gone in one write; `reason` is the command's own text (a hold's
// --why, a cancel's --why).
export function withdraw(store: Store, m: Row, why: WithdrawWhy, by: string, reason?: string, at = now()): void {
  const unit = wishUnit(m), said = reason ? { reason } : {};
  store.tx(() => {
    store.want("member", String(m.id), "gone", { by, why: `withdrawn: ${why}`, payload: { withdrawn: { unit, why, ...said } } });
    store.fact("builder_wish_withdrawn", [{ table: "members", key: { id: m.id }, set: { status: "gone", updated_at: at } }],
      { project: String(m.project), squad: String(m.squad), member: `builder/${m.suffix ?? ""}`, unit,
        payload: { id: Number(m.id), unit, why, by, ...said } });
  });
}

// The queued wishes of one unit (its suffix, or a payload naming it).
export function unitWishes(store: Store, project: string, squad: string, slug: string): Row[] {
  return wantedBuilders(store, project, squad).filter((m) => wishUnit(m) === slug && queued(store, m));
}

// Every queued wish of the squad the rule refuses, withdrawn by the loop; returns how many.
export function withdrawRefused(store: Store, project: string, squad: string, at = now()): number {
  let n = 0;
  for (const m of wantedBuilders(store, project, squad)) {
    const why = queuedWhy(store, m, true, at);
    if (why) { withdraw(store, m, why, "loop", undefined, at); n++; }
  }
  return n;
}

// A builder wished gone with no worktree has nothing for the decider to close, so without this it
// stays `wanted` and blocks its unit's next wish (ensureBuilder counts any row not gone as live).
export function settleWithdrawn(store: Store, project: string, squad: string, at = now()): number {
  let n = 0;
  for (const m of store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = 'builder' AND want = 'gone' AND COALESCE(wt, '') = '' AND COALESCE(status, '') NOT IN ('gone', 'closed')")
    .all(project, squad) as Row[]) {
    if (pauseOwned(store, m) || inFlight(store, m)) continue;
    const unit = wishUnit(m);
    store.fact("builder_wish_settled", [{ table: "members", key: { id: m.id }, set: { status: "gone", updated_at: at } }],
      { project, squad, member: `builder/${m.suffix ?? ""}`, unit, payload: { id: Number(m.id), unit, was: String(m.status ?? "") } });
    n++;
  }
  return n;
}
