// liveness.test.ts — U7: broken members, the account-wait poke and unpark (bin/loop/reconcilers/liveness.ts).
// Scenario names are the removed sweep tests's (main 0fbb8be) for step 2, step 4, spawn grace (sweep-required
// U2) and parked re-evaluation (U7). Each runs the real tick on a copy of tests/fixtures/loop/state
// with a world observer standing in for Orca and the clock injected per tick (DS_NOW-style).
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { Action, Actuator, TickCtx } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import liveness, { QUIET_POKE_TEXT, builderHead, dispatchVerdict, foregroundOpen, leadVerdict, linesEnded, openCalls, stepOpen, turnEnded } from "../../bin/loop/reconcilers/liveness.ts";
import { pick } from "../../bin/loop/capacity/pick.ts";
import ready from "../../bin/loop/reconcilers/ready.ts";
import { FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { orcaObserver } from "../../bin/loop/observers/orca.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const T = 1_800_000_000;
const MIN = 60;
const W = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/";
const STUDIO = `${W}ds-fx-studio`, LEAD = `${W}ds-dev-studio-lead-demo`, THINKER = `${W}ds-dev-studio-thinker-demo`;
const B2 = `${W}ds-dev-studio-builder-u2-sqlite-store-migrations-and-demo`; // u2's Builder (dispatched, not in members)
const B2NAME = "builder-u2-sqlite-store-migrations-and";

type Seen = { state?: string; out?: number; agents?: number; unread?: number; limited?: string | null; dispatch?: string; dispatchId?: string; dispatchAt?: number; dispatchSeenAt?: number | null; said?: string; terminals?: string[] };
const temps: string[] = [], stores: Store[] = [];
const readHead = builderHead.read;
afterEach(() => {
  builderHead.read = readHead;
  delete process.env.DS_NOW;
  delete process.env.DS_SWEEP_SPAWN_GRACE_MIN;
  delete process.env.DS_SWEEP_CRASH_WINDOW_MIN;
  for (const s of stores.splice(0)) s.close();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

// The fixture squad `demo`, all idle and healthy; `world` is what Orca shows (a missing wt is GONE).
function setup() {
  const root = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  const s = open(root); stores.push(s); importJson(s);
  { // the fixture approves only demo-plan.md; u3/u4 run on demo-loop-plan.md (U157: unapproved plans get no Builder)
    const row = s.get("squads", { project: "fx", topic: "demo" })!;
    const doc = JSON.parse(String(row.doc ?? "{}"));
    s.upsert("squads", { project: "fx", topic: "demo" },
      { doc: JSON.stringify({ ...doc, approved_plans: [...(doc.approved_plans ?? []), "/state/fx/squads/demo-loop-plan.md"] }) });
  }
  const world = new Map<string, Seen>([STUDIO, LEAD, THINKER, B2].map((wt) => [wt, { state: "idle", agents: 1 }]));
  const acted: Action[] = [];
  const act: Actuator & { fail?: boolean } = {
    act(a, c) {
      acted.push(a);
      if (a.kind === "run-switch" && (a.payload as Row).liveness) c.store.upsert("episodes", { project: a.project, subject: a.subject, kind: "req" }, {
        squad: a.squad, started_at: c.now, ended_at: null, count: 1, episode_key: a.episode, state: "sent", source: "loop", observed_at: c.now,
      });
      if (act.fail && a.kind === "poke") c.store.upsert("episodes", { project: a.project, subject: a.subject, kind: "action:poke" }, { state: "failed" });
    },
  };
  const observer = { name: "world", run(c: TickCtx) {
    c.store.db.run("UPDATE observed_workers SET gone_at = ? WHERE project = ?", [c.now, c.project]);
    c.store.db.run("UPDATE observed_terminals SET gone_at = ? WHERE project = ?", [c.now, c.project]);
    for (const [wt, w] of world) {
      c.store.upsert("observed_workers", { project: c.project, wt }, { state: w.state ?? "idle", last_output_at: w.out ?? null, unread: w.unread ?? 0,
        limited: w.limited ?? null, dispatch_id: w.dispatchId ?? (w.dispatch ? `ctx_${w.dispatchAt}` : null), dispatch: w.dispatch ?? null, dispatch_at: w.dispatchAt ?? null,
        dispatch_seen_at: w.dispatchSeenAt !== undefined ? w.dispatchSeenAt : c.now,
        said: w.said ?? null, observed_at: c.now, gone_at: null });
      c.store.upsert("observed_worktrees", { project: c.project, wt }, { doc: { agents: w.agents ?? 1 }, observed_at: c.now, gone_at: null });
      for (const [i, handle] of (w.terminals ?? []).entries()) c.store.upsert("observed_terminals", { project: c.project, handle }, {
        wt, doc: { newest: i === 0 }, observed_at: c.now, gone_at: null,
      });
    }
  } };
  const loop = new Loop(s, { observers: [observer], reconcilers: [liveness, ready] }, act, { projects: () => ["fx"] });
  const tick = async (at: number) => { process.env.DS_NOW = String(at); return (await loop.tick(at)).acted; };
  const reqs = (target: string) => acted.filter((a) => a.kind === "request.file" && (a.payload as Row).target === target);
  const text = (a: Action) => String((a.payload as Row).text);
  const pokes = () => acted.filter((a) => a.kind === "poke");
  const alerts = () => acted.filter((a) => a.kind === "alert");
  // U46: the fixture's unit with a dangling ext ref now has a Studio card; these tests are about liveness.
  s.db.run("UPDATE units SET ext_deps = '[]', hold = 1 WHERE slug = 'u10-ext-missing'");
  const sinceAll = (at: number) => s.db.run("UPDATE members SET since = ? WHERE project = 'fx'", [new Date(at * 1000).toISOString()]);
  return { s, world, act, acted, tick, reqs, text, pokes, alerts, sinceAll };
}

describe("step 2: dead", () => {
  test("Lead GONE: no request and no alert; the decider starts it (U152); minutes on: still nothing", async () => {
    const t = setup();
    t.world.delete(LEAD);
    await t.tick(T);
    await t.tick(T + 6 * MIN);
    expect(t.acted).toEqual([]);
  });
  test("Lead/Thinker 'done' (turn ended): no request", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "done" }); t.world.set(THINKER, { state: "done" });
    await t.tick(T);
    expect(t.acted).toEqual([]);
  });

  test("Studio GONE: one operator alert, never a request", async () => {
    const t = setup();
    t.world.delete(STUDIO);
    await t.tick(T);
    await t.tick(T + MIN);
    // studio-hung-agent-broken U2: the Studio's own card; with no adopted handle there is nothing to restart through.
    expect(t.alerts().map((a) => [t.text(a), (a.payload as Row).to])).toEqual([[expect.stringMatching(/^studio \(dead since .*\) — the fx Studio \(your cockpit terminal; the loop has adopted none\) is no longer listed by Orca$/), "@project"]]);
    expect(t.alerts()[0]!.payload).toMatchObject({ title: "Studio not responding", card: "agent_broken", option: "look at it, then restart it by hand", why: "The loop never restarts the Studio on its own." });
    expect((t.alerts()[0]!.payload as Row).fields).toBeUndefined();
    expect(t.acted.filter((a) => a.kind === "request.file")).toEqual([]);
  });

  test("studio-hung-agent-broken U2: a hung Studio with an adopted handle: Studio not responding, Restart Studio / It's fine, the terminal named", async () => {
    const t = setup();
    t.s.db.run("INSERT INTO members (project, squad, role, suffix, wt, handle, agent, observed_at, updated_at) VALUES ('fx', '_studio', 'studio', '', ?, 'term_s', 'claude', ?, ?)", [STUDIO, T, T]);
    t.world.set(STUDIO, { state: "working", out: T - 35 * MIN, terminals: ["term_s"] });
    t.s.upsert("observed_terminals", { project: "fx", handle: "term_s" }, { wt: STUDIO, title: "fx studio", observed_at: T, gone_at: null });
    await t.tick(T);
    await t.tick(T + MIN);
    const cards = t.alerts().filter((a) => a.subject === "_studio");
    expect(cards).toHaveLength(1);
    expect(t.text(cards[0]!)).toMatch(/^studio \(hung since \d\d:\d\d\) — the fx Studio \(your cockpit terminal fx studio, term_s\) has shown no output for 3[56] min while Orca reads it as working$/);
    expect(cards[0]!.payload).toMatchObject({ title: "Studio not responding", card: "agent_broken", option: "", to: "@project", why: "The loop never restarts the Studio on its own.",
      fields: { restart: true, handle: "term_s", options: ["Restart Studio", "It's fine"] } });
    expect(t.acted.filter((a) => a.kind === "studio-move" || a.kind === "request.file")).toEqual([]);
  });

  test("Lead + Studio GONE: only the Studio's alert", async () => {
    const t = setup();
    t.world.delete(STUDIO); t.world.delete(LEAD);
    await t.tick(T);
    expect(t.alerts().map(t.text)).toEqual([expect.stringContaining("studio (")]);
  });
  test("Builder GONE, its unit open or done: no request (the decider starts an unfinished one)", async () => {
    const t = setup();
    t.world.delete(B2);
    await t.tick(T);
    expect(t.acted).toEqual([]);
    t.s.db.run("UPDATE units SET status = 'done' WHERE slug = 'u2-sqlite-store-migrations-and'");
    await t.tick(T + MIN);
    // u4 is now ready: no poke — the loop writes its Builder wish instead (U157).
    expect(t.pokes()).toEqual([]);
    expect(t.s.db.query("SELECT want, want_by FROM members WHERE project = 'fx' AND squad = 'demo' AND role = 'builder' AND suffix = 'u4-orca-state-file-config'").get()).toEqual({ want: "running", want_by: "loop" });
  });
  test("suspended squad: no request", async () => {
    const t = setup();
    t.s.db.run("UPDATE squads SET status = 'suspended'");
    t.world.delete(LEAD); t.world.delete(B2);
    await t.tick(T);
    expect(t.acted).toEqual([]);
  });

  test("empty worker-states: no request (no fresh Orca observation this tick)", async () => {
    const t = setup();
    await t.tick(T);
    t.s.db.run("UPDATE observed_workers SET observed_at = ?", [T]);
    const l = new Loop(t.s, { observers: [], reconcilers: [liveness] }, t.act, { projects: () => ["fx"] });
    t.s.db.run("DELETE FROM observed_workers WHERE wt = ?", [LEAD]);
    expect((await l.tick(T + MIN)).acted).toEqual([]);
  });
});

describe("step 2: not responding", () => {
  test("the Lead is poked; 2 min later no second poke; 5 min later poked again; after 2 pokes a restart request", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T);                      // first unread seen
    await t.tick(T + 9 * MIN);
    expect(t.pokes()).toEqual([]);
    await t.tick(T + 10 * MIN);
    expect(t.pokes().map((a) => [a.member, (a.payload as Row).reason])).toEqual([[LEAD, "silent"]]);
    await t.tick(T + 12 * MIN);
    expect(t.pokes().length).toBe(1);
    await t.tick(T + 15 * MIN);
    expect(t.pokes().length).toBe(2);
    expect(t.reqs("_studio")).toEqual([]);
    await t.tick(T + 20 * MIN);
    expect(t.pokes().length).toBe(2);
    expect(t.reqs("_studio").map(t.text)).toEqual([expect.stringContaining("restart lead of demo (not responding since")]);
  });

  test("poke fails (no terminal): request at once", async () => {
    const t = setup();
    t.act.fail = true;
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T);
    await t.tick(T + 10 * MIN);
    expect(t.pokes().length).toBe(1);
    await t.tick(T + 10 * MIN + 5);
    expect(t.reqs("_studio").map(t.text)).toEqual([expect.stringContaining("not responding since")]);
    expect(t.pokes().length).toBe(1);
  });

  test("mail read: the unread clock starts over", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T);
    t.world.set(LEAD, { state: "idle", unread: 0 });
    await t.tick(T + 5 * MIN);
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T + 12 * MIN);
    expect(t.pokes()).toEqual([]);
  });
});

