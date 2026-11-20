// ds unexpose — end an entry `ds expose` published (expose-hosted-services U1, R4): the caller's own
// entry of that name. From the squad's Lead worktree, or with --project/--topic, any open entry of that
// name in the squad; two owners refuse and are listed (--owner <role[/suffix]> picks one).
// `ds expose --remove <name>` runs this with the same arguments. Ending an entry by hand never runs its
// stop command (exposed-cleanup U2): the role stopped what it hosts itself.
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel } from "../lib/shared";
import { badInput, caller, endExposed, ownerOf, plain, toplevel, unexposeMatches } from "../loop/squad/exposed.ts";

export const help = "<name> [--project <label> --topic <slug>] [--owner <role[/suffix]>] — end an exposed entry: your own, or (Lead, --project/--topic) the squad's; same as ds expose --remove <name>; never runs its stop command";
export async function run(args: string[], me = "ds unexpose"): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { console.log(`usage: ${me} ${help}`); return 0; }
  const usage = (why: string) => { console.error(`${me}: ${why}\nusage: ${me} ${help}`); return 2; };
  let p: ReturnType<typeof parse>;
  try { p = parse(args, ["project", "topic", "owner"]); } catch (e) { return usage((e as Error).message); }
  const { pos, opt } = p;
  if (pos.length !== 1) return usage("name one entry");
  const bad = badInput(pos[0]);
  if (bad) return usage(bad);
  const s = open();
  try {
    const c = caller(s, toplevel(), { project: opt.project === undefined ? undefined : dsLabel(opt.project), topic: opt.topic });
    if ("error" in c) { console.error(`${me}: ${c.error}`); return c.code; }
    const rows = unexposeMatches(s, c, pos[0], { squadWide: opt.project !== undefined || opt.topic !== undefined, owner: opt.owner });
    if (rows.length === 0) { console.error(`${me}: no open entry '${pos[0]}' ${c.lead || c.squadOwned ? "in" : `of this ${c.role} in`} ${c.project}/${c.squad}`); return 1; }
    if (rows.length > 1) {
      console.error(`${me}: ${rows.length} open entries named '${pos[0]}' in ${c.project}/${c.squad}, owned by ${rows.map(ownerOf).join(", ")}; pick one with --owner <role[/suffix]>`);
      return 2;
    }
    endExposed(s, rows[0], "unexposed", c.role);
    print(plain(s.get("exposed", { id: rows[0].id })!));
    return 0;
  } finally { s.close(); }
}
