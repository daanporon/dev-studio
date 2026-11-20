// events.ts — the append-only event log (Bun). Rows are only ever added; a reader keeps the last id
// it saw and asks for what came after it (the board's SSE stream, `ds events --since`).
import type { Row, Store } from "./store.ts";

// The id a new reader starts from: everything up to now counts as seen.
export function cursor(store: Store): number {
  return (store.db.query("SELECT COALESCE(MAX(id), 0) AS id FROM events").get() as { id: number }).id;
}

export function since(store: Store, after: number, f: { project?: string; squad?: string; kinds?: string[]; limit?: number } = {}): Row[] {
  const kinds = f.kinds?.length ? f.kinds : null;
  return store.db.query(`SELECT * FROM events WHERE id > ?1 AND (?2 IS NULL OR project = ?2) AND (?3 IS NULL OR squad = ?3)
    AND (?4 IS NULL OR kind IN (SELECT value FROM json_each(?4))) ORDER BY id LIMIT ?5`)
    .all(after, f.project ?? null, f.squad ?? null, kinds ? JSON.stringify(kinds) : null, f.limit ?? -1) as Row[];
}
