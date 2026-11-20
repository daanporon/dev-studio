// reconcilers/messages.ts — wake the receiver of an undelivered message (U45). Per project each tick,
// every receiver (`<squad>/<role>[-<suffix>]`) with unread, undelivered rows in `messages` gets one
// poke through wake() (R16: its skip rules, backoff and cap hold here too), carrying the row ids; the
// poke fulfiller marks them delivered when the poke went out (started or accepted). So a sleeping
// receiver is woken once per batch, a poke Orca refused is tried again on wake()'s doubling gap (a new
// message starts a fresh episode), and a receiver with no live member, paused, limited or not yet
// observed is skipped: its rows wait, undelivered, until it lives. A poke has no Orca retry id, so
// the rows are their own write-ahead (fulfil/poke.ts sets `sending_at` before it types): a row a loop
// crash left sending past DOUBT_S (the poke waits 10 s for its turn) is settled delivered here,
// never poked again, so a restart types nothing twice; the receiver's watch.sh still lists it.
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { line, markDelivered, receiverWt, roleName, WAITING, type Message } from "../messages/messages.ts";
import { wake } from "../pause/wake.ts";
import { alertId } from "../core/actuator.ts";
import { limitInt } from "../settings/limits.ts";

const SHOWN = 3;
export const DOUBT_S = 120;

export function wakeText(ms: Message[]): string {
  const more = ms.length > SHOWN ? `; and ${ms.length - SHOWN} more` : "";
  return `dev-studio: ${ms.length} new message${ms.length === 1 ? "" : "s"} for you (${ms.slice(0, SHOWN).map(line).join("; ")}${more}). ` +
    "Read them with ~/.dev-studio/bin/ds msg inbox and ack each with ~/.dev-studio/bin/ds msg ack <id> once handled.";
}

// U277: a message the receiver has not read (`msg_chase_min`, default 15; 0 = off) gets one more poke while the
// receiver is idle, once per oldest-aged-row episode (the chase never records itself as capped, so it raises no
// "Poke unanswered" alert); a needs-reply message with no reply row (`msg_reply_alert_min`, default 60; 0 = off)
// raises one Studio alert naming sender, receiver and subject, and the reply clears it.
export const CHASE_REASON = "msg-chase";
export const REPLY_SUBJECT = "msg-reply:";
export const replyAlertSubject = (id: number) => `${REPLY_SUBJECT}${id}`;

function chase(ctx: TickCtx): Action[] {
  const { store, project, now: at } = ctx, out: Action[] = [];
  const min = limitInt(store, project, "msg_chase_min", 15);
  if (min <= 0) return out;
  const aged = store.db.query("SELECT * FROM messages WHERE project = ? AND read_at IS NULL AND delivered_at IS NOT NULL AND delivered_at <= ? ORDER BY id").all(project, at - min * 60) as Message[];
  const by = new Map<string, Message[]>();
  for (const m of aged) {
    const k = `${m.squad}\0${m.to_role}\0${m.to_suffix}`;
    by.set(k, [...(by.get(k) ?? []), m]);
  }
  for (const ms of by.values()) {
    const m0 = ms[0], to = { project, squad: String(m0.squad), role: String(m0.to_role), suffix: String(m0.to_suffix) };
    const wt = receiverWt(store, to);
    if (!wt) continue;
    const episode = `${to.squad}/${roleName(to.role, to.suffix)}:${m0.id}`;
    // One chase per episode: a recorded one is never asked again (wake's own cap would raise an alert instead).
    const ep = store.get("episodes", { project, subject: wt, kind: `wake:${CHASE_REASON}` });
    if (ep && ep.episode_key === episode) continue;
    const text = `dev-studio: ${ms.length} message${ms.length === 1 ? "" : "s"} for you ${ms.length === 1 ? "is" : "are"} still unread (${ms.slice(0, SHOWN).map(line).join("; ")}${ms.length > SHOWN ? `; and ${ms.length - SHOWN} more` : ""}). ` +
      "Read them with ~/.dev-studio/bin/ds msg inbox and ack each with ~/.dev-studio/bin/ds msg ack <id> once handled.";
    out.push(...wake(ctx, wt, text, CHASE_REASON, episode, { cap: 1, gapS: 0 }).actions);
  }
  return out;
}

