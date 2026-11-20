import { existsSync } from "node:fs";
import { CANCEL_KINDS, unitOfCancellation, cancellationReality, cancellationRepository, sharedBuilder, sharedPr, prNumber } from "../squad/cancel.ts";
import type { Action } from "../core/plugins.ts";
import { alert, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { errOf, spawn } from "../io/orca.ts";
import type { Row } from "../core/store.ts";
import { closeTidy } from "../io/tidy.ts";

async function cleanup(a: Action, x: Exec): Promise<Result> {
  const p = a.payload as Row, wt = String(p.wt ?? "");
  if (cancel.stale!(a, x)) return { dropped: "cancellation target changed" };
  if (a.kind === "cancel.remove" && existsSync(String(p.path))) {
    // Orca may delete a branch it considers merged. Detach first, at the same
    // commit, so both merged and unmerged branches survive a crash or rm.
    const sha = await spawn(["git", "-C", String(p.path), "rev-parse", "HEAD"], {}, 30_000);
    if (sha.code !== 0) return { retry: errOf(sha, "read cancelled worktree HEAD") };
    if (cancel.stale!(a, x)) return { dropped: "cancellation target changed" };
    const o = await spawn(["git", "-C", String(p.path), "update-ref", "--no-deref", "HEAD", sha.out.trim()], {}, 30_000);
    if (o.code !== 0) return { retry: errOf(o, "detach cancelled worktree") };
  }
  if (cancel.stale!(a, x)) return { dropped: "cancellation target changed" };
  // U1: the close-time tidy around the forced removal. Best effort: the command's result never stops
  // the removal and no second probe gates it.
  const path = String(p.path ?? ""), tidy = a.kind === "cancel.remove" && path && existsSync(path) ? await closeTidy.before(a, x, path) : null;
  if (tidy && cancel.stale!(a, x)) return { dropped: "cancellation target changed" };
  const op = a.kind === "cancel.stop" ? "terminal-close-worktree" : a.kind === "cancel.remove" ? "worktree-rm" : "pr-close";
  const args = a.kind === "cancel.pr" ? [String(p.repo), String(p.pr)] : a.kind === "cancel.remove" ? [`id:${wt}`, "force"] : [`id:${wt}`, "--strict"];
  const o = await x.act.orca.run(op, args);
  if (o.code !== 0) return { retry: errOf(o, op) };
  if (tidy) await closeTidy.after(a, x, path, tidy);
  return { done: true };
}
const cancel: Fulfiller = {
  name: "cancel", kinds: [...CANCEL_KINDS], run: () => [],
  stale: (a, x) => {
    const u = unitOfCancellation(x.store, a), p = a.payload as Row;
    if (u?.status !== "cancelled") return true;
    if (a.kind === "cancel.pr") {
      const pr = x.store.get("observed_prs", { project: a.project, ref: `${p.repo}#${p.pr}` });
      return prNumber(u.pr) !== Number(p.pr) || cancellationRepository(x.store, u) !== p.repo || sharedPr(x.store, u) || pr?.state !== "OPEN" || pr.gone_at != null;
    }
    if (String(u.builder_wt ?? "") !== String(p.wt) || sharedBuilder(x.store, u)) return true;
    const reality = cancellationReality(x.store, a.project, String(p.wt));
    return a.kind === "cancel.remove" ? !reality.present || !reality.tree || reality.live : !reality.live;
  },
  exec: (a, x) => ({ background: cleanup(a, x) }),
  async giveUp(a, x, why) {
    const o = await alert(x.store, a.project, `${a.kind}.${a.subject}`, "card", `Cancellation of ${a.squad}/${(a.payload as Row).unit} is stuck at ${a.kind} (${a.subject}): ${why}. The loop keeps retrying.`,
      { title: "Cancellation failed", fields: { kind: "cancel_failed", squad: a.squad, unit: (a.payload as Row).unit, step: a.kind } });
    return o.code === 0;   // its own card written: no refusal card beside it (else the actuator's, retried by ready())
  },
};
export default cancel;
