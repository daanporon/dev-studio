// observer-github.test.ts — U5: the GitHub PR observer against bin/loop/fakes/github.ts, which answers
// from tests/fixtures/loop/prs.json (PRs in the shape of tests/fixtures/pr-health/*.json). Every test
// works on a copy of tests/fixtures/loop/state in a temp dir; nothing calls GitHub.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { DIRS, load, type Observer, type TickCtx } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { listNotes, noteLine } from "../../bin/loop/feedback/notes.ts";
import { repoOf } from "../../bin/loop/settings/projects.ts";
import * as timers from "../../bin/loop/core/timers.ts";
import { since } from "../../bin/loop/core/events.ts";
import { fakeGithub, fromFixture, loadPrs, type FakeGithub } from "../../bin/loop/fakes/github.ts";
import { buildQuery, carrySince, expectedChecks, FULL_PER_POST, githubObserver, prHealth, problemKey, MAX_INTERVAL_S, MERGE_BACKFILL_S, poll, type Gh } from "../../bin/loop/observers/github.ts";
import { prHealthLine } from "../../bin/lib/lib.ts";
import type { RestLimit } from "../../bin/loop/io/github-budget.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const PR_HEALTH = join(ROOT, "tests", "fixtures", "pr-health");
const T = 1_800_000_000;
const APP = { owner: "acme", name: "app" };

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed by the test */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.DS_LIMIT_PR_STALE_MIN;
  delete process.env.DS_LIMIT_GITHUB_BUDGET_SHARE;
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(d); return d; }

// The fixture state, imported, with a third unit whose PR is a URL into a second repo (acme/lib).
function imported(): Store {
  const root = tmp();
  cpSync(FIXTURE, root, { recursive: true });
  const s = open(root);
  stores.push(s);
  importJson(s);
  s.upsert("units", { project: "fx", squad: "demo", slug: "u9-lib" }, { ord: 9, status: "dispatched", pr: "https://github.com/acme/lib/pull/7", observed_at: T, updated_at: T });
  return s;
}
function fake(): FakeGithub { return fakeGithub(loadPrs(join(ROOT, "tests", "fixtures", "loop", "prs.json"))); }
function observer(gh: Gh, budgetMs = 1000): Observer { return githubObserver({ gh, resolve: () => APP, budgetMs }); }
const ctx = (s: Store, at: number, fired: string[] = []): TickCtx =>
  ({ store: s, project: "", tick: 1, now: at, fired: fired.map((key) => ({ key, due_at: at, payload: null })), poked: new Set() });
const pr = (s: Store, ref: string, project = "fx") => s.get("observed_prs", { project, ref }) as Row;
const sched = (s: Store) => s.get("observed_github", { repo: "" }) as Row;
const reasons = (r: Row) => JSON.parse(String(r.reasons));
const iso = (sec: number) => new Date(sec * 1000).toISOString();

describe("required:<context>, a check the base requires that nothing posted", () => {
  const load = (f: string) => JSON.parse(readFileSync(join(PR_HEALTH, f), "utf8")).data.repository.pullRequest;
  test("it waits, is no part of a problem's identity, and a wait on it alone restarts since", () => {
    const h = prHealth(load("required-missing.json"))!;
    expect(h).toMatchObject({ verdict: "waiting", reasons: ["required:manual-gate"] });
    expect(problemKey(["required:manual-gate", "threads:1"])).toBe("threads");
    expect(carrySince(h, { since: 100, verdict: "waiting" }, 500)).toBe(500);
    const running = { verdict: "waiting" as const, reasons: ["checks-running", "required:manual-gate"], ci: "pending" as const };
    expect(carrySince(running, { since: 100, verdict: "waiting" }, 500)).toBe(100);
  });

  test("U178: a red stretch keeps since across reshuffled reasons; ready, required-only and a merge start over", () => {
    const blocked = (reasons: string[]) => ({ verdict: "blocked" as const, reasons, ci: "red" as const });
    let row: Row | null = null;
    const read = (h: ReturnType<typeof blocked> | NonNullable<ReturnType<typeof prHealth>>, at: number) => {
      const since = carrySince(h, row, at);
      row = { since, verdict: h.verdict, problem: h.verdict === "blocked" ? problemKey(h.reasons) : null };
      return since;
    };
    expect(read(blocked(["conflicting", "checks-failing"]), 100)).toBe(100);
    expect(read(blocked(["checks-failing"]), 200)).toBe(100);
    expect(read(blocked(["conflicting", "checks-failing"]), 300)).toBe(100);
    expect(read({ verdict: "waiting", reasons: ["checks-running"], ci: "pending" }, 400)).toBe(100);
    expect(read(blocked(["threads:1"]), 500)).toBe(100);
    expect(read({ verdict: "ready", reasons: [], ci: "green" }, 600)).toBe(600);
    expect(read(blocked(["checks-failing"]), 700)).toBe(700);
    expect(read({ verdict: "waiting", reasons: ["required:ship"], ci: "green" }, 800)).toBe(800);
    expect(read(blocked(["checks-failing"]), 900)).toBe(800);
    expect(read({ verdict: "merged", reasons: [], ci: "green" }, 1000)).toBe(1000);
    expect(read({ verdict: "merged", reasons: [], ci: "green" }, 1100)).toBe(1000);
  });

  test("a unit PR asks for the base's rules and the posted names; the open page does not", () => {
    const q = buildQuery([{ nwo: "acme/app", tracked: [7] }]);
    for (const part of ["baseRef { rules(first: 50)", "refUpdateRule { requiredStatusCheckContexts }", "... on CheckRun { name ", "... on StatusContext { context "]) expect(q).toContain(part);
    expect(buildQuery([{ nwo: "acme/app", page: null }])).not.toContain("baseRef {");
  });

  test("an observed unit PR carries the reason from the fake's full node", async () => {
    const s = imported(), gh = fake();
    gh.repos.get("acme/lib")!.prs.set(7, fromFixture("required-missing", { number: 7 }));
    await observer(gh.run).run(ctx(s, T));
    expect(pr(s, "acme/lib#7")).toMatchObject({ verdict: "waiting", problem: null });
    expect(String(reasons(pr(s, "acme/lib#7")))).toBe("required:manual-gate");
  });
});

