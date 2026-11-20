// settings.ts — the one writer of a project's settings rows (U255, KTD2 of the settings-db plan):
// get, set, rm, reset, export and history for the project overrides of limits.conf, roles.conf,
// models.conf and ship-mode, as `config` rows (project, file, key) in the value shape confRows makes
// (KTD3), so the readers that already use rows (pick, lifecycle, liveness, board-data, override,
// limits) see the same thing. Every change writes its row and one `config_history` row in one
// transaction, then rewrites the plain-text backup `<state>/<label>/settings.export` (KTD6), which
// nothing reads.
//
// Order (unchanged from bin/loop/settings/limits.ts): an env var (limits.conf only) beats the project row,
// which beats the default. Defaults are the shipped conventions/*.conf (KTD1): code, read here
// through the same confRows the config observer uses.
//
// Since the cut-over (U256, settings-migrate.ts) these rows are the only copy: the config observer
// reads only conventions/*.conf, and the board's Settings and Roles edits (fulfil/config.ts), `ds
// config` and `ds limits|roles|ship-mode` all write through here.
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { limitValueProblem, SHIP_MODES } from "../../lib/operator.ts";
import { confRows, confText } from "../db/import-config.ts";
import { limitEnv } from "./limits.ts";
import { FOCUS_KEY, focusProblem, NO_FOCUS } from "../squad/focus.ts";
import { dbPath, now as clock, openReadOnly, ROOT, stateRoot, type Store } from "../core/store.ts";

export const SETTINGS_FILES = ["limits.conf", "roles.conf", "models.conf", "ship-mode"] as const;
export type SettingsFile = (typeof SETTINGS_FILES)[number];
export type Source = "env" | "project" | "default";

export interface Got { project: string; file: SettingsFile; key: string; value: string | null; source: Source | null; env?: string }
export interface Change { project: string; file: SettingsFile; key: string; old: string | null; new: string | null }
export interface HistoryRow { id: number; project: string; file: string; key: string; old_value: string | null; new_value: string | null; actor: string; at: number }
export interface Opts { conventions?: string; now?: number }

// A refused change: the message says why, as the shell scripts said it.
export class SettingsError extends Error {}

const NAME = /^[A-Za-z0-9._-]+$/;
const SPAWNS = ["always", "ondemand", "elevate"];
const FALLBACK = "[A-Za-z0-9._-]+:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+(:[A-Za-z0-9._-]+)?)?";

const conv = (o: Opts): string => o.conventions ?? join(ROOT, "conventions");
const fail = (m: string): never => { throw new SettingsError(m); };

function checkFile(file: string): SettingsFile {
  return (SETTINGS_FILES as readonly string[]).includes(file) ? file as SettingsFile : fail(`unknown settings file '${file}' (one of: ${SETTINGS_FILES.join(" ")})`);
}
function checkProject(project: string): void {
  if (!NAME.test(project)) fail(`bad project label '${project}'`);
}

// The shipped rows of a file (project ''): key -> {value, comment}.
function shipped(file: string, o: Opts): Map<string, { value: string; comment: string | null }> {
  return new Map(confRows("", file, join(conv(o), file)).map((r) => [String(r.key.key), { value: String(r.set.value ?? ""), comment: (r.set.comment as string | null) ?? null }]));
}

function rowOf(store: Store | null, project: string, file: string, key: string): { value: string | null; comment: string | null } | null {
  if (!store) return null;
  return store.db.query("SELECT value, comment FROM config WHERE project = ? AND file = ? AND key = ?").get(project, file, key) as { value: string | null; comment: string | null } | null;
}
function rowsOf(store: Store, project: string, file: string): { key: string; value: string | null; comment: string | null }[] {
  return store.db.query("SELECT key, value, comment FROM config WHERE project = ? AND file = ? ORDER BY rowid").all(project, file) as { key: string; value: string | null; comment: string | null }[];
}

// The default of one key: the shipped row; for ship-mode the project's conventions/projects.conf
// line (its first word after the label, as shipMode reads it), else ce-pipeline.
function defaultOf(project: string, file: SettingsFile, key: string, o: Opts): string | null {
  if (file === "ship-mode") return shipped("projects.conf", o).get(project)?.value.split(/\s+/)[0] || "ce-pipeline";
  return shipped(file, o).get(key)?.value ?? null;
}

