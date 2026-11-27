// side-fence.ts — side-loop-host U14 (issue #127, KTD11): a side host fences itself when its link to main has been
// down for the grace. Side only (core/side-plugins.ts SIDE_ONLY: a main loop never loads it). Once a tick (host scope):
//   - while this process holds the link up, it moves the clock's heard_at on (bin/link/side-state.ts noteHeard);
//   - when the link has been down since `down_since` for host_grace_min (default 15) minutes and the side has not
//     fenced for that clock yet: one `side.fence` action, episode = down_since. The side actuator pushes each Builder
//     branch that is ahead of its remote (never forced, each push capped at DS_SIDE_FENCE_PUSH_MS), then closes the
//     terminals of every member of this host, records fenced_at and writes `side_fenced`.
// It asks for no checkpoint: a journal write is a forwarded call, and main cannot be reached. Main fences the host
// at the grace plus 60 s counted from its own clock (the host's last pong), which never starts before this one
// (side-state.ts), so the push and close end before main requeues the units (U15). The clock lives in loop.db, so a
// restarted side loop keeps the original down_since.
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import type { Store } from "../core/store.ts";
import { limitInt } from "../settings/limits.ts";
import { fencedAt, linkDown, noteHeard } from "../../link/side-state.ts";

export const KIND = "side.fence";
export const GRACE_MIN = 15;
/** Main's extra wait past the grace (KTD11): the side's push and close must end inside it. */
export const MAIN_MARGIN_S = 60;

/** The grace in seconds: host_grace_min, read the same way on main and on the side (env, then the default row). */
export const graceS = (store: Store): number => Math.max(0, limitInt(store, "", "host_grace_min", GRACE_MIN)) * 60;

/** The down clock the side must fence for now, or null (link up, grace not over, or already fenced for it). */
export function fenceDue(store: Store, now: number): number | null {
  const since = linkDown(store);
  if (since == null || now - since < graceS(store) || fencedAt(store) != null) return null;
  return since;
}

export function sideFence(ctx: TickCtx): Action[] {
  if (ctx.role !== "side") return [];
  noteHeard(ctx.store, ctx.now);
  const since = fenceDue(ctx.store, ctx.now);
  if (since == null) return [];
  return [{ project: "", subject: "side-fence", kind: KIND, episode: String(since), payload: { down_since: since } }];
}

export default { name: "side-fence", scope: "host", run: sideFence } satisfies Reconciler;
