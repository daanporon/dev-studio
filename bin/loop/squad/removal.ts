// squad/removal.ts — orca-backend-alternatives U11c: how a worktree of a squad on a contract backend
// goes. Its terminals close through the contract (`terminal.close` on every terminal whose folder is the
// worktree's path, one orca_calls row under the action's key) and its worktree goes through the provider
// that made it (io/worktrees.ts removeWorktree, by path; the branch is kept). A squad on Orca keeps
// terminal-close-worktree and worktree-rm at each call site. Both answers are the Orca adapter's shape
// (code 0 = done), so close, cancel, a leftover pass and a host tidy each keep their own refusal handling.
import type { Exec } from "../core/actuator.ts";
import type { Action } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import type { Out } from "../io/orca.ts";
import { removeWorktree, worktreeAt } from "../io/worktrees.ts";
import { LOCAL } from "../drivers/contract.ts";
import { onContract } from "./backend.ts";

export type Where = { project: string; squad: string | null | undefined; wt: string; path: string };
const OK: Out = { code: 0, out: "", err: "" };

/** Whether this worktree's removal is the contract's: its squad is on a backend other than `orca`. */
export const byContract = (store: Store, w: Pick<Where, "project" | "squad">): boolean => !!w.squad && onContract(store, w.project, w.squad);

/** The live `worktrees` row at `path` when a provider made it for a squad on a contract backend. */
export function contractTree(store: Store, path: string | null | undefined): Row | null {
  const r = path ? worktreeAt(store, path) : null;
  return r && r.gone_at == null && r.project && r.squad && onContract(store, String(r.project), String(r.squad)) ? r : null;
}
/** The member worktree id of a contract tree (`local::<path>`). */
export const contractWt = (r: Row): string => `${LOCAL}${r.path}`;

/** Close every terminal in the worktree's folder through the squad's contract backend. */
export async function contractCloseTerminals(a: Action, x: Exec, w: Where): Promise<Out> {
  const seat = x.act.seat(x.store, w.project, w.squad ?? null, `${a.kind}:${a.subject}:${a.episode}:terminal.close`, w.wt, x.now);
  if (!seat.contract) return { code: 2, out: "", err: `squad ${w.squad} is not on a contract backend` };
  const r = await seat.contract.close(w.path);
  return r.ok ? OK : { code: 1, out: "", err: r.error ?? "terminal.close failed" };
}

/** Remove the worktree at `path` through its recorded provider; a refusal (dirty, no row) is code 1. */
export async function contractRemoveTree(x: Exec, w: Where, force = false): Promise<Out> {
  try {
    await removeWorktree(x.store, w.path, { force }, x.now);
    return OK;
  } catch (e) { return { code: 1, out: "", err: (e as Error).message }; }
}
