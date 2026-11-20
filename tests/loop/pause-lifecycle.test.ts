import pauseResume from "../../bin/loop/reconcilers/pause-resume.ts";
import { beforeAll, afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./pause-fixture.ts";
import { acknowledge, clearDependency, journalPath, paused, projection } from "../../bin/loop/pause/pause.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import pauseLifecycle from "../../bin/loop/fulfil/pause.ts";
import pending from "../../bin/loop/fulfil/pending.ts";
import member from "../../bin/loop/fulfil/member.ts";
import duplicate from "../../bin/loop/fulfil/duplicate.ts";
import { wake } from "../../bin/loop/pause/wake.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import picker from "../../bin/loop/core/decide.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import { copyFileSync } from "node:fs";
import { open as question, answer } from "../../bin/loop/messages/questions.ts";
import { orcaObserver } from "../../bin/loop/observers/orca.ts";

// U150: a transient refusal is tried again every 15 minutes (DS_LOOP_RETRY_S); these tests step
// a retry one tick at a time. The spacing itself is tested in actuator.test.ts ("refusals").
beforeAll(() => { process.env.DS_LOOP_RETRY_S = "1"; });
afterAll(() => { delete process.env.DS_LOOP_RETRY_S; });


// The checkpoint deadline closes only on a tick whose process walk (U149) ran and read no live
// sub-agents: these fixtures walk every tick (an empty process table, so no helpers).
const LIVE_S = process.env.DS_LOOP_LIVE_ACCOUNT_S;
afterEach(() => { if (LIVE_S === undefined) delete process.env.DS_LOOP_LIVE_ACCOUNT_S; else process.env.DS_LOOP_LIVE_ACCOUNT_S = LIVE_S; });
const walking = <F extends { orca: { procs: unknown } }>(f: F): F => { process.env.DS_LOOP_LIVE_ACCOUNT_S = "1"; f.orca.procs = []; return f; };

test("a busy role winding down makes no further backend calls", async () => {
  const f = fixture(); f.orca.agents[0].busy = true;
  f.store.pause({ scope: "member", ...f.target }); await f.tick();
  const calls = f.orca.calls.length;
  for (let n = 0; n < 20; n++) await f.tick();
  expect(f.orca.calls).toHaveLength(calls);
  expect(f.orca.of("pause-deliver")).toHaveLength(1);
  expect(projection(f.store, f.target).state).toBe("pausing");
});

// U150 (the edited pause test): the three-idle-spells hold that waited forever is gone. Each idle
// spell before the deadline is one resend; CHECKPOINT_S after delivery the loop closes anyway and
// writes "checkpoint failed" in the role's journal.
test("a pause with no checkpoint closes 5 minutes after delivery, with the journal line (U150)", async () => {
  const f = walking(fixture()); f.orca.agents[0].busy = true;
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle] });
  const loop = new Loop(f.store, { observers: [f.observer], reconcilers: [pauseLifecycle] }, act, { projects: () => ["p"] });
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  f.store.pause({ scope: "member", ...f.target }); loop.boot(100);
  await tick(100);
  expect(f.orca.of("pause-deliver")).toHaveLength(1);
  for (let spell = 0; spell < 4; spell++) {
    f.orca.agents[0].busy = false; await tick(110 + spell * 20); await tick(111 + spell * 20);
    f.orca.agents[0].busy = true; await tick(112 + spell * 20);
  }
  expect(f.orca.of("pause-deliver")).toHaveLength(5);   // no cap of three
  f.orca.agents[0].busy = false; await tick(398);
  expect(projection(f.store, f.target).state).toBe("pausing");
  expect(f.orca.of("pause-close")).toHaveLength(0);
  f.orca.agents[0].busy = true; await tick(400);       // past the deadline, but busy: not closed mid-step
  expect(f.orca.of("pause-close")).toHaveLength(0);
  expect(projection(f.store, f.target).reason).toContain("closing once the agent is idle");
  f.orca.agents[0].busy = false; await tick(401);
  expect(f.orca.of("pause-close")).toHaveLength(1);
  expect(projection(f.store, f.target)).toMatchObject({ state: "paused" });
  expect(projection(f.store, f.target).reason).toContain("checkpoint failed");
  const generation = String((f.store.db.query("SELECT generation FROM pause_members").get() as { generation: string }).generation);
  const lines = readFileSync(journalPath(f.store, f.target), "utf8").split("\n").filter((l) => l.includes("checkpoint failed"));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toStartWith(`- 1970-01-01T00:06:41Z [keep] checkpoint failed ${generation}: no checkpoint within 5 minutes`);
  const closed = f.store.db.query("SELECT payload FROM events WHERE kind = 'pause_closed'").all() as { payload: string }[];
  expect(closed.map((e) => JSON.parse(e.payload).checkpoint_failed)).toEqual([true]);
  await tick(402); await tick(1400);
  expect(f.orca.of("pause-close")).toHaveLength(1);
  expect(readFileSync(journalPath(f.store, f.target), "utf8").split("\n").filter((l) => l.includes("checkpoint failed"))).toHaveLength(1);
});

test("a late close whose release finishes on a later tick still says checkpoint failed (U150)", async () => {
  const f = walking(fixture()); f.orca.dispatched("run_one", "wt_one", "term_one");
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle] });
  const loop = new Loop(f.store, { observers: [f.observer], reconcilers: [pauseLifecycle] }, act, { projects: () => ["p"] });
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  f.orca.agents[0].busy = true;
  f.store.pause({ scope: "member", ...f.target }); loop.boot(100); await tick(100);
  f.orca.fail("pause-release", { code: 1, out: "", err: "release unconfirmed" });
  f.orca.agents[0].busy = false; await tick(401);
  expect(f.orca.of("pause-close")).toHaveLength(1);
  expect(projection(f.store, f.target).state).toBe("pausing");
  for (let at = 402; at < 1400; at += 60) await tick(at);
  expect(projection(f.store, f.target).state).toBe("paused");
  expect(projection(f.store, f.target).reason).toContain("checkpoint failed");
  expect(readFileSync(journalPath(f.store, f.target), "utf8").split("\n").filter((l) => l.includes("checkpoint failed"))).toHaveLength(1);
  const closed = f.store.db.query("SELECT payload FROM events WHERE kind = 'pause_closed'").all() as { payload: string }[];
  expect(closed.map((e) => JSON.parse(e.payload).checkpoint_failed)).toEqual([true]);
});

test("an agent gone before acknowledgment becomes Paused without claiming a checkpoint", async () => {
  const f = fixture(); f.orca.agents[0].busy = true;
  f.store.pause({ scope: "member", ...f.target }); await f.tick();
  f.orca.agents = []; await f.tick();
  expect(projection(f.store, f.target)).toMatchObject({ state: "paused", checkpoint: null });
  expect(projection(f.store, f.target).reason).toContain("no fresh pause checkpoint");
  expect(f.orca.of("pause-close")).toHaveLength(0);
});

test("a disappeared worktree's failed dispatch release retries on fresh absence observations", async () => {
  const f = fixture(); f.orca.dispatched("run_one", "wt_one", "term_one");
  let gone = false;
  const observer = orcaObserver(f.orca.observer(
    () => gone ? [{ worktreeId: "unrelated" }] : [{ worktreeId: "wt_one", path: f.path }],
    () => [{ wt: "wt_one", squad: "one", role: "builder", suffix: "task", terminals: gone ? [] : ["term_one"] }]));
  const loop = new Loop(f.store, { observers: [observer], reconcilers: [pauseLifecycle] }, f.act, { projects: () => ["p"] });
  f.store.pause({ scope: "member", ...f.target }); loop.boot(10); await loop.tick(11);
  gone = true; f.orca.agents = [];
  f.orca.fail("pause-release", { code: 1, out: "", err: "temporary release failure" });
  await loop.tick(12); expect(projection(f.store, f.target).state).toBe("pausing");
  await loop.tick(13);
  expect(projection(f.store, f.target).state).toBe("paused");
  expect(f.orca.of("pause-release")).toHaveLength(2);
  expect(f.store.get("observed_workers", { project: "p", wt: "wt_one" })).toMatchObject({ gone_at: 12, observed_at: 13 });
  expect(f.orca.of("pause-close")).toHaveLength(0);
});

