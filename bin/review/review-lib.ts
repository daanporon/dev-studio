// review-lib.ts — what review-unit-ts needs that the shell got from jq, bash and the old shell lib
// (U228): JSON files read the way jq read them, bash's `read`/glob/`printf %q`, the limits, the
// roster row and unit tier (from loop.db when it is current), the plugin probe and its repair line.
// Only bun/node built-ins; no package and no shell lib.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ROOT, settingsAt, stateRoot, writeErr } from "../lib/shared";
import { readGet, readRoster } from "../loop/settings/settings";
import { ceRepairCmd } from "../lib/account-skills";

export const writeErrLine = (s: string): void => { writeErr(s + "\n"); };

// ---- processes -------------------------------------------------------------------------------

export type Ran = { out: string; err: string; rc: number };

/** The env a child gets: this process's env (CROSS_MODEL_PEERS included once set), plus overrides; undefined unsets. */
export function childEnv(over: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

/** Run to completion, no shell. stdin is /dev/null unless given. A missing binary is rc 127. */
export function sh(cmd: string[], o: { stdin?: string; env?: Record<string, string | undefined>; cwd?: string } = {}): Ran {
  try {
    const p = Bun.spawnSync({
      cmd, cwd: o.cwd, env: childEnv(o.env), stdout: "pipe", stderr: "pipe",
      stdin: o.stdin === undefined ? "ignore" : Buffer.from(o.stdin),
    });
    return { out: p.stdout?.toString() ?? "", err: p.stderr?.toString() ?? "", rc: p.exitCode ?? 1 };
  } catch { return { out: "", err: "", rc: 127 }; }
}

/** `$(cmd 2>/dev/null || true)`: stdout without trailing newlines, "" when the command failed. */
export function out(cmd: string[], o: Parameters<typeof sh>[1] = {}): string {
  return chompAll(sh(cmd, o).out);
}

export const chompAll = (s: string): string => s.replace(/\n+$/, "");

export function git(...args: string[]): Ran { return sh(["git", ...args]); }
/** `$(git … 2>/dev/null || true)` */
export function gitOut(...args: string[]): string { return chompAll(git(...args).out); }
/** `$(git … 2>/dev/null)` with its status: [stdout, ok]. */
export function gitTry(...args: string[]): [string, boolean] { const r = git(...args); return [chompAll(r.out), r.rc === 0]; }

/** `command -v <name>`: an executable file of that name on PATH. */
export function onPath(name: string): boolean {
  if (name.includes("/")) return isExec(name);
  for (const d of (process.env.PATH ?? "").split(":")) if (d && isExec(join(d, name))) return true;
  return false;
}

// ---- files -----------------------------------------------------------------------------------

export function isFile(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }
export function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
export function exists(p: string): boolean { try { statSync(p); return true; } catch { return false; } }
export function isLink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
export function nonEmpty(p: string): boolean { try { return statSync(p).size > 0; } catch { return false; } }
export function readable(p: string): boolean { try { accessSync(p, constants.R_OK); return true; } catch { return false; } }
export function writable(p: string): boolean { try { accessSync(p, constants.W_OK); return true; } catch { return false; } }
export function isExec(p: string): boolean { try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; } }
export function owned(p: string): boolean { try { return statSync(p).uid === process.getuid!(); } catch { return false; } }
/** `[ a -nt b ]`: a exists and is newer than b (or b is missing). */
export function newer(a: string, b: string): boolean {
  let ma: bigint;
  try { ma = statSync(a, { bigint: true }).mtimeNs; } catch { return false; }
  try { return ma > statSync(b, { bigint: true }).mtimeNs; } catch { return true; }
}
/** `readlink -f`: the canonical path; a missing last component is kept; "" when more is missing. */
export function realpathF(p: string): string {
  try { return realpathSync(p); } catch { /* fall through */ }
  try { return join(realpathSync(dirname(p)), basename(p)); } catch { return ""; }
}
export function readText(p: string): string | null { try { return readFileSync(p, "utf8"); } catch { return null; } }
export function sha256File(p: string): string {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return ""; }
}
export const now = (): number => Math.floor(Date.now() / 1000);

// ---- JSON the way jq reads it ----------------------------------------------------------------

