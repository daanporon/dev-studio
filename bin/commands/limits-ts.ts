// ds limits-ts — view and configure the limits (U263): what bin/commands/limits.sh runs. The defaults are
// conventions/limits.conf; a project's overrides are its limits.conf rows in loop.db, changed through
// bin/loop/settings/settings.ts (U256), which checks the key and value and rewrites state/<label>/settings.export.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, dsLabel, writeErr, writeOut } from "../lib/shared";
import { confLines, limitEnvName, limitSrc, readFields } from "../lib/operator";
import { backendChangeNote, rm, set } from "../loop/settings/settings.ts";
import { PROVIDER_SETTINGS } from "../backend/registry.ts";
import { changeSettings } from "../loop/settings/settings-migrate.ts";

export const help = `show [--json] [<project>] | set <project> <key> <value> | rm <project> <key> — view or set the limits (limits.sh)`;

const USAGE = "usage: limits.sh show [--json] [<project>] | set <project> <key> <value> | rm <project> <key>\n";

const dflt = (): string => join(ROOT, "conventions", "limits.conf");

function allowedFor(key: string): string[] | null {
  if (key === "review_block_severity" || key === "review_block_severity_risky") return ["P0", "P1", "P2", "P3"];
  if (key === "compact_mode_studio") return ["compact", "off"];
  if (key.startsWith("compact_mode_")) return ["compact", "clear", "off"];
  if (key === "studio_move") return ["auto", "ask", "off"];
  if (key === "auto_merge") return ["off", "squash", "merge", "rebase"];
  if (key === "builder_host_brake") return ["off", "on"];
  if (key === "unblock_first" || key === "debrief") return ["on", "off"];
  if (key === "worktree_provider") return [...PROVIDER_SETTINGS];
  if (key === "base_update") return ["merge", "rebase"];
  return null;
}

const defaultRows = (): Array<{ key: string; comment: string }> =>
  (existsSync(dflt()) ? confLines(readFileSync(dflt(), "utf8")) : []).map((l) => { const f = readFields(l, 4); return { key: f[0], comment: f[3] }; });


export async function run(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "show";
  const args = argv.slice(1);
  const usage = (): number => { writeErr(USAGE); return 2; };

  if (cmd === "show") {
    let json = false, a = args;
    if (a[0] === "--json") { json = true; a = a.slice(1); }
    const label = dsLabel(a[0]);
    const rows = defaultRows();
    if (json) {
      const limits = rows.map(({ key, comment }) => {
        const [value, source] = limitSrc(label, key);
        const hint = key === "ticket_url" ? "https://tracker.example/issue/{id}, or -" : key === "briefing_time" ? "off or HH:MM (24h), e.g. 08:30" : key === "briefing_days" ? "daily, mon-fri, or mon,wed,fri" : null;
        return { key, value, source, env: limitEnvName(key), comment, allowed: allowedFor(key), hint,
          list: key === "expected_checks" || key === "review_risk_paths" || key === "review_skip_lenses" };
      });
      writeOut(JSON.stringify({ project: label, limits }, null, 2) + "\n");
      return 0;
    }
    writeOut(`LIMITS (${a[0] ? label + a[0] : "repo default"})\n`);
    writeOut(`${"key".padEnd(24)} ${"value".padEnd(12)} ${"source".padEnd(9)} comment\n`);
    writeOut("-".repeat(70) + "\n");
    for (const { key, comment } of rows) {
      const [v, src] = limitSrc(label, key);
      writeOut(`${key.padEnd(24)} ${v.padEnd(12)} ${src.padEnd(9)} ${comment}\n`);
    }
    return 0;
  }

  if (cmd === "set") {
    if (args.length < 3) return usage();
    const [proj, key, val] = args, label = dsLabel(proj);
    let note = "";
    if (!changeSettings("limits.sh", (s) => { const cs = set(s, label, "limits.conf", key, val, "ds limits"); note = backendChangeNote(s, label, cs); return cs; })) return 2;
    writeOut(`set ${key} = ${val.trim()} for ${label}\n`);   // settings.ts stores it trimmed
    if (note) writeOut(note + "\n");
    return 0;
  }

  if (cmd === "rm") {
    if (args.length < 2) return usage();
    const [proj, key] = args, label = dsLabel(proj);
    const cs = changeSettings("limits.sh", (s) => rm(s, label, "limits.conf", key, "ds limits"));
    if (!cs) return 2;
    writeOut(cs.length ? `removed ${key} for ${label}\n` : `no override of ${key} for ${label}; nothing to remove\n`);
    return 0;
  }
  return usage();
}
