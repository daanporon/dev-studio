// fulfil/finish.ts — kind `finish-unit`: the request finish-unit.sh writes on a migrated state root
// (U13b). The loop runs it again with DS_LOOP_CHILD=1 in the Builder's worktree and as the Builder's
// terminal, so the PR lookup, the gate and worker-done go as when the Builder ran it (replay.ts).
import { requests } from "../messages/replay.ts";

export default requests("finish", ["finish-unit"]);