/** The values of a JSON text stream (jq reads concatenated values), and whether it parsed to the end. */
export function parseStream(text: string): { values: any[]; ok: boolean } {
  const values: any[] = [];
  let i = 0;
  const n = text.length;
  const ws = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (true) {
    while (i < n && ws(text[i])) i++;
    if (i >= n) return { values, ok: true };
    const start = i;
    const c = text[i];
    if (c === "{" || c === "[") {
      let depth = 0, inStr = false;
      for (; i < n; i++) {
        const ch = text[i];
        if (inStr) { if (ch === "\\") i++; else if (ch === "\"") inStr = false; continue; }
        if (ch === "\"") inStr = true;
        else if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") { depth--; if (depth === 0) { i++; break; } }
      }
      if (depth !== 0) return { values, ok: false };
    } else if (c === "\"") {
      for (i++; i < n; i++) { if (text[i] === "\\") i++; else if (text[i] === "\"") { i++; break; } }
    } else {
      while (i < n && !ws(text[i]) && !"[]{}\",".includes(text[i])) i++;
      if (i === start) return { values, ok: false };
    }
    try { values.push(JSON.parse(text.slice(start, i))); } catch { return { values, ok: false }; }
  }
}

/** `jq -s .` of a file: the array of its values, or null when it is missing or does not parse. */
export function slurp(file: string): any[] | null {
  const t = readText(file);
  if (t === null) return null;
  const s = parseStream(t);
  return s.ok ? s.values : null;
}

export class JqError extends Error {}
export function jtype(v: any): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : typeof v === "boolean" ? "boolean" : typeof v;
}
/** `.k`: null on null, the field (or null) on an object, an error on anything else. */
export function get(v: any, k: string): any {
  if (v === null || v === undefined) return null;
  if (jtype(v) !== "object") throw new JqError(`Cannot index ${jtype(v)} with "${k}"`);
  return Object.prototype.hasOwnProperty.call(v, k) ? v[k] : null;
}
/** `.[i]`: null on null, the element (or null) on an array, an error on anything else. */
export function at(v: any, i: number): any {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw new JqError(`Cannot index ${jtype(v)} with number`);
  return i < v.length ? v[i] : null;
}
/** `a.b.c` as a path of getters. */
export function path(v: any, ...ks: (string | number)[]): any {
  for (const k of ks) v = typeof k === "number" ? at(v, k) : get(v, k);
  return v;
}
export const truthy = (v: any): boolean => !(v === null || v === undefined || v === false);
/** `(f) // d`: f's value unless it is null/false or errors. */
export function alt<T>(f: () => any, d: T): any {
  try { const r = f(); return truthy(r) ? r : d; } catch { return d; }
}
/** `.[]?` / `.[]`: the elements of an array or the values of an object; `[]` on null when optional. */
export function each(v: any, optional = false): any[] {
  if (Array.isArray(v)) return v;
  if (jtype(v) === "object") return Object.values(v);
  if (optional) return [];
  throw new JqError(`Cannot iterate over ${jtype(v)}`);
}
/** jq's total order: null < false < true < numbers < strings < arrays < objects. */
export function jcmp(a: any, b: any): number {
  const rank = (v: any) => v === null || v === undefined ? 0 : v === false ? 1 : v === true ? 2
    : typeof v === "number" ? 3 : typeof v === "string" ? 4 : Array.isArray(v) ? 5 : 6;
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) return a - b;
  if (ra === 4) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 5) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = jcmp(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  if (ra === 6) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    const c = jcmp(ka, kb);
    if (c) return c;
    for (const k of ka) { const d = jcmp(a[k], b[k]); if (d) return d; }
  }
  return 0;
}
export const jeq = (a: any, b: any): boolean => jcmp(a, b) === 0;
export function unique(xs: any[]): any[] {
  const s = [...xs].sort(jcmp);
  return s.filter((x, i) => i === 0 || !jeq(x, s[i - 1]));
}
/** `index($x)`: on an array the first deep-equal position (or null), on a string a substring offset, on null null. */
export function index(v: any, x: any): any {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) { const i = v.findIndex((e) => jeq(e, x)); return i < 0 ? null : i; }
  if (typeof v === "string" && typeof x === "string") {
    if (x === "") return null;
    const i = Buffer.from(v).indexOf(Buffer.from(x)); return i < 0 ? null : i;
  }
  if (jtype(v) === "object" && typeof x === "string") return at(get(v, x), 0); // jq: `.[$i] | .[0]`
  throw new JqError(`Cannot index ${jtype(v)}`);
}
/** `length`: of null 0, of a string/array/object its size, of a number its absolute value. */
export function jlength(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (typeof v === "number") return Math.abs(v);
  if (jtype(v) === "object") return Object.keys(v).length;
  throw new JqError("boolean has no length");
}
/** `-r` output of one value: a string raw, anything else as JSON. */
export function rawOut(v: any): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, Array.isArray(v) || jtype(v) === "object" ? 2 : undefined) ?? "null";
}

