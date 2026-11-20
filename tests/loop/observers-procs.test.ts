// observers-procs.test.ts — the per-worktree process-tree observer on a fixture /proc tree: ancestry
// to a verified agent pid, the cwd fallback for reparented processes, longest-prefix worktree match,
// unattributed host groups, gone and reused-pid workers, CPU % from two samples; host groups named by
// owner (service, container, exe script), containers and removed worktrees counted under their worktree;
// CPU-seconds per unit (reaped children included, a restarted Builder adding to the same row); the loop's own load
// from its cgroup, or its process tree when the cgroup is shared or `/`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { exeScript, procsObserver, type Container } from "../../bin/loop/observers/procs.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzprocs-")); temps.push(d); return d; };

const BTIME = 1_700_000_000;
// started_at as the orca walk records it: btime + starttime ticks / CLK_TCK.
const startedAt = (startTicks: number) => BTIME + Math.floor(startTicks / 100);

type P = { pid: number; comm: string; ppid?: number; cwd?: string | null; ticks?: number; cticks?: number; rssPages?: number; start?: number; cgroup?: string; argv?: string[] };
function proc(root: string, p: P) {
  const d = join(root, String(p.pid));
  mkdirSync(d, { recursive: true });
  const start = p.start ?? 1000 + p.pid;
  // pid (comm) S ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime … starttime(22)
  writeFileSync(join(d, "stat"), `${p.pid} (${p.comm}) S ${p.ppid ?? 1} 1 1 0 -1 0 0 0 0 0 ${p.ticks ?? 0} 0 ${p.cticks ?? 0} 0 20 0 1 0 ${start} 0 0\n`);
  writeFileSync(join(d, "statm"), `100 ${p.rssPages ?? 25} 0 0 0 0 0\n`);
  try { unlinkSync(join(d, "cwd")); } catch { /* none yet */ }
  if (p.cwd !== null) symlinkSync(p.cwd ?? "/", join(d, "cwd"));
  if (p.cgroup) writeFileSync(join(d, "cgroup"), `0::${p.cgroup}\n`);
  if (p.argv) writeFileSync(join(d, "cmdline"), `${p.argv.join("\0")}\0`);
}
function fixture(): string {
  const root = tmp();
  writeFileSync(join(root, "stat"), `cpu  1 2 3 4\ncpu0 1 2 3 4\nbtime ${BTIME}\n`);
  return root;
}
// inspect: a stub docker; `calls` records each inspect's ids. No stub = Docker unavailable.
// cgroupRoot defaults to an empty dir (no cgroup v2), so no test reads the host's /sys/fs/cgroup.
function run(root: string, docker?: Record<string, Container>, cgroupRoot = tmp()) {
  const s = open(tmp());
  stores.push(s);
  const calls: string[][] = [];
  const inspect = async (ids: string[]) => { calls.push(ids); return docker ? new Map(ids.filter((i) => docker[i]).map((i) => [i, docker[i]])) : null; };
  const l = new Loop(s, { observers: [procsObserver({ proc: root, inspect, cgroupRoot })], reconcilers: [] }, { act() {} }, { projects: () => [] });
  return { s, l, calls };
}
// A fixture cgroup v2 tree: per cgroup, memory.stat (anon/shmem in KiB, written as bytes; stat false = no
// memory controller, "unreadable" = a memory.stat that can't be read) and `some avg10` of cpu.pressure /
// memory.pressure (omitted = no file).
type Leaf = { anon?: number; shmem?: number; cpu?: number; mem?: number; stat?: false | "unreadable"; usec?: number | "unreadable" };
function cgroups(leaves: Record<string, Leaf>, v2 = true): string {
  const root = tmp();
  if (v2) writeFileSync(join(root, "cgroup.controllers"), "cpu memory pids\n");
  for (const [cg, x] of Object.entries(leaves)) {
    const d = join(root, cg);
    mkdirSync(d, { recursive: true });
    if (x.stat === "unreadable") mkdirSync(join(d, "memory.stat"));
    else if (x.stat !== false) writeFileSync(join(d, "memory.stat"), `anon ${(x.anon ?? 0) * 1024}\nfile 999999\nkernel 4096\nshmem ${(x.shmem ?? 0) * 1024}\n`);
    if (x.usec === "unreadable") mkdirSync(join(d, "cpu.stat"));
    else if (x.usec !== undefined) writeFileSync(join(d, "cpu.stat"), `usage_usec ${x.usec}\nuser_usec 1\nsystem_usec 1\n`);
    const pr = (v: number) => `some avg10=${v.toFixed(2)} avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`;
    if (x.cpu !== undefined) writeFileSync(join(d, "cpu.pressure"), pr(x.cpu));
    if (x.mem !== undefined) writeFileSync(join(d, "memory.pressure"), pr(x.mem));
  }
  return root;
}
function worktree(s: Store, project: string, wt: string, path: string) {
  s.upsert("observed_worktrees", { project, wt }, { path, observed_at: 1 });
}
function worker(s: Store, project: string, wt: string, pid: number | null, startTicks: number | null, gone = false) {
  s.upsert("observed_workers", { project, wt }, { pid, started_at: startTicks === null ? null : startedAt(startTicks), rss_kb: 100,
    gone_at: gone ? 5 : null, observed_at: 1 });
}
// A Builder member on `wt` and its unit (builder_wt = wt), as the state observer writes them.
function builderUnit(s: Store, project: string, squad: string, slug: string, wt: string, status = "dispatched") {
  s.upsert("members", { project, squad, wt }, { role: "builder", suffix: slug, observed_at: 1, updated_at: 1 });
  s.upsert("units", { project, squad, slug }, { status, builder_wt: wt, observed_at: 1, updated_at: 1 });
}
const unitCpu = (s: Store) => Object.fromEntries((s.db.query("SELECT * FROM unit_cpu").all() as Row[]).map((r) => [`${r.project}/${r.squad}/${r.slug}`, r]));
const rows = (s: Store) => Object.fromEntries((s.db.query("SELECT * FROM observed_procs ORDER BY project, wt").all() as Row[])
  .map((r) => [`${r.project}/${r.wt}`, r]));
const host = (s: Store) => s.db.query("SELECT * FROM observed_host_procs").get() as Row | null;
const hostGroups = (s: Store) => Object.fromEntries((JSON.parse(host(s)!.groups as string) as Row[]).map((g) => [g.label, g]));

