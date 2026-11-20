// roster.ts — the one roster rule (U267): a project's roles.conf row overrides its own role, and
// the default roster (conventions/roles.conf, config rows of project '') fills every role the
// project lacks. Order: the default's rows in their order, a project row in its default's place, a
// project-only role after them.
import type { Store } from "../core/store.ts";

type Row = { key: string; value: string | null };

/** Role name -> roster value (`agent model spawn [effort] [fallbacks] [plan]`) for one project. */
export function effectiveRoster(store: Store, project: string): Map<string, string> {
  const rows = (p: string): [string, string][] =>
    (store.db.query("SELECT key, value FROM config WHERE project = ? AND file = 'roles.conf' ORDER BY rowid").all(p) as Row[])
      .map((r) => [String(r.key), String(r.value ?? "")]);
  // A later key keeps the earlier one's position: `new Map([...default, ...project])`.
  return new Map([...rows(""), ...(project ? rows(project) : [])]);
}
