// lifecycle.test.ts — U6: the unit and PR lifecycle reconciler, the the removed sweep tests scenarios for
// steps 1a–1d, 9 and 10 ported by name. Each runs real ticks over a hermetic state root holding one
// squad (lc) and asserts the episode key, and that a repeated tick acts on nothing new.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { Action, Actuator } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { since } from "../../bin/loop/core/events.ts";
import { pokeCap, pokeGap, allDone as allDoneWake } from "../../bin/loop/pause/wake.ts";
import { allDone as allDoneIn, retestDue } from "../../bin/loop/squad/retest.ts";
import { pokeSettled } from "../../bin/loop/reconcilers/alerts.ts";
import { open as askOpen, answer } from "../../bin/loop/messages/questions.ts";
import lifecycle from "../../bin/loop/reconcilers/lifecycle.ts";
import { fakeGithub, fromFixture } from "../../bin/loop/fakes/github.ts";
import { githubObserver } from "../../bin/loop/observers/github.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const T = 1_800_000_000;
const LEAD = "wt-lead::/ws/ds-lead-lc", B = "wt-b1::/ws/ds-builder-u1-lc";
const NWO = "o/r";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

type Unit = Row & { slug: string };
// A root with the fixture's projects and one squad, lc, of a busy Lead and an idle Builder for u1.
function squad(units: Unit[], extra: Row = {}): { s: Store; root: string } {
  const root = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  rmSync(join(root, "fx", "squads", "demo.json"));
  rmSync(join(root, "fx", "sweep", "pr-health.json"));
  const doc = {
    type: "feature", status: "running", repo: "path:/x/repo", lead_wt: LEAD,
    members: [{ role: "lead", suffix: "", wt: LEAD }, { role: "builder", suffix: "u1", wt: B }],
    units: units.map((u) => ({ status: "dispatched", builder_wt: B, deps: [], hold: false, ...u })),
    leftovers: [], ...extra,
  };
  writeFileSync(join(root, "fx", "squads", "lc.json"), JSON.stringify(doc, null, 2) + "\n");
  const s = open(root); stores.push(s);
  importJson(s);
  s.upsert("config", { project: "fx", file: "github", key: "repo:path:/x/repo" }, { value: NWO, observed_at: T });
  s.upsert("config", { project: "fx", file: "github", key: `default_branch:${NWO}` }, { value: "main", observed_at: T });
  s.upsert("observed_worktrees", { project: "fx", wt: B }, { path: "/ws/ds-builder-u1-lc", branch: "feat-u1", observed_at: T });
  worker(s, B, "idle");
  worker(s, LEAD, "working"); // the all-done tests idle it
  return { s, root };
}
function worker(s: Store, wt: string, state: string, limited: string | null = null, at: number | null = null) {
  s.upsert("observed_workers", { project: "fx", wt }, { state, limited, since: at, observed_at: T });
}
function agent(s: Store, wt: string, a: string) {
  s.db.query("UPDATE members SET agent = ? WHERE wt = ?").run(a, wt);
}
function pr(s: Store, n: number, set: Row) {
  s.upsert("observed_prs", { project: "fx", ref: `${NWO}#${n}` }, { pr: n, repo: NWO, head: "feat-u1", state: "OPEN", verdict: "ready", reasons: JSON.stringify(""), observed_at: T, ...set });
}
function loop(s: Store) {
  const got: Action[] = [];
  const act: Actuator = { act(a) { got.push(a); } };
  const l = new Loop(s, { observers: [], reconcilers: [lifecycle] }, act, { projects: () => ["fx"] });
  l.boot(T);
  return { got, tick: async (at: number) => (await l.tick(at)).acted };
}
const unit = (s: Store, slug: string) => s.get("units", { project: "fx", squad: "lc", slug }) as Row;
const sq = (s: Store) => s.get("squads", { project: "fx", topic: "lc" }) as Row;
const events = (s: Store, kind: string) => since(s, 0, { kinds: [kind] });
const exported = (root: string) => JSON.parse(readFileSync(join(root, "fx", "squads", "lc.json"), "utf8"));
const eps = (a: Action[]) => a.map((x) => `${x.kind} ${x.episode}`);

describe("Builders waiting for a ruling", () => {
  test.each(["unit", "asker"])("a blocking question linked by %s silences PR pokes until answered", async (link) => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    askOpen(s, "fx", "lc", { id: "routing", blocking: true, question: "Who owns the upstream fix?", ...(link === "unit" ? { unit: "u1", asker: "lead" } : { asker: "builder-u1" }) });
    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("conflicting"), problem: "conflicting", since: T, detail: "full", doc: JSON.stringify({ headRefOid: "aaa" }) });
    const l = loop(s);
    expect(await l.tick(T)).toEqual([]);
    expect(unit(s, "u1").merge_blocked).toBe("conflicting");
    pr(s, 7, { verdict: "waiting", reasons: JSON.stringify("required:signoff") });
    expect(await l.tick(T + 30)).toEqual([]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM questions WHERE status = 'open'").get()).toEqual({ n: 1 });
    pr(s, 7, { verdict: "ready", reasons: JSON.stringify(""), base: "main", mergeable: "MERGEABLE" });
    worker(s, LEAD, "idle");
    expect(await l.tick(T + 60)).toEqual([]);
    answer(s, "fx", "lc", "routing", "Resume work", "terminal");
    expect((await l.tick(T + 120)).some((a) => a.member === B && a.kind === "poke")).toBe(true);
  });

  // U160 (U28/#273): `hold` keeps a planned unit quiet; a unit dispatched by hand despite it is held back only by a blocking question.
  const readyPr = (s: Store) => pr(s, 7, { verdict: "ready", reasons: JSON.stringify(""), base: "main", mergeable: "MERGEABLE", detail: "full", doc: JSON.stringify({ headRefOid: "aaa" }) });
  const toLead = (a: Action[]) => a.filter((x) => x.member === LEAD && x.kind === "poke");
  test("a hand-dispatched held unit with a merge-ready PR tells its Lead once", async () => {
    const { s } = squad([{ slug: "u1", pr: "7", hold: true }]);
    worker(s, LEAD, "idle");
    readyPr(s);
    const l = loop(s);
    expect(toLead(await l.tick(T))).toHaveLength(1);
    expect(toLead(await l.tick(T + 5))).toEqual([]);
  });

  test("a held planned unit stays quiet", async () => {
    const { s } = squad([{ slug: "u1", pr: "7", hold: true, status: "planned" }]);
    worker(s, LEAD, "idle");
    readyPr(s);
    expect(await loop(s).tick(T)).toEqual([]);
  });

  test("a dispatched unit with a blocking question stays quiet, held or not", async () => {
    for (const hold of [false, true]) {
      const { s } = squad([{ slug: "u1", pr: "7", hold }]);
      askOpen(s, "fx", "lc", { id: "routing", blocking: true, question: "Who owns the upstream fix?", unit: "u1", asker: "lead" });
      worker(s, LEAD, "idle");
      readyPr(s);
      expect(toLead(await loop(s).tick(T))).toEqual([]);
    }
  });

  test.each([false, true])("a non-blocking or unrelated question does not silence this Builder (blocking=%s)", async (blocking) => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    askOpen(s, "fx", "lc", { id: "other", blocking, unit: blocking ? "u2" : "u1", asker: "lead", question: "Follow-up?" });
    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("conflicting"), problem: "conflicting", since: T });
    expect((await loop(s).tick(T)).some((a) => a.member === B && a.kind === "poke")).toBe(true);
  });
});

// U36: tests/fixtures/pr-health through the real observer into the reconciler, one poll per tick.
// The first five carry #160's the removed sweep tests names at 1edf8b0. "a base with no rules" and "a comma
// in a name" use its fixtures but have no sweep assertion of that name; the merge-ready one is the
// loop's own (KTD17).
describe("required:<context> (#160), from the fixtures through the observer", () => {
  const P = 60; // past the observer's 30 s interval, so each tick polls
  // `health(f)` is the sweep test's helper: the next poll answers with that fixture.
  function observed(s: Store, base = "main") {
    const prs = new Map<number, any>();
    const health = (f: string, edit: (n: any) => void = () => {}) => {
      const node = fromFixture(f, { number: 7, head: "feat-u1", base, nwo: NWO });
      edit(node);
      prs.set(7, node);
    };
    const gh = fakeGithub(new Map([[NWO, { defaultBranch: "main", prs }]]));
    const observer = githubObserver({ gh: gh.run, resolve: () => ({ owner: "o", name: "r" }), budgetMs: 1000 });
    const got: Action[] = [];
    const act: Actuator = { act(a) { got.push(a); } };
    const l = new Loop(s, { observers: [observer], reconcilers: [lifecycle] }, act, { projects: () => ["fx"] });
    l.boot(T);
    // U77's pr-news pokes are tested below; these tests are about step 9 and KTD17.
    return { health, tick: async (at: number) => eps((await l.tick(at)).acted).filter((e) => !e.startsWith("poke pr-news:")) };
  }
  const row = (s: Store) => s.get("observed_prs", { project: "fx", ref: `${NWO}#7` }) as Row;
  const reasons = (s: Store) => JSON.parse(String(row(s).reasons));
  const stale = (s: Store) => s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:stale" }) as Row;

  test("U2 required context missing: waiting, no poke", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
    o.health("required-missing");
    expect(await o.tick(T)).toEqual([]);
    expect(await o.tick(T + P)).toEqual([]);
    expect(row(s)).toMatchObject({ verdict: "waiting", problem: null, merge_blocked: 0 });
    expect(reasons(s)).toBe("required:manual-gate");
    expect(unit(s, "u1").merge_blocked ?? null).toBeNull();
  });

  test("U2 a wait on required:* alone clears a poke, so the sitting alarm can fire", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
    o.health("threads");
    expect(await o.tick(T)).toEqual([`poke pr-stale:threads|${T}#1#1`]);
    expect(stale(s)).toMatchObject({ count: 1, state: "poked", ended_at: null });
    o.health("required-missing");
    expect(await o.tick(T + P)).toEqual([]);
    expect(stale(s)).toBeNull();
    expect(row(s).since).toBe(T + P);
    // every later blocker still gets a poke: a kept count would hit the two-poke cap at the third
    o.health("conflicting");
    expect(await o.tick(T + 2 * P)).toEqual([`poke pr-stale:conflicting|${T + P}#1#1`]);
    o.health("required-missing");
    expect(await o.tick(T + 3 * P)).toEqual([]);
    o.health("failing-check");
    expect(await o.tick(T + 4 * P)).toEqual([`poke pr-stale:checks-failing|${T + 3 * P}#1#1`]);
    expect(stale(s)).toMatchObject({ count: 1, state: "poked", ended_at: null });
  });

  test("required:* with checks still running keeps the count", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
    o.health("threads");
    expect(await o.tick(T)).toEqual([`poke pr-stale:threads|${T}#1#1`]);
    o.health("required-missing", (n) => {
      n.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.push({ __typename: "CheckRun", name: "slow", status: "IN_PROGRESS", conclusion: null, isRequired: true });
    });
    expect(await o.tick(T + P)).toEqual([]);
    expect(reasons(s)).toBe("checks-running,required:manual-gate");
    expect(row(s).since).toBe(T);
    expect(stale(s)).toMatchObject({ count: 1, state: "armed", ended_at: null });
    // The count held: back on the same problem is the second poke of that episode, not a new first.
    o.health("threads");
    expect(await o.tick(T + 2 * P)).toEqual([`poke pr-stale:threads|${T}#2#1`]);
  });

  test("U2 blocked with a missing required context: one poke", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
    o.health("required-classic-threads");
    expect(await o.tick(T)).toEqual([`poke pr-stale:threads|${T}#1#1`]);
    expect(row(s)).toMatchObject({ verdict: "blocked", problem: "threads" });
    expect(reasons(s)).toBe("required:Secret scan,mergeable-unknown,threads:1");
    expect(await o.tick(T + P)).toEqual([]);
  });

  test("the required context arriving is the same key: no new poke", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
    o.health("required-classic-threads");
    expect(await o.tick(T)).toEqual([`poke pr-stale:threads|${T}#1#1`]);
    o.health("threads");
    expect(await o.tick(T + P)).toEqual([]);
    expect(row(s)).toMatchObject({ verdict: "blocked", problem: "threads", since: T });
    expect(reasons(s)).toBe("threads:2");
  });

  test("a base with no rules adds nothing", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
    o.health("no-rules");
    expect(await o.tick(T)).toEqual([]);
    expect(row(s).verdict).toBe("ready");
    expect(reasons(s)).toBe("");
  });

  test("a comma in a name does not split the reasons", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
    o.health("threads");
    await o.tick(T);
    o.health("required-missing-comma");
    expect(await o.tick(T + P)).toEqual([]);
    expect(reasons(s)).toBe("required:a-gate,required:test (ubuntu-latest; 20)");
    expect(row(s).verdict).toBe("waiting");
    expect(stale(s)).toBeNull(); // both reasons read as required:*: a wait on them alone
  });

  test("the merge-ready wake still needs ready: a missing required context holds it", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s, "main");
    worker(s, LEAD, "idle");
    o.health("required-missing");
    expect(await o.tick(T)).toEqual([]);
    o.health("required-all-green");
    expect(await o.tick(T + P)).toEqual([`poke merge-ready:${NWO}#7#1#1`]);
  });
});

