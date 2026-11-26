// fulfil/account-reset.ts — kind `account-reset` (account-free-resets U4): use one free reset grant, for
// an operator's press of the board's Use button (POST /api/account-reset files the request with its
// idempotency key). The backend's `account-reset-use` runs in the background; this module is its only
// caller. An answer finishes the request with the outcome, logs `account_reset_used` and starts one
// accounts refresh, so the board's figures and grants are read again. No answer (network, timeout:
// exit 1, no outcome line) is a retry, and every retry passes the same key, so the provider sees one
// claim however often it is tried. Given up, the request fails and a `failed` event is logged.
import { join } from "node:path";
import { failRequest, finishRequest, requestActions, type Exec, type Fulfiller } from "../core/actuator.ts";
import { payloadOf } from "../core/kinds.ts";
import type { Action } from "../core/plugins.ts";
import { errOf } from "../io/orca.ts";
import { ROOT } from "../core/store.ts";

const OUTCOMES = new Set(["used", "nothing_to_reset", "no_grant", "already_used", "failed"]);

/** The forced accounts refresh (accounts-refresh.sh without --max-age), detached like the state observer's. */
export function refreshAccounts(root: string): void {
  Bun.spawn([join(ROOT, "bin", "lib", "accounts-refresh.sh")],
    { env: { ...process.env, DS_STATE_ROOT: root }, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
}

function logUse(x: Exec, a: Action, outcome: string, detail: string): void {
  const p = payloadOf<"account-reset">(a);
  const by = p.request == null ? null
    : (x.store.db.query("SELECT requested_by FROM requests WHERE id = ?").get(p.request) as { requested_by: string | null } | null)?.requested_by ?? null;
  x.store.event("account_reset_used", { project: a.project || null, payload: { agent: p.agent, account: p.account, grant: p.grant, outcome, detail, by } });
}

export function accountReset(opts: { refresh?: (root: string) => void } = {}): Fulfiller {
  const refresh = opts.refresh ?? refreshAccounts;
  return {
    name: "account-reset",
    scope: "host",
    kinds: ["account-reset"],
    run: (ctx) => requestActions(ctx, ["account-reset"]),
    exec(a, x) {
      const p = payloadOf<"account-reset">(a);
      return {
        background: (async () => {
          const o = await x.act.orca.run("account-reset-use", [p.agent, p.account, p.grant, p.key]);
          const [outcome, ...rest] = o.out.split("\n")[0].split("\t");
          if (o.code !== 0 || !OUTCOMES.has(outcome)) return { retry: `account-reset-use: ${errOf(o, "account-reset-use")}` };
          const detail = rest.join(" ").trim();
          logUse(x, a, outcome, detail);
          finishRequest(x.store, a, { ok: outcome !== "failed", outcome, detail, ...(outcome === "failed" ? { error: detail || "failed" } : {}) }, x.now);
          refresh(x.store.root);
          return { done: true as const, result: outcome };
        })(),
      };
    },
    giveUp(a, x, why) {
      logUse(x, a, "failed", why);
      return failRequest(a, x, why);
    },
  };
}

export default accountReset();
