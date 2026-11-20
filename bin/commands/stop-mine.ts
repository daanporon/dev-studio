// ds stop-mine <pattern> [--signal TERM|INT|KILL] [--dry-run] — signal only the
// processes you started: those whose full command line contains <pattern> (like
// `pgrep -f`, but a literal substring) AND whose working folder (/proc/<pid>/cwd)
// is inside this worktree (the git top level of the cwd), plus their descendants.
// Anything matching <pattern> that lives in another worktree is left alone and
// reported (count + folders). Never matches itself or its own shell.
//
// A host-wide `pkill -f <pattern>` matches every squad's Builders on the host;
// this is the safe replacement (roles/builder.md). Exit 0 when it stopped (or,
// with --dry-run, would stop) something, 1 when nothing matched, 2 on bad usage.
import { realpathSync } from "node:fs";

export const help = `<pattern> [--signal TERM|INT|KILL] [--dry-run] — TERM (or the signal) every process matching <pattern> under this worktree, plus descendants; else report`;

const SIGNALS: Record<string, number> = { TERM: 15, INT: 2, KILL: 9 };

type Proc = { pid: number; ppid: number; cmd: string; cwd: string | null };

export async function run(args: string[]): Promise<number> {
  let signal = "TERM", dry = false;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dry = true;
    else if (a === "--signal") {
      if (args[i + 1] === undefined) { console.error("ds stop-mine: --signal needs a value (TERM|INT|KILL)"); return 2; }
      signal = args[++i].toUpperCase();
    } else if (a.startsWith("--")) { console.error(`ds stop-mine: unknown option ${a}`); return 2; }
    else pos.push(a);
  }
  if (pos.length !== 1 || !pos[0]) {
    console.error("usage: ds stop-mine <pattern> [--signal TERM|INT|KILL] [--dry-run]");
    return 2;
  }
  const pattern = pos[0];
  const signo = SIGNALS[signal] ?? (/^\d+$/.test(signal) ? Number(signal) : NaN);
  if (!Number.isInteger(signo)) { console.error(`ds stop-mine: bad signal '${signal}' (TERM|INT|KILL)`); return 2; }

  const top = await gitTop().catch(() => null);
  if (!top) { console.error("ds stop-mine: not inside a git worktree — refusing (scope unknown)"); return 2; }
  const root = realpathSync(top);

  const procs = await snapshot();
  // Never match this process or any of its ancestors (the invoking shell's
  // command line contains the pattern when run as `ds stop-mine <pattern>`).
  const self = new Set<number>();
  {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    let pid: number | undefined = process.pid;
    while (pid !== undefined && !self.has(pid)) {
      self.add(pid);
      pid = byPid.get(pid)?.ppid || undefined;
      if (pid === 0) break;
    }
    self.add(process.ppid);
  }
  const inside = (cwd: string | null) => cwd === root || (cwd !== null && cwd.startsWith(root + "/"));
  const matched = procs.filter((p) => !self.has(p.pid) && p.cmd.includes(pattern));
  const mine = matched.filter((p) => inside(p.cwd));

  // Descendants of in-scope matches, whatever folder they run in.
  const children = new Map<number, number[]>();
  for (const p of procs) {
    const list = children.get(p.ppid);
    if (list) list.push(p.pid);
    else children.set(p.ppid, [p.pid]);
  }
  const mineSet = new Set(mine.map((p) => p.pid));
  const queue = [...mineSet];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    for (const kid of children.get(pid) ?? []) {
      if (self.has(kid) || mineSet.has(kid)) continue;
      mineSet.add(kid);
      queue.push(kid);
    }
  }
  const others = matched.filter((p) => !mineSet.has(p.pid));

  const targets = procs.filter((p) => mineSet.has(p.pid));
  const verb = dry ? "would stop" : "stopped";
  for (const t of targets.sort((a, b) => a.pid - b.pid)) {
    if (!dry) {
      try {
        process.kill(t.pid, signo);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err?.code === "ESRCH") continue; // exited between listing and kill
        console.error(`ds stop-mine: PID ${t.pid}: ${err?.message ?? e}`);
        continue;
      }
    }
    console.log(`${verb} ${t.pid} ${t.cmd}`);
  }
  if (others.length > 0) {
    const folders = [...new Set(others.map((p) => p.cwd ?? "(unknown)"))].sort();
    console.log(`left alone: ${others.length} matching process${others.length === 1 ? "" : "es"} outside ${root} (${folders.join(", ")})`);
  }
  if (dry && targets.length > 0) console.log(`dry-run: stopped nothing`);
  return targets.length > 0 ? 0 : 1;
}

async function gitTop(): Promise<string> {
  const p = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error("no git top level");
  return new TextDecoder().decode(p.stdout).trim();
}

async function snapshot(): Promise<Proc[]> {
  // One `ps` gives pid/ppid/args portably; cwds come from /proc readlinks.
  const p = Bun.spawnSync(["ps", "-e", "-o", "pid=,ppid=,args="], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error("ps failed");
  const text = new TextDecoder().decode(p.stdout);
  const out: Proc[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    let cwd: string | null = null;
    try {
      cwd = realpathSync(`/proc/${pid}/cwd`);
    } catch { cwd = null; }
    out.push({ pid, ppid: Number(m[2]), cmd: m[3], cwd });
  }
  return out;
}
