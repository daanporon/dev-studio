// limits.ts — a project's limits from the `config` rows, as the old shell lib ds_limit reads the files (Bun):
// the env var (ds_limit_env), else the project's limits.conf rows (project <label>), else
// conventions/limits.conf (project ''). The value is the line's first word, as ds_limit's awk takes it.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import type { Store } from "../core/store.ts";
import { ROOT, stateRoot } from "../core/store.ts";

// the old shell lib ds_limit_env: the env var that overrides a limits.conf key.
const ENV_NAMES: Record<string, string> = { context_warn: "DS_RESUME_MAX_CTX", limit_pct: "DS_SWEEP_LIMIT_PCT",
  pick_session_max: "DS_PICK_SESSION_MAX", pick_weekly_max: "DS_PICK_WEEKLY_MAX", unit_token_x: "DS_UNIT_TOKEN_X", unit_token_max: "DS_UNIT_TOKEN_MAX",
  auto_merge: "DS_LOOP_AUTO_MERGE" };
export function limitEnv(key: string): string { return ENV_NAMES[key] ?? `DS_LIMIT_${key.toUpperCase()}`; }

// The whole value of a key (KTD11): same env, project and default order as `limit()`, but not cut at
// the first word. `-` or empty means unset (null).
export function limitLine(store: Store, project: string, key: string): string | null {
  const ev = process.env[limitEnv(key)]?.trim();
  if (ev) return ev === "-" ? null : ev;
  for (const p of project ? [project, ""] : [""]) {
    const r = store.db.query("SELECT value FROM config WHERE project = ? AND file = 'limits.conf' AND key = ?").get(p, key) as { value: string | null } | null;
    const v = (r?.value ?? "").trim();
    if (v) return v === "-" ? null : v;
  }
  return null;
}

export function limit(store: Store, project: string, key: string): string | null {
  const ev = process.env[limitEnv(key)];
  if (ev) return ev;
  for (const p of project ? [project, ""] : [""]) {
    const r = store.db.query("SELECT value FROM config WHERE project = ? AND file = 'limits.conf' AND key = ?").get(p, key) as { value: string | null } | null;
    const v = (r?.value ?? "").trim().split(/\s+/)[0];
    if (v) return v;
  }
  return null;
}

// A whole-number limit; `dflt` when it is unset or not a number (the sweep's `case … *[!0-9]*`).
export function limitInt(store: Store, project: string, key: string, dflt: number): number {
  const v = limit(store, project, key);
  return v !== null && /^\d+$/.test(v) ? Number(v) : dflt;
}

// The auto-compact window (tokens) a start passes the backend,
// auto_compact_<role> for a lead/thinker/builder/studio else auto_compact_other; `-` when unset or not a number.
export function compactWindow(store: Store, project: string, role: string): string {
  const key = ["lead", "thinker", "builder", "studio"].includes(role) ? `auto_compact_${role}` : "auto_compact_other";
  const v = limit(store, project, key);
  return v !== null && /^\d+$/.test(v) ? v : "-";
}

// `cleanup_tmp_globs` (KTD5): comma- or space-separated absolute globs with the wildcard in the last
// path segment only, that segment holding a literal part of 3+ characters, in a parent that is not a
// place the host keeps work. `rejected` carries each refused glob with its reason (for the card).
export interface CleanupGlobs { valid: string[]; rejected: { glob: string; reason: string }[] }
export function cleanupGlobs(store: Store, project: string): CleanupGlobs {
  const out: CleanupGlobs = { valid: [], rejected: [] };
  const line = limitLine(store, project, "cleanup_tmp_globs");
  if (!line) return out;
  const guarded = new Set(["/", posix.normalize(homedir()), posix.normalize(ROOT), posix.normalize(stateRoot()), posix.normalize(store.root),
    posix.normalize(join(homedir(), "orca", "workspaces"))]);
  for (const glob of line.split(/[,\s]+/).filter(Boolean)) {
    const reason = globProblem(glob, guarded, store.root);
    if (reason) out.rejected.push({ glob, reason }); else if (!out.valid.includes(glob)) out.valid.push(glob);
  }
  return out;
}

function globProblem(glob: string, guarded: Set<string>, storeRoot: string): string | null {
  if (!glob.startsWith("/")) return "not an absolute path";
  if (glob.split("/").includes("..")) return "contains ..";
  const norm = posix.normalize(glob), parent = posix.dirname(norm), last = posix.basename(norm);
  if (/[*?\[]/.test(parent)) return "wildcard in a middle segment";
  if (!/[*?\[]/.test(last)) return "no wildcard";
  if (last.replace(/\[[^\]]*\]?/g, "").replace(/[*?]/g, "").length < 3) return "last segment has fewer than 3 literal characters";
  if (guarded.has(parent)) return `parent ${parent} is protected`;
  for (const g of [stateRoot(), ROOT, storeRoot]) { const n = posix.normalize(g); if (parent === n || parent.startsWith(n + "/")) return `under protected ${n}`; }
  if (existsSync(join(parent, ".git"))) return "parent is a repo clone";
  return null;
}
