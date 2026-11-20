// U248: the loop's backend reads run in its own process and a Run's reads are kept across ticks. A fake `orca`
// CLI (no live Orca) logs every call it gets; the loop's own Loop.tick, shell() and run-keep.ts do the rest.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open } from "../../bin/loop/core/store.ts";
import { orca as orcaCall } from "../../bin/backend/orca.ts";
import { shell } from "../../bin/loop/io/orca.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { coordinatorMail, parseUnread } from "../../bin/loop/observers/orca.ts";
import type { Observer } from "../../bin/loop/core/plugins.ts";

const T = 1_800_000_000;
const tmp = mkdtempSync(join(tmpdir(), "zzinproc-"));
const data = join(tmp, "data"), bin = join(tmp, "bin"), log = join(tmp, "cli.log"), root = join(tmp, "state");
const saved: Record<string, string | undefined> = {};
const ENV = { DS_ORCA_CLI_BIN_DIR: bin, FAKE_DIR: data, CLI_LOG: log, DS_STATE_ROOT: root, DS_ROOT: join(import.meta.dir, "..", "..") };

const FAKE = `#!/usr/bin/env bash
echo "$1 $2 $*" >> "$CLI_LOG"
d="$FAKE_DIR"
case "$1 $2" in
  "terminal list") cat "$d/terminals.json" ;;
  "orchestration worker-list")
    run=""; cur=0
    while [ $# -gt 0 ]; do case "$1" in --run) run="$2"; shift;; --cursor) cur="$2"; shift;; esac; shift; done
    f="$d/wl-$run-$cur.json"
    if [ -f "$f" ]; then cat "$f"; else echo '{"ok":false,"error":"no such run"}'; echo "orca: no such run" >&2; exit 1; fi ;;
  "orchestration run-show")
    id=""; while [ $# -gt 0 ]; do case "$1" in --id) id="$2"; shift;; esac; shift; done
    printf '{"ok":true,"result":{"run":{"coordinator_handle":"term_lead_%s"}}}\n' "$id" ;;
  "orchestration inbox") cat "$d/inbox.json" ;;
  "orchestration check")
    run=""; while [ $# -gt 0 ]; do case "$1" in --run) run="$2"; shift;; esac; shift; done
    if [ -f "$d/check-$run.json" ]; then cat "$d/check-$run.json"; else echo '{"ok":true,"result":{"messages":[]}}'; fi ;;
  *) echo '{"ok":true}' ;;
esac
`;

const worker = (run: string, i: number) => ({ dispatchId: `d_${run}_${i}`, dispatchStatus: "dispatched", taskId: `task_${i}`, terminalState: "active",
  resource: { worktreeId: `wt_${run}_${i}`, terminalHandle: `term_${run}_${i}` } });
function writeRun(run: string, n: number): void {
  for (let page = 0, from = 0; from < n || page === 0; page++, from += 100) {
    const rows = Array.from({ length: Math.min(100, n - from) }, (_, i) => worker(run, from + i));
    const more = from + 100 < n;
    writeFileSync(join(data, `wl-${run}-${page === 0 ? 0 : page * 100}.json`),
      JSON.stringify({ ok: true, result: { workers: rows, page: { hasMore: more, nextCursor: more ? String((page + 1) * 100) : null } } }));
  }
}
const terminals = (list: unknown[]) => writeFileSync(join(data, "terminals.json"), JSON.stringify({ ok: true, result: { terminals: list } }));
const term = (run: string, i: number) => ({ handle: `term_${run}_${i}`, worktreeId: `wt_${run}_${i}`, connected: true, writable: true, orphaned: false, agentIdentity: "claude" });
const calls = (re: RegExp) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => re.test(l)).length : 0);
const reset = () => writeFileSync(log, "");

beforeAll(() => {
  mkdirSync(data, { recursive: true }); mkdirSync(bin, { recursive: true }); mkdirSync(root, { recursive: true });
  writeFileSync(join(bin, "orca"), FAKE); chmodSync(join(bin, "orca"), 0o755);
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  for (const k of ["BACKEND", "DS_LOOP_RUN_READ_S", "DS_ORCA_TICK_DIR", "DS_ORCA_KEEP_DIR", "DS_ORCA_SPAWN_LOG"]) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  rmSync(tmp, { recursive: true, force: true });
});

