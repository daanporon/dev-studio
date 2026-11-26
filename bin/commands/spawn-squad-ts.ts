// ds spawn-squad-ts — spawn one topic squad (U263): what bin/commands/spawn-squad.sh runs. A wish writer.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dsLabel, dsLoopArgs, readJson, settingsAt, stateRoot, writeErr } from "../lib/shared";
import { dsExec, waitArgs } from "../lib/operator";
import { readGet, readRoster } from "../loop/settings/settings";
import { openReadOnly, dbPath } from "../loop/core/store";
import { noLaunchLine } from "../backend/launch-lines";
import { whoAmI } from "../loop/core/whoami.ts";
import { squadWish } from "../loop/squad/squad-wish.ts";
import { openRemoval } from "../loop/squad/project-removal.ts";

export const help = `--repo <selector> --topic <slug> [--type t] [--autonomy a] [--host h] [--backend b] [--framing f | --framing-file path] [--start s] — write a squad's running wish (spawn-squad.sh)`;

const USAGE = "usage: spawn-squad.sh --repo <selector> --topic <slug> [--type feature|testing] [--autonomy checkpoints|lfg] [--host <saved-env>] [--backend orca|orca-lite|tmux|herdr] [--framing <text>] [--start plan|brainstorm|ask|investigate|fix]\n";

export async function run(raw: string[]): Promise<number> {
  const la = dsLoopArgs("spawn-squad.sh", raw);
  if (la.error) { writeErr(la.error + "\n"); return 2; }
  const argv = la.argv;
  let repo = "", topic = "", host = "", backend = "", framing = "", framingFile = "", start = "", type = "feature", autonomy = "checkpoints";
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i];
    if (!["--repo", "--topic", "--type", "--autonomy", "--host", "--backend", "--framing", "--framing-file", "--start"].includes(a)) { writeErr(USAGE); return 2; }
    if (i + 1 >= argv.length) { writeErr("spawn-squad.sh: $2: unbound variable\n"); return 1; }
    const v = argv[i + 1];
    if (a === "--repo") repo = v; else if (a === "--topic") topic = v; else if (a === "--type") type = v;
    else if (a === "--autonomy") autonomy = v; else if (a === "--host") host = v; else if (a === "--backend") backend = v; else if (a === "--start") start = v; else if (a === "--framing-file") framingFile = v; else framing = v;
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
  if (existsSync(dbPath(stateRoot()))) {
    const ro = openReadOnly();
    let removing: number | null;
    try { removing = openRemoval(ro, label); } finally { ro.close(); }
    if (removing !== null) { writeErr(`spawn-squad: '${label}' is being removed (request ${removing}); no squad starts in it\n`); return 1; }
  }
  const word = (key: string) => String(readGet(label, "limits.conf", key, settingsAt()).value ?? "").trim().split(/\s+/)[0];
  // board-actions-as-wishes U6: the wish itself is squad-wish.ts's, shared with the loop's board Start.
  const w = squadWish({
    label, topic, repo, type, autonomy, host, backend, framing, start, from: whoAmI().handle ?? "",
    disp: readJson(join(stateRoot(), label, "dispatcher.json")),
    // The effective roster (U267, settings.ts readRoster): the project's rows override their roles, the default fills the rest.
    roster: readRoster(label, settingsAt()),
    placed: squadBackend(label, topic), worktreeProvider: word("worktree_provider"),
  });
  if ("error" in w) { writeErr(`spawn-squad: ${w.error}\n`); return 1; }
  return dsExec(["want", "squad", `${w.label}/${w.topic}`, "running", "--payload", JSON.stringify(w.payload), "--fill", JSON.stringify(w.fill), "--by", "spawn-squad", ...waitArgs(la.wait)]);
}

/** The backend of a squad that has started (its doc is written) and is not closed; null for a new one. */
export { noLaunchLine };

function squadBackend(label: string, topic: string): string | null {
  if (!existsSync(dbPath())) return null;
  const s = openReadOnly();
  try {
    const r = s.db.query("SELECT backend FROM squads WHERE project = ? AND topic = ? AND doc IS NOT NULL AND COALESCE(status, '') NOT IN ('closed', 'gone')").get(label, topic) as { backend: string } | null;
    return r ? r.backend : null;
  } catch { return null; /* a db before migration 0054 (between a pull and its migrate): every squad there is on orca */ }
  finally { s.close(); }
}
