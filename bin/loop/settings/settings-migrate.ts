// settings-migrate.ts — the settings cut-over (U256, KTD4 of the settings-db plan): once per state
// root, every project's override files (state/<label>/{limits,roles,models}.conf, ship-mode) become
// `config` rows written by settings.ts, and the files are renamed `<file>.imported-<UTC date>`, never
// deleted. From then on the rows are the only copy; the config observer reads only conventions/*.conf.
//
// Per project: import each file's rows (importText, actor `migration`, one history row per key), write
// the backup state/<label>/settings.export, then rename the files. The mark (settings-mark.ts) is
// written last. A crash at any step leaves either the file in place, so a rerun imports it again and
// gets the same rows and no second history row, or the rows plus the renamed file. Nothing here runs
// inside another transaction: a rename the database rolled back would lose the value.
//
// Run by the config observer before it reads (so a loop on new code cuts over on its first tick) and
// by bin/loop/db/migrate-host.ts (the install). After the mark it does nothing.
//
// DS_SETTINGS_CRASH=<step> (tests only) dies after the first time that step ran: import, export,
// rename, mark-tmp.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_FILES } from "../db/import-config.ts";
import { discoverProjects } from "./projects.ts";
import { SETTINGS_MARK, settingsMigrated } from "./settings-mark.ts";
import { importText, SettingsError, writeExport } from "./settings.ts";
import { now as clock, open, type Store } from "../core/store.ts";

export const MIGRATION_ACTOR = "migration";

function crash(step: string): void {
  if (process.env.DS_SETTINGS_CRASH === step) { console.error(`settings-migrate: crash injected after ${step}`); process.exit(9); }
}

// `<file>.imported-<YYYY-MM-DD>`, or with `.2`, `.3`… when that name is taken.
function renamedPath(path: string, date: string): string {
  const base = `${path}.imported-${date}`;
  let p = base;
  for (let n = 2; existsSync(p); n++) p = `${base}.${n}`;
  return p;
}

/** Every project to cut over: the loop's projects, and any other folder that holds a settings file (the old
 *  limits.sh wrote state/<label>/limits.conf for a label before its /ds-up, and dsLimit read it). */
function settingsDirs(root: string): string[] {
  const other = (() => { try { return readdirSync(root); } catch { return []; } })()
    .filter((n) => !n.startsWith(".") && PROJECT_FILES.some((f) => existsSync(join(root, n, f))) && statSync(join(root, n)).isDirectory());
  return [...new Set([...discoverProjects(root), ...other.sort()])];
}

export interface Migrated { project: string; file: string; rows: number; renamed: string }

export function migrateSettings(store: Store, root = store.root, at: (step: string) => void = crash, o: { now?: number } = {}): Migrated[] | null {
  if (settingsMigrated(root)) return null;
  const t = o.now ?? clock(), date = new Date(t * 1000).toISOString().slice(0, 10), out: Migrated[] = [];
  for (const project of settingsDirs(root)) {
    const files = PROJECT_FILES.filter((f) => existsSync(join(root, project, f)));
    if (!files.length) continue;
    const texts = files.map((f) => [f, readFileSync(join(root, project, f), "utf8")] as const);
    for (const [f, text] of texts) importText(store, project, f, text, MIGRATION_ACTOR, { record: true, now: t });
    at("import");
    writeExport(store, project);
    at("export");
    for (const [f] of texts) {
      const from = join(root, project, f), to = renamedPath(from, date);
      renameSync(from, to);
      out.push({ project, file: f, rows: (store.db.query("SELECT count(*) AS n FROM config WHERE project = ? AND file = ?").get(project, f) as { n: number }).n, renamed: to });
    }
    at("rename");
  }
  const mark = join(root, SETTINGS_MARK);
  writeFileSync(`${mark}.tmp`, `${new Date(t * 1000).toISOString()}\n${out.map((m) => `${m.project}/${m.file} ${m.rows} rows -> ${m.renamed}`).join("\n")}\n`);
  at("mark-tmp");
  renameSync(`${mark}.tmp`, mark);
  store.event("settings_migrated", { payload: { files: out } });
  return out;
}

// The store a settings command writes through, the root cut over first: a write on a root the loop has
// not ticked on since the upgrade (or a test's fixture root) must not leave its files to disagree.
export function openSettings(root?: string): Store {
  const s = open(root);
  try { migrateSettings(s); } catch (e) { s.close(); throw e; }
  return s;
}

/** One command's change through settings.ts on the state root: what `fn` returns, or null when settings.ts refused
 *  it, after printing `<who>: <why>` on stderr (the limits, roles and ship-mode commands exit 2 then). */
export function changeSettings<T>(who: string, fn: (s: Store) => T): T | null {
  const s = openSettings();
  try { return fn(s); } catch (e) {
    if (!(e instanceof SettingsError)) throw e;
    process.stderr.write(`${who}: ${e.message}\n`);
    return null;
  } finally { s.close(); }
}
