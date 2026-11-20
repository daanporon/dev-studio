// ds msg — role-to-role messages kept in loop.db (U45): send one, read your inbox, ack what you
// handled, reply, show one. The rows are the record; the loop only wakes the receiver with one poke
// (reconcilers/messages.ts). Who you are is your worktree's member row; outside a role worktree name
// it with --as <squad>/<role[-suffix]> --project <label>.
import { open, type Row, type Store } from "../loop/core/store.ts";
import { parse, print } from "../loop/core/cli.ts";
import { dsLabel } from "../lib/shared";
import { toplevel } from "../loop/squad/exposed.ts";
import { ack, inbox, line, receiverWt, reply, roleName, senderAt, sendMessage, splitRole, waitingFor, waitingLines, type Addr, type Message, type Sender } from "../loop/messages/messages.ts";

export const help = "send <squad> <role[-suffix]> <subject> <body> [--needs-reply] | inbox [--all] | ack <id>…|--all | reply <id> <body> | show <id> [--json] [--project <label>] [--as <squad>/<role>] — role-to-role messages kept in loop.db";

const USAGE = `usage: ds msg ${help}`;

/** The caller as a receiver: --as with --project, else this worktree's member. */
function me(s: Store, opt: Record<string, string>): (Addr & { member: string | null }) | { error: string } {
  if (opt.as) {
    const [squad, want, ...rest] = opt.as.split("/");
    const r = want && !rest.length ? splitRole(want) : null;
    if (!squad || !r) return { error: `--as is <squad>/<role[-suffix]>, not '${opt.as}'` };
    const project = opt.project ? dsLabel(opt.project) : "";
    if (!project) return { error: "--as needs --project <label>" };
    return { project, squad, ...r, member: receiverWt(s, { project, squad, ...r }) };
  }
  const who = senderAt(s, toplevel());
  if (!who.squad || !who.project || !who.member) return { error: "not in a squad member's worktree: pass --as <squad>/<role[-suffix]> --project <label>" };
  if (opt.project && dsLabel(opt.project) !== who.project) return { error: `this worktree is in project ${who.project}, not ${opt.project}` };
  return { project: who.project, squad: who.squad, role: who.role, suffix: who.suffix, member: who.member };
}

/** A send's target must be an open squad with that member (or its Lead). */
export function targetProblem(s: Store, to: Addr): string | null {
  const sq = s.get("squads", { project: to.project, topic: to.squad });
  if (!sq) return `no squad '${to.squad}' in '${to.project}'`;
  if (["gone", "closed", "archived"].includes(String(sq.status ?? ""))) return `squad '${to.squad}' is ${sq.status}`;
  if (to.role === "lead" && !to.suffix) return null;
  const m = s.db.query("SELECT 1 FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix = ?").get(to.project, to.squad, to.role, to.suffix);
  return m ? null : `no member '${roleName(to.role, to.suffix)}' in squad '${to.squad}'`;
}

function text(m: Message, body = true): string {
  const state = m.read_at ? "read" : m.delivered_at ? "delivered" : "not yet delivered";
  return `${line(m)}  (${state})${body ? `\n${String(m.body).replace(/^/gm, "    ")}` : ""}`;
}

export async function run(args: string[]): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") { console.log(USAGE); return args.length ? 0 : 2; }
  const usage = (why: string) => { console.error(`ds msg: ${why}\n${USAGE}`); return 2; };
  const [sub, ...rest] = args;
  let p: ReturnType<typeof parse>;
  try { p = parse(rest, ["project", "as", "key"], ["all", "json", "needs-reply"]); } catch (e) { return usage((e as Error).message); }
  const { pos, opt, flag } = p;
  const s = open();
  try {
    if (sub === "send") {
      if (pos.length !== 4) return usage("send <squad> <role[-suffix]> <subject> <body>");
      const [squad, want, subject, body] = pos;
      const r = splitRole(want);
      if (!r) return usage(`'${want}' is no role (one of lead, thinker, builder, reviewer, tester, researcher)`);
      let from: Sender;
      if (opt.as === "operator") from = { project: opt.project ? dsLabel(opt.project) : null, squad: null, role: "operator", suffix: "", member: null };
      else if (opt.as) { const m = me(s, opt); if ("error" in m) return usage(m.error); from = { ...m }; }
      else from = senderAt(s, toplevel());
      const project = opt.project ? dsLabel(opt.project) : from.project;
      if (!project) return usage("no project: pass --project <label>");
      const to = { project, squad, ...r };
      const bad = targetProblem(s, to);
      if (bad) { console.error(`ds msg: ${bad}`); return 2; }
      const out = sendMessage(s, { to, from, subject, body, needsReply: flag.has("needs-reply"), key: opt.key });
      print({ created: out.created, id: out.message.id, to: `${squad}/${want}` });
      return 0;
    }
    const who = me(s, opt);
    if ("error" in who) return usage(who.error);
    if (sub === "inbox") {
      const ms = inbox(s, who, { all: flag.has("all") });
      const wait = waitingFor(s, who); // the questions the board counts as waiting for this member
      if (flag.has("json")) { print(ms); return 0; }
      if (!ms.length) console.log(`no ${flag.has("all") ? "" : "unread "}messages for ${who.squad}/${roleName(who.role, who.suffix)}`);
      for (const m of ms) console.log(text(m));
      if (ms.length && !flag.has("all")) console.log(`ack each once handled: ds msg ack ${ms.map((m) => m.id).join(" ")}`);
      for (const l of waitingLines(wait)) console.log(l);
      return 0;
    }
    if (sub === "ack") {
      const ids = pos.map(Number);
      if (!flag.has("all") && (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0))) return usage("ack <id>… or --all");
      const done = ack(s, who, flag.has("all") ? "all" : ids);
      const missed = flag.has("all") ? [] : ids.filter((n) => !done.includes(n));
      print({ acked: done, ...(missed.length ? { not_unread_in_your_inbox: missed } : {}) });
      return 0;
    }
    if (sub === "reply") {
      const id = Number(pos[0]);
      if (pos.length !== 2 || !Number.isInteger(id) || id <= 0) return usage("reply <id> <body>");
      const out = reply(s, who, id, pos[1]);
      if ("error" in out) { console.error(`ds msg: ${out.error}`); return 2; }
      print({ created: out.created, id: out.message?.id ?? null, reply_to: id, ...(out.request ? { orca_reply_request: out.request } : {}) });
      return 0;
    }
    if (sub === "show") {
      const id = Number(pos[0]);
      if (pos.length !== 1 || !Number.isInteger(id) || id <= 0) return usage("show <id>");
      const m = s.get("messages", { id }) as Row | null;
      const mine = m && m.project === who.project && m.squad === who.squad && m.to_role === who.role && m.to_suffix === who.suffix;
      const sent = m && m.from_project === who.project && m.from_squad === who.squad && m.from_role === who.role && (m.from_suffix ?? "") === who.suffix;
      if (!mine && !sent) { console.error(`ds msg: message ${id} is neither to nor from you`); return 1; }
      if (flag.has("json")) print(m); else console.log(text(m as Message));
      return 0;
    }
    return usage(`unknown subcommand '${sub}'`);
  } finally { s.close(); }
}
