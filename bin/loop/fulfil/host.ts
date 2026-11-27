// fulfil/host.ts — side-loop-host U17 (issue #127): the board's Hosts actions, the same code as `ds host`
// (link/host-keys.ts, settings/host-settings.ts), as actor `board`. Host-wide requests, no project:
//   host-member {host, action: accept|reject, fingerprint}  the Needs-you card of a pending join; refused when the
//               pending row's fingerprint is no longer the one the card showed
//   host-member {host, action: remove}                      Remove on a Hosts row
//   host-key    {host, key, value?}                         one host's override of a [host] key; no value drops it
import { failRequest, finishRequest, requestActions, type Fulfiller } from "../core/actuator.ts";
import { accept, reject, remove } from "../../link/host-keys.ts";
import { HostSettingsError, rmHostKey, setHostKey } from "../settings/host-settings.ts";
import { BOARD_ACTOR } from "./config.ts";

const KINDS = ["host-member", "host-key"];
type P = { host?: string; action?: string; fingerprint?: string; key?: string; value?: string | null };

const host: Fulfiller = {
  name: "host",
  scope: "host",
  kinds: KINDS,
  run: (ctx) => requestActions(ctx, KINDS),
  async exec(a, x) {
    const p = (a.payload ?? {}) as P;
    if (!p.host) return { failed: `a ${a.kind} request needs a host` };
    if (a.kind === "host-member") {
      const verb = p.action;
      if (verb !== "accept" && verb !== "reject" && verb !== "remove") return { failed: "a host-member request is accept, reject or remove" };
      if (verb !== "remove" && !p.fingerprint) return { failed: `${verb} needs the fingerprint the operator saw` };
      const opts = { by: BOARD_ACTOR, fingerprint: p.fingerprint };
      const r = (verb === "accept" ? accept : verb === "reject" ? reject : remove)(x.store, p.host, opts, x.now);
      if (!r.ok) return { failed: r.why };
      finishRequest(x.store, a, { ok: true, ran: `host ${verb} ${p.host}` }, x.now);
      return { done: true };
    }
    if (!p.key) return { failed: "a host-key request needs a key" };
    try {
      const changes = p.value == null ? rmHostKey(x.store, p.host, p.key, BOARD_ACTOR, x.now) : setHostKey(x.store, p.host, p.key, String(p.value), BOARD_ACTOR, x.now);
      finishRequest(x.store, a, { ok: true, ran: `host ${p.value == null ? "rm" : "set"} ${p.host} ${p.key}`, changed: changes.length }, x.now);
      return { done: true };
    } catch (err) {
      if (err instanceof HostSettingsError) return { failed: err.message };
      throw err;
    }
  },
  giveUp: failRequest,
};
export default host;
