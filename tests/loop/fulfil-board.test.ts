// fulfil-board.test.ts — U15: the fulfillers of the board's requests rows (config, override, lavish,
// studio, and an answer that never landed), on a copy of tests/fixtures/loop/state against the fake
// Orca. tests/board.sh drives the same fulfillers through the served board.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { setAccountEnabled } from "../../bin/loop/capacity/accounts.ts";
import { creditsHold, holdCredits } from "../../bin/loop/capacity/credits.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { answer, open as ask } from "../../bin/loop/messages/questions.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { limitsJson, rolesJson } from "../../bin/board/board-data.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const LEAD = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-lead-demo";
// A label of this run's own for the roles edits.
const RL = `zzfb_${process.pid}`;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzfb-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}

const fulfillers = (await load<Fulfiller & Reconciler>(DIRS.fulfil)).filter((f) => f.kinds);
function rig(s: Store, orca = new FakeOrca()) {
  const act = new LoopActuator({ orca, fulfillers });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  return { orca, tick: async (at = T) => { await loop.tick(at); await act.drain(); } };
}
const board = (s: Store, kind: string, payload: unknown, o: { project: string; squad?: string; member?: string }) =>
  Number(s.request(kind, payload, { ...o, by: "board" }).row.id);
const result = (s: Store, id: number) => {
  const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) };
};
const events = (s: Store, kind: string) =>
  (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[]).map((e) => JSON.parse(String(e.payload)));
const withEnv = async (env: Record<string, string>, fn: () => Promise<void>) => {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { await fn(); } finally { for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v); }
};

// U154: the board no longer files run-switch requests (its Restart writes a restart_at wish,
// U153); the run-switch "Builder restart" path is gone with fulfil/request.ts run-switch.


