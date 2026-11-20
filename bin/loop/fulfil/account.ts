// fulfil/account.ts — kind `account`: the board's Enable/Disable button on an account row (plan "disable", U3).
// Payload {agent, account, enabled}: calls accounts.ts setAccountEnabled, the one writer `ds account`
// uses too, which flips accounts.state and records `account_disabled` / `account_enabled` (by "board").
// Host-wide: nothing moves or restarts because an account was switched off (members switch at their
// next restart). A switch to the state it already has changes nothing and is still a done request.
import { failRequest, finishRequest, requestActions, type Fulfiller } from "../core/actuator.ts";
import { setAccountEnabled } from "../capacity/accounts.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

const account: Fulfiller = {
  name: "account",
  scope: "host",
  kinds: ["account"],
  run: (ctx) => requestActions(ctx, ["account"]),
  exec(a, x) {
    const p = payloadOf<"account">(a);
    if (!p.agent || !p.account || typeof p.enabled !== "boolean") return { failed: "an account switch needs an agent, an account and enabled true/false" };
    const r = setAccountEnabled(x.store, { agent: p.agent, account: p.account, enabled: p.enabled, by: "board" }, x.now);
    finishRequest(x.store, a, { ok: true, changed: r.changed, state: r.state }, x.now);
    return { done: true, result: r.state };
  },
  giveUp: failRequest,
};
export default account;
