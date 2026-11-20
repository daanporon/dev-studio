// fulfil/duplicate.ts — kind `duplicate` (U97): a second live session of a member's agent in its
// worktree (reconcilers/members.ts finds it; the newest is kept). Before acting the agent list is
// read again, so an agent that went busy since, or is already gone, is never closed blindly.
//   idle  closed (`terminal-close`), event `duplicate_agent_closed`, and its card (if any) resolved
//   busy  waits until it is idle; still busy after DUPLICATE_CARD_AFTER (30 min) gets one card
//         (kind duplicate_agent) and is not closed
//   newest is not the terminal the Run lists as the member's worker: one card, nothing closed
//   the session a pause recorded for the member: one card, nothing closed
//   a close that fails: one card, then failed (the claim keeps it to one try per episode)
// One card per worktree episode: every card of a duplicate has one id (episode CARD).
import { alert, resolveAlert, type Fulfiller } from "../core/actuator.ts";
import { errOf } from "../io/orca.ts";
import type { Action } from "../core/plugins.ts";
import { agentsOf, DUPLICATE_CARD_AFTER, DUPLICATE_KIND, loopPanes, parseAgents, parseWorkers } from "../reconcilers/members.ts";
import type { Row, Store } from "../core/store.ts";
import { actionBlock, memberKey } from "../pause/pause.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

const CARD = "card";
type P = ActionPayload<"duplicate">;

async function card(store: Store, a: Action, p: Required<Pick<P, "wt" | "handle">>, why: string) {
  return alert(store, a.project, a.subject, CARD,
    `${p.handle} is a second live session of the member's agent in ${p.wt}, a member worktree of ${a.squad} — ${why}. Close it if nothing in it is needed.`,
    { title: `Duplicate agent: ${a.squad}`, fields: { kind: DUPLICATE_KIND, handle: p.handle, wt: p.wt } });
}

// The session a pause recorded for this worktree's member. Resume drops the acknowledgement and moves
// the generation, so whether it checkpointed can't be told here: it is left for the operator.
function pauseRecorded(store: Store, a: Action, wt: string, handle: string): boolean {
  const m = store.db.query("SELECT * FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(a.project, wt) as Row | null;
  const row = m && store.get("pause_members", memberKey(m));
  return !!row && (row.session === handle || (JSON.parse(String(row.terminals ?? "[]")) as string[]).includes(handle));
}

const duplicate: Fulfiller = {
  name: "duplicate",
  kinds: ["duplicate"],
  run: () => [],
  async exec(a, x) {
    const p = payloadOf<"duplicate">(a);
    if (!a.project || !p.wt || !p.handle) return { failed: "a duplicate needs a project, a worktree and a handle" };
    const t = { wt: p.wt, handle: p.handle };
    // The newest is not the terminal the Run lists as the member's worker: trust neither, close
    // nothing. Re-checked live, so a Run that now lists the newest clears the way (and the card).
    const squad = a.squad ? x.store.db.query("SELECT run_id FROM squads WHERE project = ? AND topic = ?").get(a.project, a.squad) as { run_id: string | null } | null : null;
    if (squad?.run_id) {
      const rw = await x.act.orca.run("run-workers", [String(squad.run_id)]);
      // No fresh Run reading, no close: the mismatch check must run on live data first.
      if (rw.code !== 0) return { retry: errOf(rw, "run-workers") };
      const w = parseWorkers(rw.out).find((v) => v.wt === p.wt);
      if (w?.live && w.handle && p.newest && w.handle !== p.newest) {
        const o = await card(x.store, a, t, `the newest session ${p.newest} is not the terminal the Run lists as the member's worker (${w.handle}), so the loop closes neither`);
        return o.code === 0 ? { done: true } : { retry: errOf(o, "alerts.sh") };
      }
    }
    const ah = await x.act.orca.run("agent-handles", []);
    if (ah.code !== 0) return { retry: errOf(ah, "agent-handles") };
    const mine = agentsOf(parseAgents(ah.out), p.wt, loopPanes(x.store, a.project));
    const now = mine.find((v) => v.handle === p.handle);
    if (!now || mine.length < 2 || mine[0].handle === p.handle) {
      await resolveAlert(x.store, a.project, a.subject, CARD);
      return { done: true, result: `${p.handle} is gone` };
    }
    const observed = x.store.db.query("SELECT state FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(a.project, p.wt) as { state: string | null } | null;
    // Close only on a positive idle signal for this worktree; with no observed row yet, wait for
    // the observer rather than closing on an unattributed guess.
    const busy = now.busy ?? (observed ? observed.state === "working" : null);
    if (busy === null) return { wait: `${p.handle}: no observed state yet`, at: x.now + 60 };
    if (busy) {
      const first = p.first ?? x.now;
      if (x.now - first >= DUPLICATE_CARD_AFTER) {
        const o = await card(x.store, a, t, "it is still mid-turn after 30 minutes, so the loop leaves it open");
        return o.code === 0 ? { done: true } : { retry: errOf(o, "alerts.sh") };
      }
      return { wait: `${p.handle} is mid-turn`, at: Math.min(first + DUPLICATE_CARD_AFTER, x.now + 60) };
    }
    const block = actionBlock(x.store, a);
    if (block) return block === "paused" ? { wait: block } : { dropped: block };
    if (pauseRecorded(x.store, a, p.wt, p.handle)) {
      const o = await card(x.store, a, t, "a pause recorded it as the member's session, so the loop leaves it open");
      return o.code === 0 ? { done: true } : { retry: errOf(o, "alerts.sh") };
    }
    const c = await x.act.orca.run("terminal-close", [p.handle], { env: x.act.childActivity(x.store, a) });
    if (c.code === 0) {
      x.store.event("duplicate_agent_closed", { project: a.project, squad: a.squad, member: p.wt, payload: { wt: p.wt, handle: p.handle, title: now.title } });
      await resolveAlert(x.store, a.project, a.subject, CARD);
      return { done: true };
    }
    const why = errOf(c, "terminal-close");
    const o = await card(x.store, a, t, `the loop could not close it (${why})`);
    return o.code === 0 ? { failed: why } : { retry: errOf(o, "alerts.sh") };
  },
};
export default duplicate;