/** `jq -r '<f>' file 2>/dev/null` (no slurp): f runs per value, its outputs printed raw one per line;
 *  an error drops the rest of that value's outputs, a parse error ends the stream. Trailing newlines
 *  stripped, as `$(…)` does. */
export function jqR(file: string, f: (v: any, emit: (o: any) => void) => void | any[]): string {
  const t = readText(file);
  if (t === null) return "";
  return jqRText(t, f);
}
/** jqR over a text instead of a file (`jq -r … <<< "$s"`). */
export function jqRText(t: string, f: (v: any, emit: (o: any) => void) => void | any[]): string {
  const lines: string[] = [];
  const emit = (o: any) => { lines.push(rawOut(o)); };
  for (const v of parseStream(t).values) {
    try { const r = f(v, emit); if (Array.isArray(r)) r.forEach(emit); } catch { /* the value's remaining outputs */ }
  }
  return chompAll(lines.join("\n"));
}
/** `X // empty | strings` on one value: the string, or nothing. */
export function strOf(f: () => any): any[] {
  try { const r = f(); return typeof r === "string" ? [r] : []; } catch { return []; }
}
/** `jq -e '<f>' file` (no slurp): true when the file parses and the last output is truthy. */
export function jqE(file: string, f: (v: any) => any): boolean {
  const t = readText(file);
  if (t === null) return false;
  const s = parseStream(t);
  if (!s.ok || s.values.length === 0) return false;
  let last: any = undefined, errored = false;
  for (const v of s.values) {
    try { last = f(v); errored = false; } catch { errored = true; }
  }
  return !errored && last !== undefined && truthy(last);
}
/** `jq -se '<f>' file`: true when the file parses and f of the slurped array is truthy. */
export function jqSE(file: string, f: (s: any[]) => any): boolean {
  const s = slurp(file);
  if (s === null) return false;
  try { return truthy(f(s)); } catch { return false; }
}
/** `any(gen; cond)` with jq's short-circuit: a true element stops before a later error. */
export function any(xs: any[], cond: (x: any) => any): boolean {
  for (const x of xs) if (truthy(cond(x))) return true;
  return false;
}
export function all(xs: any[], cond: (x: any) => any): boolean {
  for (const x of xs) if (!truthy(cond(x))) return false;
  return true;
}

// ---- bash ------------------------------------------------------------------------------------

/** `IFS=$'\t' read -r a b c < file`: the first line split on runs of tabs (leading/trailing tabs
 *  dropped, the last field takes the rest); ok is false at EOF with no newline (read's status). */
