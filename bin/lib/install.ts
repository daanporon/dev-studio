// install.ts — what the two install commands share (U262): the role-row walk, account owners, the shell's
// readlink -f and glob order, and children run by absolute path so a stub PATH behaves as it did in bash.
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ROOT, writeErr, type Ran } from "./shared";

export const MUSE_CE_SKILLS = "ce-simplify-code ce-work ce-debug ce-code-review ce-resolve-pr-feedback ce-commit-push-pr ce-pov";
export const MUSE_DS_SKILL = "ds";

export const isFile = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
export const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
export const isLink = (p: string): boolean => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const isExec = (p: string): boolean => { try { return statSync(p).isFile() && (statSync(p).mode & 0o111) !== 0; } catch { return false; } };

/** `command -v <name>` against the current PATH: the absolute path, or null. */
export function which(name: string): string | null {
  if (name.includes("/")) return isExec(name) ? name : null;
  return Bun.which(name, { PATH: process.env.PATH ?? "" }) ?? null;
}

function resolveCmd(cmd: string[]): string[] | null {
  const bin = which(cmd[0]);
  return bin === null ? null : [bin, ...cmd.slice(1)];
}

type Opts = { env?: Record<string, string | undefined>; stdin?: string; cwd?: string };
const childEnv = (env?: Record<string, string | undefined>) => {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...(env ?? {}) })) if (v !== undefined) e[k] = v;
  return e;
};

/** `$(cmd)`: stdout and stderr captured, stdin from a string or /dev/null; a missing command is rc 127. */
export async function capture(cmd: string[], opts: Opts = {}): Promise<Ran> {
  const c = resolveCmd(cmd);
  if (c === null) return { out: "", err: "", rc: 127 };
  try {
    const p = Bun.spawn(c, { stdout: "pipe", stderr: "pipe", env: childEnv(opts.env), cwd: opts.cwd,
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin) });
    const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, rc };
  } catch { return { out: "", err: "", rc: 127 }; }
}

/** A bare command in a script: this process's stdio (`out`/`err` "ignore" for `>/dev/null`); rc 127 when missing. */
export async function inherit(cmd: string[], opts: Opts & { out?: "ignore"; err?: "ignore"; stdinNull?: boolean } = {}): Promise<number> {
  const c = resolveCmd(cmd);
  if (c === null) { if (opts.err !== "ignore") writeErr(`${cmd[0]}: command not found\n`); return 127; }
  try {
    const p = Bun.spawn(c, { stdin: opts.stdinNull ? "ignore" : "inherit", stdout: opts.out ?? "inherit", stderr: opts.err ?? "inherit",
      env: childEnv(opts.env), cwd: opts.cwd });
    return await p.exited;
  } catch { return 127; }
}

/** GNU `readlink -f`: every component but the last must exist; null when it cannot resolve. */
function readlinkF(p: string, depth = 0): string | null {
  if (depth > 40) return null;
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* last component missing or dangling */ }
  let dir: string;
  try { dir = realpathSync(dirname(abs)); } catch { return null; }
  const last = join(dir, basename(abs));
  let target: string;
  try { target = readlinkSync(last); } catch { return last; }
  return readlinkF(isAbsolute(target) ? target : join(dir, target), depth + 1);
}

/** `readlink -f <p> || echo <p>`. */
export const canon = (p: string): string => readlinkF(p) ?? p;

/** the old shell lib ds_account_owner: the parent of <cfg>/plugins' real dir when it is named plugins, else <cfg>. */
export function accountOwner(cfg: string): string {
  const real = readlinkF(join(cfg, "plugins"));
  return real !== null && real !== "" && basename(real) === "plugins" ? dirname(real) : cfg;
}

