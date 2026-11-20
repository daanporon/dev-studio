// fulfil/chat.ts — kind `chat` (KTD5, board chat): a one-line message from the operator, typed into a
// member's own agent terminal as `dev-studio board, the operator says: <text>`, only once the member
// is ready (memberReady, member-ready.ts; for the Studio studioReady on its adopted handle). Payload
// {text, via?}; member and squad sit on the row. The loop types it; the board only files the row.
//
// The request's `result` (JSON) says where the message is, for the board's chat panel:
//   {"state":"queued","why":…,"since"?:…}     not typed yet, and why; rewritten only when the why changes
//   {"ok":true,"state":"sent"|"turn started",…} typed; `delivery` names the deliveries row of a send the
//                                               agent only accepted, which poke.ts's verify turns into
//                                               verified (turn started) or escalates
//   {"ok":false,"error":"never ready: …"}       failed with the last why after chat_queue_min of waiting
//                                               on the member itself (not on a pause or an earlier chat)
// One member's chats go oldest first, one at a time: a later one waits for the earlier to be typed and
// taken. A paused member's chat stays queued and is never typed. A chat to a non-hub member (not Lead,
// Thinker or Studio) also appends one line to state/<label>/crew-chat.md, which the squad Lead's next
// watch tick shows under CREW CHAT: (bin/commands/watch-ts.ts) — a log line, never mail, so nothing wakes it.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { failRequest, finishRequest, memberAt, type Fulfiller } from "../core/actuator.ts";
import { limitInt } from "../settings/limits.ts";
import { memberReady } from "../squad/member-ready.ts";
import { paused } from "../pause/pause.ts";
import type { Action } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { STUDIO_SQUAD, studioReady, studioView } from "../squad/studio.ts";
import { payloadOf } from "../core/kinds.ts";
import { deliver } from "./poke.ts";
import { chatLine } from "../chat/turns.ts";
import { redact } from "../chat/redact.ts";

export const CHAT_MAX = 2000;
const HUB = new Set(["lead", "thinker", "studio"]);

const parse = (s: unknown): Row => { try { const o = JSON.parse(String(s ?? "")); return o && typeof o === "object" ? o : {}; } catch { return {}; } };

// The why a request was last queued with, "" when none.
const lastWhy = (r: Row | null) => { const o = parse(r?.result); return o.state === "queued" ? String(o.why ?? "") : ""; };

// `since` (exec only): when the member's own readiness started to be waited on. A chat held back by
// a pause or an earlier chat (run()) has none, so its chat_queue_min starts once it is next in line.
function queue(store: Store, id: number, why: string, since?: number): void {
  const r = store.get("requests", { id });
  if (!r || r.done_at != null || lastWhy(r) === why) return;
  store.upsert("requests", { id }, { result: JSON.stringify({ state: "queued", why, ...(since != null ? { since } : {}) }) });
}

// The crew-chat.md line: `- <iso> operator → <topic>/<role[-suffix]>: <text, first 200 chars>`.
function crewLog(store: Store, project: string, topic: string, role: string, suffix: string, text: string, at: number): void {
  const iso = new Date(at * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const who = `${topic}/${role}${suffix ? `-${suffix}` : ""}`;
  appendFileSync(join(store.root, project, "crew-chat.md"), `- ${iso} operator → ${who}: ${Array.from(text).slice(0, 200).join("")}\n`);
}

const chat: Fulfiller = {
  name: "chat",
  scope: "host",
  kinds: ["chat"],

  run(ctx) {
    const { store } = ctx, out: Action[] = [], first = new Set<string>();
    const rows = store.db.query("SELECT * FROM requests WHERE done_at IS NULL AND kind = 'chat' ORDER BY id").all() as Row[];
    for (const r of rows) {
      const id = Number(r.id), project = String(r.project ?? ""), squad = (r.squad as string | null) ?? null, member = (r.member as string | null) ?? null;
      const k = `${project}|${member}`;
      if (first.has(k)) { queue(store, id, "an earlier message waits"); continue; }
      first.add(k);
      if (member && squad !== STUDIO_SQUAD && paused(store, { project, squad, member })) { queue(store, id, "paused"); continue; }
      out.push({ project, squad, member, subject: `req:${id}`, kind: "chat", episode: `req:${id}`, payload: { ...parse(r.payload), text: redact(String(parse(r.payload).text ?? "")), request: id } });   // the action and its events never hold a raw secret; exec types the request row's text
    }
    return out;
  },

  async exec(a, x) {
    const p = payloadOf<"chat">(a), wt = a.member, { store, now } = x, id = p.request ?? null;
    const text = String(parse(id == null ? null : store.get("requests", { id })?.payload).text ?? p.text ?? "");
    if (!wt || !text || id == null) return { failed: "a chat needs a member, text and its request" };
    if (/[\u0000-\u001f\u007f]/.test(text) || Array.from(text).length > CHAT_MAX) return { failed: `a chat is one line of at most ${CHAT_MAX} characters` };
    const studio = a.squad === STUDIO_SQUAD;
    const m = studio ? null : memberAt(store, a, wt);
    const ready = studio ? studioReady(store, a.project, now, 120, id)
      : memberReady(store, a.project, wt, now, { quietS: limitInt(store, a.project, "chat_quiet_s", 10), agent: m!.agent, before: id });
    if (!ready.ready) {
      const since = Number(parse(store.get("requests", { id })?.result).since ?? now);
      if (now - since >= limitInt(store, a.project, "chat_queue_min", 30) * 60) return { failed: `never ready: ${ready.why}` };
      queue(store, id, ready.why, since);
      return { wait: `queued: ${ready.why}` };
    }
    const line = chatLine(text);
    const seat = x.act.seat(store, a.project, a.squad ?? m?.squad ?? null, `${a.subject}:${a.episode}`, wt, now);
    if (studio) {
      // The Studio's adopted handle only, as poke.ts does: its worktree also holds ds-loop panes and shells.
      const h = studioView(store, a.project)?.member?.handle as string | null;
      if (!h) return { retry: "no Studio terminal adopted" };
      const r = await seat.send("poke-terminal", [h, line]);
      if (r.code !== 0) return { retry: `poke-terminal ${h}: not sent` };
      finishRequest(store, a, { ok: true, state: "sent", delivered: "sent" }, now);
      return { done: true, result: "sent" };
    }
    const r = await x.act.driver(seat, m!.agent).poke(m!, line);
    if (r === "failed") return { retry: `chat ${wt}: not sent` };
    const delivery = r === "accepted" ? deliver(store, { project: a.project, squad: a.squad ?? m!.squad, member: wt, kind: "chat", text: line, request: id }, now) : null;
    finishRequest(store, a, { ok: true, state: r === "started" ? "turn started" : "sent", delivered: r, delivery }, now);
    if (m!.role && !HUB.has(m!.role)) {
      try { crewLog(store, a.project, a.squad ?? m!.squad, m!.role, m!.suffix, text, now); }
      catch (e) { store.event("plugin_error", { project: a.project, payload: { plugin: "chat", error: `crew-chat.md: ${e instanceof Error ? e.message : String(e)}` } }); }
    }
    return { done: true, result: r };
  },

  giveUp: (a, x, why) => failRequest(a, x, why),
};
export default chat;
