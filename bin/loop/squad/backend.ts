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
