// lifecycle.ts — the unit and PR lifecycle reconciler (U6, R13): the removed sweep steps 1a–1d, 9 and 10
// over the observed PR and worktree rows (Bun). Ported from the removed sweep at origin/main 1edf8b0.
//
//   1a      a dispatched unit with no PR records its Builder branch's PR (open, highest number; else
//           the newest merged; never a closed one); a recorded PR that closed unmerged is replaced
//   1b      a unit whose PR merged is done (done_at), even while its Builder still works
//   1c      a done unit's Builder that is still a member and not working/waiting: its own wish is
//           written archived (gone); the decider closes it and removes its worktree (U155)
//   1d      leftovers: a record whose worktree is back in members or gone is dropped; any other is a
//           worktree.remove action (the actuator runs the sweep's dirty/unpushed/ignored probes);
//           a cancelled unit superseded by a merged `PR#n` gets into_merged
//   9       a watched unit's blocked PR: merge_blocked/pr_stale facts; unless the ship mode is
//           local-only, a pr-stale poke to an idle Builder, wake episode `<problem>|<since>` (the
//           sweep's key), and once more after the PR read waiting (the sweep's `armed`): two at most
//           per red stretch. U178: a stretch is one `since`, which github.ts's carrySince keeps while
//           the PR stays blocked (or waits on running checks), whatever reasons GitHub reshuffles in
//           between; ready, merged, closed or a wait on required:* alone ends it (no pr-stale poke on
//           that wait; U179's required-wait poke covers it). A Builder session placed or cleared (placed_at/cleared_at) after the last
//           poke about the PR gets one more pr-stale poke once idle, outside the two. U275: a Builder
//           quiet for stale_repoke_min after the first poke (no check running, worktree under 5% CPU)
//           gets the second; quiet is idle/done, or Orca's `working` that liveness's atPrompt reads as
//           at its prompt (transcript still, only a background task open), timed from its last write
//   U179    a unit PR waiting on required:<context> alone, none of them a human gate (isHumanGate /
//           human_checks keep the pr-question path), unless the ship mode is local-only: once the wait
//           is required_wait_min (15; 0 = off) old and the Builder has been idle that long, one
//           required-wait poke (post it if your ship step does, else ask the Lead); required_wait_min
//           after that, one request to the Lead. Episode `lifecycle:required-wait`, keyed
//           `<pr>|<head>|<contexts>`: a new head, other contexts or leaving the wait ends it
//   U183    the U179 wait mixed with human gates: the required-wait poke runs on the non-gate
//           contexts alone — the key is `<pr>|<head>|<non-gate contexts>` and the text names only
//           those. Once the Builder-owned contexts are posted and only human gates remain, the
//           pr-question path asks the operator (askState has no blocker then). A wait of only
//           human gates still gets no required-wait poke.
//   KTD17   a dispatched unit's PR into its repo's default branch that is ready and mergeable: a "merge it" poke to the
//           Lead, a second after merge_ready_nudge_min (15) if still open, then one Studio alert
//   U249    the auto-merge episode follows the actuator's claim (action:merge row of the PR, subject = the PR ref), not this
//           reconciler's own emit: the merge is emitted every tick until claimed (count 0), and a settled merge GitHub still shows
//           without autoMergeRequest is sent again (up to 3 rounds). The stuck card says never-started / not armed / armed.
//   U77     a watched (detail full) unit PR whose verdict turns blocked or ready: one pr-news poke to its
//           Builder per `pr-news|<head sha>|<verdict>|<reasons>` (after step 9's poke; running checks poke nothing).
//           U178: on a blocked PR only a new head or a blocking reason the stretch never sent is news
//           (a failed check by name, one more open thread); a reason going away and back is not. What
//           was sent is the lifecycle:news episode's `result` (JSON, per since)
//           U214: a failed check RUN the stretch never sent is news too, but one that only ran again and failed
//           again on a head already told about waits red_repoke_min (15; 0 = off), needs an idle Builder, and
//           pokes at most twice a head; its key carries a digest of the failed runs, and the poke names the lanes
//   U2      (main-red-liveness-test) with auto_merge on, a dispatched unit PR into the default branch that is
//           mergeable and only `behind` gets an `update-branch` action per head (fulfil/update-branch.ts merges
//           the base in on GitHub), one PR per repo at a time, lowest PR number first: the slot (episode
//           `lifecycle:update-branch`, subject the repo, key the PR ref) holds until the PR merges or closes,
//           turns blocked for another reason, its update fails, or it has not merged DS_LOOP_UPDATE_HOLD_S
//           (3600) after its last update. While the loop will update a PR its Builder gets no pr-stale or
//           pr-news poke; a failed update (`update-branch-failed` for the head, or a failed or dropped claim)
//           drops it from the line, so the usual "merge the base in" message goes out
//   10      a feature squad all done (retest.ts; U238 a retest due instead, episode `retest|<topic>|<slug#pr,…>`): all_done_at, and one all-done nudge to an
//           idle Lead quiet for DS_SWEEP_DONE_IDLE_MIN, episode `done|<topic>|<slug#pr,…>`
// worktree.remove is sent again every DS_LOOP_LIFECYCLE_RETRY_S (600) while it still
// applies (the episode carries the period), as the sweep re-tried it every run.
// Facts are one setIf plus one event in one transaction, so the same tick's export and U7 see them.
// Pokes go through wake(), one attempt per round; a round is counted in this reconciler's own
// episodes row (subject `<topic>/<slug>`, kind `lifecycle:stale|merge-ready`) once wake() sent it.
// U70: an open operator question about a PR (`pr` on its entry, ask-operator.sh --pr) whose PR stops being
// ready for a human is closed via `reality`, and its Lead hears once (episode `lifecycle:qclose`, retried
// until the poke lands). After a Builder's second pr-stale poke, a PR still not ready stale_lead_min later
// (default 30; 0 = off) gets its Lead one request (episode `lifecycle:stale-lead`, one per stale stretch);
// a second poke due (stale_repoke_min after the first) but never sent starts that timer at its due time.
// U178: a PR still blocked stale_alert_min (default 60; 0 = off) after that request raises one Studio
// alert for the stretch; nothing re-pokes the Builder or the Lead on a timer.
// The step-11 ready poke is U7's (the plan's "merge-unblock poke" wording names it; see the PR).
import { recordLane } from "../capacity/unit-lanes.ts";
import { cancellationActions } from "../squad/cancel.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expectedChecks, failedChecks, failedLanes, requiredOnly } from "../observers/github.ts";
import { budgetOf, hasBudget, isRateLimit } from "../io/github-budget.ts";
import { askState, checksOf, expectedChecks as prExpectedChecks, headOf, humanCheckNames, isHumanGate, latestReview, prQuestionKey, rowNotReady } from "../squad/pr-ready.ts";
import { answer, blockingForUnit, entryOf, open as askOpen, pending, waiting } from "../messages/questions.ts";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import type { Ctx, Row, Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { wake } from "../pause/wake.ts";
import { atPrompt } from "./liveness.ts";
import { allDone as allDoneIn, retestDue, settleIn } from "../squad/retest.ts";
import { paused } from "../pause/pause.ts";
import { onContract } from "../squad/backend.ts";
import { finishOf } from "../squad/finish-read.ts";
import { UPDATE_FAILED } from "../fulfil/update-branch.ts";

const MERGE_TRIES = 3;
// U249: GitHub's own word on the PR: the observer's autoMergeRequest is null (key present, value null).
const autoOn = (pr: Row): boolean => { try { return (JSON.parse(String(pr.doc ?? "{}")) as Row).autoMergeRequest != null; } catch { return false; } };
const noAuto = (pr: Row): boolean => { try { const d = JSON.parse(String(pr.doc ?? "{}")) as Row; return "autoMergeRequest" in d && d.autoMergeRequest == null; } catch { return false; } };

export const num = (pr: unknown): number | null => { const m = String(pr ?? "").match(/(\d+)\/?$/); return m ? Number(m[1]) : null; };

function envOr(store: Store, project: string, env: string, key: string, dflt: number): number {
  const e = process.env[env];
  if (e !== undefined && /^\d+$/.test(e)) return Number(e);
  for (const p of [project, ""]) {
    const row = store.get("config", { project: p, file: "limits.conf", key });
    if (row && /^\d+$/.test(String(row.value))) return Number(row.value);
  }
  return dflt;
}

// U182: how a Builder brings a moved base into its unit branch (merge | rebase), read the way
// auto_merge is: DS_LIMIT_BASE_UPDATE beats the project's limits.conf beats the repo default.
// Anything but rebase reads as merge, so a typo keeps the safe default: merging never rewrites
// the pushed branch, while a rebase needs an operator-approved force-push.
export function baseUpdate(store: Store, project: string): string {
  const e = process.env.DS_LIMIT_BASE_UPDATE;
  const v = (e !== undefined && e !== "" ? e : [project, ""].map((p) =>
    String(store.get("config", { project: p, file: "limits.conf", key: "base_update" })?.value ?? "").trim().split(/\s+/)[0] ?? "")
    .find((s) => s !== "") ?? "merge").trim();
  return v === "rebase" ? "rebase" : "merge";
}

// U166: the auto_merge method (off | squash | merge | rebase), read the way merge_ready_nudge_min
// is: DS_LOOP_AUTO_MERGE beats the project's limits.conf beats the repo default. Anything but a
// merge method reads as off, so a typo keeps today's Lead poke.
function autoMerge(store: Store, project: string): string {
  const e = process.env.DS_LOOP_AUTO_MERGE;
  const v = (e !== undefined && e !== "" ? e : [project, ""].map((p) =>
    String(store.get("config", { project: p, file: "limits.conf", key: "auto_merge" })?.value ?? "").trim().split(/\s+/)[0] ?? "")
    .find((s) => s !== "") ?? "off").trim();
  return v === "squash" || v === "merge" || v === "rebase" ? v : "off";
}

// A fact: one column under its condition, and its event, together.
function fact(store: Store, table: string, id: number, col: string, value: unknown, was: unknown, kind: string, ctx: Ctx): boolean {
  return store.tx(() => {
    if (!store.setIf(table, id, col, value, was)) return false;
    store.event(kind, ctx);
    return true;
  });
}

const stateFile = (store: Store, project: string, topic: string) => join(store.root, project, "squads", `${topic}.json`);

const docOf = (pr: Row): Row => { try { return JSON.parse(String(pr.doc ?? "{}")) as Row; } catch { return {}; } };
const blockingOf = (pr: Row): string[] => (pr.reasons ? String(JSON.parse(String(pr.reasons))) : "").split(",")
  .filter((r) => r && r !== "mergeable-unknown" && r !== "checks-running" && !r.startsWith("required:"));

// U178: what a red stretch (one `since`) has told its Builder, kept as JSON in the lifecycle:news
// episode's `result`: the head it last heard about, the blocking reasons it was sent (a failed check
// by name, open threads as the most it heard of) and when it was last poked about the PR (`at`).
// U214: a failed RUN is news too (`runs`, `<name>#<run>`), but a check that only ran again and failed again
// on a head already told about waits `red_repoke_min`, needs an idle Builder, and pokes at most twice a head
// (`repeats`, reset by a new head).
type Told = { since: number | null; head: string; sent: string[]; threads: number; at: number; runs?: string[]; repeats?: number };
type Heard = Omit<Told, "since" | "at" | "runs" | "repeats"> & { runs: string[] };
function heard(store: Store, project: string, pr: Row): Heard {
  const doc = docOf(pr), sent: string[] = [], runs: string[] = [];
  let threads = 0;
  for (const r of blockingOf(pr)) {
    if (r.startsWith("threads:")) threads = Number(r.slice(8)) || 0;
    else if (r === "checks-failing") {
      const f = failedChecks(doc, expectedChecks(store, project));
      sent.push(...(f.length ? f.map((c) => `checks-failing:${c.name}`) : [r]));
      runs.push(...f.map((c) => `${c.name}#${c.run}`));
    } else sent.push(r);
  }
  return { head: String(doc.headRefOid ?? ""), sent, threads, runs };
}
function toldOf(row: Row | null, since: unknown): Told | null {
  if (!row?.result) return null;
  try {
    const t = JSON.parse(String(row.result)) as Told;
    return t && typeof t === "object" && Array.isArray(t.sent) && t.since === (since == null ? null : Number(since)) ? t : null;
  } catch { return null; }
}
// News on a blocked PR: a new head, or a blocking reason this stretch never sent (a reason that went
// away and came back is not news; one more open thread is).
const fresh = (told: Told, now: Heard): boolean =>
  now.head !== told.head || now.threads > told.threads || now.sent.some((r) => !told.sent.includes(r));
// U214: nothing fresh, but a failed run this stretch never sent, the wait is over and the head has repeats left.
const repeatDue = (told: Told, now: Heard, waitS: number, t: number): boolean =>
  waitS > 0 && t - told.at >= waitS && (told.repeats ?? 0) < 2 && now.runs.some((r) => !(told.runs ?? []).includes(r));
// U275: the open review threads of a PR read, as `<author> on <path>:<line> <url>` (never a comment body),
// at most 10 and `+N more`; "" when none. A nudge naming them lets a Builder answer the right thread.
function threadList(pr: Row): string {
  const nodes = ((docOf(pr).reviewThreads as Row | undefined)?.nodes ?? []) as Row[];
  const open = nodes.filter((n) => n && n.isResolved !== true).map((n) => {
    const c = ((n.comments as Row | undefined)?.nodes as Row[] | undefined)?.[0];
    const who = String((c?.author as Row | undefined)?.login ?? "someone"), at = n.path ? `${n.path}${n.line != null ? `:${n.line}` : ""}` : "the PR";
    return `${who} on ${at}${c?.url ? ` ${c.url}` : ""}`;
  });
  if (!open.length) return "";
  return ` Open review threads (GitHub blocks the merge until each is resolved): ${open.slice(0, 10).join("; ")}${open.length > 10 ? `; +${open.length - 10} more` : ""}.`;
}
function tell(store: Store, project: string, topic: string, slug: string, pr: Row, key: string | null, t: number, repeat = false): void {
  const k = { project, subject: `${topic}/${slug}`, kind: "lifecycle:news" }, old = toldOf(store.get("episodes", k), pr.since), now = heard(store, project, pr);
  const repeats = repeat ? (old?.repeats ?? 0) + 1 : old && old.head === now.head ? old.repeats ?? 0 : 0;
  const told: Told = { since: pr.since == null ? null : Number(pr.since), head: now.head, sent: [...new Set([...(old?.sent ?? []), ...now.sent])], threads: Math.max(old?.threads ?? 0, now.threads), at: t,
    runs: [...new Set([...(old?.runs ?? []), ...now.runs])], repeats };
  store.upsert("episodes", k, { squad: topic, ...(key !== null ? { episode_key: key } : {}), count: 1, state: "poked", source: "loop", started_at: t, observed_at: t, result: JSON.stringify(told) });
}

// U77: what a watched PR's Builder should hear. Null while nothing is news: a local-only squad, a PR
// not read in full, a verdict that is only waiting (checks still running), or merged/closed. The key is
// `pr-news|<head sha>|<verdict>|<reasons>`; on a blocked PR, U178's `fresh` decides whether it is news.
// U182: a conflicting or behind PR is told to merge the base in (never rebase), the way the repo's
// AGENTS.md says; only a project with `base_update rebase` keeps the rebase wording.
function prNews(store: Store, project: string, pr: Row, u: Row, applies: boolean, sf: string, dflt: string | null): { key: string; text: string } | null {
  if (!applies || pr.detail !== "full" || (pr.verdict !== "blocked" && pr.verdict !== "ready")) return null;
  const doc = docOf(pr), list = blockingOf(pr), reasons = list.join(",");
  const failed = list.includes("checks-failing") ? failedChecks(doc, expectedChecks(store, project)) : [];
  // U214: the failed runs are in the key, so a repeat is a poke of its own, not a retry counted toward the cap.
  const digest = failed.length ? `|${createHash("sha1").update(failed.map((c) => `${c.name}#${c.run}`).sort().join(",")).digest("hex").slice(0, 8)}` : "";
  const key = `pr-news|${doc.headRefOid ?? ""}|${pr.verdict}|${reasons}${digest}`, slug = String(u.slug), head = `dev-studio loop: PR #${pr.pr} for your unit ${slug}`;
  if (pr.verdict === "ready") return { key, text: `${head} is merge-ready (checks green, no open review threads, mergeable). Run: ~/.dev-studio/bin/role/finish-unit.sh ${sf} ${slug} — then stop at your prompt.` };
  const to: string[] = [];
  if (list.includes("checks-failing")) {
    const f = failed, lanes = failedLanes(doc, expectedChecks(store, project));
    to.push(`checks failed: ${f.map((c) => c.name).join(", ") || "see gh pr checks"}${lanes.length ? ` (lanes failed: ${lanes.map((c) => c.name).join(", ")})` : ""}. Read why: ${[...f, ...lanes].filter((c) => c.id !== null).map((c) => `gh run view --job ${c.id} --log-failed`).join("; ") || `gh pr checks ${pr.pr}`}; fix, push.`);
  }
  if (list.some((r) => r.startsWith("threads:"))) to.push(`${list.find((r) => r.startsWith("threads:"))!.slice(8)} open review thread(s): read them, fix or reply, push.${threadList(pr)}`);
  if (list.includes("changes-requested")) to.push("changes were requested: address the review, push.");
  if (list.includes("conflicting") || list.includes("behind")) {
    if (baseUpdate(store, project) === "rebase") {
      to.push(`the branch is ${list.includes("conflicting") ? "conflicting" : "behind"}: rebase onto the base, resolve, push.`);
    } else {
      // The PR's own base (a stacked PR's is not the repo default); the repo's AGENTS.md names the command.
      const b = String(pr.base || dflt || "") || "the base";
      to.push(`the branch is ${list.includes("conflicting") ? `conflicting with ${b}` : `behind ${b}`}: merge ${b} in (not a rebase), with the command the repo's AGENTS.md names if it names one, resolve, push.`);
    }
  }
  if (list.includes("draft")) to.push("the PR is a draft.");
  if (!to.length) return null;
  return { key, text: `${head} changed (${reasons}): ${to.join(" ")}${pullFirst(store, project, pr)} The loop pokes you again when the PR changes; do not poll GitHub. If a blocker needs the Lead, orch.sh ask it.` };
}

// U2: a PR the loop will merge the base into, in its repo's line.
type Updatable = { nwo: string; n: number; ref: string; head: string; topic: string; slug: string; lead: string | null; base: string };
// U2: the update-branch action's episode for one head of a PR, and its claim row.
const updateEp = (ref: string, head: string) => `update-branch:${ref}|${head}`;
const updateClaim = (store: Store, project: string, ref: string) => store.get("episodes", { project, subject: ref, kind: "action:update-branch" });
// U2: the loop merges the base into this PR itself: auto_merge on, a dispatched unit's open PR into the
// default branch, mergeable, `behind` its only reason, and no update of this head failed.
function loopUpdates(store: Store, project: string, pr: Row, u: Row, dflt: string | null): boolean {
  if (u.status !== "dispatched" || !dflt || pr.base !== dflt || pr.state !== "OPEN" || pr.gone_at || pr.mergeable !== "MERGEABLE") return false;
  const reasons = pr.reasons ? String(JSON.parse(String(pr.reasons))).split(",").filter(Boolean) : [];
  if (reasons.length !== 1 || reasons[0] !== "behind" || autoMerge(store, project) === "off") return false;
  const ref = String(pr.ref), head = headOf(pr);
  const failed = store.get("episodes", { project, subject: ref, kind: UPDATE_FAILED });
  if (failed && String(failed.episode_key ?? "") === head) return false;
  const claim = updateClaim(store, project, ref);
  return !(claim?.episode_key === updateEp(ref, head) && (claim.state === "failed" || claim.state === "dropped"));
}
// U2: after the loop merged the base in on GitHub, the Builder's worktree is a merge commit behind its remote.
const pullFirst = (store: Store, project: string, pr: Row): string => {
  const c = updateClaim(store, project, String(pr.ref));
  return c?.state === "done" && c.result === "updated" ? " The loop merged the base into this branch on GitHub: git pull --no-rebase before you push." : "";
};

// 1d leftovers: kept worktrees of a squad (live or closed). A record whose tree is gone is dropped from the squad's row and,
// through a `gone` removal, from its state file (live or archived); a tree still there goes through the removal check.
function leftoverStep(ctx: TickCtx, s: Row, nwo: string | null, out: Action[]): void {
  const { store, project, now: t } = ctx, topic = String(s.topic);
  const retry = Math.floor(t / envInt("DS_LOOP_LIFECYCLE_RETRY_S", 600));
  const member = (wt: unknown): Row | null => (wt ? store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? AND COALESCE(status, '') != 'gone'").get(project, topic, String(wt)) as Row | null : null);
  const doc = JSON.parse(String(s.doc)) as Row, left = Array.isArray(doc.leftovers) ? (doc.leftovers as Row[]) : [];
  const keep = left.filter((l) => paused(store, { project, squad: topic, member: String(l.wt) }) || !(member(l.wt) || !existsSync(String(l.path ?? ""))));
  if (keep.length !== left.length) {
    const next = JSON.stringify({ ...doc, leftovers: keep });
    fact(store, "squads", Number(s.id), "doc", next, s.doc, "leftover_dropped", { project, squad: topic, payload: { dropped: left.filter((l) => !keep.includes(l)).map((l) => l.wt) } });
    // The state file keeps the record until the removal's drop-leftover writes it out (the folder is gone: nothing to check).
    for (const l of left) if (!keep.includes(l) && !member(l.wt) && !existsSync(String(l.path ?? "")))
      out.push({ project, squad: topic, subject: String(l.wt), kind: "worktree.remove", episode: `leftover-gone:${l.wt}@${retry}`,
        payload: { label: project, topic, wt: l.wt, path: l.path, branch: String(l.branch ?? ""), unit: l.unit ?? null, merged: false, gone: true } });
  }
  for (const l of keep) {
    if (paused(store, { project, squad: topic, member: String(l.wt) })) continue;
    const branch = String(l.branch ?? ""), merged = !!branch && !!nwo && !!store.db.query("SELECT 1 FROM observed_prs WHERE project = ? AND repo = ? AND head = ? AND state = 'MERGED'").get(project, nwo, branch);
    out.push({ project, squad: topic, subject: String(l.wt), kind: "worktree.remove", episode: `leftover:${l.wt}@${retry}`,
      payload: { label: project, topic, wt: l.wt, path: l.path, branch, unit: l.unit ?? null, merged } });
  }
}

export function run(ctx: TickCtx): Action[] {
  const { store, project, now: t } = ctx, out: Action[] = cancellationActions(ctx);
  const retry = Math.floor(t / envInt("DS_LOOP_LIFECYCLE_RETRY_S", 600));
  const squads = store.db.query("SELECT * FROM squads WHERE project = ? AND doc IS NOT NULL AND COALESCE(status, '') != 'closed' ORDER BY topic").all(project) as Row[];
  const extraGates = humanCheckNames(store, project), expected = prExpectedChecks(store, project);
  // U2: per repo, the PRs the loop updates (in line) and the open PRs that are not blocked (still on their way to merge).
  const updates = new Map<string, Updatable[]>(), onTrack = new Set<string>();
  for (const s of squads) {
    const topic = String(s.topic);
    const nwo = (store.get("config", { project, file: "github", key: `repo:${s.repo}` })?.value as string) || null;
    const dflt = nwo ? (store.get("config", { project, file: "github", key: `default_branch:${nwo}` })?.value as string) : null;
    const prRow = (pr: unknown, slug: string): Row | null => {
      const n = num(pr);
      if (n === null) return null;
      return (nwo && store.get("observed_prs", { project, ref: `${nwo}#${n}` }))
        || (store.db.query("SELECT * FROM observed_prs WHERE project = ? AND ref = ? AND pr = ?").get(project, `${topic}/${slug}`, n) as Row | null);
    };
    const branchPr = (branch: string, not: number | null): number | null => {
      if (!nwo || !branch || branch === "HEAD" || branch === "main" || branch === dflt) return null;
      const open = store.db.query(`SELECT MAX(pr) AS n FROM observed_prs WHERE project = ? AND repo = ? AND head = ? AND state = 'OPEN' AND gone_at IS NULL AND pr IS NOT ?`)
        .get(project, nwo, branch, not) as { n: number | null };
      if (open.n !== null) return open.n;
      const merged = store.db.query(`SELECT pr FROM observed_prs WHERE project = ? AND repo = ? AND head = ? AND state = 'MERGED' AND pr IS NOT ? ORDER BY merged_at DESC, pr DESC`)
        .get(project, nwo, branch, not) as { pr: number } | null;
      return merged?.pr ?? null;
    };
    const member = (wt: unknown): Row | null => (wt ? store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? AND COALESCE(status, '') != 'gone'").get(project, topic, String(wt)) as Row | null : null);
    // U148: a working Claude hears the PR pokes at its next step (the text reaches its input queue); other agents wait for idle.
    const claude = (r: Row | null) => String(r?.agent || "claude") === "claude";
    const worker = (wt: unknown): Row | null => (wt ? store.db.query("SELECT * FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, String(wt)) as Row | null : null);
    const tree = (wt: unknown): Row | null => (wt ? store.db.query("SELECT * FROM observed_worktrees WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, String(wt)) as Row | null : null);
    const lead = (s.lead_wt as string) || (store.db.query("SELECT wt FROM members WHERE project = ? AND squad = ? AND role = 'lead' AND COALESCE(status, '') != 'gone' ORDER BY ord DESC, id DESC").get(project, topic) as { wt: string } | null)?.wt;
    const babysits = store.get("config", { project, file: "ship-mode", key: "mode" })?.value !== "local-only";
    const contract = onContract(store, project, topic);
    const units = () => store.db.query("SELECT rowid AS _rowid, * FROM units WHERE project = ? AND squad = ? ORDER BY ord IS NULL, ord, id").all(project, topic) as Row[];
    // U160: `hold` keeps a planned unit quiet; a unit dispatched by hand despite it is only held back by a blocking question (U28/#273).
    const waitingForRuling = (u: Row, questions = waiting(store, project, topic)) => (u.status !== "dispatched" && !!u.hold) || !!blockingForUnit(questions.map(entryOf), String(u.slug));
    const end = (row: Row | null) => { if (row) store.db.run("DELETE FROM episodes WHERE id = ?", [Number(row.id)]); };
    const ev = (u: Row, payload: Row): Ctx => ({ project, squad: topic, unit: String(u.slug), member: (u.builder_wt as string) || null, payload });
    // The unit's Builder has finished (it ran finish-unit, sits in babysit, or stopped at its prompt).
    const builderFinished = (u: Row, bwt: string): boolean => {
      if (!bwt) return false;
      const live = worker(bwt);
      if (live && (live.state === "working" || live.state === "waiting")) return false;
      const slug = String(u.slug);
      if (store.db.query("SELECT 1 FROM requests WHERE project = ? AND squad = ? AND kind = 'finish-unit' AND done_at IS NOT NULL AND key LIKE ?").get(project, topic, `%/${topic}/${slug}@%`)) return true;
      if (String(member(bwt)?.phase ?? "") === "babysit") return true;
      const w = worker(bwt);
      return !!w && (w.state === "idle" || w.state === "done");
    };

    for (const u of units()) {
      const id = Number(u._rowid), slug = String(u.slug);
      // 1a / 1a-closed
      if (u.status === "dispatched") {
        const cur = u.pr ? prRow(u.pr, slug) : null, branch = String(tree(u.builder_wt)?.branch ?? "");
        if (!u.pr || cur?.state === "CLOSED") {
          const n = branchPr(branch, num(u.pr));
          if (n !== null) fact(store, "units", id, "pr", String(n), u.pr ?? null, "unit_pr", ev(u, { pr: n, was: u.pr ?? null, branch }));
        }
      }
      // 1b
      const after = store.db.query("SELECT rowid AS _rowid, * FROM units WHERE rowid = ?").get(id) as Row;
      const pr = after.pr ? prRow(after.pr, slug) : null;
      if (pr?.state === "MERGED" && after.status !== "done" && after.status !== "cancelled") {
        store.tx(() => {
          if (!store.setIf("units", id, "status", "done", after.status ?? null)) return;
          store.setIf("units", id, "done_at", t, after.done_at ?? null);
          store.event("unit_done", ev(after, { pr: num(after.pr), was: after.status ?? null }));
          // A lane record is bookkeeping: its failure must not undo the done.
          try { recordLane(store, after, pr.doc, num(after.pr), t); } catch (e) { console.error(`lanes: no record for ${slug}: ${(e as Error).message}`); }
        });
      }
      // into-PR (1d)
      const into = String(after.superseded_by ?? "").match(/^PR#(\d+)$/);
      if (after.status === "cancelled" && into && !after.into_merged && nwo && store.get("observed_prs", { project, ref: `${nwo}#${into[1]}` })?.state === "MERGED")
        fact(store, "units", id, "into_merged", 1, after.into_merged ?? null, "unit_into_merged", ev(after, { pr: Number(into[1]) }));
    }

    for (const u of units()) {
      const id = Number(u._rowid), slug = String(u.slug), bwt = u.builder_wt ? String(u.builder_wt) : "", m = member(bwt);
      const pr = u.pr ? prRow(u.pr, slug) : null;
      // 1c (U155): write the Builder's own archived wish; the decider (decide.ts) closes it
      // only once it is not working or waiting, and fulfil/close.ts removes its worktree.
      // U12: off Orca, a finish row of its generation also says its work ended.
      const idle = !["working", "waiting"].includes(String(worker(bwt)?.state ?? "")) || (!!m && contract && !!finishOf(store, m));
      if (u.status === "done" && pr?.state === "MERGED" && m && m.want !== "gone" && !paused(store, { project, squad: topic, member: bwt }) && idle) {
        store.want("member", String(m.id), "gone", { by: "loop", why: `unit ${slug} done` });
      }
      // 9: dispatched, or done while its Builder is still a member
      // A PR that merged, closed or left the query clears the flags and ends both episodes.
      const open = (u.status === "dispatched" || (u.status === "done" && !!m)) && pr?.state === "OPEN" && !pr.gone_at;
      // `mergeable-unknown` is GitHub re-reading the PR, not a reason: it is left out of the flag, and
      // a PR waiting on it keeps the flag it had. `unit_pr_blocked` is written only when the reasons
      // change; a stale count that moves on its own updates the column quietly (U57).
      const all = open && pr!.reasons ? String(JSON.parse(String(pr!.reasons))).split(",") : [];
      const rereading = open && pr!.verdict === "waiting" && all.includes("mergeable-unknown");
      const blocked = open && pr!.verdict === "blocked", reasons = all.filter((r) => r && r !== "mergeable-unknown").join(",");
      const want = rereading ? (u.merge_blocked ?? null) : blocked ? reasons : null;
      const stale = rereading ? (u.pr_stale ?? null) : blocked ? Number(pr!.stale ?? 0) : null;
      if ((u.merge_blocked ?? null) !== want || (u.pr_stale ?? null) !== stale) {
        store.tx(() => {
          store.setIf("units", id, "merge_blocked", want, u.merge_blocked ?? null);
          store.setIf("units", id, "pr_stale", stale, u.pr_stale ?? null);
          if ((u.merge_blocked ?? null) !== want) store.event("unit_pr_blocked", ev(u, { pr: pr?.pr ?? null, reasons: want, stale }));
        });
      }
      const askHere = pr ? askState(pr, extraGates, expected) : null;
      const gateFailOnly = !!askHere && askHere.gates.length > 0 && askHere.blockers.every((b) => b === "checks-running");
      const sk = { project, subject: `${topic}/${slug}`, kind: "lifecycle:stale" }, row = store.get("episodes", sk);
      const mk = { project, subject: `${topic}/${slug}`, kind: "lifecycle:merge-ready" }, mr = store.get("episodes", mk);
      const sl = { project, subject: `${topic}/${slug}`, kind: "lifecycle:stale-lead" }, slr = store.get("episodes", sl);
      const nk = { project, subject: `${topic}/${slug}`, kind: "lifecycle:news" }, nr = store.get("episodes", nk);
      const rk = { project, subject: `${topic}/${slug}`, kind: "lifecycle:required-wait" }, rwr = store.get("episodes", rk);
      if (!open || !pr) { end(row); end(mr); end(slr); end(nr); end(rwr); continue; }
      if (waitingForRuling(u)) {
        end(row); end(mr); end(slr); end(nr); end(rwr);
        continue;
      }
      const updating = loopUpdates(store, project, pr, u, dflt);
      if (updating && nwo && dflt) {
        const list = updates.get(nwo) ?? [];
        list.push({ nwo, n: Number(pr.pr), ref: String(pr.ref), head: headOf(pr), topic, slug, lead: lead ?? null, base: dflt });
        updates.set(nwo, list);
      } else if (u.status === "dispatched" && !blocked) onTrack.add(String(pr.ref));
      const staleRepoke = envOr(store, project, "DS_LOOP_STALE_REPOKE_MIN", "stale_repoke_min", 30);
      // The sweep's stale_prs pokes: ready or a wait on required:* alone ends the episode, any other
      // waiting arms a second poke.
      if (pr.verdict === "ready" || (pr.verdict === "waiting" && requiredOnly(all.filter(Boolean)))) { end(row); end(slr); } // the full list, as github.ts's carrySince reads it
      else if (pr.verdict === "waiting") { if (row && row.state !== "armed") store.upsert("episodes", sk, { state: "armed", observed_at: t }); }
      else if (blocked && babysits && m && tree(bwt) && !gateFailOnly && !updating) {
        const key = `${pr.pr}|${pr.since ?? ""}`, same = row?.episode_key === key, n = same ? Number(row!.count ?? 0) : 0;
        // U182: merge the base in, never rebase; only a `base_update rebase` project keeps the rebase wording.
        const sf = stateFile(store, project, topic), fix = baseUpdate(store, project) === "rebase"
          ? `Fix it — rebase/resolve conflicts, fix the red check, address the open review threads — push, and stop at your prompt: the loop pokes you again when the PR changes (merge-ready included). If a blocker needs a reviewer or the Lead (changes requested, a thread you disputed), orch.sh ask your Lead instead of changing code. Don't send worker_done again.`
          : `Fix it — merge the base in and resolve conflicts, fix the red check, address the open review threads — push, and stop at your prompt: the loop pokes you again when the PR changes (merge-ready included). If a blocker needs a reviewer or the Lead (changes requested, a thread you disputed), orch.sh ask your Lead instead of changing code. Don't send worker_done again.`;
        // U160: a sent pr-stale poke told the Builder about the PR as it is now; the pr-news poke below fires only for a later change.
        // Quiet: no check running, the Builder idle at its prompt (idle/done, or Orca's `working` that
        // atPrompt reads as at its prompt: a still transcript with only a background task open), its
        // worktree under 5% CPU, and staleRepoke min since the latest of the first poke, the last news
        // poke and its last output (at its prompt: its transcript's last write, as the screen keeps moving).
        const quiet = (ep: Row): { prompt: boolean } | null => {
          if (staleRepoke <= 0 || all.includes("checks-running")) return null;
          const w = worker(bwt);
          if (!w) return null;
          const p = w.state === "working" ? atPrompt(store, project, topic, slug, String(bwt), t, w) : null;
          if (w.state !== "idle" && w.state !== "done" && !p) return null;
          const cpu = store.db.query("SELECT cpu_pct FROM observed_procs WHERE project = ? AND wt = ?").get(project, String(bwt)) as { cpu_pct: number | null } | null;
          if (cpu && Number(cpu.cpu_pct ?? 0) >= 5) return null;
          const last = Math.max(Number(ep.observed_at ?? 0), toldOf(store.get("episodes", nk), pr.since)?.at ?? 0, p ? p.since : Number(w.last_output_at ?? 0));
          return t - last >= staleRepoke * 60 ? { prompt: !!p } : null;
        };
        let q: { prompt: boolean } | null = null;
        const told = () => tell(store, project, topic, slug, pr, prNews(store, project, pr, u, u.status === "dispatched", sf, dflt)?.key ?? null, t);
        if (n === 0 || (same && row!.state === "armed" && n < 2)) {
          const text = `dev-studio loop: PR #${pr.pr} for your unit ${slug} is not merge-ready (${reasons}).${threadList(pr)}${pullFirst(store, project, pr)} ${fix}`;
          const w = wake(ctx, bwt, text, "pr-stale", `${pr.problem ?? ""}|${pr.since ?? ""}#${n + 1}`, { allowWorking: claude(m) });
          out.push(...w.actions);
          if (w.status === "sent") store.upsert("episodes", sk, { squad: topic, episode_key: key, count: n + 1, state: "poked", source: "loop", started_at: same ? row!.started_at : t, observed_at: t,
            next_at: n + 1 >= 2 ? t : null });
          if (w.status === "sent") told();
        } else if (same && row!.state === "poked" && n === 1 && (q = quiet(row!))) {
          // U275: the Builder went quiet after the first poke without pushing: the second comes after
          // stale_repoke_min, so the Lead and card timers (which run from it) follow.
          const text = `dev-studio loop: PR #${pr.pr} for your unit ${slug} is still not merge-ready (${reasons}) and nothing has changed for ${staleRepoke} min.${threadList(pr)} ${fix}`;
          const w = wake(ctx, bwt, text, "pr-stale", `${pr.problem ?? ""}|${pr.since ?? ""}#2`, { allowWorking: q.prompt });
          out.push(...w.actions);
          if (w.status === "sent") { store.upsert("episodes", sk, { squad: topic, episode_key: key, count: 2, state: "poked", source: "loop", observed_at: t, next_at: t }); told(); }
        } else if (same) {
          // U178: a Builder session placed or cleared after the last poke about this PR never saw it:
          // one more pr-stale poke per session, once it is idle; it does not count toward the two.
          const last = toldOf(store.get("episodes", nk), pr.since), session = Math.max(Number(m.placed_at ?? 0), Number(m.cleared_at ?? 0));
          if (session > (last?.at ?? Number(row!.observed_at ?? 0))) {
            const text = `dev-studio loop: PR #${pr.pr} for your unit ${slug} is still not merge-ready (${reasons}); an earlier session of yours was told, this one was not.${threadList(pr)} ${fix}`;
            const w = wake(ctx, bwt, text, "pr-stale", `${pr.problem ?? ""}|${pr.since ?? ""}#s${session}`);
            out.push(...w.actions);
            if (w.status === "sent") told();
          }
        }
      }
      // U70: the Builder's two pokes did not fix it; its Lead hears once per stale stretch.
      // board-empty-state-and-port U4: the ladder never freezes on a poke that can't be sent. With one
      // poke sent, the second is due stale_repoke_min after it; if wake() never sent it (limited, a
      // draft, paused, really working, not quiet), the Lead's timer runs from that due time.
      const staleLead = envOr(store, project, "DS_LOOP_STALE_LEAD_MIN", "stale_lead_min", 30), skey = `${pr.pr}|${pr.since ?? ""}`;
      const pokesSent = row?.episode_key === skey ? Number(row.count ?? 0) : 0;
      const leadFrom = pokesSent >= 2 ? (row!.next_at != null ? Number(row!.next_at) : null)
        : pokesSent === 1 && staleRepoke > 0 ? Number(row!.observed_at ?? 0) + staleRepoke * 60 : null;
      if (slr && slr.episode_key !== skey) end(slr);
      if (blocked && !gateFailOnly && lead && staleLead > 0 && leadFrom != null
        && t >= leadFrom + staleLead * 60 && !(slr && slr.episode_key === skey)) {
        const ws = bwt ? String(worker(bwt)?.state ?? "gone") : "gone";
        const after = pokesSent >= 2 ? `${staleLead} min after its Builder's second pr-stale poke`
          : `${staleRepoke + staleLead} min after its Builder's first pr-stale poke (the second, due ${staleRepoke} min after it, could not be sent)`;
        const text = `dev-studio loop: PR #${pr.pr} for unit ${slug} is still not merge-ready (${reasons}) ${after}; the Builder is ${ws}. Look at it, re-dispatch the unit, or ask the operator. (One request per stale stretch.)`;
        const w = wake(ctx, lead, text, "pr-stale-lead", `${pr.pr}|${pr.since ?? ""}#lead`);
        out.push(...w.actions);
        if (w.status === "sent") store.upsert("episodes", sl, { squad: topic, episode_key: skey, count: 1, state: "sent", source: "loop", started_at: t, observed_at: t });
      }
      // U178: still blocked stale_alert_min after the Lead's request: one Studio alert per stretch, no further poke.
      const staleAlert = envOr(store, project, "DS_LOOP_STALE_ALERT_MIN", "stale_alert_min", 60);
      if (blocked && !gateFailOnly && lead && staleAlert > 0 && slr?.episode_key === skey && slr.state === "sent" && t >= Number(slr.started_at ?? 0) + staleAlert * 60) {
        out.push({ project, squad: topic, member: lead, subject: lead, kind: "alert", episode: `pr-stale:${pr.ref}|${pr.since ?? ""}`,
          payload: { title: "Red PR still blocked", card: "pr_stale", fields: { ref: pr.ref, pr: pr.pr, url: pr.url ?? null, blocked_since: pr.since ?? null },
            text: `PR #${pr.pr}${pr.url ? ` ${pr.url}` : ""} (${topic}/${slug}) is still not merge-ready (${reasons}) ${staleAlert} min after its Lead was told, and its Builder was poked ${pokesSent >= 2 ? "twice" : "once (a second poke could not be sent)"}. The loop pokes no one again for this stretch. Its Lead can re-dispatch the unit or ask the operator; this card goes when the PR merges, closes or is no longer blocked.` } });
        store.upsert("episodes", sl, { state: "alerted", observed_at: t });
      }
      // U179: a PR waiting on required:<context> alone, none a human gate (those take the pr-question
      // path), waits on a context nobody has posted. Its Builder, idle required_wait_min, hears once; the
      // Lead once more required_wait_min after that. GitHub re-reading mergeability keeps the episode.
      // U183: a wait mixing human gates with Builder-owned contexts pokes the Builder for its part
      // alone: the key and the text name only the non-gate contexts.
      if (!rereading) {
        const ctxs = pr.verdict === "waiting" && requiredOnly(all.filter(Boolean)) ? all.filter(Boolean).map((r) => r.slice(9)) : [];
        const owned = ctxs.filter((c) => !isHumanGate(c, extraGates));
        const rkey = owned.length ? `${pr.pr}|${headOf(pr)}|${owned.join(",")}` : null;
        const reqWait = envOr(store, project, "DS_LOOP_REQUIRED_WAIT_MIN", "required_wait_min", 15) * 60;
        const cur = rwr && rwr.episode_key === rkey ? rwr : null;
        if (rwr && !cur) end(rwr);
        if (rkey && reqWait > 0 && babysits && m && tree(bwt)) {
          const list = owned.map((c) => `\`${c}\``).join(", "), it = owned.length > 1 ? "them" : "it";
          // P3 (review r1): the gate clause reads wrong on a pure Builder-owned wait, so it
          // runs only in a mixed wait; otherwise the U179 wording stands as it was.
          const scope = ctxs.length > owned.length ? `on ${list} (besides any human gate, which the operator clears)` : `only on ${list}`;
          if (!cur) store.upsert("episodes", rk, { squad: topic, episode_key: rkey, count: 0, state: "seen", source: "loop", started_at: t, observed_at: t, next_at: t + reqWait });
          else if (cur.state === "seen" && t >= Number(cur.next_at ?? 0)) {
            // Idle that long (observed_workers.since is when it entered its state); a working Builder waits.
            const w = worker(bwt), idle = !!w && (w.state === "idle" || w.state === "done") && w.since != null && t - Number(w.since) >= reqWait;
            if (idle) {
              const text = `dev-studio loop: PR #${pr.pr} for your unit ${slug} waits ${scope}, which nobody has posted. If your ship step posts ${it}, run it now; if you don't know who posts ${it}, orch.sh ask your Lead. Then stop at your prompt.`;
              const wk = wake(ctx, bwt, text, "required-wait", rkey);
              out.push(...wk.actions);
              if (wk.status === "sent") store.upsert("episodes", rk, { count: 1, state: "poked", observed_at: t, next_at: t + reqWait });
            }
          } else if (cur.state === "poked" && lead && t >= Number(cur.next_at ?? 0)) {
            const text = `dev-studio loop: PR #${pr.pr} for unit ${slug} still waits ${scope}, which nobody has posted, ${reqWait / 60} min after its Builder was told to post ${it} or ask you. Find who posts ${it} and get ${it} posted, or ask the operator. (One request per wait.)`;
            const wk = wake(ctx, lead, text, "required-wait-lead", `${rkey}#lead`);
            out.push(...wk.actions);
            if (wk.status === "sent") store.upsert("episodes", rk, { count: 2, state: "sent", observed_at: t, next_at: null });
          }
        }
      }
      // U77, after step 9's pr-stale poke (a Builder poked this tick hears the news at its next step if it is a working Claude, else once it is idle): one poke when the
      // PR turns ready, or (U178) when a blocked one shows a new head or a blocking reason not yet sent in this stretch.
      const news = gateFailOnly || updating ? null : prNews(store, project, pr, u, u.status === "dispatched" && babysits && !!m && !!tree(bwt), stateFile(store, project, topic), dflt);
      const nrow = store.get("episodes", nk), told = toldOf(nrow, pr.since);
      const nowHeard = pr.verdict === "blocked" && told ? heard(store, project, pr) : null;
      // U214: a repeat (a failed check ran again) is not fresh news, so it keeps to the wait, an idle Builder and two a head.
      const again = !!news && !!told && !!nowHeard && !fresh(told, nowHeard) && repeatDue(told, nowHeard, envOr(store, project, "DS_LOOP_RED_REPOKE_MIN", "red_repoke_min", 15) * 60, t);
      // GitHub re-reading mergeability keeps the episode, so the same ready head does not poke twice; so
      // does a red stretch that is still on (a wait on running checks in it included).
      const inStretch = !!told && (pr.verdict === "blocked" || (pr.verdict === "waiting" && !requiredOnly(all.filter(Boolean))));
      if (!news) { if (!rereading && !inStretch) end(nr); }
      else if (pr.verdict === "blocked" && told ? fresh(told, nowHeard!) || again : nrow?.episode_key !== news.key) {
        const w = wake(ctx, bwt, news.text, "pr-news", news.key, { allowWorking: again ? false : claude(member(bwt)) });
        out.push(...w.actions);
        if (w.status === "sent") {
          if (pr.verdict === "blocked") tell(store, project, topic, slug, pr, news.key, t, again);
          else store.upsert("episodes", nk, { squad: topic, episode_key: news.key, count: 1, state: "poked", source: "loop", started_at: t, observed_at: t, result: null });
        }
      }
      // KTD17: the Lead merges a merge-ready unit PR into its repo's default branch; a PR that stops being ready ends it.
      // U166: with the project's auto_merge set, the loop arms GitHub auto-merge once per PR head
      // instead of poking the Lead; the stuck alert still fires when the PR stays open.
      const ready = u.status === "dispatched" && !!dflt && pr.base === dflt && pr.verdict === "ready" && pr.mergeable === "MERGEABLE";
      // GitHub re-reading mergeability is not the PR going unready: keep the episode (and a
      // merge-failed state) across the flap, as the pr-news episode does.
      if (!ready) { if (!rereading) end(mr); }
      else if (lead) {
        const ref = String(pr.ref), head = headOf(pr), key = head ? `${ref}|${head}` : ref;
        const method = autoMerge(store, project);
        const gap = envOr(store, project, "DS_LOOP_MERGE_READY_NUDGE_MIN", "merge_ready_nudge_min", 15) * 60;
        if (method !== "off") {
          const n = mr?.episode_key === key ? Number(mr.count ?? 0) : 0;
          // U249: the episode follows the actuator's claim, not this reconciler's own emit. The action is
          // emitted again every tick until the actuator has claimed it (a busy slot or subject turns it down
          // before the claim, and that wrote nothing). Safe: the actuator takes an episode once.
          const base = `merge-ready:${key}#auto`, claim = store.get("episodes", { project, subject: ref, kind: "action:merge" });
          const ck = String(claim?.episode_key ?? ""), round = ck === base ? 1 : ck.startsWith(`${base}#r`) ? Number(ck.slice(base.length + 2)) || 0 : 0;
          const mine = round > 0 ? claim : null;
          const tries = store.get("episodes", { project, subject: ref, kind: "merge-tries" });
          const tried = String(tries?.episode_key ?? "").startsWith(base);
          const claimed = (!!mine && ["acted", "running", "done", "pending"].includes(String(mine.state))) || tried || mr?.state === "merge-failed";
          const send = (ep: string) => out.push({ project, squad: topic, member: lead, subject: ref, kind: "merge", episode: ep,
            payload: { n: pr.pr, repo: nwo, method, unit: slug, topic, base: dflt, ref, head, ep: key } });
          if (!claimed) {
            send(base);
            if (!mr || mr.episode_key !== key) store.upsert("episodes", mk, { squad: topic, episode_key: key, count: 0, state: "merge-unclaimed", next_at: t + 2 * gap, source: "loop", started_at: t, observed_at: t, ended_at: null });
            else if (n === 0 && mr.state === "merge-unclaimed" && t >= Number(mr.next_at ?? 0)) {
              out.push({ project, squad: topic, member: lead, subject: lead, kind: "alert", episode: `merge-ready:${ref}`,
                payload: { title: "Merge-ready PR left open", card: "merge_card", fields: { ref, head },
                  text: `PR #${pr.pr} (${topic}/${slug}) is merge-ready into ${dflt} and still open after two merge_ready_nudge_min gaps; the loop never started its merge (no free background slot or the action was not claimed) and keeps trying — merge it by hand if this stays.` } });
              store.upsert("episodes", mk, { state: "merge-unclaimed-alerted", next_at: null, observed_at: t });
            }
          } else if (n === 0) store.upsert("episodes", mk, { squad: topic, episode_key: key, count: 1, state: "merge-armed", next_at: t + gap, source: "loop", started_at: t, observed_at: t, ended_at: null });
          // The reconcile rule: GitHub shows the PR open and mergeable with no auto-merge on it, and no merge
          // action of the loop's is running or waiting: arm it again, whatever the count. A merge the actuator
          // settled and GitHub still doesn't show is a new round, once the PR was read after the settle.
          if (claimed && mine?.state === "done" && mr?.state !== "merge-failed" && noAuto(pr) && round < MERGE_TRIES
              && !(tried && Number(tries!.count ?? 0) >= MERGE_TRIES) && Number(pr.observed_at ?? 0) > Number(mine.observed_at ?? 0)) send(`${base}#r${round + 1}`);
          // U286: a merge GitHub refused for its rate limit (before U286 that counted as a try and ended
          // merge-failed, or alerted) is armed again once the budget is back: a new round, with its own tries.
          else if (mine?.state === "done" && isRateLimit(String(mine.result ?? "")) && noAuto(pr) && hasBudget(budgetOf(store), t)) {
            send(`${base}#r${round + 1}`);
            if (mr?.episode_key !== key || mr.state !== "merge-armed")
              store.upsert("episodes", mk, { squad: topic, episode_key: key, count: 1, state: "merge-armed", result: null, next_at: t + gap, source: "loop", started_at: t, observed_at: t, ended_at: null });
          }
          if (n === 1 && t >= Number(mr!.next_at ?? 0)) {
            // Keep the row's state: a failed arm (merge-failed, written by the fulfiller) stays failed.
            store.upsert("episodes", mk, { count: 2, state: mr!.state ?? "merge-armed", next_at: t + gap, observed_at: t });
          } else if (n === 2 && t >= Number(mr!.next_at ?? 0)) {
            const failed = mr!.state === "merge-failed";
            const armed = autoOn(pr);
            out.push({ project, squad: topic, member: lead, subject: lead, kind: "alert", episode: `merge-ready:${ref}`,
              payload: { title: "Merge-ready PR left open", card: "merge_card", fields: { ref, head }, text: failed
                ? `PR #${pr.pr} (${topic}/${slug}) is merge-ready into ${dflt} and still open after two merge_ready_nudge_min gaps; auto-merge (${method}) could not be armed (see "Auto-merge not armed") — arm it or merge it by hand, then dispatch what the merge unblocked.`
                : armed ? `PR #${pr.pr} (${topic}/${slug}) is merge-ready into ${dflt} and still open after two merge_ready_nudge_min gaps with auto-merge (${method}) armed on GitHub; it has not merged.`
                : `PR #${pr.pr} (${topic}/${slug}) is merge-ready into ${dflt} and still open after two merge_ready_nudge_min gaps; GitHub shows no auto-merge (${method}) on it, so the loop's merge did not take hold; the loop tries again — merge it by hand if this stays.` } });
            store.upsert("episodes", mk, { count: 3, state: "alerted", next_at: null, ended_at: t, observed_at: t });
          }
        } else {
          const n = mr?.episode_key === ref ? Number(mr.count ?? 0) : 0;
          const text = `dev-studio loop: PR #${pr.pr} for unit ${slug} is merge-ready into ${dflt} (checks green, no open review threads, mergeable). Merge it (KTD17): confirm its base is ${dflt}, merge it, then dispatch what the merge unblocked.`;
          if (n === 0 || (n === 1 && t >= Number(mr!.next_at ?? 0))) {
            const w = wake(ctx, lead, text, "merge-ready", `${ref}#${n + 1}`);
            out.push(...w.actions);
            if (w.status === "sent") store.upsert("episodes", mk, { squad: topic, episode_key: ref, count: n + 1, state: "poked", next_at: t + gap, source: "loop", started_at: n ? mr!.started_at : t, observed_at: t });
          } else if (n === 2 && t >= Number(mr!.next_at ?? 0)) {
            out.push({ project, squad: topic, member: lead, subject: lead, kind: "alert", episode: `merge-ready:${ref}`,
              payload: { title: "Merge-ready PR left open", text: `PR #${pr.pr} (${topic}/${slug}) is merge-ready into ${dflt} and still open after two pokes to the Lead.` } });
            store.upsert("episodes", mk, { count: 3, state: "alerted", next_at: null, ended_at: t, observed_at: t });
          }
        }
      }
    }

    // The loop asks the PR questions: one question per PR, once only human gates remain and the
    // unit's Builder has finished. Withdrawn on a new push; re-asked when ready again (one per head).
    for (const u of units()) {
      const slug = String(u.slug), bwt = u.builder_wt ? String(u.builder_wt) : "";
      const pr = u.pr ? prRow(u.pr, slug) : null;
      if (!pr || u.status !== "dispatched" || !babysits) continue;
      const questions = pending(store, project, topic);
      // A separate routing question takes precedence over asking about human PR gates.
      // Loop-owned PR questions still run their withdrawal and answer-routing lifecycle.
      const held = waitingForRuling(u, waiting(store, project, topic).filter((q) => q.asker !== "loop"));
      const qk = { project, subject: `${topic}/${slug}`, kind: "lifecycle:pr-question" }, qe = store.get("episodes", qk);
      const openQs = questions.filter((q) => { try { return Number((JSON.parse(String(q.doc)) as Row).pr) === Number(pr.pr); } catch { return false; } });
      const loopQ = openQs.find((q) => { try { return String((JSON.parse(String(q.doc)) as Row).asker) === "loop"; } catch { return false; } });
      const ask = askState(pr, extraGates, expected), head = headOf(pr);
      // A new push withdraws the open question (the not-ready withdraw is in the U70 loop below).
      if (loopQ && qe?.episode_key && head) {
        const askedHead = String(qe.episode_key).split("|")[1] ?? "";
        if (askedHead && head !== askedHead) {
          const msg = `PR #${pr.pr} went back to not ready (new push); question withdrawn`;
          if (answer(store, project, topic, String(loopQ.id), msg, "reality")) {
            store.upsert("episodes", qk, { squad: topic, episode_key: String(qe.episode_key), state: "withdrawn", source: "loop", observed_at: t });
            if (s.status === "waiting-on-you" && !pending(store, project, topic).length) store.setIf("squads", Number(s.id), "status", "running", "waiting-on-you");
            if (!held && bwt && member(bwt)) out.push(...wake(ctx, bwt, `dev-studio loop: ${msg}. Fix the PR and stop at your prompt; the loop asks the operator again when only human gates remain.`, "pr-question", `${pr.pr}|${head}|withdrawn`).actions);
          }
          continue;
        }
      }
      if (held) continue;
      // Answered in a terminal (not through the board's answer fulfiller): route it as the board
      // answer is routed — Done follows the Done path, anything else goes to the Builder.
      if (!loopQ && qe && (qe.state === "asked" || qe.state === "reminded" || qe.state === "alerted")) {
        const qrow = store.db.query("SELECT answer, answered_via, answered_at FROM questions WHERE project = ? AND squad = ? AND id = ? ORDER BY seq DESC LIMIT 1").get(project, topic, `pr-${pr.pr}`) as Row | null;
        if (!qrow) { store.upsert("episodes", qk, { state: "done-wait", next_at: t + 86400, observed_at: t }); continue; }
        // After the quiet-day alert, an answer that is not newer than the alert was already
        // routed: close the episode instead of replaying it and alerting again.
        if (qe.state === "alerted" && Number(qrow.answered_at ?? 0) <= Number(qe.observed_at ?? 0)) {
          store.upsert("episodes", qk, { state: "closed", next_at: null, observed_at: t });
          continue;
        }
        // A board answer is the answer fulfiller's to route; one closed by reality (or with no
        // stored row) just follows the quiet-day path. This path is only for a terminal answer.
        if (qrow && qrow.answered_via !== "terminal" && qrow.answered_via !== "picker") {
          if (qrow.answered_via === "board") continue;
          store.upsert("episodes", qk, { state: "done-wait", next_at: t + 86400, observed_at: t });
          continue;
        }
        const ans = String(qrow?.answer ?? "");
        if (!ans.trim()) {
          out.push({ project, squad: topic, member: lead ?? bwt, subject: `${topic}/${slug}`, kind: "alert", episode: `pr-question-answer:${pr.pr}`,
            payload: { title: "PR answer without text", text: `The PR #${pr.pr} question (${topic}/${slug}) was answered in a terminal with no answer text, so the loop cannot tell Done from Send back; it follows the quiet-day path.` } });
        }
        if (!(/^done\W*$/i.test(ans.trim()) || ans.trim() === "Done — I cleared the gates") && ans) {
          const target = bwt && member(bwt) ? bwt : lead;
          if (target) {
            const w = wake(ctx, target, `dev-studio loop: the operator answered the PR #${pr.pr} question (${topic}/${slug}): ${ans} — act on it and stop at your prompt; the loop pokes you when the PR changes.`, "pr-question", `${pr.pr}|${head}|sent-back`);
            out.push(...w.actions);
            // Not delivered yet: wake() spaces its own attempts and alerts when they cap; a
            // capped answer follows the quiet-day path instead of retrying forever.
            if (w.status !== "sent") {
              if (w.status === "skipped:capped") store.upsert("episodes", qk, { state: "done-wait", next_at: t + 86400, observed_at: t });
              continue;
            }
          }
        }
        store.upsert("episodes", qk, { state: "done-wait", next_at: t + 86400, observed_at: t });
        continue;
      }
      // After the reminder has waited a quiet day with the gates still open: one alert.
      if (qe?.state === "reminded" && qe.next_at != null && t >= Number(qe.next_at) && ask && !ask.blockers.length && ask.gates.length
        && qe.episode_key === `${pr.pr}|${head}|${ask.gates.join(",")}` && builderFinished(u, bwt)) {
        out.push({ project, squad: topic, member: lead ?? bwt, subject: `${topic}/${slug}`, kind: "alert", episode: `pr-question:${pr.pr}`,
          payload: { title: "PR still waits on human gates", text: `PR #${pr.pr} (${topic}/${slug}) still waits on: ${ask.gates.join(", ")} a day after the reminder.` } });
        store.upsert("episodes", qk, { state: "alerted", next_at: null, observed_at: t });
        continue;
      }
      if (loopQ || openQs.length || !ask || ask.blockers.length || !ask.gates.length) continue;
      if (!builderFinished(u, bwt)) continue;
      const key = `${pr.pr}|${head}|${ask.gates.join(",")}`;
      const reminder = !!qe && qe.state === "done-wait" && qe.episode_key === key;
      if (reminder && qe.next_at != null && t >= Number(qe.next_at) && Number(qe.count ?? 0) >= 2) {
        out.push({ project, squad: topic, member: lead ?? bwt, subject: `${topic}/${slug}`, kind: "alert", episode: `pr-question:${pr.pr}`,
          payload: { title: "PR still waits on human gates", text: `PR #${pr.pr} (${topic}/${slug}) still waits on: ${ask.gates.join(", ")} after the reminder.` } });
        store.upsert("episodes", qk, { state: "alerted", next_at: null, observed_at: t });
        continue;
      }
      if (qe && qe.episode_key === key && (qe.state === "asked" || qe.state === "reminded" || qe.state === "alerted")) continue;
      if (reminder && qe.next_at != null && t < Number(qe.next_at)) continue;
      const note = latestReview(pr), gates = ask.gates.join(", ");
      const entry: Row = {
        id: `pr-${pr.pr}`, asker: "loop", blocking: true, pr: Number(pr.pr), unit: slug,
        title: `PR #${pr.pr} waits on: ${gates}`,
        question: `PR #${pr.pr} (${topic}/${slug}) waits on: ${gates}${pr.url ? `\n${pr.url}` : ""}${note ? `\nLatest review: "${note}"` : ""}`,
        options: ["Done — I cleared the gates", "Send back to the Builder"],
        choices: [{ label: "Done — I cleared the gates", does: "the loop reads the PR again and acts on it" }, { label: "Send back to the Builder", does: "your words are poked to the unit's Builder" }],
        suggestion: "Done — I cleared the gates", why: "only human gates remain on this PR",
        since: new Date(t * 1000).toISOString(),
        ...(lead ? { card_wt: lead } : {}),
      };
      store.tx(() => {
        askOpen(store, project, topic, entry);
        store.upsert("episodes", qk, { squad: topic, episode_key: key, count: reminder ? 2 : 1, state: reminder ? "reminded" : "asked", next_at: reminder ? t + 86400 : null, source: "loop", started_at: qe?.started_at ?? t, observed_at: t });
        store.event(reminder ? "pr_question_reminded" : "pr_question_asked", ev(u, { pr: Number(pr.pr), gates: ask.gates, head }));
      });
      if (s.status === "running") store.setIf("squads", Number(s.id), "status", "waiting-on-you", "running");
    }

    // U70: a question about a PR that went back to not ready
    for (const q of pending(store, project, topic)) {
      let n: unknown; try { n = (JSON.parse(String(q.doc)) as Row).pr; } catch { continue; }
      const row = typeof n === "number" ? prRow(n, "") : null;
      if (!row) continue;
      let asker0 = ""; try { asker0 = String((JSON.parse(String(q.doc)) as Row).asker ?? ""); } catch { /* not loop's */ }
      if (asker0 === "loop" && (row.state === "MERGED" || row.gone_at != null)) {
        if (answer(store, project, topic, String(q.id), `PR #${n} merged; question closed`, "reality")) {
          const u = units().find((x) => num(x.pr) === n);
          if (u) store.upsert("episodes", { project, subject: `${topic}/${u.slug}`, kind: "lifecycle:pr-question" }, { squad: topic, state: "closed", observed_at: t });
          if (s.status === "waiting-on-you" && !pending(store, project, topic).length) store.setIf("squads", Number(s.id), "status", "running", "waiting-on-you");
        }
        continue;
      }
      let bad = rowNotReady(row, false, extraGates);
      // A failing check that is only a human gate is the gate itself, not the PR going back.
      if (bad?.includes("checks-failing") && !checksOf(row, expected).some((c) => c.failed && !isHumanGate(c.name, extraGates))) bad = bad.filter((b) => b !== "checks-failing");
      if (!bad?.length) continue;
      let asker = ""; try { asker = String((JSON.parse(String(q.doc)) as Row).asker ?? ""); } catch { /* not loop's */ }
      if (asker === "loop") {
        const msg = `PR #${n} went back to not ready (${bad.join(",")}); question withdrawn`;
        if (answer(store, project, topic, String(q.id), msg, "reality")) {
          const u = units().find((x) => num(x.pr) === n), slug = u ? String(u.slug) : "";
          if (slug) store.upsert("episodes", { project, subject: `${topic}/${slug}`, kind: "lifecycle:pr-question" }, { squad: topic, state: "withdrawn", observed_at: t });
          if (s.status === "waiting-on-you" && !pending(store, project, topic).length) store.setIf("squads", Number(s.id), "status", "running", "waiting-on-you");
          const bwt = u?.builder_wt ? String(u.builder_wt) : "";
          if (u && bwt && member(bwt) && !waitingForRuling(u)) out.push(...wake(ctx, bwt, `dev-studio loop: ${msg}. Fix the PR and stop at your prompt; the loop asks the operator again when only human gates remain.`, "pr-question", `${n}|${bad.join(",")}|withdrawn`).actions);
        }
        continue;
      }
      const msg = `PR #${n} went back to not ready (${bad.join(",")})`;
      if (answer(store, project, topic, String(q.id), msg, "reality")) {
        store.upsert("episodes", { project, subject: `${topic}/q:${q.id}`, kind: "lifecycle:qclose" }, { squad: topic, episode_key: msg, state: "pending", source: "loop", started_at: t, observed_at: t });
        if (s.status === "waiting-on-you" && !pending(store, project, topic).length) store.setIf("squads", Number(s.id), "status", "running", "waiting-on-you");
      }
    }
    for (const e of store.db.query("SELECT * FROM episodes WHERE project = ? AND squad = ? AND kind = 'lifecycle:qclose' AND state = 'pending' ORDER BY id").all(project, topic) as Row[]) {
      if (!lead) break;
      const id = String(e.subject).slice(topic.length + 3);
      const text = `dev-studio loop: your operator question "${id}" was closed: ${e.episode_key}. Send its Builder to fix the PR (it gets the pr-stale poke), then ask again once only human gates remain.`;
      const w = wake(ctx, lead, text, "question-closed", `${e.subject}|${e.episode_key}`);
      out.push(...w.actions);
      if (w.status === "sent") store.upsert("episodes", { project, subject: String(e.subject), kind: "lifecycle:qclose" }, { state: "sent", ended_at: t, observed_at: t });
    }

    // 1d leftovers (a closed squad's too: see the end of run())
    leftoverStep(ctx, s, nwo, out);

    // 10 all done, parked (only held work left), or a retest due (U238): one rule for the units (squad-finish.ts via retest.ts, the same as
    // wake.ts, the board and the Lead tick). A held unit is open work: a held-only squad is not all done.
    const us = units(), done = us.filter((u) => u.status === "done");
    const retest = retestDue(store.db, project, topic, t);
    const all = !retest && allDoneIn(store.db, project, topic, t);
    const at = s.all_done_at ?? null;
    if (all !== (at !== null)) fact(store, "squads", Number(s.id), "all_done_at", all ? t : null, at, "squad_all_done", { project, squad: topic, payload: { all_done: all } });
    // squad-done-definition U3: only held work is left (no retest due): one poke per held set, never a repeat.
    const parked = !all && !retest && s.status !== "done" ? settleIn(store.db, project, topic, t) : null;
    if (parked?.state !== "held-only" && ((!all && !retest) || s.status === "done")) continue;
    const quiet = Number(worker(lead)?.since ?? t);
    if (!lead || t - quiet < envOr(store, project, "DS_SWEEP_DONE_IDLE_MIN", "done_idle_min", 5) * 60) continue;
    if (retest) {
      const names = retest.units.map((x) => (x.pr ? `${x.slug} #${x.pr}` : x.slug)).join(", ");
      const text = `dev-studio loop: the fixes since the last test pass are all merged (${names}). Ask your Thinker for the retest scope, then \`ds request tester --suffix <scope> --spec …\`. The retest Tester starts from a new worktree on current main; its first step is to stop the squad's existing env with the registered stop command and bring up a fresh one, then report the new address and stop command, and you replace the old ones in the squad state (\`squad-state.sh <state> add-cleanup\`) so there is one env, never a stale one. If no retest is planned, wrap up as usual.`;
      out.push(...wake(ctx, lead, text, "retest-due", retest.key).actions);
      continue;
    }
    if (parked?.state === "held-only") {
      const held = [...parked.held].sort(), pep = `parked|${topic}|${held.join(",")}`;
      if (store.get("episodes", { project, subject: lead, kind: "wake:parked" })?.episode_key === pep) continue;
      const ptext = `dev-studio loop: only held work is left in your squad (${held.join(", ")}${parked.waiting.length ? `; waiting on them: ${[...parked.waiting].sort().join(", ")}` : ""}), so it is parked, not done. Ask the operator once, in one question for the whole set (ask-operator.sh): release them, cancel them, suspend the squad, or keep it parked (recommend keep parked; for release or cancel the operator names the units in the answer). On keep parked run \`ds pause squad ${project} ${topic} --by parked\`. Do not mark the squad done.`;
      out.push(...wake(ctx, lead, ptext, "parked", pep).actions);
      continue;
    }
    const ep = `done|${topic}|${done.map((u) => `${u.slug}#${u.pr}`).sort().join(",")}`;
    const text = `dev-studio loop: every unit of your squad is done (PR merged) or cancelled, and none is held. Do the testability handoff to your Thinker (skip it for docs-only or one-unit squads), check the Try it page is current, then set-status done and tell the operator to run /ds-close-squad ${topic}. Write no debrief now: the loop asks for it when the operator archives. The loop never closes a squad.`;
    out.push(...wake(ctx, lead, text, "all-done", ep).actions);
  }
  out.push(...updateQueue(store, project, t, updates, onTrack));
  // archive-leftovers U2: a closed squad's leftovers are checked too (only this step reads closed squads).
  for (const s of store.db.query("SELECT * FROM squads WHERE project = ? AND doc IS NOT NULL AND status = 'closed' AND doc LIKE '%\"leftovers\"%' ORDER BY topic").all(project) as Row[]) {
    const nwo = (store.get("config", { project, file: "github", key: `repo:${s.repo}` })?.value as string) || null;
    leftoverStep(ctx, s, nwo, out);
  }
  return out;
}

// U2: one update in flight per repo. The slot names the PR it holds; a PR still in line (its update not
// yet run, or behind again on a new head) keeps it, and so does one on its way to merge (checks running,
// ready) for DS_LOOP_UPDATE_HOLD_S after its last update; anything else frees it for the lowest PR number
// in line. The action is emitted every tick until the actuator has claimed it (it takes an episode once).
function updateQueue(store: Store, project: string, t: number, updates: Map<string, Updatable[]>, onTrack: Set<string>): Action[] {
  const out: Action[] = [], hold = envInt("DS_LOOP_UPDATE_HOLD_S", 3600);
  const slots = store.db.query("SELECT * FROM episodes WHERE project = ? AND kind = 'lifecycle:update-branch'").all(project) as Row[];
  for (const nwo of new Set([...updates.keys(), ...slots.map((r) => String(r.subject))])) {
    const key = { project, subject: nwo, kind: "lifecycle:update-branch" }, line = (updates.get(nwo) ?? []).sort((a, b) => a.n - b.n);
    const row = slots.find((r) => r.subject === nwo) ?? null;
    let slot = row?.state === "updating" ? row : null;
    const held = slot ? line.find((c) => c.ref === slot!.episode_key) : undefined;
    // A free slot keeps its row (state `free`, the last PR it held), so nothing is deleted.
    if (slot && !held && (!onTrack.has(String(slot.episode_key)) || t >= Number(slot.next_at ?? 0))) {
      store.upsert("episodes", key, { state: "free", observed_at: t, next_at: null, ended_at: t });
      slot = null;
    }
    const next = slot ? held : line[0];
    if (!next) continue;
    // A new head (the PR held, or the next in line) starts the hold clock again.
    if (!slot || slot.episode_key !== next.ref || slot.result !== next.head)
      store.upsert("episodes", key, { squad: next.topic, episode_key: next.ref, count: 1, state: "updating", result: next.head, source: "loop", started_at: t, observed_at: t, next_at: t + hold, ended_at: null });
    out.push({ project, squad: next.topic, ...(next.lead ? { member: next.lead } : {}), subject: next.ref, kind: "update-branch", episode: updateEp(next.ref, next.head),
      payload: { n: next.n, repo: nwo, ref: next.ref, head: next.head, unit: next.slug, topic: next.topic, base: next.base } });
  }
  return out;
}

export default { name: "lifecycle", run } satisfies Reconciler;
