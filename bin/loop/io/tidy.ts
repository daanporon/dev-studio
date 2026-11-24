// tidy.ts — the shared cleanup safety module (host-disk-cleanup KTD1): every primitive that reads or
// changes host state for cleanup lives here, so no cleanup rule is written twice.
//   inUse         the paths live processes hold: cwds and open files (KTD6)
//   procsUnder    the processes of this uid that belong to a worktree, minus the loop's own family and
//                 anything under a live agent (KTD7)
//   stopProcs     TERM, wait, KILL; pid and start time checked again before each signal
//   claudeTmpDir  a worktree's Claude session temp dir: <root>/<mangled worktree path>
//   removeGuarded lstat, never follow a link, this uid, the expected parent, not in use, past the age
//                 floor (KTD15)
//   closeTidy     the close-time order around a caller's worktree-rm (KTD10): before = the project's
//                 cleanup_on_close, then stop what is left; after = remove the Claude temp dir.
//   removeGlobBatch  one capped, guarded pass over a cleanup_tmp_globs entry (KTD9, host_tidy apply)
//   trimGlobBatch    the same inside each folder a cleanup_trim_globs entry matches, the folder kept
// Every root is a parameter so tests run on fixture trees; signalling needs the real /proc or an
// injected `kill`.
import { closeSync, mkdirSync, openSync, readdirSync, realpathSync } from "node:fs";
import { lstat, opendir, readdir, readlink, realpath, rm, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Action } from "../core/plugins.ts";
import type { Exec } from "../core/actuator.ts";
import { limitLine } from "../settings/limits.ts";
import { mangle } from "../observers/orca.ts";
import { bootTime, CLK_TCK, PAGE_KB, parseStat, readCwdRaw, readFdTargets, readText, readUid } from "./proc.ts";
import type { Store } from "../core/store.ts";
import { spawn } from "./orca.ts";
import { OURS, wtProbe } from "./wt-probe.ts";
import { NOTE_DIRS } from "./rescue.ts";

export type TProc = { pid: number; ppid: number; pgrp: number; start: number; state: string; rss_kb: number };
export type Agent = { pid: number; started_at: number | null };
type Kill = (pid: number, sig: NodeJS.Signals) => void;

const uidNow = () => process.getuid?.() ?? -1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const envNum = (k: string, d: number) => { const v = Number(process.env[k]); return Number.isFinite(v) && v >= 0 && process.env[k] !== "" ? v : d; };
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
const canon = (p: string) => { try { return realpathSync(p); } catch { return p; } };

export function claudeTmpRoot(): string { return process.env.DS_CLAUDE_TMP_ROOT || `/tmp/claude-${uidNow()}`; }
export function claudeTmpDir(path: string, root = claudeTmpRoot()): string { return join(root, mangle(path)); }

function readProc(root: string, pid: number): TProc | null {
  const s = readText(join(root, String(pid), "stat"));
  const p = s === null ? null : parseStat(s);
  if (!p) return null;
  const pages = Number((readText(join(root, String(pid), "statm")) ?? "").split(" ")[1]);
  return { pid: p.pid, ppid: p.ppid, pgrp: p.pgrp, start: p.start, state: p.state, rss_kb: Number.isFinite(pages) ? pages * PAGE_KB : 0 };
}
function scan(root: string): TProc[] {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  const out: TProc[] = [];
  for (const n of names) if (/^\d+$/.test(n)) { const p = readProc(root, Number(n)); if (p) out.push(p); }
  return out;
}

// KTD6: built once per action. `holder(path)` is a pid whose cwd or an open file is the path or under it.
// `exact` is the one-lookup form for a plain file, which only a link to itself can hold.
export type InUse = { holder(path: string): number | null; exact?(path: string): number | null };
export function inUse(procRoot = "/proc"): InUse {
  const held: { pid: number; path: string }[] = [];
  for (const p of scan(procRoot)) {
    const cwd = readCwdRaw(procRoot, p.pid);
    if (cwd) held.push({ pid: p.pid, path: cwd.path });
    for (const f of readFdTargets(procRoot, p.pid)) held.push({ pid: p.pid, path: f });
  }
  const byPath = new Map<string, number>();
  for (const h of held) if (!byPath.has(h.path)) byPath.set(h.path, h.pid);
  return {
    holder(path: string) {
      const roots = [...new Set([path, canon(path)])];
      return held.find((h) => roots.some((r) => under(h.path, r)))?.pid ?? null;
    },
    exact: (path: string) => byPath.get(path) ?? null,
  };
}

