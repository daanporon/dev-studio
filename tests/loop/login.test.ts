// login.test.ts — claude-login-ended U2: an account whose Claude login ended is held host-wide
// (bin/loop/capacity/login.ts), from Claude's `· Please run /login` line on a member's screen or the usage
// probe's `login ended` note, on a temp copy of tests/fixtures/loop/state. Fixtures only: nothing here reads
// a credentials file.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { Action, TickCtx } from "../../bin/loop/core/plugins.ts";
import { since } from "../../bin/loop/core/events.ts";
import { decide } from "../../bin/loop/core/decide.ts";
import { makeLimits } from "../../bin/loop/reconcilers/limits.ts";
import { scan, type Gate } from "../../bin/loop/capacity/fingerprints.ts";
import { accountBlock, pick } from "../../bin/loop/capacity/pick.ts";
import { setAccountEnabled } from "../../bin/loop/capacity/accounts.ts";
import { clearLogin, heldNotice, liveLoginHolds, loginHold, LOGIN_HOLD_S } from "../../bin/loop/capacity/login.ts";
import { loginWorksAgain } from "../../bin/loop/squad/handoff.ts";
import lift from "../../bin/loop/fulfil/lift.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const LOGIN = join(ROOT, "tests", "fixtures", "login");
const fx = (f: string) => readFileSync(join(LOGIN, f), "utf8");
const SCREEN = fx("claude-login-ended.txt");
const LINE = "Login reached its time limit · Please run /login";
const T = 1_792_144_800;
const WS = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-";
const LEAD = `${WS}lead-demo`, THINKER = `${WS}thinker-demo`, BUILDER = `${WS}builder-u1-spike-loop-as-coordinator-demo`;
const ACCT = "6b9a19e7-e78f-4a78-ba77-b573b3c9f95d";
const H = LOGIN_HOLD_S;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzlogin-")); temps.push(d);
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
// `wt` runs Claude on `account`, idle with a live agent, showing `tail`.
function on(s: Store, wt: string, tail: string, account = ACCT, at = T) {
  s.db.run("UPDATE members SET agent = 'claude', model = 'opus', account = ? WHERE wt = ?", [account, wt]);
  s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", tail, tail_at: at, since: at - 900, last_output_at: at - 900, limited: null, gone_at: null, suspect: 0,
    presence: "running", account_at: at, observed_at: at });
  s.db.run("UPDATE members SET want = 'running', want_at = ?, want_result = 'fresh', status = 'running' WHERE wt = ?", [at - 60, wt]);
}
const probe = (s: Store, account: string, set: Row, at: number) =>
  s.upsert("observed_accounts", { agent: "claude", account }, { session_pct: "-", weekly_pct: "-", note: "-", updated: String(at), observed_at: at, ...set });
// The fixture's other Claude accounts (accounts.tsv acct-a, acct-b) held by the probe too: nowhere to go.
const others = (s: Store, at: number) => { for (const a of ["acct-a", "acct-b"]) probe(s, a, { note: `login ended · CLAUDE_CONFIG_DIR=/home/user/.claude-${a}` }, at); };
const ctx = (s: Store, at: number): TickCtx => ({ store: s, project: "fx", tick: 1, now: at, fired: [], poked: new Set<string>() });
const tick = (s: Store, at: number) => makeLimits().run(ctx(s, at));
const said = (s: Store, kind: string) => since(s, 0, { kinds: [kind] }).map((e) => JSON.parse(String(e.payload)) as Row);
const ended = (s: Store) => said(s, "account_login_ended");
const cleared = (s: Store) => said(s, "account_login_cleared");
const episode = (s: Store, wt: string) => s.get("episodes", { project: "fx", subject: wt, kind: "limited" });
const mine = (a: Action[], wt: string) => a.filter((x) => x.member === wt);
const decided = (s: Store, at: number) => decide(ctx(s, at));
const stops = (a: Action[]) => a.filter((x) => x.kind === "member" && (x.payload as Row)?.stop);
const tells = (a: Action[]) => a.filter((x) => x.kind === "poke");

