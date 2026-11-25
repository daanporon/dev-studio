// providers/git.ts — the `git` worktree provider (orca-backend-alternatives U7): plain `git worktree`.
//   pathFor  <DS_WORKTREE_ROOT, else ~/dev-studio-worktrees>/<project, else the repo's folder name>/<name>
//   create   `git worktree add` on the branch: a new branch from the base, an existing one as is. A path
//            git already lists on that branch is adopted (no git write); one on another branch, or a
//            folder git does not know, is refused. A stale entry (folder gone) is pruned first.
//   remove   refuses a tree with changes other than dev-studio's own files (the role brief, the role
//            settings: wt-probe.ts OURS) unless forced, then `git worktree remove --force`. The branch is
//            kept, unless deleteBranch and it is merged into the base (`merge-base --is-ancestor`); an
//            unmerged branch is always kept. A folder already gone is pruned and reported `already`.
//   list     `git worktree list --porcelain` of the repo.
//   prune    `git worktree prune` of the repo.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Row } from "../../core/store.ts";
import { OURS } from "../wt-probe.ts";
import { git, lastLine, WorktreeError, type Gone, type Listed, type Made, type Provider, type RemoveOpts, type Spec } from "../worktrees.ts";

export function root(): string {
  return resolve(process.env.DS_WORKTREE_ROOT || join(homedir(), "dev-studio-worktrees"));
}

/** `git worktree list --porcelain` as entries; the main checkout is left out. */
export async function listed(repo: string): Promise<Listed[]> {
  const o = await git(["-C", repo, "worktree", "list", "--porcelain"]);
  if (o.code !== 0) throw new WorktreeError(`git: worktree list in ${repo} failed: ${lastLine(o)}`);
  const out: Listed[] = [];
  for (const block of o.out.split("\n\n")) {
    const lines = block.split("\n").filter(Boolean);
    const wt = lines.find((l) => l.startsWith("worktree "));
    if (!wt) continue;
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? null;
    const br = lines.find((l) => l.startsWith("branch "))?.slice(7) ?? null;
    out.push({ path: resolve(wt.slice(9)), head, branch: br ? br.replace(/^refs\/heads\//, "") : null, prunable: lines.some((l) => l.startsWith("prunable")) });
  }
  const main = await git(["-C", repo, "rev-parse", "--path-format=absolute", "--show-toplevel"]);
  const top = main.code === 0 ? resolve(main.out.trim()) : resolve(repo);
  return out.filter((l) => l.path !== top);
}

export const hasBranch = async (repo: string, branch: string) =>
  (await git(["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;

/** What becomes of a removed worktree's branch: kept, unless opts.deleteBranch and it is merged into the
 *  base (an unmerged branch is always kept); `none` when there is no such branch. */
export async function branchAfter(repo: string, branch: string, opts: RemoveOpts): Promise<Gone["branch"]> {
  if (!branch || !(await hasBranch(repo, branch))) return "none";
  if (!opts.deleteBranch) return "kept";
  const base = opts.base || "HEAD";
  if ((await git(["-C", repo, "merge-base", "--is-ancestor", `refs/heads/${branch}`, base])).code !== 0) return "kept";
  return (await git(["-C", repo, "branch", "-D", branch])).code === 0 ? "deleted" : "kept";
}

/** Why the tree at `path` must not be removed unforced: its changes other than dev-studio's own files
 *  (wt-probe.ts OURS), or a failed `git status`; null when there are none. */
export async function changes(path: string): Promise<string | null> {
  const st = await git(["-C", path, "status", "--porcelain", "--untracked-files=all"]);
  if (st.code !== 0) return `git status failed: ${lastLine(st)}`;
  const dirty = st.out.split("\n").filter((l) => l && !OURS.test(l));
  return dirty.length ? `${dirty.length} changed file(s): ${dirty.slice(0, 5).map((l) => l.slice(3)).join(", ")}` : null;
}

const provider: Provider = {
  name: "git",
  pathFor: (spec: Spec) => join(root(), spec.project || basename(resolve(spec.repo)), spec.name),

  async create(spec: Spec, path: string): Promise<Made> {
    const ok = await git(["check-ref-format", "--branch", spec.branch]);
    if (ok.code !== 0) throw new WorktreeError(`git: '${spec.branch}' is not a branch name`);
    let entries = await listed(spec.repo);
    let here = entries.find((l) => l.path === path);
    if (here?.prunable || (here && !existsSync(path))) {
      await git(["-C", spec.repo, "worktree", "prune"]);
      entries = await listed(spec.repo);
      here = entries.find((l) => l.path === path);
    }
    if (here) {
      if (here.branch !== spec.branch) throw new WorktreeError(`git: ${path} holds branch '${here.branch ?? "(detached)"}', not '${spec.branch}'`);
      return { path, branch: spec.branch, adopted: true };
    }
    if (existsSync(path)) throw new WorktreeError(`git: ${path} exists and is not a worktree of ${spec.repo}`);
    const other = entries.find((l) => l.branch === spec.branch);
    if (other) throw new WorktreeError(`git: branch '${spec.branch}' is checked out in ${other.path}`);
    mkdirSync(dirname(path), { recursive: true });
    const args = (await hasBranch(spec.repo, spec.branch))
      ? ["-C", spec.repo, "worktree", "add", path, spec.branch]
      : ["-C", spec.repo, "worktree", "add", "--no-track", "-b", spec.branch, path, spec.base];
    const add = await git(args, 600_000);
    if (add.code !== 0) throw new WorktreeError(`git: worktree add ${path} failed: ${lastLine(add)}`);
    return { path, branch: spec.branch, adopted: false };
  },

  async remove(row: Row, opts: RemoveOpts): Promise<Gone> {
    const path = String(row.path), repo = row.repo ? String(row.repo) : "", branch = row.branch ? String(row.branch) : "";
    if (!repo || !existsSync(repo)) return { removed: false, already: false, branch: "none", why: `its repo ${repo || "(unknown)"} is not there` };
    const keepOrDrop = () => branchAfter(repo, branch, opts);
    const here = (await listed(repo)).find((l) => l.path === path);
    if (!here || here.prunable || !existsSync(path)) {
      if (existsSync(path)) return { removed: false, already: false, branch: "none", why: `${path} exists and is not a worktree of ${repo}` };
      await git(["-C", repo, "worktree", "prune"]);
      return { removed: true, already: true, branch: await keepOrDrop() };
    }
    if (!opts.force) {
      const why = await changes(path);
      if (why) return { removed: false, already: false, branch: "none", why };
    }
    const rm = await git(["-C", repo, "worktree", "remove", "--force", path]);
    if (rm.code !== 0) return { removed: false, already: false, branch: "none", why: `git worktree remove failed: ${lastLine(rm)}` };
    return { removed: true, already: false, branch: await keepOrDrop() };
  },

  list: listed,
  prune: (repo: string) => git(["-C", repo, "worktree", "prune"]),
};

export default provider;
