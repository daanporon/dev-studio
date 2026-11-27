// forward-table.ts — side-loop-host U7 (issue #127, KTD5/KTD6): which `ds` commands a worker on a side host may
// run, and the checks main makes before it runs one for it. A worker's terminal on a side host carries
// DS_MAIN_URL; `bin/ds` hands each call to the side relay (relay.ts), the relay sends it up the link, and main's
// `ds-call` channel (channels/ds-call.ts) runs the real `bin/ds` as the checked member. Each command a Builder,
// Tester or Researcher calls is listed per role as
//   forward  pure loop.db: runs on main, output and exit code come back as they are
//   local    runs on the side host only (bin/ds runs it there, nothing goes up)
//   split    U8: reads the worktree and writes rows: bin/ds on the side gathers the facts (split.ts gather), main
//            checks them and runs the real command with them (DS_LINK_FACTS)
// Any other command is refused, and Lead, Thinker and Studio commands are never in the table. The walk test
// (tests/loop/link-split-commands.test.ts) reads the worker role files and fails on a command they call that is
// not listed here.
// Main's checks, in order (checkCall): the member row is this link's host's, its generation is current ("you were
// replaced" otherwise, no row written), the command is listed as forward for that member's role, and the call
// names no other identity or scope: no --state, --as or --from, no --project, --squad or --topic but the member's
// own, and a journal, notes, finish, reload or checkpoint target only inside the member's own project, squad and
// unit. The caller is the member row, never an argument: main runs the call with DS_LINK_WT, the row's worktree id,
// which toplevel() (squad/exposed.ts) returns in place of main's own folder.
import type { Row, Store } from "../loop/core/store.ts";
import { parseMember } from "../loop/core/whoami.ts";
import { memberAt, roleName, squadOfRun } from "../loop/messages/messages.ts";
import { dsLabel } from "../lib/shared";
import { checkFacts } from "./split.ts";
import { join } from "node:path";

export type Kind = "forward" | "local" | "split";
export const WORKER_ROLES = ["builder", "tester", "researcher"] as const;

/** Exit codes of a forwarded call that never ran: refused by main, a stale generation, main unreachable (retry). */
export const EXIT = { refused: 77, replaced: 78, unreachable: 75 } as const;
export const REPLACED_LINE = "you were replaced";
/** The most stdin a forwarded call carries (the side reads at most this, main passes at most this on). */
export const STDIN_MAX = 256 * 1024;

// Every worker role forwards the same loop.db commands (U8 adds expose, unexpose, exposed, reload, ds-feedback,
// ship-mode, the row ops of orch.sh and the pause checkpoint). `local` lists the shell wrappers that only exec a
// listed `-ts` command (their own call to bin/ds is forwarded), help, and what only touches the side host: the
// kill guard and rewake hooks (the rewake hook's watch.sh call is itself split), the start-hook gate, stop-mine
// (processes under this worktree), the contract adapter (`current` is `local::<worktree>`, KTD9) and the review
// (a headless session on this worktree; its receipt stays in the worktree and its row goes up as observed_reviews).
const PURE = ["msg", "send-role-ts", "journal-ts", "notes-ts", "finish", "expose", "unexpose", "exposed", "reload", "ds-feedback-ts",
  "ship-mode-ts", "orch-ts", "pause-checkpoint-ts"] as const;
const WRAPPERS = ["journal", "notes", "send-role", "help"] as const;
const ON_SIDE = ["stop-mine", "contract-backend", "hook-gate", "no-broad-kill-hook-ts", "rewake-hook-ts"] as const;
const ROW: Record<string, Kind> = Object.fromEntries([...PURE.map((c) => [c, "forward"]), ...[...WRAPPERS, ...ON_SIDE].map((c) => [c, "local"]),
  ["watch-ts", "split"]]);
// Only a Builder ends a unit with a PR and reviews it (roles/builder.md); a Tester or Researcher finishes with `ds finish`.
const BUILDER: Record<string, Kind> = { "finish-unit-ts": "split", "review-unit-ts": "local" };
export const TABLE: Record<(typeof WORKER_ROLES)[number], Record<string, Kind>> = { builder: { ...ROW, ...BUILDER }, tester: { ...ROW }, researcher: { ...ROW } };

/** The orch.sh ops a side host forwards: the ones written as loop.db rows (orch-ts ROW_OPS), never a backend verb. */
export const ORCH_OPS = ["send", "send-worker", "reply", "ask"] as const;

