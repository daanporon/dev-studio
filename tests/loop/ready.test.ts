// ready.test.ts — U157: the loop dispatches ready units' Builders within a tick (bin/loop/reconcilers/ready.ts).
// Ready is `squad-state.sh ready-units`: planned, not held, not waiting, every dep satisfied and
// every ext dep done. The fixture squad `demo`: u3 is ready from the start (u1 done), u4 waits on
// u2 (dispatched), u6 takes the cancelled u5's work, u9 waits on an archived peer unit that is done.
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { Action, Actuator, TickCtx } from "../../bin/loop/core/plugins.ts";
import { DIRS, load } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import picker from "../../bin/loop/core/decide.ts";
import liveness from "../../bin/loop/reconcilers/liveness.ts";
import ready, { readyUnits } from "../../bin/loop/reconcilers/ready.ts";
import requests from "../../bin/loop/reconcilers/requests.ts";
import { open as askOpen, answer } from "../../bin/loop/messages/questions.ts";
import { exportJson } from "../../bin/loop/db/export-json.ts";
import { buildBoard } from "../../bin/board/board-data.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const T = 1_800_000_000;
const MIN = 60;
const W = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/";
const STUDIO = `${W}ds-fx-studio`, LEAD = `${W}ds-dev-studio-lead-demo`, THINKER = `${W}ds-dev-studio-thinker-demo`;
const B2 = `${W}ds-dev-studio-builder-u2-sqlite-store-migrations-and-demo`;
const U2 = "u2-sqlite-store-migrations-and", U4 = "u4-orca-state-file-config";
const U3 = "u3-loop-daemon-skeleton-health";
const ENV = ["DS_LIMIT_PICK_FLOOR_BUILDER", "DS_LOOP_SEND_TRIES"];
const DEMO_PLAN = "/state/fx/squads/demo-loop-plan.md";
// The operator's plan approval, as approve-plan records it: the loop dispatches only units
// whose plan is empty (ad-hoc) or approved.
function approvePlan(s: Store, ...plans: string[]) {
  const row = s.get("squads", { project: "fx", topic: "demo" })!;
  const doc = JSON.parse(String(row.doc ?? "{}"));
  s.upsert("squads", { project: "fx", topic: "demo" },
    { doc: JSON.stringify({ ...doc, approved_plans: [...(doc.approved_plans ?? []), ...plans] }) });
}

type Seen = { state?: string; unread?: number; limited?: string | null };
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  delete process.env.DS_NOW;
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const e of ENV) delete process.env[e];
});
beforeAll(() => { process.env.DS_LOOP_RETRY_S = "1"; });
afterAll(() => { delete process.env.DS_LOOP_RETRY_S; });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  const s = open(root); stores.push(s); importJson(s);
  approvePlan(s, DEMO_PLAN);   // the fixture approves only demo-plan.md; u3/u4 run on demo-loop-plan.md
  const world = new Map<string, Seen>([STUDIO, LEAD, THINKER, B2].map((wt) => [wt, { state: "idle" }]));
  const acted: Action[] = [];
  const act: Actuator = {
    act(a) { acted.push(a); },
  };
  const observer = { name: "world", run(c: TickCtx) {
    for (const [wt, w] of world) {
      c.store.upsert("observed_workers", { project: c.project, wt }, { state: w.state ?? "idle", unread: w.unread ?? 0, limited: w.limited ?? null, observed_at: c.now, gone_at: null });
      c.store.upsert("observed_worktrees", { project: c.project, wt }, { doc: { agents: 1 }, observed_at: c.now, gone_at: null });
    }
  } };
  const loop = new Loop(s, { observers: [observer], reconcilers: [liveness, ready] }, act, { projects: () => ["fx"] });
  const tick = async (at: number) => { process.env.DS_NOW = String(at); return (await loop.tick(at)).acted; };
  const pokes = () => acted.filter((a) => a.kind === "poke");
  const unit = (slug: string, col: string, v: unknown) => s.db.run(`UPDATE units SET ${col} = ? WHERE slug = ?`, [v as never, slug]);
  const wish = (slug: string) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = 'demo' AND role = 'builder' AND suffix = ? ORDER BY id DESC").get(slug) as Row | null;
  const wishes = () => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = 'demo' AND role = 'builder' ORDER BY id").all() as Row[];
  // u3, u6 and u9 are ready from the start: hold them so only the unit under test can become ready.
  const holdRest = () => { for (const h of [U3, "u6-takes-u5", "u9-ext-archived"]) unit(h, "hold", 1); };
  return { s, world, act, acted, tick, pokes, unit, wish, wishes, holdRest };
}

