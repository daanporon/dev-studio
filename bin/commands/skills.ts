// ds skills — which skills each role starts with (U229): `list` the skills this host offers,
// `resolve` a role's skillOverrides (what orca.sh passes to claude --settings).
import { open } from "../loop/core/store.ts";
import { discoverProjects } from "../loop/settings/projects.ts";
import { stateRoot } from "../loop/core/store.ts";
import { allSkills, deniedMcpServers, disabledPlugins, isProjectSkill, levelOf, mcpLevels, pluginLevels, projectRepoDir, projectRules, roleOf, shippedRules, skillOverrides } from "../loop/settings/skills.ts";

export const help = "list [--refresh] [<project> | --wt <worktree>] | resolve <project> <role> | resolve --wt <worktree> | resolve <project> <role> --hook <name> | resolve … --all (skillOverrides, mcp, deniedMcpServers, plugins, enabledPlugins) — skills a role starts with";
export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "list") {
    let dir = "", label = "";
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--wt") { dir = rest[++i] ?? ""; label = roleOf(dir, discoverProjects(stateRoot()))?.project ?? ""; }
      else if (!rest[i].startsWith("--")) { label = rest[i]; dir = projectRepoDir(label) ?? ""; }
    }
    console.log(JSON.stringify(allSkills(rest.includes("--refresh"), dir, label), null, 1));
    return 0;
  }
  if (sub !== "resolve") { console.error(`usage: ds skills ${help}`); return 2; }
  let project = "", role = "", hook = "", wt = "", all = false;
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--wt") {
      const r = roleOf(rest[++i] ?? "", discoverProjects(stateRoot()));
      if (!r) { console.log("{}"); return 0; }   // not a role worktree: no overrides
      ({ project, role } = r);
      wt = rest[i].replace(/^.*::/, "");   // a selector may read id::path
    } else if (rest[i] === "--all") all = true;
    else if (rest[i] === "--hook") hook = rest[++i] ?? "";
    else pos.push(rest[i]);
  }
  if (pos.length) [project, role] = pos;
  if (!role) { console.error(`usage: ds skills ${help}`); return 2; }
  let s: ReturnType<typeof open> | null = null;
  try { s = open(); } catch { /* no database: the shipped rules alone */ }
  try {
    const shipped = shippedRules(), mine = projectRules(s?.db ?? null, project);
    if (hook) { console.log(levelOf(`hook:${hook}`, role, shipped, mine) ?? "on"); return 0; }
    const skills = allSkills(false, wt);   // the worktree's own .claude/skills join the names the rules map onto
    const so = skillOverrides(skills.map((x) => x.name), role, shipped, mine, new Set(skills.filter(isProjectSkill).map((x) => x.name)));
    if (!all) { console.log(JSON.stringify(so)); return 0; }
    const mcp = mcpLevels(role, shipped, mine);   // U283: the role's MCP servers next to its skillOverrides
    const plugins = pluginLevels(role, shipped, mine);   // each plugin a `plugin:<id>` rule names: on or off
    console.log(JSON.stringify({ skillOverrides: so, mcp, deniedMcpServers: deniedMcpServers(mcp), plugins, enabledPlugins: disabledPlugins(plugins) }));
    return 0;
  } finally { s?.close(); }
}
