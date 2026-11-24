// login-card.test.ts — claude-login-ended U3: the Needs-you card for an account whose login ended
// (bin/loop/capacity/login-card.ts, run by the limits reconciler), on a temp copy of tests/fixtures/loop/state with
// a fake picker. The actuator's claim rows are written by `settle` the way it records a sent action.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { alertId } from "../../bin/loop/core/actuator.ts";
import type { Action, TickCtx } from "../../bin/loop/core/plugins.ts";
import { makeLimits, type Pick, type PickArgs } from "../../bin/loop/reconcilers/limits.ts";
import { clearLogin, holdLogin, loginHold } from "../../bin/loop/capacity/login.ts";
import { LOGGED_IN, LOGIN_KIND, LOGIN_MOVED_KIND, SWITCH_OFF, loginCommand } from "../../bin/loop/capacity/login-card.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_792_144_800;
const WS = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-";
const LEAD = `${WS}lead-demo`, BUILDER = `${WS}builder-u1-spike-loop-as-coordinator-demo`;
const ACCT = "6b9a19e7-e78f-4a78-ba77-b573b3c9f95d";
const KEY = `claude/${ACCT}`, CARD = `login.card|${KEY}`, MOVED = `login.moved|${KEY}`;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzlogin-card-")); temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  rmSync(join(d, "fx", "loop", "limited.json"), { force: true });
  const s = open(d); stores.push(s); importJson(s, d, () => {});
  for (const [key, value] of [["lead", "claude sonnet spawn -"], ["thinker", "claude opus spawn -"], ["builder", "claude opus spawn -"]])
    s.upsert("config", { project: "fx", file: "roles.conf", key }, { value, observed_at: T });
  s.upsert("accounts", { agent: "claude", account: ACCT }, { observed_at: T });
  for (const account of [ACCT, "acct-b"]) s.upsert("observed_accounts", { agent: "claude", account }, { updated: String(T), observed_at: T });
  s.db.run("UPDATE observed_accounts SET limited_until = NULL WHERE agent = 'claude'");
  s.db.run("UPDATE units SET status = 'dispatched' WHERE slug = 'u1-spike-loop-as-coordinator'");
  s.upsert("observed_prs", { project: "fx", ref: "demo/u1-spike-loop-as-coordinator" }, { state: "OPEN", observed_at: T });
  return s;
}
// `wt` runs Claude on the account, idle since `at`, showing `tail`.
function onAcct(s: Store, wt: string, tail = "❯", at = T) {
  s.db.run("UPDATE members SET agent = 'claude', model = 'sonnet', account = ? WHERE wt = ?", [ACCT, wt]);
  s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", tail, tail_at: at, since: at - 900, last_output_at: at - 900, limited: null, gone_at: null, suspect: 0, observed_at: at });
}
const note = (s: Store, n: string, label = "work") => s.upsert("observed_accounts", { agent: "claude", account: ACCT }, { note: n, label, updated: String(T), observed_at: T });
const WAIT: Pick = { wait: T + 3600 };
const OTHER: Pick = { agent: "claude", model: "sonnet", effort: "-", account: "acct-b", fallback: false };
const ctx = (s: Store, at: number): TickCtx => ({ store: s, project: "fx", tick: 1, now: at, fired: [], poked: new Set<string>() });
async function tick(s: Store, at: number, next: Pick | ((a: PickArgs) => Pick)): Promise<Action[]> {
  const r = makeLimits({ pick: (a) => (typeof next === "function" ? next(a) : next) });
  const out = (await r.run(ctx(s, at))) ?? [];
  settle(s, out, at);
  return out.filter((a) => a.subject.startsWith("login."));
}
// The actuator's claim row for each sent action (one per subject and kind; a new episode replaces it).
function settle(s: Store, actions: Action[], at: number) {
  for (const a of actions) s.upsert("episodes", { project: a.project, subject: a.subject, kind: `action:${a.kind}` }, { episode_key: a.episode, state: "done", started_at: at, source: "loop", observed_at: at });
}
const pay = (a: Action) => a.payload as Row;

