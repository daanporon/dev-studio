// place.ts — side-loop-host U11 (issue #127, KTD10, KTD16): which host a worker start runs on. Main first; a side
// host is tried only when main says no, and only for a start the loop places (the picks reconciler passes
// `place`, pick.ts): a shell start (`ds pick`, add-role.sh, restart-role.sh) runs on main and waits there as before.
//
//   Builder               goes to a side host when main answers WAIT for a slot (max_builders) or main's brake
//   Tester, Researcher    goes to a side host when main's own sample crosses a machine_*_crit line
//   Lead, Thinker, Studio never placed: always main
//
// A side host is a candidate (`refusal` null) only when it is accepted and online (squad/host-reach.ts), not draining,
// not fenced, on main's link version and newest up-table migration (KTD15: otherwise "behind"), has a free seat under
// its own `seats` (a host key, U25: its override, else the repo default), its own machine row (observed_machine,
// host = its name, uploaded through the rows channel) is fresh, and that row crosses no crit line read with the
// host's own lines. The crit check is the brake: a Builder is held by it only while the host's `builder_host_brake`
// is on (a side host's default is `on`, KTD16); a Tester or Researcher, moved because main is critical, never goes
// to a host that is critical too. Whether the host has the project cloned does not matter: the start clones it
// through a host job (U10). Candidates are tried in name order.
//
// A seat is any worker of any project on that host that is wished running or runs (the latest member row per
// slot, not gone, in a live squad), plus each start this pick walk already placed there (the walk's temp `picks`
// rows, picks.host) that its member row does not show yet. The member asking is never counted against itself.
//
// Moving: only a member with no worktree yet may be placed. One whose row names a side host stays there (pinned)
// unless that host came from the loop's own earlier pick (picks.host = members.host): `ds request --host` (U10)
// deletes the picks row, so an operator's or a test's host is never moved. A pinned side member is outside main's
// max_builders (slot.ts) and is braked by its own host (pick.ts hostBrake).
import type { Row, Store } from "../core/store.ts";
import { hostLine } from "../../lib/host-settings.ts";
import { SIDE_DEFAULTS } from "../settings/host-settings.ts";
import { hostLink } from "../squad/host-reach.ts";
import { hostOf, onSide } from "../squad/backend.ts";
import { LINK_VERSION } from "../../link/protocol.ts";
import { UP_MIGRATION } from "../../link/replica.ts";
import { hostCrit, sampleState, type Line } from "./machine-level.ts";

/** The roles a start may be placed off main for (KTD10). */
export const PLACED_ROLES = ["builder", "tester", "researcher"] as const;
export const placedRole = (role: unknown): boolean => (PLACED_ROLES as readonly string[]).includes(String(role));

/** A host key's value for side host `host`: its override, else the repo default (main never sees a side host's env). */
export const sideValue = (store: Store, host: string, key: string): string | null => {
  const l = hostLine(store.db, host, key);
  return l.source === "default" && SIDE_DEFAULTS[key] ? SIDE_DEFAULTS[key] : l.value?.split(/\s+/)[0] ?? null;
};
/** A side host's own crit lines, read as whole numbers (machine-level.ts Line). */
export const sideLine = (store: Store, host: string): Line => (k) => {
  const v = sideValue(store, host, k);
  return v !== null && /^[0-9]+$/.test(v) ? Number(v) : null;
};

/** The side host's `seats` (U25): a whole number, else 0 (no seat). */
export function hostSeats(store: Store, host: string): number {
  const v = sideValue(store, host, "seats");
  return v !== null && /^\d+$/.test(v) ? Number(v) : 0;
}

/** Its latest machine sample, the one its own brake reads. */
export const hostSample = (store: Store, host: string): Row | null =>
  store.db.query("SELECT * FROM observed_machine WHERE host = ? ORDER BY observed_at DESC LIMIT 1").get(host) as Row | null;

/** The crit line the host's own fresh sample crosses (`<metric> <value> ≥ crit <line>`) while its brake is on; null = go. */
export function sideBrake(store: Store, host: string, now: number): string | null {
  if (sideValue(store, host, "builder_host_brake") !== "on") return null;
  return hostCrit(hostSample(store, host), sideLine(store, host), now);
}

