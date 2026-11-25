// contract-here.ts — which backend this process's squad runs on, when it is not Orca (orca-backend-alternatives
// U11b): loop.db read-only, nothing else. shared.ts backendPath() imports it, so it stays light (no backend
// code); the contract reads themselves are bin/lib/contract-roles.ts.
// U50 (project-start): a project's Studio runs on its dispatcher.json `studio_backend` (projects.doc; empty is
// orca), so a Studio off Orca counts here like a squad off Orca.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseMember } from "../loop/core/whoami.ts";

const STUDIO_SQUAD = "_studio";   // as bin/loop/squad/studio.ts, without its imports

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

/** The adapter verbs a member off Orca answers through bin/backend/contract.sh (bin/commands/contract-backend.ts).
 *  In a Studio off Orca only these go there; every other verb is the host's (shared.ts backendFor). */
export const MEMBER_VERBS = ["current", "ping", "worker-states", "wt-terminals", "worker-detail", "terminal-reap"] as const;

const STUDIO_BACKEND = "CASE WHEN json_valid(doc) THEN json_extract(doc, '$.studio_backend') END";
const offOrca = (b: unknown): string | null => (typeof b === "string" && b.trim() && b.trim() !== "orca" ? b.trim() : null);

/** The backend a project's Studio runs on when it is not Orca, else null (dispatcher.json studio_backend). */
export function studioContract(root: string, project: string): string | null {
  return offOrca(db(root, (d) => (d.query(`SELECT ${STUDIO_BACKEND} AS b FROM projects WHERE label = ?`).get(project) as { b?: unknown } | null)?.b ?? null));
}

/** The projects whose Studio runs off Orca. */
function studioProjects(root: string): string[] {
  return db(root, (d) => (d.query(`SELECT label, ${STUDIO_BACKEND} AS b FROM projects ORDER BY label`).all() as { label: string; b: unknown }[])
    .filter((r) => offOrca(r.b)).map((r) => r.label)) ?? [];
}

const merged = (a: string[], b: string | string[] | null): string[] => [...new Set([...a, ...(b === null ? [] : [b].flat())])].sort();

/** The contract backends a project's open squads and its Studio run on, each once. */
export function projectContracts(root: string, project: string): string[] {
  const squads = db(root, (d) => (d.query("SELECT DISTINCT backend FROM squads WHERE project = ? AND backend != 'orca' AND COALESCE(status, '') NOT IN ('closed', 'gone') ORDER BY backend")
    .all(project) as { backend: string }[]).map((r) => r.backend)) ?? [];
  return merged(squads, studioContract(root, project));
}

/** The contract backend this process belongs to, else null: DS_BACKEND (on every terminal the loop starts
 *  on a contract, core/actuator.ts contractSeat), else the squad of DS_MEMBER as loop.db has it (the
 *  Studio, squad `_studio`: its project's studio_backend). */
export function contractHere(root: string, env: Record<string, string | undefined> = process.env): string | null {
  if (env.DS_BACKEND) return env.DS_BACKEND === "orca" ? null : env.DS_BACKEND;
  const m = parseMember(env.DS_MEMBER);
  if (!m) return null;
  return m.squad === STUDIO_SQUAD ? studioContract(root, m.project) : squadContract(root, m.project, m.squad);
}

/** This process is a project's Studio (DS_MEMBER `<project>/_studio/studio`). */
export const studioHere = (env: Record<string, string | undefined> = process.env): boolean => parseMember(env.DS_MEMBER)?.squad === STUDIO_SQUAD;

/** The projects a contract verb answers for: DS_MEMBER's, else every project with a contract squad or a
 *  Studio off Orca (one whose only contract member is its Studio too). */
export function contractProjects(root: string, env: Record<string, string | undefined> = process.env): string[] {
  const m = parseMember(env.DS_MEMBER);
  if (m) return [m.project];
  const squads = db(root, (d) => (d.query("SELECT DISTINCT project FROM squads WHERE backend != 'orca' AND COALESCE(status, '') NOT IN ('closed', 'gone') ORDER BY project")
    .all() as { project: string }[]).map((r) => r.project)) ?? [];
  return merged(squads, studioProjects(root));
}