export type UnderOpts = {
  proc?: string;            // the /proc root
  uid?: number;             // whose processes may match (default this process's)
  self?: number;            // the loop's own pid: it, its ancestors and its descendants never match
  agents?: Agent[];         // live agents (observed_workers): nothing under them is stopped
  groups?: number[];        // process groups that match wherever they run (cleanup_on_close's own)
};
// One /proc scan with the relations KTD7 needs: the loop's own family (itself, its ancestors and its
// descendants) and which processes run under a live agent (trusted only while its start time matches).
export type ProcIndex = { all: TProc[]; byPid: Map<number, TProc>; kids: Map<number, number[]>; family: Set<number>;
  boot: number | null; underAgent(pid: number): number | null };
export function procIndex(root = "/proc", self = process.pid, agentList: Agent[] = []): ProcIndex {
  const all = scan(root), byPid = new Map(all.map((p) => [p.pid, p]));
  const kids = new Map<number, number[]>();
  for (const p of all) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const family = new Set<number>();
  for (let cur: number | undefined = self; cur !== undefined && cur > 0 && !family.has(cur); cur = byPid.get(cur)?.ppid) family.add(cur);
  for (const q = [self]; q.length;) for (const k of kids.get(q.pop()!) ?? []) if (!family.has(k)) { family.add(k); q.push(k); }
  const bt = bootTime(root), agents = new Set<number>();
  for (const a of agentList) {
    const p = byPid.get(a.pid);
    if (p && bt !== null && a.started_at !== null && Math.abs(bt + Math.floor(p.start / CLK_TCK) - a.started_at) <= 1) agents.add(p.pid);
  }
  const underAgent = (pid: number) => {
    const seen = new Set<number>();
    for (let cur: number | undefined = pid; cur !== undefined && !seen.has(cur); cur = byPid.get(cur)?.ppid) { if (agents.has(cur)) return cur; seen.add(cur); }
    return null;
  };
  return { all, byPid, kids, family, boot: bt, underAgent };
}

// KTD7: this uid, cwd equal to or under the worktree, plus their descendants; `groups` members too.
// `spared` lists the matches that run under a live agent (trusted only while its start time matches).
export function procsUnder(path: string, o: UnderOpts = {}): { procs: TProc[]; spared: TProc[] } {
  const root = o.proc ?? "/proc", uid = o.uid ?? uidNow(), self = o.self ?? process.pid;
  const { all, byPid, kids, family, underAgent } = procIndex(root, self, o.agents ?? []);
  const groups = new Set(o.groups ?? []);
  const roots = [...new Set([path, canon(path)])];
  const hit = new Set<number>();
  for (const p of all) {
    const inGroup = groups.has(p.pgrp) && p.pid !== self;
    if (family.has(p.pid) && !inGroup) continue;
    const cwd = readCwdRaw(root, p.pid);
    if (inGroup || (cwd && roots.some((r) => under(cwd.path, r)))) hit.add(p.pid);
  }
  for (const q = [...hit]; q.length;) for (const k of kids.get(q.pop()!) ?? []) if (!hit.has(k) && !family.has(k)) { hit.add(k); q.push(k); }
  const procs: TProc[] = [], spared: TProc[] = [];
  for (const pid of hit) {
    const p = byPid.get(pid)!;
    if (p.state === "Z" || readUid(root, pid) !== uid) continue;
    (underAgent(pid) !== null ? spared : procs).push(p);
  }
  return { procs: procs.sort((a, b) => a.pid - b.pid), spared: spared.sort((a, b) => a.pid - b.pid) };
}

