// ds add-role-ts — ask the loop to add one role worker to a running squad (U263): what bin/commands/add-role.sh runs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dsLabel, stateRoot, writeErr } from "../lib/shared";
import { dsExec } from "../lib/operator";

export const help = `<project> <topic> <role> <suffix> [--spec <text>] [--host <name>] — write a member wish for one extra worker (add-role.sh)`;

const USAGE = "usage: add-role.sh <project> <topic> <role> <suffix> [--spec <text>] [--host <name>]\n";

export async function run(argv: string[]): Promise<number> {
  if (argv.length < 4) { writeErr(USAGE); return 2; }
  const [project, topic, role, suffix] = argv;
  let spec = "", host = "";
  const rest = argv.slice(4);
  for (let i = 0; i < rest.length;) {
    const a = rest[i];
    if (a === "--spec") { if (i + 1 >= rest.length) { writeErr("add-role.sh: $2: unbound variable\n"); return 1; } spec = rest[i + 1]; i += 2; }
    // side-loop-host U10: --host forces the side host the worker runs on (tests, the operator); the loop places the rest.
    else if (a === "--host") { if (i + 1 >= rest.length) { writeErr(USAGE); return 2; } host = rest[i + 1]; i += 2; }
    else if (["--agent", "--model", "--effort", "--account", "--for", "--unit", "--owns"].includes(a)) {
      writeErr(`add-role: ${a} is ignored; the loop places workers\n`); i += 2;
    } else { writeErr(USAGE); return 2; }
  }
  if (suffix === "" || /[^A-Za-z0-9._-]/.test(suffix)) { writeErr(`add-role: bad suffix '${suffix}'\n`); return 2; }
  if (role === "lead") { writeErr("add-role: a squad has exactly one Lead (its coordinator); it is created with the squad, not added.\n"); return 2; }
  if (!["builder", "reviewer", "tester", "researcher", "thinker"].includes(role)) {
    writeErr(`add-role: unknown role '${role}' (allowed within a squad: builder, thinker, reviewer, tester, researcher)\n`); return 2;
  }
  const label = dsLabel(project);
  const state = join(stateRoot(), label, "squads", `${topic}.json`);
  if (!existsSync(state)) { writeErr(`add-role: no squad '${topic}' for project '${label}' (expected ${state})\n`); return 1; }
  const args = role === "builder" ? ["builder", "--unit", suffix] : [role, "--suffix", suffix];
  if (spec !== "") args.push("--spec", spec);
  if (host !== "") args.push("--host", host);
  return dsExec(["request", ...args, "--squad", `${label}/${topic}`]);
}