describe("1a: PR record", () => {
  test("a dispatched unit with no PR records its Builder branch's open PR, highest number; once", async () => {
    const { s, root } = squad([{ slug: "u1" }]);
    pr(s, 6, {}); pr(s, 7, {}); pr(s, 5, { state: "CLOSED", verdict: "closed" });
    const l = loop(s);
    await l.tick(T);
    expect(unit(s, "u1").pr).toBe("7");
    expect(exported(root).units[0].pr).toBe("7");
    await l.tick(T + 5);
    expect(events(s, "unit_pr").length).toBe(1);
  });

  test("no open PR: the newest merged one; a closed one is never recorded; main is never a unit branch", async () => {
    const { s } = squad([{ slug: "u1" }]);
    pr(s, 3, { state: "MERGED", verdict: "merged", merged_at: T - 50 });
    pr(s, 4, { state: "CLOSED", verdict: "closed" });
    const l = loop(s);
    await l.tick(T);
    expect(unit(s, "u1").pr).toBe("3");

    const o = squad([{ slug: "u1" }]);
    pr(o.s, 4, { state: "CLOSED", verdict: "closed" });
    o.s.upsert("observed_worktrees", { project: "fx", wt: B }, { branch: "main", observed_at: T });
    pr(o.s, 8, { head: "main" });
    await loop(o.s).tick(T);
    expect(unit(o.s, "u1").pr ?? null).toBeNull();
  });

  test("1a-closed: a recorded PR that closed unmerged is replaced by the branch's open one", async () => {
    const { s } = squad([{ slug: "u1", pr: "5" }]);
    pr(s, 5, { state: "CLOSED", verdict: "closed" }); pr(s, 9, {});
    await loop(s).tick(T);
    expect(unit(s, "u1").pr).toBe("9");
    expect(JSON.parse(String(events(s, "unit_pr")[0].payload))).toMatchObject({ pr: 9, was: "5" });
  });
});

describe("1b/1c: done on merge and archive (U155)", () => {
  const builderRow = (s: Store) => s.db.query("SELECT * FROM members WHERE wt = ? ORDER BY id DESC").get(B) as Row;
  test("a merged PR marks the unit done in the same tick's export and writes the idle Builder's archived wish once", async () => {
    const { s, root } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 7, { state: "MERGED", verdict: "merged" });
    const l = loop(s);
    const acted = await l.tick(T);
    expect(unit(s, "u1").status).toBe("done");
    expect(unit(s, "u1").done_at).toBe(T);
    expect(exported(root).units[0].status).toBe("done");
    expect(eps(acted)).toEqual([]);   // no retire action: the decider closes the archived Builder
    expect(builderRow(s)).toMatchObject({ want: "gone", want_by: "loop" });
    const at = builderRow(s).want_at;
    expect(await l.tick(T + 5)).toEqual([]);
    expect(builderRow(s).want_at).toBe(at);
    expect(events(s, "unit_done").length).toBe(1);
  });

  test("a merged PR leaves one lane record: the unit rule, its CPU and the PR top-level folders (U5)", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    s.db.run("UPDATE units SET doc = ? WHERE slug = 'u1'", [JSON.stringify({ lane: "light", lane_rule: "contracts-only" })]);
    s.db.run("INSERT INTO unit_cpu (project, squad, slug, cpu_s, first_at, updated_at) VALUES ('fx', ?, 'u1', 7200, 1, 1)", [String(unit(s, "u1").squad)]);
    pr(s, 7, { state: "MERGED", verdict: "merged", doc: JSON.stringify({ files: { nodes: [{ path: "contracts/a.sol" }, { path: "docs/x.md" }] } }) });
    const l = loop(s);
    await l.tick(T);
    await l.tick(T + 5);
    const rows = s.db.query("SELECT * FROM unit_lanes WHERE project = 'fx'").all() as Row[];
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ slug: "u1", lane: "light", lane_rule: "contracts-only", cpu_s: 7200, moved: 0, pr: 7, done_at: T });
    expect(JSON.parse(String(rows[0].folders))).toEqual(["contracts", "docs"]);
  });

  test("a lane record that cannot be written never undoes unit_done (U5)", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    s.db.run("DROP TABLE unit_lanes");
    pr(s, 7, { state: "MERGED", verdict: "merged" });
    await loop(s).tick(T);
    expect(unit(s, "u1").status).toBe("done");
    expect(events(s, "unit_done").length).toBe(1);
  });

  test("done on merge even while the Builder works; the archive wish waits for it to stop working", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 7, { state: "MERGED", verdict: "merged" });
    worker(s, B, "working");
    const l = loop(s);
    expect(await l.tick(T)).toEqual([]);
    expect(unit(s, "u1").status).toBe("done");
    expect(builderRow(s).want).not.toBe("gone");
    worker(s, B, "idle");
    expect(await l.tick(T + 5)).toEqual([]);
    expect(builderRow(s).want).toBe("gone");
  });

  test("a cancelled unit is never marked done", async () => {
    const { s } = squad([{ slug: "u1", pr: "7", status: "cancelled" }]);
    pr(s, 7, { state: "MERGED", verdict: "merged" });
    await loop(s).tick(T);
    expect(unit(s, "u1").status).toBe("cancelled");
  });
});

describe("1d: leftovers and into-PR", () => {
  test("a revived or gone leftover's record drops; a present one gets one worktree.remove", async () => {
    const keep = mkdtempSync(join(tmpdir(), "zzloop-left-")); temps.push(keep);
    const left = [
      { wt: B, path: "/ws/ds-builder-u1-lc", branch: "feat-u1", unit: "u1" },
      { wt: "wt-gone::/nope", path: "/nonexistent/zzloop-gone", branch: "x", unit: "u0" },
      { wt: "wt-old::" + keep, path: keep, branch: "feat-u1", unit: "u0" },
    ];
    const { s, root } = squad([{ slug: "u1", status: "done", pr: "7" }], { leftovers: left });
    pr(s, 7, { state: "MERGED", verdict: "merged" });
    worker(s, B, "working");
    const l = loop(s);
    const acted = await l.tick(T);
    expect(eps(acted)).toEqual([`worktree.remove leftover:wt-old::${keep}@3000000`]);
    expect((acted[0].payload as Row).merged).toBe(true);
    expect(exported(root).leftovers.map((x: Row) => x.wt)).toEqual([`wt-old::${keep}`]);
    expect(await l.tick(T + 5)).toEqual([]);
    expect(events(s, "leftover_dropped").length).toBe(1);
    // Still there a retry period later (the probes refused it): sent again, as the sweep re-probed.
    expect(eps(await l.tick(T + 600))).toEqual([`worktree.remove leftover:wt-old::${keep}@3000001`]);
  });

  test("a cancelled unit superseded by a merged PR#n gets into_merged", async () => {
    const { s } = squad([{ slug: "u1", status: "cancelled", superseded_by: "PR#9" }]);
    pr(s, 9, { state: "MERGED", verdict: "merged", head: "other" });
    await loop(s).tick(T);
    expect(unit(s, "u1").into_merged).toBe(1);
  });
});

describe("9: stale PR", () => {
  test("a blocked PR is flagged with pr_health's reasons and its idle Builder poked once per problem|since episode, round 1", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("conflicting,threads:2"), problem: "conflicting,threads", since: T - 100, stale: 1 });
    const l = loop(s);
    const acted = await l.tick(T);
    expect([unit(s, "u1").merge_blocked, unit(s, "u1").pr_stale]).toEqual(["conflicting,threads:2", 1]);
    expect(eps(acted)).toEqual([`poke pr-stale:conflicting,threads|${T - 100}#1#1`]);
    expect(String((acted[0].payload as Row).text)).toContain("PR #7 for your unit u1 is not merge-ready (conflicting,threads:2)");
    expect(await l.tick(T + 5)).toEqual([]);

    pr(s, 7, { verdict: "ready", problem: null, since: T + 10, stale: 0 });
    expect(await l.tick(T + 10)).toEqual([]);
    expect([unit(s, "u1").merge_blocked, unit(s, "u1").pr_stale]).toEqual([null, null]);

    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("checks-failing"), problem: "checks-failing", since: T + 20, stale: 0 });
    expect(eps(await l.tick(T + 20))).toEqual([`poke pr-stale:checks-failing|${T + 20}#1#1`]);
  });

  test("an unchanged blocked PR, re-read by GitHub or going stale, writes no new unit_pr_blocked", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    worker(s, B, "working");
    const l = loop(s), n = () => s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'unit_pr_blocked'").get() as { n: number };
    const blocked = (r: string, stale = 0) => pr(s, 7, { verdict: "blocked", reasons: JSON.stringify(r), problem: "threads", since: T, stale });
    const rereading = () => pr(s, 7, { verdict: "waiting", reasons: JSON.stringify("mergeable-unknown"), problem: null, since: T });
    blocked("threads:1"); await l.tick(T);
    expect(n().n).toBe(1);
    let at = T;
    for (const step of [() => blocked("threads:1,mergeable-unknown"), rereading, () => blocked("threads:1"), () => blocked("threads:1", 1), rereading, () => blocked("threads:1", 1)]) {
      step(); await l.tick(at += 5);
      expect(unit(s, "u1").merge_blocked).toBe("threads:1");
    }
    expect(n().n).toBe(1);
    expect(unit(s, "u1").pr_stale).toBe(1);
    blocked("threads:2", 1); await l.tick(at += 5);
    expect(n().n).toBe(2);
  });

  test("a GitHub re-read (waiting on required:* and mergeable-unknown) keeps the poke episode", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s), got: string[] = [];
    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("threads:1"), problem: "threads", since: T });
    got.push(...eps(await l.tick(T)));
    pr(s, 7, { verdict: "waiting", reasons: JSON.stringify("required:A,mergeable-unknown"), problem: null, since: T });
    got.push(...eps(await l.tick(T + 600)));
    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("threads:1"), problem: "threads", since: T });
    got.push(...eps(await l.tick(T + 1200)));
    expect(got).toEqual([`poke pr-stale:threads|${T}#1#1`, `poke pr-stale:threads|${T}#2#1`]);
  });

  test("a working non-Claude Builder, or one whose worktree is gone, is not poked", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("conflicting"), problem: "conflicting", since: T });
    agent(s, B, "codex"); worker(s, B, "working");
    const l = loop(s);
    expect(await l.tick(T)).toEqual([]);
    worker(s, B, "idle");
    s.upsert("observed_worktrees", { project: "fx", wt: B }, { gone_at: T });
    expect(await l.tick(T + 5)).toEqual([]);
  });

  test("not-merge-ready Builder poke: a second only after the PR read waiting (a push), two at most per episode", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const blocked = () => pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("threads:1"), problem: "threads", since: T });
    const waiting = () => pr(s, 7, { verdict: "waiting", reasons: JSON.stringify("checks-running"), problem: null, since: T });
    const l = loop(s), got: string[] = [];
    blocked();
    for (const at of [T, T + 600]) got.push(...eps(await l.tick(at)));
    waiting(); got.push(...eps(await l.tick(T + 610)));
    blocked(); got.push(...eps(await l.tick(T + 620)));
    waiting(); got.push(...eps(await l.tick(T + 1300)));
    blocked(); got.push(...eps(await l.tick(T + 2000)));
    expect(got).toEqual([`poke pr-stale:threads|${T}#1#1`, `poke pr-stale:threads|${T}#2#1`]);
  });

  test("a problem that changes across waiting keeps the episode's two-poke cap (since carries)", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s), got: string[] = [];
    const blocked = (p: string) => pr(s, 7, { verdict: "blocked", reasons: JSON.stringify(p), problem: p, since: T });
    const waiting = () => pr(s, 7, { verdict: "waiting", reasons: JSON.stringify("checks-running"), problem: null, since: T });
    let at = T;
    for (const p of ["threads", "checks-failing", "conflicting", "behind"]) {
      blocked(p); got.push(...eps(await l.tick(at))); at += 700;
      waiting(); got.push(...eps(await l.tick(at))); at += 700;
    }
    expect(got).toEqual([`poke pr-stale:threads|${T}#1#1`, `poke pr-stale:checks-failing|${T}#2#1`]);
  });

  test("a PR that merged or closed clears merge_blocked and pr_stale", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("conflicting"), problem: "conflicting", since: T, stale: 1 });
    worker(s, B, "working");
    const l = loop(s);
    await l.tick(T);
    expect(unit(s, "u1").merge_blocked).toBe("conflicting");
    pr(s, 7, { state: "MERGED", verdict: "merged" });
    await l.tick(T + 5);
    expect([unit(s, "u1").status, unit(s, "u1").merge_blocked, unit(s, "u1").pr_stale]).toEqual(["done", null, null]);
    expect(s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:stale" })).toBeNull();
  });

  test("local-only ship mode: the PR is flagged, the Builder never poked", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    s.upsert("config", { project: "fx", file: "ship-mode", key: "mode" }, { value: "local-only", observed_at: T });
    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("conflicting"), problem: "conflicting", since: T });
    expect(await loop(s).tick(T)).toEqual([]);
    expect(unit(s, "u1").merge_blocked).toBe("conflicting");
  });
});

