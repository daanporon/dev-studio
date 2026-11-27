// arm-picker-ts.ts — bin/hooks/arm-picker.sh, ported (U190): merge the picker-mirror hooks (the
// AskUserQuestion pair and the PermissionRequest one, for safety-check prompts) and the
// broad-kill Bash guard into a role worktree's .claude/settings.local.json. bin/hooks/arm-picker.sh
// runs it (U193: the only body). Same arguments, output, exit codes and settings.
import { join } from "node:path";
import { ROOT, writeErr, writeOut } from "../lib/shared";
import { isDir, mergeSettings, setKey, worktreePath } from "../lib/lib";

export const help = "arm-picker-ts <worktree_id> <state> <role> — arm the picker hooks (bin/hooks/arm-picker.sh)";

/** jq `.k` (null for null, an error for a non-object). */
function get(o: any, k: string): any {
  if (o === null || o === undefined) return null;
  if (typeof o !== "object" || Array.isArray(o)) throw new Error(`cannot index ${k}`);
  return o[k] ?? null;
}
/** jq `x // d`. */
const or = (x: any, d: any) => (x === null || x === false ? d : x);
/** jq `map(f)`: over an array's or an object's values. */
function map(v: any, f: (x: any) => any): any[] {
  if (Array.isArray(v)) return v.map(f);
  if (v !== null && typeof v === "object") return Object.values(v).map(f);
  throw new Error("cannot iterate");
}

/** jq `def strip`: drop our own hook commands (starting with one of `prefixes`), then the entries left with none. */
export function strip(entries: any, prefixes: string[]): any[] {
  return map(entries, (e) => setKey(e, "hooks", map(or(get(e, "hooks"), []), (h) => h).filter((h) => {
    const c = or(get(h, "command"), "");
    if (typeof c !== "string") throw new Error("startswith of a non-string");
    return !prefixes.some((p) => c.startsWith(p));
  }))).filter((e) => e.hooks.length > 0);
}

/** Merge the picker hooks and the broad-kill guard into the settings of the worktree folder `path`; `wt` is the id the
 *  hooks name. Prints nothing: `rc` is mergeSettings' exit code, `pre` the armed PreToolUse command. */
export function armPicker(path: string, STATE: string, ROLE: string, WT: string): { rc: number; pre: string } {
  const self = join(ROOT, "bin", "hooks", "picker-hook.sh");
  const pre = `${self} pre ${STATE} ${ROLE} ${WT}`, post = `${self} post ${STATE} ${ROLE} ${WT}`;
  const permission = `${self} permission ${STATE} ${ROLE} ${WT}`;
  const guard = join(ROOT, "bin", "hooks", "no-broad-kill-hook.sh");
  const mine = [self, join(ROOT, "bin", "picker-hook.sh")], guards = [guard, join(ROOT, "bin", "no-broad-kill-hook.sh")];
  const rc = mergeSettings(path, (s) => {
    const preHooks = strip(strip(or(get(get(s, "hooks"), "PreToolUse"), []), mine), guards);
    s = setKey(s, "hooks", setKey(get(s, "hooks"), "PreToolUse", [...preHooks,
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: pre, timeout: 15 }] },
      { matcher: "Bash", hooks: [{ type: "command", command: guard, timeout: 5 }] }]));
    const postHooks = strip(or(get(s.hooks, "PostToolUse"), []), mine);
    s = setKey(s, "hooks", setKey(s.hooks, "PostToolUse", [...postHooks,
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: post, timeout: 15 }] }]));
    const askHooks = strip(or(get(s.hooks, "PermissionRequest"), []), mine);
    return setKey(s, "hooks", setKey(s.hooks, "PermissionRequest", [...askHooks,
      { matcher: "*", hooks: [{ type: "command", command: permission, timeout: 15 }] }]));
  });
  return { rc, pre };
}

export async function run(argv: string[]): Promise<number> {
  if (argv.length !== 3) { writeErr("usage: arm-picker.sh <worktree_id> <state> <role>\n"); return 2; }
  const [WT, STATE, ROLE] = argv;
  const path = await worktreePath(WT);
  if (!path || !isDir(path)) {
    writeErr(`arm-picker: no local path for worktree ${WT} (remote host?) — not arming\n`);
    return 0;
  }
  const { rc, pre } = armPicker(path, STATE, ROLE, WT);
  if (rc !== 0) return rc;
  writeOut(`armed picker PreToolUse/PostToolUse/PermissionRequest hooks + broad-kill Bash guard in ${join(path, ".claude", "settings.local.json")} -> ${pre}\n`);
  return 0;
}