describe("leadVerdict: the board's read of a Lead agrees with the reconciler", () => {
  const verdict = (t: ReturnType<typeof setup>, at: number) => leadVerdict(t.s, "fx", LEAD, at);
  test("idle with unread mail: none before SILENT_MIN, not responding from it, in step with the first poke", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T);
    expect(verdict(t, T + 5 * MIN)).toBeNull();
    await t.tick(T + 9 * MIN);
    expect(verdict(t, T + 9 * MIN)).toBeNull();
    expect(t.pokes()).toEqual([]);
    await t.tick(T + 10 * MIN);
    expect(verdict(t, T + 10 * MIN)).toEqual({ verdict: "not responding", since: T });
    expect(t.pokes().length).toBe(1);
  });
  test("idle or done with nothing unread, however long: none; the read writes no row", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "done", out: T - 80 * MIN });
    await t.tick(T);
    const before = JSON.stringify(t.s.db.query("SELECT * FROM episodes ORDER BY id").all());
    expect(verdict(t, T + 80 * MIN)).toBeNull();
    expect(JSON.stringify(t.s.db.query("SELECT * FROM episodes ORDER BY id").all())).toBe(before);
    expect(t.pokes()).toEqual([]);
  });
  test("the mail was read (count 0) while the episode is still open: none", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T);
    t.s.db.run("UPDATE observed_workers SET unread = 0 WHERE project = 'fx' AND wt = ?", [LEAD]);
    expect(verdict(t, T + 15 * MIN)).toBeNull();
  });
  test("working with no output: hung at HUNG_MIN (an open step shares broken()'s longStepOpen, covered by the U82 tests)", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "working", out: T - 35 * MIN });
    await t.tick(T);
    expect(verdict(t, T)).toEqual({ verdict: "hung", since: T - 35 * MIN });
    expect(verdict(t, T - 10 * MIN)).toBeNull();
  });
  test("no run, usage-limited, inside the spawn grace: none", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T);
    expect(verdict(t, T + 15 * MIN)?.verdict).toBe("not responding");
    t.s.db.run("UPDATE squads SET lead_wt = ?, run_id = NULL WHERE project = 'fx' AND topic = 'demo'", [LEAD]);
    expect(verdict(t, T + 15 * MIN)).toBeNull();
    t.s.db.run("UPDATE squads SET run_id = 'run_x' WHERE project = 'fx' AND topic = 'demo'");
    expect(verdict(t, T + 15 * MIN)?.verdict).toBe("not responding");
    t.s.db.run("UPDATE observed_workers SET limited = 'limit' WHERE project = 'fx' AND wt = ?", [LEAD]);
    expect(verdict(t, T + 15 * MIN)).toBeNull();
    t.s.db.run("UPDATE observed_workers SET limited = NULL, started_at = ? WHERE project = 'fx' AND wt = ?", [T + 14 * MIN, LEAD]);
    expect(verdict(t, T + 15 * MIN)).toBeNull();
  });
});

describe("U82: no quiet poke during a long step", () => {
  const use = (id: string, input: Row = {}) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
  const res = (id: string, content = "ok") => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
  const note = (bid: string, status: string) => JSON.stringify({ type: "user", message: { content: `<task-notification><task-id>${bid}</task-id><status>${status}</status></task-notification>` } });
  function member(lines: string[], out: number) {
    const t = setup();
    t.s.db.run("INSERT INTO members (project, squad, role, suffix, wt, observed_at, updated_at) VALUES ('fx', 'demo', 'builder', 'u2-sqlite-store-migrations-and', ?, ?, ?)", [B2, T, T]);
    const path = join(temps[temps.length - 1], "b2.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    t.s.upsert("observed_transcripts", { path }, { project: "fx", wt: B2, mtime: T, size: 1, observed_at: T });
    t.world.set(B2, { state: "working", out: T - out * MIN });
    return t;
  }
  test("an open tool_use, quiet 13 min: no poke, no request, no event", async () => {
    const t = member([use("a", {}), res("a"), use("b")], 13);
    await t.tick(T);
    expect(t.pokes()).toEqual([]);
    expect(t.reqs("demo")).toEqual([]);
    expect(t.alerts()).toEqual([]);
  });
  test("an open tool_use, quiet 35 min: not hung either", async () => {
    const t = member([use("b")], 35);
    await t.tick(T);
    expect(t.pokes()).toEqual([]);
    expect(t.reqs("demo")).toEqual([]);
  });
  test("a running background task: no poke; once it completes: poked", async () => {
    const lines = [use("a", { run_in_background: true }), res("a", "Command running in background with ID: bx1"), use("b"), res("b")];
    const t = member(lines, 13);
    await t.tick(T);
    expect(t.pokes()).toEqual([]);
    const u = member([...lines, note("bx1", "completed")], 13);
    await u.tick(T);
    await u.tick(T + MIN);
    expect(u.pokes().map((a) => (a.payload as Row).text)).toEqual([QUIET_POKE_TEXT]);
  });
  test("a completion recorded only as a queue-operation, a stopped task, a TaskStop: none keeps the member exempt", async () => {
    const start = [use("a", { run_in_background: true }), res("a", "Command running in background with ID: bx1")];
    const queued = JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "<task-notification><task-id>bx1</task-id><status>completed</status></task-notification>" });
    const stopped = note("bx1", "stopped");
    const stop = [use("s", {}).replace('"name":"Bash"', '"name":"TaskStop"').replace('"input":{}', '"input":{"task_id":"bx1"}'), res("s")];
    for (const tail of [[queued], [stopped], stop]) {
      const t = member([...start, ...tail], 13);
      await t.tick(T);
      await t.tick(T + MIN);
      expect(t.pokes().length).toBe(1);
    }
  });
  test("long_step_min 0 turns the exemption off; an open step past cap + HUNG_MIN is hung", async () => {
    const t = member([use("a")], 13);
    t.s.upsert("config", { project: "fx", file: "limits.conf", key: "long_step_min" }, { value: "0", observed_at: T });
    await t.tick(T); await t.tick(T + MIN);
    expect(t.pokes().length).toBe(1);
    const u = member([use("a")], 91);
    await u.tick(T);
    expect(u.reqs("demo")).toEqual([]);   // U153: hung is the decider's stop, no Lead request
  });
  test("nothing open: poked once as before", async () => {
    const t = member([use("a"), res("a")], 13);
    await t.tick(T);
    await t.tick(T + MIN);
    expect(t.pokes().length).toBe(1);
  });
  test("an open step past the long cap: poked once", async () => {
    const t = member([use("a")], 61);
    await t.tick(T);
    await t.tick(T + MIN);
    expect(t.pokes().map((a) => (a.payload as Row).text)).toEqual([QUIET_POKE_TEXT]);
    expect(t.reqs("demo")).toEqual([]);
  });
});

describe("studio-hung-agent-broken U1: an agent at its prompt after Esc is not hung", () => {
  const FX = join(import.meta.dir, "..", "fixtures", "liveness");
  const MEMBERS = [LEAD, B2, STUDIO];
  // The Lead, u2's Builder and the Studio: Orca reads each `working` with no output for 40 min, and each one's
  // newest transcript is a copy of `fixture`, last written when its output stopped.
  function quiet40(fixture: string) {
    const t = setup();
    for (const [i, wt] of MEMBERS.entries()) {
      const path = join(temps[temps.length - 1], `t${i}-${fixture}`);
      copyFileSync(join(FX, fixture), path);
      t.s.upsert("observed_transcripts", { path }, { project: "fx", wt, mtime: T - 40 * MIN, size: 1, observed_at: T });
      t.world.set(wt, { state: "working", out: T - 40 * MIN });
    }
    return t;
  }
  // The `req` markers liveness leaves for the decider's hung stop (U153), by member key.
  const hungMarks = (t: ReturnType<typeof setup>) => (t.s.db.query("SELECT subject, episode_key FROM episodes WHERE project = 'fx' AND kind = 'req'").all() as Row[])
    .filter((r) => String(r.episode_key).startsWith("hung|")).map((r) => r.subject).sort();

  for (const fixture of ["interrupted.jsonl", "ended.jsonl"]) {
    test(`${fixture}: no hung verdict, no restart marker, no request and no card for the Lead, a Builder or the Studio`, async () => {
      const t = quiet40(fixture);
      for (const wt of MEMBERS) expect(turnEnded(t.s, wt)).toBe(true);
      await t.tick(T);
      await t.tick(T + MIN);
      expect(leadVerdict(t.s, "fx", LEAD, T + MIN)).toBeNull();
      expect(hungMarks(t)).toEqual([]);
      expect(t.alerts()).toEqual([]);
      expect(t.acted.filter((a) => a.kind === "request.file")).toEqual([]);
    });
  }

  test("open.jsonl (a new prompt after an ended turn, no end record since): hung for all three, as today", async () => {
    const t = quiet40("open.jsonl");
    for (const wt of MEMBERS) expect(turnEnded(t.s, wt)).toBe(false);
    await t.tick(T);
    expect(leadVerdict(t.s, "fx", LEAD, T)).toEqual({ verdict: "hung", since: T - 40 * MIN });
    expect(hungMarks(t)).toEqual([`demo.${B2NAME}`, "demo.lead"]);
    expect(t.alerts().map(t.text)).toEqual([expect.stringMatching(/^studio \(hung since .*\) — nobody above it can restart it$/)]);
  });

  test("turnEnded: no transcript, or one last written before this process started, keeps today's rule", async () => {
    const t = quiet40("interrupted.jsonl");
    await t.tick(T);
    expect(turnEnded(t.s, THINKER)).toBe(false);
    t.s.db.run("UPDATE observed_workers SET started_at = ? WHERE project = 'fx' AND wt = ?", [T - 30 * MIN, LEAD]);
    expect(turnEnded(t.s, LEAD)).toBe(false);
    expect(turnEnded(t.s, B2)).toBe(true);
  });

  test("linesEnded: the newest record that speaks for the turn decides", () => {
    const rec = (r: Row) => JSON.stringify(r);
    const user = (content: unknown, extra: Row = {}) => rec({ type: "user", message: { content }, ...extra });
    const end = rec({ type: "system", subtype: "turn_duration" });
    const asst = rec({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
    expect(linesEnded([])).toBe(false);
    expect(linesEnded([asst, end])).toBe(true);
    expect(linesEnded([asst, rec({ type: "system", subtype: "stop_hook_summary" })])).toBe(true);
    expect(linesEnded([asst, user("[Request interrupted by user]")])).toBe(true);
    expect(linesEnded([asst, user([{ type: "text", text: "[Request interrupted by user for tool use]" }])])).toBe(true);
    // skipped: bookkeeping, meta, compaction summary, a local command's output, other system records, a torn line
    expect(linesEnded([end, rec({ type: "file-history-snapshot" }), user("<system-reminder>x</system-reminder>", { isMeta: true }),
      user("This session is being continued", { isCompactSummary: true }), user("<local-command-stdout>done</local-command-stdout>"),
      rec({ type: "system", subtype: "away_summary" }), '{"type":"assistant","message":{"con'])).toBe(true);
    // open: a later prompt, Stop hook feedback, a task notification, a tool result, assistant output
    for (const open of [user("go on"), user("Stop hook feedback: keep going"), user("<task-notification><status>completed</status></task-notification>"),
      user([{ type: "tool_result", tool_use_id: "x", content: "ok" }]), asst]) expect(linesEnded([end, open])).toBe(false);
    // a tool result carrying the interrupt text ends it
    expect(linesEnded([asst, user([{ type: "tool_result", tool_use_id: "x", content: "no" }, { type: "text", text: "[Request interrupted by user for tool use]" }])])).toBe(true);
  });
});

describe("step 2: hung, quiet, exited", () => {
  test("Builder working, no output 31 min: hung is the decider's (U153), no Lead request; output 10 min ago: nothing", async () => {
    const t = setup();
    t.world.set(B2, { state: "working", out: T - 31 * MIN });
    await t.tick(T);
    expect(t.reqs("demo")).toEqual([]);
    const u = setup();
    u.world.set(B2, { state: "working", out: T - 10 * MIN });
    await u.tick(T);
    expect(u.reqs("demo")).toEqual([]);
  });

  test("quiet: working Builder silent 13 min: poked once, asks if stuck, no request; output then silent again: poked for the new episode", async () => {
    const t = setup();
    t.world.set(B2, { state: "working", out: T - 13 * MIN });
    await t.tick(T);
    // B2 has no members row: wake() cannot read it, so give it one, as add-member would.
    expect(t.pokes()).toEqual([]);
    t.s.db.run("INSERT INTO members (project, squad, role, suffix, wt, observed_at, updated_at) VALUES ('fx', 'demo', 'builder', 'u2-sqlite-store-migrations-and', ?, ?, ?)", [B2, T, T]);
    await t.tick(T + MIN);
    expect(t.pokes().map((a) => [a.member, (a.payload as Row).text])).toEqual([[B2, QUIET_POKE_TEXT]]);
    await t.tick(T + 2 * MIN);
    expect(t.pokes().length).toBe(1);
    expect(t.reqs("demo")).toEqual([]);
    t.world.set(B2, { state: "working", out: T + 3 * MIN });
    await t.tick(T + 16 * MIN);
    expect(t.pokes().length).toBe(2);
  });

  test("quiet: silent 31 min still escalates as hung, with no quiet poke; quiet_nudge_min=20, silent 13 min: no poke", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "working", out: T - 31 * MIN });
    await t.tick(T);
    expect(t.pokes()).toEqual([]);
    expect(t.reqs("_studio")).toEqual([]);   // U153: hung goes to the decider, not a request
    const u = setup();
    u.s.upsert("config", { project: "fx", file: "limits.conf", key: "quiet_nudge_min" }, { value: "20", observed_at: T });
    u.world.set(LEAD, { state: "working", out: T - 13 * MIN });
    await u.tick(T);
    expect(u.pokes()).toEqual([]);
  });

  test("quiet: working Lead silent 13 min: poked; the Studio is never quiet-poked", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "working", out: T - 13 * MIN });
    t.world.set(STUDIO, { state: "working", out: T - 13 * MIN });
    await t.tick(T);
    expect(t.pokes().map((a) => a.member)).toEqual([LEAD]);
  });

  test("quiet: an obsolete capacity wait cannot suppress the normal quiet poke", async () => {
    const t = setup();
    t.s.db.run("INSERT INTO members (project, squad, role, suffix, wt, observed_at, updated_at) VALUES ('fx', 'demo', 'builder', 'u2-sqlite-store-migrations-and', ?, ?, ?)", [B2, T, T]);
    t.s.db.run("UPDATE units SET wait_until = ? WHERE slug = 'u2-sqlite-store-migrations-and'", [T + 600]);
    t.world.set(B2, { state: "working", out: T - 13 * MIN });
    await t.tick(T);
    expect(t.pokes()).toHaveLength(1);
    expect(t.s.db.query("SELECT wait_until FROM units WHERE slug = 'u2-sqlite-store-migrations-and'").get()).toEqual({ wait_until: null });
  });

  test("Lead idle with no agent terminal: no request and never poked (the decider starts it)", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "idle", agents: 0, unread: 1 });
    await t.tick(T - 12 * MIN);
    await t.tick(T);
    await t.tick(T + MIN);
    expect(t.reqs("_studio")).toEqual([]);
    expect(t.pokes()).toEqual([]);
  });
  test("working with no agent terminal (a restart in flight): nothing", async () => {
    const t = setup();
    t.world.set(B2, { state: "working", agents: 0, out: T - 10 * MIN });
    await t.tick(T);
    expect(t.acted).toEqual([]);
  });
});

