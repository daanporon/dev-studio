// accounts.ts — the operator's on/off switch per account (plan "disable", U2), host-wide.
//
//   setAccountEnabled(store, { agent, account, enabled, by })   the only writer of accounts.state
//   accountDisabled(store, agent, account)                      is it switched off?
//   resolveAccount(store, "<agent>:<account|label>")            the account a CLI name means
//   knownAccounts(store)                                        every known account with its state
//   mergeOrcaImport / parseAccountFolders / copyLoginIds        the state observer's merge of the refresh's files
//   setDefaultAccount / removeAccount                           `ds account default|remove` (issue #125)
//   addAccount                                                  `ds account add`'s row: added, back or already there (U5)
//   moveProblem / moveAccountRow / accountMembers               `ds account move`: its refusals and its row (U8)
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
// (credits.ts clearCredits, one `account_credits_cleared` event), even when it was not disabled. So does
// a live login hold (claude-login-ended U2: login.ts clearLogin, one `account_login_cleared` event).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { now, type FactRow, type Row, type Store } from "../core/store.ts";
import { accountFolder, type AccountRow } from "../../lib/account-dirs.ts";
import { findKind } from "../../lib/account-kinds/index.ts";
import { clearCredits, creditsHold } from "./credits.ts";
import { clearLogin, loginHold } from "./login.ts";

export const DISABLED = "disabled";

export function accountDisabled(store: Store, agent: string, account: string | null | undefined): boolean {
  if (!account || account === "-") return false;
  return store.get("accounts", { agent, account })?.state === DISABLED;
}

