// ds import — today's state files, markers and config into loop.db (idempotent; the install
// migration runs it once on the host switch). Prints the rows each importer changed.
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { importJson } from "../loop/db/import-json.ts";
import { importMarkers } from "../loop/db/import-markers.ts";
import { importConfig } from "../loop/db/import-config.ts";

export const help = "[--conventions <dir>] — import state JSON, markers, TSVs, config and markdown; prints changed-row counts";
export async function run(args: string[]): Promise<number> {
  const { opt } = parse(args, ["conventions"]);
  const s = open();
  const out = { root: s.root, json: importJson(s), markers: importMarkers(s), config: importConfig(s, s.root, opt.conventions) };
  s.close();
  print(out);
  return 0;
}
