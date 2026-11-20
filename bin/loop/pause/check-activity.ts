// Internal child-script fence; no public lifecycle operation and no write to state.
import { paused, version, pauseControlBlock, resumeAction, type Target } from "./pause.ts";
import type { Action } from "../core/plugins.ts";
import { openReadOnly } from "../core/store.ts";

const raw = process.env.DS_LOOP_ACTIVITY;
if (raw) {
  const store = openReadOnly();
  try {
    const gate = JSON.parse(raw) as { targets: Target[]; version: string; mail?: boolean; control?: Action; resume?: Action };
    if (!Array.isArray(gate.targets)) throw new Error("invalid activity fence");
    const block = gate.control?.kind === "pause-control" ? pauseControlBlock(store, gate.control) : gate.targets.some((t) => paused(store, t)) && !(gate.resume && resumeAction(store, gate.resume)) ? "paused"
      : !gate.mail && JSON.stringify(gate.targets.map((t) => version(store, t))) !== gate.version ? "generation changed" : null;
    if (block) { process.stderr.write(`activity: ${block}\n`); process.exitCode = 75; }
  } finally { store.close(); }
}
