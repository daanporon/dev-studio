// fulfil/chat.ts — kind `chat` (KTD5, board chat): a message from the operator (U19: it may span lines;
// the backend pastes it whole, so the lines arrive as one message), typed into a
// member's own agent terminal as `dev-studio board, the operator says: <text>`, only once the member
// is ready (memberReady, member-ready.ts; for the Studio studioReady on its adopted handle; for a Claude member
// recent output alone does not hold it, only a fresh transcript or the working marker on screen). Payload
// {text, via?, files?}; `files` are stored image names (chat/files.ts, at most 4, text may then be empty):
// each is resolved inside the squad's chat-files folder and the line ends with ` [images attached; open each
// with your file-reading tool: <abs path>, …]`; a missing file or a bad name fails and types nothing. Member and squad sit on the row. The loop types it; the board only files the row.
//
// The request's `result` (JSON) says where the message is, for the board's chat panel:
//   {"state":"queued","why":…,"since"?:…}     not typed yet, and why; rewritten only when the why changes
//   {"state":"queued","why":"send failed[: <err>]","failing":true,"since"?:…}   the send itself failed (the
//                                               Studio's error text is kept; a member's driver says only "failed")
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
import { failRequest, finishRequest, memberAt, requestActions, type Fulfiller } from "../core/actuator.ts";
import { limitInt } from "../settings/limits.ts";
import { memberReady } from "../squad/member-ready.ts";
import { paused } from "../pause/pause.ts";
import type { Action } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { STUDIO_SQUAD, studioReady, studioView } from "../squad/studio.ts";
import { payloadOf } from "../core/kinds.ts";
import { deliver } from "./poke.ts";
import { studioType } from "../squad/studio-send.ts";
import { STUDIO_MEMBER, sendFailed, sendOk } from "../squad/send-fail.ts";
import { chatLine } from "../chat/turns.ts";
import { CHAT_FILES_MAX, IMAGES_MARK, chatFilePath } from "../chat/files.ts";
import { existsSync } from "node:fs";
import { redact } from "../chat/redact.ts";
import { CHAT_MAX, chatProblem } from "../chat/limits.ts";

export { CHAT_MAX };
const HUB = new Set(["lead", "thinker", "studio"]);

const parse = (s: unknown): Row => { try { const o = JSON.parse(String(s ?? "")); return o && typeof o === "object" ? o : {}; } catch { return {}; } };

// The why a request was last queued with, "" when none.
const lastWhy = (r: Row | null) => { const o = parse(r?.result); return o.state === "queued" ? String(o.why ?? "") : ""; };
const lastFailing = (r: Row | null) => { const o = parse(r?.result); return o.state === "queued" && o.failing === true; };

// `since` (exec only): when the member's own readiness started to be waited on. A chat held back by
// a pause or an earlier chat (run()) has none, so its chat_queue_min starts once it is next in line.
// `failing` (exec only): the send itself failed, so the why is `send failed[: <err>]`; `since` stays as it was.
function queue(store: Store, id: number, why: string, since?: number, failing = false): void {
  const r = store.get("requests", { id });
  if (!r || r.done_at != null || (lastWhy(r) === why && lastFailing(r) === failing)) return;
  store.upsert("requests", { id }, { result: JSON.stringify({ state: "queued", why, ...(failing ? { failing: true } : {}), ...(since != null ? { since } : {}) }) });
}
const sinceOf = (store: Store, id: number): number | undefined => { const n = parse(store.get("requests", { id })?.result).since; return n == null ? undefined : Number(n); };

