// squad/contracts.ts — the contract backend a non-Orca squad runs on (U11, U12): one client per
// backend and project, shared by the actuator (starts, pokes, closes) and the contract observer
// (observers/contract.ts: lists, reads, state). tmux, and orca-lite (U13) with its facts in
// <root>/<project>/loop/orca-lite-terminals.json; herdr has no adapter here yet, and the registry
// (bin/backend/registry.ts) still refuses a spawn on orca-lite or herdr. A test passes its fake as `make`.
import { checked, type Backend, type Capabilities } from "../../backend/contract.ts";
import { projectTmux, TMUX_CAPS } from "../../backend/tmux.ts";
import { ORCA_LITE_CAPS, orcaLite } from "../../backend/orca-lite.ts";
import type { Store } from "../core/store.ts";
import type { Orca } from "../io/orca.ts";
import { join } from "node:path";

export type Contracted = { backend: Backend; caps: Capabilities };
export type MakeContract = (name: string, project: string, store: Store) => Contracted;

function made(name: string, project: string, store: Store, orca?: Orca): Contracted {
  if (name === "tmux") return { backend: checked(projectTmux(project, { stateRoot: store.root })), caps: TMUX_CAPS };
  if (name === "orca-lite") return { backend: checked(orcaLite({ orca, keep: join(store.root, project, "loop", "orca-lite-terminals.json") })), caps: ORCA_LITE_CAPS };
  throw new Error(`backend ${name}: the loop has no adapter for it`);
}

/** A resolver that makes each backend once per state root and project; `make` (a test's fake) wins.
 *  orca-lite runs on `orca` (an actuator's runner), else the adapter in process. */
export function contracts(make?: MakeContract, orca?: Orca): (store: Store, name: string, project: string) => Contracted {
  const kept = new Map<string, Contracted>();
  return (store, name, project) => {
    const k = `${store.root}\t${name}\t${project}`;
    let c = kept.get(k);
    if (!c) {
      c = make?.(name, project, store) ?? made(name, project, store, orca);
      kept.set(k, c);
    }
    return c;
  };
}

/** The process-wide resolver: the actuator and the observer share one client per backend and project. */
export const sharedContracts = contracts();
