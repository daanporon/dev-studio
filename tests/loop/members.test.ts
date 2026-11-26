// members.test.ts — U71: every member of a squad whose Run the loop holds is a live worker of that
// Run. A member with a live agent terminal the Run doesn't count as live gets one `rebind`; a live
// Run worker that is no longer a member gets one `unbind`. Hermetic: a copy of
// tests/fixtures/loop/state and the fake Orca (bin/loop/fakes/orca.ts).
import { beforeAll, afterAll, afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { sender } from "../../bin/loop/messages/coordinator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { members, parseWorkers, reconcile, starting, STRAY_EVERY, STRAY_QUIET } from "../../bin/loop/reconcilers/members.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

// U150: a transient refusal is tried again every 15 minutes (DS_LOOP_RETRY_S); these tests step
// a retry one tick at a time. The spacing itself is tested in actuator.test.ts ("refusals").
beforeAll(() => { process.env.DS_LOOP_RETRY_S = "1"; });
afterAll(() => { delete process.env.DS_LOOP_RETRY_S; });

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000, RUN = "run_fixture01";

const temps: string[] = [], stores: Store[] = [];
const env = process.env.DS_STATE_ROOT;
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (env === undefined) delete process.env.DS_STATE_ROOT; else process.env.DS_STATE_ROOT = env;
});