describe("ready-units", () => {
  test("all readiness paths exclude a planned unit waiting on a board answer, then release it", async () => {
    const t = setup(), slug = "u3-loop-daemon-skeleton-health";
    writeFileSync(join(t.s.root, ".loop-migrated"), "test\n");
    const seq = askOpen(t.s, "fx", "demo", { id: "routing", blocking: true, unit: slug, asker: "lead", question: "Who owns this work?" });
    const check = (waiting: boolean) => {
      exportJson(t.s);
      const sh = Bun.spawnSync([join(import.meta.dir, "..", "..", "bin", "role", "squad-state.sh"), join(t.s.root, "fx", "squads", "demo.json"), "ready-units"], { env: { ...process.env, DS_STATE_ROOT: t.s.root } });
      expect(sh.exitCode).toBe(0);
      expect(sh.stdout.toString().split("\n").includes(slug)).toBe(!waiting);
      const cli = Bun.spawnSync([join(import.meta.dir, "..", "..", "bin", "ds"), "--state", t.s.root, "units", "fx", "demo", "--ready"]);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout.toString()).includes(slug)).toBe(!waiting);
      const unit = buildBoard("fx", "demo", t.s.root).squads[0].units.find((u) => u.slug === slug);
      expect(unit?.state === "waiting").toBe(waiting);
      expect(unit?.waiting_on?.id ?? null).toBe(waiting ? "routing" : null);
    };
    check(true);
    await t.tick(T);
    expect(t.wish(slug)).toBeNull();
    const { row } = t.s.request("answer", { id: "routing", seq, answer: "Proceed" }, { project: "fx", squad: "demo", member: LEAD });
    answer(t.s, "fx", "demo", "routing", "Proceed", "board");
    check(true);
    await t.tick(T + 60);
    expect(t.wish(slug)).toBeNull();
    t.s.db.run("UPDATE requests SET done_at = ? WHERE id = ?", [T + 60, Number(row.id)]);
    check(false);
  });

  test("the loop's ready set is squad-state.sh ready-units on the fixture", () => {
    const t = setup();
    const units = t.s.db.query("SELECT * FROM units WHERE project = 'fx' AND squad = 'demo'").all() as never[];
    const sh = Bun.spawnSync([join(import.meta.dir, "..", "..", "bin", "role", "squad-state.sh"), join(t.s.root, "fx", "squads", "demo.json"), "ready-units"], { stderr: "ignore" });
    const want = sh.stdout.toString().split("\n").filter(Boolean).sort();
    expect(want).toEqual(["u3-loop-daemon-skeleton-health", "u6-takes-u5", "u9-ext-archived"]);
    expect(readyUnits(t.s, "fx", units, T).map((u) => u.slug).sort()).toEqual(want);
  });
});

