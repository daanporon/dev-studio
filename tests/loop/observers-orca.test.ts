// observers-orca.test.ts — U4: the Orca observer against bin/loop/fakes/orca.ts (recorded ps, inbox
// and directory outputs) on a copy of tests/fixtures/loop/state: the rows it writes, gone_at, when it
// reads a screen, what it costs per tick, and the tick-timing budget.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { since } from "../../bin/loop/core/events.ts";
import { FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { mangle, orcaObserver, parseAgentAccounts, walkNoneAt } from "../../bin/loop/observers/orca.ts";
import { codexObserver, scanRollouts } from "../../bin/loop/observers/codex.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const RECORDED = join(ROOT, "tests", "fixtures", "loop", "orca");
const T = 1_800_000_000;
const W = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo";
const LEAD = `${W}/ds-dev-studio-lead-demo`, THINKER = `${W}/ds-dev-studio-thinker-demo`;
const BUILDER = `${W}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`;
const STUDIO = `${W}/ds-fx-studio`, STRAY = `${W}/ds-fx-builder-stray-demo`;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzloop-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}
function loopOf(s: Store, orca: FakeOrca, projects = ["fx"]) {
  const l = new Loop(s, { observers: [orcaObserver(orca)], reconcilers: [] }, { act() {} }, { projects: () => projects });
  l.boot(T);
  return l;
}
const workers = (s: Store, project = "fx") => Object.fromEntries((s.db.query("SELECT * FROM observed_workers WHERE project = ?").all(project) as Row[]).map((r) => [r.wt, r]));
const errors = (s: Store) => since(s, 0, { kinds: ["plugin_error"] });