describe("in-process read verbs", () => {
  test("print and exit exactly what the spawned orca.sh does, errors included", async () => {
    writeRun("run_1", 3); writeRun("run_big", 250);
    writeFileSync(join(data, "check-run_1.json"), JSON.stringify({ ok: true, result: { messages: [{ id: "m9", from_handle: "term_w", type: "worker_done", subject: "s", body: "b", payload: null }] } }));
    terminals([term("run_1", 0), term("run_1", 1)]);
    writeFileSync(join(data, "inbox.json"), JSON.stringify({ ok: true, result: { messages: [
      { id: "m1", to_handle: "term_lead", run_id: "run_1", read: 0, type: "worker_done", created_at: "2026-11-12T10:00:00Z" },
      { id: "m2", to_handle: "term_lead", run_id: "run_1", read: 1, type: "ask", created_at: "2026-11-12T10:00:00Z" }] } }));
    const cases: [string, string[]][] = [["run-workers", ["run_1"]], ["run-workers", ["run_big"]], ["run-workers", ["run_none"]], ["worker-detail", ["run_1"]],
      ["run-dispatches", ["run_big"]], ["run-dispatches", ["run_none"]], ["loop-terminals", []], ["wt-terminals", []], ["inbox-unread-all", []], ["run-inbox-peek", ["run_1"]]];
    const orca = shell();
    const spawnedOp = async (op: string, args: string[]) => { const p = Bun.spawnSync([join(ENV.DS_ROOT, "bin/backend/orca.sh"), op, ...args], { env: { ...process.env, DS_ORCA_FROM: "term_loop", DS_WORKER_START_RETRIES: "1" }, stdout: "pipe", stderr: "pipe" }); return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }; };
    for (const [op, args] of cases) {
      const spawned = await spawnedOp(op, args);
      const inproc = await orca.run(op, args, { from: "term_loop" });
      expect({ op, ...inproc }).toEqual({ op, ...spawned });
    }
    expect((await orca.run("run-workers", ["run_none"])).code).toBe(1);
    expect((await orca.run("inbox-unread-all", [])).out).toBe("term_lead\trun_1\t2026-11-12T10:00:00Z\tm1\n".replace("2026-11-12T10:00:00Z", String(Date.parse("2026-11-12T10:00:00Z") / 1000)));
  });
});

// A loop whose one observer reads every Run the way the loop's steps do: run-workers, worker-detail and
// run-dispatches (each a read of the Run's worker-list), through shell() as the actuator and observers do.
function fixture(runs: string[], before?: () => Promise<void>) {
  const s = open(mkdtempSync(join(tmp, "s-")));
  runs.forEach((r, i) => {
    s.upsert("squads", { project: "p", topic: `t${i}` }, { status: "running", run_id: r, observed_at: 1, updated_at: 1 });
    s.upsert("members", { project: "p", squad: `t${i}`, role: "lead", suffix: "" }, { wt: `wt_${r}_0`, status: "running", observed_at: 1, updated_at: 1 });
  });
  const reads: string[] = [];
  const observer: Observer = { name: "reads", scope: "host", async run() {
    if (before) await before();
    const orca = shell();
    await Promise.all(runs.map(async (r) => {
      for (const op of ["run-workers", "worker-detail", "run-dispatches"]) { const o = await orca.run(op, [r]); if (o.code !== 0) reads.push(`${op}:${r}:failed`); }
    }));
    await orca.run("loop-terminals", []);
    await orca.run("inbox-unread-all", []);
  } };
  const signals = async () => {
    const orca = shell(), [t, u] = await Promise.all([orca.run("loop-terminals", []), orca.run("inbox-unread-all", [])]);
    if (t.code !== 0 || u.code !== 0) throw new Error("signals");
    return { terminals: t.out, unread: u.out };
  };
  const loop = new Loop(s, { observers: [observer], reconcilers: [] }, { act() {} }, { projects: () => ["p"], signals });
  const tick = async () => { reset(); const at = T + loop.tickNo * 5; await loop.tick(at); return JSON.parse(readFileSync(join(s.root, "loop", "orca-spawns.json"), "utf8")); };
  return { s, loop, tick, reads };
}

