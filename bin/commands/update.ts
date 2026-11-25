// ds update — file an `update` request for a project (board-actions-as-wishes U1): the loop pulls the host's
// dev-studio checkout, reinstalls, restarts itself and refreshes the project's squads (bin/loop/fulfil/update.ts,
// in a job outside the loop), with no Studio turn. Refused (exit 1) while the project already has one open.
//   ds update <project> [--by <who>] [--wait <s>]
// --wait polls until the request is done and exits 1 when it failed or did not finish in time.
import { open } from "../loop/core/store.ts";
import { parse, print, seconds, shape, waitFor } from "../loop/core/cli.ts";

export const help = "<project> [--by <who>] [--wait <s>] — the loop pulls, reinstalls, restarts itself and refreshes the project's squads (no Studio)";

export async function run(args: string[]): Promise<number> {
  const { pos, opt } = parse(args, ["by", "wait"]);
  if (pos.length !== 1) { console.error(`usage: ds update ${help}`); return 2; }
  const project = pos[0];
  const wait = seconds(opt.wait);
  const by = opt.by ?? process.env.DS_WHO ?? "ds";
  const s = open();
  try {
    const openRow = s.db.query("SELECT id FROM requests WHERE kind = 'update' AND project = ? AND done_at IS NULL ORDER BY id LIMIT 1").get(project) as { id: number } | null;
    if (openRow) { console.error(`ds update: ${project} already has an update open (request ${openRow.id})`); return 1; }
    const { row } = s.request("update", { by }, { project, by });
    if (wait === null) { print(shape(row)); return 0; }
    let last = row;
    const met = await waitFor(wait, () => {
      last = s.db.query("SELECT * FROM requests WHERE id = ?").get(Number(row.id)) as typeof row;
      return (last.done_at ?? null) !== null;
    });
    print(shape(last));
    if (met && /"ok":\s*false/.test(String(last.result ?? ""))) { console.error(`ds update: failed (request ${row.id}): ${String(last.result)}`); return 1; }
    if (met) return 0;
    console.error(`ds update: still running (request ${row.id})`);
    return 1;
  } finally { s.close(); }
}