describe("the loop dispatches a ready Builder (no poke)", () => {
  test("a unit made ready by its last dep gets a Builder wish the same tick and no poke", async () => {
    const t = setup();
    t.holdRest();
    await t.tick(T);
    expect(t.wish(U4)).toBeNull();
    t.unit(U2, "status", "done");
    await t.tick(T + MIN);
    const w = t.wish(U4);
    expect(w).toMatchObject({ want: "running", status: "wanted", phase: "build", tier: "hard" });
    expect(JSON.parse(String(w!.want_payload))).toEqual({ why: "start", request: true, unit: U4 });
    expect(String(w!.want_by)).toBe("loop");
    // The unit stays planned until the Builder starts; the tick sent no poke at all.
    expect(t.s.get("units", { project: "fx", squad: "demo", slug: U4 })?.status).toBe("planned");
    expect(t.pokes()).toEqual([]);
    await t.tick(T + 2 * MIN);
    expect(t.pokes()).toEqual([]);
    expect(t.wishes().filter((m) => m.suffix === U4).length).toBe(1);
  });

  test("two units ready in one tick get one wish each, and a held unit gets none until released", async () => {
    const t = setup();
    t.s.db.run("INSERT INTO units (project, squad, slug, status, deps, ext_deps, observed_at, updated_at) VALUES ('fx', 'demo', 'u11-also', 'planned', ?, ?, ?, ?)",
      [JSON.stringify([U2]), JSON.stringify([]), T, T]);
    await t.tick(T);
    // u3, u6 and u9 are ready from the start; u8's obsolete capacity deadline is retired by the
    // tick (retireCapacityFacts), so it is ready too: one wish each, no pokes.
    for (const slug of [U3, "u6-takes-u5", "u8-waits", "u9-ext-archived"]) expect(t.wish(slug)?.want).toBe("running");
    expect(t.wish("u11-also")).toBeNull();   // its dep is still dispatched
    expect(t.wish(U4)).toBeNull();
    expect(t.pokes()).toEqual([]);
    // u7 is held: nothing while held; u2's done mark readies u4, u7 (released) and u11 together.
    expect(t.wish("u7-held")).toBeNull();
    t.unit(U2, "status", "done");
    t.unit("u7-held", "hold", 0);
    await t.tick(T + MIN);
    for (const slug of ["u7-held", U4, "u11-also"]) expect(t.wish(slug)?.want).toBe("running");
    expect(t.wishes().filter((m) => m.suffix === U4).length).toBe(1);
    expect(t.pokes()).toEqual([]);
  });

  test("an ext dep not done or a blocking question: no wish; answered and done: wished", async () => {
    const t = setup();
    for (const h of ["u6-takes-u5", "u8-waits", "u9-ext-archived"]) t.unit(h, "hold", 1);
    const seq = askOpen(t.s, "fx", "demo", { id: "routing", blocking: true, unit: U3, asker: "lead", question: "Who owns this work?" });
    expect(seq).toBeGreaterThan(0);
    await t.tick(T);
    expect(t.wish("u10-ext-missing")).toBeNull();   // its ext ref names no live or archived done unit
    expect(t.wish(U3)).toBeNull();
    expect(t.pokes()).toEqual([]);
    const { row } = t.s.request("answer", { id: "routing", seq, answer: "Proceed" }, { project: "fx", squad: "demo", member: LEAD });
    answer(t.s, "fx", "demo", "routing", "Proceed", "board");
    t.s.db.run("UPDATE requests SET done_at = ? WHERE id = ?", [T, Number(row.id)]);
    await t.tick(T + MIN);
    expect(t.wish(U3)?.want).toBe("running");
    expect(t.pokes()).toEqual([]);
  });

  test("a unit whose plan is not approved gets no Builder until approve-plan records it", async () => {
    const t = setup();
    for (const h of ["u6-takes-u5", "u8-waits", "u9-ext-archived"]) t.unit(h, "hold", 1);
    t.s.db.run("INSERT INTO units (project, squad, slug, status, deps, ext_deps, plan, observed_at, updated_at) VALUES ('fx', 'demo', 'u14-unapproved', 'planned', '[]', '[]', ?, ?, ?)",
      ["/state/fx/squads/other-plan.md", T, T]);
    await t.tick(T);
    expect(t.wish("u14-unapproved")).toBeNull();
    expect(t.wish(U3)?.want).toBe("running");   // the approved plan still dispatches
    expect(t.pokes()).toEqual([]);
    approvePlan(t.s, "/state/fx/squads/other-plan.md");
    await t.tick(T + MIN);
    expect(t.wish("u14-unapproved")?.want).toBe("running");
    expect(t.pokes()).toEqual([]);
  });

  describe("plan paths match in every form (U181)", () => {
  // A relative plan anchors at the dev-studio root (the state root's parent), so the unit's plan
  // and the approval compare equal however each side was typed.
  const forms = (s: Store) => {
    const dev = dirname(s.root);
    const rel = "state/fx/squads/other-plan.md";
    return { rel, abs: join(dev, rel), tilde: `~/${rel}`, dev };
  };
  const addUnit = (t: ReturnType<typeof setup>, slug: string, plan: string) => {
    t.s.db.run("INSERT INTO units (project, squad, slug, status, deps, ext_deps, plan, observed_at, updated_at) VALUES ('fx', 'demo', ?, 'planned', '[]', '[]', ?, ?, ?)",
      [slug, plan, T, T]);
  };
  const unapprovedEvents = (t: ReturnType<typeof setup>) =>
    t.s.db.query("SELECT * FROM events WHERE kind = 'ready_unapproved' AND project = 'fx' AND squad = 'demo' ORDER BY id").all() as Row[];

  test("a relative plan matches an absolute approval, and the reverse", async () => {
    const t = setup();
    t.holdRest();
    t.unit("u8-waits", "hold", 1);
    const { rel, abs } = forms(t.s);
    const relB = rel.replace("other-plan", "second-plan"), absB = abs.replace("other-plan", "second-plan");
    addUnit(t, "u14-rel", rel);
    addUnit(t, "u14-abs", absB);
    approvePlan(t.s, abs);   // absolute approval for the relative unit
    approvePlan(t.s, relB);  // relative approval for the absolute unit
    await t.tick(T);
    expect(t.wish("u14-rel")?.want).toBe("running");
    expect(t.wish("u14-abs")?.want).toBe("running");
    expect(unapprovedEvents(t)).toEqual([]);
  });

  test("a ~/ plan matches an absolute approval", async () => {
    const t = setup();
    t.holdRest();
    t.unit("u8-waits", "hold", 1);
    const { abs, tilde, dev } = forms(t.s);
    const home = process.env.HOME;
    process.env.HOME = dev;
    try {
      addUnit(t, "u14-tilde", tilde);
      approvePlan(t.s, abs);
      await t.tick(T);
      expect(t.wish("u14-tilde")?.want).toBe("running");
    } finally {
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    }
  });

  test("a ready unit with no approval gets no wish and exactly one event over three ticks", async () => {
    const t = setup();
    t.holdRest();
    t.unit("u8-waits", "hold", 1);
    const { abs } = forms(t.s);
    addUnit(t, "u14-unapproved", abs);
    for (let i = 0; i < 3; i++) await t.tick(T + i * MIN);
    expect(t.wish("u14-unapproved")).toBeNull();
    const events = unapprovedEvents(t);
    expect(events.length).toBe(1);
    expect(JSON.parse(String(events[0].payload))).toEqual({ unit: "u14-unapproved", plan: abs });
    expect(events[0].unit).toBe("u14-unapproved");
    // The approval releases it on the next tick, with no second event.
    approvePlan(t.s, abs);
    await t.tick(T + 3 * MIN);
    expect(t.wish("u14-unapproved")?.want).toBe("running");
    expect(unapprovedEvents(t).length).toBe(1);
  });
  });

  test("a paused squad dispatches nothing until resumed", async () => {
    const t = setup();
    t.holdRest();
    t.s.upsert("pause_intents", { scope: "squad", project: "fx", squad: "demo", role: "", suffix: "", source: "manual" }, { generation: "g1", requested_at: T });
    t.unit(U2, "status", "done");
    t.unit("u7-held", "hold", 0);
    await t.tick(T);
    expect(t.wish(U4)).toBeNull();
    expect(t.wish("u7-held")).toBeNull();
    expect(t.pokes()).toEqual([]);
    t.s.db.run("UPDATE pause_intents SET cleared_at = ?", [T]);
    await t.tick(T + MIN);
    expect(t.wish(U4)?.want).toBe("running");
    expect(t.wish("u7-held")?.want).toBe("running");
    expect(t.pokes()).toEqual([]);
  });

  test("a project pause and a suspended squad dispatch nothing", async () => {
    const t = setup();
    t.holdRest();
    t.s.db.run("INSERT INTO units (project, squad, slug, status, deps, ext_deps, observed_at, updated_at) VALUES ('fx', 'demo', 'u12-paused', 'planned', '[]', '[]', ?, ?)", [T, T]);
    t.s.upsert("pause_intents", { scope: "project", project: "fx", squad: "", role: "", suffix: "", source: "manual" }, { generation: "g1", requested_at: T });
    await t.tick(T);
    expect(t.wish("u12-paused")).toBeNull();
    expect(t.pokes()).toEqual([]);
    t.s.db.run("UPDATE pause_intents SET cleared_at = ?", [T]);
    await t.tick(T + MIN);
    expect(t.wish("u12-paused")?.want).toBe("running");
    t.s.db.run("INSERT INTO units (project, squad, slug, status, deps, ext_deps, observed_at, updated_at) VALUES ('fx', 'demo', 'u13-suspended', 'planned', '[]', '[]', ?, ?)", [T + MIN, T + MIN]);
    t.s.db.run("UPDATE squads SET status = 'suspended' WHERE project = 'fx' AND topic = 'demo'");
    await t.tick(T + 2 * MIN);
    expect(t.wish("u13-suspended")).toBeNull();
    expect(t.pokes()).toEqual([]);
    t.s.db.run("UPDATE squads SET status = 'running' WHERE project = 'fx' AND topic = 'demo'");
    await t.tick(T + 3 * MIN);
    expect(t.wish("u13-suspended")?.want).toBe("running");
    expect(t.pokes()).toEqual([]);
  });

  test("a testing squad gets no Builder wish", async () => {
    const t = setup();
    t.holdRest();
    t.s.db.run("UPDATE squads SET type = 'testing'");
    t.unit(U2, "status", "done");
    await t.tick(T + MIN);
    expect(t.wish(U4)).toBeNull();
    expect(t.pokes()).toEqual([]);
  });

  test("a failed Builder start waits for the Lead's re-request: no second wish", async () => {
    const t = setup();
    t.holdRest();
    t.unit(U2, "status", "done");
    await t.tick(T);
    const w = t.wish(U4)!;
    expect(w.want).toBe("running");
    // The start gave up: from here only a new wish (the Lead's ds request) retries.
    t.s.db.run("UPDATE members SET want_result = 'failed: boom' WHERE id = ?", [w.id as number]);
    await t.tick(T + MIN);
    await t.tick(T + 2 * MIN);
    expect(t.wishes().filter((m) => m.suffix === U4).length).toBe(1);
    expect(t.pokes()).toEqual([]);
  });

  test("a Builder the Lead already requested in the same tick is not wished twice", async () => {
    const t = setup();
    t.holdRest();
    t.unit(U2, "status", "done");
    // The Lead's `ds request builder --unit` for the same unit, before the loop's tick.
    const { row } = t.s.want("member", `fx/demo/builder/${U4}`, "running",
      { payload: { why: "start", request: true, unit: U4 }, by: "lead", rearm: true });
    t.s.fact("member_requested", [{ table: "members", key: { id: row.id }, set: { phase: "build", status: "wanted", updated_at: T } }],
      { project: "fx", squad: "demo", member: `builder/${U4}`, payload: { id: row.id } });
    await t.tick(T + MIN);
    expect(t.wishes().filter((m) => m.suffix === U4).length).toBe(1);
    expect(t.pokes()).toEqual([]);
  });
});

