// github-view.ts — what the board shows of the loop's GitHub API budget (U287; pure).
// board-data.ts reads the PR observer's schedule row (observed_github, repo '') and the open merge-ready PRs
// and hands them here; nothing is written, so the card below is gone the moment the budget is back or the
// PRs merge.
import { isRateLimit } from "../loop/io/github-budget.ts";

export type GithubRow = { remaining?: unknown; rate_limit?: unknown; cost?: unknown; reset_at?: unknown; interval_s?: unknown; error?: unknown } | null | undefined;
export type GithubView = {
  remaining: number | null; limit: number | null; cost: number | null; reset_at: number | null; interval_s: number | null;
  error: string | null; pct: number | null; level: "ok" | "low" | "out";
};

const LOW_PCT = 20;
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// Null when the observer has not recorded a budget or a refusal yet.
export function githubView(r: GithubRow, now: number): GithubView | null {
  if (!r) return null;
  const remaining = num(r.remaining), limit = num(r.rate_limit), resetAt = num(r.reset_at);
  const error = typeof r.error === "string" && r.error ? r.error : null;
  if (remaining === null && !error) return null;
  // Used up: nothing left, or the last read was refused for the rate limit; a passed reset time ends it.
  const spent = remaining === 0 || (error !== null && isRateLimit(error));
  const out = spent && !(resetAt !== null && now >= resetAt);
  const pct = remaining !== null && limit ? Math.round((remaining / limit) * 100) : null;
  return { remaining, limit, cost: num(r.cost), reset_at: resetAt, interval_s: num(r.interval_s), error,
    pct, level: out ? "out" : pct !== null && pct < LOW_PCT ? "low" : "ok" };
}

const hm = (t: number) => { const d = new Date(t * 1000); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };

// The text board's one line: only when the budget is under 20 % or used up.
export function githubLine(g: GithubView | null, waiting: number): string | null {
  if (!g || g.level === "ok") return null;
  const reset = g.reset_at !== null ? ` — resets ${hm(g.reset_at)}Z` : "";
  return g.level === "out"
    ? `GITHUB API limit used up${reset}; ${waiting} PR${waiting === 1 ? "" : "s"} waiting to merge`
    : `GITHUB API ${g.pct}% left (${g.remaining}/${g.limit})${reset}`;
}

export type WaitingPr = { project: string; num: string };

// The one Needs-you card per project while the budget is used up and a merge-ready PR is open; null otherwise.
export function budgetCard(project: string, g: GithubView | null, waiting: WaitingPr[]) {
  const mine = waiting.filter((p) => p.project === project);
  if (!g || g.level !== "out" || !mine.length) return null;
  const when = g.reset_at !== null ? `until ${hm(g.reset_at)}Z` : "for now";
  const text = `GitHub API limit used up ${when} — ${mine.length} merge-ready PR${mine.length === 1 ? "" : "s"} wait (${mine.map((p) => "#" + p.num).join(", ")}); the loop merges them after the reset.`;
  return { project, id: `github-budget:${project}`, kind: "github_budget", title: `GitHub API limit used up ${when}`, text, reset_at: g.reset_at };
}

const MERGE_TITLE = /(Auto-merge not armed|Merge-ready PR left open)$/;
// A Lead's copy of a merge card is dropped when the Studio's card already names the same PR (`has`).
export function dropLeadMergeCopies<Q extends { title?: unknown; question?: unknown }>(questions: Q[], has: (q: Q) => boolean): Q[] {
  return questions.filter((q) => !(MERGE_TITLE.test(String(q.title ?? q.question ?? "")) && has(q)));
}
