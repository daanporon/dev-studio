// needs-rules.ts — what the board counts as Needs-you, in one pure module (morning-brief-stale-items U1).
// board-data.ts builds its `needs_you` list through these rules and `ds briefing-input` reads the same
// ones, so the brief lists only what the board lists and the two cannot drift apart. No db, no clock:
// callers pass the rows, the time and the limits.
import { cardPlace, type CardLike, type Place } from "./card-place.ts";
import { dropLeadMergeCopies } from "./github-view.ts";

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// A PR number out of a `pr` value: "owner/repo#12", "#12", a url or a number.
export const prNumber = (v: unknown): string => String(v).match(/(\d+)\/?$/)?.[1] ?? String(v).replace(/^#/, "");

// An untitled question's one-line row.
export function shortTitle(q: string, id?: string | null): string {
  const m = typeof id === "string" ? id.match(/^plan-(.+)$/) : null;
  if (m && m[1]) return `Approve plan: ${m[1]}?`;
  const t = q.replace(/\s+/g, " ").trim().replace(/(^|\s)~?\/\S*\/([^\s/]+)/g, "$1$2").split(/(?<=[.?!])\s/)[0];
  return t.length > 80 ? t.slice(0, 80).replace(/\s\S*$/, "") + "…" : t;
}

// Whose questions the board lists: every squad that is not closed (the board never reads a closed
// squad) and not suspended or on hold.
export const squadListed = (status: unknown): boolean => String(status ?? "") !== "closed";
export const questionsCount = (status: unknown): boolean => squadListed(status) && status !== "suspended" && status !== "on-hold";

// The status the board shows for a stored one: `waiting-on-you` with nothing queued is `running`.
export function shownStatus(status: string, queued: number): string {
  return status === "waiting-on-you" && queued === 0 ? "running" : status;
}

// A squad the Lead marked done that waits only for the operator to Close it (the board's done row).
export const doneWaits = (status: unknown, shown: unknown, error: boolean): boolean => status === "done" && shown === "done" && !error;

// One queued question of a squad doc, as the board lists it.
export type QuestionItem = { id: string | null; asker: string | null; blocking: boolean; question: string | null; title: string; titled: boolean; since: string | null; pr: { num: string } | null };
export function questionItems(doc: any): QuestionItem[] {
  return arr(doc?.waiting_on_you).map((x) => ({
    id: x.id ?? null, asker: x.asker ?? null, blocking: x.blocking === true, question: x.question ?? null,
    title: x.title ?? shortTitle(String(x.question ?? ""), x.id ?? null), titled: !!x.title, since: x.since ?? null,
    pr: x?.pr == null || x.pr === false || String(x.pr) === "" ? null : { num: prNumber(x.pr) },
  }));
}

// Fix squads a Thinker proposed and nobody has spawned.
export const proposalsOf = (doc: any): { id: string | null; topic: string | null }[] =>
  arr(doc?.proposed_squads).filter((p) => p?.status !== "spawned").map((p) => ({ id: p.id ?? null, topic: p.topic ?? null }));

// A Studio card's place (needs / note / later), with the project's two limits.
export function placeAlert(card: CardLike, now: number, graceMin: number | null, refusalMin: number | null): Place {
  return cardPlace(card, now, graceMin ?? 10, refusalMin ?? 240);
}

// One Studio card's PR number (its `ref`), for the one-card-per-PR rule.
export const mergePrOf = (ref: unknown): string | null => (ref == null || String(ref) === "" ? null : /^\d+$/.test(prNumber(ref)) ? prNumber(ref) : null);

// A Lead's copy of a merge card goes when the Studio's card names the same PR.
export function dropMergeCopies<Q extends { title?: unknown; question?: unknown; pr?: { num?: unknown } | null }>(questions: Q[], studioMergePrs: Set<string>): Q[] {
  return dropLeadMergeCopies(questions, (q) => q.pr?.num != null && studioMergePrs.has(String(q.pr.num)));
}
