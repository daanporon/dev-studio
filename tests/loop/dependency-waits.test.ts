import { alias, apply, poll, targets, type Gh } from "../../bin/loop/observers/github.ts";
import { dependencyReasons, memberUnit } from "../../bin/loop/pause/pause-conditions.ts";
import pauseResume from "../../bin/loop/reconcilers/pause-resume.ts";
import { expect, test } from "bun:test";
import { fixture } from "./pause-fixture.ts";
import { open } from "../../bin/loop/core/store.ts";
import { projection, type Prerequisite } from "../../bin/loop/pause/pause.ts";
import dependencyWaits from "../../bin/loop/reconcilers/dependency-waits.ts";
import pauseLifecycle from "../../bin/loop/fulfil/pause.ts";
import member from "../../bin/loop/fulfil/member.ts";
import decider from "../../bin/loop/core/decide.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { open as question, answer } from "../../bin/loop/messages/questions.ts";

const refs: Prerequisite[] = [{ kind: "unit", project: "p", squad: "one", slug: "before" }, { kind: "pr", project: "p", ref: "repo/name#7" }];
function waitFixture() {
  const f = fixture();
  f.store.upsert("units", { project: "p", squad: "one", slug: "before" }, { status: "dispatched", updated_at: 1, observed_at: 1 });
  f.store.upsert("observed_prs", { project: "p", ref: "repo/name#7" }, { pr: 7, state: "OPEN", observed_at: 1 });
  return f;
}
test("dependency waits take no role turns across 100 ticks and a loop/store restart, then start once after all holds clear", async () => {
  const f = waitFixture();
  f.store.upsert("units", { project: "p", squad: "one", slug: "task" }, { hold: true });
  f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: refs });
  await f.tick(); f.checkpoint(); await f.tick();
  const calls = f.orca.calls.length;
  for (let n = 0; n < 100; n++) { dependencyWaits.run(f.ctx()); await f.tick(); }
  expect(f.orca.calls).toHaveLength(calls);
  expect(f.orca.of("pause-deliver")).toHaveLength(1);
  f.store.close(); const store = open(f.root);
  try {
    store.upsert("units", { project: "p", squad: "one", slug: "before" }, { status: "done" });
    store.upsert("observed_prs", { project: "p", ref: "repo/name#7" }, { state: "MERGED" });
    const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle, member], pick: async () => ({ agent: "claude", model: "opus", account: "a", effort: null }) });
    const tick = async () => {
      const c = { ...f.ctx(), store }; f.world.run(c); dependencyWaits.run(c); pauseResume.run(c);
      for (const a of pauseLifecycle.run(c) ?? []) await act.act(a, c);
      for (const a of decider.run(c) ?? []) await act.act(a, c); await act.drain();
    };
    await tick(); expect(projection(store, f.target).state).toBe("paused");
    expect(projection(store, f.target).sources).toMatchObject([{ remaining: ["unit hold: task"] }]);
    store.upsert("units", { project: "p", squad: "one", slug: "task" }, { hold: false });
    for (let n = 0; n < 3; n++) await tick();
    expect(f.orca.started).toHaveLength(1);
    expect(projection(store, f.target).state).toBe("active");
  } finally { store.close(); }
});

test("a prerequisite satisfied before checkpoint closure cancels the old close and keeps running work", async () => {
  const f = waitFixture(); f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: refs });
  await f.tick(); f.checkpoint();
  f.store.upsert("units", { project: "p", squad: "one", slug: "before" }, { status: "done" });
  f.store.upsert("observed_prs", { project: "p", ref: "repo/name#7" }, { state: "MERGED" });
  dependencyWaits.run(f.ctx()); await f.tick();
  expect(f.orca.of("pause-close")).toHaveLength(0);
  expect(f.orca.started).toHaveLength(0);
  expect(f.orca.agents).toHaveLength(1);
});

test.each(["member", "squad", "project"] as const)("dependency release preserves a manual %s pause", async (scope) => {
  const f = waitFixture(); f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: refs });
  f.store.pause({ scope, ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  f.store.upsert("units", { project: "p", squad: "one", slug: "before" }, { status: "done" });
  f.store.upsert("observed_prs", { project: "p", ref: "repo/name#7" }, { state: "MERGED" });
  dependencyWaits.run(f.ctx()); await f.tick();
  expect(projection(f.store, f.target).state).toBe("paused");
  expect(projection(f.store, f.target).sources).toMatchObject([{ source: "manual", scope }]);
  expect(f.orca.started).toHaveLength(0);
});