/** The class of `cmd` for a member of `role`; null when it is not listed (refused). */
export function kindOf(role: string, cmd: string): Kind | null {
  return (TABLE as Record<string, Record<string, Kind>>)[role]?.[cmd] ?? null;
}

// The options each forwarded command takes a value for, so a value (a message body) is never read as a flag.
const VALUED: Record<string, string[]> = {
  msg: ["project", "as", "key"],
  finish: ["outcome", "body", "key", "as", "project", "squad", "member", "limit"],
  "send-role-ts": ["project", "from", "wait"],
  "journal-ts": [],
  "notes-ts": [],
  expose: ["note", "stop", "ports", "project", "topic", "owner"],
  unexpose: ["project", "topic", "owner"],
  exposed: ["project", "topic"],
  "finish-unit-ts": ["failed", "wait"],
  "watch-ts": ["ack", "run", "requests"],
};
const IDENTITY_FLAGS = ["as", "from"];

export type Call = { argv: string[]; member: string; gen: string; facts?: unknown };
export type Checked = { ok: true; member: Row; env: Record<string, string>; argv: string[] } | { ok: false; code: number; why: string };

const refuse = (why: string, code: number = EXIT.refused): Checked => ({ ok: false, code, why });

/** The open member row DS_MEMBER names (newest first), or null. */
export function memberRow(s: Store, member: string): Row | null {
  const id = parseMember(member);
  if (!id) return null;
  return s.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = ? AND COALESCE(suffix, '') = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
    .get(id.project, id.squad, id.role, id.suffix) as Row | null;
}

/** A member's own unit: a Builder's suffix, or a unit whose builder worktree is the member's. A Tester or Researcher
 *  reports on another member's unit (roles/tester.md), so for them it is any unit of their own squad. */
function ownUnit(s: Store, m: Row, role: string, unit: string): boolean {
  if (role !== "builder") return !!s.db.query("SELECT 1 FROM units WHERE project = ? AND squad = ? AND slug = ?").get(m.project, m.squad, unit);
  if (unit === String(m.suffix ?? "")) return true;
  return !!m.wt && !!s.db.query("SELECT 1 FROM units WHERE project = ? AND squad = ? AND slug = ? AND builder_wt = ?").get(m.project, m.squad, unit, m.wt);
}

/** The path part of a worktree id (`<host>::<path>`, KTD9). */
export const wtPath = (wt: unknown): string => { const w = String(wt ?? ""); return w.includes("::") ? w.slice(w.indexOf("::") + 2) : w; };

