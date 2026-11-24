// chat-multiline-send-fails U1: the loop restarts itself on new code (bin/loop/core/code-watch.ts, main.ts).
// The spawned loops run on a temp state root against a temp git repo (DS_LOOP_CODE_ROOT), with a fake
// orca CLI and a temp HOME, so nothing reaches the host.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeWatch, codeWatchOn, headRev, isLoopCode, loopCodeChanges } from "../../bin/loop/core/code-watch.ts";

const MAIN = join(import.meta.dir, "..", "..", "bin", "loop", "main.ts");
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `code-restart-${name}-`));
  dirs.push(d);
  return d;
}

function git(repo: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", HOME: repo, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(repo: string, files: Record<string, string>, msg = "c"): string {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

function repo(): string {
  const r = tmp("repo");
  git(r, "init", "-q", "-b", "main");
  commit(r, { "bin/loop/x.ts": "export const x = 1;\n", "docs/a.md": "a\n" });
  return r;
}

describe("code-watch", () => {
  test("loop code is bin .ts and migrations, never tests or fakes", () => {
    expect(isLoopCode("bin/loop/x.ts")).toBe(true);
    expect(isLoopCode("bin/board/board-data.ts")).toBe(true);
    expect(isLoopCode("bin/loop/migrations/0060-x.sql")).toBe(true);
    expect(isLoopCode("bin/loop/x.test.ts")).toBe(false);
    expect(isLoopCode("bin/loop/fakes/orca.ts")).toBe(false);
    expect(isLoopCode("bin/loop/loop.sh")).toBe(false);
    expect(isLoopCode("web/board.html")).toBe(false);
    expect(isLoopCode("docs/a.md")).toBe(false);
    expect(isLoopCode("tests/loop/x.ts")).toBe(false);
  });

  test("on only for the live root unless forced", () => {
    expect(codeWatchOn("/r/state", "/r", {})).toBe(true);
    expect(codeWatchOn("/r/state/", "/r", {})).toBe(true);
    expect(codeWatchOn("/tmp/x/state", "/r", {})).toBe(false);
    expect(codeWatchOn("/tmp/x/state", "/r", { DS_LOOP_CODE_WATCH: "1" })).toBe(true);
    expect(codeWatchOn("/r/state", "/r", { DS_LOOP_CODE_WATCH: "0" })).toBe(false);
  });

  test("adopts a docs-only move, restarts on loop code, skips a failed read", () => {
    const r = repo(), boot = headRev(r)!;
    const w = new CodeWatch(r, boot, 10, 0);
    expect(w.check(5)).toBeNull();                       // not due yet
    expect(w.check(20)).toEqual({ kind: "same" });
    const docs = commit(r, { "docs/a.md": "b\n", "bin/loop/x.test.ts": "t\n", "bin/loop/fakes/f.ts": "f\n" });
    expect(w.check(40)).toEqual({ kind: "adopt", from: boot, to: docs });
    expect(w.rev).toBe(docs);
    const code = commit(r, { "bin/loop/x.ts": "export const x = 2;\n", "bin/loop/migrations/0099-y.sql": "-- y\n" });
    expect(w.check(60)).toEqual({ kind: "restart", from: docs, to: code, files: ["bin/loop/migrations/0099-y.sql", "bin/loop/x.ts"] });
    expect(w.rev).toBe(docs);                            // a restart leaves the running rev alone
    expect(loopCodeChanges(r, boot, code)).toEqual(["bin/loop/migrations/0099-y.sql", "bin/loop/x.ts"]);
    // A commit git no longer knows: the diff fails, the check skips and nothing changes.
    const lost = new CodeWatch(r, "0".repeat(40), 10, 0);
    expect(lost.check(20)).toEqual({ kind: "skip", why: "diff failed" });
    expect(new CodeWatch(tmp("norepo"), boot, 10, 0).check(20)).toEqual({ kind: "skip", why: "HEAD unreadable" });
  });
});

// --- the loop itself ---------------------------------------------------------------------------------

function fakeOrca(): string {
  const d = tmp("orca");
  writeFileSync(join(d, "orca"), "#!/bin/sh\necho '{}'\nexit 0\n");
  chmodSync(join(d, "orca"), 0o755);
  return d;
}

function spawnLoop(code: string, watch: "0" | "1") {
  const state = join(tmp("state"), "state"), home = tmp("home");
  mkdirSync(state, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(DS_|ORCA_)/.test(k)) env[k] = v;
  if (process.env.DS_LOOP_DB_TEMPLATE) env.DS_LOOP_DB_TEMPLATE = process.env.DS_LOOP_DB_TEMPLATE;
  Object.assign(env, {
    HOME: home, DS_STATE_ROOT: state, DS_ORCA_CLI_BIN_DIR: fakeOrca(),
    DS_LOOP_TICK_S: "0.3", DS_LOOP_UPDATE_S: "0", DS_LOOP_CODE_ROOT: code, DS_LOOP_CODE_WATCH: watch, DS_LOOP_CODE_CHECK_MS: "200",
  });
  const p = Bun.spawn([process.execPath, MAIN], { env, stdout: "ignore", stderr: "ignore" });
  const db = () => new Database(join(state, "loop.db"), { readonly: true });
  const read = <T>(f: (d: Database) => T): T | null => {
    if (!existsSync(join(state, "loop.db"))) return null;
    const d = db();
    try { return f(d); } catch { return null; } finally { d.close(); }
  };
  const tickNo = () => Number(read((d) => (d.query("SELECT tick_no FROM health WHERE id = 1 AND pid = ?").get(p.pid) as { tick_no: number } | null)?.tick_no) ?? 0);
  const events = () => read((d) => d.query("SELECT payload FROM events WHERE kind = 'loop_code_changed'").all() as { payload: string }[]) ?? [];
  return { p, state, tickNo, events };
}

async function until(what: string, f: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

describe("main.ts", () => {
  test("a docs or test commit restarts nothing; a loop-code commit exits 75 with one event", async () => {
    const r = repo(), from = headRev(r)!;
    const l = spawnLoop(r, "1");
    try {
      await until("the first tick", () => l.tickNo() >= 1);
      commit(r, { "docs/a.md": "b\n" });
      commit(r, { "bin/loop/x.test.ts": "t\n" });
      const docs = headRev(r)!;
      const at = l.tickNo();
      await until("ticks after the docs and test commits", () => l.tickNo() >= at + 4);
      expect(l.p.exitCode).toBeNull();
      expect(l.events()).toEqual([]);
      const to = commit(r, { "bin/loop/x.ts": "export const x = 2;\n" });
      expect(await Promise.race([l.p.exited, Bun.sleep(20_000).then(() => "still running")])).toBe(75);
      const ev = l.events();
      expect(ev.length).toBe(1);
      expect(JSON.parse(ev[0].payload)).toEqual({ from_rev: docs, to_rev: to, files: ["bin/loop/x.ts"], count: 1 });
      expect(docs).not.toBe(from);
      expect(existsSync(join(l.state, "loop.pid"))).toBe(false);
    } finally { l.p.kill(); await l.p.exited; }
  }, 90_000);

  test("DS_LOOP_CODE_WATCH=0 keeps ticking on new loop code", async () => {
    const r = repo();
    const l = spawnLoop(r, "0");
    try {
      await until("the first tick", () => l.tickNo() >= 1);
      commit(r, { "bin/loop/x.ts": "export const x = 3;\n" });
      const at = l.tickNo();
      await until("ticks after the loop-code commit", () => l.tickNo() >= at + 4);
      expect(l.p.exitCode).toBeNull();
      expect(l.events()).toEqual([]);
    } finally { l.p.kill(); await l.p.exited; }
  }, 90_000);
});
