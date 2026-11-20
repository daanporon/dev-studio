// observers-machine.test.ts — the host machine observer on a fixture /proc tree: the row it writes,
// group CPU % from two samples, vanished processes, the per-tick scan cache, NULL PSI, no loadavg.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { cpuBusyPct, cpuJiffies, disks, machineObserver } from "../../bin/loop/observers/machine.ts";
import { scanOnce, scanProc } from "../../bin/loop/io/proc.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzmach-")); temps.push(d); return d; };

function proc(root: string, pid: number, comm: string, ticks: number, rssPages: number, ppid = 1) {
  const d = join(root, String(pid));
  mkdirSync(d, { recursive: true });
  // pid (comm) S ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime … starttime(22)
  writeFileSync(join(d, "stat"), `${pid} (${comm}) S ${ppid} 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 ${1000 + pid} 0 0\n`);
  writeFileSync(join(d, "statm"), `100 ${rssPages} 0 0 0 0 0\n`);
}
function fixture(opts: { pressure?: boolean; loadavg?: boolean } = {}): string {
  const root = tmp();
  if (opts.loadavg !== false) writeFileSync(join(root, "loadavg"), "1.50 2.25 3.00 1/200 999\n");
  writeFileSync(join(root, "meminfo"), "MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    4000000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n");
  writeFileSync(join(root, "stat"), "cpu  1 2 3 4\ncpu0 1 2 3 4\ncpu1 1 2 3 4\ncpu2 1 2 3 4\ncpu3 1 2 3 4\nintr 0\n");
  if (opts.pressure !== false) {
    mkdirSync(join(root, "pressure"));
    writeFileSync(join(root, "pressure", "cpu"), "some avg10=1.50 avg60=1.00 avg300=0.50 total=1\n");
    writeFileSync(join(root, "pressure", "memory"), "some avg10=2.00 avg60=0 avg300=0 total=1\nfull avg10=0.50 avg60=0 avg300=0 total=1\n");
    writeFileSync(join(root, "pressure", "io"), "some avg10=3.00 avg60=0 avg300=0 total=1\nfull avg10=1.00 avg60=0 avg300=0 total=1\n");
  }
  proc(root, 10, "a", 100, 250);
  proc(root, 11, "a", 200, 250);
  proc(root, 12, "b", 50, 500);
  return root;
}
function run(root: string) {
  const s = open(tmp());
  stores.push(s);
  const l = new Loop(s, { observers: [machineObserver(root)], reconcilers: [] }, { act() {} }, { projects: () => [] });
  return { s, l };
}
const row = (s: Store) => s.db.query("SELECT * FROM observed_machine").get() as Row | null;