describe("config", () => {
  test("a limits edit sets and drops the project's config row under the store's root (no file, U256)", async () => {
    const s = imported(), { tick } = rig(s);
    const id = board(s, "limits", { key: "context_compact", value: "120000" }, { project: "fx" });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: true });
    expect(existsSync(join(s.root, "fx", "limits.conf"))).toBe(false);
    expect((s.db.query("SELECT value FROM config WHERE project = 'fx' AND file = 'limits.conf' AND key = 'context_compact'").get() as Row).value).toBe("120000");
    const rm = board(s, "limits", { key: "context_compact", value: null }, { project: "fx" });
    await tick(T + 1);
    expect(result(s, rm)).toMatchObject({ done: true, ok: true });
    expect(s.db.query("SELECT 1 FROM config WHERE project = 'fx' AND file = 'limits.conf' AND key = 'context_compact'").get()).toBeNull();
  });

  test("U258: the Settings row shows the last change and Undo puts the first value back (3 history rows)", async () => {
    const s = imported(), { tick } = rig(s);
    // The loop's observer holds the shipped defaults as project '' rows; the board's read joins against them.
    for (const [file, key, value] of [["limits.conf", "context_compact", "100000"], ["roles.conf", "builder", "claude opus always"]])
      s.db.run("INSERT OR IGNORE INTO config (project, file, key, value, observed_at) VALUES ('', ?, ?, ?, 1)", [file, key, value]);
    const shown = () => limitsJson("fx", s.root)!.limits.find((l) => l.key === "context_compact")!;
    board(s, "limits", { key: "context_compact", value: "120000" }, { project: "fx" });
    await tick(T);
    board(s, "limits", { key: "context_compact", value: "130000" }, { project: "fx" });
    await tick(T + 1);
    expect(shown()).toMatchObject({ value: "130000", source: "override", changed: { by: "board", from: "120000", undo: true, imported: false } });
    const id = board(s, "config-undo", { file: "limits.conf", key: "context_compact", history: shown().changed!.id }, { project: "fx" });
    await tick(T + 2);
    expect(result(s, id)).toMatchObject({ done: true, ok: true });
    expect(shown()).toMatchObject({ value: "120000", changed: { by: "board", from: "130000" } });
    const n = (s.db.query("SELECT COUNT(*) AS n FROM config_history WHERE project = 'fx' AND file = 'limits.conf' AND key = 'context_compact'").get() as Row).n;
    expect(n).toBe(3);
    // A stale Undo (its history id is no longer the latest) is refused and changes nothing.
    const stale = board(s, "config-undo", { file: "limits.conf", key: "context_compact", history: 1 }, { project: "fx" });
    await tick(T + 3);
    expect(result(s, stale)).toMatchObject({ done: true, ok: false });
    expect(shown().value).toBe("120000");
  });

  test("U258: Undo of a first override drops the row; an imported value shows its date and no Undo", async () => {
    const s = imported(), { tick } = rig(s);
    // The loop's observer holds the shipped defaults as project '' rows; the board's read joins against them.
    for (const [file, key, value] of [["limits.conf", "context_compact", "100000"], ["roles.conf", "builder", "claude opus always"]])
      s.db.run("INSERT OR IGNORE INTO config (project, file, key, value, observed_at) VALUES ('', ?, ?, ?, 1)", [file, key, value]);
    board(s, "roles", { role: "builder", agent: "claude", model: "sonnet", spawn: "ondemand", effort: "high", fallbacks: "claude:opus" }, { project: RL });
    await tick(T);
    const r = () => rolesJson(RL, s.root)!.roles.find((x) => x.role === "builder")!;
    expect(r()).toMatchObject({ source: "project", changed: { by: "board", from: null, undo: true } });
    board(s, "config-undo", { file: "roles.conf", key: "builder", history: r().changed!.id }, { project: RL });
    await tick(T + 1);
    expect(r()).toMatchObject({ source: "default", changed: null });
    s.db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES ('', 'limits.conf', 'context_warn', '80000', 1), ('fx', 'limits.conf', 'context_warn', '90000', 1)");
    s.db.run("INSERT INTO config_history (project, file, key, old_value, new_value, actor, at) VALUES ('fx', 'limits.conf', 'context_warn', NULL, '90000', 'migration', 1800000000)");
    expect(limitsJson("fx", s.root)!.limits.find((l) => l.key === "context_warn")!.changed).toMatchObject({ imported: true, undo: false });
  });

  test("a limits.sh refusal fails the request with the script's reason", async () => {
    const s = imported(), { tick } = rig(s);
    const id = board(s, "limits", { key: "no_such_limit", value: "1" }, { project: "fx" });
    await tick();
    const r = result(s, id);
    expect(r).toMatchObject({ done: true, ok: false });
    expect(r.error).not.toMatch(/^limits\.sh: /);
    expect(r.error.length).toBeGreaterThan(0);
    expect(events(s, "request_done").find((e) => e.id === id)?.result).toMatchObject({ ok: false });
  });

  test("a roles edit sets and resets one role's row (no file, U256)", async () => {
    const s = imported(), { tick } = rig(s);
    const id = board(s, "roles", { role: "builder", agent: "claude", model: "sonnet", spawn: "ondemand", effort: "high", fallbacks: "claude:opus" }, { project: RL });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: true });
    expect(existsSync(join(s.root, RL, "roles.conf"))).toBe(false);
    expect(String((s.db.query("SELECT value FROM config WHERE project = ? AND file = 'roles.conf' AND key = 'builder'").get(RL) as Row).value)).toMatch(/^claude\s+sonnet\s+ondemand\s+high\s+claude:opus/);
    const reset = board(s, "roles", { role: "builder", reset: true }, { project: RL });
    await tick(T + 1);
    expect(result(s, reset)).toMatchObject({ done: true, ok: true });
    // U267: reset drops the project's row, so the role runs the default row again.
    expect(s.db.query("SELECT value FROM config WHERE project = ? AND file = 'roles.conf' AND key = 'builder'").get(RL)).toBeNull();
  });

  test("configurable-role-elevation U2: a roles edit writes `return` as column 8, and rolesJson shows the resolved value", async () => {
    const s = imported(), { tick } = rig(s);
    for (const [k, v] of [["thinker", "claude opus always - - - up"], ["lead", "claude opus always"], ["builder", "claude opus ondemand - - - up"], ["builder-standard", "claude sonnet ondemand"], ["builder-review", "claude opus elevate"]])
      s.db.run("INSERT OR IGNORE INTO config (project, file, key, value, observed_at) VALUES ('', 'roles.conf', ?, ?, 1)", [k, v]);
    const row = (role: string) => rolesJson(RL, s.root)!.roles.find((x) => x.role === role)! as any;
    const stored = (role: string) => String((s.db.query("SELECT value FROM config WHERE project = ? AND file = 'roles.conf' AND key = ?").get(RL, role) as Row | null)?.value);
    expect(row("thinker")).toMatchObject({ back_up: true, back_up_from: "default" });
    expect(row("lead")).toMatchObject({ back_up: false, return: "" });
    expect(row("builder-standard")).toMatchObject({ back_up: true, back_up_from: "builder" });
    expect(row("builder-review")).toMatchObject({ back_up: false });
    const up = board(s, "roles", { role: "lead", agent: "claude", model: "opus", spawn: "always", effort: "", fallbacks: "", plan: "", return: "up" }, { project: RL });
    await tick();
    expect(result(s, up)).toMatchObject({ done: true, ok: true });
    expect(stored("lead")).toBe("claude opus always - - - up");
    expect(row("lead")).toMatchObject({ return: "up", back_up: true, back_up_from: "row" });
    // an absent return keeps the row's own; "" writes `-` (inherit)
    board(s, "roles", { role: "lead", agent: "claude", model: "sonnet", spawn: "always", effort: "", fallbacks: "" }, { project: RL });
    await tick(T + 1);
    expect(stored("lead")).toBe("claude sonnet always - - - up");
    board(s, "roles", { role: "lead", agent: "claude", model: "sonnet", spawn: "always", effort: "", fallbacks: "", plan: "", return: "" }, { project: RL });
    await tick(T + 2);
    expect(row("lead")).toMatchObject({ return: "", back_up: false });
    const bad = board(s, "roles", { role: "builder-review", agent: "claude", model: "opus", spawn: "elevate", effort: "", fallbacks: "", plan: "", return: "up" }, { project: RL });
    await tick(T + 3);
    expect(result(s, bad)).toMatchObject({ done: true, ok: false });
  });

  test("a roles edit upserts a row the project's roster lacks (U85)", async () => {
    const s = imported(), { tick } = rig(s);
    rmSync(join(s.root, RL), { recursive: true, force: true });
    mkdirSync(join(s.root, RL, "squads"), { recursive: true });   // a project dir, as the cut-over finds them
    const dflt = readFileSync(join(ROOT, "conventions", "roles.conf"), "utf8");
    expect(dflt).toMatch(/^builder-hard-babysit\s/m);   // the test needs a default row to drop
    const seeded = dflt.split("\n").filter((l) => !/^\s*builder-hard-babysit\s/.test(l)).join("\n");
    writeFileSync(join(s.root, RL, "roles.conf"), seeded);   // the old file: the cut-over makes it rows
    const rowsOf = () => (s.db.query("SELECT key, value FROM config WHERE project = ? AND file = 'roles.conf' ORDER BY rowid").all(RL) as Row[])
      .map((r) => `${r.key} ${r.value}`);
    const id = board(s, "roles", { role: "builder-hard-babysit", agent: "claude", model: "sonnet", spawn: "ondemand", effort: "high", fallbacks: "claude:opus" }, { project: RL });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: true });
    expect(existsSync(join(s.root, RL, "roles.conf"))).toBe(false);
    // The upsert adds one row and never rewrites the rest: every other row is the seeded file's, in its
    // order, and the new row is the last.
    const rows = rowsOf(), norm = (l: string) => l.trim().split(/\s+/).join(" ");
    expect(rows.slice(0, -1).map(norm)).toEqual(seeded.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).map(norm));
    expect(rows[rows.length - 1]).toMatch(/^builder-hard-babysit\s+claude\s+sonnet\s+ondemand\s+high\s+claude:opus/);
  });

  test("a payload short of a role's agent fails without running the script", async () => {
    const s = imported(), { tick } = rig(s);
    rmSync(join(ROOT, "state", RL), { recursive: true, force: true });
    const id = board(s, "roles", { role: "builder", agent: "claude" }, { project: RL });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: false });
    expect(existsSync(join(ROOT, "state", RL, "roles.conf"))).toBe(false);
  });
});