async function rig() {
  const d = mkdtempSync(join(tmpdir(), "zzmembers-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  process.env.DS_STATE_ROOT = d;
  const orca = new FakeBackend();
  const pane = await sender(s, orca, "fx", "demo", T);              // the loop's pane holds the Run
  const wt = (role: string) => String((s.db.query("SELECT wt FROM members WHERE project = 'fx' AND squad = 'demo' AND role = ?").get(role) as Row).wt);
  const check = () => reconcile({ store: s, project: "fx", tick: 1, now: T, fired: [], poked: new Set() }, orca);
  return { s, orca, pane, wt, check };
}

describe("a member the Run doesn't count gets one rebind", () => {
  for (const role of ["lead", "thinker", "builder"]) {
    test(`a ${role} with a new live agent terminal the Run doesn't list as live gets one rebind`, async () => {
      const { orca, wt, check } = await rig();
      orca.dispatched(RUN, wt(role), "term_old", { task: "task_mine", status: "failed" });
      orca.agent(wt(role), "term_new");
      const got = await check();
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ squad: "demo", member: wt(role), kind: "rebind", subject: `rebind:${wt(role)}`, payload: { wt: wt(role), handle: "term_new" } });
    });

    test(`a ${role} already live on its terminal gets none`, async () => {
      const { orca, wt, check } = await rig();
      orca.dispatched(RUN, wt(role), "term_new");
      orca.agent(wt(role), "term_new");
      expect(await check()).toEqual([]);
    });

    test(`a ${role} with no live terminal gets none (liveness's)`, async () => {
      const { orca, wt, check } = await rig();
      orca.dispatched(RUN, wt(role), "term_old", { status: "failed" });
      expect(await check()).toEqual([]);
    });
  }

  test("a Lead whose open dispatch names a terminal that is gone gets one rebind to the live one", async () => {
    const { orca, wt, check } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old");                    // still `dispatched` in Orca
    orca.agent(wt("lead"), "term_new");
    const got = await check();
    expect(got.map((a) => [a.kind, (a.payload as { handle: string }).handle])).toEqual([["rebind", "term_new"]]);
  });

  test("a Lead whose role task completed with its terminal still live gets one rebind", async () => {
    const { orca, wt, check } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_lead", { status: "completed" });
    orca.agent(wt("lead"), "term_lead");
    const got = await check();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "rebind", payload: { wt: wt("lead"), handle: "term_lead" } });
  });

  test("a Builder whose role task completed (worker_done) with its terminal live has finished: none", async () => {
    const { orca, wt, check } = await rig();
    orca.dispatched(RUN, wt("builder"), "term_b", { status: "completed" });
    orca.agent(wt("builder"), "term_b");
    expect(await check()).toEqual([]);
  });

  test("U215: a Builder whose dispatch failed by its own worker_done report has finished: none", async () => {
    const { orca, wt, check } = await rig();
    orca.dispatched(RUN, wt("builder"), "term_b", { status: "failed", provenance: "worker_report" });
    orca.agent(wt("builder"), "term_b");
    expect(await check()).toEqual([]);
  });

  test("U215: a Builder whose dispatch failed any other way (process stopped) is still rebound", async () => {
    const { orca, wt, check } = await rig();
    orca.dispatched(RUN, wt("builder"), "term_b", { status: "failed", provenance: "process_stopped" });
    orca.agent(wt("builder"), "term_b");
    expect((await check()).map((a) => a.kind)).toEqual(["rebind"]);
  });

  describe("U238: a finished Tester closes in a feature squad", () => {
    const tester = (s: Store, squadType: string) => {
      s.db.run("UPDATE squads SET type = ? WHERE project = 'fx' AND topic = 'demo'", [squadType]);
      s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, updated_at, observed_at) VALUES ('fx', 'demo', 'wt-tester::/ws/ds-tester-demo', 'tester', 'a1', 'running', ?, ?)", [T, T]);
      return "wt-tester::/ws/ds-tester-demo";
    };
    const want = (s: Store, wt: string) => (s.db.query("SELECT want, want_by, status FROM members WHERE wt = ?").get(wt) as Row);

    test("its newest dispatch reported: want = gone and one tester_pass_done event, not a second on the next tick", async () => {
      const { s, orca, check } = await rig(), wt = tester(s, "feature");
      orca.dispatched(RUN, wt, "term_t", { status: "failed", provenance: "worker_report" });
      orca.agent(wt, "term_t");
      expect(await check()).toEqual([]);
      expect(want(s, wt)).toMatchObject({ want: "gone", want_by: "loop" });
      await check();
      const ev = s.db.query("SELECT member, payload FROM events WHERE kind = 'tester_pass_done'").all() as Row[];
      expect(ev).toHaveLength(1);
      expect(ev[0].member).toBe(wt);
      expect(JSON.parse(String(ev[0].payload))).toMatchObject({ suffix: "a1" });
    });

    test("one that dropped out (process stopped) is not closed", async () => {
      const { s, orca, check } = await rig(), wt = tester(s, "feature");
      orca.dispatched(RUN, wt, "term_t", { status: "failed", provenance: "process_stopped" });
      orca.agent(wt, "term_t");
      expect((await check()).map((a) => a.kind)).toEqual(["rebind"]);
      expect(want(s, wt).want ?? null).toBeNull();
      expect(s.db.query("SELECT 1 FROM events WHERE kind = 'tester_pass_done'").get()).toBeNull();
    });

    test("a testing squad's Tester is standing and is never closed this way", async () => {
      const { s, orca, check } = await rig(), wt = tester(s, "testing");
      orca.dispatched(RUN, wt, "term_t", { status: "failed", provenance: "worker_report" });
      orca.agent(wt, "term_t");
      await check();
      expect(want(s, wt).want ?? null).toBeNull();
    });
  });

  test("U215: a Lead whose dispatch failed by a worker report is still rebound (standing)", async () => {
    const { orca, wt, check } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_lead", { status: "failed", provenance: "worker_report" });
    orca.agent(wt("lead"), "term_lead");
    expect((await check()).map((a) => a.kind)).toEqual(["rebind"]);
  });

  test("U215: an old 6-column run-workers line reads as not reported", () => {
    expect(parseWorkers("wt\tno\t-\tterm\ttask\tfailed\n")[0].reported).toBe(false);
    expect(parseWorkers("wt\tno\t-\tterm\ttask\tfailed\tyes\n")[0].reported).toBe(true);
  });

  test("the ds-loop pane is never chosen, even as the newest terminal in the Lead's worktree", async () => {
    const { orca, pane, wt, check } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old", { status: "failed" });
    orca.agent(wt("lead"), "term_new");
    orca.agent(wt("lead"), pane, "ds-loop demo");                    // newest first
    orca.agent(wt("lead"), "term_other", "ds-loop restart");
    const got = await check();
    expect(got.map((a) => (a.payload as { handle: string }).handle)).toEqual(["term_new"]);
  });

  test("the ds-loop pane alone is no live terminal: no rebind", async () => {
    const { orca, pane, wt, check } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old", { status: "failed" });
    orca.agent(wt("lead"), pane, "ds-loop demo");
    expect(await check()).toEqual([]);
  });

  test("a member live on one of two terminals in its worktree gets no rebind (U97 cards the duplicate instead)", async () => {
    const { orca, wt, check } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_a");
    orca.agent(wt("lead"), "term_a");
    orca.agent(wt("lead"), "term_b");                                 // newer, but the Run has term_a
    const got = await check();
    expect(got.filter((a) => a.kind === "rebind")).toEqual([]);
    expect(got.filter((a) => a.kind === "duplicate")).toHaveLength(1);
  });

  test("a member the loop is starting, or one never dispatched in the Run, gets none", async () => {
    const { s, orca, wt, check } = await rig();
    orca.agent(wt("thinker"), "term_t");                              // no task of its own in the Run
    orca.dispatched(RUN, wt("lead"), "term_old", { status: "failed" });
    orca.agent(wt("lead"), "term_new");
    const lead = s.db.query("SELECT id FROM members WHERE project = 'fx' AND wt = ?").get(wt("lead")) as { id: number };
    s.db.run("INSERT INTO episodes (project, subject, kind, episode_key, state, source, started_at, observed_at) VALUES ('fx', ?, 'action:member', 'start:0', 'running', 'loop', ?, ?)", [`member:${lead.id}`, T, T]);   // its start claim runs
    expect(await check()).toEqual([]);
  });

  test("a Run the loop doesn't hold, or a read that fails, gives nothing", async () => {
    const { s, orca, wt, check } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old", { status: "failed" });
    orca.agent(wt("lead"), "term_new");
    orca.fail("agent-handles", { code: 1, out: "", err: "orca adapter: agent-handles could not read the terminal list" });
    expect(await check()).toEqual([]);
    orca.fail("run-workers", { code: 1, out: "", err: "orca adapter: run-workers could not read the worker list" });
    expect(await check()).toEqual([]);
    expect(await check()).toHaveLength(1);
    s.db.run("UPDATE coordinators SET run_id = '' WHERE project = 'fx' AND squad = 'demo'");
    expect(await check()).toEqual([]);
  });

  test("a live member with an old dispatch a rebind failed to fence gets one rebind (the fence), none once it's fenced", async () => {
    const { s, orca, wt, check } = await rig();
    const old = orca.dispatched(RUN, wt("lead"), "term_old");
    orca.dispatched(RUN, wt("lead"), "term_new");
    orca.agent(wt("lead"), "term_new");
    const call = (state: string, id: string) => s.db.run("INSERT INTO orca_calls (retry_id, key, op, project, squad, member, at, state) VALUES (?, ?, 'dispatch-abandon', 'fx', 'demo', ?, ?, ?)",
      [id, `rebind-fence:${old.id}`, wt("lead"), T, state]);
    expect(await check()).toEqual([]);
    call("failed", "r1");
    expect((await check()).map((a) => [a.kind, a.episode])).toEqual([["rebind", `fence|${old.id}`]]);
    call("completed", "r2");
    expect(await check()).toEqual([]);
  });
});

