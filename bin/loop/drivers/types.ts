// drivers/types.ts — what the actuator needs from an agent CLI (Bun). One driver per agent:
//   start(member, model, account, prompt)   a fresh session with this model on this account
//   resume(member)                          the same conversation again (only where `resumes`)
//   poke(member, text)                      type text and wait for the turn to start (--wait-submit)
//   answerMenu(screen)                      the keys that answer a menu the agent is known to show
// A driver acts through a Seat: the squad's Run, a mutating call that carries a retry id and the
// loop's sender terminal, and a plain backend op. The shared mechanics live here; claude.ts,
// muse.ts and codex.ts say what differs.
import { busy, errOf, type Out } from "../io/orca.ts";

export type Member = {
  id: number; project: string; squad: string; wt: string | null; role: string; suffix: string;
  agent: string | null; model: string | null; effort: string | null; account: string | null;
  phase?: string | null; limited_until?: number | null;
};
export type Squad = { project: string; topic: string; run_id: string | null; repo: string | null; lead_wt: string | null; studio_wt?: string | null };
export type Seat = {
  squad: Squad;
  call(op: string, args: string[]): Promise<Out>;   // an Orca mutation: retry id stored first, from the sender terminal
  send(op: string, args: string[]): Promise<Out>;   // a plain backend op
  window?(role: string): string;                     // the role's auto-compact window in tokens (auto_compact_<role>), `-` when unset
};
export type Started = { ok: true; wt: string } | { ok: false; error: string; busy?: boolean };
// started: Orca saw the turn start; accepted: the text landed but no turn yet; failed: not sent.
export type Poked = "started" | "accepted" | "failed";

export interface Driver {
  start(m: Member, model: string, account: string | null, prompt: string): Promise<Started>;
  resume(m: Member): Promise<Started>;
  poke(m: Member, text: string): Promise<Poked>;
  stop(makeSeat: (op: string) => Seat, m: Member, run: string, keep: string): Promise<{ ok: boolean; error?: string }>;
  answerMenu(screen: string): string | null;
}
export type DriverModule = { agent: string; resumes: boolean; make(seat: Seat): Driver };

const dash = (v: string | null | undefined) => v || "-";
// U104: every start and resume carries the role's auto-compact window, as compactWindowOf (bin/lib/lib.ts)
// does for the scripts; without it a Claude session runs on its own default and grows past the threshold.
export const windowOf = (seat: Seat, role: string) => seat.window?.(role) || "-";

// A standing role lives across turns (U64): the backend starts it --keep-open (the role is the last
// arg of every start op) and its brief carries STANDING_NOTE, the same words as roleSpec's
// (bin/loop/reconcilers/requests.ts; tests/loop/actuator.test.ts checks).
export const STANDING = new Set(["lead", "thinker", "studio"]);
const STANDING_NOTE = "You are a standing role: never call worker_done and never end your session, whatever the Orca brief says — stay running between turns and report through `ds` and send-role.sh.";
export const standingNote = (role: string) => (STANDING.has(role) ? ` ${STANDING_NOTE}` : "");
// U97: the backend's fresh-start guard refuses with `agent_busy` (exit 3) when the worktree's old
// agent is mid-turn. That is a wait, not a failure: the wish stays open and retries next tick.
export const failed = (o: Out, what: string): Started => ({ ok: false, error: errOf(o, what), busy: busy(o) || /agent_busy/.test(o.err + o.out) });

// The worktree name add-role.sh gives a role: ds-<project>-<role>-<suffix>-<topic>.
function wtName(m: Member): string {
  return `${process.env.DS_PREFIX ?? "ds-"}${m.project}-${m.role}${m.suffix ? `-${m.suffix}` : ""}-${m.squad}`;
}

// What a start or resume call asked for, read back from its args.
export function startedOn(op: string, a: string[]): { launch: "fresh" | "continue"; prompt: string; agent: string; model: string; effort: string | null; account: string | null } | null {
  const set = (v: string | undefined) => (v && v !== "-" ? v : null);
  if (op === "worker-start") return { launch: "fresh", prompt: a[2], agent: a[3], model: a[4], effort: set(a[6]), account: set(a[7]) };
  if (op === "role-start") return { launch: "fresh", prompt: a[3], agent: a[4], model: a[5], effort: set(a[8]), account: set(a[9]) };
  if (op === "worker-resume") return { launch: "continue", prompt: "", agent: a[5], model: a[3], effort: null, account: set(a[4]) };
  return null;
}

// The worktree a new role's worktree nests under (U206): the Lead under its project's Studio, any
// other role under the squad's Lead (none while `lead_wt` is unset: reconcilers/nesting.ts moves it
// there once both are observed). The tree is Studio > Lead > the Lead's roles and Builders.
export function parentFor(squad: Squad, role: string): string | null {
  return role === "lead" ? squad.studio_wt || null : squad.lead_wt || null;
}

// A fresh worker: worker-start in the member's worktree, or role-start (worktree + worker under its
// parent, parentFor) for a member that has none yet. The loop keeps that tree (reconcilers/nesting.ts). --model goes with every launch, never a /model afterwards.
export async function startVia(seat: Seat, agent: string, m: Member, model: string, account: string | null, prompt: string): Promise<Started> {
  const { run_id: run, repo } = seat.squad;
  if (!run) return { ok: false, error: `squad ${m.squad} has no run` };
  if (m.wt) {
    const o = await seat.call("worker-start", [run, m.wt, prompt, agent, model, "-", dash(m.effort), dash(account), windowOf(seat, m.role), m.role]);
    return o.code === 0 ? { ok: true, wt: m.wt } : failed(o, "worker-start");
  }
  if (!repo) return { ok: false, error: `squad ${m.squad} has no repo` };
  const o = await seat.call("role-start", [run, repo, dash(parentFor(seat.squad, m.role)), prompt, agent, model, wtName(m), "-", dash(m.effort), dash(account), windowOf(seat, m.role), m.role]);
  const wt = o.out.trim().split("\n").pop() ?? "";
  return o.code === 0 && wt ? { ok: true, wt } : failed(o, "role-start");
}

// U153 stop: worker-stop, worker-release, then close the worktree's terminals but the loop's
// pane. Any failure is the caller's retry; presence stays as observed (never assumed stopped).
export async function stopVia(makeSeat: (op: string) => Seat, m: Member, run: string, keep: string): Promise<{ ok: boolean; error?: string }> {
  if (!m.wt || !run) return { ok: false, error: "stop needs a run and a worktree" };
  // One seat per op: a seat's call key is one effect, replayed under its retry id.
  const s = await makeSeat("worker-stop").call("worker-stop", [run, m.wt]);
  if (s.code !== 0) return { ok: false, error: errOf(s, "worker-stop") };
  const r = await makeSeat("worker-release").call("worker-release", [run, m.wt]);
  if (r.code !== 0) return { ok: false, error: errOf(r, "worker-release") };
  const c = await makeSeat("terminal-close-worktree").call("terminal-close-worktree", [`id:${m.wt}`, keep]);
  if (c.code !== 0) return { ok: false, error: errOf(c, "terminal-close-worktree") };
  return { ok: true };
}

// The backend's poke: `orca terminal send --wait-submit`; exit 0 a turn started, 3 accepted only.
export async function pokeVia(seat: Seat, m: Member, text: string): Promise<Poked> {
  if (!m.wt) return "failed";
  const o = await seat.send("poke", [m.wt, text]);
  return o.code === 0 ? "started" : o.code === 3 ? "accepted" : "failed";
}