describe("login card (claude-login-ended U3)", () => {
  test("one card per held account: label, terminal, command, every member (the Studio too) and the two answers", async () => {
    const s = imported();
    onAcct(s, BUILDER); onAcct(s, LEAD);
    note(s, "login ended · CLAUDE_CONFIG_DIR=/home/user/.cfg/work");
    const a = await tick(s, T, OTHER);
    expect(loginHold(s, "claude", ACCT, T)).not.toBeNull();
    expect(a.map((x) => [x.kind, x.subject])).toEqual([["alert", CARD]]);
    const p = pay(a[0]);
    expect(p).toMatchObject({ title: "work: login ended", card: LOGIN_KIND });
    expect((p.fields as Row).options).toEqual([LOGGED_IN, SWITCH_OFF]);
    expect((p.fields as Row).login).toEqual({ agent: "claude", account: ACCT });
    const text = String(p.text);
    expect(text).toContain("CLAUDE_CONFIG_DIR=/home/user/.cfg/work claude /login");
    expect(text).toContain("builder-u1-spike-loop-as-coordinator (demo)");
    expect(text).toContain("lead (demo)");
    expect(await tick(s, T + 60, OTHER)).toEqual([]);
  });

  test("a stuck member is listed first, marked, and its terminal named", async () => {
    const s = imported();
    onAcct(s, BUILDER); onAcct(s, LEAD);
    note(s, "login ended · default config");
    const id = String((s.db.query("SELECT id FROM members WHERE wt = ?").get(BUILDER) as Row).id);
    s.db.run("INSERT INTO overrides (member, model, account, scope, set_by, set_at) VALUES (?, 'sonnet', ?, 'member', 'test', ?)", [id, ACCT, T]);
    const text = String(pay((await tick(s, T, OTHER))[0]).text);
    expect(text).toContain("run /login in builder-u1-spike-loop-as-coordinator's terminal (or `claude /login`)");
    expect(text.indexOf("builder-u1")).toBeLessThan(text.indexOf("lead (demo)"));
    expect(text).toContain("builder-u1-spike-loop-as-coordinator (demo) — cannot move");
  });

  test("a hold from a screen alone says to use that account's config dir; no label falls back to the key", async () => {
    const s = imported();
    onAcct(s, BUILDER, "● Not logged in · Please run /login");
    const p = pay((await tick(s, T, OTHER))[0]);
    expect(String(p.title)).toBe(`${KEY}: login ended`);
    expect(String(p.text)).toContain("claude /login with that account's config dir");
    expect(loginCommand(null)).toContain("config dir");
  });

  test("a moved member keeps the card; when none is left it clears and one note says where they went", async () => {
    const s = imported();
    onAcct(s, BUILDER); note(s, "login ended · default config");
    const up = await tick(s, T, OTHER);
    expect(up.map((x) => x.kind)).toEqual(["alert"]);
    s.db.run("UPDATE members SET account = 'acct-b' WHERE wt = ?", [BUILDER]);
    const out = await tick(s, T + 60, OTHER);
    expect(out.map((x) => [x.kind, x.subject])).toEqual([["alert-clear", CARD], ["alert", MOVED]]);
    expect(pay(out[1])).toMatchObject({ card: LOGIN_MOVED_KIND });
    expect(String(pay(out[1]).text)).toContain("moved 1 member to claude/sonnet");
  });

  test("the hold ends: the card and the note clear with no answer; a new hold is a new card", async () => {
    const s = imported();
    onAcct(s, BUILDER); note(s, "login ended · default config");
    const up = await tick(s, T, OTHER);
    clearLogin(s, "claude", ACCT, "test", T + 60);
    const clr = await tick(s, T + 120, OTHER);
    expect(clr.map((x) => [x.kind, x.episode])).toEqual([["alert-clear", `cleared@${up[0].episode}`]]);
    expect(pay(clr[0])).toEqual({ target: "project", id: alertId(CARD, up[0].episode) });
    holdLogin(s, { agent: "claude", account: ACCT, from: "screen" }, T + 200);
    const again = await tick(s, T + 200, OTHER);
    expect(again.map((x) => x.kind)).toEqual(["alert"]);
    expect(again[0].episode).not.toBe(up[0].episode);
  });
});
