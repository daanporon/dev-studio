// ds reload — the loop's reload wishes (U156). The Studio's /ds-reload writes one on every
// member through notify-squads.sh and a Lead writes one per child; the loop types it into each
// idle member's terminal and the member confirms from that terminal with `ack`.
//   ds reload ack <project> <squad> <role> [suffix] — confirm you re-read your instructions.
// Session-checked like `ds pause ack`: ORCA_TERMINAL_HANDLE must be the member's live agent
// terminal, so an old session's ack does not count. A fresh session after the wish satisfies it
// without an ack (the decider records it). With nothing pending the ack is stale.
import { open, now, pendingWishes } from "../loop/core/store.ts";
import { effective } from "../loop/pause/pause.ts";
import { parse, print, shape } from "../loop/core/cli.ts";
import { whoAmI } from "../loop/core/whoami.ts";

export const help = `ack <project> <squad> <role> [suffix] — confirm you re-read your instructions after a reload wish`;

export async function run(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { console.log(`usage: ds reload ${help}`); return 0; }
  const { pos } = parse(args, [], []);
  if (pos[0] !== "ack" || pos.length < 4 || pos.length > 5) { console.error(`usage: ds reload ${help}`); return 2; }
  const [, project, squad, role, suffix = ""] = pos;
  const s = open();
  try {
    const row = s.acknowledgeReload(`${project}/${squad}/${role}${suffix && suffix !== "-" ? `/${suffix}` : ""}`,
      whoAmI().handle ?? undefined, now());
    print({ ...shape(row), effective: effective(s, row).state, pending: pendingWishes(row, now()) });
    return 0;
  } finally { s.close(); }
}