describe("account", () => {
  const state = (s: Store) => (s.get("accounts", { agent: "claude", account: "acct-b" })?.state as string | null) ?? null;

  test("the board's Disable sets the flag and its event; Enable clears it; a repeat changes nothing", async () => {
    const s = imported(), { tick } = rig(s);
    const off = board(s, "account", { agent: "claude", account: "acct-b", enabled: false }, { project: "fx" });
    await tick();
    expect(result(s, off)).toMatchObject({ done: true, ok: true, changed: true, state: "disabled" });
    expect(state(s)).toBe("disabled");
    expect(events(s, "account_disabled")).toEqual([{ agent: "claude", account: "acct-b", by: "board" }]);
    const again = board(s, "account", { agent: "claude", account: "acct-b", enabled: false }, { project: "fx" });
    await tick(T + 1);
    expect(result(s, again)).toMatchObject({ done: true, ok: true, changed: false });
    expect(events(s, "account_disabled").length).toBe(1);
    const on = board(s, "account", { agent: "claude", account: "acct-b", enabled: true }, { project: "fx" });
    await tick(T + 2);
    expect(result(s, on)).toMatchObject({ done: true, ok: true, changed: true, state: null });
    expect(state(s)).toBeNull();
    expect(events(s, "account_enabled")).toEqual([{ agent: "claude", account: "acct-b", by: "board" }]);
  });

  test("a request without an agent, an account or a boolean fails", async () => {
    const s = imported(), { tick } = rig(s);
    const a = board(s, "account", { agent: "claude", account: "acct-b" }, { project: "fx" });
    await tick();
    expect(result(s, a).done).toBe(true);
    expect(state(s)).toBeNull();
    expect(events(s, "account_disabled")).toEqual([]);
  });
});

