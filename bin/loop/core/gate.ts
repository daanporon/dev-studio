// gate.ts — the mtime gate the file observers share (U4). A source (a file, or a set of files) is
// re-read only when its signature moves; while it stands, its rows are only re-confirmed: their
// observed_at moves to the tick, nothing is parsed.
import { statSync } from "node:fs";
import type { FactRow, Row, Store } from "./store.ts";

// mtime and size of a file, or "-" when it is missing.
export function sig(...paths: string[]): string {
  return paths.map((p) => { try { const s = statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } }).join("|");
}

export class Gate {
  private memo = new Map<string, string>();
  // fresh() when key's signature moved (or on first sight), else same(). A fresh() that throws is
  // not remembered, so the next tick reads the source again.
  run(key: string, signature: string, fresh: () => void, same: () => void = () => {}): void {
    if (this.memo.get(key) === signature) { same(); return; }
    fresh();
    this.memo.set(key, signature);
  }
  // Forget the keys under `prefix` not in `keys`: a source that left and comes back is read again.
  keep(keys: string[], prefix = ""): void {
    const live = new Set(keys);
    for (const k of this.memo.keys()) if (k.startsWith(prefix) && !live.has(k)) this.memo.delete(k);
  }
}

const where = (scope: Row) => Object.keys(scope).map((k) => `${k} IS ?`).join(" AND ") || "1";
const args = (scope: Row) => Object.values(scope) as (string | number | null)[];

// A source's rows as they stand now: upsert them stamped observed_at = at, then drop the rows of
// each (table, scope) the source no longer gives. Tables with no scope are only upserted.
export function replace(store: Store, rows: FactRow[], at: number, scopes: [string, Row][]): void {
  const kept = new Map<string, number[]>();
  for (const r of rows) {
    const set = store.columns(r.table).has("observed_at") ? { ...r.set, observed_at: at } : r.set;
    store.upsert(r.table, r.key, set);
    if (scopes.some(([t]) => t === r.table)) {
      const id = store.get(r.table, r.key)?._rowid as number;
      kept.set(r.table, [...(kept.get(r.table) ?? []), id]);
    }
  }
  for (const [t, scope] of scopes) {
    store.db.run(`DELETE FROM ${t} WHERE ${where(scope)} AND rowid NOT IN (SELECT value FROM json_each(?))`, [...args(scope), JSON.stringify(kept.get(t) ?? [])]);
  }
}

// The source did not change: its rows stand as of `at`.
export function confirm(store: Store, at: number, scopes: [string, Row][]): void {
  for (const [t, scope] of scopes) store.db.run(`UPDATE ${t} SET observed_at = ? WHERE ${where(scope)}`, [at, ...args(scope)]);
}
