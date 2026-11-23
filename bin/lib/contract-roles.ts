// contract-roles.ts — what the role scripts read of a squad on a contract backend (orca-backend-alternatives
// U11b; conventions/backend.md, "Role scripts off Orca"). Such a squad has no Run and no Orca worktree:
// its members' worktrees are `local::<path>` (bin/loop/drivers/contract.ts LOCAL) and its terminals live on
// the squad's backend (squads.backend; tmux today). Liveness and agent state come from the contract
// (`terminal.list`, `agent.state`, `terminal.last_output`), which backend a squad runs on from loop.db,
// read-only, and nothing here reaches Orca.
//
// bin/backend/contract.sh answers the adapter verbs the role scripts call through $BACKEND with these
// (`ds contract-backend`); the phone book and the team listing call them in process for the contract
// squads of a project that also has squads on Orca. Imports no shared.ts: shared.ts imports this.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { checked, type Backend } from "../backend/contract.ts";
import { projectTmux } from "../backend/tmux.ts";
import { parseMember } from "../loop/core/whoami.ts";

export const LOCAL = "local::";   // as bin/loop/drivers/contract.ts, without its imports
export const isLocalWt = (wt: string | null | undefined): boolean => !!wt && wt.startsWith(LOCAL);

/** The contract backend `name` of a project, as the loop makes it (core/actuator.ts contracted): only
 *  tmux has an adapter. A read never starts its server (bin/backend/tmux.ts starts one on create only). */
export type MakeBackend = (name: string, project: string) => Backend | null;
export const makeBackend = (root: string): MakeBackend => (name, project) =>
  (name === "tmux" ? checked(projectTmux(project, { stateRoot: root })) : null);

function db<T>(root: string, f: (d: Database) => T): T | null {
  const path = join(root, "loop.db");
  try { if (!existsSync(path) || statSync(path).size === 0) return null; } catch { return null; }
  try {
    const d = new Database(path, { readonly: true });
    try { return f(d); } finally { d.close(); }
  } catch { return null; }   // an older loop.db with no backend column, or none at all: read as Orca
}

/** The backend a squad runs on when it is not Orca, else null (squads.backend, migration 0054). */
export function squadContract(root: string, project: string, squad: string): string | null {
  const b = db(root, (d) => (d.query("SELECT backend FROM squads WHERE project = ? AND topic = ?").get(project, squad) as { backend?: string } | null)?.backend ?? null);
  return b && b !== "orca" ? b : null;
}

/** The contract backends a project's open squads run on, each once. */
export function projectContracts(root: string, project: string): string[] {
  return db(root, (d) => (d.query("SELECT DISTINCT backend FROM squads WHERE project = ? AND backend != 'orca' AND COALESCE(status, '') NOT IN ('closed', 'gone') ORDER BY backend")
    .all(project) as { backend: string }[]).map((r) => r.backend)) ?? [];
}

/** The contract backend this process belongs to, else null: DS_BACKEND (on every terminal the loop starts
 *  on a contract, core/actuator.ts contractSeat), else the squad of DS_MEMBER as loop.db has it. */
export function contractHere(root: string, env: Record<string, string | undefined> = process.env): string | null {
  if (env.DS_BACKEND) return env.DS_BACKEND === "orca" ? null : env.DS_BACKEND;
  const m = parseMember(env.DS_MEMBER);
  return m ? squadContract(root, m.project, m.squad) : null;
}

/** The projects a contract verb answers for: DS_MEMBER's, else every project with a contract squad. */
export function contractProjects(root: string, env: Record<string, string | undefined> = process.env): string[] {
  const m = parseMember(env.DS_MEMBER);
  if (m) return [m.project];
  return db(root, (d) => (d.query("SELECT DISTINCT project FROM squads WHERE backend != 'orca' AND COALESCE(status, '') NOT IN ('closed', 'gone') ORDER BY project")
    .all() as { project: string }[]).map((r) => r.project)) ?? [];
}

export type LiveTerm = { wt: string; id: string; backend: string; label: string; created_at: number };
export type Live = { terms: LiveTerm[]; blind: string[] };   // blind: why a backend could not be read

/** The live terminals of a project's contract squads, each as the member worktree it runs in. A backend
 *  with no adapter, or a list that fails, is named in `blind`: liveness there is unknown, not "none". */
export async function contractLive(root: string, project: string, o: { make?: MakeBackend; backends?: string[] } = {}): Promise<Live> {
  const make = o.make ?? makeBackend(root), out: Live = { terms: [], blind: [] };
  for (const name of o.backends ?? projectContracts(root, project)) {
    const b = make(name, project);
    if (!b) { out.blind.push(`${name}: no adapter`); continue; }
    try {
      const l = await b.call("terminal.list", {});
      if (!l.ok) { out.blind.push(`${name}: ${l.error.message}`); continue; }
      for (const t of l.terminals) out.terms.push({ wt: LOCAL + t.cwd, id: t.id, backend: name, label: t.label, created_at: t.created_at });
    } catch (e) { out.blind.push(`${name}: ${(e as Error).message}`); }
  }
  return out;
}

/** Orca's `worker-states` lines for contract terminals: `<wt>\t<state>\t<name>\t<since ms>\t<last said>`.
 *  The state is the contract's (`working|waiting|idle|unknown`; tmux reads `unknown`), the name the
 *  worktree's folder, the since its last output (else its start); a contract says nothing of the last
 *  message, so that column is empty. The newest terminal of a worktree speaks for it. */
export async function contractStates(root: string, project: string, o: { make?: MakeBackend } = {}): Promise<{ lines: string[]; blind: string[] }> {
  const make = o.make ?? makeBackend(root), live = await contractLive(root, project, o);
  const newest = new Map<string, LiveTerm>();
  for (const t of live.terms) { const n = newest.get(t.wt); if (!n || t.created_at > n.created_at) newest.set(t.wt, t); }
  const lines: string[] = [];
  for (const t of newest.values()) {
    const b = make(t.backend, project)!;
    const st = await b.call("agent.state", { id: t.id }).catch(() => null);
    const lo = await b.call("terminal.last_output", { id: t.id }).catch(() => null);
    const since = (lo?.ok && lo.at) || t.created_at;
    lines.push(`${t.wt}\t${st?.ok ? st.state : "unknown"}\t${basename(t.wt.slice(LOCAL.length))}\t${since * 1000}\t`);
  }
  return { lines, blind: live.blind };
}