/** The seats in use on `host`: its workers wished running or running, plus this walk's placements there. */
export function seatsUsed(store: Store, host: string, exclude: number | null = null): number {
  const members = store.db.query(`SELECT id FROM members WHERE host = ?1 AND role IN ('builder', 'tester', 'researcher')
      AND id IN (SELECT MAX(id) FROM members WHERE host = ?1 GROUP BY project, squad, role, suffix)
      AND COALESCE(status, '') != 'gone' AND COALESCE(want, '') != 'gone' AND (want = 'running' OR status = 'running')
      AND EXISTS (SELECT 1 FROM squads q WHERE q.project = members.project AND q.topic = members.squad
        AND COALESCE(q.status, 'running') NOT IN ('suspended', 'on-hold', 'done', 'failed', 'closed', 'gone'))`)
    .all(host) as { id: number }[];
  const ids = new Set(members.map((r) => Number(r.id)));
  // Starts this walk placed there whose member row does not name the host yet (picks.ts writes it after the walk).
  for (const r of store.db.query(`SELECT p.member FROM picks p JOIN members m ON m.id = p.member
      WHERE p.slot = 1 AND p.host = ? AND COALESCE(m.host, 'local') != p.host`).all(host) as { member: number }[]) ids.add(Number(r.member));
  if (exclude !== null) ids.delete(exclude);
  return ids.size;
}

/** Why side host `host` takes no new start of `role` now; null = it is a candidate. */
export function refusal(store: Store, host: string, role: string, now: number, exclude: number | null = null): string | null {
  const h = store.get("hosts", { name: host });
  if (!h || h.status !== "accepted") return "not accepted";
  if (hostLink(store, host).state !== "online") return "unreachable";
  if (Number(h.drain ?? 0)) return "draining";
  if (h.fenced_at != null) return "fenced";
  if (String(h.link_version ?? "") !== LINK_VERSION || String(h.up_migration ?? "") !== UP_MIGRATION) return "behind";
  const seats = hostSeats(store, host), used = seatsUsed(store, host, exclude);
  if (used >= seats) return `full ${used}/${seats}`;
  const r = hostSample(store, host), s = sampleState(r, now);
  if (s.state !== "fresh") return `machine sample ${s.state}`;
  const crit = role === "builder" ? sideBrake(store, host, now) : hostCrit(r, sideLine(store, host), now);
  return crit ? `brake: ${crit}` : null;
}

export type Placement = { host: string; skipped: string[] } | { host: null; skipped: string[] };

/** The first side host, in name order, that takes this start; `skipped` names each one passed over and why. */
export function placeSide(store: Store, role: string, now: number, member: number | null = null): Placement {
  const skipped: string[] = [];
  for (const { name } of store.db.query("SELECT name FROM hosts WHERE status = 'accepted' ORDER BY name").all() as { name: string }[]) {
    if (!onSide(name)) continue;
    const why = refusal(store, name, role, now, member);
    if (!why) return { host: name, skipped };
    skipped.push(`${name} ${why}`);
  }
  return { host: null, skipped };
}

/** The host the loop placed this member on in its last pick, when its row still names that host (see Moving). */
const loopPlaced = (store: Store, m: Row): boolean => {
  const p = store.get("picks", { member: m.id });
  return !!p && onSide(p.host) && String(p.host) === String(m.host);
};

/** May this member's start be placed (on main or a side host)? A worker with no worktree yet that no forced host pins. */
export function movable(store: Store, m: Row | null, role: string): boolean {
  if (!placedRole(m?.role ?? role)) return false;
  if (!m) return true;
  if (m.wt) return false;
  return !onSide(m.host) || loopPlaced(store, m);
}

/** The side host this member must start on whatever main says (a forced host, or a worktree there); null = main rules. */
export function pinnedSide(store: Store, m: Row | null): string | null {
  if (!m || !onSide(m.host)) return null;
  return !m.wt && loopPlaced(store, m) ? null : hostOf(m);
}
