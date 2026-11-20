// ds limit-lift <agent> <account> — lift one account's limit by hand (U107): files a `limit-lift`
// request and the loop (fulfil/lift.ts) clears the account's block everywhere the picker reads it —
// the host-wide account episodes, observed_accounts.limited_until (and accounts.tsv, so
// accounts-refresh.sh does not bring it back) and members.limited_until — and logs one
// account_limit_lifted event. A new real limit notice blocks the account again as before.
// --wait <s> polls until the loop has done it.
import { open } from "../loop/core/store.ts";
import { parse, print, seconds, shape, waitFor } from "../loop/core/cli.ts";

export const help = "<agent> <account> [--by <who>] [--wait <s>] — lift one account's limit (the picker may use it again)";
export async function run(args: string[]): Promise<number> {
  const { pos, opt } = parse(args, ["by", "wait"]);
  const [agent, account] = pos;
  if (!agent || !account || pos.length > 2) { console.error(`usage: ds limit-lift ${help}`); return 2; }
  const wait = seconds(opt.wait);
  const s = open();
  try {
    const { row, created } = s.request("limit-lift", { agent, account }, { by: opt.by ?? process.env.DS_WHO ?? "ds" });
    if (wait === null) { print({ ...shape(row), created }); return 0; }
    let last = row;
    const met = await waitFor(wait, () => {
      last = s.db.query("SELECT * FROM requests WHERE id = ?").get(Number(row.id)) as typeof row;
      return (last.done_at ?? null) !== null;
    });
    print({ ...shape(last), created });
    if (met && /"ok":\s*false/.test(String(last.result ?? ""))) { console.error(`the loop gave up (row ${row.id}): ${String(last.result)}`); return 1; }
    if (met) return 0;
    console.error(`still requested (row ${row.id})`);
    return 1;
  } finally { s.close(); }
}
