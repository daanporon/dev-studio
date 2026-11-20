// fulfil/stray.ts — kind `stray` (U79): a plain shell in the worktree of a member that is up
// (reconcilers/members.ts finds it). Before acting the shell list is read again, so a shell that
// went busy or printed since is never closed, and one already gone is done.
//   idle  closed (`terminal-close`), event `stray_terminal_closed`, and its card (if any) resolved;
//         a close that fails raises the card and fails (the claim keeps it to one try per episode)
//   busy  one card (kind stray_terminal) naming the terminal and its worktree; it stays open
// One card per terminal: every card of a terminal has one id (episode CARD), whatever raised it.
import { alert, resolveAlert, type Fulfiller } from "../core/actuator.ts";
import { errOf } from "../io/orca.ts";
import type { Action } from "../core/plugins.ts";
import { parseShells, quiet, STRAY_KIND, STRAY_QUIET } from "../reconcilers/members.ts";
import type { Store } from "../core/store.ts";
import { actionBlock } from "../pause/pause.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

const CARD = "card";
type P = ActionPayload<"stray">;

async function card(store: Store, a: Action, p: Required<Pick<P, "wt" | "handle">>, why: string) {
  return alert(store, a.project, a.subject, CARD,
    `${p.handle} is a plain shell in ${p.wt}, a member worktree of ${a.squad} — ${why}. Close it if nothing in it is needed.`,
    { title: `Stray terminal: ${a.squad}`, fields: { kind: STRAY_KIND, handle: p.handle, wt: p.wt } });
}

const stray: Fulfiller = {
  name: "stray",
  kinds: ["stray"],
  run: () => [],
  async exec(a, x) {
    const p = payloadOf<"stray">(a);
    if (!a.project || !p.wt || !p.handle) return { failed: "a stray needs a project, a worktree and a handle" };
    const ts = await x.act.orca.run("terminal-shells", []);
    if (ts.code !== 0) return { retry: errOf(ts, "terminal-shells") };
    const now = parseShells(ts.out).find((t) => t.handle === p.handle);
    if (!now) {
      await resolveAlert(x.store, a.project, a.subject, CARD);
      return { done: true, result: `${p.handle} is gone` };
    }
    const t = { wt: p.wt, handle: p.handle };
    // In use again: look once more when it may be quiet (a claim never re-runs a dropped episode).
    if (!quiet(now, x.now)) return { wait: `${p.handle} is in use again`, at: (now.out ?? x.now) + STRAY_QUIET };
    if (now.state === "idle") {
      const block = actionBlock(x.store, a);
      if (block) return block === "paused" ? { wait: block } : { dropped: block };
      const c = await x.act.orca.run("terminal-close", [p.handle], { env: x.act.childActivity(x.store, a) });
      if (c.code === 0) {
        x.store.event("stray_terminal_closed", { project: a.project, squad: a.squad, member: p.wt, payload: { wt: p.wt, handle: p.handle, title: now.title } });
        await resolveAlert(x.store, a.project, a.subject, CARD);
        return { done: true };
      }
      const why = errOf(c, "terminal-close");
      const o = await card(x.store, a, t, `the loop could not close it (${why})`);
      return o.code === 0 ? { failed: why } : { retry: errOf(o, "alerts.sh") };
    }
    const o = await card(x.store, a, t, "something is running in it, so the loop leaves it open");
    return o.code === 0 ? { done: true } : { retry: errOf(o, "alerts.sh") };
  },
};
export default stray;
