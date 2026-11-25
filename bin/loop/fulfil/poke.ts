// fulfil/poke.ts — kind `poke`: type text into a member's agent terminal with `--wait-submit`
// (backend `poke`: exit 0 a turn started, 3 the text landed but no turn yet, else not sent).
// Three sources: wake() (its episode does the backoff, so nothing more here), `requests` rows of
// kind poke (`ds nudge poke`, the board), and the resends below. A send that is only accepted
// becomes a `deliveries` row; the next tick checks the member is working, else sends it again, and
// after DS_LOOP_VERIFY_TRIES sends (default 2) raises one Studio alert (a board chat's delivery is
// never resent: one alert after CHAT_TAKE_S). A send that fails leaves the
// action pending for the next tick.
//
// A payload with `handle` (U263: wake() for the Studio) goes out through `poke-terminal <handle>` only,
// never by worktree: the Studio's worktree also holds ds-loop panes and shells. Right before it types,
// the handle must still be the Studio's and studioReady() must still hold (a turn may have started,
// the operator may be typing); if not, nothing is sent and the wake episode is marked `unsent`, so it
// counts as no compaction and the reconciler tries again once the Studio is ready.
import { failRequest, finishRequest, memberAt, requestActions, type Exec, type Fulfiller } from "../core/actuator.ts";
import { memberIn } from "../messages/cards.ts";
import type { Action, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { paused } from "../pause/pause.ts";
import { offOrca } from "../squad/backend.ts";
import { studioReady, studioView } from "../squad/studio.ts";
import { studioType } from "../squad/studio-send.ts";
import { STUDIO_MEMBER, sendFailed, sendOk } from "../squad/send-fail.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";
import { clearSending, markDelivered, markSending } from "../messages/messages.ts";

const verifyTries = () => envInt("DS_LOOP_VERIFY_TRIES", 2);
export const CHAT_TAKE_S = 60;
// U20b: a send that is only `accepted` on a backend off Orca (tmux, herdr: no `turn_started`) gets this long
// to be taken before it is resent; the contract observer reads the member `working` a few seconds later.
// Orca's sends keep their 1 s.
const takeS = () => envInt("DS_LOOP_DELIVERY_TAKE_S", 30);
function verifyAfter(store: Store, project: string, member: string, at: number): number {
  return at + (offOrca(store, project).wts.has(member) ? takeS() : 1);
}
type P = ActionPayload<"poke">;

// Taken since the send: the turn the text asked for ran. Seen working is the direct case; a
// short turn that started and ended between ticks (or a slow first start) is never seen working,
// so a terminal done/idle state entered at or after the send counts too. `since` is epoch seconds
// (migration 0003-u4), like the delivery's `at`. Only agent state counts — never terminal output
// time, which the poke's own typed text would pollute.
function working(store: Store, d: Row): boolean {
  const w = store.db.query("SELECT state, since, observed_at FROM observed_workers WHERE project = ? AND wt = ?").get(String(d.project), String(d.member)) as Row | null;
  if (!w) return false;
  if (w.state === "working" && Number(w.observed_at) >= Number(d.at)) return true;
  // U20b: off Orca the transcript growing since the send is the agent taking it (no native state to read).
  if (offOrca(store, String(d.project)).wts.has(String(d.member))) {
    const t = store.db.query("SELECT MAX(mtime) AS t FROM observed_transcripts WHERE project = ? AND wt = ?").get(String(d.project), String(d.member)) as { t: number | null };
    if (t.t != null && Number(t.t) > Number(d.at)) return true;
  }
  return (w.state === "done" || w.state === "idle") && w.since != null && Number(w.since) >= Number(d.at);
}

export function deliver(store: Store, d: { project: string; squad: string | null; member: string; kind: string; text: string; request?: number | null }, at: number): number {
  const r = store.db.run("INSERT INTO deliveries (project, squad, member, kind, text, request, tries, state, at, verify_at) VALUES (?, ?, ?, ?, ?, ?, 1, 'accepted', ?, ?)",
    [d.project, d.squad, d.member, d.kind, d.text, d.request ?? null, at, verifyAfter(store, d.project, d.member, at)]);
  return Number(r.lastInsertRowid);
}

function setDelivery(store: Store, id: number, set: Row, kind: string, d: Row) {
  store.fact(kind, [{ table: "deliveries", key: { id }, set }], { project: String(d.project), squad: d.squad as string | null, member: String(d.member), payload: { delivery: id, ...set } });
}

// The wake() episode a poke attempt belongs to: `<reason>:<episode>#<n>` minus reason and attempt.
function wakeEpisode(a: Action, reason: string): string { return a.episode.slice(reason.length + 1).replace(/#\d+$/, ""); }

function verify(ctx: TickCtx): Action[] {
  const { store, now: at } = ctx, out: Action[] = [];
  const due = store.db.query("SELECT * FROM deliveries WHERE state = 'accepted' AND verify_at <= ? ORDER BY id").all(at) as Row[];
  for (const d of due) {
    const id = Number(d.id), project = String(d.project), squad = (d.squad as string | null) ?? null, member = String(d.member);
    if (working(store, d)) { setDelivery(store, id, { state: "verified", settled_at: at }, "delivery_verified", d); continue; }
    if (paused(store, { project, squad, member })) continue;
    const tries = Number(d.tries);
    // A board chat (fulfil/chat.ts) is never resent: a second copy would be typed past its ready guard.
    // It gets CHAT_TAKE_S to start a turn, then the same one alert.
    if (d.kind === "chat") { if (at < Number(d.at) + CHAT_TAKE_S) continue; }
    else if (tries < verifyTries()) {
      out.push({ project, squad, member, subject: `deliver:${id}`, kind: "poke", episode: `deliver:${id}#${tries + 1}`, payload: { text: d.text, delivery: id } });
      continue;
    }
    setDelivery(store, id, { state: "escalated", settled_at: at }, "delivery_escalated", d);
    out.push({ project, squad, member, subject: `deliver:${id}`, kind: "alert", episode: "escalated",
      payload: { title: d.kind === "chat" ? "Chat not taken" : "Poke not taken", card: "poke_not_taken", option: "looked at it", why: "the agent never started on the poke",
        text: `${memberIn(store, project, member, squad)} was sent its ${d.kind} ${tries === 1 ? "once" : `${tries} times`} and never started working on it. What you can do: open its terminal and check.` } });
  }
  return out;
}

const poke: Fulfiller = {
  name: "poke",
  scope: "host",
  kinds: ["poke"],
  run: (ctx) => [...requestActions(ctx, ["poke"]), ...verify(ctx)],

  stale(a, x) {
    const p = payloadOf<"poke">(a);
    if (p.delivery != null) return (x.store.get("deliveries", { id: p.delivery })?.state ?? "") !== "accepted";
    if (!p.reason) return false;
    const ep = x.store.get("episodes", { project: a.project, subject: a.member ?? a.subject, kind: `wake:${p.reason}` });
    return !ep || ep.episode_key !== wakeEpisode(a, p.reason) || ep.ended_at != null;
  },

  async exec(a, x: Exec) {
    const p = payloadOf<"poke">(a), wt = a.member ?? p.wt ?? null, { store, now: at } = x;
    if (!wt || !p.text) return { failed: "a poke needs a member and text" };
    if (p.handle) {
      const v = studioView(store, a.project), ready = studioReady(store, a.project, at, p.quietS ?? 120);
      const why = v?.member?.handle !== p.handle ? `${p.handle} is no longer the Studio's terminal` : ready.ready ? null : ready.why;
      if (why) {
        if (p.reason) store.db.run("UPDATE episodes SET state = 'unsent', ended_at = ?, observed_at = ? WHERE project = ? AND subject = ? AND kind = ?", [at, at, a.project, wt, `wake:${p.reason}`]);
        return { done: true, result: `not sent: ${why}` };
      }
      const seat = x.act.seat(store, a.project, a.squad ?? null, `${a.subject}:${a.episode}`, wt, at);
      const r = await studioType(seat, p.handle, p.text);
      if (r.code === 0) { sendOk(x.store, a.project, STUDIO_MEMBER, at); return { done: true, result: "sent" }; }
      const err = (r.err || r.out || "").trim();
      sendFailed(x.store, a.project, STUDIO_MEMBER, err || `poke-terminal exit ${r.code}`, at);
      return { retry: `poke-terminal ${p.handle}: not sent${err ? `: ${err}` : ""}` };
    }
    const m = memberAt(store, a, wt);
    const seat = x.act.seat(store, a.project, a.squad ?? m.squad, `${a.subject}:${a.episode}`, wt, at);
    // U45: a poke has no Orca retry id, so a message wake writes ahead on the rows themselves.
    const sending = p.messages?.length ? markSending(store, a.project, p.messages, wt, at) : [];
    if (p.messages?.length && !sending.length) return { done: true, result: "delivered or being sent already" };
    let r: Awaited<ReturnType<ReturnType<typeof x.act.driver>["poke"]>>;
    try { r = await x.act.driver(seat, m.agent).poke(m, p.text); }
    catch (e) { clearSending(store, sending); throw e; }
    if (r === "failed") { clearSending(store, sending); return { retry: `poke ${wt}: not sent` }; }
    if (p.delivery != null) {
      const d = store.get("deliveries", { id: p.delivery })!;
      setDelivery(store, p.delivery, r === "started" ? { state: "verified", tries: Number(d.tries) + 1, at, settled_at: at } : { tries: Number(d.tries) + 1, at, verify_at: verifyAfter(store, a.project, wt, at) }, "delivery_sent", d);
      return { done: true, result: r };
    }
    // U45: a message wake that went out (started or accepted) delivered its rows.
    if (sending.length) markDelivered(store, a.project, sending, wt, at);
    if (p.reason) return { done: true, result: r };
    const delivery = r === "accepted" ? deliver(store, { project: a.project, squad: a.squad ?? null, member: wt, kind: "poke", text: p.text, request: p.request }, at) : null;
    finishRequest(store, a, { ok: true, delivered: r, delivery }, at);
    return { done: true, result: r };
  },

  giveUp(a, x, why) {
    const p = payloadOf<"poke">(a);
    // A resend that never went out: let the next verify escalate it.
    if (p.delivery != null) x.store.db.run("UPDATE deliveries SET tries = ?, verify_at = ? WHERE id = ? AND state = 'accepted'", [verifyTries(), x.now, p.delivery]);
    else return failRequest(a, x, why);
  },
};
export default poke;
