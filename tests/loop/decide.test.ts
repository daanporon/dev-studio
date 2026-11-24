// decide.test.ts — U152: the decider. compare() is the act table (pure); reality() reads presence;
// the seed sets each member's standing wish from reality once per project; decide() turns them into
// at most one act per member: a `member` start, a card, or nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, decide, reality, type Facts } from "../../bin/loop/core/decide.ts";
import { startEpisode, view } from "../../bin/loop/squad/member-state.ts";
import { seedWish } from "../../bin/loop/db/seed.ts";
import { mainAgents, parseAgentAccounts } from "../../bin/loop/observers/orca.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const T = 1_800_000_000;
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  delete process.env.DS_SWEEP_SPAWN_GRACE_MIN;
});

function fixture(squad: Row = { status: "running" }): Store {
  const root = mkdtempSync(join(tmpdir(), "decide-")); roots.push(root);
  const s = open(root); stores.push(s);
  s.upsert("projects", { label: "p" }, { observed_at: 1 });
  s.upsert("squads", { project: "p", topic: "one" }, { run_id: "run_one", repo: "path:/fake", observed_at: 1, updated_at: 1, ...squad });
  return s;
}
// A member; `unit`: a Builder's unit status (suffix = slug). `presence`: its observed worker.
function member(s: Store, role: string, set: Row = {}, opts: { unit?: string; presence?: string; walkAt?: number } = {}): Row {
  const suffix = role === "builder" ? String(set.suffix ?? "u1") : "";
  const wt = set.wt === undefined ? `wt_${role}${suffix}` : set.wt;
  if (opts.unit) s.upsert("units", { project: "p", squad: "one", slug: suffix }, { status: opts.unit, builder_wt: wt, observed_at: 1, updated_at: 1 });
  s.upsert("members", { project: "p", squad: "one", role, suffix }, { wt, status: "running", observed_at: 1, updated_at: 1, ...set });
  if (opts.presence && wt) s.upsert("observed_workers", { project: "p", wt }, { presence: opts.presence, walk: opts.presence, account_at: opts.walkAt ?? T - 1, observed_at: T });
  return s.get("members", { project: "p", squad: "one", role, suffix })!;
}
// U266: an idle restart/rss stop asks for a journal checkpoint first (stop-checkpoint.test.ts); these
// tests are about the stop, so its checkpoint is already proved.
const checkpointed = (s: Store, m: Row, key: string) => s.db.run(`INSERT INTO stop_checkpoints (member_id, project, squad, role, suffix, stop_key, why, generation, state, created_at)
  VALUES (?, 'p', 'one', ?, ?, ?, ?, ?, 'verified', ?)`, [Number(m.id), String(m.role), String(m.suffix ?? ""), key, key.split(":")[0], `stop-${m.id}-${key}`, T]);
const ctx = (s: Store, now = T): TickCtx => ({ store: s, project: "", tick: 1, now, fired: [], poked: new Set() });
const run = (s: Store, now = T) => decide(ctx(s, now)).map((a) => `${a.kind}:${a.kind === "alert" ? (a.payload as Row).title : a.subject}`);

