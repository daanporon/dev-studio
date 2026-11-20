// ds restart-role-ts — recycle one worker in place (U191): what bin/commands/restart-role.sh runs.
// A restart is a wish the loop acts on (`ds want member … --restart now`); no backend call on any path.
import { dsLabel, backend, chomp, writeErr } from "../lib/shared";
import { inherit, dsBin } from "../lib/upkeep";

export const help = `<project> <topic> <role> [suffix] [--wt <worktree_id>] — restart one worker in place (restart-role.sh)`;

const USAGE = "usage: restart-role.sh <project> <topic> <role> [suffix] [--wt <worktree_id>] [--resume] [--account <id>] [--agent <a>] [--model <m>] [--effort <e>] [--limited <agent>:<account>=<epoch>] [--phase <p>]";

/** ds_loop_args: drop `--wait <s>`, keep the rest; after `--` everything stays. */
function stripWait(argv: string[]): string[] | null {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--wait") { if (i + 1 >= argv.length) { writeErr("restart-role.sh: --wait needs seconds\n"); return null; } i++; continue; }
    if (argv[i] === "--") { out.push(...argv.slice(i)); break; }
    out.push(argv[i]);
  }
  return out;
}

/** quiet: the wish's JSON goes to /dev/null (restart-squads ran restart-role with >/dev/null). */
export async function run(rawArgv: string[], quiet = false): Promise<number> {
  const argv = stripWait(rawArgv);
  if (!argv) return 2;
  const pos: string[] = [];
  let wt = "", agentEtc = "", accountSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string | undefined => { const v = argv[i + 1]; i++; return v; };
    switch (a) {
      case "--wt": { const v = val(); if (v === undefined) { writeErr("restart-role.sh: $2: unbound variable\n"); return 1; } wt = v; break; }
      case "--resume": break;
      case "--account": { if (val() === undefined) { writeErr("restart-role.sh: $2: unbound variable\n"); return 1; } accountSet = true; break; }
      case "--agent": case "--model": case "--effort": { const v = val(); if (v === undefined) { writeErr("restart-role.sh: $2: unbound variable\n"); return 1; } agentEtc += v; break; }
      case "--phase": case "--limited": { if (val() === undefined) { writeErr("restart-role.sh: $2: unbound variable\n"); return 1; } break; }
      default:
        if (pos.length >= 4) { writeErr(`restart-role: unexpected arg '${a}'\n`); return 2; }
        pos.push(a);
    }
  }
  if (pos.length < 3) { writeErr(USAGE + "\n"); return 2; }
  const [project, topic, role, suffix = ""] = pos;
  if (agentEtc !== "" || accountSet) {
    writeErr("restart-role: --agent/--model/--effort/--account are gone (U153) — pin with: bin/ds want member <id> --model <m> --account <a>\n");
    return 2;
  }
  const label = dsLabel(project);
  // A worker can't restart its own worktree: the loop's stop would kill this terminal.
  if (wt !== "" && (process.env.ORCA_TERMINAL_HANDLE ?? "") !== "") {
    const cur = chomp((await backend(["current"])).out);
    if (cur !== "" && cur === wt) {
      writeErr(`restart-role: that worktree is THIS terminal (${wt}) — a worker can't restart itself. Run it from the Studio.\n`);
      return 1;
    }
  }
  const mid = wt !== "" ? wt : `${label}/${topic}/${role}${suffix ? "/" + suffix : ""}`;
  const cmd = [dsBin(), "want", "member", mid, "--restart", "now", "--by", "restart-role", "--why", `restart-role ${topic}/${role}${suffix ? "/" + suffix : ""}`];
  if (!quiet) return inherit(cmd);
  return await Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "inherit" }).exited;
}