describe("obsolete capacity records", () => {
  test("an old park is retired immediately", async () => {
    const t = setup();
    const key = { project: "fx", subject: `demo.${B2NAME}`, kind: "park" };
    t.s.db.run("UPDATE units SET wait_until = ? WHERE slug = 'u2-sqlite-store-migrations-and'", [T + 5000]);
    t.s.upsert("episodes", key, { squad: "demo", started_at: T, ended_at: T + 5000, state: "parked", episode_key: "ek", source: "loop", observed_at: T });
    await t.tick(T);
    await t.tick(T + MIN);
    expect(t.s.db.query("SELECT wait_until FROM units WHERE slug = 'u2-sqlite-store-migrations-and'").get()).toEqual({ wait_until: null });
    expect(t.s.get("episodes", key)).toBeNull();
  });

  test("a usage-limited Builder keeps its at-limit guard after its obsolete wait is retired", async () => {
    const t = setup();
    t.s.db.run("UPDATE units SET wait_until = ? WHERE slug = 'u2-sqlite-store-migrations-and'", [T + 5000]);
    t.world.set(B2, { state: "working", out: T - 40 * MIN, limited: "-\t5-hour limit reached" });
    await t.tick(T);
    expect(t.acted).toEqual([]);
    expect(t.s.db.query("SELECT wait_until FROM units WHERE slug = 'u2-sqlite-store-migrations-and'").get()).toEqual({ wait_until: null });
  });
});

describe("capacity reset timestamps never schedule a Lead poke", () => {
  test.each([T - 60, T + 600])("an old unit wait at %s is discarded without a reset poke", async (until) => {
    const t = setup();
    t.s.db.run("UPDATE units SET wait_until = ? WHERE slug = 'u3-loop-daemon-skeleton-health'", [until]);
    await t.tick(T); await t.tick(T + MIN);
    expect(t.pokes().filter((a) => (a.payload as Row).reason === "acctwait")).toEqual([]);
    expect(t.s.db.query("SELECT wait_until FROM units WHERE slug = 'u3-loop-daemon-skeleton-health'").get()).toEqual({ wait_until: null });
  });
});

describe("cutover: the sweep's imported markers are honoured", () => {
  const sweepRow = (t: ReturnType<typeof setup>, subject: string, kind: string, set: Row) =>
    t.s.upsert("episodes", { project: "fx", subject, kind }, { squad: "demo", source: "sweep", observed_at: T, ...set });

  test("a sweep restart request for the same hang: no second request and no recheck alert (U153: hung is the decider's)", async () => {
    const t = setup();
    sweepRow(t, "demo.lead", "req", { started_at: T - 60, episode_key: `hung|${LEAD}|${(T - 31 * MIN) * 1000 + 417}`, state: "sent" });
    t.world.set(LEAD, { state: "working", out: T - 31 * MIN });
    await t.tick(T);
    expect(t.reqs("_studio")).toEqual([]);
    await t.tick(T + 5 * MIN);
    expect(t.alerts()).toEqual([]);
  });

  test("a sweep alert already raised for the episode: not raised again", async () => {
    const t = setup();
    const ep = `hung|${LEAD}|${(T - 31 * MIN) * 1000}`;
    sweepRow(t, "demo.lead", "req", { started_at: T - 10 * MIN, episode_key: ep, state: "sent" });
    sweepRow(t, "demo.lead", "alerted", { started_at: T, episode_key: `${ep}|recheck`, state: JSON.stringify([`${ep}|recheck`]) });
    t.world.set(LEAD, { state: "working", out: T - 31 * MIN });
    await t.tick(T);
    expect(t.acted).toEqual([]);
  });

  test("a sweep request and alert for an earlier hang: a new hang gets no request (U153)", async () => {
    const t = setup();
    const old = `hung|${LEAD}|${(T - 5 * 3600) * 1000 + 417}`;
    sweepRow(t, "demo.lead", "req", { started_at: T - 4 * 3600, episode_key: old, state: "sent" });
    sweepRow(t, "demo.lead", "alerted", { started_at: T - 4 * 3600, episode_key: `${old}|recheck`, state: JSON.stringify([`${old}|recheck`]) });
    t.world.set(LEAD, { state: "working", out: T - 31 * MIN });
    await t.tick(T);
    expect(t.reqs("_studio")).toEqual([]);
    expect(t.alerts()).toEqual([]);
  });

  test("a sweep quiet nudge for an earlier quiet spell: the new spell is nudged", async () => {
    const t = setup();
    sweepRow(t, "demo.lead.quiet", "poke", { started_at: T - 3 * 3600, episode_key: `quiet|${LEAD}|${(T - 4 * 3600) * 1000}`, count: 1, state: "poked" });
    t.world.set(LEAD, { state: "working", out: T - 13 * MIN });
    await t.tick(T);
    expect(t.pokes().map(t.text)).toEqual([expect.stringContaining("are you stuck?")]);
  });

  test("a sweep poke for an earlier unread spell: this spell is poked from the start", async () => {
    const t = setup();
    sweepRow(t, "demo.lead", "poke", { started_at: T - 5 * 3600, episode_key: `silent|${LEAD}|m0`, count: -1, state: "failed" });
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T - 10 * MIN);
    await t.tick(T);
    expect(t.pokes().map(t.text)).toEqual([expect.stringContaining("unread messages")]);
    expect(t.reqs("_studio")).toEqual([]);
  });

  test("a sweep poke that failed (n = -1) for the silent episode: request at once, no poke", async () => {
    const t = setup();
    sweepRow(t, "demo.lead", "poke", { started_at: T - 60, episode_key: `silent|${LEAD}|m1`, count: -1, state: "failed" });
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T - 10 * MIN);
    await t.tick(T);
    expect(t.pokes()).toEqual([]);
    expect(t.reqs("_studio").map(t.text)).toEqual([expect.stringContaining("not responding since")]);
  });

  test("a sweep poke one minute ago for the silent episode: no poke yet", async () => {
    const t = setup();
    sweepRow(t, "demo.lead", "poke", { started_at: T - 60, episode_key: `silent|${LEAD}|m1`, count: 1, state: "poked" });
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T - 10 * MIN);
    await t.tick(T);
    expect(t.pokes()).toEqual([]);
    expect(t.reqs("_studio")).toEqual([]);
  });
});

describe("not responding: the unread clock", () => {
  test("a turn that leaves the mail unread keeps the clock: poked 10 min after first sight", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T);
    t.world.set(LEAD, { state: "working", out: T + 5 * MIN, unread: 1 });
    await t.tick(T + 5 * MIN);
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T + 8 * MIN);
    expect(t.pokes()).toEqual([]);
    await t.tick(T + 10 * MIN);
    expect(t.pokes().length).toBe(1);
  });

  test("poked twice across turns, the mail still unread: then the restart request", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T);
    for (const m of [10, 15, 20]) {
      t.world.set(LEAD, { state: "idle", unread: 1 });
      await t.tick(T + m * MIN);
      t.world.set(LEAD, { state: "working", out: T + (m + 1) * MIN, unread: 1 });
      await t.tick(T + (m + 1) * MIN);
    }
    expect(t.pokes().length).toBe(2);
    expect(t.reqs("_studio").map(t.text)).toEqual([expect.stringContaining("not responding since")]);
  });

  test("studio-hung-agent-broken U2: the same Lead with the Studio gone: its card to the operator keeps today's text, no Restart Studio", async () => {
    const t = setup();
    t.world.delete(STUDIO);
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T);
    for (const m of [10, 15, 20]) {
      t.world.set(LEAD, { state: "idle", unread: 1 });
      await t.tick(T + m * MIN);
      t.world.set(LEAD, { state: "working", out: T + (m + 1) * MIN, unread: 1 });
      await t.tick(T + (m + 1) * MIN);
    }
    const lead = t.alerts().filter((a) => a.subject === "demo.lead");
    expect(lead.map(t.text)).toEqual([expect.stringMatching(/^lead of demo \(not responding since \d\d:\d\d\) — nobody above it can restart it$/)]);
    expect(lead[0]!.payload).toMatchObject({ title: "Agent broken", option: "look at it, then restart it by hand (restart-role.sh)" });
    expect((lead[0]!.payload as Row).fields).toBeUndefined();
  });

  test("a turn that reads some of the mail starts a new episode", async () => {
    const t = setup();
    t.world.set(LEAD, { state: "idle", unread: 2 });
    await t.tick(T);
    t.world.set(LEAD, { state: "working", out: T + 5 * MIN, unread: 1 });
    await t.tick(T + 5 * MIN);
    t.world.set(LEAD, { state: "idle", unread: 1 });
    await t.tick(T + 8 * MIN);
    await t.tick(T + 12 * MIN);
    expect(t.pokes()).toEqual([]);
    await t.tick(T + 18 * MIN);
    expect(t.pokes().length).toBe(1);
  });
});

