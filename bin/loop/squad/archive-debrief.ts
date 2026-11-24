// archive-debrief.ts — the archive's final-debrief step (debrief-on-archive U1), shared by the
// reconciler that runs it, effective() that keeps the Lead alive while it is open, the archive that
// writes the fallback line, and the board.
//
// One episode per gone wish: kind `archive-debrief`, subject `squad:<id>`, episode_key the squad's
// want_at, state open|written|timeout|lead-gone|skipped, started_at the step's start, ended_at when it
// settled, and the payload `{asked_at, limit_s, lead_wt, why, poked_at, carded_at}` as JSON in `result`.
// No import of pause.ts here: pause.ts reads debriefHold().
import type { Row, Store } from "../core/store.ts";
import { limit, limitInt } from "../settings/limits.ts";
import { prNumber } from "./cancel.ts";

export const KIND = "archive-debrief";
export const LIMIT_KEY = "archive_debrief_min";
export type StepState = "open" | "written" | "timeout" | "lead-gone" | "skipped";
export type Step = { state: StepState; asked_at: number; limit_s: number; settled_at: number | null; why: string | null;
  lead_wt: string | null; poked_at: number | null; carded_at: number | null };

const ENDED = ["closed", "archived", "gone"];
export const limitS = (store: Store, project: string): number => limitInt(store, project, LIMIT_KEY, 10) * 60;
// The per-project switch (`debrief on|off`, default on): the one place that reads the key.
export const debriefOn = (store: Store, project: string): boolean => String(limit(store, project, "debrief") ?? "on").trim() !== "off";
export const stepKey = (sq: Row) => ({ project: String(sq.project), subject: `squad:${sq.id}`, kind: KIND });

// A JSON object column (an episode result, a squad doc); anything else reads as {}.
export const parseJson = (v: unknown): Row => { try { return (JSON.parse(String(v ?? "{}")) ?? {}) as Row; } catch { return {}; } };
const numOr = (v: unknown): number | null => (v == null ? null : Number(v));

// The step of the squad's current wish: only a gone wish has one, keyed by its want_at.
export function stepOf(store: Store, sq: Row): Step | null {
  if (sq.want !== "gone" || sq.want_at == null) return null;
  const ep = store.get("episodes", stepKey(sq));
  if (!ep || ep.episode_key !== String(sq.want_at)) return null;
  const p = parseJson(ep.result);
  return { state: String(ep.state) as StepState, asked_at: Number(p.asked_at ?? ep.started_at ?? 0), limit_s: Number(p.limit_s ?? 0),
    settled_at: numOr(ep.ended_at), why: p.why == null ? null : String(p.why), lead_wt: p.lead_wt == null ? null : String(p.lead_wt),
    poked_at: numOr(p.poked_at), carded_at: numOr(p.carded_at) };
}

export function archiveDebriefStep(store: Store, project: string, topic: string): Step | null {
  const sq = store.get("squads", { project, topic });
  return sq ? stepOf(store, sq) : null;
}

// The one exception to "a member of an archived squad reads archived": the squad's Lead, still
// wanted running with a worktree, while its squad's step for this wish is open, or before the step
// is opened (the decider runs before the reconciler that opens it, so the tick the wish lands must
// not close the Lead). Once the step settles the Lead closes like every other member.
export function debriefHold(store: Store, m: Row, sq: Row | null): boolean {
  if (!sq || sq.want !== "gone" || m.role !== "lead" || (m.suffix ?? "") !== "" || !m.wt || m.want !== "running") return false;
  if (ENDED.includes(String(sq.status ?? "")) || !debriefOn(store, String(m.project))) return false;
  const step = stepOf(store, sq);
  if (step) return step.state === "open" && (step.lead_wt == null || step.lead_wt === m.wt);
  return sq.status !== "suspended" && limitS(store, String(m.project)) > 0;
}

// The archived doc's debrief: the Lead's own text when the step settled `written`, else the
// done-time text under one line that says what it misses.
export type Final = { debrief: string; source: "archive" | "done"; late: number | null; first: string; none?: string };
const unitLine = (u: Row) => `${u.slug}${prNumber(u.pr) ? ` #${prNumber(u.pr)}` : ""} (${u.status ?? "planned"})`;
const firstLine = (t: string) => t.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";

export function finalDebrief(doc: Row, units: Row[], step: Step | null): Final {
  const text = typeof doc.debrief === "string" ? doc.debrief.trim() : "";
  const written = step?.state === "written";
  if (!text) {
    const none = step && step.state !== "open" ? `${step.state}${step.why ? `: ${step.why}` : ""}` : "";
    const line = none ? `No debrief was written (${none}).` : "No debrief was written.";
    return { debrief: line, source: "done", late: null, first: line, ...(none ? { none } : {}) };
  }
  if (written) return { debrief: text, source: "archive", late: 0, first: firstLine(text) };
  if (!Array.isArray(doc.debrief_units)) {
    return { debrief: `Written before the archive; units added after it are not known.\n\n${text}`, source: "done", late: null, first: firstLine(text) };
  }
  const known = new Set((doc.debrief_units as unknown[]).map(String));
  const late = units.filter((u) => !known.has(String(u.slug)));
  const at = String(doc.debrief_at ?? "unknown time");
  const line = late.length
    ? `Written at done (${at}); ${late.length} unit${late.length === 1 ? " was" : "s were"} added after it: ${late.map(unitLine).join(", ")}.`
    : `Written at done (${at}); no units were added after it.`;
  return { debrief: `${line}\n\n${text}`, source: "done", late: late.length, first: firstLine(text) };
}

// The card's line on where the debrief came from.
export function provenance(f: Final): string {
  if (f.source === "archive") return "written at archive by the Lead";
  if (f.late == null) return f.none ? `no debrief (${f.none})` : f.first === "No debrief was written." ? "no debrief was written" : "written before the archive; units added after it are not known";
  return `written at done; ${f.late} unit${f.late === 1 ? "" : "s"} added after it`;
}

// The squad's units as the archive lists them, in the doc's order.
export function unitsOf(store: Store, project: string, topic: string): Row[] {
  return store.db.query("SELECT * FROM units WHERE project = ? AND squad = ? ORDER BY ord IS NULL, ord, id").all(project, topic) as Row[];
}
