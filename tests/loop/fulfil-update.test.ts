// fulfil-update.test.ts — board-actions-as-wishes U1: the `update` request (`ds update <project>`), its fulfiller
// (bin/loop/fulfil/update.ts) and its job (bin/commands/update-run.ts). Fake update-host and update-squads
// scripts (DS_UPDATE_HOST_SH, DS_UPDATE_SQUADS_SH) stand in for the real ones; nothing touches the checkout.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { systemdArgv, update, type UpdateOpts } from "../../bin/loop/fulfil/update.ts";
import { parseHost, parseSquads } from "../../bin/commands/update-run.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [], pids: number[] = [];
const saved = { host: process.env.DS_UPDATE_HOST_SH, squads: process.env.DS_UPDATE_SQUADS_SH };
let dir = "";

function script(name: string, body: string): string {
  const f = join(dir, name);
  writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}
// The fake update-host prints FAKE_HOST_LINE after FAKE_HOST_SLEEP seconds and exits FAKE_HOST_RC; the fake
// update-squads leaves a marker file and prints FAKE_SQUADS_LINE.
function fakes(): { marker: string } {
  const marker = join(dir, "squads-ran");
  process.env.DS_UPDATE_HOST_SH = script("update-host.sh", [
    'echo "update: WARNING example warning"',
    'sleep "${FAKE_HOST_SLEEP:-0}"',
    'echo "${FAKE_HOST_LINE:-DS-UPDATE: advanced aaaaaaa -> bbbbbbb}"',
    'exit "${FAKE_HOST_RC:-0}"'].join("\n"));
  process.env.DS_UPDATE_SQUADS_SH = script("update-squads.sh", [
    `echo "$@" > ${JSON.stringify(marker)}`,
    'echo "${FAKE_SQUADS_LINE:-update-squads: [fx] reload — instructions — 2 wish(es)}"'].join("\n"));
  return { marker };
}

beforeEach(() => {
  dir = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "zzup-"));
  temps.push(dir);
  for (const k of ["FAKE_HOST_SLEEP", "FAKE_HOST_LINE", "FAKE_HOST_RC", "FAKE_SQUADS_LINE"]) delete process.env[k];
});
afterEach(() => {
  for (const p of pids.splice(0)) { try { process.kill(-p, "SIGKILL"); } catch { /* gone */ } }
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const [k, v] of [["DS_UPDATE_HOST_SH", saved.host], ["DS_UPDATE_SQUADS_SH", saved.squads]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function rig(root: string, opts: UpdateOpts = {}) {
  const s = open(root);
  stores.push(s);
  const f = update({ inService: () => false, ...opts });
  const act = new LoopActuator({ orca: new FakeOrca(), fulfillers: [f] });
  const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  return { s, tick };
}
const file = (s: Store, project = "fx") => Number(s.requestAny("update", { by: "test" }, { project, by: "test" }).row.id);
const request = (s: Store, id: number) => {
  const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) } as Record<string, any>;
};
const runs = (s: Store) => (s.db.query("SELECT project, payload FROM events WHERE kind = 'update_run' ORDER BY id").all() as Row[])
  .map((r) => ({ project: r.project, ...JSON.parse(String(r.payload)) }));

// Fake time moves 5 s a tick; the job runs in real time, so each tick also waits a little.
async function until(tick: (at: number) => Promise<void>, ok: () => boolean, from = T, ms = 15_000): Promise<number> {
  let at = from;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await tick(at);
    if (ok()) return at;
    at += 5;
    await Bun.sleep(100);
  }
  throw new Error("timed out");
}
const pidOf = (s: Store, id: number) => Number(request(s, id).pid);