describe("procs observer", () => {
  test("a background process reparented to init with its cwd in a worktree attributes to it", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    proc(root, { pid: 200, comm: "bun", ppid: 1, cwd: "/w/a/sub", rssPages: 50 });
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a");
    worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"]).toMatchObject({ procs: 2, rss_kb: 300, root_pid: 100, cpu_pct: null, observed_at: 1000 });
  });

  test("an agent and its children attribute to its worktree with summed RSS", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    proc(root, { pid: 101, comm: "bash", ppid: 100, cwd: "/w/a" });
    proc(root, { pid: 102, comm: "bun", ppid: 101, cwd: "/w/a" });
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a");
    worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"]).toMatchObject({ procs: 3, rss_kb: 300, root_pid: 100 });
  });

  test("ancestry wins over a cwd outside the worktree", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    proc(root, { pid: 300, comm: "node", ppid: 100, cwd: "/tmp" });
    proc(root, { pid: 301, comm: "node", ppid: 300, cwd: "/w/b" });  // nearest root is still 100
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a"); worktree(s, "p", "b", "/w/b");
    worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"]).toMatchObject({ procs: 3 });
    expect(rows(s)["p/b"]).toBeUndefined();
  });

  test("the longest worktree path prefix wins, on a path boundary", async () => {
    const root = fixture();
    proc(root, { pid: 400, comm: "bun", cwd: "/w/x-2/src" });
    proc(root, { pid: 401, comm: "bun", cwd: "/w/x" });
    proc(root, { pid: 402, comm: "bun", cwd: "/w/x/deep/er" });
    const { s, l } = run(root);
    worktree(s, "p", "x", "/w/x"); worktree(s, "q", "x-2", "/w/x-2");
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["q/x-2"]).toMatchObject({ procs: 1, root_pid: null });
    expect(rows(s)["p/x"]).toMatchObject({ procs: 2 });
  });

  test("a process with no root and a cwd outside every worktree is unattributed and only counted in host groups", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    proc(root, { pid: 500, comm: "dockerd", cwd: "/", rssPages: 100 });
    proc(root, { pid: 501, comm: "dockerd", cwd: "/", rssPages: 100 });
    proc(root, { pid: 502, comm: "sshd", cwd: null });                // unreadable cwd: ancestry only
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a");
    worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(Object.keys(rows(s))).toEqual(["p/a"]);
    const g = hostGroups(s);
    expect(g.dockerd).toMatchObject({ procs: 2, rss_kb: 800, cpu_pct: null });
    expect(g.sshd).toMatchObject({ procs: 1 });
    expect(g.claude).toBeUndefined();
    expect(host(s)).toMatchObject({ procs: 3, rss_kb: 900, observed_at: 1000 });
    expect(host(s)!.scan_ms).toBeGreaterThanOrEqual(0);
  });

  test("a gone worker is not a root, and its old row is removed", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    proc(root, { pid: 101, comm: "bun", ppid: 100, cwd: "/tmp" });
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a");
    worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"]).toMatchObject({ procs: 2 });
    worker(s, "p", "a", 100, 1100, true);
    s.db.run("UPDATE observed_worktrees SET gone_at = 5");
    await l.tick(1030);
    expect(rows(s)).toEqual({});
  });

  test("a vanished or reused pid is not a root; its worktree still collects cwd matches", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", start: 9999 });   // reused: start differs from started_at
    proc(root, { pid: 101, comm: "bun", ppid: 100, cwd: "/tmp" });
    proc(root, { pid: 102, comm: "bun", ppid: 1, cwd: "/w/b/x" });
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a"); worktree(s, "p", "b", "/w/b");
    worker(s, "p", "a", 100, 1100);
    worker(s, "p", "b", 777, 1100);                                       // vanished
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"]).toMatchObject({ procs: 1, root_pid: null });  // 100 by cwd; 101 unattributed
    expect(rows(s)["p/b"]).toMatchObject({ procs: 1, root_pid: null });
    expect(hostGroups(s).bun).toMatchObject({ procs: 1 });
  });

  test("a second sample gives CPU % per worktree and per host group", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", ticks: 100 });
    proc(root, { pid: 101, comm: "bun", ppid: 100, ticks: 0 });
    proc(root, { pid: 500, comm: "dockerd", cwd: "/", ticks: 0 });
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a");
    worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"].cpu_pct).toBeNull();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", ticks: 1600 });  // +1500
    proc(root, { pid: 101, comm: "bun", ppid: 100, ticks: 1500 });       // +1500
    proc(root, { pid: 500, comm: "dockerd", cwd: "/", ticks: 300 });      // +300
    await l.tick(1030);                                                   // 30 s: a = 3000/3000 = 100 %, dockerd 10 %
    expect(rows(s)["p/a"]).toMatchObject({ cpu_pct: 100, observed_at: 1030 });
    expect(hostGroups(s).dockerd.cpu_pct).toBe(10);
  });

  test("CPU-seconds per unit: live children, a child reaped between samples, a restarted Builder", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", ticks: 100 });
    proc(root, { pid: 101, comm: "bash", ppid: 100, ticks: 0 });
    proc(root, { pid: 102, comm: "bun", ppid: 101, ticks: 0 });
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a"); worktree(s, "p", "b", "/w/b");
    worker(s, "p", "a", 100, 1100);
    builderUnit(s, "p", "sq", "u2", "a");
    l.boot(1000); await l.tick(1000);                                     // first sample: a baseline, nothing charged
    expect(unitCpu(s)["p/sq/u2"]).toMatchObject({ cpu_s: 0, peak_cpu_pct: null, wt: "a" });
    // 103 ran and was reaped by bash between the samples: it shows only as bash's cutime.
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", ticks: 400 });   // +300
    proc(root, { pid: 101, comm: "bash", ppid: 100, ticks: 50, cticks: 200 }); // +50, +200 reaped
    proc(root, { pid: 102, comm: "bun", ppid: 101, ticks: 1000 });       // +1000
    await l.tick(1030);                                                   // 1550 ticks
    expect(unitCpu(s)["p/sq/u2"].cpu_s).toBeCloseTo(15.5, 1);
    // bun exits after 500 more ticks and bash reaps it: its whole 1500 lands in bash's cutime, 1000 of
    // it charged already. A new child of claude starts and runs 40 ticks.
    rmSync(join(root, "102"), { recursive: true });
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", ticks: 500 });   // +100
    proc(root, { pid: 101, comm: "bash", ppid: 100, ticks: 60, cticks: 1700 }); // +10, +1500 reaped
    proc(root, { pid: 104, comm: "node", ppid: 100, cwd: "/tmp", ticks: 40 });   // new: +40
    await l.tick(1060);                                                   // 100 + 10 + 500 + 40 = 650
    const truth = (1550 + 650) / 100;
    const r = unitCpu(s)["p/sq/u2"];
    expect(Math.abs(r.cpu_s - truth) / truth).toBeLessThan(0.05);
    expect(r.peak_cpu_pct).toBeCloseTo(1550 / 30, 0);
    expect(r.peak_rss_kb).toBe(300);                                      // 3 procs × 25 pages × 4 kB
    // The Builder is restarted on the same unit in a new worktree: it adds to the same row.
    for (const pid of ["100", "101", "104"]) rmSync(join(root, pid), { recursive: true });
    worker(s, "p", "a", 100, 1100, true);
    proc(root, { pid: 200, comm: "claude", cwd: "/w/b", ticks: 300 });   // new since the last sample: +300
    worker(s, "p", "b", 200, 1200);
    builderUnit(s, "p", "sq", "u2", "b");
    await l.tick(1090);
    proc(root, { pid: 200, comm: "claude", cwd: "/w/b", ticks: 600 });   // +300
    await l.tick(1120);
    expect(unitCpu(s)["p/sq/u2"]).toMatchObject({ wt: "b", first_at: 1000, updated_at: 1120 });
    expect(unitCpu(s)["p/sq/u2"].cpu_s).toBeCloseTo(truth + 6, 1);
  });

  test("CPU per unit: an orphan's exit takes nothing off; no open unit, no row", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", ticks: 0 });
    proc(root, { pid: 300, comm: "bun", ppid: 1, cwd: "/w/a/x", ticks: 0 });   // reparented to init
    proc(root, { pid: 400, comm: "claude", cwd: "/w/c", ticks: 0 });
    proc(root, { pid: 500, comm: "claude", cwd: "/w/d", ticks: 0 });
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a"); worktree(s, "p", "c", "/w/c"); worktree(s, "p", "d", "/w/d");
    worker(s, "p", "a", 100, 1100); worker(s, "p", "c", 400, 1400); worker(s, "p", "d", 500, 1500);
    builderUnit(s, "p", "sq", "u1", "a");
    builderUnit(s, "p", "sq", "u0", "d", "done");                          // d: its unit is done
    l.boot(1000); await l.tick(1000);
    proc(root, { pid: 300, comm: "bun", ppid: 1, cwd: "/w/a/x", ticks: 500 });
    proc(root, { pid: 400, comm: "claude", cwd: "/w/c", ticks: 900 });
    proc(root, { pid: 500, comm: "claude", cwd: "/w/d", ticks: 900 });
    await l.tick(1030);
    rmSync(join(root, "300"), { recursive: true });                       // init reaps it, not claude
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", ticks: 100 });
    await l.tick(1060);
    expect(unitCpu(s)["p/sq/u1"].cpu_s).toBeCloseTo(6, 1);
    expect(Object.keys(unitCpu(s))).toEqual(["p/sq/u1"]);                 // c has no unit, d's unit is done
  });

  test("CPU per unit: a shell and its child killed together; the child's charged CPU stays on the unit", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", ticks: 0 });
    proc(root, { pid: 101, comm: "bash", ppid: 100, cwd: "/w/a", ticks: 0 });
    proc(root, { pid: 102, comm: "bun", ppid: 101, cwd: "/w/a", ticks: 0 });
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a"); worker(s, "p", "a", 100, 1100);
    builderUnit(s, "p", "sq", "u1", "a");
    l.boot(1000); await l.tick(1000);
    proc(root, { pid: 101, comm: "bash", ppid: 100, cwd: "/w/a", ticks: 10 });
    proc(root, { pid: 102, comm: "bun", ppid: 101, cwd: "/w/a", ticks: 1000 });
    await l.tick(1030);                                                    // 10 s charged
    rmSync(join(root, "101"), { recursive: true });                       // the timeout kills both:
    rmSync(join(root, "102"), { recursive: true });                       // claude reaps bash, init reaps bun
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", ticks: 50, cticks: 10 });
    await l.tick(1060);
    expect(unitCpu(s)["p/sq/u1"].cpu_s).toBeCloseTo(10.6, 1);             // 10.1 s + claude's own 0.5 s; bun's 10 s not taken back
  });

  test("no btime: pids cannot be verified, cwd still attributes", async () => {
    const root = fixture();
    writeFileSync(join(root, "stat"), "cpu  1 2 3 4\n");
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    proc(root, { pid: 101, comm: "bun", ppid: 100, cwd: "/tmp" });
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a");
    worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"]).toMatchObject({ procs: 1, root_pid: null });
  });

  test("no processes listed (no /proc): writes nothing", async () => {
    const { s, l } = run(join(tmp(), "missing"));
    l.boot(1000); await l.tick(1000);
    expect(rows(s)).toEqual({});
    expect(host(s)).toBeNull();
  });
  test("a host process is named by its .service, not its thread name", async () => {
    const root = fixture();
    proc(root, { pid: 600, comm: "MainThread", cgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice/orca-serve.service",
      argv: ["/x/runtimes/node-e32e", "/x/orcad-server.js"], rssPages: 100 });
    const { s, l } = run(root);
    l.boot(1000); await l.tick(1000);
    const g = hostGroups(s);
    expect(g["orca-serve"]).toMatchObject({ comm: "MainThread", procs: 1, rss_kb: 400 });
    expect(g.MainThread).toBeUndefined();
  });

  test("an unowned interpreter in a session scope is named exe + script", async () => {
    const root = fixture();
    const scope = "/user.slice/user-1000.slice/user@1000.service/orca_pty_7.scope";
    proc(root, { pid: 601, comm: "MainThread", cgroup: scope, argv: ["node", "/x/y/server.mjs", "--flag"] });
    proc(root, { pid: 602, comm: "MainThread", cgroup: scope, argv: ["node", "/z/server.mjs"] });
    proc(root, { pid: 603, comm: "bun", cgroup: scope, argv: ["bun", "/a/cli.ts", "jobs"] });
    const { s, l } = run(root);
    l.boot(1000); await l.tick(1000);
    const g = hostGroups(s);
    expect(g["node server.mjs"]).toMatchObject({ procs: 2 });
    expect(g["bun cli.ts"]).toMatchObject({ procs: 1 });
    expect(g.MainThread).toBeUndefined();
  });

  test("exe script: interpreters, options, java jars and classes, rewritten titles", () => {
    expect(exeScript(null, ["node", "--max-old-space-size=4096", "-r", "ts-node/register", "/a/b/srv.js"])).toBe("node srv.js");
    expect(exeScript("/usr/bin/python3.12", ["python3", "-u", "-m", "http.server"])).toBe("python3 http.server");
    expect(exeScript(null, ["java", "-Xmx1g", "-jar", "/opt/app/app.jar"])).toBe("java app.jar");
    expect(exeScript(null, ["java", "-cp", "/a:/b", "org.elasticsearch.bootstrap.Elasticsearch"])).toBe("java Elasticsearch");
    expect(exeScript(null, ["bun", "run", "/a/dev.ts"])).toBe("bun dev.ts");
    expect(exeScript(null, ["node", "-e", "1"])).toBe("node");
    expect(exeScript(null, ["sshd: user@pts/0"])).toBe("sshd");
    expect(exeScript(null, ["/opt/google/chrome/chrome --type=renderer --lang=en"])).toBe("chrome");
    expect(exeScript("/usr/bin/node", ["chrome-devtools-mcp", "", ""])).toBe("chrome-devtools-mcp");   // a rewritten process.title
    expect(exeScript("/home/u/.local/share/claude/versions/2.1.3", ["claude", "--model", "opus"])).toBe("claude");
    expect(exeScript("/usr/sbin/dockerd", [])).toBe("dockerd");
    expect(exeScript(null, [])).toBeNull();
  });

  test("a process with nothing readable takes its parent's label; a kernel thread keeps its comm", async () => {
    const root = fixture();
    proc(root, { pid: 2, comm: "kthreadd", ppid: 0 });
    proc(root, { pid: 30, comm: "kworker/0:1", ppid: 2 });
    proc(root, { pid: 900, comm: "MainThread", argv: ["node", "/x/daemon-entry.js"] });
    proc(root, { pid: 901, comm: "MainThread", ppid: 900 });          // exiting: no cmdline, no exe
    const { s, l } = run(root);
    l.boot(1000); await l.tick(1000);
    const g = hostGroups(s);
    expect(g["node daemon-entry.js"]).toMatchObject({ procs: 2 });
    expect(g["kworker/0:1"]).toMatchObject({ procs: 1 });
    expect(g.MainThread).toBeUndefined();
  });

  const CID = "a".repeat(64), CID2 = "b".repeat(64);
  const dockerScope = (id: string) => `/system.slice/docker-${id}.scope`;

  test("a container with a bind source under a worktree counts in that worktree's row", async () => {
    const root = fixture(), w = tmp();
    mkdirSync(join(w, ".devenv"));
    proc(root, { pid: 100, comm: "claude", cwd: w });
    proc(root, { pid: 700, comm: "containerd-shim", cgroup: "/system.slice/containerd.service" });
    proc(root, { pid: 701, comm: "java", ppid: 700, cwd: "/app", cgroup: dockerScope(CID), argv: ["java", "-jar", "/app/x.jar"], rssPages: 200 });
    const { s, l } = run(root, { [CID]: { name: "dev-db", dirs: ["/tmp/x", join(w, ".devenv")] } });
    worktree(s, "p", "a", w);
    worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"]).toMatchObject({ procs: 2, rss_kb: 100 + 800 });
    expect(hostGroups(s)["dev-db"]).toBeUndefined();
    expect(hostGroups(s).containerd).toMatchObject({ procs: 1 });
  });

  test("a container with a compose working dir under a worktree counts there; the longest worktree wins", async () => {
    const root = fixture();
    proc(root, { pid: 701, comm: "node", cwd: "/srv", cgroup: dockerScope(CID) });
    const { s, l } = run(root, { [CID]: { name: "web", dirs: ["/w/a/b/compose"] } });
    worktree(s, "p", "a", "/w/a");
    worktree(s, "p", "b", "/w/a/b");
    l.boot(1000); await l.tick(1000);
    expect(Object.keys(rows(s))).toEqual(["p/b"]);
  });

  test("a container mounting nothing under a worktree is a host group named by its container name", async () => {
    const root = fixture();
    proc(root, { pid: 701, comm: "java", cwd: "/", cgroup: dockerScope(CID), argv: ["java", "-jar", "x.jar"], rssPages: 100 });
    proc(root, { pid: 702, comm: "sh", ppid: 701, cwd: "/", cgroup: dockerScope(CID) });
    const { s, l } = run(root, { [CID]: { name: "keycloak", dirs: ["/tmp/k"] } });
    worktree(s, "p", "a", "/w/a");
    l.boot(1000); await l.tick(1000);
    expect(rows(s)).toEqual({});
    expect(hostGroups(s).keycloak).toMatchObject({ procs: 2, comm: "java" });
    expect(hostGroups(s).java).toBeUndefined();
  });

  test("Docker unavailable: a container's processes are labelled by its short id and the scan completes", async () => {
    const root = fixture();
    proc(root, { pid: 701, comm: "java", cwd: "/", cgroup: dockerScope(CID), argv: ["/usr/bin/java", "-jar", "/opt/kc.jar"] });
    const { s, l, calls } = run(root);
    l.boot(1000); await l.tick(1000);
    expect(calls).toEqual([[CID]]);
    expect(hostGroups(s)[CID.slice(0, 12)]).toMatchObject({ procs: 1, comm: "java" });
    expect(hostGroups(s)["java kc.jar"]).toBeUndefined();
  });

  test("container metadata is cached: a second scan of the same ids makes no inspect call", async () => {
    const root = fixture();
    proc(root, { pid: 701, comm: "java", cwd: "/", cgroup: dockerScope(CID) });
    const { s, l, calls } = run(root, { [CID]: { name: "kc", dirs: [] } });
    l.boot(1000); await l.tick(1000); await l.tick(1030);
    expect(calls).toEqual([[CID]]);
    proc(root, { pid: 702, comm: "redis-server", cwd: "/", cgroup: dockerScope(CID2) });
    await l.tick(1060);
    expect(calls).toEqual([[CID], [CID2]]);
    expect(hostGroups(s).kc).toMatchObject({ procs: 1 });
  });

  test("a process whose cwd is a removed worktree is a leftover row of that project", async () => {
    const root = fixture(), ws = tmp();
    proc(root, { pid: 800, comm: "MainThread", cwd: `${ws}/ds-acme-builder-x (deleted)`, rssPages: 50,
      argv: ["node", "/n/chrome-devtools-mcp/build/src/index.js"] });
    proc(root, { pid: 801, comm: "node", cwd: `${ws}/ds-acme-builder-old/sub (deleted)` });
    const { s, l } = run(root);
    worktree(s, "acme", "r::" + `${ws}/ds-acme-lead-y`, `${ws}/ds-acme-lead-y`);   // live: gives acme's workspace root
    s.upsert("observed_worktrees", { project: "acme", wt: `r::${ws}/ds-acme-builder-old` }, { path: `${ws}/ds-acme-builder-old`, gone_at: 5, observed_at: 1 });
    l.boot(1000); await l.tick(1000);
    const r = rows(s);
    expect(r[`acme/${ws}/ds-acme-builder-x`]).toMatchObject({ procs: 1, rss_kb: 200, root_pid: null });
    expect(r[`acme/r::${ws}/ds-acme-builder-old`]).toMatchObject({ procs: 1 });
    expect(host(s)).toMatchObject({ procs: 0 });
  });

  test("a shared workspace root: the DS_PREFIX project name picks the leftover's project", async () => {
    const root = fixture(), ws = tmp();
    proc(root, { pid: 800, comm: "node", cwd: `${ws}/ds-dev-studio-builder-z (deleted)` });
    const { s, l } = run(root);
    worktree(s, "dev", "a", `${ws}/ds-dev-lead-a`);
    worktree(s, "dev-studio", "b", `${ws}/ds-dev-studio-lead-b`);
    l.boot(1000); await l.tick(1000);
    expect(Object.keys(rows(s))).toEqual([`dev-studio/${ws}/ds-dev-studio-builder-z`]);
  });

  test("a deleted cwd outside every workspace root stays a host group", async () => {
    const root = fixture();
    proc(root, { pid: 800, comm: "node", cwd: "/tmp/gone (deleted)", argv: ["node", "/x/tool.js"] });
    const { s, l } = run(root);
    worktree(s, "acme", "a", "/w/acme/ds-acme-lead-a");
    l.boot(1000); await l.tick(1000);
    expect(rows(s)).toEqual({});
    expect(hostGroups(s)["node tool.js"]).toMatchObject({ procs: 1 });
  });

  test("a container whose bind source is a removed worktree is a leftover of its project", async () => {
    const root = fixture(), ws = tmp();
    proc(root, { pid: 701, comm: "postgres", cwd: "/", cgroup: dockerScope(CID) });
    const { s, l } = run(root, { [CID]: { name: "pg", dirs: [`${ws}/ds-acme-builder-x/.devenv/pg`] } });
    worktree(s, "acme", "a", `${ws}/ds-acme-lead-a`);
    l.boot(1000); await l.tick(1000);
    expect(Object.keys(rows(s))).toEqual([`acme/${ws}/ds-acme-builder-x`]);
  });

  test("one owner: an agent's child with a cwd in another worktree, deleted or not, stays with the agent", async () => {
    const root = fixture(), ws = tmp();
    mkdirSync(join(ws, "ds-p-a")); mkdirSync(join(ws, "ds-p-b"));
    proc(root, { pid: 100, comm: "claude", cwd: join(ws, "ds-p-a") });
    proc(root, { pid: 101, comm: "bun", ppid: 100, cwd: join(ws, "ds-p-b") });
    proc(root, { pid: 102, comm: "bun", ppid: 100, cwd: `${ws}/ds-p-gone (deleted)` });
    const { s, l } = run(root);
    worktree(s, "p", "a", join(ws, "ds-p-a"));
    worktree(s, "p", "b", join(ws, "ds-p-b"));
    worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"]).toMatchObject({ procs: 3, root_pid: 100 });
    expect(rows(s)["p/b"]).toBeUndefined();
  });
});