test("a role becoming busy after observation is retained by the close safety check", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  f.orca.onCall = (c) => { if (c.op === "pause-close") f.orca.agents[0].busy = true; };
  await f.tick();
  expect(projection(f.store, f.target).state).toBe("pausing");
  expect(f.orca.agents.map((a) => a.handle)).toEqual(["term_one"]);
  f.orca.onCall = undefined; f.orca.agents[0].busy = false; await f.tick();
  expect(projection(f.store, f.target).state).toBe("paused");
});

test.each(["worker", "terminals", "dispatch", "identity", "agent state"])("missing or stale %s facts cannot authorize a close", async (fact) => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  const c = f.ctx(); await f.observer.run(c);
  const key = { project: "p", wt: "wt_one" }, worker = f.store.get("observed_workers", key)!;
  const meta = JSON.parse(String(worker.doc));
  if (fact === "worker") f.store.db.run("DELETE FROM observed_workers WHERE wt = 'wt_one'");
  if (fact === "dispatch") f.store.upsert("observed_workers", key, { dispatch_seen_at: c.now - 1 });
  if (fact === "terminals") f.store.upsert("observed_workers", key, { doc: { ...meta, terminals_seen_at: c.now - 1 } });
  if (fact === "identity") f.store.upsert("observed_terminals", { project: "p", handle: "term_one" }, { doc: {} });
  if (fact === "agent state") f.store.upsert("observed_workers", key, { doc: { ...meta, agent_states: ["unknown"] } });
  expect(pauseLifecycle.run(c)).toEqual([]);
  expect(f.orca.of("pause-close")).toHaveLength(0);
  expect(projection(f.store, f.target).state).toBe("pausing");
  expect(projection(f.store, f.target).reason).toContain("cannot verify agent state");
});

test("plain shells are observed without being paused or closed as agents", async () => {
  const f = fixture(); f.orca.agents = [];
  f.orca.shells.push({ wt: "wt_one", handle: "term_shell", title: "operator", busy: false });
  f.store.pause({ scope: "member", ...f.target }); await f.tick();
  expect(projection(f.store, f.target).state).toBe("paused");
  expect(f.orca.calls).toHaveLength(0);
  expect(JSON.parse(String(f.store.get("observed_terminals", { project: "p", handle: "term_shell" })?.doc)).agent).toBe(false);
  expect(f.orca.shells).toHaveLength(1);
});

test("restart keeps the pause's delivery time and continues when the role checkpoints", async () => {
  const f = fixture(); f.orca.agents[0].busy = true;
  f.store.pause({ scope: "member", ...f.target }); await f.tick();
  for (let n = 0; n < 3; n++) {
    f.orca.agents[0].busy = false; await f.tick();
    f.orca.agents[0].busy = true; await f.tick();
  }
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle] });
  const loop = new Loop(f.store, { observers: [f.observer], reconcilers: [pauseLifecycle] }, act, { projects: () => ["p"] });
  loop.boot(100); await act.boot(f.store, 100);
  f.orca.agents[0].busy = false;
  await loop.tick(101); await loop.tick(102);
  expect(f.orca.of("pause-deliver")).toHaveLength(5);
  expect(f.store.db.query("SELECT delivered_at FROM pause_members").get()).toEqual({ delivered_at: 10 });
  f.checkpoint(); await loop.tick(103);
  expect(projection(f.store, f.target).state).toBe("paused");
  expect(projection(f.store, f.target).reason).toContain("journal checkpoint verified");
  expect(f.orca.of("pause-close")).toHaveLength(1);
});

test("journal checkpoint precedes terminal closure; resume writes only state then starts fresh once", async () => {
  const f = fixture();
  f.store.pause({ scope: "member", ...f.target });
  await f.tick();
  expect(f.orca.of("pause-deliver")).toHaveLength(1);
  expect(f.orca.of("pause-close")).toHaveLength(0);
  f.checkpoint();
  await f.tick();
  expect(f.store.get("pause_members", f.target)?.state).toBe("paused");
  expect(readFileSync(join(f.path, "unfinished"), "utf8")).toBe("local changes");
  const calls = f.orca.calls.length;
  f.store.resume({ scope: "member", ...f.target });
  expect(f.orca.calls).toHaveLength(calls);
  expect(f.store.db.query("SELECT COUNT(*) n FROM requests").get()).toEqual({ n: 0 });
  await f.tick(); await f.tick();
  expect(f.orca.started).toHaveLength(1);
  expect(f.orca.started[0].op).toBe("worker-start");
  expect(f.orca.started[0].args.join(" ")).toContain("journal");
  expect(f.store.get("pause_members", f.target)?.state).toBe("active");
  expect(f.store.get("pause_members", f.target)?.closed_at).toBeNull();
});

test.each(["squad", "project"] as const)("%s Resume leaves an earlier resumed role's session alone", async (scope) => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  f.store.resume({ scope: "member", ...f.target }); await f.tick(); await f.tick();
  const active = f.store.get("pause_members", f.target)!;
  f.orca.agent("wt_one", "term_resumed", "claude");
  const other = { ...f.target, suffix: "other" };
  f.store.upsert("members", other, { wt: "wt_other", status: "running", want: "running", want_result: "fresh", observed_at: 1, updated_at: 1 });
  f.store.upsert("observed_worktrees", { project: "p", wt: "wt_other" }, { path: f.path, observed_at: 1 });
  f.store.upsert("units", { project: "p", squad: "one", slug: "other" }, { status: "dispatched", builder_wt: "wt_other", observed_at: 1, updated_at: 1 });
  f.store.pause({ scope: "member", ...other }); await f.tick();
  expect(f.store.get("pause_members", other)?.state).toBe("paused");
  f.store.resume({ scope, project: "p", squad: "one" }); await f.tick(); await f.tick();
  expect(f.orca.of("worker-start").filter((c) => c.args[1] === "wt_one")).toHaveLength(1);
  expect(f.orca.of("worker-start").filter((c) => c.args[1] === "wt_other")).toHaveLength(1);
  expect(f.orca.agents.some((a) => a.handle === "term_resumed")).toBe(true);
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "active", generation: active.generation, closed_at: null });
  expect(f.store.resume({ scope, project: "p", squad: "one" }).changed).toBe(false);
});

test("dependency release cannot reopen an active role's historical pause row", async () => {
  const f = fixture();
  f.store.upsert("units", { project: "p", squad: "one", slug: "prerequisite" }, { status: "dispatched", observed_at: 1, updated_at: 1 });
  f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: [{ kind: "unit", project: "p", squad: "one", slug: "prerequisite" }] });
  const intent = f.store.db.query("SELECT * FROM pause_intents WHERE source = 'dependency'").get()!;
  await f.tick(); f.checkpoint(); await f.tick();
  f.store.resume({ scope: "member", ...f.target }); await f.tick(); await f.tick();
  const active = f.store.get("pause_members", f.target)!;
  // An old active row may still carry a closure timestamp from before this fix.
  f.store.upsert("pause_members", f.target, { closed_at: 10 });
  clearDependency(f.store, intent, 30); await f.tick();
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "active", generation: active.generation });
  expect(f.orca.of("worker-start")).toHaveLength(1);
});

test.each(["member", "squad", "project"] as const)("%s pause and Resume leave a retired Builder and its unfinished work alone", async (scope) => {
  const f = fixture(); f.orca.agents = [];
  f.store.want("member", String(f.store.get("members", f.target)!.id), "gone");
  if (scope === "member") {
    expect(() => f.store.pause({ scope, ...f.target })).toThrow("member");
    expect(() => f.store.resume({ scope, ...f.target })).toThrow("member");
  } else {
    expect(f.store.pause({ scope, project: "p", squad: "one" }).state).toBe("paused");
    await f.tick();
    expect(f.store.resume({ scope, project: "p", squad: "one" }).state).toBe("active");
    await f.tick(); await f.tick();
  }
  expect(f.store.get("pause_members", f.target)).toBeNull();
  expect(f.store.get("members", f.target)?.want).toBe("gone");
  expect(f.orca.calls).toHaveLength(0);
  expect(readFileSync(join(f.path, "unfinished"), "utf8")).toBe("local changes");
});

