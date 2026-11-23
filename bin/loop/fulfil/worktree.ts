// fulfil/worktree.ts — kind `worktree.remove`: the removed sweep step 1d, a leftover worktree is removed
// only when that is provably safe, never by force. Ported from the removed sweep and the old shell lib at
// origin/main 898381d.
//
//   wt_probe (bin/loop/io/wt-probe.ts, the rule close-role and close-squad share) fails   left, with a note
//   dirty                                                                    left
//   unpushed, unless the payload says its PR merged                          left
//   an ignored file outside the sweep's allowed top-level dirs (.env)        left
//   the worktree's exposed entries end and their stop commands run (squad/exposed.ts removalHold: waits)
//   then terminal-close-worktree, the close-time tidy (tidy.ts closeTidy.before: cleanup_on_close and
//   leftover processes), the same probe again, worktree-rm                    refused: left, with a note
//   and on success the Claude temp dir (closeTidy.after) and drop-leftover
//   (U11c: a squad on a contract backend: the contract's terminal.close and its provider's removal, by path)
//
// Leaving it is a done action, not a failure: the reconciler's next episode tries again. The note
// (event `leftover_note`) is once per cause, as the sweep's leftover_note: the episodes row
// (kind `leftover-note`) holds the last cause noted and goes when the worktree does.
// It runs in the background: a removal deletes a whole tree and must not hold up the tick.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Action } from "../core/plugins.ts";
import type { Exec, Fulfiller, Result } from "../core/actuator.ts";
import { spawn } from "../io/orca.ts";
import { wtProbe } from "../io/wt-probe.ts";
import { ROOT } from "../core/store.ts";
import { actionBlock } from "../pause/pause.ts";
import { closeTidy } from "../io/tidy.ts";
import { removalHold } from "../squad/exposed.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";
import { byContract, contractCloseTerminals, contractRemoveTree } from "../squad/removal.ts";

type P = ActionPayload<"worktree.remove">;

// Rebuildable top-level dirs, and dev-studio's own per-worktree files (OURS in bin/loop/io/wt-probe.ts).
const ALLOWED = new Set(["node_modules/", ".devenv/", ".direnv/", "dist/", "build/", "target/", ".turbo/", ".next/", "CLAUDE.local.md", ".claude/"]);
const noteKey = (a: Action, wt: string) => ({ project: a.project, subject: wt, kind: "leftover-note" });

function note(a: Action, x: Exec, p: P, cause: string, text: string): Result {
  const key = noteKey(a, p.wt!);
  if (x.store.get("episodes", key)?.state !== cause) {
    x.store.upsert("episodes", key, { squad: a.squad ?? null, state: cause, source: "loop", observed_at: x.now });
    x.store.event("leftover_note", { project: a.project, squad: a.squad, unit: p.unit ?? null, payload: { wt: p.wt, path: p.path, cause, text } });
  }
  return { done: true, result: `left: ${cause}` };
}

// A `git status --porcelain --ignored=matching` line for an ignored file the removal would lose.
const stray = (status: string) => status.split("\n").some((l) => l.startsWith("!! ") && !ALLOWED.has(l.slice(3).replace(/\/.*$/, "/")));

// The probe: a reason to leave the tree, or its unpushed count when it is safe to remove.
async function safe(a: Action, x: Exec, p: P, path: string): Promise<Result | { unpushed: string }> {
  const probe = await wtProbe(path, 60_000);
  if (probe.code !== 0) return note(a, x, p, "probe-failed", `leftover ${path} (${p.unit ?? ""}): worktree probe failed — left as is`);
  const [dirty, unpushed] = probe.out.split("\n")[0].split("\t");
  if (dirty !== "0") return { done: true, result: "left: dirty" };
  if (unpushed !== "0" && !p.merged) return { done: true, result: "left: unpushed" };
  const ignored = await spawn(["git", "-C", path, "status", "--porcelain", "--ignored=matching"], {}, 60_000);
  if (ignored.code !== 0) return { done: true, result: "left: ignored files unknown" };
  if (stray(ignored.out)) return { done: true, result: "left: ignored files" };
  return { unpushed };
}

async function remove(a: Action, x: Exec, p: P): Promise<Result> {
  const { wt, path } = p as { wt: string; path: string };
  const first = await safe(a, x, p, path);
  if (!("unpushed" in first)) return first;

  const block = actionBlock(x.store, a);
  if (block) return block === "paused" ? { wait: block } : { dropped: block };
  // exposed-cleanup U2: end what this worktree exposed and run its stop commands before the tree goes.
  const stops = removalHold(x.store, a.project, wt, "worktree-removed", x.now);
  if (stops) return { wait: stops };
  // U11c: a squad on a contract backend closes and removes through its contract and its provider, by path.
  const w = { project: a.project, squad: p.topic, wt, path }, contract = byContract(x.store, w);
  if (contract) await contractCloseTerminals(a, x, w);
  else await x.act.orca.run("terminal-close-worktree", [`id:${wt}`], { env: x.act.childActivity(x.store, a) });
  if (actionBlock(x.store, a)) return { wait: "activity changed before removal" };
  // U1 (KTD10): the project's cleanup_on_close, then stop what is still running in the tree, then probe again.
  const tidy = await closeTidy.before(a, x, path);
  const again = await safe(a, x, p, path);
  if (!("unpushed" in again)) return again;
  const { unpushed } = again;
  if (actionBlock(x.store, a)) return { wait: "activity changed before removal" };
  const rm = contract ? await contractRemoveTree(x, w) : await x.act.orca.run("worktree-rm", [`id:${wt}`], { env: x.act.childActivity(x.store, a) });
  if (rm.code !== 0) return note(a, x, p, "rm-refused", `leftover ${path} still refused by worktree-rm — left as is`);
  await closeTidy.after(a, x, path, tidy);
  x.store.db.run("DELETE FROM episodes WHERE project = ? AND subject = ? AND kind = ?", [a.project, wt, "leftover-note"]);
  // The tree is gone either way: a record this could not drop, the reconciler drops as gone.
  const state = join(x.store.root, a.project, "squads", `${p.topic}.json`);
  await spawn([join(ROOT, "bin", "role", "squad-state.sh"), state, "drop-leftover", wt], { DS_STATE_ROOT: x.store.root }, 30_000);
  return { done: true, result: p.merged && unpushed !== "0" ? "removed: PR merged" : "removed: clean, pushed" };
}

const worktree: Fulfiller = {
  name: "worktree",
  kinds: ["worktree.remove"],
  run: () => [],
  // The directory went meanwhile: the reconciler drops that record itself.
  stale: (a) => !existsSync(String((a.payload as P | null)?.path ?? "")),
  exec(a, x) {
    const p = payloadOf<"worktree.remove">(a);
    if (!a.project || !p.topic || !p.wt || !p.path) return { failed: "a leftover removal needs a project, a topic, a worktree and a path" };
    return { background: remove(a, x, p) };
  },
};
export default worktree;
