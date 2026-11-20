// skeleton.test.ts — U3: the loop daemon's tick, plugins, timers, wake() and its health watchdog.
// Every test works on a copy of tests/fixtures/loop/state in a temp dir (a hermetic state root);
// a loop process a test starts is stopped through its own pidfile, never by name.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { load, type Action, type Actuator, type Observer, type Reconciler, type TickCtx } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import * as timers from "../../bin/loop/core/timers.ts";
import { since } from "../../bin/loop/core/events.ts";
import { pokeCap, wake } from "../../bin/loop/pause/wake.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const LOOP_SH = join(ROOT, "bin", "loop", "loop.sh");
const LOOP_TS = join(ROOT, "bin", "loop", "main.ts");
const T = 1_800_000_000;
const LEAD = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-lead-demo";
const THINKER = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-thinker-demo";

const temps: string[] = [], stores: Store[] = [], pidfiles: string[] = [];
afterEach(() => {
  for (const f of pidfiles.splice(0)) {
    const pid = Number(existsSync(f) ? readFileSync(f, "utf8").trim() : 0);
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed by the test */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(d); return d; }
function fixture(): string { const d = tmp(); cpSync(FIXTURE, d, { recursive: true }); return d; }
function store(root: string): Store { const s = open(root); stores.push(s); return s; }
function imported(): Store { const s = store(fixture()); importJson(s); return s; }
const events = (s: Store, kind: string) => since(s, 0, { kinds: [kind] });

function recorder(): Actuator & { got: Action[] } {
  const got: Action[] = [];
  return { got, act(a) { got.push(a); } };
}
function loopOf(s: Store, plugins: { observers?: Observer[]; reconcilers?: Reconciler[] }, actuator: Actuator = recorder()) {
  return new Loop(s, { observers: plugins.observers ?? [], reconcilers: plugins.reconcilers ?? [] }, actuator, { projects: () => ["fx"] });
}
function ctx(s: Store, at = T, poked = new Set<string>()): TickCtx { return { store: s, project: "fx", tick: 1, now: at, fired: [], poked }; }
function worker(s: Store, wt: string, state: string, limited: string | null = null) {
  s.upsert("observed_workers", { project: "fx", wt }, { state, limited, observed_at: T });
}

describe("tick", () => {
  test("a long batch with completed actions stays healthy, but a blocked action still becomes stale", async () => {
    const s = imported(), priorNow = process.env.DS_NOW;
    let entered!: () => void, finish!: () => void;
    const second = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const watchdog = (at: number) => {
      const p = Bun.spawnSync([process.execPath, join(ROOT, "bin/loop/core/watchdog.ts")], {
        env: { ...process.env, DS_STATE_ROOT: s.root, DS_NOW: String(at), DS_LOOP_TICK_S: "5", DS_LOOP_STALE_TICKS: "12" }, stdout: "pipe", stderr: "pipe",
      });
      expect(p.exitCode).toBe(0);
      return JSON.parse(p.stdout.toString());
    };
    s.upsert("health", { id: 1 }, { tick_at: T, tick_no: 7 });
    process.env.DS_NOW = String(T);
    const l = loopOf(s, { reconcilers: [{ name: "batch", run: () => ["first", "second"].map((subject) => ({ project: "fx", subject, kind: "poke", episode: "batch" })) }] }, {
      async act(a) {
        if (a.subject === "first") process.env.DS_NOW = String(T + 61);
        else { entered(); await held; }
      },
    });
    l.boot(T);
    const running = l.tick(T);
    try {
      await second;
      expect(watchdog(T + 61).state).toBe("fresh");
      expect(s.get("health", { id: 1 })).toMatchObject({ tick_at: T, tick_no: 7 });
      expect(watchdog(T + 122).state).toBe("stale");
      process.env.DS_NOW = String(T + 122);
      finish(); await running;
      expect(watchdog(T + 122).state).toBe("fresh");
      expect(s.get("health", { id: 1 })).toMatchObject({ tick_at: T, tick_no: 8 });
    } finally {
      finish(); await running;
      if (priorNow === undefined) delete process.env.DS_NOW; else process.env.DS_NOW = priorNow;
    }
  });

  test("observers, then reconcilers, then the actuator; health counts ticks across a reboot", async () => {
    const s = imported(), order: string[] = [];
    const act = { act(a: Action) { order.push(`act:${a.episode}`); } };
    const plugins = {
      observers: [{ name: "o", run: () => { order.push("observe"); } }],
      reconcilers: [{ name: "r", run: (c: TickCtx) => { order.push("reconcile"); return [{ project: c.project, subject: "s", kind: "k", episode: `e${c.tick}` }]; } }],
    };
    const l = loopOf(s, plugins, act);
    l.boot(T, "abc");
    await l.tick(T);
    await l.tick(T + 5);
    expect(order).toEqual(["observe", "reconcile", "act:e1", "observe", "reconcile", "act:e2"]);
    const h = s.get("health", { id: 1 }) as Row;
    expect([h.tick_no, h.tick_at, h.version, h.pid]).toEqual([2, T + 5, "abc", process.pid]);
    expect(typeof h.tick_ms).toBe("number");

    const again = loopOf(s, plugins, act);
    again.boot(T + 10);
    expect((await again.tick(T + 10)).tick).toBe(3);
  });

  test("an observer runs again only once its `every` ran out; all run on the first tick", async () => {
    const s = imported(), runs: number[] = [];
    const l = loopOf(s, { observers: [{ name: "slow", every: 30, run: (c) => { runs.push(c.now); } }] });
    l.boot(T);
    for (const at of [T, T + 5, T + 29, T + 30, T + 35]) await l.tick(at);
    expect(runs).toEqual([T, T + 30]);
  });

  test("a host-scope plugin runs once with project ''; a project one once per project", async () => {
    const s = imported(), seen: string[] = [];
    const l = new Loop(s, { observers: [{ name: "h", scope: "host", run: (c) => { seen.push(`h:${c.project}`); } }, { name: "p", run: (c) => { seen.push(`p:${c.project}`); } }], reconcilers: [] },
      recorder(), { projects: () => ["fx", "other"] });
    await l.tick(T);
    expect(seen).toEqual(["h:", "p:fx", "p:other"]);
  });

  test("each action reaches the actuator once per episode, logged as an `action` event", async () => {
    const s = imported(), act = recorder();
    let episode = "one";
    const l = loopOf(s, { reconcilers: [{ name: "r", run: (c) => [{ project: c.project, squad: "demo", subject: "x", kind: "poke", episode }] }] }, act);
    await l.tick(T);
    await l.tick(T + 5);
    episode = "two";
    await l.tick(T + 10);
    expect(act.got.map((a) => a.episode)).toEqual(["one", "two"]);
    expect(events(s, "action").map((e) => JSON.parse(String(e.payload)).episode)).toEqual(["one", "two"]);
  });

  test("a plugin that throws is a plugin_error event; the tick goes on", async () => {
    const s = imported(), act = recorder();
    const l = loopOf(s, {
      observers: [{ name: "boom", run: () => { throw new Error("kaput"); } }],
      reconcilers: [{ name: "r", run: (c) => [{ project: c.project, subject: "x", kind: "k", episode: "1" }] }],
    }, act);
    await l.tick(T);
    expect(act.got.length).toBe(1);
    expect(events(s, "plugin_error").map((e) => JSON.parse(String(e.payload)))).toEqual([{ plugin: "boom", error: "kaput" }]);
  });

  test("a tick longer than the interval logs tick_slow", async () => {
    const s = imported();
    const l = new Loop(s, { observers: [{ name: "o", run: () => Bun.sleep(30) }], reconcilers: [] }, recorder(), { tickS: 0.01, projects: () => ["fx"] });
    await l.tick(T);
    expect(events(s, "tick_slow").length).toBe(1);
  });

  test("a run of slow ticks writes one tick_slow per 10 minutes, naming the slowest step and the average", async () => {
    const s = imported();
    const l = new Loop(s, { observers: [{ name: "fast", run: () => {} }, { name: "slowpoke", run: () => Bun.sleep(15) }], reconcilers: [] },
      recorder(), { tickS: 0.005, projects: () => ["fx"] });
    for (let i = 0; i < 25; i++) await l.tick(T + i * 60); // 25 slow ticks a minute apart: 0, 10 and 20 min
    const got = events(s, "tick_slow").map((e) => JSON.parse(String(e.payload)));
    expect(got.length).toBe(3);
    expect(got.map((p) => [p.slow, p.ticks])).toEqual([[1, 1], [10, 10], [10, 10]]);
    expect(got[1].slowest.step).toBe("slowpoke:fx");
    expect(got[1].avg_ms).toBeGreaterThanOrEqual(15);
    expect(got[1].slowest.avg_ms).toBeGreaterThanOrEqual(15);
  });

  test("a burst of slow ticks followed by fast ones is still reported, once", async () => {
    const s = imported();
    let slow = true;
    const l = new Loop(s, { observers: [{ name: "o", run: () => (slow ? Bun.sleep(15) : undefined) }], reconcilers: [] },
      recorder(), { tickS: 0.01, projects: () => ["fx"] });
    await l.tick(T);                                    // the first slow tick: written at once
    await l.tick(T + 60);                               // slow, inside the 10 minutes
    slow = false;
    for (let i = 2; i <= 25; i++) await l.tick(T + i * 60); // fast from here on
    const got = events(s, "tick_slow").map((e) => JSON.parse(String(e.payload)));
    expect(got.map((p) => [p.slow, p.ticks])).toEqual([[1, 1], [1, 10]]);
  });
});

describe("timers", () => {
  test("a timer due before boot fires on the first tick, once, as a `timer` event", async () => {
    const s = imported(), seen: string[][] = [];
    timers.set(s, "late", T - 100, { why: "x" });
    timers.set(s, "later", T + 100);
    const l = loopOf(s, { observers: [{ name: "o", run: (c) => { seen.push(c.fired.map((t) => t.key)); } }] });
    l.boot(T);
    expect((await l.tick(T)).fired).toEqual(["late"]);
    expect((await l.tick(T + 5)).fired).toEqual([]);
    expect(seen[0]).toEqual(["late"]);
    expect(timers.all(s).map((t) => t.key)).toEqual(["later"]);
    expect(events(s, "timer").map((e) => JSON.parse(String(e.payload)).key)).toEqual(["late"]);
  });
});

describe("export", () => {
  test("a squad that changed is exported in the same tick; an unchanged one is not; boot rewrites nothing", async () => {
    const s = imported();
    const file = join(s.root, "fx", "squads", "demo.json");
    s.db.run("UPDATE units SET wait_until = NULL"); // Current state, without pre-upgrade capacity facts.
    writeFileSync(file, "sentinel");
    const l = loopOf(s, {});
    l.boot(T);
    expect((await l.tick(T)).exported).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("sentinel");
    s.db.run("UPDATE squads SET doc = json_set(doc, '$.goal', 'changed') WHERE project = 'fx' AND topic = 'demo'");
    const r = await l.tick(T + 5);
    expect(r.exported.length).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).goal).toBe("changed");
    expect((await l.tick(T + 10)).exported).toEqual([]);
  });

  test("a failed export is a plugin_error, still a tick in health, and is retried next tick", async () => {
    const s = imported();
    const file = join(s.root, "fx", "squads", "demo.json");
    const l = loopOf(s, {});
    l.boot(T);
    rmSync(file);
    mkdirSync(join(file, "blocker"), { recursive: true });
    s.db.run("UPDATE squads SET doc = json_set(doc, '$.goal', 'changed') WHERE project = 'fx' AND topic = 'demo'");
    expect((await l.tick(T)).exported).toEqual([]);
    expect(events(s, "plugin_error").map((e) => JSON.parse(String(e.payload)).plugin)).toEqual(["export"]);
    expect((s.get("health", { id: 1 }) as Row).tick_at).toBe(T);
    rmSync(file, { recursive: true });
    expect((await l.tick(T + 5)).exported.length).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).goal).toBe("changed");
  });
});

