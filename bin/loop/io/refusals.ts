// refusals.ts — U150: one classifier for every backend answer, and a refusal that will not change
// as reality (table `refusals`, migration 0025). The actuator (settle) classifies each failed try:
//   wait       no room, agent_busy, a request Orca still works on: not counted, no card
//   fixable    a cause the loop knows (causeOf: its pane gone, the Run not bound to it, Orca seeing
//              it as a worker): the loop fixes the cause and tries once more, no try spent
//   permanent  no managed account, a terminal that already has an active dispatch, a recorded
//              terminal that no longer resolves: one row, one card, no further try while the
//              fingerprint is unchanged
//   launch     a Claude launch that failed (U270: "never came up", "could not open a terminal"): tried
//              again after 60 s plus 0–30 s per subject and try (launchRetryAt), so starts that failed
//              together don't come back together; the first LAUNCH_TRIES such tries are not counted,
//              after them it is transient
//   transient  anything else: one try per subject and fingerprint every retryGap (15 minutes);
//              after DS_LOOP_SEND_TRIES tries it is permanent for its fingerprint
// The fingerprint is the wish plus the few facts its cause depends on (a fulfiller's own
// `fingerprint`, else the action's episode and payload), never an observed_at or a flapping state:
// an episode that flips between two readings of the same reality (rebind's) is one fingerprint. A
// new wish is a new fingerprint, tried at once; a permanent row under an older fingerprint then
// lapses (lapse): its card is resolved and the episode it failed is claimed again. A permanent
// row's card stays on the board while the row stands (reconcilers/alerts.ts, kind REFUSAL_KIND).
import type { Row, Store } from "../core/store.ts";

// The `kind` of a refusal card (alerts.json), so reconcilers/alerts.ts keeps it while its row stands.
export const REFUSAL_KIND = "loop_refusal";

export type Class = "wait" | "fixable" | "launch" | "transient" | "permanent";
export type Refusal = { project: string; squad?: string | null; member?: string | null; subject: string; kind: string; fingerprint: string; text: string; at: number };

// One try per subject per RETRY_GAP seconds for a transient refusal (DS_LOOP_RETRY_S).
export function retryGap(): number {
  const v = Number(process.env.DS_LOOP_RETRY_S);
  return Number.isInteger(v) && v > 0 ? v : 900;
}

// Orca's refusals that change nothing and whose cause the loop knows (U59). The loop binds its pane
// again and tries once more.
// Orca's refusal when the coordinator terminal has no stable pane identity (U93): the pane the
// start ran from is unusable, so a retry must bind a fresh pane instead of returning it.
export const STALE_PANE = /stable_pane_required/;
const CAUSES: { re: RegExp; cause: string; next: string }[] = [
  { re: /A worker starts helpers in a new agent|worker_cannot_coordinate_own_run/, cause: "Orca sees the terminal it starts from as a worker",
    next: "close the squad's `ds-loop` tab in the Lead's worktree (or the project's `ds-loop restart` tab); the loop opens a new pane and binds it" },
  { re: /consumer_fenced|not bound to Run|run_not_bound/, cause: "the loop's pane does not hold the squad's Run",
    next: "check which terminal coordinates it (orca orchestration run-show) and stop whatever adopts it; the loop takes it back each try" },
  { re: /terminal_not_found|coordinator: /, cause: "the loop has no pane to start from",
    next: "check the squad has a Run and a Lead worktree, and that Orca can open a terminal there" },
  { re: STALE_PANE, cause: "the coordinator terminal has no stable pane identity",
    next: "the loop binds a fresh pane and tries again; if it keeps failing, restart Orca or check its panes" },
];
export function causeOf(text: string): { cause: string; next: string } | null {
  return CAUSES.find((c) => c.re.test(text)) ?? null;
}

const PERMANENT = /no managed account|already has an active dispatch|recorded terminal no longer resolves/i;
const WAITS = /\bagent_busy\b|no room|still pending|no free start slot/i;
// U270: the adapter's two texts for a Claude tab that did not come up (bin/backend/orca.ts claudeTab, resumeTab).
const LAUNCH = /never came up|could not open a terminal/i;

