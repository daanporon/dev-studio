// squad/contracts.ts — the contract backend a non-Orca squad runs on (U11, U12): one client per
// backend and project, shared by the actuator (starts, pokes, closes) and the contract observer
// (observers/contract.ts: lists, reads, state). tmux, orca-lite (U13) with its facts in
// <root>/<project>/loop/orca-lite-terminals.json, and herdr (U16c) with its server's files in
// <root>/<project>/loop/herdr/. The registry (bin/backend/registry.ts) starts a squad on a backend on
// trial only on its trial project (U16a). A test passes its fake as `make`. A member on a side host gets the
// remote adapter over that host's link (side-loop-host U4, bin/backend/remote.ts).
import { checked, type Backend, type Capabilities } from "../../backend/contract.ts";
import { projectTmux, TMUX_CAPS } from "../../backend/tmux.ts";
import { ORCA_LITE_CAPS, orcaLite } from "../../backend/orca-lite.ts";
import { HERDR_CAPS, projectHerdr } from "../../backend/herdr.ts";
import { remoteBackend } from "../../backend/remote.ts";
import { LOCAL_HOST } from "../../backend/registry.ts";
import type { Store } from "../core/store.ts";
import type { Orca } from "../io/orca.ts";
import { join } from "node:path";

export type Contracted = { backend: Backend; caps: Capabilities };
export type MakeContract = (name: string, project: string, store: Store) => Contracted;
/** A test's remote adapter for `host` (unchecked; the resolver wraps it). */
export type MakeRemote = (host: string, name: string, project: string, store: Store) => Backend;
/** The backend `name` of `project` for a member on `host` (default `local`). */
export type Resolve = (store: Store, name: string, project: string, host?: string) => Contracted;

/** The contract backend `name` of `project` under state root `root`, checked: tmux, orca-lite (on `orca`, else the
 *  adapter in process) or herdr. Throws for a backend the loop has no adapter for. A side host's `contract` link
 *  channel (bin/link/channels/contract.ts) makes its own terminals with it too. */
export function makeContract(root: string, name: string, project: string, orca?: Orca): Backend {
  if (name === "tmux") return checked(projectTmux(project, { stateRoot: root }));
  if (name === "orca-lite") return checked(orcaLite({ orca, keep: join(root, project, "loop", "orca-lite-terminals.json") }));
  if (name === "herdr") return checked(projectHerdr(project, { stateRoot: root }));
  throw new Error(`backend ${name}: the loop has no adapter for it`);
}

/** The capabilities of backend `name` (the same on every host, so a remote one reads them here). */
export function capsOf(name: string): Capabilities {
  if (name === "tmux") return TMUX_CAPS;
  if (name === "orca-lite") return ORCA_LITE_CAPS;
  if (name === "herdr") return HERDR_CAPS;
  throw new Error(`backend ${name}: the loop has no adapter for it`);
}

function made(name: string, project: string, store: Store, orca?: Orca): Contracted {
  return { backend: makeContract(store.root, name, project, orca), caps: capsOf(name) };
}

/** A resolver that makes each backend once per state root, project and host; `make` (a test's fake) wins for host
 *  `local`. orca-lite runs on `orca` (an actuator's runner), else the adapter in process. A member on a side host
 *  (`host` not `local`, side-loop-host U4) gets the remote adapter (bin/backend/remote.ts): its ops go down that
 *  host's link and its side answers them with its own backend; `remote` (a test's) replaces that adapter. */
export function contracts(make?: MakeContract, orca?: Orca, remote?: MakeRemote): Resolve {
  const kept = new Map<string, Contracted>();
  return (store, name, project, host = LOCAL_HOST) => {
    const k = `${store.root}\t${name}\t${project}\t${host}`;
    let c = kept.get(k);
    if (!c) {
      if (host === LOCAL_HOST) c = make?.(name, project, store) ?? made(name, project, store, orca);
      else {
        const caps = capsOf(name);
        c = { backend: checked(remote?.(host, name, project, store) ?? remoteBackend({ root: store.root, host, backend: name, project })), caps };
      }
      kept.set(k, c);
    }
    return c;
  };
}

/** The process-wide resolver: the actuator and the observer share one client per backend and project. */
export const sharedContracts = contracts();
