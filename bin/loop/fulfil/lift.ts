// fulfil/lift.ts — kind `limit-lift`: lift one account's limit by hand (`ds limit-lift <agent> <account>`,
// U107). A limit that should never have counted (a quoted notice) or one the operator knows has
// passed would otherwise park the account until its until. account-lift.ts liftAccount clears all three
// things the picker reads; an account with a live credits hold is cleared through credits.ts clearCredits
// instead (U2). It logs one `account_limit_lifted` event. A new real notice blocks the account again as
// before.
import type { Row } from "../core/store.ts";
import { failRequest, finishRequest, requestActions, type Fulfiller } from "../core/actuator.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";
import { liftAccount } from "../capacity/account-lift.ts";
import { clearCredits, creditsHold } from "../capacity/credits.ts";

const lift: Fulfiller = {
  name: "lift",
  scope: "host",
  kinds: ["limit-lift"],
  run: (ctx) => requestActions(ctx, ["limit-lift"]),
  exec(a, x) {
    const p = payloadOf<"limit-lift">(a);
    const { store, now: at } = x;
    if (!p.agent || !p.account) return { failed: "a limit-lift needs an agent and an account" };
    const { agent, account } = p;
    const reqId = (a.payload as { request?: number } | undefined)?.request;
    const by = reqId == null ? "ds" : String((store.db.query("SELECT requested_by FROM requests WHERE id = ?").get(reqId) as Row | null)?.requested_by ?? "ds");
    // U2: a credits hold is cleared the same way `ds account enable` clears it, so the billing notice
    // still on a member's screen does not hold the account again on the next tick.
    const lifted = creditsHold(store, agent, account, at) !== null ? clearCredits(store, agent, account, by, at) : liftAccount(store, agent, account, at);
    store.event("account_limit_lifted", { project: a.project || null, payload: { ...lifted, by } });
    finishRequest(store, a, { ok: true, ...lifted }, at);
    return { done: true, result: lifted.episodes + lifted.observed + lifted.members + lifted.files };
  },
  giveUp: failRequest,
};
export default lift;