describe("KTD17: merge-ready Lead poke", () => {
  const ready = (s: Store, set: Row = {}) => pr(s, 7, { base: "main", mergeable: "MERGEABLE", verdict: "ready", since: T, ...set });

  test("one poke at merge-ready, a second after merge_ready_nudge_min, then one Studio alert, and nothing once merged", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    worker(s, LEAD, "idle", null, T - 3600);
    ready(s);
    const l = loop(s), at = (m: number) => T + m * 60;
    const first = await l.tick(T);
    expect(eps(first)).toEqual([`poke merge-ready:${NWO}#7#1#1`]);
    expect(String((first[0].payload as Row).text)).toContain("PR #7 for unit u1 is merge-ready into main");
    expect(await l.tick(at(5))).toEqual([]);
    expect(eps(await l.tick(at(15)))).toEqual([`poke merge-ready:${NWO}#7#2#1`]);
    expect(await l.tick(at(20))).toEqual([]);
    expect(eps(await l.tick(at(30)))).toEqual([`alert merge-ready:${NWO}#7`]);
    expect(await l.tick(at(60))).toEqual([]);
    ready(s, { state: "MERGED", verdict: "merged" });
    expect(eps(await l.tick(at(61)))).toEqual(["poke all-done:done|lc|u1#7#1"]); // the merge made the squad all done; its Builder's wish is archived instead
  });

  test("no poke for a PR whose base is not the default branch, or that is not mergeable", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    worker(s, LEAD, "idle", null, T - 3600);
    ready(s, { base: "release" });
    const l = loop(s);
    expect(await l.tick(T)).toEqual([]);
    ready(s, { base: "main", mergeable: "UNKNOWN" });
    expect(await l.tick(T + 5)).toEqual([]);
  });

  test("a repo with no observed default branch gets no poke", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    s.db.query("DELETE FROM config WHERE key LIKE 'default_branch:%'").run();
    worker(s, LEAD, "idle", null, T - 3600);
    ready(s);
    expect(await loop(s).tick(T)).toEqual([]);
  });

  test("each repo uses its own observed default branch", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    s.upsert("config", { project: "fx", file: "github", key: `default_branch:${NWO}` }, { value: "trunk", observed_at: T });
    worker(s, LEAD, "idle", null, T - 3600);
    ready(s, { base: "main" });
    expect(await loop(s).tick(T)).toEqual([]);
    ready(s, { base: "trunk" });
    const got = await loop(s).tick(T + 5);
    expect(eps(got)).toEqual([`poke merge-ready:${NWO}#7#1#1`]);
    expect(String((got[0].payload as Row).text)).toContain("merge-ready into trunk");
  });
});

describe("10: all-done nudge (finish nudge, sweep-required U9)", () => {
  const merged = () => {
    const r = squad([{ slug: "u1", pr: "7", status: "done" }, { slug: "u2", status: "cancelled" }],
      { members: [{ role: "lead", suffix: "", wt: LEAD }] });
    pr(r.s, 7, { state: "MERGED", verdict: "merged" });
    worker(r.s, LEAD, "idle", null, T - 3600);
    return r;
  };
  const EP = "all-done:done|lc|u1#7";

  test("every done unit merged: all_done_at, and one nudge to the quiet Lead; a repeated tick emits nothing", async () => {
    const { s } = merged(), l = loop(s);
    const acted = await l.tick(T);
    expect(sq(s).all_done_at).toBe(T);
    expect(eps(acted)).toEqual([`poke ${EP}#1`]);
    expect(String((acted[0].payload as Row).text)).toContain("tell the operator to run /ds-close-squad lc");
    expect(await l.tick(T + 5)).toEqual([]);
    expect(events(s, "squad_all_done").length).toBe(1);
  });

  test("an open PR, a dispatched unit, or a Lead quiet for less than DS_SWEEP_DONE_IDLE_MIN: no nudge", async () => {
    const a = merged();
    pr(a.s, 7, { state: "OPEN", verdict: "ready" });
    expect(await loop(a.s).tick(T)).toEqual([]);
    expect(sq(a.s).all_done_at ?? null).toBeNull();

    const b = merged();
    worker(b.s, LEAD, "idle", null, T - 60);
    expect(await loop(b.s).tick(T)).toEqual([]);
    process.env.DS_SWEEP_DONE_IDLE_MIN = "1";
    try { expect(eps(await loop(b.s).tick(T + 1))).toEqual([`poke ${EP}#1`]); } finally { delete process.env.DS_SWEEP_DONE_IDLE_MIN; }
  });

  test("a squad its Lead set done gets no nudge", async () => {
    const { s } = merged();
    s.db.run("UPDATE squads SET status = 'done' WHERE topic = 'lc'");
    expect(await loop(s).tick(T)).toEqual([]);
  });

  test("a notice-limited Lead gets no nudge, and one (not two) once the limit ends", async () => {
    const { s } = merged(), l = loop(s);
    worker(s, LEAD, "idle", "1800003600\tweekly limit", T - 3600);
    expect(await l.tick(T)).toEqual([]);
    worker(s, LEAD, "idle", null, T - 3600);
    expect(eps(await l.tick(T + 5))).toEqual([`poke ${EP}#1`]);
    expect(await l.tick(T + 10)).toEqual([]);
  });

  test("N ticks of an unanswered nudge give capped attempts, then one alert and silence", async () => {
    const { s } = merged(), l = loop(s), got: string[] = [];
    let at = T;
    for (let i = 0; i < pokeCap() + 3; i++) { got.push(...eps(await l.tick(at))); at += pokeGap() * 2 ** i + 1; }
    expect(got.filter((e) => e.startsWith("poke")).length).toBe(pokeCap());
    expect(got.filter((e) => e.startsWith("alert"))).toEqual(["alert poke-capped:all-done:done|lc|u1#7"]);
  });
});

describe("U70: a review ask waits for a ready PR", () => {
  const ask = (n: number, id = "q1") => ({ id, asker: "lead", blocking: true, question: "Review?", since: "2026-11-03T12:00:00Z", pr: n });
  const open = (s: Store) => s.db.query("SELECT id FROM questions WHERE project = 'fx' AND squad = 'lc' AND status = 'open'").all().map((r: any) => r.id);
  const ready = (s: Store, set: Row = {}) => pr(s, 7, { verdict: "waiting", reasons: JSON.stringify("required:signoff"), mergeable: "MERGEABLE", since: T, ...set });

  test("an open question whose PR turns conflicting is closed via reality, and the Lead gets one message", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }], { waiting_on_you: [ask(7)] });
    worker(s, LEAD, "idle", null, T - 3600);
    ready(s);
    const l = loop(s);
    expect(await l.tick(T)).toEqual([]);
    expect(open(s)).toEqual(["q1"]);
    ready(s, { verdict: "blocked", reasons: JSON.stringify("conflicting,required:signoff"), problem: "conflicting" });
    const got = eps(await l.tick(T + 60));
    expect(got).toContain(`poke question-closed:lc/q:q1|PR #7 went back to not ready (conflicting)#1`);
    expect(got.filter((e) => e.includes("question-closed"))).toHaveLength(1);
    expect(open(s)).toEqual([]);
    expect(s.db.query("SELECT answered_via, answer FROM questions WHERE id = 'q1'").get()).toEqual({ answered_via: "reality", answer: "PR #7 went back to not ready (conflicting)" });
    expect(eps(await l.tick(T + 120)).filter((e) => e.includes("question-closed"))).toEqual([]);
  });

  test("a check that has not reported yet after a push (required:<check>) keeps the question open", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }], { waiting_on_you: [ask(7)] });
    ready(s, { reasons: JSON.stringify("required:tests,required:signoff") });
    await loop(s).tick(T);
    expect(open(s)).toEqual(["q1"]);
  });

  test("a PR blocked only by human gates keeps its question open", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }], { waiting_on_you: [ask(7)] });
    ready(s, { reasons: JSON.stringify("required:signoff,checks-running") });
    await loop(s).tick(T);
    expect(open(s)).toEqual(["q1"]);
  });

  describe("stale_lead_min", () => {
    const stale = (s: Store) => pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("threads:1"), problem: "threads", since: T });
    const waiting = (s: Store) => pr(s, 7, { verdict: "waiting", reasons: JSON.stringify("checks-running"), problem: null, since: T });
    async function twoPokes(s: Store) {
      const l = loop(s);
      stale(s); await l.tick(T);
      waiting(s); await l.tick(T + 610);
      stale(s); expect(eps(await l.tick(T + 620))).toEqual([`poke pr-stale:threads|${T}#2#1`]);
      worker(s, LEAD, "idle", null, T - 3600);
      return l;
    }

    test("a PR still stale stale_lead_min after the second Builder poke gives the Lead one request", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]);
      const l = await twoPokes(s);
      expect(await l.tick(T + 620 + 1700)).toEqual([]);
      const got = await l.tick(T + 620 + 1800);
      expect(eps(got)).toEqual([`poke pr-stale-lead:7|${T}#lead#1`]);
      const text = String((got[0].payload as Row).text);
      expect(text).toContain("PR #7");
      expect(text).toContain("threads:1");
      expect(text).toContain("the Builder is idle");
      expect(await l.tick(T + 620 + 3600)).toEqual([]);
    });

    test("a PR that becomes ready ends the stretch", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]);
      const l = await twoPokes(s);
      pr(s, 7, { verdict: "ready", reasons: JSON.stringify(""), problem: null, since: T + 700 });
      await l.tick(T + 700);
      expect(s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:stale-lead" })).toBeNull();
      expect(await l.tick(T + 620 + 1900)).toEqual([]);
    });

    test("stale_lead_min=0 sends nothing", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]);
      const l = await twoPokes(s);
      s.upsert("config", { project: "fx", file: "limits.conf", key: "stale_lead_min" }, { value: "0", observed_at: T });
      expect(await l.tick(T + 620 + 7200)).toEqual([]);
    });
  });
});