test("a retired role with no worktree cannot hold a squad in Pausing or Resuming", async () => {
  const f = fixture(); f.orca.agents = [];
  f.store.want("member", String(f.store.get("members", f.target)!.id), "gone");
  rmSync(f.path, { recursive: true });
  f.store.pause({ scope: "squad", project: "p", squad: "one" }); await f.tick();
  expect(projection(f.store, { project: "p", squad: "one" }).state).toBe("paused");
  expect(f.store.get("pause_members", f.target)).toBeNull();
  f.store.resume({ scope: "squad", project: "p", squad: "one" }); await f.tick();
  expect(projection(f.store, { project: "p", squad: "one" }).state).toBe("active");
  expect(f.orca.calls).toHaveLength(0);
});

test("twenty retired rows, including historical pause rows, cost no pause inspection, release or start", async () => {
  const f = fixture(); f.orca.agents = [];
  f.store.want("member", String(f.store.get("members", f.target)!.id), "gone");
  for (let n = 1; n < 20; n++) {
    const target = { ...f.target, suffix: `retired-${n}` };
    f.store.upsert("members", target, { wt: `wt_retired_${n}`, want: "gone", status: "gone", observed_at: 1, updated_at: 1 });
    f.store.upsert("pause_members", target, { generation: `old-${n}`, state: ["pausing", "paused", "resuming"][n % 3], requested_at: 1, closed_at: 2 });
  }
  expect(f.store.pause({ scope: "project", project: "p" }).state).toBe("paused");
  for (let n = 0; n < 3; n++) await f.tick();
  expect(f.store.resume({ scope: "project", project: "p" }).state).toBe("active");
  for (let n = 0; n < 3; n++) await f.tick();
  expect(f.orca.calls).toHaveLength(0);
  expect(f.store.db.query("SELECT COUNT(*) n FROM pause_members").get()).toEqual({ n: 19 });
  expect(f.store.db.query("SELECT COUNT(*) n FROM members WHERE want = 'gone'").get()).toEqual({ n: 20 });
});

test("an unexpectedly gone role wanted running is still paused and resumed", async () => {
  const f = fixture(); f.orca.agents = [];
  f.store.upsert("members", f.target, { status: "gone", want: "running", want_result: "fresh" });
  f.store.pause({ scope: "member", ...f.target });
  expect(f.store.get("pause_members", f.target)?.state).toBe("pausing");
  await f.tick(); expect(f.store.get("pause_members", f.target)?.state).toBe("paused");
  f.store.resume({ scope: "member", ...f.target }); await f.tick(); await f.tick();
  expect(f.orca.of("worker-start")).toHaveLength(1);
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "active", closed_at: null });
});

test.each(["resume", "dependency"] as const)("%s clears a retired slot's pause history before its next occupant checkpoints", async (release) => {
  const f = fixture();
  if (release === "dependency") {
    f.store.upsert("units", { project: "p", squad: "one", slug: "prerequisite" }, { status: "dispatched", observed_at: 1, updated_at: 1 });
    f.store.pause({ scope: "member", ...f.target }, { source: "dependency", prerequisites: [{ kind: "unit", project: "p", squad: "one", slug: "prerequisite" }] });
  } else f.store.pause({ scope: "squad", project: "p", squad: "one" });
  await f.tick(); f.checkpoint(); await f.tick();
  const old = f.store.get("pause_members", f.target)!;
  f.store.want("member", String(f.store.get("members", f.target)!.id), "gone");
  const calls = f.orca.calls.length;
  if (release === "dependency") clearDependency(f.store, f.store.db.query("SELECT * FROM pause_intents WHERE source = 'dependency'").get()!, 30);
  else f.store.resume({ scope: "squad", project: "p", squad: "one" });
  await f.tick();
  expect(f.orca.calls).toHaveLength(calls);
  expect(f.store.get("members", f.target)?.want).toBe("gone");
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "active", closed_at: null, checkpoint: null,
    checkpoint_hash: null, session: null, dispatch: null, terminals: null, delivered_at: null, task_completed: 0 });
  expect(readFileSync(String(old.checkpoint), "utf8")).toContain(`checkpoint ${old.generation}:`);
  expect(f.store.get("pause_members", f.target)?.generation).not.toBe(old.generation);
  f.store.upsert("members", f.target, { want: "running", want_result: "fresh" });
  f.orca.agent("wt_one", "term_reoccupied", "claude");
  f.store.pause({ scope: "member", ...f.target }); await f.tick();
  expect(f.orca.of("pause-deliver")).toHaveLength(2);
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "pausing", acknowledged_at: null, closed_at: null, session: "term_reoccupied" });
  f.checkpoint(); await f.tick();
  expect(f.orca.of("pause-close").filter((c) => c.args[1] === "term_reoccupied")).toHaveLength(1);
  f.store.resume({ scope: "member", ...f.target }); await f.tick(); await f.tick();
  expect(f.orca.of("worker-start")).toHaveLength(1);
});

test("a new pause generation exposes no old checkpoint while retaining the journal", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  const old = f.store.get("pause_members", f.target)!;
  f.store.resume({ scope: "member", ...f.target }); await f.tick();
  expect(projection(f.store, f.target).checkpoint).toBe(old.checkpoint);
  f.orca.agent("wt_one", "term_resumed", "claude");
  f.store.pause({ scope: "member", ...f.target }); await f.tick();
  expect(projection(f.store, f.target)).toMatchObject({ state: "pausing", checkpoint: null, session: "term_resumed" });
  expect(readFileSync(String(old.checkpoint), "utf8")).toContain(`checkpoint ${old.generation}:`);
});

test("retirement after completed placement clears old metadata once and retains the journal", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  const old = f.store.get("pause_members", f.target)!;
  f.store.resume({ scope: "member", ...f.target }); await f.tick();
  expect(projection(f.store, f.target).checkpoint).toBe(old.checkpoint);
  f.store.want("member", String(f.store.get("members", f.target)!.id), "gone");
  const calls = f.orca.calls.length; await f.tick();
  const retired = f.store.get("pause_members", f.target)!;
  expect(retired).toMatchObject({ state: "active", closed_at: null, checkpoint: null, checkpoint_hash: null,
    session: null, dispatch: null, terminals: null, delivered_at: null, acknowledged_at: null, task_completed: 0 });
  await f.tick();
  expect(f.store.get("pause_members", f.target)?.generation).toBe(retired.generation);
  expect(f.orca.calls).toHaveLength(calls);
  expect(readFileSync(String(old.checkpoint), "utf8")).toContain(`checkpoint ${old.generation}:`);
  f.store.upsert("members", f.target, { want: "running", want_result: "fresh" });
  expect(projection(f.store, f.target)).toMatchObject({ state: "active", checkpoint: null, session: null, dispatch: null, delivered_at: null });
});

test.each([false, true])("retirement after Resume clears the old placement before slot reuse (queued=%s)", async (queued) => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  f.store.resume({ scope: "member", ...f.target });
  if (queued) pauseResume.run(f.ctx());
  f.store.want("member", String(f.store.get("members", f.target)!.id), "gone");
  const calls = f.orca.calls.length;
  await f.tick(); await f.tick();
  expect(f.orca.calls).toHaveLength(calls);
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "active", closed_at: null });
  f.store.upsert("members", f.target, { want: "running", want_result: "fresh" });
  f.orca.agent("wt_one", "term_reoccupied", "claude");
  expect(paused(f.store, f.target)).toBe(false);
  await f.tick(); expect(f.orca.of("worker-start")).toHaveLength(0);
  f.store.pause({ scope: "member", ...f.target }); await f.tick();
  expect(f.orca.of("pause-deliver")).toHaveLength(2);
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "pausing", session: "term_reoccupied", acknowledged_at: null });
});

test("retirement plus Resume racing terminal closure cannot restore a retired placement", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  f.orca.after = (c, out) => {
    if (c.op === "pause-close" && out.code === 0) {
      f.store.want("member", String(f.store.get("members", f.target)!.id), "gone");
      f.store.resume({ scope: "squad", project: "p", squad: "one" });
    }
  };
  await f.tick();
  expect(f.store.get("members", f.target)?.want).toBe("gone");
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "active", closed_at: null });
  await f.tick(); expect(f.orca.of("worker-start")).toHaveLength(0);
});

