// update-branch.test.ts — main-red-liveness-test U2: with auto_merge on, a unit PR that would be
// merge-ready but is only behind its base gets one `update-branch` action per head, one PR per repo at a
// time, lowest number first; a conflict or a failed update gets the Builder's "merge the base in" message.
// The reconciler cases run real ticks over a hermetic state root (the auto-merge.test.ts rig); the
// fulfiller cases drive bin/loop/fulfil/update-branch.ts with a stubbed `gh` (DS_GH), no network.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { Action, Actuator } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import lifecycle from "../../bin/loop/reconcilers/lifecycle.ts";
import updateBranch, { UPDATE_FAILED } from "../../bin/loop/fulfil/update-branch.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const T = 1_800_000_000;
const LEAD = "wt-lead::/ws/ds-lead-lc", B = "wt-b1::/ws/ds-builder-u1-lc", B2 = "wt-b2::/ws/ds-builder-u2-lc";
const NWO = "o/r";

const temps: string[] = [], stores: Store[] = [];
const saved = { DS_GH: process.env.DS_GH, DS_LOOP_MERGE_RETRY_S: process.env.DS_LOOP_MERGE_RETRY_S };
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

type Unit = Row & { slug: string };
// One squad, lc: a working Lead, an idle Builder per unit, auto_merge squash unless `off`.
function squad(units: Unit[], autoMerge = "squash"): { s: Store; root: string } {
  const root = mkdtempSync(join(tmpdir(), "zzupdate-")); temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, "fx", "squads", "demo.json"));
  rmSync(join(root, "fx", "sweep", "pr-health.json"));
  const builders = units.map((u) => String(u.builder_wt ?? B));
  const doc = {
    type: "feature", status: "running", repo: "path:/x/repo", lead_wt: LEAD,
    members: [{ role: "lead", suffix: "", wt: LEAD }, ...units.map((u, i) => ({ role: "builder", suffix: u.slug, wt: builders[i] }))],
    units: units.map((u) => ({ status: "dispatched", builder_wt: B, deps: [], hold: false, ...u })),
    leftovers: [],
  };
  writeFileSync(join(root, "fx", "squads", "lc.json"), JSON.stringify(doc, null, 2) + "\n");
  const s = open(root); stores.push(s);
  importJson(s);
  importConfig(s);
  s.upsert("config", { project: "fx", file: "github", key: "repo:path:/x/repo" }, { value: NWO, observed_at: T });
  s.upsert("config", { project: "fx", file: "github", key: `default_branch:${NWO}` }, { value: "main", observed_at: T });
  if (autoMerge !== "off") s.upsert("config", { project: "fx", file: "limits.conf", key: "auto_merge" }, { value: autoMerge, observed_at: T });
  units.forEach((u, i) => {
    const wt = builders[i], path = wt.split("::")[1];
    s.upsert("observed_worktrees", { project: "fx", wt }, { path, branch: `feat-${u.slug}`, observed_at: T });
    s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", since: null, observed_at: T });
  });
  s.upsert("observed_workers", { project: "fx", wt: LEAD }, { state: "working", since: null, observed_at: T });
  return { s, root };
}
// A PR that is ready but for being behind main (GitHub's BEHIND reads verdict blocked, reason behind).
function behind(s: Store, n: number, head: string, set: Row = {}) {
  s.upsert("observed_prs", { project: "fx", ref: `${NWO}#${n}` }, {
    pr: n, repo: NWO, head: `feat-${n}`, base: "main", state: "OPEN", mergeable: "MERGEABLE", verdict: "blocked",
    reasons: JSON.stringify("behind"), since: T, doc: JSON.stringify({ headRefOid: head }), observed_at: T, ...set,
  });
}
function loop(s: Store) {
  const act: Actuator = { act() { /* captured by the tick's acted list */ } };
  const l = new Loop(s, { observers: [], reconcilers: [lifecycle] }, act, { projects: () => ["fx"] });
  l.boot(T);
  return { tick: async (at: number) => (await l.tick(at)).acted };
}
const updates = (a: Action[]) => a.filter((x) => x.kind === "update-branch");
const builderPokes = (a: Action[], wt = B) => a.filter((x) => x.kind === "poke" && x.member === wt);
const pokeText = (a: Action) => String((a.payload as Row).text ?? "");
// The actuator's settle of a claimed update (the capture rig never runs it).
function settle(s: Store, n: number, state: string, result: string) {
  s.db.run("UPDATE episodes SET state = ?, result = ? WHERE project = 'fx' AND subject = ? AND kind = 'action:update-branch'", [state, result, `${NWO}#${n}`]);
}

