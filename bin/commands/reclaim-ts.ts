// ds reclaim-ts — free leaked long-poll slots (U191): what bin/commands/reclaim.sh runs.
// Releases each squad's settled dispatches through the backend's worker-reclaim; safe to re-run.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { stateRoot, dsLabel, globJson, readJson, backend, chomp, writeOut, writeErr } from "../lib/shared";

export const help = `<project> [--topic <t>] | --all — release the settled dispatches a restart leaked (reclaim.sh)`;

const count = (s: string): number => (/^[0-9]+$/.test(s) ? parseInt(s, 10) : 0);
const bk = async (args: string[]): Promise<number> => { const r = await backend(args); return r.rc === 0 ? count(chomp(r.out)) : 0; };

export async function run(argv: string[]): Promise<number> {
  let project = "", oneTopic = "", all = false;
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--all") { all = true; i++; }
    else if (a === "--topic") { if (i + 1 >= argv.length || argv[i + 1] === "") { writeErr("reclaim: --topic needs a value\n"); return 1; } oneTopic = argv[i + 1]; i += 2; }
    else { if (project === "") project = a; else { writeErr(`reclaim: unexpected arg '${a}'\n`); return 2; } i++; }
  }
  if (all) {
    const freed = await bk(["worker-reclaim"]);
    const tabs = await bk(["terminal-reap-orphaned"]);
    const unk = await bk(["worker-resolve-unknown"]);
    writeOut(`reclaim: host-wide — released ${freed} worker dispatch(es) + closed ${tabs} orphaned terminal tab(s) + cleared ${unk} release_unknown across all runs (incl. closed/orphaned)\n`);
    return 0;
  }
  if (project === "") { writeErr("usage: reclaim.sh <project> [--topic <topic>]  |  reclaim.sh --all\n"); return 2; }
  const label = dsLabel(project);
  const dir = join(stateRoot(), label, "squads");
  if (!existsSync(dir)) { writeErr(`reclaim: no squads for '${label}'\n`); return 0; }
  let total = 0, squads = 0;
  for (const f of globJson(dir)) {
    const topic = basename(f, ".json");
    if (oneTopic !== "" && topic !== oneTopic) continue;
    const runId = readJson(f)?.run_id;
    if (!runId) continue;
    const freed = await bk(["worker-reclaim", String(runId)]);
    writeOut(`reclaim: ${topic} (${runId}) — freed ${freed} leaked dispatch(es)\n`);
    total += freed; squads++;
  }
  writeOut(`reclaim: freed ${total} leaked dispatch(es) across ${squads} squad(s) in '${label}'\n`);
  return 0;
}
