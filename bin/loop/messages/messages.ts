// messages.ts — role-to-role messages as loop.db rows (U45, migration 0045). The one write path for
// `ds msg`, send-role.sh and send-peer.sh on a loop root: a message is a row the receiver reads and
// acks through `ds msg`; Orca only wakes the receiver (reconcilers/messages.ts → wake() → poke, and
// fulfil/poke.ts marks the rows sending before that poke and delivered when it went out). A message
// whose receiver is gone, or sent while Orca is down, stays undelivered and unread until the receiver
// lives again; one a crash left sending is settled delivered, so it is never poked twice.
//
// A receiver is `<project>/<squad>/<role>[-<suffix>]`: the role is the word before the first '-',
// so the row outlives any one worker (a fresh Builder on the unit reads its predecessor's mail).
import { createHash } from "node:crypto";
import { now, type Row, type Store } from "../core/store.ts";
import { caller, type Caller } from "../squad/exposed.ts";
import { roleOf } from "../settings/skills.ts";
import { redact } from "../core/redact.ts";
import { parseMember, whoAmI } from "../core/whoami.ts";

export const ROLES = ["lead", "thinker", "builder", "reviewer", "tester", "researcher", "studio"] as const;
export type Addr = { project: string; squad: string; role: string; suffix: string };
export type Sender = { project: string | null; squad: string | null; role: string; suffix: string; member: string | null };
export type Message = Row & { id: number; subject: string; body: string };

/** `builder-u1-x` → {role: builder, suffix: u1-x}; null when the first word is no role. */
export function splitRole(want: string): { role: string; suffix: string } | null {
  const i = want.indexOf("-"), role = i < 0 ? want : want.slice(0, i);
  return (ROLES as readonly string[]).includes(role) ? { role, suffix: i < 0 ? "" : want.slice(i + 1) } : null;
}
export const roleName = (role: string, suffix: string) => (suffix ? `${role}-${suffix}` : role);

/** Who is sending (U285). The session decides, not the folder the command runs in; the first that finds a member wins:
 *  0. `DS_MEMBER` (whoami.ts, U4) → that member's worktree, else `DS_WT`, the identity the loop gave the terminal it started;
 *  1. `ORCA_TERMINAL_HANDLE` → the worktree of the terminal the loop observed under that handle (or the member holding it);
 *  2. `CLAUDE_PROJECT_DIR`, the worktree the session started in;
 *  3. the current folder's git top level `top`.
 *  Nobody found: the Studio's folder is `studio`, anything else `unknown` with the folder kept in `member`
 *  (never `operator`: that is only ever named, `ds msg send --as operator`). */