/** True when the collation the shell sorts globs with is plain byte order. */
function byteCollation(): boolean {
  const loc = process.env.LC_ALL || process.env.LC_COLLATE || process.env.LANG || "";
  return loc === "" || loc === "C" || loc === "POSIX" || /^C\./.test(loc);
}
const collator = new Intl.Collator("en", { ignorePunctuation: true });
/** The order bash expands a glob in under the current locale. */
function shellSort(names: string[]): string[] {
  const bytes = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  if (byteCollation()) return [...names].sort(bytes);
  return [...names].sort((a, b) => collator.compare(a, b) || bytes(a, b));
}

/** `sort -V` of plain names: digit runs compare as numbers. */
export function versionSort(names: string[]): string[] {
  const parts = (s: string) => s.match(/\d+|\D+/g) ?? [];
  return [...names].sort((a, b) => {
    const x = parts(a), y = parts(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const dx = /^\d/.test(x[i]), dy = /^\d/.test(y[i]);
      if (dx && dy) { const d = Number(x[i]) - Number(y[i]); if (d !== 0) return d; continue; }
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return x.length - y.length;
  });
}

/** `<dir>/*` entries (no dot names) in glob order. */
export function globNames(dir: string): string[] {
  try { return shellSort(readdirSync(dir).filter((n) => !n.startsWith("."))); } catch { return []; }
}

/** the old shell lib ds_role_rows: the default roles.conf's lines, then every project's roster rows (U257: the
 *  `config` rows of the state root's loop.db, settings.ts; none without one). */
function roleRows(root: string = ROOT): string[] {
  const state = process.env.DS_STATE_ROOT || join(root, "state"), dflt = join(root, "conventions", "roles.conf");
  let text = "";
  if (isFile(dflt)) { try { text = readFileSync(dflt, "utf8"); } catch { /* unreadable: cat fails */ } }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  // settings.ts (and the loop modules it imports) is loaded only when there is a database to read and the
  // checkout has it: the tests' partial install checkouts (tests/lib/install-ts.sh) carry no bin/loop.
  const settings = join(import.meta.dir, "..", "loop", "settings", "settings.ts");
  if (!existsSync(join(state, "loop.db")) || !existsSync(settings)) return lines;
  const { readProjectRosterLines } = require(settings) as typeof import("../loop/settings/settings.ts");
  return [...lines, ...readProjectRosterLines({ root: state })];
}

export type RoleUse = { role: string; agent: string; kind: "primary" | "fallback" };
/** Every (role, agent) use in the role rows, in file order: the primary, then each fallback entry's agent. */
export function roleUses(rows: string[] = roleRows()): RoleUse[] {
  const uses: RoleUse[] = [];
  for (const line of rows) {
    if (line === "" || line.startsWith("#")) continue;
    const f = line.split(/[ \t\n]+/).filter((w) => w !== "");
    if (f.length < 2) continue;
    const [name, agent] = f;
    let fb = "";
    if (f.length >= 6) fb = f[5];
    else if (f.length === 5 && f[4].includes(":")) fb = f[4];
    uses.push({ role: name, agent, kind: "primary" });
    if (fb === "" || fb === "-") continue;
    for (const entry of fb.split(",")) {
      const fa = entry.split(":")[0];
      if (fa !== "") uses.push({ role: name, agent: fa, kind: "fallback" });
    }
  }
  return uses;
}

/** The agents of `uses` in order of first use. */
export const agentsInUse = (uses: RoleUse[]): string[] => [...new Set(uses.map((u) => u.agent))];

/** `muse skills list` row whose first column is <name> and third reads `on`. */
export function museSkillOn(listing: string, name: string): boolean {
  return listing.split("\n").some((l) => { const f = l.trim().split(/\s+/); return f[0] === name && f[2] === "on"; });
}

/** Undo what the .sh bootstrap set for this process only: bun's transpiler cache was off so a --check
 *  writes nothing under $HOME; every child gets the caller's value back. */
export function restoreBunEnv(): void {
  const was = process.env.DS_INSTALL_TCACHE;
  if (was === undefined) return;
  delete process.env.DS_INSTALL_TCACHE;
  if (was === "@unset") delete process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  else process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = was;
}

/** `[ -e p ]`. */
export const exists = (p: string): boolean => existsSync(p);
