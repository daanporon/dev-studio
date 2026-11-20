// rebind.test.ts — U71: fulfil/rebind.ts puts a member back in its squad's Run from the loop's pane
// (a fresh copy of its last role task, dispatched with --inject to its live terminal) and fences a
// Run worker that is no longer a member. Hermetic: a copy of tests/fixtures/loop/state and the fake
// Orca (bin/loop/fakes/orca.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { sender } from "../../bin/loop/messages/coordinator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import rebindFulfiller, { UNBIND_GRACE } from "../../bin/loop/fulfil/rebind.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { members } from "../../bin/loop/reconcilers/members.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000, RUN = "run_fixture01", SQUAD_TASK = "task_fixture01";

const temps: string[] = [], stores: Store[] = [];
const env = process.env.DS_STATE_ROOT;
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (env === undefined) delete process.env.DS_STATE_ROOT; else process.env.DS_STATE_ROOT = env;
});

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
async function rig() {
  const d = mkdtempSync(join(tmpdir(), "zzrebind-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  process.env.DS_STATE_ROOT = d;
  const orca = new FakeBackend();
  orca.tasks.set(SQUAD_TASK, { run: RUN, spec: "the squad's umbrella task", title: "demo", parent: null, startable: false });
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [members(orca), ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const pane = await sender(s, orca, "fx", "demo", T);
  const wt = (role: string) => String((s.db.query("SELECT wt FROM members WHERE project = 'fx' AND squad = 'demo' AND role = ?").get(role) as Row).wt);
  const tick = async (at: number) => { const r = await loop.tick(at); await act.drain(); return r; };
  const exec = (a: Action, at = T) => rebindFulfiller.exec(a, { store: s, project: "fx", tick: 1, now: at, fired: [], poked: new Set(), act });
  const rebind = (w: string): Action => ({ project: "fx", squad: "demo", member: w, subject: `rebind:${w}`, kind: "rebind", episode: "e1", payload: { wt: w } });
  return { s, orca, act, tick, exec, rebind, pane, wt };
}
const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
const relayed = (s: Store, id: string, from: string, forwarded: number | null) =>
  s.db.run("INSERT INTO relayed (msg_id, project, squad, run_id, from_handle, type, subject, body, seen_at, forwarded_at) VALUES (?, 'fx', 'demo', ?, ?, 'status', 's', 'b', ?, ?)",
    [id, RUN, from, T, forwarded]);

describe("rebind: a member back in its Run", () => {
  test("a restarted Lead gets a new role task from its last spec under the squad task, dispatched to its terminal from the loop's pane", async () => {
    const { s, orca, tick, pane, wt } = await rig();
    const old = orca.dispatched(RUN, wt("lead"), "term_old", { task: "task_lead1", spec: "You are the Lead of demo." });
    orca.agent(wt("lead"), "term_new");
    await tick(T + 5);
    const [create] = orca.of("task-create");
    expect(create.args).toEqual([RUN, "You are the Lead of demo.", "lead of demo (rebound)", SQUAD_TASK]);
    expect(create.via.from).toBe(pane);
    const task = [...orca.tasks].find(([, t]) => t.parent === SQUAD_TASK)![0];
    expect(orca.of("dispatch").map((c) => [c.args, c.via.from])).toEqual([[[task, "term_new", RUN], pane]]);
    expect(orca.of("dispatch").some((c) => c.args[0] === SQUAD_TASK)).toBe(false);
    const [ev] = events(s, "member_rebound");
    expect(ev).toMatchObject({ run: RUN, wt: wt("lead"), handle: "term_new", was: "term_old", task, from: "task_lead1", fenced: old.id });
    // U89: the new dispatch is fenced first, then the rebind dispatch itself is settled: no open
    // dispatch is left on a Lead's terminal.
    expect(orca.of("dispatch-abandon").map((c) => c.args)).toEqual([[old.id], [ev.dispatch]]);
    expect(orca.dispatches.filter((d) => d.handle === "term_new" && d.status === "dispatched")).toEqual([]);
    expect(events(s, "member_rebound_settled")).toEqual([{ run: RUN, wt: wt("lead"), handle: "term_new", task, dispatch: ev.dispatch, at: T + 5 }]);
    await tick(T + 10);                                                                 // bound now: nothing more
    expect(orca.of("task-create")).toHaveLength(1);
    expect(events(s, "member_rebound")).toHaveLength(1);
    expect(events(s, "member_rebound_settled")).toHaveLength(1);
  });

  test("a Builder whose role task failed with its terminal up gets a fresh copy on the same terminal, nothing to fence", async () => {
    const { s, orca, exec, rebind, wt } = await rig();
    orca.dispatched(RUN, wt("builder"), "term_b", { task: "task_b1", spec: "Build U1.", status: "failed" });
    orca.agent(wt("builder"), "term_b");
    expect(await exec(rebind(wt("builder")))).toMatchObject({ done: true });
    expect(orca.of("task-create")[0].args.slice(1, 3)).toEqual(["Build U1.", "builder u1-spike-loop-as-coordinator of demo (rebound)"]);
    expect(orca.of("dispatch")[0].args[1]).toBe("term_b");
    expect(orca.of("dispatch-abandon")).toEqual([]);
    expect(events(s, "member_rebound")[0]).toMatchObject({ was: null, fenced: null });
    // U89: a Builder keeps its dispatch until it reports done — no settle, still open.
    expect(events(s, "member_rebound_settled")).toEqual([]);
    expect(orca.dispatches.filter((d) => d.handle === "term_b" && d.status === "dispatched")).toHaveLength(1);
    // Its copy fails in turn: the next rebind makes another task, not a replay of the first.
    orca.dispatches.at(-1)!.status = "failed";
    expect(await exec(rebind(wt("builder")), T + 60)).toMatchObject({ done: true });
    expect(orca.of("task-create")).toHaveLength(2);
    expect(new Set(orca.of("dispatch").map((c) => c.args[0])).size).toBe(2);
  });

  // U89: a Lead's rebind settles once the bind is seen, so a later failure of that dispatch
  // reads as bound, not as "did not take" — the redo below runs on a Builder, whose dispatch the
  // loop leaves open until it reports done.
  test("U80: a redo makes a new task and dispatch and one event; a replay of completed calls writes no event; the old dispatch stays fenced", async () => {
    const { s, orca, exec, rebind, wt } = await rig();
    const old = orca.dispatched(RUN, wt("builder"), "term_old", { task: "task_b1", spec: "Build U1." });
    orca.agent(wt("builder"), "term_new");
    expect(await exec(rebind(wt("builder")))).toMatchObject({ done: true });
    const first = events(s, "member_rebound");
    expect(first).toHaveLength(1);
    expect(orca.dispatches.find((d) => d.id === old.id)?.status).toBe("failed");
    orca.dispatches.at(-1)!.status = "failed";                                          // the rebind's task did not take
    const redo = (task: string, at: number) => exec({ ...rebind(wt("builder")), payload: { wt: wt("builder"), redo: task } }, at);
    expect(await redo(first[0].task, T + 60)).toMatchObject({ done: true });
    expect(orca.of("task-create")).toHaveLength(2);
    expect(new Set(orca.of("dispatch").map((c) => c.args[0])).size).toBe(2);
    const second = events(s, "member_rebound");
    expect(second).toHaveLength(2);
    expect(second[1]).toMatchObject({ handle: "term_new", from: first[0].task, at: T + 60 });
    expect(orca.of("dispatch-abandon")).toHaveLength(1);                                // the old dispatch is fenced once, not again (a Builder is never settled)
    expect(events(s, "member_rebound_settled")).toEqual([]);
    // The same redo again (its claim replayed): the completed calls run again under their ids and change nothing.
    orca.dispatches.pop();                                                              // Orca does not list the redo's dispatch: the Run still shows the first task
    expect(await redo(first[0].task, T + 61)).toMatchObject({ done: true });
    expect(orca.of("task-create")).toHaveLength(2);                                     // the same key: one task still
    expect(events(s, "member_rebound")).toHaveLength(2);
  });

  test("U80: a live member ends its redo count; a giveup raises one card that live resolves", async () => {
    const { s, orca, exec, rebind, wt } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_l", { task: "task_l1", status: "failed" });
    orca.agent(wt("lead"), "term_l");
    expect(await exec(rebind(wt("lead")))).toMatchObject({ done: true });
    const alertsFile = join(s.root, "fx", "alerts.json");
    const give = { ...rebind(wt("lead")), episode: "giveup|x", payload: { wt: wt("lead"), handle: "term_l", giveup: true, tasks: ["task_l1", "task_1"], status: "failed" } };
    expect(await exec(give, T + 5000)).toEqual({ done: true });
    const cards = () => (JSON.parse(readFileSync(alertsFile, "utf8")).alerts as Row[]).filter((c) => c.kind === "rebind_failed");
    expect(cards()).toHaveLength(1);
    expect(String(cards()[0].question)).toContain("task_l1, task_1");
    expect(String(cards()[0].question)).toContain("failed");
    expect(events(s, "member_rebound")).toHaveLength(1);
    orca.dispatches.at(-1)!.status = "dispatched";                                      // it turns live
    expect(await exec(rebind(wt("lead")), T + 6000)).toEqual({ done: true, result: "live on term_l" });
    expect(cards()).toHaveLength(0);
    expect((s.get("episodes", { project: "fx", subject: `redo:${wt("lead")}`, kind: "redo" }) as Row).ended_at).toBe(T + 6000);
  });

  test("a Builder whose role task completed (worker_done) has finished: no copy of its brief; a Lead's completed task is copied", async () => {
    const { s, orca, exec, rebind, wt } = await rig();
    orca.dispatched(RUN, wt("builder"), "term_b", { task: "task_b1", status: "completed" });
    orca.agent(wt("builder"), "term_b");
    expect(await exec(rebind(wt("builder")))).toMatchObject({ dropped: expect.stringContaining("finished") });
    orca.dispatched(RUN, wt("lead"), "term_l", { task: "task_l1", status: "completed" });
    orca.agent(wt("lead"), "term_l");
    expect(await exec(rebind(wt("lead")))).toMatchObject({ done: true });
    expect(orca.of("task-create")).toHaveLength(1);
    expect(events(s, "member_rebound").map((e) => e.wt)).toEqual([wt("lead")]);
  });

  test("it fences the old dispatch and moves the unforwarded relayed rows and the stored handle to the new terminal", async () => {
    const { s, orca, exec, rebind, wt } = await rig();
    const old = orca.dispatched(RUN, wt("lead"), "term_old", { task: "task_lead1" });
    orca.agent(wt("lead"), "term_new");
    relayed(s, "msg_a", "term_old", null);
    relayed(s, "msg_b", "term_old", T);
    relayed(s, "msg_c", "dispatch:ctx_builder", null);
    s.db.run("INSERT INTO observed_terminals (project, handle, wt, title, observed_at) VALUES ('fx', 'term_old', ?, 'demo/lead', ?)", [wt("lead"), T]);
    expect(await exec(rebind(wt("lead")))).toMatchObject({ done: true });
    expect(orca.dispatches.find((d) => d.id === old.id)?.status).toBe("failed");
    const from = (id: string) => (s.get("relayed", { msg_id: id }) as Row).from_handle;
    expect([from("msg_a"), from("msg_b"), from("msg_c")]).toEqual(["term_new", "term_old", "dispatch:ctx_builder"]);
    expect(s.db.query("SELECT handle, wt, observed_at, gone_at FROM observed_terminals WHERE project = 'fx'").all()).toEqual([{ handle: "term_new", wt: wt("lead"), observed_at: T, gone_at: null }]);
  });

  test("when the new terminal is already observed, the old row is marked gone instead of renamed", async () => {
    const { s, orca, exec, rebind, wt } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old", { task: "task_lead1" });
    orca.agent(wt("lead"), "term_new");
    s.db.run("INSERT INTO observed_terminals (project, handle, wt, title, observed_at) VALUES ('fx', 'term_old', ?, 'demo/lead', ?)", [wt("lead"), T - 60]);
    s.db.run("INSERT INTO observed_terminals (project, handle, wt, title, observed_at) VALUES ('fx', 'term_new', ?, 'demo/lead', ?)", [wt("lead"), T]);
    expect(await exec(rebind(wt("lead")), T + 5)).toMatchObject({ done: true });
    expect(s.db.query("SELECT handle, gone_at FROM observed_terminals WHERE project = 'fx' ORDER BY handle").all())
      .toEqual([{ handle: "term_new", gone_at: null }, { handle: "term_old", gone_at: T + 5 }]);
  });

  test("an unfenced old dispatch that is live again on a live terminal is kept, not fenced", async () => {
    const { s, orca, exec, rebind, wt } = await rig();
    const d = orca.dispatched(RUN, wt("lead"), "term_l", { task: "task_lead1" });
    orca.agent(wt("lead"), "term_l");
    s.db.run("INSERT INTO orca_calls (retry_id, key, op, project, squad, member, at, state) VALUES ('r1', ?, 'dispatch-abandon', 'fx', 'demo', ?, ?, 'failed')", [`rebind-fence:${d.id}`, wt("lead"), T - 60]);
    expect(await exec(rebind(wt("lead")))).toEqual({ done: true, result: "live on term_l" });
    expect(orca.of("dispatch-abandon")).toEqual([]);
  });

  test("a member already live on its terminal is done with no call; one with no live terminal is dropped", async () => {
    const { orca, exec, rebind, wt } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_l");
    orca.agent(wt("lead"), "term_l");
    expect(await exec(rebind(wt("lead")))).toEqual({ done: true, result: "live on term_l" });
    orca.dispatched(RUN, wt("thinker"), "term_t", { status: "failed" });
    expect(await exec(rebind(wt("thinker")))).toMatchObject({ dropped: expect.stringContaining("no live agent terminal") });
    expect(orca.of("task-create")).toEqual([]);
    expect(orca.of("dispatch")).toEqual([]);
  });

  test("a failed dispatch is an error, not done, and its retry dispatches the task it made", async () => {
    const { s, orca, exec, rebind, wt } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old", { task: "task_lead1", status: "failed" });
    orca.agent(wt("lead"), "term_new");
    orca.fail("dispatch", { code: 1, out: "", err: "orca adapter: dispatch of task_1 to term_new failed: boom" });
    expect(await exec(rebind(wt("lead")))).toEqual({ retry: expect.stringContaining("boom") });
    expect(events(s, "member_rebound")).toEqual([]);
    expect(await exec(rebind(wt("lead")), T + 1)).toMatchObject({ done: true });
    expect(orca.of("task-create")).toHaveLength(1);                                     // its write-ahead row keeps the task
    expect(orca.of("dispatch").map((c) => c.args[0])).toEqual(["task_1", "task_1"]);
    expect([...orca.tasks.values()].filter((t) => t.parent === SQUAD_TASK)).toHaveLength(1);
  });

  // U150: the live storm (37k dispatch calls on 54 keys by 2026-11-07): Orca refuses a terminal that
  // already has an active dispatch, and the rebind's episode flips with the order Orca lists the
  // worktree's old dispatches in, so each read started its tries afresh. Now it is one refusal
  // event and one card, and no further dispatch until the member's start changes.
  test("U150: a dispatch refused for an active dispatch is one event, one card and no further call until the member restarts", async () => {
    const { s, orca, act, tick, wt } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old1", { task: "task_a", spec: "You are the Lead of demo.", status: "failed" });
    orca.dispatched(RUN, wt("lead"), "term_old2", { task: "task_b", spec: "You are the Lead of demo.", status: "failed" });
    orca.agent(wt("lead"), "term_new");
    const live = (task: string) => ({ code: 1, out: "", err: `orca adapter: dispatch of ${task} to term_new failed: {   "id": "299eb9a9-0196-41ff-ad08-7fdf34382d45",   "ok": false,   "error": {     "code": "runtime_error",     "message": "Terminal term_new already has an active dispatch (ctx_a021b116dd90 for task task_b3d1aa882c0f) Orchestration mutation request ID: 684c95b7-25b4-" } }` });
    let refusing = true;
    orca.answer = (c) => (refusing && c.op === "dispatch" ? live(c.args[0]) : undefined);
    const episodes = new Set<string>(), ready = act.ready.bind(act);
    act.ready = (a, c) => { if (a.kind === "rebind") episodes.add(a.episode); return ready(a, c); };
    for (let t = T + 5; t < T + 65; t++) { orca.dispatches.reverse(); await tick(t); }   // the listing flips every read
    expect(episodes.size).toBeGreaterThan(1);
    expect(orca.of("dispatch")).toHaveLength(1);
    const refusals = events(s, "refusal");
    expect(refusals).toEqual([expect.objectContaining({ subject: `rebind:${wt("lead")}`, kind: "rebind", class: "permanent", count: 1 })]);
    const cards = () => (JSON.parse(readFileSync(join(s.root, "fx", "alerts.json"), "utf8")).alerts as Row[]).filter((x) => x.title === "Loop action refused");
    expect(cards()).toHaveLength(1);
    expect(String(cards()[0].question)).toContain("already has an active dispatch");
    // The member restarts: what the bind depends on changed, so it is tried again (and goes through).
    s.db.run("UPDATE members SET started = '2027-01-15T08:00:00Z' WHERE wt = ?", [wt("lead")]);
    refusing = false;
    await tick(T + 70); await tick(T + 71);
    expect(orca.of("dispatch")).toHaveLength(2);
    expect(events(s, "member_rebound")).toHaveLength(1);
    expect(s.db.query("SELECT count(*) n FROM refusals").get()).toEqual({ n: 0 });
    expect(cards()).toEqual([]);
  });

  test("U150: a refused rebind is tried again once the worktree's newest dispatch ends, with no restart", async () => {
    const { s, orca, tick, wt } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old", { task: "task_a", spec: "You are the Lead of demo.", status: "failed" });
    orca.agent(wt("lead"), "term_new");
    const seen = (status: string) => s.db.run(`INSERT INTO observed_workers (project, wt, dispatch_id, dispatch, observed_at) VALUES ('fx', ?, 'ctx_a021b116dd90', ?, 0)
      ON CONFLICT DO UPDATE SET dispatch = excluded.dispatch`, [wt("lead"), status]);
    seen("dispatched");
    let refusing = true;
    orca.answer = (c) => (refusing && c.op === "dispatch" ? { code: 1, out: "", err: "Terminal term_new already has an active dispatch (ctx_a021b116dd90)" } : undefined);
    for (let t = T + 5; t < T + 20; t++) await tick(t);
    expect(orca.of("dispatch")).toHaveLength(1);
    // The active dispatch Orca named ends: the observer sees the worktree's newest dispatch settle.
    seen("completed"); refusing = false;
    await tick(T + 21); await tick(T + 22);
    expect(orca.of("dispatch")).toHaveLength(2);
    expect(events(s, "member_rebound")).toHaveLength(1);
  });

  test("U150: a refused rebind is tried again once a new main agent runs in the worktree (a terminal replaced by hand)", async () => {
    const { s, orca, tick, wt } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old", { task: "task_a", spec: "You are the Lead of demo.", status: "failed" });
    orca.agent(wt("lead"), "term_new");
    const seen = (pid: number) => s.db.run(`INSERT INTO observed_workers (project, wt, dispatch_id, dispatch, pid, started_at, observed_at) VALUES ('fx', ?, 'ctx_a021b116dd90', 'dispatched', ?, ?, 0)
      ON CONFLICT DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at`, [wt("lead"), pid, pid]);
    seen(4100);
    let refusing = true;
    orca.answer = (c) => (refusing && c.op === "dispatch" ? { code: 1, out: "", err: "Terminal term_new already has an active dispatch (ctx_a021b116dd90)" } : undefined);
    for (let t = T + 5; t < T + 20; t++) await tick(t);
    expect(orca.of("dispatch")).toHaveLength(1);
    // The operator replaces the agent by hand: the walk sees a new main process, nothing else changes.
    seen(4200); refusing = false;
    await tick(T + 21); await tick(T + 22);
    expect(orca.of("dispatch")).toHaveLength(2);
    expect(events(s, "member_rebound")).toHaveLength(1);
  });

  test("the old dispatch is fenced only once the new one is up; a failed fence is an error and the next rebind fences it first", async () => {
    const { s, orca, exec, rebind, wt } = await rig();
    const old = orca.dispatched(RUN, wt("lead"), "term_old", { task: "task_lead1" });
    orca.agent(wt("lead"), "term_new");
    orca.fail("dispatch-abandon", { code: 1, out: "", err: "orca adapter: dispatch-abandon of ctx_1 refused: nope" });
    expect(await exec(rebind(wt("lead")))).toEqual({ retry: expect.stringContaining("nope") });
    const ops = orca.calls.map((c) => c.op);
    expect(ops.indexOf("dispatch")).toBeLessThan(ops.indexOf("dispatch-abandon"));       // the newest dispatch never settles (U64's crash watch)
    expect(events(s, "member_rebound")).toHaveLength(1);
    expect(orca.dispatches.find((d) => d.id === old.id)?.status).toBe("dispatched");
    expect(await exec(rebind(wt("lead")), T + 30)).toEqual({ done: true, result: "live on term_new" });
    const rebound = events(s, "member_rebound")[0].dispatch as string;
    // U89: the old dispatch is fenced first, then the rebind dispatch is settled.
    expect(orca.of("dispatch-abandon").map((c) => c.args)).toEqual([[old.id], [old.id], [rebound]]);
    expect(orca.dispatches.find((d) => d.id === old.id)?.status).toBe("failed");
    expect(orca.of("dispatch")).toHaveLength(1);
    // U89: a third run finds the member bound through the settled rebind: no second task.
    expect(await exec(rebind(wt("lead")), T + 60)).toEqual({ done: true, result: "settled on term_new" });
    expect(orca.of("dispatch-abandon")).toHaveLength(3);                                 // fenced and settled: nothing again
    expect(orca.of("dispatch")).toHaveLength(1);
  });

  test("U89: settling twice writes one event; a settle for a dispatch the loop did not make is refused", async () => {
    const { s, orca, exec, wt } = await rig();
    const d = orca.dispatched(RUN, wt("lead"), "term_l", { task: "task_lead1", spec: "You are the Lead of demo." });
    orca.agent(wt("lead"), "term_l");
    const settle = (dispatch: string): Action => ({ project: "fx", squad: "demo", member: wt("lead"), subject: `rebind:${wt("lead")}`, kind: "rebind", episode: `settle|${dispatch}`, payload: { wt: wt("lead"), handle: "term_l", settle: dispatch } });
    // A start dispatch is the member's own: the loop never settles it.
    expect(await exec(settle(d.id))).toEqual({ failed: expect.stringContaining("did not make it") });
    expect(orca.of("dispatch-abandon")).toEqual([]);
    s.event("member_rebound", { project: "fx", squad: "demo", member: wt("lead"), payload: { run: RUN, wt: wt("lead"), handle: "term_l", was: null, task: "task_x", from: "task_lead1", dispatch: d.id, fenced: null, at: T } });
    expect(await exec(settle(d.id))).toMatchObject({ done: true });
    expect(orca.of("dispatch-abandon").map((c) => c.args)).toEqual([[d.id]]);
    expect(events(s, "member_rebound_settled")).toHaveLength(1);
    expect(await exec(settle(d.id))).toMatchObject({ done: true });
    expect(orca.of("dispatch-abandon")).toHaveLength(1);
    expect(events(s, "member_rebound_settled")).toHaveLength(1);
    expect(events(s, "member_rebound")).toHaveLength(1);
  });

  test("a member restart-role.sh is restarting waits until its new start is stamped", async () => {
    const { s, orca, exec, rebind, wt } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old", { task: "task_lead1", status: "failed" });
    orca.agent(wt("lead"), "term_new");
    const iso = (t: number) => new Date(t * 1000).toISOString();
    s.db.run("UPDATE members SET started = ?, restarting = ? WHERE wt = ?", [iso(T - 100), iso(T - 10), wt("lead")]);
    expect(await exec(rebind(wt("lead")))).toMatchObject({ wait: expect.stringContaining("being started") });
    s.db.run("UPDATE members SET started = ? WHERE wt = ?", [iso(T - 5), wt("lead")]);
    expect(await exec(rebind(wt("lead")))).toMatchObject({ done: true });
  });

  test("a restart under way waits; the Run's squad task is never dispatched", async () => {
    const { s, orca, act, exec, rebind, wt } = await rig();
    orca.dispatched(RUN, wt("lead"), "term_old", { task: SQUAD_TASK, status: "failed" });   // the Lead ran the umbrella task
    orca.agent(wt("lead"), "term_new");
    const free = act.hold("fx", "demo");
    expect(await exec(rebind(wt("lead")))).toMatchObject({ wait: expect.stringContaining("restart") });
    free();
    expect(await exec(rebind(wt("lead")))).toMatchObject({ done: true });
    expect(orca.of("task-create")[0].args).toEqual([RUN, "the squad's umbrella task", "lead of demo (rebound)", SQUAD_TASK]);
    expect(orca.of("dispatch").map((c) => c.args[0])).not.toContain(SQUAD_TASK);
    expect(events(s, "member_rebound")).toHaveLength(1);
  });
});

describe("unbind: a stray Run worker is fenced", () => {
  test("a live worker that is not a member is fenced once after the grace and logs member_unbound", async () => {
    const { s, orca, tick } = await rig();
    const stray = orca.dispatched(RUN, "fakerepo::/wt/retired", "term_gone");
    await tick(T + 5);
    expect(orca.of("dispatch-abandon")).toEqual([]);                                     // may be a member being added
    await tick(T + 5 + UNBIND_GRACE);
    expect(orca.of("dispatch-abandon").map((c) => c.args)).toEqual([[stray.id]]);
    expect(events(s, "member_unbound")).toEqual([{ run: RUN, wt: "fakerepo::/wt/retired", dispatch: stray.id }]);
    await tick(T + 10 + UNBIND_GRACE);
    expect(orca.of("dispatch-abandon")).toHaveLength(1);
  });

  test("a worktree that becomes a member within the grace is left alone", async () => {
    const { s, orca, tick } = await rig();
    orca.dispatched(RUN, "fakerepo::/wt/new-builder", "term_nb");
    await tick(T + 5);
    s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, observed_at, updated_at) VALUES ('fx', 'demo', 'fakerepo::/wt/new-builder', 'builder', 'u9', 'running', ?, ?)", [T, T]);
    await tick(T + 5 + UNBIND_GRACE);
    expect(orca.of("dispatch-abandon")).toEqual([]);
    expect(events(s, "member_unbound")).toEqual([]);
  });

  test("a failed fence is an error, not done", async () => {
    const { s, orca, act } = await rig();
    const stray = orca.dispatched(RUN, "fakerepo::/wt/retired", "term_gone");
    const a: Action = { project: "fx", squad: "demo", member: stray.wt, subject: `unbind:${stray.wt}`, kind: "unbind", episode: stray.id, payload: { wt: stray.wt, dispatch: stray.id } };
    s.upsert("episodes", { project: "fx", subject: a.subject, kind: "action:unbind" }, { episode_key: a.episode, started_at: T - UNBIND_GRACE, state: "acted", source: "loop", observed_at: T });
    orca.fail("dispatch-abandon", { code: 1, out: "", err: "orca adapter: dispatch-abandon of ctx_1 failed: down" });
    expect(await rebindFulfiller.exec(a, { store: s, project: "fx", tick: 1, now: T, fired: [], poked: new Set(), act })).toEqual({ retry: expect.stringContaining("down") });
    expect(events(s, "member_unbound")).toEqual([]);
  });
});
