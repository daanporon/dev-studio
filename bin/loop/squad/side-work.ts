// side-work.ts — side-loop-host U14 (issue #127, KTD11/KTD13): what a side loop does to its own members' worktrees.
//   sideMembers(store, project?)   the members main sent down (bin/link/replica.ts) with a folder on this host
//   aheadOf(path, branch)          the branch's head when it holds commits its remote does not, else null
//   pushAhead(member)              push one Builder branch that is ahead (host-jobs pushHere: never forced)
//   closeMember(backend, member)   close the terminals in the member's folder through this host's own backend
// The side's rows are main's copy: every worktree id is `local::<path>` here, and a worktree row's branch is the one
// main made the worktree on. A Builder that moved its worktree to another branch is pushed on that branch instead.
import { existsSync } from "node:fs";
import type { Backend } from "../../backend/contract.ts";
import { pushHere } from "../../link/host-jobs.ts";
import type { Row, Store } from "../core/store.ts";
import { localPath } from "../drivers/contract.ts";
import { git, lastLine } from "../io/worktrees.ts";
import { sideBackend } from "./backend.ts";
import { makeContract } from "./contracts.ts";

export const REMOTE = "origin";

export type SideMember = { id: number; project: string; squad: string; role: string; path: string; branch: string | null };

/** This host's members with a folder on disk, Builders first, one per folder (the newest row). */
export function sideMembers(store: Store, project?: string): SideMember[] {
  const rows = store.db.query(`SELECT m.id, m.project, m.squad, m.role, m.wt, w.branch FROM members m
    LEFT JOIN worktrees w ON w.path = substr(m.wt, 8) AND w.gone_at IS NULL
    WHERE m.wt LIKE 'local::%' ${project === undefined ? "" : "AND m.project = ?"} ORDER BY m.id DESC`)
    .all(...(project === undefined ? [] : [project])) as Row[];
  const seen = new Set<string>(), out: SideMember[] = [];
  for (const r of rows) {
    const path = localPath(String(r.wt));
    if (!path || seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    out.push({ id: Number(r.id), project: String(r.project), squad: String(r.squad), role: String(r.role), path, branch: r.branch ? String(r.branch) : null });
  }
  return out.sort((a, b) => Number(b.role === "builder") - Number(a.role === "builder") || a.id - b.id);
}

const BRANCH = /^[A-Za-z0-9._/-]+$/;

/** The branch checked out in `path`, or null when its HEAD is detached. */
async function headBranch(path: string): Promise<string | null> {
  const o = await git(["-C", path, "symbolic-ref", "--short", "-q", "HEAD"], 30_000);
  const b = o.out.trim();
  return o.code === 0 && BRANCH.test(b) ? b : null;
}

/** The branch a Builder works on in `path`: the one checked out, else the one main made the worktree on. */
export async function builderBranch(m: SideMember): Promise<string | null> {
  return (await headBranch(m.path)) ?? (m.branch && BRANCH.test(m.branch) ? m.branch : null);
}

/** The head of `branch` in `path` when it holds commits the remote does not have, else null. With no remote-tracking
 *  branch yet, ahead means commits on no remote branch at all, so a fresh branch with nothing new is left alone. */
export async function aheadOf(path: string, branch: string, remote = REMOTE): Promise<string | null> {
  const head = await git(["-C", path, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], 30_000);
  if (head.code !== 0) return null;
  const sha = head.out.trim();
  const tracking = await git(["-C", path, "rev-parse", "--verify", "-q", `refs/remotes/${remote}/${branch}`], 30_000);
  const range = tracking.code === 0 ? [`${tracking.out.trim()}..${sha}`] : [sha, "--not", `--remotes=${remote}`];
  const n = await git(["-C", path, "rev-list", "--count", ...range], 30_000);
  return n.code === 0 && Number(n.out.trim()) > 0 ? sha : null;
}

export type Pushed = { ok: true; branch: string; sha: string } | { ok: false; branch: string | null; error: string } | null;

/** Push a Builder's branch when it is ahead of its remote; null when there is nothing to push. Never forced. */
export async function pushAhead(m: SideMember, timeoutMs?: number): Promise<Pushed> {
  const branch = await builderBranch(m);
  if (!branch) return null;
  const sha = await aheadOf(m.path, branch);
  if (!sha) return null;
  const o = await pushHere(m.path, branch, REMOTE, timeoutMs);
  return o.code === 0 ? { ok: true, branch, sha } : { ok: false, branch, error: lastLine(o) };
}

const backends = new Map<string, Backend>();
/** This host's backend for a member's squad (tmux for a squad that is on Orca on main: no Orca runs here). */
export function sideBackendOf(store: Store, m: SideMember): Backend {
  const name = sideBackend(store, m.project, m.squad), k = `${store.root}\t${name}\t${m.project}`;
  let b = backends.get(k);
  if (!b) { b = makeContract(store.root, name, m.project); backends.set(k, b); }
  return b;
}

/** Close every terminal in the member's folder; the number closed, or the error. */
export async function closeMember(b: Backend, m: SideMember): Promise<{ closed: number } | { error: string }> {
  const l = await b.call("terminal.list", {});
  if (!l.ok) return { error: l.error.message };
  let closed = 0;
  for (const t of l.terminals.filter((x) => x.cwd === m.path)) {
    const c = await b.call("terminal.close", { id: t.id });
    if (!c.ok) return { error: c.error.message };
    if (c.closed) closed++;
  }
  return { closed };
}
