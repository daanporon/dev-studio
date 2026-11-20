// ds reply — the Lead answers a worker's question the loop relayed to it (U61). The question id is
// the one the relayed message names; the loop, whose pane holds the Run, sends Orca's `reply` from
// there (bin/loop/fulfil/reply.ts) and the worker's parked `ask` returns the answer. The same answer
// again is a no-op; waits up to --wait seconds (default 60, 0 = don't) and exits 1 when the loop
// could not deliver it (the question was answered already, or its ask timed out).
import { open, type Row } from "../loop/core/store.ts";
import { parse, print, seconds, shape, waitFor } from "../loop/core/cli.ts";

export const help = `<question id> <answer> [--by <who>] [--wait <s>] — answer a worker's question the loop relayed to you; the loop sends the reply from the Run's seat`;

export async function run(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { console.log(`usage: ds reply ${help}`); return 0; }
  const { pos, opt } = parse(args, ["by", "wait"]);
  if (pos.length !== 2 || !pos[1].trim()) { console.error(`usage: ds reply ${help}`); return 2; }
  const [id, answer] = pos, wait = seconds(opt.wait) ?? 60;
  const s = open();
  try {
    const q = s.get("relayed", { msg_id: id });
    if (!q) { console.error(`ds reply: ${id} is no message the loop relayed (the id is in the relayed message's first line)`); return 2; }
    if (q.type !== "question") console.error(`ds reply: ${id} is a ${q.type ?? "message"}, not a question; replying anyway`);
    const { row, created } = s.request("reply", { id, run: q.run_id == null ? undefined : String(q.run_id), answer }, {
      key: `reply:${id}:${Bun.hash(answer).toString(36)}`, project: String(q.project), squad: String(q.squad), by: opt.by ?? process.env.DS_WHO ?? "lead",
    });
    let last: Row = row;
    const met = wait > 0 && await waitFor(wait, () => {
      last = s.db.query("SELECT * FROM requests WHERE id = ?").get(Number(row.id)) as Row;
      return last.done_at != null;
    });
    print({ ...shape(last), created });
    if (met && /"ok":\s*false/.test(String(last.result ?? ""))) { console.error(`ds reply: not delivered: ${String(last.result)}`); return 1; }
    if (wait > 0 && !met) { console.error(`ds reply: the loop has not sent it yet (row ${row.id}); it keeps trying`); return 1; }
    return 0;
  } finally { s.close(); }
}