describe("U64: a standing role that settles or exits soon after a start crashed", () => {
  const iso = (t: number) => new Date(t * 1000).toISOString();
  // A restart stamps members.started (squad-state set-member-model); since stays the first spawn, long before.
  const restart = (t: ReturnType<typeof setup>, wt: string, at: number) =>
    t.s.db.run("UPDATE members SET since = ?, started = ? WHERE project = 'fx' AND wt = ?", [iso(T - 3 * 3600), iso(at), wt]);
  const member = (t: ReturnType<typeof setup>, wt: string) => t.s.db.query("SELECT agent, model FROM members WHERE project = 'fx' AND wt = ?").get(wt) as Row;
  const crashRow = (t: ReturnType<typeof setup>, key: string) => t.s.get("episodes", { project: "fx", subject: key, kind: "crash" });

  test("a Lead whose dispatch settles succeeded 2 minutes after a restart is a crash: one restart request", async () => {
    const t = setup();
    restart(t, LEAD, T);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "succeeded", dispatchAt: T + 2 * MIN });
    await t.tick(T + 2 * MIN);
    expect(t.reqs("_studio").map(t.text)).toEqual(["restart lead of demo (crashed: settled 2 min after a start on claude:sonnet)\n"]);
    expect(crashRow(t, "demo.lead")).toMatchObject({ episode_key: "claude:sonnet", count: 1, state: "settled", started_at: T });
    expect(t.alerts()).toEqual([]);
    await t.tick(T + 3 * MIN);   // the same start: handled once
    expect(t.reqs("_studio").length).toBe(1);
  });

  test("a second crash in a row on the same agent and model raises one alert and the next start may use that rung again", async () => {
    const t = setup();
    restart(t, LEAD, T);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "completed", dispatchAt: T + 2 * MIN });
    await t.tick(T + 2 * MIN);
    const T2 = T + 4 * MIN;
    restart(t, LEAD, T2);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "completed", dispatchAt: T2 + 2 * MIN, said: "Done. Sending worker_done." });
    await t.tick(T2 + 2 * MIN);
    await t.tick(T2 + 3 * MIN);
    expect(t.alerts().length).toBe(1);
    const a = t.alerts()[0].payload as Row;
    expect(String(a.text)).toBe("lead of demo (crashed: settled 2 min after a start on claude:sonnet) — the second crash in a row on claude:sonnet; the next start may use it again. Last output: Done. Sending worker_done.");
    expect(t.reqs("_studio").map(t.text)).toEqual([
      "restart lead of demo (crashed: settled 2 min after a start on claude:sonnet)\n",
      "restart lead of demo (crashed: settled 2 min after a start on claude:sonnet)\n",
    ]);
    expect(t.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'member_avoid'").get()).toEqual({ n: 0 });
    t.s.upsert("config", { project: "fx", file: "roles.conf", key: "lead" }, { value: "claude sonnet always", observed_at: T });
    t.s.upsert("accounts", { agent: "claude", account: "a1" }, { observed_at: T });
    t.s.upsert("observed_accounts", { agent: "claude", account: "a1" }, { plan: "Max", session_pct: "0", weekly_pct: "0", session_reset: T + 3600, weekly_reset: T + 86400, observed_at: T });
    expect(pick(t.s, { project: "fx", role: "lead", member: Number(t.s.db.query("SELECT id FROM members WHERE wt = ?").get(LEAD)!.id) }, T2 + 4 * MIN)).toMatchObject({ model: "sonnet" });

    // A third start on that rung that crashes again: an alert, no request (never a third restart into it).
    const T3 = T2 + 5 * MIN;
    restart(t, LEAD, T3);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "completed", dispatchAt: T3 + MIN });
    await t.tick(T3 + MIN);
    expect(t.reqs("_studio").length).toBe(2);
    expect(t.alerts().map((x) => String((x.payload as Row).text))).toContainEqual(expect.stringContaining("crash 3 in a row on claude:sonnet; not restarted again"));

    // Its agent then exits and stays gone, past the window and past rebreak: still parked — the
    // generic break path neither restarts it into that crash again nor says it "broke again".
    const alerts = t.alerts().length;
    t.world.set(LEAD, { state: "idle", agents: 0, dispatch: "completed", dispatchAt: T3 + MIN });
    for (const m of [12, 20, 45]) await t.tick(T3 + m * MIN);
    expect(t.reqs("_studio").length).toBe(2);
    expect(t.alerts().length).toBe(alerts);
  });

  test("two Thinker crashes do not bar the model: the next pick still has the rung", async () => {
    const t = setup();
    t.s.upsert("config", { project: "fx", file: "roles.conf", key: "thinker" }, { value: "claude opus spawn high claude:opus:low:Max Ultra", observed_at: T });
    for (const [account, plan] of [["ultra", "Ultra"], ["max", "Max"]]) {
      t.s.upsert("accounts", { agent: "claude", account }, { observed_at: T });
      t.s.upsert("observed_accounts", { agent: "claude", account }, { plan, session_pct: "0", weekly_pct: "0", session_reset: T + 3600, weekly_reset: T + 86400, observed_at: T });
    }
    t.s.db.run("UPDATE members SET account = 'ultra' WHERE wt = ?", [THINKER]);
    for (const at of [T, T + 4 * MIN]) {
      restart(t, THINKER, at);
      t.world.set(THINKER, { state: "idle", agents: 1, dispatch: "completed", dispatchAt: at + 2 * MIN });
      await t.tick(at + 2 * MIN);
    }
    const m = t.s.db.query("SELECT id FROM members WHERE wt = ?").get(THINKER) as Row;
    expect(pick(t.s, { project: "fx", role: "thinker", member: Number(m.id) }, T + 6 * MIN)).toMatchObject({ plan: "Ultra", effort: "high" });
  });

  test("a start that lasts past the window ends the streak", async () => {
    const t = setup();
    t.s.upsert("episodes", { project: "fx", subject: "demo.lead", kind: "crash" }, { episode_key: "claude:sonnet", count: 2, started_at: T - 30 * MIN, state: "settled", source: "loop", observed_at: T - 30 * MIN });
    restart(t, LEAD, T);
    await t.tick(T + 11 * MIN);
    expect(crashRow(t, "demo.lead")).toMatchObject({ count: 0 });
    expect(t.acted).toEqual([]);
  });

  test("an agent that exits within the window is a crash with cause exited (after the spawn grace), and no request: the decider starts it", async () => {
    const t = setup();
    restart(t, THINKER, T);
    t.world.set(THINKER, { state: "idle", agents: 0 });
    await t.tick(T + 2 * MIN);
    expect(crashRow(t, "demo.thinker")).toBeNull();   // still in the spawn grace
    await t.tick(T + 6 * MIN);
    expect(crashRow(t, "demo.thinker")).toMatchObject({ state: "exited", count: 1, episode_key: "claude:opus" });
    expect(t.reqs("_studio")).toEqual([]);
  });
  test("a settle after the window is handled as before: nothing", async () => {
    const t = setup();
    restart(t, LEAD, T);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "succeeded", dispatchAt: T + 11 * MIN });
    await t.tick(T + 11 * MIN);
    expect(t.acted).toEqual([]);
    expect(crashRow(t, "demo.lead")).toBeNull();
  });

  test("crash_window_min is a knob: DS_SWEEP_CRASH_WINDOW_MIN=1 makes a settle at 2 minutes a clean finish", async () => {
    process.env.DS_SWEEP_CRASH_WINDOW_MIN = "1";
    const t = setup();
    restart(t, LEAD, T);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "succeeded", dispatchAt: T + 2 * MIN });
    await t.tick(T + 2 * MIN);
    expect(t.acted).toEqual([]);
  });

  test("a settle from before the start (the previous dispatch) is no crash", async () => {
    const t = setup();
    restart(t, LEAD, T);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "completed", dispatchAt: T - MIN });
    await t.tick(T + 2 * MIN);
    expect(t.acted).toEqual([]);
  });

  test("the loop's own restart stop is no crash: a restart wish after the start stands the rule down until the new start", async () => {
    const t = setup();
    restart(t, LEAD, T);
    t.s.db.run("UPDATE members SET restart_at = ? WHERE project = 'fx' AND wt = ?", [T + 5 * MIN, LEAD]);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "canceled", dispatchAt: T + 5 * MIN });
    await t.tick(T + 5 * MIN);
    expect(t.reqs("_studio")).toEqual([]);
    expect(crashRow(t, "demo.lead")).toBeNull();
    // set-member-model stamps the new start: the old stop is before it, so still no crash.
    restart(t, LEAD, T + 6 * MIN);
    await t.tick(T + 7 * MIN);
    expect(t.reqs("_studio")).toEqual([]);
  });

  test("a satisfied restart wish does not silence a later crash: past the crash window the rule counts again", async () => {
    const t = setup();
    restart(t, LEAD, T);
    // A restart wish written long before this start (already satisfied by it): no stand-down.
    t.s.db.run("UPDATE members SET restart_at = ? WHERE project = 'fx' AND wt = ?", [T - 3600, LEAD]);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "succeeded", dispatchAt: T + 2 * MIN });
    await t.tick(T + 2 * MIN);
    expect(crashRow(t, "demo.lead")).toMatchObject({ count: 1, state: "settled" });
  });

  test("a settle whose time is unknown (first seen already settled) is no crash", async () => {
    const t = setup();
    restart(t, LEAD, T);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "completed" });
    await t.tick(T + 2 * MIN);
    expect(t.acted).toEqual([]);
  });

  test("U89: a settle the loop did after its own rebind is no crash: the bind took", async () => {
    const t = setup();
    restart(t, LEAD, T);
    t.world.set(LEAD, { state: "idle", agents: 1, dispatch: "failed", dispatchAt: T + 2 * MIN });
    const dispatch = `ctx_${T + 2 * MIN}`;
    t.s.event("member_rebound", { project: "fx", squad: "demo", member: LEAD, payload: { run: "run_x", wt: LEAD, handle: "term_l", was: null, task: "task_1", from: "task_old", dispatch, fenced: null, at: T } });
    t.s.event("member_rebound_settled", { project: "fx", squad: "demo", member: LEAD, payload: { run: "run_x", wt: LEAD, handle: "term_l", task: "task_1", dispatch, at: T + 2 * MIN } });
    await t.tick(T + 2 * MIN);
    expect(t.acted).toEqual([]);
    expect(crashRow(t, "demo.lead")).toBeNull();
  });

  test("a Builder whose dispatch settles succeeded is not a crash", async () => {
    const t = setup();
    t.sinceAll(T);
    t.world.set(B2, { state: "idle", agents: 1, dispatch: "succeeded", dispatchAt: T + 2 * MIN });
    await t.tick(T + 2 * MIN);
    expect(t.acted).toEqual([]);
  });
});

describe("U100: a standing role's dispatch word is the loop's own verdict", () => {
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const restart = (t: ReturnType<typeof setup>, wt: string, at: number) =>
    t.s.db.run("UPDATE members SET since = ?, started = ? WHERE project = 'fx' AND wt = ?", [iso(T - 3 * 3600), iso(at), wt]);
  const crashRow = (t: ReturnType<typeof setup>, key: string) => t.s.get("episodes", { project: "fx", subject: key, kind: "crash" });
  const verdict = (t: ReturnType<typeof setup>, wt: string, at: number) => dispatchVerdict(t.s, "fx", "demo", wt, at);
  const fresh = (dispatch: string, dispatchAt: number) => ({ state: "idle", agents: 1, dispatch, dispatchAt } as Seen);

  test("open for a fresh open dispatch, settled for a fresh settled one", async () => {
    const t = setup();
    t.sinceAll(T);
    t.world.set(LEAD, fresh("dispatched", T));
    t.world.set(THINKER, fresh("succeeded", T));
    await t.tick(T);
    expect([verdict(t, LEAD, T), verdict(t, THINKER, T)]).toEqual(["open", "settled"]);
  });

  test("rebound for a fresh dispatch the loop settled itself after a rebind", async () => {
    const t = setup();
    restart(t, LEAD, T);
    t.world.set(LEAD, fresh("failed", T + 2 * MIN));
    const dispatch = `ctx_${T + 2 * MIN}`;
    t.s.event("member_rebound_settled", { project: "fx", squad: "demo", member: LEAD, payload: { dispatch, at: T + 2 * MIN } });
    await t.tick(T + 2 * MIN);
    expect(verdict(t, LEAD, T + 2 * MIN)).toBe("rebound");
    expect(t.acted).toEqual([]);
  });

  test("unknown with no row, no dispatch, or a read older than twice the knob", async () => {
    const t = setup();
    t.sinceAll(T);
    t.world.set(LEAD, fresh("succeeded", T));
    await t.tick(T);
    expect(verdict(t, LEAD, T)).toBe("settled");
    expect(verdict(t, LEAD, T + 10 * MIN + 1)).toBe("unknown"); // stale: past 2 x DISPATCH_READ_MIN (5)
    expect(verdict(t, `${W}no-such-wt`, T)).toBe("unknown");    // no row
    t.world.set(THINKER, { state: "idle", agents: 1 });
    await t.tick(T);
    expect(verdict(t, THINKER, T)).toBe("unknown");             // no dispatch on the row
  });

  test("a stale settled dispatch is no crash: the display keeps the agent state, not a restart", async () => {
    const t = setup();
    restart(t, LEAD, T);
    // Settled two minutes after the start, but the loop last read dispatches an hour ago.
    t.world.set(LEAD, { ...fresh("succeeded", T + 2 * MIN), dispatchSeenAt: T - 60 * MIN });
    await t.tick(T + 3 * MIN);
    expect(t.acted).toEqual([]);
    expect(crashRow(t, "demo.lead")).toBeNull();
  });
});

