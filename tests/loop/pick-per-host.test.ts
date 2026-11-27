// pick-per-host.test.ts — side-loop-host U19 (KTD: per-host logins, never a copied folder): a start on side host X
// is given only an account with a usable login on X (an account_folders row there whose scanned folder is not logged
// out), never a "default login" there; an explicit account without one waits; limits and load stay the account's
// (its login's), so a login used on two hosts counts once; placement skips a host where the start gets no account,
// with a reason. The launch on X runs on that login's folder there (drivers/contract.ts sideAccount), and the side's
// contract channel trusts the worktree in it (link/channels/contract.ts sideCreate).
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import { loginsOn, pick, type Picked, type PickReq, type Waiting } from "../../bin/loop/capacity/pick.ts";
import { reconcile } from "../../bin/loop/capacity/picks.ts";
import { sideAccount } from "../../bin/loop/drivers/contract.ts";
import { sideCreate } from "../../bin/link/channels/contract.ts";
import { LINK_VERSION } from "../../bin/link/protocol.ts";
import { UP_MIGRATION } from "../../bin/link/replica.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const SAVED = { ...process.env };

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

// The fixture's accounts (claude acct-a fills first, then acct-b, then acct-c), main full at max_builders 1.
function fixture(): Store {
  for (const k of Object.keys(process.env)) if (k.startsWith("DS_")) delete process.env[k];
  process.env.DS_LIMIT_LINK_LISTEN = "off";
  process.env.DS_LIMIT_MAX_BUILDERS = "1";
  const d = mkdtempSync(join(tmpdir(), "zzpickhost-")), conv = mkdtempSync(join(tmpdir(), "zzpickhost-conv-"));
  temps.push(d, conv);
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  mkdirSync(join(d, "fx", "squads"), { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(d, "accounts.tsv"));
  process.env.DS_STATE_ROOT = d;
  const s = open(d);
  stores.push(s);
  importConfig(s, d, conv);
  for (const r of accountRows(d)) s.upsert(r.table, r.key, r.set);
  s.upsert("squads", { project: "fx", topic: "demo" }, { status: "running", observed_at: T, updated_at: T });
  sample(s, "local");
  return s;
}

const CALM: Row = { cores: 24, load1: 6, load5: 6, load15: 6, mem_total_kb: 64_000_000, mem_avail_kb: 32_000_000, swap_total_kb: 8_000_000, swap_free_kb: 8_000_000,
  psi_cpu_some: 1, psi_mem_some: 0, psi_mem_full: 0, psi_io_some: 0, psi_io_full: 0, disks: "[]", groups: "[]", observed_at: T };
const sample = (s: Store, host: string) => s.upsert("observed_machine", { host }, { ...CALM, host });
// An accepted, online, calm side host with two seats, and a login folder there for each of `logins`.
function side(s: Store, name: string, logins: string[]): void {
  s.db.run(`INSERT INTO hosts (name, status, public_key, fingerprint, seats, requested_at, accepted_at, last_seen_at, link_version, up_migration)
    VALUES (?, 'accepted', 'a2V5', ?, 2, ?, ?, ?, ?, ?)`, [name, name, T, T, T, LINK_VERSION, UP_MIGRATION]);
  s.db.run("INSERT OR REPLACE INTO host_config (host, key, value, set_at) VALUES (?, 'seats', '2', ?)", [name, T]);
  sample(s, name);
  for (const a of logins) login(s, name, a, `/home/u/.dev-studio-accounts/claude/${a}`);
}
const login = (s: Store, host: string, account: string, dir: string) =>
  s.db.run("INSERT OR REPLACE INTO account_folders (agent, account, host, dir, observed_at) VALUES ('claude', ?, ?, ?, ?)", [account, host, dir, T]);
// The side's own scan of that folder (U18: `<host>::<path>`), logged in or out.
const scanned = (s: Store, host: string, dir: string, loggedIn: boolean) =>
  s.db.run("INSERT INTO observed_account_folders (dir, host, agent, login_id, logged_in, observed_at) VALUES (?, ?, 'claude', 'uuid-x', ?, ?)",
    [`${host}::${dir}`, host, loggedIn ? 1 : 0, T]);

let n = 0;
function member(s: Store, set: Row): number {
  const row: Row = { project: "fx", squad: "demo", role: "builder", suffix: `u${++n}`, observed_at: T, updated_at: T, ...set };
  const ks = Object.keys(row);
  return Number(s.db.run(`INSERT INTO members (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`, ks.map((k) => row[k] as string | number | null)).lastInsertRowid);
}
// A Builder running on main (it fills main's one slot), on `account`.
function live(s: Store, account: string | null = null): number {
  const wt = `local::/wt/live-${n + 1}`;
  const id = member(s, { status: "running", want: "running", wt, tier: "hard", account, agent: account ? "claude" : null });
  s.upsert("observed_workers", { project: "fx", wt }, { state: "working", presence: "running", observed_at: T });
  return id;
}
const asks = (s: Store, set: Row = {}) => member(s, { want: "running", want_at: T + n, tier: "hard", ...set });
const ctx = (s: Store) => ({ store: s, project: "", tick: 1, now: T, fired: [], poked: new Set() } as TickCtx);
const req = (set: Partial<PickReq> = {}): PickReq => ({ project: "fx", role: "builder", tier: "hard", phase: "build", squad: "demo", place: true, ...set });
const starts = (p: unknown) => { expect(p).not.toHaveProperty("wait"); expect(p).not.toHaveProperty("error"); return p as Picked; };
const waits = (p: unknown) => { expect(p).toHaveProperty("wait"); return p as Waiting; };
const picked = (s: Store, id: number) => s.get("picks", { member: id })!;

describe("U19: a start on a side host takes only a login there", () => {
  test("main full: placed on alpha with acct-c, the only account logged in there (not acct-a, which fills first on main)", () => {
    const s = fixture();
    side(s, "alpha", ["acct-c"]);
    // With main's slot free the pick stays on main and fills acct-a first, as before U19.
    expect(starts(pick(s, req(), T))).toMatchObject({ host: null, account: "acct-a" });
    live(s);
    expect(starts(pick(s, req(), T))).toMatchObject({ host: "alpha", account: "acct-c" });
  });

  test("a host with no usable login is skipped with a reason; the next host in name order takes the start", () => {
    const s = fixture();
    side(s, "alpha", []);
    side(s, "beta", ["acct-b"]);
    live(s);
    const id = asks(s);
    expect(reconcile(ctx(s)).has(id)).toBe(true);
    expect(picked(s, id)).toMatchObject({ host: "beta", account: "acct-b" });
  });

  test("no side host with a usable login: the start waits on main, each host named with why", () => {
    const s = fixture();
    side(s, "alpha", []);
    side(s, "beta", []);
    live(s);
    const id = asks(s);
    expect(reconcile(ctx(s)).has(id)).toBe(false);
    const why = String(picked(s, id).reason);
    expect(why).toMatch(/^WAIT slot: /);
    expect(why).toContain("side hosts: alpha no usable login: ");
    expect(why).toContain("no account with a login on alpha");
    expect(why).toContain("beta no usable login: ");
    expect(why.split("\n").slice(1).some((l) => l.startsWith("WAIT "))).toBe(false);
    expect(picked(s, id).host).toBeNull();
  });

  test("a logged-out folder is no login: the host is skipped", () => {
    const s = fixture();
    side(s, "alpha", ["acct-b"]);
    scanned(s, "alpha", "/home/u/.dev-studio-accounts/claude/acct-b", false);
    expect([...loginsOn(s, "claude", "alpha")]).toEqual([]);
    side(s, "beta", ["acct-c"]);
    scanned(s, "beta", "/home/u/.dev-studio-accounts/claude/acct-c", true);
    expect([...loginsOn(s, "claude", "beta")]).toEqual(["acct-c"]);
    live(s);
    expect(starts(pick(s, req(), T))).toMatchObject({ host: "beta", account: "acct-c" });
  });

  test("a member pinned to alpha gets only alpha's logins; with none there it waits, never a default login", () => {
    const s = fixture();
    side(s, "alpha", ["acct-b"]);
    const id = asks(s, { host: "alpha" });
    expect(starts(pick(s, req({ member: id }), T))).toMatchObject({ account: "acct-b" });
    s.db.run("DELETE FROM account_folders WHERE host = 'alpha'");
    const w = waits(pick(s, req({ member: id }), T));
    expect(w.reason).toContain("no account with a login on alpha");
  });

  test("an explicit account without a login on the member's host waits, naming both", () => {
    const s = fixture();
    side(s, "alpha", ["acct-b"]);
    const id = asks(s, { host: "alpha" });
    const w = waits(pick(s, req({ member: id, agent: "claude", model: "opus", account: "acct-a" }), T));
    expect(w.reason).toContain("account acct-a has no login on alpha");
    expect(starts(pick(s, req({ member: id, agent: "claude", model: "opus", account: "acct-b" }), T)).account).toBe("acct-b");
  });

  test("main's picks are unchanged: with no account listed, main still takes its default login", () => {
    const s = fixture();
    s.db.run("DELETE FROM accounts");
    s.db.run("DELETE FROM observed_accounts");
    expect(starts(pick(s, req({ place: false }), T))).toMatchObject({ account: null, why: "default_login" });
  });
});

describe("U19: limits and load count once per login, whatever host", () => {
  test("a login limited on main is limited on alpha too: the host has no usable login and is skipped", () => {
    const s = fixture();
    side(s, "alpha", ["acct-a"]);
    side(s, "beta", ["acct-b"]);
    live(s);
    const p = starts(pick(s, req({ limited: [`claude:acct-a=${T + 3600}`] }), T));
    expect(p).toMatchObject({ host: "beta", account: "acct-b" });
  });

  test("two accounts of one login (same login_id) share its limit across hosts", () => {
    const s = fixture();
    s.db.run("UPDATE accounts SET login_id = 'uuid-shared' WHERE account IN ('acct-a', 'acct-c')");
    side(s, "alpha", ["acct-c"]);
    live(s);
    const w = waits(pick(s, req({ limited: [`claude:acct-a=${T + 3600}`] }), T));
    expect(w.reason).toContain("alpha no usable login: ");
  });

  test("a side member's load lands on its account: the pick on main sees it", () => {
    const s = fixture();
    side(s, "alpha", ["acct-a"]);
    const before = starts(pick(s, req({ place: false }), T)).reason;
    member(s, { status: "running", want: "running", wt: "alpha::/side/wts/u9", tier: "hard", host: "alpha", agent: "claude", account: "acct-a", placed_at: T });
    const after = starts(pick(s, req({ place: false }), T)).reason;
    expect(before).toContain("acct-a resets soonest (1800003600) with room: 50% + 20% < 95%");
    expect(after).toContain("50% + 40% < 95%");   // the side member's 20% on acct-a, plus this start's
  });
});

describe("U19: the launch on a side host runs on that host's login folder", () => {
  test("sideAccount: the account's folder there (CLAUDE_CONFIG_DIR), the host's own ~/.claude as its system login, none = error", () => {
    const s = fixture();
    side(s, "alpha", ["acct-b"]);
    login(s, "alpha", "acct-c", "/home/u/.claude");
    expect(sideAccount("alpha", "acct-b")).toEqual({ config: { home: "/home/u/.dev-studio-accounts/claude/acct-b" }, env: { CLAUDE_CONFIG_DIR: "/home/u/.dev-studio-accounts/claude/acct-b" } });
    expect(sideAccount("alpha", "acct-c")).toEqual({ config: { system: true }, env: {} });
    expect(sideAccount("alpha", "acct-a")).toEqual({ error: "account acct-a has no login on host alpha" });
    expect(sideAccount("beta", "acct-b")).toEqual({ error: "account acct-b has no login on host beta" });
    expect(sideAccount("alpha", null)).toEqual({ config: null, env: {} });
  });

  test("sideCreate trusts the worktree in the login folder main names (CLAUDE_CONFIG_DIR), not the host's own", () => {
    const d = mkdtempSync(join(tmpdir(), "zzpickhost-side-")); temps.push(d);
    const own = join(d, "own"), acct = join(d, "acct-b");
    for (const x of [own, acct]) { mkdirSync(x); writeFileSync(join(x, ".claude.json"), `${JSON.stringify({ numStartups: 1 })}\n`); }
    sideCreate({ op: "terminal.create", req: { cwd: "/side/wts/u1", label: "builder-u1", env: { DS_MEMBER: "fx/sq/builder/u1", CLAUDE_CONFIG_DIR: acct } } },
      "/side/state", { DS_CLAUDE_SYSTEM_JSON_DIR: own });
    expect(JSON.parse(readFileSync(join(acct, ".claude.json"), "utf8")).projects["/side/wts/u1"].hasTrustDialogAccepted).toBe(true);
    expect(JSON.parse(readFileSync(join(own, ".claude.json"), "utf8")).projects).toBeUndefined();
  });
});