describe("U179: a PR waiting only on a Builder-owned required check", () => {
  const W = 900; // required_wait_min's default, 15 min
  const waits = (s: Store, head = "h1", reasons = "required:ship-receipt") =>
    pr(s, 7, { verdict: "waiting", reasons: JSON.stringify(reasons), problem: null, since: T, doc: JSON.stringify({ headRefOid: head }) });
  const rw = (a: Action[]) => eps(a).filter((e) => e.includes("required-wait"));
  const ep = (s: Store) => s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:required-wait" }) as Row | null;
  const asked = (s: Store) => s.db.query("SELECT id FROM questions WHERE project = 'fx' AND squad = 'lc' AND status = 'open'").all().map((r: any) => r.id);
  function setup(extra: Row = {}) {
    const { s } = squad([{ slug: "u1", pr: "7" }], extra);
    worker(s, B, "idle", null, T - 3600);
    worker(s, LEAD, "idle", null, T - 3600);
    waits(s);
    return { s, l: loop(s) };
  }

  test("Builder idle 15 min: one Builder poke naming the context; 15 min later one Lead request; 2 h later nothing", async () => {
    const { l } = setup();
    expect(rw(await l.tick(T))).toEqual([]);
    expect(rw(await l.tick(T + W - 60))).toEqual([]);
    const got = await l.tick(T + W);
    expect(rw(got)).toEqual(["poke required-wait:7|h1|ship-receipt#1"]);
    const text = String((got.find((a) => a.episode?.startsWith("required-wait:"))!.payload as Row).text);
    expect(text).toContain("PR #7");
    expect(text).toContain("waits only on `ship-receipt`");
    expect(text).not.toContain("human gate");
    expect(text).toContain("orch.sh ask your Lead");
    expect(rw(await l.tick(T + 2 * W - 60))).toEqual([]);
    const lead = await l.tick(T + 2 * W);
    expect(rw(lead)).toEqual(["poke required-wait-lead:7|h1|ship-receipt#lead#1"]);
    expect(lead.find((a) => a.episode?.startsWith("required-wait-lead:"))!.member).toBe(LEAD);
    expect(String((lead.find((a) => a.episode?.startsWith("required-wait-lead:"))!.payload as Row).text)).toContain("its Builder was told");
    for (const at of [T + 3 * W, T + 2 * W + 3600, T + 2 * W + 7200]) expect(rw(await l.tick(at))).toEqual([]);
  });

  test("a working Builder is not poked until it has been idle 15 min", async () => {
    const { s, l } = setup();
    worker(s, B, "working", null, T - 3600);
    expect(rw(await l.tick(T))).toEqual([]);
    expect(rw(await l.tick(T + W))).toEqual([]);
    expect(rw(await l.tick(T + 2 * W))).toEqual([]);
    worker(s, B, "idle", null, T + 2 * W);
    expect(rw(await l.tick(T + 3 * W - 60))).toEqual([]);
    expect(rw(await l.tick(T + 3 * W))).toEqual(["poke required-wait:7|h1|ship-receipt#1"]);
  });

  test("a context in human_checks keeps the pr-question path: no required-wait episode or poke", async () => {
    const { s, l } = setup();
    s.upsert("config", { project: "fx", file: "github", key: "human_checks" }, { value: "ship-receipt", observed_at: T });
    expect(rw(await l.tick(T))).toEqual([]);
    expect(ep(s)).toBeNull();
    expect(asked(s)).toEqual(["pr-7"]);
    for (const at of [T + W, T + 2 * W, T + 7200]) expect(rw(await l.tick(at))).toEqual([]);
    // U183: one human gate among the contexts no longer silences the poke: the Builder hears
    // about the contexts it owns alone, while the pr-question path stays quiet.
    const o = setup();
    waits(o.s, "h1", "required:signoff,required:tests");
    expect(rw(await o.l.tick(T))).toEqual([]);
    expect(ep(o.s)).toMatchObject({ episode_key: "7|h1|tests", state: "seen" });
    const ogot = await o.l.tick(T + W);
    expect(rw(ogot)).toEqual(["poke required-wait:7|h1|tests#1"]);
    const otext = String((ogot.find((a) => a.episode?.startsWith("required-wait:"))!.payload as Row).text);
    expect(otext).toContain("`tests`");
    expect(otext).not.toContain("signoff");
    expect(asked(o.s)).toEqual([]);
    for (const at of [T + 2 * W]) expect(rw(await o.l.tick(at))).toEqual(["poke required-wait-lead:7|h1|tests#lead#1"]);
  });

  test("a new head while waiting ends the episode; the later wait pokes once again", async () => {
    const { s, l } = setup();
    await l.tick(T);
    expect(rw(await l.tick(T + W))).toEqual(["poke required-wait:7|h1|ship-receipt#1"]);
    waits(s, "h2");
    expect(rw(await l.tick(T + W + 60))).toEqual([]);
    expect(ep(s)).toMatchObject({ episode_key: "7|h2|ship-receipt", state: "seen", count: 0 });
    expect(rw(await l.tick(T + 2 * W))).toEqual([]);
    expect(rw(await l.tick(T + 2 * W + 60))).toEqual(["poke required-wait:7|h2|ship-receipt#1"]);
    // leaving the wait ends it too
    pr(s, 7, { verdict: "waiting", reasons: JSON.stringify("checks-running"), since: T, doc: JSON.stringify({ headRefOid: "h2" }) });
    await l.tick(T + 2 * W + 120);
    expect(ep(s)).toBeNull();
  });

  test("a GitHub re-read keeps the episode; other missing contexts start over", async () => {
    const { s, l } = setup();
    await l.tick(T);
    waits(s, "h1", "mergeable-unknown,required:ship-receipt");
    expect(rw(await l.tick(T + W))).toEqual([]);
    waits(s);
    expect(rw(await l.tick(T + W + 60))).toEqual(["poke required-wait:7|h1|ship-receipt#1"]);
    waits(s, "h1", "required:ship-receipt,required:tests");
    expect(rw(await l.tick(T + 2 * W + 60))).toEqual([]);
    expect(ep(s)).toMatchObject({ episode_key: "7|h1|ship-receipt,tests", state: "seen" });
  });

  test("required_wait_min 0, or a local-only squad: nothing", async () => {
    const { s, l } = setup();
    s.upsert("config", { project: "fx", file: "limits.conf", key: "required_wait_min" }, { value: "0", observed_at: T });
    for (const at of [T, T + W, T + 2 * W, T + 7200]) expect(rw(await l.tick(at))).toEqual([]);
    const o = setup();
    o.s.upsert("config", { project: "fx", file: "ship-mode", key: "mode" }, { value: "local-only", observed_at: T });
    for (const at of [T, T + W, T + 2 * W, T + 7200]) expect(rw(await o.l.tick(at))).toEqual([]);
  });
});

describe("U183: a mixed human-gate wait pokes its Builder for its part", () => {
  const W = 900; // required_wait_min's default, 15 min
  const waits = (s: Store, head = "h1", reasons = "required:signoff,required:ship-receipt") =>
    pr(s, 7, { verdict: "waiting", reasons: JSON.stringify(reasons), problem: null, since: T, doc: JSON.stringify({ headRefOid: head }) });
  const rw = (a: Action[]) => eps(a).filter((e) => e.includes("required-wait"));
  const ep = (s: Store) => s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:required-wait" }) as Row | null;
  const asked = (s: Store) => s.db.query("SELECT id FROM questions WHERE project = 'fx' AND squad = 'lc' AND status = 'open'").all().map((r: any) => r.id);
  function setup() {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    worker(s, B, "idle", null, T - 3600);
    worker(s, LEAD, "idle", null, T - 3600);
    waits(s);
    return { s, l: loop(s) };
  }

  test("mixed wait: one Builder poke naming ship-receipt only, then one Lead request", async () => {
    const { s, l } = setup();
    expect(rw(await l.tick(T))).toEqual([]);
    expect(ep(s)).toMatchObject({ episode_key: "7|h1|ship-receipt", state: "seen" });
    expect(rw(await l.tick(T + W - 60))).toEqual([]);
    const got = await l.tick(T + W);
    expect(rw(got)).toEqual(["poke required-wait:7|h1|ship-receipt#1"]);
    const text = String((got.find((a) => a.episode?.startsWith("required-wait:"))!.payload as Row).text);
    expect(text).toContain("`ship-receipt`");
    expect(text).not.toContain("signoff");
    expect(text).toContain("besides any human gate");
    // the pr-question path stays quiet while the Builder-owned context blocks
    expect(asked(s)).toEqual([]);
    expect(rw(await l.tick(T + 2 * W - 60))).toEqual([]);
    const lead = await l.tick(T + 2 * W);
    expect(rw(lead)).toEqual(["poke required-wait-lead:7|h1|ship-receipt#lead#1"]);
    for (const at of [T + 3 * W, T + 2 * W + 3600]) expect(rw(await l.tick(at))).toEqual([]);
  });

  test("after ship-receipt is posted only the human gate remains: no required-wait poke, and the pr-question opens", async () => {
    const { s, l } = setup();
    await l.tick(T);
    expect(rw(await l.tick(T + W))).toEqual(["poke required-wait:7|h1|ship-receipt#1"]);
    waits(s, "h1", "required:signoff");
    expect(rw(await l.tick(T + W + 60))).toEqual([]);
    expect(ep(s)).toBeNull();
    expect(asked(s)).toEqual(["pr-7"]);
    for (const at of [T + 2 * W, T + 7200]) expect(rw(await l.tick(at))).toEqual([]);
  });

  test("required:signoff alone: no required-wait poke, and the pr-question opens", async () => {
    const { s, l } = setup();
    waits(s, "h1", "required:signoff");
    expect(rw(await l.tick(T))).toEqual([]);
    expect(ep(s)).toBeNull();
    expect(asked(s)).toEqual(["pr-7"]);
    for (const at of [T + W, T + 2 * W, T + 7200]) expect(rw(await l.tick(at))).toEqual([]);
  });
});

describe("U77: a Builder hears its PR instead of polling", () => {
  const ctxs = (extra: object[] = []) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { __typename: "CheckRun", name: "test", databaseId: 99, status: "COMPLETED", conclusion: "FAILURE", isRequired: false }, ...extra] } } } }] } });
  const news = (s: Store, sha: string, verdict: string, reasons: string, set: Row = {}, doc: Row = {}) =>
    pr(s, 7, { detail: "full", base: "main", mergeable: "MERGEABLE", verdict, reasons: JSON.stringify(reasons), since: T, doc: JSON.stringify({ headRefOid: sha, ...doc }), ...set });
  // step 9's pr-stale poke takes the tick's one poke on a blocked PR; the news follows on the next
  const go = async (l: ReturnType<typeof loop>, at: number) => [...await l.tick(at), ...await l.tick(at + 1)];
  const only = (a: Action[]) => a.filter((x) => String(x.episode).startsWith("pr-news"));
  const text = (a: Action[]) => String((only(a)[0].payload as Row).text);
  // U160: a pr-stale poke covers the PR state it was sent for, so pr-news only shows on its own once the
  // Builder's pr-stale pokes are spent (two sent for this stretch): preseed that.
  const spent = (s: Store) => s.upsert("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:stale" }, { squad: "lc", episode_key: `7|${T}`, count: 2, state: "poked", source: "loop", started_at: T, observed_at: T });
  const blocked = (s: Store, sha: string, reasons: string, doc: Row = {}) => news(s, sha, "blocked", reasons, { problem: null }, doc);

  test("running checks poke nothing; a failed check pokes once naming it; a second tick nothing; a new failing head pokes again", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s); spent(s);
    news(s, "aaa", "waiting", "checks-running");
    expect(only(await go(l, T))).toEqual([]);
    blocked(s, "aaa", "checks-failing", ctxs());
    const first = await go(l, T + 5);
    expect(only(first).map((a) => String(a.episode).replace(/\|[0-9a-f]{8}#/, "|DIGEST#"))).toEqual(["pr-news:pr-news|aaa|blocked|checks-failing|DIGEST#1"]);
    expect(text(first)).toContain("test");
    expect(text(first)).toContain("gh run view --job 99 --log-failed");
    expect(only(await go(l, T + 40))).toEqual([]);
    news(s, "bbb", "waiting", "checks-running"); await go(l, T + 80);
    blocked(s, "bbb", "checks-failing", ctxs());
    expect(only(await go(l, T + 120)).map((a) => String(a.episode).replace(/\|[0-9a-f]{8}#/, "|DIGEST#"))).toEqual(["pr-news:pr-news|bbb|blocked|checks-failing|DIGEST#1"]);
  });

  test("a new open review thread pokes once, and so does merge-ready with the finish-unit line", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s); spent(s);
    blocked(s, "aaa", "threads:1");
    const a = await go(l, T);
    expect(text(a)).toContain("1 open review thread");
    expect(only(await go(l, T + 5))).toEqual([]);
    blocked(s, "aaa", "threads:2");
    expect(only(await go(l, T + 60)).length).toBe(1);
    news(s, "ccc", "ready", "");
    const r = await go(l, T + 120);
    expect(only(r).length).toBe(1);
    expect(text(r)).toMatch(/finish-unit\.sh .*lc\.json u1/);
    expect(only(await go(l, T + 125))).toEqual([]);
  });

  test("a mergeable-unknown re-read does not re-poke the same ready head, and checks-running does not change a thread's key", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s); spent(s);
    news(s, "aaa", "ready", "");
    expect(only(await go(l, T)).length).toBe(1);
    news(s, "aaa", "waiting", "mergeable-unknown"); await go(l, T + 40);
    news(s, "aaa", "ready", "");
    expect(only(await go(l, T + 80))).toEqual([]);
    spent(s); blocked(s, "bbb", "threads:1,checks-running");
    expect(only(await go(l, T + 120)).length).toBe(1);
    blocked(s, "bbb", "threads:1");
    expect(only(await go(l, T + 160))).toEqual([]);
  });

  test("a busy non-Claude Builder gets the poke once it goes idle; local-only and light-detail PRs never poke", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s); spent(s);
    agent(s, B, "codex");
    worker(s, B, "working");
    blocked(s, "aaa", "conflicting");
    expect(only(await go(l, T))).toEqual([]);
    worker(s, B, "idle");
    expect(only(await go(l, T + 70)).length).toBe(1);

    const lo = squad([{ slug: "u1", pr: "7" }]);
    lo.s.upsert("config", { project: "fx", file: "ship-mode", key: "mode" }, { value: "local-only", observed_at: T });
    blocked(lo.s, "aaa", "conflicting");
    expect(only(await go(loop(lo.s), T))).toEqual([]);

    const li = squad([{ slug: "u1", pr: "7" }]);
    blocked(li.s, "aaa", "conflicting"); pr(li.s, 7, { detail: "light" });
    expect(only(await go(loop(li.s), T))).toEqual([]);
  });
});