// The production order through a real tick: the decider, ready, requests, then the fulfillers,
// on a copy of tests/fixtures/loop/state with the fixture accounts and conventions.
const fulfillers = await load<Fulfiller>(DIRS.fulfil);
function rig(s: Store) {
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [picker, ready, requests, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { process.env.DS_NOW = String(at); const r = await loop.tick(at); await act.drain(); return r; };
  return { orca, tick };
}
function fullFixture(): Store {
  const root = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(root, "accounts.tsv"));
  const conv = mkdtempSync(join(tmpdir(), "zzconv-")); temps.push(conv);
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  const s = open(root); stores.push(s);
  importJson(s);
  approvePlan(s, DEMO_PLAN);
  importConfig(s, root, conv);
  s.upsert("observed_workers", { project: "fx", wt: LEAD }, { state: "idle", observed_at: T });
  return s;
}
const leadPokes = (o: FakeOrca) => o.of("poke").filter((c) => c.args[0] === LEAD).map((c) => String(c.args[1]));

describe("ready dispatch end to end", () => {
  test("wish one tick, start the next, the Lead told once, never again", async () => {
    const s = fullFixture(), { orca, tick } = rig(s);
    for (const h of [U3, "u6-takes-u5", "u8-waits", "u9-ext-archived"]) s.db.run("UPDATE units SET hold = 1 WHERE slug = ?", [h]);
    s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
    await tick(T);
    const w = s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = 'demo' AND role = 'builder' AND suffix = ?").get(U4) as Row;
    expect(w.want).toBe("running");
    expect(orca.of("role-start").length).toBe(0);   // the decider runs before ready's write
    await tick(T + 1);
    const start = orca.of("role-start");
    expect(start.length).toBe(1);
    expect(start[0].args[6]).toBe(`ds-fx-builder-${U4}-demo`);
    expect(String(start[0].args[3])).toContain("Work the assigned unit of squad demo as the builder");
    expect(s.get("units", { project: "fx", squad: "demo", slug: U4 })).toMatchObject({ status: "dispatched" });
    for (let i = 2; i < 8; i++) await tick(T + i);
    expect(orca.of("role-start").length).toBe(1);
    const told = leadPokes(orca);
    expect(told.length).toBe(1);
    expect(told[0]).toContain(`builder ${U4} you requested has started`);
  });

  test("no room or no max_builders slot leaves the wish idle: no start, no second wish", async () => {
    const s = fullFixture(), { orca, tick } = rig(s);
    for (const h of [U3, "u6-takes-u5", "u8-waits", "u9-ext-archived"]) s.db.run("UPDATE units SET hold = 1 WHERE slug = ?", [h]);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "max_builders" }, { value: "1", observed_at: T });
    // One live Builder holds the only slot: wished running, never observed (its status says so).
    s.upsert("members", { project: "fx", squad: "demo", role: "builder", suffix: "older" }, {
      wt: `${W}older`, status: "running", want: "stopped", observed_at: T, updated_at: T });
    s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
    await tick(T);
    await tick(T + 1);
    expect(s.db.query("SELECT * FROM members WHERE role = 'builder' AND suffix = ?").get(U4) as Row).toMatchObject({ want: "running", status: "wanted" });
    expect(orca.of("role-start").length).toBe(0);
    expect(s.get("units", { project: "fx", squad: "demo", slug: U4 })?.status).toBe("planned");
    expect(s.get("picks", { member: (s.db.query("SELECT id FROM members WHERE role = 'builder' AND suffix = ?").get(U4) as Row).id })?.reason).toMatch(/^WAIT slot: /);
    await tick(T + 2);
    expect(s.db.query("SELECT COUNT(*) AS n FROM members WHERE role = 'builder' AND suffix = ?").get(U4)).toEqual({ n: 1 });
    // The slot frees (the fixture's done u1 Builder still counts as live): the same wish starts, once.
    s.upsert("config", { project: "fx", file: "limits.conf", key: "max_builders" }, { value: "3", observed_at: T + 3 });
    await tick(T + 3);
    expect(orca.of("role-start").map((c) => c.args[6])).toEqual([`ds-fx-builder-${U4}-demo`]);
  });

  test("a loop restart between wish and start still gives one Builder", async () => {
    const s = fullFixture();
    const first = rig(s);
    for (const h of [U3, "u6-takes-u5", "u8-waits", "u9-ext-archived"]) s.db.run("UPDATE units SET hold = 1 WHERE slug = ?", [h]);
    s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
    await first.tick(T);
    expect(first.orca.of("role-start").length).toBe(0);
    const second = rig(s);   // the loop restarts: fresh boot, same rows
    await second.tick(T + 1);
    await second.tick(T + 2);
    expect(second.orca.of("role-start").length).toBe(1);
    expect(s.db.query("SELECT COUNT(*) AS n FROM members WHERE role = 'builder' AND suffix = ?").get(U4)).toEqual({ n: 1 });
  });

  test("a failed start is told once and never retried by the loop", async () => {
    const s = fullFixture(), { orca, tick } = rig(s);
    process.env.DS_LOOP_SEND_TRIES = "1";
    orca.fail("role-start", { code: 1, out: "", err: "boom" });
    for (const h of [U3, "u6-takes-u5", "u8-waits", "u9-ext-archived"]) s.db.run("UPDATE units SET hold = 1 WHERE slug = ?", [h]);
    s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
    await tick(T);
    await tick(T + 1);
    const w = s.db.query("SELECT * FROM members WHERE role = 'builder' AND suffix = ?").get(U4) as Row;
    expect(String(w.want_result)).toStartWith("failed: ");
    await tick(T + 2);
    await tick(T + 3);
    expect(orca.of("role-start").length).toBe(1);
    const told = leadPokes(orca);
    expect(told.length).toBe(1);
    expect(told[0]).toContain(`builder ${U4} you requested could not be started`);
  });
});
