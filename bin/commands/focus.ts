// ds focus — the project's focus squad (squad-priority U1), the `focus_squad` limits key:
//   ds focus <project>             the focus: `<squad>`, `none`, or `<squad> (not live: no effect)`
//   ds focus <project> <squad>     make <squad> the focus (a live feature squad only; it replaces any other)
//   ds focus <project> --clear     no focus
// Written through bin/loop/settings/settings.ts like the board's Settings, so each change is one history
// row and one `focus_set` event. A refused change exits 2.
import { parse } from "../loop/core/cli.ts";
import { rm, set, SettingsError } from "../loop/settings/settings.ts";
import { openSettings } from "../loop/settings/settings-migrate.ts";
import { FOCUS_KEY, focusSquad, focusValue, NO_FOCUS } from "../loop/squad/focus.ts";

export const help = "<project> [<squad> | --clear] — the project's focus squad: its queued Builder work takes the next free seat (squad-priority U1)";

const USAGE = "usage: ds focus <project> [<squad> | --clear]\n";

export async function run(args: string[]): Promise<number> {
  const { pos, flag } = parse(args, [], ["clear"]);
  const clear = flag.has("clear");
  const [project, squad] = pos;
  if (!project || pos.length > 2 || (clear && squad)) { process.stderr.write(USAGE); return 2; }
  const s = openSettings();
  try {
    if (clear) rm(s, project, "limits.conf", FOCUS_KEY, "ds");
    else if (squad) set(s, project, "limits.conf", FOCUS_KEY, squad, "ds");
    const v = focusValue(s, project);
    process.stdout.write(v === NO_FOCUS ? "none\n" : focusSquad(s, project) ? `${v}\n` : `${v} (not live: no effect)\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof SettingsError)) throw e;
    process.stderr.write(`ds focus: ${e.message}\n`);
    return 2;
  } finally { s.close(); }
}