describe("the loop updates a behind, otherwise ready unit PR", () => {
  test("one update action per head, and no Builder poke while the loop updates it", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), l = loop(s);
    behind(s, 7, "aaa");
    const got = await l.tick(T);
    expect(updates(got)).toHaveLength(1);
    expect(updates(got)[0]).toMatchObject({
      project: "fx", squad: "lc", member: LEAD, subject: `${NWO}#7`, kind: "update-branch", episode: `update-branch:${NWO}#7|aaa`,
      payload: { n: 7, repo: NWO, ref: `${NWO}#7`, head: "aaa", unit: "u1", topic: "lc", base: "main" },
    });
    expect(builderPokes(got)).toEqual([]);
    // Claimed: the same head is not updated again.
    expect(updates(await l.tick(T + 60))).toEqual([]);
    settle(s, 7, "done", "updated");
    // GitHub merged main in: a new head with checks running, then behind again (main moved on).
    behind(s, 7, "bbb", { verdict: "waiting", reasons: JSON.stringify("checks-running") });
    expect(updates(await l.tick(T + 120))).toEqual([]);
    behind(s, 7, "ccc", { since: T + 180 });
    const again = await l.tick(T + 180);
    expect(updates(again).map((a) => a.episode)).toEqual([`update-branch:${NWO}#7|ccc`]);
    expect(builderPokes(again)).toEqual([]);
  });

  test("two behind PRs in one repo: one update at a time, the lowest PR number first", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }, { slug: "u2", pr: "5", builder_wt: B2 }]), l = loop(s);
    behind(s, 7, "aaa");
    behind(s, 5, "xxx");
    expect(updates(await l.tick(T)).map((a) => a.subject)).toEqual([`${NWO}#5`]);
    settle(s, 5, "done", "updated");
    // #5's checks run again on its new head: it keeps the repo's slot, #7 waits.
    behind(s, 5, "yyy", { verdict: "waiting", reasons: JSON.stringify("checks-running") });
    expect(updates(await l.tick(T + 60))).toEqual([]);
    expect(updates(await l.tick(T + 120))).toEqual([]);
    // #5 merges: the slot goes to #7.
    behind(s, 5, "yyy", { state: "MERGED", verdict: "merged", reasons: JSON.stringify("") });
    expect(updates(await l.tick(T + 180)).map((a) => a.subject)).toEqual([`${NWO}#7`]);
    expect(s.get("episodes", { project: "fx", subject: NWO, kind: "lifecycle:update-branch" })).toMatchObject({ episode_key: `${NWO}#7`, result: "aaa" });
  });

  test("a PR on its way to merge holds the slot only DS_LOOP_UPDATE_HOLD_S after its update", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }, { slug: "u2", pr: "5", builder_wt: B2 }]), l = loop(s);
    behind(s, 7, "aaa");
    behind(s, 5, "xxx");
    expect(updates(await l.tick(T)).map((a) => a.subject)).toEqual([`${NWO}#5`]);
    settle(s, 5, "done", "updated");
    behind(s, 5, "yyy", { verdict: "waiting", reasons: JSON.stringify("checks-running") });
    expect(updates(await l.tick(T + 3599))).toEqual([]);
    expect(updates(await l.tick(T + 3600)).map((a) => a.subject)).toEqual([`${NWO}#7`]);
  });

  test("a conflicting PR gets no update, and its Builder gets the merge-the-base-in message", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), l = loop(s);
    behind(s, 7, "aaa", { mergeable: "CONFLICTING", reasons: JSON.stringify("conflicting") });
    const got = await l.tick(T);
    expect(updates(got)).toEqual([]);
    expect(builderPokes(got)).toHaveLength(1);
    expect(pokeText(builderPokes(got)[0])).toContain("merge the base in");
  });

  test("a behind PR with another blocking reason gets no update", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), l = loop(s);
    behind(s, 7, "aaa", { reasons: JSON.stringify("behind,checks-failing") });
    const got = await l.tick(T);
    expect(updates(got)).toEqual([]);
    expect(builderPokes(got)).toHaveLength(1);
  });

  test("auto_merge off: no update, the Builder is told as before", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }], "off"), l = loop(s);
    expect(s.get("config", { project: "", file: "limits.conf", key: "auto_merge" })?.value).toBe("off");
    behind(s, 7, "aaa");
    const got = await l.tick(T);
    expect(updates(got)).toEqual([]);
    expect(builderPokes(got)).toHaveLength(1);
    expect(pokeText(builderPokes(got)[0])).toContain("merge the base in");
    expect(s.get("episodes", { project: "fx", subject: NWO, kind: "lifecycle:update-branch" })).toBeNull();
  });

  test("a failed update falls back to the Builder's message and frees the slot", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }, { slug: "u2", pr: "9", builder_wt: B2 }]), l = loop(s);
    behind(s, 7, "aaa");
    behind(s, 9, "zzz");
    expect(updates(await l.tick(T)).map((a) => a.subject)).toEqual([`${NWO}#7`]);
    // The fulfiller's failure record for this head (what update-branch.ts writes on a conflict).
    settle(s, 7, "done", "failed: merge conflict");
    s.upsert("episodes", { project: "fx", subject: `${NWO}#7`, kind: UPDATE_FAILED }, { episode_key: "aaa", state: "failed", result: "merge conflict", count: 1, source: "loop", started_at: T, observed_at: T });
    const got = await l.tick(T + 60);
    expect(builderPokes(got)).toHaveLength(1);
    expect(pokeText(builderPokes(got)[0])).toContain("merge the base in");
    expect(updates(got).map((a) => a.subject)).toEqual([`${NWO}#9`]);
    // A dropped or failed claim of the head counts as failed too.
    const { s: s2 } = squad([{ slug: "u1", pr: "7" }]), l2 = loop(s2);
    behind(s2, 7, "aaa");
    expect(updates(await l2.tick(T))).toHaveLength(1);
    settle(s2, 7, "dropped", "stale");
    const got2 = await l2.tick(T + 60);
    expect(updates(got2)).toEqual([]);
    expect(builderPokes(got2)).toHaveLength(1);
  });

  test("after the loop updated the branch, the Builder's message says to pull first", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), l = loop(s);
    behind(s, 7, "aaa");
    expect(updates(await l.tick(T))).toHaveLength(1);
    settle(s, 7, "done", "updated");
    behind(s, 7, "bbb", { reasons: JSON.stringify("checks-failing"), since: T + 60 });
    const got = await l.tick(T + 60);
    expect(builderPokes(got)).toHaveLength(1);
    expect(pokeText(builderPokes(got)[0])).toContain("git pull --no-rebase before you push");
  });
});

