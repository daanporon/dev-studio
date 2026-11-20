// A pause resume (pause_members `resuming`) settles here; its start is the decider's (U152): the
// member's own running wish starts it once resumeGate() says it may go, on resumePrompt().
import { existsSync } from "node:fs";
import { memberOf } from "../core/actuator.ts";
import { clearOrphanIntents, clearRetiredTransition, journalPath, intents, memberKey, type Target } from "../pause/pause.ts";
import { memberUnit, mergedUnit, dependencyReasons } from "../pause/pause-conditions.ts";
import { lock } from "../squad/member-state.ts";
import { babysitPrompt, syncPhase, unitPrHead } from "./phases.ts";
import type { Row, Store } from "../core/store.ts";
import type { Reconciler } from "../core/plugins.ts";
import { handoff, withRoleNotes } from "../squad/handoff.ts";
import { STANDING } from "../drivers/types.ts";
import { REVALIDATE_WHY } from "./ready.ts";
function set(store: Store, m: Row, values: Row) {
  const row = store.get("pause_members", memberKey(m));
  if (!row || Object.entries(values).some(([k, v]) => row[k] !== v)) store.upsert("pause_members", memberKey(m), values);
}
const GATE = /^(resume waiting|retained worktree missing|resolving earlier start|failed)/;

// May this `resuming` member start fresh now? Settles what needs no start (wanted stopped, unit or
// task finished: back to active) and names what holds it (a dependency, the retained worktree, a
// given-up start: it waits on `ds resume` again). True: the decider starts it.
export function resumeGate(store: Store, m: Row, row: Row): boolean {
  const unit = memberUnit(store, m as Target);
  const squad = store.get("squads", { project: m.project, topic: m.squad });
  if (!squad || ["suspended", "closed", "gone", "archived", "cancelled"].includes(String(squad.status)) || ["suspended", "gone"].includes(String(squad.want))) return false;
  // A member wanted stopped (U151) gets no fresh session: the resume settles and keeps that wish.
  // An earlier act on it still running keeps the resume overlay until it settles.
  if (m.want !== "running") {
    if (lock(store, m)) { set(store, m, { reason: "resolving earlier start before settling the stopped wish" }); return false; }
    set(store, m, { state: "active", closed_at: null, reason: "member wanted stopped; no fresh session" }); return false;
  }
  if (unit && (["done", "cancelled"].includes(String(unit.status)) || mergedUnit(store, unit))) {
    set(store, m, { state: "active", closed_at: null, reason: "finished unit; retained resources eligible for retirement" }); return false;
  }
  if (!unit && row.task_completed && !STANDING.has(String(m.role))) {
    set(store, m, { state: "active", closed_at: null, reason: "role task finished; no fresh session needed" }); return false;
  }
  const holds = dependencyReasons(store, m as Target, []);
  if (holds.length) { set(store, m, { reason: `resume waiting: ${holds.join("; ")}` }); return false; }
  if (String(m.want_result ?? "").startsWith("failed")) { set(store, m, { reason: String(m.want_result) }); return false; }
  const tree = store.get("observed_worktrees", { project: m.project, wt: m.wt });
  if (!m.wt || !tree?.path || tree.gone_at != null || !existsSync(String(tree.path))) {
    set(store, m, { reason: `retained worktree missing: ${tree?.path ?? m.wt ?? "unrecorded"}; restore it before resuming` }); return false;
  }
  if (lock(store, m)) { set(store, m, { reason: "resolving earlier start before fresh placement" }); return false; }
  return true;
}