// U80: a rebind that did not take is redone with a new episode after 1, 5 and 15 minutes; then one card.
describe("a rebind that did not take", () => {
  const rebound = (s: Store, wt: string, task: string, from: string, at: number, handle = "term_new") =>
    s.event("member_rebound", { project: "fx", squad: "demo", member: wt, payload: { run: RUN, wt, handle, was: null, task, from, dispatch: `ctx_${task}`, fenced: null, at } });
  const at = (s: Store, orca: FakeBackend, t: number) => reconcile({ store: s, project: "fx", tick: 1, now: t, fired: [], poked: new Set() }, orca);
  const failed = (orca: FakeBackend, wt: string, task: string) => { orca.dispatched(RUN, wt, "term_new", { task, status: "failed" }); orca.agent(wt, "term_new"); };

  test("redone with a new episode on the next tick after the wait, not before; the wait grows 1, 5, 15 minutes", async () => {
    const { s, orca, wt } = await rig();
    failed(orca, wt("lead"), "task_r1");
    rebound(s, wt("lead"), "task_r1", "task_old", T);
    expect(await at(s, orca, T + 59)).toEqual([]);
    const got = await at(s, orca, T + 60);
    expect(got.map((a) => [a.kind, a.episode, a.payload])).toEqual([["rebind", "term_new|-|task_r1|redo:task_r1", { wt: wt("lead"), handle: "term_new", redo: "task_r1" }]]);
    rebound(s, wt("lead"), "task_r2", "task_r1", T + 60);
    failed(orca, wt("lead"), "task_r2");
    expect(await at(s, orca, T + 60 + 299)).toEqual([]);
    expect((await at(s, orca, T + 60 + 300)).map((a) => a.episode)).toEqual(["term_new|-|task_r2|redo:task_r2"]);
    rebound(s, wt("lead"), "task_r3", "task_r2", T + 360);
    failed(orca, wt("lead"), "task_r3");
    expect(await at(s, orca, T + 360 + 899)).toEqual([]);
    expect((await at(s, orca, T + 360 + 900)).map((a) => a.episode)).toEqual(["term_new|-|task_r3|redo:task_r3"]);
  });

  test("after three redos that did not take: one giveup action naming the tasks, then nothing but that action", async () => {
    const { s, orca, wt } = await rig();
    for (const [i, t] of ["task_r1", "task_r2", "task_r3", "task_r4"].entries()) rebound(s, wt("lead"), t, i ? `task_r${i}` : "task_old", T + i);
    failed(orca, wt("lead"), "task_r4");
    const got = await at(s, orca, T + 100_000);
    expect(got.map((a) => [a.kind, a.episode])).toEqual([["rebind", "giveup|task_r4"]]);
    expect(got[0].payload).toMatchObject({ giveup: true, handle: "term_new", status: "failed", count: 4, tasks: ["task_r1", "task_r2", "task_r3", "task_r4"] });
    expect((await at(s, orca, T + 200_000)).map((a) => a.episode)).toEqual(["giveup|task_r4"]);   // the same episode: its claim keeps it to one
  });

  test("a member on another terminal (restarted) starts over, and one that turns live clears the count", async () => {
    const { s, orca, wt } = await rig();
    for (const [i, t] of ["task_r1", "task_r2", "task_r3", "task_r4"].entries()) rebound(s, wt("lead"), t, i ? `task_r${i}` : "task_old", T + i);
    orca.dispatched(RUN, wt("lead"), "term_restart", { task: "task_r4", status: "failed" });
    orca.agent(wt("lead"), "term_restart");
    expect((await at(s, orca, T + 100)).map((a) => [a.episode, (a.payload as { redo?: string }).redo])).toEqual([["term_restart|-|task_r4", undefined]]);
    // live on its terminal: an action marks it live (the fulfiller ends the count), none once marked
    orca.dispatches.length = 0;
    orca.dispatched(RUN, wt("lead"), "term_restart", { task: "task_r5" });
    expect(await at(s, orca, T + 30)).toEqual([]);                                        // live for less than a minute since the rebind: not settled
    expect((await at(s, orca, T + 200)).map((a) => a.episode)).toEqual(["live|task_r4"]);
    s.upsert("episodes", { project: "fx", subject: `redo:${wt("lead")}`, kind: "redo" }, { ended_at: T + 200, source: "loop", observed_at: T + 200 });
    expect(await at(s, orca, T + 300)).toEqual([]);
    orca.dispatches.at(-1)!.status = "failed";                                            // fails later: a plain rebind again, not a redo
    expect((await at(s, orca, T + 400)).map((a) => a.episode)).toEqual(["term_restart|-|task_r5"]);
  });
});