export type StopOpts = { proc?: string; waitMs?: number; kill?: Kill };
// TERM, wait (default 10 s), KILL. Before each signal the pid must still carry the start time it was
// matched with, so a reused pid is never signalled. A fixture /proc never reaches process.kill.
export async function stopProcs(list: TProc[], o: StopOpts = {}): Promise<{ stopped: TProc[]; killed: number[] }> {
  const root = o.proc ?? "/proc", waitMs = o.waitMs ?? envNum("DS_TIDY_WAIT_MS", 10_000);
  if (!o.kill && root !== "/proc") throw new Error("stopProcs: a fixture /proc needs an injected kill");
  const kill: Kill = o.kill ?? ((pid, sig) => process.kill(pid, sig));
  const same = (p: TProc) => { const now = readProc(root, p.pid); return !!now && now.start === p.start && now.state !== "Z"; };
  const send = (p: TProc, sig: NodeJS.Signals) => { if (!same(p)) return false; try { kill(p.pid, sig); return true; } catch { return false; } };
  const stopped = list.filter((p) => send(p, "SIGTERM"));
  for (const end = Date.now() + waitMs; stopped.some(same) && Date.now() < end;) await sleep(100);
  const killed = stopped.filter((p) => send(p, "SIGKILL")).map((p) => p.pid);
  return { stopped, killed };
}

export type Guard = { root: string; uid?: number; ageFloorS?: number | null; now?: number; inUse?: InUse; proc?: string };
export type Removal = { removed: true; kb: number } | { removed: false; reason: string };
// KTD15. The age floor walk stops at the first entry newer than the floor; sizes are best effort.
export async function removeGuarded(path: string, g: Guard): Promise<Removal> {
  let st;
  try { st = await lstat(path); } catch { return { removed: false, reason: "gone" }; }
  if (st.isSymbolicLink()) return { removed: false, reason: "symlink" };
  if (st.uid !== (g.uid ?? uidNow())) return { removed: false, reason: "not ours" };
  let parent: string, root: string;
  try { [parent, root] = await Promise.all([realpath(dirname(path)), realpath(g.root)]); } catch { return { removed: false, reason: "root unknown" }; }
  if (parent !== root) return { removed: false, reason: "outside its root" };
  const pid = (g.inUse ?? inUse(g.proc)).holder(path);
  if (pid !== null) return { removed: false, reason: `in use by pid ${pid}` };
  const floor = g.ageFloorS == null ? null : (g.now ?? Date.now() / 1000) - g.ageFloorS;
  let kb = 0, n = 0, tooNew = false;
  const walk = async (p: string, s: Awaited<ReturnType<typeof lstat>>): Promise<void> => {
    if (tooNew) return;
    if (floor !== null && s.mtimeMs / 1000 > floor) { tooNew = true; return; }
    kb += Math.ceil(Number(s.blocks) / 2);
    if (++n % 1000 === 0) await sleep(0);
    if (!s.isDirectory()) return;
    let names: string[] = [];
    try { names = await readdir(p); } catch { return; }
    for (const name of names) { try { await walk(join(p, name), await lstat(join(p, name))); } catch { /* gone meanwhile */ } }
  };
  await walk(path, st);
  if (tooNew) return { removed: false, reason: "too new" };
  try { await rm(path, { recursive: true, force: true }); } catch (e) { return { removed: false, reason: `rm failed: ${(e as Error).message}` }; }
  return { removed: true, kb };
}