// U182: a conflicting or behind PR is told to merge the base in, never rebase — unless the
// project sets `base_update rebase`.
describe("U182: merge the base in, not rebase", () => {
  const news = (s: Store, sha: string, verdict: string, reasons: string, set: Row = {}, doc: Row = {}) =>
    pr(s, 7, { detail: "full", base: "main", mergeable: "MERGEABLE", verdict, reasons: JSON.stringify(reasons), since: T, doc: JSON.stringify({ headRefOid: sha, ...doc }), ...set });
  const go = async (l: ReturnType<typeof loop>, at: number) => [...await l.tick(at), ...await l.tick(at + 1)];
  const only = (a: Action[]) => a.filter((x) => String(x.episode).startsWith("pr-news"));
  const text = (a: Action[]) => String((only(a)[0].payload as Row).text);
  // The Builder's pr-stale pokes are spent (two sent for this stretch), so pr-news shows on its own.
  const spent = (s: Store) => s.upsert("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:stale" }, { squad: "lc", episode_key: `7|${T}`, count: 2, state: "poked", source: "loop", started_at: T, observed_at: T });
  const blocked = (s: Store, sha: string, reasons: string) => news(s, sha, "blocked", reasons, { problem: null });

  test("a conflicting PR's pr-news and pr-stale pokes say merge, never rebase", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("conflicting"), problem: "conflicting", since: T });
    const stale = await loop(s).tick(T);
    expect(eps(stale)).toEqual([`poke pr-stale:conflicting|${T}#1#1`]);
    const fix = String((stale[0].payload as Row).text);
    expect(fix).toContain("merge the base in and resolve conflicts");
    expect(fix).not.toContain("rebase");

    const n = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(n.s); spent(n.s);
    blocked(n.s, "aaa", "conflicting");
    const a = await go(l, T);
    expect(only(a).map((x) => x.episode)).toEqual(["pr-news:pr-news|aaa|blocked|conflicting#1"]);
    expect(text(a)).toContain("the branch is conflicting with main: merge main in (not a rebase)");
    expect(text(a)).toContain("the command the repo's AGENTS.md names if it names one");
    expect(text(a)).not.toContain("rebase onto");
  });

  test("a PR stacked on another branch names that base, not the repo default", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s); spent(s);
    news(s, "aaa", "blocked", "conflicting", { problem: null, base: "release" });
    const a = await go(l, T);
    expect(text(a)).toContain("the branch is conflicting with release: merge release in (not a rebase)");
  });

  test("behind alone gets the merge wording too", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s); spent(s);
    blocked(s, "aaa", "behind");
    const a = await go(l, T);
    expect(only(a).map((x) => x.episode)).toEqual(["pr-news:pr-news|aaa|blocked|behind#1"]);
    expect(text(a)).toContain("the branch is behind main: merge main in (not a rebase)");
    expect(text(a)).not.toContain("rebase onto");
  });

  test("base_update rebase keeps today's rebase wording in both pokes", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "base_update" }, { value: "rebase", observed_at: T });
    pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("conflicting"), problem: "conflicting", since: T });
    const stale = await loop(s).tick(T);
    expect(String((stale[0].payload as Row).text)).toContain("rebase/resolve conflicts");

    const n = squad([{ slug: "u1", pr: "7" }]);
    n.s.upsert("config", { project: "fx", file: "limits.conf", key: "base_update" }, { value: "rebase", observed_at: T });
    const l = loop(n.s); spent(n.s);
    blocked(n.s, "aaa", "conflicting");
    expect(text(await go(l, T))).toContain("the branch is conflicting: rebase onto the base, resolve, push.");
  });

  test("anything but rebase reads as merge, and the env var beats the file", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "base_update" }, { value: "MERGE", observed_at: T });
    const l = loop(s); spent(s);
    blocked(s, "aaa", "conflicting");
    expect(text(await go(l, T))).toContain("merge main in (not a rebase)");

    const e = squad([{ slug: "u1", pr: "7" }]);
    e.s.upsert("config", { project: "fx", file: "limits.conf", key: "base_update" }, { value: "rebase", observed_at: T });
    process.env.DS_LIMIT_BASE_UPDATE = "merge";
    try {
      const l2 = loop(e.s); spent(e.s);
      blocked(e.s, "aaa", "conflicting");
      expect(text(await go(l2, T))).toContain("merge main in (not a rebase)");
    } finally {
      delete process.env.DS_LIMIT_BASE_UPDATE;
    }
  });
});

// U148: pr-stale and pr-news reach a `working` Claude Builder; nothing else loosens.
describe("PR pokes to a working Builder (U148)", () => {
  const agentOf = (s: Store, a: string) => agent(s, B, a);
  const st = (s: Store, sha: string, verdict: string, reasons: string, problem: string | null = null) =>
    pr(s, 7, { detail: "full", base: "main", mergeable: "MERGEABLE", verdict, reasons: JSON.stringify(reasons), problem, since: T, doc: JSON.stringify({ headRefOid: sha }) });
  const kinds = (a: Action[], prefix: string) => a.filter((x) => String(x.episode).startsWith(prefix));

  test("a working Claude Builder gets one pr-stale poke for a red PR, and no more while the backoff holds", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s);
    worker(s, B, "working");
    st(s, "aaa", "blocked", "checks-failing", "checks-failing");
    expect(kinds(await l.tick(T), "pr-stale")).toHaveLength(1);
    expect(kinds(await l.tick(T + 5), "pr-stale")).toEqual([]);
    expect(kinds(await l.tick(T + 10), "pr-stale")).toEqual([]);
  });

  test("a working Claude Builder gets one pr-news poke when the verdict changes", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s);
    worker(s, B, "working");
    st(s, "aaa", "ready", "");
    const got = [...await l.tick(T), ...await l.tick(T + 1)];
    expect(kinds(got, "pr-news")).toHaveLength(1);
    expect(kinds([...await l.tick(T + 5), ...await l.tick(T + 6)], "pr-news")).toEqual([]);
  });

  // U160: the pr-stale poke already told the Builder about this PR change, so pr-news waits for a later one.
  test("a working Claude Builder with a failing PR gets one pr-stale and no pr-news on the next tick; a later new head gives one pr-news", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s);
    worker(s, B, "working");
    st(s, "aaa", "blocked", "checks-failing", "checks-failing");
    const first = await l.tick(T);
    expect(kinds(first, "pr-stale")).toHaveLength(1);
    expect(kinds(first, "pr-news")).toEqual([]);
    expect(kinds([...await l.tick(T + 1), ...await l.tick(T + 5), ...await l.tick(T + 10)], "pr-news")).toEqual([]);
    st(s, "bbb", "blocked", "checks-failing", "checks-failing");
    expect(kinds([...await l.tick(T + 40), ...await l.tick(T + 41)], "pr-news").map((a) => a.episode)).toEqual(["pr-news:pr-news|bbb|blocked|checks-failing#1"]);
  });

  test("a later verdict change after a pr-stale poke gives one pr-news; merge-ready is news", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s);
    worker(s, B, "working");
    st(s, "aaa", "blocked", "checks-failing", "checks-failing");
    await l.tick(T); await l.tick(T + 1);
    st(s, "aaa", "ready", "");
    expect(kinds([...await l.tick(T + 40), ...await l.tick(T + 41)], "pr-news")).toHaveLength(1);
  });

  test("an idle Builder gets its pr-stale poke as before and no second poke for the same PR state", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s);
    worker(s, B, "idle");
    st(s, "aaa", "blocked", "checks-failing", "checks-failing");
    const got = [...await l.tick(T), ...await l.tick(T + 1)];
    expect(kinds(got, "pr-stale")).toHaveLength(1);
    expect(kinds(got, "pr-news")).toEqual([]);
  });

  test("a working Codex Builder is skipped:busy for both", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s);
    agentOf(s, "codex");
    worker(s, B, "working");
    st(s, "aaa", "blocked", "checks-failing", "checks-failing");
    const got = [...await l.tick(T), ...await l.tick(T + 1)];
    expect(kinds(got, "pr-stale")).toEqual([]);
    expect(kinds(got, "pr-news")).toEqual([]);
  });

  test("a limit dialog on a working Claude Builder still skips the PR pokes", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s);
    worker(s, B, "working", `${T + 3600}\tlimit reached\tdialog`);
    st(s, "aaa", "blocked", "checks-failing", "checks-failing");
    const got = [...await l.tick(T), ...await l.tick(T + 1)];
    expect(kinds(got, "pr-stale")).toEqual([]);
    expect(kinds(got, "pr-news")).toEqual([]);
  });

  test("a working Lead still gets no merge-ready poke", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]);
    const l = loop(s);
    worker(s, B, "working"); worker(s, LEAD, "working");
    st(s, "aaa", "ready", "");
    const got = [...await l.tick(T), ...await l.tick(T + 1)];
    expect(kinds(got, "merge-ready")).toEqual([]);
  });
});