describe("a Run's reads across ticks", () => {
  const runs = Array.from({ length: 16 }, (_, i) => `run_${i + 1}`);
  const setup = () => {
    for (const r of runs) writeRun(r, 4);
    terminals(runs.flatMap((r) => [0, 1].map((i) => term(r, i))));
    writeFileSync(join(data, "inbox.json"), JSON.stringify({ ok: true, result: { messages: [] } }));
  };

  test("steady ticks read no worker-list or run-show and start no bun; each Run is read once at 60s", async () => {
    setup();
    const f = fixture(runs);
    const first = await f.tick();
    expect(first.runs.reread).toBe(16);
    expect(calls(/^orchestration worker-list/)).toBe(16);          // one read per Run: three readers, one page each
      for (let i = 0; i < 3; i++) {
      const t = await f.tick();
      expect(calls(/^orchestration worker-list|^orchestration run-show/)).toBe(0);
      expect(t.runs).toMatchObject({ kept: 16, reread: 0 });
    }
    expect(f.reads).toEqual([]);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      const t = await f.tick();
      expect(t.runs).toMatchObject({ kept: 0, reread: 16, why: { age: 16 } });
      expect(calls(/^orchestration worker-list/)).toBe(16);
    } finally { Date.now = realNow; }
    f.s.close();
  });

  test("new mail or a vanished terminal makes that Run's read happen in the same tick, and only that Run's", async () => {
    setup();
    const f = fixture(runs);
    await f.tick(); await f.tick();
    writeFileSync(join(data, "inbox.json"), JSON.stringify({ ok: true, result: { messages: [
      { id: "m1", to_handle: "term_lead", run_id: "run_3", read: 0, type: "worker_done", created_at: "2026-11-12T10:00:00Z" }] } }));
    let t = await f.tick();
    expect(t.runs).toMatchObject({ kept: 15, reread: 1, why: { mail: 1 } });
    expect(readFileSync(log, "utf8")).toContain("--run run_3 ");
    expect(calls(/^orchestration worker-list/)).toBe(1);
    t = await f.tick();                                            // the same mail still unread: nothing changed
    expect(t.runs).toMatchObject({ kept: 16, reread: 0 });
    terminals(runs.flatMap((r) => [0, 1].filter((i) => !(r === "run_7" && i === 0)).map((i) => term(r, i))));
    t = await f.tick();
    expect(t.runs).toMatchObject({ kept: 15, reread: 1, why: { terminals: 1 } });
    expect(readFileSync(log, "utf8")).toContain("--run run_7 ");
    expect(calls(/^orchestration worker-list/)).toBe(1);
    f.s.close();
  });

  // U251: a call that only looks must not wipe the keep; a write drops what it can change and no more.
  const cli = (args: string[]) => orcaCall({ env: process.env as any, out() {}, err() {}, stdin: "ignore" } as any, args, "drop");
  test("worktree current and check --all read: all 16 Runs stay kept, nothing is dropped", async () => {
    setup();
    let extra = false;
    const f = fixture(runs, async () => { if (extra) { await cli(["worktree", "current", "--json"]); await cli(["orchestration", "check", "--all", "--terminal", "term_lead", "--json"]); await cli(["terminal", "read", "--terminal", "term_run_1_0", "--screen", "--json"]); } });
    await f.tick();
    extra = true;
    const t = await f.tick();
    expect(calls(/^worktree current|^orchestration check|^terminal read/)).toBe(3);
    expect(calls(/^orchestration worker-list|^orchestration run-show/)).toBe(0);
    expect(t.runs).toMatchObject({ kept: 16, reread: 0 });
    expect(t.dropped_by).toEqual({});
    f.s.close();
  });

  // U264: a write whose subject no cached Run read names (a stray terminal) keeps every Run; one that names no subject re-reads all.
  test("a terminal send to one Run's worker re-reads that Run only; a stray terminal keeps every Run; a write with no subject re-reads all", async () => {
    setup();
    let mode = "";
    const f = fixture(runs, async () => {
      if (mode === "send") await cli(["terminal", "send", "--terminal", "term_run_5_1", "--text", "hi", "--json"]);
      if (mode === "unknown") await cli(["terminal", "send", "--terminal", "term_nowhere", "--text", "hi", "--json"]);
      if (mode === "consume") await cli(["orchestration", "check", "--run", "run_9", "--terminal", "term_lead", "--json"]);
      if (mode === "unplaced") await cli(["orchestration", "gate-resolve", "--id", "gate_1", "--json"]);
    });
    await f.tick(); await f.tick();
    mode = "send";
    let t = await f.tick();
    expect(t.dropped_by).toEqual({ "terminal send": 1 });
    expect(calls(/^orchestration worker-list/)).toBe(1);
    expect(readFileSync(log, "utf8")).toContain("--run run_5 ");
    mode = "consume";
    t = await f.tick();
    expect(t.dropped_by).toEqual({ "orchestration check": 1 });
    expect(calls(/^orchestration worker-list/)).toBe(1);
    expect(readFileSync(log, "utf8")).toContain("--run run_9 ");
    mode = "unknown";
    t = await f.tick();
    expect(t.dropped_by).toEqual({ "terminal send": 1 });
    expect(calls(/^orchestration worker-list/)).toBe(0);
    mode = "unplaced";
    t = await f.tick();
    expect(t.dropped_by).toEqual({ "orchestration gate-resolve": 1, unplaced: 1 });
    expect(calls(/^orchestration worker-list/)).toBe(16);
    f.s.close();
  });

  test("a write to Orca that names no subject drops every kept read; a failed read is read again; DS_LOOP_RUN_READ_S=0 reads every tick", async () => {
    setup();
    const f = fixture(runs);
    await f.tick(); await f.tick();
    // a write goes out during the tick
    const w = new Loop(f.s, { observers: [{ name: "w", scope: "host", async run() { await cli(["orchestration", "gate-resolve", "--id", "gate_1", "--json"]); } }], reconcilers: [] },
      { act() {} }, { projects: () => ["p"], signals: async () => ({ terminals: readFileSync(join(data, "terminals.json"), "utf8"), unread: "" }) });
    await w.tick(T);
    expect(existsSync(join(f.s.root, "loop", "orca-keep")) ? readFileSync(join(f.s.root, "loop", "orca-keep", "state.json"), "utf8") : "").toBeTruthy();
    reset();
    const t = await f.tick();
    expect(t.runs.reread).toBe(16);
    process.env.DS_LOOP_RUN_READ_S = "0";
    try { await f.tick(); const t2 = await f.tick(); expect(t2.runs).toBeNull(); expect(calls(/^orchestration worker-list/)).toBe(16); }
    finally { delete process.env.DS_LOOP_RUN_READ_S; }
    f.s.close();
  });

  test("a Run of 300 workers in 3 pages and 16 more Runs: a steady tick stays under 1s", async () => {
    setup(); writeRun("run_big", 300);
    const f = fixture([...runs, "run_big"]);
    terminals([...runs.flatMap((r) => [0, 1].map((i) => term(r, i))), term("run_big", 0)]);
    await f.tick();
    expect(calls(/^orchestration worker-list.*--run run_big/)).toBe(3);   // three readers, three pages: each page once
    const start = performance.now();
    await f.tick(); const ms = performance.now() - start;
    expect(calls(/^orchestration worker-list/)).toBe(0);
    expect(ms).toBeLessThan(1000);
    f.s.close();
  });
});

