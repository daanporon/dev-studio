// arm-rewake-ts.ts — bin/hooks/arm-rewake.sh, ported (U190): set the rewake Stop hook in a standing
// agent's worktree .claude/settings.local.json. bin/hooks/arm-rewake.sh runs it (U193: the only body).
// Same arguments, output, exit codes and settings.
import { join } from "node:path";
import { ROOT, writeErr, writeOut } from "../lib/shared";
import { isDir, mergeSettings, setKey, worktreePath } from "../lib/lib";

export const help = "arm-rewake-ts <worktree_id> [--] <watch-args…> — arm the rewake Stop hook (bin/hooks/arm-rewake.sh)";

export async function run(argv: string[]): Promise<number> {
  if (argv.length < 1) { writeErr("usage: arm-rewake.sh <worktree_id> -- <watch-args...>\n"); return 2; }
  const [WT, ...rest] = argv;
  const args = rest[0] === "--" ? rest.slice(1) : rest; // optional separator before the watch args
  if (args.length < 1) { writeErr("arm-rewake: no watch args given (what should this agent watch?)\n"); return 2; }
  const path = await worktreePath(WT);
  if (!path || !isDir(path)) {
    writeErr(`arm-rewake: no local path for worktree ${WT} (remote host?) — not arming\n`);
    return 0;
  }
  const cmd = `${join(ROOT, "bin", "hooks", "rewake-hook.sh")} ${args.join(" ")}`; // watch args are simple tokens
  // asyncRewake + 8h: the hook runs after the turn ends and its exit 2 wakes the idle session.
  const rc = mergeSettings(path, (s) => {
    if (s !== null && (typeof s !== "object" || Array.isArray(s))) throw new Error("index"); // jq: cannot index
    return setKey(s, "hooks", setKey(s?.hooks ?? null, "Stop", [{ hooks: [{ type: "command", command: cmd, asyncRewake: true, timeout: 28800 }] }]));
  });
  if (rc !== 0) return rc;
  writeOut(`armed rewake Stop hook in ${join(path, ".claude", "settings.local.json")} -> ${cmd}\n`);
  return 0;
}
