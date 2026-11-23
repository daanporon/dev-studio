// drivers/claude-launch.ts — the Claude launch line (orca-backend-alternatives U11): the one place that says
// how a role's `claude` is typed into a terminal, for the Orca adapter (bin/backend/orca.ts claudeTab,
// resumeTab, compactSettings, claudeTrust) and for the contract driver (drivers/contract.ts). No store, no
// spawn: callers pass what they read, so the adapter stays a light import.
//   claudeLine(o)       `[env -u CLAUDE_CONFIG_DIR | CLAUDE_CONFIG_DIR=<home>] [DS_MEMBER=… ]PATH=<gates>:$PATH claude …`
//   claudeSettings(o)   the one `--settings` JSON (compaction window, skillOverrides, denied MCP servers, plugins off)
//   markTrusted(dir, p) pre-accept the folder-trust prompt for p in <dir>/.claude.json
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;
/** Orca's data folder, where the managed Claude accounts' profiles live (claude-profiles/<account>/home). */
export const orcaData = (env: Env): string =>
  env.DS_ORCA_DATA || env.ORCA_USER_DATA_PATH || join(env.XDG_CONFIG_HOME || `${env.HOME}/.config`, "orca");
/** A managed account's Claude config dir (CLAUDE_CONFIG_DIR); the system login's .claude.json is in $HOME. */
export const accountHome = (env: Env, acct: string): string => `${orcaData(env)}/claude-profiles/${acct}/home`;
export const systemJsonDir = (env: Env): string => env.DS_CLAUDE_SYSTEM_JSON_DIR || env.HOME || "";

/** jq's JSON text: JSON.stringify, plus the one escape jq adds (DEL). */
const jqText = (v: unknown, indent = 2): string => (JSON.stringify(v, null, indent) ?? "null").replace(/\x7f/g, "\\u007f");

export const utf8Locale = (env: Env): boolean => /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "");
const Q_META = new Set([..." !\"$&'()*,;<>?[\\]^`{|}"]);
const Q_ESC: Record<number, string> = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r", 27: "E", 39: "'", 92: "\\" };
/** bash 5.2's `printf %q`: `''` for nothing; `$'…'` when a character is not printable (a control, or any
 *  non-ASCII outside a UTF-8 locale), its bytes in octal; else a backslash before each shell character. */
export function bashQ(s: string, utf8: boolean): string {
  if (s === "") return "''";
  const cs = [...s];
  const shown = (c: string): boolean => {
    const n = c.codePointAt(0)!;
    return n < 0x80 ? n >= 0x20 && n !== 0x7f : utf8 && !/\p{Cc}/u.test(c);
  };
  if (!cs.every(shown)) {
    let r = "$'";
    for (const c of cs) {
      const n = c.codePointAt(0)!;
      if (Q_ESC[n]) r += `\\${Q_ESC[n]}`;
      else if (shown(c)) r += c;
      else for (const b of Buffer.from(c)) r += `\\${b.toString(8).padStart(3, "0")}`;
    }
    return `${r}'`;
  }
  let r = "";
  cs.forEach((c, i) => {
    const tilde = c === "~" && (i === 0 || cs[i - 1] === "=" || cs[i - 1] === ":");
    if (Q_META.has(c) || tilde || (c === "#" && i === 0)) r += "\\";
    r += c;
  });
  return r;
}

export type ClaudeConfig = { system: true } | { home: string } | null;   // null: the default login, as a plain `claude`
export type LaunchLine = {
  config: ClaudeConfig;
  gates: string;              // bin/hooks/path-gates, "" when missing: `PATH=<gates>:$PATH` goes in front (U235)
  identity?: { member: string; wt: string; gen?: string | null } | null;   // U4: DS_MEMBER/DS_WT/DS_GEN on the line
  resume?: string | null;     // `--continue … --model <model>` on the default login (Orca's resumeTab)
  args: string[];             // each quoted after the command
  utf8: boolean;
};

