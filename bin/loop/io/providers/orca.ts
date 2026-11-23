// providers/orca.ts — the `orca` worktree provider (orca-backend-alternatives U8b): worktrees made by
// `orca worktree create` with no agent and no Run, so Orca lists them and reports the state of a plain
// tab opened in one (docs/backends/orca-probe.md Q5). Every Orca call goes through the adapter
// (`wt-make`, `wt-show`, `wt-list`, `worktree-rm`; bin/backend/orca.ts) by the loop's Orca runner.
//   pathFor  <DS_ORCA_WORKSPACES, else ~/orca/workspaces>/<the repo's folder name>/<name>: where Orca puts it
//   create   a worktree Orca shows at the path on the branch is adopted (its id recorded); one on another
//            branch, a folder Orca does not know, a branch checked out elsewhere or a branch that already
//            exists is refused (Orca would make `<branch>-2`). Else `wt-make` nested under the parent (or
//            top-level), and a worktree Orca made under another path or branch is removed again and refused.
//   remove   refuses a tree with changes other than dev-studio's own files unless forced, then
//            `worktree-rm --force` by its Orca id (by path when Orca no longer knows the id). Orca keeps the
//            branch; it is deleted only with deleteBranch when merged into the base, as the git provider does.
//            A folder already gone is pruned from git and Orca and reported `already`.
//   list     Orca's list of the repo, plus each worktree git still has that Orca stopped listing,
//            re-linked through `wt-show path:<path>` (its id refreshed) and never reported gone for it.
//   prune    `git worktree prune` of the repo (Orca has no prune of its own).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Row } from "../../core/store.ts";
import { shell, type Orca, type Out } from "../orca.ts";
import { git, lastLine, WorktreeError, type Gone, type Listed, type Made, type Provider, type RemoveOpts, type Spec } from "../worktrees.ts";
import { dirtyWhy, hasBranch, keepOrDrop, listed as gitListed } from "./git.ts";

/** A worktree as the adapter prints it (one JSON line per worktree). */
export type OrcaWt = { id: string; path: string; branch: string | null; head: string | null; parentWorktreeId: string | null };

let runner: Orca | null = null;
/** The Orca the provider calls; a test hands it a fake (null: the adapter again). */
export function useOrca(o: Orca | null): void { runner = o; }
const run = (op: string, args: string[]): Promise<Out> => (runner ??= shell()).run(op, args);

export const root = (): string => resolve(process.env.DS_ORCA_WORKSPACES || join(homedir(), "orca", "workspaces"));
const short = (b: string | null) => (b ? b.replace(/^refs\/heads\//, "") : null);

function parse(o: Out): OrcaWt[] {
  const out: OrcaWt[] = [];
  for (const line of o.out.split("\n")) {
    if (!line.trim()) continue;
    const w = JSON.parse(line) as OrcaWt;
    out.push({ ...w, path: resolve(w.path), branch: short(w.branch) });
  }
  return out;
}

/** Orca's worktree at `sel` (`path:<p>` or `id:<id>`); null when Orca has none. */
async function show(sel: string): Promise<OrcaWt | null> {
  const o = await run("wt-show", [sel]);
  if (o.code === 3) return null;
  if (o.code !== 0) throw new WorktreeError(`orca: worktree show ${sel} failed: ${lastLine(o)}`);
  return parse(o)[0] ?? null;
}

async function list(repo: string): Promise<Listed[]> {
  const o = await run("wt-list", [repo]);
  if (o.code !== 0) throw new WorktreeError(`orca: worktree list of ${repo} failed: ${lastLine(o)}`);
  const top = resolve(repo);
  const out: Listed[] = parse(o).filter((w) => w.path !== top)
    .map((w) => ({ path: w.path, branch: w.branch, head: w.head, prunable: false, orca_id: w.id }));
  const have = new Set(out.map((l) => l.path));
  // A worktree Orca stopped listing while git still has it keeps its row: find its id by path.
  for (const g of await gitListed(repo)) {
    if (have.has(g.path)) continue;
    const w = g.prunable ? null : await show(`path:${g.path}`).catch(() => null);
    out.push({ ...g, ...(w ? { orca_id: w.id } : {}) });
  }
  return out;
}

const provider: Provider = {
  name: "orca",
  pathFor: (spec: Spec) => join(root(), basename(resolve(spec.repo)), spec.name),

  async create(spec: Spec, path: string): Promise<Made> {
    if ((await git(["check-ref-format", "--branch", spec.branch])).code !== 0) throw new WorktreeError(`orca: '${spec.branch}' is not a branch name`);
    if (existsSync(path)) {
      const here = await show(`path:${path}`);
      if (!here) throw new WorktreeError(`orca: ${path} exists and is not a worktree Orca knows`);
      if (here.branch !== spec.branch) throw new WorktreeError(`orca: ${path} holds branch '${here.branch ?? "(detached)"}', not '${spec.branch}'`);
      return { path, branch: spec.branch, adopted: true, orca_id: here.id };
    }
    const other = (await gitListed(spec.repo)).find((l) => l.branch === spec.branch);
    if (other) throw new WorktreeError(`orca: branch '${spec.branch}' is checked out in ${other.path}`);
    if (await hasBranch(spec.repo, spec.branch)) throw new WorktreeError(`orca: branch '${spec.branch}' already exists (Orca makes a new branch only)`);
    const o = await run("wt-make", [spec.repo, spec.name, spec.branch, spec.base, spec.parent ?? ""]);
    if (o.code !== 0) throw new WorktreeError(`orca: worktree create ${spec.name} failed: ${lastLine(o)}`);
    const made = parse(o)[0];
    if (!made) throw new WorktreeError(`orca: worktree create ${spec.name} answered no worktree`);
    if (made.path !== path || made.branch !== spec.branch) {
      await run("worktree-rm", [`id:${made.id}`, "force"]);
      throw new WorktreeError(`orca: Orca made ${made.path} on '${made.branch}', not ${path} on '${spec.branch}'; removed it again`);
    }
    return { path, branch: spec.branch, adopted: false, orca_id: made.id };
  },

  async remove(row: Row, opts: RemoveOpts): Promise<Gone> {
    const path = String(row.path), repo = row.repo ? String(row.repo) : "", branch = row.branch ? String(row.branch) : "";
    if (!repo || !existsSync(repo)) return { removed: false, already: false, branch: "none", why: `its repo ${repo || "(unknown)"} is not there` };
    const rm = async (): Promise<Out> => {
      const byId = row.orca_id ? await run("worktree-rm", [`id:${row.orca_id}`, "force"]) : null;
      return byId && !/selector_not_found/.test(byId.out + byId.err) ? byId : run("worktree-rm", [`path:${path}`, "force"]);
    };
    if (!existsSync(path)) {
      await rm();   // Orca's entry for a folder already gone; nothing to refuse
      await git(["-C", repo, "worktree", "prune"]);
      return { removed: true, already: true, branch: await keepOrDrop(repo, branch, opts) };
    }
    const why = opts.force ? null : await dirtyWhy(path);
    if (why) return { removed: false, already: false, branch: "none", why };
    const o = await rm();
    if (o.code !== 0) return { removed: false, already: false, branch: "none", why: `orca worktree rm failed: ${lastLine(o)}` };
    return { removed: true, already: false, branch: await keepOrDrop(repo, branch, opts) };
  },

  list,
  prune: (repo: string) => git(["-C", repo, "worktree", "prune"]),
};

export default provider;