export function get(store: Store | null, project: string, file: string, key: string, o: Opts = {}): Got {
  checkProject(project);
  const f = checkFile(file);
  if (f === "limits.conf") {
    const env = limitEnv(key), ev = process.env[env];
    if (ev) return { project, file: f, key, value: ev, source: "env", env };
  }
  const row = rowOf(store, project, f, key);
  if (row && (row.value ?? "").trim() !== "") return { project, file: f, key, value: row.value, source: "project" };
  // roles.conf too (U267, roster.ts): a role the project's roster lacks runs its default row.
  const d = defaultOf(project, f, key, o);
  return { project, file: f, key, value: d, source: d === null ? null : "default" };
}

// The model catalog a roster row may name: shipped and project models.conf, the Codex CLI's live
// rows (file codex-models), and every agent:model a default or project roster row already uses (the
// board's catalog shows those as custom). A versioned name (muse-spark-1.3) matches its family.
function catalog(store: Store, project: string, o: Opts): Set<string> {
  const out = new Set<string>([...shipped("models.conf", o).keys()]);
  for (const r of store.db.query("SELECT key FROM config WHERE (project = ? AND file = 'models.conf') OR (project = '' AND file = 'codex-models')").all(project) as { key: string }[]) out.add(r.key);
  const rosters = [...[...shipped("roles.conf", o).values()].map((r) => r.value), ...rowsOf(store, project, "roles.conf").map((r) => r.value ?? "")];
  for (const v of rosters) {
    const f = v.split(/\s+/);
    if (f[0] && f[1]) out.add(`${f[0]}|${f[1]}`);
    for (const fb of (f[4] ?? "").split(",")) { const [a, m] = fb.split(":"); if (a && m) out.add(`${a}|${m}`); }
  }
  return out;
}
function inCatalog(cat: Set<string>, agent: string, model: string): boolean {
  return cat.has(`${agent}|${model}`) || cat.has(`${agent}|${model.replace(/-[0-9]+(\.[0-9]+)?$/, "")}`);
}

// A roster value `agent model [spawn] [effort] [fallbacks] [plan]` checked and filled as roles.sh set
// does: an omitted spawn is the current row's, the default's, else always; omitted fallbacks are the
// current row's (else the default's) and an omitted plan the current row's, `-` clearing either.
// Normalized to single spaces with `-` for an empty field before a later one.
function rosterValue(store: Store, project: string, role: string, value: string, o: Opts): string {
  const def = shipped("roles.conf", o).get(role)?.value, cur = rowOf(store, project, "roles.conf", role)?.value ?? undefined;
  if (def === undefined && cur === undefined) fail(`unknown role '${role}' (not in the default roster or ${project}'s)`);
  const [agent = "", model = "", spawn0 = "", effort0 = "", fb0 = "", plan0 = ""] = value.trim().split(/\s+/);
  if (!NAME.test(agent) || !NAME.test(model)) fail(`a roster row needs an agent and a model (got '${value}')`);
  if (!inCatalog(catalog(store, project, o), agent, model)) fail(`unknown model '${agent}:${model}' (not in the model catalog)`);
  const spawn = spawn0 || cur?.split(/\s+/)[2] || def?.split(/\s+/)[2] || "always";
  if (!SPAWNS.includes(spawn)) fail("spawn must be always|ondemand|elevate");
  const dash = (v: string): string => (v === "-" ? "" : v), field = (v: string | undefined, i: number): string => v?.split(/\s+/)[i] ?? "";
  const effort = dash(effort0), fb = dash(fb0 || field(cur ?? def, 4)), plan = dash(plan0 || field(cur, 5));
  if (effort && !NAME.test(effort)) fail(`bad effort '${effort}'`);
  if (fb && !new RegExp(`^${FALLBACK}(,${FALLBACK})*$`).test(fb)) fail(`fallbacks must be agent:model[:effort[:plan]][,agent:model[:effort[:plan]]...] (got '${fb}')`);
  if (plan && !NAME.test(plan)) fail(`bad plan '${plan}'`);
  const fields = [agent, model, spawn, effort, fb, plan];
  while (fields.length > 3 && fields[fields.length - 1] === "") fields.pop();
  return fields.map((f) => f || "-").join(" ");
}