describe("pr_health parity", () => {
  // prHealthLine (bin/lib/lib.ts: finish-unit's read) over each fixture through a stub gh, against the observer.
  test("every pr-health fixture judges the same in finish-unit's read and in the observer, with and without expected checks", async () => {
    const dir = tmp(), stub = join(dir, "gh");
    writeFileSync(stub, "#!/usr/bin/env bash\ncat \"$FIXTURE_FILE\"\n", { mode: 0o755 });
    const files = readdirSync(PR_HEALTH).filter((f) => f.endsWith(".json")).sort();
    expect(files.length).toBeGreaterThan(0);
    const keep = { DS_GH: process.env.DS_GH, GH: process.env.GH, FIXTURE_FILE: process.env.FIXTURE_FILE, DS_LIMIT_EXPECTED_CHECKS: process.env.DS_LIMIT_EXPECTED_CHECKS };
    try {
      delete process.env.GH; process.env.DS_GH = stub;
      for (const f of files) for (const expected of [[], ["tests"], ["tests", "Unit Tests", "manual-gate"]]) {
        // Through the env var, because `limits.sh` refuses a name with a space.
        process.env.FIXTURE_FILE = join(PR_HEALTH, f); process.env.DS_LIMIT_EXPECTED_CHECKS = expected.join(",");
        const line = (await prHealthLine("acme/app", "7", expected.length ? "fx" : "")).line;
        const h = prHealth(JSON.parse(readFileSync(join(PR_HEALTH, f), "utf8")).data.repository.pullRequest, expected);
        expect(`${f} ${expected} ${h ? `${h.verdict}\t${h.reasons.join(",")}` : "unknown\t"}`).toBe(`${f} ${expected} ${line}`);
      }
    } finally {
      for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }, 30_000);
});

describe("expected checks", () => {
  const node = (f: string) => JSON.parse(readFileSync(join(PR_HEALTH, `${f}.json`), "utf8")).data.repository.pullRequest;
  const read = (f: string, exp: string[] = ["tests"]) => { const h = prHealth(node(f), exp)!; return `${h.verdict}\t${h.reasons.join(",")}\t${h.ci}`; };

  test("absent or only skipped waits on required:<context>; pending and failing keep their reasons; green is ready", () => {
    expect(read("zero-checks")).toBe("waiting\trequired:tests\tpending");
    expect(read("expected-other-only")).toBe("waiting\trequired:tests\tpending");
    expect(read("expected-skipped")).toBe("waiting\trequired:tests\tpending");
    expect(read("expected-neutral")).toBe("waiting\trequired:tests\tpending");
    expect(read("expected-pending")).toBe("waiting\tchecks-running\tpending");
    expect(read("expected-failing")).toBe("blocked\tchecks-failing\tred");
    expect(read("expected-pending-other-required")).toBe("waiting\tchecks-running\tpending");
    expect(read("expected-failing-other-required")).toBe("blocked\tchecks-failing\tred");
    expect(read("expected-green")).toBe("ready\t\tgreen");
    expect(read("expected-status-green")).toBe("ready\t\tgreen");
    expect(read("expected-skip-and-green")).toBe("ready\t\tgreen");
    expect(read("expected-cancelled-then-green")).toBe("ready\t\tgreen");
    expect(read("expected-green-then-failing")).toBe("blocked\tchecks-failing\tred");
    expect(read("expected-failing-then-pending")).toBe("waiting\tchecks-running\tpending");
    expect(read("expected-failing-then-skipped")).toBe("blocked\tchecks-failing\tred");
    expect(read("zero-checks", ["tests", "lint"])).toBe("waiting\trequired:lint,required:tests\tpending");
    expect(read("required-missing")).toBe("waiting\trequired:manual-gate,required:tests\tpending");
  });

  test("no setting changes nothing, and a light node is not judged", () => {
    for (const f of ["zero-checks", "expected-skipped", "expected-other-only"]) expect(prHealth(node(f))).toMatchObject({ verdict: "ready", reasons: [], ci: "green" });
    expect(prHealth(node("expected-cancelled-then-green"))).toMatchObject({ verdict: "blocked", reasons: ["checks-failing"] });
    expect(prHealth({ number: 1, state: "OPEN", statusCheckRollup: { state: "SUCCESS" } }, ["tests"])).toMatchObject({ verdict: "ready", reasons: [] });
  });

  test("the observer reads the project's limit: a unit PR waits, another project's does not", async () => {
    const s = imported(), gh = fake();
    gh.repos.get("acme/lib")!.prs.set(7, fromFixture("zero-checks", { number: 7 }));
    await observer(gh.run).run(ctx(s, T));
    expect(pr(s, "acme/lib#7")).toMatchObject({ verdict: "ready", merge_blocked: 0 });
    s.upsert("config", { project: "other", file: "limits.conf", key: "expected_checks" }, { value: "tests", observed_at: T });
    await observer(gh.run).run(ctx(s, T + 400, ["prs:refresh"]));
    expect(pr(s, "acme/lib#7")).toMatchObject({ verdict: "ready" });
    s.upsert("config", { project: "", file: "limits.conf", key: "expected_checks" }, { value: "-", observed_at: T });
    s.upsert("config", { project: "fx", file: "limits.conf", key: "expected_checks" }, { value: "tests", observed_at: T });
    await observer(gh.run).run(ctx(s, T + 800, ["prs:refresh"]));
    expect(pr(s, "acme/lib#7")).toMatchObject({ verdict: "waiting", ci: "pending", merge_blocked: 0 });
    expect(reasons(pr(s, "acme/lib#7"))).toBe("required:tests");
    expect(expectedChecks(s, "fx")).toEqual(["tests"]);
    expect(expectedChecks(s, "nope")).toEqual([]);
  });
});

describe("the github observer", () => {
  test("one request per poll covers every repo; rows carry the pr_health derivations", async () => {
    const s = imported(), gh = fake();
    await observer(gh.run).run(ctx(s, T));
    expect(gh.calls).toHaveLength(1);
    expect(gh.calls[0]).toContain('repository(owner: "acme", name: "app")');
    expect(gh.calls[0]).toContain('repository(owner: "acme", name: "lib")');
    // Unit PRs in full (mergeability, required checks); the rest of the open page light.
    for (const [ref, fx] of [["acme/app#93", "threads"], ["acme/lib#7", "failing-check"]] as const) {
      const r = pr(s, ref), h = prHealth(JSON.parse(readFileSync(join(PR_HEALTH, `${fx}.json`), "utf8")).data.repository.pullRequest)!;
      expect([r.detail, r.verdict, reasons(r)]).toEqual(["full", h.verdict, h.reasons.join(",")]);
    }
    expect(pr(s, "acme/app#93")).toMatchObject({ unit: "demo/u2-sqlite-store-migrations-and", repo: "acme/app", pr: 93, threads: 2, problem: "threads", merge_blocked: 1, stale: 1, since: T });
    expect(pr(s, "acme/lib#7")).toMatchObject({ unit: "demo/u9-lib", ci: "red", mergeable: "MERGEABLE" });
    expect(pr(s, "acme/app#101")).toMatchObject({ detail: "light", verdict: "ready", ci: "green", review: "approved", mergeable: null, unit: null });
    expect(pr(s, "acme/app#103")).toMatchObject({ verdict: "waiting", ci: "pending", merge_blocked: 0 });
    expect(pr(s, "acme/app#104")).toMatchObject({ verdict: "blocked", problem: "draft", draft: 1 });
    // A merged unit PR is asked by number: its row keeps the merge.
    expect(pr(s, "acme/app#92")).toMatchObject({ state: "MERGED", verdict: "merged", merged_at: Date.parse("2026-10-30T10:00:00Z") / 1000, unit: expect.stringMatching(/^demo\/u1-/) });
    expect(s.get("observed_github", { repo: "acme/app" })).toMatchObject({ default_branch: "main", open_count: 5, ok_at: T, error: null });
    expect(s.get("config", { project: "fx", file: "github", key: "default_branch:acme/lib" })?.value).toBe("trunk");
    expect(sched(s)).toMatchObject({ next_at: T + 30, interval_s: 30, posts: 1, cost: 1, remaining: 4999 });
  });

  test("asks again every 30 s, or at once when prs:refresh fires; a merge is not asked again", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run);
    await o.run(ctx(s, T));
    await o.run(ctx(s, T + 5));
    expect(gh.calls).toHaveLength(1);
    await o.run(ctx(s, T + 10, ["prs:refresh"]));
    expect(gh.calls).toHaveLength(2);
    await o.run(ctx(s, T + 39));
    expect(gh.calls).toHaveLength(2);
    await o.run(ctx(s, T + 40));
    expect(gh.calls).toHaveLength(3);
    expect(gh.calls[2]).not.toContain("pr92:");
    expect(gh.calls[2]).toContain("pr93:");
  });

  test("a done unit's PR that nothing watches and no row records is looked up once, then never again (U58)", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run), app = gh.repos.get("acme/app")!.prs;
    // Done units whose Builder is gone: 90 merged before the loop saw it, 89 GitHub cannot resolve,
    // 101 still open, 88 was seen open once and left the open page closed.
    app.set(90, { ...structuredClone(app.get(92)!), number: 90, url: "https://github.com/acme/app/pull/90" });
    app.set(88, { ...structuredClone(app.get(92)!), number: 88, state: "CLOSED", mergedAt: null });
    for (const [i, slug, n] of [[20, "u20-old", 90], [21, "u21-lost", 89], [22, "u22-open", 101], [23, "u23-left", 88]] as const)
      s.upsert("units", { project: "fx", squad: "demo", slug }, { ord: i, status: "done", pr: String(n), builder_wt: "", observed_at: T, updated_at: T });
    s.upsert("observed_prs", { project: "fx", ref: "acme/app#88" }, { pr: 88, repo: "acme/app", state: "OPEN", gone_at: T - 60, observed_at: T - 60 });
    // The first poll reads the open page only: 101 gets its row there.
    await o.run(ctx(s, T));
    for (const n of [90, 89, 88, 101]) expect(gh.calls[0]).not.toContain(`pr${n}:`);
    expect(pr(s, "acme/app#101")).toMatchObject({ state: "OPEN", detail: "light", gone_at: null });
    await o.run(ctx(s, T + 30));
    for (const n of [90, 89, 88]) expect(gh.calls[1]).toContain(`pr${n}: pullRequest(number: ${n})`);
    expect(gh.calls[1]).not.toContain("pr101:");
    expect(pr(s, "acme/app#90")).toMatchObject({ state: "MERGED", verdict: "merged", unit: "demo/u20-old", gone_at: null });
    expect(pr(s, "acme/app#88")).toMatchObject({ state: "CLOSED", verdict: "closed", unit: "demo/u23-left" });
    expect(pr(s, "acme/app#89")).toMatchObject({ detail: "missing", gone_at: T + 30, unit: "demo/u21-lost", state: null });
    await o.run(ctx(s, T + 60));
    expect(gh.calls).toHaveLength(3);
    for (const n of [90, 89, 88, 101]) expect(gh.calls[2]).not.toContain(`pr${n}:`);
  });

  test("a looked-up PR: gone-open and unresolvable becomes missing; a failing read raises no alert; a repo only it names gets polled (U58)", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run);
    s.upsert("units", { project: "fx", squad: "demo", slug: "u30-gone" }, { ord: 30, status: "done", pr: "87", builder_wt: "", observed_at: T, updated_at: T });
    s.upsert("units", { project: "fx", squad: "demo", slug: "u31-err" }, { ord: 31, status: "done", pr: "86", builder_wt: "", observed_at: T, updated_at: T });
    s.upsert("units", { project: "fx", squad: "demo", slug: "u32-other" }, { ord: 32, status: "done", pr: "https://github.com/acme/other/pull/5", builder_wt: "", observed_at: T, updated_at: T });
    s.upsert("observed_prs", { project: "fx", ref: "acme/app#87" }, { pr: 87, repo: "acme/app", state: "OPEN", gone_at: T - 60, observed_at: T - 60 });
    gh.repos.set("acme/other", { defaultBranch: "main", prs: new Map([[5, { ...structuredClone(gh.repos.get("acme/app")!.prs.get(92)!), number: 5 }]]) });
    gh.failing.add(86);
    await o.run(ctx(s, T));
    expect(gh.calls[0]).toContain('repository(owner: "acme", name: "other")');
    expect(gh.calls[0]).not.toContain("pr5:");
    await o.run(ctx(s, T + 30));
    expect(pr(s, "acme/app#87")).toMatchObject({ detail: "missing", gone_at: T + 30, state: "OPEN" });
    expect(pr(s, "acme/other#5")).toMatchObject({ state: "MERGED", unit: "demo/u32-other" });
    expect(pr(s, "acme/app#86")).toBeNull();
    expect(s.db.query("SELECT COUNT(*) AS n FROM episodes WHERE kind = 'pr-read-failing'").get()).toEqual({ n: 0 });
    // An episode opened while the unit was watched ends once the unit is only looked up.
    s.upsert("episodes", { project: "fx", subject: "acme/app#86", kind: "pr-read-failing" }, { squad: "demo", started_at: T - 600, ended_at: null, state: "failing", result: "boom", source: "loop", observed_at: T - 600 });
    // A failing lookup is asked again; the settled ones are not.
    await o.run(ctx(s, T + 60));
    expect(gh.calls[2]).toContain("pr86:");
    for (const n of [87, 5]) expect(gh.calls[2]).not.toContain(`pr${n}:`);
    expect(s.get("episodes", { project: "fx", subject: "acme/app#86", kind: "pr-read-failing" })).toMatchObject({ state: "closed", ended_at: T + 60 });
  });

  test("a rate limit doubles the interval up to five minutes, keeps every row, and the next answer resets it", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run);
    await o.run(ctx(s, T));
    const before = s.db.query("SELECT ref, verdict FROM observed_prs WHERE repo IS NOT NULL ORDER BY ref").all();
    gh.rateLimit = 5;
    let at = T + 30;
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      await o.run(ctx(s, at));
      seen.push(Number(sched(s).interval_s));
      at = Number(sched(s).next_at);
    }
    expect(seen).toEqual([60, 120, 240, MAX_INTERVAL_S, MAX_INTERVAL_S]);
    expect(gh.calls).toHaveLength(6);
    expect(s.db.query("SELECT ref, verdict FROM observed_prs WHERE repo IS NOT NULL ORDER BY ref").all()).toEqual(before);
    expect(since(s, 0, { kinds: ["github_rate_limited"] })).toHaveLength(5);
    await o.run(ctx(s, at));
    expect(sched(s)).toMatchObject({ interval_s: 30, next_at: at + 30, error: null });
  });

  test("U286: the next read is paced to github_budget_share of the hour's budget, which the row keeps", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run);
    gh.budget = { limit: 5000, cost: 100, remaining: 4000, resetAt: iso(T + 3000) };
    await o.run(ctx(s, T));
    // 100 x 3600 / (0.5 x 5000) = 144 s
    expect(sched(s)).toMatchObject({ interval_s: 144, next_at: T + 144, cost: 100, remaining: 4000, rate_limit: 5000, reset_at: T + 3000 });
    await o.run(ctx(s, T + 143));
    expect(gh.calls).toHaveLength(1);
    await o.run(ctx(s, T + 60, ["prs:refresh"]));   // a refresh reads at once while there is budget
    expect(gh.calls).toHaveLength(2);
    // The budget is the one gh user's: the smallest share any project sets wins, the env var over all.
    s.upsert("config", { project: "fx", file: "limits.conf", key: "github_budget_share" }, { value: "0.25", observed_at: T });
    await o.run(ctx(s, T + 300));
    expect(sched(s)).toMatchObject({ interval_s: 288, next_at: T + 588 });
    process.env.DS_LIMIT_GITHUB_BUDGET_SHARE = "1";
    await o.run(ctx(s, T + 600));
    expect(sched(s)).toMatchObject({ interval_s: 72, next_at: T + 672 });
    gh.budget = { ...gh.budget, cost: 1 };   // a cheap read never asks more often than DS_LOOP_GITHUB_S
    await o.run(ctx(s, T + 700));
    expect(sched(s)).toMatchObject({ interval_s: 30, next_at: T + 730 });
  });

  test("U286: with fewer than two reads' cost left the next read waits for the reset; a refresh does not read", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run);
    gh.budget = { limit: 5000, cost: 100, remaining: 150, resetAt: iso(T + 1000) };
    await o.run(ctx(s, T));
    expect(sched(s)).toMatchObject({ next_at: T + 1030, remaining: 150, reset_at: T + 1000 });
    await o.run(ctx(s, T + 10, ["prs:refresh"]));
    await o.run(ctx(s, T + 1029));
    expect(gh.calls).toHaveLength(1);
    gh.budget = { limit: 5000, cost: 100, remaining: 4900, resetAt: iso(T + 4600) };
    await o.run(ctx(s, T + 1030));
    expect(gh.calls).toHaveLength(2);
    expect(sched(s)).toMatchObject({ next_at: T + 1030 + 144, remaining: 4900 });
  });

  test("U286: a refusal leaves no budget; an empty GraphQL bucket waits for its reset, a secondary limit backs off", async () => {
    const s = imported(), gh = fake(), rest: { r: RestLimit | null } = { r: { limit: 5000, remaining: 0, reset: T + 900 } };
    const o = githubObserver({ gh: gh.run, resolve: () => APP, budgetMs: 1000, rest: async () => rest.r });
    await o.run(ctx(s, T));
    gh.rateLimit = 1;
    await o.run(ctx(s, T + 30));
    expect(sched(s)).toMatchObject({ remaining: 0, reset_at: T + 900, next_at: T + 930, error: expect.stringContaining("rate limit") });
    await o.run(ctx(s, T + 60, ["prs:refresh"]));
    await o.run(ctx(s, T + 929));
    expect(gh.calls).toHaveLength(2);
    await o.run(ctx(s, T + 930));
    expect(gh.calls).toHaveLength(3);
    expect(sched(s)).toMatchObject({ error: null, remaining: 4999 });
    // GraphQL refuses with points left in the bucket (a secondary limit): the backoff, and its end stands in for the reset.
    rest.r = { limit: 5000, remaining: 4000, reset: T + 4000 };
    gh.rateLimit = 1;
    const at = Number(sched(s).next_at);
    await o.run(ctx(s, at));
    expect(sched(s)).toMatchObject({ remaining: 0, interval_s: 60, reset_at: at + 60, next_at: at + 60 });
  });

  test("a partial error still writes the repos that answered; the other keeps its rows", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run);
    await o.run(ctx(s, T));
    gh.broken.add("acme/lib");
    gh.repos.get("acme/app")!.prs.get(101)!.isDraft = true;
    await o.run(ctx(s, T + 30));
    expect(pr(s, "acme/app#101")).toMatchObject({ verdict: "blocked", observed_at: T + 30 });
    expect(pr(s, "acme/lib#7")).toMatchObject({ verdict: "blocked", observed_at: T, gone_at: null });
    expect(s.get("observed_github", { repo: "acme/lib" })).toMatchObject({ ok_at: T, error: expect.stringContaining("acme/lib") });
    expect(sched(s)).toMatchObject({ interval_s: 30, error: null });
  });

  test("a PR that leaves the query is gone, comes back when it returns; an unresolvable unit PR is gone too", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run), app = gh.repos.get("acme/app")!.prs;
    await o.run(ctx(s, T));
    const p101 = app.get(101)!;
    app.delete(101);
    app.delete(93);
    await o.run(ctx(s, T + 30));
    expect(pr(s, "acme/app#101").gone_at).toBe(T + 30);
    expect(pr(s, "acme/app#93").gone_at).toBe(T + 30);
    expect(pr(s, "acme/app#102").gone_at).toBeNull();
    // A unit PR whose alias fails for another reason is not gone.
    gh.failing.add(7);
    gh.repos.get("acme/lib")!.prs.delete(7);
    app.set(101, p101);
    await o.run(ctx(s, T + 60));
    expect(pr(s, "acme/app#101")).toMatchObject({ gone_at: null, verdict: "ready" });
    expect(pr(s, "acme/lib#7")).toMatchObject({ gone_at: null, observed_at: T + 30 });
  });

  test("a unit PR's node with an error on its path keeps its row and is marked failed, though the open page lists it", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run);
    await o.run(ctx(s, T));
    const before = pr(s, "acme/app#93");
    expect(before.detail).toBe("full");
    gh.partial.add(93);
    await o.run(ctx(s, T + 30));
    expect(pr(s, "acme/app#93")).toEqual(before);
    // A nested NOT_FOUND is a partial node too: the PR is there, so it is not gone.
    gh.partialError = "NOT_FOUND";
    await o.run(ctx(s, T + 60));
    expect(pr(s, "acme/app#93")).toEqual(before);
    gh.partial.clear();
    await o.run(ctx(s, T + 90));
    expect(pr(s, "acme/app#93")).toMatchObject({ detail: "full", observed_at: T + 90, gone_at: null });
    // NOT_FOUND on the PR itself still reads as gone.
    gh.repos.get("acme/app")!.prs.delete(93);
    await o.run(ctx(s, T + 120));
    expect(pr(s, "acme/app#93").gone_at).toBe(T + 120);
  });

  test("poll marks only the PR with the error failed", async () => {
    const gh = fake();
    gh.partial.add(93);
    const p = await poll(gh.run, ["acme/app"], new Map([["acme/app", [93, 102]]]));
    const r = p.repos.get("acme/app")!;
    expect([...r.failed]).toEqual([[93, "Something went wrong while executing your query."]]);
    expect(r.tracked.has(93)).toBe(false);
    expect(r.tracked.get(102)).toBeTruthy();
  });

  describe("a lasting read error", () => {
    const REF = "acme/app#93";
    const alerts = (s: Store, project = "fx"): Row[] => {
      const f = join(s.root, project, "alerts.json");
      return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).alerts.filter((x: Row) => String(x.id).startsWith("loop-")) : [];
    };
    const episode = (s: Store, project = "fx", subject = REF) => s.get("episodes", { project, subject, kind: "pr-read-failing" }) as Row;

    test("no alert before 600 s, exactly one after however many polls; a good read clears it and a new failure alerts anew; the row never moves", async () => {
      const s = imported(), gh = fake(), o = observer(gh.run);
      await o.run(ctx(s, T));
      const before = pr(s, REF);
      expect(episode(s)).toBeNull();
      gh.partial.add(93);
      const F = T + 30;
      await o.run(ctx(s, F));
      expect(episode(s)).toMatchObject({ squad: "demo", started_at: F, ended_at: null, state: "failing", result: "Something went wrong while executing your query.", source: "loop" });
      for (const at of [F + 30, F + 300, F + 599]) {
        await o.run(ctx(s, at));
        expect(alerts(s)).toEqual([]);
        expect(pr(s, REF)).toEqual(before);
      }
      await o.run(ctx(s, F + 600, ["prs:refresh"]));
      expect(alerts(s)).toHaveLength(1);
      const first = alerts(s)[0];
      expect(first).toMatchObject({ title: "PR read failing" });
      for (const part of [REF, "demo/u2-sqlite-store-migrations-and", "10 minutes", "Something went wrong"]) expect(String(first.question)).toContain(part);
      for (let i = 1; i <= 5; i++) {
        await o.run(ctx(s, F + 600 + i * 30));
        expect(alerts(s)).toEqual([first]);
        expect(pr(s, REF)).toEqual(before);
      }
      expect(episode(s)).toMatchObject({ started_at: F, state: "alerted" });

      gh.partial.clear();
      const good = F + 1000;
      await o.run(ctx(s, good));
      expect(alerts(s)).toEqual([]);
      expect(episode(s)).toMatchObject({ state: "closed", ended_at: good });
      const after = pr(s, REF);
      expect(after).toMatchObject({ detail: "full", observed_at: good });

      gh.partial.add(93);
      const G = good + 30;
      await o.run(ctx(s, G));
      expect(episode(s)).toMatchObject({ started_at: G, ended_at: null, state: "failing" });
      await o.run(ctx(s, G + 599));
      expect(alerts(s)).toEqual([]);
      await o.run(ctx(s, G + 600, ["prs:refresh"]));
      expect(alerts(s)).toHaveLength(1);
      expect(alerts(s)[0].id).not.toBe(first.id);
      expect(pr(s, REF)).toEqual(after);
      expect(since(s, 0, { kinds: ["pr_read_failing"] })).toHaveLength(2);
      expect(since(s, 0, { kinds: ["pr_read_alerted"] })).toHaveLength(2);
      expect(since(s, 0, { kinds: ["pr_read_recovered"] })).toHaveLength(1);
    });

    test("a failure short of 600 s that recovers raises nothing, and the next one counts from its own start", async () => {
      const s = imported(), gh = fake(), o = observer(gh.run);
      gh.failing.add(93);
      await o.run(ctx(s, T));
      await o.run(ctx(s, T + 500));
      gh.failing.clear();
      await o.run(ctx(s, T + 530));
      expect(episode(s)).toMatchObject({ state: "closed", ended_at: T + 530 });
      gh.failing.add(93);
      await o.run(ctx(s, T + 700));
      expect(alerts(s)).toEqual([]);
      expect(episode(s)).toMatchObject({ started_at: T + 700, state: "failing" });
    });

    test("the alert survives a restart of the loop: the new observer does not raise a second", async () => {
      const s = imported(), gh = fake();
      gh.partial.add(93);
      await observer(gh.run).run(ctx(s, T));
      await observer(gh.run).run(ctx(s, T + 600));
      const raised = alerts(s);
      expect(raised).toHaveLength(1);
      await observer(gh.run).run(ctx(s, T + 630));
      expect(alerts(s)).toEqual(raised);
      expect(since(s, 0, { kinds: ["pr_read_alerted"] })).toHaveLength(1);
    });

    test("a PR GitHub can no longer resolve is gone, not failing: its episode and alert end", async () => {
      const s = imported(), gh = fake(), o = observer(gh.run);
      await o.run(ctx(s, T));
      gh.partial.add(93);
      await o.run(ctx(s, T + 30));
      await o.run(ctx(s, T + 630));
      expect(alerts(s)).toHaveLength(1);
      gh.partial.clear();
      gh.repos.get("acme/app")!.prs.delete(93);
      await o.run(ctx(s, T + 660));
      expect(alerts(s)).toEqual([]);
      expect(episode(s)).toMatchObject({ state: "closed" });
      expect(pr(s, REF).gone_at).toBe(T + 660);
    });

    test("a PR nobody watches any more ends its episode and alert", async () => {
      const s = imported(), gh = fake(), o = observer(gh.run);
      gh.partial.add(93);
      await o.run(ctx(s, T));
      await o.run(ctx(s, T + 600));
      expect(alerts(s)).toHaveLength(1);
      s.db.run("UPDATE units SET status = 'planned' WHERE pr = '93'");
      await o.run(ctx(s, T + 630));
      expect(alerts(s)).toEqual([]);
      expect(episode(s)).toMatchObject({ state: "closed", ended_at: T + 630 });
    });

    test("closing the host's last squad ends the episode and alert, though no poll follows", async () => {
      const s = imported(), gh = fake(), o = observer(gh.run);
      gh.partial.add(93);
      await o.run(ctx(s, T));
      await o.run(ctx(s, T + 600));
      expect(alerts(s)).toHaveLength(1);
      const asked = gh.calls.length;
      s.db.run("UPDATE squads SET status = 'closed'");
      await o.run(ctx(s, T + 630));
      expect(gh.calls).toHaveLength(asked);
      expect(alerts(s)).toEqual([]);
      expect(episode(s)).toMatchObject({ state: "closed", ended_at: T + 630 });
    });

    test("a PR nobody watches any more ends its alert even while its repo does not answer", async () => {
      const s = imported(), gh = fake(), o = observer(gh.run);
      gh.partial.add(93);
      await o.run(ctx(s, T));
      await o.run(ctx(s, T + 600));
      expect(alerts(s)).toHaveLength(1);
      s.db.run("UPDATE units SET status = 'planned' WHERE pr = '93'");
      gh.broken.add("acme/app");
      await o.run(ctx(s, T + 630));
      expect(alerts(s)).toEqual([]);
      expect(episode(s)).toMatchObject({ state: "closed", ended_at: T + 630 });
    });

    test("a repo GitHub could not answer neither clears nor alerts; the episode goes on when it answers", async () => {
      const s = imported(), gh = fake(), o = observer(gh.run);
      gh.partial.add(93);
      await o.run(ctx(s, T));
      gh.broken.add("acme/app");
      await o.run(ctx(s, T + 700));
      expect(alerts(s)).toEqual([]);
      expect(episode(s)).toMatchObject({ started_at: T, state: "failing", ended_at: null });
      gh.broken.clear();
      await o.run(ctx(s, T + 730));
      expect(alerts(s)).toHaveLength(1);
      expect(episode(s)).toMatchObject({ started_at: T, state: "alerted" });
    });

    test("an alert that could not be written is tried again at the next poll, and so is its resolve", async () => {
      const s = imported(), gh = fake(), o = observer(gh.run), file = join(s.root, "fx", "alerts.json");
      gh.partial.add(93);
      await o.run(ctx(s, T));
      writeFileSync(file, "not json");
      await o.run(ctx(s, T + 600));
      expect(episode(s).state).toBe("failing");
      expect(since(s, 0, { kinds: ["plugin_error"] })).toHaveLength(1);
      rmSync(file);
      await o.run(ctx(s, T + 630));
      expect(episode(s).state).toBe("alerted");
      expect(alerts(s)).toHaveLength(1);
      const good = readFileSync(file, "utf8");
      gh.partial.clear();
      writeFileSync(file, "not json");
      await o.run(ctx(s, T + 660));
      expect(episode(s)).toMatchObject({ state: "alerted", ended_at: null });
      writeFileSync(file, good);
      await o.run(ctx(s, T + 690));
      expect(alerts(s)).toEqual([]);
      expect(episode(s)).toMatchObject({ state: "closed", ended_at: T + 690 });
    });

    test("two projects with a unit on the PR each get one alert, and both clear", async () => {
      const s = imported(), gh = fake(), o = observer(gh.run);
      s.upsert("squads", { project: "other", topic: "x" }, { repo: "path:/elsewhere", observed_at: T, updated_at: T });
      s.upsert("units", { project: "other", squad: "x", slug: "u1" }, { status: "dispatched", pr: "93", observed_at: T, updated_at: T });
      gh.partial.add(93);
      await o.run(ctx(s, T));
      await o.run(ctx(s, T + 600));
      expect(alerts(s)).toHaveLength(1);
      expect(alerts(s, "other")).toHaveLength(1);
      gh.partial.clear();
      await o.run(ctx(s, T + 630));
      expect(alerts(s)).toEqual([]);
      expect(alerts(s, "other")).toEqual([]);
    });

    test("only a project with a unit on the PR hears of it, not another project on the same repo", async () => {
      const s = imported(), gh = fake(), o = observer(gh.run);
      s.upsert("squads", { project: "other", topic: "x" }, { repo: "path:/elsewhere", observed_at: T, updated_at: T });
      gh.partial.add(93);
      await o.run(ctx(s, T));
      await o.run(ctx(s, T + 600));
      expect(alerts(s)).toHaveLength(1);
      expect(alerts(s, "other")).toEqual([]);
      expect(episode(s, "other")).toBeNull();
    });

    describe("a later thread page that cannot be read", () => {
      const resolved = (n: number) => Array.from({ length: n }, () => ({ isResolved: true }));
      const setThreads = (gh: FakeGithub, n: number, nodes: any[]) => { gh.repos.get("acme/app")!.prs.get(n)!.reviewThreads = { nodes }; };
      // The fake's answer, with what comes back for one PR's thread page changed.
      const onThreadPage = (gh: FakeGithub, n: number, change: (body: any, alias: string) => void): Gh => async (query) => {
        const r = await gh.run(query), alias = `t${n}`;
        if (!query.includes(`${alias}: pullRequest`)) return r;
        const body = JSON.parse(r.stdout);
        change(body, alias);
        return { code: body.errors ? 1 : r.code, stdout: JSON.stringify(body), stderr: r.stderr };
      };
      const missing = (gh: FakeGithub, n = 93) => onThreadPage(gh, n, (body, alias) => { body.data.r_acme_app[alias] = null; });
      // The page itself looks whole, all resolved and no more to read: only the error says otherwise.
      const errored = (gh: FakeGithub, n = 93) => onThreadPage(gh, n, (body, alias) => {
        body.errors = [{ type: "INTERNAL", path: ["r_acme_app", alias, "reviewThreads", "nodes", 0], message: "thread page broke" }];
        body.data.r_acme_app[alias].reviewThreads.pageInfo.hasNextPage = false;
      });
      // 700 threads need 6 pages after the first, one more than a poll reads.
      const CASES: [string, (gh: FakeGithub) => Gh, string][] = [
        ["a missing page", missing, "did not come back"],
        ["a page with an error on its path", errored, "thread page broke"],
        ["pages still unread when the rounds run out", (gh) => gh.run, "still unread"],
      ];

      for (const [name, broken, why] of CASES) {
        test(`${name} keeps a unit PR's row and alerts once after 600 s; a good read reads ready`, async () => {
          const s = imported(), gh = fake();
          gh.repos.get("acme/app")!.prs.set(93, fromFixture("ready", { number: 93 }));
          setThreads(gh, 93, [...resolved(100), { isResolved: false }]);
          let answer: Gh = gh.run;
          const o = observer((q) => answer(q));
          await o.run(ctx(s, T));
          const before = pr(s, REF);
          expect(before).toMatchObject({ threads: 1, verdict: "blocked" });

          setThreads(gh, 93, resolved(700));
          answer = broken(gh);
          const F = T + 30;
          await o.run(ctx(s, F));
          expect(pr(s, REF)).toEqual(before);
          expect(episode(s)).toMatchObject({ started_at: F, ended_at: null, state: "failing" });
          expect(String(episode(s).result)).toContain(why);
          await o.run(ctx(s, F + 599));
          expect(alerts(s)).toEqual([]);
          await o.run(ctx(s, F + 600, ["prs:refresh"]));
          expect(alerts(s)).toHaveLength(1);
          expect(pr(s, REF)).toEqual(before);

          // 600 threads are the most a poll reads whole.
          setThreads(gh, 93, resolved(600));
          answer = gh.run;
          await o.run(ctx(s, F + 1000));
          expect(pr(s, REF)).toMatchObject({ threads: 0, verdict: "ready", observed_at: F + 1000 });
          expect(alerts(s)).toEqual([]);
          expect(episode(s)).toMatchObject({ state: "closed", ended_at: F + 1000 });
        });

        test(`${name} on a unit PR's first read writes no row`, async () => {
          const s = imported(), gh = fake();
          gh.repos.get("acme/app")!.prs.set(93, fromFixture("ready", { number: 93 }));
          setThreads(gh, 93, resolved(700));
          await observer(broken(gh)).run(ctx(s, T));
          expect(pr(s, REF)).toBeNull();
          expect(episode(s)).toMatchObject({ started_at: T, state: "failing" });
        });
      }

      for (const state of ["MERGED", "CLOSED"]) {
        test(`a ${state} unit PR is written as it is: its threads play no part in its verdict`, async () => {
          const s = imported(), gh = fake();
          gh.repos.get("acme/app")!.prs.set(93, { ...fromFixture("ready", { number: 93, mergedAt: "2026-10-30T10:00:00Z" }), state });
          setThreads(gh, 93, resolved(700));
          await observer(gh.run).run(ctx(s, T));
          expect(pr(s, REF)).toMatchObject({ state, verdict: state.toLowerCase() });
          expect(episode(s)).toBeNull();
          expect(gh.calls.some((q) => q.includes("t93: pullRequest"))).toBe(false);
        });
      }

      test("a PR with no unit keeps its row and raises nothing", async () => {
        const s = imported(), gh = fake(), other = "acme/app#500";
        gh.repos.get("acme/app")!.prs.set(500, fromFixture("ready", { number: 500 }));
        setThreads(gh, 500, [...resolved(50), { isResolved: false }]);
        let answer: Gh = gh.run;
        const o = observer((q) => answer(q));
        await o.run(ctx(s, T));
        const before = pr(s, other);
        expect(before).toMatchObject({ threads: 1, verdict: "blocked" });
        setThreads(gh, 500, resolved(700));
        answer = missing(gh, 500);
        await o.run(ctx(s, T + 30));
        await o.run(ctx(s, T + 630));
        expect(pr(s, other)).toEqual(before);
        expect(episode(s, "fx", other)).toBeNull();
        expect(alerts(s)).toEqual([]);
      });

      test("a later page that reads well still counts its unresolved thread, whatever another PR's page does", async () => {
        const s = imported(), gh = fake();
        gh.repos.get("acme/app")!.prs.set(93, fromFixture("ready", { number: 93 }));
        gh.repos.get("acme/app")!.prs.set(500, fromFixture("ready", { number: 500 }));
        setThreads(gh, 93, [...resolved(230), { isResolved: false }, ...resolved(20)]);
        setThreads(gh, 500, resolved(700));
        await observer(missing(gh, 500)).run(ctx(s, T));
        expect(pr(s, REF)).toMatchObject({ threads: 1, verdict: "blocked" });
        expect(episode(s)).toBeNull();
        expect(pr(s, "acme/app#500")).toBeNull();
      });
    });
  });

  test("a unit PR that merges keeps its row with merged_at", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run);
    await o.run(ctx(s, T));
    Object.assign(gh.repos.get("acme/app")!.prs.get(93)!, { state: "MERGED", mergedAt: "2026-10-30T12:00:00Z" });
    await o.run(ctx(s, T + 30));
    expect(pr(s, "acme/app#93")).toMatchObject({ state: "MERGED", verdict: "merged", merged_at: Date.parse("2026-10-30T12:00:00Z") / 1000, gone_at: null });
  });

  test("stale: blocked for pr_stale_min; a new problem on the same stretch keeps since (U178)", async () => {
    const s = imported(), gh = fake(), o = observer(gh.run), node = gh.repos.get("acme/app")!.prs.get(104)!;
    s.upsert("config", { project: "fx", file: "limits.conf", key: "pr_stale_min" }, { value: "5", observed_at: T });
    await o.run(ctx(s, T));
    await o.run(ctx(s, T + 299));
    expect(pr(s, "acme/app#104")).toMatchObject({ problem: "draft", since: T, stale: 0 });
    await o.run(ctx(s, T + 330));
    expect(pr(s, "acme/app#104")).toMatchObject({ since: T, stale: 1 });
    node.reviewDecision = "CHANGES_REQUESTED";
    await o.run(ctx(s, T + 360));
    expect(pr(s, "acme/app#104")).toMatchObject({ problem: "draft,changes-requested", since: T, stale: 1 });
    process.env.DS_LIMIT_PR_STALE_MIN = "10";
    await o.run(ctx(s, T + 390));
    expect(pr(s, "acme/app#104").stale).toBe(0);
  });

  test("more than 100 open PRs, or threads past the first page, cost one more request each", async () => {
    const s = imported(), gh = fake(), app = gh.repos.get("acme/app")!.prs;
    for (let n = 200; n < 350; n++) app.set(n, fromFixture("ready", { number: n }));
    app.get(93)!.reviewThreads = { nodes: [...Array.from({ length: 100 }, () => ({ isResolved: true })), { isResolved: false }] };
    await observer(gh.run).run(ctx(s, T));
    expect(gh.calls).toHaveLength(3);
    expect(gh.calls[1]).toContain('after: "100"');
    expect(gh.calls[2]).toContain('t93: pullRequest(number: 93) { reviewThreads(first: 100, after: "100")');
    expect(s.get("observed_github", { repo: "acme/app" })?.open_count).toBe(155);
    expect(pr(s, "acme/app#349").verdict).toBe("ready");
    expect(pr(s, "acme/app#93")).toMatchObject({ threads: 1, verdict: "blocked" });
  });

  test("unit PRs in full are the sweep's watched set, at most FULL_PER_POST per request", async () => {
    const s = imported(), gh = fake(), app = gh.repos.get("acme/app")!.prs;
    for (let n = 300; n < 300 + FULL_PER_POST + 5; n++) {
      app.set(n, fromFixture("ready", { number: n }));
      s.upsert("units", { project: "fx", squad: "demo", slug: `w${n}` }, { status: "dispatched", pr: String(n), observed_at: T, updated_at: T });
    }
    s.upsert("units", { project: "fx", squad: "demo", slug: "old" }, { status: "done", pr: "101", builder_wt: "gone::/nowhere", observed_at: T, updated_at: T });
    await observer(gh.run).run(ctx(s, T));
    expect(gh.calls).toHaveLength(2);
    expect(gh.calls.join("\n")).not.toContain("pr101:");
    expect(gh.calls[1]).not.toContain("pullRequests(");
    // 5 left over, plus the fixture's three unit PRs (#92, #93, acme/lib#7), which were asked first.
    expect(gh.calls[1].match(/pr\d+: pullRequest/g)!.length).toBe(8);
    expect(pr(s, `acme/app#${300 + FULL_PER_POST + 4}`)).toMatchObject({ detail: "full", verdict: "ready" });
    expect(pr(s, "acme/app#101").detail).toBe("light");
  });

  test("a slow answer never holds the tick; it lands on a later one, and only one request is in flight", async () => {
    const s = imported(), gh = fake();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const o = observer(async (q) => { await gate; return gh.run(q); }, 10);
    await o.run(ctx(s, T));
    expect(pr(s, "acme/app#101")).toBeNull();
    await o.run(ctx(s, T + 60, ["prs:refresh"]));
    release();
    await Bun.sleep(5);
    expect(gh.calls).toHaveLength(1);
    await o.run(ctx(s, T + 65));
    expect(pr(s, "acme/app#101")).toMatchObject({ verdict: "ready", observed_at: T + 65 });
  });
});