export function readTab(text: string | null, nvars: number): { ok: boolean; f: string[] } {
  if (text === null) return { ok: false, f: Array(nvars).fill("") };
  const nl = text.indexOf("\n");
  let s = (nl < 0 ? text : text.slice(0, nl)).replace(/^\t+/, "").replace(/\t+$/, "");
  const f: string[] = [];
  for (let i = 0; i < nvars - 1; i++) {
    const t = s.indexOf("\t");
    if (t < 0) { f.push(s); s = ""; } else { f.push(s.slice(0, t)); s = s.slice(t).replace(/^\t+/, ""); }
  }
  f.push(s);
  return { ok: nl >= 0, f };
}
/** `IFS=<c> read -r -a arr <<< "$s"` for a non-blank separator: empty fields kept, one trailing empty dropped. */
export function splitIfs(s: string, sep: string): string[] {
  const line = s.split("\n")[0];
  if (line === "") return [];
  const parts = line.split(sep);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
/** `IFS=: read -r a b c <<< "$s"`: split on a non-blank separator, the last variable takes the rest. */
export function readSep(s: string, sep: string, nvars: number): string[] {
  let rest = s.split("\n")[0];
  const f: string[] = [];
  for (let i = 0; i < nvars - 1; i++) {
    const t = rest.indexOf(sep);
    if (t < 0) { f.push(rest); rest = ""; } else { f.push(rest.slice(0, t)); rest = rest.slice(t + 1); }
  }
  if (rest.endsWith(sep) && !rest.slice(0, -1).includes(sep)) rest = rest.slice(0, -1);
  f.push(rest);
  return f;
}
/** awk's default field split (runs of blanks, leading blanks ignored), 1-based like $1. */
export function awkFields(line: string): string[] { return line.trim() === "" ? [] : line.trim().split(/[ \t]+/); }

/** A bash glob (`[[ $s == $glob ]]`: * also spans /) as an anchored RegExp. */
export function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) { re += escRe(glob[++i]); continue; }
    if (c === "*") { re += "[\\s\\S]*"; continue; }
    if (c === "?") { re += "[\\s\\S]"; continue; }
    if (c === "[") {
      let j = i + 1;
      if (glob[j] === "!" || glob[j] === "^") j++;
      if (glob[j] === "]") j++;
      while (j < glob.length && glob[j] !== "]") { if (glob[j] === "[" && glob[j + 1] === ":") { const e = glob.indexOf(":]", j + 2); if (e > 0) j = e + 1; } j++; }
      if (j < glob.length) {
        let body = glob.slice(i + 1, j);
        let neg = false;
        if (body[0] === "!" || body[0] === "^") { neg = true; body = body.slice(1); }
        body = body.replace(/\\/g, "\\\\").replace(/\[:(\w+):\]/g, (_, n) => CLASSES[n] ?? "");
        re += `[${neg ? "^" : ""}${body.replace(/^\]/, "\\]")}]`;
        i = j;
        continue;
      }
    }
    re += escRe(c);
  }
  return new RegExp(`^${re}$`);
}
const CLASSES: Record<string, string> = {
  alpha: "A-Za-z", digit: "0-9", alnum: "A-Za-z0-9", upper: "A-Z", lower: "a-z", space: " \\t\\n\\r\\f\\v",
  xdigit: "0-9A-Fa-f", punct: "!-\\/:-@\\[-`{-~", blank: " \\t", word: "A-Za-z0-9_",
};
const escRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\\/-]/g, "\\$&");


/** `tr '\t\n\r' '   '` */
export const flat = (s: string): string => s.replace(/[\t\n\r]/g, " ");

// ---- limits (ds_limit_src) -------------------------------------------------------------------

const LIMIT_ENV: Record<string, string> = {
  context_warn: "DS_RESUME_MAX_CTX", limit_pct: "DS_SWEEP_LIMIT_PCT", pick_session_max: "DS_PICK_SESSION_MAX",
  pick_weekly_max: "DS_PICK_WEEKLY_MAX", unit_token_x: "DS_UNIT_TOKEN_X", unit_token_max: "DS_UNIT_TOKEN_MAX",
  auto_merge: "DS_LOOP_AUTO_MERGE",
};
/** [value, source]: the env var, the project's `config` row (U257: settings.ts readGet), the shipped
 *  default, else ["", "unset"]. The value is the line's first word after the key. */
export function limitSrc(label: string, key: string): [string, string] {
  const v = process.env[LIMIT_ENV[key] ?? `DS_LIMIT_${key.toUpperCase()}`];
  if (v) return [v, "env"];
  const g = readGet(label, "limits.conf", key, settingsAt());
  const val = awkFields(g.value ?? "")[0] ?? "";
  return val ? [val, g.source === "project" ? "override" : "default"] : ["", "unset"];
}
export const limit = (label: string, key: string): string => limitSrc(label, key)[0].split("\t")[0];

/** ds_review_lens: a lens without its catalog suffix. */
export function reviewLens(n: string): string { return n.replace(/-reviewer$/, "").replace(/-researcher$/, ""); }

