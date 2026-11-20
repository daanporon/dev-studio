// tidy.test.ts — host-disk-cleanup U1: the shared cleanup safety module (bin/loop/io/tidy.ts) on fixture
// roots. A fake /proc tree drives matching; the only real processes signalled are ones this test spawned,
// and nothing is removed outside this test's own temp dir.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTmpDir, inUse, procsUnder, removeGuarded, runOnClose, stopProcs, streamDir, trimGlobBatch, type DirReader } from "../../bin/loop/io/tidy.ts";

const UID = process.getuid!();
const temps: string[] = [], spawned: number[] = [];
afterEach(() => {
  for (const pid of spawned.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "tidy-")); temps.push(d); return d; };

// A fake /proc: btime 1000; each process has stat, status (uid), statm, a cwd link and fd links.
type FP = { pid: number; ppid?: number; pgrp?: number; start?: number; uid?: number; cwd?: string; fds?: string[]; state?: string };
function fakeProc(procs: FP[]): string {
  const root = join(tmp(), "proc");
  mkdirSync(root);
  writeFileSync(join(root, "stat"), "cpu 0 0 0\nbtime 1000\n");
  for (const p of procs) setProc(root, p);
  return root;
}
function setProc(root: string, p: FP): void {
  const d = join(root, String(p.pid));
  rmSync(d, { recursive: true, force: true });
  mkdirSync(join(d, "fd"), { recursive: true });
  const f = [p.state ?? "S", p.ppid ?? 1, p.pgrp ?? p.pid, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, p.start ?? 500];
  writeFileSync(join(d, "stat"), `${p.pid} (x) ${f.join(" ")}\n`);
  writeFileSync(join(d, "statm"), "100 25 0\n");
  writeFileSync(join(d, "status"), `Name:\tx\nUid:\t${p.uid ?? UID}\t${p.uid ?? UID}\t${p.uid ?? UID}\t${p.uid ?? UID}\n`);
  if (p.cwd) symlinkSync(p.cwd, join(d, "cwd"));
  (p.fds ?? []).forEach((t, i) => symlinkSync(t, join(d, "fd", String(i + 3))));
}
const pids = (r: { pid: number }[]) => r.map((p) => p.pid);

describe("procsUnder (KTD7)", () => {
  test("cwd inside the worktree matches; a sibling ds-x-2 does not (the prefix needs a /)", () => {
    const proc = fakeProc([{ pid: 10, cwd: "/w/ds-x" }, { pid: 11, cwd: "/w/ds-x/sub" }, { pid: 12, cwd: "/w/ds-x-2" }, { pid: 13, cwd: "/w/ds-x (deleted)" }]);
    expect(pids(procsUnder("/w/ds-x", { proc, self: 999 }).procs)).toEqual([10, 11, 13]);
  });
  test("a descendant with its cwd elsewhere matches; the loop's own pid, its ancestors and descendants never", () => {
    const proc = fakeProc([
      { pid: 2, ppid: 1, cwd: "/w/ds-x" },                // ancestor of the loop
      { pid: 3, ppid: 2, cwd: "/w/ds-x" },                // the loop
      { pid: 4, ppid: 3, cwd: "/w/ds-x" },                // the loop's child
      { pid: 20, ppid: 1, cwd: "/w/ds-x" }, { pid: 21, ppid: 20, cwd: "/elsewhere" }, { pid: 22, ppid: 21, cwd: "/elsewhere" },
    ]);
    expect(pids(procsUnder("/w/ds-x", { proc, self: 3 }).procs)).toEqual([20, 21, 22]);
  });
  test("a process under a live agent is spared; an agent whose start time differs is not trusted", () => {
    const proc = fakeProc([{ pid: 30, ppid: 1, start: 500, cwd: "/home" }, { pid: 31, ppid: 30, cwd: "/w/ds-x" }]);
    // started_at = btime 1000 + 500 ticks / 100 = 1005
    const r = procsUnder("/w/ds-x", { proc, self: 999, agents: [{ pid: 30, started_at: 1005 }] });
    expect([pids(r.procs), pids(r.spared)]).toEqual([[], [31]]);
    expect(pids(procsUnder("/w/ds-x", { proc, self: 999, agents: [{ pid: 30, started_at: 2000 }] }).procs)).toEqual([31]);
  });
  test("another uid's process and a zombie never match", () => {
    const proc = fakeProc([{ pid: 40, uid: UID + 1, cwd: "/w/ds-x" }, { pid: 41, state: "Z", cwd: "/w/ds-x" }]);
    expect(procsUnder("/w/ds-x", { proc, self: 999 }).procs).toEqual([]);
  });
  test("members of a named process group match wherever they run", () => {
    const proc = fakeProc([{ pid: 50, pgrp: 50, cwd: "/elsewhere" }, { pid: 51, pgrp: 77, cwd: "/elsewhere" }]);
    expect(pids(procsUnder("/w/ds-x", { proc, self: 999, groups: [50] }).procs)).toEqual([50]);
  });
});