// U89: a rebind never leaves a Lead with an open dispatch. The reconciler settles drift the
// fulfiller did not see inline; a standing role bound through a settled rebind gets nothing.
describe("U89: a rebind never leaves a standing role with an open dispatch", () => {
  const rebound = (s: Store, wt: string, dispatch: string, handle: string, at: number, task = "task_x") =>
    s.event("member_rebound", { project: "fx", squad: "demo", member: wt, payload: { run: RUN, wt, handle, was: null, task, from: "task_old", dispatch, fenced: null, at } });
  const settledEv = (s: Store, wt: string, dispatch: string, handle: string, at: number, task = "task_x") =>
    s.event("member_rebound_settled", { project: "fx", squad: "demo", member: wt, payload: { run: RUN, wt, handle, task, dispatch, at } });
  const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));

  test("a Lead row with an open loop-made dispatch is settled once and no second task is dispatched", async () => {
    const { s, orca, wt, check } = await rig();
    const d = orca.dispatched(RUN, wt("lead"), "term_l", { task: "task_l1", spec: "Lead." });
    orca.agent(wt("lead"), "term_l");
    rebound(s, wt("lead"), d.id, "term_l", T, "task_l1");
    expect(await check()).toEqual([{ project: "fx", squad: "demo", member: wt("lead"), subject: `rebind:${wt("lead")}`, kind: "rebind",
      episode: `settle|${d.id}`, payload: { wt: wt("lead"), handle: "term_l", settle: d.id, task: "task_l1" } }]);
  });

  test("a standing role bound through a settled rebind gets nothing, not even a redo; a Builder in the same spot is rebound", async () => {
    const { s, orca, wt, check } = await rig();
    // The settled task is the newest task: that is what run-workers keeps once the dispatch is gone.
    const d = orca.dispatched(RUN, wt("lead"), "term_l", { task: "task_x", status: "failed" });
    orca.agent(wt("lead"), "term_l");
    rebound(s, wt("lead"), d.id, "term_l", T - 100);
    settledEv(s, wt("lead"), d.id, "term_l", T - 50);
    const b = orca.dispatched(RUN, wt("builder"), "term_b", { task: "task_y", status: "failed" });
    orca.agent(wt("builder"), "term_b");
    rebound(s, wt("builder"), b.id, "term_b", T - 100, "task_y");
    settledEv(s, wt("builder"), b.id, "term_b", T - 50, "task_y");
    const got = await check();
    expect(got.map((a) => [a.kind, a.member])).toEqual([["rebind", wt("builder")]]);
    // The Lead's redo count ended without going live and without a card.
    expect(s.get("episodes", { project: "fx", subject: `redo:${wt("lead")}`, kind: "redo" })).toMatchObject({ state: "settled" });
  });

  describe("on the loop", () => {
    const fulfillers = load<Fulfiller & Reconciler>(DIRS.fulfil);
    async function loopRig() {
      const r = await rig();
      const act = new LoopActuator({ orca: r.orca, fulfillers: (await fulfillers).filter((f) => f.kinds) });
      const loop = new Loop(r.s, { observers: [], reconcilers: [...await fulfillers, members(r.orca)] }, act, { projects: () => ["fx"] });
      loop.boot(T);
      const tick = async (at: number) => { await loop.tick(at); await act.drain(); importJson(r.s); };
      const cards = () => { const f = join(r.s.root, "fx", "alerts.json"); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((x) => x.kind === "rebind_settle_failed") : []; };
      return { ...r, act, tick, cards };
    }

    test("drift settles once: one abandon, one event, no second task, then bound", async () => {
      const { s, orca, wt, tick } = await loopRig();
      const d = orca.dispatched(RUN, wt("lead"), "term_l", { task: "task_l1", spec: "Lead." });
      orca.agent(wt("lead"), "term_l");
      rebound(s, wt("lead"), d.id, "term_l", T, "task_l1");
      await tick(T + 5);
      expect(orca.of("dispatch-abandon").map((c) => c.args)).toEqual([[d.id]]);
      expect(events(s, "member_rebound_settled")).toEqual([{ run: RUN, wt: wt("lead"), handle: "term_l", task: "task_l1", dispatch: d.id, at: T + 5 }]);
      expect(orca.of("task-create")).toEqual([]);
      await tick(T + 10);
      await tick(T + 15);
      expect(orca.of("dispatch-abandon")).toHaveLength(1);
      expect(orca.of("task-create")).toEqual([]);
      expect(events(s, "member_rebound_settled")).toHaveLength(1);
      // Past REDO_WAIT[0]: the settled rebind reads as bound, so no redo makes a second task.
      await tick(T + 70);
      await tick(T + 400);
      expect(orca.of("task-create")).toEqual([]);
      expect(orca.of("dispatch")).toEqual([]);
      expect(orca.of("dispatch-abandon")).toHaveLength(1);
      expect(events(s, "member_rebound")).toHaveLength(1);
      expect(events(s, "member_rebound_settled")).toHaveLength(1);
    });

    test("a settle that never goes through is tried once per episode and raises one alert past the cap", async () => {
      const { s, orca, wt, tick, cards } = await loopRig();
      const d = orca.dispatched(RUN, wt("lead"), "term_l", { task: "task_l1", spec: "Lead." });
      orca.agent(wt("lead"), "term_l");
      rebound(s, wt("lead"), d.id, "term_l", T, "task_l1");
      orca.answer = (c) => c.op === "dispatch-abandon" ? { code: 1, out: "", err: "orca adapter: dispatch-abandon refused: nope" } : undefined;
      for (let n = 5; n <= 9; n++) await tick(T + n);
      expect(orca.of("dispatch-abandon")).toHaveLength(5);
      expect(cards()).toHaveLength(1);
      expect(String(cards()[0].question)).toContain(d.id);
      expect(events(s, "member_rebind_settle_gave_up")).toHaveLength(1);
      expect(orca.of("task-create")).toEqual([]);
      expect(events(s, "member_rebound_settled")).toEqual([]);
      await tick(T + 10);
      await tick(T + 11);
      expect(orca.of("dispatch-abandon")).toHaveLength(5);
      expect(cards()).toHaveLength(1);
    });
  });
});

