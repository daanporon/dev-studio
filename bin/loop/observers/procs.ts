// procs.ts — the per-worktree process-tree observer (board machine panel U2): each process on the
// host goes to at most one worktree, and each worktree's procs, RSS and CPU % land in
// observed_procs; the rest, grouped by owner label, land in one observed_host_procs row. Host scope,
// every DS_LOOP_MACHINE_S (30 s); the file sorts after orca.ts so it reads that tick's observed_workers.
// Attribution (KTD5), first match wins:
//  1. the nearest ancestor that is a member's live agent pid — trusted only while its start time
//     matches observed_workers.started_at, so a reused pid pulls in nothing;
//  2. the live worktree whose path is the longest prefix of the process's cwd (a background process
//     reparented to init after its shell exited);
//  3. a container process (leaf cgroup docker-<id>.scope) whose compose working dir or a bind-mount
//     source lies under a live worktree (longest prefix), or under a removed one (a leftover);
//  4. a cwd Linux marks " (deleted)" under a known project's worktree path or workspace root: a
//     leftover row of that project, keyed by the removed worktree's wt (its bare path when unknown).
// The rest are host groups named by owner (machine-top-ram-clarity KTD5): a `<name>.service` leaf
// cgroup is `<name>`, a container its name (its short id when Docker can't be asked), else `exe script` (the executable's basename plus, for
// an interpreter, its script's or jar's). Groups keep `comm` (their biggest process's) for older
// readers. Docker metadata comes from one `docker inspect` of new container ids, cached by id.
// CPU % is the tick delta between two samples kept in memory (KTD4). scan_ms is the /proc scan plus
// this observer's own reads (cwd, cgroup, cmdline, docker inspect, memory.stat, pressure).
// CPU per unit (light-lane plan U2): each Builder worktree's CPU since the last sample, reaped
// children included (cpuCharges), is added to its unit's unit_cpu row. The worktree maps to the unit
// through the Builder member's wt and the unit's builder_wt (or the member's suffix); a worktree with
// no open unit adds to nothing.
// RAM counted once (machine-top-ram-clarity U4, KTD6): each non-root leaf cgroup holding a scanned
// process charges `anon + shmem` from its memory.stat, split across the owners (worktree rows and host
// groups) of its processes by their RSS in it, so Σ mem_kb = Σ the leaves' charge. Processes in `/`
// charge nothing (its memory.stat is the whole machine); a leaf without the memory controller charges
// through its nearest ancestor with it (chargedMemory). All or nothing: without cgroup v2, or with any
// memory.stat unreadable, the scan writes mem_kb NULL everywhere. rss_kb and cpu_pct are unchanged (R9).
// Pressure (KTD11): a row's psi_cpu/psi_mem is the max `some` avg10 over its non-root leaves.
// The loop's own load (machine-top-ram-clarity U5, KTD12) goes on the host row (loopLoad): read from the
// loop's own cgroup when that holds only the loop and its descendants, else summed over its process tree.
// It is information only: the loop's processes still land in their host group as before.
// Listening ports (exposed-cleanup U3): each row's `listen` is a JSON array of {port, addr, pid, comm, since, src}.
// `src: "proc"` is a listening socket of /proc/net/tcp{,6} held by one of the worktree's processes (its
// /proc/<pid>/fd socket links), never by the member's agent itself (its verified root pid); `src: "docker"` is a
// host port published by a container attributed to the worktree (from the cached inspect, pid null, comm the
// container's name). `addr` is loopback or any; IPv4 and IPv6 on one port are one item. `since` is carried
// from the previous row while the port stays, else now. The socket scan stops after LISTEN_MS (300 ms):
// a worktree it did not finish keeps its previous `listen` and goes first on the next scan.
import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Observer } from "../core/plugins.ts";
import type { Store } from "../core/store.ts";
import { bootTime, CLK_TCK, cpuCharges, cpuDeltas, cpuPct, cpuSample, parseStat, procKey, readCgroup, readCmdline, readCwdRaw, readExe, readListening, readSocketInodes, readText, scanOnce, type CpuSample, type Listening, type Proc } from "../io/proc.ts";
import { envInt } from "../core/tick.ts";
import { noteLaneMove } from "../capacity/slot.ts";
import { psi } from "./machine.ts";

type WtId = { project: string; wt: string };
type Wt = WtId & { path: string };
type Worker = WtId & { pid: number; started_at: number | null };
type Sum = { procs: number; rss_kb: number; ticks: number; charged: number };
const key = (r: WtId) => `${r.project}\0${r.wt}`;
const BTIME_SLACK_S = 1;  // /proc/stat's btime can read a second apart between reads
const INSPECT_RETRY_S = 300;  // a failed docker inspect is retried for those ids after this long