// models.conf: key `<agent>|<model>`, value `<label> | <efforts>` (efforts comma-separated or -).
function modelValue(key: string, value: string): string {
  const [agent, model, ...rest] = key.split("|").map((s) => s.trim());
  if (!agent || !model || rest.length || !NAME.test(agent) || !NAME.test(model)) fail(`a models.conf key is <agent>|<model> (got '${key}')`);
  const [label = "", efforts = "", ...more] = value.split("|").map((s) => s.trim());
  if (!label || more.length) fail(`a models.conf value is '<label> | <efforts>' (got '${value}')`);
  if (efforts && efforts !== "-" && !/^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$/.test(efforts)) fail(`efforts must be comma-separated names, or - (got '${efforts}')`);
  return `${label} | ${efforts || "-"}`;
}

// The row value a set stores for one key, after the file's checks; "default" / "-" for ship-mode is
// handled by set() as an rm.
function checked(store: Store, project: string, file: SettingsFile, key: string, value: string, o: Opts): string {
  const v = value.trim();
  if (file === "limits.conf") {
    if (!shipped("limits.conf", o).has(key) && key !== "review_delta_full_lines") fail(`unknown key '${key}' (see: limits.sh show)`);
    const problem = limitValueProblem(key, v);
    if (problem) fail(problem);
    // squad-priority U1: the focus names a live feature squad of this project, or `-` (none).
    if (key === FOCUS_KEY && v !== NO_FOCUS) { const why = focusProblem(store, project, v); if (why) fail(why); }
    return v;
  }
  if (file === "roles.conf") {
    if (!NAME.test(key)) fail(`bad role name '${key}'`);
    return rosterValue(store, project, key, v, o);
  }
  if (file === "models.conf") return modelValue(key, v);
  if (key !== "mode") fail(`ship-mode has one key, mode (got '${key}')`);
  if (!SHIP_MODES.split(" ").includes(v)) fail(`invalid mode '${v}' (one of: ${SHIP_MODES})`);
  return v;
}

