// proc.ts — the shared /proc reader (KTD3): one record per process (pid, ppid, comm, start time,
// utime+stime ticks, the cutime+cstime ticks of its reaped children, RSS kB), the CPU-delta helper, and a one-scan-per-tick cache. It takes a root
// directory so tests run on a fixture tree. Used by observers/machine.ts and observers/procs.ts.
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export type Proc = { pid: number; ppid: number; comm: string; start: number; ticks: number; cticks: number; rss_kb: number };
export type Scan = { procs: Proc[]; ms: number };

export const CLK_TCK = 100;   // USER_HZ; fixed at 100 on Linux
export const PAGE_KB = 4;

export function readText(p: string): string | null {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

// /proc/<pid>/stat: "pid (comm) S ppid ... utime(14) stime(15) cutime(16) cstime(17) ... starttime(22)".
// comm may hold spaces and parens, so fields count from the last ")". cticks (cutime+cstime) is the CPU
// of children the process has waited for; 0 when unreadable.
export function parseStat(text: string): { pid: number; comm: string; state: string; ppid: number; pgrp: number; ticks: number; cticks: number; start: number } | null {
  const a = text.indexOf("("), b = text.lastIndexOf(")");
  if (a < 0 || b < a) return null;
  const f = text.slice(b + 2).split(" ");
  const pid = Number(text.slice(0, a)), ppid = Number(f[1]), ut = Number(f[11]), st = Number(f[12]), start = Number(f[19]);
  if (![pid, ppid, ut, st, start].every(Number.isFinite)) return null;
  const pgrp = Number(f[2]), ct = Number(f[13]) + Number(f[14]);
  return { pid, comm: text.slice(a + 1, b), state: f[0] ?? "", ppid, pgrp: Number.isFinite(pgrp) ? pgrp : -1, ticks: ut + st, cticks: Number.isFinite(ct) ? ct : 0, start };
}

export function scanProc(root = "/proc"): Scan {
  const t0 = performance.now();
  let names: string[] = [];
  try { names = readdirSync(root); } catch { /* no /proc */ }
  const procs: Proc[] = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const st = readText(join(root, n, "stat"));
    if (st === null) continue; // vanished between listing and reading
    const p = parseStat(st);
    if (!p) continue;
    const sm = readText(join(root, n, "statm"));
    const pages = sm === null ? 0 : Number(sm.split(" ")[1]);
    procs.push({ pid: p.pid, ppid: p.ppid, comm: p.comm, start: p.start, ticks: p.ticks, cticks: p.cticks, rss_kb: Number.isFinite(pages) ? pages * PAGE_KB : 0 });
  }
  return { procs, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

// Linux appends " (deleted)" to the cwd link of a removed directory.
export function readCwd(root: string, pid: number): string | null {
  try { return readlinkSync(join(root, String(pid), "cwd")).replace(/ \(deleted\)$/, ""); } catch { return null; }
}

// The raw cwd link (KTD6): the path, and whether Linux marked it " (deleted)".
export function readCwdRaw(root: string, pid: number): { path: string; deleted: boolean } | null {
  try {
    const l = readlinkSync(join(root, String(pid), "cwd"));
    return l.endsWith(" (deleted)") ? { path: l.slice(0, -" (deleted)".length), deleted: true } : { path: l, deleted: false };
  } catch { return null; }
}

// The cgroup v2 path from /proc/<pid>/cgroup (the "0::<path>" line), e.g.
// "/system.slice/docker-<id>.scope"; null when unreadable or on a v1-only host.
export function readCgroup(root: string, pid: number): string | null {
  const m = /^0::(\/\S*)$/m.exec(readText(join(root, String(pid), "cgroup")) ?? "");
  return m ? m[1] : null;
}

// argv from /proc/<pid>/cmdline (NUL-separated); [] for a kernel thread or when unreadable.
export function readCmdline(root: string, pid: number): string[] {
  const t = readText(join(root, String(pid), "cmdline"));
  return t ? t.split("\0").filter((a, i, all) => a !== "" || i < all.length - 1) : [];
}

// The /proc/<pid>/exe link, " (deleted)" stripped; null when unreadable (another uid, a kernel thread).
export function readExe(root: string, pid: number): string | null {
  try { return readlinkSync(join(root, String(pid), "exe")).replace(/ \(deleted\)$/, ""); } catch { return null; }
}

// The real uid from /proc/<pid>/status ("Uid:\t<real>\t<effective>…"); null when unreadable.
export function readUid(root: string, pid: number): number | null {
  const m = /^Uid:\s+(\d+)/m.exec(readText(join(root, String(pid), "status")) ?? "");
  return m ? Number(m[1]) : null;
}

// The absolute paths a process holds open (/proc/<pid>/fd/* links), " (deleted)" stripped. Sockets,
// pipes and anon inodes are not paths and are left out; an unreadable fd dir (another uid) gives [].
export function readFdTargets(root: string, pid: number): string[] {
  const dir = join(root, String(pid), "fd");
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const n of names) {
    try {
      const l = readlinkSync(join(dir, n));
      if (l.startsWith("/")) out.push(l.replace(/ \(deleted\)$/, ""));
    } catch { /* closed meanwhile */ }
  }
  return out;
}

// The socket inodes a process holds open (its /proc/<pid>/fd/* links `socket:[<inode>]`, exposed-cleanup U3);
// an unreadable fd dir (another uid) gives []. Past `deadline` (a performance.now() time) it stops mid-way: null then.
export function readSocketInodes(root: string, pid: number, deadline = Infinity): string[] | null {
  const dir = join(root, String(pid), "fd");
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (let i = 0; i < names.length; i++) {
    if ((i & 63) === 63 && performance.now() > deadline) return null;
    try {
      const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(join(dir, names[i])));
      if (m) out.push(m[1]);
    } catch { /* closed meanwhile */ }
  }
  return out;
}

