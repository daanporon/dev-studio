// fulfil/reply.ts — kind `reply`: the Lead's answer to a worker's question the loop relayed (U61,
// `ds reply <id> "<answer>"`). Payload {id, run, answer}. Only the Run's coordinator may reply, and
// that is the loop's pane, so the reply goes from there (seat.call: write-ahead with a retry id, and
// a fenced pane is bound again once); the worker's parked `ask` returns the answer. A question Orca
// no longer takes an answer for (already answered differently, its ask timed out or its dispatch
// ended, no such question) is recorded on the request and not retried; the same answer again is
// Orca's duplicate, so done.
// U276: an answer given with `ds msg reply` to a relayed question carries its reply row (`message`), held sending
// while Orca carries it: delivered and read once the parked ask got it, plain mail (the wake poke reaches the
// worker) when Orca takes no answer for it.
import { failRequest, finishRequest, requestActions, type Fulfiller } from "../core/actuator.ts";
import { errOf } from "../io/orca.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";
import { clearSending, markDelivered } from "../messages/messages.ts";
import type { Store } from "../core/store.ts";

type P = ActionPayload<"reply">;
const REFUSED = /question_not_found|dispatch_inactive|answer_conflict|Message not found|legacy_read_only|request_mismatch/;

/** The reply row went back with the parked ask: delivered to its worker and read there. */
function carried(store: Store, project: string, id: number | undefined, at: number): void {
  if (!id) return;
  const m = store.get("messages", { id });
  if (!m || m.read_at != null) return;
  if (m.delivered_at == null) markDelivered(store, project, [id], String(m.to_member ?? ""), at);
  store.fact("message_read", [{ table: "messages", key: { id }, set: { read_at: at } }], { project, squad: String(m.squad), payload: { ids: [id], by: "orca ask" } });
}

const reply: Fulfiller = {
  name: "reply",
  scope: "host",
  kinds: ["reply"],
  run: (ctx) => requestActions(ctx, ["reply"]),
  async exec(a, x) {
    const p = payloadOf<"reply">(a);
    if (!p.id || !p.run || !p.answer || !a.squad) return { failed: "a reply needs a squad, a question id, its run and the answer" };
    const out = await x.act.seat(x.store, a.project, a.squad, `${a.subject}:${a.episode}`, null, x.now).call("reply", [p.id, p.run, p.answer]);
    if (out.code === 0) {
      finishRequest(x.store, a, { ok: true }, x.now);
      carried(x.store, a.project, p.message, x.now);
      x.store.event("question_replied", { project: a.project, squad: a.squad, payload: { id: p.id, run: p.run } });
      return { done: true };
    }
    const why = errOf(out, "reply");
    return REFUSED.test(why) ? { failed: `question ${p.id} takes no answer now: ${why}` } : { retry: why };
  },
  giveUp(a, x, why) {
    failRequest(a, x, why);
    const p = payloadOf<"reply">(a);
    if (p?.message) clearSending(x.store, [p.message]);
    x.store.event("question_reply_refused", { project: a.project, squad: a.squad, payload: { id: p?.id, why } });
    return true;
  },
};
export default reply;
