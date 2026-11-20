// accounts.test.ts — plan "disable" U2: the operator's on/off switch per account (bin/loop/capacity/accounts.ts),
// what pick.ts does with a disabled account, and `ds account`. On a temp state root with
// tests/fixtures/loop/accounts.tsv (claude acct-a, acct-b, acct-c resetting in 1 h, 2 h and 4 h).
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import { accountDisabled, knownAccounts, resolveAccount, setAccountEnabled } from "../../bin/loop/capacity/accounts.ts";
import { accountBlock, pick, type Picked, type PickReq, type Waiting } from "../../bin/loop/capacity/pick.ts";
import { reconcile } from "../../bin/loop/capacity/picks.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const T = 1_800_000_000;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.DS_PICK_WAIT_S;
});
function fixture(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzacct-")), conv = mkdtempSync(join(tmpdir(), "zzconv-"));
  temps.push(d, conv);
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  mkdirSync(join(d, "fx", "squads"), { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(d, "accounts.tsv"));
  const s = open(d);
  stores.push(s);
  importConfig(s, d, conv);
  reimport(s);
  // One rung, then codex on its own account: the all-disabled case falls to the next rung.
  s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value: "claude opus ondemand high codex:gpt-6.1-sol:high", observed_at: T });
  s.upsert("observed_accounts", { agent: "codex", account: "default" }, { session_pct: "-", weekly_pct: "-", updated: String(T), observed_at: T });
  return s;
}
const reimport = (s: Store) => { for (const r of accountRows(s.root)) s.upsert(r.table, r.key, r.set); };
const off = (s: Store, account: string, agent = "claude") => setAccountEnabled(s, { agent, account, enabled: false, by: "test" }, T);
const on = (s: Store, account: string, agent = "claude") => setAccountEnabled(s, { agent, account, enabled: true, by: "test" }, T);
const builder = (s: Store, req: Partial<PickReq> = {}) => pick(s, { project: "fx", role: "builder", tier: "hard", phase: "build", ...req }, T);
const ok = (p: unknown) => { expect(p).not.toHaveProperty("wait"); expect(p).not.toHaveProperty("error"); return p as Picked; };
const waits = (p: unknown) => { expect(p).toHaveProperty("wait"); return p as Waiting; };
const events = (s: Store, kind: string) =>
  (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[]).map((e) => JSON.parse(String(e.payload)));
function member(s: Store, set: Row): number {
  const row: Row = { project: "fx", squad: "demo", role: "builder", suffix: "", observed_at: T, updated_at: T, ...set };
  const ks = Object.keys(row);
  return Number(s.db.run(`INSERT INTO members (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`, ks.map((k) => row[k] as string | number | null)).lastInsertRowid);
}

describe("the switch", () => {
  test("disable then enable: one event each with {agent, account, by}; a repeat changes nothing", () => {
    const s = fixture();
    expect(off(s, "acct-a").changed).toBe(true);
    expect(off(s, "acct-a").changed).toBe(false);
    expect(accountDisabled(s, "claude", "acct-a")).toBe(true);
    expect(s.get("accounts", { agent: "claude", account: "acct-a" })?.state).toBe("disabled");
    expect(on(s, "acct-a").changed).toBe(true);
    expect(on(s, "acct-a").changed).toBe(false);
    expect(s.get("accounts", { agent: "claude", account: "acct-a" })?.state).toBeNull();
    expect(events(s, "account_disabled")).toEqual([{ agent: "claude", account: "acct-a", by: "test" }]);
    expect(events(s, "account_enabled")).toEqual([{ agent: "claude", account: "acct-a", by: "test" }]);
  });

  test("an accounts.tsv re-import keeps the flag", () => {
    const s = fixture();
    off(s, "acct-b");
    reimport(s);
    reimport(s);
    expect(s.get("accounts", { agent: "claude", account: "acct-b" })).toMatchObject({ state: "disabled", label: "second reset" });
    expect(knownAccounts(s).find((r) => r.account === "acct-b")).toMatchObject({ state: "disabled", listed: true });
  });

  test("an account known only from accounts.tsv gets an accounts row with its label", () => {
    const s = fixture();
    off(s, "default", "codex");
    expect(s.get("accounts", { agent: "codex", account: "default" })).toMatchObject({ state: "disabled", observed_at: T });
  });

  test("a name resolves by account id or a unique label; unknown and ambiguous names are errors", () => {
    const s = fixture();
    expect(resolveAccount(s, "claude:acct-c")).toEqual({ agent: "claude", account: "acct-c" });
    expect(resolveAccount(s, "claude:freshest")).toEqual({ agent: "claude", account: "acct-c" });
    expect(resolveAccount(s, "claude:nope")).toHaveProperty("error");
    expect(resolveAccount(s, "acct-c")).toHaveProperty("error");
    s.upsert("observed_accounts", { agent: "claude", account: "acct-b" }, { label: "freshest" });
    expect((resolveAccount(s, "claude:freshest") as { error: string }).error).toContain("ambiguous");
  });
});