// KTD9: one guarded pass over a cleanup_tmp_globs entry's parent (U3, host_tidy apply). Each match of
// this uid past the age floor that nothing holds is removed: a file or a symlink by unlink (a link
// is never followed, so its target stays), a directory through removeGuarded. It stops after `max`
// removals or `maxMs`, whichever comes first, and yields as the scan does (KTD4).
export type GlobBatch = { count: number; kb: number; sample: string[]; capped: boolean };
type BatchOpts = { ageS: number; now: number; inUse: InUse; uid?: number; max?: number; maxMs?: number; dirs?: DirReader };
// One pass's state: its caps (DS_CLEANUP_BATCH entries, DS_CLEANUP_BATCH_MS), the age floor and the tally.
function batchPass(o: BatchOpts) {
  const max = o.max ?? envNum("DS_CLEANUP_BATCH", 50_000), end = Date.now() + (o.maxMs ?? envNum("DS_CLEANUP_BATCH_MS", 30_000));
  const out: GlobBatch = { count: 0, kb: 0, sample: [], capped: false };
  return { out, uid: o.uid ?? uidNow(), floor: o.now - o.ageS, tick: yielder(), dirs: o.dirs ?? streamDir, full: () => out.count >= max || Date.now() >= end };
}
// Remove one entry of a pass when it is ours, past the floor and not held: a file or symlink by unlink,
// a directory through removeGuarded under `root`. A removal is added to the tally.
async function removeEntry(p: string, root: string, o: BatchOpts, b: ReturnType<typeof batchPass>): Promise<void> {
  let st;
  try { st = await lstat(p); } catch { return; }
  if (st.uid !== b.uid || st.mtimeMs / 1000 > b.floor) return;
  let kb = Math.ceil(Number(st.blocks) / 2);
  if (st.isDirectory()) {
    const r = await removeGuarded(p, { root, uid: b.uid, ageFloorS: o.ageS, now: o.now, inUse: o.inUse });
    if (!r.removed) return;
    kb = r.kb;
  } else {
    if ((o.inUse.exact ? o.inUse.exact(p) : o.inUse.holder(p)) !== null) return;
    try { await unlink(p); } catch { return; }
  }
  b.out.count++; b.out.kb += kb;
  if (b.out.sample.length < 20) b.out.sample.push(p);
}

export async function removeGlobBatch(glob: string, o: BatchOpts): Promise<GlobBatch> {
  const { parent, match } = globMatcher(glob), b = batchPass(o);
  for await (const name of b.dirs(parent)) {
    await b.tick();
    if (b.full()) { b.out.capped = true; break; }
    if (match(name)) await removeEntry(join(parent, name), parent, o, b);
  }
  return b.out;
}

// investigate-disk-cleanup U2: one guarded pass inside each folder of this uid a cleanup_trim_globs
// entry matches (a matched symlink, file or another uid's folder is skipped, never followed). The folder itself stays; each entry directly
// inside it of this uid past the age floor that nothing holds is removed: a file or a symlink by
// unlink (its target stays), a directory through removeGuarded with that folder as its root (so it
// goes only when nothing in it is newer). The same caps and yielding as removeGlobBatch.
export async function trimGlobBatch(glob: string, o: BatchOpts): Promise<GlobBatch> {
  const { parent, match } = globMatcher(glob), b = batchPass(o);
  for await (const name of b.dirs(parent)) {
    await b.tick();
    if (b.out.capped) break;
    if (!match(name)) continue;
    const folder = join(parent, name), st = await lstat(folder).catch(() => null);
    // Only a folder of this uid: in a sticky shared dir nobody else can swap it for a symlink. Its
    // dev/ino is read again before each removal, and the folder is left once it changed.
    if (!st?.isDirectory() || st.uid !== b.uid) continue;
    const same = async () => { const now = await lstat(folder).catch(() => null); return !!now?.isDirectory() && now.dev === st.dev && now.ino === st.ino; };
    for await (const entry of b.dirs(folder)) {
      await b.tick();
      if (b.full()) { b.out.capped = true; break; }
      if (!(await same())) break;
      await removeEntry(join(folder, entry), folder, o, b);
    }
  }
  return b.out;
}

