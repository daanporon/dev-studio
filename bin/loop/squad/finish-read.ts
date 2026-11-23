// squad/finish-read.ts — a member's finish row (U3's `finishes`, written by `ds finish`) as the loop
// reads it: only a row of the member's current generation (`members.gen`, U4) counts. The shadow
// (squad/shadow.ts, U10) compares it with the Orca signals; for a squad off Orca (U12) it is the
// signal: a one-shot with one is stopped (member-state.ts view), a Builder's failed or no-PR one is
// the Lead's request (liveness.ts idleBuilder), a Tester's verdict one retires it (members.ts).
// Kept free of the decision modules so each of them can import it.
import type { Row, Store } from "../core/store.ts";

/** The member's DS_MEMBER name, `<project>/<squad>/<role[-suffix]>`. */
export const nameOf = (m: Row): string => {
  const suffix = String(m.suffix ?? "");
  return `${m.project}/${m.squad}/${m.role}${suffix ? `-${suffix}` : ""}`;
};

/** The finish row of this member's current generation (the newest one), or null. */
export function finishOf(store: Store, m: Row): Row | null {
  if (!m.gen) return null;
  return store.db.query("SELECT * FROM finishes WHERE project = ? AND member = ? AND gen = ? ORDER BY id DESC LIMIT 1")
    .get(String(m.project), nameOf(m), String(m.gen)) as Row | null;
}