// A `gh` that logs its argv and answers with `code`, `out` and `err`.
function fakeGh(root: string, code: number, out = "", err = "") {
  const bin = join(root, "gh");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${join(root, "gh.log")}"\nprintf '%s' '${out}'\nprintf '%s' '${err}' >&2\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  process.env.DS_GH = bin;
}
const action = (head = "aaa"): Action => ({
  project: "fx", squad: "lc", member: LEAD, subject: `${NWO}#7`, kind: "update-branch", episode: `update-branch:${NWO}#7|${head}`,
  payload: { n: 7, repo: NWO, ref: `${NWO}#7`, head, unit: "u1", topic: "lc", base: "main" },
});
const rig = (s: Store) => ({ store: s, now: T, act: { seat: () => ({}), driver: () => ({}) } }) as never;
const events = (s: Store, kind: string) => s.db.query("SELECT * FROM events WHERE kind = ?").all(kind) as Row[];

describe("fulfil/update-branch.ts", () => {
  test("runs gh pr update-branch (a merge, no --rebase) and records the update", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    behind(s, 7, "aaa");
    fakeGh(root, 0, "updated");
    expect(await updateBranch.exec!(action(), rig(s))).toEqual({ done: true, result: "updated" });
    expect(readFileSync(join(root, "gh.log"), "utf8").trim()).toBe(`pr update-branch 7 -R ${NWO}`);
    expect(events(s, "pr_branch_updated")).toHaveLength(1);
    expect(s.get("episodes", { project: "fx", subject: `${NWO}#7`, kind: UPDATE_FAILED })).toBeNull();
  });

  test("a conflict is not tried again: it records update-branch-failed for the head", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    behind(s, 7, "aaa");
    fakeGh(root, 1, "", "merge conflict between base and head");
    const r = await updateBranch.exec!(action(), rig(s)) as Row;
    expect(r.done).toBe(true);
    expect(String(r.result)).toStartWith("failed:");
    expect(s.get("episodes", { project: "fx", subject: `${NWO}#7`, kind: UPDATE_FAILED })).toMatchObject({ episode_key: "aaa", state: "failed" });
    expect(events(s, "pr_branch_update_failed")).toHaveLength(1);
  });

  test("a rate limit waits for GitHub's reset from the observer's budget", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    behind(s, 7, "aaa");
    s.upsert("observed_github", { repo: "" }, { cost: 10, remaining: 0, rate_limit: 5000, reset_at: T + 900, observed_at: T });
    fakeGh(root, 1, "", "GraphQL: API rate limit exceeded for user");
    const r = await updateBranch.exec!(action(), rig(s)) as Row;
    expect(r.wait).toBeDefined();
    expect(r.at).toBe(T + 930);
    expect(s.get("episodes", { project: "fx", subject: `${NWO}#7`, kind: UPDATE_FAILED })).toBeNull();
  });

  test("stale once the PR moved past the head or closed", () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    behind(s, 7, "aaa");
    expect(updateBranch.stale!(action("aaa"), rig(s))).toBe(false);
    expect(updateBranch.stale!(action("old"), rig(s))).toBe(true);
    behind(s, 7, "aaa", { state: "CLOSED" });
    expect(updateBranch.stale!(action("aaa"), rig(s))).toBe(true);
  });
});
