// Internal recipient check for fan-out scripts: exit 0 when <project> <member worktree> is paused
// (or resuming), 1 when it is not. Read-only; a script outside a loop child has no pause, so it is 1.
import { paused } from "./pause.ts";
import { openReadOnly } from "../core/store.ts";

const [project, member] = process.argv.slice(2);
if (!process.env.DS_LOOP_ACTIVITY || !process.env.DS_STATE_ROOT || !project || !member) process.exit(1);
const store = openReadOnly();
try { process.exitCode = paused(store, { project, member }) ? 0 : 1; } finally { store.close(); }