test("a superseded member cannot restore Resuming over its retired replacement during closure", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  const old = f.store.get("members", f.target)!;
  f.orca.after = (c, out) => {
    if (c.op === "pause-close" && out.code === 0) {
      f.store.upsert("members", { project: "p", squad: "one", wt: "wt_replacement" }, { role: "builder", suffix: "task", want: "gone", status: "gone", observed_at: 20, updated_at: 20 });
      f.store.resume({ scope: "squad", project: "p", squad: "one" });
    }
  };
  await f.tick();
  expect(f.store.get("members", { id: old.id })?.want).not.toBe("gone");
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "active", closed_at: null });
  await f.tick(); expect(f.orca.of("worker-start")).toHaveLength(0);
});

test.each(["member", "squad", "project"] as const)("%s Resume retries a failed fresh start once with a new generation", async (scope) => {
  const saved = process.env.DS_LOOP_SEND_TRIES;
  process.env.DS_LOOP_SEND_TRIES = "1";
  try {
    const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
    f.store.resume({ scope: "member", ...f.target });
    const loop = new Loop(f.store, { observers: [f.world], reconcilers: [pauseResume, picker, pauseLifecycle, member] }, f.act, { projects: () => ["p"] });
    let at = 100; loop.boot(at);
    const tick = async () => { await loop.tick(at++); await f.act.drain(); };
    f.orca.fail("worker-start", { code: 1, out: "", err: "start unavailable" });
    await tick(); await tick();
    const failed = f.store.get("pause_members", f.target)!;
    expect(projection(f.store, f.target)).toMatchObject({ state: "resuming", retryable: true });
    expect(projection(f.store, f.target).reason).toContain("start unavailable");
    expect(projection(f.store, { project: "p", squad: scope === "squad" ? "one" : undefined }).retryable).toBe(true);
    await tick(); expect(f.orca.of("worker-start")).toHaveLength(1);
    const retry = { scope, ...f.target };
    expect(f.store.resume(retry).changed).toBe(true);
    expect(f.store.get("pause_members", f.target)?.generation).not.toBe(failed.generation);
    expect(f.store.resume(retry).changed).toBe(false);
    await tick(); await tick(); await tick();
    expect(f.orca.of("worker-start")).toHaveLength(2);
    expect(f.orca.started).toHaveLength(1);
    expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "active", closed_at: null });
    expect(projection(f.store, f.target).retryable).toBe(false);
  } finally {
    if (saved === undefined) delete process.env.DS_LOOP_SEND_TRIES; else process.env.DS_LOOP_SEND_TRIES = saved;
  }
});

test("the delivered checkpoint command writes the loop's state root before acknowledgment", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick();
  const instruction = f.orca.of("pause-deliver")[0].args[2];
  const command = instruction.split("acknowledge ONLY with: ")[1].split(". This is not worker_done")[0];
  const result = Bun.spawnSync(["bash", "-c", command], {
    env: { ...process.env, ORCA_TERMINAL_HANDLE: "term_one", DS_STATE_ROOT: "/invalid-state-root", BACKEND: "/nonexistent-backend" },
  });
  expect(result.exitCode).toBe(0);
  const row = f.store.get("pause_members", f.target)!;
  expect(readFileSync(String(row.checkpoint), "utf8")).toContain(`checkpoint ${row.generation}:`);
  expect(row.acknowledged_at).not.toBeNull();
  await f.tick(); expect(projection(f.store, f.target).state).toBe("paused");
});

test("busy local commands keep Pausing after acknowledgment; remote CI does not block closure", async () => {
  const f = fixture(); f.orca.agents[0].busy = true;
  f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  for (let n = 0; n < 4; n++) await f.tick();
  expect(f.orca.of("pause-close")).toHaveLength(0);
  expect(f.orca.of("pause-deliver")).toHaveLength(1);
  expect(projection(f.store, f.target)).toMatchObject({ state: "pausing", reason: "checkpoint recorded; agent or local commands still busy" });
  f.orca.agents[0].busy = false; await f.tick();
  expect(projection(f.store, f.target).state).toBe("paused");
  expect(readFileSync(String(projection(f.store, f.target).checkpoint), "utf8")).toContain("PR remote CI");
});

test("stale, foreign and wrong-journal acknowledgments cannot close a session", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick();
  const row = f.store.get("pause_members", f.target)!;
  expect(() => acknowledge(f.store, f.target, "old", "term_one", "-", "bad", 20)).toThrow("stale");
  expect(() => acknowledge(f.store, f.target, String(row.generation), "foreign", "-", "bad", 20)).toThrow("foreign");
  expect(() => acknowledge(f.store, f.target, String(row.generation), "term_one", "foreign", "bad", 20)).toThrow("foreign");
  expect(() => acknowledge(f.store, f.target, String(row.generation), "term_one", "-", "bad", 20)).toThrow("journal");
  await f.tick(); expect(f.orca.of("pause-close")).toHaveLength(0);
});

test("repeat pause keeps its generation; Resume during Pausing cancels a late acknowledgment", async () => {
  const f = fixture(); const first = f.store.pause({ scope: "member", ...f.target }); await f.tick();
  expect(f.store.pause({ scope: "member", ...f.target })).toMatchObject({ generation: first.generation, changed: false });
  f.checkpoint(); f.store.resume({ scope: "member", ...f.target }); await f.tick();
  expect(f.orca.agents.some((a) => a.handle === "term_one")).toBe(true);
  expect(f.orca.started).toHaveLength(0);
  expect(() => acknowledge(f.store, f.target, String(first.generation), "term_one", "-", "bad", 20)).toThrow("stale");
});

test("partial terminal close retries remaining terminals and preserves an unrelated shell", async () => {
  const f = fixture(); f.orca.agent("wt_one", "term_two", "claude");
  f.orca.shells.push({ wt: "wt_one", handle: "term_shell", title: "operator shell", busy: false, out: null });
  f.store.pause({ scope: "member", ...f.target }); await f.tick();
  f.checkpoint();
  f.orca.closeFails.add("term_one"); await f.tick();
  expect(projection(f.store, f.target).state).toBe("pausing");
  f.orca.closeFails.clear(); await f.tick();
  expect(projection(f.store, f.target).state).toBe("paused");
  expect(f.orca.of("pause-close").filter((c) => c.args[1] === "term_two")).toHaveLength(1);
  expect(f.orca.shells.map((s) => s.handle)).toEqual(["term_shell"]);
});

test("changed checkpoint or stale observations keep Pausing", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  writeFileSync(String(projection(f.store, f.target).checkpoint), "checkpoint removed");
  await f.tick(); expect(f.orca.of("pause-close")).toHaveLength(0);
  f.checkpoint();
  const c = f.ctx();
  for (const a of pauseLifecycle.run(c) ?? []) await f.act.act(a, c);
  expect(f.orca.of("pause-close")).toHaveLength(0);
  await f.tick(); expect(projection(f.store, f.target).state).toBe("paused");
});

test("a new session cannot be closed using the old session checkpoint", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  f.orca.agents[0].handle = "term_foreign"; await f.tick();
  expect(f.orca.of("pause-close")).toHaveLength(0);
  expect(projection(f.store, f.target).reason).toContain("session changed");
});

test("resume during a close await fences later closes and fresh-starts once", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  f.orca.after = (c, o) => { if (c.op === "pause-close" && o.code === 0) f.store.resume({ scope: "member", ...f.target }); };
  await f.tick(); await f.tick();
  expect(f.orca.started).toHaveLength(1);
  expect(projection(f.store, f.target).state).toBe("active");
});

test("resume during post-close dispatch release still starts one fresh session", async () => {
  const f = fixture(); f.orca.dispatched("run_one", "wt_one", "term_one");
  f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  f.orca.after = (c) => {
    if (c.op === "pause-release") f.store.resume({ scope: "member", ...f.target });
  };
  await f.tick(); await f.tick(); await f.tick();
  expect(f.orca.started).toHaveLength(1);
  expect(projection(f.store, f.target).state).toBe("active");
});