describe("a Run worker that is no longer a member gets one unbind", () => {
  test("a live Run worker whose worktree is not a squad member gets one unbind; members get none", async () => {
    const { orca, wt, check } = await rig();
    for (const r of ["lead", "thinker", "builder"]) { orca.dispatched(RUN, wt(r), `term_${r}`); orca.agent(wt(r), `term_${r}`); }
    const stray = orca.dispatched(RUN, "fakerepo::/wt/retired-builder", "term_gone");
    orca.dispatched(RUN, "fakerepo::/wt/old-builder", "term_x", { status: "completed" });   // settled: nothing to fence
    const got = await check();
    expect(got).toEqual([{ project: "fx", squad: "demo", member: "fakerepo::/wt/retired-builder", subject: "unbind:fakerepo::/wt/retired-builder", kind: "unbind",
      episode: stray.id, payload: { wt: "fakerepo::/wt/retired-builder", dispatch: stray.id } }]);
  });

  test("a member removed from the squad file is a stray", async () => {
    const { s, orca, wt, check } = await rig();
    const b = orca.dispatched(RUN, wt("builder"), "term_b");
    orca.agent(wt("builder"), "term_b");
    expect(await check()).toEqual([]);
    s.db.run("UPDATE members SET status = 'gone', doc = NULL WHERE wt = ?", [wt("builder")]);
    expect((await check()).map((a) => [a.kind, a.episode])).toEqual([["unbind", b.id]]);
  });
});