describe("stopProcs", () => {
  test("a fixture /proc never reaches process.kill without an injected kill", async () => {
    const proc = fakeProc([{ pid: 60, cwd: "/w/ds-x" }]);
    await expect(stopProcs(procsUnder("/w/ds-x", { proc, self: 999 }).procs, { proc })).rejects.toThrow("injected kill");
  });
  test("a pid whose start time changed between match and signal is not signalled", async () => {
    const proc = fakeProc([{ pid: 61, cwd: "/w/ds-x", start: 500 }, { pid: 62, cwd: "/w/ds-x", start: 500 }]);
    const list = procsUnder("/w/ds-x", { proc, self: 999 }).procs;
    setProc(proc, { pid: 62, cwd: "/w/ds-x", start: 900 });   // pid reused
    const sent: [number, string][] = [];
    const r = await stopProcs(list, { proc, waitMs: 0, kill: (pid, sig) => { sent.push([pid, sig]); } });
    expect(sent).toEqual([[61, "SIGTERM"], [61, "SIGKILL"]]);
    expect(pids(r.stopped)).toEqual([61]);
  });
  test("real children in a temp worktree: TERM ends one; one that ignores TERM is KILLed after the wait", async () => {
    const wt = join(tmp(), "ds-p-x"); mkdirSync(wt);
    const plain = Bun.spawn(["sleep", "30"], { cwd: wt });
    const stubborn = Bun.spawn(["bash", "-c", "trap '' TERM; echo ready; while :; do sleep 0.05; done"], { cwd: wt, stdout: "pipe" });
    spawned.push(plain.pid, stubborn.pid);
    await stubborn.stdout.getReader().read();   // the trap is set
    const found = procsUnder(wt, { self: -1 }).procs.filter((p) => [plain.pid, stubborn.pid].includes(p.pid));
    expect(pids(found).sort()).toEqual([plain.pid, stubborn.pid].sort());
    const r = await stopProcs(found, { waitMs: 300 });
    await Promise.all([plain.exited, stubborn.exited]);
    expect([plain.signalCode, stubborn.signalCode]).toEqual(["SIGTERM", "SIGKILL"]);
    expect(r.killed).toEqual([stubborn.pid]);
  });
});