export function setAccountEnabled(store: Store, req: { agent: string; account: string; enabled: boolean; by: string }, at = now()): { changed: boolean; state: string | null; cleared?: boolean } {
  const { agent, account, enabled, by } = req;
  const r = switchAccount(store, req, at);
  if (!enabled) return r;
  const credits = creditsHold(store, agent, account, at) !== null, login = loginHold(store, agent, account, at) !== null;
  if (credits) clearCredits(store, agent, account, by, at);
  if (login) clearLogin(store, agent, account, by, at);
  return credits || login ? { changed: true, state: r.state, cleared: true } : r;
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
      a.source, a.config_dir, a.login_id, COALESCE(a.orca_listed, 0) AS orca_listed, COALESCE(a.is_default, 0) AS is_default, a.removed_at,
      (SELECT COUNT(*) FROM members m WHERE m.agent = k.agent AND m.account = k.account AND m.status = 'running'
        AND COALESCE(m.want, '') != 'gone') AS running
    FROM (SELECT agent, account FROM accounts UNION SELECT agent, account FROM observed_accounts) k
    LEFT JOIN accounts a ON a.agent = k.agent AND a.account = k.account
    LEFT JOIN observed_accounts o ON o.agent = k.agent AND o.account = k.account
    ORDER BY k.agent, k.account`).all().map((r) => {
      const x = r as Row;
      return { ...x, listed: !!x.listed, orca_listed: !!x.orca_listed, is_default: !!x.is_default };
    });
}

// `<agent>:<account|label>` -> the one account it names: an account id first, else a unique
// observed_accounts.label (such as an email). An unknown or ambiguous name is an error.
export function resolveAccount(store: Store, name: string): { agent: string; account: string } | { error: string } {
  const i = name.indexOf(":");
  const agent = i > 0 ? name.slice(0, i) : "", key = i > 0 ? name.slice(i + 1) : "";
  if (!agent || !key) return { error: `'${name}' is not <agent>:<account|label>` };
  const known = knownAccounts(store).filter((r) => r.agent === agent);
  if (known.some((r) => r.account === key) || findKind(agent)?.systemId === key) return { agent, account: key };
  const byLabel = store.db.query("SELECT account FROM observed_accounts WHERE agent = ? AND label = ? ORDER BY account").all(agent, key) as Row[];
  if (byLabel.length === 1) return { agent, account: String(byLabel[0].account) };
  if (byLabel.length > 1) return { error: `'${name}' is ambiguous: label of ${byLabel.map((r) => r.account).join(", ")}` };
  return { error: `no ${agent} account or label '${key}' (ds account list)` };
}

// ---- dev-studio owns the list (issue #125, U1): Orca's import, the folder scan, the default and remove ----

/** accounts-orca.tsv, as the accounts refresh writes it: `orca: here|absent|unreachable`, then one
 *  `id\tlabel\thome\tactive` line per Orca host profile (`system\t<label>\t-\t<active>` for the system login). */
export type OrcaImport = { orca: "here" | "absent" | "unreachable"; lines: { id: string; label: string | null; home: string | null; active: boolean }[] };

export function parseOrcaImport(text: string): OrcaImport | null {
  const [head, ...rest] = text.split("\n");
  const m = /^orca: (here|absent|unreachable)$/.exec((head ?? "").trim());
  if (!m) return null;
  const dash = (s: string | undefined) => (!s || s === "-" ? null : s);
  const lines = rest.filter((l) => l.trim()).map((l) => l.split("\t")).filter((f) => f[0])
    .map((f) => ({ id: f[0], label: dash(f[1]), home: dash(f[2]), active: f[3] === "1" }));
  return { orca: m[1] as OrcaImport["orca"], lines };
}

const CLAUDE = "claude", CLAUDE_SYSTEM = "system";

/** Merge Orca's host profiles into the accounts rows (KTD4, KTD5). A new profile becomes an `orca` row; a row
 *  with no source and no removed_at is claimed; an `orca` row gets its folder and label filled. A removed row
 *  is never brought back and a `ds` or `system` row is never repointed. On `here` orca_listed is 1 for this
 *  list and 0 on every other Claude row, on `absent` 0 everywhere, on `unreachable` untouched. The default is
 *  seeded once, from Orca's active account, when no Claude row has it: on the system row (made if missing)
 *  when the active account is the system login or names no row. */
export function mergeOrcaImport(store: Store, imp: OrcaImport, at = now()): void {
  store.tx(() => {
    const listed: string[] = [];
    if (imp.orca === "here") {
      for (const l of imp.lines) {
        if (l.id === CLAUDE_SYSTEM) continue;
        listed.push(l.id);
        const row = store.get("accounts", { agent: CLAUDE, account: l.id });
        if (!row) {
          store.db.run("INSERT INTO accounts (agent, account, label, config_dir, source, observed_at) VALUES (?, ?, ?, ?, 'orca', ?)",
            [CLAUDE, l.id, l.label, l.home, at]);
        } else if (row.removed_at == null && (row.source == null || row.source === "orca")) {
          store.db.run(`UPDATE accounts SET source = 'orca', config_dir = COALESCE(?, config_dir), label = COALESCE(?, label)
            WHERE agent = ? AND account = ?`, [l.home, l.label, CLAUDE, l.id]);
        }
      }
    }
    if (imp.orca !== "unreachable") {
      store.db.run(`UPDATE accounts SET orca_listed = CASE WHEN account IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END
        WHERE agent = ?`, [JSON.stringify(listed), CLAUDE]);
    }
    if (imp.orca !== "here" || store.db.query("SELECT 1 FROM accounts WHERE agent = ? AND is_default = 1").get(CLAUDE)) return;
    const active = imp.lines.find((l) => l.active)?.id;
    const target = active && active !== CLAUDE_SYSTEM
      && store.db.query("SELECT 1 FROM accounts WHERE agent = ? AND account = ? AND removed_at IS NULL AND source IS NOT NULL").get(CLAUDE, active)
      ? active : CLAUDE_SYSTEM;
    if (target === CLAUDE_SYSTEM) {
      const label = imp.lines.find((l) => l.id === CLAUDE_SYSTEM)?.label ?? null;
      store.db.run(`INSERT INTO accounts (agent, account, label, source, observed_at) VALUES (?, ?, ?, 'system', ?)
        ON CONFLICT (agent, account) DO UPDATE SET source = 'system'`, [CLAUDE, CLAUDE_SYSTEM, label, at]);
    }
    store.db.run("UPDATE accounts SET is_default = 1 WHERE agent = ? AND account = ?", [CLAUDE, target]);
    store.event("account_default", { payload: { agent: CLAUDE, account: target, by: "orca-import" } });
  });
}

/** account-folders.tsv's rows: `agent\tdir\tlogin_id\tlogged_in`, one per login folder the refresh found. */
export function parseAccountFolders(text: string, at: number): FactRow[] {
  return text.split("\n").map((l) => l.split("\t")).filter((f) => f[0] && f[1]).map((f) => ({ table: "observed_account_folders",
    key: { dir: f[1] }, set: { agent: f[0], login_id: f[2] && f[2] !== "-" ? f[2] : null, logged_in: f[3] === "1" ? 1 : 0, observed_at: at } }));
}

/** Copy each scanned folder's login id onto the accounts row whose folder it is (KTD4). */
export function copyLoginIds(store: Store, env: Record<string, string | undefined> = process.env): void {
  const ids = new Map((store.db.query("SELECT dir, login_id FROM observed_account_folders WHERE login_id IS NOT NULL").all() as Row[])
    .map((r) => [String(r.dir), String(r.login_id)]));
  if (!ids.size) return;
  for (const r of store.db.query("SELECT agent, account, config_dir, source, login_id FROM accounts").all() as AccountRow[]) {
    const id = ids.get(accountFolder(r, env));
    if (id && id !== r.login_id) store.db.run("UPDATE accounts SET login_id = ? WHERE agent = ? AND account = ?", [id, r.agent, r.account]);
  }
}

/** The listed row `agent:account` names, or why it is not one. */
function listedRow(store: Store, agent: string, account: string): Row | string {
  const row = store.get("accounts", { agent, account });
  if (row?.removed_at != null) return `${agent}:${account} was removed`;
  if (!row?.source && findKind(agent)?.systemId !== account) return `${agent}:${account} is not in the account list (ds account list)`;
  return row ?? { agent, account };
}

/** `ds account default`: make `agent:account` the agent's default (KTD5). One `account_default` event. */
export function setDefaultAccount(store: Store, req: { agent: string; account: string; by: string }, at = now()): { changed: boolean } | { error: string } {
  const { agent, account, by } = req;
  return store.tx(() => {
    const row = listedRow(store, agent, account);
    if (typeof row === "string") return { error: row };
    if (row.is_default) return { changed: false };
    store.db.run("UPDATE accounts SET is_default = 0 WHERE agent = ? AND is_default = 1", [agent]);
    if (!store.get("accounts", { agent, account })) {
      // The agent's system login with no row yet.
      store.db.run("INSERT INTO accounts (agent, account, source, observed_at) VALUES (?, ?, 'system', ?)", [agent, account, at]);
    }
    store.db.run("UPDATE accounts SET is_default = 1 WHERE agent = ? AND account = ?", [agent, account]);
    store.event("account_default", { payload: { agent, account, by } });
    return { changed: true };
  });
}

/** `ds account remove`: tombstone `agent:account` (removed_at; KTD6). Refuses the system login and the current
 *  default; leaves the folder on disk, moves nobody, and the name stays taken. One `account_removed` event. */
export function removeAccount(store: Store, req: { agent: string; account: string; by: string }, at = now()): { changed: boolean } | { error: string } {
  const { agent, account, by } = req;
  return store.tx(() => {
    if (findKind(agent)?.systemId === account) return { error: `${agent}:${account} is the agent's own login and cannot be removed` };
    const row = store.get("accounts", { agent, account });
    if (!row) return { error: `no ${agent} account '${account}' (ds account list)` };
    if (row.removed_at != null) return { changed: false };
    if (row.is_default) return { error: `${agent}:${account} is the default; make another account the default first (ds account default)` };
    store.db.run("UPDATE accounts SET removed_at = ? WHERE agent = ? AND account = ?", [at, agent, account]);
    store.event("account_removed", { payload: { agent, account, by } });
    return { changed: true };
  });
}

