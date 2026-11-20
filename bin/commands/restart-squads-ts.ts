// ds restart-squads-ts — restart the roles of one or all squads in a project, in place (U191): what
// bin/commands/restart-squads.sh runs. One restart wish per member, through restart-role.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { stateRoot, dsLabel, globJson, writeOut, writeErr } from "../lib/shared";
import { squadMembers, squadStatus } from "../lib/upkeep";
import { run as restartRole } from "./restart-role-ts";

export const help = `<project> [--topic <t>] [--role <r>] — restart the roles of one or all squads in place (restart-squads.sh)`;

export async function run(argv: string[]): Promise<number> {
  let project = "", oneTopic = "", onlyRole = "";
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--topic") { if (i + 1 >= argv.length) { writeErr("restart-squads.sh: $2: unbound variable\n"); return 1; } oneTopic = argv[i + 1]; i += 2; }
    else if (a === "--role") { if (i + 1 >= argv.length) { writeErr("restart-squads.sh: $2: unbound variable\n"); return 1; } onlyRole = argv[i + 1]; i += 2; }
    else if (a === "--resume") i++;
    else { if (project === "") project = a; else { writeErr(`restart-squads: unexpected arg '${a}'\n`); return 2; } i++; }
  }
  if (project === "") { writeErr("usage: restart-squads.sh <project> [--topic <topic>] [--role <role>] [--resume]\n"); return 2; }
  const label = dsLabel(project);
  const dir = join(stateRoot(), label, "squads");
  if (!existsSync(dir)) { writeErr(`restart-squads: no squads for '${label}'\n`); return 0; }
  let n = 0;
  for (const f of globJson(dir)) {
    const topic = basename(f, ".json");
    if (oneTopic !== "" && topic !== oneTopic) continue;
    if (squadStatus(f) === "suspended") { writeErr(`restart-squads: ${topic} is suspended — skipped\n`); continue; }
    for (const [role, suffix] of squadMembers(f)) {
      if (role === "") continue;
      if (onlyRole !== "" && role !== onlyRole) continue;
      const rc = await restartRole(suffix ? [project, topic, role, suffix] : [project, topic, role], true);
      if (rc === 0) n++; else writeErr(`restart-squads: restart wish FAILED for ${topic}/${role}\n`);
    }
  }
  writeOut(`restart-squads: wrote ${n} restart wish(es) in '${label}' — the loop restarts them\n`);
  return 0;
}