test("parent pause blocks member resume; cascading resume clears earlier role pauses", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  f.store.pause({ scope: "squad", project: "p", squad: "one" });
  expect(() => f.store.resume({ scope: "member", ...f.target })).toThrow("squad");
  f.store.pause({ scope: "project", project: "p" });
  expect(() => f.store.resume({ scope: "squad", project: "p", squad: "one" })).toThrow("project");
  f.store.resume({ scope: "project", project: "p" }); await f.tick(); await f.tick();
  expect(f.orca.started).toHaveLength(1);
  expect(projection(f.store, { project: "p" }).state).toBe("active");
});

test("resume waits visibly for capacity and never recreates a missing retained worktree", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  rmSync(f.path, { recursive: true }); f.store.resume({ scope: "member", ...f.target }); await f.tick();
  expect(projection(f.store, f.target)).toMatchObject({ state: "resuming" });
  expect(projection(f.store, f.target).reason).toContain("retained worktree missing");
  expect(f.orca.started).toHaveLength(0);
});

test.each(["account", "slot"])("resuming without a free %s waits and starts only after capacity returns", async (capacity) => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle, member], slots: capacity === "slot" ? 0 : 1,
    pick: async () => capacity === "account" ? { wait: 100 } : { agent: "claude", model: "opus", account: "a", effort: null } });
  f.store.resume({ scope: "member", ...f.target });
  const c = f.ctx(); pauseResume.run(c); for (const a of pauseLifecycle.run(c) ?? []) await act.act(a, c);
  for (const a of member.run(c) ?? []) await act.act(a, c);
  expect(projection(f.store, f.target).state).toBe("resuming");
  expect(f.orca.started).toHaveLength(0);
  await f.tick(); await f.tick(); expect(f.orca.started).toHaveLength(1);
});

test("a merged unit stays finished while a standing role shown done resumes fresh", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  f.store.want("member", String(f.store.get("members", f.target)!.id), "running", { payload: { why: "start", prompt: "old queued restart" } });
  f.store.upsert("units", { project: "p", squad: "one", slug: "task" }, { status: "done" });
  f.store.resume({ scope: "member", ...f.target }); await f.tick(); expect(f.orca.started).toHaveLength(0);
  const lead = fixture("lead", ""); lead.store.pause({ scope: "member", ...lead.target }); await lead.tick(); lead.checkpoint(); await lead.tick();
  lead.store.upsert("observed_workers", { project: "p", wt: "wt_one" }, { state: "done", observed_at: 1 });
  lead.store.resume({ scope: "member", ...lead.target }); await lead.tick(); expect(lead.orca.started).toHaveLength(1);
});

test("explicit Resume clears intent but retains a human unit hold until released", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  f.store.upsert("units", { project: "p", squad: "one", slug: "task" }, { hold: true });
  f.store.resume({ scope: "member", ...f.target }); await f.tick();
  expect(projection(f.store, f.target)).toMatchObject({ state: "resuming", sources: [] });
  expect(f.orca.started).toHaveLength(0);
  expect(f.store.get("units", { project: "p", squad: "one", slug: "task" })?.hold).toBe(1);
  f.store.upsert("units", { project: "p", squad: "one", slug: "task" }, { hold: false });
  await f.tick(); expect(f.orca.started).toHaveLength(1);
});

test("a member wanted stopped while paused gets no fresh session on resume and keeps the wish (U151)", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  const m = f.store.get("members", { project: "p", squad: "one", role: f.target.role, suffix: f.target.suffix })!;
  f.store.want("member", String(m.id), "stopped", { by: "op" });
  f.store.resume({ scope: "member", ...f.target }); await f.tick(); await f.tick();
  expect(f.orca.started).toHaveLength(0);
  expect(f.store.get("members", { id: m.id })?.want).toBe("stopped");
  expect(projection(f.store, f.target)).toMatchObject({ state: "active" });
});

test("a stopped wish keeps the resume overlay while an earlier start still runs (U151)", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  const m = f.store.get("members", { project: "p", squad: "one", role: f.target.role, suffix: f.target.suffix })!;
  f.store.want("member", String(m.id), "stopped", { by: "op" });
  f.store.db.run(`INSERT INTO episodes (project, subject, kind, episode_key, state, source, started_at, observed_at) VALUES ('p', 'member:${m.id}', 'action:member', 'want:1', 'running', 'loop', 1, 1)`);
  f.store.resume({ scope: "member", ...f.target }); pauseResume.run(f.ctx());
  expect(projection(f.store, f.target)).toMatchObject({ state: "resuming", reason: "resolving earlier start before settling the stopped wish" });
  f.store.db.run(`UPDATE episodes SET state = 'done' WHERE subject = 'member:${m.id}'`);
  pauseResume.run(f.ctx());
  expect(projection(f.store, f.target)).toMatchObject({ state: "active" });
  expect(f.store.get("members", { id: m.id })?.want).toBe("stopped");
});

test.each(["hold", "ruling"])("a %s added after resume queuing fences the start until released", async (gate) => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  f.store.resume({ scope: "member", ...f.target }); pauseResume.run(f.ctx());
  if (gate === "hold") f.store.upsert("units", { project: "p", squad: "one", slug: "task" }, { hold: true });
  else question(f.store, "p", "one", { id: "ruling", unit: "task", asker: "lead", blocking: true, question: "Approve work?" });
  await f.tick(); expect(f.orca.started).toHaveLength(0);
  expect(projection(f.store, f.target).reason).toContain(gate === "hold" ? "unit hold" : "blocking ruling");
  if (gate === "hold") f.store.upsert("units", { project: "p", squad: "one", slug: "task" }, { hold: false });
  else answer(f.store, "p", "one", "ruling", "approved", "terminal");
  await f.tick(); await f.tick(); expect(f.orca.started).toHaveLength(1);
});

test("an absent agent releases its live dispatch before becoming Paused", async () => {
  const f = fixture(); f.orca.dispatched("run_one", "wt_one", "term_one"); f.orca.agents = [];
  f.store.pause({ scope: "member", ...f.target }); await f.tick();
  expect(f.orca.of("pause-release")).toHaveLength(1);
  expect(f.orca.dispatches).toHaveLength(0);
  expect(projection(f.store, f.target).state).toBe("paused");
  expect(projection(f.store, f.target).reason).toContain("no fresh pause checkpoint");
});

test("a completed standing dispatch is released after its checkpoint and terminal closure", async () => {
  const f = fixture("lead", ""); f.orca.dispatched("run_one", "wt_one", "term_one", { status: "completed" });
  f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  expect(f.orca.of("pause-release")).toHaveLength(1);
  expect(f.orca.dispatches).toHaveLength(0);
  expect(projection(f.store, f.target).state).toBe("paused");
  f.store.resume({ scope: "member", ...f.target }); await f.tick(); expect(f.orca.started).toHaveLength(1);
});

test("a release failure that is not release_unknown keeps Pausing and retries without another close", async () => {
  const f = fixture(); f.orca.dispatched("run_one", "wt_one", "term_one");
  f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  f.orca.fail("pause-release", { code: 1, out: "", err: "release unconfirmed" });
  await f.tick(); expect(projection(f.store, f.target).state).toBe("pausing");
  expect(projection(f.store, f.target).reason).toContain("dispatch release pending");
  await f.tick(); expect(projection(f.store, f.target).state).toBe("paused");
  expect(f.orca.of("pause-close")).toHaveLength(1);
});