describe("machine observer", () => {
  test("a fixture /proc writes exactly its values", async () => {
    const root = fixture(), { s, l } = run(root);
    l.boot(1000); await l.tick(1000);
    const r = row(s)!;
    expect(r).toMatchObject({ cores: 4, load1: 1.5, load5: 2.25, load15: 3, mem_total_kb: 16000000, mem_avail_kb: 4000000,
      swap_total_kb: 2000000, swap_free_kb: 1500000, psi_cpu_some: 1.5, psi_mem_some: 2, psi_mem_full: 0.5, psi_io_some: 3, psi_io_full: 1, observed_at: 1000 });
    expect(r.scan_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(r.disks as string).length).toBeGreaterThan(0);
  });

  test("groups by comm with summed RSS; first sample has NULL CPU", async () => {
    const root = fixture(), { s, l } = run(root);
    l.boot(1000); await l.tick(1000);
    const g = JSON.parse(row(s)!.groups as string);
    expect(g).toEqual([{ comm: "b", procs: 1, rss_kb: 2000, cpu_pct: null }, { comm: "a", procs: 2, rss_kb: 2000, cpu_pct: null }]);
  });

  test("two samples give group CPU %", async () => {
    const root = fixture(), { s, l } = run(root);
    l.boot(1000); await l.tick(1000);
    proc(root, 10, "a", 1600, 250);  // +1500 ticks
    proc(root, 11, "a", 1700, 250);  // +1500 ticks
    proc(root, 12, "b", 350, 500);   // +300 ticks
    await l.tick(1030);             // 30 s later (the observer's cadence): a = 3000/(100*30) = 100 %, b = 10 %
    const g = Object.fromEntries(JSON.parse(row(s)!.groups as string).map((x: Row) => [x.comm, x.cpu_pct]));
    expect(g).toEqual({ a: 100, b: 10 });
  });

  test("a process that vanishes mid-scan is skipped", async () => {
    const root = fixture();
    writeFileSync(join(root, "99"), "not a dir");     // listed, stat unreadable
    mkdirSync(join(root, "98"));                        // dir without stat
    const { s, l } = run(root);
    l.boot(1000); await l.tick(1000);
    expect(JSON.parse(row(s)!.groups as string).reduce((n: number, g: Row) => n + (g.procs as number), 0)).toBe(3);
  });

  test("one scan per tick for two readers", async () => {
    const root = fixture();
    const a = scanOnce(7, root);
    proc(root, 13, "c", 1, 1);
    expect(scanOnce(7, root)).toBe(a);
    expect(scanOnce(8, root).procs.length).toBe(a.procs.length + 1);
    expect(scanProc(root).procs.length).toBe(4);
  });

  test("no pressure directory: NULL PSI, row still written", async () => {
    const root = fixture({ pressure: false }), { s, l } = run(root);
    l.boot(1000); await l.tick(1000);
    expect(row(s)).toMatchObject({ psi_cpu_some: null, psi_mem_some: null, psi_mem_full: null, psi_io_some: null, psi_io_full: null, cores: 4 });
  });

  test("no loadavg: no row", async () => {
    const root = fixture({ loadavg: false }), { s, l } = run(root);
    l.boot(1000); await l.tick(1000);
    expect(row(s)).toBeNull();
  });

  test("two paths on one device give one disk entry", async () => {
    const d = tmp();
    mkdirSync(join(d, "x"));
    expect(disks([d, join(d, "x")]).length).toBe(1);
  });
});

describe("machine CPU busy from /proc/stat (U6)", () => {
  const stat = (agg: string) => `${agg}\ncpu0 1 1 1 1\ncpu1 1 1 1 1\ncpu2 1 1 1 1\ncpu3 1 1 1 1\nintr 0\n`;

  test("busy = user+nice+system+irq+softirq+steal; idle+iowait and guest are not busy", () => {
    // user nice system idle iowait irq softirq steal guest guest_nice
    const j = cpuJiffies(stat("cpu  100 10 20 500 300 5 5 10 50 5"))!;
    expect(j).toEqual({ busy: 150, all: 950 });
    expect(cpuJiffies(null)).toBeNull();
    expect(cpuJiffies("cpu0 1 2 3 4\n")).toBeNull();
  });

  test("delta over delta × cores × 100; no previous sample, no cores or no elapsed time is NULL", () => {
    const a = { busy: 100, all: 1000 }, b = { busy: 200, all: 1200 };
    expect(cpuBusyPct(a, b, 24)).toBe(1200);        // 100/200 busy on 24 cores = 12 cores
    expect(cpuBusyPct(null, b, 24)).toBeNull();
    expect(cpuBusyPct(a, b, null)).toBeNull();
    expect(cpuBusyPct(a, a, 24)).toBeNull();
    expect(cpuBusyPct(b, a, 24)).toBeNull();
  });

  test("the observer stores NULL on the first scan and the busy cores on the second", async () => {
    const root = fixture(), { s, l } = run(root);
    writeFileSync(join(root, "stat"), stat("cpu  100 0 100 800 0 0 0 0"));
    l.boot(1000); await l.tick(1000);
    expect(row(s)!.cpu_busy_pct).toBeNull();
    writeFileSync(join(root, "stat"), stat("cpu  200 0 200 1000 0 0 0 0"));   // Δbusy 200 of Δall 400 on 4 cores
    await l.tick(1040);
    expect(row(s)!.cpu_busy_pct).toBe(200);
  });

  test("a missing /proc/stat stores NULL", async () => {
    const root = fixture(), { s, l } = run(root);
    rmSync(join(root, "stat"));
    l.boot(1000); await l.tick(1000); await l.tick(1040);
    expect(row(s)!.cpu_busy_pct).toBeNull();
  });
});
