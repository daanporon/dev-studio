// ds worktree — the loop's worktree providers by hand (orca-backend-alternatives U7, bin/loop/io/worktrees.ts):
// make, remove, list and prune worktrees through a provider (git today), each recorded in the `worktrees`
// table by host + path. For tests and operators; the loop calls the same functions for squads on a new
// backend (U11). Rows are written directly: no request, no action.
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel } from "../lib/shared";
import { createWorktree, listWorktrees, pruneWorktrees, removeWorktree, worktreeLine, WorktreeError } from "../loop/io/worktrees.ts";

export const help = "create --repo <path> --name <n> --branch <b> [--base <ref>] [--provider git] [--parent <path>] [--project p --squad s --role r] [--path p] | rm <path> [--force] [--delete-branch [--base <ref>]] | list [--project p] [--provider x] [--repo r] [--all] | prune [--repo r] [--provider x] — make, remove and list the loop's own worktrees (worktrees rows)";

const USAGE = `usage: ds worktree create --repo <path> --name <name> --branch <branch> [--base <ref>] [--provider git] [--parent <path>]
                          [--project <label>] [--squad <topic>] [--role <role[-suffix]>] [--path <path>] [--json]
       ds worktree rm <path> [--force] [--delete-branch [--base <ref>]] [--json]
       ds worktree list [--project <label>] [--provider <name>] [--repo <path>] [--all] [--json]
       ds worktree prune [--project <label>] [--provider <name>] [--repo <path>] [--json]`;

export async function run(args: string[]): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(USAGE); return args.length ? 0 : 2; }
  const usage = (why: string) => { console.error(`ds worktree: ${why}\n${USAGE}`); return 2; };
  let p: ReturnType<typeof parse>;
  try {
    p = parse(args, ["repo", "name", "branch", "base", "provider", "parent", "project", "squad", "role", "path"], ["force", "delete-branch", "all", "json"]);
  } catch (e) { return usage((e as Error).message); }
  const { pos, opt, flag } = p, json = flag.has("json");
  const project = opt.project ? dsLabel(opt.project) : undefined;
  const s = open();
  try {
    switch (pos[0]) {
      case "create": {
        if (pos.length !== 1) return usage("create takes no other words");
        for (const k of ["repo", "name", "branch"]) if (!opt[k]) return usage(`--${k} is required`);
        const r = await createWorktree(s, opt.provider || "git", { repo: opt.repo, name: opt.name, branch: opt.branch, base: opt.base || "HEAD",
          parent: opt.parent || null, project: project ?? null, squad: opt.squad || null, role: opt.role || null, path: opt.path || null });
        if (json) print({ adopted: r.adopted, worktree: r.row });
        else console.log(`${r.adopted ? "worktree already there" : "worktree created"}: ${r.row.path} (${r.row.provider}, branch ${r.row.branch})`);
        return 0;
      }
      case "rm": {
        if (pos.length !== 2) return usage("name one worktree path");
        const r = await removeWorktree(s, pos[1], { force: flag.has("force"), deleteBranch: flag.has("delete-branch"), base: opt.base });
        if (json) print({ gone: r.gone, worktree: r.row });
        else console.log(`${r.gone.already ? "worktree already gone" : "worktree removed"}: ${r.row.path} (branch ${r.gone.branch})`);
        return 0;
      }
      case "list": {
        if (pos.length !== 1) return usage("list takes no other words");
        const r = await listWorktrees(s, { project, provider: opt.provider, repo: opt.repo, all: flag.has("all") });
        if (json) print(r);
        else {
          for (const m of r.marked) console.log(`marked gone: ${m}`);
          if (!r.rows.length) console.log("no worktrees recorded");
          for (const row of r.rows) console.log(worktreeLine(row));
        }
        return 0;
      }
      case "prune": {
        if (pos.length !== 1) return usage("prune takes no other words");
        const r = await pruneWorktrees(s, { project, provider: opt.provider, repo: opt.repo });
        if (json) print(r);
        else { for (const m of r.marked) console.log(`marked gone: ${m}`); console.log(`pruned ${r.pruned.length} repo(s), marked ${r.marked.length} gone`); }
        return 0;
      }
      default: return usage(`unknown subcommand '${pos[0] ?? ""}'`);
    }
  } catch (e) {
    if (e instanceof WorktreeError) { console.error(`ds worktree: ${e.message}`); return 1; }
    throw e;
  } finally { s.close(); }
}
