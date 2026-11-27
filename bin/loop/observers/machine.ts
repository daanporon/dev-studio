// machine.ts — the host machine observer (board machine panel U1): load, memory, swap, PSI, disks
// and process-name groups from /proc and statfs into one observed_machine row (host 'local', like every observed
// row of this host; main files a side host's row under its name, bin/link/replica.ts). Host scope, every
// DS_LOOP_MACHINE_S (30 s). A missing /proc file leaves its columns NULL; no /proc/loadavg, no row.
// CPU % of a group is the tick delta of its processes between two samples kept in memory (KTD4):
// the first sample after a loop start stores NULL. cpu_busy_pct is the whole machine's busy CPU from the
// /proc/stat aggregate line (delta between two samples), not a sum of processes (machine-top-ram-clarity U6).
import { statfsSync, statSync } from "node:fs";
import type { Observer } from "../core/plugins.ts";
import { cpuDeltas, cpuPct, procKey, readText, scanOnce } from "../io/proc.ts";
import { envInt } from "../core/tick.ts";

const num = (s: string | undefined) => { const n = Number(s); return s !== undefined && s !== "" && Number.isFinite(n) ? n : null; };

export function meminfo(text: string | null): Record<string, number> {
  const m: Record<string, number> = {};
  for (const l of (text ?? "").split("\n")) { const x = /^(\w+):\s+(\d+)/.exec(l); if (x) m[x[1]] = Number(x[2]); }
  return m;
}

// /proc/pressure/<x>: "some avg10=0.00 avg60=… total=…" and "full …" lines.
export function psi(text: string | null, kind: "some" | "full"): number | null {
  const l = (text ?? "").split("\n").find((x) => x.startsWith(`${kind} `));
  return num(/avg10=([\d.]+)/.exec(l ?? "")?.[1]);
}

export function cores(stat: string | null): number | null {
  if (stat === null) return null;
  const n = stat.split("\n").filter((l) => /^cpu\d+\s/.test(l)).length;
  return n > 0 ? n : null;
}

// The aggregate `cpu` line of /proc/stat as {busy, all} jiffies. busy = user+nice+system+irq+softirq+steal;
// idle+iowait count as not busy; guest and guest_nice are already inside user/nice, so they are not added again.
export function cpuJiffies(stat: string | null): { busy: number; all: number } | null {
  const l = (stat ?? "").split("\n").find((x) => /^cpu\s/.test(x));
  if (!l) return null;
  const f = l.trim().split(/\s+/).slice(1, 9).map((x) => Number(x) || 0);
  const at = (i: number) => f[i] ?? 0;
  const all = f.reduce((a, b) => a + b, 0);
  return all > 0 ? { busy: at(0) + at(1) + at(2) + at(5) + at(6) + at(7), all } : null;
}

// Whole-machine busy CPU, 100 = one core: Δbusy / Δall × cores × 100 between two aggregate samples.
// NULL without a previous sample, with no cores, or when no time passed (or the counters went back).
export function cpuBusyPct(prev: { busy: number; all: number } | null, cur: { busy: number; all: number } | null, nCores: number | null): number | null {
  if (!prev || !cur || !nCores) return null;
  const dAll = cur.all - prev.all, dBusy = cur.busy - prev.busy;
  if (dAll <= 0 || dBusy < 0) return null;
  return Math.round(dBusy / dAll * nCores * 10000) / 100;
}

export function disks(paths: string[]): { path: string; total_kb: number; free_kb: number }[] {
  const seen = new Set<number>(), out: { path: string; total_kb: number; free_kb: number }[] = [];
  for (const p of paths) {
    try {
      const dev = statSync(p).dev;
      if (seen.has(dev)) continue;
      seen.add(dev);
      const s = statfsSync(p), bs = Number(s.bsize);
      out.push({ path: p, total_kb: Math.floor(Number(s.blocks) * bs / 1024), free_kb: Math.floor(Number(s.bavail) * bs / 1024) });
    } catch { /* unreadable path: no entry */ }
  }
  return out;
}

export function machineObserver(proc = "/proc"): Observer {
  let prev: { at: number; ticks: Map<string, number> } | null = null;
  let prevCpu: { busy: number; all: number } | null = null;
  return {
    name: "machine",
    scope: "host",
    every: envInt("DS_LOOP_MACHINE_S", 30),
    run({ store, tick, now }) {
      const la = readText(`${proc}/loadavg`);
      if (la === null) return;
      const l = la.split(" ");
      const mem = meminfo(readText(`${proc}/meminfo`));
      const pc = readText(`${proc}/pressure/cpu`), pm = readText(`${proc}/pressure/memory`), pi = readText(`${proc}/pressure/io`);
      const scan = scanOnce(tick, proc);
      const delta = cpuDeltas(prev, scan.procs, now);
      const secs = prev ? now - prev.at : 0;
      const g = new Map<string, { comm: string; procs: number; rss_kb: number; ticks: number }>();
      for (const p of scan.procs) {
        const e = g.get(p.comm) ?? { comm: p.comm, procs: 0, rss_kb: 0, ticks: 0 };
        e.procs++; e.rss_kb += p.rss_kb; e.ticks += delta?.get(procKey(p)) ?? 0;
        g.set(p.comm, e);
      }
      const groups = [...g.values()].map((e) => ({ comm: e.comm, procs: e.procs, rss_kb: e.rss_kb, cpu_pct: delta ? cpuPct(e.ticks, secs) : null }))
        .sort((a, b) => b.rss_kb - a.rss_kb);
      prev = { at: now, ticks: new Map(scan.procs.map((p) => [procKey(p), p.ticks])) };
      const stat = readText(`${proc}/stat`), nCores = cores(stat), jf = cpuJiffies(stat);
      const busyPct = cpuBusyPct(prevCpu, jf, nCores);
      prevCpu = jf;
      const wts = (store.db.query("SELECT DISTINCT path FROM observed_worktrees WHERE gone_at IS NULL AND path IS NOT NULL").all() as { path: string }[]).map((r) => r.path);
      store.tx(() => store.upsert("observed_machine", { host: "local" }, {
        cores: nCores, cpu_busy_pct: busyPct, load1: num(l[0]), load5: num(l[1]), load15: num(l[2]),
        mem_total_kb: mem.MemTotal ?? null, mem_avail_kb: mem.MemAvailable ?? null,
        swap_total_kb: mem.SwapTotal ?? null, swap_free_kb: mem.SwapFree ?? null,
        psi_cpu_some: psi(pc, "some"), psi_mem_some: psi(pm, "some"), psi_mem_full: psi(pm, "full"),
        psi_io_some: psi(pi, "some"), psi_io_full: psi(pi, "full"),
        disks: JSON.stringify(disks(["/", store.root, ...wts])), groups: JSON.stringify(groups),
        scan_ms: scan.ms, observed_at: now,
      }));
    },
  };
}

export default machineObserver();