describe("repos", () => {
  test("a squad's repo selector resolves through its origin remote, once, into a config row", async () => {
    const dir = tmp();
    Bun.spawnSync(["git", "init", "-q", dir]);
    Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", "git@github.com:acme/app.git"]);
    expect(repoOf(`path:${dir}`)).toEqual(APP);
    expect(repoOf(`id:0a1b2c3d-0000-4000-8000-00000000d3a0::${dir}`)).toEqual(APP);
    const s = imported(), gh = fake();
    s.db.run("UPDATE squads SET repo = ? WHERE project = 'fx'", [`path:${dir}`]);
    let asked = 0;
    const o = githubObserver({ gh: gh.run, resolve: (sel) => { asked++; return repoOf(sel); } });
    await o.run(ctx(s, T));
    await o.run(ctx(s, T + 30));
    expect(asked).toBe(1);
    expect(s.get("config", { project: "fx", file: "github", key: `repo:path:${dir}` })?.value).toBe("acme/app");
    expect(pr(s, "acme/app#101").verdict).toBe("ready");
    importConfig(s, s.root, join(ROOT, "conventions"));
    expect(s.get("config", { project: "fx", file: "github", key: "default_branch:acme/app" })?.value).toBe("main");
  });

  test("an unresolvable repo is asked again only after an hour; with no repo nothing is requested", async () => {
    const s = imported(), gh = fake();
    s.db.run("DELETE FROM units WHERE slug = 'u9-lib'");
    let asked = 0;
    const o = githubObserver({ gh: gh.run, resolve: () => { asked++; return null; } });
    await o.run(ctx(s, T));
    await o.run(ctx(s, T + 30));
    expect([asked, gh.calls.length]).toEqual([1, 0]);
    await o.run(ctx(s, T + 3600));
    expect(asked).toBe(2);
  });
});