describe("override", () => {
  // The catalog sources a pin's model is checked against (U205): the fixture's own roster has no sonnet.
  const seeded = () => { const s = imported(); s.upsert("config", { project: "", file: "models.conf", key: "claude|sonnet" }, { value: "", observed_at: T }); return s; };
  const open_ = (s: Store) => s.db.query("SELECT member, model, account, set_by FROM overrides WHERE cleared_at IS NULL").all() as Row[];

  test("until done: one open row keyed by the worktree; a new one replaces it; back to auto clears it", async () => {
    const s = seeded(), { tick } = rig(s);
    const a = board(s, "override", { model: "sonnet" }, { project: "fx", squad: "demo", member: LEAD });
    await tick();
    expect(result(s, a)).toMatchObject({ done: true, ok: true });
    expect(open_(s)).toEqual([{ member: LEAD, model: "sonnet", account: null, set_by: "board" }]);
    board(s, "override", { account: "acct-b" }, { project: "fx", squad: "demo", member: LEAD });
    await tick(T + 1);
    expect(open_(s)).toEqual([{ member: LEAD, model: null, account: "acct-b", set_by: "board" }]);
    expect(events(s, "override_cleared").map((e) => e.reason)).toEqual(["replaced"]);
    board(s, "override", { clear: true }, { project: "fx", squad: "demo", member: LEAD });
    await tick(T + 2);
    expect(open_(s)).toEqual([]);
    expect(events(s, "override_cleared").map((e) => e.reason)).toEqual(["replaced", "back to auto"]);
    expect(events(s, "override_set").length).toBe(2);
  });

  test("an override with nothing to set fails", async () => {
    const s = seeded(), { tick } = rig(s);
    const id = board(s, "override", {}, { project: "fx", squad: "demo", member: LEAD });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: false });
    expect(open_(s)).toEqual([]);
  });

  test("an override on a disabled account is refused (the board toasts the failed request)", async () => {
    const s = seeded(), { tick } = rig(s);
    setAccountEnabled(s, { agent: "claude", account: "acct-b", enabled: false, by: "test" }, T);
    const id = board(s, "override", { account: "acct-b" }, { project: "fx", squad: "demo", member: LEAD });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: false, error: expect.stringContaining("acct-b is disabled") });
    expect(open_(s)).toEqual([]);
    setAccountEnabled(s, { agent: "claude", account: "acct-b", enabled: true, by: "test" }, T);
    board(s, "override", { account: "acct-b" }, { project: "fx", squad: "demo", member: LEAD });
    await tick(T + 1);
    expect(open_(s)).toEqual([{ member: LEAD, model: null, account: "acct-b", set_by: "board" }]);
  });

  // U24: the scope in the payload; a broader row's `member` holds its target.
  test("U24: squad, role and project overrides store their target; each replaces only its own; clear drops one scope", async () => {
    const s = seeded(), { tick } = rig(s);
    const scoped = () => s.db.query("SELECT member, scope, model FROM overrides WHERE cleared_at IS NULL ORDER BY id").all() as Row[];
    const ids: number[] = [];
    let t = T;
    for (const p of [{ scope: "squad", model: "sonnet" }, { scope: "project", model: "sonnet" }, { scope: "role", model: "sonnet" }]) {
      ids.push(board(s, "override", p, { project: "fx", squad: "demo", member: LEAD }));
      await tick(++t);
      expect(result(s, ids.at(-1)!)).toMatchObject({ done: true, ok: true });
    }
    const role = String(s.db.query("SELECT role FROM members WHERE wt = ?").get(LEAD)!["role" as never]);
    expect(scoped()).toEqual([{ member: "fx/demo", scope: "squad", model: "sonnet" }, { member: "fx", scope: "project", model: "sonnet" }, { member: `fx/${role}`, scope: "role", model: "sonnet" }]);
    board(s, "override", { scope: "squad", model: "sonnet", effort: "high" }, { project: "fx", squad: "demo" });   // no member: a squad pin needs none
    await tick(++t);
    expect(scoped().map((r) => r.scope)).toEqual(["project", "role", "squad"]);
    expect(s.db.query("SELECT effort FROM overrides WHERE scope = 'squad' AND cleared_at IS NULL").get()).toEqual({ effort: "high" });
    board(s, "override", { scope: "project", clear: true }, { project: "fx" });
    await tick(++t);
    expect(scoped().map((r) => r.scope)).toEqual(["role", "squad"]);
    expect(events(s, "override_set").length).toBe(4);
  });

  test("U24: an unknown scope and a missing target are refused with the reason in the result", async () => {
    const s = seeded(), { tick } = rig(s);
    const refused = async (payload: Row, ctx: Row, error: string, at: number) => {
      const id = board(s, "override", payload, ctx as never);
      await tick(at);
      expect(result(s, id)).toMatchObject({ done: true, ok: false, error: expect.stringContaining(error) });
    };
    await refused({ scope: "galaxy", model: "sonnet" }, { project: "fx", squad: "demo", member: LEAD }, "unknown scope 'galaxy'", T);
    await refused({ scope: "squad", model: "sonnet" }, { project: "fx", squad: "nosuch" }, "no open squad 'nosuch'", T + 1);
    await refused({ scope: "role", role: "nosuchrole", model: "sonnet" }, { project: "fx", squad: "demo", member: LEAD }, "no role 'nosuchrole'", T + 2);
    await refused({ scope: "project", model: "sonnet" }, { project: "nosuch" }, "no project 'nosuch'", T + 3);
    await refused({ model: "sonnet" }, { project: "fx", squad: "demo" }, "needs a member", T + 4);
    expect(open_(s)).toEqual([]);
  });

  test("U205: effort and plan are stored; an unknown model fails with the list message; a clear still works", async () => {
    const s = seeded(), { tick } = rig(s);
    const row = () => s.db.query("SELECT model, effort, plan, account FROM overrides WHERE cleared_at IS NULL").all() as Row[];
    const ok_ = board(s, "override", { model: "sonnet", effort: "low", plan: "Max" }, { project: "fx", squad: "demo", member: LEAD });
    await tick();
    expect(result(s, ok_)).toMatchObject({ done: true, ok: true });
    expect(row()).toEqual([{ model: "sonnet", effort: "low", plan: "Max", account: null }]);
    const bad = board(s, "override", { model: "sonnet-5.5" }, { project: "fx", squad: "demo", member: LEAD });
    await tick(T + 1);
    expect(result(s, bad)).toMatchObject({ done: true, ok: false, error: "unknown model 'sonnet-5.5': pick one from the list" });
    expect(row().length).toBe(1);
    const both = board(s, "override", { model: "sonnet", plan: "Max", account: "acct-b" }, { project: "fx", squad: "demo", member: LEAD });
    await tick(T + 2);
    expect(result(s, both)).toMatchObject({ done: true, ok: false });
    board(s, "override", { clear: true }, { project: "fx", squad: "demo", member: LEAD });
    await tick(T + 3);
    expect(row()).toEqual([]);
  });

  test("the refusal checks the agent the override's model runs on", async () => {
    const s = seeded(), { tick } = rig(s);
    for (const agent of ["muse", "codex"]) s.upsert("observed_accounts", { agent, account: "default" }, { observed_at: T });
    for (const key of ["muse|muse-spark", "codex|gpt-6.1-sol"]) s.upsert("config", { project: "", file: "models.conf", key }, { value: "", observed_at: T });
    setAccountEnabled(s, { agent: "muse", account: "default", enabled: false, by: "test" }, T);
    const no = board(s, "override", { model: "muse-spark", account: "default" }, { project: "fx", squad: "demo", member: LEAD });
    await tick();
    expect(result(s, no)).toMatchObject({ done: true, ok: false });
    const yes = board(s, "override", { model: "gpt-6.1-sol", account: "default" }, { project: "fx", squad: "demo", member: LEAD });
    await tick(T + 1);
    expect(result(s, yes)).toMatchObject({ done: true, ok: true });
    expect(open_(s)).toEqual([{ member: LEAD, model: "gpt-6.1-sol", account: "default", set_by: "board" }]);
  });
});

