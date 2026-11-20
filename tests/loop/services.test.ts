// services.test.ts — U16: the web board as a service the loop runs. A `ds want board` wish starts
// bin/board/board-server.ts for the row's scope, a dead or hung server is restarted within one tick, the
// fourth restart in the window gives up with one alert, --stop stops it, a new loop adopts a healthy
// server, and a port in use leaves the row failed with the bind error. Every test works on a copy
// of tests/fixtures/loop/state in a temp dir; a server a test started is killed by its own pid.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import board, { boardUp } from "../../bin/loop/fulfil/board.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import services from "../../bin/loop/reconcilers/services.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const DS = join(ROOT, "bin", "ds");

Object.assign(process.env, { DS_BOARD_SYSTEMD: "0", DS_BIND: "127.0.0.1", DS_LOOP_BOARD_PING_MS: "400", DS_LOOP_BOARD_WAIT_MS: "8000" });

const temps: string[] = [], stores: Store[] = [], pids = new Set<number>();
afterEach(() => {
  for (const p of pids) { try { process.kill(p, "SIGCONT"); process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  pids.clear();
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzsvc-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}
// A port nothing listens on right now.
function freePort(): number {
  const srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const p = srv.port;
  srv.stop(true);
  return p;
}
const now = () => Math.floor(Date.now() / 1000);
function rig(s: Store) {
  const act = new LoopActuator({ orca: new FakeOrca(), fulfillers: [board as Fulfiller] });
  const loop = new Loop(s, { observers: [], reconcilers: [services] }, act, { projects: () => ["fx"] });
  let at = now();
  loop.boot(at);
  return {
    act,
    // One tick without waiting for the starts it began.
    begin: () => loop.tick(++at),
    // One tick, then wait for the starts it began; the row as it is then.
    tick: async () => {
      const r = await loop.tick(++at);
      await act.drain();
      const row = svc(s);
      if (row?.pid) pids.add(Number(row.pid));
      return r;
    },
  };
}
const svc = (s: Store) => s.db.query("SELECT * FROM services WHERE name = 'board' AND project = 'fx'").get() as Row | null;
const wish = (s: Store, port: number) => s.want("service", "board/fx", "running", { payload: { port }, fill: { port }, by: "test" });
const events = (s: Store, kind: string) =>
  (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[]).map((e) => JSON.parse(String(e.payload)));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid: number) { for (let i = 0; i < 50 && alive(pid); i++) await Bun.sleep(100); }
const alerts = (s: Store) => {
  const f = join(s.root, "fx", "alerts.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as { id: string; question: string }[]).filter((a) => a.id.startsWith("loop-board")) : [];
};

describe("the board service", () => {
  test("a wish starts the server: running with a pid that answers /healthz", async () => {
    const s = imported(), port = freePort(), { tick } = rig(s);
    wish(s, port);
    await tick();
    const r = svc(s)!;
    expect(r).toMatchObject({ want: "running", status: "running", port });
    expect(Number(r.pid)).toBeGreaterThan(0);
    const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    expect(h).toMatchObject({ ok: true, pid: Number(r.pid), port });
    // The board itself is served from the store's root.
    expect((await fetch(`http://127.0.0.1:${port}/board.json`)).ok).toBe(true);
    // Healthy: the next tick only moves last_ping_at.
    const t = await tick();
    expect(t.acted).toEqual([]);
    expect(svc(s)!.pid).toBe(r.pid);
  }, 30_000);

  test("a kill -9 is restarted within one tick, and so is a server that stops answering /healthz", async () => {
    const s = imported(), port = freePort(), { tick } = rig(s);
    wish(s, port);
    await tick();
    const first = Number(svc(s)!.pid);
    process.kill(first, "SIGKILL");
    await gone(first);
    await tick();
    const second = svc(s)!;
    expect(second.status).toBe("running");
    expect(Number(second.pid)).not.toBe(first);
    expect(await boardUp(port)).toBe(true);
    expect(JSON.parse(String(second.restarts))).toHaveLength(1);

    process.kill(Number(second.pid), "SIGSTOP");
    await tick();
    const third = svc(s)!;
    expect(third.status).toBe("running");
    expect(Number(third.pid)).not.toBe(Number(second.pid));
    expect(alive(Number(second.pid))).toBe(false);
    expect(await boardUp(port)).toBe(true);
    expect(events(s, "service_restarted").map((e) => e.why)).toEqual(["its process is gone", "it stopped answering /healthz"]);
  }, 60_000);

  test("a fourth restart within ten minutes raises one alert and stops retrying until the next wish", async () => {
    const s = imported(), port = freePort(), { tick } = rig(s);
    wish(s, port);
    await tick();
    for (let i = 0; i < 3; i++) {
      const pid = Number(svc(s)!.pid);
      process.kill(pid, "SIGKILL");
      await gone(pid);
      await tick();
      expect(svc(s)!.status).toBe("running");
    }
    const last = Number(svc(s)!.pid);
    process.kill(last, "SIGKILL");
    await gone(last);
    await tick();
    const r = svc(s)!;
    expect(r.status).toBe("failed");
    expect(r.pid).toBeNull();
    expect(String(r.want_result)).toMatch(/^failed: was restarted 3 times in 10 minutes/);
    expect(alerts(s)).toHaveLength(1);
    expect(alerts(s)[0].question).toMatch(/the loop stopped restarting it/);
    // No more tries, and no second alert.
    expect((await tick()).acted).toEqual([]);
    expect((await tick()).acted).toEqual([]);
    expect(alerts(s)).toHaveLength(1);
    expect(await boardUp(port)).toBe(false);
    // The next wish (another port: a change) starts it again.
    const again = freePort();
    wish(s, again);
    await tick();
    expect(svc(s)).toMatchObject({ status: "running", port: again });
  }, 90_000);

  test("--stop stops it and the row shows stopped", async () => {
    const s = imported(), port = freePort(), { tick } = rig(s);
    wish(s, port);
    await tick();
    const pid = Number(svc(s)!.pid);
    s.want("service", "board/fx", "stopped", { by: "test" });
    await tick();
    expect(svc(s)).toMatchObject({ want: "stopped", status: "stopped", pid: null });
    await gone(pid);
    expect(alive(pid)).toBe(false);
    expect((await tick()).acted).toEqual([]);
  }, 30_000);

  test("a loop restart adopts a healthy server: same pid, nothing started", async () => {
    const s = imported(), port = freePort(), one = rig(s);
    wish(s, port);
    await one.tick();
    const pid = Number(svc(s)!.pid);
    // A new loop on the same db: its actuator boots, its first ticks keep the server.
    const two = rig(s);
    await two.act.boot(s, now());
    expect((await two.tick()).acted).toEqual([]);
    expect((await two.tick()).acted).toEqual([]);
    expect(svc(s)).toMatchObject({ status: "running", pid });
    expect(await boardUp(port)).toBe(true);
  }, 30_000);

  test("a port already in use leaves the row failed with the bind error and one service_failed toast", async () => {
    const s = imported();
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("someone else", { status: 418 }) });
    try {
      process.env.DS_BOARD_BIND_TRIES = "1";
      const { tick } = rig(s);
      wish(s, holder.port);
      await tick();
      const r = svc(s)!;
      expect(r.status).toBe("failed");
      expect(r.pid).toBeNull();
      expect(String(r.result)).toMatch(/could not bind 127\.0\.0\.1:\d+/);
      expect(String(r.want_result)).toMatch(/^failed: /);
      expect((await tick()).acted).toEqual([]);
      const failed = events(s, "service_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ project: "fx", port: holder.port });
      expect(String(failed[0].error)).toMatch(/could not bind/);
    } finally {
      delete process.env.DS_BOARD_BIND_TRIES;
      holder.stop(true);
    }
  }, 30_000);

  test("a port held by another board that answers /healthz is not taken for ours: failed with the bind error", async () => {
    const s = imported();
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true, pid: 1, port: 0 }) });
    try {
      process.env.DS_BOARD_BIND_TRIES = "1";
      const { tick } = rig(s);
      wish(s, holder.port);
      await tick();
      const r = svc(s)!;
      expect(r.status).toBe("failed");
      expect(String(r.result)).toMatch(/could not bind/);
      expect(JSON.parse(String(r.restarts ?? "[]"))).toEqual([]);
      expect(events(s, "service_started")).toEqual([]);
    } finally {
      delete process.env.DS_BOARD_BIND_TRIES;
      holder.stop(true);
    }
  }, 30_000);

  test("a new port on a running board restarts it there, uncounted", async () => {
    const s = imported(), port = freePort(), { tick } = rig(s);
    wish(s, port);
    await tick();
    const first = Number(svc(s)!.pid), next = freePort();
    wish(s, next);
    // The wish is newer than the start (the rig's tick clock runs ahead of the wall clock).
    s.db.run("UPDATE services SET want_at = started_at + 1 WHERE id = ?", [Number(svc(s)!.id)]);
    await tick();
    const r = svc(s)!;
    expect(r).toMatchObject({ status: "running", port: next });
    expect(Number(r.pid)).not.toBe(first);
    expect(JSON.parse(String(r.restarts ?? "[]"))).toEqual([]);
    expect(events(s, "service_restarted").map((e) => [e.why, e.counted])).toEqual([["a new wish", false]]);
    expect(await boardUp(next)).toBe(true);
    expect(await boardUp(port)).toBe(false);
  }, 30_000);
});

