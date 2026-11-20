// fakes/github.ts — a GitHub GraphQL endpoint for the GitHub observer's tests (Bun). It answers the
// queries observers/github.ts builds, from PR nodes in pr_health's shape:
//
//   const gh = fakeGithub(loadPrs("tests/fixtures/loop/prs.json"));
//   githubObserver({ gh: gh.run, ... })
//
// It reads the query, not a script: each `<alias>: repository(owner, name)` gets its open PRs page by
// page (`first`/`after`, cursors are offsets), its `pr<N>: pullRequest(number: N)` PRs in full, and
// `t<N>` thread pages. A light node (the open page) carries `statusCheckRollup.state` where a full one
// carries the check contexts. Knobs: `rateLimit` answers that many requests with gh's 403,
// `budget` is the rateLimit every answer reports;
// `broken` answers a repo with a partial error (its alias null), `failing` a unit PR, `partial` a unit
// PR's node with its checks blanked and `partialError` on their path; a PR it does not know is NOT_FOUND.
// A top-level `m_<alias>: search(...)` (the merge read) answers from `merged` (per owner/name, search
// nodes with mergedAt) inside the query's `merged:<from>..<to>`, 100 per page; `mergeCount` can claim a
// larger issueCount for a range, `mergesFailing` answers a repo's search with an error.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GhResult } from "../observers/github.ts";

export type FakeRepo = { defaultBranch: string; prs: Map<number, any> }; // every PR (any state), full shape
export type FakeGithub = {
  repos: Map<string, FakeRepo>;
  calls: string[];          // every query asked, in order
  rateLimit: number;        // answer the next N requests with a rate limit
  budget: { limit: number; cost: number; remaining: number; resetAt: string }; // each answer's rateLimit
  broken: Set<string>;      // owner/name answered with a partial error
  failing: Set<number>;     // PR numbers whose `pr<N>` alias fails with an INTERNAL error
  partial: Set<number>;     // PR numbers whose `pr<N>` node comes back without checks, with an error
  partialError: string;     // that error's type (default INTERNAL)
  merged: Map<string, any[]>; // owner/name -> merged PR search nodes { number, title, baseRefName, mergedAt, author }
  mergeCount: ((nwo: string, from: number, to: number) => number | null) | null; // issueCount override for a range
  mergesFailing: Set<string>; // owner/name whose merge search errors
  run(query: string): Promise<GhResult>;
};

const FIXTURES = join(import.meta.dir, "..", "..", "..", "tests", "fixtures", "pr-health");

// A pr-health fixture (`{data: {repository: {pullRequest}}}`) as a PR node with its identity.
export function fromFixture(name: string, pr: { number: number; title?: string; head?: string; base?: string; mergedAt?: string; nwo?: string }): any {
  const node = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")).data.repository.pullRequest;
  return {
    ...node, number: pr.number, title: pr.title ?? `PR ${pr.number}`, headRefName: pr.head ?? `b${pr.number}`, baseRefName: pr.base ?? "main",
    url: `https://github.com/${pr.nwo ?? "acme/app"}/pull/${pr.number}`, mergedAt: pr.mergedAt ?? null, updatedAt: "2026-10-30T09:00:00Z",
  };
}

// tests/fixtures/loop/prs.json: { "<owner/name>": { defaultBranch, prs: [{ number, fixture, title?, head?, mergedAt? }] } }
export function loadPrs(path: string): Map<string, FakeRepo> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, { defaultBranch: string; prs: any[] }>;
  return new Map(Object.entries(raw).map(([nwo, r]) =>
    [nwo, { defaultBranch: r.defaultBranch, prs: new Map(r.prs.map((p) => [p.number, fromFixture(p.fixture, { ...p, nwo })])) }]));
}

const FAILED_RUN = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];

function rollup(node: any): string | null {
  const ctx: any[] = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  if (!ctx.length) return null;
  if (ctx.some((c) => (c.__typename === "CheckRun" ? c.status === "COMPLETED" && FAILED_RUN.includes(c.conclusion) : ["FAILURE", "ERROR"].includes(c.state)))) return "FAILURE";
  if (ctx.some((c) => (c.__typename === "CheckRun" ? c.status !== "COMPLETED" : ["PENDING", "EXPECTED"].includes(c.state)))) return "PENDING";
  return "SUCCESS";
}

function threads(node: any, first: number, after: string | null, total = true): any {
  const all: any[] = node.reviewThreads?.nodes ?? [], from = after ? Number(after) : 0, page = all.slice(from, from + first);
  return { ...(total ? { totalCount: all.length } : {}), pageInfo: { hasNextPage: from + first < all.length, endCursor: String(from + page.length) }, nodes: page };
}

function light(node: any): any {
  const { commits: _c, mergeable: _m, mergeStateStatus: _s, baseRef: _b, ...rest } = node;
  const state = rollup(node);
  return { ...rest, statusCheckRollup: state ? { state } : null, reviews: { nodes: [] }, reviewThreads: threads(node, 50, null) };
}

function full(node: any): any {
  return { ...node, reviews: { nodes: [] }, reviewThreads: threads(node, 100, null) };
}