describe("orca observer", () => {
  test("worktrees, workers and terminals of the project, with unread mail and observed_at", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED);
    o.screens.set(LEAD, "> working on it\n\n");
    await loopOf(s, o).tick(T);
    expect(errors(s)).toEqual([]);

    const wts = (s.db.query("SELECT wt, branch, observed_at, gone_at FROM observed_worktrees WHERE project = 'fx' ORDER BY wt").all() as Row[]);
    expect(wts.map((r) => r.wt)).toEqual([BUILDER, LEAD, THINKER, STRAY, STUDIO].sort());
    expect(wts.every((r) => r.observed_at === T && r.gone_at === null)).toBe(true);

    const w = workers(s);
    expect(Object.keys(w).sort()).toEqual([BUILDER, LEAD, THINKER, STRAY, STUDIO].sort());
    expect([w[LEAD].state, w[LEAD].unread, w[LEAD].name, w[LEAD].last_output_at]).toEqual(["working", 2, "ds-dev-studio-lead-demo", 1799999940]);
    expect([w[THINKER].state, w[THINKER].unread]).toEqual(["done", 1]);
    expect([w[BUILDER].state, w[BUILDER].unread]).toEqual(["working", 0]);
    expect([w[STRAY].state, w[STUDIO].state]).toEqual(["waiting", "idle"]);
    expect(JSON.parse(w[LEAD].doc as string)).toMatchObject({ squad: "demo", role: "lead", suffix: "", run_id: "run_fixture01", agent_states: ["working"], terminals_seen_at: T });
    expect([w[LEAD].tail, w[LEAD].tail_at, w[LEAD].observed_at]).toEqual(["> working on it", T, T]);

    const terms = s.db.query("SELECT handle, wt, title, doc FROM observed_terminals WHERE project = 'fx' ORDER BY handle").all() as Row[];
    expect(terms.map((t) => [t.handle, t.wt, t.title])).toEqual([
      ["term_b1", BUILDER, "demo/builder-u1-spike-loop-as-coordinator"], ["term_lead1", LEAD, "demo/lead"],
      ["term_lead2", LEAD, "demo/lead"], ["term_think", THINKER, "demo/thinker"]]);
    expect(JSON.parse(terms[2].doc as string).newest).toBe(true);
  });

  test("U9: a reply and a screen with secret shapes are stored redacted; the prompt line is unchanged", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    const tok = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
    o.worktrees.find((w) => w.worktreeId === LEAD)!.agents = [{ state: "working", lastAssistantMessage: `token ${tok} here` }];
    o.screens.set(LEAD, `-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nAuthorization: Bearer abcdefgh12345678\n> ready`);
    await l.tick(T);
    const w = workers(s)[LEAD];
    expect(w.said).toBe("token [redacted] here");
    expect(w.tail).toBe("[redacted]\nAuthorization: Bearer [redacted]\n> ready");
  });

  test("a worktree that disappears gets gone_at; seen again, it clears", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    await l.tick(T);
    const all = o.worktrees;
    o.worktrees = all.filter((w) => w.worktreeId !== THINKER);
    o.dirs.set("fx", o.dirs.get("fx")!.filter((d) => d.wt !== THINKER));
    await l.tick(T + 5);
    expect([workers(s)[THINKER].gone_at, workers(s)[LEAD].gone_at]).toEqual([T + 5, null]);
    expect(s.get("observed_worktrees", { project: "fx", wt: THINKER })?.gone_at).toBe(T + 5);
    expect(s.get("observed_terminals", { project: "fx", handle: "term_think" })?.gone_at).toBe(T + 5);

    o.worktrees = all;
    await l.tick(T + 10);
    expect([workers(s)[THINKER].gone_at, workers(s)[THINKER].observed_at]).toEqual([null, T + 10]);
  });

  test("U55: each worker's live account, from the agent processes in its worktree; read every 30 s, kept when a read fails", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o), P = "/home/user/orca/workspaces/demo";
    const acct = () => Object.fromEntries(Object.entries(workers(s)).map(([wt, r]) => [wt, [r.account, r.account_at]]));
    await l.tick(T);   // the read fails: nothing known
    expect(acct()[LEAD]).toEqual([null, null]);
    o.procs = [
      { cwd: `${P}/ds-dev-studio-lead-demo`, agent: "claude", account: "acct-b" },
      { cwd: `${P}/ds-dev-studio-thinker-demo/sub/dir`, agent: "claude", account: "system" },
      { cwd: `${P}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`, agent: "claude", account: "acct-a" },
      { cwd: `${P}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`, agent: "claude", account: "acct-b" },
      { cwd: `${P}/ds-fx-studio-other`, agent: "claude", account: "acct-a" },
    ];
    await l.tick(T + 30);
    expect([acct()[LEAD], acct()[THINKER], acct()[BUILDER], acct()[STUDIO]]).toEqual([["acct-b", T + 30], ["system", T + 30], [null, T + 30], [null, T + 30]]);
    o.procs[0].account = "acct-a";
    await l.tick(T + 45);   // not due yet
    expect(acct()[LEAD]).toEqual(["acct-b", T + 30]);
    o.procs = null;
    await l.tick(T + 60);   // due, the read fails: kept, and account_at says how old
    expect(acct()[LEAD]).toEqual(["acct-b", T + 30]);
    expect(errors(s)).toEqual([]);
  });

  test("U90: a worker shows every agent it runs: sub lines fill sub_agents, never the main account", async () => {
    expect(parseAgentAccounts("/w\tmuse\tdefault\n/w\tsub\tclaude\topus\tacc9\n")).toEqual([
      { cwd: "/w", agent: "muse", account: "default" },
      { cwd: "/w", agent: "claude", account: "acc9", kind: "sub", model: "opus" },
    ]);
    // U105: a sixth field is the sub's --effort; absent reads as before.
    expect(parseAgentAccounts("/w\tsub\tclaude\topus\tacc9\txhigh\n")).toEqual([
      { cwd: "/w", agent: "claude", account: "acc9", kind: "sub", model: "opus", effort: "xhigh" }]);
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o), P = "/home/user/orca/workspaces/demo";
    const row = (wt: string) => s.get("observed_workers", { project: "fx", wt });
    o.procs = [
      { cwd: `${P}/ds-dev-studio-lead-demo`, agent: "claude", account: "acct-b" },
      { cwd: `${P}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`, agent: "muse", account: "default" },
      { cwd: `${P}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`, agent: "claude", account: "acct-a", kind: "sub", model: "opus" },
    ];
    await l.tick(T + 30);
    expect([row(LEAD)!.account, row(LEAD)!.sub_agents]).toEqual(["acct-b", null]);
    expect(row(BUILDER)!.account).toBe("default");
    expect(JSON.parse(row(BUILDER)!.sub_agents as string)).toEqual([{ agent: "claude", model: "opus", account: "acct-a" }]);
    // A worktree with only a sub line reads its account as unknown, not as the sub's.
    o.procs = o.procs.filter((p) => p.agent === "claude");
    await l.tick(T + 60);
    expect(row(BUILDER)!.account).toBeNull();
    expect(JSON.parse(row(BUILDER)!.sub_agents as string)).toEqual([{ agent: "claude", model: "opus", account: "acct-a" }]);
    // The sub exits: cleared, the main kept as read.
    o.procs = [
      { cwd: `${P}/ds-dev-studio-lead-demo`, agent: "claude", account: "acct-b" },
      { cwd: `${P}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`, agent: "muse", account: "default" },
    ];
    await l.tick(T + 90);
    expect([row(BUILDER)!.account, row(BUILDER)!.sub_agents]).toEqual(["default", null]);
    expect(errors(s)).toEqual([]);
  });

  test("U64: a Run's dispatches are read while a standing member is new, then throttled (U100); a settle is dated only when watched", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    const iso = (t: number) => new Date(t * 1000).toISOString();
    const disp = () => { const w = workers(s); return [LEAD, BUILDER].map((wt) => [w[wt].dispatch_id, w[wt].dispatch, w[wt].dispatch_at]); };
    const seen = () => { const w = workers(s); return [LEAD, THINKER].map((wt) => w[wt].dispatch_seen_at); };
    s.db.run("UPDATE members SET since = ? WHERE project = 'fx'", [iso(T - 3600)]);
    await l.tick(T);   // every member past crash_window_min: one read to stamp dispatch_seen_at, then throttled
    expect(o.calls.dispatches).toEqual(["run_fixture01"]);
    expect(seen()).toEqual([T, T]);
    await l.tick(T + 60);   // inside DISPATCH_READ_MIN: no reread
    expect(o.calls.dispatches.length).toBe(1);

    s.db.run("UPDATE members SET started = ? WHERE project = 'fx' AND role = 'lead'", [iso(T)]);   // a restart: since stays old
    o.runs.set("run_fixture01", [{ wt: LEAD, id: "ctx_old", status: "completed" }, { wt: BUILDER, id: "ctx_b", status: "dispatched" }, { wt: `${W}/elsewhere`, id: "ctx_x", status: "completed" }]);
    await l.tick(T + 65);   // the dispatch before the restart, already settled: its time is unknown
    expect(o.calls.dispatches).toEqual(["run_fixture01", "run_fixture01"]);
    expect(disp()).toEqual([["ctx_old", "completed", null], ["ctx_b", "dispatched", T + 65]]);
    expect(s.get("observed_workers", { project: "fx", wt: `${W}/elsewhere` })).toBeNull();

    o.runs.set("run_fixture01", [{ wt: LEAD, id: "ctx_new", status: "dispatched" }, { wt: BUILDER, id: "ctx_b", status: "dispatched" }]);
    await l.tick(T + 70);
    o.runs.set("run_fixture01", [{ wt: LEAD, id: "ctx_new", status: "completed" }, { wt: BUILDER, id: "ctx_b", status: "dispatched" }]);
    await l.tick(T + 75);   // watched settling: dated
    await l.tick(T + 80);   // unchanged: the first time kept
    expect(disp()).toEqual([["ctx_new", "completed", T + 75], ["ctx_b", "dispatched", T + 65]]);

    // A new dispatch that started and settled between two reads, after another was on record: dated.
    o.runs.set("run_fixture01", [{ wt: LEAD, id: "ctx_fast", status: "succeeded" }, { wt: BUILDER, id: "ctx_b", status: "dispatched" }]);
    await l.tick(T + 85);
    expect(disp()[0]).toEqual(["ctx_fast", "succeeded", T + 85]);

    await l.tick(T + 11 * 60);   // past the window and the throttle: one reread, then quiet again
    expect(o.calls.dispatches.length).toBe(7);
    await l.tick(T + 11 * 60 + 10);
    expect(o.calls.dispatches.length).toBe(7);
    expect(errors(s)).toEqual([]);
  });

  test("U100: a failed dispatches read stamps nothing, so the verdict falls back to unknown", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    const iso = (t: number) => new Date(t * 1000).toISOString();
    const seen = () => { const w = workers(s); return [LEAD, THINKER].map((wt) => w[wt].dispatch_seen_at); };
    s.db.run("UPDATE members SET since = ? WHERE project = 'fx'", [iso(T - 3600)]);
    o.runs.set("run_fixture01", [{ wt: LEAD, id: "ctx_l", status: "dispatched" }]);
    await l.tick(T);
    expect(seen()).toEqual([T, T]);
    o.dispatches = async (run: string) => { o.calls.dispatches.push(run); throw new Error("orca down"); };
    await l.tick(T + 5 * 60);   // due, but the read fails: the old stamp stands, nothing throws
    expect(o.calls.dispatches.length).toBe(2);
    expect(seen()).toEqual([T, T]);
    expect(errors(s)).toEqual([]);
  });

  test("U100: past the crash window a live standing member's Run is read once per DISPATCH_READ_MIN, stamped, not more often", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    const iso = (t: number) => new Date(t * 1000).toISOString();
    const seen = () => { const w = workers(s); return [LEAD, THINKER].map((wt) => w[wt].dispatch_seen_at); };
    s.db.run("UPDATE members SET since = ? WHERE project = 'fx'", [iso(T - 3600)]);
    o.runs.set("run_fixture01", [{ wt: THINKER, id: "ctx_t", status: "dispatched" }, { wt: LEAD, id: "ctx_l", status: "dispatched" }]);
    await l.tick(T);
    expect(o.calls.dispatches).toEqual(["run_fixture01"]);
    expect(seen()).toEqual([T, T]);   // stamped even though the rows only carry a status
    await l.tick(T + 4 * 60);         // inside the 5 min knob: no reread
    expect(o.calls.dispatches.length).toBe(1);
    await l.tick(T + 5 * 60);         // the knob elapsed: reread once
    expect(o.calls.dispatches.length).toBe(2);
    expect(seen()).toEqual([T + 300, T + 300]);
    await l.tick(T + 5 * 60 + 10);    // not due again yet
    expect(o.calls.dispatches.length).toBe(2);
    expect(errors(s)).toEqual([]);
  });

  test("a pausing Builder's dispatch is refreshed every tick, and absence clears the old identity", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    await l.tick(T);
    const m = s.db.query("SELECT * FROM members WHERE wt = ?").get(BUILDER) as Row;
    s.pause({ scope: "member", project: "fx", squad: String(m.squad), role: "builder", suffix: String(m.suffix) });
    o.runs.set("run_fixture01", [{ wt: BUILDER, id: "ctx_builder", status: "dispatched" }]);
    await l.tick(T + 1); await l.tick(T + 2);
    expect(o.calls.dispatches).toHaveLength(3);
    expect(s.get("observed_workers", { project: "fx", wt: BUILDER })).toMatchObject({ dispatch_id: "ctx_builder", dispatch_seen_at: T + 2 });
    o.runs.set("run_fixture01", []); await l.tick(T + 3);
    expect(s.get("observed_workers", { project: "fx", wt: BUILDER })).toMatchObject({ dispatch_id: null, dispatch: null, dispatch_seen_at: T + 3 });
    expect(errors(s)).toEqual([]);
  });

  test("U2: a dispatch keeps its member after the worktree is re-dispatched; a repeat sighting writes nothing", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    await l.tick(T);
    const m = s.db.query("SELECT * FROM members WHERE wt = ?").get(BUILDER) as Row;
    s.pause({ scope: "member", project: "fx", squad: String(m.squad), role: "builder", suffix: String(m.suffix) });
    const rows = () => s.db.query("SELECT dispatch_id, project, wt, first_seen FROM dispatches ORDER BY first_seen, dispatch_id").all();
    o.runs.set("run_fixture01", [{ wt: BUILDER, id: "ctx_aaaaaaaaaaaa", status: "dispatched" }]);
    await l.tick(T + 1);
    o.runs.set("run_fixture01", [{ wt: BUILDER, id: "ctx_bbbbbbbbbbbb", status: "dispatched" }]);
    await l.tick(T + 2);
    expect(s.get("observed_workers", { project: "fx", wt: BUILDER })?.dispatch_id).toBe("ctx_bbbbbbbbbbbb");
    expect(rows()).toEqual([
      { dispatch_id: "ctx_aaaaaaaaaaaa", project: "fx", wt: BUILDER, first_seen: T + 1 },
      { dispatch_id: "ctx_bbbbbbbbbbbb", project: "fx", wt: BUILDER, first_seen: T + 2 }]);
    o.runs.set("run_fixture01", [{ wt: BUILDER, id: "ctx_aaaaaaaaaaaa", status: "dispatched" }]);
    await l.tick(T + 3);   // A seen again: no new row, its first_seen stands
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toMatchObject({ dispatch_id: "ctx_aaaaaaaaaaaa", first_seen: T + 1 });
    expect(errors(s)).toEqual([]);
  });

  test("U2: the migration backfills dispatches from observed_workers and orca_calls, skipping what does not parse", () => {
    const s = imported();
    s.db.run("INSERT INTO observed_workers (project, wt, dispatch_id, observed_at) VALUES ('fx', ?, 'ctx_111111111111', ?)", [LEAD, T]);
    const call = (retry: string, result: string | null, member: string | null, at: number) =>
      s.db.run("INSERT INTO orca_calls (retry_id, key, op, project, squad, member, at, state, result) VALUES (?, 'k', 'dispatch', 'fx', 'demo', ?, ?, 'completed', ?)", [retry, member, at, result]);
    call("r-json", JSON.stringify({ result: { dispatchId: "ctx_222222222222" } }), BUILDER, T + 1);
    call("r-text", "ctx_333333333333\n", THINKER, T + 2);
    call("r-embed", "send: delivered to dispatch:ctx_444444444444 (msg_1)", STUDIO, T + 3);
    call("r-junk", "no dispatch id here", LEAD, T + 4);
    call("r-nomember", "ctx_555555555555\n", null, T + 5);
    s.db.run("INSERT INTO orca_calls (retry_id, key, op, project, squad, member, at, state, dispatch) VALUES ('r-col', 'k', 'dispatch', 'fx', 'demo', ?, ?, 'completed', 'ctx_666666666666')", [THINKER, T + 6]);
    s.db.run("DROP TABLE dispatches");
    s.db.run("DELETE FROM schema_migrations WHERE filename = '0024-dispatch-names.sql'");
    migrate(s.db);
    expect(s.db.query("SELECT dispatch_id, wt, first_seen FROM dispatches ORDER BY dispatch_id").all()).toEqual([
      { dispatch_id: "ctx_111111111111", wt: LEAD, first_seen: T },
      { dispatch_id: "ctx_222222222222", wt: BUILDER, first_seen: T + 1 },
      { dispatch_id: "ctx_333333333333", wt: THINKER, first_seen: T + 2 },
      { dispatch_id: "ctx_444444444444", wt: STUDIO, first_seen: T + 3 },
      { dispatch_id: "ctx_666666666666", wt: THINKER, first_seen: T + 6 }]);
  });

  test("an empty ps while workers are live is an error, not a mass exit", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    await l.tick(T);
    o.worktrees = [];
    await l.tick(T + 5);
    expect(errors(s).length).toBe(1);
    expect(Object.values(workers(s)).every((w) => w.gone_at === null)).toBe(true);
  });

  test("a terminal-read outage preserves identity rows while other successful observations refresh", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    await l.tick(T);
    o.terminals = async () => { throw new Error("terminal service unavailable"); };
    await l.tick(T + 1);
    expect(s.get("observed_workers", { project: "fx", wt: LEAD })?.observed_at).toBe(T + 1);
    expect(s.get("observed_terminals", { project: "fx", handle: "term_lead1" })?.observed_at).toBe(T);
    expect(JSON.parse(String(s.get("observed_workers", { project: "fx", wt: LEAD })?.doc)).terminals_seen_at).toBeNull();
  });

  test("screens are read for new, changed, idle and suspect workers; a quiet working one costs nothing", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    await l.tick(T);
    // The Studio's screen is read by its adopted handle only (U261); none is adopted here.
    expect(o.calls.screenTail.sort()).toEqual([BUILDER, LEAD, THINKER, STRAY].sort());

    o.reset();
    await l.tick(T + 5);
    expect(o.calls.screenTail).toEqual([]);
    expect(workers(s)[LEAD].observed_at).toBe(T + 5);

    // The lead's token count moves: its screen is read again.
    o.reset();
    s.upsert("observed_tokens", { worker: mangle(LEAD.slice(LEAD.indexOf("::") + 2)), model: "claude-opus-5-5" }, { output: 900, observed_at: T + 9 });
    await l.tick(T + 10);
    expect(o.calls.screenTail).toEqual([LEAD]);
    expect([workers(s)[LEAD].tokens, workers(s)[LEAD].tail_at]).toEqual([900, T + 10]);

    // The builder goes idle; the thinker is marked suspect by a reconciler.
    o.reset();
    o.worktrees.find((w) => w.worktreeId === BUILDER)!.agents = [{ state: "idle" }];
    s.upsert("observed_workers", { project: "fx", wt: THINKER }, { suspect: 1 });
    await l.tick(T + 15);
    expect(o.calls.screenTail.sort()).toEqual([BUILDER, THINKER].sort());
    expect(workers(s)[THINKER].suspect).toBe(0);
  });

  test("a screen read that fails after a state change is tried again next tick", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    await l.tick(T);
    o.reset();
    o.worktrees.find((w) => w.worktreeId === BUILDER)!.agents = [{ state: "done" }];
    o.failScreens.add(BUILDER);
    await l.tick(T + 5);
    expect([workers(s)[BUILDER].state, workers(s)[BUILDER].suspect]).toEqual(["done", 1]);
    o.reset();
    o.screens.set(BUILDER, "all done");
    await l.tick(T + 10);
    expect(o.calls.screenTail).toEqual([BUILDER]);
    expect([workers(s)[BUILDER].tail, workers(s)[BUILDER].tail_at, workers(s)[BUILDER].suspect]).toEqual(["all done", T + 10, 0]);
  });

  test("two projects in one tick: one ps, one inbox read, one directory list each", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED);
    await loopOf(s, o, ["fx", "fy"]).tick(T);
    expect(errors(s)).toEqual([]);
    expect([o.calls.ps, o.calls.unread, o.calls.directory]).toEqual([1, 1, ["fx", "fy"]]);
  });

  test("two projects of twenty terminals each, 100 ms per Orca call: one tick stays under five seconds", async () => {
    const s = imported(), o = new FakeOrca(100);
    for (const p of ["pa", "pb"]) {
      const dir = [];
      for (let i = 0; i < 20; i++) {
        const wt = `${W}/ds-${p}-builder-u${i}-sq`;
        o.worktrees.push({ worktreeId: wt, displayName: `ds-${p}-builder-u${i}-sq`, agents: [{ state: "working", stateStartedAt: T * 1000 }] });
        dir.push({ squad: "sq", role: "builder", suffix: `u${i}`, wt, kind: "worktree", run_id: "run_x", terminals: [`term_${p}_${i}`] });
      }
      o.dirs.set(p, dir);
    }
    const l = loopOf(s, o, ["pa", "pb"]);
    const first = await l.tick(T);
    expect(errors(s)).toEqual([]);
    expect(first.ms).toBeLessThan(5000);
    expect((s.db.query("SELECT COUNT(*) AS n FROM observed_terminals WHERE gone_at IS NULL").get() as { n: number }).n).toBe(40);
    const second = await l.tick(T + 5);
    expect(second.ms).toBeLessThan(first.ms);
  });
});