describe("liveness before wishes (U76)", () => {
  // The 2026-11-03 rows: running, a dead pid, a wish one second newer than the start.
  const stale = (s: Store, port: number, o: Row = {}) => {
    wish(s, port);
    const at = now();
    s.db.run("UPDATE services SET status = 'running', pid = 2147483000, started_at = ?, want_at = ? WHERE project = 'fx'", [at - 100, at - 99]);
    for (const [k, v] of Object.entries(o)) s.db.run(`UPDATE services SET ${k} = ? WHERE project = 'fx'`, [v as string | number]);
  };

  test("a dead pid with a wish one second newer is one counted restart, and the next tick emits nothing", async () => {
    const s = imported(), port = freePort(), { tick } = rig(s);
    stale(s, port);
    const t1 = await tick();
    expect(t1.acted.length).toBe(1);
    const r = svc(s)!;
    expect(r.status).toBe("running");
    expect(JSON.parse(String(r.restarts))).toHaveLength(1);
    expect(events(s, "service_restarted").map((e) => [e.why, e.counted])).toEqual([["its process is gone", true]]);
    // The start served the wish: started_at is not older than want_at.
    expect(Number(r.started_at)).toBeGreaterThanOrEqual(Number(r.want_at));
    expect((await tick()).acted).toEqual([]);
    expect((await tick()).acted).toEqual([]);
  }, 30_000);

  test("a start served a wish written after the tick's clock: no newer wish afterwards", async () => {
    const s = imported(), port = freePort(), { tick } = rig(s);
    wish(s, port);
    s.db.run("UPDATE services SET want_at = ? WHERE project = 'fx'", [now() + 60]);
    await tick();
    const r = svc(s)!;
    expect(r.status).toBe("running");
    expect(Number(r.started_at)).toBeGreaterThanOrEqual(Number(r.want_at));
    expect((await tick()).acted).toEqual([]);
  }, 30_000);

  test("a real newer wish (another port) on a live board still restarts uncounted", async () => {
    const s = imported(), port = freePort(), { tick } = rig(s);
    wish(s, port);
    await tick();
    wish(s, freePort());
    s.db.run("UPDATE services SET want_at = started_at + 1 WHERE project = 'fx'");
    await tick();
    expect(JSON.parse(String(svc(s)!.restarts ?? "[]"))).toEqual([]);
    expect(events(s, "service_restarted").map((e) => e.why)).toEqual(["a new wish"]);
  }, 30_000);

  test("the restart cap still gives up after three, with a dead pid and a newer wish", async () => {
    const s = imported(), port = freePort(), { tick } = rig(s);
    stale(s, port);
    const at = now();
    stale(s, port, { restarts: JSON.stringify([at - 30, at - 20, at - 10]) });
    await tick();
    const r = svc(s)!;
    expect(r.status).toBe("failed");
    expect(String(r.want_result)).toMatch(/^failed: was restarted 3 times/);
    expect(alerts(s)).toHaveLength(1);
  }, 30_000);
});