describe("pick with a disabled account", () => {
  test("it is left out, and the pick's why names it", () => {
    const s = fixture();
    expect(ok(builder(s)).account).toBe("acct-a");
    off(s, "acct-a");
    const p = ok(builder(s));
    expect(p.account).toBe("acct-b");
    expect(p.why).toBe("fill_first; acct-a disabled");
    on(s, "acct-a");
    expect(ok(builder(s)).account).toBe("acct-a");
  });

  test("accountBlock returns disabled, so a held pick on it is dropped", () => {
    const s = fixture();
    expect(accountBlock(s, "claude", "acct-a", T)).toBeNull();
    off(s, "acct-a");
    expect(accountBlock(s, "claude", "acct-a", T)).toBe("disabled");
    // keep (U65) never wins on a disabled account: the next account is picked instead.
    expect(ok(builder(s, { keep: { agent: "claude", model: "opus", account: "acct-a" } })).account).toBe("acct-b");
  });

  test("every account of the rung disabled: the next rung, never the default login", () => {
    const s = fixture();
    for (const a of ["acct-a", "acct-b", "acct-c"]) off(s, a);
    const p = ok(builder(s));
    expect([p.agent, p.account, p.fallback]).toEqual(["codex", "default", true]);
    expect(p.why).toContain("acct-a disabled");
  });

  test("every account disabled on the last rung: WAIT at now + DS_PICK_WAIT_S, never `-`", () => {
    const s = fixture();
    process.env.DS_PICK_WAIT_S = "900";
    for (const a of ["acct-a", "acct-b", "acct-c"]) off(s, a);
    off(s, "default", "codex");
    const w = waits(builder(s));
    expect([w.wait, w.known]).toEqual([T + 900, false]);
    // One rung only (no fallback): the same.
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value: "claude opus ondemand high", observed_at: T });
    expect(waits(builder(s)).wait).toBe(T + 900);
  });

  test("an override or explicit account on a disabled account waits with reason account disabled", () => {
    const s = fixture();
    process.env.DS_PICK_WAIT_S = "600";
    off(s, "acct-c");
    const w = waits(builder(s, { account: "acct-c" }));
    expect(w.wait).toBe(T + 600);
    expect(w.reason).toContain("account disabled (acct-c)");
    const m = member(s, { want: "running", want_at: T, wt: "wt-ov", tier: "hard" });
    s.db.run("INSERT INTO overrides (member, model, account, scope, set_by, set_at) VALUES ('wt-ov', NULL, 'acct-c', 'member', 'board', ?)", [T]);
    const o = waits(builder(s, { member: m }));
    expect(o.reason).toMatch(/^override #\d+: account disabled \(acct-c\)/);
    on(s, "acct-c");
    expect(ok(builder(s, { member: m })).account).toBe("acct-c");
  });

  test("a pending start re-picks off a disabled account; a running member on it is left alone", () => {
    const s = fixture();
    const run = member(s, { status: "running", agent: "claude", model: "opus", account: "acct-a", tier: "hard", wt: "wt-run", placed_at: null });
    const want = member(s, { want: "running", want_at: T, tier: "hard", wt: "wt-new" });
    const tick = () => reconcile({ store: s, project: "", tick: 1, now: T, fired: [], poked: new Set() } as unknown as TickCtx);
    tick();
    expect(s.get("picks", { member: want })?.account).toBe("acct-a");
    off(s, "acct-a");
    tick();
    expect(s.get("picks", { member: want })?.account).toBe("acct-b");
    expect(s.get("members", { id: run })).toMatchObject({ status: "running", account: "acct-a" });
  });
});

describe("ds account", () => {
  function ds(root: string, ...args: string[]) {
    const p = Bun.spawnSync([DS, "--state", root, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DS_NOW: String(T) } });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
  }
  test("list prints JSON with state; disable/enable by label; unknown and ambiguous names exit 2", () => {
    const s = fixture();
    member(s, { status: "running", agent: "claude", model: "opus", account: "acct-c", wt: "wt-c" });
    const list = () => JSON.parse(ds(s.root, "account").out) as Row[];
    expect(list().find((r) => r.account === "acct-c")).toMatchObject({ agent: "claude", label: "freshest", state: "enabled", running: 1, listed: true });
    expect(ds(s.root, "account", "disable", "claude:freshest")).toMatchObject({ code: 0, out: "claude:acct-c disabled" });
    expect(JSON.parse(ds(s.root, "account", "list").out).find((r: Row) => r.account === "acct-c").state).toBe("disabled");
    expect(ds(s.root, "account", "disable", "claude:acct-c").out).toBe("claude:acct-c disabled (already)");
    const p = JSON.parse(ds(s.root, "pick", "fx", "builder", "--tier", "hard", "--json").out);
    expect(p.why).toContain("acct-c disabled");
    expect(ds(s.root, "account", "enable", "claude:acct-c")).toMatchObject({ code: 0, out: "claude:acct-c enabled" });
    expect(events(s, "account_disabled")).toEqual([{ agent: "claude", account: "acct-c", by: "cli" }]);
    expect(ds(s.root, "account", "disable", "claude:nobody").code).toBe(2);
    s.upsert("observed_accounts", { agent: "claude", account: "acct-b" }, { label: "freshest" });
    const amb = ds(s.root, "account", "disable", "claude:freshest");
    expect(amb.code).toBe(2);
    expect(amb.err).toContain("ambiguous");
    expect(ds(s.root, "account", "disable").code).toBe(2);
    expect(ds(s.root, "account", "pause", "claude:acct-c").code).toBe(2);
  });
});