// U252: the whole steady tick with the loop's own seat and relay steps (a real LoopActuator over the fake CLI):
// 16 seated Runs, each Lead's terminal live, no mail. Orca is asked who holds a Run only when something changed or
// its spread-out check is due; U264: a Run with no unread mail and nothing due is never peeked.
describe("a steady tick with 16 seated Runs", () => {
  const runs = Array.from({ length: 16 }, (_, i) => `run_${i + 1}`);
  const lead = (r: string) => ({ handle: `term_lead_${r}`, worktreeId: `wt_${r}_0`, connected: true, writable: true, orphaned: false, agentIdentity: "claude" });
  const mail = (msgs: unknown[]) => writeFileSync(join(data, "inbox.json"), JSON.stringify({ ok: true, result: { messages: msgs } }));
  function seated() {
    for (const r of runs) writeRun(r, 4);
    terminals(runs.flatMap((r) => [lead(r), term(r, 1)]));
    mail([]);
    const s = open(mkdtempSync(join(tmp, "s-")));
    runs.forEach((r, i) => {
      s.upsert("squads", { project: "p", topic: `t${i}` }, { status: "running", run_id: r, lead_wt: `wt_${r}_0`, observed_at: 1, updated_at: 1 });
      s.upsert("members", { project: "p", squad: `t${i}`, role: "lead", suffix: "" }, { wt: `wt_${r}_0`, status: "running", observed_at: 1, updated_at: 1 });
      s.upsert("coordinators", { project: "p", squad: `t${i}` }, { handle: `term_lead_${r}`, run_id: r, pane_key: `pane_${r}`, created_at: T, bound_at: T });
    });
    // What the Orca observer reads and leaves in the tick's facts, through the same verbs and rule.
    const observer: Observer = { name: "orca", scope: "host", async run(c) {
      const orca = shell();
      await Promise.all(runs.map(async (r) => { for (const op of ["run-workers", "worker-detail", "run-dispatches"]) await orca.run(op, [r]); }));
      const [t, u] = await Promise.all([orca.run("loop-terminals", []), orca.run("inbox-unread-all", [])]);
      if (c.facts) {
        c.facts.terminalHandles = new Set((JSON.parse(t.out).result.terminals as { handle: string }[]).map((x) => x.handle));
        c.facts.unreadRuns = coordinatorMail(s, parseUnread(u.out));
      }
    } };
    const signals = async () => {
      const orca = shell(), [t, u] = await Promise.all([orca.run("loop-terminals", []), orca.run("inbox-unread-all", [])]);
      return { terminals: t.out, unread: u.out };
    };
    const act = new LoopActuator({ orca: shell(), fulfillers: [] });
    const loop = new Loop(s, { observers: [observer], reconcilers: [] }, act, { projects: () => ["p"], signals });
    const tick = async () => { reset(); await loop.tick(T + loop.tickNo * 5); await act.drain(); return JSON.parse(readFileSync(join(s.root, "loop", "orca-spawns.json"), "utf8")); };
    return { s, tick, act };
  }

  test("a minute of steady ticks: at most 7 spawns a tick, one terminal list, at least 14 of 16 Runs kept, no peek", async () => {
    const f = seated();
    await f.tick();
    const totals: number[] = [], peeks: number[] = [], peeked = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const t = await f.tick();
      totals.push(t.total); peeks.push(calls(/^orchestration check/));
      for (const m of readFileSync(log, "utf8").matchAll(/^orchestration check .*--run (\S+)/gm)) peeked.add(m[1]);
      expect(calls(/^terminal list/)).toBeLessThanOrEqual(1);
      expect(t.runs.kept).toBeGreaterThanOrEqual(14);
      expect(Array.isArray(t.by_caller)).toBe(true);
    }
    expect(Math.max(...totals)).toBeLessThanOrEqual(7);
    expect(peeked.size).toBe(0);
    expect(Math.max(...peeks)).toBe(0);
    f.s.close();
  });

  test("new mail for one Run's coordinator is peeked the next tick; mail to its workers is not", async () => {
    const f = seated();
    await f.tick(); await f.tick();
    mail([{ id: "m1", to_handle: "dispatch:ctx_w", run_id: "run_5", read: 0, type: "ask", created_at: "2026-11-12T10:00:00Z" }]);
    await f.tick();
    expect(readFileSync(log, "utf8")).not.toContain("check --run run_5 ");
    mail([{ id: "m2", to_handle: "run:run_3", run_id: "run_3", read: 0, type: "worker_done", created_at: "2026-11-12T10:00:00Z" }]);
    const t = await f.tick();
    expect(readFileSync(log, "utf8")).toContain("check --run run_3 ");
    expect(t.by_caller).toContainEqual(expect.objectContaining({ caller: "run-inbox-peek", verb: "orchestration check" }));
    expect(t.peek_why).toEqual({ unread: 1 });                       // U264: why each peek was made
    f.s.close();
  });
});

