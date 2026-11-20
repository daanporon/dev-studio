// ds close-squad-ts — tear down one squad (U263): what bin/commands/close-squad.sh runs. A wish writer.
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { dsLabel, dsLoopArgs, readJson, stateRoot, writeErr } from "../lib/shared";
import { dsExec, jqRaw, waitArgs } from "../lib/operator";

export const help = `<project> <topic> [--force] [--keep-state] [--purge] — write a squad's archived wish (close-squad.sh)`;

export async function run(raw: string[]): Promise<number> {
  const la = dsLoopArgs("close-squad.sh", raw);
  if (la.error) { writeErr(la.error + "\n"); return 2; }
  let project = "", topic = "";
  for (const a of la.argv) {
    if (a === "--force" || a === "--keep-state" || a === "--purge") continue;
    if (project === "") project = a;
    else if (topic === "") topic = a;
    else { writeErr(`close-squad: unexpected arg '${a}'\n`); return 2; }
  }
  if (project === "") { writeErr("usage: close-squad.sh <project> [<topic>] [--force] [--keep-state]\n"); return 2; }
  const label = dsLabel(project);

  if (topic === "") {
    writeErr(`close-squad: which squad in '${label}'? open squads:\n`);
    const dir = join(stateRoot(), label, "squads");
    let found = false;
    if (existsSync(dir)) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".json") && !x.startsWith(".")).sort()) {
        found = true;
        const d = readJson(join(dir, f));
        const field = (k: string): string => { const v = d?.[k]; return v === null || v === undefined || v === false ? "?" : jqRaw(v); };
        writeErr(`  ${basename(f, ".json")}  [${field("type")}/${field("status")}]\n`);
      }
    }
    if (!found) writeErr("  (none)\n");
    writeErr(`re-run with the topic: close-squad.sh ${project} <topic>\n`);
    return 2;
  }
  const state = join(stateRoot(), label, "squads", `${topic}.json`);
  if (!existsSync(state)) { writeErr(`close-squad: no squad '${topic}' for '${label}' (expected ${state})\n`); return 1; }
  return dsExec(["want", "squad", `${label}/${topic}`, "gone", "--by", "close-squad", ...waitArgs(la.wait)]);
}