// cleanup_on_close (U1 step 6): in its own process group, output to a file, never through orca.ts's
// spawn (a backgrounded grandchild would hold its pipes open). On timeout the group gets TERM, the
// wait, then KILL.
export async function runOnClose(cmd: string, cwd: string, env: Record<string, string>, log: string, timeoutS: number, waitMs: number):
    Promise<{ code: number | null; ms: number; timedOut: boolean; pgid: number | null; error?: string }> {
  const t0 = Date.now();
  let fd: number | null = null;
  try {
    mkdirSync(dirname(log), { recursive: true });
    fd = openSync(log, "w");
    const p = Bun.spawn(["bash", "-c", cmd], { cwd, env: { ...process.env, ...env }, stdin: "ignore", stdout: fd, stderr: fd, detached: true });
    closeSync(fd); fd = null;
    const pgid = p.pid;
    const group = (sig: NodeJS.Signals) => { try { process.kill(-pgid, sig); } catch { /* group gone */ } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([p.exited.then(() => true), new Promise<false>((r) => { timer = setTimeout(() => r(false), timeoutS * 1000); })]);
    clearTimeout(timer);
    if (!done) {
      group("SIGTERM");
      if (!(await Promise.race([p.exited.then(() => true), sleep(waitMs).then(() => false)]))) group("SIGKILL");
      await p.exited;
    }
    return { code: done ? p.exitCode : null, ms: Date.now() - t0, timedOut: !done, pgid };
  } catch (e) {
    if (fd !== null) try { closeSync(fd); } catch { /* closed */ }
    return { code: null, ms: Date.now() - t0, timedOut: false, pgid: null, error: (e as Error).message };
  }
}

export function liveAgents(store: Store): Agent[] {
  return store.db.query("SELECT pid, started_at FROM observed_workers WHERE gone_at IS NULL AND pid IS NOT NULL").all() as Agent[];
}

export type TidyNote = { spared: number[] };
// KTD10 around a caller's worktree-rm. `before` never stops the removal: a failed or timed-out command
// writes its event and the caller goes on (and probes again). `after` runs only once worktree-rm succeeded.
export const closeTidy = {
  async before(a: Action, x: Exec, path: string): Promise<TidyNote> {
    const { store } = x, ctx = { project: a.project, squad: a.squad ?? null, member: a.member ?? null };
    const waitMs = envNum("DS_TIDY_WAIT_MS", 10_000);
    const cmd = limitLine(store, a.project, "cleanup_on_close");
    const groups: number[] = [];
    if (cmd) {
      const log = join(store.root, a.project, "loop", "cleanup", `close-${mangle(basename(path))}.log`);
      const r = await runOnClose(cmd, path, { DS_PROJECT: a.project, DS_WORKTREE: path }, log, envNum("DS_LOOP_CLEANUP_CMD_S", 120), waitMs);
      if (r.pgid !== null) groups.push(r.pgid);
      store.event("cleanup_on_close_ran", { ...ctx, payload: { path, code: r.code, ms: r.ms, timed_out: r.timedOut, log, ...(r.error ? { error: r.error } : {}) } });
    }
    const { procs, spared } = procsUnder(path, { agents: liveAgents(store), groups });
    const res = procs.length ? await stopProcs(procs, { waitMs }) : { stopped: [], killed: [] };
    if (res.stopped.length || spared.length) {
      store.event("leftover_procs_stopped", { ...ctx, payload: { path, pids: res.stopped.map((p) => p.pid), count: res.stopped.length,
        rss_kb: res.stopped.reduce((s, p) => s + p.rss_kb, 0), killed: res.killed, spared: spared.map((p) => p.pid) } });
    }
    return { spared: spared.map((p) => p.pid) };
  },

  async after(a: Action, x: Exec, path: string, note?: TidyNote): Promise<void> {
    const ctx = { project: a.project, squad: a.squad ?? null, member: a.member ?? null };
    const root = claudeTmpRoot(), dir = claudeTmpDir(path, root);
    try { await lstat(dir); } catch { return; }   // no session temp: nothing to do, no event
    const r: Removal = note?.spared.length ? { removed: false, reason: `live agent pid ${note.spared[0]}` } : await removeGuarded(dir, { root, ageFloorS: null });
    if (r.removed) x.store.event("claude_tmp_removed", { ...ctx, payload: { path: dir, kb: r.kb } });
    else if (r.reason !== "gone") x.store.event("claude_tmp_kept", { ...ctx, payload: { path: dir, reason: r.reason } });
  },
};

// ---- read-only scan primitives for the hourly cleanup pass (U2) ----

// KTD5: directories are streamed, never expanded. A reader yields entry names one at a time; tests
// inject one to prove a listing was iterated, not read whole.
export type DirReader = (dir: string) => AsyncIterable<string>;
export const streamDir: DirReader = async function* (dir: string) {
  let d;
  try { d = await opendir(dir, { bufferSize: 256 }); } catch { return; }
  for await (const e of d) yield e.name;
};

// Yields to the event loop at least every 1,000 entries or 1 second (KTD4), so a long scan never holds a tick.
export function yielder(): () => Promise<void> {
  let n = 0, at = Date.now();
  return async () => {
    if (++n % 1000 !== 0 && Date.now() - at < 1000) return;
    at = Date.now();
    await sleep(0);
  };
}

// A cleanup_tmp_globs entry (already checked by limits.ts cleanupGlobs) as its parent dir and a
// matcher for the last segment: `*`, `?` and `[...]` as the shell reads them, never across a `/`.
export function globMatcher(glob: string): { parent: string; match(name: string): boolean } {
  const parent = dirname(glob), seg = basename(glob);
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = seg.indexOf("]", i + 2);
      if (end < 0) { re += "\\["; continue; }
      const body = seg.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\");
      re += `[${body}]`; i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  const rx = new RegExp(`^${re}$`);
  // A shell glob's `*` does not match a leading dot unless the pattern starts with one.
  return { parent, match: (name) => (name.startsWith(".") && !seg.startsWith(".") ? false : rx.test(name)) };
}

// Best-effort size and newest mtime of a tree, never following a link. `budget.left` is shared across
// a scan; when it runs out the walk stops and says `partial`. Sizes never decide anything (KTD4), but the newest mtime does for class b: it sets the age floor, so a `partial` walk keeps the row "too new".
export type Size = { kb: number; newest: number; entries: number; partial: boolean };
export async function treeSize(path: string, budget: { left: number }, tick = yielder()): Promise<Size> {
  const out: Size = { kb: 0, newest: 0, entries: 0, partial: false };
  const walk = async (p: string): Promise<void> => {
    if (budget.left <= 0) { out.partial = true; return; }
    let s;
    try { s = await lstat(p); } catch { return; }
    budget.left--; out.entries++;
    out.kb += Math.ceil(Number(s.blocks) / 2);
    out.newest = Math.max(out.newest, Math.floor(s.mtimeMs / 1000));
    await tick();
    if (!s.isDirectory()) return;
    for await (const name of streamDir(p)) { await walk(join(p, name)); if (budget.left <= 0) { out.partial = true; return; } }
  };
  await walk(path);
  return out;
}

// R7's facts about a checkout, as wt_probe (bin/loop/io/wt-probe.ts) reads them for close: dirty files (the
// tree's own dev-studio files left out), commits on no remote, and of those how many are not
// patch-equal on `target` (git cherry); detached when HEAD names no branch. null when git fails.
export type TreeProbe = { dirty: number; files: string[]; unpushed: number; unique: number; detached: boolean };
export async function probeTree(path: string, target: string | null): Promise<TreeProbe | null> {
  const p = await wtProbe(path, 120_000);
  if (p.code !== 0) return null;
  const [head, ...files] = p.out.split("\n").filter(Boolean);
  const [dirty, unpushed] = (head ?? "").split("\t").map(Number);
  if (!Number.isFinite(dirty) || !Number.isFinite(unpushed)) return null;
  const sym = await spawn(["git", "-C", path, "symbolic-ref", "-q", "HEAD"], {}, 30_000);
  let unique = unpushed;
  if (unpushed > 0 && target) {
    const c = await spawn(["git", "-C", path, "cherry", target, "HEAD"], {}, 120_000);
    if (c.code === 0) unique = c.out.split("\n").filter((l) => l.startsWith("+")).length;
  }
  return { dirty, files: files.slice(0, 20), unpushed, unique, detached: sym.code !== 0 };
}

// `git worktree list --porcelain` of a repo: path, branch, detached and locked per entry; null when git fails.
export type GitTree = { path: string; branch: string | null; detached: boolean; locked: boolean };
export async function gitWorktrees(repo: string): Promise<GitTree[] | null> {
  const r = await spawn(["git", "-C", repo, "worktree", "list", "--porcelain"], {}, 60_000);
  if (r.code !== 0) return null;
  const out: GitTree[] = [];
  for (const block of r.out.split(/\n\n+/)) {
    const lines = block.split("\n").filter(Boolean);
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path) continue;
    out.push({ path, branch: lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null,
      detached: lines.includes("detached"), locked: lines.some((l) => l === "locked" || l.startsWith("locked ")) });
  }
  return out;
}

