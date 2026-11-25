// reassert-roles-ts.ts — bin/hooks/reassert-roles.sh, ported (U190): rewrite every live agent's
// role brief (CLAUDE.local.md), move old hook paths to bin/hooks/ and re-arm each member's picker
// hooks. bin/hooks/reassert-roles.sh runs it (U193: the only body). Same output, exit
// codes, files and backend / arm-picker.sh calls as the shell body; a migrated root still writes
// the loop's request (the loop replays the .sh).
import { lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT, stateRoot, dsLabel, run as runCmd, readJson, writeErr, writeOut } from "../lib/shared";
import { isDir, loopArgs, loopFront, loopKey, loopOn, recipientPaused, worktreePath, writeRoleFile } from "../lib/lib";

export const help = "reassert-roles-ts <project> — rewrite the role briefs of a project's agents (bin/hooks/reassert-roles.sh)";

/** jq `@tsv` of one value (strings escaped, null empty); null for an object or array (jq's error). */
function tsv(v: any): string | null {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return null;
  return String(v).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/** The members as `IFS=$'\t' read -r role wt suffix` sees each `@tsv` line (tabs collapse: IFS whitespace). */
export function members(sq: any): [string, string, string][] {
  const ms = sq?.members;
  if (sq !== null && sq !== undefined && (typeof sq !== "object" || Array.isArray(sq))) return [];
  const list: any[] = Array.isArray(ms) ? ms : ms && typeof ms === "object" ? Object.values(ms) : [];
  const out: [string, string, string][] = [];
  for (const m of list) {
    if (m !== null && (typeof m !== "object" || Array.isArray(m))) break; // jq stops here
    const f = [m?.role ?? null, m?.wt ?? null, m?.suffix === null || m?.suffix === undefined || m?.suffix === false ? "" : m.suffix].map(tsv);
    if (f.includes(null)) break;
    const w = (f as string[]).join("\t").split("\t").filter((x) => x !== "");
    out.push([w[0] ?? "", w[1] ?? "", w.slice(2).join("\t")]);
  }
  return out;
}

const PATH_FIX: [RegExp, string][] = [[/\/bin\/rewake-hook\.sh/g, "/bin/hooks/rewake-hook.sh"],
  [/\/bin\/picker-hook\.sh/g, "/bin/hooks/picker-hook.sh"], [/\/bin\/no-broad-kill-hook\.sh/g, "/bin/hooks/no-broad-kill-hook.sh"]];

export async function run(argv: string[]): Promise<number> {
  const a = loopArgs(argv, "reassert-roles.sh");
  if (!a) return 2;
  if (a.argv.length < 1) { writeErr("usage: reassert-roles.sh <project>\n"); return 2; }
  const LABEL = dsLabel(a.argv[0]);
  const STATE_DIR = join(stateRoot(), LABEL);
  if (!isDir(STATE_DIR)) { writeErr(`reassert-roles: no state for '${LABEL}' (${STATE_DIR}) — run ds up <git-url> first\n`); return 1; }
  // A migrated state root: the loop does it (U13b) — a request it fulfils by running the .sh again.
  if (loopOn()) {
    const rc = await loopFront(LABEL, "reassert-roles", "", "", `reassert-roles:${LABEL}:${loopKey(a.argv)}`, a, "hooks/reassert-roles.sh");
    if (rc !== null) return rc;
  }

  let n = 0;
  const write = async (wt: string, role: string, topic = "", runId = "") => { await writeRoleFile(wt, role, LABEL, topic, runId); n++; };
  // U185: move any hook entry still naming a pre-folder bin path to bin/hooks/.
  const rewriteHooks = async (wt: string) => {
    const path = await worktreePath(wt);
    if (!path || !isDir(path)) return;
    const settings = join(path, ".claude", "settings.local.json");
    try {
      if (!statSync(settings).isFile()) return;
      const text = readFileSync(settings, "utf8");
      const fixed = PATH_FIX.reduce((s, [re, to]) => s.replace(re, to), text);
      if (fixed !== text) writeFileSync(settings, fixed);
    } catch { /* as the shell: best effort */ }
  };

  // Studio (the one standing cockpit; dispatcher.json is the instance-state file name).
  const disp = readJson(join(STATE_DIR, "dispatcher.json"));
  const s = disp && typeof disp === "object" && !Array.isArray(disp) ? disp.studio_wt : null;
  if (s !== null && s !== undefined && s !== false && s !== "") {
    const wt = typeof s === "string" ? s : JSON.stringify(s, null, 2);
    await write(wt, "studio");
    await rewriteHooks(wt);
  }

  // Each squad's members, with the squad's run for the Lead's adopt line; re-arms their pickers.
  const squads = join(STATE_DIR, "squads");
  let files: string[] = [];
  try { files = readdirSync(squads).filter((f) => f.endsWith(".json")).map((f) => join(squads, f)).filter((f) => { try { return lstatSync(f).isFile(); } catch { return false; } }); }
  catch { /* no squads */ }
  for (const sf of files) {
    const topic = basename(sf, ".json");
    const sq = readJson(sf);
    const r = sq && typeof sq === "object" && !Array.isArray(sq) ? sq.run_id : null;
    const runId = r === null || r === undefined || r === false ? "" : typeof r === "string" ? r : JSON.stringify(r, null, 2);
    for (const [role, wt, suffix] of members(sq)) {
      if (!role || !wt) continue;
      if (await recipientPaused(LABEL, wt)) { writeOut(`reassert-roles: ${role} (${topic}) is paused — skipped\n`); continue; }
      await write(wt, role, topic, runId);
      await rewriteHooks(wt);
      const plabel = suffix ? `${role}-${suffix}` : role;
      if ((await runCmd([join(ROOT, "bin", "hooks", "arm-picker.sh"), wt, sf, plabel])).rc !== 0)
        writeErr(`reassert-roles: WARNING — could not arm picker hooks for ${plabel} (${topic})\n`);
    }
  }

  writeOut(`reassert-roles: wrote ${n} role brief(s) for '${LABEL}' — poke/restart each agent so it re-reads (or it applies on its next session start)\n`);
  return 0;
}