// --- U149: per-member reality — the main agent really running, on what ------------------------

describe("U149: the main agent's presence, kind, process and live model", () => {
  const P = "/home/user/orca/workspaces/demo", START = 1_799_996_400;
  const ACCOUNTS = join(RECORDED, "agent-accounts.tsv");
  const main = (s: Store, wt: string) => {
    const r = s.get("observed_workers", { project: "fx", wt })!;
    return { presence: r.presence, agent: r.agent, account: r.account, pid: r.pid, started_at: r.started_at, rss_kb: r.rss_kb, live_model: r.live_model, live_effort: r.live_effort };
  };

  test("agent-accounts' two main line shapes parse; the long one carries the process", () => {
    expect(FakeOrca.accounts(ACCOUNTS)).toEqual([
      { cwd: `${P}/ds-dev-studio-lead-demo`, agent: "claude", account: "acct-b", kind: "main", model: "opus", effort: "high", pid: 4101, start: START, rss: 512000 },
      { cwd: `${P}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`, agent: "muse", account: "default" },
      { cwd: `${P}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo/sub`, agent: "claude", account: "acct-a", kind: "sub", model: "sonnet", effort: "medium" },
      { cwd: `${P}/ds-fx-studio`, agent: "codex", account: "default", kind: "main", model: "-", pid: 4103, start: START, rss: 230000 },
    ]);
  });

  test("RSS, pid, start and kind are recorded; none vs idle vs unknown; a failed read keeps the values and ages", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    await l.tick(T);   // no walk yet: unknown
    expect(main(s, LEAD).presence).toBe("unknown");
    o.procs = FakeOrca.accounts(ACCOUNTS);
    await l.tick(T + 30);
    expect(main(s, LEAD)).toEqual({ presence: "running", agent: "claude", account: "acct-b", pid: 4101, started_at: START, rss_kb: 512000, live_model: "opus", live_effort: "high" });
    // The Thinker: Orca says `done`, the walk found no agent process and no dispatch is live.
    expect([workers(s)[THINKER].state, main(s, THINKER).presence, main(s, THINKER).agent]).toEqual(["done", "none", null]);
    // A muse main from an old 3-field line: running, its model unknown.
    expect(main(s, BUILDER)).toMatchObject({ presence: "running", agent: "muse", account: "default", pid: null, live_model: null });
    o.procs = null;
    await l.tick(T + 60);   // the walk fails: unknown, with the old values and their age
    expect(main(s, LEAD)).toEqual({ presence: "unknown", agent: "claude", account: "acct-b", pid: 4101, started_at: START, rss_kb: 512000, live_model: "opus", live_effort: "high" });
    expect(workers(s)[LEAD].account_at).toBe(T + 30);
    expect(errors(s)).toEqual([]);
  });

  test("the live ACME shape (Orca idle, dispatch failed, a leftover terminal, no process) reads none; a live dispatch reads running", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    o.worktrees = o.worktrees.map((w) => (w.worktreeId === BUILDER ? { ...w, agents: [{ state: "idle" }] } : w));
    o.procs = [];
    await l.tick(T);
    s.db.run("UPDATE observed_workers SET dispatch = 'failed' WHERE wt = ?", [BUILDER]);
    await l.tick(T + 30);
    expect([workers(s)[BUILDER].state, s.get("observed_terminals", { project: "fx", handle: "term_b1" })?.gone_at]).toEqual(["idle", null]);
    expect(main(s, BUILDER).presence).toBe("none");
    s.db.run("UPDATE observed_workers SET dispatch = 'dispatched' WHERE wt = ?", [BUILDER]);
    await l.tick(T + 45);
    expect(main(s, BUILDER).presence).toBe("running");
  });

  test("U21a walk_none_at: set by the first walk that finds no agent, kept by later ones and by a failed walk, cleared by one that finds it", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    const at = () => s.get("observed_workers", { project: "fx", wt: LEAD })!.walk_none_at;
    o.procs = FakeOrca.accounts(ACCOUNTS);
    await l.tick(T);
    expect(at()).toBeNull();
    o.procs = FakeOrca.accounts(ACCOUNTS).filter((p) => !p.cwd.endsWith("ds-dev-studio-lead-demo"));
    await l.tick(T + 30);
    expect(at()).toBe(T + 30);
    await l.tick(T + 60);
    expect(at()).toBe(T + 30);
    o.procs = null;                                     // a failed walk proves nothing: the time is kept
    await l.tick(T + 90);
    expect(at()).toBe(T + 30);
    o.procs = FakeOrca.accounts(ACCOUNTS);
    await l.tick(T + 120);
    expect(at()).toBeNull();
  });

  test("U21a walkNoneAt: a spell begun at or before the member's last start starts again", () => {
    expect(walkNoneAt("none", null, 100, 500)).toBe(500);
    expect(walkNoneAt("none", 200, 100, 500)).toBe(200);
    expect(walkNoneAt("none", 100, 100, 500)).toBe(500);
    expect(walkNoneAt("unknown", 200, 100, 500)).toBe(200);
    expect(walkNoneAt("running", 200, 100, 500)).toBeNull();
  });

  test("two mains that disagree read unknown; in the Studio worktree only the Studio's agent counts", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    o.procs = [
      { cwd: `${P}/ds-fx-studio`, agent: "codex", account: "default", kind: "main", pid: 1, start: START },
      { cwd: `${P}/ds-fx-studio`, agent: "claude", account: "system", kind: "main", pid: 2, start: START + 1 },
      { cwd: `${P}/ds-dev-studio-thinker-demo`, agent: "codex", account: "default", kind: "main", pid: 5, start: START },
      { cwd: `${P}/ds-dev-studio-thinker-demo`, agent: "claude", account: "system", kind: "main", pid: 6, start: START + 1 },
      { cwd: `${P}/ds-dev-studio-lead-demo`, agent: "claude", account: "acct-b", kind: "main", model: "opus", pid: 3, start: START },
      { cwd: `${P}/ds-dev-studio-lead-demo`, agent: "claude", account: "acct-b", kind: "main", model: "sonnet", pid: 4, start: START + 5 },
    ];
    await l.tick(T);
    expect(main(s, THINKER)).toMatchObject({ presence: "unknown", agent: null, account: null, pid: null });
    // AE1: the Studio (claude) beside a ds-loop pane running codex reads the Studio, not unknown.
    expect(main(s, STUDIO)).toMatchObject({ presence: "running", agent: "claude", account: "system", pid: 2 });
    // Two that agree on agent and account: the newest start is the main.
    expect(main(s, LEAD)).toMatchObject({ presence: "running", agent: "claude", pid: 4, live_model: "sonnet" });
  });

  test("a transcript model newer than the process start wins over the --model flag; an older one does not", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    o.procs = FakeOrca.accounts(ACCOUNTS);
    const said = (model: string, at: number) => s.upsert("observed_transcripts", { path: "/t/lead.jsonl" },
      { project: "fx", wt: LEAD, mtime: at, size: 1, last_model: model, model_at: at, last_effort: "low", observed_at: T });
    said("claude-sonnet-5-5", START - 60);   // the session before this start
    await l.tick(T);
    expect([main(s, LEAD).live_model, main(s, LEAD).live_effort]).toEqual(["opus", "high"]);
    said("claude-sonnet-5-5", START + 600);  // an in-session /model switch
    await l.tick(T + 30);
    expect([main(s, LEAD).live_model, main(s, LEAD).live_effort]).toEqual(["claude-sonnet-5-5", "low"]);
  });

  test("a Codex main's model comes from the newest interactive rollout begun in its cwd", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), dir = mkdtempSync(join(tmpdir(), "zzcodex-"));
    temps.push(dir);
    const day = join(dir, "2027", "01", "15");
    mkdirSync(day, { recursive: true });
    const rollout = (name: string, cwd: string, originator: string, model: string, at: number) => {
      const p = join(day, `rollout-${name}.jsonl`);
      writeFileSync(p, [JSON.stringify({ timestamp: new Date(at * 1000).toISOString(), type: "session_meta", payload: { cwd, originator } }),
        JSON.stringify({ timestamp: new Date(at * 1000).toISOString(), type: "turn_context", payload: { cwd, model, effort: "low" } }), ""].join("\n"));
      utimesSync(p, at, at);
      return p;
    };
    rollout("old", `${P}/ds-fx-studio`, "codex-tui", "gpt-old", START - 600);          // before this start
    rollout("review", `${P}/ds-fx-studio`, "acpx", "gpt-review", START + 900);         // a headless review pass
    rollout("other", `${P}/ds-dev-studio-lead-demo`, "codex-tui", "gpt-other", START + 900);
    const own = rollout("own", `${P}/ds-fx-studio`, "codex-tui", "gpt-6.1-sol", START + 300);
    const l = new Loop(s, { observers: [codexObserver({ dir }), orcaObserver(o)], reconcilers: [] }, { act() {} }, { projects: () => ["fx"] });
    l.boot(T);
    // The Studio worktree's walk counts only the Studio's own agent (U261): this one runs codex.
    s.db.run("UPDATE projects SET doc = json_set(COALESCE(doc, '{}'), '$.studio_agent', 'codex') WHERE label = 'fx'");
    o.procs = FakeOrca.accounts(ACCOUNTS);
    await l.tick(T);        // the walk finds the codex main; the rollouts are read on the next pass
    await l.tick(T + 30);
    await l.tick(T + 60);
    expect([main(s, STUDIO).agent, main(s, STUDIO).live_model, main(s, STUDIO).live_effort]).toEqual(["codex", "gpt-6.1-sol", "low"]);
    // A later turn appended to the same rollout is read from where the last read stopped.
    writeFileSync(own, JSON.stringify({ timestamp: new Date((START + 1200) * 1000).toISOString(), type: "turn_context", payload: { model: "gpt-6.1-terra", effort: "high" } }) + "\n", { flag: "a" });
    utimesSync(own, START + 1200, START + 1200);
    await l.tick(T + 90);
    await l.tick(T + 120);
    expect([main(s, STUDIO).live_model, main(s, STUDIO).live_effort]).toEqual(["gpt-6.1-terra", "high"]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM observed_rollouts").get()).toEqual({ n: 3 });   // the one before the start is not kept
  });

  test("a turn still being written when a rollout is first read is read whole once it lands", () => {
    const s = imported(), dir = mkdtempSync(join(tmpdir(), "zzcodex-"));
    temps.push(dir);
    const day = join(dir, "2027", "01", "15"), p = join(day, "rollout-cut.jsonl");
    mkdirSync(day, { recursive: true });
    const line = (type: string, payload: object) => JSON.stringify({ timestamp: new Date(START * 1000).toISOString(), type, payload });
    const next = line("turn_context", { model: "gpt-6.1-terra", effort: "high" });
    writeFileSync(p, `${line("session_meta", { cwd: `${P}/ds-fx-studio`, originator: "codex-tui" })}\n${line("turn_context", { model: "gpt-6.1-sol", effort: "low" })}\n${next.slice(0, 40)}`);
    utimesSync(p, START, START);
    scanRollouts(s, dir, START - 60, T);
    expect(s.get("observed_rollouts", { path: p })?.model).toBe("gpt-6.1-sol");
    writeFileSync(p, `${next.slice(40)}\n`, { flag: "a" });
    utimesSync(p, START + 60, START + 60);
    scanRollouts(s, dir, START - 60, T + 30);
    expect(s.get("observed_rollouts", { path: p })?.model).toBe("gpt-6.1-terra");
  });
});