// U79: a plain shell in the worktree of a member that is up is a stray. An idle one is closed; a
// busy one, or one whose close fails, gets one card; the loop's own panes are never touched.
describe("a stray shell in a member's worktree", () => {
  const fulfillers = load<Fulfiller & Reconciler>(DIRS.fulfil);
  async function loopRig() {
    const r = await rig();
    const act = new LoopActuator({ orca: r.orca, fulfillers: (await fulfillers).filter((f) => f.kinds) });
    const loop = new Loop(r.s, { observers: [], reconcilers: [...await fulfillers, members(r.orca)] }, act, { projects: () => ["fx"] });
    loop.boot(T);
    const tick = async (at: number) => { await loop.tick(at); await act.drain(); importJson(r.s); };
    const cards = () => { const f = join(r.s.root, "fx", "alerts.json"); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((x) => x.kind === "stray_terminal") : []; };
    return { ...r, act, tick, cards };
  }
  const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
  const up = (orca: FakeBackend, wt: string, handle = "term_agent") => { orca.dispatched(RUN, wt, handle); orca.agent(wt, handle, "claude"); };

  test("an idle bash terminal in the Builder's worktree is closed once, with stray_terminal_closed", async () => {
    const { s, orca, wt, tick, cards } = await loopRig();
    up(orca, wt("builder"));
    orca.shells.push({ wt: wt("builder"), handle: "term_bash", title: "user@host: ~" });
    await tick(T + 5);
    expect(orca.of("terminal-close").map((c) => c.args)).toEqual([["term_bash"]]);
    expect(orca.shells).toEqual([]);
    expect(events(s, "stray_terminal_closed")).toEqual([{ wt: wt("builder"), handle: "term_bash", title: "user@host: ~" }]);
    expect(cards()).toEqual([]);
    await tick(T + 5 + STRAY_EVERY);
    await tick(T + 5 + 2 * STRAY_EVERY);
    expect(orca.of("terminal-close")).toHaveLength(1);
    expect(events(s, "stray_terminal_closed")).toHaveLength(1);
  });

  // U5 (issue #125): an open `ds account add`'s login terminal is the add's, never a stray, even in a member's worktree.
  test("an open account add's quiet login terminal in a held squad's worktree is left alone", async () => {
    const { s, orca, wt, tick, cards } = await loopRig();
    up(orca, wt("builder"));
    orca.shells.push({ wt: wt("builder"), handle: "term_login", title: "ds-account-add claude:realp" });
    const id = Number(s.requestAny("account-add", { agent: "claude", name: "realp", project: "fx" }, { project: "fx" }).row.id);
    // The add's own fulfiller watches it meanwhile: a folder with no login yet and a screen it can read.
    const folder = join(s.root, "accounts", "claude", "realp");
    mkdirSync(folder, { recursive: true });
    orca.screens.set("term_login", { pane: "tab9:leaf9", wt: wt("builder"), cwd: folder, env: {}, lines: ["Paste code here if prompted >"], line: "", out: null });
    s.upsert("requests", { id }, { result: JSON.stringify({ state: "terminal_open", folder, started_at: T, opened_at: T,
      terminal: { via: "orca", handle: "term_login", project: "fx" } }) });
    await tick(T + 5);
    await tick(T + 5 + STRAY_EVERY);
    expect(orca.of("terminal-close")).toEqual([]);
    expect(events(s, "stray_terminal_closed")).toEqual([]);
    expect(cards()).toEqual([]);
  });

  // U261: the adopted Studio (squad _studio) is no squad member: a shell beside it is never a stray,
  // and the Studio itself never gets a rebind or an unbind.
  test("a shell in the adopted Studio's worktree is left alone, and the Studio gets no rebind", async () => {
    const { s, orca, tick, cards } = await loopRig();
    const studio = String(s.get("projects", { label: "fx" })!.studio_wt);
    s.upsert("members", { project: "fx", squad: "_studio", wt: studio }, { role: "studio", suffix: "", agent: "claude", handle: "term_studio",
      status: "running", observed_at: T, updated_at: T });
    orca.agent(studio, "term_studio", "claude");
    orca.shells.push({ wt: studio, handle: "term_bash", title: "user@host: ~" });
    await tick(T + 5);
    await tick(T + 5 + STRAY_EVERY);
    expect(orca.calls.filter((c) => c.args.some((x) => x === studio || x === "term_studio" || x === "term_bash")).map((c) => c.op)).toEqual([]);
    expect(cards()).toEqual([]);
  });

  test("a busy one gets one card and no close; once it's gone the card goes", async () => {
    const { orca, wt, tick, cards } = await loopRig();
    up(orca, wt("builder"));
    orca.shells.push({ wt: wt("builder"), handle: "term_bash", title: "vim", busy: true });
    await tick(T + 5);
    await tick(T + 5 + STRAY_EVERY);
    await tick(T + 5 + 2 * STRAY_EVERY);
    expect(orca.of("terminal-close")).toEqual([]);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatchObject({ title: "Stray terminal: demo", handle: "term_bash", wt: wt("builder") });
    expect(String(cards()[0].question)).toContain("term_bash");
    orca.shells = [];                                                 // the user closed it
    await tick(T + 5 + 3 * STRAY_EVERY);
    await tick(T + 5 + 3 * STRAY_EVERY + 1);
    expect(cards()).toEqual([]);
  });

  test("a card clears once its terminal is gone, also when the squad is closed or the agent list can't be read", async () => {
    for (const how of ["closed", "no agent list"]) {
      const { s, orca, wt, tick, cards } = await loopRig();
      up(orca, wt("builder"));
      orca.shells.push({ wt: wt("builder"), handle: "term_bash", title: "vim", busy: true });
      await tick(T + 5);
      expect(cards()).toHaveLength(1);
      if (how === "closed") s.db.run("UPDATE squads SET status = 'closed' WHERE topic = 'demo'");
      else for (let n = 0; n < 2; n++) orca.fail("agent-handles", { code: 1, out: "", err: "orca adapter: agent-handles could not read the terminal list" });
      orca.shells = [];
      await tick(T + 5 + STRAY_EVERY);
      await tick(T + 5 + STRAY_EVERY + 1);
      expect([how, cards()]).toEqual([how, []]);
    }
  });

  test("a busy one that goes idle is closed and its card resolved", async () => {
    const { orca, wt, tick, cards } = await loopRig();
    up(orca, wt("builder"));
    orca.shells.push({ wt: wt("builder"), handle: "term_bash", title: "make", busy: true });
    await tick(T + 5);
    expect(cards()).toHaveLength(1);
    orca.shells[0].busy = false;
    await tick(T + 5 + STRAY_EVERY);
    expect(orca.of("terminal-close")).toHaveLength(1);
    expect(cards()).toEqual([]);
  });

  test("an idle one whose close fails gets one card and is not closed again every pass", async () => {
    const { s, orca, wt, tick, cards } = await loopRig();
    up(orca, wt("builder"));
    orca.shells.push({ wt: wt("builder"), handle: "term_bash", title: "bash" });
    orca.closeFails.add("term_bash");
    await tick(T + 5);
    await tick(T + 5 + STRAY_EVERY);
    await tick(T + 5 + 2 * STRAY_EVERY);
    expect(orca.of("terminal-close")).toHaveLength(1);
    expect(cards()).toHaveLength(1);
    expect(String(cards()[0].question)).toContain("could not close it");
    expect(events(s, "stray_terminal_closed")).toEqual([]);
  });

  test("the loop's pane in the Lead's worktree is never touched, by handle or by title", async () => {
    const { orca, pane, wt, tick, cards, check } = await loopRig();
    up(orca, wt("lead"));
    orca.shells.push({ wt: wt("lead"), handle: pane, title: "bash" }, { wt: wt("lead"), handle: "term_restart", title: "ds-loop restart" });
    orca.shells.push({ wt: wt("lead"), handle: "term_busyloop", title: "ds-loop demo", busy: true });
    await tick(T + 5);
    await tick(T + 5 + STRAY_EVERY);
    expect(orca.of("terminal-close")).toEqual([]);
    expect(cards()).toEqual([]);
    expect((await check()).filter((a) => a.kind === "stray")).toEqual([]);
  });

  test("none for a worktree whose member has no live agent or is starting, for a busy Setup tab, or when the shell read fails", async () => {
    const { s, orca, wt, check } = await rig();
    orca.shells.push({ wt: wt("thinker"), handle: "term_t", title: "bash" });     // the thinker has no agent terminal
    up(orca, wt("builder"));
    orca.shells.push({ wt: wt("builder"), handle: "term_setup", title: "Setup", busy: true });
    expect((await check()).filter((a) => a.kind === "stray")).toEqual([]);
    up(orca, wt("lead"), "term_l");
    const lead = s.db.query("SELECT id FROM members WHERE project = 'fx' AND wt = ?").get(wt("lead")) as { id: number };
    s.db.run("INSERT INTO episodes (project, subject, kind, episode_key, state, source, started_at, observed_at) VALUES ('fx', ?, 'action:member', 'start:0', 'running', 'loop', ?, ?)", [`member:${lead.id}`, T, T]);   // its start claim runs
    orca.shells.push({ wt: wt("lead"), handle: "term_lb", title: "bash" });
    const at = (n: number) => reconcile({ store: s, project: "fx", tick: 2, now: T + n, fired: [], poked: new Set() }, orca);
    expect((await at(STRAY_EVERY)).filter((a) => a.kind === "stray")).toEqual([]);
    orca.fail("terminal-shells", { code: 1, out: "", err: "orca adapter: terminal-shells could not read the terminal list" });
    s.db.run("UPDATE episodes SET state = 'done', ended_at = ? WHERE kind = 'action:member'", [T]);   // the start settled
    expect((await at(2 * STRAY_EVERY)).filter((a) => a.kind === "stray")).toEqual([]);
    expect((await at(2 * STRAY_EVERY + 1)).map((a) => a.subject).filter((x) => x.startsWith("stray:"))).toEqual(["stray:term_lb"]);
  });

  test("a shell with output in the last STRAY_QUIET is in use: not closed or carded until it goes quiet", async () => {
    const { orca, wt, tick, cards } = await loopRig();
    up(orca, wt("builder"));
    orca.shells.push({ wt: wt("builder"), handle: "term_bash", title: "bash", out: T });
    orca.shells.push({ wt: wt("builder"), handle: "term_vim", title: "vim", busy: true, out: T });
    await tick(T + 5);
    await tick(T + STRAY_QUIET - 1);
    expect(orca.of("terminal-close")).toEqual([]);
    expect(cards()).toEqual([]);
    await tick(T + STRAY_QUIET + STRAY_EVERY);
    expect(orca.of("terminal-close").map((c) => c.args)).toEqual([["term_bash"]]);
    expect(cards().map((c) => c.handle)).toEqual(["term_vim"]);
  });

  test("a shell that prints between the find and the close is left for a later look", async () => {
    const { orca, wt, tick } = await loopRig();
    up(orca, wt("builder"));
    orca.shells.push({ wt: wt("builder"), handle: "term_bash", title: "bash" });
    let n = 0;
    orca.onCall = (c) => { if (c.op === "terminal-shells" && ++n === 2) orca.shells[0].out = T + 5; };
    await tick(T + 5);
    expect(orca.of("terminal-close")).toEqual([]);
    await tick(T + 5 + STRAY_QUIET + 1);
    expect(orca.of("terminal-close").map((c) => c.args)).toEqual([["term_bash"]]);
  });

  test("the shell list is read once per STRAY_EVERY per project", async () => {
    const { orca, wt, check } = await rig();
    up(orca, wt("builder"));
    await check();
    await check();
    expect(orca.of("terminal-shells")).toHaveLength(1);
  });
});

