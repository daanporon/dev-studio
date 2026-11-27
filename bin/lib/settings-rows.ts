// settings-rows.ts — a project's own settings (limits.conf, roles.conf, models.conf, ship-mode) for the
// readers outside the loop (ds_limit, ds_limit_src, ds_ship_mode, the roster), U256.
//
// After the state root's cut-over (the mark `.settings-migrated`, bin/loop/settings/settings-migrate.ts) they are
// the project's `config` rows in loop.db, read read-only; the files state/<label>/<file> are not read.
// Before it — a root the loop has not ticked on the new code, or a test's fixture root — the file is the
// override, as it always was. Only bun/node built-ins.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./shared.ts";
import { hostLine, SELF, type HostLine } from "./host-settings.ts";

export const cutOver = (root = stateRoot()): boolean => existsSync(join(root, ".settings-migrated"));

const dbs = new Map<string, Database>();
function db(root: string): Database | null {
  const hit = dbs.get(root);
  if (hit) return hit;
  const path = join(root, "loop.db");
  if (!existsSync(path)) return null;
  try {
    const d = new Database(path, { readonly: true });
    d.exec("PRAGMA busy_timeout = 5000");
    dbs.set(root, d);
    return d;
  } catch { return null; }
}

/** The project's rows of one file after the cut-over, key → value (the line after the key, no comment). */
function rows(label: string, file: string, root: string): [string, string][] {
  try {
    return (db(root)?.query("SELECT key, value FROM config WHERE project = ? AND file = ? ORDER BY rowid").all(label, file) as { key: string; value: string | null }[] ?? [])
      .map((r) => [r.key, String(r.value ?? "")]);
  } catch { return []; }
}

/** The project's override of one settings file as conf text (`<key> <value>` lines; ship-mode its mode), or
 *  "" when it has none. Before the cut-over: the file's own text. */
export function ownText(label: string, file: string, root = stateRoot()): string {
  if (!cutOver(root)) {
    try { return readFileSync(join(root, label, file), "utf8"); } catch { return ""; }
  }
  return rows(label, file, root).map(([k, v]) => {
    if (file === "ship-mode") return `${v}\n`;
    if (file === "models.conf") { const [a, m] = k.split("|"); return `${a} | ${m} | ${v}\n`; }
    return v ? `${k} ${v}\n` : `${k}\n`;
  }).join("");
}

/** Whether the project overrides anything in that file. */
export const hasOwn = (label: string, file: string, root = stateRoot()): boolean => ownText(label, file, root).trim() !== "";

/** U25: this host's line of a `[host]` key (env, its override in loop.db, the default); never a project's row. */
export const ownHostLine = (key: string, env: string, root = stateRoot()): HostLine => hostLine(db(root), SELF, key, env);
