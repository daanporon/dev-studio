// Internal child-script fence; no public lifecycle operation and no write to state.
import { gateBlock, type ActivityGate } from "./pause.ts";
import { openReadOnly } from "../core/store.ts";

const raw = process.env.DS_LOOP_ACTIVITY;
if (raw) {
  const store = openReadOnly();
  try {
    const gate = JSON.parse(raw) as ActivityGate;
    if (!Array.isArray(gate.targets)) throw new Error("invalid activity fence");
    const block = gateBlock(store, gate);
    if (block) { process.stderr.write(`activity: ${block}\n`); process.exitCode = 75; }
  } finally { store.close(); }
}
