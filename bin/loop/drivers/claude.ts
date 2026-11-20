// drivers/claude.ts — Claude Code. --model on every launch (never /model); resume is `claude
// --continue` in the member's worktree (backend worker-resume), on the account the handoff chose.
import { ROOT } from "../core/store.ts";
import { HOSTING_ROLES, RESTART_HOSTING_NOTE } from "../squad/handoff.ts";
import { failed, pokeVia, standingNote, startVia, stopVia, windowOf, type Driver, type DriverModule, type Seat } from "./types.ts";

// Menus Claude Code stops on, and the key that answers each: the usage-limit dialog ("1. Stop and
// wait" — the loop moves the session itself) and the folder-trust prompt ("1. Yes, proceed").
const MENUS: [RegExp, string][] = [
  [/What do you want to do\?[\s\S]*1\. Stop and wait/, "1"],
  [/Do you trust the files in this folder\?[\s\S]*1\. Yes, proceed/, "1"],
];

function resumeSpec(role: string, run: string): string {
  return `You were restarted with your conversation kept. Re-read ${ROOT}/roles/${role}.md (it may have changed), check the squad state file and your inbox, then carry on where you left off.${standingNote(role)}${HOSTING_ROLES.includes(role) ? ` ${RESTART_HOSTING_NOTE}` : ""} Squad run=${run}.`;
}

export const claude: DriverModule = {
  agent: "claude",
  resumes: true,
  make(seat: Seat): Driver {
    return {
      start: (m, model, account, prompt) => startVia(seat, "claude", m, model, account, prompt),
      async resume(m) {
        const run = seat.squad.run_id;
        if (!run || !m.wt || !m.model) return { ok: false, error: "resume needs a run, a worktree and a model" };
        const o = await seat.call("worker-resume", [run, m.wt, resumeSpec(m.role, run), m.model, m.account || "-", "claude", windowOf(seat, m.role), m.role]);
        return o.code === 0 ? { ok: true, wt: m.wt } : failed(o, "worker-resume");
      },
      poke: (m, text) => pokeVia(seat, m, text),
      stop: (make, m, run, keep) => stopVia(make, m, run, keep),
      answerMenu: (screen) => MENUS.find(([re]) => re.test(screen))?.[1] ?? null,
    };
  },
};
export default claude;
