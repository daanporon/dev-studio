// account-folders-host.test.ts — side-loop-host U18 (issue #127): each login has a folder per host.
// Migration 0062 seeds account_folders from today's accounts rows as `local` and gives observed_account_folders a
// host; a side host scans its own login folders and sends them up the link as `<host>::<path>`; main's state
// observer turns a side folder whose login id is an account's into that account's folder on the side host, keeps
// main's own scan off the side's rows, and drops a side folder that went away; folderOn(root, host, ...) reads it.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, open, type Row, type Store } from "../../bin/loop/core/store.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { stateObserver } from "../../bin/loop/observers/state.ts";
import { applyUp, upBatch, upRequests } from "../../bin/link/replica.ts";
import { folderOf, folderOn } from "../../bin/lib/account-dirs.ts";

const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const temp = () => { const d = mkdtempSync(join(tmpdir(), "zzacctfold-")); temps.push(d); return d; };
const store = (root = temp()) => { const s = open(root); stores.push(s); return s; };
const all = (s: Store, sql: string, ...a: string[]) => s.db.query(sql).all(...a) as Row[];

function observer(scan: string[] = []) {
  const d = temp();
  return stateObserver({ tokenDir: join(d, "projects"), lavishDir: join(d, "lavish"), lavishLog: join(d, "lavish.log"),
    refreshAccounts: () => {}, scanFolders: () => scan });
}
const tick = (s: Store, o: ReturnType<typeof stateObserver>, at: number, role?: "side") =>
  o.run({ store: s, project: "", tick: at, now: at, fired: [], poked: new Set(), ...(role ? { role } : {}) } as TickCtx);

// Ship the side's up rows to main as host `host`, the way RowSync does over the link.
function ship(side: Store, main: Store, host: string, full = true) {
  for (const req of upRequests(upBatch(side, full))) applyUp(main, host, req);
}

describe("migration 0062", () => {
  test("seeds a local folder per accounts row and gives observed_account_folders a host", () => {
    const root = temp(), before = join(temp(), "migrations");
    mkdirSync(before);
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "0062")) symlinkSync(join(MIGRATIONS, f), join(before, f));
    const db = new Database(join(root, "loop.db"));
    try {
      migrate(db, before);
      db.run("INSERT INTO accounts (agent, account, config_dir, source, observed_at) VALUES ('claude', 'p1', '/o/p1/home', 'orca', 1), ('claude', 'system', NULL, 'system', 1)");
      db.run("INSERT INTO observed_account_folders (dir, agent, login_id, logged_in, observed_at) VALUES ('/o/p1/home', 'claude', 'uuid-1', 1, 1)");
      migrate(db);
      expect(db.query("SELECT agent, account, host, dir FROM account_folders ORDER BY account").all()).toEqual([
        { agent: "claude", account: "p1", host: "local", dir: "/o/p1/home" },
        { agent: "claude", account: "system", host: "local", dir: null },
      ]);
      expect(db.query("SELECT dir, host FROM observed_account_folders").all()).toEqual([{ dir: "/o/p1/home", host: "local" }]);
    } finally { db.close(); }
  });
});

describe("a side host's login folders", () => {
  test("the side scans its own folders, sends them up, and main records each login's folder on that host", () => {
    const side = store(), main = store();
    main.upsert("accounts", { agent: "claude", account: "p1" }, { source: "orca", config_dir: "/o/p1/home", login_id: "uuid-1", observed_at: 1 });
    main.upsert("accounts", { agent: "claude", account: "p2" }, { source: "ds", config_dir: "/a/p2", login_id: "uuid-2", observed_at: 1 });
    // main's own scan: p1's folder on main
    writeFileSync(join(main.root, "account-folders.tsv"), "claude\t/o/p1/home\tuuid-1\t1\n");

    // the side: its own Claude folder is logged in as p2's login; an orphan folder has no login
    tick(side, observer(["claude\t/home/user/side/.claude\tuuid-2\t1", "claude\t/home/user/side/x\t-\t0"]), T, "side");
    expect(all(side, "SELECT dir, host, login_id FROM observed_account_folders ORDER BY dir")).toEqual([
      { dir: "/home/user/side/.claude", host: "local", login_id: "uuid-2" }, { dir: "/home/user/side/x", host: "local", login_id: null }]);
    ship(side, main, "s1");
    expect(all(main, "SELECT dir, host FROM observed_account_folders WHERE host = 's1' ORDER BY dir")).toEqual([
      { dir: "s1::/home/user/side/.claude", host: "s1" }, { dir: "s1::/home/user/side/x", host: "s1" }]);

    const mo = observer();
    tick(main, mo, T);
    expect(all(main, "SELECT account, host, dir FROM account_folders ORDER BY account, host")).toEqual([
      { account: "p1", host: "local", dir: "/o/p1/home" },
      { account: "p2", host: "local", dir: "/a/p2" },
      { account: "p2", host: "s1", dir: "/home/user/side/.claude" },
    ]);
    // main's own scan replaced only its own rows; the side's stay
    expect(all(main, "SELECT dir FROM observed_account_folders ORDER BY dir").map((r) => r.dir)).toEqual(["/o/p1/home", "s1::/home/user/side/.claude", "s1::/home/user/side/x"]);
    // a side folder never lends main its login id
    expect(all(main, "SELECT login_id FROM accounts WHERE account = 'p2'")).toEqual([{ login_id: "uuid-2" }]);

    // the lookup takes a host: main's folder on local, the side's own on s1, none where the host has no login
    expect(folderOn(main.root, "local", "claude", "p1")).toBe(folderOf(main.root, "claude", "p1"));
    expect(folderOn(main.root, "s1", "claude", "p2")).toBe("/home/user/side/.claude");
    expect(folderOn(main.root, "s1", "claude", "p1")).toBeNull();
    expect(folderOn(main.root, "s2", "claude", "p2")).toBeNull();

    // the side logs that folder out and in as p1: the next scan moves the login, a delta ships it
    tick(side, observer(["claude\t/home/user/side/.claude\tuuid-1\t1"]), T + 60, "side");
    ship(side, main, "s1", false);
    tick(main, mo, T + 60);
    expect(all(main, "SELECT account, host, dir FROM account_folders WHERE host = 's1'")).toEqual([{ account: "p1", host: "s1", dir: "/home/user/side/.claude" }]);
    expect(folderOn(main.root, "s1", "claude", "p2")).toBeNull();
  });

  test("the side rescans only every DS_LOOP_ACCOUNTS_S; a new account row gets its local folder", () => {
    const side = store(), main = store();
    let scans = 0;
    const o = stateObserver({ tokenDir: join(temp(), "p"), lavishDir: temp(), lavishLog: join(temp(), "l.log"), refreshAccounts: () => {},
      scanFolders: () => { scans++; return []; } });
    tick(side, o, T, "side");
    tick(side, o, T + 10, "side");
    tick(side, o, T + 60, "side");
    expect(scans).toBe(2);
    main.upsert("accounts", { agent: "codex", account: "c1" }, { source: "ds", observed_at: 1 });
    tick(main, observer(), T);
    expect(all(main, "SELECT agent, account, host, dir FROM account_folders")).toEqual([{ agent: "codex", account: "c1", host: "local", dir: null }]);
  });
});