/** The command line that starts `claude` for a role. `system` keeps its onboarded config at ~/.claude.json, so it
 *  runs with NO CLAUDE_CONFIG_DIR, through `env -u`: with a managed account selected Orca's `claude` function
 *  re-selects that profile whenever the variable is unset, and `env` is a binary, so it skips the function.
 *  `$PATH` stays literal: the terminal's shell expands it. */
export function claudeLine(o: LaunchLine): string {
  const q = (v: string) => bashQ(v, o.utf8);
  const id = o.identity?.member ? `DS_MEMBER=${q(o.identity.member)} DS_WT=${q(o.identity.wt)} ${o.identity.gen ? `DS_GEN=${q(o.identity.gen)} ` : ""}` : "";
  const env = o.config === null ? "" : "system" in o.config ? "env -u CLAUDE_CONFIG_DIR " : `CLAUDE_CONFIG_DIR=${q(o.config.home)} `;
  const claude = o.resume ? `claude --continue --dangerously-skip-permissions --model ${o.resume}` : "claude --dangerously-skip-permissions";
  return `${env}${id}PATH=${q(o.gates)}:$PATH ${claude}${o.args.map((a) => ` ${q(a)}`).join("")}`;
}

/** The claude args for one --settings JSON that holds the auto-compact window (env), the role's skillOverrides, its
 *  denied MCP servers (U283) and the plugins it has off (`enabledPlugins`), or none when all are empty. --settings
 *  outranks ~/.claude/settings.json; an env var on the command does not (probed 2026-10-27). `window` is digits or "". */
export function claudeSettings(o: { window: string; skillOverrides: Record<string, unknown>; denied: unknown[]; plugins: Record<string, unknown> }): string[] {
  const so = Object.keys(o.skillOverrides).length > 0, den = o.denied.length > 0, pl = Object.keys(o.plugins).length > 0;
  if (!o.window && !so && !den && !pl) return [];
  return ["--settings", jqText({ ...(o.window ? { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: o.window } } : {}), ...(so ? { skillOverrides: o.skillOverrides } : {}),
    ...(den ? { deniedMcpServers: o.denied } : {}), ...(pl ? { enabledPlugins: o.plugins } : {}) }, 0)];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Pre-accept Claude's "trust this folder" prompt for `path` in <dir>/.claude.json (projects[path].hasTrustDialogAccepted),
 *  so the TUI comes up without it. Best effort: a missing, empty or non-JSON file is left alone (`unusable`), an
 *  already-trusted path is not rewritten (`already`), a file whose shape is not objects is left alone (`skipped`),
 *  no other key is touched; written through a temp file with the file's mode. */
export function markTrusted(dir: string, path: string): "trusted" | "already" | "unusable" | "skipped" {
  const f = `${dir}/.claude.json`;
  let d: unknown;
  try { if (!statSync(f).isFile()) return "unusable"; d = JSON.parse(readFileSync(f, "utf8")); } catch { return "unusable"; }
  if (!d) return "unusable";
  if (!isObj(d)) return "skipped";
  const projects = d.projects ?? {};
  if (!isObj(projects)) return "skipped";
  const e = projects[path] ?? null;
  if (e !== null && !isObj(e)) return "skipped";
  if (e?.hasTrustDialogAccepted === true) return "already";
  const tmp = `${dir}/.claude.json.${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
  try { writeFileSync(tmp, "", { flag: "wx", mode: 0o600 }); } catch { return "skipped"; }
  writeFileSync(tmp, `${jqText({ ...d, projects: { ...projects, [path]: { ...(e ?? {}), hasTrustDialogAccepted: true } } })}\n`);
  try { chmodSync(tmp, statSync(f).mode & 0o7777); } catch { /* best effort */ }
  try { renameSync(tmp, f); } catch { rmSync(tmp, { force: true }); return "skipped"; }
  return "trusted";
}
