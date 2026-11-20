// ds suspend-squad-ts — suspend a squad or bring it back (U263): what bin/commands/suspend-squad.sh runs. A wish writer.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dsLabel, dsLoopArgs, stateRoot, writeErr } from "../lib/shared";
import { dsExec, waitArgs } from "../lib/operator";
import { squadStatus } from "../lib/upkeep";

export const help = `<project> <topic> [--resume] — write a squad's suspended (or running) wish (suspend-squad.sh)`;

export async function run(raw: string[]): Promise<number> {
  const la = dsLoopArgs("suspend-squad.sh", raw);
  if (la.error) { writeErr(la.error + "\n"); return 2; }
  let project = "", topic = "", resume = false;
  for (const a of la.argv) {
    if (a === "--resume") resume = true;
    else if (project === "") project = a;
    else if (topic === "") topic = a;
    else { writeErr(`suspend-squad: unexpected arg '${a}'\n`); return 2; }
  }
  if (project === "" || topic === "") { writeErr("usage: suspend-squad.sh <project> <topic> [--resume]\n"); return 2; }
  const label = dsLabel(project);
  const f = join(stateRoot(), label, "squads", `${topic}.json`);
  if (!existsSync(f)) { writeErr(`suspend-squad: no squad '${topic}' for '${label}' (${f})\n`); return 1; }
  if (resume && squadStatus(f) !== "suspended") { writeErr(`suspend-squad: '${topic}' is not suspended\n`); return 1; }
  if (resume) return dsExec(["want", "squad", `${label}/${topic}`, "running", "--by", "resume-squad", ...waitArgs(la.wait)]);
  return dsExec(["want", "squad", `${label}/${topic}`, "suspended", "--by", "suspend-squad", ...waitArgs(la.wait)]);
}
