// accounts.ts — the operator's on/off switch per account (plan "disable", U2), host-wide.
//
//   setAccountEnabled(store, { agent, account, enabled, by })   the only writer of accounts.state
//   accountDisabled(store, agent, account)                      is it switched off?
//   resolveAccount(store, "<agent>:<account|label>")            the account a CLI name means
//   knownAccounts(store)                                        every known account with its state
//
// A disabled account has accounts.state = 'disabled'; NULL is enabled ('draining' is the v2 hook,
// U25). pick.ts leaves a disabled account out on every rung and accountBlock names it, so nothing new
// starts on it. Members already running there move (provider-billing-fallback U5): the decider stops
// each one when idle, after its journal checkpoint, and its start's pick lands on its next rung
// (switches.ts accountStop); one with nowhere to go keeps running. A disabled Studio moves through
// `studio-move` under studio_move (reconcilers/limits.ts). Enabling moves nobody back: members return
// as after a limit (a Thinker through fallback_return_min). The accounts.tsv
// import upserts only label and observed_at, so the flag survives every refresh. Each change records
// one event, `account_disabled` or `account_enabled`, payload {agent, account, by}; a switch to the
// state it already has changes nothing and records nothing.
// U2 (provider-billing-fallback): enabling an account with a live credits hold also clears the hold
// (credits.ts clearCredits, one `account_credits_cleared` event), even when it was not disabled.
import { now, type Row, type Store } from "../core/store.ts";
import { clearCredits, creditsHold } from "./credits.ts";

export const DISABLED = "disabled";

export function accountDisabled(store: Store, agent: string, account: string | null | undefined): boolean {
  if (!account || account === "-") return false;
  return store.get("accounts", { agent, account })?.state === DISABLED;
}

export function setAccountEnabled(store: Store, req: { agent: string; account: string; enabled: boolean; by: string }, at = now()): { changed: boolean; state: string | null; cleared?: boolean } {
  const { agent, account, enabled, by } = req;
  const r = switchAccount(store, req, at);
  if (!enabled || creditsHold(store, agent, account, at) === null) return r;
  clearCredits(store, agent, account, by, at);
  return { changed: true, state: r.state, cleared: true };
}

function switchAccount(store: Store, req: { agent: string; account: string; enabled: boolean; by: string }, at: number): { changed: boolean; state: string | null } {
  const { agent, account, enabled, by } = req;
  return store.tx(() => {
    const row = store.get("accounts", { agent, account });
    const was = (row?.state as string | null) ?? null;
    const state = enabled ? (was === DISABLED ? null : was) : DISABLED;
    if (row && state === was) return { changed: false, state };
    if (!row && enabled) return { changed: false, state: null };
    if (row) store.db.run("UPDATE accounts SET state = ? WHERE agent = ? AND account = ?", [state, agent, account]);
    else {
      // Known only from accounts.tsv so far (or not at all, when the operator names it ahead of the
      // list): the row starts with the list's label.
      const label = (store.get("observed_accounts", { agent, account })?.label as string | null) ?? null;
      store.db.run("INSERT INTO accounts (agent, account, label, state, observed_at) VALUES (?, ?, ?, ?, ?)", [agent, account, label, state, at]);
    }
    store.event(enabled ? "account_enabled" : "account_disabled", { payload: { agent, account, by } });
    return { changed: true, state };
  });
}

// Every account the host knows (the accounts rows and accounts.tsv's), its label, plan, state and how
// many running members are on it.
export function knownAccounts(store: Store): Row[] {
  return store.db.query(`SELECT k.agent, k.account, COALESCE(o.label, a.label) AS label, o.plan, o.limited_until,
      CASE WHEN a.state IS NULL THEN 'enabled' ELSE a.state END AS state, o.account IS NOT NULL AS listed,
      (SELECT COUNT(*) FROM members m WHERE m.agent = k.agent AND m.account = k.account AND m.status = 'running'
        AND COALESCE(m.want, '') != 'gone') AS running
    FROM (SELECT agent, account FROM accounts UNION SELECT agent, account FROM observed_accounts) k
    LEFT JOIN accounts a ON a.agent = k.agent AND a.account = k.account
    LEFT JOIN observed_accounts o ON o.agent = k.agent AND o.account = k.account
    ORDER BY k.agent, k.account`).all().map((r) => ({ ...(r as Row), listed: !!(r as Row).listed }));
}

// `<agent>:<account|label>` -> the one account it names: an account id first, else a unique
// observed_accounts.label (such as an email). An unknown or ambiguous name is an error.
export function resolveAccount(store: Store, name: string): { agent: string; account: string } | { error: string } {
  const i = name.indexOf(":");
  const agent = i > 0 ? name.slice(0, i) : "", key = i > 0 ? name.slice(i + 1) : "";
  if (!agent || !key) return { error: `'${name}' is not <agent>:<account|label>` };
  const known = knownAccounts(store).filter((r) => r.agent === agent);
  if (known.some((r) => r.account === key)) return { agent, account: key };
  const byLabel = store.db.query("SELECT account FROM observed_accounts WHERE agent = ? AND label = ? ORDER BY account").all(agent, key) as Row[];
  if (byLabel.length === 1) return { agent, account: String(byLabel[0].account) };
  if (byLabel.length > 1) return { error: `'${name}' is ambiguous: label of ${byLabel.map((r) => r.account).join(", ")}` };
  return { error: `no ${agent} account or label '${key}' (ds account list)` };
}
