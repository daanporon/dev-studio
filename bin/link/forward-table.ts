// forward-table.ts — side-loop-host U7 (issue #127, KTD5/KTD6): which `ds` commands a worker on a side host may
// run, and the checks main makes before it runs one for it. A worker's terminal on a side host carries
// DS_MAIN_URL; `bin/ds` hands each call to the side relay (relay.ts), the relay sends it up the link, and main's
// `ds-call` channel (channels/ds-call.ts) runs the real `bin/ds` as the checked member. Each command a Builder,
// Tester or Researcher calls is listed per role as
//   forward  pure loop.db: runs on main, output and exit code come back as they are
//   local    runs on the side host only (bin/ds runs it there, nothing goes up)
// U8 adds `split` (a local half gathers facts, the main half uses them) and the walk test over the role scripts.
// Any other command is refused, and Lead, Thinker and Studio commands are never in the table.
// Main's checks, in order (checkCall): the member row is this link's host's, its generation is current ("you were
// replaced" otherwise, no row written), the command is listed as forward for that member's role, and the call
// names no other identity or scope: no --state, --as or --from, no --project but the member's own, and a
// journal, notes or finish target only inside the member's own project, squad and unit. The caller is the
// member row, never an argument.
import type { Row, Store } from "../loop/core/store.ts";
import { parseMember } from "../loop/core/whoami.ts";
import { roleName } from "../loop/messages/messages.ts";
import { dsLabel } from "../lib/shared";

export type Kind = "forward" | "local";
export const WORKER_ROLES = ["builder", "tester", "researcher"] as const;

/** Exit codes of a forwarded call that never ran: refused by main, a stale generation, main unreachable (retry). */
export const EXIT = { refused: 77, replaced: 78, unreachable: 75 } as const;
export const REPLACED_LINE = "you were replaced";
/** The most stdin a forwarded call carries (the side reads at most this, main passes at most this on). */
export const STDIN_MAX = 256 * 1024;

// Every worker role forwards the same pure loop.db commands. `local` lists the shell wrappers that only exec a
// listed `-ts` command (their own call to bin/ds is forwarded) and help.
const PURE = ["msg", "send-role-ts", "journal-ts", "notes-ts", "finish"] as const;
const WRAPPERS = ["journal", "notes", "send-role", "help"] as const;
const ROW: Record<string, Kind> = Object.fromEntries([...PURE.map((c) => [c, "forward"]), ...WRAPPERS.map((c) => [c, "local"])]);
export const TABLE: Record<(typeof WORKER_ROLES)[number], Record<string, Kind>> = { builder: { ...ROW }, tester: { ...ROW }, researcher: { ...ROW } };

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
};
const IDENTITY_FLAGS = ["as", "from"];

export type Call = { argv: string[]; member: string; gen: string };
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
  if (kind !== "forward") return refuse(`'ds ${cmd}' runs on the side host, not on main`);
  if (call.argv.some((a) => a === "--state" || a.startsWith("--state="))) return refuse("--state is not allowed from a side host");
  const project = String(m.project), squad = String(m.squad), me = roleName(role, String(m.suffix ?? ""));
  // Flags: skip each valued flag's value; an identity flag or another project is refused.
  const valued = VALUED[cmd] ?? [];
  const pos: string[] = [];
  let named = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--") || a === "--") { pos.push(a); continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (IDENTITY_FLAGS.includes(name)) return refuse(`--${name} is not allowed from a side host: the caller is the member row`);
    const value = inline ?? (valued.includes(name) ? args[++i] : undefined);
    if (name === "project" && (value === undefined || dsLabel(value) !== project)) return refuse(`--project names another project than ${project}`);
    if (name === "squad" && value !== squad) return refuse(`--squad names another squad than ${squad}`);
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
  }
  const env: Record<string, string> = { DS_MEMBER: call.member, DS_GEN: String(m.gen) };
  const wt = wtPath(m.wt);
  if (wt) env.DS_WT = wt;
  // Main's cwd is its state root, so a command that finds its project from the caller's worktree is told it:
  // the member's own project, the only one it may name.
  const scoped = cmd === "send-role-ts" || (cmd === "finish" && pos[0] === "list");
  const argv = scoped && !named ? [...call.argv, "--project", project] : call.argv;
  return { ok: true, member: m, env, argv };
}