// U150: the live pause-release storm: a dispatch whose recorded terminal no longer resolves cannot be
// released, and the pause waited on it forever. Now it is recorded once as release unknown (one
// `refusals` row, one event) and the pause finishes; the release is never tried again.
test("a release whose recorded terminal no longer resolves is recorded once as unknown and never retried (U150)", async () => {
  const f = fixture(); f.orca.dispatched("run_one", "wt_one", "term_one");
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle] });
  const loop = new Loop(f.store, { observers: [f.observer], reconcilers: [pauseLifecycle] }, act, { projects: () => ["p"] });
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  f.store.pause({ scope: "member", ...f.target }); loop.boot(100); await tick(100); f.checkpoint();
  // orca.sh pause-release's answer once it walked every dispatch, with Orca's live release_unknown text.
  const live = `pause: dispatch release unknown: {"dispatch": "ctx_one", "state": "release_unknown", "lastError": "The recorded terminal no longer resolves; whether its process is gone cannot be proven."}\npause: release_unknown only; every other dispatch released\n`;
  f.orca.answer = (c) => (c.op === "pause-release" ? { code: 1, out: "", err: live } : undefined);
  await tick(101);
  expect(f.orca.of("pause-close")).toHaveLength(1);
  expect(f.orca.of("pause-release")).toHaveLength(1);
  expect(projection(f.store, f.target).state).toBe("paused");
  expect(projection(f.store, f.target).reason).toContain("dispatch release unknown");
  for (let at = 102; at < 2100; at += 60) await tick(at);
  expect(f.orca.of("pause-release")).toHaveLength(1);
  expect(f.store.db.query("SELECT kind, class, count FROM refusals").all()).toEqual([{ kind: "pause-release", class: "unknown", count: 1 }]);
  expect(f.store.db.query("SELECT count(*) n FROM events WHERE kind = 'refusal'").get()).toEqual({ n: 1 });
  const closed = f.store.db.query("SELECT payload FROM events WHERE kind = 'pause_closed'").all() as { payload: string }[];
  expect(closed.map((e) => JSON.parse(e.payload).release)).toEqual(["unknown"]);
});

test("past the checkpoint deadline an idle agent with live sub-agents is not closed until they end (U150)", async () => {
  const f = walking(fixture());
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle] });
  const loop = new Loop(f.store, { observers: [f.observer], reconcilers: [pauseLifecycle] }, act, { projects: () => ["p"] });
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  const subs = (v: string | null) => f.store.db.run("UPDATE observed_workers SET sub_agents = ?", [v]);
  f.store.pause({ scope: "member", ...f.target }); loop.boot(100);
  await tick(100);
  expect(f.orca.of("pause-deliver")).toHaveLength(1);
  const observe = f.observer.run.bind(f.observer);
  let helpers: string | null = '[{"agent":"claude"}]';
  f.observer.run = async (ctx) => { await observe(ctx); subs(helpers); };
  await tick(500);
  expect(f.orca.of("pause-close")).toHaveLength(0);
  expect(projection(f.store, f.target).reason).toContain("no live sub-agents");
  helpers = null; f.orca.procs = null; await tick(501);       // no walk this tick: its old columns prove nothing
  expect(f.orca.of("pause-close")).toHaveLength(0);
  f.orca.procs = []; await tick(502);
  expect(f.orca.of("pause-close")).toHaveLength(1);
  expect(projection(f.store, f.target).reason).toContain("checkpoint failed");
});

test("an agent gone by itself past the checkpoint deadline is not said to be closed by the loop (U150)", async () => {
  const f = fixture(); f.orca.agents[0].busy = true;
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle] });
  const loop = new Loop(f.store, { observers: [f.observer], reconcilers: [pauseLifecycle] }, act, { projects: () => ["p"] });
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  f.store.pause({ scope: "member", ...f.target }); loop.boot(100);
  await tick(100);
  expect(f.orca.of("pause-deliver")).toHaveLength(1);
  f.orca.agents = []; await tick(500);
  expect(f.orca.of("pause-close")).toHaveLength(0);
  expect(projection(f.store, f.target)).toMatchObject({ state: "paused", reason: "agent already absent; no fresh pause checkpoint obtained" });
  expect(existsSync(journalPath(f.store, f.target)) && readFileSync(journalPath(f.store, f.target), "utf8").includes("checkpoint failed")).toBe(false);
  const closed = f.store.db.query("SELECT payload FROM events WHERE kind = 'pause_closed'").all() as { payload: string }[];
  expect(closed.map((e) => JSON.parse(e.payload).checkpoint_failed)).toEqual([undefined]);
});

test("a fence failure that quotes release_unknown text is a retry, not an unknown release (U150)", async () => {
  const f = fixture(); f.orca.dispatched("run_one", "wt_one", "term_one");
  f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  f.orca.fail("pause-release", { code: 1, out: "", err: `pause: dispatch fence failed: {"state": "release_unknown", "lastError": "The recorded terminal no longer resolves"}` });
  await f.tick();
  expect(projection(f.store, f.target).state).toBe("pausing");
  expect(projection(f.store, f.target).reason).toContain("dispatch release pending: pause: dispatch fence failed");
  expect(f.store.db.query("SELECT count(*) n FROM refusals WHERE class = 'unknown'").get()).toEqual({ n: 0 });
});

test("an already absent role records missing checkpoint honestly and resumes from its old journal", async () => {
  const f = fixture(); f.orca.agents = []; f.store.pause({ scope: "member", ...f.target }); await f.tick();
  expect(projection(f.store, f.target).reason).toContain("no fresh pause checkpoint");
  expect(f.orca.of("pause-deliver")).toHaveLength(0);
  f.store.resume({ scope: "member", ...f.target }); await f.tick();
  expect(f.orca.started[0].args.join(" ")).toContain("no fresh pause checkpoint");
});

test("a resuming role receives no ordinary wake before its one fresh session exists", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  f.store.resume({ scope: "member", ...f.target });
  expect(wake(f.ctx(), "wt_one", "ordinary repair", "test", "resume-wait").status).toBe("skipped:paused");
  await f.tick(); expect(f.orca.started).toHaveLength(1);
});

test("a queued fresh start cannot target a superseded member row", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  f.store.resume({ scope: "member", ...f.target });
  const ctx = f.ctx(); f.world.run(ctx); pauseResume.run(ctx);
  const queued = picker.run(ctx)![0];
  f.store.upsert("members", { project: "p", squad: "one", wt: "wt_new" }, { role: "builder", suffix: "task", observed_at: 20, updated_at: 20 });
  await f.act.act(queued, ctx); await f.act.drain();
  expect(f.orca.started).toHaveLength(0);
});

test("resumed roles use the real tier/phase/account picker and its start reservation", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  copyFileSync(join(import.meta.dir, "../fixtures/loop/accounts.tsv"), join(f.root, "accounts.tsv"));
  importConfig(f.store, f.root, join(import.meta.dir, "../../conventions"));
  for (const r of accountRows(f.root)) f.store.upsert(r.table, r.key, r.set);
  f.store.resume({ scope: "member", ...f.target });
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle, member] });
  const loop = new Loop(f.store, { observers: [f.world], reconcilers: [pauseResume, picker, pauseLifecycle, member] }, act, { projects: () => ["p"] });
  loop.boot(1_800_000_000); await loop.tick(1_800_000_001); await act.drain();
  expect(f.orca.started).toHaveLength(1);
  expect(f.orca.started[0].args).toContain("acct-a");
  const row = f.store.get("members", f.target)!;
  expect(f.store.get("picks", { member: row.id })).toMatchObject({ tier: "hard", phase: "build", slot: 1 });
  await loop.tick(1_800_000_002); await act.drain(); expect(f.orca.started).toHaveLength(1);
});