// U97: a member worktree with two live sessions of its agent keeps the newest; each older one
// gets one `duplicate` action — idle closed, busy carded after 30 min, a newest the Run does not
// list carded with nothing closed. A `claude -p` beside the agent is never counted.
describe("a duplicate agent in a member's worktree", () => {
  const fulfillers = load<Fulfiller & Reconciler>(DIRS.fulfil);
  async function loopRig() {
    const r = await rig();
    const act = new LoopActuator({ orca: r.orca, fulfillers: (await fulfillers).filter((f) => f.kinds) });
    const loop = new Loop(r.s, { observers: [], reconcilers: [...await fulfillers, members(r.orca)] }, act, { projects: () => ["fx"] });
    loop.boot(T);
    const tick = async (at: number) => { await loop.tick(at); await act.drain(); importJson(r.s); };
    const cards = () => { const f = join(r.s.root, "fx", "alerts.json"); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((x) => x.kind === "duplicate_agent") : []; };
    return { ...r, act, tick, cards };
  }
  const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
  // Busy is the worktree's observed state (production has no per-terminal signal): `working`
  // while the older session is mid-turn, `waiting` once it is idle at its prompt.
  const two = (orca: FakeBackend, wt: string) => {
    orca.agent(wt, "term_old", "claude");
    orca.agent(wt, "term_new", "claude");
    orca.dispatched(RUN, wt, "term_new");
  };
  const busy = (s: Store, wt: string, on: boolean) =>
    s.upsert("observed_workers", { project: "fx", wt }, { state: on ? "working" : "waiting", observed_at: T });

  test("the older idle one gets one duplicate action and is closed, with duplicate_agent_closed", async () => {
    const { s, orca, wt, tick, cards, check } = await loopRig();
    two(orca, wt("builder"));
    busy(s, wt("builder"), false);
    const got = await check();
    expect(got.filter((a) => a.kind === "duplicate").map((a) => [a.subject, (a.payload as { handle: string }).handle])).toEqual([["duplicate:term_old", "term_old"]]);
    await tick(T + 5);
    expect(orca.of("terminal-close").map((c) => c.args)).toEqual([["term_old"]]);
    expect(orca.agents.map((a) => a.handle)).toEqual(["term_new"]);
    expect(events(s, "duplicate_agent_closed")).toEqual([{ wt: wt("builder"), handle: "term_old", title: "claude" }]);
    expect(cards()).toEqual([]);
  });

  test("the older busy one is not closed; still busy after 30 min it gets one card", async () => {
    const { s, orca, wt, tick, cards } = await loopRig();
    two(orca, wt("builder"));
    busy(s, wt("builder"), true);
    await tick(T + 5);
    await tick(T + 5 + 900);
    expect(orca.of("terminal-close")).toEqual([]);
    expect(cards()).toEqual([]);
    await tick(T + 5 + 1800);
    await tick(T + 5 + 1860);
    expect(orca.of("terminal-close")).toEqual([]);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]).toMatchObject({ handle: "term_old", wt: wt("builder") });
  });

  test("a busy one that goes idle is closed and gets no card", async () => {
    const { s, orca, wt, tick, cards } = await loopRig();
    two(orca, wt("builder"));
    busy(s, wt("builder"), true);
    await tick(T + 5);
    busy(s, wt("builder"), false);
    await tick(T + 65);
    await tick(T + 125);
    expect(orca.of("terminal-close").map((c) => c.args)).toEqual([["term_old"]]);
    expect(cards()).toEqual([]);
  });

  test("the Run naming the older handle gets one card and no close", async () => {
    const { orca, wt, tick, cards } = await loopRig();
    orca.agent(wt("builder"), "term_old", "claude");
    orca.agent(wt("builder"), "term_new", "claude");
    orca.dispatched(RUN, wt("builder"), "term_old");
    await tick(T + 5);
    await tick(T + 65);
    expect(orca.of("terminal-close")).toEqual([]);
    expect(cards()).toHaveLength(1);
  });

  test("an idle one whose close fails gets one card and is not closed again every pass", async () => {
    const { s, orca, wt, tick, cards } = await loopRig();
    two(orca, wt("builder"));
    busy(s, wt("builder"), false);
    orca.closeFails.add("term_old");
    await tick(T + 5);
    await tick(T + 65);
    await tick(T + 125);
    expect(orca.of("terminal-close")).toHaveLength(1);
    expect(cards()).toHaveLength(1);
    expect(events(s, "duplicate_agent_closed")).toEqual([]);
  });

  test("one already gone before the close is done, with no event", async () => {
    const { s, orca, wt, tick, cards } = await loopRig();
    two(orca, wt("builder"));
    busy(s, wt("builder"), false);
    orca.gone("term_old");
    await tick(T + 5);
    expect(orca.of("terminal-close")).toEqual([]);
    expect(events(s, "duplicate_agent_closed")).toEqual([]);
    expect(cards()).toEqual([]);
  });

  test("one agent, or a claude -p beside it, gets nothing", async () => {
    const { orca, wt, check } = await rig();
    orca.agent(wt("builder"), "term_new", "claude");
    orca.dispatched(RUN, wt("builder"), "term_new");
    expect((await check()).filter((a) => a.kind === "duplicate")).toEqual([]);
    orca.agent(wt("builder"), "term_p", "claude -p --model opus");
    expect((await check()).filter((a) => a.kind === "duplicate")).toEqual([]);
  });
});