describe("the screen line (fingerprints.ts CLAUDE_LOGIN_RE)", () => {
  const g = (agent: string | null, over: Partial<Gate> = {}): Gate => ({ agent, state: "idle", since: T - 30, lastOutput: T - 30, now: T, silentMin: 10, ...over });

  test("Claude's line reads as login: no reset, no dialog, at once on an idle worker", () => {
    for (const agent of ["claude", null]) expect(scan(SCREEN, g(agent))).toEqual({ reset: null, notice: LINE, dialog: false, kind: "login" });
    expect(scan(SCREEN, g("claude", { since: null, lastOutput: null }))).toMatchObject({ kind: "login" });
    expect(scan("  ⎿  API Error: 401 · Please run /login\n❯", g("claude"))).toMatchObject({ kind: "login", notice: "API Error: 401 · Please run /login" });
  });
  test("near misses: another agent, prose quoting it, an entry after it, a working worker with recent output", () => {
    expect(scan(SCREEN, g("muse"))).toBeNull();
    expect(scan(SCREEN, g("codex"))).toBeNull();
    expect(scan(fx("claude-login-quoted.txt"), g("claude"))).toBeNull();
    expect(scan(SCREEN.replace("\n\n───", "\n\n● Back after the login.\n\n───"), g("claude"))).toBeNull();
    expect(scan(SCREEN, g("claude", { state: "working", lastOutput: T - 30 }))).toBeNull();
  });
  test("a narrow pane's wrapped line is read whole", () => {
    const wrapped = `● Login reached its time limit ·\n  Please run /login\n❯`;
    expect(scan(wrapped, g("claude"))).toMatchObject({ kind: "login", notice: LINE });
    expect(scan(`● Login reached its time limit ·\nPlease run /login\n❯`, g("claude"))).toBeNull();   // not indented under it
  });
  test("a long line is cut to the notice size and keeps its tail", () => {
    const r = scan(`● ${"x".repeat(400)} · Please run /login\n❯`, g("claude"))!;
    expect(r.kind).toBe("login");
    expect(Buffer.byteLength(r.notice)).toBeLessThanOrEqual(160);
    expect(r.notice).toEndWith("· Please run /login");
  });
});

describe("U2: an account whose login ended is held host-wide", () => {
  function unblocked(s: Store, at: number) {
    expect(loginHold(s, "claude", ACCT, at)).toBeNull();
    expect(s.db.query("SELECT subject FROM episodes WHERE kind = 'account' AND state = ? AND ended_at > ?").all(`claude/${ACCT}`, at)).toEqual([]);
    expect(s.db.query("SELECT 1 FROM members WHERE account = ? AND limited_until IS NOT NULL").all(ACCT)).toEqual([]);
    expect(accountBlock(s, "claude", ACCT, at)).toBeNull();
  }

  test("hold from the screen: one hold for 1 h, renewed while the line stands, the member limited with no reset", async () => {
    const s = imported();
    on(s, BUILDER, SCREEN);
    await tick(s, T);
    expect(loginHold(s, "claude", ACCT, T)).toBe(T + H);
    expect(accountBlock(s, "claude", ACCT, T)).toBe("login");
    expect(ended(s)).toEqual([{ agent: "claude", account: ACCT, from: "screen", notice: LINE }]);
    expect([episode(s, BUILDER)!.state, episode(s, BUILDER)!.episode_key]).toEqual(["login", `claude/${ACCT}|${LINE}`]);
    on(s, BUILDER, SCREEN, ACCT, T + 600);
    await tick(s, T + 600);
    expect(loginHold(s, "claude", ACCT, T + 600)).toBe(T + 600 + H);
    expect(ended(s)).toHaveLength(1);
    expect(since(s, 0, { kinds: ["limited"] })).toHaveLength(1);
    expect(liveLoginHolds(s, T + 600)).toEqual([{ agent: "claude", account: ACCT, started: T, until: T + 600 + H, from: "screen" }]);
  });

  test("hold from the probe: every member on the account reads limited, the others do not", async () => {
    const s = imported();
    on(s, BUILDER, "❯");
    on(s, THINKER, "❯", "acct-b");
    probe(s, ACCT, { note: "login ended · default config" }, T);
    await tick(s, T);
    expect(loginHold(s, "claude", ACCT, T)).toBe(T + H);
    expect(ended(s)).toEqual([{ agent: "claude", account: ACCT, from: "probe", notice: "login ended · default config" }]);
    expect([episode(s, BUILDER)!.state, episode(s, BUILDER)!.episode_key]).toEqual(["login", `claude/${ACCT}|${heldNotice("claude", ACCT)}`]);
    expect(episode(s, THINKER)?.state ?? null).not.toBe("login");
    await tick(s, T + 120);
    expect(ended(s)).toHaveLength(1);
  });

  test("clear on recovery: the probe's allowance ends the hold and clears the member", async () => {
    const s = imported();
    on(s, BUILDER, "❯");
    probe(s, ACCT, { note: "login ended · default config" }, T);
    await tick(s, T);
    probe(s, ACCT, { session_pct: "3" }, T + 600);
    await tick(s, T + 600);
    expect(cleared(s)).toEqual([expect.objectContaining({ by: "probe", held: true, members_cleared: 1 })]);
    expect(episode(s, BUILDER)!.state).toBe("cleared");
    unblocked(s, T + 600);
  });

  test("re-hold: after the probe's own clear a note that comes back holds at once", async () => {
    const s = imported();
    probe(s, ACCT, { note: "login ended · default config" }, T);
    await tick(s, T);
    probe(s, ACCT, { note: "no usage yet" }, T + 300);
    await tick(s, T + 300);
    expect(loginHold(s, "claude", ACCT, T + 300)).toBeNull();
    probe(s, ACCT, { note: "login ended · default config" }, T + 600);
    await tick(s, T + 600);
    expect(loginHold(s, "claude", ACCT, T + 600)).toBe(T + 600 + H);
    expect(ended(s)).toHaveLength(2);
  });

  test("old line stays cleared: after an operator clear only a later reading holds again", async () => {
    const s = imported();
    on(s, BUILDER, SCREEN);
    probe(s, ACCT, { note: "login ended · default config" }, T);
    await tick(s, T);
    expect(clearLogin(s, "claude", ACCT, "operator", T + 120)).toMatchObject({ held: true, members_cleared: 1 });
    expect(cleared(s)[0].by).toBe("operator");
    // The same line on screen and the probe's old reading, its row confirmed again by the state observer
    // (observed_at moves, updated does not): still cleared, nothing held.
    s.db.run("UPDATE observed_accounts SET observed_at = ?", [T + 180]);
    await tick(s, T + 180);
    expect([episode(s, BUILDER)!.state, episode(s, BUILDER)!.ended_at]).toEqual(["cleared", T + 120]);
    unblocked(s, T + 180);
    expect(ended(s)).toHaveLength(1);
    // A reading taken after the clear holds it again.
    probe(s, ACCT, { note: "login ended · default config" }, T + 240);
    await tick(s, T + 240);
    expect(loginHold(s, "claude", ACCT, T + 240)).toBe(T + 240 + H);
    expect(ended(s)).toHaveLength(2);
  });

  test("with no evidence left the hold lapses after an hour", async () => {
    const s = imported();
    probe(s, ACCT, { note: "login ended · default config" }, T);
    await tick(s, T);
    probe(s, ACCT, { note: "expired" }, T + 60);   // neither holds nor clears
    await tick(s, T + 60);
    expect(loginHold(s, "claude", ACCT, T + H - 1)).toBe(T + H);
    expect(loginHold(s, "claude", ACCT, T + H)).toBeNull();
    expect(cleared(s)).toEqual([]);
  });

  test("ds account enable and ds limit-lift clear the hold", async () => {
    for (const how of ["enable", "lift"]) {
      const s = imported();
      on(s, BUILDER, SCREEN);
      await tick(s, T);
      if (how === "enable") expect(setAccountEnabled(s, { agent: "claude", account: ACCT, enabled: true, by: "test" }, T + 60)).toMatchObject({ cleared: true });
      else lift.exec!({ kind: "limit-lift", project: "", subject: "", payload: { agent: "claude", account: ACCT } } as unknown as Action, ctx(s, T + 60) as never);
      expect([how, cleared(s).length]).toEqual([how, 1]);
      unblocked(s, T + 60);
    }
  });

  test("the pick leaves a held account out and names it in a wait", async () => {
    const s = imported();
    probe(s, ACCT, { note: "login ended · default config" }, T);
    await tick(s, T);
    const p = pick(s, { project: "fx", role: "thinker", phase: "build" }, T) as Row;
    expect(p.account).not.toBe(ACCT);
    others(s, T + 60);
    await tick(s, T + 60);
    const w = pick(s, { project: "fx", role: "thinker", phase: "build" }, T + 60) as Row;
    expect(w).toMatchObject({ wait: expect.any(Number) });
    expect(String(w.reason)).toContain(`; claude:${ACCT}, claude:acct-a, claude:acct-b login ended; wait until`);
  });
});

