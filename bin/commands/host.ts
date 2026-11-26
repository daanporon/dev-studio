// ds host — side-loop-host U1 (issue #127, KTD4): the side hosts that may run worker seats for main, on main.
// `list` shows them; `accept <name> [--seats N]` lets a pending join in (default 2 seats), `reject <name>` turns
// a pending join down, `remove <name>` deletes an accepted host's key. With no hosts and link_listen not `on`,
// `list` says to turn link_listen on so a first join can reach main's link server (U2). Same code as the board's Accept (U17):
// bin/link/host-keys.ts. A join request itself arrives over the link (U2), never through this command.
import { now, open } from "../loop/core/store.ts";
import { linkListen, linkWish } from "../loop/fulfil/link.ts";
import { parse, print } from "../loop/core/cli.ts";
import { accept, hostLine, listHosts, reject, remove } from "../link/host-keys.ts";

export const help = "list [--all] [--json] | accept <name> [--seats N] | reject <name> | remove <name> — side hosts that run worker seats (hosts rows)";

const USAGE = `usage: ds host list [--all] [--json]     (--all: removed hosts too)
       ds host accept <name> [--seats N]   (a pending join request; seats default 2)
       ds host reject <name>               (a pending join request)
       ds host remove <name>               (an accepted host: its key is deleted)`;

export async function run(args: string[]): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(USAGE); return args.length ? 0 : 2; }
  const usage = (why: string) => { console.error(`ds host: ${why}\n${USAGE}`); return 2; };
  let p: ReturnType<typeof parse>;
  try { p = parse(args, ["seats"], ["json", "all"]); } catch (e) { return usage((e as Error).message); }
  const { pos, opt, flag } = p;
  const verb = pos[0];
  if (verb === "list") {
    if (pos.length !== 1 || opt.seats !== undefined) return usage("list takes only --all and --json");
    const s = open();
    try {
      const rows = listHosts(s, { all: flag.has("all") });
      if (flag.has("json")) { print(rows); return 0; }
      if (!rows.length) {
        console.log("no side hosts (a side host asks to join with `ds join <main-url>`)");
        const listen = linkListen(s);
        if (listen !== "on") console.log(`link_listen is ${listen}: main's link server is not running, so a first join cannot reach it (port ${linkWish(s, now()).port}); turn it on with \`ds config set <project> limits.conf link_listen on\``);
        return 0;
      }
      for (const r of rows) console.log(hostLine(r));
      return 0;
    } finally { s.close(); }
  }
  if (verb !== "accept" && verb !== "reject" && verb !== "remove") return usage(verb ? `unknown subcommand '${verb}'` : "name one of list, accept, reject, remove");
  if (pos.length !== 2) return usage(`${verb} takes one host name`);
  if (flag.has("all") || flag.has("json")) return usage(`${verb} takes no --all or --json`);
  if (verb !== "accept" && opt.seats !== undefined) return usage("--seats is for accept");
  if (opt.seats !== undefined && !/^\d+$/.test(opt.seats)) return usage(`--seats is a whole number, not '${opt.seats}'`);
  const seats = opt.seats === undefined ? undefined : Number(opt.seats);
  const by = process.env.DS_WHO || "ds";
  const s = open();
  try {
    const r = verb === "accept" ? accept(s, pos[1], { seats, by }) : verb === "reject" ? reject(s, pos[1], { by }) : remove(s, pos[1], { by });
    if (!r.ok) { console.error(`ds host: ${r.why}`); return 1; }
    const h = r.host;
    console.log(verb === "accept" ? `host ${h.name} accepted with ${h.seats} seats (fingerprint ${h.fingerprint})`
      : verb === "reject" ? `host ${h.name}: join request rejected` : `host ${h.name} removed: its key is deleted`);
    return 0;
  } finally { s.close(); }
}
