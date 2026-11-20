// handoff.ts — how a member moves to a new session (R23, §5b): one function, one table.
// U154: every switch below is reached only through the decider (decide.ts, switches.ts): it stops
// the member when idle, and the start's pick lands it on the new place, briefed fresh here.
//
//   why       what the loop knows                     launch     model      account    context
//   start     a member wanted for the first time      fresh      picked     picked     its brief
//   phase     members.phase changed (U22)             fresh      new        picked     the babysit brief
//   model     running on the wrong model              fresh      expected   picked     the handoff
//   limit     limited, moved to another account       fresh      same       new        the handoff
//   limit     limited, nowhere to move                tell       same       same       "carry on"
//   limit     out of credits, nowhere to move (U3)    nothing    same       same       -
//   limit     out of credits, its hold cleared (U3)   tell       same       same       worksAgain()
//
// Every restart starts fresh from the brief (U95): no restart continues a conversation.
// `context` is the prompt of a fresh start, or the text `tell` types; the handoff itself
// points at the member's journal (U266: whose briefing ends with the checkpoint a planned restart
// asked for) until U27 extracts a transcript.
import { standingNote, type Member } from "../drivers/types.ts";
import { ROOT } from "../core/store.ts";
import { existsSync } from "node:fs";

export type Why = "start" | "phase" | "model" | "limit";
export type Reason = {
  why: Why;
  model?: string | null;     // the model to run: the pick's, the phase's, or the expected one
  account?: string | null;   // the account picked; for `limit`, null or unchanged means nowhere to move
  ctx?: number | null;       // the member's live context in tokens, when known (U95: restarts start fresh whatever it says)
  run?: string | null;       // the squad's Run, named in the prompt
  prompt?: string | null;    // a self-contained brief from the wish (start, phase)
};
// "continue" is only ever a replay: fulfil/member.ts replays a pre-upgrade resume under its
// retry id — handoff() itself never returns it.
export type Handoff = { launch: "fresh" | "continue" | "tell"; model: string; account: string | null; context: string };

export const TELL = "dev-studio loop: your usage limit is over and there is no other account to move to — carry on where you left off.";
// U3: an account out of credits has no "over" until its hold is cleared; then this, once (decide.ts).
export const worksAgain = (agent: string, account: string) => `dev-studio loop: the ${agent}/${account} account works again — carry on where you left off.`;

function jrole(m: Member): string { return `${m.role}${m.suffix ? `-${m.suffix}` : ""}`; }

// The same words as a role's start spec (roleSpec, bin/loop/reconcilers/requests.ts) (and
// standingNote, in drivers/types.ts);
// tests/loop/actuator.test.ts fails if they drift.
export const PR_NOTE = "Orca's \"don't post to GitHub\" line doesn't cover this unit's PR; committing, pushing, opening and recording the PR (set-unit-pr) per the ship mode in roles/builder.md is the job; send worker_done only after that, with the PR number in the body (local-only mode: after the commit).";
export const NO_HEARTBEAT_NOTE = "Do not send heartbeats: the loop tracks liveness — message the Run only on transitions that need the Lead.";
export function notesNote(m: Pick<Member, "project" | "role">): string {
  const notes = `${ROOT}/bin/role/notes.sh ${m.project} ${m.role}`;
  return `Before you start work, read the notes earlier ${m.role} roles left on this project (tips, not orders): \`${notes} print\`. If you lose time on project know-how that is not in the repo's docs, add a note before you finish: \`${notes} add "<note>" "<why>"\`.`;
}

// Every start brief names its role file; the roles that host things also get the hosting check.
export const HOSTING_ROLES = ["builder", "tester", "researcher"];
export const HOSTING_NOTE = "Hosting anything (a dev server, a stack, a database)? As soon as it answers: `ds expose <name> <url> --stop \"<cmd>\"` (`--squad` when the squad needs it after you leave, as a Tester's stack does; `--ports` for ports that are not web pages; `--self` for a tool only you use).";
export const RESTART_HOSTING_NOTE = "You were restarted: run `ds exposed` and expose anything you host that is not listed.";
export function roleFileNote(role: string): string {
  return existsSync(`${ROOT}/roles/${role}.md`) ? `Read ${ROOT}/AGENTS.md and ${ROOT}/roles/${role}.md before you start.` : `Read ${ROOT}/AGENTS.md before you start.`;
}
/** Adds what a brief lacks: the role file line, and for a hosting role the hosting line (the restart line on a restart). Twice changes nothing. */
export function withRoleNotes(role: string, text: string, o: { restart?: boolean } = {}): string {
  let s = text;
  if (!s.includes(`roles/${role}.md`)) s += ` ${roleFileNote(role)}`;
  if (HOSTING_ROLES.includes(role) && !s.includes(HOSTING_NOTE) && !s.includes(RESTART_HOSTING_NOTE)) s += ` ${o.restart ? RESTART_HOSTING_NOTE : HOSTING_NOTE}`;
  return s;
}

// U266: a planned restart asks for a checkpoint first (stop-checkpoint.ts); the briefing ends with the newest one.
export const CHECKPOINT_NOTE = "If the briefing ends with a newest checkpoint, continue from its next step; when it says the checkpoint failed or newer entries came after it, check the work tree and the PR first.";

// The brief of a fresh session: who it is, what to re-read, its journal, and for a Builder the PR note
// (restart-role.sh's spec). Without that note a restarted Builder obeys Orca's "don't post to GitHub".
function brief(m: Member, run?: string | null, why = ""): string {
  const body = `You are the ${m.role}${m.suffix ? ` (${m.suffix})` : ""} of squad "${m.squad}".${why ? ` ${why}` : ""} Re-read ${ROOT}/AGENTS.md and ${ROOT}/roles/${m.role}.md, then resume from the squad state and your inbox — work ONLY your own scope. Read your journal first: \`${ROOT}/bin/role/journal.sh ${m.project} ${m.squad} ${jrole(m)} briefing\`. ${CHECKPOINT_NOTE}${m.role === "builder" ? ` ${PR_NOTE}` : ""} ${NO_HEARTBEAT_NOTE} ${notesNote(m)}${standingNote(m.role)}`;
  return `${withRoleNotes(m.role, body, { restart: !!why })}${run ? ` Squad run=${run}.` : ""}`;
}

export function handoff(m: Member, r: Reason): Handoff {
  const model = r.model || m.model || "";
  switch (r.why) {
    case "start":
    case "phase":
      return { launch: "fresh", model, account: r.account ?? m.account, context: withRoleNotes(m.role, r.prompt || brief(m, r.run)) };
    case "model":
      return { launch: "fresh", model, account: r.account ?? m.account, context: withRoleNotes(m.role, brief(m, r.run, `You were restarted on ${model}; your conversation did not come along.`), { restart: true }) };
    case "limit": {
      const same = m.model || model;
      if (!r.account || r.account === m.account) return { launch: "tell", model: same, account: m.account, context: TELL };
      return { launch: "fresh", model: same, account: r.account, context: withRoleNotes(m.role, brief(m, r.run, "You hit a usage limit and were moved to another account; your conversation did not come along."), { restart: true }) };
    }
  }
}
