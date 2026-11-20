// github-budget.ts — the loop's GitHub GraphQL budget (U286). The PR observer (observers/github.ts)
// and the merge fulfiller (fulfil/merge.ts) spend the same per-user GraphQL budget (5000 points an
// hour), so both read it here:
//
//   - isRateLimit / rateLimitedBody: the one test for "GitHub refused this for its rate limit". GraphQL
//     says `type: "RATE_LIMITED"` or `"RATE_LIMIT"` (code graphql_rate_limit), gh's stderr says
//     "API rate limit (already) exceeded" or "secondary rate limit", HTTP 429. A bare HTTP 403 is not
//     one: a permission refusal is a 403 too.
//   - budgetOf: what the last read said, from the observer's schedule row (observed_github, repo '').
//   - restRateLimit: `gh api rate_limit`, which costs nothing, for the reset time a refusal leaves out.
//   - pace: how long the next read waits so the reads spend at most github_budget_share of the budget.
import { closeSync, lstatSync, openSync, readdirSync, readSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store } from "../core/store.ts";
import { spawn } from "./orca.ts";
import { limitEnv } from "../settings/limits.ts";

// Seconds after GitHub's reset time before the loop asks again (clocks differ).
export const RESET_GRACE_S = 30;
export const DEFAULT_SHARE = 0.5;

const LIMIT_TYPES = new Set(["RATE_LIMITED", "RATE_LIMIT"]);
export const isRateLimit = (text: string): boolean => /rate limit|HTTP 429/i.test(text);
export const rateLimitedBody = (body: any): boolean =>
  Array.isArray(body?.errors) && body.errors.some((e: any) => LIMIT_TYPES.has(e?.type) || e?.code === "graphql_rate_limit");

export type Budget = { limit: number | null; remaining: number | null; cost: number | null; resetAt: number | null };
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function budgetOf(store: Store): Budget {
  const r = store.get("observed_github", { repo: "" });
  return { limit: num(r?.rate_limit), remaining: num(r?.remaining), cost: num(r?.cost), resetAt: num(r?.reset_at) };
}

// Room for two more reads at the last read's cost; a budget past its reset time is full again. Unknown is room.
export function hasBudget(b: Budget, now: number): boolean {
  if (b.remaining === null) return true;
  if (b.resetAt !== null && now >= b.resetAt) return true;
  return b.remaining >= 2 * Math.max(b.cost ?? 1, 1);
}

// When a budget without room is full again (reset + grace), or null when it has room or no reset is known.
export function budgetBackAt(b: Budget, now: number): number | null {
  if (hasBudget(b, now) || b.resetAt === null) return null;
  return b.resetAt + RESET_GRACE_S;
}

// github_budget_share: the env var, else the smallest valid share any project's limits rows or the
// default set (the budget is the host's gh user's, one for every project), else 0.5.
export function budgetShare(store: Store): number {
  const ok = (v: unknown) => { const n = Number(String(v ?? "").trim().split(/\s+/)[0]); return n > 0 && n <= 1 ? n : null; };
  const ev = ok(process.env[limitEnv("github_budget_share")]);
  if (ev !== null) return ev;
  const rows = store.db.query("SELECT value FROM config WHERE file = 'limits.conf' AND key = 'github_budget_share'").all() as { value: string | null }[];
  const shares = rows.map((r) => ok(r.value)).filter((n): n is number => n !== null);
  return shares.length ? Math.min(...shares) : DEFAULT_SHARE;
}

// Seconds between reads so `cost` points a read spend at most `share` of `limit` an hour, never under `base`.
export function pace(base: number, cost: number | null, limit: number | null, share: number): number {
  if (!cost || !limit || limit <= 0 || share <= 0) return base;
  return Math.max(base, Math.ceil((cost * 3600) / (share * limit)));
}

// U290: gh keeps GraphQL answers in its HTTP cache for a day, and a rate-limit error GitHub sent while the
// budget really was used up gets cached too: every later `gh pr merge` then fails at once with it. This
// finds gh's cache directory the way gh does and deletes only the files whose body is a GraphQL rate-limit
// error. It reads the first few KB of each file, skips what it cannot read, and returns the files removed.
const CACHE_HEAD = 8192;
export function ghCacheDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  const dirs = [join(env.XDG_CACHE_HOME || join(home, ".cache"), "gh")];
  if (process.platform === "darwin") dirs.push(join(home, "Library", "Caches", "gh"));
  return dirs;
}
export function clearStaleGhCache(dirs: string[] = ghCacheDirs()): number {
  let removed = 0;
  const poisoned = (path: string): boolean => {
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const buf = Buffer.alloc(CACHE_HEAD);
      const text = buf.subarray(0, readSync(fd, buf, 0, CACHE_HEAD, 0)).toString("utf8");
      if (/API rate limit already exceeded/i.test(text)) return true;
      const body = text.slice(text.search(/\r?\n\r?\n/) + 1).trim();   // after the cached headers, when there are any
      for (const cand of [text.trim(), body]) { try { if (rateLimitedBody(JSON.parse(cand))) return true; } catch { /* not JSON */ } }
      return false;
    } catch { return false; } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } }
  };
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const p = join(dir, name);
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) { if (depth < 2) walk(p, depth + 1); continue; }
        if (!st.isFile() || !poisoned(p)) continue;
        unlinkSync(p); removed++;
      } catch { /* gone or unreadable */ }
    }
  };
  for (const d of dirs) walk(d, 0);
  return removed;
}

// `gh api rate_limit` (REST, free): the GraphQL bucket, or null when gh fails or says something else.
export type RestLimit = { limit: number; remaining: number; reset: number };
export type Rest = () => Promise<RestLimit | null>;
export const restRateLimit: Rest = async () => {
  const gh = (process.env.DS_GH || "gh").split(/\s+/).filter(Boolean);
  const r = await spawn([...gh, "api", "rate_limit", "--jq", ".resources.graphql"], {}, 30_000);
  if (r.code !== 0) return null;
  try {
    const g = JSON.parse(r.out);
    const out = { limit: Number(g?.limit), remaining: Number(g?.remaining), reset: Number(g?.reset) };
    return Object.values(out).every(Number.isFinite) ? out : null;
  } catch { return null; }
};
