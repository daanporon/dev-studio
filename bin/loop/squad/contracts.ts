// squad/contracts.ts — the contract backend a non-Orca squad runs on (U11, U12): one client per
// backend and project, shared by the actuator (starts, pokes, closes) and the contract observer
// (observers/contract.ts: lists, reads, state). tmux is the only adapter today; orca-lite and herdr
// have none yet (bin/backend/registry.ts). A test passes its fake as `make`.
import { checked, type Backend, type Capabilities } from "../../backend/contract.ts";
import { projectTmux, TMUX_CAPS } from "../../backend/tmux.ts";
import type { Store } from "../core/store.ts";

export type Contracted = { backend: Backend; caps: Capabilities };
export type MakeContract = (name: string, project: string, store: Store) => Contracted;

function made(name: string, project: string, store: Store): Contracted {
  if (name === "tmux") return { backend: checked(projectTmux(project, { stateRoot: store.root })), caps: TMUX_CAPS };
  throw new Error(`backend ${name}: the loop has no adapter for it`);
}

/** A resolver that makes each backend once per state root and project; `make` (a test's fake) wins. */
export function contracts(make?: MakeContract): (store: Store, name: string, project: string) => Contracted {
  const kept = new Map<string, Contracted>();
  return (store, name, project) => {
    const k = `${store.root}\t${name}\t${project}`;
    let c = kept.get(k);
    if (!c) {
      c = make?.(name, project, store) ?? made(name, project, store);
      kept.set(k, c);
    }
    return c;
  };
}

/** The process-wide resolver: the actuator and the observer share one tmux client per project. */
export const sharedContracts = contracts();
