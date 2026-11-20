// fulfil/alert.ts — kind `alert`: one Studio alert (bin/lib/alerts.sh) for the action's project. Other
// fulfillers and wake() emit these; the claim row makes it one per episode. Payload {title?, text,
// option?, why?}.
import { alert, type Fulfiller } from "../core/actuator.ts";
import { errOf } from "../io/orca.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

const alerts: Fulfiller = {
  name: "alert",
  kinds: ["alert"],
  run: () => [],
  stale: (a) => a.subject === "studio.early",
  async exec(a, x) {
    const p = payloadOf<"alert">(a);
    if (!a.project || !p.text) return { failed: "an alert needs a project and text" };
    // U232: the title says whose card it is; the card keeps the squad, member, unit and reason so a
    // reconciler can tell when it is no longer true (alertGone) without reading the display title.
    const fields = { ...(a.squad ? { squad: a.squad } : {}), ...(a.member ? { member: a.member } : {}), ...(p.unit ? { unit: p.unit } : {}),
      ...(p.card ? { kind: p.card } : {}), ...(p.reason ? { reason: p.reason } : {}), ...p.fields };
    const o = await alert(x.store, a.project, a.subject, a.episode, p.text, { ...p, fields, who: { squad: a.squad, member: a.member, unit: p.unit } });
    return o.code === 0 ? { done: true } : { retry: errOf(o, "alerts.sh") };
  },
};
export default alerts;