describe("lavish", () => {
  const port = 30000 + (process.pid % 20000);

  test("a start that comes up finishes the request", async () => {
    const s = imported(), { tick } = rig(s);
    const tmp = mkdtempSync(join(tmpdir(), "zzfb-lv-")); temps.push(tmp);
    const start = `'${process.execPath}' -e "Bun.serve({hostname:'127.0.0.1',port:${port},fetch:()=>new Response('ok')}); await Bun.sleep(8000)" >/dev/null 2>&1 & echo $! > '${tmp}/pid'`;
    await withEnv({ DS_LAVISH_START: start, TMPDIR: tmp }, async () => {
      const id = board(s, "lavish", { port }, { project: "fx" });
      await tick();
      expect(result(s, id)).toMatchObject({ done: true, ok: true, port });
    });
    try { process.kill(Number(readFileSync(join(tmp, "pid"), "utf8"))); } catch { /* gone */ }
  });

  test("a start that never answers fails with the start log's tail", async () => {
    const s = imported(), { tick } = rig(s);
    const tmp = mkdtempSync(join(tmpdir(), "zzfb-lv-")); temps.push(tmp);
    await withEnv({ DS_LAVISH_START: 'echo "npx: command not found" >> "$DS_LAVISH_LOG"', TMPDIR: tmp, DS_LOOP_LAVISH_WAIT_MS: "1000" }, async () => {
      const id = board(s, "lavish", { port: port + 1 }, { project: "fx" });
      await tick();
      const r = result(s, id);
      expect(r).toMatchObject({ done: true, ok: false });
      expect(r.error).toContain("npx: command not found");
    });
  });
});

