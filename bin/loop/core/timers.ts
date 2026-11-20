// timers.ts — the loop's timers as `timers` rows (Bun). A timer is a key and a due time; nothing is
// held in memory, so a restarted loop has every timer back, and one that came due while the loop
// was down fires on its first tick.
//
//   set(store, "retry:fx/demo", now() + 60, {…})   fire(store) -> the due ones, removed, one event each
import { now, type Store } from "./store.ts";

export type Timer = { key: string; due_at: number; payload: unknown };

function timer(r: { key: string; due_at: number; payload: string | null }): Timer {
  return { key: r.key, due_at: r.due_at, payload: r.payload === null ? null : JSON.parse(r.payload) };
}

// A second set() of the same key moves it.
export function set(store: Store, key: string, dueAt: number, payload: unknown = null): void {
  store.db.run("INSERT INTO timers (key, due_at, payload) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET due_at = excluded.due_at, payload = excluded.payload",
    [key, dueAt, payload == null ? null : JSON.stringify(payload)]);
}

export function clear(store: Store, key: string): void { store.db.run("DELETE FROM timers WHERE key = ?", [key]); }

export function get(store: Store, key: string): Timer | null {
  const r = store.db.query("SELECT * FROM timers WHERE key = ?").get(key) as Parameters<typeof timer>[0] | null;
  return r ? timer(r) : null;
}

export function all(store: Store): Timer[] {
  return (store.db.query("SELECT * FROM timers ORDER BY due_at, key").all() as Parameters<typeof timer>[0][]).map(timer);
}

// Every timer due at `at`, oldest first, taken off the table with a `timer` event each.
export function fire(store: Store, at = now()): Timer[] {
  if (!store.db.query("SELECT 1 FROM timers WHERE due_at <= ? LIMIT 1").get(at)) return [];
  return store.tx(() => {
    const due = (store.db.query("SELECT * FROM timers WHERE due_at <= ? ORDER BY due_at, key").all(at) as Parameters<typeof timer>[0][]).map(timer);
    for (const t of due) {
      store.db.run("DELETE FROM timers WHERE key = ?", [t.key]);
      store.event("timer", { payload: { key: t.key, due_at: t.due_at } });
    }
    return due;
  });
}

/** U252: whether a check repeated every `every` (any unit, as `last` and `now`) is due for `key`: after a share of
 *  `every` fixed per key, between half of it and all of it. Many keys made due on the same tick (every Run read at a
 *  start) then come due again each at its own moment, not all together; none waits longer than `every`.
 *  `every` <= 0 is always due. */
export function spreadDue(key: string, last: number, now: number, every: number): boolean {
  if (every <= 0) return true;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  return now - last >= every * (0.5 + (h % 1024) / 2048);
}