// What the observer needs of a container: its name and the host dirs it works from.
export type Container = { name: string; dirs: string[]; ports?: Listening[] };
export type Listen = Listening & { pid: number | null; comm: string; since: number; src: "proc" | "docker" };
export const LISTEN_MS = 300;
export type Inspect = (ids: string[]) => Promise<Map<string, Container> | null>;
export type ProcsOpts = {
  proc?: string;          // the /proc root
  inspect?: Inspect;      // docker inspect; null result = Docker unavailable
  cgroupRoot?: string;    // /sys/fs/cgroup: memory.stat and *.pressure of the leaf cgroups
  listenMs?: number;      // the socket scan's budget (LISTEN_MS)
};

// Memory charged to each owner (KTD6): `leaves` maps a leaf cgroup path to its owners' RSS in it.
// A leaf without the memory controller (no memory.stat, e.g. systemd-udevd.service/udev) is charged
// to its nearest ancestor that has it, as the kernel does; v2 enables controllers top-down, so these
// never nest. One reached only at `/`, or whose cgroup is gone (its processes exited), charges
// nothing. A unit with no RSS splits evenly across its owners. null without cgroup v2, when no leaf
// reaches a memory-controller cgroup, or when any memory.stat that exists can't be read.
export function chargedMemory(cgroupRoot: string, leaves: Map<string, Map<string, number>>): Map<string, number> | null {
  if (!existsSync(join(cgroupRoot, "cgroup.controllers"))) return null;
  const units = new Map<string, Map<string, number>>();
  for (const [leaf, owners] of leaves) {
    if (!existsSync(join(cgroupRoot, leaf))) continue;
    let cg = leaf;
    while (cg !== "/" && !existsSync(join(cgroupRoot, cg, "memory.stat"))) cg = dirname(cg);
    if (cg === "/") continue;
    const u = units.get(cg) ?? new Map<string, number>();
    for (const [o, r] of owners) u.set(o, (u.get(o) ?? 0) + r);
    units.set(cg, u);
  }
  if (units.size === 0) return null;  // no memory controller below `/`, or a cgroup namespace (all `0::/`)
  const out = new Map<string, number>();
  for (const [cg, owners] of units) {
    const stat = readText(join(cgroupRoot, cg, "memory.stat"));
    const anon = stat && /^anon (\d+)$/m.exec(stat), shmem = stat && /^shmem (\d+)$/m.exec(stat);
    if (!anon || !shmem) return null;
    const kb = (Number(anon[1]) + Number(shmem[1])) / 1024;
    const rss = [...owners.values()].reduce((a, b) => a + b, 0);
    for (const [o, r] of owners) out.set(o, (out.get(o) ?? 0) + kb * (rss > 0 ? r / rss : 1 / owners.size));
  }
  return out;
}

// CPU charged to each owner from the leaf cgroups' cpu.stat (machine-top-ram-clarity U9): a leaf's usage_usec
// delta since the previous scan of that same leaf, in percent of one core (100 = one core), split across the
// owners of its processes by their CPU ticks in it (RSS when none had ticks). Counts processes that start and
// exit between scans, which sampled ticks miss. A leaf with no previous reading (first scan, or new) or one
// that is gone charges nothing; one whose cpu.stat exists but can't be read makes the whole scan null.
// `usage` is the next scan's baseline, only the leaves seen now. null without cgroup v2 or on the first scan.
export type CgUsage = Map<string, { usec: number; at: number }>;
export function chargedCpu(cgroupRoot: string, leaves: Map<string, Map<string, number>>, ticks: Map<string, Map<string, number>>,
    prev: CgUsage | null, now: number): { cpu: Map<string, number> | null; usage: CgUsage } {
  const usage: CgUsage = new Map();
  if (!existsSync(join(cgroupRoot, "cgroup.controllers"))) return { cpu: null, usage };
  const out = new Map<string, number>();
  let bad = false;
  for (const [leaf, rss] of leaves) {
    if (!existsSync(join(cgroupRoot, leaf))) continue;
    const m = /^usage_usec (\d+)$/m.exec(readText(join(cgroupRoot, leaf, "cpu.stat")) ?? "");
    if (!m) { bad = true; continue; }
    const u = Number(m[1]);
    usage.set(leaf, { usec: u, at: now });
    const p = prev?.get(leaf);
    if (!p || now <= p.at || u < p.usec) continue;
    const pct = (u - p.usec) / ((now - p.at) * 1e6) * 100;
    const tk = ticks.get(leaf) ?? new Map<string, number>();
    const tsum = [...tk.values()].reduce((a, b) => a + b, 0);
    const w = tsum > 0 ? tk : rss;
    const wsum = [...w.values()].reduce((a, b) => a + b, 0);
    for (const o of rss.keys()) out.set(o, (out.get(o) ?? 0) + pct * (wsum > 0 ? (w.get(o) ?? 0) / wsum : 1 / rss.size));
  }
  return { cpu: bad || prev === null ? null : out, usage };
}

