// github.ts — the GitHub PR observer (U5, R10): every open PR of every project's repo in one
// GraphQL POST, into observed_prs (Bun). It replaces the per-PR `gh` calls of the sweep's pr_health
// (step 9) and the board.
//
// Shape (the spike's S3 observer mode, docs/spikes/loop-coordinator.md):
//   - one aliased `repository` block per repo: its open PRs without mergeability, 100 per page
//     (`detail: light`); asking mergeability for 100 PRs runs past GitHub's 10 s timeout
//   - `pr<N>: pullRequest(number: N)` per unit PR the sweep watches (dispatched, or done while its
//     Builder is still a member; `detail: full`): mergeability and the required checks, the exact
//     fields pr_health judges, and a merge is seen after the PR leaves the open page
//   - one POST per poll while every repo has at most 100 open PRs and at most 20 unit PRs are
//     watched; a further page, 20 more unit PRs, or the threads of a PR with more threads than one
//     page, cost one more POST each
// A poll runs every DS_LOOP_GITHUB_S (30) seconds at most (paced, below), or on the tick a `prs:refresh` timer fires. It
// never blocks a tick for more than a moment: a slow answer is applied on the tick it lands.
//
// Rows: (project, `<owner>/<name>#<n>`) for every project whose squads use the repo. A PR that left
// the query without a merge gets `gone_at`; a merged one keeps its row with `merged_at`. Derived
// columns follow prHealthLine in bin/lib/lib.ts (verdict, reasons) and the sweep's stale_prs (`since`,
// `problem`); `stale` is a blocked PR whose problem is at least pr_stale_min (limits.conf) old.
// Ported from the old shell lib pr_health and the removed sweep stale_prs at origin/main 1edf8b0 (#160: the
// required:<context> reason).
//
// Budget (U286, bin/loop/io/github-budget.ts): every POST asks rateLimit { limit cost remaining resetAt },
// kept on the schedule row (repo ''). The next read waits max(DS_LOOP_GITHUB_S, cost x 3600 /
// (github_budget_share x limit)), or for resetAt when fewer than two reads' cost remain; a prs:refresh
// timer reads at once only while there is room. The open page asks threads without their first comment.
//
// Failures never drop rows: a rate limit doubles the interval up to five minutes (reset by the next
// answer), or waits for GitHub's reset when `gh api rate_limit` says the GraphQL bucket is empty; a repo GitHub could not answer keeps its rows, and a unit PR GitHub cannot resolve
// (deleted, transferred) is marked gone without blanking its repo. Repo owner/name come from a
// squad's `repo` (`path:<repo dir>`) through `git remote get-url origin`, observed once per
// selector into `config` rows (file `github`), next to each repo's default branch.
//
// The merge read (brief-other-prs U1): every merged PR of each watched repo goes into observed_merges,
// from a cursor on the repo's observed_github row (merges_from .. merges_until). When a repo's read is
// due (merges_next_at), the POST carries one top-level `m_<alias>: search(...)` asking for the PRs merged
// in [merges_until - 30 min, min(now, that + 1 day)] (search can lag; rows upsert by (repo, pr), so the
// overlap adds nothing twice); further pages ride on the poll's next POSTs. The first read starts the
// record 4 days back. A read that ends more than 10 minutes before now makes the next one due at once
// (backfill and catch-up after downtime are the same walk), else after DS_LOOP_MERGES_S (600). Search
// gives at most 1,000 results, so a range over 900 records nothing and is asked again as 6 h, then 1 h;
// an hour still over is skipped with merges_error set. Bot authors are not stored, a deleted one is
// `ghost`, a name is the User's name else the login. A failed merge field sets merges_error and keeps the
// cursor; it never fails the open-PR read. With no merge read due the query is what it was before.
//
// A unit PR whose read fails with an error on its path keeps its row, which then says nothing new: it
// can stay "ready" after CI turned red, and a merge goes unseen. Its episode (kind `pr-read-failing`,
// subject the ref) remembers the first failure and its error: after STUCK_AFTER seconds one Studio
// alert names the PR, and a later poll that no longer fails it resolves the alert and ends the episode,
// so a new failure alerts again. A repo GitHub could not answer says nothing about the PR either way.
import { alert, resolveAlert, STUCK_AFTER } from "../core/actuator.ts";
import { errOf, type Out } from "../io/orca.ts";
import type { Observer, TickCtx } from "../core/plugins.ts";
import { limit } from "../settings/limits.ts";
import { repoOf, prUrl } from "../settings/projects.ts";
export { prUrl } from "../settings/projects.ts";
import type { Row, Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { ROOT } from "../core/store.ts";
import { feedbackRepo } from "../feedback/post.ts";
import { budgetBackAt, budgetOf, budgetShare, hasBudget, isRateLimit, pace, RESET_GRACE_S, rateLimitedBody, restRateLimit, type Rest, type RestLimit } from "../io/github-budget.ts";

export type GhResult = { code: number; stdout: string; stderr: string };
export type Gh = (query: string) => Promise<GhResult>;
type Nwo = string; // owner/name

export const MAX_INTERVAL_S = 300;
export const baseInterval = () => envInt("DS_LOOP_GITHUB_S", 30);
const PAGE = 100;

// `gh api graphql`, the query as a JSON body on stdin. DS_GH may be several words
// ("devenv shell -- gh"), as in the sweep.
export function ghCli(timeoutMs = 60_000): Gh {
  return async (query) => {
    const cmd = (process.env.DS_GH || "gh").split(/\s+/).filter(Boolean);
    const p = Bun.spawn([...cmd, "api", "graphql", "--input", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(JSON.stringify({ query }));
    p.stdin.end();
    const kill = setTimeout(() => p.kill(), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    } finally { clearTimeout(kill); }
  };
}

// --- pr_health, ported -----------------------------------------------------------------------

export type Health = { verdict: "ready" | "waiting" | "blocked" | "merged" | "closed"; reasons: string[]; ci: "green" | "red" | "pending" };
const FAILED_RUN = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
const truthy = (v: unknown) => v !== false && v !== null && v !== undefined; // jq's truthiness
const unresolved = (t: any) => (Array.isArray(t?.nodes) ? t.nodes : []).filter((x: any) => x?.isResolved !== true).length;
const blocking = (r: string) => r !== "checks-running" && r !== "mergeable-unknown" && !r.startsWith("required:");
// Every reason is required:<context>: nothing but a status nobody has posted stands between the PR
// and ready, and that can last forever (the sweep's required_only).
export const requiredOnly = (reasons: string[]) => reasons.length > 0 && reasons.every((r) => r.startsWith("required:"));

const notSkipped = (c: any) => !["SKIPPED", "NEUTRAL"].includes(c?.conclusion ?? "");
function expectedMissing(ctx: any[], expected: string[]): string[] {
  const landed = new Set(ctx.filter(notSkipped).map((c) => c?.name ?? c?.context));
  return expected.filter((c) => !landed.has(c));
}
// A head keeps every run of a check (a retarget adds one, and may cancel the older), so for an expected
// check only the newest run that did not skip is judged.
function latestRuns(ctx: any[], expected: string[]): any[] {
  const runs = ctx.filter((c) => c?.__typename === "CheckRun" && c.databaseId != null && expected.includes(c.name ?? "") && notSkipped(c));
  return ctx.filter((c) => !runs.some((r) => r.name === c?.name && r.databaseId > (c?.databaseId ?? 0)));
}
// A status check the base branch requires (rulesets plus classic protection's refUpdateRule) that
// the head's rollup does not carry at all: required:<context>, one per name, sorted, a comma as ";".
// An expected check the rollup has not at all, or only as SKIPPED or NEUTRAL, reads the same.
function missingRequired(pr: any, ctx: any[], expected: string[]): string[] {
  const posted = new Set(ctx.map((c) => c?.name ?? c?.context));
  const rules = (pr.baseRef?.rules?.nodes ?? []).filter((r: any) => r?.type === "REQUIRED_STATUS_CHECKS")
    .flatMap((r: any) => (r.parameters?.requiredStatusChecks ?? []).map((c: any) => c?.context));
  const names = [...rules, ...(pr.baseRef?.refUpdateRule?.requiredStatusCheckContexts ?? [])]
    .filter((c): c is string => typeof c === "string" && c !== "" && !posted.has(c));
  return [...new Set([...names, ...expectedMissing(ctx, expected)])].sort().map((c) => `required:${c.replace(/,/g, ";").replace(/[\t\n\r]/g, " ")}`);
}

// prHealthLine (bin/lib/lib.ts) over one PR node. A full node carries `commits(last: 1)` contexts with
// isRequired (checks judge only the required ones when any is, else all; zero checks is green);
// a light node has only `statusCheckRollup.state`, no mergeability and no base rules, so `expected`
// (the project's expected_checks) judges only a full node. Null when the node is.
export function prHealth(pr: any, expected: string[] = []): Health | null {
  if (!pr || typeof pr !== "object") return null;
  if (pr.state === "MERGED") return { verdict: "merged", reasons: [], ci: "green" };
  if (pr.state === "CLOSED") return { verdict: "closed", reasons: [], ci: "green" };
  const threads = unresolved(pr.reviewThreads);
  let failing: boolean, running: boolean, noResult = false, missing: string[] = [];
  if (pr.commits !== undefined) {
    const ctx: any[] = (pr.commits?.nodes ?? [])[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    const judged = judgedChecks(ctx, expected);
    failing = judged.some(isFailed);
    running = judged.some((c) => c?.__typename === "CheckRun" ? (c.status ?? "") !== "COMPLETED" : ["EXPECTED", "PENDING"].includes(c?.state ?? ""));
    missing = missingRequired(pr, ctx, expected);
    noResult = expectedMissing(ctx, expected).length > 0;
  } else {
    const s = pr.statusCheckRollup?.state ?? "";
    failing = s === "FAILURE" || s === "ERROR";
    running = s === "PENDING" || s === "EXPECTED";
  }
  const reasons = [
    truthy(pr.isDraft) && "draft",
    pr.mergeable === "CONFLICTING" && "conflicting",
    pr.mergeStateStatus === "BEHIND" && "behind",
    failing && "checks-failing",
    running && "checks-running",
    ...missing,
    pr.mergeable === "UNKNOWN" && "mergeable-unknown",
    threads > 0 && `threads:${threads}`,
    pr.reviewDecision === "CHANGES_REQUESTED" && "changes-requested",
  ].filter((r): r is string => typeof r === "string");
  const blocked = reasons.some(blocking);
  return { verdict: blocked ? "blocked" : reasons.length ? "waiting" : "ready", reasons, ci: failing ? "red" : running || noResult ? "pending" : "green" };
}

const judgedChecks = (ctx: any[], expected: string[]): any[] => {
  const live = latestRuns(ctx, expected);
  return live.some((c) => c?.isRequired === true)
    ? live.filter((c) => c?.isRequired === true || expected.includes(c?.name ?? c?.context ?? "")) : live;
};
const isFailed = (c: any): boolean => c?.__typename === "CheckRun"
  ? c.status === "COMPLETED" && FAILED_RUN.includes(c.conclusion ?? "")
  : ["FAILURE", "ERROR"].includes(c?.state ?? "");
// The checks prHealth judged failed on a full node, for the unit PR news poke: name, the check run's
// id (a job id: `gh run view --job <id> --log-failed`) when it is a CheckRun, and `run` (U214), what
// tells one failed run of a check from the next: the CheckRun's databaseId, a StatusContext's createdAt.
const runOf = (c: any): string => String(c?.databaseId ?? c?.createdAt ?? "");
const nodeCtx = (node: any): any[] => (node?.commits?.nodes ?? [])[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
const asFailed = (c: any) => ({ name: String(c.name ?? c.context ?? "?"), id: c.databaseId ?? null, run: runOf(c) });
export function failedChecks(node: any, expected: string[] = []): { name: string; id: number | null; run: string }[] {
  return judgedChecks(nodeCtx(node), expected).filter(isFailed).map(asFailed);
}
// U214: when a required check is what the PR is judged on, the other checks of the head's latest runs
// that failed (the lanes behind it). Shown in the poke, never news by themselves.
export function failedLanes(node: any, expected: string[] = []): { name: string; id: number | null; run: string }[] {
  const ctx = nodeCtx(node), judged = judgedChecks(ctx, expected);
  if (!latestRuns(ctx, expected).some((c) => c?.isRequired === true)) return [];
  return latestRuns(ctx, expected).filter((c) => !judged.includes(c) && isFailed(c)).map(asFailed);
}

// The sweep's problem_key: the blocking reasons, `threads:<n>` as `threads`.
export function problemKey(reasons: string[]): string {
  return reasons.filter(blocking).map((r) => (r.startsWith("threads:") ? "threads" : r)).join(",");
}

// `since`, the start of a PR's red stretch (U178): ready and a wait on required:* alone start over;
// any other waiting keeps it; blocked keeps it after blocked or waiting, whatever reasons GitHub
// reports in between (it reshuffles them on one head: `conflicting,checks-failing` ↔
// `checks-failing`), so a reshuffle is not a new stretch with new pokes. A merge or close starts
// over once, then keeps its own.
export function carrySince(h: Health, old: Row | null, at: number): number {
  const o = old && old.since != null ? Number(old.since) : null;
  if (h.verdict === "waiting") return requiredOnly(h.reasons) ? at : o ?? at;
  if (h.verdict === "blocked" && o != null && (old!.verdict === "blocked" || old!.verdict === "waiting")) return o;
  if (h.verdict === "merged" || h.verdict === "closed") return o != null && old!.verdict === h.verdict ? o : at;
  return at;
}

const review = (d: unknown) => (d === "APPROVED" ? "approved" : d === "CHANGES_REQUESTED" ? "changes" : d === "REVIEW_REQUIRED" ? "requested" : "none");
const epoch = (iso: unknown) => (typeof iso === "string" && iso ? Math.floor(Date.parse(iso) / 1000) || null : null);

// --- the query -------------------------------------------------------------------------------

const LIGHT = "number url title headRefName baseRefName isDraft state reviewDecision mergedAt updatedAt "
  + "statusCheckRollup { state } reviews(last: 20) { nodes { state author { login } submittedAt body } }";
// U275: each thread also names where it is (path, line) and who opened it (first comment: author, url), never a body.
const THREAD_NODE = "isResolved isOutdated path line comments(first: 1) { nodes { url author { login } } }";
// U286: the open page's threads only count (nothing reads who opened them): the first comment of 50
// threads on 100 PRs was 50 of the ~52 points a repo's page cost.
const THREAD_LIGHT = "isResolved isOutdated path line";
const threadsSel = (first: number, node = THREAD_NODE) => `reviewThreads(first: ${first}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${node} } }`;
// A unit's PR: what pr_health asks, isRequired bound to the PR's own number.
const full = (n: number) => `${LIGHT} files(first: 100) { nodes { path } } headRefOid mergeable mergeStateStatus autoMergeRequest { enabledAt } ${threadsSel(100)} `
  + `baseRef { rules(first: 50) { nodes { type parameters { ... on RequiredStatusChecksParameters { requiredStatusChecks { context } } } } } refUpdateRule { requiredStatusCheckContexts } } `
  + `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename `
  + `... on CheckRun { name databaseId status conclusion isRequired(pullRequestNumber: ${n}) } `
  + `... on StatusContext { context state createdAt isRequired(pullRequestNumber: ${n}) } } } } } } }`;
const q = (s: string) => JSON.stringify(s);
// A feedback issue this host filed (ds-feedback-github-issues U5): how it ended and the PR that closed it.
const ISSUE_PREFIX = "fi";
const ISSUE_NODE = "number state stateReason closedByPullRequestsReferences(first: 5, includeClosedPrs: false) { nodes { number merged mergedAt mergeCommit { oid } } }";
const MERGE_NODE = "... on PullRequest { number title baseRefName mergedAt author { __typename login ... on User { name } } }";
// GitHub search's time form: 2026-11-17T10:00:00+00:00.
const searchTime = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
export const mergeQuery = (nwo: Nwo, from: number, to: number) => `repo:${nwo} is:pr is:merged merged:${searchTime(from)}..${searchTime(to)}`;
export const mergeAlias = (nwo: Nwo) => `m_${alias(nwo)}`;
export const alias = (nwo: Nwo) => `r_${nwo.replace(/[^A-Za-z0-9]/g, "_")}`;

// One POST: per repo its next open page (`page`: a cursor, null = the first, absent = none left)
// with unit PRs in full, or only thread pages of single PRs; and a page of its merge read (`merges`).
type Ask = { nwo: Nwo; page?: string | null; tracked?: number[]; issues?: number[]; threads?: Map<number, string>; merges?: { from: number; to: number; after: string | null } };
export function buildQuery(asks: Ask[]): string {
  let s = "query { rateLimit { limit cost remaining resetAt }";
  for (const a of asks) {
    const [owner, name] = a.nwo.split("/");
    let b = "";
    if (a.page !== undefined) {
      b += `nameWithOwner defaultBranchRef { name } pullRequests(states: OPEN, first: ${PAGE}, after: ${a.page === null ? "null" : q(a.page)}, `
        + `orderBy: {field: CREATED_AT, direction: ASC}) { totalCount pageInfo { hasNextPage endCursor } nodes { ${LIGHT} ${threadsSel(50, THREAD_LIGHT)} } }`;
    }
    for (const n of a.issues ?? []) b += ` ${ISSUE_PREFIX}${n}: issue(number: ${n}) { ${ISSUE_NODE} }`;
    for (const n of a.tracked ?? []) b += ` pr${n}: pullRequest(number: ${n}) { ${full(n)} }`;
    for (const [n, after] of a.threads ?? []) b += ` t${n}: pullRequest(number: ${n}) { reviewThreads(first: 100, after: ${q(after)}) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_NODE} } } }`;
    if (b) s += ` ${alias(a.nwo)}: repository(owner: ${q(owner)}, name: ${q(name)}) { ${b.trim()} }`;
    const m = a.merges;
    if (m) s += ` ${mergeAlias(a.nwo)}: search(type: ISSUE, first: ${PAGE}, after: ${m.after === null ? "null" : q(m.after)}, query: ${q(mergeQuery(a.nwo, m.from, m.to))}) `
      + `{ issueCount pageInfo { hasNextPage endCursor } nodes { ${MERGE_NODE} } }`;
  }
  return `${s} }`;
}

// --- one poll ----------------------------------------------------------------------------------

export class RateLimited extends Error {}
type RepoResult = { issues: Map<number, any>; ok: boolean; error: string | null; open: Map<number, any>; tracked: Map<number, any | null>; failed: Map<number, string>; total: number | null; defaultBranch: string | null };
// A merge read's outcome: the range it covered and its PR nodes, or why not. `skipped`: more merges
// than search returns even in one hour, so the range is passed over (error says which).
export type MergeResult = { from: number; to: number; nodes: any[]; error: string | null; skipped: boolean };
// A due merge read: `start` is the cursor (merges_until, or now - 4 days on the first read), `from` 30
// minutes before it, `now` when it was planned.
export type MergeAsk = { start: number; from: number; now: number };
export type Poll = { repos: Map<Nwo, RepoResult>; merges: Map<Nwo, MergeResult>; posts: number; cost: number; remaining: number | null; limit: number | null; resetAt: number | null };
export const emptyPoll = (): Poll => ({ repos: new Map(), merges: new Map(), posts: 0, cost: 0, remaining: null, limit: null, resetAt: null });

export const MERGE_OVERLAP_S = 1800;
export const MERGE_BACKFILL_S = 4 * 86400;
export const MERGE_CAUGHT_UP_S = 600;
export const MERGE_CAP = 900;
const MERGE_SPANS = [86400, 6 * 3600, 3600];
export const mergesInterval = () => envInt("DS_LOOP_MERGES_S", 600);

function rateLimited(r: GhResult, body: any): boolean {
  if (rateLimitedBody(body)) return true;
  return !body?.data && r.code !== 0 && isRateLimit(`${r.stderr}\n${r.stdout}`);
}

const THREAD_ROUNDS = 5;
const errorText = (e: any) => String(e.message ?? e.type ?? "an error on its path");
// Mergeability is slow to compute: 100 of them run past GitHub's 10 s timeout (a 504).
export const FULL_PER_POST = 20;

// Every page of every repo, then the threads of any PR whose first page showed none unresolved
// but has more. A thread page that cannot be read fails that PR's read, as an error on its node does.
// Throws RateLimited, or Error for any answer without data: nothing is applied then.
export async function poll(gh: Gh, repos: Nwo[], tracked: Map<Nwo, number[]>, merges: Map<Nwo, MergeAsk> = new Map(), issues: Map<Nwo, number[]> = new Map()): Promise<Poll> {
  const out = emptyPoll();
  for (const nwo of repos) out.repos.set(nwo, { issues: new Map(), ok: true, error: null, open: new Map(), tracked: new Map(), failed: new Map(), total: null, defaultBranch: null });
  const send = async (asks: Ask[]) => {
    const r = await gh(buildQuery(asks));
    out.posts++;
    let body: any = null;
    try { body = JSON.parse(r.stdout); } catch { /* not JSON */ }
    const msg = (r.stderr || r.stdout).trim().slice(0, 300);
    if (rateLimited(r, body)) throw new RateLimited(msg || "rate limited");
    if (!body || typeof body !== "object" || !body.data) throw new Error(msg || `gh exited ${r.code}`);
    out.cost += Number(body.data.rateLimit?.cost) || 0;
    const rl = body.data.rateLimit;
    if (rl?.remaining != null) out.remaining = Number(rl.remaining);
    if (rl?.limit != null) out.limit = Number(rl.limit);
    if (rl?.resetAt) out.resetAt = epoch(rl.resetAt);
    // A partial error names its alias path: [repo] blanks that repo, [repo, prN] that one PR.
    const errs: any[] = Array.isArray(body.errors) ? body.errors : [];
    const errsOf = (path: string[]) => errs.filter((e) => Array.isArray(e?.path) && path.every((p, i) => e.path[i] === p));
    return { data: body.data, errOf: (path: string[]) => errsOf(path)[0], errsOf };
  };

  // Out of `tracked` too: the write step writes every tracked node without looking at `failed`.
  const failRead = (res: RepoResult, n: number, why: string) => { res.failed.set(n, why.slice(0, 300)); res.tracked.delete(n); };

  // Each POST takes every repo's next open page and at most FULL_PER_POST unit PRs; the unit PRs
  // left over ride along on the next POST.
  const cursor = new Map<Nwo, string | null>(repos.map((nwo) => [nwo, null]));
  const queue = new Map<Nwo, number[]>(repos.map((nwo) => [nwo, [...(tracked.get(nwo) ?? [])]]));
  const queued = new Map<Nwo, Set<number>>(repos.map((nwo) => [nwo, new Set(tracked.get(nwo))]));
  const more = new Map<string, { nwo: Nwo; n: number; after: string; node: any }>();
  const noteThreads = (nwo: Nwo, n: number, node: any) => {
    // A merged or closed PR's verdict does not depend on its threads, so a bad page must not hide it.
    if (node?.state === "MERGED" || node?.state === "CLOSED") return;
    const t = node?.reviewThreads;
    if (t?.pageInfo?.hasNextPage && unresolved(t) === 0) more.set(`${nwo}#${n}`, { nwo, n, after: t.pageInfo.endCursor, node });
  };
  // The merge reads in flight: each walks its range's pages, shrinking the range when it is over the cap.
  type Reading = { from: number; to: number; now: number; span: number; after: string | null; nodes: any[] };
  const reading = new Map<Nwo, Reading>();
  // The feedback issues ride on the repo's first POST only (one aliased field each, no call of their own).
  const issueQueue = new Map<Nwo, number[]>(repos.map((nwo) => [nwo, [...(issues.get(nwo) ?? [])]]));
  for (const nwo of repos) {
    const m = merges.get(nwo);
    if (m) reading.set(nwo, { from: m.from, to: Math.min(m.now, m.from + MERGE_SPANS[0]), now: m.now, span: MERGE_SPANS[0], after: null, nodes: [] });
  }
  const readMerges = (nwo: Nwo, r: Reading, page: any, errs: any[]) => {
    const done = (o: Partial<MergeResult>) => { reading.delete(nwo); out.merges.set(nwo, { from: r.from, to: r.to, nodes: r.nodes, error: null, skipped: false, ...o }); };
    if (errs.length || !page) return done({ nodes: [], error: (errs.length ? errorText(errs[0]) : "the merge search did not come back").slice(0, 300) });
    if (r.after === null && Number(page.issueCount) > MERGE_CAP) {
      const span = MERGE_SPANS[MERGE_SPANS.indexOf(r.span) + 1];
      if (span === undefined) return done({ nodes: [], skipped: true, error: `over ${MERGE_CAP} merged PRs in ${searchTime(r.from)}..${searchTime(r.to)} (${page.issueCount}): that hour is not recorded` });
      Object.assign(r, { span, to: Math.min(r.now, r.from + span) });
      return;
    }
    r.nodes.push(...(page.nodes ?? []));
    if (page.pageInfo?.hasNextPage && page.pageInfo.endCursor) r.after = page.pageInfo.endCursor;
    else done({});
  };

  for (;;) {
    let budget = FULL_PER_POST;
    const asks: Ask[] = [];
    for (const nwo of repos) {
      const r = reading.get(nwo), ask: Ask = { nwo };
      if (r) ask.merges = { from: r.from, to: r.to, after: r.after };
      if (out.repos.get(nwo)!.ok) {
        const q = queue.get(nwo)!, take = q.splice(0, Math.max(budget, 0));
        budget -= take.length;
        if (cursor.has(nwo) || take.length) Object.assign(ask, { page: cursor.get(nwo), tracked: take });
      }
      const iss = issueQueue.get(nwo) ?? [];
      if (iss.length) { ask.issues = iss.splice(0); }
      if (ask.tracked || ask.merges || ask.issues) asks.push(ask);
    }
    if (!asks.length) break;
    const { data, errOf, errsOf } = await send(asks);
    for (const a of asks) {
      if (a.merges) readMerges(a.nwo, reading.get(a.nwo)!, data[mergeAlias(a.nwo)], errsOf([mergeAlias(a.nwo)]));
      // An issue that did not come back (an error on its path, or gone) says nothing: its draft stays as it was.
      for (const n of a.issues ?? []) {
        const node = data[alias(a.nwo)]?.[`${ISSUE_PREFIX}${n}`];
        if (node && !errsOf([alias(a.nwo), `${ISSUE_PREFIX}${n}`]).length) out.repos.get(a.nwo)!.issues.set(n, node);
      }
      if (!a.tracked) continue;
      const res = out.repos.get(a.nwo)!, d = data[alias(a.nwo)];
      if (!d) {
        res.ok = false;
        res.error = errOf([alias(a.nwo)])?.message ?? "no data for this repo";
        continue;
      }
      for (const n of a.tracked ?? []) {
        const node = d[`pr${n}`] ?? null, path = [alias(a.nwo), `pr${n}`], errs = errsOf(path);
        // The PR itself unresolvable (NOT_FOUND on its alias) reads as gone. Any other error on its
        // path keeps its row as it was: a node that came back with one may be missing fields, and
        // missing checks would read as zero checks, which is green.
        const unresolvable = node === null && errs.every((e) => e.type === "NOT_FOUND" && e.path.length === path.length);
        if (errs.length && !unresolvable) { failRead(res, n, errorText(errs[0])); continue; }
        res.tracked.set(n, node);
        if (node) noteThreads(a.nwo, n, node);
      }
      if (a.page === undefined) continue;
      const prs = d.pullRequests;
      if (!prs) { res.ok = false; res.error = errOf([alias(a.nwo), "pullRequests"])?.message ?? "no pullRequests"; continue; }
      res.total = Number(prs.totalCount) || 0;
      res.defaultBranch = d.defaultBranchRef?.name ?? res.defaultBranch;
      for (const node of prs.nodes ?? []) {
        if (node?.number == null) continue;
        const n = Number(node.number);
        res.open.set(n, node);
        // A unit PR's threads are paged on its full node, which is the one written.
        if (!queued.get(a.nwo)!.has(n)) noteThreads(a.nwo, n, node);
      }
      if (prs.pageInfo?.hasNextPage && prs.pageInfo.endCursor) cursor.set(a.nwo, prs.pageInfo.endCursor);
      else cursor.delete(a.nwo);
    }
  }
  for (let round = 0; more.size && round < THREAD_ROUNDS; round++) {
    const byRepo = new Map<Nwo, Map<number, string>>();
    for (const m of more.values()) {
      if (!out.repos.get(m.nwo)?.ok) continue;
      if (!byRepo.has(m.nwo)) byRepo.set(m.nwo, new Map());
      byRepo.get(m.nwo)!.set(m.n, m.after);
    }
    if (!byRepo.size) break;
    const { data, errsOf } = await send([...byRepo].map(([nwo, threads]) => ({ nwo, threads })));
    for (const [nwo, threads] of byRepo) {
      const res = out.repos.get(nwo)!;
      for (const n of threads.keys()) {
        const k = `${nwo}#${n}`, m = more.get(k)!, key = `t${n}`;
        const page = data[alias(nwo)]?.[key]?.reviewThreads, errs = errsOf([alias(nwo), key]);
        more.delete(k);
        if (errs.length) { failRead(res, n, errorText(errs[0])); continue; }
        if (!page) { failRead(res, n, "a later reviewThreads page did not come back"); continue; }
        m.node.reviewThreads.nodes = [...(m.node.reviewThreads.nodes ?? []), ...(page.nodes ?? [])];
        m.node.reviewThreads.pageInfo = page.pageInfo;
        noteThreads(nwo, n, m.node);
      }
    }
  }
  for (const m of more.values()) failRead(out.repos.get(m.nwo)!, m.n, `reviewThreads pages still unread after ${THREAD_ROUNDS} more requests: this PR has more threads than a poll reads, so its read keeps failing until it has fewer`);
  return out;
}

// --- what to ask about -----------------------------------------------------------------------

// `lookup`: the refs (project|ref) asked once for how they ended (U58), not watched.
// `merges`: the repos whose merge read is due, with its range.
type Target = { repos: Map<Nwo, Set<string>>; tracked: Map<Nwo, number[]>; units: Map<string, string>; lookup: Set<string>; merges: Map<Nwo, MergeAsk>; issues: Map<Nwo, number[]> };
const CFG = "github";
const RETRY_UNRESOLVED_S = 3600;
const READ_FAILING = "pr-read-failing";

// A repo selector's owner/name from its config row, resolved once (an unresolvable one is asked
// again after an hour).
function repoFor(store: Store, project: string, selector: string, at: number, resolve: (s: string) => { owner: string; name: string } | null): Nwo | null {
  const key = { project, file: CFG, key: `repo:${selector}` };
  const row = store.get("config", key);
  if (row && (row.value || at - Number(row.observed_at) < RETRY_UNRESOLVED_S)) return (row.value as string) || null;
  const r = resolve(selector);
  const nwo = r ? `${r.owner}/${r.name}` : "";
  store.upsert("config", key, { value: nwo, observed_at: at });
  return nwo || null;
}

export function targets(store: Store, at: number, resolve = repoOf): Target {
  const t: Target = { repos: new Map(), tracked: new Map(), units: new Map(), lookup: new Set(), merges: new Map(), issues: new Map() };
  const add = (nwo: Nwo, project: string) => { if (!t.repos.has(nwo)) t.repos.set(nwo, new Set()); t.repos.get(nwo)!.add(project); };
  const squads = store.db.query("SELECT project, topic, repo FROM squads WHERE COALESCE(status, '') != 'closed' ORDER BY project, topic").all() as { project: string; topic: string; repo: string | null }[];
  const repoOfSquad = new Map<string, Nwo | null>();
  for (const s of squads) {
    const nwo = s.repo ? repoFor(store, s.project, s.repo, at, resolve) : null;
    repoOfSquad.set(`${s.project}/${s.topic}`, nwo);
    if (nwo) add(nwo, s.project);
  }
  // The units the sweep watches (step 9): dispatched, or done while its Builder is still a member.
  // A done unit past that is asked once for how its PR ended (U58): the open page never shows a
  // merged PR, so without its own row the board cannot tell a merged unit from one still open.
  const units = store.db.query(`SELECT project, squad, slug, status, pr,
      (status IN ('dispatched', 'cancelled') OR builder_wt IN (SELECT wt FROM members m WHERE m.project = u.project AND m.squad = u.squad)) AS watched
    FROM units u WHERE pr IS NOT NULL AND pr != '' AND status IN ('dispatched', 'done', 'cancelled')
    ORDER BY project, squad, ord, slug`).all() as Row[];
  const seen = new Set<string>();
  for (const u of units) {
    const sk = `${u.project}/${u.squad}`;
    if (!repoOfSquad.has(sk)) continue;
    const pr = String(u.pr), url = prUrl(pr), digits = pr.match(/(\d+)\/?$/);
    const nwo = url?.nwo ?? repoOfSquad.get(sk), n = url?.n ?? (digits ? Number(digits[1]) : null);
    if (!nwo || !n) continue;
    const ref = `${nwo}#${n}`, project = u.project as string;
    const row = store.get("observed_prs", { project, ref });
    // Not watched: asked only while no row says how it ended — none, or one the open page dropped
    // without a merge or close — and only once the repo's open page has been read, so a PR still open
    // gets its row from the page instead. A row the open page lists needs no ask, and one GitHub
    // could not resolve (detail `missing`) is never asked again.
    if (!u.watched) {
      if (row && (row.gone_at == null || row.detail === "missing" || row.state === "MERGED" || row.state === "CLOSED")) continue;
      // A repo nothing else polls is added, so its page is read and the next poll can ask.
      if (store.get("observed_github", { repo: nwo })?.ok_at == null) { add(nwo, project); continue; }
      t.lookup.add(`${project}|${ref}`);
    }
    if (!t.units.has(`${project}|${ref}`)) t.units.set(`${project}|${ref}`, `${u.squad}/${u.slug}`);
    // A merge is final; a closed PR is watched only while its unit still waits on it.
    if (row?.state === "MERGED" || (row?.state === "CLOSED" && !["dispatched", "cancelled"].includes(String(u.status)))) continue;
    add(nwo, project);
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (!t.tracked.has(nwo)) t.tracked.set(nwo, []);
    t.tracked.get(nwo)!.push(n);
  }
  // The PRs open dependency waits name (U119), whichever unit owns them or if none does: each is
  // asked once for how it ended, so a merge releases the wait. A final row, or one the open page
  // still lists, needs no ask.
  const waits = store.db.query("SELECT project, prerequisites FROM pause_intents WHERE source = 'dependency' AND cleared_at IS NULL AND prerequisites IS NOT NULL").all() as Row[];
  for (const w of waits) {
    let refs: { kind?: string; project?: string; ref?: string }[] = [];
    try { refs = JSON.parse(String(w.prerequisites)); } catch { continue; }
    for (const p of refs) {
      const m = p.kind === "pr" ? String(p.ref ?? "").match(/^([^/#]+\/[^/#]+)#(\d+)$/) : null;
      if (!m) continue;
      const project = String(p.project ?? w.project), nwo = m[1] as Nwo, n = Number(m[2]), ref = `${nwo}#${n}`;
      const row = store.get("observed_prs", { project, ref });
      if (row && (row.detail === "missing" || row.state === "MERGED" || row.state === "CLOSED")) continue;
      add(nwo, project);
      if (row && row.gone_at == null) continue;
      if (store.get("observed_github", { repo: nwo })?.ok_at == null) continue;
      t.lookup.add(`${project}|${ref}`);
      if (!t.tracked.get(nwo)?.includes(n)) { if (!t.tracked.has(nwo)) t.tracked.set(nwo, []); t.tracked.get(nwo)!.push(n); }
    }
  }
  const fb = feedbackIssues(store);
  if (fb) {
    // The feedback repo is read like any watched repo; with no squad on it, no project owns its PR rows.
    if (!t.repos.has(fb.repo)) t.repos.set(fb.repo, new Set());
    t.issues.set(fb.repo, fb.issues);
  }
  t.merges = mergeAsks(store, [...t.repos.keys()], at);
  return t;
}

// The issues this host filed that can still change: filed, or fixed in a PR the checkout does not hold yet.
// None while `feedback_repo` is unset, so the query then carries no issue field.
export function feedbackIssues(store: Store): { repo: Nwo; issues: number[] } | null {
  const repo = feedbackRepo(store) as Nwo | null;
  if (!repo) return null;
  const rows = store.db.query(`SELECT DISTINCT issue FROM feedback_drafts WHERE repo = ? AND issue IS NOT NULL
    AND (state = 'filed' OR (state = 'fixed' AND fix_pr IS NOT NULL AND COALESCE(fix_here, 0) = 0)) ORDER BY issue LIMIT 100`).all(repo) as { issue: number }[];
  return rows.length ? { repo, issues: rows.map((r) => Number(r.issue)) } : null;
}

// What a closed issue says: `fixed` (closed as completed, with the merged PR GitHub names and its merge commit)
// or `closed` (not planned, duplicate); an open issue, or a close with no reason, null.
export function issueOutcome(node: any): { state: "fixed" | "closed"; pr: number | null; oid: string | null } | null {
  if (node?.state !== "CLOSED") return null;
  const why = String(node.stateReason ?? "");
  if (why === "NOT_PLANNED" || why === "DUPLICATE") return { state: "closed", pr: null, oid: null };
  if (why !== "COMPLETED") return null;
  const prs = ((node.closedByPullRequestsReferences?.nodes ?? []) as any[]).filter((n) => n?.merged && n.number != null);
  prs.sort((a, b) => String(b.mergedAt ?? "").localeCompare(String(a.mergedAt ?? "")));
  return { state: "fixed", pr: prs[0] ? Number(prs[0].number) : null, oid: prs[0]?.mergeCommit?.oid ?? null };
}

// The merge commits of closed-as-completed feedback issues in a poll, to ask the checkout about.
export function fixCommits(p: Poll): string[] {
  const out = new Set<string>();
  for (const res of p.repos.values()) for (const node of res.issues.values()) { const o = issueOutcome(node); if (o?.oid) out.add(o.oid); }
  return [...out];
}

// Does the host checkout hold these commits (an ancestor of HEAD)? One async git call each, never a fetch.
export async function checkoutHolds(oids: string[], root = ROOT): Promise<Set<string>> {
  const held = new Set<string>();
  for (const oid of oids) {
    if (!/^[0-9a-f]{7,64}$/.test(oid)) continue;
    try {
      const pr = Bun.spawn(["git", "merge-base", "--is-ancestor", oid, "HEAD"], { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      const timer = setTimeout(() => pr.kill(), 10_000);
      try { if ((await pr.exited) === 0) held.add(oid); } finally { clearTimeout(timer); }
    } catch { /* no git: not here */ }
  }
  return held;
}

// The poll's feedback issues onto their drafts and notes. A draft moves only while it is `filed` (or, for
// fix_here, `fixed`); an open issue changes nothing.
function applyFeedback(store: Store, p: Poll, held: Set<string>, at: number): void {
  const repo = feedbackRepo(store);
  if (!repo) return;
  for (const [nwo, res] of p.repos) {
    if (nwo !== repo) continue;
    for (const [n, node] of res.issues) {
      const o = issueOutcome(node);
      if (!o) continue;
      const here = o.oid && held.has(o.oid) ? 1 : 0;
      const drafts = store.db.query("SELECT id, state, fix_pr, fix_here FROM feedback_drafts WHERE repo = ? AND issue = ? AND state IN ('filed', 'fixed')").all(repo, n) as Row[];
      for (const d of drafts) {
        if (d.state === "fixed") {
          if (o.state === "fixed" && here && !d.fix_here) store.db.run("UPDATE feedback_drafts SET fix_here = 1, updated_at = ? WHERE id = ?", [at, d.id as string]);
          continue;
        }
        store.db.run("UPDATE feedback_drafts SET state = ?, fix_pr = ?, fix_here = ?, updated_at = ? WHERE id = ?", [o.state, o.pr ?? null, o.state === "fixed" ? here : null, at, d.id as string]);
        store.db.run("UPDATE feedback_notes SET state = ?, updated_at = ? WHERE draft_id = ? AND state IN ('drafted', 'filed')", [o.state, at, d.id as string]);
        store.event(o.state === "fixed" ? "feedback_fixed" : "feedback_closed", { payload: { draft: d.id, repo, issue: n, pr: o.pr, in_your_version: !!here } });
      }
    }
  }
}

// The merge reads due at `at`: per repo, from 30 minutes before its cursor (the first read: 4 days back).
export function mergeAsks(store: Store, repos: Nwo[], at: number): Map<Nwo, MergeAsk> {
  const out = new Map<Nwo, MergeAsk>();
  for (const nwo of repos) {
    const row = store.get("observed_github", { repo: nwo });
    if (row?.merges_next_at != null && Number(row.merges_next_at) > at) continue;
    const start = row?.merges_until != null ? Number(row.merges_until) : at - MERGE_BACKFILL_S;
    out.set(nwo, { start, from: start - MERGE_OVERLAP_S, now: at });
  }
  return out;
}

// --- writing it down ---------------------------------------------------------------------------

function staleMin(store: Store, project: string): number {
  const env = Number(process.env.DS_LIMIT_PR_STALE_MIN);
  if (process.env.DS_LIMIT_PR_STALE_MIN && Number.isFinite(env)) return env;
  for (const p of [project, ""]) {
    const row = store.get("config", { project: p, file: "limits.conf", key: "pr_stale_min" });
    if (row && Number.isFinite(Number(row.value))) return Number(row.value);
  }
  return 0;
}

// The project's expected_checks limit as a list; unset (or `-`, the default's placeholder) is none.
export function expectedChecks(store: Store, project: string): string[] {
  return (limit(store, project, "expected_checks") ?? "").split(",").filter((c) => c && c !== "-");
}

function prRow(store: Store, project: string, nwo: Nwo, node: any, detail: "full" | "light", unit: string | null, at: number): Row {
  const ref = `${nwo}#${node.number}`, h = prHealth(node, expectedChecks(store, project))!, old = store.get("observed_prs", { project, ref });
  const since = carrySince(h, old, at), problem = h.verdict === "blocked" ? problemKey(h.reasons) : null;
  const threads = unresolved(node.reviewThreads);
  return {
    pr: Number(node.number), repo: nwo, unit, url: node.url ?? null, title: node.title ?? null, head: node.headRefName ?? null, base: node.baseRefName ?? null,
    state: node.state ?? null, draft: truthy(node.isDraft) ? 1 : 0, detail,
    mergeable: detail === "full" ? node.mergeable ?? null : null, merge_state: detail === "full" ? node.mergeStateStatus ?? null : null,
    verdict: h.verdict, reasons: JSON.stringify(h.reasons.join(",")), ci: h.ci, review: review(node.reviewDecision), threads,
    problem, since, stale: h.verdict === "blocked" && at - since >= staleMin(store, project) * 60 ? 1 : 0,
    merge_blocked: h.verdict === "blocked" ? 1 : 0, merged_at: epoch(node.mergedAt), updated_at: epoch(node.updatedAt),
    gone_at: null, doc: JSON.stringify(node), observed_at: at,
  };
}

// One observed_merges row from a search node; null for a bot's PR (or no number).
export function mergeRow(node: any, at: number): Row | null {
  if (node?.number == null) return null;
  const a = node.author ?? null, login = a?.login ? String(a.login) : "ghost";
  if (a && (a.__typename === "Bot" || login.endsWith("[bot]"))) return null;
  const name = typeof a?.name === "string" ? a.name.trim() : "";
  return { title: node.title ?? null, author_login: login, author_name: name || login, base: node.baseRefName ?? null, merged_at: epoch(node.mergedAt), observed_at: at };
}

// A merge read's outcome onto the repo's cursor: a good read (or a skipped hour) moves merges_until to
// the range's end; a failed one keeps it and is asked again after DS_LOOP_MERGES_S.
function applyMerges(store: Store, t: Target, p: Poll, at: number): void {
  const every = mergesInterval();
  for (const [nwo, m] of p.merges) {
    const ask = t.merges.get(nwo), old = store.get("observed_github", { repo: nwo });
    if (!ask) continue;
    if (m.error && old?.merges_error !== m.error) store.event(m.skipped ? "github_merges_skipped" : "github_merges_error", { payload: { repo: nwo, error: m.error } });
    if (m.error && !m.skipped) {
      store.upsert("observed_github", { repo: nwo }, { merges_error: m.error, merges_next_at: at + every, observed_at: at });
      continue;
    }
    for (const node of m.nodes) {
      const row = mergeRow(node, at);
      if (row) store.upsert("observed_merges", { repo: nwo, pr: Number(node.number) }, row);
    }
    const until = Math.max(m.to, Number(old?.merges_until ?? 0));
    store.upsert("observed_github", { repo: nwo }, {
      merges_from: old?.merges_from ?? ask.start, merges_until: until, merges_error: m.error,
      ...(m.skipped ? {} : { merges_ok_at: at }),
      merges_next_at: until < ask.now - MERGE_CAUGHT_UP_S ? at : at + every, observed_at: at,
    });
  }
}

export function apply(store: Store, t: Target, p: Poll, at: number, held: Set<string> = new Set()): void {
  store.tx(() => {
    noteReadFailures(store, t, p, at);
    applyFeedback(store, p, held, at);
    applyMerges(store, t, p, at);
    for (const [nwo, res] of p.repos) {
      store.upsert("observed_github", { repo: nwo }, res.ok
        ? { default_branch: res.defaultBranch, open_count: res.open.size, ok_at: at, error: null, observed_at: at }
        : { error: res.error, observed_at: at });
      if (!res.ok) continue;
      for (const project of t.repos.get(nwo) ?? []) {
        if (res.defaultBranch) store.upsert("config", { project, file: CFG, key: `default_branch:${nwo}` }, { value: res.defaultBranch, observed_at: at });
        const nodes = new Map<number, [any, "full" | "light"]>();
        for (const [n, node] of res.open) if (!res.failed.has(n)) nodes.set(n, [node, "light"]);
        for (const [n, node] of res.tracked) if (node) nodes.set(n, [node, "full"]);
        for (const [n, [node, detail]] of nodes) {
          store.upsert("observed_prs", { project, ref: `${nwo}#${n}` }, prRow(store, project, nwo, node, detail, t.units.get(`${project}|${nwo}#${n}`) ?? null, at));
        }
        // A PR asked once (U58) that GitHub could not resolve: a gone row marked `missing`, never asked again.
        for (const [n, node] of res.tracked) {
          const ref = `${nwo}#${n}`;
          if (node || !t.lookup.has(`${project}|${ref}`)) continue;
          store.upsert("observed_prs", { project, ref }, { pr: n, repo: nwo, unit: t.units.get(`${project}|${ref}`) ?? null, detail: "missing", gone_at: at, observed_at: at });
        }
        // Gone: an open row of this repo the query no longer returns, or a unit PR GitHub could not resolve.
        const gone = store.db.query("SELECT ref, pr FROM observed_prs WHERE project = ? AND repo = ? AND gone_at IS NULL AND COALESCE(state, '') NOT IN ('MERGED', 'CLOSED')").all(project, nwo) as { ref: string; pr: number }[];
        for (const g of gone) {
          if (nodes.has(g.pr) || res.failed.has(g.pr)) continue;
          store.db.run("UPDATE observed_prs SET gone_at = ?, observed_at = ? WHERE project = ? AND ref = ?", [at, at, project, g.ref]);
        }
      }
    }
  });
}

function noteReadFailures(store: Store, t: Target, p: Poll, at: number): void {
  for (const [nwo, res] of p.repos) {
    if (!res.ok) continue;
    for (const [n, error] of res.failed) for (const project of t.repos.get(nwo) ?? []) {
      const subject = `${nwo}#${n}`, unit = t.units.get(`${project}|${subject}`);
      // A one-off lookup (U58) is no watched PR: its unit's Builder has left, so nobody to alert for.
      if (!unit || t.lookup.has(`${project}|${subject}`)) continue;
      const key = { project, subject, kind: READ_FAILING }, row = store.get("episodes", key);
      if (row && row.ended_at == null) continue;
      const squad = unit.split("/")[0];
      store.upsert("episodes", key, { squad, started_at: at, ended_at: null, state: "failing", result: error, source: "loop", observed_at: at });
      store.event("pr_read_failing", { project, squad, payload: { ref: subject, error } });
    }
  }
}

function alertsFailed(store: Store, project: string, o: Out): boolean {
  if (o.code === 0) return false;
  store.event("plugin_error", { project, payload: { plugin: "github", error: errOf(o, "alerts.sh") } });
  return true;
}

async function reportReadFailures(store: Store, t: Target, p: Poll, at: number): Promise<void> {
  const open = store.db.query("SELECT * FROM episodes WHERE kind = ? AND ended_at IS NULL ORDER BY id").all(READ_FAILING) as Row[];
  for (const r of open) {
    const project = String(r.project), ref = String(r.subject), hash = ref.lastIndexOf("#"), res = p.repos.get(ref.slice(0, hash)), n = Number(ref.slice(hash + 1));
    const unit = t.units.get(`${project}|${ref}`), waited = at - Number(r.started_at);
    if (unit && res && !res.ok) continue;
    const key = { project, subject: ref, kind: READ_FAILING }, subject = `${READ_FAILING}.${ref}`, episode = String(r.started_at), squad = r.squad as string | null;
    // A one-off lookup (U58) ends the episode too: the unit is done and nobody watches its PR now.
    if (!res?.failed.has(n) || !unit || t.lookup.has(`${project}|${ref}`)) {
      if (r.state === "alerted" && alertsFailed(store, project, await resolveAlert(store, project, subject, episode))) continue;
      store.upsert("episodes", key, { state: "closed", ended_at: at, observed_at: at });
      store.event("pr_read_recovered", { project, squad, payload: { ref, failing_s: waited } });
      continue;
    }
    if (r.state === "alerted" || waited < STUCK_AFTER) continue;
    const o = await alert(store, project, subject, episode,
      `PR ${ref} (unit ${unit}) has failed to read for ${Math.floor(waited / 60)} minutes: ${r.result}. Its board row is frozen as it last read, so it may hide a red check or a merge; bin/role/finish-unit.sh still reads the live verdict. This clears on the next good read.`,
      { title: "PR read failing" });
    if (alertsFailed(store, project, o)) continue;
    store.upsert("episodes", key, { state: "alerted", observed_at: at });
    store.event("pr_read_alerted", { project, squad, payload: { ref, failing_s: waited } });
  }
}

// --- the plugin --------------------------------------------------------------------------------

type Opts = { holds?: (oids: string[]) => Promise<Set<string>>; gh?: Gh; resolve?: typeof repoOf; budgetMs?: number; rest?: Rest };

// The schedule row (repo ''): next_at and the current interval.
function schedule(store: Store): Row { return store.get("observed_github", { repo: "" }) ?? { next_at: 0, interval_s: baseInterval() }; }

export function githubObserver(opts: Opts = {}): Observer {
  const gh = opts.gh ?? ghCli(), budget = opts.budgetMs ?? 1500;
  // A refusal asks `gh api rate_limit` for GitHub's reset time; a test's fake gh brings its own or none.
  const rest: Rest = opts.rest ?? (opts.gh ? async () => null : restRateLimit);
  // The poll in flight: its targets, and its outcome once settled (`rest`: the REST budget after a refusal).
  type Flight = { t: Target; done: boolean; poll?: Poll; err?: unknown; rest?: RestLimit | null };
  let flight = null as Flight | null;

  const settle = async (ctx: TickCtx) => {
    const f = flight!, store = ctx.store, at = ctx.now, base = baseInterval();
    flight = null;
    if (f.poll) {
      const p = f.poll;
      apply(store, f.t, p, at, await (opts.holds ?? checkoutHolds)(fixCommits(p)));
      // U286: reads spend at most github_budget_share of the hour's budget; with no room left for two
      // more, the next one waits for GitHub's reset.
      const interval = pace(base, p.cost, p.limit, budgetShare(store));
      const next = budgetBackAt(p, at) ?? at + interval;
      store.upsert("observed_github", { repo: "" }, { next_at: next, interval_s: interval, posts: p.posts, cost: p.cost,
        remaining: p.remaining, rate_limit: p.limit, reset_at: p.resetAt, error: null, ok_at: at, observed_at: at });
      await reportReadFailures(store, f.t, p, at);
      return;
    }
    const prev = Number(schedule(store).interval_s) || base;
    const limited = f.err instanceof RateLimited, interval = limited ? Math.min(prev * 2, Math.max(MAX_INTERVAL_S, prev)) : prev;
    const error = (f.err as Error)?.message ?? String(f.err);
    if (!limited) {
      store.upsert("observed_github", { repo: "" }, { next_at: at + interval, interval_s: interval, error, observed_at: at });
      store.event("github_error", { payload: { error, interval_s: interval } });
      return;
    }
    // U286: a refusal leaves no budget (remaining 0, so merges wait too). An empty GraphQL bucket waits for
    // its reset (gh api rate_limit); a secondary limit (bucket not empty) or no answer backs off and is
    // "reset" when the backoff ends.
    const r = f.rest, empty = !!r && r.remaining <= 0 && r.reset > at;
    const resetAt = empty ? r!.reset : at + interval;
    store.upsert("observed_github", { repo: "" }, { next_at: empty ? resetAt + RESET_GRACE_S : resetAt, interval_s: interval, error,
      remaining: 0, reset_at: resetAt, ...(r ? { rate_limit: r.limit } : {}), observed_at: at });
    store.event("github_rate_limited", { payload: { error, interval_s: interval, reset_at: resetAt } });
  };

  return {
    name: "github",
    scope: "host",
    async run(ctx: TickCtx) {
      if (flight && !flight.done) return;
      if (flight) return settle(ctx);
      // A prs:refresh timer reads at once while the budget has room (U286).
      const refresh = ctx.fired.some((t) => t.key === "prs:refresh") && hasBudget(budgetOf(ctx.store), ctx.now);
      if (!refresh && Number(schedule(ctx.store).next_at ?? 0) > ctx.now) return;
      const t = ctx.store.tx(() => targets(ctx.store, ctx.now, opts.resolve));
      if (!t.repos.size) {
        ctx.store.upsert("observed_github", { repo: "" }, { next_at: ctx.now + baseInterval(), observed_at: ctx.now });
        await reportReadFailures(ctx.store, t, emptyPoll(), ctx.now);
        return;
      }
      const f: Flight = { t, done: false };
      flight = f;
      const p = poll(gh, [...t.repos.keys()].sort(), t.tracked, t.merges, t.issues)
        .then((r) => { f.poll = r; }, async (e) => { f.err = e; if (e instanceof RateLimited) f.rest = await rest().catch(() => null); })
        .finally(() => { f.done = true; });
      await Promise.race([p, Bun.sleep(budget)]);
      if (f.done) await settle(ctx);
    },
  };
}

export default githubObserver();
