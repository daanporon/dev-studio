// contract-here.ts — which backend this process's squad runs on, when it is not Orca (orca-backend-alternatives
// U11b): loop.db read-only, nothing else. shared.ts backendPath() imports it, so it stays light (no backend
// code); the contract reads themselves are bin/lib/contract-roles.ts.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseMember } from "../loop/core/whoami.ts";

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
