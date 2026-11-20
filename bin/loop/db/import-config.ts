// import-config.ts — the shipped config files into `config` rows (Bun); the config observer
// (observers/config.ts) re-reads them every tick and the importer gives the first copy.
//
//   conventions/{roles,limits,models,projects,skills}.conf   project ''   code, shipped in git (KTD1)
//   state/<label>/{roles,limits,models}.conf, ship-mode      project <label>, only until the root's
//       settings cut-over (U256, settings-migrate.ts): after it a project's settings are rows written by
//       bin/loop/settings/settings.ts alone, and these files are not read (one reappearing raises an alert).
// One row per line: key = the first field (models.conf: `<agent>|<model>`; ship-mode: `mode`),
// value = the rest of the line without a trailing `# comment`; the comment goes in `comment`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FactRow, Store } from "../core/store.ts";
import { ROOT } from "../core/store.ts";
import { discoverProjects } from "../settings/projects.ts";
import { mtime } from "./import-json.ts";
import { settingsMigrated } from "../settings/settings-mark.ts";

export const CONF_FILES = ["roles.conf", "limits.conf", "models.conf", "projects.conf", "skills.conf"];
export const PROJECT_FILES = ["roles.conf", "limits.conf", "models.conf", "ship-mode"];

export function confRows(project: string, file: string, path: string): FactRow[] {
  if (!existsSync(path)) return [];
  return confText(project, file, readFileSync(path, "utf8"), mtime(path));
}

// The rows of one conf file's text, observed at `at`.
export function confText(project: string, file: string, text: string, at: number): FactRow[] {
  const rows: FactRow[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim(), comment = raw.match(/\s+#\s*(.*?)\s*$/)?.[1] || null;
    if (!line || line.startsWith("#")) continue;
    let key: string, value: string;
    if (file === "ship-mode") { key = "mode"; value = line; }
    else if (file === "models.conf") {
      const f = line.split("|").map((s) => s.trim());
      key = `${f[0]}|${f[1] ?? ""}`; value = f.slice(2).join(" | ");
    } else if (file === "skills.conf") {   // `<role> <pattern> <level> [required]`: key = role + pattern
      const f = line.split(/\s+/);
      if (f.length < 3) continue;
      key = `${f[0]} ${f[1]}`; value = f.slice(2).join(" ");
    } else {
      const m = line.match(/^(\S+)\s*(.*)$/)!;
      key = m[1]; value = m[2];
    }
    rows.push({ table: "config", key: { project, file, key }, set: { value, comment, observed_at: at } });
    if (file === "ship-mode") break; // first line only, as ds_ship_mode reads it
  }
  return rows;
}

// The shipped rows, and a project's file rows only while the root is not cut over yet.
export function configRows(root: string, conventions = join(ROOT, "conventions")): FactRow[] {
  const rows = CONF_FILES.flatMap((f) => confRows("", f, join(conventions, f)));
  if (!settingsMigrated(root)) for (const p of discoverProjects(root)) rows.push(...PROJECT_FILES.flatMap((f) => confRows(p, f, join(root, p, f))));
  return rows;
}

export function importConfig(store: Store, root = store.root, conventions?: string): number {
  const cut = settingsMigrated(root);
  return store.tx(() => {
    let n = 0;
    const rows = configRows(root, conventions);
    for (const r of rows) n += store.upsert(r.table, r.key, r.set) ? 1 : 0;
    // A line removed from its file drops its row; the file is the truth. Rows of other files (the
    // GitHub observer's `github` rows) are not this importer's.
    const keep = JSON.stringify(rows.map((r) => [r.key.project, r.key.file, r.key.key].join("\u001f")));
    // A project's rows are written to the database only — the board's skills.conf edits always, its
    // settings after the cut-over — so only the shipped ones (project '') are this importer's to drop.
    const files = JSON.stringify(cut ? CONF_FILES : [...CONF_FILES, ...PROJECT_FILES]);
    n += store.db.run("DELETE FROM config WHERE file IN (SELECT value FROM json_each(?)) AND NOT (file = 'skills.conf' AND project != '') AND (? = 0 OR project = '') AND (project || char(31) || file || char(31) || key) NOT IN (SELECT value FROM json_each(?))", [files, cut ? 1 : 0, keep]).changes;
    return n;
  });
}
