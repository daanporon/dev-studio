// cards.ts — U232: who a Needs-you card is about. One helper builds every alert title as
// `<squad> · <unit or role>: <title>`: the unit's `U<n>` when the card is about a unit, else the
// member's role label (`lead`, `builder-u222`), else just the squad. A card with no squad keeps its
// title. Text names a member as `<role label> in <squad>`, never its `<uuid>::<path>` worktree id.
import type { Row, Store } from "../core/store.ts";

export type Whose = { squad?: string | null; member?: string | null; unit?: string | null };

// `u222-port-read-helpers` -> `U222`; a slug with no number stays as it is.
export function unitLabel(slug: string): string {
  const m = slug.match(/^u(\d+)(?:-|$)/i);
  return m ? `U${m[1]}` : slug;
}

// The member row's role label (`lead`, `builder-u222`), or null when no row has the worktree.
export function memberLabel(store: Store, project: string, wt: string | null | undefined): string | null {
  if (!wt) return null;
  const m = store.db.query("SELECT role, suffix FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(project, wt) as Row | null;
  if (!m?.role) return null;
  return String(m.role) + (m.suffix ? `-${m.suffix}` : "");
}

// `<role label> in <squad>` for a member, else the squad alone, else "an agent".
export function memberIn(store: Store, project: string, wt: string | null | undefined, squad?: string | null): string {
  const label = memberLabel(store, project, wt);
  return label && squad ? `${label} in ${squad}` : label ?? squad ?? "an agent";
}

export function cardTitle(store: Store, project: string, who: Whose, title: string): string {
  const squad = who.squad ?? "";
  if (!squad || !title || title.startsWith(`${squad} · `)) return title;
  const what = who.unit ? unitLabel(who.unit) : memberLabel(store, project, who.member);
  return `${squad} · ${what ? `${what}: ` : ""}${title}`;
}
