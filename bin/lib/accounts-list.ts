// accounts-list.ts — the accounts refresh's list (issue #125, U1, KTD4): loop.db's accounts table plus Orca's
// host profiles, with the two files the state observer merges into the table. The refresh is a host command
// and never writes loop.db.
//
//   const lines = await accountList(root)   // "<agent>\t<account>\t<label>\t<folder>" per account, each agent's
//                                            // default first; null = the table cannot be read (keep last files)
//
// Beside accounts.tsv it writes:
//   accounts-orca.tsv     `orca: here|absent|unreachable`, then Orca's `id\tlabel\thome\tactive` lines: whenever
//                         an orca CLI is here (bin/backend/orca.sh orca-accounts, whatever BACKEND is), absent
//                         without one, unreachable when it does not answer
//   account-folders.tsv   `agent\tdir\tlogin_id\tlogged_in` per login folder found: Orca's claude-profiles/*/home,
//                         <accounts root>/<agent>/* for a kind with more than one login, and each agent's own folder
import { existsSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountFolder, accountsRoot, listFromRows, readAccountsTable, type AccountRow } from "./account-dirs.ts";
import { KINDS, type AccountKind, type Env } from "./account-kinds/index.ts";
import { orcaCliHere } from "./orca-missing";
import { ROOT, run, writeErr } from "./shared";
import { orcaData } from "../loop/drivers/claude-launch.ts";

type OrcaLine = { id: string; label: string; home: string; active: boolean };
type Orca = { state: "here" | "absent" | "unreachable"; lines: OrcaLine[] };

const clean = (s: string): string => s.replace(/[\t\r\n]/g, " ");
const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
const subdirs = (d: string): string[] => { try { return readdirSync(d).filter((n) => isDir(join(d, n))).sort(); } catch { return []; } };

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** Orca's host profiles through its adapter, whenever an orca CLI is here. */
async function orcaProfiles(env: Env): Promise<Orca> {
  if (!orcaCliHere(env)) return { state: "absent", lines: [] };
  const r = await run([join(ROOT, "bin", "backend", "orca.sh"), "orca-accounts"], { env });
  if (r.rc !== 0 || !r.out.trim()) return { state: "unreachable", lines: [] };
  const lines = r.out.split("\n").map((l) => l.split("\t")).filter((f) => f[0])
    .map((f) => ({ id: f[0], label: f[1] || f[0], home: f[2] && f[2] !== "-" ? f[2] : "", active: f[3] === "1" }));
  return { state: "here", lines };
}

/** One folder line: the kind's login id and whether its credentials file is there. */
function folderLine(kind: AccountKind, dir: string, system: boolean, env: Env): string {
  const id = kind.loginId(dir, system, env);
  return [kind.agent, dir, id ? clean(id) : "-", existsSync(join(dir, kind.credentialsFile)) ? "1" : "0"].join("\t");
}

/** Every login folder on the host (account-folders.tsv's lines). */
export function scanFolders(env: Env): string[] {
  const out: string[] = [], seen = new Set<string>();
  const add = (kind: AccountKind, dir: string, system: boolean) => {
    if (seen.has(dir) || !isDir(dir)) return;
    seen.add(dir);
    out.push(folderLine(kind, dir, system, env));
  };
  for (const kind of KINDS) {
    add(kind, kind.systemDir(env), true);
    if (kind.agent === "claude") {
      const profiles = join(orcaData(env), "claude-profiles");
      for (const id of subdirs(profiles)) add(kind, join(profiles, id, "home"), false);
    }
    if (kind.multi) for (const n of subdirs(join(accountsRoot(env), kind.agent))) add(kind, join(accountsRoot(env), kind.agent, n), false);
  }
  return out;
}

/** The table's rows with this run's Orca profiles laid over them, as the observer will merge them: a new
 *  profile is an orca row, a sourceless one is claimed; a removed, ds or system row is left as it is. While no
 *  Claude row is the default, Orca's active account (or the system login) stands in for this run. */
function withOrca(rows: AccountRow[], orca: Orca): AccountRow[] {
  if (orca.state !== "here") return rows;
  const out = rows.map((r) => ({ ...r }));
  for (const l of orca.lines) {
    if (l.id === "system") continue;
    const r = out.find((x) => x.agent === "claude" && x.account === l.id);
    if (!r) out.push({ agent: "claude", account: l.id, label: l.label, config_dir: l.home || null, source: "orca", login_id: null,
      orca_listed: 1, is_default: 0, removed_at: null });
    else if (r.removed_at == null && (r.source == null || r.source === "orca"))
      Object.assign(r, { source: "orca", config_dir: l.home || r.config_dir, label: r.label ?? l.label });
  }
  if (!out.some((r) => r.agent === "claude" && r.is_default)) {
    const active = orca.lines.find((l) => l.active)?.id ?? "system";
    const r = out.find((x) => x.agent === "claude" && x.account === active && x.source && x.removed_at == null);
    if (r) r.is_default = 1;
  }
  return out;
}

/** The refresh's list, with accounts-orca.tsv and account-folders.tsv written; null when the table cannot be
 *  read (one line on stderr, last run's files kept). */
export async function accountList(root: string, env: Env = process.env): Promise<string[] | null> {
  const t = readAccountsTable(root);
  if ("unreadable" in t) {
    writeErr(`accounts-refresh: loop.db's accounts table is unreadable (${t.unreadable}); last run's files kept\n`);
    return null;
  }
  const orca = await orcaProfiles(env);
  writeAtomic(join(root, "accounts-orca.tsv"), `orca: ${orca.state}\n`
    + orca.lines.map((l) => [l.id, l.label, l.home || "-", l.active ? "1" : "0"].map(clean).join("\t") + "\n").join(""));
  writeAtomic(join(root, "account-folders.tsv"), scanFolders(env).map((l) => l + "\n").join(""));

  const rows = withOrca("rows" in t ? t.rows : [], orca);
  const systemLabel = orca.lines.find((l) => l.id === "system")?.label;
  const out: string[] = [];
  for (const kind of KINDS) {
    let list = listFromRows(rows, kind.agent, env);
    // The agent's own login is in the list whenever it is logged in, listed row or not.
    if (!list.some((r) => r.account === kind.systemId) && existsSync(join(kind.systemDir(env), kind.credentialsFile)))
      list = [...list, { ...rows.find((r) => r.agent === kind.agent && r.account === kind.systemId) ?? {
        agent: kind.agent, account: kind.systemId, label: null, config_dir: null, source: "system" as const, login_id: null,
        orca_listed: 0, is_default: 0, removed_at: null } }];
    for (const r of list) {
      const system = r.account === kind.systemId;
      const label = r.label ?? (system ? (kind.agent === "claude" ? systemLabel ?? "system login" : kind.systemId) : r.account);
      out.push([kind.agent, r.account, clean(label), system ? "" : accountFolder(r, env)].join("\t"));
    }
  }
  return out;
}