describe("studio", () => {
  test("a Studio request is written out as the request file, with the row the state observer would import", async () => {
    const s = imported(), { tick } = rig(s);
    const line = "board: the operator asks you to run: /ds-close-squad demo";
    const id = board(s, "studio", { action: "close", topic: "demo", line }, { project: "fx", squad: "demo" });
    await tick();
    const name = `board-close-demo-${id}.txt`;
    expect(readFileSync(join(s.root, "fx", "requests", "_studio", name), "utf8")).toBe(`${line}\n`);
    expect(result(s, id)).toMatchObject({ done: true, ok: true });
    const filed = s.db.query("SELECT kind, done_at, payload FROM requests WHERE key = ?").get(`file:fx/_studio/${name}`) as Row;
    expect(filed).toMatchObject({ kind: "board", done_at: null });
    expect(JSON.parse(String(filed.payload))).toEqual({ file: `fx/requests/_studio/${name}`, text: line });
  });

  test("the loop's morning brief (action briefing) is written as briefing-<id>.txt, its first line the briefing line (U3)", async () => {
    const s = imported(), { tick } = rig(s);
    const line = "briefing: write the morning brief for fx, 2027-01-11 (since Sun 09:00) — studio/studio.md \"Morning brief\"; facts: bin/ds briefing-input fx --date 2027-01-11";
    const id = Number(s.request("studio", { action: "briefing", label: "fx", date: "2027-01-11", since: 0, until: 1, spend: {}, line },
      { key: "briefing:fx:2027-01-11", project: "fx", by: "loop:briefing" }).row.id);
    await tick();
    const name = `briefing-${id}.txt`;
    expect(readFileSync(join(s.root, "fx", "requests", "_studio", name), "utf8")).toBe(`${line}\n`);
    expect(result(s, id)).toMatchObject({ done: true, ok: true });
    expect(s.db.query("SELECT kind, done_at FROM requests WHERE key = ?").get(`file:fx/_studio/${name}`)).toMatchObject({ kind: "board", done_at: null });
  });

  test("a dismiss resolves the Studio alert in alerts.json and drops its observed row", async () => {
    const s = imported(), { tick } = rig(s);
    const ids = JSON.parse(readFileSync(join(s.root, "fx", "alerts.json"), "utf8")).alerts.map((x: Row) => String(x.id));
    expect(ids.length).toBeGreaterThan(0);
    const id = board(s, "dismiss", { id: ids[0] }, { project: "fx" });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: true, dismissed: ids[0] });
    const left = JSON.parse(readFileSync(join(s.root, "fx", "alerts.json"), "utf8")).alerts.map((x: Row) => String(x.id));
    expect(left).not.toContain(ids[0]);
    expect(s.db.query("SELECT 1 FROM observed_alerts WHERE project = 'fx' AND id = ?").get(ids[0])).toBeNull();
    // A plain card records no move approval.
    expect(s.get("episodes", { project: "fx", subject: "studio.move", kind: "studio:approved" })).toBeNull();
  });

  test("U264: a studio_move ask card (move: true) answered \"move it\" records the operator's approval; Dismiss or other text does not", async () => {
    for (const [answer, approves] of [["move it", true], [" Move it ", true], [undefined, false], ["done — restarted it there", false]] as const) {
      const s = imported(), { tick } = rig(s);
      const ids = JSON.parse(readFileSync(join(s.root, "fx", "alerts.json"), "utf8")).alerts.map((x: Row) => String(x.id));
      const doc = JSON.parse(String((s.db.query("SELECT doc FROM observed_alerts WHERE project = 'fx' AND id = ?").get(ids[0]) as Row).doc));
      s.db.run("UPDATE observed_alerts SET doc = ? WHERE project = 'fx' AND id = ?", [JSON.stringify({ ...doc, move: true, suggestion: "move it" }), ids[0]]);
      const id = board(s, "dismiss", { id: ids[0], ...(answer ? { answer } : {}) }, { project: "fx" });
      await tick();
      expect(result(s, id)).toMatchObject({ done: true, ok: true, dismissed: ids[0] });
      expect((result(s, id) as Row).move).toBe(approves ? "approved" : undefined);
      const ep = s.get("episodes", { project: "fx", subject: "studio.move", kind: "studio:approved" });
      if (approves) expect(ep).toMatchObject({ state: "approved", ended_at: null, source: "board" });
      else expect(ep).toBeNull();
    }
  });

  test("provider-billing-fallback U4: an out-of-credits card answered Fixed ends the hold, Switch it off disables the account, Dismiss only clears", async () => {
    for (const [answer, held, state] of [["Fixed", false, null], [" switch it off ", true, "disabled"], [undefined, true, null], ["something else", true, null]] as const) {
      const s = imported(), { tick } = rig(s);
      holdCredits(s, { agent: "muse", account: "default", until: T + 86_400, from: "screen" }, T);
      s.upsert("accounts", { agent: "muse", account: "default" }, { observed_at: T });
      const ids = JSON.parse(readFileSync(join(s.root, "fx", "alerts.json"), "utf8")).alerts.map((x: Row) => String(x.id));
      const doc = JSON.parse(String((s.db.query("SELECT doc FROM observed_alerts WHERE project = 'fx' AND id = ?").get(ids[0]) as Row).doc));
      s.db.run("UPDATE observed_alerts SET doc = ? WHERE project = 'fx' AND id = ?", [JSON.stringify({ ...doc, kind: "out_of_credits", credits: { agent: "muse", account: "default" }, options: ["Fixed", "Switch it off"] }), ids[0]]);
      const id = board(s, "dismiss", { id: ids[0], ...(answer ? { answer } : {}) }, { project: "fx" });
      await tick();
      expect(result(s, id)).toMatchObject({ done: true, ok: true, dismissed: ids[0] });
      expect(creditsHold(s, "muse", "default", T) !== null).toBe(held);
      expect(s.get("accounts", { agent: "muse", account: "default" })?.state ?? null).toBe(state);
      if (answer === "Fixed") expect(result(s, id)).toMatchObject({ account: "muse/default", enabled: true, cleared: true });
      expect(s.db.query("SELECT 1 FROM observed_alerts WHERE project = 'fx' AND id = ?").get(ids[0])).toBeNull();
    }
  });
});

