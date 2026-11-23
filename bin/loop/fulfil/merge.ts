// fulfil/merge.ts — kind `merge`: arm GitHub auto-merge on a merge-ready unit PR (U166).
// The lifecycle reconciler emits one per PR head when the project's `auto_merge` limit names a
// merge method (`squash`/`merge`/`rebase`); with `off` the Lead gets the merge poke instead (KTD17).
// `gh pr merge --auto` merges at once when the requirements are already met, else arms the PR so
// GitHub merges it once they are (required checks, merge queue, approvals). Either way a zero
// exit counts as armed. U240: a repo with allow_auto_merge false gets `gh pr merge` without `--auto`
// (direct). A non-zero exit is tried again every DS_LOOP_MERGE_RETRY_S (180) on the same episode; the
// third failure raises one Studio alert with gh's stderr and settles done. A moved head or a PR no
// longer open ends the episode (stale), and a new push starts its own.
// U286: a refusal for GitHub's rate limit (isRateLimit, bin/loop/io/github-budget.ts) is no try: it waits
// for an empty bucket's reset + 30 s (the observer's reset_at, else `gh api rate_limit`), else (a
// secondary limit) DS_LOOP_MERGE_RETRY_S,
// marks nothing failed and raises no card. A merge-failed episode keeps gh's reason in `result`.
import { alert, memberAt } from "../core/actuator.ts";
import { headOf } from "../squad/pr-ready.ts";
import { errOf, spawn } from "../io/orca.ts";
import type { Exec, Fulfiller } from "../core/actuator.ts";
import type { Action } from "../core/plugins.ts";
import { MERGE_CARD } from "../reconcilers/alerts.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";
import { budgetOf, clearStaleGhCache, hasBudget, isRateLimit, resetWaitAt, restRateLimit } from "../io/github-budget.ts";

export type MergePayload = {
  n?: number; repo?: string; method?: string; unit?: string; topic?: string;
  base?: string; ref?: string; head?: string; ep?: string;
};

const METHODS = ["squash", "merge", "rebase"];
const MERGE_TRIES = 3;
const retryS = () => { const v = Number(process.env.DS_LOOP_MERGE_RETRY_S); return Number.isFinite(v) && v > 0 ? v : 180; };

// U290: does GitHub's budget have room right now? The observer's last read when it is recent (a few read
// intervals), else the free `gh api rate_limit`; unreadable reads as no room (today's wait).
const CLEARED = new Map<string, number>();   // episode → when its wait ends; no second clear before
const FRESH_S = 600;
async function budgetHasRoom(store: Exec["store"], now: number): Promise<boolean> {
  const row = store.get("observed_github", { repo: "" });
  const seen = Number(row?.observed_at ?? 0), b = budgetOf(store);
  if (b.remaining !== null && seen > 0 && now - seen <= FRESH_S) return hasBudget(b, now);
  const r = await restRateLimit().catch(() => null);
  return !!r && (r.remaining > 0 || r.reset <= now);
}

// The repo's allow_auto_merge, read once and kept; a failed merge drops it. undefined = unreadable.
const ALLOWED = new Map<string, boolean>();
export const forgetAutoMerge = () => { ALLOWED.clear(); CLEARED.clear(); };   // tests
async function autoMergeAllowed(gh: string[], repo: string): Promise<boolean | undefined> {
  if (ALLOWED.has(repo)) return ALLOWED.get(repo);
  const r = await spawn([...gh, "api", `repos/${repo}`, "--jq", ".allow_auto_merge"], {}, 30_000);
  const v = r.code === 0 ? r.out.trim() : "";
  if (v !== "true" && v !== "false") return undefined;
  ALLOWED.set(repo, v === "true");
  return v === "true";
}