// U178: a red PR is one stretch until it goes green, and its pokes are bounded within it.
describe("U178: one red stretch, bounded pokes", () => {
  const P = 600; // ten minutes a tick: each tick polls
  type Read = { head: string; conflicting?: boolean; checks?: Record<string, "SUCCESS" | "FAILURE" | "RUNNING">; threads?: number; run?: number; lanes?: Record<string, "SUCCESS" | "FAILURE">; optional?: boolean };
  function observed(s: Store) {
    const prs = new Map<number, any>();
    const read = (o: Read) => {
      const n = fromFixture("ready", { number: 7, head: "feat-u1", base: "main", nwo: NWO });
      n.headRefOid = o.head;
      if (o.conflicting) { n.mergeable = "CONFLICTING"; n.mergeStateStatus = "DIRTY"; }
      n.commits.nodes[0].commit.statusCheckRollup.contexts.nodes = Object.entries(o.checks ?? { test: "SUCCESS" }).map(([name, c], i) => ({
        __typename: "CheckRun", name, databaseId: 100 + i + (o.run ?? 0) * 1000, isRequired: !o.optional, status: c === "RUNNING" ? "IN_PROGRESS" : "COMPLETED", conclusion: c === "RUNNING" ? null : c }));
      n.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.push(...Object.entries(o.lanes ?? {}).map(([name, c], i) => ({
        __typename: "CheckRun", name, databaseId: 500 + i + (o.run ?? 0) * 1000, isRequired: false, status: "COMPLETED", conclusion: c })));
      n.reviewThreads = { nodes: Array.from({ length: o.threads ?? 0 }, () => ({ isResolved: false })) };
      prs.set(7, n);
    };
    const gh = fakeGithub(new Map([[NWO, { defaultBranch: "main", prs }]]));
    const observer = githubObserver({ gh: gh.run, resolve: () => ({ owner: "o", name: "r" }), budgetMs: 1000 });
    const got: string[] = [];
    const act: Actuator = { act() {} };
    const l = new Loop(s, { observers: [observer], reconcilers: [lifecycle] }, act, { projects: () => ["fx"] });
    l.boot(T);
    // These cases pin the push-driven path; U275's quiet second nudge has its own cases below.
    s.upsert("config", { project: "fx", file: "limits.conf", key: "stale_repoke_min" }, { value: "0", observed_at: T });
    const texts: string[] = [];
    const cards: Row[] = [];
    const tick = async (at: number) => { const r = (await l.tick(at)).acted; cards.push(...r.filter((a) => a.kind === "alert" && String(a.episode).startsWith("pr-stale:")).map((a) => a.payload as Row)); texts.push(...r.filter((a) => String(a.episode).startsWith("pr-news")).map((a) => String((a.payload as Row).text))); const e = eps(r); got.push(...e.map((x) => `${at - T} ${x}`)); return e; };
    return { read, tick, got, texts, cards };
  }
  const count = (got: string[], prefix: string) => got.filter((e) => e.split(" ").slice(1).join(" ").startsWith(prefix)).length;
  const red = { test: "FAILURE" as const };

  test("reshuffled reasons on one head over hours: 2 pr-stale, 1 Lead request, 1 Studio alert, no pr-news", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
    worker(s, LEAD, "idle", null, T - 3600);
    let at = T;
    o.read({ head: "aaa", conflicting: true, checks: red }); await o.tick(at);
    expect((s.get("observed_prs", { project: "fx", ref: `${NWO}#7` }) as Row).verdict).toBe("blocked");
    o.read({ head: "aaa", checks: red }); await o.tick(at += P);
    o.read({ head: "aaa", conflicting: true, checks: red }); await o.tick(at += P);
    o.read({ head: "bbb", checks: { test: "RUNNING" } }); await o.tick(at += P); // the Builder pushed
    for (let i = 0; at < T + 4 * 3600; i++) {
      o.read({ head: "bbb", conflicting: i % 2 === 0, checks: red });
      await o.tick(at += P);
    }
    expect(count(o.got, "poke pr-stale:")).toBe(2);
    expect(count(o.got, "poke pr-stale-lead:")).toBe(1);
    expect(count(o.got, "poke pr-news:")).toBe(0);
    const alerts = o.got.filter((e) => e.includes(" alert pr-stale:"));
    expect(alerts).toHaveLength(1);
    // U4: the card carries its kind and PR so the loop can clear it when the PR merges or closes.
    expect(o.cards).toHaveLength(1);
    expect(o.cards[0]).toMatchObject({ title: "Red PR still blocked", card: "pr_stale", fields: { ref: `${NWO}#7`, pr: 7 } });
    const lead = Number(o.got.find((e) => e.includes(" poke pr-stale-lead:"))!.split(" ")[0]);
    expect(Number(alerts[0].split(" ")[0])).toBeGreaterThanOrEqual(lead + 60 * 60);
    expect(Number(alerts[0].split(" ")[0])).toBeLessThan(lead + 60 * 60 + P + 1);
  });

  test("same head: a check that was green failing is 1 pr-news; reasons dropping and returning are 0", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
    let at = T;
    o.read({ head: "aaa", conflicting: true }); await o.tick(at);
    expect(count(o.got, "poke pr-stale:")).toBe(1);
    o.read({ head: "aaa", conflicting: true, checks: red }); await o.tick(at += P); await o.tick(at += 1);
    expect(count(o.got, "poke pr-news:")).toBe(1);
    for (const r of [{ conflicting: true }, { conflicting: true, checks: red }, { checks: red }, { conflicting: true, checks: red }, { conflicting: true }, { conflicting: true, checks: red }]) {
      o.read({ head: "aaa", ...r }); await o.tick(at += P); await o.tick(at += 1);
    }
    expect(count(o.got, "poke pr-news:")).toBe(1);
    o.read({ head: "aaa", conflicting: true, checks: red, threads: 1 }); await o.tick(at += P); await o.tick(at += 1);
    expect(count(o.got, "poke pr-news:")).toBe(2); // a new review thread is news
    expect(count(o.got, "poke pr-stale:")).toBe(1);
  });

  test("a new head pushed, still red: 1 pr-news", async () => {
    const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
    let at = T;
    o.read({ head: "aaa", checks: red }); await o.tick(at);
    o.read({ head: "bbb", checks: { test: "RUNNING" } }); await o.tick(at += P);
    o.read({ head: "bbb", checks: red }); await o.tick(at += P);
    expect(count(o.got, "poke pr-stale:")).toBe(2); // the second pr-stale told it about bbb
    expect(count(o.got, "poke pr-news:")).toBe(0);
    o.read({ head: "ccc", checks: { test: "RUNNING" } }); await o.tick(at += P);
    o.read({ head: "ccc", checks: red }); await o.tick(at += P); await o.tick(at += 1);
    o.read({ head: "ccc", checks: { test: "RUNNING" } }); await o.tick(at += P); await o.tick(at += 1); // a re-run of the same check
    o.read({ head: "ccc", checks: red }); await o.tick(at += P); await o.tick(at += 1);
    expect(o.got.filter((e) => e.includes(" poke pr-news:")).map((e) => e.split(" ").slice(1).join(" ").replace(/\|[0-9a-f]{8}#/, "|DIGEST#"))).toEqual(["poke pr-news:pr-news|ccc|blocked|checks-failing|DIGEST#1"]);
    expect(count(o.got, "poke pr-stale:")).toBe(2);
  });

  // U214: a check that ran again and failed again on a head already told about.
  describe("U214: a failed rerun", () => {
    const M = 60;
    const news = (got: string[]) => got.filter((e) => e.includes(" poke pr-news:"));
    // Two pr-stale pokes spent, a failed run 0 told (pr-stale/pr-news), then idle ticks to the end of the first wait.
    async function told(o: ReturnType<typeof observed>, extra: Partial<Read> = {}) {
      o.read({ head: "aaa", checks: red, ...extra }); await o.tick(T);
      o.read({ head: "aaa", checks: red, ...extra }); await o.tick(T + P);
      o.read({ head: "aaa", checks: red, ...extra }); await o.tick(T + 2 * P);
      // the wait runs from the last poke of any kind
      return T + Math.max(...o.got.filter((e) => e.includes(" poke pr-")).map((e) => Number(e.split(" ")[0])));
    }
    test("rerun before red_repoke_min: nothing; after it exactly one poke under a new key naming the lanes; then nothing", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
      let at = await told(o, { lanes: { "Unit Tests": "FAILURE" } });
      const before = news(o.got).length;
      o.read({ head: "aaa", checks: red, run: 1, lanes: { "Unit Tests": "FAILURE", "Static Checks": "FAILURE" } }); await o.tick(at += 5 * M);
      expect(news(o.got)).toHaveLength(before);
      const a = await (async () => { o.read({ head: "aaa", checks: red, run: 1, lanes: { "Unit Tests": "FAILURE", "Static Checks": "FAILURE" } }); return o.tick(at += 20 * M); })();
      expect(a.filter((e) => e.startsWith("poke pr-news:"))).toHaveLength(1);
      expect(news(o.got).length).toBe(before + 1);
      await o.tick(at += M); await o.tick(at += P);
      expect(news(o.got).length).toBe(before + 1);
    });
    test("the poke text lists the non-required lanes that failed", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
      const at = await told(o, { lanes: { "Unit Tests": "FAILURE", Lint: "SUCCESS" } });
      o.read({ head: "aaa", checks: red, run: 1, lanes: { "Unit Tests": "FAILURE", "Static Checks": "FAILURE", Lint: "SUCCESS" } }); await o.tick(at + 30 * M);
      expect(o.texts.pop()).toContain("checks failed: test (lanes failed: Unit Tests, Static Checks)");
    });
    test("the same failed run flapping away and back is not news", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
      let at = await told(o);
      const before = news(o.got).length;
      for (let i = 0; i < 4; i++) {
        o.read({ head: "aaa", checks: { test: "RUNNING" } }); await o.tick(at += 30 * M);
        o.read({ head: "aaa", checks: red }); await o.tick(at += 30 * M);
      }
      expect(news(o.got)).toHaveLength(before);
    });
    test("red_repoke_min 0: a rerun failure is never news; a new head still is", async () => {
      process.env.DS_LOOP_RED_REPOKE_MIN = "0";
      try {
        const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
        let at = await told(o);
        const before = news(o.got).length;
        o.read({ head: "aaa", checks: red, run: 1 }); await o.tick(at += 120 * M); await o.tick(at += 120 * M);
        expect(news(o.got)).toHaveLength(before);
        o.read({ head: "bbb", checks: red, run: 2 }); await o.tick(at += M); await o.tick(at += 1);
        expect(news(o.got).length + count(o.got, "poke pr-stale:")).toBeGreaterThan(before);
      } finally { delete process.env.DS_LOOP_RED_REPOKE_MIN; }
    });
    test("a working Builder gets no repeat; at most two repeats a head; a new head resets the count", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
      let at = await told(o);
      const base = news(o.got).length;
      worker(s, B, "working");
      o.read({ head: "aaa", checks: red, run: 1 }); await o.tick(at += 30 * M); await o.tick(at += 30 * M);
      expect(news(o.got)).toHaveLength(base);
      worker(s, B, "idle");
      for (const run of [1, 2, 3, 4]) { o.read({ head: "aaa", checks: red, run }); await o.tick(at += 30 * M); await o.tick(at += 30 * M); }
      expect(news(o.got)).toHaveLength(base + 2);
      o.read({ head: "bbb", checks: { test: "RUNNING" } }); await o.tick(at += 30 * M);
      o.read({ head: "bbb", checks: red, run: 5 }); await o.tick(at += 30 * M); await o.tick(at += 30 * M);
      const afterNew = news(o.got).length;
      for (const run of [6, 7, 8]) { o.read({ head: "bbb", checks: red, run }); await o.tick(at += 30 * M); await o.tick(at += 30 * M); }
      expect(news(o.got).length - afterNew).toBe(2);
    });
    test("a PR with no required checks: a rerun of a failed check is news after the wait", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]), o = observed(s);
      let at = await told(o, { optional: true });
      const base = news(o.got).length;
      o.read({ head: "aaa", checks: red, optional: true, run: 1 }); await o.tick(at += 30 * M);
      expect(news(o.got)).toHaveLength(base + 1);
    });
  });

  describe("rows", () => {
    const stale = (s: Store) => pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("threads:1"), problem: "threads", since: T });
    const waiting = (s: Store) => pr(s, 7, { verdict: "waiting", reasons: JSON.stringify("checks-running"), problem: null, since: T });
    const place = (s: Store, col: "placed_at" | "cleared_at", at: number) => s.db.query(`UPDATE members SET ${col} = ? WHERE wt = ?`).run(at, B);
    async function twoPokes(s: Store) {
      const l = loop(s);
      stale(s); await l.tick(T);
      waiting(s); await l.tick(T + 610);
      stale(s); expect(eps(await l.tick(T + 620))).toEqual([`poke pr-stale:threads|${T}#2#1`]);
      return l;
    }
    const pokes = (a: Action[]) => eps(a).filter((e) => e.startsWith("poke pr-stale:"));

    test("a Builder placed after the 2nd poke gets 1 extra pr-stale, placed again 1 more; no placement none", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]);
      const l = await twoPokes(s);
      for (const at of [T + 1200, T + 1800]) expect(pokes(await l.tick(at))).toEqual([]);
      place(s, "placed_at", T + 2000);
      worker(s, B, "working");
      expect(pokes(await l.tick(T + 2100))).toEqual([]); // a busy new session waits for idle
      worker(s, B, "idle");
      const got = await l.tick(T + 2200);
      expect(pokes(got)).toEqual([`poke pr-stale:threads|${T}#s${T + 2000}#1`]);
      expect(String((got[0].payload as Row).text)).toContain("an earlier session of yours was told");
      for (const at of [T + 2800, T + 3400]) expect(pokes(await l.tick(at))).toEqual([]);
      place(s, "cleared_at", T + 3500);
      expect(pokes(await l.tick(T + 4000))).toEqual([`poke pr-stale:threads|${T}#s${T + 3500}#1`]);
      expect(pokes(await l.tick(T + 4600))).toEqual([]);
      const ep = s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:stale" }) as Row;
      expect([ep.count, ep.next_at]).toEqual([2, T + 620]); // the Lead's clock still runs from the second poke
    });

    test("a placement before the last poke is no fresh session", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]);
      place(s, "placed_at", T - 60);
      const l = await twoPokes(s);
      for (const at of [T + 1200, T + 1800, T + 2400]) expect(pokes(await l.tick(at))).toEqual([]);
    });

    test("stale_alert_min 0: the Lead request, then no alert", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]);
      s.upsert("config", { project: "fx", file: "limits.conf", key: "stale_alert_min" }, { value: "0", observed_at: T });
      const l = await twoPokes(s);
      worker(s, LEAD, "idle", null, T - 3600);
      expect(eps(await l.tick(T + 620 + 1800))).toEqual([`poke pr-stale-lead:7|${T}#lead#1`]);
      const later = [...await l.tick(T + 620 + 1800 + 7200), ...await l.tick(T + 620 + 1800 + 14400)];
      expect(eps(later).filter((e) => e.startsWith("alert"))).toEqual([]);
    });

    test("stale_alert_min after the Lead request: one alert per stretch, then silence", async () => {
      const { s } = squad([{ slug: "u1", pr: "7" }]);
      const l = await twoPokes(s);
      worker(s, LEAD, "idle", null, T - 3600);
      const lead = T + 620 + 1800;
      await l.tick(lead);
      expect(eps(await l.tick(lead + 3599))).toEqual([]);
      const a = await l.tick(lead + 3600);
      expect(eps(a)).toEqual([`alert pr-stale:${NWO}#7|${T}`]);
      expect(String((a[0].payload as Row).text)).toContain("PR #7 (lc/u1) is still not merge-ready (threads:1)");
      expect(await l.tick(lead + 9000)).toEqual([]);
    });

    // U275: the second pr-stale nudge after stale_repoke_min of quiet, no push needed.
    describe("U275 quiet second nudge", () => {
      const Q = 60;
      const out = (s: Store, at: number | null) => s.upsert("observed_workers", { project: "fx", wt: B }, { last_output_at: at });
      const cpu = (s: Store, pct: number) => s.upsert("observed_procs", { project: "fx", wt: B }, { procs: 1, rss_kb: 1, cpu_pct: pct, observed_at: T });
      const firstPoke = async (s: Store) => { const l = loop(s); stale(s); expect(pokes(await l.tick(T))).toEqual([`poke pr-stale:threads|${T}#1#1`]); return l; };
      const epRow = (s: Store) => s.get("episodes", { project: "fx", subject: "lc/u1", kind: "lifecycle:stale" }) as Row;

      test("29 min of quiet: nothing; 31 min: the second nudge, then the Lead 30 min later and the alert 120 after", async () => {
        const { s } = squad([{ slug: "u1", pr: "7" }]);
        const l = await firstPoke(s);
        expect(pokes(await l.tick(T + 29 * Q))).toEqual([]);
        const got = await l.tick(T + 31 * Q);
        expect(pokes(got)).toEqual([`poke pr-stale:threads|${T}#2#1`]);
        expect(String((got[0].payload as Row).text)).toContain("nothing has changed for 30 min");
        expect([epRow(s).count, epRow(s).next_at]).toEqual([2, T + 31 * Q]);
        expect(pokes(await l.tick(T + 40 * Q))).toEqual([]);
        worker(s, LEAD, "idle", null, T - 3600);
        const lead = T + 31 * Q + 30 * Q;
        expect(eps(await l.tick(lead))).toEqual([`poke pr-stale-lead:7|${T}#lead#1`]);
        expect(eps(await l.tick(lead + 7200))).toEqual([`alert pr-stale:${NWO}#7|${T}`]);
      });
      test("a check still running is never quiet", async () => {
        const { s } = squad([{ slug: "u1", pr: "7" }]);
        const l = await firstPoke(s);
        pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("threads:1,checks-running"), problem: "threads", since: T });
        expect(pokes(await l.tick(T + 90 * Q))).toEqual([]);
      });
      test("a working Builder waits until it is idle", async () => {
        const { s } = squad([{ slug: "u1", pr: "7" }]);
        const l = await firstPoke(s);
        worker(s, B, "working");
        expect(pokes(await l.tick(T + 40 * Q))).toEqual([]);
        worker(s, B, "idle");
        expect(pokes(await l.tick(T + 41 * Q))).toEqual([`poke pr-stale:threads|${T}#2#1`]);
      });
      test("a busy worktree (cpu 40) is not quiet", async () => {
        const { s } = squad([{ slug: "u1", pr: "7" }]);
        const l = await firstPoke(s);
        cpu(s, 40);
        expect(pokes(await l.tick(T + 40 * Q))).toEqual([]);
        cpu(s, 2);
        expect(pokes(await l.tick(T + 41 * Q))).toEqual([`poke pr-stale:threads|${T}#2#1`]);
      });
      // board-empty-state-and-port U4: Orca reads the Builder `working`, but liveness's atPrompt reads it at
      // its prompt (transcript still for prompt_wait_min, CPU under 5 %, only a background task open).
      describe("a Builder that only looks busy", () => {
        const use = (id: string, input: Row = {}) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
        const res = (id: string, content = "ok") => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
        const BG = [use("a", { command: "until ! pgrep -f review-unit.sh; do sleep 5; done", run_in_background: true }), res("a", "Command running in background with ID: bx1")];
        // The Builder's transcript (last written at `mtime`) and a terminal Orca reads `working`, its screen moving.
        function busy(s: Store, root: string, lines: string[], mtime = T) {
          const path = join(root, "b1.jsonl");
          writeFileSync(path, lines.join("\n") + "\n");
          s.upsert("observed_transcripts", { path }, { project: "fx", wt: B, mtime, size: 1, observed_at: T });
          cpu(s, 2);
          worker(s, B, "working");
        }
        const at = async (s: Store, l: { tick: (at: number) => Promise<Action[]> }, m: number) => { out(s, T + m * Q); return l.tick(T + m * Q); };

        test("at its prompt with a background task: the second nudge after stale_repoke_min, then the Lead and the alert", async () => {
          const { s, root } = squad([{ slug: "u1", pr: "7" }]);
          const l = await firstPoke(s);
          busy(s, root, BG);
          expect(pokes(await at(s, l, 29))).toEqual([]);
          const got = await at(s, l, 31);
          expect(pokes(got)).toEqual([`poke pr-stale:threads|${T}#2#1`]);
          expect(String((got[0].payload as Row).text)).toContain("nothing has changed for 30 min");
          expect([epRow(s).count, epRow(s).next_at]).toEqual([2, T + 31 * Q]);
          worker(s, LEAD, "idle", null, T - 3600);
          const lead = T + 31 * Q + 30 * Q;
          expect(eps(await at(s, l, 61))).toEqual([`poke pr-stale-lead:7|${T}#lead#1`]);
          expect(eps(await l.tick(lead + 7200))).toEqual([`alert pr-stale:${NWO}#7|${T}`]);
        });
        test("the clock counts from its transcript's last write, not the moving screen", async () => {
          const { s, root } = squad([{ slug: "u1", pr: "7" }]);
          const l = await firstPoke(s);
          busy(s, root, BG, T + 10 * Q);
          expect(pokes(await at(s, l, 31))).toEqual([]);
          expect(pokes(await at(s, l, 41))).toEqual([`poke pr-stale:threads|${T}#2#1`]);
        });
        test("a truly working Builder gets none: its transcript moving, or a foreground call open", async () => {
          const { s, root } = squad([{ slug: "u1", pr: "7" }]);
          const l = await firstPoke(s);
          busy(s, root, BG, T + 85 * Q);
          expect(pokes(await at(s, l, 90))).toEqual([]);
          busy(s, root, [...BG, use("b", { command: "CI_JOBS=4 tests/ci.sh" })]);
          expect(pokes(await at(s, l, 91))).toEqual([]);
          busy(s, root, BG);
          cpu(s, 40);
          expect(pokes(await at(s, l, 92))).toEqual([]);
          expect(epRow(s).count).toBe(1);
        });
      });
      // board-empty-state-and-port U4 fix 2: a second poke due but never sent does not freeze the ladder.
      test.each([
        ["really working", (s: Store) => worker(s, B, "working")],
        ["limited", (s: Store) => worker(s, B, "idle", "limited")],
      ])("a Builder %s never gets the second poke: the Lead at repoke + lead min, the card 60 min later, once each", async (_why, block) => {
        const { s } = squad([{ slug: "u1", pr: "7" }]);
        const l = await firstPoke(s);
        block(s);
        worker(s, LEAD, "idle", null, T - 3600);
        expect(eps(await l.tick(T + 59 * Q))).toEqual([]);
        const req = await l.tick(T + 60 * Q);
        expect(eps(req)).toEqual([`poke pr-stale-lead:7|${T}#lead#1`]);
        expect(String((req[0].payload as Row).text)).toContain("60 min after its Builder's first pr-stale poke (the second, due 30 min after it, could not be sent)");
        expect(epRow(s).count).toBe(1);
        expect(eps(await l.tick(T + 119 * Q))).toEqual([]);
        const card = await l.tick(T + 120 * Q);
        expect(eps(card)).toEqual([`alert pr-stale:${NWO}#7|${T}`]);
        expect(String((card[0].payload as Row).text)).toContain("60 min after its Lead was told, and its Builder was poked once (a second poke could not be sent)");
        expect(eps(await l.tick(T + 300 * Q))).toEqual([]);
      });
      test("stale_repoke_min 0: no due time, so no Lead request after one poke", async () => {
        const { s } = squad([{ slug: "u1", pr: "7" }]);
        s.upsert("config", { project: "fx", file: "limits.conf", key: "stale_repoke_min" }, { value: "0", observed_at: T });
        const l = await firstPoke(s);
        worker(s, LEAD, "idle", null, T - 3600);
        expect(eps(await l.tick(T + 600 * Q))).toEqual([]);
      });
      // board-empty-state-and-port U4 fix 3: the card's default wait is 60 min after the Lead's request.
      test("stale_alert_min defaults to 60", async () => {
        const { s } = squad([{ slug: "u1", pr: "7" }]);
        const l = await firstPoke(s);
        expect(pokes(await l.tick(T + 31 * Q))).toEqual([`poke pr-stale:threads|${T}#2#1`]);
        worker(s, LEAD, "idle", null, T - 3600);
        expect(eps(await l.tick(T + 61 * Q))).toEqual([`poke pr-stale-lead:7|${T}#lead#1`]);
        expect(eps(await l.tick(T + 120 * Q))).toEqual([]);
        expect(eps(await l.tick(T + 121 * Q))).toEqual([`alert pr-stale:${NWO}#7|${T}`]);
      });
      test("the clock counts from the Builder's last output", async () => {
        const { s } = squad([{ slug: "u1", pr: "7" }]);
        const l = await firstPoke(s);
        out(s, T + 25 * Q);
        expect(pokes(await l.tick(T + 31 * Q))).toEqual([]);
        expect(pokes(await l.tick(T + 56 * Q))).toEqual([`poke pr-stale:threads|${T}#2#1`]);
      });
      test("stale_repoke_min 0 keeps today's behaviour: no second nudge without a push", async () => {
        const { s } = squad([{ slug: "u1", pr: "7" }]);
        s.upsert("config", { project: "fx", file: "limits.conf", key: "stale_repoke_min" }, { value: "0", observed_at: T });
        const l = await firstPoke(s);
        expect(pokes(await l.tick(T + 600 * Q))).toEqual([]);
        expect(epRow(s).count).toBe(1);
      });
      test("nudges name each open thread (author, file:line, link) and no comment body", async () => {
        const { s } = squad([{ slug: "u1", pr: "7" }]);
        const nodes = [
          { isResolved: true, path: "done.ts", line: 1, comments: { nodes: [{ author: { login: "carol" }, url: "https://x/c0", body: "SECRET-BODY" }] } },
          { isResolved: false, path: "a.ts", line: 3, comments: { nodes: [{ author: { login: "alice" }, url: "https://x/c1", body: "SECRET-BODY" }] } },
          { isResolved: false, path: "b.ts", line: null, comments: { nodes: [{ author: { login: "bob" }, url: "https://x/c2" }] } },
        ];
        pr(s, 7, { verdict: "blocked", reasons: JSON.stringify("threads:2"), problem: "threads", since: T, doc: JSON.stringify({ reviewThreads: { nodes } }) });
        const l = loop(s), got = await l.tick(T);
        const text = String(got.find((a) => String(a.episode).startsWith("pr-stale:threads"))?.payload && (got[0].payload as Row).text);
        expect(text).toContain("alice on a.ts:3 https://x/c1; bob on b.ts https://x/c2");
        expect(text).not.toContain("carol");
        expect(text).not.toContain("SECRET-BODY");
      });
    });
  });
});