describe("U2: a member on a held account moves, with no tell while held and one after the clear", () => {
  test("idle on the held account it is stopped so its start picks another account", async () => {
    const s = imported();
    on(s, THINKER, SCREEN);
    await tick(s, T);
    const a = mine(decided(s, T), THINKER);
    expect(stops(a)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ stop: true, why: "limit" }) })]);
    expect(tells(a)).toEqual([]);
  });

  test("tell once: nowhere to go means no tell and no stop; after the clear one login-ok tell", async () => {
    const s = imported();
    on(s, BUILDER, SCREEN);
    others(s, T);
    await tick(s, T);
    for (const at of [T, T + 60, T + 1800]) {
      const a = mine(decided(s, at), BUILDER);
      expect(stops(a)).toEqual([]);
      expect(tells(a)).toEqual([]);
    }
    expect(setAccountEnabled(s, { agent: "claude", account: ACCT, enabled: true, by: "test" }, T + 1900)).toMatchObject({ cleared: true });
    await tick(s, T + 1920);   // the line is still on screen: the episode stays `cleared`
    expect(episode(s, BUILDER)!.state).toBe("cleared");
    const told = tells(mine(decided(s, T + 1920), BUILDER));
    expect(told.map((x) => (x.payload as Row).text)).toEqual([loginWorksAgain]);
    expect(told[0].episode).toStartWith(`login-ok:login-ok|claude/${ACCT}|`);
    expect((told[0].payload as Row).reason).toBe("login-ok");
  });
});
