// ds exposed — the entries `ds expose` published, with their latest probe, as JSON (expose-hosted-services
// U1, R5): open ones, or every one with --all. Each row has its audience (self entries too), ports and
// stop_state (exposed-cleanup U2).
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel } from "../lib/shared";
import { listExposed } from "../loop/squad/exposed.ts";

export const help = "[--project <label>] [--topic <slug>] [--all] — the exposed entries as JSON, newest first; --all includes ended ones";
export async function run(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { console.log(`usage: ds exposed ${help}`); return 0; }
  let p: ReturnType<typeof parse>;
  try { p = parse(args, ["project", "topic"], ["all"]); } catch (e) { console.error(`ds exposed: ${(e as Error).message}\nusage: ds exposed ${help}`); return 2; }
  const { pos, opt, flag } = p;
  if (pos.length) { console.error(`usage: ds exposed ${help}`); return 2; }
  const s = open();
  try {
    print(listExposed(s, { project: opt.project === undefined ? undefined : dsLabel(opt.project), topic: opt.topic, all: flag.has("all") }));
    return 0;
  } finally { s.close(); }
}