describe("compare: the act table", () => {
  const base: Facts = { view: "running", lock: false, reality: "none", unknownS: 0, recheckS: 300, resume: null,
    switchDue: false, givenUp: false, capped: false, rebroke: false, room: true };
  test.each([
    ["none, room", {}, { act: "start" }],
    ["lock held", { lock: true }, null],
    ["an open start call (the lock)", { lock: true, reality: "starting" }, null],
    ["no room: no claim, no card", { room: false }, null],
    ["wish stopped", { view: "stopped" }, null],
    ["wish paused", { view: "paused" }, null],
    ["wish archived (a finished Builder)", { view: "archived" }, null],
    ["a resume its gate holds", { resume: false }, null],
    ["a resume that may go", { resume: true }, { act: "start" }],
    ["unknown, fresh", { reality: "unknown", unknownS: 60 }, null],
    ["unknown past RECHECK_MIN", { reality: "unknown", unknownS: 300 }, { act: "card", why: "unknown" }],
    ["starting", { reality: "starting" }, null],
    ["running", { reality: "running" }, null],
    ["running, a phase switch due", { reality: "running", switchDue: true }, { act: "start" }],
    ["running, a phase switch due, no room", { reality: "running", switchDue: true, room: false }, null],
    ["stopped, agent present (U155)", { view: "stopped", reality: "running" }, { act: "close", phase: "stop", why: "stopped" }],
    ["stopped, no agent, worktree kept (U155)", { view: "stopped", reality: "none", hasWorktree: true }, null],
    ["archived, agent present (U155)", { view: "archived", reality: "running" }, { act: "close", phase: "stop", why: "archived" }],
    ["archived, no agent, worktree present (U155)", { view: "archived", reality: "none", hasWorktree: true }, { act: "close", phase: "remove", why: "archived" }],
    ["archived, no agent, no worktree (U155)", { view: "archived", reality: "none" }, null],
    ["suspended, agent present: the pause flow's (U158)", { view: "suspended", reality: "running" }, null],
    ["suspended, no agent, worktree present: remove, wt cleared for resume (U158)", { view: "suspended", reality: "none", hasWorktree: true }, { act: "close", phase: "remove", why: "suspended" }],
    ["archived, no agent, stale wt but tree already gone: still remove (U158)", { view: "archived", reality: "none", wt: true, staleWtOk: true }, { act: "close", phase: "remove", why: "archived" }],
    ["archived from a finished unit, stale wt: no act (its tree is lifecycle's)", { view: "archived", reality: "none", wt: true }, null],
    ["archived from a finished unit, still working (U155)", { view: "archived", reality: "running", closeOK: false }, null],
    ["archived from a finished unit, idle (U155)", { view: "archived", reality: "running", closeOK: true }, { act: "close", phase: "stop", why: "archived" }],
    ["archived, unknown reality (U155)", { view: "archived", reality: "unknown", unknownS: 9999, hasWorktree: true }, null],
    ["given up", { givenUp: true }, null],
    ["crash-capped", { capped: true }, null],
    ["broke again soon after a restart", { rebroke: true }, { act: "card", why: "rebroke" }],
    ["running, reload due and idle (U156)", { reality: "running", reloadDue: true, idleOK: true }, { act: "reload" }],
    ["running, reload due but working (U156)", { reality: "running", reloadDue: true }, null],
    ["running, reload due, lock held (U156)", { reality: "running", reloadDue: true, idleOK: true, lock: true }, null],
    ["running, clear due and idle, claude (U156)", { reality: "running", clearDue: true, clearCmd: "/clear", idleOK: true }, { act: "clear" }],
    ["running, clear due and idle, codex (U156)", { reality: "running", clearDue: true, clearCmd: "/new", idleOK: true }, { act: "clear" }],
    ["running, clear due but no signal, muse (U156)", { reality: "running", clearDue: true, clearCmd: null, idleOK: true }, null],
    ["running, restart stop beats reload (U156)", { reality: "running", stopDue: "now", stopWhy: "restart", room: true, reloadDue: true, idleOK: true }, { act: "stop", why: "restart" }],
    ["running, an unconfirmed reload never wedges a switch start (U156)", { reality: "running", reloadDue: true, idleOK: true, switchDue: true, room: true }, { act: "start" }],
    ["running, an unconfirmed reload never wedges a tell (U156)", { reality: "running", tellLimit: "k", room: false, reloadDue: true, idleOK: true }, { act: "tell", why: "limit" }],
    ["running, out of credits with nowhere to go: no tell (U3)", { reality: "running", tellLimit: null, tellOk: null, room: false }, null],
    ["running, its credits hold cleared: one works-again tell, room or not (U3)", { reality: "running", tellOk: "credits-ok|k", room: false }, { act: "tell", why: "credits-ok" }],
    ["running, its login hold cleared: one login-ok tell (claude-login-ended U2)", { reality: "running", tellOk: "login-ok|k", room: false }, { act: "tell", why: "login-ok" }],
    ["running, a clear waits behind a switch start (U156)", { reality: "running", clearDue: true, clearCmd: "/clear", idleOK: true, switchDue: true, room: true }, { act: "start" }],
    ["stopped with reload+clear due, agent present (U156)", { view: "stopped", reality: "running", closeOK: true, reloadDue: true, clearDue: true, clearCmd: "/clear", idleOK: true },
      { act: "close", phase: "stop", why: "stopped" }],
  ] as [string, Partial<Facts>, unknown][])("%s", (_, f, want) => {
    expect(compare({ ...base, ...f })).toEqual(want as ReturnType<typeof compare>);
  });
});

describe("reality", () => {
  test("presence running / none; a placed start no walk has read is starting for the grace, then unknown", () => {
    const s = fixture();
    expect(reality(s, member(s, "lead", {}, { presence: "running" }), T)).toBe("running");
    expect(reality(s, member(s, "thinker", {}, { presence: "none" }), T)).toBe("none");
    expect(reality(s, member(s, "builder", { wt: null }), T)).toBe("none");
    const b = member(s, "builder", { suffix: "u2", placed_at: T - 60 }, { presence: "none", walkAt: T - 120 });
    expect(reality(s, b, T)).toBe("starting");
    expect(reality(s, b, T - 60 + 5 * 60)).toBe("unknown");
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { account_at: T });     // a walk after the start reads it
    expect(reality(s, b, T)).toBe("none");
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { presence: "unknown" });
    expect(reality(s, b, T)).toBe("unknown");
  });

  // U21a: after a KILL Orca keeps the member `working` (presence running) while the walk finds no agent.
  describe("presence running, walk none (a dead agent under a stale Orca view)", () => {
    const START = T - 30 * 60;
    function dead(walkNoneAt: number | null, set: Row = {}): { s: Store; b: Row } {
      const s = fixture();
      const b = member(s, "builder", { placed_at: START, gen: "g1", ...set }, { unit: "dispatched" });
      s.upsert("observed_workers", { project: "p", wt: b.wt }, { presence: "running", walk: "none", walk_none_at: walkNoneAt, account_at: T - 5, state: "working", observed_at: T });
      return { s, b };
    }
    afterEach(() => { delete process.env.DS_SWEEP_GONE_MIN; });

    test("every walk since after its start found none for GONE_MIN (3 min): none", () => {
      const { s, b } = dead(T - 3 * 60);
      expect(reality(s, b, T)).toBe("none");
    });
    test("under GONE_MIN: running", () => {
      const { s, b } = dead(T - 2 * 60);
      expect(reality(s, b, T)).toBe("running");
    });
    test("gone_min from the limits row and DS_SWEEP_GONE_MIN", () => {
      const { s, b } = dead(T - 2 * 60);
      s.upsert("config", { project: "p", file: "limits.conf", key: "gone_min" }, { value: "1", observed_at: T });
      expect(reality(s, b, T)).toBe("none");
      process.env.DS_SWEEP_GONE_MIN = "10";
      expect(reality(s, b, T)).toBe("running");
    });
    test("a failed walk (walk unknown) keeps it running, whatever the kept time", () => {
      const { s, b } = dead(T - 20 * 60);
      s.upsert("observed_workers", { project: "p", wt: b.wt }, { walk: "unknown" });
      expect(reality(s, b, T)).toBe("running");
    });
    test("no walk_none_at (no walk read none since the observer kept it): running", () => {
      const { s, b } = dead(null);
      expect(reality(s, b, T)).toBe("running");
    });
    test("a spell begun at or before its last start proves nothing about this start: running", () => {
      const { s, b } = dead(START);
      expect(reality(s, b, T)).toBe("running");
    });
    test("a transcript that grew since the walk first read none: running", () => {
      const { s, b } = dead(T - 10 * 60);
      s.upsert("observed_transcripts", { path: "/t/a.jsonl" }, { project: "p", wt: b.wt, mtime: T - 60, size: 9, observed_at: T });
      expect(reality(s, b, T)).toBe("running");
      s.upsert("observed_transcripts", { path: "/t/a.jsonl" }, { mtime: T - 11 * 60 });
      expect(reality(s, b, T)).toBe("none");
    });
    test("a finish row of its generation: running (it ended its work; the finish points decide)", () => {
      const { s, b } = dead(T - 10 * 60);
      s.db.run("INSERT INTO finishes (key, project, squad, member, unit, gen, outcome, body, at) VALUES ('k1', 'p', 'one', 'p/one/builder-u1', 'u1', 'g1', 'no-pr', '', ?)", [T - 600]);
      expect(reality(s, b, T)).toBe("running");
    });
  });
});

