// fulfil/update-branch.ts — kind `update-branch`: merge the base into a unit PR that would be merge-ready
// but is behind it (main-red-liveness-test U2). A ruleset that wants branches up to date holds such a PR
// BLOCKED, and GitHub's auto-merge waits on it without ever updating it. The lifecycle reconciler emits
// one per PR head, one PR per repo at a time, only while the project's `auto_merge` is on.
// `gh pr update-branch <n> -R <repo>` merges the base in on GitHub (never `--rebase`); the new head runs
// the PR's checks again, and once they pass the merge path arms it as for any ready PR.
// A refusal for GitHub's rate limit waits for the reset (github-budget.ts `resetWaitAt`), like a merge.
// Any other refusal (a conflict, a gh error) is not tried again: it records `update-branch-failed` for
// this head, so the reconciler sends the Builder the usual "branch is behind: merge the base in" message.
import { errOf, spawn } from "../io/orca.ts";
import type { Exec, Fulfiller } from "../core/actuator.ts";
import type { Action } from "../core/plugins.ts";
import { payloadOf } from "../core/kinds.ts";
import { headOf } from "../squad/pr-ready.ts";
import { isRateLimit, resetWaitAt } from "../io/github-budget.ts";

const retryS = () => { const v = Number(process.env.DS_LOOP_MERGE_RETRY_S); return Number.isFinite(v) && v > 0 ? v : 180; };

// The episode a failed update leaves for its PR (subject the PR's ref, key the head it was asked for).
export const UPDATE_FAILED = "update-branch-failed";

const updateBranch: Fulfiller = {
  name: "update-branch",
  kinds: ["update-branch"],
  run: () => [],

  // The PR left the open state or moved past the head it was asked for: nothing to update.
  stale(a: Action, x: Exec) {
    const p = payloadOf<"update-branch">(a);
    const row = x.store.get("observed_prs", { project: a.project, ref: p.ref });
    const now = row ? headOf(row) : "";
    return row?.state !== "OPEN" || (!!p.head && !!now && now !== p.head);
  },

  async exec(a: Action, x: Exec) {
    const p = payloadOf<"update-branch">(a);
    if (!Number.isInteger(p.n) || p.n <= 0 || !p.repo.includes("/")) return { failed: "an update-branch needs a PR number and an owner/repo" };
    const gh = (process.env.DS_GH ?? "gh").split(/\s+/).filter(Boolean);
    const r = await spawn([...gh, "pr", "update-branch", String(p.n), "-R", p.repo], {}, 60_000);
    const ctx = { project: a.project, squad: a.squad ?? null, unit: p.unit ?? null, member: a.member ?? null };
    if (r.code !== 0) {
      const why = errOf(r, "gh pr update-branch");
      if (isRateLimit(`${r.err}\n${r.out}`)) return { wait: `rate limited, waiting for GitHub's reset: ${why}`, at: await resetWaitAt(x.store, x.now, retryS()) };
      x.store.upsert("episodes", { project: a.project, subject: p.ref, kind: UPDATE_FAILED },
        { squad: a.squad ?? null, episode_key: p.head ?? "", count: 1, state: "failed", result: why, source: "loop", started_at: x.now, observed_at: x.now });
      x.store.event("pr_branch_update_failed", { ...ctx, payload: { pr: p.n, repo: p.repo, head: p.head ?? null, error: why } });
      return { done: true, result: `failed: ${why}` };
    }
    x.store.event("pr_branch_updated", { ...ctx, payload: { pr: p.n, repo: p.repo, base: p.base ?? null, head: p.head ?? null, out: r.out.trim() || null } });
    return { done: true, result: "updated" };
  },
};
export default updateBranch;