export function senderAt(s: Store, top: string | null, env: Record<string, string | undefined> = process.env): Sender {
  const tries: string[] = [];
  const me = whoAmI(env), id = parseMember(me.member);
  if (id) {
    const m = s.db.query("SELECT wt FROM members WHERE project = ? AND squad = ? AND role = ? AND COALESCE(suffix, '') = ? AND wt IS NOT NULL AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
      .get(id.project, id.squad, id.role, id.suffix) as Row | null;
    if (m?.wt) tries.push(String(m.wt), wtDir(String(m.wt)));   // the exact id first: a side path can equal a main one
  }
  if (me.wt) tries.push(me.wt.replace(/\/+$/, ""));
  const handle = me.handle;
  if (handle) {
    const t = s.db.query("SELECT wt FROM observed_terminals WHERE handle = ? AND wt IS NOT NULL ORDER BY (gone_at IS NULL) DESC, observed_at DESC").get(handle) as Row | null;
    const m = t ? null : s.db.query("SELECT wt FROM members WHERE handle = ? AND wt IS NOT NULL AND COALESCE(status, '') != 'gone' ORDER BY id DESC").get(handle) as Row | null;
    const wt = String((t ?? m)?.wt ?? "");
    if (wt) tries.push(wtDir(wt));
  }
  if (env.CLAUDE_PROJECT_DIR) tries.push(env.CLAUDE_PROJECT_DIR.replace(/\/+$/, ""));
  if (top) tries.push(top);
  for (const t of tries) {
    const c = caller(s, t, {});
    if (!("error" in c)) return fromCaller(c);
  }
  const projects = (s.db.query("SELECT DISTINCT project FROM squads").all() as { project: string }[]).map((r) => r.project);
  for (const t of tries) {
    const dir = roleOf(t, projects);
    if (dir?.role === "studio") return { project: dir.project ?? null, squad: null, role: "studio", suffix: "", member: null };
  }
  const folder = top ?? tries[0] ?? process.cwd();
  return { project: roleOf(folder, projects)?.project ?? null, squad: null, role: "unknown", suffix: "", member: folder };
}
const wtDir = (wt: string) => (wt.includes("::") ? wt.slice(wt.indexOf("::") + 2) : wt);
export const fromCaller = (c: Caller): Sender =>
  ({ project: c.project, squad: c.squad, role: c.role, suffix: c.suffix, member: c.owner_wt || null });

// The default idempotency key: the same sender, receiver and text inside one 5-minute window is the
// same message (a retried send-role, as the old request key was).
function keyOf(to: Addr, from: Sender, subject: string, body: string, at: number): string {
  const h = createHash("sha1");
  for (const p of [from.member ?? from.role, subject, body, String(Math.floor(at / 300))]) h.update(p + "\0");
  return `${to.project}/${to.squad}/${roleName(to.role, to.suffix)}:${h.digest("hex").slice(0, 12)}`;
}

/** Write one message; the same key again returns the existing row with created false. */
export function sendMessage(s: Store, m: { to: Addr; from: Sender; subject: string; body: string; kind?: string; needsReply?: boolean; replyTo?: number | null; key?: string },
  at = now()): { created: boolean; message: Message } {
  const key = m.key ?? keyOf(m.to, m.from, m.subject, m.body, at);
  // Redacted after the key, so a retried send of the same raw text still dedupes (KTD3: no secret shape reaches loop.db).
  const subject = redact(m.subject), body = redact(m.body);
  const had = s.get("messages", { key });
  if (had) return { created: false, message: had as Message };
  s.fact("message_sent", [{ table: "messages", key: { key }, set: {
    project: m.to.project, squad: m.to.squad, to_role: m.to.role, to_suffix: m.to.suffix,
    from_project: m.from.project, from_squad: m.from.squad, from_role: m.from.role, from_suffix: m.from.suffix || null, from_member: m.from.member,
    kind: m.kind ?? "message", subject, body, needs_reply: m.needsReply ? 1 : 0, reply_to: m.replyTo ?? null, sent_at: at,
  } }], { project: m.to.project, squad: m.to.squad, member: m.from.role === "unknown" ? null : m.from.member, payload: { key, to: roleName(m.to.role, m.to.suffix), from: roleName(m.from.role, m.from.suffix), kind: m.kind ?? "message", subject } });
  return { created: true, message: s.get("messages", { key }) as Message };
}

/** The receiver's messages, oldest first: unread only, or all of them with `all`. */
export function inbox(s: Store, me: Addr, o: { all?: boolean } = {}): Message[] {
  return s.db.query(`SELECT * FROM messages WHERE project = ? AND squad = ? AND to_role = ? AND to_suffix = ?${o.all ? "" : " AND read_at IS NULL"} ORDER BY id`)
    .all(me.project, me.squad, me.role, me.suffix) as Message[];
}

/** The questions the board counts as waiting for this receiver (WAITING): the agent's own view of the same number. */
export function waitingFor(s: Store, me: Addr): Message[] {
  return s.db.query(`SELECT * FROM messages m WHERE m.project = ? AND m.squad = ? AND m.to_role = ? AND m.to_suffix = ? AND ${WAITING} ORDER BY m.id`)
    .all(me.project, me.squad, me.role, me.suffix) as Message[];
}

/** The "waiting for your reply" lines `ds msg inbox` and the watch tick print: id, line and the reply command. */
export function waitingLines(ms: Message[]): string[] {
  return ms.length ? [`waiting for your reply (${ms.length}):`, ...ms.map((m) => `  ${line(m)}  → ds msg reply ${m.id} "<answer>"`)] : [];
}

/** Mark the receiver's messages read: the given ids (only its own), or every unread one. Returns the ids it marked. */
export function ack(s: Store, me: Addr, ids: number[] | "all", at = now()): number[] {
  const open = inbox(s, me).map((m) => m.id);
  const hit = ids === "all" ? open : open.filter((id) => ids.includes(id));
  if (!hit.length) return [];
  s.fact("message_read", hit.map((id) => ({ table: "messages", key: { id }, set: { read_at: at } })),
    { project: me.project, squad: me.squad, payload: { ids: hit, by: roleName(me.role, me.suffix) } });
  return hit;
}

/** The Orca message id a relayed row carries (`relay:<msg_id>`, kind `run`, U276); null for any other row. */
export const relayedId = (m: Row): string | null => (m.kind === "run" && String(m.key).startsWith("relay:") ? String(m.key).slice(6) : null);

/** Answer message `id` (which must be the receiver's): a new message back to its sender (`reply_to` links it), the
 *  original read and replied. A relayed Orca question (U276) is also answered in Orca: a `reply` request the loop
 *  sends from the Run's seat (fulfil/reply.ts), so the worker's parked `orca orchestration ask` returns the answer;
 *  its reply row is held sending while Orca carries it (no wake poke), and becomes plain mail if Orca refuses it. */
export function reply(s: Store, me: Addr & { member: string | null }, id: number, body: string, at = now()):
  { created: boolean; message: Message | null; request?: number } | { error: string } {
  const orig = s.get("messages", { id }) as Message | null;
  if (!orig || orig.project !== me.project || orig.squad !== me.squad || orig.to_role !== me.role || orig.to_suffix !== me.suffix) {
    // Same project and squad, another role's inbox: say whose it is and what to do (never details about another squad).
    if (orig && orig.project === me.project && orig.squad === me.squad) {
      const owner = roleName(String(orig.to_role), String(orig.to_suffix ?? ""));
      const squadMember = orig.from_squad === me.squad && orig.from_project === me.project && !!orig.from_role && !!splitRole(String(orig.from_role));
      const from = squadMember ? roleName(String(orig.from_role), String(orig.from_suffix ?? "")) : "";
      return { error: `message ${id} is not in your inbox (it is in ${owner}'s) — reply to the message that reached you${from ? `, or write to ${from} with send-role.sh ${me.squad} ${from} …` : ""}` };
    }
    return { error: `message ${id} is not in your inbox` };
  }
  const msgId = relayedId(orig), relayed = msgId ? s.get("relayed", { msg_id: msgId }) : null;
  const member = !!(orig.from_squad && orig.from_project && orig.from_role && splitRole(String(orig.from_role)));
  if (!member && !relayed)
    return { error: `message ${id} came from ${orig.from_role ?? "nobody"}, not a squad member: it takes no reply through ds msg` };
  const hash = createHash("sha1").update(body).digest("hex").slice(0, 12);
  let out: { created: boolean; message: Message } | null = null;
  if (member) {
    const to: Addr = { project: String(orig.from_project), squad: String(orig.from_squad), role: String(orig.from_role), suffix: String(orig.from_suffix ?? "") };
    const subject = /^re: /i.test(orig.subject) ? orig.subject : `re: ${orig.subject}`;
    out = sendMessage(s, { to, from: { project: me.project, squad: me.squad, role: me.role, suffix: me.suffix, member: me.member }, subject, body, kind: "reply", replyTo: id, key: `reply:${id}:${hash}` }, at);
  }
  let request: number | undefined;
  if (relayed && msgId) {
    if (out?.created && orig.from_member && markSending(s, me.project, [out.message.id], String(orig.from_member), at).length)
      out = { ...out, message: s.get("messages", { id: out.message.id }) as Message };
    const { row } = s.request("reply", { id: msgId, answer: body, ...(relayed.run_id ? { run: String(relayed.run_id) } : {}), ...(out ? { message: out.message.id } : {}) },
      { key: `reply:${msgId}:${hash}`, project: me.project, squad: me.squad, by: roleName(me.role, me.suffix) });
    request = Number(row.id);
  }
  s.fact("message_replied", [{ table: "messages", key: { id }, set: { replied_at: orig.replied_at ?? at, read_at: orig.read_at ?? at } }],
    { project: me.project, squad: me.squad, payload: { id, ...(out ? { reply: out.message.id } : {}), ...(request ? { request } : {}) } });
  return { created: out?.created ?? true, message: out?.message ?? null, ...(request ? { request } : {}) };
}

/** The first reply to message `id` (`reply_to`), or null. */
export function replyTo(s: Store, id: number): Message | null {
  return (s.db.query("SELECT * FROM messages WHERE reply_to = ? AND kind = 'reply' ORDER BY id LIMIT 1").get(id) as Message | null) ?? null;
}

/** The member at worktree `wt` (an Orca worktree id `<uuid>::<path>`, or its path) as a sender/receiver; null when none. */
export function memberAt(s: Store, wt: string): Sender | null {
  const c = caller(s, wt, {});
  return "error" in c ? null : fromCaller(c);
}

/** The open squad whose Run is `run`. */
export function squadOfRun(s: Store, run: string): { project: string; squad: string } | null {
  const r = s.db.query("SELECT project, topic FROM squads WHERE run_id = ? ORDER BY (COALESCE(status, '') = 'gone'), id DESC").get(run) as Row | null;
  return r ? { project: String(r.project), squad: String(r.topic) } : null;
}

/** relay.ts (U276): one Run mail the loop peeked becomes a message row to the squad's Lead. The key `relay:<msg_id>`
 *  makes a replayed peek the same row; a question needs a reply (`ds msg reply`, which also answers the parked ask).
 *  `from` is the member whose terminal sent it, else a bare `worker` with the handle in the first line. */
export function relayMessage(s: Store, o: { project: string; squad: string; from: Sender | null; mail: Row }, at = now()): { created: boolean; message: Message } {
  const r = o.mail, type = String(r.type ?? "message");
  let p: Record<string, unknown> = {};
  if (r.payload && typeof r.payload === "object") p = r.payload as Record<string, unknown>;
  else if (typeof r.payload === "string" && r.payload) { try { p = JSON.parse(r.payload) as Record<string, unknown>; } catch { /* plain text */ } }
  const lines = [`[run mail · ${type} from ${r.from_handle ?? "?"} · id ${r.msg_id}${p.taskId ? ` · task ${p.taskId}` : ""}]`, String(r.body ?? "")];
  const opts = Array.isArray(p.options) ? (p.options as unknown[]).map(String) : [];
  if (type === "question" && opts.length) lines.push(`options: ${opts.join(" | ")}`);
  const from: Sender = o.from ?? { project: o.project, squad: o.squad, role: "worker", suffix: "", member: null };
  return sendMessage(s, { to: { project: o.project, squad: o.squad, role: "lead", suffix: "" }, from, subject: redact(String(r.subject || type)), body: redact(lines.join("\n")),
    kind: "run", needsReply: type === "question", key: `relay:${r.msg_id}` }, at);
}

/** Write-ahead before the wake poke, as a claim: the rows neither delivered nor already sending get
 *  `sending_at` and the worktree. Returns the ids it claimed; a row another poke holds (one replayed
 *  after a restart, or a timed-out one still typing) is left to that poke or the in-doubt settle. */
export function markSending(s: Store, project: string, ids: number[], wt: string, at = now()): number[] {
  return ids.filter((id) => s.db.run("UPDATE messages SET sending_at = ?, to_member = ? WHERE id = ? AND project = ? AND delivered_at IS NULL AND sending_at IS NULL",
    [at, wt, id, project]).changes === 1);
}

/** The poke did not go out: the rows wait for the next wake. */
export function clearSending(s: Store, ids: number[]): void {
  for (const id of ids) s.db.run("UPDATE messages SET sending_at = NULL, to_member = NULL WHERE id = ? AND delivered_at IS NULL", [id]);
}

/** The poke that woke the receiver went out (or a crash left it in doubt): its rows are delivered, to that worktree. */
export function markDelivered(s: Store, project: string, ids: number[], wt: string, at = now()): void {
  const open = ids.filter((id) => { const r = s.get("messages", { id }); return r && r.project === project && r.delivered_at == null; });
  if (!open.length) return;
  s.fact("message_delivered", open.map((id) => ({ table: "messages", key: { id }, set: { delivered_at: at, to_member: wt, sending_at: null } })),
    { project, member: wt, payload: { ids: open } });
}

/** The receiver's live worktree: its newest member row that is not gone and has a worktree. */
export function receiverWt(s: Store, a: Addr): string | null {
  const m = s.db.query("SELECT wt FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix = ? AND wt IS NOT NULL AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
    .get(a.project, a.squad, a.role, a.suffix) as Row | null;
  if (m) return String(m.wt);
  if (a.role !== "lead" || a.suffix) return null;
  const sq = s.db.query("SELECT lead_wt FROM squads WHERE project = ? AND topic = ? AND COALESCE(status, '') NOT IN ('gone', 'closed')").get(a.project, a.squad) as Row | null;
  return sq?.lead_wt ? String(sq.lead_wt) : null;
}

// U1 (unread-counts-mismatch): the one definition of what a message count means. SQL fragments over a
// `messages` row aliased `m`; the board's counts, `/api/messages` and the reply-alert reconciler embed
// these and nothing else. A message to or from a member that has ended is history: shown, never counted.
/** The receiver of `m` runs: a member row of its squad with its role and suffix, not gone. */
export const RECEIVER_RUNNING = `EXISTS (SELECT 1 FROM members rc WHERE rc.project = m.project AND rc.squad = m.squad
  AND rc.role = m.to_role AND rc.suffix = COALESCE(m.to_suffix, '') AND COALESCE(rc.want, '') != 'gone' AND COALESCE(rc.status, '') != 'gone')`;
/** The asker of `m` can still use an answer: nobody to check (operator, loop, Studio), its own worktree is live,
 *  or a live member holds the same seat (a fresh member on the unit inherits the question). */
export const ASKER_WAITING = `(m.from_member IS NULL OR EXISTS (SELECT 1 FROM members ak WHERE COALESCE(ak.want, '') != 'gone' AND COALESCE(ak.status, '') != 'gone'
  AND (ak.wt = m.from_member OR (ak.project = m.from_project AND ak.squad = m.from_squad AND ak.role = m.from_role AND ak.suffix = COALESCE(m.from_suffix, '')))))`;
/** Unread: to a running member that has not acked it. */
export const UNREAD = `(m.read_at IS NULL AND ${RECEIVER_RUNNING})`;
/** The id of what answered question `m`: the first reply row (`reply_to`) or later message from the receiver to the
 *  asker (same project, squad, role and suffix each way), NULL when none; a question marked `replied_at` with no
 *  such row is answered by itself. Agents mostly answer with a plain message, so a later one counts. */
export const ANSWERED_BY = `(SELECT MIN(an.id) FROM messages an WHERE an.reply_to = m.id OR (an.id > m.id
  AND an.from_project = m.project AND an.from_squad = m.squad AND an.from_role = m.to_role AND COALESCE(an.from_suffix, '') = COALESCE(m.to_suffix, '')
  AND an.project = m.from_project AND an.squad = m.from_squad AND an.to_role = m.from_role AND COALESCE(an.to_suffix, '') = COALESCE(m.from_suffix, '')))`;
/** Answered: a reply, `replied_at` set, or a later message from the receiver to the asker (ANSWERED_BY). */
export const ANSWERED = `(m.replied_at IS NOT NULL OR ${ANSWERED_BY} IS NOT NULL)`;
/** Waiting for a reply: a question nobody answered, to a running receiver, from an asker still waiting. */
export const WAITING = `(m.needs_reply = 1 AND NOT ${ANSWERED} AND ${RECEIVER_RUNNING} AND ${ASKER_WAITING})`;
/** Ended: still open as a row (unacked, or a question with no answer) but not countable. An answered question is history. */
export const ENDED = `(NOT (${UNREAD}) AND NOT (${WAITING}) AND (m.read_at IS NULL OR (m.needs_reply = 1 AND NOT ${ANSWERED})))`;

/** One line per message, as watch.sh and `ds msg inbox` print them. */
export function line(m: Message): string {
  const from = m.from_squad ? `${m.from_squad}/${roleName(String(m.from_role), String(m.from_suffix ?? ""))}`
    : m.from_role === "unknown" ? `unknown${m.from_member ? ` (${String(m.from_member).replace(/\/+$/, "").split("/").pop()})` : ""}` : String(m.from_role ?? "?");
  const tags = [m.kind !== "message" ? String(m.kind) : "", Number(m.needs_reply) ? "needs reply" : "", m.reply_to ? `re #${m.reply_to}` : ""].filter(Boolean).join(", ");
  return `#${m.id} [${tags || "msg"}] from ${from} — ${m.subject}`;
}

/** send-role.sh / send-peer.sh on a loop root: the message row, from this worktree (or `from`) to `<squad>/<want>`.
 *  The project is --project, else the sender's, else the one project holding a squad of that name. */
export function scriptSend(s: Store, o: { project?: string; squad: string; want: string; subject: string; body: string; kind: string; from?: Sender; top: string | null },
  at = now()): { message: Message; created: boolean; from: Sender } | { error: string } {
  const r = splitRole(o.want);
  if (!r) return { error: `'${o.want}' is no role` };
  const from = o.from ?? senderAt(s, o.top);
  let project = o.project || from.project || "";
  if (!project) {
    const ps = s.db.query("SELECT DISTINCT project FROM squads WHERE topic = ?").all(o.squad) as Row[];
    if (ps.length !== 1) return { error: "can't tell the project — pass --project <label>" };
    project = String(ps[0].project);
  }
  const out = sendMessage(s, { to: { project, squad: o.squad, ...r }, from, subject: o.subject, body: o.body, kind: o.kind }, at);
  return { ...out, from };
}