/** Main's checks for one forwarded call from `host` (KTD5): the member row and the environment to run it with, or why not. */
export function checkCall(s: Store, host: string, call: Call): Checked {
  const m = memberRow(s, call.member);
  if (!m) return refuse(`no member '${call.member}' on main`);
  if (String(m.host ?? "local") !== host) return refuse(`member '${call.member}' is not on host ${host}`);
  if (!call.gen || !m.gen || call.gen !== String(m.gen)) return refuse(REPLACED_LINE, EXIT.replaced);
  const [cmd, ...args] = call.argv;
  if (!cmd) return refuse("no command");
  const role = String(m.role);
  const kind = kindOf(role, cmd);
  if (kind === null) return refuse(`'ds ${cmd}' is not a command a ${role} may run from a side host`);
  if (kind === "local") return refuse(`'ds ${cmd}' runs on the side host, not on main`);
  const bad = kind === "split" ? checkFacts(cmd, call.facts) : null;
  if (bad) return refuse(`'ds ${cmd}' from a side host: ${bad}`);
  if (call.argv.some((a) => a === "--state" || a.startsWith("--state="))) return refuse("--state is not allowed from a side host");
  const project = String(m.project), squad = String(m.squad), me = roleName(role, String(m.suffix ?? ""));
  // Flags: skip each valued flag's value; an identity flag or another project is refused.
  const valued = VALUED[cmd] ?? [];
  const pos: string[] = [], posAt: number[] = [];
  let named = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--") || a === "--") { pos.push(a); posAt.push(i + 1); continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (IDENTITY_FLAGS.includes(name)) return refuse(`--${name} is not allowed from a side host: the caller is the member row`);
    const value = inline ?? (valued.includes(name) ? args[++i] : undefined);
    if (name === "project" && (value === undefined || dsLabel(value) !== project)) return refuse(`--project names another project than ${project}`);
    // (`ds expose --squad` is a switch, not a squad name.)
    if ((name === "squad" || name === "topic") && (inline !== undefined || valued.includes(name)) && value !== squad) return refuse(`--${name} names another squad than ${squad}`);
    if (cmd === "expose" && name === "stop") return refuse("--stop from a side host is not supported yet: a stop must run on the member's host, never on main");
    if (cmd === "watch-ts" && (name === "run" || name === "requests")) return refuse(`watch.sh --${name} is not a worker's tick`);
    if (name === "member" && !String(value ?? "").startsWith(`${project}/${squad}/`)) return refuse(`--member names a member outside ${project}/${squad}`);
    if (name === "project") named = true;
  }
  // Positional targets.
  if (cmd === "journal-ts") {
    const [p, topic, r] = pos;
    if (p !== undefined && (p !== project || topic !== squad || r !== me))
      return refuse(`a journal from a side host is only ${project} ${squad} ${me}`);
  } else if (cmd === "notes-ts") {
    const [p, r] = pos;
    if (p !== undefined && (dsLabel(p) !== project || r !== role)) return refuse(`notes from a side host are only ${project} ${role}`);
  } else if (cmd === "finish") {
    const unit = pos[0];
    if (unit !== undefined && unit !== "list" && unit !== "-" && !ownUnit(s, m, role, unit)) return refuse(`a finish from a side host is only for this member's own unit, not '${unit}'`);
  } else if (cmd === "reload" || cmd === "pause-checkpoint-ts") {
    // reload ack <project> <squad> <role> [suffix]; pause-checkpoint <project> <squad> <role> <suffix|-> …
    const [p, sq, r, sfx = ""] = cmd === "reload" ? pos.slice(1) : pos;
    const suffix = sfx === "-" ? "" : sfx;
    if (p !== project || sq !== squad || r !== role || suffix !== String(m.suffix ?? "")) return refuse(`'ds ${cmd}' from a side host is only for ${project} ${squad} ${me}`);
  } else if (cmd === "ship-mode-ts") {
    if (pos.length !== 1 || dsLabel(pos[0]) !== project) return refuse(`from a side host ship-mode only reads ${project}'s mode`);
  } else if (cmd === "orch-ts") {
    if (!(ORCH_OPS as readonly string[]).includes(pos[0] ?? "")) return refuse(`from a side host orch.sh only does ${ORCH_OPS.join(", ")}`);
    // The target is the member's own project, as for `ds msg send`: a Run id's squad, or a worktree's member.
    const target = pos[0] === "send-worker" ? memberAt(s, pos[1] ?? "") : pos[0] === "reply" ? null : squadOfRun(s, pos[1] ?? "");
    if (target && target.project !== project) return refuse(`orch.sh ${pos[0]} from a side host only reaches ${project}`);
  } else if (cmd === "watch-ts") {
    if (!args.includes("--worktree")) return refuse("from a side host watch.sh only reads your own inbox (--worktree)");
  }
  let argv = call.argv;
  if (cmd === "finish-unit-ts") {
    // The state file is main's: <state root>/<project>/squads/<squad>.json, named on the side by the same tail.
    const [state, unit] = pos;
    const tail = String(state ?? "").split("/").slice(-3);
    if (tail[0] !== project || tail[1] !== "squads" || tail[2] !== `${squad}.json`) return refuse(`finish-unit from a side host takes ${project}/squads/${squad}.json`);
    if (unit === undefined || !ownUnit(s, m, role, unit)) return refuse(`finish-unit from a side host is only for this member's own unit, not '${unit ?? ""}'`);
    argv = [...argv];
    argv[posAt[0]] = join(s.root, project, "squads", `${squad}.json`);
  }
  const env: Record<string, string> = { DS_MEMBER: call.member, DS_GEN: String(m.gen) };
  const wt = wtPath(m.wt);
  if (wt) env.DS_WT = wt;
  if (m.wt) env.DS_LINK_WT = String(m.wt);
  if (kind === "split") env.DS_LINK_FACTS = JSON.stringify(call.facts);
  // Main's cwd is its state root, so a command that finds its project from the caller's worktree is told it:
  // the member's own project, the only one it may name.
  const scoped = cmd === "send-role-ts" || cmd === "exposed" || (cmd === "finish" && pos[0] === "list");
  if (scoped && !named) argv = [...argv, "--project", project];
  return { ok: true, member: m, env, argv };
}
