// squad/backend.ts — the backend a squad runs on (squads.backend, migration 0054; orca when unset).
// U11 (orca-backend-alternatives): a squad not on `orca` runs through the contract (core/actuator.ts
// contractSeat), and has no Run, task, dispatch, coordinator pane or relay.
import type { Store } from "../core/store.ts";

export function squadBackend(store: Store, project: string, squad: string): string {
  return String(store.get("squads", { project, topic: squad })?.backend ?? "orca");
}
export const onContract = (store: Store, project: string, squad: string): boolean => squadBackend(store, project, squad) !== "orca";
// The orca_calls op whose row says a member's stop went out (fulfil/member.ts, member-state.ts stopOpen).
export const stopOp = (store: Store, project: string, squad: string): string => (onContract(store, project, squad) ? "terminal.close" : "worker-stop");

// U12: what the Orca observer leaves alone in a project: each worktree id of a member of a squad off
// Orca (a `local::<path>`), and each folder a live `worktrees` row of such a squad owns (a provider
// worktree Orca may still list, e.g. one the `orca` provider made). The contract observer reads them.
export function offOrca(store: Store, project: string): { wts: Set<string>; paths: Set<string> } {
  const wts = (store.db.query(`SELECT m.wt FROM members m JOIN squads s ON s.project = m.project AND s.topic = m.squad
      WHERE m.project = ? AND m.wt IS NOT NULL AND COALESCE(s.backend, 'orca') != 'orca'`).all(project) as { wt: string }[]).map((r) => r.wt);
  const paths = (store.db.query(`SELECT w.path FROM worktrees w JOIN squads s ON s.project = w.project AND s.topic = w.squad
      WHERE w.project = ? AND w.gone_at IS NULL AND COALESCE(s.backend, 'orca') != 'orca'`).all(project) as { path: string }[]).map((r) => r.path.replace(/\/+$/, ""));
  for (const wt of wts) if (wt.startsWith("local::")) paths.push(wt.slice(7).replace(/\/+$/, ""));
  return { wts: new Set(wts), paths: new Set(paths) };
}
