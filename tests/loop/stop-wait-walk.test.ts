// stop-wait-walk.test.ts — account-move-slow U2: a member stop whose calls went out ends once a
// process walk read after the stop's worker-stop call finds no agent, even while Orca's dispatch for
// the old agent still reads open (presence running). A walk read before or in the stop's own tick, a
// walk that saw the agent, and a walk that could not tell keep the stop waiting as before (U200).
// The decider reads the same walk (reality(), walkedGone): the stopped member reads gone and its start
// goes on the next tick, still under the open dispatch; a start placed since the stop never gets a second.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { decide, reality } from "../../bin/loop/core/decide.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Action, type Reconciler, type TickCtx } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);

// Squad t1 with a Lead and a running Builder (wtb) whose agent Orca still lists.
function rig() {
  const t = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzstopwalk-")), S = join(t, "state");
  temps.push(t);
  mkdirSync(join(S, "fx", "squads"), { recursive: true });
  writeFileSync(join(S, "fx", "dispatcher.json"), '{"home_repo":"fx"}');
  writeFileSync(join(S, "fx", "squads", "t1.json"), JSON.stringify({
    topic: "t1", repo: "fx", type: "feature", status: "running", run_id: "run1", lead_wt: "wtl", worktrees: ["wtl", "wtb"],
    members: [{ role: "lead", wt: "wtl" }, { role: "builder", suffix: "u1", wt: "wtb" }],
    units: [{ slug: "u1", status: "dispatched", tier: "hard", builder_wt: "wtb" }],
  }));
  const s = open(S);
  stores.push(s);
  importJson(s);
  writeFileSync(join(S, ".loop-migrated"), "");
  const b = s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = 't1' AND wt = 'wtb'").get() as Row;
  s.upsert("members", { id: b.id }, { want: "running", status: "running" });
  s.upsert("coordinators", { project: "fx", squad: "t1" }, { handle: "term_loop", run_id: "run1", created_at: T, bound_at: T });
  s.upsert("picks", { member: b.id }, { project: "fx", squad: "t1", role: "builder", agent: "claude", model: "opus", slot: 1, picked_at: T });
  // Before the stop: the walk saw the agent and its dispatch is live.
  s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { presence: "running", walk: "running", dispatch: "running", account_at: T, state: "idle", observed_at: T });

  const orca = new FakeOrca(), queue: Action[] = [];
  orca.agent("wtb", "term_b");
  const emit: Reconciler = { name: "emit", run: () => queue.splice(0) };
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [...fulfillers, emit] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const tick = async () => { at += 1; await loop.tick(at); await act.drain(); };
  const stop: Action = { project: "fx", squad: "t1", member: "wtb", subject: `member:${b.id}`, kind: "member", episode: "stop:restart:1",
    payload: { id: Number(b.id), stop: true, why: "restart" } };
  // The stop goes out; the worker still reads running (presence from walk and dispatch), so it waits.
  const sendStop = async () => {
    queue.push(stop);
    await tick();
    expect(orca.of("worker-stop").length).toBe(1);
    expect(stopped()).toBe(0);
    return Number((s.db.query("SELECT at FROM orca_calls WHERE key LIKE 'stop:%:worker-stop' ORDER BY id DESC LIMIT 1").get() as Row).at);
  };
  // What the observer writes after a walk: its verdict, its read time and presence (here still running:
  // Orca's dispatch for the old agent is open).
  const observe = (walk: string, accountAt: number) =>
    s.upsert("observed_workers", { project: "fx", wt: "wtb" }, { walk, account_at: accountAt, presence: "running", dispatch: "running", observed_at: at });
  const stopped = () => (s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'member_stopped'").get() as { n: number }).n;
  const waits = () => (s.db.query("SELECT payload FROM events WHERE kind = 'action_pending' ORDER BY id").all() as { payload: string }[])
    .map((e) => JSON.parse(e.payload).wait as string);
  return { s, b, orca, tick, sendStop, observe, stopped, waits, now: () => at };
}

test("a walk read after the stop that finds no agent ends the stop although the dispatch is still open", async () => {
  const r = rig();
  const sentAt = await r.sendStop();
  r.observe("none", sentAt + 1);
  await r.tick();
  expect(r.stopped()).toBe(1);
  expect(r.orca.of("worker-stop").length).toBe(1);   // done, not stopped again
  const ev = r.s.db.query("SELECT payload FROM events WHERE kind = 'member_stopped'").get() as { payload: string };
  expect(JSON.parse(ev.payload).sent_at).toBe(sentAt);
  // The decider reads the same walk: gone, so the start is not held behind the open dispatch.
  expect(reality(r.s, r.s.get("members", { id: r.b.id })!, r.now())).toBe("none");
});

