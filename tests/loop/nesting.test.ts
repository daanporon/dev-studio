// nesting.test.ts — U206: the squad tree (Studio > Lead > the Lead's roles) as reality. A new
// squad's Lead starts under the Studio's worktree, its other roles under the Lead once it has one;
// reconcilers/nesting.ts files one `wt-set-parent` for a standing member observed under the wrong
// parent; Builders are nested too (U213). Hermetic: the FakeBackend and a copy of the fixture state.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { parentFor } from "../../bin/loop/drivers/types.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const STUDIO = "fakerepo::/wt/studio";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.DS_LOOP_RETRY_S; delete process.env.DS_LOOP_NEST_GRACE_S;
});

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
async function rig() {
  const d = mkdtempSync(join(tmpdir(), "zznest-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  process.env.DS_LOOP_RETRY_S = "1";
  for (const [role, value] of [["lead", "claude sonnet always"], ["thinker", "claude opus always"], ["builder", "claude opus ondemand"]] as const)
    s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
  s.db.run("UPDATE projects SET studio_wt = ? WHERE label = 'fx'", [STUDIO]);
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const reconcilers = await load<Reconciler>(DIRS.reconcilers);
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
  return { s, orca, act, tick };
}

const members = (s: Store, topic: string) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = ? AND COALESCE(status, '') != 'gone' ORDER BY id").all(topic) as Row[];
const sets = (orca: FakeOrca) => orca.of("wt-set-parent");
function observe(s: Store, wt: string, parent: string | null, gone = false) {
  s.upsert("observed_worktrees", { project: "fx", wt }, { path: `/x/${wt}`, branch: "b", parent, observed_at: T, gone_at: gone ? T : null });
}
function seedMember(s: Store, n: string, role: string, wt: string) {
  s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, observed_at, updated_at) VALUES ('fx', ?, ?, ?, '', 'running', ?, ?)", [n, wt, role, T, T]);
}
// A running squad `n` with a Lead, a Thinker and a Builder holding worktrees.
function seedSquad(s: Store, n: string, lead: string, thinker: string, builder: string) {
  s.upsert("squads", { project: "fx", topic: n }, { run_id: "run_n", repo: "r", lead_wt: lead, status: "running", observed_at: T, updated_at: T });
  for (const [role, wt] of [["lead", lead], ["thinker", thinker], ["builder", builder]] as const) seedMember(s, n, role, wt);
}

describe("squad nesting (U206)", () => {
  test("parentFor: the Lead's is the Studio, another role's the Lead (none while unset)", () => {
    const sq = { project: "fx", topic: "t", run_id: "r", repo: "r", lead_wt: null, studio_wt: STUDIO };
    expect(parentFor(sq, "lead")).toBe(STUDIO);
    expect(parentFor(sq, "thinker")).toBeNull();
    expect(parentFor({ ...sq, lead_wt: "L" }, "thinker")).toBe("L");
    expect(parentFor({ ...sq, studio_wt: null }, "lead")).toBeNull();
  });

  test("a new squad: the Lead starts under the Studio and its Thinker under the Lead; a Thinker seen top-level is moved by one set", async () => {
    const { s, orca, tick } = await rig();
    s.want("squad", "fx/nest1", "running", { payload: { repo: "path:/nonexistent/fixture-repo", type: "feature" }, fill: { repo: "path:/nonexistent/fixture-repo", type: "feature" }, by: "spawn-squad" });
    await tick();
    for (const m of members(s, "nest1"))
      s.upsert("picks", { member: m.id }, { project: "fx", squad: "nest1", role: m.role, agent: "claude", model: "sonnet", slot: 1, picked_at: T });
    await tick(2);
    const starts = orca.started.filter((x) => x.wt.includes("nest1"));
    expect(starts.map((x) => x.op)).toEqual(["role-start", "role-start"]);
    const [lead, thinker] = starts;
    expect(lead.args[2]).toBe(STUDIO);
    const lwt = String(members(s, "nest1")[0].wt), twt = String(members(s, "nest1")[1].wt);
    expect(thinker.args[2]).toBe(lwt);   // lead_wt was set by then: nested at creation
    expect(String(s.db.query("SELECT lead_wt FROM squads WHERE project = 'fx' AND topic = 'nest1'").get()!["lead_wt" as never])).toBe(lwt);
    observe(s, STUDIO, null); observe(s, lwt, STUDIO); observe(s, twt, null);   // Orca put the Thinker top-level
    await tick(2);
    expect(sets(orca).map((c) => c.args)).toEqual([[twt, lwt]]);
    observe(s, twt, lwt);
    await tick(3);
    expect(sets(orca)).toHaveLength(1);
  }, 30_000);

  test("a Lead observed top-level, or under the wrong worktree, gets one set to the Studio; a correct tree gets none", async () => {
    const { s, orca, tick } = await rig();
    seedSquad(s, "a", "L1", "T1", "B1");
    seedSquad(s, "b", "L2", "T2", "B2");
    seedSquad(s, "c", "L3", "T3", "B3");
    observe(s, STUDIO, null);
    observe(s, "L1", null); observe(s, "T1", "L1"); observe(s, "B1", "L1");
    observe(s, "L2", "elsewhere"); observe(s, "T2", "L2"); observe(s, "B2", "L2");
    observe(s, "L3", STUDIO); observe(s, "T3", "L3"); observe(s, "B3", "L3");
    await tick(3);
    expect(sets(orca).map((c) => c.args).sort()).toEqual([["L1", STUDIO], ["L2", STUDIO]]);
  });

  test("a Builder observed under the wrong parent is moved under the Lead; an unobserved or unknown wanted parent files nothing", async () => {
    const { s, orca, tick } = await rig();
    seedSquad(s, "a", "L1", "T1", "B1");
    observe(s, "L1", STUDIO); observe(s, "T1", STUDIO); observe(s, "B1", null);
    observe(s, STUDIO, null, true);                   // the Studio is not observed: the Lead waits
    await tick(2);
    expect(sets(orca).map((c) => c.args).sort()).toEqual([["B1", "L1"], ["T1", "L1"]]);   // the Thinker and the Builder
    s.db.run("UPDATE projects SET studio_wt = NULL WHERE label = 'fx'");
    seedSquad(s, "b", "L2", "T2", "B2");
    observe(s, "L2", null); observe(s, "T2", "L2"); observe(s, "B2", null);
    await tick(2);
    expect(sets(orca).filter((c) => c.args[0] === "L2")).toHaveLength(0);
    // A squad with no lead_wt yet: its Thinker waits.
    s.upsert("squads", { project: "fx", topic: "c" }, { run_id: "run_c", repo: "r", status: "running", observed_at: T, updated_at: T });
    seedMember(s, "c", "thinker", "T3");
    observe(s, "T3", null);
    await tick(2);
    expect(sets(orca).filter((c) => c.args[0] === "T3")).toHaveLength(0);
  }, 30_000);

  test("a failed set is retried and gives up like any op; a hand move to the right parent ends the episode", async () => {
    const { s, orca, tick } = await rig();
    seedSquad(s, "a", "L1", "T1", "B1");
    observe(s, STUDIO, null); observe(s, "L1", STUDIO); observe(s, "T1", null);
    for (let i = 0; i < 12; i++) orca.fail("wt-set-parent", { code: 1, out: "", err: "boom" });
    await tick(4);
    expect(sets(orca).length).toBeGreaterThan(1);       // retried
    expect(sets(orca).length).toBeLessThan(12);         // and given up on, not endlessly
    const tries = sets(orca).length;
    observe(s, "T1", "L1");                             // the operator moved it by hand
    await tick(3);
    expect(sets(orca)).toHaveLength(tries);
  }, 30_000);

  test("a correctly nested squad whose members hold worktrees files nothing and starts nothing new", async () => {
    const { s, orca, tick } = await rig();
    seedSquad(s, "a", "L1", "T1", "B1");
    observe(s, STUDIO, null); observe(s, "L1", STUDIO); observe(s, "T1", "L1");
    await tick(2);
    expect(orca.started.filter((x) => ["L1", "T1", "B1"].includes(x.wt))).toHaveLength(0);   // members with worktrees are not role-started
    expect(sets(orca)).toHaveLength(0);
  });

  // U259: the parent is a wish. A set that landed and was later undone is a new drift.
  test("set -> done -> Orca drops the parent -> a second set is filed and run", async () => {
    const { s, orca, tick } = await rig();
    process.env.DS_LOOP_NEST_GRACE_S = "0";
    seedSquad(s, "a", "L1", "T1", "B1");
    observe(s, STUDIO, null); observe(s, "L1", STUDIO); observe(s, "T1", null);
    await tick();
    expect(sets(orca).map((c) => c.args)).toEqual([["T1", "L1"]]);
    observe(s, "T1", "L1");
    await tick(2);
    expect(sets(orca)).toHaveLength(1);
    observe(s, "T1", null);                              // Orca dropped it
    await tick();
    expect(sets(orca).map((c) => c.args)).toEqual([["T1", "L1"], ["T1", "L1"]]);
    delete process.env.DS_LOOP_NEST_GRACE_S;
  }, 30_000);

  test("a set is not repeated while the observer still shows the old parent (grace)", async () => {
    const { s, orca, tick } = await rig();
    seedSquad(s, "a", "L1", "T1", "B1");
    observe(s, STUDIO, null); observe(s, "L1", STUDIO); observe(s, "T1", null);
    await tick(4);                                       // 20s on the loop clock, under the 30s grace
    expect(sets(orca)).toHaveLength(1);
  }, 30_000);

  test("a fourth drift within an hour raises one alert and files nothing", async () => {
    const { s, orca, tick } = await rig();
    process.env.DS_LOOP_NEST_GRACE_S = "0";
    seedSquad(s, "a", "L1", "T1", "B1");
    observe(s, STUDIO, null); observe(s, "L1", STUDIO);
    for (let i = 0; i < 3; i++) {
      observe(s, "T1", null);
      await tick();
      observe(s, "T1", "L1");
      await tick();
    }
    expect(sets(orca)).toHaveLength(3);
    observe(s, "T1", null);
    await tick(3);
    expect(sets(orca)).toHaveLength(3);
    const alerts = s.db.query("SELECT * FROM episodes WHERE project = 'fx' AND subject = 'nest-drift.T1'").all();
    expect(alerts.length).toBe(1);
    delete process.env.DS_LOOP_NEST_GRACE_S;
  }, 30_000);

  test("a nudged wt-set-parent sets the parent; on an already-correct tree it finishes done with no Orca call", async () => {
    const { s, orca, tick } = await rig();
    seedSquad(s, "a", "L1", "T1", "B1");
    observe(s, STUDIO, null); observe(s, "L1", STUDIO); observe(s, "T1", "L1"); observe(s, "B1", "L1");
    observe(s, "X1", null); observe(s, "X2", STUDIO);   // two worktrees outside the squad's members: only the nudge touches them
    const a = s.request("wt-set-parent", { wt: "X1", parent: "L1" }, { project: "fx", squad: "a", by: "test" }).row;
    const b = s.request("wt-set-parent", { wt: "X2", parent: STUDIO }, { project: "fx", squad: "a", by: "test" }).row;
    await tick(3);
    expect(sets(orca).map((c) => c.args)).toEqual([["X1", "L1"]]);
    const done = (id: unknown) => s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(Number(id)) as Row;
    expect(done(a.id).done_at).not.toBeNull();
    expect(done(b.id).done_at).not.toBeNull();
    expect(String(done(b.id).result)).toContain("already");
  }, 30_000);
});
