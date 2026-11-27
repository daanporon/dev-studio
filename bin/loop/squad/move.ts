// move.ts — side-loop-host U16: "Move to main" on one member of a side host. The board files one `member-move`
// request ({id: the member row}); while it is open the decider asks that member's journal checkpoint once it is idle
// (pause/stop-checkpoint.ts), then hands it to fulfil/member-move.ts: push, close, requeue on main.
import type { Row, Store } from "../core/store.ts";
import { onSide } from "./backend.ts";
import { view } from "./member-state.ts";

/** The open `member-move` request of member row `id`; null when none. */
export function openMove(store: Store, id: number): number | null {
  const r = store.db.query(`SELECT id FROM requests WHERE done_at IS NULL AND kind = 'member-move'
    AND json_extract(payload, '$.id') = ? ORDER BY id LIMIT 1`).get(id) as Row | null;
  return r ? Number(r.id) : null;
}

/** Why member row `m` cannot be moved to main; null = it can. */
export function unmovable(store: Store, m: Row | null): string | null {
  if (!m || String(m.status ?? "") === "gone") return "this member has ended";
  if (!onSide(m.host)) return "this member runs on main already";
  const newest = store.db.query("SELECT MAX(id) AS id FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix = ?")
    .get(String(m.project), String(m.squad), String(m.role), String(m.suffix ?? "")) as Row;
  if (Number(newest.id) !== Number(m.id)) return "a newer member holds this slot";
  if (view(store, m) !== "running") return "this member is not wished running";
  return null;
}
