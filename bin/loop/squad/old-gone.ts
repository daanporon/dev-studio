// squad/old-gone.ts — U21c (orca-backend-alternatives): the start of a member Orca still shows `working`
// after its agent died. U21a's rule (decide.ts staleWorkingAt) reads it `none`, but the adapter's
// fresh-start guard (bin/backend/orca.ts guardFreshStart) would still refuse `agent_busy` on Orca's stale
// state. Right before the call the start walks that one worktree's processes again; only when that walk
// succeeds and finds no agent does the call carry OLD_GONE, with which the guard closes the old agent
// terminals as for an idle one. A walk that finds an agent or fails sends no flag: the guard decides.
import { staleWorkingAt } from "../core/decide.ts";
import type { Row, Store } from "../core/store.ts";
import type { Orca } from "../io/orca.ts";
import { parseAgentAccounts, wtPath } from "../observers/orca.ts";

export const OLD_GONE = "DS_START_OLD_GONE";

const under = (cwd: string, p: string) => cwd === p || cwd.startsWith(`${p}/`);

// One worktree's main agents from a fresh host process walk (orca.sh agent-accounts): a process in a
// worktree nested inside this one's folder is that worktree's, as the observer's deepest-folder rule.
export async function walkOne(store: Store, orca: Orca, wt: string): Promise<"running" | "none" | "failed"> {
  const path = (wtPath(wt) ?? (wt.startsWith("/") ? wt : "")).replace(/\/+$/, "");
  if (!path) return "failed";
  const o = await orca.run("agent-accounts", []).catch(() => null);
  if (!o || o.code !== 0) return "failed";
  const deeper = (store.db.query(`SELECT wt_path AS p FROM members WHERE wt_path LIKE ?1
    UNION SELECT path AS p FROM worktrees WHERE gone_at IS NULL AND path LIKE ?1`).all(`${path}/%`) as { p: string | null }[])
    .flatMap((r) => (r.p ? [r.p.replace(/\/+$/, "")] : []));
  const mains = parseAgentAccounts(o.out).filter((pr) => (pr.kind ?? "main") === "main" && under(pr.cwd, path) && !deeper.some((d) => under(pr.cwd, d)));
  return mains.length ? "running" : "none";
}

// The env a member's start carries: OLD_GONE when U21a's rule holds now and a fresh walk finds no agent.
export async function oldGoneEnv(store: Store, orca: Orca, m: Row, now: number): Promise<Record<string, string> | undefined> {
  const at = staleWorkingAt(store, m);
  if (at == null || at > now) return undefined;
  return (await walkOne(store, orca, String(m.wt))) === "none" ? { [OLD_GONE]: "1" } : undefined;
}