export function revalidateHolds(store: Store, project: string, squad: string): string[] {
  const rows = store.db.query("SELECT slug, doc FROM units WHERE project = ? AND squad = ? AND status = 'planned' AND hold = 1 ORDER BY ord IS NULL, ord, id").all(project, squad) as Row[];
  return rows.filter((u) => { try { return JSON.parse(String(u.doc ?? "{}")).hold_reason === REVALIDATE_WHY; } catch { return false; } }).map((u) => String(u.slug));
}
// The line a Thinker's start prompt carries while such holds stand (roles/thinker.md, "After a resume").
export function revalidateNote(store: Store, m: Row): string {
  if (m.role !== "thinker") return "";
  const held = revalidateHolds(store, String(m.project), String(m.squad));
  if (!held.length) return "";
  return ` This squad was suspended and has resumed: its not-started units ${held.join(", ")} are held (why "${REVALIDATE_WHY}") until you check the plan. Before anything else, check the plan against what merged on the default branch since the suspend, the files each unit touches, other squads' work and the goal, then follow "After a resume" in roles/thinker.md: still valid → release each hold; changed → revise the plan and ask approval again.`;
}

// A Builder's fresh session in its babysit phase starts on the babysit brief; anyone else on the
// handoff's own brief (undefined).
export function phasePrompt(store: Store, m: Row): string | undefined {
  const unit = memberUnit(store, m as Target);
  if (!unit || syncPhase(store, String(m.project), m) !== "babysit") return undefined;
  const { head, base, url } = unitPrHead(store, String(m.project), m);
  return babysitPrompt(store, { project: String(m.project), squad: String(m.squad), slug: String(unit.slug), pr: Number(String(unit.pr).match(/\d+$/)?.[0]),
    url, branch: head, base, wt: String(m.wt), run: String(store.get("squads", { project: m.project, topic: m.squad })?.run_id ?? "") });
}

// The prompt of a resumed member's fresh session: its brief (or the babysit brief), pointed at its
// retained journal checkpoint.
export function resumePrompt(store: Store, m: Row, row: Row): string {
  const unit = memberUnit(store, m as Target), squad = store.get("squads", { project: m.project, topic: m.squad });
  const tree = store.get("observed_worktrees", { project: m.project, wt: m.wt });
  let prompt = phasePrompt(store, m) ?? handoff(memberOf(store, { id: Number(m.id) })!, { why: "start", run: String(squad?.run_id ?? "") }).context;
  prompt += ` You are resuming fresh after pause; your conversation did not come along. Read your retained journal checkpoint first: ${journalPath(store, m as Target)}. Branch: ${tree?.branch ?? "this worktree's branch"}.${unit ? ` Unit: ${unit.slug}. Plan: ${unit.plan ?? "see squad state"}.` : ""}`;
  // U220: a wait-on pause names what it waited on, so the Builder knows to merge main and go on.
  let waited: string[] = [];
  try { waited = Object.keys((JSON.parse(String(unit?.doc ?? "{}")) as Row).wait_on ?? {}); } catch { /* no doc */ }
  if (waited.length) prompt += ` You were paused because this unit waited on ${waited.join(", ")}, which has merged: merge the default branch into your branch and continue.`;
  if (!row.checkpoint_hash) prompt += " The agent was already absent when paused; no fresh pause checkpoint was obtained, so use the existing journal.";
  return withRoleNotes(String(m.role), prompt, { restart: true });
}

const pauseResume: Reconciler = {
  name: "pause-resume",
  run(ctx) {
    clearOrphanIntents(ctx.store, ctx.project, ctx.now);
    const seen = new Set<string>();
    for (const m of ctx.store.db.query("SELECT * FROM members WHERE project = ? ORDER BY id DESC").all(ctx.project) as Row[]) {
      const key = JSON.stringify(memberKey(m)); if (seen.has(key)) continue; seen.add(key);
      if (m.want === "gone") { clearRetiredTransition(ctx.store, m as Target, ctx.now); continue; }
      const row = ctx.store.get("pause_members", memberKey(m));
      // The gate's own hold lifted: back to waiting on the start (the pick names its waits itself).
      if (row?.state === "resuming" && !intents(ctx.store, m as Target).length && resumeGate(ctx.store, m, row) && GATE.test(String(row.reason ?? "")))
        set(ctx.store, m, { reason: "awaiting fresh placement" });
    }
    return [];
  },
};
export default pauseResume;