describe("plugins", () => {
  test("load() finds a directory's plugins in filename order and rejects one without run", async () => {
    const d = tmp();
    writeFileSync(join(d, "b.ts"), "export default { name: 'b', run() {} };");
    writeFileSync(join(d, "a.ts"), "export const name = 'a'; export function run() {}");
    writeFileSync(join(d, "notes.md"), "ignored");
    expect((await load(d)).map((p) => p.name)).toEqual(["a", "b"]);
    expect(await load(join(d, "missing"))).toEqual([]);
    const bad = tmp();
    writeFileSync(join(bad, "x.ts"), "export default { name: 'x' };");
    await expect(load(bad)).rejects.toThrow("exports no { name, run }");
  });
});

describe("wake", () => {
  test("an unknown member, an unobserved one, and a working one are busy", () => {
    const s = imported();
    expect(wake(ctx(s), "nobody", "hi", "r", "e").status).toBe("skipped:busy");
    expect(wake(ctx(s), LEAD, "hi", "r", "e").status).toBe("skipped:busy");
    worker(s, LEAD, "working");
    expect(wake(ctx(s), LEAD, "hi", "r", "e").status).toBe("skipped:busy");
    worker(s, LEAD, "idle", "1800000100\tnotice\tdialog");
    expect(wake(ctx(s), LEAD, "hi", "r", "e", { allowLimited: true }).status).toBe("skipped:busy");
    // A worker whose worktree left keeps its last row, stamped gone_at: not idle any more.
    worker(s, LEAD, "idle");
    s.upsert("observed_workers", { project: "fx", wt: LEAD }, { gone_at: T });
    expect(wake(ctx(s), LEAD, "hi", "r", "e").status).toBe("skipped:busy");
  });

  test("a limited member is skipped unless the poke is a limit-recovery one", () => {
    const s = imported();
    worker(s, LEAD, "idle", "1800000100\tusage limit");
    expect(wake(ctx(s), LEAD, "hi", "r", "e").status).toBe("skipped:limited");
    expect(wake(ctx(s), LEAD, "hi", "r", "e", { allowLimited: true }).status).toBe("sent");
    worker(s, THINKER, "idle");
    s.db.run("UPDATE members SET limited_until = ? WHERE wt = ?", [T + 60, THINKER]);
    expect(wake(ctx(s), THINKER, "hi", "r", "e").status).toBe("skipped:limited");
  });

  test("PR and ready pokes skip an all-done squad; other pokes do not", () => {
    const s = imported();
    worker(s, LEAD, "idle");
    s.db.run("UPDATE units SET status = 'done' WHERE project = 'fx' AND squad = 'demo' AND status = 'dispatched'");
    s.db.run("UPDATE units SET hold = 1 WHERE project = 'fx' AND squad = 'demo' AND status = 'planned'");
    // held planned units are open work (squad-done-definition U1): not all done, so the poke goes
    expect(wake(ctx(s), LEAD, "hi", "pr-stale", "e").status).toBe("sent");
    s.db.run("UPDATE units SET status = 'cancelled' WHERE project = 'fx' AND squad = 'demo' AND status = 'planned'");
    expect(wake(ctx(s), LEAD, "hi", "pr-stale", "e").status).toBe("skipped:all_done");
    expect(wake(ctx(s), LEAD, "hi", "ready", "e").status).toBe("skipped:all_done");
    expect(wake(ctx(s), LEAD, "hi", "all-done", "e").status).toBe("sent");
  });

  test("two wakes of one member in a tick send one poke", () => {
    const s = imported(), c = ctx(s);
    worker(s, LEAD, "idle");
    const a = wake(c, LEAD, "one", "r1", "e"), b = wake(c, LEAD, "two", "r2", "e");
    expect([a.status, b.status]).toEqual(["sent", "skipped:tick"]);
    expect(a.actions.map((x) => x.kind)).toEqual(["poke"]);
    expect(b.actions).toEqual([]);
  });

  test("CAP attempts with doubling gaps, then one alert, then nothing", () => {
    const s = imported();
    worker(s, LEAD, "idle");
    const cap = pokeCap(), sentAt: number[] = [];
    let at = T, alerts = 0;
    for (let i = 0; i < 400; i++, at += 30) {
      const w = wake(ctx(s, at), LEAD, "hi", "r", "e");
      if (w.status === "sent") sentAt.push(at);
      alerts += w.actions.filter((a) => a.kind === "alert").length;
    }
    expect(sentAt.length).toBe(cap);
    const gaps = sentAt.slice(1).map((t, i) => t - sentAt[i]);
    expect(gaps).toEqual([60, 120, 240, 480].slice(0, cap - 1));
    expect(alerts).toBe(1);
    expect(wake(ctx(s, at), LEAD, "hi", "r", "e").status).toBe("skipped:capped");
    expect(wake(ctx(s, at), LEAD, "hi", "r", "e2").status).toBe("sent");
  });
});

