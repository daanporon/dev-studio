// host-settings.ts — side-loop-host U25 (issue #127, KTD16): the one writer of the per-host overrides of the machine
// keys (`host_config`, migration 0063). The keys are the `[host]` ones of conventions/limits.conf; the lookup is
// bin/lib/host-settings.ts. Each change writes its row and one `config_history` row (project '', file limits.conf,
// `host` set) in one transaction, as a project's change does (settings.ts). Callers: `ds host set|rm|show` and
// `ds host accept` (a new side host gets seats and its brake on). A side host reads its own rows from the settings
// copy (bin/link/replica.ts), never writes them.
import { limitValueProblem } from "../../lib/operator.ts";
import { hostKeys, hostLine, isHostKey, SELF, type HostLine } from "../../lib/host-settings.ts";
import { limitEnv } from "./limits.ts";
import { SHELL_ONLY_LIMITS } from "./settings.ts";
import { now as clock, type Store } from "../core/store.ts";

export class HostSettingsError extends Error {}
const fail = (m: string): never => { throw new HostSettingsError(m); };

/** A side host's own defaults, written on accept (KTD16): main's brake default is the repo's `off`, a side host's `on`. */
export const SIDE_DEFAULTS: Record<string, string> = { builder_host_brake: "on" };

export interface HostChange { host: string; key: string; old: string | null; new: string | null }

/** Main (`local`) or a side host that is not removed. */
export function knownHost(store: Store, host: string): boolean {
  if (host === SELF) return true;
  const r = store.db.query("SELECT status FROM hosts WHERE name = ?").get(host) as { status: string } | null;
  return !!r && r.status !== "removed";
}

function checkKey(key: string): void {
  if (!isHostKey(key)) fail(`${key} is not a host key (host keys: ${hostKeys().join(" ")}); a project's limit is set with: ds limits set <project> ${key} <value>`);
}

function checkValue(key: string, v: string): string {
  if (!v) fail(`${key} needs a value`);
  if (key === "seats" && !/^\d+$/.test(v)) fail(`seats is a whole number, 0 or more (got '${v}')`);
  if (key === "host_tidy" && !["report", "apply"].includes(v)) fail(`host_tidy must be report or apply (got '${v}')`);
  // A glob or path list is kept whole; its reader checks each entry (cleanupGlobs, watchPaths), as an import does.
  if ((SHELL_ONLY_LIMITS as readonly string[]).includes(key)) return v;
  const problem = limitValueProblem(key, v);
  if (problem) fail(problem);
  return v;
}

const rowOf = (store: Store, host: string, key: string): string | null =>
  (store.db.query("SELECT value FROM host_config WHERE host = ? AND key = ?").get(host, key) as { value: string } | null)?.value ?? null;

function write(store: Store, host: string, key: string, value: string | null, actor: string, at: number): HostChange | null {
  const old = rowOf(store, host, key);
  if (old === value) return null;
  if (value === null) store.db.run("DELETE FROM host_config WHERE host = ? AND key = ?", [host, key]);
  else store.db.run("INSERT INTO host_config (host, key, value, set_at) VALUES (?, ?, ?, ?) ON CONFLICT (host, key) DO UPDATE SET value = excluded.value, set_at = excluded.set_at", [host, key, value, at]);
  // hosts.seats (migration 0060) follows the seats override, so the two never disagree.
  if (key === "seats" && host !== SELF) store.db.run("UPDATE hosts SET seats = ? WHERE name = ?", [Number(value ?? hostLine(store.db, host, "seats").value ?? 2), host]);
  store.db.run("INSERT INTO config_history (project, file, key, old_value, new_value, actor, at, host) VALUES ('', 'limits.conf', ?, ?, ?, ?, ?, ?)",
    [key, old, value, actor, at, host]);
  return { host, key, old, new: value };
}

/** Set one host key's override for `host`. Refuses an unknown host, a key without host scope and a bad value. */
export function setHostKey(store: Store, host: string, key: string, value: string, actor: string, at = clock()): HostChange[] {
  if (!knownHost(store, host)) fail(`no host '${host}' (main is local; side hosts: ds host list)`);
  checkKey(key);
  const v = checkValue(key, value.trim().split(/\s+/).join(" "));
  return store.tx(() => { const c = write(store, host, key, v, actor, at); return c ? [c] : []; });
}

/** Drop one override: the host goes back to the repo default. Nothing to drop is no change and no history row. */
export function rmHostKey(store: Store, host: string, key: string, actor: string, at = clock()): HostChange[] {
  checkKey(key);
  return store.tx(() => { const c = write(store, host, key, null, actor, at); return c ? [c] : []; });
}

/** A new side host's rows (`ds host accept`): its seats and its own defaults (SIDE_DEFAULTS), inside the caller's tx. */
export function acceptDefaults(store: Store, host: string, seats: number, actor: string, at = clock()): void {
  write(store, host, "seats", String(seats), actor, at);
  for (const [k, v] of Object.entries(SIDE_DEFAULTS)) if (rowOf(store, host, k) === null) write(store, host, k, v, actor, at);
}

/** Every host key for `host` with its value and source (env only for this host: main cannot see a side host's env). */
export function hostShow(store: Store, host: string): HostLine[] {
  return hostKeys().map((k) => hostLine(store.db, host, k, limitEnv(k)));
}

/** A host's rows go with the host (`ds host remove`): the history keeps them. */
export function dropHost(store: Store, host: string, actor: string, at = clock()): void {
  if (host === SELF) return;
  for (const r of store.db.query("SELECT key FROM host_config WHERE host = ?").all(host) as { key: string }[]) write(store, host, r.key, null, actor, at);
}
