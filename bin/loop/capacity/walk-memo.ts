// walk-memo.ts — the facts one picks walk reads over and over, read once (loop-tick-8s U3).
//
// The picks walk (picks.ts reconcile) calls pick() for every member the decider would start, and each pick()
// asks slot(), which walks every live Builder of the project again: its lock, pause and presence, the
// reservations, the limits rows, the units and their lanes. None of that changes inside the walk: the walk
// writes only its temp `picks` copy (and at most one `unit_lane_moved` event per unit, which laneOf checks
// for itself). So `withWalkMemo(store, now, fn)` opens a scope for `fn` in which `memo()` keeps each fact the
// first time it is read; the scope ends with `fn`, and the next walk reads everything again.
//
// What a pick of this same walk changes stays live: a member holding a start slot (picks.slot = 1, read by
// liveWhy between its memoized halves) and the load on each account (pick.ts loads()). Outside a scope (the
// board, `ds pick`, fulfil/member.ts, ready.ts) memo() just calls its reader, so they read as before.
//
// `withDecideMemo` is the wider scope over a whole decide (decide.ts), whose look() asks pick() of every member
// again for its switches. look() writes member and episode rows, so this scope keeps only the facts no decide
// writes (STABLE: the limits rows, the host's machine sample and each worktree's parsed transcript tail,
// liveness.ts openCalls); a walk scope inside it keeps the rest.
// A scope belongs to one store and one `now`: a read for another store or time is not kept.
// DS_PICK_MEMO=0 turns both off (everything is read each time; the tests compare the two).
import type { Store } from "../core/store.ts";

type Scope = { store: Store; now: number; only: Set<string> | null; maps: Map<string, Map<string, unknown>> };
const scopes: Scope[] = [];
const STABLE = new Set(["limit", "whole-limit", "machine", "open-calls"]);

function within<T>(store: Store, now: number, only: Set<string> | null, fn: () => T): T {
  if (process.env.DS_PICK_MEMO === "0") return fn();
  scopes.push({ store, now, only, maps: new Map() });
  try { return fn(); } finally { scopes.pop(); }
}
export const withWalkMemo = <T>(store: Store, now: number, fn: () => T): T => within(store, now, null, fn);
export const withDecideMemo = <T>(store: Store, now: number, fn: () => T): T => within(store, now, STABLE, fn);

// The fact `kind`/`key`, read by `read` once in the outermost scope that keeps it (the decide's, for a STABLE
// fact a walk inside it asks again). `now`: the time the fact
// depends on (null: none); a scope of another time does not keep it. The value is shared: callers never change it.
export function memo<T>(store: Store, now: number | null, kind: string, key: string, read: () => T): T {
  let s: Scope | undefined;
  for (let i = 0; i < scopes.length && !s; i++) {
    const c = scopes[i];
    if (c.store === store && (now === null || now === c.now) && (!c.only || c.only.has(kind))) s = c;
  }
  if (!s) return read();
  let m = s.maps.get(kind);
  if (!m) s.maps.set(kind, (m = new Map()));
  if (m.has(key)) return m.get(key) as T;
  const v = read();
  m.set(key, v);
  return v;
}