function history(store: Store, c: Change, actor: string, at: number): void {
  store.db.run("INSERT INTO config_history (project, file, key, old_value, new_value, actor, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [c.project, c.file, c.key, c.old, c.new, actor, at]);
}

// One row to `value` (null drops it), with its history row; null when nothing changed.
function write(store: Store, project: string, file: SettingsFile, key: string, value: string | null, comment: string | null, actor: string, at: number): Change | null {
  const old = rowOf(store, project, file, key)?.value ?? null;
  if (old === value) return null;
  if (value === null) store.db.run("DELETE FROM config WHERE project = ? AND file = ? AND key = ?", [project, file, key]);
  else store.upsert("config", { project, file, key }, { value, comment, observed_at: at });
  const c: Change = { project, file, key, old, new: value };
  history(store, c, actor, at);
  // squad-priority U1: every writer of the focus (ds focus, the board, an undo, limits.sh, the loop's
  // clear) logs one `focus_set` when the focus it means changes (no row and `-` both mean none).
  const from = old ?? NO_FOCUS, to = value ?? NO_FOCUS;
  if (file === "limits.conf" && key === FOCUS_KEY && from !== to)
    store.event("focus_set", { project, squad: to === NO_FOCUS ? from : to, payload: { from, to, by: actor } });
  return c;
}

const words = (v: string): string => v.trim().split(/\s+/).join(" ");
const one = (c: Change | null): Change[] => (c ? [c] : []);

function done(store: Store, project: string, changes: Change[]): Change[] {
  if (changes.length) writeExport(store, project);
  return changes;
}

export function set(store: Store, project: string, file: string, key: string, value: string, actor: string, o: Opts = {}): Change[] {
  checkProject(project);
  const f = checkFile(file);
  if (f === "ship-mode" && ["default", "-"].includes(value.trim())) return rm(store, project, f, key, actor, o);
  const v = checked(store, project, f, key, value, o), at = o.now ?? clock();
  // A role's default value on a project without its row changes nothing: the role already runs it.
  if (f === "roles.conf" && !rowOf(store, project, f, key) && words(v) === words(shipped(f, o).get(key)?.value ?? "")) return [];
  // A roster edit writes that role's row only (U267): every other role keeps following the default.
  return done(store, project, store.tx(() => one(write(store, project, f, key, v, null, actor, at))));
}

// Drop the project's row of one key: back to the default (for roles.conf the role's default row,
// as roles.sh rm). Nothing to drop is no change and no history row.
export function rm(store: Store, project: string, file: string, key: string, actor: string, o: Opts = {}): Change[] {
  checkProject(project);
  const f = checkFile(file), at = o.now ?? clock();
  return done(store, project, store.tx(() => one(write(store, project, f, key, null, null, actor, at))));
}

// With a key: that key back to its default, by dropping the project's row (rm; roles.conf, U267:
// the role then follows the default row, so it must have one). Without: every project row of the
// file goes.
export function reset(store: Store, project: string, file: string, key: string | null, actor: string, o: Opts = {}): Change[] {
  checkProject(project);
  const f = checkFile(file), at = o.now ?? clock();
  if (key !== null && f === "roles.conf" && !shipped("roles.conf", o).has(key)) fail(`'${key}' is not in the default roster`);
  if (key !== null) return rm(store, project, f, key, actor, o);
  return done(store, project, store.tx(() => rowsOf(store, project, f).map((r) => write(store, project, f, r.key, null, null, actor, at)).filter((c): c is Change => c !== null)));
}

// A project's rows of one file replaced by the rows of a conf text, unchecked (the values were already
// in force): the cut-over's import and `ds config import`. A row the text lacks goes. With `record`, a
// key the text keeps as it is still gets one history row by `actor` (the migration's "imported" mark),
// unless one with that value is there already, so a rerun adds none.
export function importText(store: Store, project: string, file: string, text: string, actor: string, o: Opts & { record?: boolean } = {}): Change[] {
  checkProject(project);
  const f = checkFile(file), at = o.now ?? clock();
  const want = new Map(confText(project, f, text, at).map((r) => [String(r.key.key), { value: String(r.set.value ?? ""), comment: (r.set.comment as string | null) ?? null }]));
  return done(store, project, store.tx(() => {
    const out: Change[] = [];
    for (const r of rowsOf(store, project, f)) if (!want.has(r.key)) out.push(...one(write(store, project, f, r.key, null, null, actor, at)));
    for (const [key, w] of want) {
      const cur = rowOf(store, project, f, key);
      const c = write(store, project, f, key, w.value, w.comment, actor, at);
      if (c) { out.push(c); continue; }
      if ((cur?.comment ?? null) !== w.comment) store.upsert("config", { project, file: f, key }, { value: w.value, comment: w.comment, observed_at: at });
      if (o.record && !store.db.query("SELECT 1 FROM config_history WHERE project = ? AND file = ? AND key = ? AND actor = ? AND new_value IS ?").get(project, f, key, actor, w.value)) {
        const same: Change = { project, file: f, key, old: w.value, new: w.value };
        history(store, same, actor, at);
        out.push(same);
      }
    }
    return out;
  }));
}

// Each file's project rows in conf syntax, as confRows reads them back to the same rows; a file with
// no rows is left out.
export function exportFiles(store: Store, project: string): Partial<Record<SettingsFile, string>> {
  checkProject(project);
  const out: Partial<Record<SettingsFile, string>> = {};
  for (const f of SETTINGS_FILES) {
    const rows = rowsOf(store, project, f);
    if (!rows.length) continue;
    out[f] = rows.map((r) => {
      const body = f === "ship-mode" ? r.value ?? "" : f === "models.conf" ? `${r.key.split("|").join(" | ")} | ${r.value ?? ""}` : `${r.key} ${r.value ?? ""}`.trimEnd();
      return r.comment ? `${body}  # ${r.comment}` : body;
    }).join("\n") + "\n";
  }
  return out;
}

export const EXPORT_SECTION = "#== ";

// The whole backup: a header saying it is not read, then each file's rows under `#== <file>`.
export function exportText(store: Store, project: string): string {
  const files = exportFiles(store, project);
  const head = `# settings.export — ${project}'s settings overrides, a backup that nothing reads.\n` +
    `# Change a setting with \`ds config set ${project} <file> <key> <value>\` or on the board, not here.\n`;
  return head + SETTINGS_FILES.filter((f) => files[f] !== undefined).map((f) => `\n${EXPORT_SECTION}${f}\n${files[f]}`).join("");
}

// Split an export back into each file's text (what confRows reads), by its `#== <file>` lines.
export function exportSections(text: string): Partial<Record<SettingsFile, string>> {
  const out: Partial<Record<SettingsFile, string>> = {};
  let cur: SettingsFile | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith(EXPORT_SECTION)) { const f = line.slice(EXPORT_SECTION.length).trim(); cur = (SETTINGS_FILES as readonly string[]).includes(f) ? f as SettingsFile : null; continue; }
    if (cur && line !== "") out[cur] = (out[cur] ?? "") + line + "\n";
  }
  return out;
}

