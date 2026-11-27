// side-state.ts — side-loop-host U14 (issue #127, KTD11): a side host's own clock of its link to main, kept in its
// loop.db (`side_link`, migration 0062) so a restarted side loop keeps the time the link went down.
//   noteLink(store, state)  the side process that holds the link calls it on every LinkClient state change
//                           (`onState`): `up` clears the clock; anything else (connecting, down, refused) starts it
//                           at the last time the link was heard up, unless it already runs
//   noteHeard(store, at)    each side tick while this process holds the link up (side.ts): heard_at = when main was
//                           last heard, from the LinkClient's last frame, never the tick's own time
//   linkDown(store)         when the link went down, or null while it is up (or never came up on this host)
// The clock starts at the last time the side heard the link up, not when it noticed the loss, so it never starts
// later than main's own (main's starts at the host's last pong, server.ts): the side fences first. An `up` written
// by a process that is gone (another pid) reads as down since its heard_at: that process died with the link up.
import type { LinkState } from "./client.ts";
import { deadMs } from "./protocol.ts";
import { now as nowS, type Row, type Store } from "../loop/core/store.ts";

const row = (store: Store): Row | null => store.get("side_link", { id: 1 });

/** Record a LinkClient state change. `at` is when it happened (epoch seconds). */
export function noteLink(store: Store, state: LinkState, at = nowS(), pid = process.pid): void {
  if (state === "stopped") return;   // this process is going away; the next one reads the row afresh
  const r = row(store);
  if (state === "up") {
    store.upsert("side_link", { id: 1 }, { state: "up", pid, heard_at: at, down_since: null, fenced_at: null });
    return;
  }
  if (!r) return;                    // never up on this host: nothing to fence
  // heard_at is no later than main's last frame (set from it, at most a tick old), and a silent link is called
  // down no sooner than the silence after that frame: the earlier of the two never starts after main's own clock,
  // which starts at the side's last pong, an answer to that frame.
  const since = downSince(r, pid) ?? Math.min(Number(r.heard_at ?? at), at - Math.ceil(deadMs() / 1000));
  store.upsert("side_link", { id: 1 }, { state: "down", pid, down_since: since });
}

/** While this process holds the link up: the side heard main now. */
export function noteHeard(store: Store, at = nowS(), pid = process.pid): void {
  store.db.run("UPDATE side_link SET heard_at = ? WHERE id = 1 AND state = 'up' AND pid = ?", [at, pid]);
}

function downSince(r: Row, pid: number): number | null {
  if (r.state === "down") return Number(r.down_since ?? r.heard_at) || null;
  return Number(r.pid) === pid ? null : Number(r.heard_at) || null;
}

/** When this host's link to main went down (epoch seconds), or null while it is up or never came up. */
export function linkDown(store: Store, pid = process.pid): number | null {
  const r = row(store);
  return r ? downSince(r, pid) : null;
}

/** When the side fenced itself for the current down clock, or null. */
export function fencedAt(store: Store): number | null {
  const r = row(store);
  return r?.state === "down" && r.fenced_at != null ? Number(r.fenced_at) : null;
}

/** Record that the side fenced itself for down clock `since`. A link back up since then is left as it is; a stale
 *  `up` (its process gone) is written down as what it read as. */
export function noteFenced(store: Store, since: number, at = nowS(), pid = process.pid): void {
  if (linkDown(store, pid) !== since) return;
  store.upsert("side_link", { id: 1 }, { state: "down", down_since: since, fenced_at: at });
}