test("runs as a discovered plugin in the loop's tick; a prs:refresh timer forces a poll on the tick it fires", async () => {
  const s = imported(), gh = fake();
  expect((await load<Observer>(DIRS.observers)).map((o) => o.name)).toContain("github");
  const l = new Loop(s, { observers: [observer(gh.run)], reconcilers: [] }, { act: () => {} }, { projects: () => ["fx"] });
  l.boot(T);
  await l.tick(T);
  expect(since(s, 0, { kinds: ["plugin_error"] })).toHaveLength(0);
  expect(pr(s, "acme/app#93").verdict).toBe("blocked");
  timers.set(s, "prs:refresh", T + 10);
  await l.tick(T + 5);
  expect(gh.calls).toHaveLength(1);
  await l.tick(T + 10);
  expect(gh.calls).toHaveLength(2);
});

// U275: every thread selection (open page, full PR, later thread pages) names the thread's place and
// its first comment's author and url, and never a comment body.
test("the thread selections ask for path, line, first comment author and url, no body; the open page skips the comment (U286)", async () => {
  const { buildQuery } = await import("../../bin/loop/observers/github.ts");
  const q = buildQuery([{ nwo: "o/r", page: null, tracked: [7], threads: new Map([[7, "cur"]]) }]);
  expect(q.split("isResolved isOutdated path line comments(first: 1) { nodes { url author { login } } }")).toHaveLength(3);
  expect(q).toContain("reviewThreads(first: 50) { totalCount pageInfo { hasNextPage endCursor } nodes { isResolved isOutdated path line } }");
  expect(q).not.toMatch(/isOutdated \}/);
  expect(q).not.toMatch(/reviewThreads[^]*bodyText/);
});