export function writeExport(store: Store, project: string): string {
  const dir = join(store.root, project), path = join(dir, "settings.export");
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${path}.tmp`, exportText(store, project));
  renameSync(`${path}.tmp`, path);
  return path;
}

export function historyOf(store: Store, project: string, file?: string | null, key?: string | null): HistoryRow[] {
  return store.db.query("SELECT * FROM config_history WHERE project = ? AND (? IS NULL OR file = ?) AND (? IS NULL OR key = ?) ORDER BY id")
    .all(project, file ?? null, file ?? null, key ?? null, key ?? null) as HistoryRow[];
}

// ---- readers outside the loop (U257) ---------------------------------------------------------
// A command, the review step, spawn-squad, up and install hold no Store: they read the rows of the
// state root's loop.db, opened read-only for the one read. No db (a host before its first import, a
// test root that has none) reads as no project rows, so the shipped default answers. No code outside
// the config importer, its observer and this module reads a project's settings file
// (tests/loop/settings-files-guard.test.ts).

export interface ReadOpts extends Opts { root?: string }

function reading<T>(o: ReadOpts, none: T, fn: (s: Store) => T): T {
  const root = o.root ?? stateRoot();
  if (!existsSync(dbPath(root))) return none;
  let s: Store | null = null;
  try { s = openReadOnly(root); return fn(s); } catch { return none; } finally { s?.close(); }
}

/** A project's rows of one settings file (key, value) in row order, from the db at the state root. */
export function readRows(project: string, file: SettingsFile, o: ReadOpts = {}): { key: string; value: string }[] {
  return reading(o, [], (s) => rowsOf(s, project, file).map((r) => ({ key: r.key, value: r.value ?? "" })));
}

/** get() for a reader without a Store: the env var, else the project's row at the state root, else the default. */
export function readGet(project: string, file: string, key: string, o: ReadOpts = {}): Got {
  return reading(o, null as Got | null, (s) => get(s, project, file, key, o)) ?? get(null, project, file, key, o);
}

/** A project's effective roster (U267, roster.ts): role -> `agent model spawn [effort] [fallbacks] [plan]`,
 *  the shipped roles.conf rows in order with the project's rows over them, a project-only role after. */
export function readRoster(project: string, o: ReadOpts = {}): Map<string, string> {
  return new Map([...[...shipped("roles.conf", o)].map(([k, r]): [string, string] => [k, r.value]),
    ...readRows(project, "roles.conf", o).map((r): [string, string] => [r.key, r.value])]);
}

/** Every project's roster rows at the state root (project <> ''), as `<role> <value>` lines. */
export function readProjectRosterLines(o: ReadOpts = {}): string[] {
  return reading(o, [], (s) => (s.db.query("SELECT key, value FROM config WHERE project != '' AND file = 'roles.conf' ORDER BY project, rowid").all() as { key: string; value: string | null }[])
    .map((r) => `${r.key} ${r.value ?? ""}`.trim()));
}