describe("seed: each member's standing wish from reality, once", () => {
  test("closed squad -> gone; standing role of a running or suspended squad -> running; a paused one still reads paused", () => {
    const s = fixture({ status: "closed" });
    expect(seedWish(s, member(s, "lead"), T)).toBe("gone");
    const r = fixture();
    const lead = member(r, "lead", { want: null });
    r.pause({ scope: "member", project: "p", squad: "one", role: "lead", suffix: "" });
    r.upsert("units", { project: "p", squad: "one", slug: "u9" }, { status: "dispatched", observed_at: 1, updated_at: 1 });
    expect(seedWish(r, lead, T)).toBe("running");
    r.upsert("members", { id: lead.id }, { want: "running" });
    expect(view(r, r.get("members", { id: lead.id })!)).toBe("paused");
    const u = fixture({ status: "suspended" });
    expect(seedWish(u, member(u, "thinker"), T)).toBe("running");
  });

  test("a Builder: running for a dispatched unit or a live main agent, else stopped; a member wanted gone is left", () => {
    const s = fixture();
    expect(seedWish(s, member(s, "builder", { suffix: "a" }, { unit: "dispatched" }), T)).toBe("running");
    expect(seedWish(s, member(s, "builder", { suffix: "b" }, { unit: "planned" }), T)).toBe("stopped");
    expect(seedWish(s, member(s, "builder", { suffix: "c" }, { unit: "done" }), T)).toBe("stopped");
    expect(seedWish(s, member(s, "builder", { suffix: "d" }, { unit: "planned", presence: "running", walkAt: T }), T)).toBe("running");
    expect(seedWish(s, member(s, "builder", { suffix: "e", want: "gone" }, { unit: "dispatched" }), T)).toBeNull();
  });

  test("a codex exec under a Muse Builder is not its agent: the walk names the Muse main, and a lone sub reads none", () => {
    const ps = [{ worktreeId: "wt_b", path: "/w/b" }];
    const both = parseAgentAccounts("/w/b\tmain\tmuse\tmuse-spark-1.3\tmuse\tmax\t4100\t500\t9000\n/w/b\tsub\tcodex\tgpt-6.1-sol\tdefault\n");
    expect(mainAgents(ps, both).get("wt_b")).toMatchObject({ walk: "running", main: { agent: "muse", pid: 4100 } });
    const sub = parseAgentAccounts("/w/b\tsub\tcodex\tgpt-6.1-sol\tdefault\n");
    expect(mainAgents(ps, sub).get("wt_b")).toEqual({ walk: "none", main: null });
    const s = fixture();
    const b = member(s, "builder", { wt: "wt_b" }, { unit: "planned", presence: "none", walkAt: T });
    expect(seedWish(s, b, T)).toBe("stopped");
  });

  test("runs once, on the first tick a walk read; a pending start is left; one wish_seeded event per change", () => {
    const s = fixture();
    const a = member(s, "builder", { suffix: "a" }, { unit: "dispatched", presence: "none", walkAt: T - 5 });
    const b = member(s, "builder", { suffix: "b", want: "running", want_at: T - 100 }, { unit: "planned" });
    decide(ctx(s));                                                   // no walk this tick: no seed
    expect(s.get("members", { id: a.id })?.want).toBeNull();
    s.upsert("observed_workers", { project: "p", wt: a.wt }, { account_at: T + 1 });
    decide(ctx(s, T + 1));
    expect(s.get("members", { id: a.id })).toMatchObject({ want: "running", want_by: "seed" });
    expect(s.get("members", { id: b.id })).toMatchObject({ want: "running", want_at: T - 100 });   // its start still pending
    expect(s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'wish_seeded'").get()).toEqual({ n: 1 });
    s.upsert("members", { id: a.id }, { want: null });
    s.upsert("observed_workers", { project: "p", wt: a.wt }, { account_at: T + 2 });
    decide(ctx(s, T + 2));
    expect(s.get("members", { id: a.id })?.want).toBeNull();          // seeded once per project
  });
});

describe("decide", () => {
  test("a dead Builder: one start and no run-switch; held while its claim runs; nothing once placed", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", want_at: T - 100 }, { unit: "dispatched", presence: "none" });
    const acts = decide(ctx(s));
    expect(acts.map((a) => [a.kind, a.subject, a.episode])).toEqual([["member", `member:${b.id}`, "start:0"]]);
    s.upsert("episodes", { project: "p", subject: `member:${b.id}`, kind: "action:member" }, { episode_key: "start:0", state: "running", source: "loop", started_at: T, observed_at: T });
    expect(run(s, T + 1)).toEqual([]);
    s.upsert("episodes", { project: "p", subject: `member:${b.id}`, kind: "action:member" }, { state: "done", ended_at: T + 2, source: "loop" });
    s.upsert("members", { id: b.id }, { placed_at: T + 2 });
    expect(run(s, T + 3)).toEqual([]);                                // starting: no second start beside it
  });

  test("U21a: a Builder killed mid-work that Orca still reads working is started GONE_MIN after the walk first read none; a failed walk starts nothing", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", want_at: T - 3600, placed_at: T - 3600, gen: "g1" }, { unit: "dispatched" });
    const walk = (at: number, v: string, noneAt: number | null) => s.upsert("observed_workers", { project: "p", wt: b.wt },
      { presence: "running", walk: v, walk_none_at: noneAt, account_at: at, state: "working", observed_at: at });
    walk(T, "none", T);
    expect(run(s, T)).toEqual([]);
    expect(run(s, T + 2 * 60)).toEqual([]);
    walk(T + 3 * 60 - 5, "unknown", T);                               // a failed walk: running, no start beside a live one
    expect(run(s, T + 3 * 60)).toEqual([]);
    walk(T + 3 * 60 + 5, "none", T);
    expect(run(s, T + 3 * 60 + 8)).toEqual([`member:member:${b.id}`]);
  });

  test("a pre-U159 wish still carrying a script replay is a plain wish: one start, never a child (U159)", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", want_at: T - 100,
      want_payload: JSON.stringify({ kind: "add-role", key: "add-role:p/one/builder-u1", argv: ["bin/commands/add-role.sh", "p", "one", "builder", "u1"], cwd: "/fake", from: "term_x" }) },
      { unit: "dispatched", presence: "none" });
    expect(run(s)).toEqual([`member:member:${b.id}`]);
  });

  test("an open start call on its worktree is the lock: nothing", () => {
    const s = fixture();
    member(s, "builder", { want: "running" }, { unit: "dispatched", presence: "none" });
    s.db.run("INSERT INTO orca_calls (retry_id, key, op, sender, at, state, project, member) VALUES ('r1', 'k', 'worker-start', 'term_x', 1, 'sent', 'p', 'wt_builderu1')");
    expect(run(s)).toEqual([]);
  });

  test("a finished Builder is not revived, nor a stopped or given-up one, nor a third crash on one rung", () => {
    const s = fixture();
    member(s, "builder", { suffix: "a", want: "running" }, { unit: "done", presence: "none" });
    member(s, "builder", { suffix: "b", want: "running" }, { unit: "cancelled", presence: "none" });
    member(s, "builder", { suffix: "c", want: "stopped" }, { unit: "dispatched", presence: "none" });
    member(s, "builder", { suffix: "d", want: "running", want_result: "failed: start refused" }, { unit: "dispatched", presence: "none" });
    const lead = member(s, "lead", { want: "running", want_at: T - 100 }, { presence: "none" });
    s.upsert("episodes", { project: "p", subject: "one.lead", kind: "crash" }, { count: 3, state: "exited", source: "loop", started_at: T - 60, observed_at: T - 50 });
    expect(run(s)).toEqual([]);
    s.upsert("members", { id: lead.id }, { want_at: T, want_by: "operator" });   // a wish written since lifts the cap
    expect(run(s)).toEqual([`member:member:${lead.id}`]);
  });

  test("unknown presence: nothing, then one card past RECHECK_MIN; broke again soon after a restart: one card", () => {
    const s = fixture();
    member(s, "lead", { want: "running" }, { presence: "unknown" });
    expect(run(s)).toEqual([]);
    expect(run(s, T + 5 * 60)).toEqual(["alert:Agent presence unknown"]);
    const r = fixture();
    const b = member(r, "builder", { want: "running", want_at: T - 3600 }, { unit: "dispatched", presence: "none" });
    r.upsert("episodes", { project: "p", subject: `member:${b.id}`, kind: "restarted" }, { started_at: T - 60, state: "done", source: "loop", observed_at: T - 60 });
    expect(run(r)).toEqual(["alert:Agent broke again"]);
  });

  test("U288: restart, then a loop stop (phase switch), then gone -> a start, no rebroke card; no loop stop -> the card", () => {
    const r = fixture();
    const b = member(r, "builder", { want: "running", want_at: T - 3600 }, { unit: "dispatched", presence: "none" });
    r.upsert("episodes", { project: "p", subject: `member:${b.id}`, kind: "restarted" }, { started_at: T - 180, state: "done", source: "loop", observed_at: T - 180 });
    r.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, 'p', 'one', ?, 'member_stopped', ?)", [T - 10, String(b.wt), JSON.stringify({ id: b.id, why: "phase" })]);
    expect(run(r)).toEqual([`member:member:${b.id}`]);
    // a stop from before the restart, or of another member, does not lift it
    const q = fixture();
    const c = member(q, "builder", { want: "running", want_at: T - 3600 }, { unit: "dispatched", presence: "none" });
    q.upsert("episodes", { project: "p", subject: `member:${c.id}`, kind: "restarted" }, { started_at: T - 180, state: "done", source: "loop", observed_at: T - 180 });
    q.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, 'p', 'one', 'x', 'member_stopped', ?)", [T - 400, JSON.stringify({ id: c.id, why: "phase" })]);
    q.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, 'p', 'one', 'x', 'member_stopped', ?)", [T - 10, JSON.stringify({ id: c.id + 99, why: "phase" })]);
    expect(run(q)).toEqual(["alert:Agent broke again"]);
  });

  test("U153: restart wish on a live agent -> one stop; mode idle waits, mode now stops mid-turn; paused never", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", restart_at: T - 10, restart_mode: "now", restart_by: "operator", placed_at: T - 3600 }, { unit: "dispatched", presence: "running", walkAt: T });
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { state: "working", started_at: T - 3600, observed_at: T });
    const acts = decide(ctx(s));
    expect(acts.filter((a) => (a.payload as Row).stop).map((a) => (a.payload as Row).why)).toEqual(["restart"]);
    // mode idle waits while working
    const s2 = fixture();
    const b2 = member(s2, "builder", { want: "running", restart_at: T - 10, restart_mode: "idle", restart_by: "operator", placed_at: T - 3600 }, { unit: "dispatched", presence: "running", walkAt: T });
    s2.upsert("observed_workers", { project: "p", wt: b2.wt }, { state: "working", started_at: T - 3600, observed_at: T });
    expect(decide(ctx(s2)).filter((a) => (a.payload as Row).stop)).toEqual([]);
    s2.upsert("observed_workers", { project: "p", wt: b2.wt }, { state: "idle", observed_at: T });
    checkpointed(s2, b2, `restart:${T - 10}`);
    expect(decide(ctx(s2)).filter((a) => (a.payload as Row).stop).length).toBe(1);
    // paused: nothing, and the fresh session at resume satisfies the wish (proc start moves past it)
    const s3 = fixture();
    const b3 = member(s3, "builder", { want: "running", restart_at: T - 10, restart_mode: "now", restart_by: "operator", placed_at: T - 3600 }, { unit: "dispatched", presence: "running", walkAt: T });
    s3.upsert("observed_workers", { project: "p", wt: b3.wt }, { state: "idle", started_at: T - 3600, observed_at: T });
    s3.pause({ scope: "member", project: "p", squad: "one", role: "builder", suffix: "u1" });
    expect(decide(ctx(s3))).toEqual([]);
  });

  test("U153 guards: an idle restart waits with live sub-agents or an undelivered delivery", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", restart_at: T - 10, restart_mode: "idle", restart_by: "operator", placed_at: T - 3600 }, { unit: "dispatched", presence: "running", walkAt: T });
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { state: "idle", started_at: T - 3600, sub_agents: '[{"wt":"x"}]', observed_at: T });
    checkpointed(s, b, `restart:${T - 10}`);
    expect(decide(ctx(s)).filter((a) => (a.payload as Row).stop)).toEqual([]);
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { sub_agents: null, observed_at: T });
    s.db.run("INSERT INTO deliveries (project, squad, member, kind, text, tries, state, at) VALUES ('p', 'one', ?, 'brief', 'x', 0, 'accepted', ?)", [String(b.wt), T]);
    expect(decide(ctx(s)).filter((a) => (a.payload as Row).stop)).toEqual([]);
    s.db.run("DELETE FROM deliveries");
    expect(decide(ctx(s)).filter((a) => (a.payload as Row).stop).length).toBe(1);
  });

  test("studio-hung-agent-broken U1: no hung stop when the transcript's last turn was interrupted or ended; an open turn still stops", () => {
    const stops = (fixtureName: string | null) => {
      const s = fixture();
      const b = member(s, "builder", { want: "running", placed_at: T - 7200 }, { unit: "dispatched", presence: "running", walkAt: T });
      s.upsert("observed_workers", { project: "p", wt: b.wt }, { state: "working", last_output_at: T - 40 * 60, started_at: T - 7200, observed_at: T });
      if (fixtureName) s.upsert("observed_transcripts", { path: join(import.meta.dir, "..", "fixtures", "liveness", fixtureName) }, { project: "p", wt: b.wt, mtime: T - 40 * 60, size: 1, observed_at: T });
      return decide(ctx(s)).filter((a) => (a.payload as Row).stop).map((a) => (a.payload as Row).why);
    };
    expect(stops("interrupted.jsonl")).toEqual([]);
    expect(stops("ended.jsonl")).toEqual([]);
    expect(stops("open.jsonl")).toEqual(["hung"]);
    expect(stops(null)).toEqual(["hung"]);
  });

  test("U153: hung -> stop; loop restart expiring; RSS idle-only and throttled; fresh session meets reload+clear", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", placed_at: T - 7200 }, { unit: "dispatched", presence: "running", walkAt: T });
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { state: "working", last_output_at: T - 31 * 60, started_at: T - 7200, observed_at: T });
    expect(decide(ctx(s)).filter((a) => (a.payload as Row).stop).map((a) => (a.payload as Row).why)).toEqual(["hung"]);
    // loop-made restart older than 60 min is dropped with one event
    const s2 = fixture();
    const b2 = member(s2, "builder", { want: "running", restart_at: T - 3700, restart_mode: "now", restart_by: "loop", placed_at: T - 7200, reload_at: T - 5000, clear_at: T - 5000 }, { unit: "dispatched", presence: "running", walkAt: T });
    s2.upsert("observed_workers", { project: "p", wt: b2.wt }, { state: "idle", started_at: T - 100, observed_at: T });
    decide(ctx(s2));
    const after = s2.get("members", { id: b2.id })!;
    expect(after.restart_at).toBeNull();
    expect(Number(after.reloaded_at)).toBe(T - 100);
    expect(Number(after.cleared_at)).toBe(T - 100);
    expect(s2.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'wish_expired'").get()).toEqual({ n: 1 });
    // RSS: working waits, idle stops, '-' never
    const s3 = fixture();
    s3.upsert("config", { project: "p", file: "limits.conf", key: "restart_rss_gb" }, { value: "6", observed_at: T });
    const b3 = member(s3, "builder", { want: "running", placed_at: T - 7200 }, { unit: "dispatched", presence: "running", walkAt: T });
    s3.upsert("observed_workers", { project: "p", wt: b3.wt }, { state: "working", rss_kb: 7 * 1024 * 1024, started_at: T - 7200, observed_at: T });
    expect(decide(ctx(s3)).filter((a) => (a.payload as Row).stop)).toEqual([]);
    s3.upsert("observed_workers", { project: "p", wt: b3.wt }, { state: "idle", observed_at: T });
    checkpointed(s3, b3, "rss:0");
    expect(decide(ctx(s3)).filter((a) => (a.payload as Row).stop).map((a) => (a.payload as Row).why)).toEqual(["rss"]);
  });

  test("U155: stopped with an agent -> one close stop; archived with none and a worktree -> close remove; an archived squad's live agent is closed", () => {
    const seeded = (s: Store) => s.upsert("episodes", { project: "p", subject: "seed", kind: "wish_seed" }, { state: "done", started_at: T, observed_at: T, source: "loop" });
    const s = fixture(); seeded(s);
    const b = member(s, "builder", { want: "stopped", want_at: T - 100 }, { unit: "dispatched", presence: "running", walkAt: T });
    expect(decide(ctx(s)).map((a) => [a.kind, (a.payload as Row).phase, (a.payload as Row).why])).toEqual([["member.close", "stop", "stopped"]]);
    const s2 = fixture(); seeded(s2);
    const b2 = member(s2, "builder", { want: "gone", want_at: T - 100 }, { unit: "done", presence: "none", walkAt: T });
    s2.upsert("observed_worktrees", { project: "p", wt: b2.wt }, { path: "/ws/x", branch: "feat", observed_at: T });
    expect(decide(ctx(s2)).map((a) => [a.kind, (a.payload as Row).phase])).toEqual([["member.close", "remove"]]);
    const s3 = fixture({ status: "gone" }); seeded(s3);
    member(s3, "lead", { want: "running", want_at: T - 100 }, { presence: "running", walkAt: T });
    expect(decide(ctx(s3)).map((a) => [a.kind, (a.payload as Row).phase, (a.payload as Row).why])).toEqual([["member.close", "stop", "archived"]]);
    // a cancelled Builder is cancel.ts's: no close act from the decider
    const s4 = fixture(); seeded(s4);
    member(s4, "builder", { want: "gone", want_at: T - 100, want_payload: JSON.stringify({ cancel: { unit: "u1" } }) }, { unit: "cancelled", presence: "running", walkAt: T });
    expect(decide(ctx(s4))).toEqual([]);
    // a merged Builder still working is not stopped; once idle it is
    const s5 = fixture(); seeded(s5);
    const b5 = member(s5, "builder", { want: "running", want_at: T - 100 }, { unit: "done", presence: "running", walkAt: T });
    s5.upsert("observed_workers", { project: "p", wt: b5.wt }, { state: "working", observed_at: T });
    expect(decide(ctx(s5))).toEqual([]);
    s5.upsert("observed_workers", { project: "p", wt: b5.wt }, { state: "idle", observed_at: T });
    expect(decide(ctx(s5)).map((a) => [a.kind, (a.payload as Row).phase])).toEqual([["member.close", "stop"]]);
    // a suspended squad's live members get no close act: the pause flow closes them first (U158)
    const s6 = fixture({ status: "suspended" }); seeded(s6);
    member(s6, "lead", { want: "running", want_at: T - 100 }, { presence: "running", walkAt: T });
    expect(decide(ctx(s6))).toEqual([]);
    void b;
  });

  // U203: a finished unit's Builder is closed once its turn has ended, background shells or not.
  describe("U203: a finished Builder idle at its prompt", () => {
    const use = (id: string, bg = false) => JSON.stringify({ message: { content: [{ type: "tool_use", id, name: "Bash", input: bg ? { command: "sleep 9", run_in_background: true } : { command: "ls" } }] } });
    const res = (id: string, text = "ok") => JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
    const say = JSON.stringify({ message: { content: [{ type: "text", text: "done" }] } });
    const bgStarted = (id: string) => res(id, "Command running in background with ID: bg1");
    function seed(unit: string, state: string, lines: string[] | null) {
      const s = fixture(); s.upsert("episodes", { project: "p", subject: "seed", kind: "wish_seed" }, { state: "done", started_at: T, observed_at: T, source: "loop" });
      const b = member(s, "builder", { want: "running", want_at: T - 100 }, { unit, presence: "running", walkAt: T });
      s.upsert("observed_workers", { project: "p", wt: b.wt }, { state, observed_at: T });
      if (lines) {
        const dir = mkdtempSync(join(tmpdir(), "u203-")); roots.push(dir);
        const path = join(dir, "t.jsonl"); writeFileSync(path, lines.join("\n") + "\n");
        s.upsert("observed_transcripts", { path }, { project: "p", wt: b.wt, mtime: T, size: 1, observed_at: T });
      }
      return s;
    }
    const closes = (s: Store) => decide(ctx(s)).map((a) => [a.kind, (a.payload as Row).phase]);
    test("working, turn ended, a background task still open -> close stop", () => {
      expect(closes(seed("done", "working", [use("a", true), bgStarted("a"), say]))).toEqual([["member.close", "stop"]]);
    });
    test("a last tool_use with no result -> no close yet", () => {
      expect(closes(seed("done", "working", [use("a"), res("a"), use("b")]))).toEqual([]);
    });
    test("waiting -> no close", () => {
      expect(closes(seed("done", "waiting", [use("a"), res("a"), say]))).toEqual([]);
    });
    test("a unit not done -> no close", () => {
      expect(closes(seed("dispatched", "working", [use("a"), res("a"), say]))).toEqual([]);
    });
    test("a missing transcript -> no close", () => {
      expect(closes(seed("done", "working", null))).toEqual([]);
    });
  });

  test("U155: stopped then running again gives one start, only after the stop settles", () => {
    const s = fixture();
    s.upsert("episodes", { project: "p", subject: "seed", kind: "wish_seed" }, { state: "done", started_at: T, observed_at: T, source: "loop" });
    const b = member(s, "builder", { want: "stopped", want_at: T - 100 }, { unit: "dispatched", presence: "running", walkAt: T });
    expect(decide(ctx(s)).map((a) => a.kind)).toEqual(["member.close"]);
    s.upsert("episodes", { project: "p", subject: `member:${b.id}`, kind: "action:member.close" }, { episode_key: "close:stop:stopped:1", state: "running", source: "loop", started_at: T, observed_at: T });
    s.upsert("members", { id: b.id }, { want: "running", want_at: T + 1 });
    expect(decide(ctx(s, T + 1))).toEqual([]);   // the close claim is the member lock
    s.upsert("episodes", { project: "p", subject: `member:${b.id}`, kind: "action:member.close" }, { state: "done", ended_at: T + 2, source: "loop" });
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { presence: "none", account_at: T + 2, observed_at: T + 2 });
    expect(decide(ctx(s, T + 3)).map((a) => a.kind)).toEqual(["member"]);
  });

  test("a model write between start sent and settled keeps the start's episode; the next start gets a new one", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", want_at: T - 100 }, { unit: "dispatched", presence: "none" });
    const ep = startEpisode(s, b);
    s.upsert("members", { id: b.id }, { want_at: T, want_payload: JSON.stringify({ model: "sonnet" }) });
    expect(startEpisode(s, s.get("members", { id: b.id })!)).toBe(ep);   // the call's retry id stays: one session
    s.upsert("members", { id: b.id }, { placed_at: T + 5 });
    expect(startEpisode(s, s.get("members", { id: b.id })!)).toBe(`start:${T + 5}`);
  });

  test("U156: reload pending on an idle member -> one reload poke with the ack command, once per reload_at; never mid-turn", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", agent: "claude", reload_at: T - 10, reload_by: "operator", placed_at: T - 3600 }, { unit: "dispatched", presence: "running", walkAt: T });
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { state: "idle", started_at: T - 3600, observed_at: T });
    const acts = decide(ctx(s));
    expect(acts.map((a) => [a.kind, (a.payload as Row).reason])).toEqual([["poke", "reload"]]);
    expect((acts[0].payload as Row).text as string).toContain("'reload' 'ack' 'p' 'one' 'builder' 'u1'");
    expect((acts[0].payload as Row).text as string).toContain("re-read");
    // a repeat tick inside the poke backoff sends nothing more for the same reload_at
    expect(decide(ctx(s, T + 1)).filter((a) => a.kind === "poke")).toEqual([]);
    // past the backoff with the member still idle and unacked: the same episode is tried again
    expect(decide(ctx(s, T + 61)).filter((a) => a.kind === "poke").map((a) => (a.payload as Row).reason)).toEqual(["reload"]);
    // a new reload_at is a new episode: sent again
    s.upsert("members", { id: b.id }, { reload_at: T + 61 });
    expect(decide(ctx(s, T + 61)).filter((a) => a.kind === "poke").map((a) => (a.payload as Row).reason)).toEqual(["reload"]);
    // working: nothing, even past the backoff; idle again: still the new episode until acked
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { state: "working", observed_at: T + 61 });
    expect(decide(ctx(s, T + 61 + 61)).filter((a) => a.kind === "poke")).toEqual([]);
  });

  test("U156: clear pending on an idle member -> /clear (claude) or /new (codex), once; a muse member gets nothing", () => {
    const claude = fixture();
    const c = member(claude, "builder", { want: "running", agent: "claude", clear_at: T - 10, clear_by: "operator", placed_at: T - 3600 }, { unit: "dispatched", presence: "running", walkAt: T });
    claude.upsert("observed_workers", { project: "p", wt: c.wt }, { state: "idle", started_at: T - 3600, observed_at: T });
    const acts = decide(ctx(claude));
    expect(acts.map((a) => [a.kind, (a.payload as Row).reason])).toEqual([["poke", "clear"]]);
    expect((acts[0].payload as Row).text).toBe("/clear");
    expect(decide(ctx(claude, T + 1)).filter((a) => a.kind === "poke")).toEqual([]);
    const codex = fixture();
    const x = member(codex, "builder", { want: "running", agent: "codex", clear_at: T - 10, clear_by: "operator", placed_at: T - 3600 }, { unit: "dispatched", presence: "running", walkAt: T });
    codex.upsert("observed_workers", { project: "p", wt: x.wt }, { state: "idle", started_at: T - 3600, observed_at: T });
    const xa = decide(ctx(codex));
    expect(xa.map((a) => [a.kind, (a.payload as Row).reason])).toEqual([["poke", "clear"]]);
    expect((xa[0].payload as Row).text).toBe("/new");
    const muse = fixture();
    const mu = member(muse, "builder", { want: "running", agent: "muse", clear_at: T - 10, clear_by: "operator", placed_at: T - 3600 }, { unit: "dispatched", presence: "running", walkAt: T });
    muse.upsert("observed_workers", { project: "p", wt: mu.wt }, { state: "idle", started_at: T - 3600, observed_at: T });
    expect(decide(ctx(muse))).toEqual([]);
  });

  test("U156: a clear is confirmed by a new transcript (claude) or rollout (codex) after clear_at", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", agent: "claude", clear_at: T - 100, clear_by: "operator", placed_at: T - 3600 }, { unit: "dispatched", presence: "running", walkAt: T });
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { state: "idle", started_at: T - 3600, observed_at: T });
    s.upsert("observed_transcripts", { path: "/tok/s.jsonl" }, { project: "p", wt: b.wt, mtime: T - 200, size: 10, observed_at: T });
    decide(ctx(s));                                                        // baselines /tok/s.jsonl, types /clear
    expect(s.get("members", { id: b.id })!.cleared_at).toBeNull();
    s.upsert("observed_transcripts", { path: "/tok/s2.jsonl" }, { project: "p", wt: b.wt, mtime: T + 5, size: 10, observed_at: T });
    expect(decide(ctx(s, T + 10)).filter((a) => a.kind === "poke")).toEqual([]);
    expect(Number(s.get("members", { id: b.id })!.cleared_at)).toBe(T + 10);
    expect(s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'cleared'").get()).toEqual({ n: 1 });
    // a headless reviewer's transcript beside the member's own never confirms
    const r = fixture();
    const rb = member(r, "builder", { want: "running", agent: "claude", clear_at: T - 100, clear_by: "operator", placed_at: T - 3600 }, { unit: "dispatched", presence: "running", walkAt: T });
    r.upsert("observed_workers", { project: "p", wt: rb.wt }, { state: "idle", started_at: T - 3600, observed_at: T });
    r.upsert("observed_transcripts", { path: "/tok/o.jsonl" }, { project: "p", wt: rb.wt, mtime: T - 200, size: 10, observed_at: T });
    decide(ctx(r));
    r.upsert("observed_transcripts", { path: "/tok/review.jsonl" }, { project: "p", wt: rb.wt, mtime: T + 5, size: 10, entrypoint: "sdk-cli", observed_at: T });
    decide(ctx(r, T + 10));
    expect(r.get("members", { id: rb.id })!.cleared_at).toBeNull();
    // codex: a new interactive rollout confirms; a headless one does not
    const x = fixture();
    const xb = member(x, "builder", { want: "running", agent: "codex", clear_at: T - 100, clear_by: "operator", placed_at: T - 3600, wt: "id::/w/x" }, { unit: "dispatched", presence: "running", walkAt: T });
    x.upsert("observed_workers", { project: "p", wt: xb.wt }, { state: "idle", started_at: T - 3600, observed_at: T });
    x.upsert("observed_rollouts", { path: "/cx/a.jsonl" }, { cwd: "/w/x", mtime: T - 200, size: 50, originator: "claude", observed_at: T });
    decide(ctx(x));
    x.upsert("observed_rollouts", { path: "/cx/headless.jsonl" }, { cwd: "/w/x", mtime: T + 5, size: 50, originator: "codex_exec", observed_at: T });
    decide(ctx(x, T + 10));
    expect(x.get("members", { id: xb.id })!.cleared_at).toBeNull();
    x.upsert("observed_rollouts", { path: "/cx/b.jsonl" }, { cwd: "/w/x", mtime: T + 11, size: 50, originator: "claude", observed_at: T });
    decide(ctx(x, T + 20));
    expect(Number(x.get("members", { id: xb.id })!.cleared_at)).toBe(T + 20);
  });

  test("U156: an unconfirmed reload never wedges a switch start; the fresh session then satisfies it", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", agent: "claude", reload_at: T - 10, reload_by: "operator", placed_at: T - 3600,
      want_payload: JSON.stringify({ why: "phase" }) }, { unit: "dispatched", presence: "running", walkAt: T });
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { state: "idle", started_at: T - 3600, observed_at: T });
    const acts = decide(ctx(s));
    expect(acts.map((a) => a.kind)).toEqual(["member"]);   // the switch start, not the reload poke
    s.upsert("members", { id: b.id }, { placed_at: T + 5 });   // the new session satisfies the reload
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { started_at: T + 5, account_at: T + 6, observed_at: T + 6 });
    expect(decide(ctx(s, T + 6)).filter((a) => a.kind === "poke")).toEqual([]);   // satisfied: nothing typed
    expect(Number(s.get("members", { id: b.id })!.reloaded_at)).toBe(T + 5);
  });

  test("U156: a loop-made clear expires at 60 minutes; an operator clear and any reload never do", () => {
    const s = fixture();
    const b = member(s, "builder", { want: "running", agent: "claude", clear_at: T - 3700, clear_by: "loop", placed_at: T - 7200 }, { unit: "dispatched", presence: "running", walkAt: T });
    s.upsert("observed_workers", { project: "p", wt: b.wt }, { state: "idle", started_at: T - 7200, observed_at: T });
    expect(decide(ctx(s)).filter((a) => a.kind === "poke")).toEqual([]);
    expect(s.get("members", { id: b.id })!.clear_at).toBeNull();
    expect(s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'wish_expired'").get()).toEqual({ n: 1 });
    const s2 = fixture();
    const b2 = member(s2, "builder", { want: "running", agent: "claude", reload_at: T - 7200, reload_by: "operator", clear_at: T - 7200, clear_by: "operator", placed_at: T - 7200 },
      { unit: "dispatched", presence: "running", walkAt: T });
    s2.upsert("observed_workers", { project: "p", wt: b2.wt }, { state: "idle", started_at: T - 7200, observed_at: T });
    expect(decide(ctx(s2)).map((a) => (a.payload as Row).reason)).toEqual(["reload"]);
    expect([s2.get("members", { id: b2.id })!.reload_at, s2.get("members", { id: b2.id })!.clear_at]).toEqual([T - 7200, T - 7200]);
  });
});