describe("U69: an idle Builder with an open unit", () => {
  const IDLE = { state: "idle", agents: 1, out: T, said: "waiting for a go-ahead" } as Seen;
  // The unit open with no PR, and its Builder a squad member (wake() pokes members only).
  const stale = (t: ReturnType<typeof setup>) => {
    t.s.db.run("UPDATE units SET pr = NULL, hold = NULL, doc = NULL WHERE builder_wt = ?", [B2]);
    t.s.db.run("INSERT INTO members (project, squad, wt, role, suffix, agent, status, since, observed_at, updated_at) VALUES ('fx', 'demo', ?, 'builder', 'u2', 'claude', 'running', ?, ?, ?)", [B2, new Date((T - 7200) * 1000).toISOString(), T, T]);
  };
  const nudges = (t: ReturnType<typeof setup>) => t.pokes().filter((a) => a.subject === B2);

  test("idle 25 min: one nudge; 20 min later a second; 20 min after that one Lead request; later ticks file nothing new", async () => {
    const t = setup(); stale(t); t.world.set(B2, IDLE); t.sinceAll(T - 3600);
    await t.tick(T + 10 * MIN);
    expect(nudges(t)).toEqual([]);
    await t.tick(T + 25 * MIN);
    expect(nudges(t).length).toBe(1);
    expect(t.reqs("demo")).toEqual([]);
    await t.tick(T + 26 * MIN);
    await t.tick(T + 46 * MIN);
    expect(nudges(t).length).toBe(2);
    expect(t.reqs("demo")).toEqual([]);
    await t.tick(T + 66 * MIN);
    expect(t.reqs("demo").map(t.text)).toEqual([expect.stringMatching(/^idle: builder-u2.* of demo has sat idle on unit u2-.* for 66 min with no PR, nudged 2 times with no new commit\. Last output: waiting for a go-ahead\./)]);
    await t.tick(T + 67 * MIN);
    await t.tick(T + 120 * MIN);
    expect(nudges(t).length).toBe(2);
    expect(t.reqs("demo").length).toBe(1);
  });

  test("a recorded waiting_on gets nothing", async () => {
    const t = setup(); stale(t); t.world.set(B2, IDLE); t.sinceAll(T - 3600);
    t.s.db.run("UPDATE units SET doc = ? WHERE builder_wt = ?", [JSON.stringify({ waiting_on: "squad x/u1" }), B2]);
    await t.tick(T + 25 * MIN); await t.tick(T + 60 * MIN);
    expect(nudges(t)).toEqual([]); expect(t.reqs("demo")).toEqual([]);
  });

  test("U3: a Builder out of credits (its 402 row and a day's hold) gets no nudge, and its Lead no poke or report", async () => {
    const t = setup(); stale(t); t.sinceAll(T - 3600);
    t.world.set(B2, { ...IDLE, limited: "-\t◆ model failed: API error 402\t-\tcredits" });
    t.s.db.run("UPDATE members SET agent = 'muse', account = 'default', limited_until = ? WHERE wt = ?", [T + 86400, B2]);
    t.s.upsert("episodes", { project: "fx", subject: B2, kind: "limited" },
      { episode_key: "muse/default|◆ model failed: API error 402", state: "credits", started_at: T, ended_at: T + 86400, source: "loop", observed_at: T });
    for (const at of [T + 25 * MIN, T + 46 * MIN, T + 66 * MIN, T + 120 * MIN]) await t.tick(at);
    expect(t.pokes()).toEqual([]);
    expect(t.reqs("demo")).toEqual([]);
  });

  const RUN = "run_fixture01", DISPATCH = "ctx_builder_current";
  const current = () => {
    const t = setup(); stale(t); t.sinceAll(T - 3600);
    t.world.set(B2, { ...IDLE, dispatch: "dispatched", dispatchId: DISPATCH, terminals: ["term_b2"] });
    return t;
  };
  const question = (t: ReturnType<typeof setup>, id = "canonical", facts: Row = {}) => t.s.upsert("relayed", { msg_id: id }, {
    project: "fx", squad: "demo", run_id: RUN, from_handle: `dispatch:${DISPATCH}`, type: "question",
    payload: { taskId: "task_builder", dispatchId: DISPATCH, question: "Which approach?" }, seen_at: T - 3600, ...facts,
  });
  const reply = (t: ReturnType<typeof setup>, id = "canonical", facts: Row = {}) => t.s.request("reply", {
    id, run: RUN, answer: "Proceed", ...(facts.payload as Row ?? {}),
  }, { project: String(facts.project ?? "fx"), squad: String(facts.squad ?? "demo") }).row;
  const complete = (t: ReturnType<typeof setup>, r: Row, result: Row = { ok: true }) => t.s.db.run(
    "UPDATE requests SET done_at = ?, result = ? WHERE id = ?", [T + 30 * MIN, JSON.stringify(result), Number(r.id)],
  );
  const idleEpisode = (t: ReturnType<typeof setup>) => t.s.get("episodes", { project: "fx", subject: "demo.builder-u2.idle", kind: "idle" });
  const waiting = (t: ReturnType<typeof setup>) => {
    expect(nudges(t)).toEqual([]); expect(t.reqs("demo")).toEqual([]);
    expect(idleEpisode(t)?.state).toBe("waiting");
  };

  // Reuse the state/actions fixture, with the production observer's dispatch-read cadence.
  const observed = () => {
    const t = current(), o = FakeOrca.recorded(join(FIXTURE, "..", "orca"));
    o.mail = [];
    o.worktrees = o.worktrees.map((w) => ({ ...w, lastOutputAt: T * 1000,
      agents: [{ state: "idle", stateStartedAt: (T - 3600) * 1000 }] }));
    o.worktrees.push({ worktreeId: B2, lastOutputAt: T * 1000,
      agents: [{ state: "idle", stateStartedAt: (T - 3600) * 1000 }] });
    o.dirs.get("fx")!.push({ squad: "demo", role: "builder", suffix: "u2", wt: B2, run_id: RUN, terminals: ["term_b2"] });
    const dispatch = (id: string | null) => o.runs.set(RUN, [
      { wt: LEAD, id: "ctx_lead", status: "dispatched" }, { wt: THINKER, id: "ctx_thinker", status: "dispatched" },
      ...(id ? [{ wt: B2, id, status: "dispatched" }] : []),
    ]);
    dispatch(DISPATCH);
    const loop = new Loop(t.s, { observers: [orcaObserver(o)], reconcilers: [liveness] }, t.act, { projects: () => ["fx"] });
    const tick = async (at: number) => { process.env.DS_NOW = String(at); return (await loop.tick(at)).acted; };
    const held = () => t.s.db.run("UPDATE units SET hold = 1 WHERE builder_wt = ?", [B2]);
    return { ...t, o, tick, dispatch, held };
  };
  const failDispatchReads = (t: ReturnType<typeof observed>) => {
    const read = t.o.dispatches.bind(t.o);
    t.o.dispatches = async (run) => { t.o.calls.dispatches.push(run); throw new Error("dispatch read unavailable"); };
    return () => { t.o.dispatches = read; };
  };
  const ownActions = (t: ReturnType<typeof observed>) => t.acted.filter((a) => a.subject === B2 || a.subject === "demo.builder-u2.idle");

  test("production observer: a new held-unit question stays quiet before the next periodic dispatch read", async () => {
    const t = observed(); await t.tick(T);
    expect(t.o.calls.dispatches).toHaveLength(1);
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })).toMatchObject({ dispatch_id: DISPATCH, dispatch_seen_at: T });
    t.dispatch("ctx_replacement"); t.held();
    question(t, "new-terminal", { from_handle: "term_b2", seen_at: T + 30, payload: { dispatchId: "ctx_replacement" } });
    await t.tick(T + MIN);
    expect(t.s.get("observed_terminals", { project: "fx", handle: "term_b2" })).toMatchObject({ observed_at: T + MIN, gone_at: null });
    expect(t.acted).toEqual([]);
    await t.tick(T + 5 * MIN); waiting(t);
  });

  test("production observer: a verified replacement releases only its old question on a held unit", async () => {
    const t = observed(); t.held(); question(t, "old-terminal", { from_handle: "term_b2" });
    await t.tick(T); waiting(t);
    t.dispatch("ctx_replacement"); await t.tick(T + 5 * MIN);
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })).toMatchObject({ dispatch_id: "ctx_replacement", dispatch_seen_at: T + 5 * MIN });
    expect(nudges(t)).toEqual([]); expect(t.reqs("demo")).toHaveLength(1);
    expect(t.text(t.reqs("demo")[0])).toContain("idle:");
  });

  test("production observer: a newly seen dispatch sender is associated by the current listing, not its payload", async () => {
    const t = observed(); await t.tick(T); t.held(); t.dispatch("ctx_replacement");
    question(t, "new-dispatch", { from_handle: "dispatch:ctx_replacement", seen_at: T + 30, payload: { dispatchId: "ctx_untrusted_payload" } });
    await t.tick(T + MIN); waiting(t);
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })).toMatchObject({ dispatch_id: "ctx_replacement", dispatch_seen_at: T + MIN });
  });

  test("production observer: a failed dispatch read defers a new question decision until a successful read", async () => {
    const t = observed(); await t.tick(T);
    t.dispatch("ctx_replacement"); t.held();
    question(t, "new-terminal", { from_handle: "term_b2", seen_at: T + 30, payload: { dispatchId: "ctx_replacement" } });
    const read = t.o.dispatches.bind(t.o);
    t.o.dispatches = async (run) => { t.o.calls.dispatches.push(run); throw new Error("dispatch read unavailable"); };
    await t.tick(T + 5 * MIN);
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })?.dispatch_seen_at).toBe(T);
    t.o.dispatches = read; await t.tick(T + 5 * MIN + 1);
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })).toMatchObject({ dispatch_id: "ctx_replacement", dispatch_seen_at: T + 5 * MIN + 1 });
    expect(t.acted).toEqual([]); waiting(t);
  });

  test("production observer: checked-absent dispatch evidence does not retain an old question wait", async () => {
    const t = observed(); t.held(); question(t, "old-terminal", { from_handle: "term_b2" });
    await t.tick(T); waiting(t);
    t.dispatch(null); await t.tick(T + 5 * MIN);
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })).toMatchObject({ dispatch_id: null, dispatch_seen_at: T + 5 * MIN });
    expect(t.reqs("demo")).toHaveLength(1);
  });

  test("production observer: a Builder-only Run can verify replacement instead of retaining its old question forever", async () => {
    const t = observed(); t.held(); question(t, "old-terminal", { from_handle: "term_b2" });
    await t.tick(T); waiting(t);
    t.s.db.run("UPDATE members SET status = 'gone' WHERE project = 'fx' AND role != 'builder'");
    t.dispatch("ctx_replacement"); await t.tick(T + 5 * MIN);
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })).toMatchObject({ dispatch_id: "ctx_replacement", dispatch_seen_at: T + 5 * MIN });
    expect(t.acted.filter((a) => a.kind === "request.file" && String((a.payload as Row).text).startsWith("idle:"))).toHaveLength(1);
  });

  test("production observer: 100 unavailable bindings defer only the uncertain Builder, then confirm its current question", async () => {
    const t = observed(), other = `${W}ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`;
    t.s.db.run("UPDATE units SET status = 'dispatched', pr = NULL, hold = NULL, doc = NULL WHERE builder_wt = ?", [other]);
    await t.tick(T); t.held(); t.dispatch("ctx_replacement");
    question(t, "uncertain", { from_handle: "term_b2", seen_at: T + 30, payload: { dispatchId: "ctx_replacement" } });
    const read = t.o.dispatches.bind(t.o);
    t.o.dispatches = async (run) => { t.o.calls.dispatches.push(run); throw new Error("dispatch read unavailable"); };
    const own = () => t.acted.filter((a) => a.subject === B2 || a.subject === "demo.builder-u2.idle");
    for (let i = 0; i < 100; i++) {
      await t.tick(T + (25 + 25 * i) * MIN);
      expect(own()).toEqual([]); expect(idleEpisode(t)).toBeNull();
      expect(t.s.get("observed_workers", { project: "fx", wt: B2 })?.dispatch_seen_at).toBe(T);
    }
    expect(t.acted.filter((a) => a.kind === "poke" && a.subject === other)).toHaveLength(2);
    expect(t.acted.filter((a) => a.kind === "request.file" && a.member === "builder-u1-spike-loop-as-coordinator")).toHaveLength(1);
    expect(t.o.calls.dispatches).toHaveLength(101);
    t.o.dispatches = read; await t.tick(T + 2501 * MIN);
    expect(own()).toEqual([]); expect(idleEpisode(t)?.state).toBe("waiting");
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })?.dispatch_id).toBe("ctx_replacement");
  });

  test("production observer: 100 failed first binding reads keep a current question from filing idle recovery", async () => {
    const t = observed(); t.held();
    question(t, "first-current", { from_handle: "term_b2", payload: { dispatchId: DISPATCH } });
    const read = t.o.dispatches.bind(t.o);
    t.o.dispatches = async (run) => { t.o.calls.dispatches.push(run); throw new Error("dispatch read unavailable"); };
    const own = () => t.acted.filter((a) => a.subject === B2 || a.subject === "demo.builder-u2.idle");
    for (let i = 0; i < 100; i++) {
      await t.tick(T + (25 + 25 * i) * MIN);
      expect(own()).toEqual([]); expect(idleEpisode(t)).toBeNull();
      expect(t.s.get("observed_workers", { project: "fx", wt: B2 })).toMatchObject({ dispatch_id: null, dispatch_seen_at: null });
    }
    t.o.dispatches = read; await t.tick(T + 2501 * MIN);
    expect(own()).toEqual([]); expect(idleEpisode(t)?.state).toBe("waiting");
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })?.dispatch_id).toBe(DISPATCH);
  });

  test("production observer: 100 failed first binding reads defer old-only recovery until a different binding is verified", async () => {
    const t = observed(); t.held();
    question(t, "first-old", { from_handle: "term_b2", payload: { dispatchId: "ctx_old" } });
    const read = t.o.dispatches.bind(t.o);
    t.o.dispatches = async (run) => { t.o.calls.dispatches.push(run); throw new Error("dispatch read unavailable"); };
    const own = () => t.acted.filter((a) => a.subject === B2 || a.subject === "demo.builder-u2.idle");
    for (let i = 0; i < 100; i++) {
      await t.tick(T + (25 + 25 * i) * MIN);
      expect(own()).toEqual([]); expect(idleEpisode(t)).toBeNull();
    }
    t.o.dispatches = read; await t.tick(T + 2501 * MIN);
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })?.dispatch_id).toBe(DISPATCH);
    expect(own().filter((a) => a.kind === "request.file")).toHaveLength(1);
    expect(idleEpisode(t)?.state).toBe("reported");
  });

  test("production observer: 100 failed first binding reads keep a dispatch question pending until its binding is confirmed", async () => {
    const t = observed(); t.held();
    question(t, "first-dispatch", { from_handle: `dispatch:${DISPATCH}`, payload: { dispatchId: DISPATCH } });
    const restore = failDispatchReads(t);
    for (let i = 0; i < 100; i++) {
      await t.tick(T + (25 + 25 * i) * MIN);
      expect(ownActions(t)).toEqual([]); expect(idleEpisode(t)).toBeNull();
      expect(t.s.get("observed_workers", { project: "fx", wt: B2 })?.dispatch_seen_at).toBeNull();
    }
    restore(); await t.tick(T + 2501 * MIN);
    expect(ownActions(t)).toEqual([]); expect(idleEpisode(t)?.state).toBe("waiting");
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })?.dispatch_id).toBe(DISPATCH);
  });

  test("production observer: a retired dispatch question permits one report after the first successful binding read", async () => {
    const t = observed(); t.held();
    question(t, "retired-dispatch", { from_handle: "dispatch:ctx_retired", payload: { dispatchId: "ctx_retired" } });
    const restore = failDispatchReads(t);
    for (let i = 0; i < 100; i++) {
      await t.tick(T + (25 + 25 * i) * MIN);
      expect(ownActions(t)).toEqual([]); expect(idleEpisode(t)).toBeNull();
    }
    restore(); await t.tick(T + 2501 * MIN);
    expect(ownActions(t).filter((a) => a.kind === "request.file")).toHaveLength(1);
    expect(idleEpisode(t)?.state).toBe("reported");
  });

  test("production observer: another live Builder's dispatch question does not block first-binding recovery", async () => {
    const t = observed(), other = `${W}ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`;
    t.o.runs.get(RUN)!.push({ wt: other, id: "ctx_other_builder", status: "dispatched" });
    await t.tick(T);
    t.s.db.run("UPDATE observed_workers SET dispatch_id = NULL, dispatch = NULL, dispatch_seen_at = NULL WHERE project = 'fx' AND wt = ?", [B2]);
    t.held();
    question(t, "theirs", { from_handle: "dispatch:ctx_other_builder", seen_at: T + 30, payload: { dispatchId: "ctx_other_builder" } });
    failDispatchReads(t); await t.tick(T + 25 * MIN);
    expect(t.s.get("observed_workers", { project: "fx", wt: other })?.dispatch_id).toBe("ctx_other_builder");
    expect(ownActions(t).filter((a) => a.kind === "request.file")).toHaveLength(1);
    expect(idleEpisode(t)?.state).toBe("reported");
  });

  test("production observer: 100 failed reads preserve the episode, then verified replacement releases an old-only question", async () => {
    const t = observed(); t.held(); question(t, "old-terminal", { from_handle: "term_b2" });
    await t.tick(T); waiting(t); const episode = idleEpisode(t);
    t.dispatch("ctx_replacement"); const read = t.o.dispatches.bind(t.o);
    t.o.dispatches = async (run) => { t.o.calls.dispatches.push(run); throw new Error("dispatch read unavailable"); };
    for (let i = 0; i < 100; i++) {
      await t.tick(T + (25 + 25 * i) * MIN);
      expect(t.acted).toEqual([]); expect(idleEpisode(t)).toEqual(episode);
      expect(t.s.get("observed_workers", { project: "fx", wt: B2 })?.dispatch_seen_at).toBe(T);
    }
    t.o.dispatches = read; await t.tick(T + 2501 * MIN);
    expect(t.reqs("demo")).toHaveLength(1); expect(idleEpisode(t)?.state).toBe("reported");
  });

  test("production observer: two eligible Builders share one current Run read per tick", async () => {
    const t = observed(), other = `${W}ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`;
    t.s.db.run("UPDATE units SET status = 'dispatched', pr = NULL, hold = 1, doc = NULL WHERE builder_wt = ?", [other]);
    t.o.runs.get(RUN)!.push({ wt: other, id: "ctx_other_builder", status: "dispatched" });
    t.held(); question(t, "own", { from_handle: "term_b2" });
    question(t, "other", { from_handle: "term_b1", payload: { dispatchId: "ctx_other_builder" } });
    await t.tick(T); await t.tick(T + MIN);
    expect(t.acted).toEqual([]); expect(t.o.calls.dispatches).toEqual([RUN, RUN]);
    for (const wt of [B2, other]) expect(t.s.get("observed_workers", { project: "fx", wt })?.dispatch_seen_at).toBe(T + MIN);
  });

  test("production observer: an unassociated unknown dispatch question cannot defer unrelated recovery", async () => {
    const t = observed(); await t.tick(T); t.held();
    question(t, "unknown", { from_handle: "dispatch:ctx_unknown", seen_at: T + 30, payload: { taskId: "task_unknown", dispatchId: "ctx_unknown" } });
    t.o.dispatches = async (run) => { t.o.calls.dispatches.push(run); throw new Error("dispatch read unavailable"); };
    await t.tick(T + MIN);
    expect(t.reqs("demo")).toHaveLength(1); expect(idleEpisode(t)?.state).toBe("reported");
  });

  test("production observer: checked absence retains a supported terminal-only question", async () => {
    const t = observed(); t.dispatch(null); t.held();
    question(t, "terminal-only", { from_handle: "term_b2", payload: null });
    await t.tick(T); await t.tick(T + MIN); waiting(t);
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })).toMatchObject({ dispatch_id: null, dispatch_seen_at: T + MIN });
  });

  test("production observer: independent U69 guards do not request an extra question read", async () => {
    for (const guard of ["pr", "wait", "off", "pause", "limited"]) {
      const t = observed(); await t.tick(T);
      t.o.worktrees.find((w) => w.worktreeId === B2)!.lastOutputAt = (T - 25 * MIN) * 1000;
      question(t, "candidate", { from_handle: "term_b2", seen_at: T + 30 });
      if (guard === "pr") t.s.db.run("UPDATE units SET pr = '99' WHERE builder_wt = ?", [B2]);
      if (guard === "wait") t.s.db.run("UPDATE units SET doc = '{\"waiting_on\":\"operator\"}' WHERE builder_wt = ?", [B2]);
      if (guard === "off") t.s.upsert("config", { project: "fx", file: "limits.conf", key: "stale_min" }, { value: "0", observed_at: T });
      if (guard === "pause") t.s.pause({ scope: "member", project: "fx", squad: "demo", role: "builder", suffix: "u2" });
      if (guard === "limited") t.s.db.run("UPDATE members SET limited_until = ? WHERE wt = ?", [T + 3600, B2]);
      await t.tick(T + MIN);
      // Pausing already requests a binding read each tick, independently of U69.
      expect(t.o.calls.dispatches).toHaveLength(guard === "pause" ? 2 : 1);
      expect(t.acted.filter((a) => a.subject === B2 || a.subject === "demo.builder-u2.idle")).toEqual([]);
    }
  });

  test("a current native dispatch question suppresses the stale nudge and idle report", async () => {
    const t = current(); question(t);
    await t.tick(T + 25 * MIN); await t.tick(T + 60 * MIN);
    expect(t.s.get("observed_workers", { project: "fx", wt: B2 })?.dispatch_id).toBe(DISPATCH);
    expect(t.s.get("relayed", { msg_id: "canonical" })).toMatchObject({ type: "question", from_handle: `dispatch:${DISPATCH}`, run_id: RUN });
    waiting(t);
  });

  test("100 full ticks: an old unanswered question survives later output, forwarding, taking and acknowledgment", async () => {
    const t = current(); question(t, "canonical", { forwarded_at: T + MIN, taken_at: T + 2 * MIN });
    t.s.event("run_mail_relayed", { project: "fx", squad: "demo", payload: { id: "canonical", run: RUN, type: "question", from: `dispatch:${DISPATCH}` } });
    for (let i = 0; i < 100; i++) {
      const at = T + (25 + 25 * i) * MIN;
      if (i % 10 === 0) t.world.set(B2, { ...t.world.get(B2), state: i % 20 === 0 ? "idle" : "done", out: at - 25 * MIN });
      await t.tick(at); waiting(t);
    }
    expect(t.s.get("relayed", { msg_id: "canonical" })).toMatchObject({ forwarded_at: T + MIN, taken_at: T + 2 * MIN });
    expect(t.acted).toEqual([]);
  });

  test("an auxiliary reply mentioning the blocker does not release it; exact success restores the nudges then one report", async () => {
    const t = current(); question(t); question(t, "auxiliary");
    complete(t, reply(t, "auxiliary", { payload: { answer: "canonical is still waiting" } }));
    await t.tick(T + 35 * MIN); waiting(t);
    const r = reply(t); complete(t, r);
    expect(t.s.get("requests", { id: r.id })).toMatchObject({ done_at: T + 30 * MIN, result: '{"ok":true}' });
    await t.tick(T + 36 * MIN);
    expect(nudges(t)).toHaveLength(1); expect(idleEpisode(t)?.state).toBe("nudged");
    await t.tick(T + 57 * MIN); expect(nudges(t)).toHaveLength(2);
    await t.tick(T + 100 * MIN);
    expect(nudges(t)).toHaveLength(2); expect(t.reqs("demo")).toHaveLength(1);
    expect(idleEpisode(t)?.state).toBe("reported");
  });

  test("answering one current question leaves another current question waiting", async () => {
    const t = current(); question(t); question(t, "second"); complete(t, reply(t));
    await t.tick(T + 35 * MIN); await t.tick(T + 60 * MIN); waiting(t);
    complete(t, reply(t, "second"));
    await t.tick(T + 61 * MIN); expect(nudges(t)).toHaveLength(1);
  });

  test("queued, retrying, failed and terminal-refused replies cannot release a question", async () => {
    for (const state of ["queued", "retry", "failed", "question_not_found"]) {
      const t = current(); question(t); const r = reply(t);
      if (state === "retry") t.s.upsert("episodes", { project: "fx", subject: `req:${r.id}`, kind: "action:reply" }, {
        state: "pending", episode_key: `req:${r.id}`, source: "loop", observed_at: T, next_at: T + MIN,
      });
      if (state === "failed" || state === "question_not_found") complete(t, r, { ok: false, error: state });
      await t.tick(T + 35 * MIN); await t.tick(T + 60 * MIN); waiting(t);
    }
  });

  test("only an exact successful reply in the question's project, squad and Run resolves it", async () => {
    for (const facts of [
      { project: "other" }, { squad: "other" }, { payload: { run: "run_other" } }, { payload: { id: "canonical-extra" } },
    ]) {
      const t = current(); question(t); complete(t, reply(t, "canonical", facts));
      await t.tick(T + 35 * MIN); await t.tick(T + 60 * MIN); waiting(t);
    }
    const t = current(); question(t); const r = reply(t);
    t.s.db.run("UPDATE requests SET result = '{\"ok\":true}' WHERE id = ?", [Number(r.id)]);
    await t.tick(T + 35 * MIN); waiting(t);
    for (const result of [{ ok: 1 }, { ok: "true" }, {}]) {
      complete(t, r, result);
      await t.tick(T + 60 * MIN); waiting(t);
    }
  });

  test("a replacement dispatch ignores the old question and retained terminal; its new question suppresses recovery", async () => {
    const t = current(); question(t);
    await t.tick(T + 25 * MIN); waiting(t);
    t.world.set(B2, { ...IDLE, dispatch: "dispatched", dispatchId: "ctx_replacement", terminals: ["term_replacement"] });
    await t.tick(T + 26 * MIN);
    expect(t.s.get("observed_terminals", { project: "fx", handle: "term_b2" })?.gone_at).toBe(T + 26 * MIN);
    expect(nudges(t)).toHaveLength(1);
    question(t, "new", { from_handle: "dispatch:ctx_replacement", payload: { dispatchId: "ctx_replacement" } });
    await t.tick(T + 60 * MIN);
    expect(nudges(t)).toHaveLength(1); expect(t.reqs("demo")).toEqual([]); expect(idleEpisode(t)?.state).toBe("waiting");
  });

  test("a current terminal sender waits; a retired or older terminal cannot block its replacement", async () => {
    const t = current(); question(t, "terminal", { from_handle: "term_b2" });
    await t.tick(T + 25 * MIN); waiting(t);
    t.world.set(B2, { ...t.world.get(B2), terminals: ["term_new", "term_b2"] });
    await t.tick(T + 26 * MIN); expect(nudges(t)).toHaveLength(1);
    question(t, "new-terminal", { from_handle: "term_new" });
    await t.tick(T + 60 * MIN); expect(t.reqs("demo")).toEqual([]); expect(idleEpisode(t)?.state).toBe("waiting");
    t.world.set(B2, { ...t.world.get(B2), terminals: [] });
    await t.tick(T + 61 * MIN); expect(nudges(t)).toHaveLength(2);
  });

  test("other members, projects, squads, Runs and message types do not create this Builder's wait", async () => {
    for (const facts of [
      { from_handle: "dispatch:ctx_other" }, { from_handle: "term_thinker" }, { project: "other" },
      { squad: "other" }, { run_id: "run_other" }, { type: "ask" }, { type: "message" },
    ]) {
      const t = current(); t.world.set(THINKER, { terminals: ["term_thinker"] }); question(t, "foreign", facts);
      await t.tick(T + 25 * MIN); await t.tick(T + 46 * MIN); await t.tick(T + 67 * MIN);
      expect(nudges(t)).toHaveLength(2); expect(t.reqs("demo")).toHaveLength(1);
    }
  });

  test("a surviving terminal cannot carry its previous dispatch's question into a replacement", async () => {
    const t = current(); question(t, "old-terminal", { from_handle: "term_b2" });
    await t.tick(T + 25 * MIN); waiting(t);
    t.world.set(B2, { ...t.world.get(B2), dispatchId: "ctx_replacement" });
    await t.tick(T + 26 * MIN);
    expect(t.s.get("observed_terminals", { project: "fx", handle: "term_b2" })).toMatchObject({ gone_at: null, observed_at: T + 26 * MIN });
    expect(nudges(t)).toHaveLength(1);
    await t.tick(T + 47 * MIN); expect(nudges(t)).toHaveLength(2);
    await t.tick(T + 68 * MIN); expect(t.reqs("demo")).toHaveLength(1);
    question(t, "new-terminal", { from_handle: "term_b2", payload: { dispatchId: "ctx_replacement" } });
    await t.tick(T + 69 * MIN); await t.tick(T + 120 * MIN);
    expect(nudges(t)).toHaveLength(2); expect(t.reqs("demo")).toHaveLength(1);
    expect(idleEpisode(t)?.state).toBe("waiting");
  });

  test("a terminal-only question without a dispatch cannot follow its terminal into a new dispatch", async () => {
    const t = current(); t.world.set(B2, { ...IDLE, terminals: ["term_b2"] });
    question(t, "terminal-only", { from_handle: "term_b2", payload: null });
    await t.tick(T + 25 * MIN); waiting(t);
    t.world.set(B2, { ...t.world.get(B2), dispatch: "dispatched", dispatchId: DISPATCH });
    await t.tick(T + 26 * MIN); expect(nudges(t)).toHaveLength(1);
    question(t, "current-terminal", { from_handle: "term_b2" });
    await t.tick(T + 60 * MIN);
    expect(nudges(t)).toHaveLength(1); expect(t.reqs("demo")).toEqual([]);
    expect(idleEpisode(t)?.state).toBe("waiting");
  });

  test("a successful question reply preserves a separate recorded wait", async () => {
    const t = current(); question(t); complete(t, reply(t));
    t.s.db.run("UPDATE units SET doc = ? WHERE builder_wt = ?", [JSON.stringify({ waiting_on: "operator decision" }), B2]);
    await t.tick(T + 35 * MIN); await t.tick(T + 60 * MIN); waiting(t);
  });

  test("retired or superseded member rows cannot keep the current unit waiting on their questions", async () => {
    for (const retired of ["status", "replaced"]) {
      const t = current(); question(t);
      if (retired === "replaced") t.s.db.run(`INSERT INTO members (project, squad, wt, role, suffix, agent, status, since, observed_at, updated_at)
        SELECT project, squad, ?, role, suffix, agent, status, since, observed_at, updated_at FROM members WHERE wt = ?`, [`${B2}-replacement`, B2]);
      else t.s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [B2]);
      await t.tick(T + 25 * MIN); await t.tick(T + 46 * MIN); await t.tick(T + 67 * MIN);
      expect(t.reqs("demo")).toHaveLength(1);
      expect(t.text(t.reqs("demo")[0])).toContain("idle:");
      expect(t.s.db.query("SELECT 1 FROM episodes WHERE project = 'fx' AND kind = 'idle' AND state = 'waiting'").get()).toBeNull();
    }
  });

  test("a gone wish keeps cancellation in control even with a pending question", async () => {
    const t = current(); question(t);
    t.s.db.run("UPDATE members SET want = 'gone' WHERE wt = ?", [B2]);
    await t.tick(T + 25 * MIN); await t.tick(T + 46 * MIN);
    expect(t.acted).toEqual([]); expect(idleEpisode(t)).toBeNull();
  });

  test("a Builder with an open PR gets nothing", async () => {
    const t = setup(); stale(t); t.world.set(B2, IDLE); t.sinceAll(T - 3600);
    t.s.db.run("UPDATE units SET pr = '77' WHERE builder_wt = ?", [B2]);
    await t.tick(T + 25 * MIN); await t.tick(T + 60 * MIN);
    expect(nudges(t)).toEqual([]); expect(t.reqs("demo")).toEqual([]);
  });

  test("a held unit's Builder gets the report straight away, with no nudge", async () => {
    const t = setup(); stale(t); t.world.set(B2, IDLE); t.sinceAll(T - 3600);
    t.s.db.run("UPDATE units SET hold = 1 WHERE builder_wt = ?", [B2]);
    await t.tick(T + MIN);
    expect(nudges(t)).toEqual([]);
    expect(t.reqs("demo").map(t.text)).toEqual([expect.stringContaining("(the unit is held)")]);
    await t.tick(T + 2 * MIN);
    expect(t.reqs("demo").length).toBe(1);
  });

  test("stale_min=0 does nothing", async () => {
    const t = setup(); stale(t); t.world.set(B2, IDLE); t.sinceAll(T - 3600);
    process.env.DS_SWEEP_STALE_MIN = "0";
    try { await t.tick(T + 25 * MIN); await t.tick(T + 60 * MIN); } finally { delete process.env.DS_SWEEP_STALE_MIN; }
    expect(nudges(t)).toEqual([]); expect(t.reqs("demo")).toEqual([]);
  });
});