/** ds_review_skip_lenses_problem: why a review_skip_lenses value is invalid, "" when valid. */
export function skipLensesProblem(v: string): string {
  if (v === "-") return "";
  let lenses = splitIfs(v, ",");
  if (v === "" || v.startsWith(",") || v.endsWith(",") || v.includes(",,")) lenses = [""];
  for (const l of lenses) {
    if (!/^[a-z][a-z0-9_-]*$/.test(l)) return `review_skip_lenses must be comma-separated lowercase lens names, or - (got '${v}')`;
    if (reviewLens(l) === "correctness") return `review_skip_lenses cannot drop correctness: every review runs it (got '${v}')`;
  }
  return "";
}

// ---- the loop's database ---------------------------------------------------------------------

/** loop.db, read-only, only when it holds this checkout's state (the state root is ROOT/state):
 *  the shell read ROOT/state, so a DB of another state root never answers for it. */
function loopDb(): Database | null {
  const st = stateRoot(), mine = join(ROOT, "state");
  if (realpathF(st) !== realpathF(mine)) return null;
  const p = join(st, "loop.db");
  if (!existsSync(p)) return null;
  try { return new Database(p, { readonly: true }); } catch { return null; }
}

/** The project's effective roster (U267) as `<role> -> [role, agent, model, spawn, …]`: the shipped
 *  conventions/roles.conf rows overlaid by the project's `config` rows (settings.ts readRoster), so a
 *  role the project lacks runs the default. */
export function effectiveRosterRows(project: string): Map<string, string[]> {
  return new Map([...readRoster(project, settingsAt())].map(([k, v]): [string, string[]] => [k, [k, ...awkFields(v)]]));
}

/** The tier of the unit this worktree builds (builder_wt, `<x>::` stripped, equal to `pwd -P`): from
 *  loop.db's units, the truth the squad JSON is exported from, with the shell's order (squads by
 *  file name, a squad's first matching unit, an empty tier passing to the next squad); the squad
 *  files when the database has no such unit. */
export function unitTier(label: string, here: string): string {
  const db = loopDb();
  if (db) {
    try {
      const r = db.query("SELECT squad, tier, builder_wt FROM units WHERE project = ? ORDER BY ord, id").all(label) as { squad: string; tier: string | null; builder_wt: string | null }[];
      const first = new Map<string, string>();
      for (const x of r) {
        if (typeof x.builder_wt !== "string" || x.builder_wt.replace(/^[\s\S]*::/, "") !== here || x.tier === null) continue;
        if (!first.has(x.squad)) first.set(x.squad, x.tier);
      }
      if (first.size > 0) {
        for (const sq of [...first.keys()].sort((a, b) => (`${a}.json` < `${b}.json` ? -1 : 1))) {
          const t = first.get(sq)!;
          if (t !== "") return t.split("\n")[0];
        }
        return "";
      }
    } catch { /* the files below */ } finally { db.close(); }
  }
  return tierFromFiles(join(ROOT, "state", label, "squads"), here);
}
/** The shell's scan: per squad file in name order, the first matching unit's tier. */
function tierFromFiles(dir: string, here: string): string {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return ""; }
  for (const f of files) {
    const p = join(dir, f);
    if (!isFile(p)) continue;
    const s = parseStream(readText(p) ?? "");
    for (const doc of s.values) {
      try {
        const ts: string[] = [];
        for (const u of each(get(doc, "units"), true)) {
          const wt = alt(() => get(u, "builder_wt"), "");
          if (typeof wt !== "string" || wt.replace(/^[\s\S]*::/, "") !== here) continue;
          const t = alt(() => get(u, "tier"), null);
          if (t !== null) ts.push(rawOut(t));
        }
        if (ts.length > 0 && ts[0] !== "") return ts[0].split("\n")[0];
      } catch { /* jq failed on this file */ }
    }
  }
  return "";
}

// ---- engines' skill copies ---------------------------------------------------------------------