describe("claudeTmpDir, inUse, removeGuarded (KTD15)", () => {
  test("claudeTmpDir mangles the worktree path under the root", () => {
    expect(claudeTmpDir("/home/u/ws/ds-p-x", "/r")).toBe("/r/-home-u-ws-ds-p-x");
  });
  test("removed with its size; kept when a process has its cwd or an open file under it", async () => {
    const root = tmp(), dir = join(root, "-w-ds-x");
    mkdirSync(join(dir, "s1"), { recursive: true }); writeFileSync(join(dir, "s1", "f"), "x".repeat(10_000));
    const byCwd = inUse(fakeProc([{ pid: 70, cwd: join(dir, "s1") }]));
    expect(await removeGuarded(dir, { root, inUse: byCwd })).toEqual({ removed: false, reason: "in use by pid 70" });
    const byFd = inUse(fakeProc([{ pid: 71, cwd: "/", fds: ["pipe:[1]", join(dir, "s1", "f")] }]));
    expect(await removeGuarded(dir, { root, inUse: byFd })).toEqual({ removed: false, reason: "in use by pid 71" });
    const r = await removeGuarded(dir, { root, inUse: inUse(fakeProc([{ pid: 72, cwd: `${dir}-2` }])) });
    expect(r.removed).toBe(true);
    expect((r as { kb: number }).kb).toBeGreaterThan(0);
    expect(existsSync(dir)).toBe(false);
  });
  test("a symlink is not followed and not removed; a path outside the root is kept; the age floor keeps a new tree", async () => {
    const root = tmp(), target = join(tmp(), "target"), link = join(root, "-w-ds-x");
    mkdirSync(target); writeFileSync(join(target, "keep"), "k"); symlinkSync(target, link);
    const none = inUse(fakeProc([]));
    expect(await removeGuarded(link, { root, inUse: none })).toEqual({ removed: false, reason: "symlink" });
    expect(existsSync(join(target, "keep"))).toBe(true);
    expect(await removeGuarded(target, { root, inUse: none })).toEqual({ removed: false, reason: "outside its root" });
    const dir = join(root, "-w-ds-y"); mkdirSync(dir);
    expect(await removeGuarded(dir, { root, inUse: none, ageFloorS: 3600 })).toEqual({ removed: false, reason: "too new" });
    expect(await removeGuarded(dir, { root, inUse: none, ageFloorS: 3600, now: Date.now() / 1000 + 7200 })).toMatchObject({ removed: true });
    expect(await removeGuarded(dir, { root, inUse: none })).toEqual({ removed: false, reason: "gone" });
  });
});

describe("runOnClose", () => {
  test("a command that backgrounds a sleeper and exits 0 returns at once with its group id", async () => {
    const wt = tmp(), log = join(wt, "logs", "c.log");
    const r = await runOnClose("sleep 600 & echo started", wt, {}, log, 20, 200);
    expect([r.code, r.timedOut]).toEqual([0, false]);
    expect(r.ms).toBeLessThan(5000);
    const left = procsUnder(wt, { self: -1, groups: [r.pgid!] }).procs;
    expect(left.length).toBe(1);
    spawned.push(...pids(left));
    await stopProcs(left, { waitMs: 300 });
    expect(procsUnder(wt, { self: -1, groups: [r.pgid!] }).procs).toEqual([]);
  });
  test("a command that hangs past the timeout with a backgrounded child: its whole group is killed", async () => {
    const wt = tmp(), log = join(wt, "c.log");
    const r = await runOnClose("trap '' TERM; sleep 600 & while :; do sleep 0.05; done", wt, { DS_X: "1" }, log, 1, 200);
    expect([r.code, r.timedOut]).toEqual([null, true]);
    await Bun.sleep(100);
    expect(procsUnder(wt, { self: -1, groups: [r.pgid!] }).procs).toEqual([]);
  });
});