describe("update request: a full run", () => {
  test("advanced pull, then update-squads --auto: done with both lines and one event", async () => {
    const { marker } = fakes();
    const root = join(dir, "state");
    const { s, tick } = rig(root);
    const id = file(s);
    await until(tick, () => request(s, id).done);
    const r = request(s, id);
    pids.push(r.pid);
    expect(r.ok).toBe(true);
    expect(r.state).toBe("done");
    expect(r.line).toBe("DS-UPDATE: advanced aaaaaaa -> bbbbbbb");
    expect(r.outcome).toBe("advanced");
    expect(r.warnings).toEqual(["update: WARNING example warning"]);
    expect(r.squads_line).toBe("update-squads: [fx] reload — instructions — 2 wish(es)");
    expect(r.need).toBe("reload");
    expect(r.classes).toEqual(["instructions"]);
    expect(readFileSync(marker, "utf8").trim()).toBe("fx --auto");
    expect(readFileSync(r.log, "utf8")).toContain("DS-UPDATE: advanced");
    expect(runs(s)).toEqual([{ project: "fx", id, outcome: "advanced", need: "reload", by: "test", line: r.line }]);
  });

  test("a refused pull fails the request with its line and never runs update-squads", async () => {
    const { marker } = fakes();
    process.env.FAKE_HOST_LINE = "DS-UPDATE: refused — the checkout has local changes";
    process.env.FAKE_HOST_RC = "1";
    const { s, tick } = rig(join(dir, "state"));
    const id = file(s);
    await until(tick, () => request(s, id).done);
    const r = request(s, id);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("DS-UPDATE: refused — the checkout has local changes");
    expect(existsSync(marker)).toBe(false);
    expect(runs(s).map((e) => e.outcome)).toEqual(["failed"]);
  });

  test("a setsid job outlives the loop that started it; a fresh loop finishes the request", async () => {
    fakes();
    process.env.FAKE_HOST_SLEEP = "2";
    const root = join(dir, "state");
    mkdirSync(root, { recursive: true });
    const seed = open(root);
    const id = file(seed);
    seed.close();
    const launcher = join(dir, "launcher.ts");
    writeFileSync(launcher, [
      `import { LoopActuator } from ${JSON.stringify(join(ROOT, "bin/loop/core/actuator.ts"))};`,
      `import { FakeBackend } from ${JSON.stringify(join(ROOT, "bin/loop/fakes/orca.ts"))};`,
      `import { update } from ${JSON.stringify(join(ROOT, "bin/loop/fulfil/update.ts"))};`,
      `import { open } from ${JSON.stringify(join(ROOT, "bin/loop/core/store.ts"))};`,
      `import { Loop } from ${JSON.stringify(join(ROOT, "bin/loop/core/tick.ts"))};`,
      `const s = open(${JSON.stringify(root)});`,
      `const f = update({ inService: () => false });`,
      `const act = new LoopActuator({ orca: new FakeBackend(), fulfillers: [f] });`,
      `const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });`,
      `loop.boot(${T}); await loop.tick(${T}); await act.drain();`,
      `console.log("launched"); await Bun.sleep(60_000);`].join("\n"));
    const p = Bun.spawn([process.execPath, launcher], { stdout: "pipe", stderr: "inherit", env: process.env as Record<string, string> });
    const reader = p.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("launched");
    p.kill("SIGKILL");
    await p.exited;

    const { s, tick } = rig(root);
    expect(request(s, id).state).not.toBe("waiting");
    pids.push(pidOf(s, id));
    await until(tick, () => request(s, id).done, T + 5);
    expect(request(s, id)).toMatchObject({ ok: true, state: "done", outcome: "advanced", need: "reload" });
  });

  test("a job killed mid-run ends lost", async () => {
    fakes();
    process.env.FAKE_HOST_SLEEP = "30";
    const { s, tick } = rig(join(dir, "state"));
    const id = file(s);
    const at = await until(tick, () => request(s, id).state === "pulling");
    const pid = pidOf(s, id);
    process.kill(-pid, "SIGKILL");
    await Bun.sleep(200);
    await until(tick, () => request(s, id).done, at + 5);
    const r = request(s, id);
    expect(r.ok).toBe(false);
    expect(r.error).toStartWith("lost: the update job ended with no result");
  });
});