/** ds_muse_resolve: a muse model alias resolved to the newest visible catalog row. */
export function museResolve(m: string): string {
  const d = process.env.MUSE_MODEL_CATALOG_DIR || join(process.env.HOME ?? "", ".local/share/muse/model-catalog");
  let rows: any[] = [];
  let any_ = false;
  let files: string[] = [];
  try { files = readdirSync(d).filter((f) => f.endsWith(".json")).sort(); } catch { files = []; }
  for (const f of files) {
    const p = join(d, f);
    if (!isFile(p)) continue;
    const s = parseStream(readText(p) ?? "");
    if (!s.ok || s.values.length === 0) continue;
    try {
      const one = s.values.map((v) => each(alt(() => get(v, "rows"), []))
        .filter((r) => get(r, "visibility") === "visible")
        .filter((r) => typeof get(r, "model_id") === "string")
        .filter((r) => !get(r, "model_id").endsWith("-contributor")));
      for (const o of one) { rows = rows.concat(o); any_ = true; }
    } catch { continue; }
  }
  if (!any_) return m;
  if (rows.some((r) => r.model_id === m)) return m;
  const fam = rows.filter((r) => r.model_id.replace(/-[0-9]+(\.[0-9]+)?$/, "") === m)
    .map((r, i) => ({ r, i, k: alt(() => get(r, "release_date"), "") }))
    .sort((a, b) => jcmp(a.k, b.k) || a.i - b.i);
  const last = fam.length ? fam[fam.length - 1].r : null;
  const id = last ? alt(() => get(last, "model_id"), m) : m;
  return rawOut(id) || m;
}

export type Probe = { state: string; scope: string; path: string };
/** ds_ce_skill_probe: does the compound-engineering plugin that applies here have the skill on disk. */
export function skillProbe(skill: string, dir: string): Probe {
  const t = sh(["git", "-C", dir, "rev-parse", "--show-toplevel"]);
  const top = (t.rc === 0 ? chompAll(t.out) : "") || dir;
  if (!onPath("claude")) return { state: "unknown", scope: "-", path: "claude not on PATH" };
  const l = sh(["claude", "plugin", "list", "--json"]);
  if (l.rc !== 0) return { state: "unknown", scope: "-", path: "claude plugin list failed" };
  const s = parseStream(l.out);
  if (!s.ok) return { state: "unknown", scope: "-", path: "claude plugin list did not return JSON" };
  let pick = "";
  try {
    const picks: string[] = [];
    for (const v of s.values) {
      const c = each(v).filter((e) => get(e, "id") === "compound-engineering@compound-engineering-plugin" && get(e, "enabled") === true)
        .filter((e) => get(e, "scope") === "user" || (get(e, "scope") === "project" && get(e, "projectPath") === top))
        .map((e, i) => ({ e, i, rank: get(e, "scope") === "project" ? 0 : 1 }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i);
      if (c.length) picks.push(`${tmpl(get(c[0].e, "scope"))}\t${tmpl(get(c[0].e, "installPath"))}`);
    }
    pick = picks.join("\n");
  } catch { return { state: "unknown", scope: "-", path: "claude plugin list did not return JSON" }; }
  if (!pick) return { state: "not-installed", scope: "-", path: "-" };
  const tab = pick.indexOf("\t");
  const scope = pick.slice(0, tab), p = pick.slice(tab + 1);
  if (isFile(join(p, "skills", skill, "SKILL.md"))) return { state: "ok", scope: p, path: "" };
  return { state: "missing-path", scope, path: p };
}
/** jq string interpolation of a value: a string as is, anything else as JSON. */
const tmpl = (v: any): string => typeof v === "string" ? v : JSON.stringify(v) ?? "null";

/** The probe line read back with `IFS=$'\t' read -r state scope path` (ok carries its path as scope). */
export function probeRead(p: Probe): Probe {
  const line = p.state === "ok" ? `ok\t${p.scope}\n` : `${p.state}\t${p.scope}\t${p.path}\n`;
  const r = readTab(line, 3);
  return { state: r.f[0], scope: r.f[1], path: r.f[2] };
}

/** ds_ce_repair_cmd [install-only] [<scope> <project-dir>]: the repair the operator runs, under CLAUDE_CONFIG_DIR. */
export const repairCmd = (mode: string, scope = "user", pdir = ""): string =>
  ceRepairCmd(mode, scope, pdir, process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? "", ".claude"));
