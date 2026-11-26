// account-dirs.ts — the account list and each login's folder, read from loop.db's `accounts` table (issue #125,
// KTD3): read-only and light (bun:sqlite plus the account kinds), so host commands, launch lines and the board
// can all ask it without opening the store.
//
//   listAccounts(root, "claude")      // the agent's list: default first, then by name
//   defaultAccount(root, "claude")    // the agent's default (the system row when no row is marked)
//   accountFolder(row)                // the login folder a launch points the agent at
//   accountsRoot()                    // where `ds account add` makes folders (<state>/accounts, KTD7)
//
// The list is every row with a source, no removed_at and a folder on disk (a system row needs no folder: it is
// the agent's own login), plus the agent's system row when it has no listed row. A loop.db from before
// migration 0059 reads as the system login only, with one line on stderr; no loop.db reads the same, silently.
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { orcaData } from "../loop/drivers/claude-launch.ts";
import { findKind, type Env } from "./account-kinds/index.ts";

const ROOT = resolve(import.meta.dir, "..", "..");

export type AccountRow = {
  agent: string;
  account: string;
  label: string | null;
  config_dir: string | null;
  source: "orca" | "ds" | "system" | null;
  login_id: string | null;
  orca_listed: number;
  is_default: number;
  removed_at: number | null;
};

/** The table read: its rows, `missing` (no loop.db yet) or `unreadable` (a failed open or a pre-0059 table). */
export type TableRead = { rows: AccountRow[] } | { missing: true } | { unreadable: string };

const COLS = "agent, account, label, config_dir, source, login_id, orca_listed, is_default, removed_at";

export function readAccountsTable(root: string): TableRead {
  const path = join(root, "loop.db");
  try { if (!existsSync(path) || statSync(path).size === 0) return { missing: true }; } catch { return { missing: true }; }
  try {
    const d = new Database(path, { readonly: true });
    try { return { rows: d.query(`SELECT ${COLS} FROM accounts ORDER BY agent, account`).all() as AccountRow[] }; }
    finally { d.close(); }
  } catch (e) {
    return { unreadable: e instanceof Error ? e.message : String(e) };
  }
}

/** The implicit system row of `agent` (no table row yet). */
export function systemRow(agent: string): AccountRow {
  const kind = findKind(agent);
  return { agent, account: kind?.systemId ?? "system", label: null, config_dir: null, source: "system", login_id: null,
    orca_listed: 0, is_default: 0, removed_at: null };
}

/** Where `ds account add` makes login folders: <ROOT>/accounts beside the default state root, else
 *  <state root>/accounts (a test's DS_STATE_ROOT). */
export function accountsRoot(env: Env = process.env): string {
  const state = env.DS_STATE_ROOT ? resolve(env.DS_STATE_ROOT) : join(ROOT, "state");
  return state === join(ROOT, "state") ? join(ROOT, "accounts") : join(state, "accounts");
}

/** The login folder of `row`: the agent's own folder for its system row, else config_dir, else Orca's profile
 *  folder for an orca row (KTD2), else <accounts root>/<agent>/<account>. */
export function accountFolder(row: Pick<AccountRow, "agent" | "account" | "config_dir" | "source">, env: Env = process.env): string {
  const kind = findKind(row.agent);
  if (kind && row.account === kind.systemId) return kind.systemDir(env);
  if (row.config_dir) return row.config_dir;
  if (row.source === "orca" || row.source === null) return join(orcaData(env), "claude-profiles", row.account, "home");
  return join(accountsRoot(env), row.agent, row.account);
}

const isSystem = (r: Pick<AccountRow, "agent" | "account">): boolean => findKind(r.agent)?.systemId === r.account;

/** The listed rows of `agent` from table rows (default first, then by name), plus its system row when none is listed. */
export function listFromRows(rows: AccountRow[], agent: string, env: Env = process.env): AccountRow[] {
  const listed = rows.filter((r) => r.agent === agent && r.source && r.removed_at == null
    && (isSystem(r) || existsSync(accountFolder(r, env))));
  if (!listed.length) return [systemRow(agent)];
  const dflt = listed.find((r) => r.is_default) ?? listed.find(isSystem);
  return [...(dflt ? [dflt] : []), ...listed.filter((r) => r !== dflt).sort((a, b) => a.account.localeCompare(b.account))];
}

let warned = false;
function tableRows(root: string): AccountRow[] {
  const t = readAccountsTable(root);
  if ("rows" in t) return t.rows;
  if ("unreadable" in t && !warned) {
    warned = true;
    process.stderr.write(`account-dirs: loop.db's accounts table is unreadable (${t.unreadable}); using the system login only\n`);
  }
  return [];
}

/** The login folder of `account`: its row's, removed or not (a running agent can still be on it); an id the
 *  table does not know is an Orca profile for Claude (KTD2), else the folder `ds account add` would make. */
export function folderOf(root: string, agent: string, account: string, env: Env = process.env): string {
  const row = tableRows(root).find((r) => r.agent === agent && r.account === account);
  return accountFolder(row ?? { agent, account, config_dir: null, source: agent === "claude" ? null : "ds" }, env);
}

/** [folder, account] for every row of `agent` with a source, rows not removed first. */
export function knownFolders(root: string, agent: string, env: Env = process.env): [string, string][] {
  return tableRows(root).filter((r) => r.agent === agent && r.source)
    .sort((a, b) => Number(a.removed_at != null) - Number(b.removed_at != null))
    .map((r) => [accountFolder(r, env), r.account]);
}

/** The account list of `agent`: default first. */
export const listAccounts = (root: string, agent: string, env: Env = process.env): AccountRow[] =>
  listFromRows(tableRows(root), agent, env);

/** The default account of `agent`: the row marked default when it is listed, else the system row. */
export function defaultAccount(root: string, agent: string, env: Env = process.env): AccountRow {
  const list = listAccounts(root, agent, env);
  return list.find((r) => r.is_default) ?? list.find(isSystem) ?? systemRow(agent);
}
