// close-busy.ts (U203) — the one "is this member busy?" test for a close, shared by decide.ts
// (`closeOK`) and fulfil/close.ts (`stale`) so the two cannot drift.
// Busy = Orca's worker state `working` or `waiting`. One exception: the close comes from the
// member's finished unit (the unit-derived stopped/archived view), its state is `working`, and its
// newest transcript's turn has ended (no foreground tool call open). Claude reports `working` while
// a background shell it started still runs, even at its prompt; background tasks do not count here.
// An unreadable or missing transcript counts as busy; `waiting` is always busy.
import { view } from "./member-state.ts";
import { foregroundOpen } from "../reconcilers/liveness.ts";
import type { Row, Store } from "../core/store.ts";

export function closeBusy(store: Store, m: Row): boolean {
  const state = String((m.wt ? store.get("observed_workers", { project: m.project, wt: m.wt })?.state : "") ?? "");
  if (!["working", "waiting"].includes(state)) return false;
  if (state !== "working") return true;
  const v = view(store, m);
  if (v !== "stopped" && v !== "archived") return true;
  return foregroundOpen(store, String(m.wt)) !== false;
}