describe("update request: the fulfiller's rules", () => {
  test("a job past update_run_max_min is stopped, then the request fails", async () => {
    let launched = 0;
    const stopped: unknown[] = [];
    const { s, tick } = rig(join(dir, "state"), {
      live: () => true, launch: () => { launched++; return { unit: null, pid: 4242 }; }, alive: () => true, stop: (rec) => { stopped.push(rec.pid); },
    });
    const id = file(s);
    await tick(T);
    expect(request(s, id)).toMatchObject({ done: false, state: "starting", pid: 4242 });
    await tick(T + 19 * 60);
    expect(request(s, id).done).toBe(false);
    await tick(T + 21 * 60);
    expect(stopped).toEqual([4242]);
    expect(launched).toBe(1);
    expect(request(s, id).ok).toBe(false);
    expect(request(s, id).error).toStartWith("timeout: the update job ran past 20 min");
  });

  test("a live host-update.hold keeps the request waiting and launches nothing", async () => {
    let launched = 0;
    const root = join(dir, "state");
    const { s, tick } = rig(root, { live: () => true, launch: () => { launched++; return { unit: null, pid: 1 }; } });
    mkdirSync(join(root, "loop"), { recursive: true });
    writeFileSync(join(root, "loop", "host-update.hold"), JSON.stringify({ pid: process.pid }));
    const id = file(s);
    await tick(T);
    await tick(T + 10);
    expect(launched).toBe(0);
    expect(request(s, id)).toMatchObject({ done: false, state: "waiting" });
    expect(request(s, id).why).toContain("host-update.hold");
  });

  test("off the live root with no fake scripts, the request fails and no job or log is made", async () => {
    delete process.env.DS_UPDATE_HOST_SH;
    delete process.env.DS_UPDATE_SQUADS_SH;
    let launched = 0;
    const root = join(dir, "state");
    const { s, tick } = rig(root, { live: () => false, launch: () => { launched++; return { unit: null, pid: 1 }; } });
    const id = file(s);
    await tick(T);
    expect(launched).toBe(0);
    expect(request(s, id)).toMatchObject({ done: true, ok: false, error: "not the live state root" });
    expect(existsSync(join(root, "loop", "update"))).toBe(false);
  });

  test("a request already starting is watched after a restart, never launched again", async () => {
    let launched = 0;
    const { s, tick } = rig(join(dir, "state"), { live: () => true, launch: () => { launched++; return { unit: null, pid: 1 }; }, alive: () => false });
    const id = file(s);
    s.upsert("requests", { id }, { result: JSON.stringify({ state: "starting", log: join(dir, "x.log"), out: join(dir, "x.json"), unit: null, pid: null, started_at: T }) });
    await tick(T + 5);
    expect(launched).toBe(0);
    expect(request(s, id).done).toBe(false);
    await tick(T + 70);
    expect(launched).toBe(0);
    expect(request(s, id)).toMatchObject({ done: true, ok: false });
  });

  test("a second project's update waits for the first", async () => {
    let launched = 0;
    const { s, tick } = rig(join(dir, "state"), { live: () => true, launch: () => { launched++; return { unit: null, pid: 1 }; }, alive: () => true });
    const a = file(s, "fx");
    const b = file(s, "fy");
    await tick(T);
    expect(launched).toBe(1);
    expect(request(s, a).state).toBe("starting");
    expect(request(s, b)).toMatchObject({ state: "waiting", why: `update #${a} runs first` });
  });

  test("the systemd argv carries the unit name, the env and the log", () => {
    const argv = systemdArgv({ id: 7, project: "fx", root: "/s", log: "/s/loop/update/7.log", out: "/s/loop/update/7.json",
      env: { DS_STATE_ROOT: "/s", PATH: "/bin", HOME: "/h", ORCA_USER_DATA_PATH: "/o", SECRET: "x" } });
    expect(argv.slice(0, 4)).toEqual(["systemd-run", "--user", "--collect", "--quiet"]);
    expect(argv).toContain("--unit=ds-update-7");
    expect(argv).toContain("--setenv=DS_STATE_ROOT=/s");
    expect(argv).toContain("--setenv=PATH=/bin");
    expect(argv).toContain("--setenv=HOME=/h");
    expect(argv).toContain("--setenv=ORCA_USER_DATA_PATH=/o");
    expect(argv).toContain("--property=StandardOutput=append:/s/loop/update/7.log");
    expect(argv.join(" ")).not.toContain("SECRET");
    expect(argv.slice(-3)).toEqual(["update-run", "7", "fx"]);
  });
});

describe("update-run's parsers", () => {
  test("update-host lines", () => {
    expect(parseHost("x\nupdate: repair: relinked\nDS-UPDATE: already current (abc1234) — nothing new\n"))
      .toEqual({ line: "DS-UPDATE: already current (abc1234) — nothing new", outcome: "already current", warnings: ["update: repair: relinked"] });
    expect(parseHost("boom\n")).toEqual({ line: undefined, outcome: undefined, warnings: [] });
  });
  test("update-squads summaries", () => {
    expect(parseSquads("update-squads: [fx] restart — loop, instructions — roles: lead — 3 wish(es) (one a reload of the Studio)"))
      .toMatchObject({ need: "restart", classes: ["loop", "instructions"] });
    expect(parseSquads("update-squads: [fx] none — none — 0 wish(es)")).toMatchObject({ need: "none", classes: [] });
    expect(parseSquads("update-squads: [fx] squads already on abcd1234")).toMatchObject({ need: "none", classes: [] });
    expect(parseSquads("nothing")).toEqual({});
  });
});

describe("ds update", () => {
  test("files one request per project and refuses a second while it is open", () => {
    const root = join(dir, "state");
    const env = { ...process.env, DS_STATE_ROOT: root } as Record<string, string>;
    const ds = (...a: string[]) => Bun.spawnSync([join(ROOT, "bin", "ds"), "update", ...a], { env, stdout: "pipe", stderr: "pipe" });
    const one = ds("fx");
    expect(one.exitCode).toBe(0);
    expect(JSON.parse(one.stdout.toString())).toMatchObject({ kind: "update", project: "fx" });
    const two = ds("fx");
    expect(two.exitCode).toBe(1);
    expect(two.stderr.toString()).toContain("already has an update open");
    expect(ds("fy").exitCode).toBe(0);
  });
});