// studio-chat-queued-busy U1: `ds-fx-public-…` worktrees are fx-public's, not fx's, though their
// names start with `ds-fx-`; rows fx recorded for them before read gone after one tick.
describe("one project per worktree", () => {
  const PUB_STUDIO = `${W}/ds-fx-public-studio`, PUB_LEAD = `${W}/ds-fx-public-lead-chat`;
  function twoLabels(): { s: Store; o: FakeOrca } {
    const s = imported(), o = FakeOrca.recorded(RECORDED);
    mkdirSync(join(s.root, "fx-public", "squads"), { recursive: true });
    for (const [wt, name] of [[PUB_STUDIO, "ds-fx-public-studio"], [PUB_LEAD, "ds-fx-public-lead-chat"]])
      o.worktrees.push({ worktreeId: wt, path: wt.split("::")[1], branch: "refs/heads/main", displayName: name, lastOutputAt: (T - 30) * 1000, unread: 0, agents: [] } as never);
    return { s, o };
  }
  const wtsOf = (s: Store, project: string) => (s.db.query("SELECT wt FROM observed_worktrees WHERE project = ? AND gone_at IS NULL").all(project) as Row[]).map((r) => String(r.wt));

  test("fx's observer records none of the ds-fx-public-… worktrees; fx-public's records them", async () => {
    const { s, o } = twoLabels();
    await loopOf(s, o, ["fx", "fx-public"]).tick(T);
    expect(errors(s)).toEqual([]);
    expect(wtsOf(s, "fx")).not.toContain(PUB_STUDIO);
    expect(wtsOf(s, "fx")).not.toContain(PUB_LEAD);
    expect(wtsOf(s, "fx")).toContain(STUDIO);                          // fx's own name match still holds
    expect(wtsOf(s, "fx-public").sort()).toEqual([PUB_LEAD, PUB_STUDIO]);
    expect(Object.keys(workers(s))).not.toContain(PUB_LEAD);
  });

  test("a longer label known only as a projects row still claims its names", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED);
    o.worktrees.push({ worktreeId: PUB_LEAD, path: PUB_LEAD.split("::")[1], displayName: "ds-fx-public-lead-chat", agents: [] } as never);
    s.upsert("projects", { label: "fx-public" }, { observed_at: T });
    await loopOf(s, o).tick(T);
    expect(wtsOf(s, "fx")).not.toContain(PUB_LEAD);
  });

  test("fx's earlier rows for a fx-public worktree and its live terminal read gone after one tick", async () => {
    const { s, o } = twoLabels();
    o.tabs = [...await o.terminals(), { handle: "term_pub", worktreeId: PUB_LEAD, connected: true, agentIdentity: "claude", title: "pub lead" }];
    // What the over-wide name match wrote before: fx rows for a fx-public worktree.
    s.upsert("observed_worktrees", { project: "fx", wt: PUB_LEAD }, { observed_at: T - 60, gone_at: null });
    s.upsert("observed_workers", { project: "fx", wt: PUB_LEAD }, { state: "idle", observed_at: T - 60, gone_at: null });
    s.upsert("observed_terminals", { project: "fx", handle: "term_pub" }, { wt: PUB_LEAD, observed_at: T - 60, gone_at: null });
    await loopOf(s, o, ["fx", "fx-public"]).tick(T);
    expect(errors(s)).toEqual([]);
    const term = (project: string) => s.get("observed_terminals", { project, handle: "term_pub" });
    expect(term("fx")?.gone_at).toBe(T);
    expect(term("fx-public")?.gone_at).toBeNull();
    expect(s.get("observed_workers", { project: "fx", wt: PUB_LEAD })?.gone_at).toBe(T);
    expect(s.get("observed_worktrees", { project: "fx", wt: PUB_LEAD })?.gone_at).toBe(T);
    expect(s.db.query("SELECT COUNT(*) AS n FROM observed_terminals WHERE handle = 'term_pub'").get()).toEqual({ n: 2 }); // stamped, not deleted
    // fx's own terminals stay live.
    expect(term("fx")).toBeTruthy();
    expect((s.db.query("SELECT COUNT(*) AS n FROM observed_terminals WHERE project = 'fx' AND gone_at IS NULL").get() as Row).n).toBe(4);
  });
});