// The branch a repo's commits land on: origin/HEAD when set, else origin/main; null when neither resolves.
export async function targetRef(repo: string): Promise<string | null> {
  for (const ref of ["origin/HEAD", "origin/main"]) {
    const r = await spawn(["git", "-C", repo, "rev-parse", "--verify", "-q", ref], {}, 30_000);
    if (r.code === 0) return ref;
  }
  return null;
}

// archive-leftovers U1 — is every change in a leftover worktree already on the repo's default branch, byte for
// byte? The paths a tree changes are those of its commits on no remote (`HEAD --not --remotes`; a merge adds
// only what its combined diff `--cc` shows, so a plain merge of origin/main adds none), its tracked changes and
// its untracked files, less dev-studio's own files (OURS) and the notes the close's rescue copies out first
// (an untracked or ignored .html/.md under NOTE_DIRS). A path is equal when the tree's file has the bytes of
// the same path on `target` (`git hash-object`, so the repo's filters apply), or is absent on both sides. Safe
// when every path is equal; a tree that changes nothing is safe; with no target any change keeps it. `git
// cherry` is not used: a squash merge defeats it. null when git fails. Ignored files are the caller's check.
export type LeftoverCommit = { sha: string; title: string };
export type LeftoverCheck = { safe: boolean; commits: LeftoverCommit[]; differ: string[]; n_differ: number; target: string | null; target_sha: string | null };
export const DIFFER_CAP = 50, COMMITS_MAX = 1000;
export const rescuedNote = (p: string) => NOTE_DIRS.some((d) => p.startsWith(`${d}/`)) && /\.(html|md)$/i.test(p);
const git = (path: string, args: string[], ms = 60_000) => spawn(["git", "-C", path, "-c", "core.quotePath=false", ...args], {}, ms);