// U118: the pause decision belongs before the launch. A start that has gone out finishes, and the
// normal pause path winds its agent down; one that has not starts nothing. These tests place the
// started agent's terminal themselves (term_new), so the fake start leaves none.
const pick = async () => ({ agent: "claude", model: "opus", account: "a", effort: null });
const startCalls = (f: ReturnType<typeof fixture>) => f.store.db.query("SELECT retry_id, state FROM orca_calls WHERE op IN ('role-start', 'worker-start', 'worker-resume') ORDER BY id").all() as Row[];
const deliveries = (f: ReturnType<typeof fixture>) => f.store.db.query("SELECT COUNT(*) AS n FROM deliveries").get();
// A role with no worktree yet and a wish to start.
function unplaced(f: ReturnType<typeof fixture>) {
  const m = f.store.get("members", f.target)!;
  f.orca.agents = [];
  f.store.upsert("members", { id: m.id }, { wt: null });
  f.store.want("member", String(m.id), "running", { payload: { prompt: "build" } });
  return Number(m.id);
}
// U152: a model write while the start call is out keeps the call's retry id and args: one session,
// one start call, and no later call under a new retry id beside it.
test("a model write between start sent and settled gives one session, then the new model (U152)", async () => {
  const f = fixture(), id = unplaced(f), release = f.orca.hold();
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle, member], pick: async (_s, _m, o) => ({ agent: "claude", model: o.model ?? "opus", account: "a", effort: null }) });
  const loop = new Loop(f.store, { observers: [f.observer, f.world], reconcilers: [pauseResume, picker, pauseLifecycle, member] }, act, { projects: () => ["p"] });
  const partial = () => loop.tick(f.ctx().now);                     // a tick that does not wait for its background start
  await partial(); await partial();                                  // binds the coordinator, then sends the start
  expect(f.orca.inflight).toBe(1);
  f.store.want("member", String(id), "running", { payload: { prompt: "build", model: "sonnet" }, rearm: true });
  expect(JSON.parse(String(f.store.get("members", { id })!.want_payload))).toMatchObject({ model: "sonnet" });
  await partial(); await partial();                                  // the start's claim is the lock: nothing beside it
  expect(f.orca.of("role-start")).toHaveLength(1);
  release(); await act.drain();
  expect(f.orca.started).toHaveLength(1);
  expect(f.orca.started[0].args).toContain("opus");                 // the call ran what it first asked for
  expect(new Set(startCalls(f).map((c) => c.retry_id)).size).toBe(1);
  const wt = f.orca.started[0].wt;
  expect(f.store.get("members", { id })).toMatchObject({ status: "running", wt, model: "opus", want_result: null });
  const tick = async () => { await loop.tick(f.ctx().now); await act.drain(); };
  await tick(); await tick(); await tick();
  expect(f.orca.of("worker-start").map((c) => c.args[1])).toEqual([wt]);   // one switch, into the same worktree
  expect(f.orca.agents.filter((a) => a.wt === wt)).toHaveLength(1);         // the old session closed first
  expect(f.store.get("members", { id })).toMatchObject({ model: "sonnet", want_result: "fresh" });
});

test("a prompt-only edit mid-start of a wish naming a model alias is what the start ran: no switch (U152)", async () => {
  const f = fixture(), id = unplaced(f);
  f.store.want("member", String(id), "running", { payload: { prompt: "build", model: "sonnet" }, rearm: true });
  const release = f.orca.hold();
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle, member], pick: async (_s, _m, o) => ({ agent: "claude", model: o.model === "sonnet" ? "claude-sonnet-9" : "opus", account: "a", effort: null }) });
  const loop = new Loop(f.store, { observers: [f.observer, f.world], reconcilers: [pauseResume, picker, pauseLifecycle, member] }, act, { projects: () => ["p"] });
  await loop.tick(f.ctx().now); await loop.tick(f.ctx().now);
  expect(f.orca.inflight).toBe(1);
  f.store.want("member", String(id), "running", { payload: { why: "start", prompt: "build more", model: "sonnet" }, rearm: true });   // why "start" = none
  release(); await act.drain();
  for (let i = 0; i < 3; i++) { await loop.tick(f.ctx().now); await act.drain(); }
  expect(f.orca.started).toHaveLength(1);
  expect(f.store.get("members", { id })).toMatchObject({ model: "claude-sonnet-9", want_result: "fresh" });
});

// U152: a walk that read the worktree while the restart was out (no agent yet) is older than the
// start: the decide after the start settles reads it starting, never a second start.
test("a walk taken while a restart is out does not make the decide start it again (U152)", async () => {
  const f = fixture();
  f.orca.agents = []; f.orca.spawn = false;                          // dead; the new agent shows up later
  f.orca.after = (c) => { if (c.op === "worker-start") f.world.run(f.ctx()); };
  await f.tick();
  expect(f.orca.of("worker-start")).toHaveLength(1);
  expect(await picker.run(f.ctx())).toEqual([]);
});

async function winds(f: ReturnType<typeof fixture>, wt: string) {
  const spawned = f.orca.agents.find((a) => a.wt === wt);
  if (spawned) spawned.handle = "term_new"; else f.orca.agent(wt, "term_new", "claude");
  await f.tick();
  expect(f.orca.of("pause-deliver").at(-1)?.args[1]).toBe("term_new");
  expect(f.orca.of("pause-close").filter((c) => c.args[1] === "term_new")).toHaveLength(0);
  f.checkpoint(); await f.tick();
  expect(f.orca.of("pause-close").at(-1)?.args[1]).toBe("term_new");
  expect(f.store.get("pause_members", f.target)?.state).toBe("paused");
}

test("a pause during a fresh start: one recorded agent, no brief, wound down with a checkpoint", async () => {
  const f = fixture(), id = unplaced(f);
  f.orca.onCall = (c) => { if (c.op === "role-start") f.store.pause({ scope: "member", ...f.target }); };
  await f.tick();
  const wt = f.orca.started[0].wt;
  expect(f.store.get("members", { id })?.wt).toBe(wt);
  expect(deliveries(f)).toEqual({ n: 0 });
  expect(f.store.get("pause_members", f.target)?.state).toBe("pausing");
  await winds(f, wt);
  expect(f.orca.started).toHaveLength(1);
});

test("a pause during a resumed start: one recorded agent, no brief, wound down with a checkpoint", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  const start = (op: string) => op === "worker-start" || op === "worker-resume";
  f.orca.spawn = false;
  f.orca.onCall = (c) => { if (start(c.op)) f.store.pause({ scope: "member", ...f.target }); };
  f.orca.after = (c) => { if (start(c.op)) f.orca.agent("wt_one", "term_new", "claude"); };
  f.store.resume({ scope: "member", ...f.target }); await f.tick();
  expect(f.orca.started).toHaveLength(1);
  expect(deliveries(f)).toEqual({ n: 0 });
  expect(f.store.get("pause_members", f.target)?.state).toBe("pausing");
  await winds(f, "wt_one");
  expect(f.orca.started).toHaveLength(1);
});

test("the fence lets a launched start bind after a pause, through the real adapter", async () => {
  const f = fixture(), log = join(f.root, "log"), go = join(f.root, "go"), waiting = join(f.root, "waiting"), shim = join(f.root, "orca");
  writeFileSync(shim, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "${log}"
case "$1 $2" in
  "terminal create") echo '{"result":{"terminal":{"handle":"term_new"}}}' ;;
  "terminal wait") : > "${waiting}"; until [ -e "${go}" ]; do sleep 0.02; done; echo '{"result":{"ok":true}}' ;;
  "terminal list") echo '{"result":{"terminals":[]}}' ;;
  "orchestration request-show") echo '{"result":{"state":"absent"}}' ;;
  "orchestration worker-start") echo '{"result":{"dispatchId":"ctx_one"}}' ;;
  *) echo '{"result":{}}' ;;
