// host-fence.ts — side-loop-host U15 (issue #127, KTD11): main fences a side host it lost and requeues its members.
// Main only (a side loop loads only core/side-plugins.ts). Once a tick (host scope), for each accepted side host:
//   host.fence   {host, since, members}  members are still live there, and either its link has been unreachable
//                                        (squad/host-reach.ts) for host_grace_min plus MAIN_MARGIN_S, counted from
//                                        the last pong or, after a main restart, from the link server's start; or the
//                                        host said on reconnect that it fenced itself (`hosts.fenced_at`, link/server.ts).
//                                        fulfil/host-fence.ts ends each member and wishes its slot again elsewhere
//                                        (squad/host-requeue.ts).
//   host.return  {host, members}         a fenced host is online again with nothing live there: the terminals of the
//                                        members moved off it are closed there first, then `fenced_at` is cleared and
//                                        placement may use it again.
// And once per requeued unit whose old PR (units.retry_pr) still reads open: one Studio card (alerts.ts alertAction).
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { hostLink } from "../squad/host-reach.ts";
import { liveOn } from "../squad/host-requeue.ts";
import { alertAction } from "./alerts.ts";
import { prRow } from "./phases.ts";
import { graceS, MAIN_MARGIN_S } from "./side-fence.ts";

/** When main fences host `h` (epoch seconds), or null while it is not due. */
export function fenceDueAt(store: Store, h: Row): number | null {
  if (h.fenced_at != null) return Number(h.fenced_at);
  const link = hostLink(store, String(h.name));
  if (link.state !== "unreachable" || link.since == null) return null;
  return link.since + graceS(store) + MAIN_MARGIN_S;
}

// Members moved off host `host` whose terminals there are not closed yet.
export const staleOn = (store: Store, host: string): Row[] =>
  store.db.query("SELECT * FROM members WHERE host = ? AND fenced_at IS NOT NULL AND fence_closed_at IS NULL ORDER BY id").all(host) as Row[];

function hostActions(store: Store, now: number): Action[] {
  const out: Action[] = [];
  for (const h of store.db.query("SELECT * FROM hosts WHERE status = 'accepted' ORDER BY name").all() as Row[]) {
    const host = String(h.name), live = liveOn(store, host);
    const due = fenceDueAt(store, h);
    if (live.length && due != null && now >= due) {
      const ids = live.map((m) => Number(m.id));
      out.push({ project: "", subject: `host-fence:${host}`, kind: "host.fence", episode: `${h.fenced_at ?? h.unreachable_since ?? due}:${ids.join(",")}`,
        payload: { host, since: Number(h.fenced_at ?? h.unreachable_since ?? due), members: ids } });
    } else if (!live.length && h.fenced_at != null && hostLink(store, host).state === "online") {
      const ids = staleOn(store, host).map((m) => Number(m.id));
      out.push({ project: "", subject: `host-return:${host}`, kind: "host.return", episode: `${h.fenced_at}:${ids.join(",")}`, payload: { host, members: ids } });
    }
  }
  return out;
}

const prNumber = (v: unknown): number | null => {
  const m = String(v ?? "").match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
};

// One Studio card per requeued unit whose old branch's PR is still open.
function prCards(store: Store): Action[] {
  const out: Action[] = [];
  for (const u of store.db.query("SELECT * FROM units WHERE retry_pr IS NOT NULL AND COALESCE(status, '') NOT IN ('done', 'cancelled')").all() as Row[]) {
    const n = prNumber(u.retry_pr), project = String(u.project), squad = store.get("squads", { project, topic: String(u.squad) });
    if (n == null || !squad) continue;
    const pr = prRow(store, project, squad, String(u.slug), n);
    if (!pr || pr.state !== "OPEN" || pr.gone_at != null) continue;
    const slug = String(u.slug), attempt = Number(u.attempt ?? 2);
    out.push(...alertAction(store, { project, squad: null, key: `host-requeue.${u.squad}.${slug}`, episode: `${slug}#${attempt}`, unit: slug,
      title: `Old PR #${n} of ${slug} is still open`,
      // No retry_host: the operator moved the unit's Builder to main (U16), no host was lost.
      text: (u.retry_host ? `Host ${u.retry_host} was lost, so unit ${slug} of squad ${u.squad} started again on another seat (attempt ${attempt}). `
        : `Unit ${slug} of squad ${u.squad} was moved to main and started again there (attempt ${attempt}). `)
        + `PR #${n} from its old branch ${u.retry_from ?? "(not pushed)"} is still open.`,
      option: "close the old PR, or tell the Lead to have the new Builder take it over",
      why: "a requeued unit's old PR is still open" }));
  }
  return out;
}

export function hostFence(ctx: TickCtx): Action[] {
  if (ctx.role === "side") return [];
  return [...hostActions(ctx.store, ctx.now), ...prCards(ctx.store)];
}

export default { name: "host-fence", scope: "host", run: hostFence } satisfies Reconciler;
