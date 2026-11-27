// squad/host-reach.ts — side-loop-host U13 (issue #127, KTD11): main's view of a side host's link, from its
// `hosts` row. The link server (bin/link/server.ts) keeps the row: a hello clears `unreachable_since`, a link
// silent for DS_LINK_DEAD_MS (30 s without a pong) or closed sets it to the last time the host was heard, and the
// server's own start sets it on every accepted host to the later of that host's last pong and the start (no link
// is up yet), so main's own downtime does not use up a host's grace.
//   online        accepted, heard at least once, no unreachable clock
//   unreachable   anything else: the link is down (or never came up), the host is pending or removed
// While a host is unreachable its members read `unknown` (core/decide.ts reality()): the decider starts, stops and
// closes nothing there and raises no unknown card, and the liveness pass (reconcilers/liveness.ts) leaves them
// alone, so none is counted dead. Placement (U11) places only on an online host. Once the link is back the side's
// rows flow again and its members read what its walk says, with no action taken in between. Fencing at the
// grace is U15's, read from `since`.
import type { Store } from "../core/store.ts";
import { onSide } from "./backend.ts";

export type HostLink = { state: "online" | "unreachable"; since: number | null };

/** Main's view of host `host`'s link; `local` (main itself) is always online. `since`: when it became unreachable. */
export function hostLink(store: Store, host: string): HostLink {
  if (!onSide(host)) return { state: "online", since: null };
  const r = store.get("hosts", { name: host });
  if (r && r.status === "accepted" && r.last_seen_at != null && r.unreachable_since == null) return { state: "online", since: null };
  const since = r ? Number(r.unreachable_since ?? r.last_seen_at ?? r.accepted_at ?? r.requested_at) || null : null;
  return { state: "unreachable", since };
}

/** Why a login cannot be added on `host` now (side-loop-host U20: `ds account add --host`, the board's Add account),
 *  or null: main (`local`) always can; a side host must be accepted and its link up. */
export function addHostProblem(store: Store, host: string): string | null {
  if (!onSide(host)) return null;
  const r = store.get("hosts", { name: host });
  if (!r || r.status !== "accepted") return `no accepted host '${host}'`;
  return hostLink(store, host).state === "online" ? null : `host ${host} is not online: add it once its link is up`;
}

/** True for a side host whose link is not up: its members read unknown and nothing new goes there. */
export const hostUnreachable = (store: Store, host: unknown): boolean => onSide(host) && hostLink(store, String(host)).state !== "online";