// brief-other-prs U1: the merge read into observed_merges, riding on the poll's POST.
describe("the merge read", () => {
  const DAY = 86400, START = T - MERGE_BACKFILL_S;
  const user = (login: string, name: string | null = login.toUpperCase()) => ({ __typename: "User", login, name });
  const mnode = (number: number, at: number, author: any = user("ann"), base = "main") =>
    ({ number, title: `feat(core): change ${number}`, baseRefName: base, mergedAt: iso(at), author });
  const ranges = (calls: string[], nwo = "acme/app") => calls.flatMap((c) => [...c.matchAll(/query: "repo:(\S+) is:pr is:merged merged:(\S+)\.\.(\S+)"/g)]
    .filter((m) => m[1] === nwo).map((m) => [Date.parse(m[2]) / 1000, Date.parse(m[3]) / 1000]));
  const merges = (s: Store, repo = "acme/app") => s.db.query("SELECT * FROM observed_merges WHERE repo = ? ORDER BY pr").all(repo) as Row[];
  const gh = (s: Store, repo = "acme/app") => s.get("observed_github", { repo }) as Row;

  test("(a, b) the first read starts 4 days back and walks 1-day reads, due at once, until caught up; overlaps add no row twice", async () => {
    const s = imported(), f = fake(), o = observer(f.run);
    // One merge per half day over the window, plus one right in the first read's overlap.
    const nodes = Array.from({ length: 9 }, (_, i) => mnode(500 + i, START + i * DAY / 2 + 60));
    nodes.push(mnode(600, START - 600));
    f.merged.set("acme/app", nodes);
    let at = T;
    for (let i = 0; i < 10 && Number(gh(s)?.merges_next_at ?? 0) <= at; i++, at += 30) await o.run(ctx(s, at));
    const r = ranges(f.calls);
    // Each read: from 30 min before the cursor, one day long; the last ends at its poll's now.
    expect(r[0]).toEqual([START - 1800, START - 1800 + DAY]);
    for (let i = 1; i < r.length; i++) expect(r[i][0]).toBe(r[i - 1][1] - 1800);
    expect(r).toHaveLength(5);
    const last = at - 30;
    expect(r[4][1]).toBe(last);
    expect(gh(s)).toMatchObject({ merges_from: START, merges_until: last, merges_ok_at: last, merges_error: null, merges_next_at: last + 600 });
    // Every merge once, the overlap's included, though several reads asked for it.
    expect(merges(s).map((m) => m.pr)).toEqual([...nodes.map((n) => n.number)].sort((a, b) => a - b));
    expect(merges(s).find((m) => m.pr === 500)).toMatchObject({ title: "feat(core): change 500", author_login: "ann", author_name: "ANN", base: "main", merged_at: START + 60 });
    // The next read waits DS_LOOP_MERGES_S, then asks 30 min before the cursor again: nothing new, nothing twice.
    await o.run(ctx(s, last + 300));
    expect(ranges(f.calls)).toHaveLength(5);
    await o.run(ctx(s, last + 600));
    expect(ranges(f.calls).at(-1)).toEqual([last - 1800, last + 600]);
    expect(merges(s)).toHaveLength(nodes.length);
  });

  test("(c) a Bot and a [bot] login are not stored; no author is ghost; a User with no name is its login", async () => {
    const s = imported(), f = fake();
    f.merged.set("acme/app", [
      mnode(1, T - 3600, { __typename: "Bot", login: "renovate" }),
      mnode(2, T - 3600, user("dependabot[bot]", null)),
      mnode(3, T - 3600, null),
      mnode(4, T - 3600, user("bob", null)),
      mnode(5, T - 3600, user("cy", "  ")),
      mnode(6, T - 3600, user("di", "Di Ng")),
    ]);
    const o = observer(f.run);
    for (let at = T; Number(gh(s)?.merges_next_at ?? 0) <= at; at += 30) await o.run(ctx(s, at));
    expect(merges(s).map((m) => [m.pr, m.author_login, m.author_name])).toEqual([
      [3, "ghost", "ghost"], [4, "bob", "bob"], [5, "cy", "cy"], [6, "di", "Di Ng"],
    ]);
  });

  test("(d) a range over 900 results stores nothing for it and is asked again as 6 h, then 1 h; an hour still over is skipped", async () => {
    const s = imported(), f = fake();
    f.merged.set("acme/app", [mnode(1, START + 3000), mnode(2, START + 5 * 3600), mnode(3, START + 12 * 3600)]);
    f.mergeCount = (nwo, from, to) => (nwo === "acme/app" && to - from > 6 * 3600 ? 950 : null);
    await observer(f.run).run(ctx(s, T));
    expect(ranges(f.calls).map(([a, b]) => b - a)).toEqual([DAY, 6 * 3600]);
    // The 6 h read is a POST of its own: only the search, no repository block.
    expect(f.calls[1]).not.toContain("repository(");
    expect(merges(s).map((m) => m.pr)).toEqual([1, 2]);
    expect(gh(s)).toMatchObject({ merges_from: START, merges_until: START - 1800 + 6 * 3600, merges_error: null, merges_next_at: T });

    const s2 = imported(), f2 = fake();
    f2.merged.set("acme/app", [mnode(1, START + 60)]);
    f2.mergeCount = (nwo) => (nwo === "acme/app" ? 950 : null);
    await observer(f2.run).run(ctx(s2, T));
    expect(ranges(f2.calls).map(([a, b]) => b - a)).toEqual([DAY, 6 * 3600, 3600]);
    expect(merges(s2)).toHaveLength(0);
    expect(gh(s2)).toMatchObject({ merges_from: START, merges_until: START - 1800 + 3600, merges_ok_at: null, merges_next_at: T });
    expect(String(gh(s2).merges_error)).toMatch(/^over 900 merged PRs in .*: that hour is not recorded$/);
    expect(since(s2, 0, { kinds: ["github_merges_skipped"] })).toHaveLength(1);
  });

  test("(e) a failed merge field sets merges_error and keeps the cursor; the open rows are still written", async () => {
    const s = imported(), f = fake();
    f.merged.set("acme/app", [mnode(1, T - 3600)]);
    f.mergesFailing.add("acme/app");
    const o = observer(f.run);
    await o.run(ctx(s, T));
    expect(gh(s)).toMatchObject({ ok_at: T, error: null, open_count: 5, merges_from: null, merges_until: null, merges_next_at: T + 600 });
    expect(String(gh(s).merges_error)).toContain("Something went wrong");
    expect(pr(s, "acme/app#101")).toMatchObject({ verdict: "ready" });
    // The other repo's read went on.
    expect(gh(s, "acme/lib")).toMatchObject({ merges_from: START, merges_error: null });
    expect(merges(s)).toHaveLength(0);
    // It is asked again after DS_LOOP_MERGES_S from the same start; a good answer clears the error.
    f.mergesFailing.clear();
    await o.run(ctx(s, T + 600));
    expect(ranges(f.calls).at(-1)).toEqual([T + 600 - MERGE_BACKFILL_S - 1800, T + 600 - MERGE_BACKFILL_S - 1800 + DAY]);
    expect(gh(s)).toMatchObject({ merges_error: null, merges_from: T + 600 - MERGE_BACKFILL_S });
  });

  test("(f) when no merge read is due the query has no m_ field and is the open read's alone", async () => {
    const s = imported(), f = fake();
    for (const repo of ["acme/app", "acme/lib"]) s.upsert("observed_github", { repo }, { merges_until: T - 60, merges_next_at: T + 100, observed_at: T });
    await observer(f.run).run(ctx(s, T));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).not.toContain("m_");
    expect(f.calls[0]).not.toContain("search(");
    const asks = [{ nwo: "acme/app", page: null, tracked: [92, 93] }, { nwo: "acme/lib", page: null, tracked: [7] }];
    expect(f.calls[0]).toBe(buildQuery(asks));
    // Due again: the search rides on the same POST.
    await observer(f.run).run(ctx(s, T + 100));
    expect(f.calls[1]).toContain('m_r_acme_app: search(type: ISSUE, first: 100, after: null, query: "repo:acme/app is:pr is:merged merged:');
  });
});