// The worst `some` avg10 of a set of leaf cgroups' <kind>.pressure; null when none can be read.
function leafPressure(cgroupRoot: string, leaves: Iterable<string>, kind: "cpu" | "memory"): number | null {
  let worst: number | null = null;
  for (const cg of leaves) {
    const v = psi(readText(join(cgroupRoot, cg, `${kind}.pressure`)), "some");
    if (v !== null && (worst === null || v > worst)) worst = v;
  }
  return worst;
}

// The loop's own load (U5, KTD12). The loop is the process reading `<proc>/self` (a fixture links it
// to a pid). Its cgroup counts only when it is not `/` and every pid in its cgroup.procs is the loop or
// a descendant (a pid that started after the scan is walked through its own stat; one already gone is
// skipped): then CPU is the cpu.stat usage_usec delta since the previous scan of the same cgroup (it
// counts helpers that start and exit between scans; the first scan has none), own memory is
// memory.stat anon + shmem and cache is its `file`. Otherwise, or when those files can't be read, it
// is the loop's process tree from this scan: tick CPU and RSS, no cache. All NULL when the loop isn't
// in the scan (a fixture /proc without `self`).
export type LoopLoad = { loop_cpu_pct: number | null; loop_mem_kb: number | null; loop_cache_kb: number | null; loop_source: "cgroup" | "tree" | null };
export type LoopUsage = { cg: string; usec: number; at: number };
type LoopIn = { proc: string; cgroupRoot: string; byPid: Map<number, Proc>; ticks: (p: Proc) => number; secs: number | null; now: number; prev: LoopUsage | null };
export function loopLoad(o: LoopIn): { load: LoopLoad; usage: LoopUsage | null } {
  const none = { load: { loop_cpu_pct: null, loop_mem_kb: null, loop_cache_kb: null, loop_source: null }, usage: o.prev };
  let self: number;
  try { self = Number(readlinkSync(join(o.proc, "self"))); } catch { return none; }
  if (!o.byPid.has(self)) return none;
  const ppid = (pid: number) => o.byPid.get(pid)?.ppid ?? parseStat(readText(join(o.proc, String(pid), "stat")) ?? "")?.ppid ?? null;
  const ours = (pid: number) => {  // null: gone before we could look
    let cur: number | null = pid;
    for (let n = 0; cur !== null && n < 64; n++) {
      if (cur === self) return true;
      if (cur <= 1) return false;
      const up = ppid(cur);
      if (up === null) return n === 0 ? null : false;
      cur = up;
    }
    return false;
  };
  const cg = readCgroup(o.proc, self);
  if (cg !== null && cg !== "/") {
    const dir = join(o.cgroupRoot, cg);
    const pids = (readText(join(dir, "cgroup.procs")) ?? "").split("\n").filter(Boolean).map(Number);
    const usec = /^usage_usec (\d+)$/m.exec(readText(join(dir, "cpu.stat")) ?? "");
    const stat = readText(join(dir, "memory.stat")) ?? "";
    const field = (k: string) => { const m = new RegExp(`^${k} (\\d+)$`, "m").exec(stat); return m ? Number(m[1]) : null; };
    const anon = field("anon"), shmem = field("shmem"), file = field("file");
    if (pids.includes(self) && pids.every((p) => ours(p) !== false) && usec && anon !== null && shmem !== null && file !== null) {
      const u = Number(usec[1]), p = o.prev;
      const cpu = p && p.cg === cg && o.now > p.at && u >= p.usec ? Math.round((u - p.usec) / ((o.now - p.at) * 1e6) * 1000) / 10 : null;
      return { load: { loop_cpu_pct: cpu, loop_mem_kb: Math.round((anon + shmem) / 1024), loop_cache_kb: Math.round(file / 1024), loop_source: "cgroup" },
        usage: { cg, usec: u, at: o.now } };
    }
  }
  let ticks = 0, rss = 0;
  for (const p of o.byPid.values()) if (ours(p.pid)) { ticks += o.ticks(p); rss += p.rss_kb; }
  return { load: { loop_cpu_pct: o.secs ? cpuPct(ticks, o.secs) : null, loop_mem_kb: rss, loop_cache_kb: null, loop_source: "tree" }, usage: o.prev };
}

const canon = (p: string) => { let r = p; try { r = realpathSync(p); } catch { /* not on this host */ } return r.length > 1 ? r.replace(/\/+$/, "") : r; };
const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