/** What `ds account add` came to (KTD6, R6): a new row, a removed row with the same login back, or the same login
 *  already listed (nothing written). `folder` is the row's folder afterwards. */
export type AddOutcome = { outcome: "added" | "back" | "there"; account: string; label: string; folder: string };

/** `ds account add`'s row (issue #125, U5): a `ds` row for `agent:account` on `folder`, unless the login is already
 *  in the list (its row, or the agent's own login: "there") or on a removed row (cleared, and repointed at `folder`
 *  when its own folder is gone: "back"). One `account_added` event for a row added or back. */
export function addAccount(store: Store, req: { agent: string; account: string; folder: string; loginId: string | null; by: string },
  env: Record<string, string | undefined> = process.env, at = now()): AddOutcome {
  const { agent, account, folder, loginId, by } = req;
  const kind = findKind(agent);
  return store.tx(() => {
    const done = (outcome: AddOutcome["outcome"], r: Row, f: string): AddOutcome => {
      const label = String(r.label ?? r.account);
      if (outcome !== "there") store.event("account_added", { payload: { agent, account: String(r.account), label, outcome, by } });
      return { outcome, account: String(r.account), label, folder: f };
    };
    if (loginId) {
      if (kind && kind.loginId(kind.systemDir(env), true, env) === loginId) {
        const sys = store.get("accounts", { agent, account: kind.systemId }) ?? { account: kind.systemId };
        return done("there", sys, kind.systemDir(env));
      }
      const same = store.db.query("SELECT * FROM accounts WHERE agent = ? AND login_id = ? ORDER BY removed_at IS NOT NULL, account")
        .all(agent, loginId) as Row[];
      const live = same.find((r) => r.removed_at == null && r.source != null);
      if (live) return done("there", live, accountFolder(live as AccountRow, env));
      const gone = same.find((r) => r.removed_at != null);
      if (gone) {
        const old = accountFolder(gone as AccountRow, env), repoint = !existsSync(old);
        store.db.run(`UPDATE accounts SET removed_at = NULL, config_dir = CASE WHEN ? THEN ? ELSE config_dir END,
          source = CASE WHEN ? THEN 'ds' ELSE COALESCE(source, 'ds') END WHERE agent = ? AND account = ?`,
        [repoint ? 1 : 0, folder, repoint ? 1 : 0, agent, gone.account as string]);
        return done("back", gone, repoint ? folder : old);
      }
    }
    store.db.run("INSERT INTO accounts (agent, account, label, config_dir, source, login_id, observed_at) VALUES (?, ?, ?, ?, 'ds', ?, ?)",
      [agent, account, account, folder, loginId, at]);
    return done("added", { account, label: account }, folder);
  });
}