const unquote = (s: string) => JSON.parse(s);

export function fakeGithub(repos: Map<string, FakeRepo>): FakeGithub {
  const fake: FakeGithub = {
    repos, calls: [], rateLimit: 0, budget: { limit: 5000, cost: 1, remaining: 4999, resetAt: "2026-10-30T11:00:00Z" }, broken: new Set(), failing: new Set(), partial: new Set(), partialError: "INTERNAL",
    merged: new Map(), mergeCount: null, mergesFailing: new Set(),
    async run(query: string): Promise<GhResult> {
      fake.calls.push(query);
      if (fake.rateLimit > 0) {
        fake.rateLimit--;
        return { code: 1, stdout: '{"message":"API rate limit exceeded for user ID 1."}', stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)\n" };
      }
      const data: Record<string, any> = { rateLimit: { ...fake.budget } };
      const errors: any[] = [];
      const blocks = [...query.matchAll(/(\w+): repository\(owner: ("[^"]*"), name: ("[^"]*")\)/g)];
      blocks.forEach((b, i) => {
        const alias = b[1], nwo = `${unquote(b[2])}/${unquote(b[3])}`;
        const body = query.slice(b.index! + b[0].length, blocks[i + 1]?.index ?? query.length);
        const repo = repos.get(nwo);
        if (!repo || fake.broken.has(nwo)) {
          data[alias] = null;
          errors.push({ type: repo ? "FORBIDDEN" : "NOT_FOUND", path: [alias], message: `Could not resolve to a Repository with the name '${nwo}'.` });
          return;
        }
        const d: Record<string, any> = {};
        const page = body.match(/pullRequests\(states: OPEN, first: (\d+), after: (null|"[^"]*")/);
        if (page) {
          const open = [...repo.prs.values()].filter((p) => p.state === "OPEN").sort((a, b) => a.number - b.number);
          const first = Number(page[1]), from = page[2] === "null" ? 0 : Number(unquote(page[2])), nodes = open.slice(from, from + first);
          d.nameWithOwner = nwo;
          d.defaultBranchRef = { name: repo.defaultBranch };
          d.pullRequests = { totalCount: open.length, pageInfo: { hasNextPage: from + first < open.length, endCursor: String(from + nodes.length) }, nodes: nodes.map(light) };
        }
        for (const m of body.matchAll(/\b(pr|t)(\d+): pullRequest\(number: (\d+)\)( \{ reviewThreads\(first: (\d+), after: ("[^"]*")\))?/g)) {
          const key = `${m[1]}${m[2]}`, node = repo.prs.get(Number(m[3]));
          if (fake.failing.has(Number(m[3]))) {
            d[key] = null;
            errors.push({ type: "INTERNAL", path: [alias, key], message: "Something went wrong while executing your query." });
          } else if (!node) {
            d[key] = null;
            errors.push({ type: "NOT_FOUND", path: [alias, key], message: `Could not resolve to a PullRequest with the number of ${m[3]}.` });
          } else if (fake.partial.has(Number(m[3])) && m[1] === "pr") {
            d[key] = { ...full(node), commits: { nodes: [{ commit: { statusCheckRollup: null } }] }, statusCheckRollup: null };
            errors.push({ type: fake.partialError, path: [alias, key, "commits", "nodes", 0, "commit", "statusCheckRollup"], message: "Something went wrong while executing your query." });
          } else d[key] = m[1] === "pr" ? full(node) : { reviewThreads: threads(node, Number(m[5]), unquote(m[6]), false) };
        }
        data[alias] = d;
      });
      for (const m of query.matchAll(/(m_\w+): search\(type: ISSUE, first: (\d+), after: (null|"[^"]*"), query: ("(?:[^"\\]|\\.)*")\)/g)) {
        const key = m[1], text: string = unquote(m[4]);
        const nwo = text.match(/repo:(\S+)/)![1], range = text.match(/merged:(\S+)\.\.(\S+)/)!;
        const from = Date.parse(range[1]) / 1000, to = Date.parse(range[2]) / 1000;
        if (fake.mergesFailing.has(nwo)) {
          data[key] = null;
          errors.push({ type: "INTERNAL", path: [key], message: "Something went wrong while executing your query." });
          continue;
        }
        const all = (fake.merged.get(nwo) ?? []).filter((n) => { const at = Date.parse(n.mergedAt) / 1000; return at >= from && at <= to; })
          .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
        const first = Number(m[2]), off = m[3] === "null" ? 0 : Number(unquote(m[3])), nodes = all.slice(off, off + first);
        data[key] = { issueCount: fake.mergeCount?.(nwo, from, to) ?? all.length, pageInfo: { hasNextPage: off + first < all.length, endCursor: String(off + nodes.length) }, nodes };
      }
      // gh exits 1 on a partial error and still prints the body.
      return { code: errors.length ? 1 : 0, stdout: JSON.stringify(errors.length ? { data, errors } : { data }), stderr: errors.length ? `gh: ${errors[0].message}\n` : "" };
    },
  };
  return fake;
}
