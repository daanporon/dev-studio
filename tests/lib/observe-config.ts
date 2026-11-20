// observe-config.ts — a test's stand-in for the loop's config observer (U257): the readers outside the
// loop (bin/lib/lib.ts roleRow, review-unit's limits and roster, spawn-squad, up, install) read a project's
// settings as `config` rows (bin/loop/settings/settings.ts), never from state/<label>/*.conf. A test that writes
// those files (by hand or through a writer that still writes them) runs this before a reader, so the rows
// hold what the loop would have imported:
//
//   bun tests/lib/observe-config.ts <state root> [<project>=<dir> …]
//
// With no pairs, every folder under the root is a project. Each project settings file that exists replaces
// that project's rows of the file, as the observer does. A file this helper imported before and that is
// gone now drops its rows (the observer's "a removed file drops its rows"); rows of a file it never saw
// (written straight to the database, as the settings module does) are left alone. It records what it
// imported in <root>/.observe-config.json. After the root's settings cut-over (U256, the mark
// .settings-migrated) it does nothing: the observer reads no project file then, and the rows are the only copy.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confRows, PROJECT_FILES } from "../../bin/loop/db/import-config.ts";
import { settingsMigrated } from "../../bin/loop/settings/settings-mark.ts";
import { open } from "../../bin/loop/core/store.ts";

/** Import into <root>'s loop.db the settings files of each project folder: `dirs` maps a project to its
 *  folder (default: every folder under root, named after it). */
export function observeConfig(root: string, dirs?: Map<string, string>): number {
  if (settingsMigrated(root)) return 0;
  const seenPath = join(root, ".observe-config.json");
  let seen: string[] = [];
  try { seen = JSON.parse(readFileSync(seenPath, "utf8")); } catch { /* first run */ }
  dirs ??= new Map((() => { try { return readdirSync(root).filter((n) => !n.startsWith(".") && statSync(join(root, n)).isDirectory()); } catch { return []; } })()
    .map((n): [string, string] => [n, join(root, n)]));
  const now: string[] = [];
  for (const [p, d] of dirs) for (const f of PROJECT_FILES) if (existsSync(join(d, f))) now.push(`${p}/${f}`);
  const gone = seen.filter((k) => !now.includes(k) && dirs.has(k.split("/")[0]));
  if (now.length === 0 && gone.length === 0) return 0;
  const s = open(root);
  let n = 0;
  try {
    s.tx(() => {
      for (const k of [...now, ...gone]) {
        const [p, f] = k.split("/");
        n += s.db.run("DELETE FROM config WHERE project = ? AND file = ?", [p, f]).changes;
        for (const r of confRows(p, f, join(dirs.get(p)!, f))) { s.upsert(r.table, r.key, r.set); n++; }
      }
    });
  } finally { s.close(); }
  writeFileSync(seenPath, JSON.stringify([...seen.filter((k) => !dirs.has(k.split("/")[0])), ...now]));
  return n;
}

if (import.meta.main) {
  const [root, ...pairs] = process.argv.slice(2);
  if (!root) { process.stderr.write("observe-config: usage: observe-config.ts <state root> [<project>=<dir> …]\n"); process.exit(2); }
  observeConfig(root, pairs.length ? new Map(pairs.map((x): [string, string] => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)])) : undefined);
}
