// cleanup-fixture.ts — fixture roots for the host-disk-cleanup U2 tests: a fake /proc, a fake Claude
// temp root, temp git clones with worktrees, a temp state root. Nothing outside the test's own temp
// dirs is read or written, and no real process is signalled.
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { onTestEnd, tempRoot } from "./temp-roots.ts";
import type { CleanupOpts } from "../../bin/loop/observers/cleanup.ts";

export const UID = process.getuid!();
// Removed after each test in every file by temp-roots.ts (U284).
export function tmp(): string {
  return tempRoot("zzclean-");
}

export function store(): Store {
  const s = open(tmp());
  onTestEnd(() => s.close());
  return s;
}

// A fake /proc: btime 1000; each process has stat, status (uid), statm, comm, a cwd link and fd links.
export type FP = { pid: number; ppid?: number; start?: number; uid?: number; cwd?: string; fds?: string[]; comm?: string };
export function fakeProc(procs: FP[]): string {
  const root = join(tmp(), "proc");
  mkdirSync(root);
  writeFileSync(join(root, "stat"), "cpu 0 0 0\nbtime 1000\n");
  for (const p of procs) {
    const d = join(root, String(p.pid));
    mkdirSync(join(d, "fd"), { recursive: true });
    const f = ["S", p.ppid ?? 1, p.pid, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, p.start ?? 500];
    writeFileSync(join(d, "stat"), `${p.pid} (${p.comm ?? "x"}) ${f.join(" ")}\n`);
    writeFileSync(join(d, "statm"), "100 25 0\n");
    writeFileSync(join(d, "comm"), `${p.comm ?? "x"}\n`);
    const u = p.uid ?? UID;
    writeFileSync(join(d, "status"), `Name:\tx\nUid:\t${u}\t${u}\t${u}\t${u}\n`);
    if (p.cwd) symlinkSync(p.cwd, join(d, "cwd"));
    (p.fds ?? []).forEach((t, i) => symlinkSync(t, join(d, "fd", String(i + 3))));
  }
  return root;
}

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// A bare origin with one commit on main and its clone (the project's home repo).
export function clone(): { root: string; repo: string } {
  const root = tmp(), origin = join(root, "origin.git"), repo = join(root, "repo");
  git(root, "init", "-q", "--bare", origin);
  git(root, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-q", "-m", "one");
  git(repo, "push", "-q", "origin", "HEAD:main");
  git(repo, "remote", "set-head", "origin", "main");
  return { root, repo };
}
export function worktree(repo: string, path: string, branch: string): string {
  git(repo, "worktree", "add", "-q", "-b", branch, path, "origin/main");
  return path;
}

export const aged = (path: string, epoch: number) => utimesSync(path, epoch, epoch);
export function project(s: Store, label: string, repo: string | null = null): void {
  s.upsert("projects", { label }, { home_repo: repo ? `path:${repo}` : null, observed_at: 1 });
  mkdirSync(join(s.root, label, "squads"), { recursive: true });
}
export function observedWt(s: Store, project: string, wt: string, path: string, gone: number | null = null): void {
  s.upsert("observed_worktrees", { project, wt }, { path, observed_at: 1, gone_at: gone });
}

// The observer's injected roots; never the real /proc, /tmp or Claude temp root.
export function opts(o: Partial<CleanupOpts> & { proc: string; tmpRoot: string }): CleanupOpts {
  return { self: 999_999, host: "test", ps: async () => [{ worktreeId: "x::/nowhere/u0" }], ...o };
}