describe("U238: a retest is due (one all-done rule, one nudge per fix round)", () => {
  const PASS = T - 10_000;
  // A feature squad whose Tester pass ended at PASS; the given units reached done after it (merged PRs).
  const round = (slugs: string[], extraUnits: Unit[] = [], tester = false) => {
    const r = squad([...slugs.map((slug, i) => ({ slug, pr: String(7 + i), status: "done" })), ...extraUnits],
      { members: [{ role: "lead", suffix: "", wt: LEAD }, ...(extraUnits.length ? [{ role: "builder", suffix: "u2", wt: B }] : []), ...(tester ? [{ role: "tester", suffix: "x", wt: "wt-t2::/ws/ds-tester-x-lc" }] : [])] });
    slugs.forEach((slug, i) => {
      pr(r.s, 7 + i, { state: "MERGED", verdict: "merged" });
      r.s.db.run("INSERT INTO events (at, project, squad, unit, kind) VALUES (?, 'fx', 'lc', ?, 'unit_done')", [PASS + 100 * (i + 1), slug]);
    });
    r.s.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, 'fx', 'lc', 'wt-t', 'tester_pass_done', '{}')", [PASS]);
    worker(r.s, LEAD, "idle", null, T - 3600);
    return r;
  };

  test("two units done after the pass: one wake naming both, none on the same tick again; a third unit is a new wake", async () => {
    const { s } = round(["u1", "u2"]), l = loop(s);
    const acted = await l.tick(T);
    expect(eps(acted)).toEqual(["poke retest-due:retest|lc|u1#7,u2#8#1"]);
    const text = String((acted[0].payload as Row).text);
    expect(text).toContain("u1 #7, u2 #8");
    expect(text).toContain("ds request tester --suffix");
    expect(text).toContain("stop the squad's existing env with the registered stop command and bring up a fresh one");
    expect(text).toContain("add-cleanup");
    expect(sq(s).all_done_at ?? null).toBeNull();
    expect(await l.tick(T + 5)).toEqual([]);
    s.db.run("INSERT INTO units (project, squad, slug, status, pr, observed_at, updated_at) VALUES ('fx', 'lc', 'u3', 'done', '9', ?, ?)", [T, T]);
    pr(s, 9, { state: "MERGED", verdict: "merged" });
    s.db.run("INSERT INTO events (at, project, squad, unit, kind) VALUES (?, 'fx', 'lc', 'u3', 'unit_done')", [T - 50]);
    expect(eps(await l.tick(T + 10))).toEqual(["poke retest-due:retest|lc|u1#7,u2#8,u3#9#1"]);
  });

  test("a unit still dispatched, or a Tester up: no wake", async () => {
    const a = round(["u1"], [{ slug: "u2", status: "planned", builder_wt: "" }]);
    expect(await loop(a.s).tick(T)).toEqual([]);
    a.s.db.run("UPDATE units SET status = 'dispatched' WHERE slug = 'u2'");
    expect(retestDue(a.s.db, "fx", "lc")).toBeNull();
    a.s.db.run("UPDATE units SET status = 'done' WHERE slug = 'u2'");
    expect(retestDue(a.s.db, "fx", "lc")?.units.map((x) => x.slug)).toEqual(["u1"]); // u2 is done, but not after the pass
    const b = round(["u1"], [], true);
    expect(retestDue(b.s.db, "fx", "lc")).toBeNull();
    expect(eps(await loop(b.s).tick(T)).filter((e) => e.includes("retest"))).toEqual([]);
  });

  test("no unit done after the pass: no retest wake, and the all-done nudge as usual", async () => {
    const { s } = round(["u1"]);
    s.db.run("UPDATE events SET at = ? WHERE kind = 'unit_done'", [PASS - 5]);
    expect(eps(await loop(s).tick(T))).toEqual(["poke all-done:done|lc|u1#7#1"]);
  });

  test("all done: done units with no PR, a CLOSED PR and a 4-day-old OPEN row count; a fresh OPEN row does not; wake.ts agrees", async () => {
    const { s } = squad([{ slug: "u1", status: "done" }, { slug: "u2", pr: "8", status: "done" }, { slug: "u3", pr: "9", status: "done" }], { members: [{ role: "lead", suffix: "", wt: LEAD }] });
    pr(s, 8, { state: "CLOSED", verdict: "closed" });
    pr(s, 9, { state: "OPEN", verdict: "ready", observed_at: T - 4 * 86400 });
    worker(s, LEAD, "idle", null, T - 3600);
    const l = loop(s);
    expect(eps(await l.tick(T))).toEqual(["poke all-done:done|lc|u1#null,u2#8,u3#9#1"]);
    expect(allDoneWake(s, "fx", "lc", T)).toBe(true);
    pr(s, 9, { state: "OPEN", verdict: "ready", observed_at: T });
    expect(allDoneAt(s, T)).toBe(false);
  });
});
const allDoneAt = (s: Store, at: number) => allDoneIn(s.db, "fx", "lc", at);