test("all prerequisites and the explicit blocking ruling must clear; already satisfied waits are unnecessary", () => {
  const f = waitFixture();
  f.store.upsert("units", { project: "p", squad: "one", slug: "before" }, { status: "done" });
  expect(() => f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: [refs[0]] })).toThrow("already satisfied");
  question(f.store, "p", "one", { id: "ruling", unit: "task", asker: "lead", blocking: true, question: "Approve work?" });
  f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: refs });
  dependencyWaits.run(f.ctx()); expect(projection(f.store, f.target).state).toBe("pausing");
  f.store.upsert("observed_prs", { project: "p", ref: "repo/name#7" }, { state: "MERGED" });
  dependencyWaits.run(f.ctx()); expect(projection(f.store, f.target).state).toBe("pausing");
  answer(f.store, "p", "one", "ruling", "approved", "terminal");
  dependencyWaits.run(f.ctx()); expect(projection(f.store, f.target).state).toBe("active");
});

test.each(["missing", "stale", "cancelled", "closed"])("%s prerequisites never cause speculative resume", (kind) => {
  const f = waitFixture(); f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: refs });
  f.store.upsert("observed_prs", { project: "p", ref: "repo/name#7" }, { state: "MERGED" });
  if (kind === "missing") f.store.db.run("DELETE FROM units WHERE slug = 'before'");
  else if (kind === "stale") { f.store.upsert("units", { project: "p", squad: "one", slug: "before" }, { status: "done" }); f.store.upsert("observed_prs", { project: "p", ref: "repo/name#7" }, { gone_at: 10 }); }
  else if (kind === "closed") { f.store.upsert("units", { project: "p", squad: "one", slug: "before" }, { status: "done" }); f.store.upsert("observed_prs", { project: "p", ref: "repo/name#7" }, { state: "CLOSED" }); }
  else f.store.upsert("units", { project: "p", squad: "one", slug: "before" }, { status: "cancelled" });
  dependencyWaits.run(f.ctx()); expect(projection(f.store, f.target).state).toBe("pausing");
});

test("a tracked prerequisite PR merge satisfies a unit even before unit completion reconciliation", () => {
  const f = waitFixture(); f.store.upsert("units", { project: "p", squad: "one", slug: "before" }, { pr: "8" });
  f.store.upsert("observed_prs", { project: "p", ref: "one/before" }, { pr: 8, state: "OPEN", observed_at: 1 });
  f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: [refs[0]] });
  f.store.upsert("observed_prs", { project: "p", ref: "one/before" }, { state: "MERGED" });
  dependencyWaits.run(f.ctx()); expect(projection(f.store, f.target).state).toBe("active");
});

// U119: dependency waits read the right facts.
const pr7 = { project: "p", ref: "repo/name#7" };
function prWait(row: Record<string, unknown>) {
  const f = waitFixture();
  f.store.upsert("observed_github", { repo: "repo/name" }, { ok_at: 1, observed_at: 1 });
  f.store.upsert("observed_prs", pr7, row);
  f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: [refs[1]] });
  return f;
}
test("a prerequisite PR the open page dropped is asked for how it ended, whichever unit owns it", () => {
  const f = prWait({ gone_at: 5 });
  const t = targets(f.store, 10, () => null);
  expect(t.lookup.has("p|repo/name#7")).toBe(true);
  expect(t.tracked.get("repo/name")).toEqual([7]);
  expect(t.repos.get("repo/name")?.has("p")).toBe(true);
  // The answer: a final MERGED row releases the wait with no unit owning the PR.
  f.store.upsert("observed_prs", pr7, { state: "MERGED", gone_at: null });
  dependencyWaits.run(f.ctx()); expect(projection(f.store, f.target).state).toBe("active");
});
test("a prerequisite PR already final, still listed open, or never read is not asked", () => {
  for (const row of [{ state: "CLOSED", gone_at: 5 }, { state: "MERGED", gone_at: 5 }, { state: "OPEN", gone_at: null }, { gone_at: 5, detail: "missing" }]) {
    expect(targets(prWait(row).store, 10, () => null).lookup.size).toBe(0);
  }
  const f = prWait({ gone_at: 5 }); f.store.upsert("observed_github", { repo: "repo/name" }, { ok_at: null });
  const t = targets(f.store, 10, () => null);
  expect(t.lookup.size).toBe(0); expect(t.repos.has("repo/name")).toBe(true);
});
test("a closed unmerged prerequisite stays unresolved", () => {
  const f = prWait({ state: "CLOSED", gone_at: null });
  dependencyWaits.run(f.ctx()); expect(projection(f.store, f.target).state).toBe("pausing");
});

