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

// configurable-role-elevation U1: column 8 of a roles.conf row (`return`, the value's 7th word) says
// whether a member started from that row moves back up to a higher rung once it has room
// (switches.ts fallbackStop): `up`, `stay`, or `-`/omitted to inherit.
export const RETURNS = ["up", "stay"] as const;
export type Return = (typeof RETURNS)[number];

/** A roster value's own `return` word: `up`, `stay`, or "" when it inherits (`-`, omitted, or unknown). */
export function returnOf(value: string | undefined | null): Return | "" {
  const w = String(value ?? "").trim().split(/\s+/)[6] ?? "";
  return (RETURNS as readonly string[]).includes(w) ? (w as Return) : "";
}

/** The base role of a roster row name: `builder-standard` -> `builder`, `thinker` -> `thinker`. */
export const baseRole = (row: string): string => row.split("-")[0];

/** The resolved move-back-up setting of one roster row, and where it came from: `row` (the project's
 *  own row), `default` (the default row of the same name), the base role's name (`builder`) when it
 *  came from that role's row, or null when nothing sets it (`stay`). */
export type BackUp = { back_up: boolean; value: Return; from: "row" | "default" | string | null };

/** The one move-back-up rule (pure): the project row's column 8, else the default row of the same
 *  name, else (for a longer name: `builder-standard`, `thinker-standard-babysit`) the base role row
 *  the same way, else `stay`. An `elevate` row (it never runs a terminal) and `studio` (studio_move
 *  moves it) are always `stay`, whatever they inherit. `own`/`dflt` map a row name to its value. */
export function resolveBackUp(row: string, own: Map<string, string>, dflt: Map<string, string>): BackUp {
  const spawn = String(own.get(row) ?? dflt.get(row) ?? "").trim().split(/\s+/)[2] ?? "";
  if (row === "studio" || spawn === "elevate") return { back_up: false, value: "stay", from: null };
  const at = (name: string, ownFrom: string, dfltFrom: string): BackUp | null => {
    const o = returnOf(own.get(name));
    if (o) return { back_up: o === "up", value: o, from: ownFrom };
    const d = returnOf(dflt.get(name));
    return d ? { back_up: d === "up", value: d, from: dfltFrom } : null;
  };
  const base = baseRole(row);
  return at(row, "row", "default") ?? (base !== row ? at(base, base, base) : null) ?? { back_up: false, value: "stay", from: null };
}

/** The project's own roster rows and the default's, name -> value. */
export function rosterParts(store: Store, project: string): { own: Map<string, string>; dflt: Map<string, string> } {
  const rows = (p: string): Map<string, string> =>
    new Map((store.db.query("SELECT key, value FROM config WHERE project = ? AND file = 'roles.conf' ORDER BY rowid").all(p) as Row[])
      .map((r): [string, string] => [String(r.key), String(r.value ?? "")]));
  return { own: project ? rows(project) : new Map(), dflt: rows("") };
}

/** Does a member started from roster row `row` of `project` move back up? */
export function backUpOf(store: Store, project: string, row: string): boolean {
  const { own, dflt } = rosterParts(store, project);
  return resolveBackUp(row, own, dflt).back_up;
}