// RAM counted once (machine-top-ram-clarity U4, KTD6) and pressure per worktree (KTD11), on a fixture cgroup tree.
describe("procs observer: charged memory and pressure", () => {
  // W1 (p/a, RSS 12000) and host group H (redis-server, RSS 4000) share leaf A charged 8000; W2 (p/b) has leaf B
  // charged 4000 alone; a systemd process with RSS in the root cgroup, whose memory.stat holds the whole machine.
  function two(leafB: Leaf = { anon: 4000 }, v2 = true) {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", cgroup: "/u/a.scope", rssPages: 3000 });
    proc(root, { pid: 300, comm: "redis-server", cwd: "/", cgroup: "/u/a.scope", rssPages: 1000, argv: ["redis-server"] });
    proc(root, { pid: 200, comm: "claude", cwd: "/w/b", cgroup: "/u/b.scope", rssPages: 500 });
    proc(root, { pid: 400, comm: "systemd", cwd: "/", cgroup: "/", rssPages: 5000, argv: ["/sbin/init"] });
    const cg = cgroups({ "/": { anon: 50_000_000 }, "/u/a.scope": { anon: 6000, shmem: 2000, cpu: 12, mem: 3 }, "/u/b.scope": leafB }, v2);
    const { s, l } = run(root, undefined, cg);
    worktree(s, "p", "a", "/w/a"); worktree(s, "p", "b", "/w/b");
    worker(s, "p", "a", 100, 1100); worker(s, "p", "b", 200, 1200);
    return { s, l };
  }

  test("a leaf's charge splits across its owners by RSS; the sum is the leaves' charge, the root cgroup adds nothing", async () => {
    const { s, l } = two();
    builderUnit(s, "p", "sq", "u1", "a");
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"]).toMatchObject({ rss_kb: 12000, mem_kb: 6000 });
    expect(rows(s)["p/b"]).toMatchObject({ rss_kb: 2000, mem_kb: 4000 });
    const g = hostGroups(s);
    expect(g["redis-server"]).toMatchObject({ rss_kb: 4000, mem_kb: 2000 });
    expect(g.init).toMatchObject({ rss_kb: 20000, mem_kb: 0 });
    const sum = Object.values(rows(s)).reduce((a, r) => a + Number(r.mem_kb), 0) + Object.values(g).reduce((a, x) => a + Number(x.mem_kb), 0);
    expect(sum).toBe(12000);
    expect(unitCpu(s)["p/sq/u1"]).toMatchObject({ peak_rss_kb: 12000 });  // unit_cpu keeps RSS (R9)
  });

  test("a non-root leaf whose processes have no RSS splits its charge evenly across their owners", async () => {
    const root = fixture();
    proc(root, { pid: 300, comm: "alpha", cwd: "/", cgroup: "/u/z.scope", rssPages: 0, argv: ["alpha"] });
    proc(root, { pid: 301, comm: "beta", cwd: "/", cgroup: "/u/z.scope", rssPages: 0, argv: ["beta"] });
    proc(root, { pid: 302, comm: "beta", cwd: "/", cgroup: "/u/z.scope", rssPages: 0, argv: ["beta"] });
    const { s, l } = run(root, undefined, cgroups({ "/u/z.scope": { anon: 1000 } }));
    l.boot(1000); await l.tick(1000);
    expect(hostGroups(s).alpha.mem_kb).toBe(500);
    expect(hostGroups(s).beta.mem_kb).toBe(500);
  });

  test("one unreadable memory.stat leaves every mem_kb in the scan NULL", async () => {
    const { s, l } = two({ stat: "unreadable" });
    l.boot(1000); await l.tick(1000);
    expect(Object.values(rows(s)).map((r) => r.mem_kb)).toEqual([null, null]);
    expect(Object.values(hostGroups(s)).map((g) => g.mem_kb)).toEqual([null, null]);
    expect(rows(s)["p/a"].rss_kb).toBe(12000);
  });

  test("a leaf without the memory controller charges through its nearest ancestor with it; a gone cgroup charges nothing", async () => {
    const root = fixture();
    proc(root, { pid: 300, comm: "udevd", cwd: "/", cgroup: "/s/udevd.service", rssPages: 1000, argv: ["udevd"] });
    proc(root, { pid: 301, comm: "worker", cwd: "/", cgroup: "/s/udevd.service/udev", rssPages: 3000, argv: ["worker"] });
    proc(root, { pid: 302, comm: "gone", cwd: "/", cgroup: "/s/gone.scope", rssPages: 500, argv: ["gone"] });
    proc(root, { pid: 303, comm: "loose", cwd: "/", cgroup: "/nomem/x.scope", rssPages: 500, argv: ["loose"] });
    const cg = cgroups({ "/s/udevd.service": { anon: 8000 }, "/s/udevd.service/udev": { stat: false }, "/nomem/x.scope": { stat: false } });
    const { s, l } = run(root, undefined, cg);
    l.boot(1000); await l.tick(1000);
    const g = hostGroups(s);
    expect([g.udevd.mem_kb, g.worker.mem_kb, g.gone.mem_kb, g.loose.mem_kb]).toEqual([2000, 6000, 0, 0]);
  });

  test("no cgroup v2 leaves every mem_kb NULL, as does the default empty cgroup root", async () => {
    const { s, l } = two(undefined, false);
    l.boot(1000); await l.tick(1000);
    expect(Object.values(rows(s)).map((r) => r.mem_kb)).toEqual([null, null]);
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", cgroup: "/u/a.scope" });
    const r2 = run(root);
    worktree(r2.s, "p", "a", "/w/a"); worker(r2.s, "p", "a", 100, 1100);
    r2.l.boot(1000); await r2.l.tick(1000);
    expect(rows(r2.s)["p/a"]).toMatchObject({ mem_kb: null, psi_cpu: null, psi_mem: null });
  });

  test("cgroup v2 with no memory controller below the root leaves every mem_kb NULL, not 0", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", cgroup: "/u/a.scope" });
    proc(root, { pid: 300, comm: "redis-server", cwd: "/", cgroup: "/u/r.scope", argv: ["redis-server"] });
    const { s, l } = run(root, undefined, cgroups({ "/u/a.scope": { stat: false }, "/u/r.scope": { stat: false } }));
    worktree(s, "p", "a", "/w/a"); worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect([rows(s)["p/a"].mem_kb, hostGroups(s)["redis-server"].mem_kb]).toEqual([null, null]);
  });

  test("pressure is the worst some avg10 over a worktree's leaves; unreadable pressure is NULL", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", cgroup: "/u/a.scope" });
    proc(root, { pid: 101, comm: "bun", ppid: 100, cwd: "/w/a", cgroup: "/u/a2.scope" });
    proc(root, { pid: 200, comm: "claude", cwd: "/w/b", cgroup: "/u/b.scope" });
    const cg = cgroups({ "/u/a.scope": { cpu: 12, mem: 3 }, "/u/a2.scope": { cpu: 40, mem: 1 }, "/u/b.scope": {} });
    const { s, l } = run(root, undefined, cg);
    worktree(s, "p", "a", "/w/a"); worktree(s, "p", "b", "/w/b");
    worker(s, "p", "a", 100, 1100); worker(s, "p", "b", 200, 1200);
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"]).toMatchObject({ psi_cpu: 40, psi_mem: 3 });
    expect(rows(s)["p/b"]).toMatchObject({ psi_cpu: null, psi_mem: null });
  });

  // The loop's own load (U5, KTD12): <proc>/self names the loop's pid; its cgroup gets cgroup.procs, cpu.stat and
  // memory.stat (bytes), so the figures come from the cgroup only when it holds nothing but the loop's tree.
  const G = 1024 * 1024 * 1024, M = 1024 * 1024;
  function loopCg(cgRoot: string, cg: string, x: { procs: number[]; usec: number; anon: number; shmem: number; file: number }) {
    const d = join(cgRoot, cg);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "cgroup.procs"), x.procs.map((p) => `${p}\n`).join(""));
    writeFileSync(join(d, "cpu.stat"), `usage_usec ${x.usec}\nuser_usec 1\nsystem_usec 1\n`);
    writeFileSync(join(d, "memory.stat"), `anon ${x.anon}\nfile ${x.file}\nkernel 4096\nshmem ${x.shmem}\n`);
  }
  const hostRow = (s: Store) => s.db.query("SELECT loop_cpu_pct, loop_mem_kb, loop_cache_kb, loop_source FROM observed_host_procs").get() as Row;
  function loopTree(cgroup: string, extra?: P) {
    const root = fixture();
    symlinkSync("100", join(root, "self"));
    proc(root, { pid: 100, comm: "bun", cgroup, ticks: 0, rssPages: 2500 });  // 10 000 kB
    proc(root, { pid: 101, comm: "bash", ppid: 100, cgroup, ticks: 0, rssPages: 250 });
    proc(root, { pid: 102, comm: "gh", ppid: 101, cgroup, ticks: 0, rssPages: 250 });
    if (extra) proc(root, extra);
    return root;
  }

  test("loop load from its own cgroup: CPU from the usage_usec delta, own memory anon + shmem, cache file", async () => {
    const cg = "/app.slice/x.service", root = loopTree(cg), cgRoot = cgroups({});
    loopCg(cgRoot, cg, { procs: [100, 101, 102, 140], usec: 10_000_000, anon: 90 * M, shmem: 10 * M, file: 14 * G });  // 140: gone already
    const { s, l } = run(root, undefined, cgRoot);
    l.boot(1000); await l.tick(1000);
    expect(hostRow(s)).toEqual({ loop_cpu_pct: null, loop_mem_kb: 100 * 1024, loop_cache_kb: 14 * 1024 * 1024, loop_source: "cgroup" });
    loopCg(cgRoot, cg, { procs: [100, 101, 102], usec: 100_000_000, anon: 90 * M, shmem: 10 * M, file: 14 * G });
    await l.tick(1030);                                                    // 90 s of CPU in 30 s = 3 cores
    expect(hostRow(s)).toMatchObject({ loop_cpu_pct: 300, loop_source: "cgroup" });
    expect(hostGroups(s).x.procs).toBe(3);                                 // the loop and its helpers stay in their host group
  });

  test("loop load falls back to the process tree when its cgroup holds another process, or is the root", async () => {
    for (const [cg, stranger] of [["/app.slice/x.service", true], ["/", false]] as const) {
      const root = loopTree(cg, stranger ? { pid: 300, comm: "redis-server", cgroup: cg, ticks: 0 } : undefined), cgRoot = cgroups({});
      if (cg !== "/") loopCg(cgRoot, cg, { procs: [100, 101, 102, 300], usec: 10_000_000, anon: 90 * M, shmem: 10 * M, file: 14 * G });
      const { s, l } = run(root, undefined, cgRoot);
      l.boot(1000); await l.tick(1000);
      expect(hostRow(s)).toEqual({ loop_cpu_pct: null, loop_mem_kb: 12_000, loop_cache_kb: null, loop_source: "tree" });
      proc(root, { pid: 100, comm: "bun", cgroup: cg, ticks: 3000, rssPages: 2500 });
      proc(root, { pid: 102, comm: "gh", ppid: 101, cgroup: cg, ticks: 1500, rssPages: 250 });
      if (stranger) proc(root, { pid: 300, comm: "redis-server", cgroup: cg, ticks: 9000 });
      await l.tick(1030);                                                  // 4500 ticks in 30 s, the stranger's not counted
      expect(hostRow(s)).toMatchObject({ loop_cpu_pct: 150, loop_source: "tree" });
    }
  });

  test("no loop in the scan (no <proc>/self) leaves the loop columns NULL", async () => {
    const root = fixture();
    proc(root, { pid: 100, comm: "bun", cgroup: "/app.slice/x.service" });
    const { s, l } = run(root, undefined, cgroups({}));
    l.boot(1000); await l.tick(1000);
    expect(hostRow(s)).toEqual({ loop_cpu_pct: null, loop_mem_kb: null, loop_cache_kb: null, loop_source: null });
  });
});

