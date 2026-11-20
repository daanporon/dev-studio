// ds stop-checkpoint — U266: the agent side of the checkpoint a planned restart asks for first
// (bin/loop/pause/stop-checkpoint.ts). bin/role/pause-checkpoint.sh calls `show` before it writes the
// journal line, so a stale generation or another terminal's call writes nothing.
//   ds stop-checkpoint show <project> <squad> <role> <suffix|-> <generation>
// Prints the asking row; exits 1 unless the member's newest row asks for this generation and
// ORCA_TERMINAL_HANDLE is a live terminal in the member's worktree.
import { parse, print } from "../loop/core/cli.ts";
import { latest } from "../loop/pause/stop-checkpoint.ts";
import { open } from "../loop/core/store.ts";

export const help = "show <project> <squad> <role> <suffix|-> <generation> — check a stop checkpoint ask (pause-checkpoint.sh)";

export async function run(args: string[]): Promise<number> {
  const { pos } = parse(args, [], []);
  if (pos[0] !== "show" || pos.length !== 6) { console.error(`usage: ds stop-checkpoint ${help}`); return 2; }
  const [, project, squad, role, sfx, generation] = pos;
  const suffix = sfx === "-" ? "" : sfx, handle = process.env.ORCA_TERMINAL_HANDLE ?? "";
  const s = open();
  try {
    const m = s.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = ? AND COALESCE(suffix, '') = ? ORDER BY id DESC LIMIT 1").get(project, squad, role, suffix) as Record<string, unknown> | null;
    const row = m ? latest(s, Number(m.id)) : null;
    if (!m || !row || row.state !== "asking" || row.generation !== generation) { console.error("stop checkpoint: stale generation (no ask pending for it)"); return 1; }
    const live = handle && m.wt && s.db.query("SELECT 1 FROM observed_terminals WHERE project = ? AND handle = ? AND wt = ? AND gone_at IS NULL").get(project, handle, String(m.wt));
    if (!live) { console.error("stop checkpoint: must run in the member's live agent terminal"); return 1; }
    print(row);
    return 0;
  } finally { s.close(); }
}