describe("a start in flight", () => {
  test("failing after a newer wish replaced it does not give the newer wish up", async () => {
    const s = imported();
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("someone else", { status: 418 }) });
    try {
      process.env.DS_BOARD_BIND_TRIES = "5";
      const { act, begin, tick } = rig(s);
      wish(s, holder.port);
      await begin();                       // the server retries the bind for ~1 s
      const next = freePort();
      wish(s, next);
      await act.drain();
      const r = svc(s)!;
      expect(r.status).toBe("failed");
      expect(r.want_result).toBeNull();
      await tick();
      expect(svc(s)).toMatchObject({ status: "running", port: next });
      expect(await boardUp(next)).toBe(true);
    } finally {
      delete process.env.DS_BOARD_BIND_TRIES;
      holder.stop(true);
    }
  }, 30_000);
});

describe("ds want board", () => {
  const ds = (root: string, ...args: string[]) => {
    const p = Bun.spawnSync([DS, ...args], { env: { ...process.env, DS_STATE_ROOT: root } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  test("writes the services row and starts nothing; the same wish again is a no-op, --stop flips it", () => {
    const s = imported();
    const w = ds(s.root, "want", "board", "--project", "fx", "--port", "8799");
    expect(w.code).toBe(0);
    expect(JSON.parse(w.out)).toMatchObject({ name: "board", project: "fx", port: 8799, want: "running", changed: true });
    expect(svc(s)).toMatchObject({ want: "running", port: 8799, status: null, pid: null });
    expect(JSON.parse(ds(s.root, "want", "board", "--project", "fx").out)).toMatchObject({ port: 8799, changed: false });
    expect(JSON.parse(ds(s.root, "want", "board", "--project", "fx", "--stop").out)).toMatchObject({ want: "stopped", changed: true });
    const list = JSON.parse(ds(s.root, "services").out) as Row[];
    expect(list.map((r) => [r.name, r.project, r.want])).toEqual([["board", "fx", "stopped"]]);
    expect(ds(s.root, "want", "board", "--topic", "t").code).toBe(2);
    expect(ds(s.root, "want", "board", "--stop", "--port", "1").code).toBe(2);
  });
  test("asked again on a running row with a dead pid it re-arms the wish and says was_down; a live pid is a no-op", () => {
    const s = imported();
    ds(s.root, "want", "board", "--project", "fx", "--port", "8799");
    const at = now();
    const live = Bun.spawn(["bash", "-c", "exec -a board-server sleep 30"]);
    try {
      s.db.run("UPDATE services SET status = 'running', pid = ?, started_at = ?, want_at = ? WHERE project = 'fx'", [live.pid, at - 50, at - 50]);
      const same = JSON.parse(ds(s.root, "want", "board", "--project", "fx").out);
      expect(same).toMatchObject({ changed: false });
      expect(same.was_down).toBeUndefined();
      expect(svc(s)!.want_at).toBe(at - 50);
    } finally { live.kill("SIGKILL"); }
    s.db.run("UPDATE services SET pid = 2147483000 WHERE project = 'fx'");
    const down = JSON.parse(ds(s.root, "want", "board", "--project", "fx").out);
    expect(down).toMatchObject({ was_down: true, changed: true });
    expect(Number(svc(s)!.want_at)).toBeGreaterThan(at - 50);
  });
  test("--wait after a failed start waits for the new wish instead of reporting the old failure", () => {
    const s = imported();
    ds(s.root, "want", "board", "--project", "fx", "--port", "8799");
    s.db.run("UPDATE services SET status = 'failed', want_result = 'failed: could not bind' WHERE project = 'fx'");
    const w = ds(s.root, "want", "board", "--project", "fx", "--port", "8798", "--wait", "1");
    expect(w.code).toBe(1);
    expect(w.err).toMatch(/still wanted/);
    expect(w.err).not.toMatch(/gave up/);
  });
});