// The crew-chat.md line: `- <iso> operator → <topic>/<role[-suffix]>: <text, first 200 chars>`.
function crewLog(store: Store, project: string, topic: string, role: string, suffix: string, text: string, at: number, images = 0): void {
  const iso = new Date(at * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const who = `${topic}/${role}${suffix ? `-${suffix}` : ""}`;
  appendFileSync(join(store.root, project, "crew-chat.md"), `- ${iso} operator → ${who}: ${Array.from(text.replace(/\s*\n\s*/g, " ↵ ")).slice(0, 200).join("")}${images ? ` (+${images} image${images === 1 ? "" : "s"})` : ""}\n`);
}

// chat-cancel / chat-now (U4): act on the named chat request of the same project. A chat already done (typed,
// failed or cancelled) is left alone; the control request says so in its result, and the board answers 409 first.
function control(a: Action, store: Store, now: number): { done: true; result: string } | { failed: string } {
  const p = payloadOf<"chat-cancel">(a), t = store.get("requests", { id: p.chat });
  if (!t || t.kind !== "chat" || t.project !== a.project) return { failed: `no chat request ${p.chat} in ${a.project}` };
  if (a.kind === "chat-dismiss") {
    // chat-multiline-send-fails U2: take a failed or cancelled send out of the chat panel (chatJson leaves a dismissed one out).
    const res = parse(t.result);
    if (t.done_at == null || !(res.ok === false || res.state === "cancelled")) return { failed: `chat request ${p.chat} is not a failed or cancelled send` };
    if (res.dismissed_at == null) store.upsert("requests", { id: p.chat }, { result: JSON.stringify({ ...res, dismissed_at: now }) });
    finishRequest(store, a, { ok: true, state: "dismissed" }, now);
    return { done: true, result: "dismissed" };
  }
  if (t.done_at != null) { finishRequest(store, a, { ok: true, state: "already done" }, now); return { done: true, result: "already done" }; }
  if (a.kind === "chat-cancel") {
    finishRequest(store, { ...a, kind: "chat", payload: { request: p.chat } } as Action, { ok: false, state: "cancelled" }, now);
  } else {
    store.upsert("requests", { id: p.chat }, { payload: JSON.stringify({ ...parse(t.payload), now: true }) });
  }
  finishRequest(store, a, { ok: true, state: a.kind === "chat-cancel" ? "cancelled" : "now" }, now);
  return { done: true, result: a.kind };
}

const chat: Fulfiller = {
  name: "chat",
  scope: "host",
  kinds: ["chat", "chat-cancel", "chat-now", "chat-dismiss"],

  run(ctx) {
    const { store } = ctx, out: Action[] = requestActions(ctx, ["chat-cancel", "chat-now", "chat-dismiss"]), first = new Set<string>();
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
    if (a.kind !== "chat") return control(a, x.store, x.now);
    const p = payloadOf<"chat">(a), wt = a.member, { store, now } = x, id = p.request ?? null;
    if (id != null && store.get("requests", { id })?.done_at != null) return { done: true, result: "already done" };   // cancelled (or finished) while this action waited
    const row = parse(id == null ? null : store.get("requests", { id })?.payload);
    const text = String(row.text ?? p.text ?? "").trim();
    const names: unknown[] = Array.isArray(row.files) ? row.files : Array.isArray(p.files) ? p.files : [];
    if (!wt || (!text && !names.length) || id == null) return { failed: "a chat needs a member, text or images, and its request" };
    const why = chatProblem(text);
    if (why) return { failed: why };
    if (names.length > CHAT_FILES_MAX) return { failed: `a chat carries at most ${CHAT_FILES_MAX} images` };
    const paths: string[] = [];
    for (const n of names) {
      const f = typeof n === "string" ? chatFilePath(store.root, a.project, a.squad ?? "", n) : null;
      if (!f) return { failed: `image name ${JSON.stringify(n)} is not a stored chat image` };
      if (!existsSync(f)) return { failed: `image ${n} was removed before it was sent` };
      paths.push(f);
    }
    const studio = a.squad === STUDIO_SQUAD;
    const m = studio ? null : memberAt(store, a, wt);
    // Screen noise alone never holds a chat to a Claude member (memberReady's screenNoise); other agents keep the quiet window.
    // Send now (U4): the operator asked to skip the quiet windows only; the screen read, the prompt, picker and earlier-request checks stay.
    const quietS = row.now === true ? 0 : limitInt(store, a.project, "chat_quiet_s", 10);
    const ready = studio ? studioReady(store, a.project, now, quietS, id, "ignore")
      : memberReady(store, a.project, wt, now, { quietS, agent: m!.agent, before: id, screenNoise: "ignore" });
    if (!ready.ready) {
      const since = Number(parse(store.get("requests", { id })?.result).since ?? now);
      if (now - since >= limitInt(store, a.project, "chat_queue_min", 30) * 60) return { failed: `never ready: ${ready.why}` };
      queue(store, id, ready.why, since);
      return { wait: `queued: ${ready.why}` };
    }
    const line = chatLine(`${text}${text && paths.length ? " " : ""}${paths.length ? `${IMAGES_MARK}${paths.join(", ")}]` : ""}`);
    const seat = x.act.seat(store, a.project, a.squad ?? m?.squad ?? null, `${a.subject}:${a.episode}`, wt, now);
    if (studio) {
      // The Studio's adopted handle only, as poke.ts does: its worktree also holds ds-loop panes and shells.
      const h = studioView(store, a.project)?.member?.handle as string | null;
      if (!h) return { retry: "no Studio terminal adopted" };
      const r = await studioType(seat, h, line);
      if (r.code !== 0) {
        const err = (r.err || r.out || "").trim() || `poke-terminal exit ${r.code}`;
        sendFailed(store, a.project, STUDIO_MEMBER, err, now);
        queue(store, id, `send failed: ${err}`, sinceOf(store, id), true);
        return { retry: `poke-terminal ${h}: not sent: ${err}` };
      }
      sendOk(store, a.project, STUDIO_MEMBER, now);
      finishRequest(store, a, { ok: true, state: "sent", delivered: "sent" }, now);
      return { done: true, result: "sent" };
    }
    const r = await x.act.driver(seat, m!.agent).poke(m!, line);
    if (r === "failed") {
      sendFailed(store, a.project, wt, "send failed", now);
      queue(store, id, "send failed", sinceOf(store, id), true);
      return { retry: `chat ${wt}: not sent` };
    }
    sendOk(store, a.project, wt, now);
    const delivery = r === "accepted" ? deliver(store, { project: a.project, squad: a.squad ?? m!.squad, member: wt, kind: "chat", text: line, request: id }, now) : null;
    finishRequest(store, a, { ok: true, state: r === "started" ? "turn started" : "sent", delivered: r, delivery }, now);
    if (m!.role && !HUB.has(m!.role)) {
      try { crewLog(store, a.project, a.squad ?? m!.squad, m!.role, m!.suffix, text, now, paths.length); }
      catch (e) { store.event("plugin_error", { project: a.project, payload: { plugin: "chat", error: `crew-chat.md: ${e instanceof Error ? e.message : String(e)}` } }); }
    }
    return { done: true, result: r };
  },

  giveUp: (a, x, why) => failRequest(a, x, why),
};
export default chat;
