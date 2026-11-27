// side.ts — side-loop-host U12 (issue #127): what makes `main.ts --role side` this host's end of the link.
// `ds join` writes `<root>/link/host.json` ({main, name}, lib/loop-unit.ts); a root with that file is a side root, so
// `ds loop-ts` runs its loop as `--role side` and `ds install-ts` installs the side unit. `startSideLink`
// (the entry point, called once by main.ts) dials main and stays dialling (LinkClient), serves the relay
// socket agents' `ds` calls go through (relay.ts), and on each `tick()` and each reconnect syncs rows
// (replica.ts RowSync) and the plans and notes mirror (mirror.ts MirrorSync), in the background so a slow
// main never holds a loop tick. `<root>/link/status.json` says how the link stands; `ds join` reads it.
import { join } from "node:path";
import { readDoc, readSideConfig, writeDoc } from "../lib/loop-unit.ts";
import { LinkClient, type LinkState } from "./client.ts";
import { MirrorSync } from "./mirror.ts";
import { startRelay } from "./relay.ts";
import { RowSync } from "./replica.ts";
import type { Store } from "../loop/core/store.ts";

export type SideStatus = { state: LinkState; why: string; main: string; at: number; pid: number };

export const sideStatusPath = (root: string): string => join(root, "link", "status.json");
export const readSideStatus = (root: string): SideStatus | null => readDoc(sideStatusPath(root)) as SideStatus | null;

export type SideLink = { tick(): void; stop(): void };

/** Null on a root that joined no main (a side loop there only observes). */
export function startSideLink(store: Store, root: string, log: (line: string) => void = (l) => console.log(l)): SideLink | null {
  const cfg = readSideConfig(root);
  if (!cfg) return null;
  let stopped = false, busy = false, said = "";
  // A state that lasts across redials and ticks is logged once.
  const say = (line: string) => { if (line !== said) log((said = line)); };
  const request = (ch: string, body: unknown) => client.request(ch, body);
  const rows = new RowSync(store, request), mirror = new MirrorSync(root, request, log);
  const sync = async () => {
    if (busy || stopped || client.state !== "up") return;
    busy = true;
    for (const [what, part] of [["rows", () => rows.tick()], ["mirror", () => mirror.tick()]] as const) {
      try { await part(); } catch (e) { if (!stopped) say(`link: the ${what} sync failed: ${(e as Error).message}`); }
    }
    busy = false;
  };
  const client: LinkClient = new LinkClient({
    main: cfg.main, root, name: cfg.name, reconnect: true,
    onState: (state, why) => {
      if (state === "connecting") return;   // the last answer stands while it redials
      writeDoc(sideStatusPath(root), { state, why: why ?? "", main: cfg.main, at: Math.floor(Date.now() / 1000), pid: process.pid } satisfies SideStatus);
      if (state === "up") { rows.linkUp(); say(`link: connected to ${cfg.main} as ${cfg.name}`); void sync(); }
      else if (state !== "stopped") say(`link: ${why ?? state}`);
    },
  });
  const relay = startRelay(root, request);
  // A refusal or a lost first dial rejects; the client redials by itself, and onState has said why.
  client.start().catch((e) => say(`link: ${(e as Error).message}`));
  return {
    tick: () => { void sync(); },
    stop: () => { client.stop(); stopped = true; relay.stop(); },
  };
}