const merge: Fulfiller = {
  name: "merge",
  kinds: ["merge"],
  run: () => [],

  // The PR left the open state meanwhile (merged, closed, gone): nothing to arm.
  stale(a: Action, x: Exec) {
    const p = payloadOf<"merge">(a).ref;
    if (!p) return false;
    const row = x.store.get("observed_prs", { project: a.project, ref: p });
    const head = payloadOf<"merge">(a).head, now = row ? headOf(row) : "";
    return row?.state !== "OPEN" || (!!head && !!now && now !== head);
  },

  async exec(a: Action, x: Exec) {
    const p = payloadOf<"merge">(a);
    const n = Number(p.n), repo = String(p.repo ?? ""), method = String(p.method ?? "");
    const lead = a.member ?? null;
    if (!Number.isInteger(n) || n <= 0 || !repo.includes("/") || !METHODS.includes(method) || !lead)
      return { failed: "a merge needs a PR number, an owner/repo, a method (squash|merge|rebase) and a Lead" };
    const gh = (process.env.DS_GH ?? "gh").split(/\s+/).filter(Boolean);
    // U240: a repo that refuses GitHub auto-merge gets a direct merge: the loop's own ready check stands in
    // for the queue it doesn't have. Unreadable reads as allowed, so a project keeps `--auto`.
    const direct = (await autoMergeAllowed(gh, repo)) === false;
    // Pin the head the loop judged ready: GitHub refuses to merge when the PR has moved past it.
    const mergeArgv = [...gh, "pr", "merge", String(n), "--repo", repo, ...(direct ? [] : ["--auto"]), `--${method}`,
      ...(p.head ? ["--match-head-commit", p.head] : [])];
    let r = await spawn(mergeArgv, {}, 60_000);
    const where = `${p.topic ?? a.squad}/${p.unit ?? ""}`;
    // U290: a rate-limit refusal while the budget has room may be gh's cached copy of an old one: clear
    // those cache files and try once more. Not again for this episode until its wait has ended.
    const cacheKey = `${a.project}|${a.subject}|${a.episode}`;
    if (r.code !== 0 && isRateLimit(`${r.err}\n${r.out}`) && x.now >= (CLEARED.get(cacheKey) ?? 0) && await budgetHasRoom(x.store, x.now)) {
      const cleared = clearStaleGhCache();
      if (cleared > 0) {
        x.store.event("gh_cache_cleared", { project: a.project, squad: a.squad ?? null, unit: (p.unit ?? null) as string | null, member: lead, payload: { files: cleared, pr: n } });
        await alert(x.store, a.project, `gh-cache-cleared:${repo}#${n}`, a.episode,
          `gh had cached GitHub's rate-limit error; cleared ${cleared} entr${cleared === 1 ? "y" : "ies"} and retried the merge of #${n}.`,
          { title: "gh cache cleared", fields: { kind: "gh_cache_cleared", ref: p.ref ?? `${repo}#${n}` } });
        r = await spawn(mergeArgv, {}, 60_000);
        if (r.code !== 0 && isRateLimit(`${r.err}\n${r.out}`)) CLEARED.set(cacheKey, (await resetWaitAt(x.store, x.now, retryS())));
      }
    }
    if (r.code !== 0) {
      const why = errOf(r, "gh pr merge");
      ALLOWED.delete(repo);   // the setting may have changed: read it again next time
      if (isRateLimit(`${r.err}\n${r.out}`)) {
        return { wait: `rate limited, waiting for GitHub's reset: ${why}`, at: await resetWaitAt(x.store, x.now, retryS()) };
      }
      // U240: a refusal is tried again a few minutes later (same episode, same head) before a card.
      const key = { project: a.project, subject: a.subject, kind: "merge-tries" };
      const old = x.store.get("episodes", key), tries = (old?.episode_key === a.episode ? Number(old.count ?? 0) : 0) + 1;
      x.store.upsert("episodes", key, { squad: a.squad ?? null, episode_key: a.episode, count: tries, state: "retrying", source: "loop", observed_at: x.now });
      if (tries < MERGE_TRIES) return { wait: `merge try ${tries} of ${MERGE_TRIES} failed: ${why}`, at: x.now + retryS() };
      await alert(x.store, a.project, a.subject, a.episode, direct
        ? `PR #${n} (${where}) is merge-ready but the loop's direct merge failed ${tries} times (${why}). Merge it by hand, then dispatch what the merge unblocked.`
        : `PR #${n} (${where}) is merge-ready but the loop could not arm auto-merge (${method}): ${why}. Arm it by hand or fix the repo setting, then dispatch what the merge unblocked.`,
        { title: "Auto-merge not armed", fields: { kind: MERGE_CARD, ref: p.ref ?? `${repo}#${n}`, head: p.head ?? "" } });
      // The reconciler wrote state merge-armed when it emitted this action; mark the failed arm so
      // its stuck alert says "could not be armed" instead of "armed".
      if (p.ep && p.topic && p.unit) {
        const k = { project: a.project, subject: `${p.topic}/${p.unit}`, kind: "lifecycle:merge-ready" };
        const row = x.store.get("episodes", k);
        if (row && row.episode_key === p.ep) x.store.upsert("episodes", k, { state: "merge-failed", result: why, observed_at: x.now });
      }
      return { done: true, result: `not armed for ${p.head || "this head"}: ${why}` };
    }
    x.store.event("auto_merge_armed", {
      project: a.project, squad: a.squad ?? null, unit: (p.unit ?? null) as string | null, member: lead,
      payload: { pr: n, repo, method, head: p.head ?? null, out: r.out.trim() || null, ...(direct ? { direct: true } : {}) },
    });
    const m = memberAt(x.store, a, lead);
    const seat = x.act.seat(x.store, a.project, a.squad ?? m.squad, `${a.subject}:${a.episode}`, lead, x.now);
    const poked = await x.act.driver(seat, m.agent).poke(m,
      `dev-studio loop: PR #${n} for unit ${p.unit ?? ""} is merge-ready; ${direct ? `the loop merged it (${method})` : `the loop armed auto-merge (${method})`}. ${direct ? "Dispatch what the merge unblocked." : "When it merges, dispatch what the merge unblocked."}`);
    if (poked === "failed")
      x.store.event("auto_merge_poke_failed", {
        project: a.project, squad: a.squad ?? null, unit: (p.unit ?? null) as string | null, member: lead,
        payload: { pr: n, head: p.head ?? null },
      });
    return { done: true, result: poked };
  },
};
export default merge;
