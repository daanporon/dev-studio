// ds nudge — write a one-off request row (KTD15) the loop handles once: a poke, a key, a role or
// limit edit. A --key makes it idempotent: the same key again returns the existing row. --wait polls
// until the loop marks it done and exits 1 when it does not in time, or when the loop gave up on it.
import { open } from "../loop/core/store.ts";
import { parse, print, seconds, shape, waitFor } from "../loop/core/cli.ts";

export const help = "<kind> --json <payload> [--key <k>] [--project <label>] [--squad <topic>] [--member <wt>] [--tier <t>] [--by <who>] [--wait <s>]";
export async function run(args: string[]): Promise<number> {
  const { pos, opt } = parse(args, ["json", "key", "project", "squad", "member", "tier", "by", "wait"]);
  if (pos.length !== 1 || opt.json === undefined) { console.error(`usage: ds nudge ${help}`); return 2; }
  const wait = seconds(opt.wait);
  const payload = JSON.parse(opt.json);
  const s = open();
  try {
    const { row, created } = s.requestAny(pos[0], payload, { key: opt.key ?? null, project: opt.project ?? null, squad: opt.squad ?? null,
      member: opt.member ?? null, tier: opt.tier ?? null, by: opt.by ?? process.env.DS_WHO ?? "ds" });
    if (wait === null) { print({ ...shape(row), created }); return 0; }
    let last = row;
    const met = await waitFor(wait, () => {
      last = s.db.query("SELECT * FROM requests WHERE id = ?").get(Number(row.id)) as typeof row;
      return (last.done_at ?? null) !== null;
    });
    print({ ...shape(last), created });
    if (met && /"ok":\s*false/.test(String(last.result ?? ""))) { console.error(`the loop gave up (row ${row.id}): ${String(last.result)}`); return 1; }
    if (met) return 0;
    console.error(`still requested (row ${row.id})${opt.key ? "; asking again with this key is a no-op" : ""}`);
    return 1;
  } finally { s.close(); }
}
