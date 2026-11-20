// board-fulfil.ts — tests/board.sh's "next tick" after the served board wrote (Bun): one loop tick
// over DS_STATE_ROOT's loop.db that runs the fulfillers alone (no observers), so the board's
// requests rows are done the way the loop does them. BACKEND is the fake backend.
//
//   DS_STATE_ROOT=<root> BACKEND=<fake> bun tests/board-fulfil.ts <label>
import { LoopActuator, type Fulfiller } from "../bin/loop/core/actuator.ts";
import { DIRS, load, type Reconciler } from "../bin/loop/core/plugins.ts";
import { now, open } from "../bin/loop/core/store.ts";
import { Loop } from "../bin/loop/core/tick.ts";

const [label = ""] = process.argv.slice(2);
const s = open();
const fulfillers = (await load<Fulfiller & Reconciler>(DIRS.fulfil)).filter((f) => f.kinds);
const act = new LoopActuator({ fulfillers });
const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => [label] });
loop.boot(now());
await loop.tick(now());
await act.drain();
s.close();