esac
`); chmodSync(shim, 0o755);
  const a = { project: "p", squad: "one", member: "wt_one", subject: "start", kind: "member", episode: "want:1", payload: { id: f.store.get("members", f.target)!.id } };
  const env = { ...process.env, ...f.act.childActivity(f.store, a), DS_ORCA_CLI_BIN_DIR: f.root, PATH: `${f.root}:${process.env.PATH}`, DS_ORCA_DATA: join(f.root, "data"), DS_CLAUDE_HOME: join(f.root, "home"), DS_ORCA_RETRY_REQUEST: "rq_fence", DS_WORKER_START_RETRIES: "1" };
  const p = Bun.spawn(["bash", join(import.meta.dir, "../../bin/backend/orca.sh"), "worker-resume", "run_one", "wt_one", "spec", "opus", "-", "claude", "-", "builder"], { env, stdout: "pipe", stderr: "pipe" });
  while (!existsSync(waiting)) await Bun.sleep(10);
  f.store.pause({ scope: "member", ...f.target });
  writeFileSync(go, "");
  expect(await p.exited).toBe(0);
  const calls = readFileSync(log, "utf8");
  expect(calls.match(/terminal create/g)).toHaveLength(1);
  expect(calls).toContain("orchestration worker-start --terminal term_new");
});

test("a pause before the launch starts nothing, reaches Paused honestly, and Resume gives one session", async () => {
  const f = fixture(), id = unplaced(f);
  f.store.pause({ scope: "member", ...f.target });
  await f.tick(); await f.tick();
  expect(f.orca.started).toHaveLength(0);
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "paused", reason: "no agent or worktree existed; nothing to checkpoint", closed_at: null });
  expect(projection(f.store, f.target)).toMatchObject({ state: "paused", reason: "no agent or worktree existed; nothing to checkpoint" });
  f.store.resume({ scope: "member", ...f.target });
  await f.tick(); await f.tick(); await f.tick();
  expect(f.orca.started).toHaveLength(1);
  expect(f.store.get("members", { id })?.wt).toBe(f.orca.started[0].wt);
  expect(f.store.get("pause_members", f.target)?.state).toBe("active");
});

test("a wish on a placed member waits out a pause without a launch", async () => {
  const f = fixture(), m = f.store.get("members", f.target)!;
  f.store.pause({ scope: "member", ...f.target });
  f.store.want("member", String(m.id), "running", { payload: { prompt: "build" } });
  await f.tick();
  expect(f.orca.started).toHaveLength(0);
  expect(startCalls(f)).toEqual([]);
});

test("a squad that has fully paused stops saying it awaits a checkpoint", async () => {
  const f = fixture(); f.store.pause({ scope: "squad", project: "p", squad: "one" });
  await f.tick();
  expect(projection(f.store, { project: "p", squad: "one" })).toMatchObject({ state: "pausing", reason: "awaiting journal checkpoint" });
  f.checkpoint(); await f.tick();
  expect(projection(f.store, { project: "p", squad: "one" })).toMatchObject({ state: "paused", reason: null });
});

// The loop dies inside the start call, then comes back to find a pause. boot() settles the row as
// absent, so the replay goes out under the same retry id.
// A start whose call landed but never answered (the loop killed mid-call), then a pause, then a
// loop restart: the restarted actuator's boot leaves the claim pending, and pending.ts replays it.
async function crashed(f: ReturnType<typeof fixture>) {
  const first = new Loop(f.store, { observers: [f.world], reconcilers: [picker] }, f.act, { projects: () => ["p"] });
  await new Promise<void>((sent) => {
    f.orca.answer = (o) => { if (o.op !== "role-start") return undefined; sent(); return new Promise<never>(() => {}); };
    void first.tick(f.ctx().now);
  });
  f.orca.answer = undefined;
  f.store.pause({ scope: "member", ...f.target });
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle, member], pick }), at = f.ctx().now;
  await act.boot(f.store, at);
  const loop = new Loop(f.store, { observers: [f.observer, f.world], reconcilers: [pauseLifecycle, pending, picker] }, act, { projects: () => ["p"] });
  loop.boot(at);
  return async () => { await loop.tick(f.ctx().now); await act.drain(); };
}

test("a crash between launch and bind replays under its retry id during a pause: no second agent", async () => {
  const f = fixture(), id = unplaced(f), tick = await crashed(f);
  await tick();
  expect(startCalls(f)).toHaveLength(1);
  expect(startCalls(f)[0].state).toBe("completed");
  expect(f.orca.started).toHaveLength(1);
  expect(f.store.get("members", { id })?.wt).toBe(f.orca.started[0].wt);
  expect(deliveries(f)).toEqual({ n: 0 });
  expect(f.store.get("pause_members", f.target)?.state).toBe("pausing");
});

test("a pausing role waits for a crashed start before it reaches Paused", async () => {
  const f = fixture(); unplaced(f); const tick = await crashed(f);
  const c = f.ctx(); await f.observer.run(c); await pauseLifecycle.run(c);
  expect(f.store.get("pause_members", f.target)).toMatchObject({ state: "pausing", reason: "resolving in-flight start before checkpoint" });
  await tick();
  expect(f.orca.started).toHaveLength(1);
});

test("a crash before the launch: the fence refuses the replay, the role reaches Paused, Resume gives one session", async () => {
  const f = fixture(), id = unplaced(f), tick = await crashed(f);
  f.orca.answer = (c) => c.op === "role-start" ? { code: 1, out: "", err: "activity: paused" } : undefined;
  await tick();
  f.orca.answer = undefined;
  expect(f.orca.started).toHaveLength(0);
  expect(startCalls(f)[0].state).toBe("failed");
  await tick(); await tick();
  expect(f.store.get("pause_members", f.target)?.state).toBe("paused");
  expect(startCalls(f)).toHaveLength(1);
  f.store.resume({ scope: "member", ...f.target });
  await tick(); await tick();
  expect(f.orca.started).toHaveLength(1);
  expect(f.store.get("members", { id })?.wt).toBe(f.orca.started[0].wt);
});

function second(f: ReturnType<typeof fixture>, row: Row) {
  f.orca.agent("wt_one", "term_new", "claude");
  f.store.upsert("observed_workers", { project: "p", wt: "wt_one" }, { state: "waiting", observed_at: 1 });
  f.store.upsert("pause_members", f.target, { generation: "g1", state: "active", requested_at: 1, session: "term_one", terminals: JSON.stringify(["term_one"]), ...row });
  const act = new LoopActuator({ orca: f.orca, fulfillers: [duplicate] });
  return act.act({ project: "p", squad: "one", member: "wt_one", subject: "duplicate:term_one", kind: "duplicate", episode: "term_one", payload: { wt: "wt_one", handle: "term_one", newest: "term_new", first: null } }, f.ctx());
}

test("the duplicate guard never closes a session a pause recorded", async () => {
  const f = fixture(); await second(f, {});
  expect(f.orca.of("terminal-close")).toHaveLength(0);
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'duplicate_agent_closed'").get()).toEqual({ n: 0 });
  const cards = JSON.parse(readFileSync(join(f.root, "p", "alerts.json"), "utf8")).alerts as Row[];
  expect(cards.filter((c) => c.kind === "duplicate_agent")).toHaveLength(1);
});

test("the duplicate guard leaves a session that checkpointed before a real Resume", async () => {
  const f = fixture();
  f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint();
  f.store.resume({ scope: "member", ...f.target });
  const { generation, state, requested_at, session, terminals } = f.store.get("pause_members", f.target)!;
  expect(session).toBe("term_one");
  await second(f, { generation, state, requested_at, session, terminals });
  expect(f.orca.of("terminal-close")).toHaveLength(0);
});

test("the duplicate guard closes a session no pause recorded", async () => {
  const f = fixture(); await second(f, { session: "term_other", terminals: JSON.stringify(["term_other"]) });
  expect(f.orca.of("terminal-close").map((c) => c.args[0])).toEqual(["term_one"]);
});


test("a paused unfinished role resumes on the first tick with room without a capacity deadline", async () => {
  const f = fixture(); f.store.pause({ scope: "member", ...f.target }); await f.tick(); f.checkpoint(); await f.tick();
  let room = false;
  const act = new LoopActuator({ orca: f.orca, fulfillers: [pauseLifecycle, member], pick: async () => room
    ? { agent: "claude", model: "opus", account: "a", effort: null } : { wait: 10000 } });
  const loop = new Loop(f.store, { observers: [f.observer, f.world], reconcilers: [pauseResume, picker, pending, pauseLifecycle, member] }, act, { projects: () => ["p"] });
  loop.boot(30); f.store.resume({ scope: "member", ...f.target });
  await loop.tick(30); await act.drain();
  const held = f.store.get("pause_members", f.target);
  expect(held?.reason).toBe("no account free; awaiting fresh placement");
  for (let at = 31; at < 35; at++) { await loop.tick(at); await act.drain(); }
  expect(f.store.get("pause_members", f.target)).toEqual(held);
  const m = f.store.get("members", f.target)!;
  expect(m.want_result).toBeNull(); expect(m.status).not.toBe("waiting");
  expect(f.store.get("episodes", { project: "p", subject: `member:${m.id}`, kind: "action:member" })).toBeNull();
  expect(f.orca.started).toHaveLength(0);
  room = true; await loop.tick(35); await act.drain(); await loop.tick(36); await act.drain();
  expect(f.orca.started).toHaveLength(1);
  expect(f.store.get("pause_members", f.target)?.state).toBe("active");
});
