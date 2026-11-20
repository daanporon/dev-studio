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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { limitValueProblem, SHIP_MODES } from "../../lib/operator.ts";
import { confRows, confText } from "../db/import-config.ts";
import { limitEnv } from "./limits.ts";
import { FOCUS_KEY, focusProblem, NO_FOCUS } from "../squad/focus.ts";
import { levelOf, PROJECT_PATTERN, ROLES, shippedRules, skillRuleProblem } from "./skills.ts";
import { dbPath, now as clock, openReadOnly, ROOT, stateRoot, type Store } from "../core/store.ts";

export const SETTINGS_FILES = ["limits.conf", "roles.conf", "models.conf", "ship-mode"] as const;
export type SettingsFile = (typeof SETTINGS_FILES)[number];
// What an export and an import carry: the settings files plus the board's skills.conf rows. skills.conf
// stays out of SETTINGS_FILES: `ds config import` maps every SETTINGS_FILES entry an export lacks to no
// rows, which would wipe the skills rows on restoring a backup made before they were exported.
export const IMPORT_FILES = [...SETTINGS_FILES, "skills.conf"] as const;
export type ImportFile = (typeof IMPORT_FILES)[number];
export type Source = "env" | "project" | "default";

export interface Got { project: string; file: SettingsFile; key: string; value: string | null; source: Source | null; env?: string }
export interface Change { project: string; file: ImportFile; key: string; old: string | null; new: string | null }
export interface HistoryRow { id: number; project: string; file: string; key: string; old_value: string | null; new_value: string | null; actor: string; at: number }
export interface Opts { conventions?: string; now?: number; /** planImport: agent|model pairs the import's own models.conf rows add */ models?: Iterable<string> }

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
function checkImportFile(file: string): ImportFile {
  return (IMPORT_FILES as readonly string[]).includes(file) ? file as ImportFile : fail(`unknown settings file '${file}' (one of: ${IMPORT_FILES.join(" ")})`);
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
  const out = new Set<string>([...shipped("models.conf", o).keys(), ...(o.models ?? [])]);
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

const knownLimit = (key: string, o: Opts): boolean => shipped("limits.conf", o).has(key) || key === "review_delta_full_lines";

// The row value a set stores for one key, after the file's checks; "default" / "-" for ship-mode is
// handled by set() as an rm.
function checked(store: Store, project: string, file: SettingsFile, key: string, value: string, o: Opts): string {
  const v = value.trim();
  if (file === "limits.conf") {
    if (!knownLimit(key, o)) fail(`unknown key '${key}' (see: limits.sh show)`);
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
function write(store: Store, project: string, file: ImportFile, key: string, value: string | null, comment: string | null, actor: string, at: number): Change | null {
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
  const f = checkImportFile(file), at = o.now ?? clock();
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

// What importText would change, without writing: the rows the text lacks go, the rows it has are
// written when their value differs (`ds config import --dry-run`).
export function previewText(store: Store, project: string, file: string, text: string, o: Opts = {}): Change[] {
  checkProject(project);
  const f = checkImportFile(file);
  const want = new Map(confText(project, f, text, o.now ?? clock()).map((r) => [String(r.key.key), String(r.set.value ?? "")]));
  const out: Change[] = [];
  for (const r of rowsOf(store, project, f)) if (!want.has(r.key)) out.push({ project, file: f, key: r.key, old: r.value, new: null });
  for (const [key, value] of want) {
    const old = rowOf(store, project, f, key)?.value ?? null;
    if (old !== value) out.push({ project, file: f, key, old, new: value });
  }
  return out;
}

// The project's rows whose key this dev-studio doesn't know (an older version's `hooks_ts`, a retired role).
export function staleRows(store: Store, project: string, o: Opts = {}): { file: ImportFile; key: string; value: string | null }[] {
  checkProject(project);
  return IMPORT_FILES.flatMap((file) => rowsOf(store, project, file).filter((r) => unknownKey(store, project, file, r.key, o)).map((r) => ({ file, key: r.key, value: r.value })));
}

// Drop those rows: one history row each, then the backup once.
export function prune(store: Store, project: string, actor: string, o: Opts = {}): Change[] {
  const at = o.now ?? clock(), rows = staleRows(store, project, o);
  return done(store, project, store.tx(() => rows.flatMap((r) => one(write(store, project, r.file, r.key, null, null, actor, at)))));
}

// Each file's project rows in conf syntax, as confRows reads them back to the same rows (skills.conf
// too: `<role> <pattern> <level>`); a file with no rows is left out.
export function exportFiles(store: Store, project: string): Partial<Record<ImportFile, string>> {
  checkProject(project);
  const out: Partial<Record<ImportFile, string>> = {};
  for (const f of IMPORT_FILES) {
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
// A transfer file's first line: `#! ds-settings <format> from=<label> rev=<short commit> at=<iso>`.
export const TRANSFER_HEAD = "#! ds-settings";
export const TRANSFER_FORMAT = 1;
export interface Transfer { rev: string; at: number }

// The whole export: a header saying it is not read, then each file's rows under `#== <file>`. With a
// `transfer` (ds config export, the board's Export) it starts with the TRANSFER_HEAD line; the backup
// writeExport keeps rewriting has none.
export function exportText(store: Store, project: string, transfer?: Transfer): string {
  const files = exportFiles(store, project);
  const first = transfer ? `${TRANSFER_HEAD} ${TRANSFER_FORMAT} from=${project} rev=${transfer.rev} at=${new Date(transfer.at * 1000).toISOString()}\n` : "";
  const head = `# settings.export — ${project}'s settings overrides, a backup that nothing reads.\n` +
    `# Change a setting with \`ds config set ${project} <file> <key> <value>\` or on the board, not here.\n`;
  return first + head + IMPORT_FILES.filter((f) => files[f] !== undefined).map((f) => `\n${EXPORT_SECTION}${f}\n${files[f]}`).join("");
}

// exportText with the transfer header: this checkout's short commit (`unknown` outside git) and now.
export function exportTransfer(store: Store, project: string, o: Opts = {}): string {
  const git = spawnSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return exportText(store, project, { rev: (git.status === 0 && git.stdout.trim()) || "unknown", at: o.now ?? clock() });
}

// Split an export back into each file's text (what confRows reads), by its `#== <file>` lines; a
// section of a file this dev-studio doesn't carry is dropped.
export function exportSections(text: string): Partial<Record<ImportFile, string>> {
  const out: Partial<Record<ImportFile, string>> = {};
  let cur: ImportFile | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith(EXPORT_SECTION)) { const f = line.slice(EXPORT_SECTION.length).trim(); cur = (IMPORT_FILES as readonly string[]).includes(f) ? f as ImportFile : null; continue; }
    if (cur && line !== "") out[cur] = (out[cur] ?? "") + line + "\n";
  }
  return out;
}

export interface ParsedExport { header: boolean; from: string | null; rev: string | null; at: string | null; files: Partial<Record<ImportFile, string>> }

// An export's text read for an import: its header's fields (when it has one) and its sections. A text
// that is neither (no header, no `#== <file>` line, not a backup's first line) or whose format is newer
// than TRANSFER_FORMAT is refused, saying why.
export function parseExport(text: string): ParsedExport {
  const lines = text.split("\n"), first = (lines[0] ?? "").trim(), meta: Record<string, string> = {};
  let header = false;
  if (first.startsWith(TRANSFER_HEAD)) {
    const [fmt0 = "", ...kvs] = first.slice(TRANSFER_HEAD.length).trim().split(/\s+/), fmt = Number(fmt0);
    if (!/^[0-9]+$/.test(fmt0) || fmt < 1) fail(`not a settings export: a bad header line '${first.slice(0, 80)}'`);
    if (fmt > TRANSFER_FORMAT) fail(`a settings export of format ${fmt}, newer than this dev-studio reads (${TRANSFER_FORMAT}): update dev-studio first`);
    for (const kv of kvs) { const i = kv.indexOf("="); if (i > 0) meta[kv.slice(0, i)] = kv.slice(i + 1); }
    header = true;
  } else if (!first.startsWith("# settings.export") && !lines.some((l) => l.startsWith(EXPORT_SECTION)))
    fail(`not a settings export: no '${TRANSFER_HEAD}' header and no '${EXPORT_SECTION}<file>' section`);
  return { header, from: meta.from ?? null, rev: meta.rev ?? null, at: meta.at ?? null, files: exportSections(text) };
}

export function writeExport(store: Store, project: string): string {
  const dir = join(store.root, project), path = join(dir, "settings.export");
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${path}.tmp`, exportText(store, project));
  renameSync(`${path}.tmp`, path);
  return path;
}

// ---- copy between projects and hosts: planImport / applyImport ---------------------------------
// An import is a checked copy, not a restore (importText): each source row is planned against the
// target as `set` would store it, and only the picked rows are written.

// Keys that fit one project only: planned as `skip: project-specific`, unpicked, but can be picked.
export const PROJECT_SPECIFIC_LIMITS = ["auto_merge", "expected_checks", "focus_squad", "review_risk_paths", "cleanup_tmp_globs", "cleanup_on_close", "disk_watch_paths"] as const;
// limits.conf keys the board never writes (a command the loop runs, absolute paths it clears; board-data's
// FILE_ONLY_LIMITS): a board plan skips them as `shell only`, and only the shell imports them.
export const SHELL_ONLY_LIMITS = ["cleanup_tmp_globs", "cleanup_on_close", "disk_watch_paths"] as const;
export function projectSpecific(file: string, key: string): boolean {
  return file === "ship-mode" || (file === "limits.conf" && (PROJECT_SPECIFIC_LIMITS as readonly string[]).includes(key));
}
const shellOnly = (file: string, key: string): boolean => file === "limits.conf" && (SHELL_ONLY_LIMITS as readonly string[]).includes(key);

/** Another project's rows on this host, or an export's text (`name` labels it in the history's actor). */
export type ImportSource = { project: string } | { text: string; name?: string };
export type ImportAction = "add" | "change" | "same" | "remove" | "skip";
export interface PlanRow {
  file: ImportFile; key: string;
  /** what the target would hold: the row value after set's checks, null for a remove */
  value: string | null;
  /** the target's row now (null: no row) — a pick's `expect` */
  current: string | null;
  action: ImportAction;
  /** a skip's reason: project-specific | shell only | unknown key | refused: <message> */
  why?: string;
  pick: boolean; can_pick: boolean;
  warn?: string;
}
export interface PlanOpts extends Opts { replace?: boolean; board?: boolean }
export interface ImportPick { file: string; key: string; expect?: string | null }
export interface ApplyResult { written: Change[]; skipped: { file: string; key: string; why: string }[]; stale: { file: string; key: string; expect: string | null; current: string | null }[] }

export function importActor(src: ImportSource): string {
  return `import:${"project" in src ? src.project : src.name || "file"}`;
}

type SrcRow = { key: string; value: string; comment: string | null };

// The source's rows per file, and the files whose every row it carries (a target row they lack is a
// remove under `replace`): all of them for a project; for an export its settings files, and skills.conf
// only when it has that section or the transfer header (an old backup never exported skills).
function sourceRows(store: Store, target: string, src: ImportSource): { files: Map<ImportFile, SrcRow[]>; full: Set<ImportFile> } {
  const files = new Map<ImportFile, SrcRow[]>();
  if ("project" in src) {
    checkProject(src.project);
    if (src.project === target) fail(`'${target}' can't import from itself`);
    let n = 0;
    for (const f of IMPORT_FILES) { const rows = rowsOf(store, src.project, f).map((r) => ({ key: r.key, value: r.value ?? "", comment: r.comment })); n += rows.length; files.set(f, rows); }
    if (!n && !existsSync(join(store.root, src.project))) fail(`no project '${src.project}' on this host`);
    return { files, full: new Set(IMPORT_FILES) };
  }
  const parsed = parseExport(src.text);
  for (const f of IMPORT_FILES) files.set(f, confText(target, f, parsed.files[f] ?? "", 0).map((r) => ({ key: String(r.key.key), value: String(r.set.value ?? ""), comment: (r.set.comment as string | null) ?? null })));
  const full = new Set<ImportFile>(SETTINGS_FILES);
  if (parsed.header || parsed.files["skills.conf"] !== undefined) full.add("skills.conf");
  return { files, full };
}

// The value the target would store for one source row, after the checks `set` (or the Skills tab) runs.
function targetValue(store: Store, target: string, file: ImportFile, key: string, raw: string, o: PlanOpts): string {
  if (shellOnly(file, key)) return raw.trim();   // as the restore writes it: set refuses its spaces
  if (file !== "skills.conf") return checked(store, target, file, key, raw, o);
  const [role, name] = key.split(" "), level = raw.trim();
  const problem = skillRuleProblem(role, name, level, shippedRules(join(conv(o), "skills.conf")), name === PROJECT_PATTERN);
  return problem ? fail(problem) : level;
}

// The row a key with no target row already runs: a role's default roster row (as set() treats it), a
// skills rule's shipped level. Other files have no such row: a pin of the default value is still a pin.
function runsAlready(file: ImportFile, key: string, value: string, o: Opts): boolean {
  if (file === "roles.conf") return words(value) === words(shipped("roles.conf", o).get(key)?.value ?? "");
  if (file !== "skills.conf") return false;
  const [role, name] = key.split(" ");
  return value === (levelOf(name, role, shippedRules(join(conv(o), "skills.conf")), [], name === PROJECT_PATTERN) ?? "on");
}

function unknownKey(store: Store, target: string, file: ImportFile, key: string, o: Opts): boolean {
  if (file === "limits.conf") return !knownLimit(key, o);
  if (file === "roles.conf") return !shipped("roles.conf", o).has(key) && !rowOf(store, target, file, key);
  if (file === "ship-mode") return key !== "mode";
  if (file === "skills.conf") { const f = key.split(" "); return f.length !== 2 || !f[1] || !(ROLES as readonly string[]).includes(f[0]); }
  return false;
}

// A roster value's account plans (its own, each fallback's) that no account of that agent reports.
function planWarn(store: Store, value: string): string | undefined {
  const f = value.split(/\s+/), want: [string, string][] = [];
  if (f[5] && f[5] !== "-") want.push([f[0], f[5]]);
  for (const fb of (f[4] ?? "").split(",")) { const [a, , , p] = fb.split(":"); if (a && p && p !== "-") want.push([a, p]); }
  const missing = want.filter(([a, p]) => !store.db.query("SELECT 1 FROM observed_accounts WHERE agent = ? AND plan = ?").get(a, p)).map(([a, p]) => `${a}:${p}`);
  return missing.length ? `no account on this host reports plan ${[...new Set(missing)].join(", ")}` : undefined;
}

type Planned = { row: PlanRow; raw: string | null; comment: string | null };

function planned(store: Store, target: string, src: ImportSource, o: PlanOpts): Planned[] {
  checkProject(target);
  const { files, full } = sourceRows(store, target, src);
  // A roster row may name a model the import's own models.conf rows bring.
  const models = (files.get("models.conf") ?? []).map((r) => r.key);
  const po: PlanOpts = { ...o, models: [...(o.models ?? []), ...models] };
  const out: Planned[] = [];
  for (const file of IMPORT_FILES) {
    const rows = files.get(file) ?? [], seen = new Set(rows.map((r) => r.key));
    for (const r of rows) out.push({ row: planOne(store, target, file, r.key, r.value, po), raw: r.value, comment: r.comment });
    if (!o.replace || !full.has(file)) continue;
    for (const t of rowsOf(store, target, file)) {
      if (seen.has(t.key)) continue;
      const base = { file, key: t.key, value: null, current: t.value };
      const row: PlanRow = o.board && shellOnly(file, t.key) ? { ...base, action: "skip", why: "shell only", pick: false, can_pick: false }
        : projectSpecific(file, t.key) ? { ...base, action: "skip", why: "project-specific", pick: false, can_pick: true }
        : { ...base, action: "remove", pick: true, can_pick: true };
      out.push({ row, raw: null, comment: null });
    }
  }
  return out;
}

function planOne(store: Store, target: string, file: ImportFile, key: string, raw: string, o: PlanOpts): PlanRow {
  const current = rowOf(store, target, file, key)?.value ?? null;
  const skip = (why: string, value: string | null = null, can = false): PlanRow => ({ file, key, value, current, action: "skip", why, pick: false, can_pick: can });
  if (unknownKey(store, target, file, key, o)) return skip("unknown key");
  if (o.board && shellOnly(file, key)) return skip("shell only", raw.trim());
  let value: string;
  try { value = targetValue(store, target, file, key, raw, o); } catch (e) {
    if (e instanceof SettingsError) return skip(`refused: ${e.message}`);
    throw e;
  }
  if (value === current || (current === null && runsAlready(file, key, value, o))) return { file, key, value, current, action: "same", pick: false, can_pick: false };
  if (projectSpecific(file, key)) return skip("project-specific", value, true);
  const warn = file === "roles.conf" ? planWarn(store, value) : undefined;
  return { file, key, value, current, action: current === null ? "add" : "change", pick: true, can_pick: true, ...(warn ? { warn } : {}) };
}

// One row per (file, key) of the source, then (with `replace`) each target row the source lacks; see
// PlanRow. `board` marks the shell-only keys `skip: shell only`. Reads only.
export function planImport(store: Store, target: string, src: ImportSource, o: PlanOpts = {}): PlanRow[] {
  return planned(store, target, src, o).map((p) => p.row);
}

// Plan again and write each pick the plan still allows, through the same checks, in one transaction:
// one config_history row per change by `actor`, then the backup once. A pick the plan doesn't allow is
// `skipped` with its why; one whose `expect` is not the target's row now is `stale` and not written.
// models.conf goes before roles.conf, so a roster row may name a model the same import adds.
export function applyImport(store: Store, target: string, src: ImportSource, picks: ImportPick[], actor: string, o: PlanOpts = {}): ApplyResult {
  const plan = new Map(planned(store, target, src, o).map((p) => [`${p.row.file}\0${p.row.key}`, p]));
  const order: string[] = ["limits.conf", "models.conf", "roles.conf", "ship-mode", "skills.conf"];
  const res: ApplyResult = { written: [], skipped: [], stale: [] }, at = o.now ?? clock();
  const sorted = [...picks].sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));
  store.tx(() => {
    for (const p of sorted) {
      const pl = plan.get(`${p.file}\0${p.key}`);
      if (!pl) { res.skipped.push({ file: p.file, key: p.key, why: "not in the import" }); continue; }
      const r = pl.row;
      if (!r.can_pick) { res.skipped.push({ file: r.file, key: r.key, why: r.why ?? r.action }); continue; }
      if (p.expect !== undefined && (p.expect ?? null) !== r.current) { res.stale.push({ file: r.file, key: r.key, expect: p.expect ?? null, current: r.current }); continue; }
      let value = r.value;
      if (pl.raw !== null) {
        // Again, without the plan's borrowed models: a roster row whose model was left out is refused.
        try { value = targetValue(store, target, r.file, r.key, pl.raw, { ...o, models: undefined }); } catch (e) {
          if (!(e instanceof SettingsError)) throw e;
          res.skipped.push({ file: r.file, key: r.key, why: `refused: ${e.message}` });
          continue;
        }
      }
      const c = write(store, target, r.file, r.key, value, value === null ? null : pl.comment, actor, at);
      if (c) res.written.push(c);
    }
  });
  if (res.written.length) writeExport(store, target);
  return res;
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
