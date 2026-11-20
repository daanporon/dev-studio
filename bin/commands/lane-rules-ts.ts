// ds lane-rules-ts — the project's lane rules file state/<label>/lanes.md: what bin/role/lane-rules.sh runs.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dsLabel, stateRoot, writeErr, writeOut } from "../lib/shared";

export const help = `<project> [print] | add <id> light|normal "<when it applies>" "<evidence>" | drop <id> | path — shared lane rules (lane-rules.sh)`;
const USAGE = `usage: lane-rules.sh <project> [print] | add <id> light|normal "<when it applies>" "<evidence>" | drop <id> | path`;
const MAX_CHARS = 400;

export async function run(argv: string[]): Promise<number> {
  const err = (s: string) => writeErr(s + "\n");
  if (argv.length < 1) { err(USAGE); return 2; }
  const label = dsLabel(argv[0]), op = argv[1] ?? "print";
  const F = join(stateRoot(), label, "lanes.md");
  const LANE_NOTE = "# Lane = what a unit's checks cost (the files it touches), not its Tier; a running unit can be retagged while under light_lane_cpu_h CPU-h.";
  const fold = (s: string) => s.replace(/[\n\r]/g, " ").trim();
  const ids = () => (existsSync(F) ? readFileSync(F, "utf8").split("\n").map((l) => l.match(/^- ([^:]+): /)?.[1]).filter(Boolean) : []) as string[];
  switch (op) {
    case "path": writeOut(F + "\n"); return 0;
    case "print":
      if (argv.length > 2) { err(USAGE); return 2; }
      if (existsSync(F) && statSync(F).size > 0) writeOut(`# Lane rules for ${label} — shared by every Thinker. A rule with misses (moved units) gets narrowed or dropped (ds lanes ${label}).\n${LANE_NOTE}\n` + readFileSync(F, "utf8"));
      else writeOut(`${LANE_NOTE}\n(no lane rules yet for ${label})\n`);
      return 0;
    case "add": {
      if (argv.length !== 6) { err(USAGE); return 2; }
      const [id, lane] = [argv[2], argv[3]], when = fold(argv[4]), evidence = fold(argv[5]);
      return add(id, lane, when, evidence);
    }
    case "drop": {
      if (argv.length !== 3) { err(USAGE); return 2; }
      if (!existsSync(F)) { err(`lanes: no rules yet for ${label} — nothing to drop`); return 1; }
      const all = readFileSync(F, "utf8").split("\n");
      if (all[all.length - 1] === "") all.pop();
      const rest = all.filter((l) => !l.startsWith(`- ${argv[2]}: `));
      if (rest.length === all.length) { err(`lanes: no rule '${argv[2]}' — nothing dropped`); return 1; }
      const tmp = join(dirname(F), `.drop.${Math.random().toString(36).slice(2, 8)}`);
      writeFileSync(tmp, rest.map((l) => l + "\n").join("")); renameSync(tmp, F);
      writeOut(`lanes: dropped ${argv[2]} from ${F}\n`);
      return 0;
    }
    default: err(USAGE); return 2;
  }
  function add(id: string, lane: string, when: string, evidence: string): number {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) { err("lanes: rule id must be letters, digits, '.', '_' or '-' (it is what `Lane: light (rule: <id>)` names)"); return 2; }
    if (lane !== "light" && lane !== "normal") { err("lanes: lane must be light or normal"); return 2; }
    if (!when) { err("lanes: empty 'when it applies'"); return 2; }
    if (!evidence) { err("lanes: empty evidence — a later Thinker needs it to judge whether the rule still holds"); return 2; }
    if (when.length + evidence.length > MAX_CHARS) { err(`lanes: when + evidence is ${when.length + evidence.length} characters, max ${MAX_CHARS} — shorten it`); return 2; }
    mkdirSync(dirname(F), { recursive: true });
    if (ids().includes(id)) { err(`lanes: rule '${id}' exists — drop it first to replace it`); return 1; }
    appendFileSync(F, `- ${id}: ${lane} — ${when} — ${evidence}\n`);
    writeOut(`lanes: added ${id} to ${F}\n`);
    return 0;
  }
}
