// squad/backend.ts — the backend a squad runs on (squads.backend, migration 0054; orca when unset).
// U11 (orca-backend-alternatives): a squad not on `orca` runs through the contract (core/actuator.ts
// contractSeat), and has no Run, task, dispatch, coordinator pane or relay.
import type { Store } from "../core/store.ts";
import { backendOf, LOCAL_HOST } from "../../backend/registry.ts";
import { limit } from "../settings/limits.ts";
import { STUDIO_SQUAD, studioBackend } from "./studio.ts";

export function squadBackend(store: Store, project: string, squad: string): string {
  return String(store.get("squads", { project, topic: squad })?.backend ?? "orca");
}
// side-loop-host U10: a member whose `members.host` names a side host runs through the contract on that host,
// whatever its squad's backend: an Orca squad's side member has no Orca terminal, Run or pane to read.
export const onSide = (host: unknown): boolean => typeof host === "string" && host !== "" && host !== LOCAL_HOST;
/** The host a member row names: `members.host`, else `local`. */
export const hostOf = (m: { host?: unknown } | null | undefined): string => (onSide(m?.host) ? String(m!.host) : LOCAL_HOST);
export const onContract = (store: Store, project: string, squad: string, host?: unknown): boolean => onSide(host) || squadBackend(store, project, squad) !== "orca";
// The orca_calls op whose row says a member's stop went out (fulfil/member.ts, member-state.ts stopOpen).
export const stopOp = (store: Store, project: string, squad: string, host?: unknown): string => (onContract(store, project, squad, host) ? "terminal.close" : "worker-stop");
/** The host of a worktree id: `<host>::<path>` for a host in the `hosts` table, else `local` (`local::<path>`, an
 *  Orca `<repo id>::<path>`, null). */
export function wtHost(store: Store, wt: string | null | undefined): string {
  const i = wt ? wt.indexOf("::") : -1;
  if (i <= 0) return LOCAL_HOST;
  const h = wt!.slice(0, i);
  return h !== LOCAL_HOST && store.get("hosts", { name: h }) ? h : LOCAL_HOST;
}
/** The backend a member on side host `host` runs on there: its squad's, but tmux for a squad on Orca or orca-lite
 *  (no Orca runs on a side host). */
export function sideBackend(store: Store, project: string, squad: string): string {
  const b = squad === STUDIO_SQUAD ? "tmux" : squadBackend(store, project, squad);
  return b === "orca" || b === "orca-lite" ? "tmux" : b;
}

// U12: what the Orca observer leaves alone in a project: each worktree id of a member of a squad off
// Orca (a `local::<path>`) or on a side host (a `<host>::<path>`, side-loop-host U10), and each folder a live `worktrees` row of such a squad owns (a provider
// worktree Orca may still list, e.g. one the `orca` provider made). The contract observer reads them.
export function offOrca(store: Store, project: string): { wts: Set<string>; paths: Set<string> } {
  // side-loop-host U10 (KTD9): a member on a side host is never Orca's, whatever its squad runs on.
  const wts = (store.db.query(`SELECT m.wt FROM members m LEFT JOIN squads s ON s.project = m.project AND s.topic = m.squad
      WHERE m.project = ? AND m.wt IS NOT NULL AND (COALESCE(s.backend, 'orca') != 'orca' OR COALESCE(m.host, 'local') NOT IN ('', 'local'))`).all(project) as { wt: string }[]).map((r) => r.wt);
  const paths = (store.db.query(`SELECT w.path FROM worktrees w JOIN squads s ON s.project = w.project AND s.topic = w.squad
      WHERE w.project = ? AND w.host = 'local' AND w.gone_at IS NULL AND COALESCE(s.backend, 'orca') != 'orca'`).all(project) as { path: string }[]).map((r) => r.path.replace(/\/+$/, ""));
  // U51: a Studio off Orca is the contract observer's too, and off Orca for the poke checks (fulfil/poke.ts).
  const studioWt = studioContract(store, project) ? String(store.get("projects", { label: project })?.studio_wt ?? "") : "";
  if (studioWt) wts.push(studioWt);
  for (const wt of wts) if (wt.startsWith("local::")) paths.push(wt.slice(7).replace(/\/+$/, ""));
  return { wts: new Set(wts), paths: new Set(paths) };
}

// U50 (project-start): the contract backend and worktree tool a project's Studio runs on, or null when it is
// on Orca (studio_backend empty or `orca`). The tool is the project's `worktree_provider` as a squad's is
// picked (bin/backend/registry.ts chooseSquadBackend): `auto`, empty or one the backend cannot use is its default.
export function studioContract(store: Store, project: string): { backend: string; provider: string } | null {
  const backend = studioBackend(store.get("projects", { label: project }));
  if (backend === "orca") return null;
  const providers: readonly string[] = backendOf(backend)?.providers ?? ["git"];
  const setting = (limit(store, project, "worktree_provider") ?? "").trim();
  return { backend, provider: providers.includes(setting) ? setting : providers[0] };
}

// A seat for the Studio: squad `_studio`, or no squad with the Studio's worktree as the member (fulfil/studio.ts).
export const studioSeat = (squad: string | null, member: string | null, studioWt: string | null): boolean =>
  squad === STUDIO_SQUAD || (squad === null && member !== null && member === studioWt);
