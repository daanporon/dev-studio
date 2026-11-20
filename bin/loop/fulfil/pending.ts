// fulfil/pending.ts — the actions the actuator left `pending` (a failed send, no free slot), acted again once their next_at comes. The tick's claim lets the same episode
// through only in that state.
import type { Action, Reconciler } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";

export function retireCapacityFacts(store: Store): void {
  // Retire the old capacity-only facts. At-limit flags and usage/reset observations stay intact.
  store.db.run("DELETE FROM episodes WHERE kind IN ('park', 'acctwait')");
  store.db.run("DELETE FROM episodes WHERE kind = 'action:poke' AND json_valid(action) AND json_extract(action, '$.action.payload.reason') = 'acctwait'");
  store.db.run("UPDATE units SET wait_until = NULL WHERE wait_until IS NOT NULL");
  store.db.run("UPDATE members SET status = 'idle' WHERE status = 'waiting'");
  const old = store.db.query("SELECT * FROM episodes WHERE kind LIKE 'action:%' AND state = 'pending' AND action IS NOT NULL AND next_at IS NOT NULL").all() as Row[];
  for (const row of old) {
    // Only the last settlement identifies the clock's cause: a backend retry after a WAIT
    // still owns its backoff. The old rows did not store that cause outside this event.
    const ev = store.db.query(`SELECT payload FROM events WHERE project = ? AND kind = 'action_pending'
      AND json_extract(payload, '$.subject') = ? AND json_extract(payload, '$.kind') = ?
      AND json_extract(payload, '$.episode') = ? ORDER BY id DESC LIMIT 1`)
      .get(row.project, row.subject, String(row.kind).slice(7), row.episode_key) as { payload: string } | null;
    const wait = ev ? JSON.parse(ev.payload).wait : null;
    if (typeof wait !== "string") continue;
    const until = /^WAIT (\d+)\b/m.exec(wait)?.[1];
    const capacity = /^(no account free$|no room until )/.test(wait)
      || (until != null && Number(until) === Number(row.next_at));
    if (!capacity) continue;
    store.db.run("UPDATE episodes SET next_at = NULL WHERE id = ?", [row.id as number]);
  }
}

const pending: Reconciler = {
  name: "pending",
  scope: "host",
  run(ctx) {
    const rows = ctx.store.db.query("SELECT action FROM episodes WHERE kind LIKE 'action:%' AND state = 'pending' AND action IS NOT NULL AND COALESCE(next_at, 0) <= ? ORDER BY id")
      .all(ctx.now) as { action: string }[];
    return rows.map((r) => (JSON.parse(r.action) as { action: Action }).action);
  },
};
export default pending;