// investigate-disk-cleanup U2: one capped pass inside each folder a cleanup_trim_globs entry matches.
describe("trimGlobBatch (class f)", () => {
  const H = 3600, now = () => Math.floor(Date.now() / 1000);
  const aged = (p: string, at: number) => utimesSync(p, at, at);
  // <root>/zzcache-v1/: `old` files 72 h old, `fresh` files just written; the folder itself is fresh too.
  function cache(old: number, fresh: number) {
    const root = tmp(), folder = join(root, "zzcache-v1"), t = now() - 72 * H;
    mkdirSync(folder);
    for (let i = 0; i < old; i++) { writeFileSync(join(folder, `old-${i}`), "x"); aged(join(folder, `old-${i}`), t); }
    for (let i = 0; i < fresh; i++) writeFileSync(join(folder, `fresh-${i}`), "x");
    return { root, folder, glob: join(root, "zzcache-*"), t };
  }
  const left = (d: string) => readdirSync(d).sort();

  test("1,000 old files, 10 fresh and 1 old one a live process holds open: one pass removes exactly the 1,000; the folder stays", async () => {
    const { folder, glob, t } = cache(1000, 10);
    const held = join(folder, "held");
    writeFileSync(held, "x"); aged(held, t);
    const p = Bun.spawn(["bash", "-c", `exec 3<"${held}"; echo ready; exec sleep 30`], { stdout: "pipe" });
    spawned.push(p.pid);
    const r = p.stdout.getReader();
    await r.read(); r.releaseLock();
    const b = await trimGlobBatch(glob, { ageS: 48 * H, now: now(), inUse: inUse() });
    expect([b.count, b.capped, b.sample.length]).toEqual([1000, false, 20]);
    expect(existsSync(folder)).toBe(true);
    expect(left(folder)).toEqual([...Array.from({ length: 10 }, (_, i) => `fresh-${i}`), "held"].sort());
  }, 60_000);

  test("the batch cap stops the pass and says capped; the next pass removes the rest", async () => {
    const { folder, glob } = cache(30, 0);
    const o = { ageS: 48 * H, now: now(), inUse: inUse(fakeProc([])), max: 20 };
    expect(await trimGlobBatch(glob, o)).toMatchObject({ count: 20, capped: true });
    expect(await trimGlobBatch(glob, o)).toMatchObject({ count: 10, capped: false });
    expect(left(folder)).toEqual([]);
    expect(existsSync(folder)).toBe(true);
  });

  test("an old symlink inside is unlinked and its target kept; a matched symlink to a folder is never entered", async () => {
    const { root, folder, glob, t } = cache(0, 0), outside = tmp(), target = join(outside, "keep.txt");
    writeFileSync(target, "keep"); writeFileSync(join(outside, "old"), "x"); aged(join(outside, "old"), t);
    symlinkSync(target, join(folder, "link"));
    symlinkSync(outside, join(root, "zzcache-link"));
    const b = await trimGlobBatch(glob, { ageS: 0, now: now() + 10, inUse: inUse(fakeProc([])) });
    expect(b.count).toBe(1);
    expect(left(folder)).toEqual([]);
    expect(left(outside)).toEqual(["keep.txt", "old"]);
  });

  test("a folder swapped for a symlink during the pass: the pass leaves it and the link's target is untouched", async () => {
    const { folder, glob, t } = cache(5, 0), victim = tmp();
    for (let i = 0; i < 5; i++) { writeFileSync(join(victim, `old-${i}`), "x"); aged(join(victim, `old-${i}`), t); }
    const dirs: DirReader = (d) => d !== folder ? streamDir(d) : (async function* () {
      const names = readdirSync(folder).sort();
      yield names[0];
      renameSync(folder, `${folder}.moved`); symlinkSync(victim, folder); // another user's swap, between two entries
      for (const n of names.slice(1)) yield n;
    })();
    const b = await trimGlobBatch(glob, { ageS: 48 * H, now: now(), inUse: inUse(fakeProc([])), dirs });
    expect(b.count).toBe(1);
    expect(readdirSync(victim)).toHaveLength(5);
  });

  test("another uid's entries are kept; an old folder inside goes only when nothing in it is newer", async () => {
    const { folder, glob, t } = cache(3, 0);
    for (const d of ["olddir", "mixed"]) { mkdirSync(join(folder, d)); writeFileSync(join(folder, d, "f"), "x"); aged(join(folder, d, "f"), t); }
    writeFileSync(join(folder, "mixed", "new"), "x");
    aged(join(folder, "olddir"), t); aged(join(folder, "mixed"), t);
    const o = { ageS: 48 * H, now: now(), inUse: inUse(fakeProc([])) };
    expect((await trimGlobBatch(glob, { ...o, uid: UID + 1 })).count).toBe(0); // another uid's folder: not entered
    expect(left(folder)).toEqual(["mixed", "old-0", "old-1", "old-2", "olddir"]);
    expect((await trimGlobBatch(glob, o)).count).toBe(4);
    expect(left(folder)).toEqual(["mixed"]);
  });
});
