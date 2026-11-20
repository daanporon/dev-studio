// ds approve-fix-ts — spawn the fix squad a testing squad's Thinker proposed (U263): what bin/commands/approve-fix.sh runs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, dsLabel, readJson, run as runCmd, stateRoot, writeErr, writeOut } from "../lib/shared";
import { inherit } from "../lib/upkeep";
import { jqOr, jqRaw, readFields, tsvCell } from "../lib/operator";

export const help = `<project> <testing-topic> <proposal-id> [--autonomy checkpoints|lfg] — spawn the fix squad a proposal asks for (approve-fix.sh)`;

const USAGE = "usage: approve-fix.sh <project> <testing-topic> <proposal-id> [--autonomy checkpoints|lfg]\n";

export async function run(argv: string[]): Promise<number> {
  let autonomy = "checkpoints", project = "", topic = "", pid = "";
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--autonomy") { if (i + 1 >= argv.length) { writeErr("approve-fix.sh: $2: unbound variable\n"); return 1; } autonomy = argv[i + 1]; i += 2; continue; }
    if (project === "") project = a; else if (topic === "") topic = a; else if (pid === "") pid = a;
    else { writeErr(`approve-fix: unexpected arg '${a}'\n`); return 2; }
    i++;
  }
  if (project === "" || topic === "" || pid === "") { writeErr(USAGE); return 2; }

  const label = dsLabel(project);
  const state = join(stateRoot(), label, "squads", `${topic}.json`);
  if (!existsSync(state)) { writeErr(`approve-fix: no squad '${topic}' for '${label}' (${state})\n`); return 1; }

  const d = readJson(state);
  const matches: any[] = Array.isArray(d?.proposed_squads) ? d.proposed_squads.filter((p: any) => p !== null && typeof p === "object" && p.id === pid) : [];
  const first = matches[0];
  const [pTopic, pRepo, pStatus] = first ? readFields([first.topic, first.repo, first.status].map(tsvCell).join("\t"), 3) : ["", "", ""];
  if (!pTopic) { writeErr(`approve-fix: no proposal '${pid}' in squad '${topic}' (see /ds-board or the state file)\n`); return 1; }
  if (pStatus === "spawned") { writeErr(`approve-fix: proposal '${pid}' already spawned — nothing to do\n`); return 0; }
  const pFraming = matches.map((p) => jqRaw(jqOr(p.framing))).join("\n");
  const pHost = jqRaw(jqOr(d?.host));

  writeErr(`approve-fix: spawning fix squad '${pTopic}' (repo=${pRepo}) from proposal '${pid}'…\n`);
  const sp = ["--repo", pRepo, "--topic", pTopic, "--type", "feature", "--autonomy", autonomy, "--framing", pFraming];
  if (pHost !== "") sp.push("--host", pHost);
  const rc = await inherit([process.env.DS_SPAWN || join(ROOT, "bin", "commands", "spawn-squad.sh"), ...sp]);
  if (rc !== 0) { writeErr(`approve-fix: spawn-squad failed for '${pTopic}' (see above) — proposal left as-is for retry\n`); return 1; }

  const ss = join(ROOT, "bin", "role", "squad-state.sh");
  await runCmd([ss, state, "set-proposal-status", pid, "spawned"]);
  await runCmd([ss, state, "resolve-question", pid, "--answer", "approved"]);
  writeOut(`approve-fix: fix squad '${pTopic}' spawned; proposal '${pid}' marked spawned in '${topic}'.\n`);
  return 0;
}