describe("U69: a nudge that cannot land", () => {
  test("a Builder with no member row is still reported stale_min later", async () => {
    const t = setup(); t.world.set(B2, { state: "idle", agents: 1, out: T, said: "x" }); t.sinceAll(T - 3600);
    t.s.db.run("UPDATE units SET pr = NULL, hold = NULL, doc = NULL WHERE builder_wt = ?", [B2]);
    await t.tick(T + 25 * MIN);
    expect(t.pokes().filter((a) => a.subject === B2)).toEqual([]);
    await t.tick(T + 46 * MIN);
    expect(t.reqs("demo").length).toBe(1);
  });
});

describe("U267: a stalled Builder escalates on progress, not output", () => {
  const IDLE = { state: "idle", agents: 1, out: T, said: "on it", dispatch: "dispatched", dispatchId: "ctx_b2" } as Seen;
  const start = (heads: string[] = ["abc123"]) => {
    const t = setup(); t.sinceAll(T - 3600);
    t.s.db.run("UPDATE units SET pr = NULL, hold = NULL, doc = NULL WHERE builder_wt = ?", [B2]);
    t.s.db.run("INSERT INTO members (project, squad, wt, role, suffix, agent, status, since, observed_at, updated_at) VALUES ('fx', 'demo', ?, 'builder', 'u2', 'claude', 'running', ?, ?, ?)", [B2, new Date((T - 7200) * 1000).toISOString(), T, T]);
    t.world.set(B2, IDLE);
    const head = { now: heads[0] }, reads: string[] = [];
    builderHead.read = (_s, _p, wt) => { reads.push(wt); return head.now; };
    // The Builder answers a nudge a minute after it lands: output, no commit.
    const answer = (at: number) => t.world.set(B2, { ...t.world.get(B2), out: at + MIN });
    const stalls = () => (t.s.db.query("SELECT unit, member, payload FROM events WHERE kind = 'builder_stall' ORDER BY id").all() as Row[])
      .map((e) => ({ unit: e.unit, member: e.member, ...JSON.parse(String(e.payload)) }));
    return { ...t, head, reads, answer, stalls, nudges: () => t.pokes().filter((a) => a.subject === B2) };
  };
  // The Builder's own worker_done, and its dispatch settled as Orca then reports it.
  const workerDone = (t: ReturnType<typeof setup>, facts: Row = {}) => {
    t.s.upsert("relayed", { msg_id: "msg_done" }, {
      project: "fx", squad: "demo", run_id: "run_fixture01", from_handle: "dispatch:ctx_b2", type: "worker_done",
      subject: "U2 not done: no code, no PR", body: "I did not implement U2.\nThe store needs a migration first.\nThird line.\nFourth line.",
      payload: { taskId: "task_b2", dispatchId: "ctx_b2", outcome: "failed" }, seen_at: T, ...facts,
    });
    t.world.set(B2, { ...t.world.get(B2), dispatch: (facts.payload as Row | undefined)?.outcome === "succeeded" ? "succeeded" : "completed" });
  };

  test("a Builder that answers every nudge without committing is nudged twice, then reported once", async () => {
    const t = start();
    await t.tick(T + 25 * MIN); expect(t.nudges()).toHaveLength(1); t.answer(T + 25 * MIN);
    await t.tick(T + 46 * MIN); expect(t.nudges()).toHaveLength(2); t.answer(T + 46 * MIN);
    expect(t.reqs("demo")).toEqual([]);
    await t.tick(T + 67 * MIN);
    expect(t.reqs("demo").map(t.text)).toEqual([expect.stringMatching(/^idle: builder-u2.* of demo has sat idle on unit u2-.* for 20 min with no PR, nudged 2 times with no new commit\. Last output: on it\./)]);
    for (const m of [68, 90, 150, 300]) await t.tick(T + m * MIN);
    expect(t.nudges()).toHaveLength(2); expect(t.reqs("demo")).toHaveLength(1);
    expect(t.stalls().map((e) => [e.step, e.head, e.unit, e.member])).toEqual([
      ["poked", "abc123", expect.stringMatching(/^u2-/), B2], ["poked", "abc123", expect.stringMatching(/^u2-/), B2],
      ["reported", "abc123", expect.stringMatching(/^u2-/), B2]]);
  });

  test("a commit between nudges starts over at the first nudge", async () => {
    const t = start();
    await t.tick(T + 25 * MIN); t.answer(T + 25 * MIN);
    t.head.now = "def456";
    await t.tick(T + 46 * MIN); t.answer(T + 46 * MIN);
    expect(t.nudges()).toHaveLength(2);
    expect(t.s.get("episodes", { project: "fx", subject: "demo.builder-u2.idle", kind: "idle" })).toMatchObject({ state: "nudged", count: 1 });
    await t.tick(T + 67 * MIN); t.answer(T + 67 * MIN);
    expect(t.nudges()).toHaveLength(3); expect(t.reqs("demo")).toEqual([]);
    await t.tick(T + 88 * MIN);
    expect(t.reqs("demo")).toHaveLength(1);
    expect(t.stalls().map((e) => `${e.step}:${e.head}`)).toEqual(["poked:abc123", "poked:def456", "poked:def456", "reported:def456"]);
  });

  test("the head is read only for a due Builder", async () => {
    const t = start();
    await t.tick(T + 5 * MIN); await t.tick(T + 10 * MIN);
    expect(t.reads).toEqual([]);
    await t.tick(T + 25 * MIN);
    expect(t.reads).toEqual([B2]);
  });

  test("a worker_done with no PR: no nudge, and two minutes on exactly one report naming the body", async () => {
    const t = start(); workerDone(t);
    await t.tick(T + MIN);
    expect(t.reqs("demo")).toEqual([]);
    await t.tick(T + 2 * MIN);
    expect(t.reqs("demo").map(t.text)).toEqual([expect.stringMatching(
      /^failed report: builder-u2.* of demo ended its task on unit u2-.* with no PR \(worker_done, outcome failed\): U2 not done: no code, no PR \/ I did not implement U2\. \/ The store needs a migration first\.\. Answer it/)]);
    expect(t.text(t.reqs("demo")[0])).not.toContain("Third line");
    for (const m of [25, 46, 67, 120, 300]) await t.tick(T + m * MIN);
    expect(t.nudges()).toEqual([]); expect(t.reqs("demo")).toHaveLength(1);
    expect(t.stalls().map((e) => e.step)).toEqual(["failed_report"]);
    expect(t.s.get("episodes", { project: "fx", subject: "demo.builder-u2.idle", kind: "idle" })).toMatchObject({ state: "failed_report", ended_at: null });
  });

  test("a succeeded worker_done with no PR (finish-unit --no-pr) is a report with no PR, not a failed one", async () => {
    const t = start(); workerDone(t, { payload: { dispatchId: "ctx_b2", outcome: "succeeded" } });
    await t.tick(T + 3 * MIN);
    expect(t.reqs("demo").map(t.text)).toEqual([expect.stringMatching(/^report with no PR: .* \(worker_done, outcome succeeded\)/)]);
  });

  test("a new dispatch clears the failed report; the new task is nudged as usual", async () => {
    const t = start(); workerDone(t);
    await t.tick(T + 2 * MIN);
    expect(t.reqs("demo")).toHaveLength(1);
    t.world.set(B2, { ...t.world.get(B2), dispatchId: "ctx_b2_again", out: T + 2 * MIN });
    await t.tick(T + 3 * MIN);
    expect(t.s.get("episodes", { project: "fx", subject: "demo.builder-u2.idle", kind: "idle" })).toMatchObject({ state: "cleared", ended_at: T + 3 * MIN });
    await t.tick(T + 25 * MIN);
    expect(t.nudges()).toHaveLength(1); expect(t.reqs("demo")).toHaveLength(1);
  });

  test("a worker_done from another dispatch, squad or a unit with a PR files no failed report", async () => {
    for (const [facts, pr] of [[{ payload: { dispatchId: "ctx_other", outcome: "failed" } }, null], [{ squad: "other" }, null], [{}, "77"]] as [Row, string | null][]) {
      const t = start(); workerDone(t, facts);
      if (pr) t.s.db.run("UPDATE units SET pr = ? WHERE builder_wt = ?", [pr, B2]);
      await t.tick(T + 3 * MIN);
      expect(t.reqs("demo")).toEqual([]);
    }
  });

  test("a recorded waiting_on gets neither a nudge nor a report, a worker_done one included", async () => {
    for (const done of [false, true]) {
      const t = start(); if (done) workerDone(t);
      t.s.db.run("UPDATE units SET doc = ? WHERE builder_wt = ?", [JSON.stringify({ waiting_on: "squad x/u1" }), B2]);
      for (const m of [1, 25, 46, 67, 120]) await t.tick(T + m * MIN);
      expect(t.nudges()).toEqual([]); expect(t.reqs("demo")).toEqual([]); expect(t.stalls()).toEqual([]);
    }
  });

  test("an open question gets neither a nudge nor a report", async () => {
    const t = start();
    t.s.upsert("relayed", { msg_id: "q1" }, { project: "fx", squad: "demo", run_id: "run_fixture01", from_handle: "dispatch:ctx_b2", type: "question",
      payload: { taskId: "task_b2", dispatchId: "ctx_b2", question: "Which approach?" }, seen_at: T });
    for (const m of [25, 46, 67, 120]) await t.tick(T + m * MIN);
    expect(t.nudges()).toEqual([]); expect(t.reqs("demo")).toEqual([]); expect(t.stalls()).toEqual([]);
  });
});