// The daemon and its watchdog, as processes. Each test has its own state root and HOME (no systemd
// unit there, and DS_LOOP_SYSTEMD=0), so loop.sh runs the loop detached and never touches a live one.
describe("daemon", () => {
  function env(root: string, extra: Record<string, string> = {}) {
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    // DS_NOW pins the clock, and an earlier file in the same bun process may have left it set: a real loop
    // must read the real time, or --ensure sees it as having not ticked for decades.
    return { ...process.env, DS_NOW: "", DS_STATE_ROOT: root, HOME: home, DS_LOOP_SYSTEMD: "0", DS_LOOP_TICK_S: "1", ...extra } as Record<string, string>;
  }
  function sh(root: string, extra: Record<string, string>, ...args: string[]) {
    const p = Bun.spawnSync([LOOP_SH, ...args], { env: env(root, extra), stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  }
  const pidOf = (root: string) => Number(readFileSync(join(root, "loop.pid"), "utf8").trim());
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function until(f: () => boolean, ms = 5000) {
    for (const end = Date.now() + ms; !f() && Date.now() < end;) await Bun.sleep(50);
    return f();
  }
  function health(root: string): Row | null { const s = open(root); try { return s.get("health", { id: 1 }); } finally { s.close(); } }

  test("--ensure twice leaves one loop; a second loop.ts logs the line and exits 0; a killed loop comes back with its timers", async () => {
    const root = fixture();
    pidfiles.push(join(root, "loop.pid"));
    expect(sh(root, {}, "--ensure").code).toBe(0);
    const pid = pidOf(root);
    // A loop that has not ticked yet reads as hung to --ensure (a loaded host takes seconds for a first
    // tick that runs every plugin against the real Orca CLI), so the second --ensure waits for tick 1.
    expect(await until(() => Number(health(root)?.tick_no ?? 0) >= 1, 60_000)).toBe(true);
    const again = sh(root, {}, "--ensure");
    expect(again.out).toContain(`loop: running (pid ${pid})`);
    expect(pidOf(root)).toBe(pid);

    const second = Bun.spawnSync([process.execPath, LOOP_TS], { env: env(root), stdout: "pipe" });
    expect(second.exitCode).toBe(0);
    expect(second.stdout.toString().trim()).toBe(`loop already running (pid ${pid})`);
    const s = store(root);
    expect(events(s, "loop_skip").map((e) => JSON.parse(String(e.payload)).pid)).toEqual([pid]);

    // A tick here runs every plugin against the real Orca CLI (2-3 s each on a busy host): wait for two.
    expect(await until(() => Number(health(root)?.tick_no ?? 0) >= 2, 15_000)).toBe(true);
    process.kill(pid, "SIGKILL");
    expect(await until(() => !alive(pid))).toBe(true);
    timers.set(s, "after-restart", 1);
    expect(sh(root, {}, "--ensure").code).toBe(0);
    const next = pidOf(root);
    expect(next).not.toBe(pid);
    expect(await until(() => events(s, "timer").some((e) => JSON.parse(String(e.payload)).key === "after-restart"))).toBe(true);

    expect(sh(root, {}, "--stop").code).toBe(0);
    expect(alive(next)).toBe(false);
    expect(sh(root, {}, "--status").code).toBe(3);
  }, 30_000);

  test("a live loop that boots and hangs is restarted and logged, and raises no Studio alert", async () => {
    const root = fixture();
    pidfiles.push(join(root, "loop.pid"));
    const s = store(root);
    s.upsert("health", { id: 1 }, { tick_at: 1000, started_at: 1000, tick_no: 7 });
    const hang = { DS_LOOP_HANG: "1", DS_LOOP_STALE_TICKS: "1" };
    // Wait for the hung loop's boot, then for it to go stale, then --ensure.
    async function restart(prev: number): Promise<number> {
      expect(await until(() => Number(health(root)?.pid) === prev)).toBe(true);
      expect(await until(() => Math.floor(Date.now() / 1000) - Number(health(root)?.started_at) > 1)).toBe(true);
      const r = sh(root, hang, "--ensure");
      expect(r.out).toContain("has not ticked");
      expect(alive(prev)).toBe(false);
      const next = pidOf(root);
      expect(next).not.toBe(prev);
      return next;
    }
    const stalls = () => (JSON.parse(readFileSync(join(root, "fx", "alerts.json"), "utf8")).alerts as { id: string }[])
      .map((a) => a.id).filter((id) => id.startsWith("loop-stall-"));

    expect(sh(root, hang, "--ensure").code).toBe(0);
    let pid = await restart(pidOf(root));
    pid = await restart(pid);
    expect(stalls()).toEqual([]);
    // A loop that ticked since is a new stall.
    s.upsert("health", { id: 1 }, { tick_at: 2000 });
    pid = await restart(pid);
    expect(stalls()).toEqual([]);
    expect(events(s, "loop_restart").length).toBe(3);
    sh(root, hang, "--stop");
  }, 30_000);
});
