// side-actuator.ts — what acts on a side host's actions (side-loop-host U14, issue #127). A side loop decides
// nothing for main; its own reconcilers (core/side-plugins.ts) raise only these kinds:
//   side.push   {member, path, branch, sha}   push the Builder branch when it is still ahead (never forced):
//               `side_pushed`, or `side_push_failed` and the episode is tried again after SIDE_PUSH_RETRY_S
//   side.fence  {down_since}                  the link has been down for the grace: push each Builder branch that is
//               ahead (in parallel, each capped at DS_SIDE_FENCE_PUSH_MS, default 20 s), then close the terminals of
//               every member of this host, record fenced_at (bin/link/side-state.ts) and write `side_fenced`
// Any other kind is an error: the unit that adds a side reconciler brings what acts on it.
import type { Backend } from "../../backend/contract.ts";
import { noteFenced } from "../../link/side-state.ts";
import type { Action, Actuator, TickCtx } from "./plugins.ts";
import type { Store } from "./store.ts";
import { closeMember, pushAhead, sideBackendOf, sideMembers, type Pushed, type SideMember } from "../squad/side-work.ts";

export const SIDE_PUSH_RETRY_S = 300;
const fencePushMs = (): number => {
  const v = Number(process.env.DS_SIDE_FENCE_PUSH_MS);
  return Number.isFinite(v) && v > 0 ? v : 20_000;
};

export type SideDeps = {
  push?: (m: SideMember, timeoutMs?: number) => Promise<Pushed>;
  backend?: (store: Store, m: SideMember) => Backend;
};

type Fenced = { down_since: number; pushed: string[]; push_failed: string[]; closed: number; close_failed: string[] };

export function makeSideActuator(deps: SideDeps = {}): Actuator {
  const push = deps.push ?? pushAhead, backend = deps.backend ?? sideBackendOf;

  async function sidePush(a: Action, ctx: TickCtx): Promise<void> {
    const p = (a.payload ?? {}) as { path?: unknown };
    const m = sideMembers(ctx.store, a.project).find((x) => x.path === p.path && x.role === "builder");
    if (!m) return;
    const r = await push(m);
    if (!r) return;
    const ev = { project: a.project, squad: a.squad ?? null, member: a.member ?? null };
    if (r.ok) { ctx.store.fact("side_pushed", [], { ...ev, payload: { branch: r.branch, sha: r.sha } }); return; }
    ctx.store.fact("side_push_failed", [], { ...ev, payload: { branch: r.branch, error: r.error } });
    ctx.store.db.run("UPDATE episodes SET state = 'pending', next_at = ? WHERE project = ? AND subject = ? AND kind = ? AND episode_key = ?",
      [ctx.now + SIDE_PUSH_RETRY_S, a.project, a.subject, `action:${a.kind}`, a.episode]);
  }

  async function sideFence(a: Action, ctx: TickCtx): Promise<void> {
    const since = Number((a.payload as { down_since?: unknown } | null)?.down_since);
    const members = sideMembers(ctx.store);
    const out: Fenced = { down_since: since, pushed: [], push_failed: [], closed: 0, close_failed: [] };
    // Push first, all at once: the whole fence must end inside main's 60 s margin.
    const pushed = await Promise.all(members.filter((m) => m.role === "builder").map(async (m) => {
      try { return { m, r: await push(m, fencePushMs()) }; } catch (e) { return { m, r: { ok: false as const, branch: null, error: (e as Error).message } }; }
    }));
    for (const { m, r } of pushed) {
      if (r?.ok) out.pushed.push(`${r.branch}@${r.sha.slice(0, 12)}`);
      else if (r) out.push_failed.push(`${r.branch ?? m.path}: ${r.error}`);
    }
    for (const m of members) {
      try {
        const c = await closeMember(backend(ctx.store, m), m);
        if ("closed" in c) out.closed += c.closed; else out.close_failed.push(`${m.path}: ${c.error}`);
      } catch (e) { out.close_failed.push(`${m.path}: ${(e as Error).message}`); }
    }
    noteFenced(ctx.store, since, ctx.now);
    ctx.store.fact("side_fenced", [], { payload: out });
  }

  return {
    async act(a, ctx) {
      if (a.kind === "side.push") return sidePush(a, ctx);
      if (a.kind === "side.fence") return sideFence(a, ctx);
      throw new Error(`side loop: nothing acts on '${a.kind}'`);
    },
  };
}

export const sideActuator: Actuator = makeSideActuator();