describe("answer", () => {
  test("a board answer that never reaches the agent fails with the reason and reopens the question", async () => {
    const s = imported(), orca = new FakeOrca(), { tick } = rig(s, orca);
    ask(s, "fx", "demo", { id: "qz", asker: "lead", blocking: true, question: "go?", since: "2026-10-08T09:00:00Z" });
    answer(s, "fx", "demo", "qz", "yes", "board");
    for (let i = 0; i < 6; i++) orca.fail("poke", { code: 1, out: "", err: "orca adapter: poke: no such terminal" });
    const id = board(s, "answer", { id: "qz", answer: "yes", via: "board" }, { project: "fx", squad: "demo", member: LEAD });
    await withEnv({ DS_LOOP_SEND_TRIES: "1" }, () => tick());
    expect(result(s, id)).toMatchObject({ done: true, ok: false });
    expect((s.db.query("SELECT status, answer FROM questions WHERE project = 'fx' AND squad = 'demo' AND id = 'qz'").get() as Row))
      .toEqual({ status: "open", answer: null });
    expect(events(s, "question_reopened").map((e) => e.id)).toEqual(["qz"]);
  });

  test("an answer given in the terminal is never reopened by a failed board delivery", async () => {
    const s = imported(), orca = new FakeOrca(), { tick } = rig(s, orca);
    ask(s, "fx", "demo", { id: "qt", asker: "lead", blocking: true, question: "go?", since: "2026-10-08T09:00:00Z" });
    answer(s, "fx", "demo", "qt", "no", "terminal");
    for (let i = 0; i < 6; i++) orca.fail("poke", { code: 1, out: "", err: "boom" });
    board(s, "answer", { id: "qt", answer: "yes", via: "board" }, { project: "fx", squad: "demo", member: LEAD });
    await withEnv({ DS_LOOP_SEND_TRIES: "1" }, () => tick());
    expect((s.db.query("SELECT status, answered_via FROM questions WHERE project = 'fx' AND squad = 'demo' AND id = 'qt'").get() as Row))
      .toEqual({ status: "answered", answered_via: "terminal" });
  });

  test("a failed delivery reopens only the row the board answered, never an earlier asking of the id", async () => {
    const s = imported(), orca = new FakeOrca(), { tick } = rig(s, orca);
    const q = { id: "qs", asker: "lead", blocking: true, question: "go?", since: "2026-10-08T09:00:00Z" };
    ask(s, "fx", "demo", q); answer(s, "fx", "demo", "qs", "last week", "board");
    const seq = ask(s, "fx", "demo", q); answer(s, "fx", "demo", "qs", "today", "board");
    for (let i = 0; i < 6; i++) orca.fail("poke", { code: 1, out: "", err: "boom" });
    board(s, "answer", { id: "qs", answer: "today", seq, via: "board" }, { project: "fx", squad: "demo", member: LEAD });
    await withEnv({ DS_LOOP_SEND_TRIES: "1" }, () => tick());
    expect(s.db.query("SELECT status, answer FROM questions WHERE project = 'fx' AND squad = 'demo' AND id = 'qs' ORDER BY seq").all())
      .toEqual([{ status: "answered", answer: "last week" }, { status: "open", answer: null }]);
  });

  test("a delivered answer clears its card's NEEDS YOU note once no other open question sits on it", async () => {
    const s = imported(), orca = new FakeOrca(), { tick } = rig(s, orca);
    ask(s, "fx", "demo", { id: "qn", asker: "lead", blocking: true, question: "go?", since: "2026-10-08T09:00:00Z", card_wt: LEAD });
    ask(s, "fx", "demo", { id: "qo", asker: "lead", blocking: true, question: "and?", since: "2026-10-08T09:00:00Z", card_wt: LEAD });
    answer(s, "fx", "demo", "qn", "yes", "board");
    board(s, "answer", { id: "qn", answer: "yes", card_wt: LEAD, via: "board" }, { project: "fx", squad: "demo", member: LEAD });
    await tick();
    expect(orca.of("ping")).toEqual([]);   // qo still waits on that card
    answer(s, "fx", "demo", "qo", "sure", "board");
    board(s, "answer", { id: "qo", answer: "sure", card_wt: LEAD, via: "board" }, { project: "fx", squad: "demo", member: LEAD });
    await tick(T + 1);
    expect(orca.of("ping").map((c) => c.args)).toEqual([[LEAD, ""]]);
  });

  test("a picker that closed before its key is never typed into", async () => {
    const s = imported(), orca = new FakeOrca(), { tick } = rig(s, orca);
    const t = join(s.root, "t.jsonl");
    writeFileSync(t, `${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "answered" }] } })}\n`);
    const id = board(s, "answer", { id: "qk", answer: "Blue", choices: [{ label: "Blue" }], transcript: t, tool_use_id: "toolu_9", via: "board" },
      { project: "fx", squad: "demo", member: LEAD });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: false });
    expect(orca.of("keys")).toEqual([]);
  });
});

