// stop-checkpoint.test.ts — U266: a planned restart (restart wish in idle mode, rss, fallback, pin, account)
// asks the idle agent for a journal checkpoint first and stops once the line is there, or after
// CHECKPOINT_S anyway; restart mode now, hung, phase and limit stops go ahead as before.
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compare, decide, type Facts } from "../../bin/loop/core/decide.ts";
import { CHECKPOINT_S, journalPath } from "../../bin/loop/pause/pause.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { latest, owed, pendingOf } from "../../bin/loop/pause/stop-checkpoint.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): Store {
  const root = mkdtempSync(join(tmpdir(), "zzstopcp-")); roots.push(root);
  const s = open(root); stores.push(s);
  s.upsert("projects", { label: "p" }, { observed_at: 1 });
  s.upsert("squads", { project: "p", topic: "one" }, { run_id: "run_one", repo: "path:/fake", status: "running", observed_at: 1, updated_at: 1 });
  return s;
}
// An idle Builder on unit u1 with its live agent; `set` adds member columns (a restart wish).
function builder(s: Store, set: Row = {}, state = "idle"): Row {
  s.upsert("units", { project: "p", squad: "one", slug: "u1" }, { status: "dispatched", builder_wt: "wt_b", observed_at: 1, updated_at: 1 });
  s.upsert("members", { project: "p", squad: "one", role: "builder", suffix: "u1" },
    { wt: "wt_b", status: "running", want: "running", placed_at: T - 3600, observed_at: 1, updated_at: 1, ...set });
  s.upsert("observed_workers", { project: "p", wt: "wt_b" }, { presence: "running", walk: "running", account_at: T, state, started_at: T - 3600, observed_at: T });
  return s.get("members", { project: "p", squad: "one", role: "builder", suffix: "u1" })!;
}
const restart = (mode = "idle") => ({ restart_at: T - 10, restart_mode: mode, restart_by: "operator" });
const ctx = (s: Store, now = T): TickCtx => ({ store: s, project: "", tick: 1, now, fired: [], poked: new Set() });
const acts = (s: Store, now = T) => decide(ctx(s, now));
const stops = (a: ReturnType<typeof acts>) => a.filter((x) => x.kind === "member" && (x.payload as Row).stop).map((x) => (x.payload as Row).why);
const pokes = (a: ReturnType<typeof acts>) => a.filter((x) => x.kind === "poke").map((x) => String((x.payload as Row).text));
const journal = (s: Store, m: Row) => journalPath(s, { scope: "member", project: "p", squad: "one", role: String(m.role), suffix: String(m.suffix ?? "") });
function write(s: Store, m: Row, line: string) {
  const f = journal(s, m); mkdirSync(dirname(f), { recursive: true });
  appendFileSync(f, `- 2027-01-15T08:00:00Z [keep] ${line} — before a planned restart\n`);
}
const results = (s: Store) => (s.db.query("SELECT payload FROM events WHERE kind = 'stop_checkpoint' ORDER BY id").all() as Row[])
  .map((e) => JSON.parse(String(e.payload)) as Row).map((p) => `${p.why}:${p.result}`);