for (const project of ["p", "pr-project"]) {
  test.each(["MERGED", "OPEN", "CLOSED"])(`a %s prerequisite stays observed without an open squad on its repo (${project})`, async (state) => {
    const f = waitFixture(), key = { project, ref: "repo/name#7" };
    f.store.upsert("projects", { label: project }, { observed_at: 1 });
    f.store.upsert("squads", { project, topic: "finished" }, { repo: "path:/pr-repo", status: "closed", updated_at: 1, observed_at: 1 });
    f.store.upsert("observed_github", { repo: "repo/name" }, { ok_at: 1, observed_at: 1 });
    f.store.upsert("observed_prs", key, { repo: "repo/name", pr: 7, state: "OPEN", gone_at: null, observed_at: 1 });
    f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: [{ kind: "pr", ...key }] });
    const queries: string[] = [];
    const gh: Gh = async (query) => {
      queries.push(query);
      const page = { pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } };
      const node = { number: 7, state, isDraft: false, mergedAt: state === "MERGED" ? "2026-11-06T00:00:00Z" : null };
      return { code: 0, stderr: "", stdout: JSON.stringify({ data: {
        [alias("waiting/repo")]: page,
        [alias("repo/name")]: { ...page, pullRequests: { ...page.pullRequests, nodes: state === "OPEN" ? [node] : [] },
          ...(query.includes("pr7:") ? { pr7: node } : {}) },
      } }) };
    };
    const resolve = () => ({ owner: "waiting", name: "repo" });
    const first = targets(f.store, 10, resolve);
    expect(first.repos.get("repo/name")?.has(project)).toBe(true);
    expect(first.lookup.size).toBe(0);
    await poll(gh, [...first.repos.keys()], first.tracked).then((p) => apply(f.store, first, p, 10));
    dependencyWaits.run(f.ctx());
    expect(projection(f.store, f.target).state).toBe("pausing");
    expect(f.store.get("observed_prs", key)?.gone_at).toBe(state === "OPEN" ? null : 10);

    const second = targets(f.store, 20, resolve);
    expect(second.tracked.get("repo/name") ?? []).toEqual(state === "OPEN" ? [] : [7]);
    await poll(gh, [...second.repos.keys()], second.tracked).then((p) => apply(f.store, second, p, 20));
    dependencyWaits.run(f.ctx());
    expect(f.store.get("observed_prs", key)?.state).toBe(state);
    expect(projection(f.store, f.target).state).toBe(state === "MERGED" ? "active" : "pausing");
    expect(queries).toHaveLength(2);
    expect(queries[0]).not.toContain("pr7:");
    if (state === "OPEN") {
      expect(targets(f.store, 30, resolve).repos.get("repo/name")?.has(project)).toBe(true);
      f.store.resume({ scope: "member", ...f.target });
    }
    expect(targets(f.store, 30, resolve).repos.has("repo/name")).toBe(false);
  });
}
test("a target with no worktree and an unmatched slug gets no unit, so no unrelated hold shows", () => {
  const f = waitFixture();
  f.store.upsert("units", { project: "p", squad: "one", slug: "other" }, { hold: true, builder_wt: "", updated_at: 1, observed_at: 1 });
  const t = { project: "p", squad: "one", role: "builder", suffix: "nomatch", member: "" };
  expect(memberUnit(f.store, t)).toBeNull();
  expect(dependencyReasons(f.store, t, [])).toEqual([]);
  expect(memberUnit(f.store, { ...t, suffix: "other" })?.slug).toBe("other");
});
test("a worktree matches its unit only when the target has one", () => {
  const f = waitFixture();
  f.store.upsert("units", { project: "p", squad: "one", slug: "mine" }, { builder_wt: "wt_x", updated_at: 1, observed_at: 1 });
  expect(memberUnit(f.store, { project: "p", squad: "one", role: "builder", suffix: "nomatch", member: "wt_x" })?.slug).toBe("mine");
});