test("a walk read before the stop, or in the stop's own tick, keeps it waiting", async () => {
  for (const before of [-1, 0]) {
    const r = rig();
    const sentAt = await r.sendStop();
    r.observe("none", sentAt + before);
    for (let i = 0; i < 3; i++) await r.tick();
    expect(r.stopped()).toBe(0);
    expect(r.waits().at(-1)).toBe("agent still running after stop");
  }
});

test("a walk that still sees the agent keeps the stop waiting", async () => {
  const r = rig();
  const sentAt = await r.sendStop();
  r.observe("running", sentAt + 1);
  for (let i = 0; i < 3; i++) await r.tick();
  expect(r.stopped()).toBe(0);
  expect(r.waits().at(-1)).toBe("agent still running after stop");
});

test("a walk that could not tell (unknown) keeps the stop waiting", async () => {
  const r = rig();
  const sentAt = await r.sendStop();
  r.observe("unknown", sentAt + 1);
  for (let i = 0; i < 3; i++) await r.tick();
  expect(r.stopped()).toBe(0);
  expect(r.waits().at(-1)).toBe("agent still running after stop");
});

// The decider side, on a bare store: a Lead the loop stopped (its member_stopped event with sent_at)
// whose worker still reads presence running from Orca's open dispatch.
function standing() {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzstopwalk-decide-")); temps.push(root);
  const s = open(root); stores.push(s);
  s.upsert("projects", { label: "p" }, { observed_at: 1 });
  s.upsert("squads", { project: "p", topic: "one" }, { run_id: "run_one", repo: "path:/fake", observed_at: 1, updated_at: 1, status: "running" });
  s.upsert("members", { project: "p", squad: "one", role: "lead", suffix: "" }, { wt: "wt_lead", status: "running", want: "running", want_at: T - 2000, placed_at: T - 1000, observed_at: 1, updated_at: 1 });
  const m = () => s.get("members", { project: "p", squad: "one", role: "lead", suffix: "" })!;
  const sent = T - 100;
  s.event("member_stopped", { project: "p", squad: "one", member: "wt_lead", payload: { id: Number(m().id), why: "limit", sent_at: sent } });
  const worker = (walk: string, accountAt: number) => s.upsert("observed_workers", { project: "p", wt: "wt_lead" },
    { presence: "running", walk, dispatch: "running", account_at: accountAt, state: "idle", observed_at: T });
  const ctx: TickCtx = { store: s, project: "", tick: 1, now: T, fired: [], poked: new Set() };
  const starts = () => decide(ctx).filter((a) => a.kind === "member" && !(a.payload as { stop?: boolean }).stop).map((a) => a.subject);
  return { s, m, sent, worker, starts };
}

test("decider: a walk read after the stop that finds no agent reads gone, and the start goes under the open dispatch", () => {
  const d = standing();
  d.worker("none", d.sent + 1);
  expect(reality(d.s, d.m(), T)).toBe("none");
  expect(d.starts()).toEqual([`member:${d.m().id}`]);
});

test("decider: a walk read before or in the stop's tick, a running walk or an unknown one still read running: no start", () => {
  const d = standing();
  for (const [walk, at] of [["none", d.sent], ["none", d.sent - 1], ["running", d.sent + 1], ["unknown", d.sent + 1]] as [string, number][]) {
    d.worker(walk, at);
    expect(reality(d.s, d.m(), T)).toBe("running");
    expect(d.starts()).toEqual([]);
  }
});

test("decider: a start placed after the stop is never started twice; no loop stop keeps today's reading", () => {
  const d = standing();
  d.s.upsert("members", { id: d.m().id }, { placed_at: d.sent + 10 });
  for (const at of [d.sent + 5, d.sent + 20]) {   // the walk read before, then after, the new placement
    d.worker("none", at);
    expect(reality(d.s, d.m(), T)).not.toBe("none");
    expect(d.starts()).toEqual([]);
  }
  const e = standing();
  e.s.db.run("DELETE FROM events WHERE kind = 'member_stopped'");
  e.worker("none", e.sent + 1);
  expect(reality(e.s, e.m(), T)).toBe("running");    // an open dispatch with no loop stop still reads running
});

test("decider: another member's stop in this worktree, or this member's stop in another worktree, is not its stop", () => {
  const d = standing();
  d.s.db.run("DELETE FROM events WHERE kind = 'member_stopped'");
  const id = Number(d.m().id);
  d.s.event("member_stopped", { project: "p", squad: "one", member: "wt_lead", payload: { id: id + 1, why: "limit", sent_at: d.sent } });
  d.s.event("member_stopped", { project: "p", squad: "one", member: "wt_other", payload: { id, why: "limit", sent_at: d.sent } });
  d.worker("none", d.sent + 1);
  expect(reality(d.s, d.m(), T)).toBe("running");
  expect(d.starts()).toEqual([]);
});