// CPU from the leaf cgroups (machine-top-ram-clarity U9): cpu_cg_pct is the usage_usec delta of the leaves holding a
// row's processes (100 = one core), a shared leaf split by CPU ticks (RSS when none); rss_kb, cpu_pct stay as before.
describe("procs observer: cgroup CPU", () => {
  const setUsec = (cg: string, c: string, usec: number | "unreadable") => {
    const f = join(cg, c, "cpu.stat");
    rmSync(f, { recursive: true, force: true });
    if (usec === "unreadable") mkdirSync(f); else writeFileSync(f, `usage_usec ${usec}\n`);
  };
  // W1 (p/a, pid 100) and host group redis-server (pid 300) share leaf /u/a.scope; W2 (p/b, pid 200) has /u/b.scope alone;
  // systemd (pid 400) sits in the root cgroup, which counts nothing.
  function scene(ticks: [number, number]) {
    const root = fixture();
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", cgroup: "/u/a.scope", rssPages: 3000, ticks: ticks[0] });
    proc(root, { pid: 300, comm: "redis-server", cwd: "/", cgroup: "/u/a.scope", rssPages: 1000, ticks: ticks[1], argv: ["redis-server"] });
    proc(root, { pid: 200, comm: "claude", cwd: "/w/b", cgroup: "/u/b.scope", rssPages: 500 });
    proc(root, { pid: 400, comm: "systemd", cwd: "/", cgroup: "/", rssPages: 5000, argv: ["/sbin/init"] });
    return root;
  }
  const setup = (usec: Record<string, number | "unreadable">, ticks: [number, number] = [0, 0]) => {
    const root = scene(ticks);
    const cg = cgroups({ "/": { usec: 999_999_999 }, "/u/a.scope": { usec: usec.a }, "/u/b.scope": { usec: usec.b } });
    const { s, l } = run(root, undefined, cg);
    worktree(s, "p", "a", "/w/a"); worktree(s, "p", "b", "/w/b");
    worker(s, "p", "a", 100, 1100); worker(s, "p", "b", 200, 1200);
    return { root, cg, s, l };
  };

  test("the first scan writes NULL; the second gives each owner its cgroup cores, a shared leaf split by ticks", async () => {
    const { root, cg, s, l } = setup({ a: 1_000_000, b: 1_000_000 });
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"].cpu_cg_pct).toBeNull();
    expect(hostGroups(s)["redis-server"].cpu_cg_pct).toBeNull();
    setUsec(cg, "/u/a.scope", 61_000_000);   // +60 s of CPU in 30 s = 2 cores
    setUsec(cg, "/u/b.scope", 16_000_000);    // +15 s = 0.5 core
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a", cgroup: "/u/a.scope", rssPages: 3000, ticks: 1800 });
    proc(root, { pid: 300, comm: "redis-server", cwd: "/", cgroup: "/u/a.scope", rssPages: 1000, ticks: 600, argv: ["redis-server"] });
    await l.tick(1030);
    expect(rows(s)["p/a"]).toMatchObject({ cpu_cg_pct: 150, cpu_pct: 60, rss_kb: 12000 });  // 3/4 of 200; cpu_pct stays the sampled figure
    expect(rows(s)["p/b"].cpu_cg_pct).toBe(50);
    expect(hostGroups(s)["redis-server"]).toMatchObject({ cpu_cg_pct: 50, cpu_pct: 20 });
    expect(hostGroups(s).init.cpu_cg_pct).toBe(0);  // the root cgroup counts nothing
    const sum = Object.values(rows(s)).reduce((a, r) => a + Number(r.cpu_cg_pct), 0) + Object.values(hostGroups(s)).reduce((a, g) => a + Number(g.cpu_cg_pct), 0);
    expect(sum).toBe(250);
  });

  test("a shared leaf whose owners had no ticks splits by RSS", async () => {
    const { cg, s, l } = setup({ a: 0, b: 0 });
    l.boot(1000); await l.tick(1000);
    setUsec(cg, "/u/a.scope", 120_000_000);   // 4 cores in 30 s
    await l.tick(1030);
    expect(rows(s)["p/a"].cpu_cg_pct).toBe(300);   // RSS 3000 : 1000 pages
    expect(hostGroups(s)["redis-server"].cpu_cg_pct).toBe(100);
  });

  test("an unreadable cpu.stat writes NULL for every row in that scan; cpu_pct is unaffected", async () => {
    const { cg, s, l } = setup({ a: 0, b: 0 });
    l.boot(1000); await l.tick(1000);
    setUsec(cg, "/u/a.scope", 30_000_000);
    setUsec(cg, "/u/b.scope", "unreadable");
    await l.tick(1030);
    expect(rows(s)["p/a"].cpu_cg_pct).toBeNull();
    expect(rows(s)["p/b"].cpu_cg_pct).toBeNull();
    expect(rows(s)["p/a"].rss_kb).toBe(12000);
  });

  test("no cgroup v2 leaves cpu_cg_pct NULL on every scan", async () => {
    const root = scene([0, 0]);
    const { s, l } = run(root);
    worktree(s, "p", "a", "/w/a"); worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000); await l.tick(1030);
    expect(rows(s)["p/a"].cpu_cg_pct).toBeNull();
  });
});