describe("squad-done-definition U1: a held unit is open work, not finished", () => {
  // u1 merged; u2 held in one of the three hold kinds (state.md: plan, follow-up, reasoned).
  const held = (hold: Row = {}) => {
    const r = squad([{ slug: "u1", pr: "7", status: "done" }, { slug: "u2", status: "planned", hold: true, builder_wt: "", ...hold }],
      { members: [{ role: "lead", suffix: "", wt: LEAD }] });
    pr(r.s, 7, { state: "MERGED", verdict: "merged" });
    worker(r.s, LEAD, "idle", null, T - 3600);
    return r;
  };

  test("a held-only squad gets no all_done_at and no all-done poke, for every hold kind", async () => {
    for (const kind of [{ hold_by: "plan" }, { hold_by: "parked" }, { hold_reason: "operator freeze" }, {}]) {
      const { s } = held(kind), l = loop(s);
      expect(eps(await l.tick(T)).filter((e) => e.includes("all-done"))).toEqual([]);
      expect(sq(s).all_done_at ?? null).toBeNull();
      expect(allDoneAt(s, T)).toBe(false);
      expect(allDoneWake(s, "fx", "lc", T)).toBe(false);
    }
  });

  test("cancelling the held unit makes it all done; holding a unit again clears all_done_at", async () => {
    const { s } = held(), l = loop(s);
    await l.tick(T);
    s.db.run("UPDATE units SET status = 'cancelled' WHERE slug = 'u2'");
    expect(eps(await l.tick(T + 5))).toEqual(["poke all-done:done|lc|u1#7#1"]);
    expect(sq(s).all_done_at).toBe(T + 5);
    s.db.run("UPDATE units SET status = 'planned', hold = 1 WHERE slug = 'u2'");
    await l.tick(T + 10);
    expect(sq(s).all_done_at ?? null).toBeNull();
  });

  test("an all-done card left on a squad that has a held unit settles", () => {
    const { s } = held();
    s.upsert("episodes", { project: "fx", subject: LEAD, kind: "wake:all-done" }, { squad: "lc", episode_key: "done|lc|u1#7", state: "capped", source: "loop", observed_at: T });
    const card = { kind: "poke_unanswered", member: LEAD, squad: "lc", reason: "all-done", pokeEpisode: "done|lc|u1#7" } as Row;
    s.db.run("UPDATE units SET status = 'cancelled' WHERE slug = 'u2'");
    expect(pokeSettled(s, "fx", card)).toBe(false); // all done: the card stays while the Lead owes the answer
    s.db.run("UPDATE units SET status = 'planned' WHERE slug = 'u2'");
    expect(pokeSettled(s, "fx", card)).toBe("the squad is no longer all done");
  });

  test("a held-only squad with a fix merged after a Tester pass still gets the retest poke", async () => {
    const { s } = held();
    s.db.run("INSERT INTO events (at, project, squad, unit, kind) VALUES (?, 'fx', 'lc', 'u1', 'unit_done')", [T - 100]);
    s.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, 'fx', 'lc', 'wt-t', 'tester_pass_done', '{}')", [T - 1000]);
    expect(eps(await loop(s).tick(T))).toEqual(["poke retest-due:retest|lc|u1#7#1"]);
  });

  test("an all-cancelled squad is all done: the loop sets all_done_at and pokes, like the board's label", async () => {
    const { s } = squad([{ slug: "u1", status: "cancelled" }, { slug: "u2", status: "cancelled" }], { members: [{ role: "lead", suffix: "", wt: LEAD }] });
    worker(s, LEAD, "idle", null, T - 3600);
    expect(eps(await loop(s).tick(T)).filter((e) => e.includes("all-done"))).toEqual(["poke all-done:done|lc|#1"]);
    expect(sq(s).all_done_at).toBe(T);
    expect(allDoneAt(s, T)).toBe(true);
  });

  test("a Tester member up keeps the squad from all done, as the board and the Lead tick already did", async () => {
    const { s } = squad([{ slug: "u1", pr: "7", status: "done" }],
      { members: [{ role: "lead", suffix: "", wt: LEAD }, { role: "tester", suffix: "x", wt: "wt-t2::/ws/ds-tester-x-lc" }] });
    pr(s, 7, { state: "MERGED", verdict: "merged" });
    worker(s, LEAD, "idle", null, T - 3600);
    expect(eps(await loop(s).tick(T)).filter((e) => e.includes("all-done"))).toEqual([]);
    expect(allDoneAt(s, T)).toBe(false);
  });
});

describe("squad-done-definition U3: a parked squad's Lead is asked once per held set", () => {
  const parkedSquad = (hold: Row[] = [{ slug: "u2" }]) => {
    const r = squad([{ slug: "u1", pr: "7", status: "done" }, ...hold.map((h) => ({ status: "planned", hold: true, builder_wt: "", ...h }))],
      { members: [{ role: "lead", suffix: "", wt: LEAD }] });
    pr(r.s, 7, { state: "MERGED", verdict: "merged" });
    worker(r.s, LEAD, "idle", null, T - 3600);
    return r;
  };
  const parkedEps = (a: string[]) => a.filter((e) => e.includes("parked"));

  test("one parked poke per held set; none after the poke gap for the same set; a new one when the set changes", async () => {
    const { s } = parkedSquad([{ slug: "u2" }, { slug: "u3", hold: false, status: "cancelled" }]), l = loop(s);
    expect(parkedEps(eps(await l.tick(T)))).toEqual(["poke parked:parked|lc|u2#1"]);
    for (const dt of [5, 70, 200, 4000]) expect(parkedEps(eps(await l.tick(T + dt)))).toEqual([]);
    s.db.run("UPDATE units SET status = 'planned', hold = 1 WHERE slug = 'u3'");
    expect(parkedEps(eps(await l.tick(T + 5000)))).toEqual(["poke parked:parked|lc|u2,u3#1"]);
    expect(sq(s).all_done_at ?? null).toBeNull();
  });

  test("the parked poke never reaches the cap card", async () => {
    const { s } = parkedSquad(), l = loop(s);
    const all: string[] = [];
    for (let i = 0; i < 12; i++) all.push(...eps(await l.tick(T + i * 4000)));
    expect(all.filter((e) => e.startsWith("alert"))).toEqual([]);
    expect(parkedEps(all)).toEqual(["poke parked:parked|lc|u2#1"]);
  });

  test("a squad with an unheld planned unit is not parked: no parked poke", async () => {
    const { s } = parkedSquad([{ slug: "u2" }, { slug: "u3", hold: false }]);
    expect(parkedEps(eps(await loop(s).tick(T)))).toEqual([]);
  });

  test("U8: a planned dependent of a held unit leaves the squad parked, one poke per held set", async () => {
    const { s } = parkedSquad([{ slug: "u2" }, { slug: "u3", hold: false, deps: ["u2"] }]), l = loop(s);
    expect(parkedEps(eps(await l.tick(T)))).toEqual(["poke parked:parked|lc|u2#1"]);
    for (const dt of [5, 70, 4000]) expect(parkedEps(eps(await l.tick(T + dt)))).toEqual([]);
    expect(sq(s).all_done_at ?? null).toBeNull();
  });

  test("a retest due wins over parked", async () => {
    const { s } = parkedSquad();
    s.db.run("INSERT INTO events (at, project, squad, unit, kind) VALUES (?, 'fx', 'lc', 'u1', 'unit_done')", [T - 100]);
    s.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, 'fx', 'lc', 'wt-t', 'tester_pass_done', '{}')", [T - 1000]);
    const got = eps(await loop(s).tick(T));
    expect(parkedEps(got)).toEqual([]);
    expect(got).toEqual(["poke retest-due:retest|lc|u1#7#1"]);
  });
});
