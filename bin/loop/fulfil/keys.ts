// fulfil/keys.ts — kind `keys`: type keys into a member's agent terminal, Enter only when asked
// (backend `keys`): a digit answers a picker at once. Payload {text, enter?}.
import { failRequest, finishRequest, requestActions, type Fulfiller } from "../core/actuator.ts";
import { errOf } from "../io/orca.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

const keys: Fulfiller = {
  name: "keys",
  scope: "host",
  kinds: ["keys"],
  run: (ctx) => requestActions(ctx, ["keys"]),
  async exec(a, x) {
    const p = payloadOf<"keys">(a);
    if (!a.member || !p.text) return { failed: "keys need a member and text" };
    const o = await x.act.seat(x.store, a.project, a.squad ?? null, `${a.subject}:${a.episode}`, a.member, x.now)
      .send("keys", [a.member, p.text, ...(p.enter ? ["enter"] : [])]);
    // The text landed and only the Enter did not: typing it again would double it.
    if (o.code !== 0) return p.enter && /Enter failed/.test(o.err) ? { failed: `typed the text but not the Enter: ${errOf(o, "keys")}` } : { retry: errOf(o, "keys") };
    finishRequest(x.store, a, { ok: true }, x.now);
    return { done: true };
  },
  giveUp: failRequest,
};
export default keys;
