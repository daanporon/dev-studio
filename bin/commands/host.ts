// ds host — side-loop-host U1 (issue #127, KTD4): the side hosts that may run worker seats for main, on main.
// `list` shows them; `accept <name> [--seats N]` lets a pending join in (default 2 seats), `reject <name>` turns
// a pending join down, `remove <name>` deletes an accepted host's key. With no hosts and link_listen not `on`,
// `list` says to turn link_listen on so a first join can reach main's link server (U2). Same code as the board's Accept (U17):
// bin/link/host-keys.ts. A join request itself arrives over the link (U2), never through this command.
// U25 (KTD16): `set <host> <key> <value>`, `rm <host> <key>` and `show <host>` are the per-host overrides of the
// `[host]` keys of conventions/limits.conf (main is `local`); bin/loop/settings/host-settings.ts writes them.
import { now, open } from "../loop/core/store.ts";
import { linkListen, linkWish } from "../loop/fulfil/link.ts";
import { parse, print } from "../loop/core/cli.ts";
import { accept, hostLine, listHosts, reject, remove, linkListenHint } from "../link/host-keys.ts";
import { HostSettingsError, hostShow, knownHost, rmHostKey, setHostKey } from "../loop/settings/host-settings.ts";

export const help = "list [--all] [--json] | accept <name> [--seats N] | reject <name> | remove <name> | set <host> <key> <value> | rm <host> <key> | show <host> [--json] — side hosts that run worker seats (hosts rows) and each host's machine keys";

const USAGE = `usage: ds host list [--all] [--json]     (--all: removed hosts too)
       ds host accept <name> [--seats N]   (a pending join request; seats default 2)
       ds host reject <name>               (a pending join request)
       ds host remove <name>               (an accepted host: its key is deleted)
       ds host set <host> <key> <value>    (a [host] key of limits.conf for one host; main is local)
       ds host rm <host> <key>             (that host back to the repo default)
       ds host show <host> [--json]        (every [host] key: value and source env|host|default)`;

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
        if (listen !== "on") console.log(`link_listen is ${listen}: ${linkListenHint(linkWish(s, now()).port)}`);
        return 0;
      }
      for (const r of rows) console.log(hostLine(r));
      return 0;
    } finally { s.close(); }
  }
  if (verb === "set" || verb === "rm" || verb === "show") return hostKeysVerb(verb, pos, opt.seats !== undefined, flag, usage);
  if (verb !== "accept" && verb !== "reject" && verb !== "remove") return usage(verb ? `unknown subcommand '${verb}'` : "name one of list, accept, reject, remove, set, rm, show");
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

// U25: one host's machine keys. `set` joins the words after the key (disk_watch_paths is a list).
function hostKeysVerb(verb: "set" | "rm" | "show", pos: string[], seats: boolean, flag: Set<string>, usage: (w: string) => number): number {
  if (seats || flag.has("all")) return usage(`${verb} takes no --seats or --all`);
  if (verb !== "show" && flag.has("json")) return usage(`${verb} takes no --json`);
  const [, host, key] = pos;
  if (verb === "show" ? pos.length !== 2 : verb === "rm" ? pos.length !== 3 : pos.length < 4)
    return usage(verb === "show" ? "show takes one host" : verb === "rm" ? "rm takes a host and a key" : "set takes a host, a key and a value");
  const s = open();
  try {
    if (verb === "show") {
      if (!knownHost(s, host)) { console.error(`ds host: no host '${host}' (main is local)`); return 1; }
      const rows = hostShow(s, host);
      if (flag.has("json")) { print(rows); return 0; }
      for (const r of rows) console.log(`${r.key.padEnd(24)} ${(r.value ?? "-").padEnd(16)} ${r.source === "env" ? `env (${r.env})` : r.source ?? "unset"}`);
      return 0;
    }
    const by = process.env.DS_WHO || "ds";
    const changes = verb === "set" ? setHostKey(s, host, key, pos.slice(3).join(" "), by) : rmHostKey(s, host, key, by);
    if (!changes.length) { console.log(`${host} ${key}: no change`); return 0; }
    for (const c of changes) console.log(`${c.host} ${c.key}: ${c.old ?? "(default)"} -> ${c.new ?? "(default)"}`);
    return 0;
  } catch (e) {
    if (e instanceof HostSettingsError) { console.error(`ds host: ${e.message}`); return 1; }
    throw e;
  } finally { s.close(); }
}
