// ds members — member rows (one per slot; want and observed status).
// U100: each row also carries `dispatch_verdict` — the loop's own verdict on the member's dispatch
// (open, settled, rebound or unknown; liveness.ts dispatchVerdict), which watch.sh and the board
// read instead of copying the settled set.
// U151: `effective` is the member's effective state (pause.ts effective(): archived, suspended,
// paused, or its own wish running|stopped|archived) and `pending` its open one-time wishes
// (restart, reload, clear) with their age and author, oldest first.
import { open, now, pendingWishes } from "../loop/core/store.ts";
import { effective } from "../loop/pause/pause.ts";
import { dispatchVerdict } from "../loop/reconcilers/liveness.ts";
import { parse, print, shape } from "../loop/core/cli.ts";

export const help = "[<project> [<squad>]] [--doc] — member rows, each with its effective state and pending one-time wishes";
export async function run(args: string[]): Promise<number> {
  const { pos, flag } = parse(args, [], ["doc"]);
  const s = open();
  const at = now();
  const rows = s.db.query(`SELECT * FROM members WHERE (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR squad = ?2)
    ORDER BY project, squad, ord IS NULL, ord, id`).all(pos[0] ?? null, pos[1] ?? null) as Record<string, unknown>[];
  const out = rows.map((r) => ({ ...shape(r, flag.has("doc")),
    dispatch_verdict: dispatchVerdict(s, String(r.project ?? ""), String(r.squad ?? ""), String(r.wt ?? ""), at),
    effective: effective(s, r).state, pending: pendingWishes(r, at) }));
  s.close();
  print(out);
  return 0;
}