// One fetch of the default branch per repo (its common git dir) per DS_LOOP_LIFECYCLE_RETRY_S; a failure is
// noted on the result and never fatal: a stale local ref can only make a tree look less safe.
const fetchedAt = new Map<string, number>();
export async function fetchTarget(path: string, now = Date.now() / 1000): Promise<{ fetched: boolean; error?: string }> {
  const common = await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], 30_000);
  if (common.code !== 0) return { fetched: false, error: "not a git tree" };
  const key = common.out.trim(), every = envNum("DS_LOOP_LIFECYCLE_RETRY_S", 600);
  if (now - (fetchedAt.get(key) ?? -Infinity) < every) return { fetched: false };
  fetchedAt.set(key, now);
  const sym = await git(path, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], 30_000);
  const branch = sym.code === 0 && sym.out.trim().startsWith("origin/") ? sym.out.trim().slice(7) : "main";
  const f = await spawn(["git", "-C", path, "fetch", "-q", "--no-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    { GIT_TERMINAL_PROMPT: "0" }, 60_000);
  return f.code === 0 ? { fetched: true } : { fetched: false, error: (f.err.trim().split("\n").at(-1) ?? "").slice(0, 200) || `exit ${f.code}` };
}

async function chunks<T>(list: string[], n: number, run: (part: string[]) => Promise<T | null>): Promise<T[] | null> {
  const out: T[] = [];
  for (let i = 0; i < list.length; i += n) { const r = await run(list.slice(i, i + n)); if (r == null) return null; out.push(r); }
  return out;
}

export async function leftoverCheck(path: string): Promise<LeftoverCheck | null> {
  const target = await targetRef(path);
  const [st, log, ts] = await Promise.all([
    git(path, ["status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"]),
    git(path, ["log", "--no-renames", "--cc", "--name-only", `--max-count=${COMMITS_MAX + 1}`, "--format=%x01%H%x02%s", "HEAD", "--not", "--remotes"], 120_000),
    target ? git(path, ["rev-parse", "--verify", "-q", target], 30_000) : Promise.resolve(null),
  ]);
  if (st.code !== 0 || log.code !== 0) return null;
  const paths = new Set<string>();
  for (const e of st.out.split("\0").filter(Boolean)) {
    if (OURS.test(e)) continue;
    const p = e.slice(3);
    if (e.startsWith("?? ") && rescuedNote(p)) continue;
    paths.add(p);
  }
  const commits: (LeftoverCommit & { paths: string[] })[] = [];
  for (const block of log.out.split("\x01").filter(Boolean)) {
    const [head, ...rest] = block.split("\n");
    const [sha, title = ""] = head.split("\x02");
    const ps = rest.filter(Boolean);
    commits.push({ sha, title, paths: ps });
    for (const p of ps) paths.add(p);
  }
  const all = [...paths].sort();
  const differ = new Set<string>();
  // A name git had to quote (a control character) cannot be read back: it is never called equal.
  for (const p of all) if (p.startsWith('"')) differ.add(p);
  const plain = all.filter((p) => !differ.has(p));
  if (!target) for (const p of plain) differ.add(p);
  else if (plain.length) {
    const theirs = new Map<string, string>();
    const ls = await chunks(plain, 500, async (part) => { const r = await git(path, ["ls-tree", "-r", "-z", target, "--", ...part]); return r.code === 0 ? r.out : null; });
    if (!ls) return null;
    for (const e of ls.join("").split("\0").filter(Boolean)) { const [meta, p] = e.split("\t"); theirs.set(p, meta.split(" ")[2]); }
    const files: string[] = [], links: string[] = [];
    for (const p of plain) {
      const s = await lstat(join(path, p)).catch(() => null);
      if (!s) { if (theirs.has(p)) differ.add(p); }   // absent here: equal only when absent there too
      else if (s.isSymbolicLink()) links.push(p);
      else if (s.isFile()) files.push(p);
      else differ.add(p);                              // a folder (a nested repo, a submodule): never equal
    }
    const hashed = await chunks(files, 500, async (part) => { const r = await git(path, ["hash-object", "--", ...part], 120_000); return r.code === 0 ? r.out.split("\n").filter(Boolean) : null; });
    if (!hashed) return null;
    hashed.flat().forEach((h, i) => { if (theirs.get(files[i]) !== h) differ.add(files[i]); });
    if (links.length) {
      const fmt = await git(path, ["rev-parse", "--show-object-format"], 30_000);
      const algo = fmt.code === 0 && fmt.out.trim() === "sha256" ? "sha256" : "sha1";
      for (const p of links) {
        const id = await linkBlob(join(path, p), algo);
        if (id == null || theirs.get(p) !== id) differ.add(p);
      }
    }
  }
  const list = [...differ].sort();
  const shown = commits.slice(0, COMMITS_MAX).filter((c) => c.paths.some((p) => differ.has(p))).map(({ sha, title }) => ({ sha, title }));
  return { safe: list.length === 0 && commits.length <= COMMITS_MAX, commits: shown, differ: list.slice(0, DIFFER_CAP), n_differ: list.length,
    target, target_sha: ts && ts.code === 0 ? ts.out.trim() : null };
}

// The object id git gives a symlink's text, in the repo's own hash (sha1 or sha256).
async function linkBlob(file: string, algo: string): Promise<string | null> {
  try {
    const text = Buffer.from(await readlink(file));
    return createHash(algo).update(`blob ${text.length}\0`).update(text).digest("hex");
  } catch { return null; }
}