// exposed-cleanup U3: listening ports per worktree (observed_procs.listen).
describe("procs observer: listening ports", () => {
  const HDR = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  // /proc/net/tcp{,6} rows: [local "hex:hexport", state, inode].
  function net(root: string, v4: [string, string, string][], v6: [string, string, string][] = []) {
    mkdirSync(join(root, "net"), { recursive: true });
    const body = (rs: [string, string, string][], rem: string) => rs.map(([a, st, ino], i) => `   ${i}: ${a} ${rem} ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${ino} 1 0000000000000000 100 0 0 10 0\n`).join("");
    writeFileSync(join(root, "net", "tcp"), HDR + body(v4, "00000000:0000"));
    writeFileSync(join(root, "net", "tcp6"), HDR + body(v6, "00000000000000000000000000000000:0000"));
  }
  function fds(root: string, pid: number, inodes: string[], extra = 0) {
    const d = join(root, String(pid), "fd");
    mkdirSync(d, { recursive: true });
    inodes.forEach((i, n) => symlinkSync(`socket:[${i}]`, join(d, String(10 + n))));
    for (let n = 0; n < extra; n++) symlinkSync(n % 2 ? "/dev/null" : `pipe:[${900000 + n}]`, join(d, String(1000 + n)));
  }
  function runL(root: string, o: { docker?: Record<string, Container>; listenMs?: number } = {}) {
    const s = open(tmp());
    stores.push(s);
    const inspect = async (ids: string[]) => (o.docker ? new Map(ids.filter((i) => o.docker![i]).map((i) => [i, o.docker![i]])) : null);
    const l = new Loop(s, { observers: [procsObserver({ proc: root, inspect, cgroupRoot: tmp(), listenMs: o.listenMs })], reconcilers: [] }, { act() {} }, { projects: () => [] });
    return { s, l };
  }
  const listen = (s: Store, k: string) => JSON.parse(String(rows(s)[k].listen)) as Row[];

  test("a child's listening socket lands in its worktree; the agent's own does not; v4 and v6 are one port", async () => {
    const root = fixture();
    // 127.0.0.1:5173 (inode 11), 0.0.0.0:3000 (12), ::1:5173 (13), [::]:3000 (14), agent's 0.0.0.0:9229 (15), a non-listen row (16)
    net(root, [["0100007F:1435", "0A", "11"], ["00000000:0BB8", "0A", "12"], ["00000000:23DD", "0A", "15"], ["0100007F:1F90", "01", "16"]],
      [["00000000000000000000000001000000:1435", "0A", "13"], ["00000000000000000000000000000000:0BB8", "0A", "14"]]);
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    proc(root, { pid: 101, comm: "node", ppid: 100, cwd: "/w/a" });
    proc(root, { pid: 102, comm: "vite", ppid: 100, cwd: "/w/a" });
    fds(root, 100, ["15"]); fds(root, 101, ["11", "13", "16"]); fds(root, 102, ["12", "14"]);
    const { s, l } = runL(root);
    worktree(s, "p", "a", "/w/a"); worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(listen(s, "p/a")).toEqual([
      { port: 3000, addr: "any", pid: 102, comm: "vite", since: 1000, src: "proc" },
      { port: 5173, addr: "loopback", pid: 101, comm: "node", since: 1000, src: "proc" },
    ]);
  });

  test("since is carried while the port stays and restarts when it comes back", async () => {
    const root = fixture();
    net(root, [["00000000:0BB8", "0A", "12"]]);
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    proc(root, { pid: 102, comm: "vite", ppid: 100, cwd: "/w/a" });
    fds(root, 102, ["12"]);
    const { s, l } = runL(root);
    worktree(s, "p", "a", "/w/a"); worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000); await l.tick(1030);
    expect(listen(s, "p/a")).toMatchObject([{ port: 3000, since: 1000 }]);
    net(root, []); await l.tick(1060);
    expect(listen(s, "p/a")).toEqual([]);
    net(root, [["00000000:0BB8", "0A", "12"]]); await l.tick(1090);
    expect(listen(s, "p/a")).toMatchObject([{ port: 3000, since: 1090 }]);
  });

  test("a container's published host ports land in the worktree it is attributed to", async () => {
    const root = fixture();
    net(root, [["00000000:1538", "0A", "50"]]);   // docker-proxy's socket: root-owned, attributed to nobody
    proc(root, { pid: 701, comm: "postgres", cwd: "/", cgroup: "/system.slice/docker-" + "a".repeat(64) + ".scope" });
    const { s, l } = runL(root, { docker: { ["a".repeat(64)]: { name: "stack-db", dirs: ["/w/a/compose"],
      ports: [{ port: 5432, addr: "any" }, { port: 5432, addr: "any" }, { port: 8025, addr: "loopback" }] } } });
    worktree(s, "p", "a", "/w/a");
    l.boot(1000); await l.tick(1000);
    expect(listen(s, "p/a")).toEqual([
      { port: 5432, addr: "any", pid: null, comm: "stack-db", since: 1000, src: "docker" },
      { port: 8025, addr: "loopback", pid: null, comm: "stack-db", since: 1000, src: "docker" },
    ]);
  });

  test("past the budget a worktree keeps its previous listen and is scanned first next time", async () => {
    const root = fixture();
    net(root, [["00000000:0BB8", "0A", "12"]]);
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    proc(root, { pid: 102, comm: "vite", ppid: 100, cwd: "/w/a" });
    fds(root, 102, ["12"]);
    const { s, l } = runL(root, { listenMs: -1 });   // already past the deadline: nothing is reached
    worktree(s, "p", "a", "/w/a"); worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(rows(s)["p/a"].listen).toBeNull();
    s.db.run("UPDATE observed_procs SET listen = ? WHERE wt = 'a'", [JSON.stringify([{ port: 1, since: 5 }])]);
    await l.tick(1030);
    expect(listen(s, "p/a")).toEqual([{ port: 1, since: 5 }]);
  });

  test("no listening socket on the host: no fd is read and every row lists []", async () => {
    const root = fixture();
    net(root, [["0100007F:1F90", "01", "16"]]);
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    proc(root, { pid: 102, comm: "vite", ppid: 100, cwd: "/w/a" });
    mkdirSync(join(root, "102", "fd"));   // a dir, not readable as links: would throw nothing but proves no read is needed
    const { s, l } = runL(root, { listenMs: -1 });
    worktree(s, "p", "a", "/w/a"); worker(s, "p", "a", 100, 1100);
    l.boot(1000); await l.tick(1000);
    expect(listen(s, "p/a")).toEqual([]);
  });

  test("2000 descriptors scan well inside the 300 ms cap", async () => {
    const root = fixture();
    net(root, [["00000000:0BB8", "0A", "12"]]);
    proc(root, { pid: 100, comm: "claude", cwd: "/w/a" });
    for (let i = 0; i < 4; i++) { proc(root, { pid: 110 + i, comm: "node", ppid: 100, cwd: "/w/a" }); fds(root, 110 + i, i === 3 ? ["12"] : [], 500); }
    const { s, l } = runL(root);
    worktree(s, "p", "a", "/w/a"); worker(s, "p", "a", 100, 1100);
    l.boot(1000);
    const t0 = performance.now();
    await l.tick(1000);
    expect(performance.now() - t0).toBeLessThan(300);
    expect(listen(s, "p/a")).toMatchObject([{ port: 3000, pid: 113 }]);
  });
});
