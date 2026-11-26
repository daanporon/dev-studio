// account-kinds.test.ts — issue #125 U1: the account-kind registry (bin/lib/account-kinds/) and the list it gives
// through bin/lib/account-dirs.ts, on made-up folders.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KINDS, kindEnv, kindOf } from "../../bin/lib/account-kinds/index.ts";
import { accountFolder, accountsRoot, listFromRows, readAccountsTable, type AccountRow } from "../../bin/lib/account-dirs.ts";

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzkinds-")); temps.push(d); return d; };

describe("account kinds", () => {
  test("Claude, Muse and Codex, each with every field", () => {
    expect(KINDS.map((k) => k.agent).sort()).toEqual(["claude", "codex", "muse"]);
    for (const k of KINDS) {
      expect(typeof k.systemId).toBe("string");
      expect(typeof k.multi).toBe("boolean");
      if (!k.multi) expect(k.why).toBeTruthy();
      expect(k.envVar === null || /^[A-Z_]+$/.test(k.envVar)).toBe(true);
      expect(typeof k.systemDir({ HOME: "/h" })).toBe("string");
      expect(Array.isArray(k.links)).toBe(true);
      expect(k.links).not.toContain(k.credentialsFile);
      expect(k.credentialsFile).toBeTruthy();
      expect(typeof k.loginId).toBe("function");
      expect(typeof k.usage).toBe("boolean");
      expect(typeof k.resets).toBe("boolean");
    }
    expect([kindOf("claude").systemId, kindOf("codex").systemId, kindOf("muse").systemId]).toEqual(["system", "default", "default"]);
    expect([kindOf("codex").envVar, kindOf("muse").envVar, kindOf("claude").envVar]).toEqual(["CODEX_HOME", null, "CLAUDE_CONFIG_DIR"]);
    expect(kindOf("claude").links).not.toContain(".claude.json");
    expect(kindEnv(kindOf("claude"), "/f")).toEqual({ CLAUDE_CONFIG_DIR: "/f" });
    expect(kindEnv(kindOf("muse"), "/f")).toEqual({});
  });

  test("kindOf refuses an unknown agent", () => {
    expect(() => kindOf("gemini")).toThrow(/no account kind/);
  });

  test("Claude's login id is .claude.json oauthAccount.accountUuid, the system login's in $HOME", () => {
    const d = tmp(), home = join(d, "home"), f = join(d, "f");
    mkdirSync(home); mkdirSync(f);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-sys" } }));
    writeFileSync(join(f, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-f" }, accessToken: "x" }));
    const k = kindOf("claude");
    expect(k.loginId(join(home, ".claude"), true, { HOME: home })).toBe("uuid-sys");
    expect(k.loginId(f, false, { HOME: home })).toBe("uuid-f");
    expect(k.loginId(join(d, "none"), false, { HOME: home })).toBeNull();
  });
});

describe("account-dirs", () => {
  const row = (r: Partial<AccountRow>): AccountRow => ({ agent: "claude", account: "x", label: null, config_dir: null, source: "ds",
    login_id: null, orca_listed: 0, is_default: 0, removed_at: null, ...r });

  test("the list: sourced, unremoved rows whose folder exists, default first; the system row when none is listed", () => {
    const d = tmp(), env = { HOME: join(d, "home"), DS_ORCA_DATA: join(d, "orca"), DS_STATE_ROOT: join(d, "state") };
    mkdirSync(join(d, "orca", "claude-profiles", "p1", "home"), { recursive: true });
    mkdirSync(join(d, "w"));
    const rows = [row({ account: "p1", source: "orca" }), row({ account: "w", config_dir: join(d, "w"), is_default: 1 }),
      row({ account: "nofolder", config_dir: join(d, "nope") }), row({ account: "gone", config_dir: join(d, "w"), removed_at: 1 }),
      row({ account: "loose", source: null, config_dir: join(d, "w") })];
    expect(listFromRows(rows, "claude", env).map((r) => r.account)).toEqual(["w", "p1"]);
    expect(listFromRows([], "claude", env).map((r) => [r.account, r.source])).toEqual([["system", "system"]]);
    expect(listFromRows(rows, "codex", env).map((r) => r.account)).toEqual(["default"]);
    expect(accountFolder(row({ account: "p1", source: "orca" }), env)).toBe(join(d, "orca", "claude-profiles", "p1", "home"));
    expect(accountFolder(row({ account: "system" }), env)).toBe(join(d, "home", ".claude"));
    expect(accountFolder(row({ account: "n" }), env)).toBe(join(d, "state", "accounts", "claude", "n"));
    expect(accountsRoot(env)).toBe(join(d, "state", "accounts"));
  });

  test("no loop.db is missing; a pre-0059 loop.db is unreadable", () => {
    const d = tmp();
    expect(readAccountsTable(d)).toEqual({ missing: true });
    const { Database } = require("bun:sqlite");
    const db = new Database(join(d, "loop.db"));
    db.run("CREATE TABLE accounts (agent TEXT, account TEXT, label TEXT, state TEXT, observed_at INTEGER)");
    db.close();
    expect(readAccountsTable(d)).toHaveProperty("unreadable");
  });
});
