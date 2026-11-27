// side-push.ts — side-loop-host U14 (issue #127, KTD13): on a side host, push each Builder branch that is ahead of
// its remote, so a host that goes away loses as little as possible (main requeues from the last pushed commit, U15).
// Side only (core/side-plugins.ts SIDE_ONLY: a main loop never loads it). Per project, each tick: for each Builder
// folder of this host (squad/side-work.ts sideMembers) whose branch holds commits its remote does not, one
// `side.push` action, episode = the head it saw, so each new commit is pushed once. The side actuator pushes (never
// forced) and writes `side_pushed`; a failed push writes `side_push_failed` and is tried again after
// SIDE_PUSH_RETRY_S. Once the link has been down for the grace, the fence (side-fence.ts) pushes instead.
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { aheadOf, builderBranch, sideMembers } from "../squad/side-work.ts";
import { fenceDue } from "./side-fence.ts";

export const KIND = "side.push";

export async function sidePush(ctx: TickCtx): Promise<Action[]> {
  if (ctx.role !== "side" || fenceDue(ctx.store, ctx.now)) return [];
  const out: Action[] = [];
  for (const m of sideMembers(ctx.store, ctx.project)) {
    if (m.role !== "builder") continue;
    const branch = await builderBranch(m);
    const sha = branch ? await aheadOf(m.path, branch) : null;
    if (!branch || !sha) continue;
    out.push({ project: m.project, squad: m.squad, member: `local::${m.path}`, subject: `side-push:${m.path}`, kind: KIND, episode: sha,
      payload: { member: m.id, path: m.path, branch, sha } });
  }
  return out;
}

export default { name: "side-push", run: sidePush } satisfies Reconciler;
