// fulfil/keys.ts — kind `keys`: type keys into a member's agent terminal, Enter only when asked
// (backend `keys`): a digit answers a picker at once. Payload {text, enter?}.
//
// Board chat U19: a payload {keys, via: "board"} presses named keys (contract.ts KEYS, or one digit or
// lowercase letter) with no Enter added: Escape stops a working agent, Up/Down/Enter or a digit picks in
// its menu. It needs only a live terminal (memberReady `interrupt`), so it passes while the member works.
// A press older than KEYS_STALE_S fails (a key typed late lands on whatever shows then): the actuator holds a
// paused member's press, so one filed before a pause goes stale rather than landing after it.
// A member presses through its driver (Orca: the keys' bytes through the adapter's `keys`; a contract
// squad: `terminal.send {keys}`), the Studio through its adopted handle. One try: a failed press is not
// typed again later. Result {ok: true, state: "sent", keys} or {ok: false, error}.
import { failRequest, finishRequest, memberAt, requestActions, type Fulfiller } from "../core/actuator.ts";
import { errOf } from "../io/orca.ts";
import { payloadOf } from "../core/kinds.ts";
import type { Action } from "../core/plugins.ts";
import { studioKeys } from "../squad/studio-send.ts";
import { KEYS, KEYS_MAX, KEYS_STALE_S, keyOk } from "../chat/keys.ts";
import { memberReady } from "../squad/member-ready.ts";
import { paused } from "../pause/pause.ts";
import { STUDIO_SQUAD, studioView } from "../squad/studio.ts";

type X = Parameters<Fulfiller["exec"]>[1];

async function press(a: Action, x: X, keys: unknown[]) {
  const { store, now } = x, wt = a.member, id = (a.payload as { request?: number }).request;
  if (!wt || !keys.length || keys.length > KEYS_MAX || !keys.every(keyOk)) return { failed: `keys are 1 to ${KEYS_MAX} of ${KEYS.join("|")} or one digit or lowercase letter` };
  const fail = (error: string) => { finishRequest(store, a, { ok: false, error }, now); return { done: true as const, result: error }; };
  const at = Number(id == null ? now : store.get("requests", { id })?.created_at ?? now);
  if (now - at > KEYS_STALE_S) return fail(`not pressed: filed ${now - at} s ago`);
  const studio = a.squad === STUDIO_SQUAD;
  if (!studio && paused(store, { project: a.project, squad: a.squad ?? null, member: wt })) return fail("paused");
  const handle = studio ? (studioView(store, a.project)?.member?.handle as string | null) ?? null : null;
  if (studio && !handle) return fail("no Studio terminal adopted");
  const ready = memberReady(store, a.project, wt, now, { quietS: 0, interrupt: true, handle });
  if (!ready.ready) return fail(ready.why);
  const seat = x.act.seat(store, a.project, a.squad ?? null, `${a.subject}:${a.episode}`, wt, now);
  if (handle) {
    const o = await studioKeys(seat, handle, keys as string[]);
    if (o.code !== 0) return fail(errOf(o, "keys"));
  } else {
    const m = memberAt(store, a, wt), r = await x.act.driver(seat, m.agent).keys(m, keys);
    if (!r.ok) return fail(r.error);
  }
  finishRequest(store, a, { ok: true, state: "sent", keys }, now);
  return { done: true as const };
}

const keys: Fulfiller = {
  name: "keys",
  scope: "host",
  kinds: ["keys"],
  run: (ctx) => requestActions(ctx, ["keys"]),
  async exec(a, x) {
    const p = payloadOf<"keys">(a);
    if (Array.isArray(p.keys)) return press(a, x, p.keys);
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