// A listening TCP socket: its port and whether it is bound to loopback only.
export type Listening = { port: number; addr: "loopback" | "any" };
// /proc/net/tcp and tcp6 rows in state 0A (listen), by socket inode. Each row is
// `sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode …`, the address in hex with each
// 32-bit word in host (little-endian) order: 0100007F:1F90 is 127.0.0.1:8080. null when neither file reads.
export function readListening(root: string): Map<string, Listening> | null {
  const v4 = readText(join(root, "net", "tcp")), v6 = readText(join(root, "net", "tcp6"));
  if (v4 === null && v6 === null) return null;
  const out = new Map<string, Listening>();
  for (const text of [v4, v6]) {
    for (const line of (text ?? "").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== "0A") continue;
      const [hex, ph] = f[1].split(":");
      const port = parseInt(ph ?? "", 16), inode = f[9];
      if (!Number.isFinite(port) || !inode || inode === "0") continue;
      out.set(inode, { port, addr: loopbackHex(hex ?? "") ? "loopback" : "any" });
    }
  }
  return out;
}

// Is a /proc/net address loopback: 127.0.0.0/8 (first byte last in the word), ::1, or ::ffff:127.x.x.x?
function loopbackHex(h: string): boolean {
  const u = h.toUpperCase();
  if (u.length === 8) return u.slice(6, 8) === "7F";
  if (u.length !== 32) return false;
  if (u === "00000000000000000000000001000000") return true;
  return u.startsWith("0000000000000000FFFF0000") && u.slice(30, 32) === "7F";
}

// A process starts at btime + its start ticks / CLK_TCK.
export function bootTime(root = "/proc"): number | null {
  const m = /^btime (\d+)$/m.exec(readText(join(root, "stat")) ?? "");
  return m ? Number(m[1]) : null;
}

// One scan per (root, tick): a second observer in the same tick reuses it.
const cache = new Map<string, { tick: number; scan: Scan }>();
export function scanOnce(tick: number, root = "/proc"): Scan {
  const c = cache.get(root);
  if (c && c.tick === tick) return c.scan;
  const scan = scanProc(root);
  cache.set(root, { tick, scan });
  return scan;
}

// The key of a process across samples: a reused pid has another start time.
export const procKey = (p: Proc) => `${p.pid}:${p.start}`;

// CPU % of each process present in both samples (100 = one core busy); `prev` is null on the first
// sample. Returns the per-process tick delta so callers sum it per group.
export function cpuDeltas(prev: { at: number; ticks: Map<string, number> } | null, procs: Proc[], at: number): Map<string, number> | null {
  if (!prev || at <= prev.at) return null;
  const out = new Map<string, number>();
  for (const p of procs) {
    const was = prev.ticks.get(procKey(p));
    if (was !== undefined) out.set(procKey(p), Math.max(0, p.ticks - was));
  }
  return out;
}
// CPU charged per process between two samples (U2), with what short-lived children used: a process's
// value is its own ticks plus its reaped children's (cticks), so a child that starts and ends between
// samples counts on whoever reaped it. A process seen last sample and gone now was charged up to then;
// its reaper's cticks jump by its whole total, so that already-charged part comes off the reaper: the
// nearest last-sample ancestor still alive. An orphan's real reaper (init, a subreaper) belongs to no
// worktree, so nothing is taken off there. A reaper's cticks grow only by what it really reaped, so
// what comes off it is capped at that growth: a child orphaned when its parent died in the same
// interval (and reaped by init) can take off no more than the reaper gained. Returns pid → ticks
// (never negative), or null on the first sample.
export type CpuSample = Map<number, { key: string; ppid: number; t: number; c: number }>;
export const cpuSample = (procs: Proc[]): CpuSample => new Map(procs.map((p) => [p.pid, { key: procKey(p), ppid: p.ppid, t: p.ticks, c: p.cticks }]));
export function cpuCharges(prev: CpuSample | null, procs: Proc[]): Map<number, number> | null {
  if (!prev) return null;
  const live = new Map(procs.map((p) => [p.pid, procKey(p)]));
  const alive = (pid: number) => { const w = prev.get(pid); return !!w && live.get(pid) === w.key; };
  const off = new Map<number, number>();
  for (const [pid, w] of prev) {
    if (alive(pid)) continue;
    const seen = new Set<number>();
    for (let cur = w.ppid; cur > 0 && !seen.has(cur) && prev.has(cur); cur = prev.get(cur)!.ppid) {
      seen.add(cur);
      if (alive(cur)) { off.set(cur, (off.get(cur) ?? 0) + w.t + w.c); break; }
    }
  }
  const out = new Map<number, number>();
  for (const p of procs) {
    const was = prev.get(p.pid);
    if (!was || was.key !== procKey(p)) { out.set(p.pid, p.ticks + p.cticks); continue; }
    const dc = Math.max(0, p.cticks - was.c);
    out.set(p.pid, Math.max(0, p.ticks - was.t) + dc - Math.min(off.get(p.pid) ?? 0, dc));
  }
  return out;
}
export const cpuPct = (ticks: number, secs: number) => Math.round((ticks / (CLK_TCK * secs)) * 1000) / 10;
