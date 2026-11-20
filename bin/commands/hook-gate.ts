// ds hook-gate — run a start hook only when this role's `hook:<name>` rule is on (U229).
//   ds hook-gate <name> -- <command…>
// The role comes from the worktree name (the cwd). Outside a role worktree (the operator's own
// sessions) the command always runs. A resolver failure runs the command too: a hook is never lost
// to a settings problem.
import { open, stateRoot } from "../loop/core/store.ts";
import { discoverProjects } from "../loop/settings/projects.ts";
import { levelOf, projectRules, roleOf, shippedRules } from "../loop/settings/skills.ts";

export const help = "<name> -- <command…> — run a start hook only when the role's hook:<name> rule is on";
export async function run(args: string[]): Promise<number> {
  const at = args.indexOf("--");
  if (at < 1 || at === args.length - 1) { console.error(`usage: ds hook-gate ${help}`); return 2; }
  const name = args[0], cmd = args.slice(at + 1);
  let on = true;
  try {
    const r = roleOf(process.cwd(), discoverProjects(stateRoot()));
    if (r) {
      let s: ReturnType<typeof open> | null = null;
      try { s = open(); } catch { /* shipped rules alone */ }
      try { on = (levelOf(`hook:${name}`, r.role, shippedRules(), projectRules(s?.db ?? null, r.project)) ?? "on") !== "off"; }
      finally { s?.close(); }
    }
  } catch { on = true; }
  if (!on) return 0;
  const argv = cmd.length === 1 ? ["bash", "-c", cmd[0]] : cmd;
  const p = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await p.exited;
}