// U252: a read shared in a tick is made once with its stderr kept apart; each caller then gets it in its own mode.
describe("a shared read and the callers' stderr modes", () => {
  test("keep, merge, pass and drop each get their own answer, a failed read included; a good read is fetched once", async () => {
    const tick = mkdtempSync(join(tmp, "tick-")), said: string[] = [];
    const ctx = { env: { ...process.env, DS_ORCA_TICK_DIR: tick } as any, out() {}, err(b: string | Uint8Array) { said.push(String(b)); }, stdin: "ignore" } as any;
    const read = ["orchestration", "worker-list", "--run", "run_missing", "--json"];
    reset();
    const [keep, merge, pass, drop] = await Promise.all((["keep", "merge", "pass", "drop"] as const).map((m) => orcaCall(ctx, read, m)));
    for (const r of [keep, merge, pass, drop]) expect(r.code).toBe(1);   // a failed read is not stored: each caller asks again
    expect(keep).toMatchObject({ out: '{"ok":false,"error":"no such run"}\n', err: "orca: no such run\n" });
    expect(merge).toMatchObject({ out: 'orca: no such run\n{"ok":false,"error":"no such run"}\n', err: "" });
    expect(pass).toMatchObject({ out: '{"ok":false,"error":"no such run"}\n', err: "" });
    expect(drop).toMatchObject({ out: '{"ok":false,"error":"no such run"}\n', err: "" });
    expect(said).toEqual(["orca: no such run\n"]);                       // only the pass caller's stderr
    writeRun("run_ok", 1);
    reset();
    const [k2, m2] = await Promise.all([orcaCall(ctx, ["orchestration", "worker-list", "--run", "run_ok", "--json"], "keep"), orcaCall(ctx, ["orchestration", "worker-list", "--run", "run_ok", "--json"], "merge")]);
    expect(k2.out).toBe(m2.out);
    expect(JSON.parse(m2.out).ok).toBe(true);
    expect(calls(/^orchestration worker-list/)).toBe(1);
    rmSync(tick, { recursive: true, force: true });
  });
});
