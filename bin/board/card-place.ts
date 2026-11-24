// card-place.ts — sorts a Studio card into Needs-you, a loop note or held back (U1; pure).
// `needs` = an ask only the operator can answer (Needs-you); `note` = loop status (the collapsed Loop notes
// under Needs-you, and on its squad's row); `later` = a card that often heals itself, held back until it has
// lasted `needs_grace_min`. board-data.ts feeds it the card and the clock.
// The rule (U7): Needs-you holds every card that only leaves when the operator acts.
// Two cards of a squad's unit wait on that squad's Lead first, as a note, until `refusal_needs_min`: a refusal of
// the squad's request (U9) and a stopped review (U2: the Builder tells its Lead, who asks the operator before any
// retry). A stopped review with no squad (no unit found) is needs at once.
export type Place = "needs" | "note" | "later";
export type CardLike = { subject?: unknown; squad?: unknown; id?: unknown; kind?: unknown; title?: unknown; since?: unknown; reason?: unknown; text?: unknown; question?: unknown };

// Kept by `kind` where the card has one, else by the id prefix or the title it had before kinds.
const NEEDS_KINDS = new Set(["out_of_credits", "login_ended", "agent_broken", "restart_failed", "review_stopped", "loop_refusal", "cancel_failed", "account_skills", "studio_move_up", "questions_dropped"]);
const NEEDS_ID = /^(loop|sweep)-studio\.(ctx|limit)-|^sweep-(account-skills|disk-pressure|tick-alarm|feedback)\.|^sweep-studio\.adopt-/;
const NEEDS_TITLE = /(^|[ :·])(studio\.ctx|studio\.limit|Studio out of credits|Studio's account removed|Agent broken|Agent broke again|Agent presence unknown|Restart failed|Reviews? stopped|Loop action refused|Cancellation failed|Lifecycle failed)$/;
// Cards that heal by themselves: they need the operator only if they last.
const GRACE_KINDS = new Set(["out_of_credits", "agent_broken"]);
const GRACE_TITLE = /(^|[ :·])(Agent broken|Agent broke again|Agent presence unknown|Studio out of credits|Lifecycle failed)$/;
const GRACE_ID = /^(loop|sweep)-studio\.(limit|adopt)-/;

const s = (v: unknown) => (typeof v === "string" ? v : "");
const epoch = (v: unknown): number | null => { const t = Date.parse(s(v)); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };

// The topic of a squad's archive debrief card: from `reason` `debrief-<topic>`, else from an id
// `sweep-debrief-<topic>-<n>`. An id `loop-debrief-…` alone is not parsed (its subject was cut to 60 characters).
export function debriefTopic(a: CardLike): string | null {
  const reason = s(a.reason).match(/^debrief-(.+)$/);
  if (reason) return reason[1];
  return s(a.id).match(/^sweep-debrief-(.+)-[0-9]+$/)?.[1] ?? null;
}

export function cardPlace(a: CardLike, now: number, graceMin = 10, refusalMin = 240): Place {
  const kind = s(a.kind), id = s(a.id), title = s(a.title);
  // U7: the morning brief and a finished squad wait on the operator, so they are needs, with no grace.
  if (/^(brief|sweep-debrief)-/.test(id) || debriefTopic(a) !== null || (kind === "poke_unanswered" && s(a.reason) === "all-done")) return "needs";
  // U287: a merge card from a rate-limited merge is a note (the budget card covers it); any other one ("merge it
  // by hand", "could not be armed") only a person clears, so it is Needs-you once it has lasted the grace.
  if (kind === "merge_card") {
    if (/rate limit|HTTP 429/i.test(s(a.text) || s(a.question))) return "note";
    const since = epoch(a.since);
    return since != null && now - since < graceMin * 60 ? "later" : "needs";
  }
  if (!NEEDS_KINDS.has(kind) && !NEEDS_ID.test(id) && !NEEDS_TITLE.test(title)) return "note";
  // U9: a refusal of a squad's one-off request went to that squad's Lead; it reaches the operator only if it lasts.
  if (kind === "loop_refusal" && /^req:/.test(s(a.subject)) && s(a.squad)) {
    const since = epoch(a.since);
    return since != null && now - since < refusalMin * 60 ? "note" : "needs";
  }
  // U2: a stopped review of a squad's unit goes to that squad's Lead first; it reaches the operator only if it lasts.
  if (kind === "review_stopped" && s(a.squad)) {
    const since = epoch(a.since);
    return since != null && now - since < refusalMin * 60 ? "note" : "needs";
  }
  const heals = GRACE_KINDS.has(kind) || GRACE_TITLE.test(title) || GRACE_ID.test(id);
  if (heals) {
    const since = epoch(a.since);
    if (since != null && now - since < graceMin * 60) return "later";
  }
  return "needs";
}
