// fulfil/nesting.ts — kind `wt-set-parent` (U206): reconcilers/nesting.ts found a standing member's
// worktree under the wrong parent. One backend `wt-set-parent <wt> <parent>`; a failed set is a retry,
// which the actuator gives up on like any op. The seat key is the action's, so a replay repeats the
// same call. Pause and activity blocks hold it as for any action on the member.
import type { Fulfiller } from "../core/actuator.ts";
import { errOf } from "../io/orca.ts";
import { actionBlock } from "../pause/pause.ts";
import { failRequest, finishRequest, requestActions } from "../core/actuator.ts";
import { recordRepair } from "../reconcilers/nesting.ts";
import { wtFolder } from "../drivers/contract.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

type P = ActionPayload<"wt-set-parent">;

const nesting: Fulfiller = {
  name: "nesting",
  kinds: ["wt-set-parent"],
  run: (ctx) => requestActions(ctx, ["wt-set-parent"]),   // `ds nudge wt-set-parent --json {wt,parent}`
  // The tree is right by now (a hand move, or an earlier try landed): nothing left to set.
  stale(a, x) {
    const p = payloadOf<"wt-set-parent">(a);
    const r = p.wt ? x.store.db.query("SELECT parent FROM observed_worktrees WHERE project = ? AND wt = ? AND gone_at IS NULL").get(a.project, p.wt) as { parent: string | null } | null : null;
    // A contract squad's observed parent is `local::<path>` (observers/contract.ts), the wish's may be Orca's form: by folder.
    const right = !r || r.parent === p.parent || (r.parent != null && String(r.parent).startsWith("local::") && wtFolder(r.parent) === wtFolder(p.parent));
    if (right && p.request != null) finishRequest(x.store, a, { ok: true, noop: "already under its parent" }, x.now);   // a nudge on a right tree: done, no Orca call
    return right;
  },
  // A nudged request given up is done with the reason; a reconciler's action keeps the refusal card.
  giveUp: (a, x, why) => ((a.payload as P | undefined)?.request != null ? failRequest(a, x, why) : false),
  async exec(a, x) {
    const p = payloadOf<"wt-set-parent">(a);
    if (!a.project || !p.wt || !p.parent) return { failed: "a wt-set-parent needs a project, a worktree and a parent" };
    const block = actionBlock(x.store, a);
    if (block) return block === "paused" ? { wait: block } : { dropped: block };
    // A nudge names a worktree, not a squad: the member row of that worktree says which squad's Run holds it.
    const squad = a.squad ?? (x.store.db.query("SELECT squad FROM members WHERE project = ? AND wt = ? AND squad IS NOT NULL AND COALESCE(status, '') != 'gone' LIMIT 1").get(a.project, p.wt) as { squad: string } | null)?.squad ?? null;
    const seat = x.act.seat(x.store, a.project, squad, `${a.subject}:${a.episode}`, p.wt, x.now);
    // U21f: a squad on a backend whose worktrees are Orca's moves it through that backend, both worktrees by folder.
    if (seat.contract) {
      const cwd = wtFolder(p.wt), parent = wtFolder(p.parent);
      if (!cwd || !parent) return { failed: `wt-set-parent on backend ${seat.contract.backend} needs folders, got ${p.wt} and ${p.parent}` };
      const r = await seat.contract.ask("worktree.set_parent", { cwd, parent });
      if (!r.ok) return { retry: r.error.message };
    } else {
      const o = await seat.call("wt-set-parent", [p.wt, p.parent]);
      if (o.code !== 0) return { retry: errOf(o, "wt-set-parent") };
    }
    recordRepair(x.store, a.project, p.wt, x.now);
    x.store.event("wt_parent_set", { project: a.project, squad: a.squad, member: p.wt, payload: { wt: p.wt, parent: p.parent } });
    finishRequest(x.store, a, { ok: true, wt: p.wt, parent: p.parent }, x.now);
    return { done: true, result: `${p.wt} under ${p.parent}` };
  },
};
export default nesting;
