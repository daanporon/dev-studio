// host-settings.ts — side-loop-host U25 (issue #127, KTD16): the one lookup of a machine key. A limits.conf key whose
// comment starts `[host]` is about a machine, not a project: its value is the env var on the host that reads it, then
// that host's override (`host_config`, migration 0064), then the repo default (the conventions row). A project's own
// row of such a key is never read. Every limit() copy (bin/loop/settings/limits.ts, capacity/pick.ts,
// reconcilers/liveness.ts, bin/lib/lib.ts, bin/lib/operator.ts, bin/board/board-data.ts) routes a host key through
// hostLine, so no copy reads one per project. Every host names itself `local`: on main that is main, and a side host
// gets its own overrides renamed to `local` in the settings copy (bin/link/replica.ts). The writer is
// bin/loop/settings/host-settings.ts. Only bun/node built-ins, so the role-side CLIs can use it.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** How every host names itself (bin/backend/registry.ts LOCAL_HOST). */
export const SELF = "local";
/** The marker a host key's comment starts with in conventions/limits.conf. */
export const HOST_TAG = "[host]";

const CODE_CONF = join(import.meta.dir, "..", "..", "conventions", "limits.conf");

type Parsed = { mtime: number; keys: Set<string>; defaults: Map<string, string> };
const parsed = new Map<string, Parsed>();

function parse(path: string): Parsed {
  let mtime = -1;
  try { mtime = statSync(path).mtimeMs; } catch { /* no file: no host keys */ }
  const hit = parsed.get(path);
  if (hit && hit.mtime === mtime) return hit;
  const keys = new Set<string>(), defaults = new Map<string, string>();
  let text = "";
  try { text = readFileSync(path, "utf8"); } catch { /* none */ }
  for (const raw of text.split("\n")) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const key = raw.trim().split(/\s+/)[0];
    const comment = raw.match(/\s#\s*(.*)$/)?.[1] ?? "";
    if (!comment.startsWith(HOST_TAG)) continue;
    keys.add(key);
    defaults.set(key, raw.replace(/\s+#.*$/, "").trim().slice(key.length).trim());
  }
  const p = { mtime, keys, defaults };
  parsed.set(path, p);
  return p;
}

/** The host keys, in file order (conventions/limits.conf of this checkout unless `conf` names another). */
export function hostKeys(conf = CODE_CONF): string[] { return [...parse(conf).keys]; }
export function isHostKey(key: string, conf = CODE_CONF): boolean { return parse(conf).keys.has(key); }

/** What a reader needs of a database: bun:sqlite's Database or a Store's db. */
type Db = { query(sql: string): { get(...a: (string | number | null)[]): unknown } };

export type HostSource = "env" | "host" | "default";
export interface HostLine { host: string; key: string; value: string | null; source: HostSource | null; env: string }

const row = (db: Db | null, sql: string, ...a: string[]): string | null => {
  if (!db) return null;
  try {
    const v = String((db.query(sql).get(...a) as { value: string | null } | null)?.value ?? "").trim();
    return v || null;
  } catch { return null; }   // a database from before migration 0064, or none
};

/** A host's override of one host key (the stored line), or null. */
export const hostOverride = (db: Db | null, host: string, key: string): string | null =>
  row(db, "SELECT value FROM host_config WHERE host = ? AND key = ?", host, key);

/** The whole line of a host key for `host` and where it came from. The env var counts only for the host reading it
 *  (`SELF`): main cannot see a side host's environment. The default is the conventions row the loop imported (project
 *  ''), else the file. `-` is kept as written: callers treat it as unset as they always did. */
export function hostLine(db: Db | null, host: string, key: string, env = `DS_LIMIT_${key.toUpperCase()}`, conf = CODE_CONF): HostLine {
  const ev = host === SELF ? process.env[env]?.trim() : "";
  if (ev) return { host, key, value: ev, source: "env", env };
  const own = hostOverride(db, host, key);
  if (own) return { host, key, value: own, source: "host", env };
  const d = row(db, "SELECT value FROM config WHERE project = '' AND file = 'limits.conf' AND key = ?", key) ?? (parse(conf).defaults.get(key) || null);
  return { host, key, value: d, source: d === null ? null : "default", env };
}

/** The first word of a host key's value for the reading host (what limit() returns), or null. */
export function hostWord(db: Db | null, key: string, env?: string): string | null {
  return hostLine(db, SELF, key, env).value?.split(/\s+/)[0] || null;
}