// `docker inspect` of the given ids: name, compose working dir label, bind-mount sources and published host TCP ports. An id
// that vanished is just missing from the map; null when docker can't be run or says nothing.
export const dockerInspect: Inspect = async (ids) => {
  try {
    const p = Bun.spawn(["docker", "inspect", ...ids], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => p.kill(), 5000);
    const out = await new Response(p.stdout).text();
    await p.exited; clearTimeout(timer);
    const arr = JSON.parse(out || "null");
    if (!Array.isArray(arr) || !arr.length) return null;
    const m = new Map<string, Container>();
    for (const c of arr) {
      if (typeof c?.Id !== "string") continue;
      const dirs: string[] = [];
      const wd = c.Config?.Labels?.["com.docker.compose.project.working_dir"];
      if (typeof wd === "string" && wd) dirs.push(wd);
      for (const mt of Array.isArray(c.Mounts) ? c.Mounts : []) if (mt?.Type === "bind" && typeof mt.Source === "string") dirs.push(mt.Source);
      m.set(c.Id, { name: String(c.Name ?? "").replace(/^\//, "") || c.Id.slice(0, 12), dirs, ports: publishedPorts(c.NetworkSettings?.Ports) });
    }
    return m;
  } catch { return null; }
};

// NetworkSettings.Ports ({"5432/tcp": [{HostIp, HostPort}], …}): the TCP ports bound on the host.
export function publishedPorts(ports: unknown): Listening[] {
  const out: Listening[] = [];
  if (!ports || typeof ports !== "object") return out;
  for (const [spec, binds] of Object.entries(ports as Record<string, unknown>)) {
    if (!spec.endsWith("/tcp") || !Array.isArray(binds)) continue;
    for (const b of binds as { HostIp?: unknown; HostPort?: unknown }[]) {
      const port = Number(b?.HostPort);
      if (!Number.isInteger(port) || port <= 0) continue;
      const ip = String(b?.HostIp ?? "");
      out.push({ port, addr: /^127\./.test(ip) || ip === "::1" ? "loopback" : "any" });
    }
  }
  return out;
}

const INTERP = /^(node|nodejs|bun|deno|python[\d.]*|ruby|perl|java)$/;
// Options that take a value, so the word after them is not the script.
const VALUE_OPTS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-cp", "-classpath", "--class-path", "-p", "--module-path", "-W", "-X"]);

// The `exe script` label: the executable's basename (argv[0] as `ps` shows it, cut at a rewritten
// title's first space or colon; else the exe link), plus the script an interpreter runs
// (`node server.mjs`, `bun cli.ts`, `python3 mod`, `java app.jar`). null when nothing is readable.
export function exeScript(exe: string | null, argv: string[]): string | null {
  const name = basename((argv[0] ?? "").split(/[\s:]/)[0] ?? "") || basename(exe ?? "");
  if (!name) return null;
  if (!INTERP.test(name)) return name;
  const args = argv.slice(1);
  let script: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-jar" || a === "-m") { script = args[i + 1] ?? null; break; }
    if (a === "-e" || a === "--eval" || a === "-c") break;
    if (VALUE_OPTS.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    if (name === "bun" && (a === "run" || a === "x")) continue;
    script = a; break;
  }
  if (!script) return name;
  const s = name === "java" && !script.includes("/") && !script.endsWith(".jar") ? script.split(".").pop()! : basename(script);
  return s ? `${name} ${s}` : name;
}

function attribute(procs: Proc[], roots: Map<number, string>, wts: { key: string; path: string }[], cwd: (pid: number) => string | null): Map<number, string | null> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const rootCache = new Map<number, string | null>();
  const nearest = (pid: number): string | null => {
    const chain: number[] = [], seen = new Set<number>();
    let cur: number | undefined = pid, found: string | null = null;
    while (cur !== undefined && !seen.has(cur)) {
      if (rootCache.has(cur)) { found = rootCache.get(cur)!; break; }
      if (roots.has(cur)) { found = roots.get(cur)!; break; }
      seen.add(cur); chain.push(cur);
      cur = byPid.get(cur)?.ppid;
    }
    for (const c of chain) rootCache.set(c, found);
    return found;
  };
  const out = new Map<number, string | null>();
  for (const p of procs) {
    let k = nearest(p.pid);
    if (k === null && wts.length) {
      const c = cwd(p.pid);
      if (c !== null) k = wts.find((w) => under(c, w.path))?.key ?? null;
    }
    out.set(p.pid, k);
  }
  return out;
}

// Builder worktree (project\0wt) → its open unit. A worktree on two units (one re-used for a later
// unit) goes to the unit naming it as builder_wt, then the newest.
function unitsByWt(db: Store["db"]): Map<string, { squad: string; slug: string }> {
  const rows = db.query(`SELECT m.project, m.wt, u.squad, u.slug FROM members m
    JOIN units u ON u.project = m.project AND u.squad = m.squad AND (u.builder_wt = m.wt OR u.slug = m.suffix)
    WHERE m.role = 'builder' AND m.wt IS NOT NULL AND m.wt != '' AND COALESCE(u.status, 'planned') NOT IN ('done', 'cancelled')
    ORDER BY (u.builder_wt = m.wt) DESC, u.id DESC`).all() as (WtId & { squad: string; slug: string })[];
  const out = new Map<string, { squad: string; slug: string }>();
  for (const r of rows) if (!out.has(key(r))) out.set(key(r), { squad: r.squad, slug: r.slug });
  return out;
}

// Where a removed worktree's path belongs: the observed_worktrees row (live or gone) whose path
// holds it, else the project whose workspace root (a worktree path's parent) holds it, the
// `<DS_PREFIX><project>-` name settling a root several projects share. Gives the row key and the
// worktree path it matched.
function leftovers(all: Wt[]): (path: string) => { key: string; path: string } | null {
  const dirs = new Map<string, string>();
  const norm = (p: string) => { const d = dirname(p); if (!dirs.has(d)) dirs.set(d, canon(d)); const c = dirs.get(d)!; return c === "/" ? `/${basename(p)}` : `${c}/${basename(p)}`; };
  const known = all.map((w) => ({ key: key(w), path: norm(w.path) })).filter((w) => w.path !== "/" && dirname(w.path) !== "/")
    .sort((a, b) => b.path.length - a.path.length);
  const roots = new Map<string, Set<string>>();
  for (const w of all) {
    const r = dirname(norm(w.path));
    if (r === "/" || r === ".") continue;
    if (!roots.has(r)) roots.set(r, new Set());
    roots.get(r)!.add(w.project);
  }
  const prefix = process.env.DS_PREFIX || "ds-";
  return (path) => {
    const hit = known.find((w) => under(path, w.path));
    if (hit) return hit;
    for (const [r, projects] of roots) {
      if (!path.startsWith(`${r}/`)) continue;
      const seg = path.slice(r.length + 1).split("/")[0];
      if (!seg) continue;
      let ps = [...projects];
      if (ps.length > 1) ps = ps.filter((p) => seg.startsWith(`${prefix}${p}-`)).sort((a, b) => b.length - a.length).slice(0, 1);
      if (ps.length === 1) return { key: key({ project: ps[0], wt: `${r}/${seg}` }), path: `${r}/${seg}` };
    }
    return null;
  };
}

// The previous scan's `listen` of every row, by row key (raw JSON).
function prevListen(db: Store["db"]): Map<string, string | null> {
  let rows: (WtId & { listen: string | null })[] = [];
  try { rows = db.query("SELECT project, wt, listen FROM observed_procs").all() as typeof rows; } catch { /* before migration 0049 */ }
  return new Map(rows.map((r) => [key(r), r.listen]));
}

// Each row's `listen` JSON (see the header): its containers' published ports, then the listening sockets its
// processes hold. The socket scan visits the rows whose scan finished longest ago first and stops at `ms`;
// a row it did not finish keeps its previous value. No listening socket on the host: no fd is read.
function listenScan(o: { proc: string; procs: Proc[]; owner: Map<number, string | null>; skip: (p: Proc) => boolean; keys: string[];
    containers: Map<string, { c: Container | null }>; ctrOwner: Map<string, string | null>; prev: Map<string, string | null>;
    done: Map<string, number>; now: number; ms: number }): Map<string, string | null> {
  const found = new Map<string, Map<number, Omit<Listen, "since">>>();
  const add = (k: string, l: Omit<Listen, "since">) => {
    const m = found.get(k) ?? new Map<number, Omit<Listen, "since">>();
    const had = m.get(l.port);
    if (!had) m.set(l.port, l); else if (l.addr === "any") had.addr = "any";
    found.set(k, m);
  };
  for (const [id, k] of o.ctrOwner) {
    const c = o.containers.get(id)?.c;
    if (k !== null && c) for (const p of c.ports ?? []) add(k, { ...p, pid: null, comm: c.name, src: "docker" });
  }
  const t0 = performance.now(), deadline = t0 + o.ms;
  const sockets = readListening(o.proc) ?? new Map();
  const reached = new Set<string>();
  if (!sockets.size) for (const k of o.keys) reached.add(k);
  else {
    const by = new Map<string, Proc[]>();
    for (const p of o.procs) {
      const k = o.owner.get(p.pid);
      if (k == null || o.skip(p)) continue;
      const a = by.get(k) ?? [];
      a.push(p); by.set(k, a);
    }
    const order = [...o.keys].sort((a, b) => (o.done.get(a) ?? -1) - (o.done.get(b) ?? -1));
    let cut = false;
    for (const k of order) {
      for (const p of by.get(k) ?? []) {
        const inodes = performance.now() > deadline ? null : readSocketInodes(o.proc, p.pid, deadline);
        if (inodes === null) { cut = true; break; }
        for (const i of inodes) { const l = sockets.get(i); if (l) add(k, { ...l, pid: p.pid, comm: p.comm, src: "proc" }); }
      }
      if (cut) break;
      reached.add(k);
    }
  }
  const out = new Map<string, string | null>();
  for (const k of o.keys) {
    if (!reached.has(k)) { out.set(k, o.prev.get(k) ?? null); continue; }
    o.done.set(k, o.now);
    let was: Listen[] = [];
    try { was = JSON.parse(o.prev.get(k) ?? "[]") as Listen[]; } catch { /* unreadable: since restarts */ }
    const since = new Map((Array.isArray(was) ? was : []).map((l) => [l.port, l.since]));
    const list = [...(found.get(k)?.values() ?? [])].sort((a, b) => a.port - b.port)
      .map((l) => ({ port: l.port, addr: l.addr, pid: l.pid, comm: l.comm, since: since.get(l.port) ?? o.now, src: l.src }));
    out.set(k, JSON.stringify(list));
  }
  return out;
}

export function procsObserver(opts: ProcsOpts = {}): Observer {
  const proc = opts.proc ?? "/proc", inspect = opts.inspect ?? dockerInspect, cgroupRoot = opts.cgroupRoot ?? "/sys/fs/cgroup";
  const listenMs = opts.listenMs ?? LISTEN_MS;
  const listenAt = new Map<string, number>();  // row key → the tick its socket scan last finished
  let prev: { at: number; ticks: Map<string, number> } | null = null;
  const containers = new Map<string, { c: Container | null; until: number }>();
  let prevCpu: CpuSample | null = null, prevCg: CgUsage | null = null, prevLoop: LoopUsage | null = null;
  return {
    name: "procs",
    scope: "host",
    every: envInt("DS_LOOP_MACHINE_S", 30),
    async run({ store, tick, now }) {
      const scan = scanOnce(tick, proc);
      if (!scan.procs.length) return;
      const t0 = performance.now();
      const byPid = new Map(scan.procs.map((p) => [p.pid, p]));
      const btime = bootTime(proc);
      const workers = store.db.query("SELECT project, wt, pid, started_at FROM observed_workers WHERE gone_at IS NULL AND pid IS NOT NULL").all() as Worker[];
      const roots = new Map<number, string>(), rootOf = new Map<string, number>();
      for (const w of workers) {
        const p = byPid.get(w.pid);
        if (!p || btime === null || w.started_at === null) continue;
        if (Math.abs(btime + Math.floor(p.start / CLK_TCK) - w.started_at) > BTIME_SLACK_S) continue;
        roots.set(p.pid, key(w)); rootOf.set(key(w), p.pid);
      }
      const wts = (store.db.query("SELECT project, wt, path FROM observed_worktrees WHERE gone_at IS NULL AND path IS NOT NULL AND host = 'local'").all() as Wt[])
        .map((w) => ({ key: key(w), path: canon(w.path) })).filter((w) => w.path !== "/").sort((a, b) => b.path.length - a.path.length);
      const cwds = new Map<number, { path: string; deleted: boolean } | null>();
      const cwdOf = (pid: number) => { if (!cwds.has(pid)) cwds.set(pid, readCwdRaw(proc, pid)); return cwds.get(pid)!; };
      const owner = attribute(scan.procs, roots, wts, (pid) => cwdOf(pid)?.path ?? null);

      // Unowned processes: their leaf cgroup, and the containers among them.
      const cgs = new Map<number, string | null>();
      const cgOf = (pid: number) => { if (!cgs.has(pid)) cgs.set(pid, readCgroup(proc, pid)); return cgs.get(pid)!; };
      const leafOf = new Map<number, string | null>(), dockerOf = new Map<number, string>();
      for (const p of scan.procs) {
        if (owner.get(p.pid) != null) continue;
        const cg = cgOf(p.pid), leaf = cg ? cg.slice(cg.lastIndexOf("/") + 1) : null;
        leafOf.set(p.pid, leaf);
        const d = leaf ? /^docker-([0-9a-f]{12,64})\.scope$/.exec(leaf) : null;
        if (d) dockerOf.set(p.pid, d[1]);
      }
      const ids = new Set(dockerOf.values());
      const want = [...ids].filter((id) => (containers.get(id)?.until ?? 0) <= now);
      if (want.length) {
        const got = await inspect(want);
        for (const id of want) {
          const c = got?.get(id);
          containers.set(id, c ? { c: { name: c.name, dirs: c.dirs.map(canon), ports: c.ports ?? [] }, until: Infinity } : { c: null, until: now + INSPECT_RETRY_S });
        }
      }
      for (const id of containers.keys()) if (!ids.has(id)) containers.delete(id);

      let leftoverOf: ReturnType<typeof leftovers> | null = null;
      const leftover = (p: string) => (leftoverOf ??= leftovers(store.db.query("SELECT project, wt, path FROM observed_worktrees WHERE path IS NOT NULL AND host = 'local'").all() as Wt[]))(p);
      // A container's owner: the live worktree holding its compose dir or a bind source (longest
      // wins), else a removed worktree's leftover row; null leaves it a host group.
      const ctrOwner = new Map<string, string | null>();
      const containerOwner = (id: string, c: Container): string | null => {
        if (ctrOwner.has(id)) return ctrOwner.get(id)!;
        let k: string | null = null, best = -1;
        for (const d of c.dirs) { const w = wts.find((x) => under(d, x.path)); if (w && w.path.length > best) { k = w.key; best = w.path.length; } }
        for (const d of k === null ? c.dirs : []) { const l = leftover(d); if (l !== null && !existsSync(l.path)) { k = l.key; break; } }
        ctrOwner.set(id, k);
        return k;
      };
      const labels = new Map<number, string>(), bare: Proc[] = [];  // no label: a kernel thread keeps its comm
      for (const p of scan.procs) {
        if (owner.get(p.pid) != null) continue;
        const id = dockerOf.get(p.pid), c = id ? containers.get(id)?.c ?? null : null;
        if (id && c) {
          const k = containerOwner(id, c);
          if (k !== null) owner.set(p.pid, k); else labels.set(p.pid, c.name);
          continue;
        }
        if (id) { labels.set(p.pid, id.slice(0, 12)); continue; }  // Docker can't be asked: the short id, not the process's exe
        const cwd = cwdOf(p.pid);
        if (cwd?.deleted) { const l = leftover(cwd.path); if (l !== null) { owner.set(p.pid, l.key); continue; } }
        const leaf = leafOf.get(p.pid);
        const svc = leaf ? /^(.+)\.service$/.exec(leaf) : null;
        const lb = svc ? svc[1] : exeScript(readExe(proc, p.pid), readCmdline(proc, p.pid));
        if (lb !== null) labels.set(p.pid, lb);
        else if (p.ppid !== 2 && p.pid !== 2) bare.push(p);  // exiting or a zombie: its parent's label
      }
      for (const p of bare) {
        let q = byPid.get(p.ppid), n = 0;
        while (q && !labels.has(q.pid) && owner.get(q.pid) == null && n++ < 8) q = byPid.get(q.ppid);
        const lb = q ? labels.get(q.pid) : undefined;
        if (lb !== undefined) labels.set(p.pid, lb);
      }

      const delta = cpuDeltas(prev, scan.procs, now);
      const charges = delta ? cpuCharges(prevCpu, scan.procs) : null;
      const secs = prev ? now - prev.at : 0;
      const pct = (t: number) => (delta ? cpuPct(t, secs) : null);
      const per = new Map<string, Sum>(), groups = new Map<string, Omit<Sum, "charged"> & { label: string; comm: string; top: number }>();
      let hostProcs = 0, hostRss = 0;
      // Leaf cgroup → owner → RSS in it (host groups keyed "\x01<label>"), and each row's leaves.
      const leaves = new Map<string, Map<string, number>>(), leafTicks = new Map<string, Map<string, number>>(), rowLeaves = new Map<string, Set<string>>();
      for (const p of scan.procs) {
        const k = owner.get(p.pid) ?? null, t = delta?.get(procKey(p)) ?? 0;
        let o: string;
        if (k !== null) {
          const e = per.get(k) ?? { procs: 0, rss_kb: 0, ticks: 0, charged: 0 };
          e.procs++; e.rss_kb += p.rss_kb; e.ticks += t; e.charged += charges?.get(p.pid) ?? 0; per.set(k, e);
          o = k;
        } else {
          const label = labels.get(p.pid) ?? p.comm;
          const e = groups.get(label) ?? { label, comm: p.comm, top: -1, procs: 0, rss_kb: 0, ticks: 0 };
          if (p.rss_kb > e.top) { e.comm = p.comm; e.top = p.rss_kb; }
          e.procs++; e.rss_kb += p.rss_kb; e.ticks += t; groups.set(label, e);
          hostProcs++; hostRss += p.rss_kb;
          o = `\x01${label}`;
        }
        const cg = cgOf(p.pid);
        if (cg === null || cg === "/") continue;  // gone, or in the root cgroup: charges nothing
        const m = leaves.get(cg) ?? new Map<string, number>();
        m.set(o, (m.get(o) ?? 0) + p.rss_kb); leaves.set(cg, m);
        const lt = leafTicks.get(cg) ?? new Map<string, number>();
        lt.set(o, (lt.get(o) ?? 0) + t); leafTicks.set(cg, lt);
        if (k !== null) { const s = rowLeaves.get(k) ?? new Set<string>(); s.add(cg); rowLeaves.set(k, s); }
      }
      const mem = chargedMemory(cgroupRoot, leaves);
      const memOf = (o: string) => (mem ? Math.round(mem.get(o) ?? 0) : null);
      const cgCpu = chargedCpu(cgroupRoot, leaves, leafTicks, prevCg, now);
      prevCg = cgCpu.usage;
      const cpuCgOf = (o: string) => (cgCpu.cpu ? Math.round((cgCpu.cpu.get(o) ?? 0) * 10) / 10 : null);
      const pressure = new Map([...per.keys()].map((k) => {
        const lv = rowLeaves.get(k) ?? [];
        return [k, { psi_cpu: leafPressure(cgroupRoot, lv, "cpu"), psi_mem: leafPressure(cgroupRoot, lv, "memory") }];
      }));
      const lp = loopLoad({ proc, cgroupRoot, byPid, ticks: (p) => delta?.get(procKey(p)) ?? 0, secs: delta ? secs : null, now, prev: prevLoop });
      prevLoop = lp.usage;
      prev = { at: now, ticks: new Map(scan.procs.map((p) => [procKey(p), p.ticks])) };
      prevCpu = cpuSample(scan.procs);
      const units = unitsByWt(store.db);
      const listen = listenScan({ proc, procs: scan.procs, owner, skip: (p) => roots.has(p.pid) || dockerOf.has(p.pid), keys: [...per.keys()], containers, ctrOwner,
        prev: prevListen(store.db), done: listenAt, now, ms: listenMs });
      for (const k of listenAt.keys()) if (!per.has(k)) listenAt.delete(k);
      const ms = Math.round((scan.ms + performance.now() - t0) * 10) / 10;

      store.tx(() => {
        for (const [k, e] of per) {
          const [project, wt] = k.split("\0");
          store.upsert("observed_procs", { project, wt }, { procs: e.procs, rss_kb: e.rss_kb, cpu_pct: pct(e.ticks), cpu_cg_pct: cpuCgOf(k), mem_kb: memOf(k),
            ...pressure.get(k)!, root_pid: rootOf.get(k) ?? null, listen: listen.get(k) ?? null, observed_at: now });
          const u = units.get(k);
          if (!u) continue;
          const charged = Math.max(0, e.charged);
          store.db.run(`INSERT INTO unit_cpu (project, squad, slug, cpu_s, peak_cpu_pct, peak_rss_kb, wt, first_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (project, squad, slug) DO UPDATE SET cpu_s = cpu_s + excluded.cpu_s,
              peak_cpu_pct = CASE WHEN excluded.peak_cpu_pct IS NULL THEN peak_cpu_pct ELSE MAX(COALESCE(peak_cpu_pct, 0), excluded.peak_cpu_pct) END,
              peak_rss_kb = MAX(COALESCE(peak_rss_kb, 0), excluded.peak_rss_kb), wt = excluded.wt, updated_at = excluded.updated_at`,
          [project, u.squad, u.slug, charged / CLK_TCK, charges ? cpuPct(charged, secs) : null, e.rss_kb, wt, now, now]);
          noteLaneMove(store, project, u.squad, u.slug);   // a light unit past light_lane_cpu_h (U3)
        }
        // side-loop-host U6: a side host's uploaded rows (host != local) are not this scan's to drop.
        for (const r of store.db.query("SELECT project, wt FROM observed_procs WHERE host = 'local'").all() as WtId[]) {
          if (!per.has(key(r))) store.db.run("DELETE FROM observed_procs WHERE project = ? AND wt = ? AND host = 'local'", [r.project, r.wt]);
        }
        const g = [...groups.values()].map((e) => ({ label: e.label, comm: e.comm, procs: e.procs, rss_kb: e.rss_kb, mem_kb: memOf(`\x01${e.label}`), cpu_pct: pct(e.ticks), cpu_cg_pct: cpuCgOf(`\x01${e.label}`) }))
          .sort((a, b) => b.rss_kb - a.rss_kb);
        store.upsert("observed_host_procs", { host: "local" }, { groups: JSON.stringify(g), procs: hostProcs, rss_kb: hostRss, scan_ms: ms, ...lp.load, observed_at: now });
      });
    },
  };
}

export default procsObserver();