describe("a restart wish on an idle Builder", () => {
  test("asks once, waits, and stops only after the line with its generation", () => {
    const s = fixture(), b = builder(s, restart());
    const first = acts(s);
    expect(stops(first)).toEqual([]);
    const row = latest(s, Number(b.id))!;
    expect(row).toMatchObject({ why: "restart", stop_key: `restart:${T - 10}`, state: "asking", asked_at: T });
    const text = pokes(first);
    expect(text.length).toBe(1);
    expect(text[0]).toContain(`generation ${row.generation}`);
    expect(text[0]).toContain("bin/role/pause-checkpoint.sh");
    expect(text[0]).toContain(journal(s, b));
    // nothing written yet: no second poke in the same window, no stop
    expect(stops(acts(s, T + 60))).toEqual([]);
    // a line with another generation does not count
    write(s, b, "checkpoint stop-other: elsewhere");
    expect(stops(acts(s, T + 120))).toEqual([]);
    write(s, b, `checkpoint ${row.generation}: done A; next step B`);
    expect(stops(acts(s, T + 180))).toEqual(["restart"]);
    expect(latest(s, Number(b.id))).toMatchObject({ state: "verified", settled_at: T + 180 });
    expect(results(s)).toEqual(["restart:verified"]);
    // the stop is owed once: the proved row lets the same wish stop again without a new ask
    expect(stops(acts(s, T + 240))).toEqual(["restart"]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM stop_checkpoints").get()).toEqual({ n: 1 });
  });

  test("a working agent is not asked until it is idle", () => {
    const s = fixture(), b = builder(s, restart(), "working");
    expect(acts(s)).toEqual([]);
    expect(latest(s, Number(b.id))).toBeNull();
  });

  test("no line within CHECKPOINT_S: it stops anyway and journals checkpoint failed", () => {
    const s = fixture(), b = builder(s, restart());
    acts(s);
    const gen = String(latest(s, Number(b.id))!.generation);
    expect(stops(acts(s, T + CHECKPOINT_S - 1))).toEqual([]);
    expect(stops(acts(s, T + CHECKPOINT_S))).toEqual(["restart"]);
    expect(latest(s, Number(b.id))!.state).toBe("failed");
    expect(readFileSync(journal(s, b), "utf8")).toContain(`[keep] checkpoint failed ${gen}: no checkpoint within 5 minutes of the stop checkpoint instruction`);
    expect(results(s)).toEqual(["restart:failed"]);
  });

  test("the wish cleared while waiting: nothing stopped, the ask is dropped", () => {
    const s = fixture(), b = builder(s, restart());
    acts(s);
    s.upsert("members", { id: b.id }, { restart_at: null, restart_mode: null, restart_by: null });
    expect(stops(acts(s, T + 60))).toEqual([]);
    expect(latest(s, Number(b.id))).toMatchObject({ state: "dropped", settled_at: T + 60 });
    expect(results(s)).toEqual(["restart:dropped"]);
    // a new wish is a new stop: a fresh generation
    s.upsert("members", { id: b.id }, { restart_at: T + 100, restart_mode: "idle", restart_by: "operator" });
    acts(s, T + 120);
    const row = latest(s, Number(b.id))!;
    expect(row).toMatchObject({ state: "asking", stop_key: `restart:${T + 100}` });
  });

  test("the board sees the pending ask", () => {
    const s = fixture(), b = builder(s, restart());
    expect(pendingOf(s, Number(b.id))).toBeNull();
    acts(s);
    expect(pendingOf(s, Number(b.id))).toMatchObject({ why: "restart", since: T, asked_at: T });
  });
});

describe("stops that go ahead without a checkpoint", () => {
  test("restart mode now stops at once, even mid-turn", () => {
    const s = fixture(), b = builder(s, restart("now"), "working");
    expect(stops(acts(s))).toEqual(["restart"]);
    expect(latest(s, Number(b.id))).toBeNull();
  });

  test("a hung agent stops at once", () => {
    const s = fixture(), b = builder(s);
    s.upsert("observed_workers", { project: "p", wt: "wt_b" }, { state: "working", last_output_at: T - 31 * 60, started_at: T - 7200 });
    expect(stops(acts(s))).toEqual(["hung"]);
    expect(latest(s, Number(b.id))).toBeNull();
  });

  test("owed(): now, phase and limit stops owe none; restart, rss, fallback, pin and account do", () => {
    const s = fixture(), m = builder(s, restart());
    expect(owed(s, m, { stopDue: "now", stopWhy: "restart" })).toBeNull();
    expect(owed(s, m, { stopDue: "now", stopWhy: "hung" })).toBeNull();
    expect(owed(s, m, { switchStop: { why: "phase", episode: "stop:phase:5" } })).toBeNull();
    expect(owed(s, m, { switchStop: { why: "limit", episode: "stop:limit:k@5" } })).toBeNull();
    expect(owed(s, m, { stopDue: "idle", stopWhy: "restart" })).toEqual({ why: "restart", key: `restart:${T - 10}` });
    expect(owed(s, m, { stopDue: "idle", stopWhy: "rss" })).toEqual({ why: "rss", key: "rss:0" });
    // a fallback's rung pair may change between picks; its key does not
    expect(owed(s, m, { switchStop: { why: "fallback", episode: "stop:fallback:rung3->1:77" } })).toEqual({ why: "fallback", key: "fallback:77" });
    expect(owed(s, m, { switchStop: { why: "fallback", episode: "stop:fallback:rung2->1" } })).toEqual({ why: "fallback", key: "fallback" });
    expect(owed(s, m, { switchStop: { why: "pin", episode: "stop:pin:9" } })).toEqual({ why: "pin", key: "pin:9" });
    // provider-billing-fallback U5: a switched-off account's stop, keyed per account_disabled event
    expect(owed(s, m, { switchStop: { why: "account", episode: "stop:account:muse/default@12" } })).toEqual({ why: "account", key: "account:muse/default@12" });
  });
});

describe("compare: a checkpoint before the stop", () => {
  const base: Facts = { view: "running", lock: false, reality: "running", unknownS: 0, recheckS: 300, resume: null,
    switchDue: false, givenUp: false, capped: false, rebroke: false, room: true, idleOK: true };
  test.each([
    ["fallback, owed", { switchStop: { why: "fallback", episode: "stop:fallback:rung2->1" }, checkpoint: "fallback" }, { act: "checkpoint", why: "fallback" }],
    ["fallback, proved", { switchStop: { why: "fallback", episode: "stop:fallback:rung2->1" }, checkpoint: null }, { act: "stop", why: "fallback" }],
    ["pin, owed", { switchStop: { why: "pin", episode: "stop:pin:9" }, checkpoint: "pin" }, { act: "checkpoint", why: "pin" }],
    ["account, owed", { switchStop: { why: "account", episode: "stop:account:muse/default@12" }, checkpoint: "account" }, { act: "checkpoint", why: "account" }],
    ["account, proved", { switchStop: { why: "account", episode: "stop:account:muse/default@12" }, checkpoint: null }, { act: "stop", why: "account" }],
    ["pin, owed, no room", { switchStop: { why: "pin", episode: "stop:pin:9" }, checkpoint: "pin", room: false }, null],
    ["phase: no checkpoint", { switchStop: { why: "phase", episode: "stop:phase:5" }, checkpoint: null }, { act: "stop", why: "phase" }],
    ["restart idle, owed", { stopDue: "idle", stopWhy: "restart", checkpoint: "restart" }, { act: "checkpoint", why: "restart" }],
    ["restart now", { stopDue: "now", stopWhy: "restart", checkpoint: null, idleOK: false }, { act: "stop", why: "restart" }],
  ] as [string, Partial<Facts>, unknown][])("%s", (_n, f, want) => {
    expect(compare({ ...base, ...f } as Facts)).toEqual(want as never);
  });
});

describe("the agent side: pause-checkpoint.sh with a stop-… generation", () => {
  const cli = (s: Store, args: string[], handle = "term_b") => {
    const r = Bun.spawnSync([join(ROOT, "bin/role/pause-checkpoint.sh"), ...args, "--commands-finished"],
      { env: { ...process.env, DS_STATE_ROOT: s.root, ORCA_TERMINAL_HANDLE: handle }, stdout: "pipe", stderr: "pipe" });
    return { rc: r.exitCode, err: r.stderr.toString() };
  };
  test("writes the line the loop proves; a stale generation or another terminal writes nothing", () => {
    const s = fixture(), b = builder(s, restart());
    s.upsert("observed_terminals", { project: "p", handle: "term_b" }, { wt: "wt_b", observed_at: T });
    acts(s);
    const gen = String(latest(s, Number(b.id))!.generation);
    expect(cli(s, ["p", "one", "builder", "u1", "stop-stale", "x"]).rc).toBe(1);
    expect(cli(s, ["p", "one", "builder", "u1", gen, "x"], "term_other").rc).toBe(1);
    const ok = cli(s, ["p", "one", "builder", "u1", gen, "done A; next step B"]);
    expect(ok).toEqual({ rc: 0, err: "" });
    const text = readFileSync(journal(s, b), "utf8");
    expect(text.split("\n").filter(Boolean).length).toBe(1);
    expect(text).toContain(`[keep] checkpoint ${gen}: done A; next step B`);
    expect(stops(acts(s, T + 60))).toEqual(["restart"]);
    // the briefing ends with it, behind 30 newer decisions
    const J = join(ROOT, "bin/role/journal.sh"), env = { ...process.env, DS_STATE_ROOT: s.root };
    for (let i = 0; i < 31; i++) Bun.spawnSync([J, "p", "one", "builder-u1", "add", "decision", `d${i}`, "w"], { env });
    const brief = Bun.spawnSync([J, "p", "one", "builder-u1", "briefing"], { env }).stdout.toString().trimEnd().split("\n");
    expect(brief.filter((l) => l.includes("[decision]")).length).toBe(30);
    expect(brief.at(-1)).toContain("newest checkpoint (continue from its next step; the 31 newer entries above came after it): ");
    expect(brief.at(-1)).toContain(`checkpoint ${gen}: done A; next step B`);
  });
});
