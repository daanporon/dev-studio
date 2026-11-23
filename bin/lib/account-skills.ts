// account-skills.ts — can each Claude account load the role skills, and its plan (U274: the TypeScript
// twins of the old shell lib's ds_account_skills_scan / _verdict / _check, ds_ce_repair_cmd and ds_account_plan,
// which are gone). Reads each account's config dir only (no `claude` call), so the loop can run it.
// Kept apart from lib.ts so the hook ports that import lib.ts don't load it.
import { readFileSync, readlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { hostBackendPath, readIfs, run, shq, writeErr, writeOut } from "./shared";
import { accountOwner, canon, exists, isDir, isFile, isLink } from "./install";

/** The skills the roles invoke (roles/*.md). ONE list: the check reads it, and tests/install-ce-accounts.sh
 *  greps roles/*.md so a new role skill can't be added without the check learning it. */
export const ROLE_CE_SKILLS = ["ce-code-review", "ce-work", "ce-plan", "ce-brainstorm", "ce-babysit-pr", "ce-commit-push-pr",
  "ce-compound", "ce-doc-review", "ce-debug", "ce-explain", "ce-pov", "ce-resolve-pr-feedback", "ce-simplify-code", "ce-test-browser", "lfg"];
/** User skills under <config dir>/skills: missing = broken. */
export const ROLE_USER_SKILLS = ["no-mistakes"];
/** Missing only warns. */
export const ROLE_OPTIONAL_USER_SKILLS = ["lavish"];

export const CE_ID = "compound-engineering@compound-engineering-plugin";
const home = (): string => process.env.HOME ?? "";

/** The command the operator runs to re-record compound-engineering under the config dir that owns the real
 *  plugins dir (`install-only`, else uninstall + install); a project/local scope runs from its project dir.
 *  `cfg` is the config dir it is asked under (CLAUDE_CONFIG_DIR, else ~/.claude). Printed only. */
export function ceRepairCmd(mode: string, scope: string, pdir: string, cfg: string): string {
  const sc = scope || "user";
  const owner = accountOwner(cfg);
  const pfx = owner === `${home()}/.claude` ? "env -u CLAUDE_CONFIG_DIR" : `env CLAUDE_CONFIG_DIR=${shq(owner)}`;
  const cd = sc !== "user" && pdir ? `cd ${shq(pdir)} && ` : "";
  if (mode === "install-only") return `${cd}${pfx} claude plugin install ${CE_ID} --scope ${sc}`;
  return `${cd}${pfx} claude plugin uninstall ${CE_ID} --scope ${sc} && ${pfx} claude plugin install ${CE_ID} --scope ${sc}`;
}

/** `env -u CLAUDE_CONFIG_DIR` for ~/.claude, else `env CLAUDE_CONFIG_DIR=<dir>`. */
function cfgPrefix(dir: string): string {
  return canon(dir) === canon(`${home()}/.claude`) ? "env -u CLAUDE_CONFIG_DIR" : `env CLAUDE_CONFIG_DIR=${shq(dir)}`;
}

/** ceRepairCmd under <cfg>'s env: ~/.claude itself (CLAUDE_CONFIG_DIR unset) or <cfg>. */
function repairIn(cfg: string, mode: string, scope = "", pdir = ""): string {
  return ceRepairCmd(mode, scope, pdir, cfgPrefix(cfg) === "env -u CLAUDE_CONFIG_DIR" ? `${home()}/.claude` : cfg);
}

/** jq's `@tsv` of one value; null when jq would stop (an object or array). */
function tsvVal(v: unknown): string | null {
  if (typeof v === "string") return v.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/** The registry rows `[id, scope, projectPath, installPath]`, `-` for none, as jq read them. */
function registryRows(reg: string): string[][] {
  let doc: any;
  try { doc = JSON.parse(readFileSync(reg, "utf8")); } catch { return []; }
  if (doc === null || doc === false) return []; // jq -e . fails
  const rows: string[][] = [];
  const plugins = doc && typeof doc === "object" && !Array.isArray(doc) ? (doc.plugins ?? {}) : null;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return rows;
  for (const [id, value] of Object.entries(plugins)) {
    if (!value || typeof value !== "object") continue; // `.value[]?`
    for (const e of Object.values(value as object)) {
      if (e !== null && (typeof e !== "object" || Array.isArray(e))) return rows; // jq stops on the error
      const f = (k: string) => { const v = e?.[k]; return v === null || v === undefined || v === false ? "-" : tsvVal(v); };
      const row = [tsvVal(id), f("scope"), f("projectPath"), f("installPath")];
      if (row.some((c) => c === null)) return rows;
      rows.push(row as string[]);
    }
  }
  return rows;
}

/** ds_account_skills_scan <config-dir>: every fault of one account's skills, one record per line,
 *  `<broken|warn|note>\t<fault>\t<path>\t<repair>`, and `ok\t<installPath>` when nothing is broken. */
export function accountSkillsScan(cfg: string): string[] {
  const out: string[] = [];
  const owner = accountOwner(cfg);
  const reg = `${cfg}/plugins/installed_plugins.json`;
  let cePath = "", ceFound = false, broken = false;
  if (isFile(reg)) {
    for (const r of registryRows(reg)) {
      // `IFS=$'\t' read -r id scope ppath ipath`: an empty field collapses like the shell's read.
      let [id, scope, ppath, ipath] = readIfs(r.join("\t"), 4, "\t");
      if (!id) continue;
      if (scope === "-") scope = "";
      if (ipath === "-") ipath = "";
      if (ppath === "-") ppath = "";
      if (id === CE_ID && scope === "user") { ceFound = true; cePath = ipath; }
      if (ipath && exists(ipath)) continue;
      const projectish = scope === "project" || scope === "local";
      if (projectish && ppath && !isDir(ppath)) {
        out.push(`note\t${id} (${scope} scope) points at a path that does not exist, but its project ${ppath} is gone too — harmless\t${ipath}\t-`);
        continue;
      }
      broken = true;
      let rc: string;
      if (id === CE_ID) rc = repairIn(cfg, "full", scope, ppath);
      else {
        rc = `${cfgPrefix(owner)} claude plugin uninstall ${id} --scope ${scope}`;
        if (projectish) rc = `cd ${shq(ppath)} && ${rc}`;
      }
      out.push(`broken\t${id} (${scope} scope) is registered at a path that does not exist\t${ipath}\t${rc}`);
    }
  }
  if (!ceFound) {
    out.push(`broken\tcompound-engineering is not installed (user scope) for this config dir\t${reg}\t${repairIn(cfg, "install-only")}`);
    broken = true;
  } else if (cePath && exists(cePath)) {
    const missing = ROLE_CE_SKILLS.filter((s) => !isFile(`${cePath}/skills/${s}/SKILL.md`)).map((s) => ` ${s}`).join("");
    if (missing) {
      out.push(`broken\tcompound-engineering is installed but lacks role skill(s):${missing}\t${cePath}\t${repairIn(cfg, "full")}`);
      broken = true;
    }
    // enabled state lives in <cfg>/settings.json (enabledPlugins), not in the registry
    let on = false;
    try {
      const s = JSON.parse(readFileSync(`${cfg}/settings.json`, "utf8"));
      const ep = s?.enabledPlugins;
      const v = ep && typeof ep === "object" && !Array.isArray(ep) ? ep[CE_ID] : undefined;
      on = v === true || v === "true";
    } catch { /* unreadable: not enabled */ }
    if (!on) {
      out.push(`broken\tcompound-engineering is installed but not enabled in this config dir (enabledPlugins in settings.json)\t${cfg}/settings.json\t${cfgPrefix(cfg)} claude plugin enable ${CE_ID} --scope user`);
      broken = true;
    }
    // Recorded through a profile: the path runs through a symlinked <profile>/plugins. A note, not a warn:
    // no repair sticks (Claude Code re-records it on each plugin update), and a real dangle shows as broken.
    const cut = cePath.indexOf("/plugins/");
    const recCfg = cut >= 0 ? cePath.slice(0, cut) : cePath;
    if (recCfg !== cePath && isLink(`${recCfg}/plugins`)) {
      let name = basename(recCfg);
      if (name === "home") name = basename(dirname(recCfg));
      out.push(`note\tcompound-engineering is recorded through ${name}'s symlinked plugins/ — Claude Code re-records it on each plugin update from that profile; a real dangle shows as broken\t${cePath}\t-`);
    }
  }
  const umiss = ROLE_USER_SKILLS.filter((s) => !isFile(`${cfg}/skills/${s}/SKILL.md`)).map((s) => ` ${s}`).join("");
  const omiss = ROLE_OPTIONAL_USER_SKILLS.filter((s) => !isFile(`${cfg}/skills/${s}/SKILL.md`)).map((s) => ` ${s}`).join("");
  if (umiss) {
    out.push(`broken\tuser skill(s) missing from ${cfg}/skills:${umiss}\t${cfg}/skills\tinstall the skill(s)${umiss} into ${cfg}/skills (copy each <name>/ directory from a config dir that has it)`);
    broken = true;
  }
  if (omiss) out.push(`warn\toptional user skill(s) missing from ${cfg}/skills:${omiss}\t${cfg}/skills\tbin/host/install-skills.sh`);
  if (!broken) out.push(`ok\t${cePath}`);
  return out;
}

/** ds_account_skills_verdict <config-dir>: `<ok|broken|warn>\t<one-line reason>` (broken beats warn beats ok). */
export function accountSkillsVerdict(cfg: string): string {
  let b = "", w = "", o = "";
  for (const l of accountSkillsScan(cfg)) {
    const f = l.split("\t");
    if (f[0] === "broken" && !b) b = f[1] ?? "";
    if (f[0] === "warn" && !w) w = f[1] ?? "";
    if (f[0] === "ok") o = f[1] ?? "";
  }
  return b ? `broken\t${b}` : w ? `warn\t${w}` : `ok\t${o}`;
}

export type Sink = { out: (s: string) => void; err: (s: string) => void };
const stdio: Sink = { out: writeOut, err: writeErr };

/** One account's report: the ok line on out, ⚠ blocks and notes on err; false when it is broken. */
function accountReport(label: string, cfg: string, io: Sink): boolean {
  let scan = accountSkillsScan(cfg);
  // a warning means the account is not plain "ok": print the ⚠ block alone
  if (scan.some((l) => l.startsWith("warn"))) scan = scan.filter((l) => !l.startsWith("ok"));
  let where = cfg === `${home()}/.claude` ? `${cfg} (CLAUDE_CONFIG_DIR unset)` : cfg;
  let link = "";
  try { link = readlinkSync(`${cfg}/plugins`); } catch { /* not a link */ }
  if (link) where = `${where}, plugins -> ${link}`;
  let ok = true;
  for (const l of scan) {
    const [kind, fault, path, repair] = readIfs(l, 4, "\t");
    if (kind === "ok") io.out(`${label}: skills ok (${fault})\n`);
    else if (kind === "note") io.err(`  note ${label}: ${fault}\n`);
    else if (kind === "broken" || kind === "warn") {
      if (kind === "broken") ok = false;
      io.err(`⚠ ${label}: ${fault}${kind === "warn" ? " (warning)" : ""}\n    config dir:  ${where}\n    path:        ${path}\n`
        + `    repair (the operator runs it; --check changes nothing): ${repair}\n`);
    }
  }
  return ok;
}

/** `$(adapter <args>)`: stdout with trailing newlines gone, and whether it exited 0. */
async function adapterOut(adapter: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await run([adapter, ...args]);
  return { ok: r.rc === 0, out: r.out.replace(/\n+$/, "") };
}

/** ds_account_skills_check <backend> [--tsv]: the install --check verdict per Claude account (`claude[<account>]:
 *  skills ok (<path>)` or a ⚠ block; with tsv `<account>\t<ok|broken|warn>\t<reason>` per account). Accounts
 *  come from the backend's account-list with their claude-config-dir (empty = ~/.claude); backend unreachable or
 *  no Claude account -> the current env only (`claude`, account `current` in tsv). Returns 1 when any is broken. */
export async function accountSkillsCheck(adapter: string = hostBackendPath(), tsv = false, io: Sink = stdio): Promise<number> {
  let accts: string[] = [];
  if ((await run([adapter, "status"])).rc === 0) {
    const list = (await run([adapter, "account-list"])).out;
    accts = list.split("\n").map((l) => l.split("\t")).filter((f) => f[0] === "claude" && (f[1] ?? "") !== "").map((f) => f[1]);
  }
  if (accts.length === 0) {
    const dir = process.env.CLAUDE_CONFIG_DIR || `${home()}/.claude`;
    if (!tsv) return accountReport("claude", dir, io) ? 0 : 1;
    const v = accountSkillsVerdict(dir);
    io.out(`current\t${v}\n`);
    return v.startsWith("broken\t") ? 1 : 0;
  }
  let rc = 0;
  for (const acct of accts) {
    const d = await adapterOut(adapter, ["claude-config-dir", acct]);
    if (!d.ok) {
      if (tsv) io.out(`${acct}\twarn\tthe backend has no Claude config dir for this account — not checked\n`);
      else io.err(`⚠ claude[${acct}]: the backend has no Claude config dir for this account — not checked\n`);
      continue;
    }
    const dir = d.out || `${home()}/.claude`; // system: ~/.claude with CLAUDE_CONFIG_DIR unset
    if (tsv) {
      const v = accountSkillsVerdict(dir);
      io.out(`${acct}\t${v}\n`);
      if (v.startsWith("broken\t")) rc = 1;
    } else if (!accountReport(`claude[${acct}]`, dir, io)) rc = 1;
  }
  return rc;
}

/** ds_account_plan <backend> <agent> <account>: the account's plan name, "" when unknown (U123). Only Claude has a
 *  reader: `oauthAccount.organizationRateLimitTier` in <config dir>/.claude.json (~/.claude.json for `system`);
 *  default_claude_max_5x -> Max, default_claude_max_20x -> Ultra, any other tier its raw text. */
export async function accountPlan(adapter: string, agent: string, account: string): Promise<string> {
  if (agent !== "claude") return "";
  const d = await adapterOut(adapter, ["claude-config-dir", account]);
  if (!d.ok) return "";
  const f = d.out ? `${d.out}/.claude.json` : `${home()}/.claude.json`;
  if (!isFile(f)) return "";
  let tier = "";
  try {
    const v = JSON.parse(readFileSync(f, "utf8"))?.oauthAccount?.organizationRateLimitTier;
    if (typeof v === "string") tier = v.replace(/[\t\r\n]/g, "");
  } catch { return ""; }
  return tier === "default_claude_max_5x" ? "Max" : tier === "default_claude_max_20x" ? "Ultra" : tier;
}