// The uncounted quick retries of a launch failure before the transient path takes over.
export const LAUNCH_TRIES = 3;
// When launch try `n` (1-based) of this subject is tried again: 60 s plus a jitter of 0–30 s from the
// subject and the try, so subjects that failed in the same tick come back apart.
export function launchRetryAt(subject: string, n: number, at: number): number {
  return at + 60 + Number(BigInt(Bun.hash(`${subject}|${n}`)) % 31n);
}

// Permanent texts first: they are specific, and an answer that names one is that whatever else it says.
export function classify(text: string): Class {
  if (PERMANENT.test(text)) return "permanent";
  if (WAITS.test(text)) return "wait";
  if (causeOf(text)) return "fixable";
  if (LAUNCH.test(text)) return "launch";
  return "transient";
}

// Keys sorted, so the same facts always give the same fingerprint.
const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Row)[k])])) : v ?? null;
export function fingerprint(kind: string, subject: string, facts: unknown): string {
  return Bun.hash(JSON.stringify(stable([kind, subject, facts]))).toString(36);
}

// The row that stops this subject and fingerprint now: a permanent (or unknown) refusal, or a
// transient one whose next try has not come.
export function standing(store: Store, project: string, subject: string, fp: string, at: number): Row | null {
  return store.db.query(`SELECT * FROM refusals WHERE project = ? AND subject = ? AND fingerprint = ?
      AND (class != 'transient' OR COALESCE(next_at, 0) > ?)`).get(project, subject, fp, at) as Row | null;
}

// One more refusal of this subject and fingerprint. A transient one counts its tries and becomes
// permanent at `tries`; the row's class after it, and whether it changed (a new row or a new class:
// the only time a `refusal` event is written).
export function refuse(store: Store, r: Refusal, cls: "transient" | "permanent" | "unknown", tries = Infinity): { row: Row; changed: boolean } {
  return store.tx(() => {
    const key = { project: r.project, subject: r.subject, fingerprint: r.fingerprint }, old = store.get("refusals", key);
    const count = Number(old?.count ?? 0) + 1;
    const now = cls === "transient" && count >= tries ? "permanent" : cls;
    const changed = !old || old.class !== now;
    store.upsert("refusals", key, {
      squad: r.squad ?? null, member: r.member ?? null, kind: r.kind, class: now, text: r.text,
      first_at: old?.first_at ?? r.at, last_at: r.at, count, next_at: now === "transient" ? r.at + retryGap() : null,
    });
    if (changed) store.event("refusal", { project: r.project, squad: r.squad ?? null, member: r.member ?? null,
      payload: { subject: r.subject, kind: r.kind, class: now, was: old?.class ?? null, count, text: r.text } });
    return { row: store.get("refusals", key)!, changed };
  });
}

export function carded(store: Store, r: Row, at: number): void {
  store.db.run("UPDATE refusals SET carded_at = ? WHERE project = ? AND subject = ? AND fingerprint = ?", [at, r.project as string, r.subject as string, r.fingerprint as string]);
}

// What a permanent refusal depended on changed: the subject's permanent rows of this action kind
// under any other fingerprint end (returned, so the caller resolves their cards and frees the
// episode they failed). Another kind on the same subject (liveness's run-switch and alert share a
// key) is another wish and never ends them.
export function lapse(store: Store, project: string, subject: string, kind: string, fp: string): Row[] {
  const where = "project = ? AND subject = ? AND kind = ? AND fingerprint != ? AND class = 'permanent'";
  const rows = store.db.query(`SELECT * FROM refusals WHERE ${where}`).all(project, subject, kind, fp) as Row[];
  if (rows.length) store.db.run(`DELETE FROM refusals WHERE ${where}`, [project, subject, kind, fp]);
  return rows;
}

// The subject's action of this kind went through: its refusals end. The rows that had a card, so
// the caller resolves them.
export function clear(store: Store, project: string, subject: string, kind: string): Row[] {
  const rows = store.db.query("SELECT * FROM refusals WHERE project = ? AND subject = ? AND kind = ?").all(project, subject, kind) as Row[];
  if (rows.length) store.db.run("DELETE FROM refusals WHERE project = ? AND subject = ? AND kind = ?", [project, subject, kind]);
  return rows.filter((r) => r.carded_at != null);
}
