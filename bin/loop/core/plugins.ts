// plugins.ts — what plugs into the loop and how it is found (Bun). A unit adds an observer, a
// reconciler or a fulfiller by dropping a file in its directory (KTD14); nothing lists them:
//   bin/loop/observers/*.ts     export default { name, every?, scope?, run(ctx) }          facts into rows
//   bin/loop/reconcilers/*.ts   export default { name, scope?, run(ctx) => Action[] }       rows into actions
//   bin/loop/fulfil/*.ts        the same shape as a reconciler; wishes into actions
// Each kind runs in filename order. `scope: "host"` runs once per tick with project "", the default
// "project" once per discovered project. A side host's loop (role `side`) loads only what side-plugins.ts names
// and never the decider (side-loop-host U3).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";
import type { Timer } from "./timers.ts";
import { SIDE_ONLY, SIDE_PLUGINS } from "./side-plugins.ts";

export const DIRS = {
  observers: join(import.meta.dir, "..", "observers"),
  reconcilers: join(import.meta.dir, "..", "reconcilers"),
  fulfil: join(import.meta.dir, "..", "fulfil"),
};

// Read by the Orca observer this tick; absent = unknown, and a step reads Orca itself (U244).
export type TickFacts = { unreadRuns?: Set<string>; terminalHandles?: Set<string> };

/** `main` decides; `side` (`main.ts --role side`) runs terminals and local reads for main. */
export type Role = "main" | "side";

export type TickCtx = {
  role?: Role;            // absent = main
  store: Store;
  project: string;        // "" for a host-scope plugin
  tick: number;           // health.tick_no of this tick
  now: number;            // epoch seconds the tick runs at
  fired: Timer[];         // timers that came due this tick
  poked: Set<string>;     // members wake() sent to this tick (one poke per member per tick)
  facts?: TickFacts;      // what the Orca observer read this tick, for later steps to skip a read (U244)
};

// What a reconciler decided. The loop hands each to the actuator once per (project, subject, kind)
// episode: the same episode again is a no-op, a new one replaces it.
export type Action = {
  project: string;
  squad?: string | null;
  member?: string | null;
  subject: string;
  kind: string;
  episode: string;
  payload?: unknown;
  pauseVersion?: string; // eligibility at enqueue time; persisted with pending actions
};

export type Scope = "project" | "host";
export type Observer = { name: string; every?: number; scope?: Scope; run(ctx: TickCtx): void | Promise<void> };
export type Reconciler = { name: string; scope?: Scope; run(ctx: TickCtx): Action[] | void | Promise<Action[] | void> };
// seats: once a tick per project, before its actions are acted (the loop takes back its Runs' seats, U59).
export type Actuator = { act(action: Action, ctx: TickCtx): unknown; seats?(ctx: TickCtx): unknown;
  ready?(action: Action, ctx: TickCtx): boolean | Promise<boolean>;
  takeTimes?(): Map<string, number>;
  takeDeferred?(): Map<string, number> };   // U249: background actions turned down this tick, by kind   // ms per `actuator:<kind>` since the last call (U239)

// The plugins in `dir`, by filename. A module exports its plugin as default (or as named exports). With
// `only` (file names without `.ts`) no other file is imported, and a name with no file is an error; a file named in
// `except` is never imported (a main loop leaves out the side-only plugins, side-plugins.ts SIDE_ONLY).
export async function load<T extends { name: string }>(dir: string, only?: readonly string[], except: readonly string[] = []): Promise<T[]> {
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !except.includes(f.slice(0, -3))).sort(); } catch { if (!only?.length) return []; }
  if (only) {
    const missing = only.filter((n) => !files.includes(`${n}.ts`));
    if (missing.length) throw new Error(`loop: ${dir} has no plugin file for ${missing.join(", ")}`);
    files = files.filter((f) => only.includes(f.slice(0, -3)));
  }
  const out: T[] = [];
  for (const f of files) {
    const m = await import(join(dir, f));
    const p = (m.default ?? m) as T & { run?: unknown };
    if (typeof p.run !== "function" || typeof p.name !== "string") throw new Error(`loop: ${join(dir, f)} exports no { name, run }`);
    out.push(p);
  }
  return out;
}

export type Plugins = { observers: Observer[]; reconcilers: Reconciler[] };

export async function loadAll(dirs = DIRS, role: Role = "main"): Promise<Plugins> {
  if (role === "side") {
    return {
      observers: await load<Observer>(dirs.observers, SIDE_PLUGINS.observers),
      reconcilers: [...await load<Reconciler>(dirs.reconcilers, SIDE_PLUGINS.reconcilers), ...await load<Reconciler>(dirs.fulfil, SIDE_PLUGINS.fulfil)],
    };
  }
  return {
    observers: await load<Observer>(dirs.observers, undefined, SIDE_ONLY.observers),
    // The decider first (U152): it compares wishes with what the observers just saw, before any
    // reconciler or fulfiller acts on the tick.
    reconcilers: [(await import("./decide.ts")).default as Reconciler, ...await load<Reconciler>(dirs.reconcilers, undefined, SIDE_ONLY.reconcilers), ...await load<Reconciler>(dirs.fulfil, undefined, SIDE_ONLY.fulfil)],
  };
}