describe("U152: an exited member is the decider's", () => {
  test("an exited Builder or Lead: no run-switch and no request file from liveness", async () => {
    const t = setup();
    t.world.set(B2, { state: "idle", agents: 0 }); t.world.set(LEAD, { state: "idle", agents: 0 });
    await t.tick(T);
    await t.tick(T + MIN);
    expect(t.acted.filter((a) => a.kind === "run-switch" || a.kind === "request.file")).toEqual([]);
  });
});

// builder-idle-no-pr-card U1: public-readiness-audit's U4 Builder read `working` for 3 h after its turn
// ended, its only open work a background `until ! pgrep -f …` loop that matched itself. Replayed here
// with T as 14:24, the minute its transcript last moved.
describe("U1: a Builder at its prompt with only a background command", () => {
  const CMD = 'until ! pgrep -f "review/review-unit.sh dev-studio" >/dev/null; do sleep 5; done';
  const use = (id: string, input: Row = {}) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input }] } });
  const res = (id: string, content = "ok") => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
  const say = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
  const U4 = [use("a", { command: "git commit -q -m docs" }), res("a"),
    use("b", { command: CMD, run_in_background: true }), res("b", "Command running in background with ID: btp4sj13h. Output is being written to: /tmp/x/btp4sj13h.output"),
    say("The review is running. I'll wait for it to finish.")];
  const hm = (at: number) => { const d = new Date(at * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  function prompt(lines = U4, cpu: number | null = 0) {
    const t = setup();
    t.s.db.run("UPDATE units SET pr = NULL, hold = NULL, doc = NULL WHERE builder_wt = ?", [B2]);
    t.s.db.run("INSERT INTO members (project, squad, wt, role, suffix, agent, status, since, observed_at, updated_at) VALUES ('fx', 'demo', ?, 'builder', 'u2', 'claude', 'running', ?, ?, ?)", [B2, new Date((T - 7200) * 1000).toISOString(), T, T]);
    t.sinceAll(T - 7200);
    const path = join(temps[temps.length - 1], "b2.jsonl");
    writeFileSync(path, lines.join("\n") + "\n");
    t.s.upsert("observed_transcripts", { path }, { project: "fx", wt: B2, mtime: T, size: 1, observed_at: T });
    if (cpu !== null) t.s.upsert("observed_procs", { project: "fx", wt: B2 }, { procs: 3, rss_kb: 1, cpu_pct: cpu, observed_at: T });
    t.world.set(B2, { state: "working", agents: 1, out: T });
    // The terminal's output keeps moving (the U4 case: no quiet poke, no hung verdict); the transcript does not.
    const at = (m: number) => { t.world.set(B2, { ...t.world.get(B2)!, out: T + m * MIN }); return t.tick(T + m * MIN); };
    const nudges = () => t.pokes().filter((a) => a.subject === B2).map((a) => String((a.payload as Row).text));
    const episode = () => t.s.get("episodes", { project: "fx", subject: "demo.builder-u2.prompt", kind: "at-prompt" });
    const stalls = () => t.s.db.query("SELECT payload FROM events WHERE kind = 'builder_stall' ORDER BY id").all().map((r) => JSON.parse(String((r as Row).payload)));
    return { ...t, path, at, nudges, episode, stalls };
  }
  const NUDGE = `dev-studio loop: your turn ended at ${hm(T)} and only a background command is still running: \`${CMD}\`. If it is stuck, stop it. If the unit is done, open the PR. If you are waiting on something, say what with \`ask\`.`;

  test("the U4 replay: nudge at 14:44, nudge at 15:04, the Lead's report at 15:24, then nothing", async () => {
    const t = prompt();
    await t.at(10);
    expect(t.nudges()).toEqual([]);
    expect(t.episode()).toBeNull();
    await t.at(20);
    expect(t.nudges()).toEqual([NUDGE]);
    expect(t.episode()).toMatchObject({ state: "open", started_at: T, ended_at: null });
    await t.at(21); await t.at(39);
    expect(t.nudges().length).toBe(1);
    await t.at(40);
    expect(t.nudges()).toEqual([NUDGE, NUDGE]);
    expect(t.reqs("demo")).toEqual([]);
    await t.at(60);
    expect(t.reqs("demo").map(t.text)).toEqual([`idle: builder-u2 of demo has sat at its prompt on unit u2-sqlite-store-migrations-and for 60 min (turn ended ${hm(T)}) with only a background command running (\`${CMD}\`) and no PR, nudged 2 times with no new commit. Wake it, stop the command, release the unit, or close it.\n`]);
    await t.at(61); await t.at(120);
    expect(t.nudges().length).toBe(2);
    expect(t.reqs("demo").length).toBe(1);
    expect(t.stalls().map((p) => [p.step, p.cause, p.since, p.command])).toEqual([
      ["poked", "at-prompt", T, CMD], ["poked", "at-prompt", T, CMD], ["reported", "at-prompt", T, CMD]]);
    expect(t.pokes().some((a) => (a.payload as Row).text === QUIET_POKE_TEXT)).toBe(false);
  });

  test("the command is redacted and cut to 80 characters", async () => {
    const long = `until curl -s -H "Authorization: Bearer abcdefghijklmnop1234" http://x/ready; do sleep 5; done; echo ${"x".repeat(60)}`;
    const t = prompt([use("b", { command: long, run_in_background: true }), res("b", "Command running in background with ID: bz9")]);
    await t.at(20);
    const cmd = /running: `(.*?)`\. If it is stuck/.exec(t.nudges()[0])?.[1] ?? "";
    expect(cmd.length).toBe(80);
    expect(cmd.endsWith("…")).toBe(true);
    expect(cmd).not.toContain("abcdefghijklmnop1234");
  });

  test("no nudge or episode: CPU 40 %, a review running, an open PR, an open foreground call, prompt_wait_min 0, no CPU row", async () => {
    const cases: [string, () => ReturnType<typeof prompt>][] = [
      ["cpu", () => prompt(U4, 40)],
      ["review", () => { const t = prompt(); t.s.upsert("observed_reviews", { project: "fx", squad: "demo", slug: "u2-sqlite-store-migrations-and" }, { wt: B2, state: "reviewing", since: T, observed_at: T }); return t; }],
      ["pr", () => { const t = prompt(); t.s.db.run("UPDATE units SET pr = '#9' WHERE builder_wt = ?", [B2]); return t; }],
      ["foreground", () => prompt([...U4, use("c", { command: "sleep 600" })])],
      ["off", () => { const t = prompt(); t.s.upsert("config", { project: "fx", file: "limits.conf", key: "prompt_wait_min" }, { value: "0", observed_at: T }); return t; }],
      ["no procs row", () => prompt(U4, null)],
    ];
    for (const [name, make] of cases) {
      const t = make();
      for (const m of [20, 40, 60, 80]) await t.at(m);
      expect([name, t.nudges(), t.reqs("demo"), t.episode()]).toEqual([name, [], [], null]);
    }
  });

  test("no background task, nothing open: not at its prompt", async () => {
    const t = prompt([use("a"), res("a"), say("done")]);
    for (const m of [20, 40, 60]) await t.at(m);
    expect(t.nudges()).toEqual([]);
    expect(t.episode()).toBeNull();
  });

  test("the episode ends when the transcript moves, and again when the unit gets a PR or the Builder stops working", async () => {
    const t = prompt();
    await t.at(20);
    expect(t.episode()).toMatchObject({ state: "open", started_at: T });
    t.s.upsert("observed_transcripts", { path: t.path }, { mtime: T + 25 * MIN });
    await t.at(25);
    expect(t.episode()).toMatchObject({ state: "cleared", started_at: T, ended_at: T + 25 * MIN });
    await t.at(44);
    expect(t.episode()).toMatchObject({ state: "cleared" });
    await t.at(45);
    expect(t.episode()).toMatchObject({ state: "open", started_at: T + 25 * MIN, ended_at: null });
    t.s.db.run("UPDATE units SET pr = '#9' WHERE builder_wt = ?", [B2]);
    await t.at(46);
    expect(t.episode()).toMatchObject({ state: "cleared", ended_at: T + 46 * MIN });

    const u = prompt();
    await u.at(20);
    u.world.set(B2, { ...u.world.get(B2)!, state: "idle" });
    await u.at(21);
    expect(u.episode()).toMatchObject({ state: "cleared", ended_at: T + 21 * MIN });
  });

  test("no quiet poke while the episode is open, past long_step_min too, with the terminal quiet", async () => {
    const t = prompt();
    for (const m of [20, 40, 61, 75, 95]) await t.tick(T + m * MIN);
    expect(t.episode()).toMatchObject({ state: "open" });
    expect(t.nudges()).toEqual([NUDGE, NUDGE]);
  });

  test("openCalls: one parse gives the foreground call and the open background tasks; stepOpen and foregroundOpen keep their answers", () => {
    const t = prompt();
    expect(openCalls(t.s, B2)).toEqual({ foreground: false, background: [{ id: "btp4sj13h", command: CMD }], ended: false });
    expect(stepOpen(t.s, B2)).toBe(true);
    expect(foregroundOpen(t.s, B2)).toBe(false);
    writeFileSync(t.path, [...U4, use("c")].join("\n") + "\n");
    expect(openCalls(t.s, B2)?.foreground).toBe(true);
    expect(foregroundOpen(t.s, B2)).toBe(true);
    writeFileSync(t.path, [use("a"), res("a")].join("\n") + "\n");
    expect([stepOpen(t.s, B2), foregroundOpen(t.s, B2)]).toEqual([false, false]);
    expect(openCalls(t.s, "nobody")).toBeNull();
    expect([stepOpen(t.s, "nobody"), foregroundOpen(t.s, "nobody")]).toEqual([false, null]);
  });
});