/** The token-rotation risk of one login in two folders (KTD14): said by the move's refusal and its result. */
export const ROTATION = "two copies of one login rotate its token: the first copy to refresh logs the other out at that copy's next refresh";

/** The live members that use `agent:account` (as the board's accountUsers counts them: a member with a live worker
 *  whose configured or live account is this one), as `project/squad/role[-suffix]`. */
export function accountMembers(store: Store, agent: string, account: string): string[] {
  return (store.db.query(`SELECT DISTINCT m.project, m.squad, m.role, m.suffix FROM members m
    JOIN observed_workers w ON w.project = m.project AND w.wt = m.wt AND w.gone_at IS NULL
    WHERE COALESCE(m.status, '') != 'gone' AND COALESCE(NULLIF(m.agent, ''), 'claude') = ? AND (m.account = ? OR w.account = ?)
    ORDER BY m.project, m.squad, m.role, m.suffix`).all(agent, account, account) as Row[])
    .map((m) => `${m.project}/${m.squad}/${m.role}${m.suffix ? `-${m.suffix}` : ""}`);
}

/** Why `ds account move` cannot move `agent:account` now (KTD14), or null. Checks the table only: the caller adds the
 *  live agent processes (agent-accounts). Claude only, a listed Orca row, nobody on it, and not listed by Orca any
 *  more unless `force`. */
export function moveProblem(store: Store, agent: string, account: string, force: boolean, env: Record<string, string | undefined> = process.env): string | null {
  if (agent !== CLAUDE) return `only Claude accounts live in Orca's folders; ${agent}:${account} has nothing to move`;
  if (findKind(agent)?.systemId === account) return `${agent}:${account} is the agent's own login (~/.claude) and stays where it is`;
  const row = store.get("accounts", { agent, account });
  if (!row) return `no ${agent} account '${account}' (ds account list)`;
  if (row.removed_at != null) return `${agent}:${account} is removed`;
  if (row.source === "ds") return `${agent}:${account} is already in dev-studio's folder (${accountFolder(row as AccountRow, env)})`;
  if (row.source !== "orca") return `${agent}:${account} is not in the list (no source yet: wait for the next accounts refresh)`;
  const folder = accountFolder(row as AccountRow, env);
  if (!existsSync(join(folder, ".credentials.json"))) return `${folder} holds no .credentials.json: nothing logged in to move`;
  const users = accountMembers(store, agent, account);
  if (users.length) return `${agent}:${account} is in use by ${users.join(", ")}; move it once they are off it (disable it, then wait for them to switch at their restart)`;
  if (row.orca_listed && !force) return `Orca still lists ${agent}:${account}: ${ROTATION}. Remove it in Orca first, or pass --force to keep both and accept that risk`;
  return null;
}

/** The move's row (KTD14): `agent:account` now runs from `folder`, a dev-studio folder. The id, the label and every
 *  flag stay. One `account_moved` event. */
export function moveAccountRow(store: Store, req: { agent: string; account: string; from: string; folder: string; force: boolean; by: string }): void {
  const { agent, account, from, folder, force, by } = req;
  store.tx(() => {
    store.db.run("UPDATE accounts SET config_dir = ?, source = 'ds' WHERE agent = ? AND account = ?", [folder, agent, account]);
    store.event("account_moved", { payload: { agent, account, from, to: folder, force, by } });
  });
}