describe("the board in its own systemd unit (U76)", () => {
  // A fake systemd-run / systemctl on PATH: systemctl --user works; systemd-run records its argv and
  // runs what follows `--` detached, with the -E variables, as the real one would.
  test("with systemd the start goes through systemd-run --unit ds-board-<id>; without it the server is spawned detached", async () => {
    const { default: board } = await import("../../bin/loop/fulfil/board.ts");
    const services = (await import("../../bin/loop/reconcilers/services.ts")).default;
    const s = imported();
    const bin = mkdtempSync(join(tmpdir(), "zzsd-")); temps.push(bin);
    const rec = join(bin, "argv");
    writeFileSync(join(bin, "systemctl"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(bin, "systemd-run"), `#!/bin/bash
printf '%s\\n' "$@" > ${rec}
envs=(); out=""
while [ $# -gt 0 ]; do case "$1" in -E) envs+=("$2"); shift 2;; -p) case "$2" in StandardOutput=append:*) out="\${2#StandardOutput=append:}";; esac; shift 2;; --) shift; break;; *) shift;; esac; done
env "\${envs[@]}" setsid "$@" >> "$out" 2>&1 < /dev/null &
exit 0
`, { mode: 0o755 });
    const port = (() => { const v = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }); const p = v.port; v.stop(true); return p; })();
    const old = { PATH: process.env.PATH, DS_BIND: process.env.DS_BIND, DS_BOARD_SYSTEMD: process.env.DS_BOARD_SYSTEMD };
    Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, DS_BIND: "127.0.0.1" });
    delete process.env.DS_BOARD_SYSTEMD;
    const act = new LoopActuator({ orca: new FakeOrca(), fulfillers: [board as Fulfiller] });
    const loop = new Loop(s, { observers: [], reconcilers: [services as Reconciler] }, act, { projects: () => ["fx"] });
    const pids: number[] = [];
    try {
      loop.boot(T);
      s.want("service", "board/fx", "running", { payload: { port }, fill: { port }, by: "test" });
      const wantAt = Number((s.db.query("SELECT want_at FROM services WHERE project = 'fx'").get() as Row).want_at);
      await loop.tick(wantAt - 5); await act.drain();
      const r = s.db.query("SELECT * FROM services WHERE project = 'fx'").get() as Row;
      pids.push(Number(r.pid));
      expect(r).toMatchObject({ status: "running", port });
      const argv = readFileSync(rec, "utf8").split("\n");
      expect(argv).toContain("--user");
      expect(argv).toContain("--collect");
      expect(argv[argv.indexOf("--unit") + 1]).toBe(`ds-board-${r.id}`);
      expect(Number(r.pid)).toBeGreaterThan(0);
      // The wish was written after the tick's clock: the start records the want_at it served.
      expect(Number(r.started_at)).toBe(wantAt);
      expect((await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as { pid: number }).pid).toBe(Number(r.pid));
    } finally {
      for (const p of pids) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
      for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
    // Without systemd: detached as before, no systemd-run call.
    rmSync(rec);
    Object.assign(process.env, { DS_BOARD_SYSTEMD: "0", DS_BIND: "127.0.0.1" });
    const s2 = imported();
    const act2 = new LoopActuator({ orca: new FakeOrca(), fulfillers: [board as Fulfiller] });
    const loop2 = new Loop(s2, { observers: [], reconcilers: [services as Reconciler] }, act2, { projects: () => ["fx"] });
    try {
      loop2.boot(T);
      s2.want("service", "board/fx", "running", { payload: { port }, fill: { port }, by: "test" });
      await loop2.tick(T); await act2.drain();
      const r2 = s2.db.query("SELECT * FROM services WHERE project = 'fx'").get() as Row;
      pids.push(Number(r2.pid));
      expect(r2.status).toBe("running");
      expect(existsSync(rec)).toBe(false);
    } finally {
      for (const p of pids) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
      for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  }, 60_000);
});
