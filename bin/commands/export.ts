// ds export — write state/<label>/squads/<topic>.json from loop.db (unchanged files left alone).
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { exportJson } from "../loop/db/export-json.ts";

export const help = "[--project <label>] [--squad <topic>] — export squad JSON; prints {written, unchanged}";
export async function run(args: string[]): Promise<number> {
  const { opt } = parse(args, ["project", "squad"]);
  const s = open();
  const out = exportJson(s, s.root, { project: opt.project, topic: opt.squad });
  s.close();
  print(out);
  return 0;
}
