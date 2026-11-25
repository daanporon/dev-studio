// worktrees.ts — keeps the `worktrees` table (orca-backend-alternatives U5) in step with the worktrees
// the loop knows: members, the Studio and Orca's list (bin/loop/squad/worktrees.ts syncWorktrees). Host
// scope, every DS_LOOP_WORKTREES_S (30 s); the file sorts after orca.ts, so it reads that tick's
// observed_worktrees. A steady state writes nothing. Nothing reads the table yet.
import type { Observer } from "../core/plugins.ts";
import { envInt } from "../core/tick.ts";
import { syncWorktrees } from "../squad/worktrees.ts";

const worktrees: Observer = {
  name: "worktrees",
  scope: "host",
  every: envInt("DS_LOOP_WORKTREES_S", 30),
  run({ store, now }) { syncWorktrees(store, now); },
};
export default worktrees;
