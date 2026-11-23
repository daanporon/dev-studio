// ds spawn-squad-ts — spawn one topic squad (U263): what bin/commands/spawn-squad.sh runs. A wish writer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dsLabel, dsLoopArgs, readJson, settingsAt, stateRoot, writeErr } from "../lib/shared";
import { dsExec, waitArgs } from "../lib/operator";
import { readRoster } from "../loop/settings/settings";
import { whoAmI } from "../loop/core/whoami.ts";

export const help = `--repo <selector> --topic <slug> [--type t] [--autonomy a] [--host h] [--framing f | --framing-file path] [--start s] — write a squad's running wish (spawn-squad.sh)`;

const USAGE = "usage: spawn-squad.sh --repo <selector> --topic <slug> [--type feature|testing] [--autonomy checkpoints|lfg] [--host <saved-env>] [--framing <text>] [--start plan|brainstorm|ask|investigate|fix]\n";

export async function run(raw: string[]): Promise<number> {
  const la = dsLoopArgs("spawn-squad.sh", raw);
  if (la.error) { writeErr(la.error + "\n"); return 2; }
  const argv = la.argv;
  let repo = "", topic = "", host = "", framing = "", framingFile = "", start = "", type = "feature", autonomy = "checkpoints";
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i];
    if (!["--repo", "--topic", "--type", "--autonomy", "--host", "--framing", "--framing-file", "--start"].includes(a)) { writeErr(USAGE); return 2; }
    if (i + 1 >= argv.length) { writeErr("spawn-squad.sh: $2: unbound variable\n"); return 1; }
    const v = argv[i + 1];
    if (a === "--repo") repo = v; else if (a === "--topic") topic = v; else if (a === "--type") type = v;
    else if (a === "--autonomy") autonomy = v; else if (a === "--host") host = v; else if (a === "--start") start = v; else if (a === "--framing-file") framingFile = v; else framing = v;
  }
  if (repo === "" || topic === "") { writeErr(USAGE); return 2; }
  if (framingFile !== "") {
    if (argv.includes("--framing")) { writeErr("spawn-squad: --framing-file and --framing are exclusive\n"); return 2; }
    try { framing = readFileSync(framingFile, "utf8"); } catch (e) { writeErr(`spawn-squad: cannot read --framing-file ${framingFile}: ${e instanceof Error ? e.message : e}\n`); return 2; }
    if (framing === "") { writeErr(`spawn-squad: --framing-file ${framingFile} is empty\n`); return 2; }
  }
  if (type !== "feature" && type !== "testing") { writeErr("spawn-squad: --type must be feature|testing\n"); return 2; }
  if (start !== "" && !["plan", "brainstorm", "ask", "investigate", "fix"].includes(start)) { writeErr(USAGE); return 2; }
  if (autonomy !== "checkpoints" && autonomy !== "lfg") { writeErr("spawn-squad: --autonomy must be checkpoints|lfg\n"); return 2; }
  if (topic.startsWith(".") || /[^A-Za-z0-9._-]/.test(topic)) { writeErr("spawn-squad: --topic must be [A-Za-z0-9._-] and not start with '.'\n"); return 2; }

  const label = dsLabel(repo);
  const home = readJson(join(stateRoot(), label, "dispatcher.json"))?.home_repo;
  if (typeof home === "string" && home !== "") repo = home;

  // The effective roster (U267, settings.ts readRoster): the project's rows override their roles, the
  // default fills the rest.
  const roster = readRoster(label, settingsAt());
  if (roster.size > 0 && !roster.has("lead")) {
    writeErr("spawn-squad: roster (conventions/roles.conf) has no 'lead' role\n"); return 1;
  }
  const keep = (o: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ""));
  const fill = keep({ repo, type, autonomy, host, framing });
  const from = whoAmI().handle ?? "";
  const payload = keep({ repo, type, autonomy, host, framing, start, from });
  return dsExec(["want", "squad", `${label}/${topic}`, "running", "--payload", JSON.stringify(payload), "--fill", JSON.stringify(fill), "--by", "spawn-squad", ...waitArgs(la.wait)]);
}