// ds-feedback-github-issues U5: the issues this host filed ride on the poll and flow back to the notes.
describe("feedback issues", () => {
  const issue = (n: number, state: string, stateReason: string | null, prs: any[] = []) =>
    ({ number: n, state, stateReason, closedByPullRequestsReferences: { nodes: prs } });
  const merged = (number: number, oid: string, at = "2026-11-20T10:00:00Z") => ({ number, merged: true, mergedAt: at, mergeCommit: { oid } });
  // The fake's answer with each asked `fi<N>` alias filled from `issues`.
  function withIssues(issues: Map<number, any>) {
    const f = fake(), queries: string[] = [];
    const run: Gh = async (query) => {
      queries.push(query);
      const r = await f.run(query), body = JSON.parse(r.stdout);
      for (const m of query.matchAll(/ fi(\d+): issue\(/g)) {
        const node = issues.get(Number(m[1]));
        if (node && body.data.r_acme_app) body.data.r_acme_app[`fi${m[1]}`] = node;
      }
      return { ...r, stdout: JSON.stringify(body) };
    };
    return { run, queries };
  }
  function seed(s: Store, nums: number[], repo: string | null = "acme/app") {
    if (repo) s.upsert("config", { project: "", file: "limits.conf", key: "feedback_repo" }, { value: repo, observed_at: T });
    for (const n of nums) {
      s.upsert("feedback_drafts", { key: `fd:${n}` }, { kind: "issue", title: `t${n}`, body: "b", state: "filed", repo: "acme/app", issue: n, created_at: T, updated_at: T });
      const id = Number((s.get("feedback_drafts", { key: `fd:${n}` }) as Row).id);
      s.upsert("feedback_notes", { key: `fb:${n}` }, { project: "fx", text: `note ${n}`, source: "cli", state: "filed", draft_id: id, at: T, updated_at: T });
    }
  }
  const draft = (s: Store, n: number) => s.get("feedback_drafts", { key: `fd:${n}` }) as Row;
  const note = (s: Store, n: number) => s.get("feedback_notes", { key: `fb:${n}` }) as Row;
  const obs = (run: Gh, held: string[] = []) => githubObserver({ gh: run, resolve: () => APP, budgetMs: 1000, holds: async (oids) => new Set(oids.filter((o) => held.includes(o))) });

  test("closed as completed with a PR → fixed with the PR; not planned → closed; open → unchanged", async () => {
    const s = imported();
    seed(s, [41, 42, 43]);
    const g = withIssues(new Map([[41, issue(41, "CLOSED", "COMPLETED", [merged(77, "abc1234")])], [42, issue(42, "CLOSED", "NOT_PLANNED")], [43, issue(43, "OPEN", null)]]));
    await obs(g.run).run(ctx(s, T));
    expect(draft(s, 41)).toMatchObject({ state: "fixed", fix_pr: 77, fix_here: 0 });
    expect(note(s, 41).state).toBe("fixed");
    expect(draft(s, 42)).toMatchObject({ state: "closed", fix_pr: null });
    expect(note(s, 42).state).toBe("closed");
    expect(draft(s, 43).state).toBe("filed");
    expect(note(s, 43).state).toBe("filed");
    expect(noteLine(listNotes(s).find((r) => r.key === "fb:41")!)).toContain("fixed in #77");
  });

  test("in your version once the checkout holds the PR's merge commit, picked up on a later poll", async () => {
    const s = imported();
    seed(s, [41]);
    const g = withIssues(new Map([[41, issue(41, "CLOSED", "COMPLETED", [merged(77, "abc1234")])]]));
    await obs(g.run).run(ctx(s, T));
    expect(draft(s, 41).fix_here).toBe(0);
    const o = obs(g.run, ["abc1234"]);
    await o.run(ctx(s, T + 100_000));
    expect(draft(s, 41)).toMatchObject({ state: "fixed", fix_pr: 77, fix_here: 1 });
    expect(noteLine(listNotes(s).find((r) => r.key === "fb:41")!)).toContain("(in your version)");
    // Done: the issue is not asked again.
    const n = g.queries.length;
    await o.run(ctx(s, T + 200_000));
    expect(g.queries.slice(n).join("")).not.toContain("fi41");
  });

  test("completed with no PR named: fixed with no PR", async () => {
    const s = imported();
    seed(s, [41]);
    await obs(withIssues(new Map([[41, issue(41, "CLOSED", "COMPLETED")]])).run).run(ctx(s, T));
    expect(draft(s, 41)).toMatchObject({ state: "fixed", fix_pr: null });
    expect(noteLine(listNotes(s).find((r) => r.key === "fb:41")!)).toContain("fixed  ");
  });

  test("no repo set → no issue field in the query and nothing changes", async () => {
    const s = imported();
    seed(s, [41], null);
    const g = withIssues(new Map([[41, issue(41, "CLOSED", "COMPLETED")]]));
    await obs(g.run).run(ctx(s, T));
    expect(g.queries.join("")).not.toContain("issue(number");
    expect(draft(s, 41).state).toBe("filed");
  });

  test("one POST: the issue fields ride on the repo's existing query, one per filed issue", async () => {
    const s = imported();
    seed(s, [41, 42]);
    const g = withIssues(new Map());
    await obs(g.run).run(ctx(s, T));
    expect(g.queries.filter((q) => q.includes("issue(number")).length).toBe(1);
    expect(g.queries[0]).toContain("fi41: issue(number: 41)");
    expect(g.queries[0]).toContain("fi42: issue(number: 42)");
  });
});
