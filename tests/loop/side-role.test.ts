// side-role.test.ts — side-loop-host U3 (issue #127, KTD7): `main.ts --role side` ticks with only the plugins
// core/side-plugins.ts names, never loads the decider and writes its observed rows into its own loop.db; the
// main loop loads what it loaded before.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DIRS, load, loadAll } from "../../bin/loop/core/plugins.ts";
import { makeSideActuator } from "../../bin/loop/core/side-actuator.ts";
import { SIDE_ONLY, SIDE_PLUGINS } from "../../bin/loop/core/side-plugins.ts";
import { open } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { mangle } from "../../bin/loop/observers/orca.ts";

const ROOT = join(import.meta.dir, "..", "..");
const LOOP_TS = join(ROOT, "bin", "loop", "main.ts");
const T = 1_800_000_000;
const tmps: string[] = [];
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "ds-side-role-"))); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

/** What keeps the side observers off this host's own folders, docker and accounts. */
const pins = (dir: string): Record<string, string> => ({
  HOME: join(dir, "home"), DS_TOKEN_DIR: join(dir, "transcripts"), DS_CLAUDE_TMP_ROOT: join(dir, "claude-tmp"),
  CODEX_HOME: join(dir, "codex"), DS_ORCA_DATA: join(dir, "orca"), DS_LOOP_DISK_S: "0",
});

const stems = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".ts")).sort().map((f) => f.slice(0, -3));
const names = async (dir: string) => (await load(dir)).map((p) => p.name);

describe("the plugins each role loads", () => {
  test("side: the named observers and nothing else", async () => {
    const got = await loadAll(DIRS, "side");
    const want: string[] = [];
    for (const f of [...SIDE_PLUGINS.observers].sort()) want.push((await import(join(DIRS.observers, `${f}.ts`))).default.name);
    expect(got.observers.map((o) => o.name)).toEqual(want);
    expect(got.reconcilers.map((r) => r.name)).toEqual([...SIDE_PLUGINS.reconcilers].sort());
    expect(SIDE_PLUGINS.fulfil).toEqual([]);
    expect(got.reconcilers.map((r) => r.name)).not.toContain("decide");
    for (const mainOnly of ["config", "documents", "github", "orca", "update"]) {
      expect(stems(DIRS.observers)).toContain(mainOnly);
      expect(SIDE_PLUGINS.observers).not.toContain(mainOnly);
    }
  });

  test("main: every observer, then the decider, the reconcilers and the fulfillers", async () => {
    const got = await loadAll();
    expect(got.observers.map((o) => o.name)).toEqual(await names(DIRS.observers));
    const mainOf = async (dir: string, skip: readonly string[]) => (await names(dir)).filter((n) => !skip.includes(n));
    expect(got.reconcilers.map((r) => r.name)).toEqual(["decide", ...await mainOf(DIRS.reconcilers, SIDE_ONLY.reconcilers), ...await mainOf(DIRS.fulfil, SIDE_ONLY.fulfil)]);
    for (const n of SIDE_ONLY.reconcilers) expect(got.reconcilers.map((r) => r.name)).not.toContain(n);
    expect((await loadAll(DIRS, "main")).reconcilers).toEqual(got.reconcilers);
  });

  test("a listed name with no file is an error, not a silently shorter loop", async () => {
    await expect(load(DIRS.observers, ["machine", "renamed-away"])).rejects.toThrow("renamed-away");
  });
});