// U151 review: nothing fulfils a `stopped` member wish yet, so it must not read as a start in
// flight forever (which would hold the drift settle, duplicate check and rebinds for that member).
test("a start in progress is a lock or a start claim waiting to be acted again, never the wish alone (U152)", () => {
  const root = mkdtempSync(join(tmpdir(), "zzstart-")), s = open(root);
  try {
    const m = { id: 7, project: "p", wt: "wt_7", want: "stopped", want_result: null };
    expect(starting({ ...m, want: "running" }, 1000, s)).toBe(false);
    expect(starting(m, 1000, s)).toBe(false);
    // A start claim running in the background holds it, whatever the wish says now.
    s.db.run("INSERT INTO episodes (project, subject, kind, episode_key, state, source, started_at, observed_at) VALUES ('p', 'member:7', 'action:member', 'want:1', 'running', 'loop', 1, 1)");
    expect(starting(m, 1000, s)).toBe(true);
    // A boot reset (or a wait/retry) leaves it pending, to be acted again: still in flight.
    s.db.run("UPDATE episodes SET state = 'pending', action = '{}'");
    expect(starting(m, 1000, s)).toBe(true);
    s.db.run("UPDATE episodes SET state = 'done', ended_at = 2, action = NULL");
    expect(starting(m, 1000, s)).toBe(false);
    // An open worker-start call for its worktree is a start in flight too.
    s.db.run("INSERT INTO orca_calls (retry_id, key, op, sender, at, state, project, member) VALUES ('rid-7', 'k', 'worker-start', 'term_9', 1, 'sent', 'p', 'wt_7')");
    expect(starting(m, 1000, s)).toBe(true);
    s.db.run("UPDATE orca_calls SET state = 'completed'");
    expect(starting(m, 1000, s)).toBe(false);
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
});
