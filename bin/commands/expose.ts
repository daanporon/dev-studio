// ds expose — publish a URL this worktree's member hosts (a dev env, a preview server, a test board) so
// the board shows it with its squad (expose-hosted-services U1, R1–R3). The same name again updates the
// entry. --squad keeps it after the member ends (a detached env); outside a role worktree it needs
// --project/--topic and the squad owns it. The loop probes it and ends it when it goes (U2).
// exposed-cleanup U2: --stop registers how to stop what it hosts (the loop runs it once when the entry
// ends with its squad or owner), --self marks a tool only the member uses, --ports names extra ports;
// --remove <name> is `ds unexpose <name>`. A squad that is done or closing takes no new entry.
import { open } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel } from "../lib/shared";
import { badInput, badStop, caller, closingRefusal, expose, parsePorts, toplevel } from "../loop/squad/exposed.ts";
import { run as unexpose } from "./unexpose.ts";

export const help = "<name> <url> [--note <text>] [--squad] [--stop \"<cmd>\"] [--self] [--ports <p,p>] [--project <label> --topic <slug>] — show a URL this member hosts on the board; --squad keeps it after the member ends, --stop is run once when the entry ends with its squad or owner, --self marks a tool only you use; ds expose --remove <name> (= ds unexpose <name>) ends one";
export async function run(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) { console.log(`usage: ds expose ${help}`); return 0; }
  const rm = args.indexOf("--remove");
  if (rm >= 0) return unexpose([...args.slice(0, rm), ...args.slice(rm + 1)], "ds expose --remove");
  const usage = (why: string) => { console.error(`ds expose: ${why}\nusage: ds expose ${help}`); return 2; };
  let p: ReturnType<typeof parse>;
  try { p = parse(args, ["note", "project", "topic", "stop", "ports"], ["squad", "self"]); } catch (e) { return usage((e as Error).message); }
  const { pos, opt, flag } = p;
  if (pos.length !== 2) return usage("name one entry and its url");
  const [name, url] = pos;
  const bad = badInput(name, url, opt.note) ?? (opt.stop === undefined ? null : badStop(opt.stop));
  if (bad) return usage(bad);
  const ports = opt.ports === undefined ? undefined : parsePorts(opt.ports);
  if (typeof ports === "string") return usage(ports);
  const s = open();
  try {
    const c = caller(s, toplevel(), { project: opt.project === undefined ? undefined : dsLabel(opt.project), topic: opt.topic });
    if ("error" in c) { console.error(`ds expose: ${c.error}`); return c.code; }
    const closing = closingRefusal(s, c);
    if (closing) { console.error(`ds expose: ${closing.error}`); return closing.code; }
    print(expose(s, c, { name, url, note: opt.note, squad: flag.has("squad"), stop: opt.stop, self: flag.has("self"), ports }));
    return 0;
  } finally { s.close(); }
}