describe("a side tick", () => {
  test("observes the members main sent down and leaves main's own steps out", async () => {
    const dir = tmp(), root = join(dir, "state"), wt = join(dir, "wt");
    mkdirSync(root); mkdirSync(wt);
    const env = pins(dir), before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    const store = open(root);
    try {
      const transcripts = join(env.DS_TOKEN_DIR!, mangle(wt));
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(join(transcripts, "s1.jsonl"), `${JSON.stringify({ type: "assistant", entrypoint: "cli", message: { model: "claude-x" } })}\n`);
      // The down copy: the project names main's Studio, off Orca, which the side must not adopt or read.
      store.upsert("projects", { label: "realp" }, { studio_wt: `local::${join(dir, "main-studio")}`, doc: JSON.stringify({ studio_backend: "tmux" }), observed_at: T });
      store.upsert("squads", { project: "realp", topic: "t" }, { status: "running", backend: "orca", doc: "{}", updated_at: T, observed_at: T });
      store.db.run("INSERT INTO members (project, squad, role, suffix, wt, status, host, updated_at, observed_at) VALUES ('realp', 't', 'builder', '', ?, 'running', 'local', ?, ?)", [`local::${wt}`, T, T]);

      // Never the real install-skills.sh: it installs into whatever login folders the env names.
      const actuator = makeSideActuator({ skills: async () => ({ ok: true }) });
      const loop = new Loop(store, await loadAll(DIRS, "side"), actuator, { role: "side" });
      loop.boot(T);
      const report = await loop.tick(T);

      expect(store.db.query("SELECT payload FROM events WHERE kind = 'plugin_error'").all()).toEqual([]);
      expect(report.actions).toEqual([]);
      expect(report.exported).toEqual([]);
      // Keyed by this machine's own name; the link rewrites it to the host's name on the way up.
      expect(store.db.query("SELECT host FROM observed_machine").all()).toEqual([{ host: hostname() }]);
      expect(store.db.query("SELECT project, wt, host, last_model FROM observed_transcripts").all())
        .toEqual([{ project: "realp", wt: `local::${wt}`, host: "local", last_model: "claude-x" }]);
      // Main's state files and snapshots: none read into rows, none written.
      expect(readdirSync(root).filter((f) => f === "realp" || f.endsWith(".tsv"))).toEqual([]);
    } finally {
      store.close();
      for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }, 30_000);
});

describe("main.ts --role side", () => {
  /** A preload that writes every loaded module's path when the process exits. */
  function recorder(dir: string): { preload: string; out: string } {
    const preload = join(dir, "record.ts"), out = join(dir, "modules.json");
    writeFileSync(preload, `import { writeFileSync } from "node:fs";\nprocess.on("exit", () => writeFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(require.cache))));\n`);
    return { preload, out };
  }
  const DECIDER = join(ROOT, "bin", "loop", "core", "decide.ts");
  const env = (root: string, dir: string) => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DS|ORCA)_/.test(k))),
    ...pins(dir), DS_STATE_ROOT: root, DS_LOOP_TICK_S: "1", DS_LOOP_CODE_WATCH: "0",
  }) as Record<string, string>;

  test("ticks an empty state root, writes its own observed rows and never loads the decider", async () => {
    const dir = tmp(), root = join(dir, "state"), { preload, out } = recorder(dir);
    mkdirSync(root);
    const p = Bun.spawn([process.execPath, "--preload", preload, LOOP_TS, "--role", "side"], { env: env(root, dir), stdout: "pipe", stderr: "pipe" });
    const read = <R>(sql: string): R | null => {
      if (!existsSync(join(root, "loop.db"))) return null;
      try {
        const db = new Database(join(root, "loop.db"), { readonly: true });
        try { return db.query(sql).get() as R | null; } finally { db.close(); }
      } catch { return null; } // not migrated yet, or busy
    };
    try {
      for (const end = Date.now() + 40_000; Date.now() < end && p.exitCode === null;) {
        if ((read<{ tick_no: number }>("SELECT tick_no FROM health WHERE id = 1")?.tick_no ?? 0) >= 2) break;
        await Bun.sleep(100);
      }
    } finally {
      p.kill("SIGTERM");
    }
    expect(await p.exited).toBe(0);
    expect(read<{ tick_no: number }>("SELECT tick_no FROM health WHERE id = 1")!.tick_no).toBeGreaterThanOrEqual(2);
    expect(read<{ host: string }>("SELECT host FROM observed_machine")).toEqual({ host: hostname() });
    expect(read<{ payload: string }>("SELECT payload FROM events WHERE kind IN ('plugin_error', 'tick_error', 'action')")).toBeNull();
    const modules = JSON.parse(readFileSync(out, "utf8")) as string[];
    expect(modules).toContain(join(ROOT, "bin", "loop", "observers", "machine.ts"));
    expect(modules).not.toContain(DECIDER);
    expect(existsSync(join(root, "squads"))).toBe(false);
  }, 60_000);

  test("the record does see the decider when a main loop's plugins load", async () => {
    const dir = tmp(), { preload, out } = recorder(dir), main = join(dir, "main-plugins.ts");
    writeFileSync(main, `import { loadAll } from ${JSON.stringify(join(ROOT, "bin", "loop", "core", "plugins.ts"))};\nawait loadAll();\nprocess.exit(0);\n`);
    const p = Bun.spawnSync([process.execPath, "--preload", preload, main], { env: env(dir, dir) });
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8"))).toContain(DECIDER);
  }, 30_000);

  test("an unknown role is refused before anything runs", () => {
    const dir = tmp(), root = join(dir, "state");
    for (const args of [["--role", "sideways"], ["--role"], ["side"]]) {
      const p = Bun.spawnSync([process.execPath, LOOP_TS, ...args], { env: env(root, dir) });
      expect(p.exitCode).toBe(2);
      expect(p.stderr.toString()).toContain("usage: main.ts [--role main|side]");
    }
    expect(existsSync(root)).toBe(false);
  });
});