function unanswered(ctx: TickCtx): Action[] {
  const { store, project, now: at } = ctx, out: Action[] = [];
  const min = limitInt(store, project, "msg_reply_alert_min", 60);
  const claim = (subject: string, kind: string) => store.get("episodes", { project, subject, kind: `action:${kind}` })?.episode_key;
  const due = min <= 0 ? [] : store.db.query(`SELECT * FROM messages m WHERE m.project = ? AND ${WAITING} AND m.sent_at <= ? ORDER BY m.id`).all(project, at - min * 60) as Message[];
  const open = new Set<string>();
  for (const m of due) {
    const subject = replyAlertSubject(m.id), ep = `reply#${m.id}`;
    open.add(subject);
    const from = m.from_squad ? `${m.from_squad}/${roleName(String(m.from_role), String(m.from_suffix ?? ""))}` : String(m.from_role ?? "unknown");
    const to = `${m.squad}/${roleName(String(m.to_role), String(m.to_suffix ?? ""))}`;
    out.push({ project, squad: String(m.squad), member: null, subject, kind: "alert", episode: ep, payload: {
      title: `${to} has not answered ${from}`,
      text: `${from} asked ${to} for a reply ("${m.subject}", message #${m.id}) and nothing came back in ${min} minutes. ` +
        `What you can do: look at ${to}, or its Lead can; this note goes when the reply arrives.`,
      card: "msg_unanswered" } });
  }
  // The reply, an ended asker or receiver (the shared WAITING test), or a limit turned off clears the alert it raised.
  for (const r of store.db.query("SELECT subject, episode_key FROM episodes WHERE project = ? AND kind = 'action:alert' AND subject LIKE ?").all(project, `${REPLY_SUBJECT}%`) as { subject: string; episode_key: string }[]) {
    if (open.has(r.subject) || claim(r.subject, "alert-clear") === `cleared@${r.episode_key}`) continue;
    out.push({ project, squad: null, member: null, subject: r.subject, kind: "alert-clear", episode: `cleared@${r.episode_key}`, payload: { target: "project", id: alertId(r.subject, r.episode_key) } });
  }
  return out;
}

export function run(ctx: TickCtx): Action[] {
  return [...deliver(ctx), ...chase(ctx), ...unanswered(ctx)];
}

function deliver(ctx: TickCtx): Action[] {
  const { store, project, now: at } = ctx, out: Action[] = [];
  // A reply row held while its open `reply` request carries the answer through Orca (U276) is not in doubt:
  // fulfil/reply.ts delivers it when Orca takes the answer, or clears it for a poke when Orca refuses it.
  const doubt = store.db.query(`SELECT id, to_member FROM messages m WHERE project = ? AND delivered_at IS NULL AND sending_at <= ?
    AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.done_at IS NULL AND r.kind = 'reply' AND json_extract(r.payload, '$.message') = m.id) ORDER BY id`).all(project, at - DOUBT_S) as Message[];
  for (const m of doubt) markDelivered(store, project, [m.id], String(m.to_member), at);
  const open = store.db.query("SELECT * FROM messages WHERE project = ? AND read_at IS NULL AND delivered_at IS NULL AND sending_at IS NULL ORDER BY id").all(project) as Message[];
  const by = new Map<string, Message[]>();
  for (const m of open) {
    const k = `${m.squad}\0${m.to_role}\0${m.to_suffix}`;
    by.set(k, [...(by.get(k) ?? []), m]);
  }
  for (const ms of by.values()) {
    const m0 = ms[0], to = { project, squad: String(m0.squad), role: String(m0.to_role), suffix: String(m0.to_suffix) };
    const wt = receiverWt(store, to);
    if (!wt) continue;
    const ids = ms.map((m) => m.id);
    const w = wake(ctx, wt, wakeText(ms), "msg", `${to.squad}/${roleName(to.role, to.suffix)}:${ids[ids.length - 1]}`, { allowWorking: true, payload: { messages: ids } });
    out.push(...w.actions);
  }
  return out;
}

const reconciler: Reconciler = { name: "messages", run };
export default reconciler;
