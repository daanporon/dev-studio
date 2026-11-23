// ds contract-backend — the role-side adapter verbs of a squad off Orca (orca-backend-alternatives U11b):
// bin/backend/contract.sh execs this for every verb. Each answers from the squad's backend through the
// contract (bin/lib/contract-roles.ts) or from loop.db, in the shape Orca's adapter prints, and none
// reaches Orca:
//   current          local::<this worktree> (DS_WT, else the git top of the working folder)
//   ping <wt> <text> nothing: a card note is Orca's; the board's card is the question itself (exit 0)
//   worker-states    <wt>\t<state>\t<name>\t<since ms>\t<said> per live member worktree
//   wt-terminals     one live member worktree per line
//   worker-detail    nothing (no Run); terminal-reap: 0 (the loop closes a contract's terminals)
import { spawnSync } from "node:child_process";
import { LOCAL, contractLive, contractProjects, contractStates } from "../lib/contract-roles.ts";
import { stateRoot, writeErr, writeOut } from "../lib/shared";

export const VERBS = ["current", "ping", "worker-states", "wt-terminals", "worker-detail", "terminal-reap"] as const;
export const help = `<verb> [args…] — run a contract adapter verb for a squad off Orca (contract.sh execs every one: ${VERBS.join(", ")})`;

function here(): string {
  if (process.env.DS_WT) return process.env.DS_WT;
  const g = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return g.status === 0 ? g.stdout.trim() : "";
}

/** Each project's lines; a backend that could not be read is named on stderr, and when nothing could be
 *  read at all the verb fails, as Orca's does: liveness unknown, not "none". */
async function perProject(f: (project: string) => Promise<{ lines: string[]; blind: string[] }>): Promise<number> {
  const out: string[] = [], blind: string[] = [];
  let read = 0;
  const projects = contractProjects(stateRoot());
  for (const p of projects) {
    const r = await f(p);
    out.push(...r.lines); blind.push(...r.blind.map((b) => `${p}: ${b}`));
    if (r.lines.length || !r.blind.length) read++;
  }
  for (const b of blind) writeErr(`contract adapter: ${b}\n`);
  if (out.length) writeOut(out.join("\n") + "\n");
  return projects.length && !read ? 1 : 0;
}

export async function run(argv: string[]): Promise<number> {
  const verb = argv[0] ?? "";
  switch (verb) {
    case "current": {
      const wt = here();
      if (!wt) { writeErr("contract adapter: current: not in a worktree (no DS_WT, no git top)\n"); return 1; }
      writeOut(`${wt.startsWith(LOCAL) ? wt : LOCAL + wt}\n`);
      return 0;
    }
    case "ping": return 0;
    case "worker-states": return perProject((p) => contractStates(stateRoot(), p));
    case "wt-terminals": return perProject(async (p) => {
      const l = await contractLive(stateRoot(), p);
      return { lines: [...new Set(l.terms.map((t) => t.wt))], blind: l.blind };
    });
    case "worker-detail": return 0;
    case "terminal-reap": writeOut("0\n"); return 0;
    default:
      writeErr(`contract adapter: no '${verb}' off Orca\n`);
      return 2;
  }
}
