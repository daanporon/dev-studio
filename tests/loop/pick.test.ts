// pick.test.ts — U9: the loop's account picker (bin/loop/capacity/pick.ts), its reconciler and `ds pick`, on
// a temp state root with tests/fixtures/loop/accounts.tsv (three claude accounts resetting in 1 h,
// 2 h and 4 h) and a copy of conventions/: fill-first, the load-aware room check, the ladder and its
// floor, overrides until done, the start budget, no_session_window and the pick events.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import { accountBlock, ladder, overrideOf, pick, tuple, workDone, type Picked, type PickReq, type Waiting } from "../../bin/loop/capacity/pick.ts";
import { reconcile, slotBudget } from "../../bin/loop/capacity/picks.ts";
import { slot } from "../../bin/loop/capacity/slot.ts";
import { since } from "../../bin/loop/core/events.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { holdCredits } from "../../bin/loop/capacity/credits.ts";
import { holdLogin } from "../../bin/loop/capacity/login.ts";
import { setAccountEnabled } from "../../bin/loop/capacity/accounts.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const T = 1_800_000_000;
const ENV = ["DS_LIMIT_PICK_FLOOR_BUILDER", "DS_LOOP_START_SLOTS", "DS_PICK_WAIT_S", "DS_LIMIT_MAX_BUILDERS"];

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const e of ENV) delete process.env[e];
});
function fixture(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzloop-")), conv = mkdtempSync(join(tmpdir(), "zzconv-"));
  temps.push(d, conv);
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  for (const p of ["fx", "fy"]) mkdirSync(join(d, p, "squads"), { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(d, "accounts.tsv"));
  const s = open(d);
  stores.push(s);
  importConfig(s, d, conv);
  for (const r of accountRows(d)) s.upsert(r.table, r.key, r.set);
  return s;
}
let wtNo = 0;
function member(s: Store, set: Row): number {
  const row: Row = { project: "fx", squad: "demo", role: "builder", suffix: "", observed_at: T, updated_at: T, ...set };
  if (row.status === "running" && row.wt === undefined) row.wt = `wt-${++wtNo}`;
  const ks = Object.keys(row);
  return Number(s.db.run(`INSERT INTO members (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`, ks.map((k) => row[k] as string | number | null)).lastInsertRowid);
}
// placed: seconds before T it was placed on the account; default a minute ago (inside pick_ttl_s). null: long running.
const running = (s: Store, account: string, tier = "hard", placed: number | null = 60) =>
  member(s, { status: "running", agent: "claude", model: "opus", account, tier, placed_at: placed === null ? null : T - placed });
// A member wanting a start: its own identity (the decider reads the latest row per identity).
const wanted = (s: Store, set: Row = {}) => member(s, { want: "running", want_at: T, tier: "hard", suffix: `w${++wtNo}`, ...set });
const acct = (s: Store, account: string, set: Row) => s.upsert("observed_accounts", { agent: "claude", account }, set);
const ok = (p: unknown) => { expect(p).not.toHaveProperty("wait"); expect(p).not.toHaveProperty("error"); return p as Picked; };
const builder = (s: Store, req: Partial<PickReq> = {}) => pick(s, { project: "fx", role: "builder", tier: "hard", phase: "build", ...req }, T);
const ctx = (s: Store, at = T) => ({ store: s, project: "", tick: 1, now: at, fired: [], poked: new Set() } as TickCtx);
const picks = (s: Store) => s.db.query("SELECT * FROM picks ORDER BY member").all() as Row[];
const events = (s: Store, kind = "pick") => since(s, 0, { kinds: [kind] });

describe("pick", () => {
  test("Codex primary uses its default login and a limit selects Muse with its own effort", () => {
    const s = fixture();
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value: "codex gpt-6.1-sol ondemand high muse:muse-spark-1.3:max", observed_at: T });
    s.upsert("observed_accounts", { agent: "codex", account: "default" }, { session_pct: "-", weekly_pct: "-", observed_at: T });
    s.upsert("observed_accounts", { agent: "muse", account: "default" }, { session_pct: "-", weekly_pct: "-", observed_at: T });
    expect(tuple(ok(builder(s)))).toBe("codex\tgpt-6.1-sol\thigh\tdefault\t0");
    expect(tuple(ok(builder(s, { limited: [`codex:default=${T + 3600}`] })))).toBe("muse\tmuse-spark-1.3\tmax\tdefault\t1");
  });

  test("fill-first: the account resetting soonest that has room, in ds pick's tuple", () => {
    const s = fixture();
    const p = ok(builder(s));
    expect(tuple(p)).toBe("claude\topus\t-\tacct-a\t0");
    expect(p.why).toBe("fill_first");
    expect(p.reason).toContain("acct-a resets soonest");
    // Full up to the session max: the next reset with room.
    acct(s, "acct-a", { session_pct: "95" });
    expect(ok(builder(s)).account).toBe("acct-b");
  });

  test("load-aware room: an account with room for one more Builder, not two", () => {
    const s = fixture();
    running(s, "acct-a");                       // 50 % + 20 + 20 = 90 % < 95 %: room for one more
    expect(ok(builder(s)).account).toBe("acct-a");
    running(s, "acct-a");                       // 50 % + 40 + 20 = 110 %: no room
    expect(ok(builder(s)).account).toBe("acct-b");
    // A standard-tier member weighs less: 50 % + 40 + 10 = 100 % is still no room; 30 % + 10 on acct-b is.
    expect(ok(builder(s, { tier: "standard" })).account).toBe("acct-b");
  });

  test("real usage only: running members already show in the session %, newly placed ones add a load", () => {
    const s = fixture();
    acct(s, "acct-a", { session_pct: "30" });
    for (let i = 0; i < 8; i++) running(s, "acct-a", "hard", null);   // eight running members, long placed
    expect(ok(builder(s)).account).toBe("acct-a");                    // 30 % + 20 < 95 %: usable
    // Three placed a minute ago: 30 + 60 + 20 = 110 % counts their load.
    const t = fixture();
    acct(t, "acct-a", { session_pct: "30" });
    for (let i = 0; i < 3; i++) running(t, "acct-a", "hard", 60);
    expect(ok(builder(t)).account).toBe("acct-b");
    // ... but placed 10 minutes ago (pick_ttl_s 600) they no longer count.
    const u = fixture();
    acct(u, "acct-a", { session_pct: "30" });
    for (let i = 0; i < 3; i++) running(u, "acct-a", "hard", 601);
    expect(ok(builder(u)).account).toBe("acct-a");
    // A run-switch episode for the member's key counts as a fresh placement.
    const v = fixture();
    acct(v, "acct-a", { session_pct: "30" });
    for (let i = 0; i < 3; i++) member(v, { status: "running", wt: `wt-sw${i}`, agent: "claude", model: "opus", account: "acct-a", tier: "hard", suffix: `u${i}` });
    for (let i = 0; i < 3; i++) v.upsert("episodes", { project: "fx", subject: `demo.builder-u${i}`, kind: "action:run-switch" }, { started_at: T - 5000, ended_at: T - 60, state: "done", source: "loop", observed_at: T });
    expect(ok(builder(v)).account).toBe("acct-b");
  });

  test("main first: with one Claude account limited and the other usable, no pick lands on a fallback rung", () => {
    const s = fixture();
    s.upsert("episodes", { project: "", subject: "wt-x|limit", kind: "account" }, { state: "claude/acct-a", ended_at: T + 600, source: "loop", observed_at: T });
    s.upsert("episodes", { project: "", subject: "wt-y|limit", kind: "account" }, { state: "claude/acct-c", ended_at: T + 600, source: "loop", observed_at: T });
    acct(s, "acct-b", { session_pct: "40" });
    for (let i = 0; i < 8; i++) running(s, "acct-b", "hard", null);
    for (let i = 0; i < 3; i++) { const p = ok(builder(s)); expect([p.agent, p.model, p.account, p.fallback]).toEqual(["claude", "opus", "acct-b", false]); }
  });

  test("a fallback rung only when no higher account is usable, and why names each skip", () => {
    const s = fixture();
    s.upsert("episodes", { project: "", subject: "wt-x|limit", kind: "account" }, { state: "claude/acct-a", ended_at: T + 600, source: "loop", observed_at: T });
    acct(s, "acct-b", { session_pct: "96" });
    acct(s, "acct-c", { weekly_pct: "99" });
    const p = ok(builder(s));
    expect([p.agent, p.fallback]).toEqual(["muse", true]);
    for (const part of ["claude:opus", "acct-a limited", "acct-b session 96%", "acct-c weekly 99%"]) expect(p.why).toContain(part);
    // A first rung that is not Claude behaves the same.
    const t = fixture();
    t.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value: "muse muse-spark-1.3 ondemand - claude:opus", observed_at: T });
    expect(ok(builder(t)).agent).toBe("muse");
  });

  test("U31: a squad on a contract backend never lands on an agent it has no launch line for", () => {
    const limitedAll = (s: Store) => {
      s.upsert("episodes", { project: "", subject: "wt-x|limit", kind: "account" }, { state: "claude/acct-a", ended_at: T + 600, source: "loop", observed_at: T });
      acct(s, "acct-b", { session_pct: "96" });
      acct(s, "acct-c", { weekly_pct: "99" });
    };
    const s = fixture();
    limitedAll(s);
    s.upsert("squads", { project: "fx", topic: "demo" }, { backend: "tmux", observed_at: T, updated_at: T });
    const w = builder(s, { squad: "demo" }) as Waiting;
    expect(w.why).toBe("wait");
    expect(w.reason).toContain("host busy: no account for claude on tmux");
    expect(w.reason).toContain("muse cannot start on tmux");
    // A Claude account frees up: it starts on Claude, not a fallback.
    acct(s, "acct-b", { session_pct: "40" });
    expect(tuple(ok(builder(s, { squad: "demo" })))).toBe("claude\topus\t-\tacct-b\t0");
    // An Orca squad still falls back as today.
    const o = fixture();
    limitedAll(o);
    o.upsert("squads", { project: "fx", topic: "demo" }, { backend: "orca", observed_at: T, updated_at: T });
    expect(ok(builder(o, { squad: "demo" })).agent).toBe("muse");
  });

  test("U267: a project roster that lacks a role runs the default row for it (studio: claude sonnet)", () => {
    const s = fixture();
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value: "claude haiku ondemand", observed_at: T });
    expect(s.db.query("SELECT count(*) AS n FROM config WHERE project = 'fx' AND file = 'roles.conf' AND key = 'studio'").get()).toEqual({ n: 0 });
    expect(ok(pick(s, { project: "fx", role: "studio" }, T))).toMatchObject({ agent: "claude", model: "sonnet" });
    expect(ok(builder(s))).toMatchObject({ agent: "claude", model: "haiku" });   // the project's own row still wins
    expect(pick(s, { project: "fx", role: "nope" }, T)).toEqual({ error: "pick: no roles.conf row for role 'nope'" });
  });

  test("ladder: listed fallbacks; floor; WAIT below it", () => {
    const s = fixture();
    for (const a of ["acct-a", "acct-b", "acct-c"]) acct(s, a, { weekly_pct: "99" });
    // builder: claude:opus, claude:sonnet, muse:muse-spark-1.3 — muse has no account listed: its default login.
    const p = ok(builder(s));
    expect([p.agent, p.account, p.fallback, p.rung]).toEqual(["muse", null, true, 3]);
    expect(tuple(p)).toBe("muse\tmuse-spark-1.3\t-\t-\t1");
    // Floor at claude:sonnet: nothing at or above it has room -> WAIT at the soonest weekly reset.
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "claude:sonnet";
    const w = builder(s) as Waiting;
    expect(w.wait).toBe(1800086400);
    expect(w.reason).toContain("floor claude:sonnet");
    // One claude account frees up: back on claude, first rung.
    acct(s, "acct-b", { weekly_pct: "30" });
    expect(tuple(ok(builder(s)))).toBe("claude\topus\t-\tacct-b\t0");
  });

  test("interleaved agents keep the written order for picks and floors", () => {
    const s = fixture();
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" },
      { value: "claude opus ondemand high codex:x,muse:y,claude:sonnet", observed_at: T });
    for (const agent of ["codex", "muse"]) s.upsert("observed_accounts", { agent, account: "default" },
      { session_pct: "0", session_reset: String(T + 3600), weekly_pct: "0", updated: String(T), observed_at: T });
    expect(ladder(s, { project: "fx", role: "builder" }, null)?.rungs.map(r => `${r.agent}:${r.model}`))
      .toEqual(["claude:opus", "codex:x", "muse:y", "claude:sonnet"]);
    expect(ok(builder(s))).toMatchObject({ agent: "claude", model: "opus", rung: 1 });
    for (const a of ["acct-a", "acct-b", "acct-c"]) acct(s, a, { weekly_pct: "99" });
    expect(ok(builder(s))).toMatchObject({ agent: "codex", model: "x", rung: 2 });
    const limited = [`codex:default=${T + 3600}`];
    expect(ok(builder(s, { limited }))).toMatchObject({ agent: "muse", model: "y", rung: 3 });
    const id = member(s, { want: "running" });
    acct(s, "acct-b", { weekly_pct: "30" });
    expect(ok(builder(s, { member: id, limited: [...limited, `muse:default=${T + 3600}`] })))
      .toMatchObject({ agent: "claude", model: "opus", rung: 1 });
    acct(s, "acct-b", { weekly_pct: "99" });
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "codex:x";
    const w = builder(s, { limited }) as Waiting;
    expect(w).toHaveProperty("wait");
    expect(w.why).not.toContain("muse:y");
    expect(w.why).not.toContain("claude:sonnet");
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "muse:y";
    expect(ok(builder(s, { limited }))).toMatchObject({ agent: "muse", model: "y", rung: 3 });
  });

  test("a standard Builder takes the builder-standard row in ce-pipeline only", () => {
    const s = fixture();
    expect(tuple(ok(builder(s, { tier: "standard" })))).toBe("claude\tsonnet\t-\tacct-a\t0");
    s.upsert("config", { project: "fx", file: "ship-mode", key: "mode" }, { value: "direct-PR", observed_at: T });
    expect(ok(builder(s, { tier: "standard" })).model).toBe("opus");
  });

  test("an account limited by an episode, a limited member or limited_until is skipped", () => {
    const s = fixture();
    s.upsert("episodes", { project: "", subject: "wt-x|limit", kind: "account" }, { state: "claude/acct-a", ended_at: T + 600, source: "loop", observed_at: T });
    expect(ok(builder(s)).account).toBe("acct-b");
    member(s, { status: "running", wt: "wt-lim", agent: "claude", account: "acct-b", limited_until: T + 60 });
    expect(ok(builder(s)).account).toBe("acct-c");
    acct(s, "acct-c", { limited_until: String(T + 900) });
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "claude:sonnet";   // muse would take it otherwise
    expect((builder(s) as Waiting).wait).toBe(T + 60);   // the soonest of the three frees up first
  });

  test("a depleted Muse weekly allowance waits for Claude's earlier session reset", () => {
    const s = fixture();
    for (const a of ["acct-a", "acct-b", "acct-c"]) acct(s, a, { session_pct: "100", session_reset: String(T + 4 * 3600) });
    s.upsert("observed_accounts", { agent: "muse", account: "default" }, { session_pct: "0", session_reset: String(T + 3600), weekly_pct: "100", weekly_reset: String(T + 3 * 86400), updated: String(T), observed_at: T });
    expect(builder(s)).toMatchObject({ wait: T + 4 * 3600, known: true });
  });

  test("an account frees only after every blocking window resets", () => {
    const s = fixture();
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "claude:sonnet";
    for (const a of ["acct-a", "acct-b", "acct-c"]) acct(s, a, { session_pct: "100", session_reset: String(T + 4 * 3600), weekly_pct: "100", weekly_reset: String(T + 3 * 86400), limited_until: String(T + 3600) });
    expect(builder(s)).toMatchObject({ wait: T + 3 * 86400, known: true });
  });

  test("no 5-hour window: picked on weekly room alone, reason no_session_window", () => {
    const s = fixture();
    for (let i = 0; i < 5; i++) running(s, "acct-c");     // newly placed: load that would sink a windowed account
    acct(s, "acct-c", { session_pct: null, session_reset: null, weekly_pct: "20", weekly_reset: String(T + 1800) });
    const p = ok(builder(s));
    expect([p.account, p.why]).toEqual(["acct-c", "no_session_window"]);
    // Its weekly cap still blocks it.
    acct(s, "acct-c", { weekly_pct: "96" });
    expect(ok(builder(s)).account).toBe("acct-a");
  });

  test("a failed usage fetch is unknown usage, not a missing window: the room check still applies", () => {
    const s = fixture();
    for (let i = 0; i < 5; i++) running(s, "acct-c");
    acct(s, "acct-c", { session_pct: null, session_reset: null, weekly_pct: null, weekly_reset: null });
    acct(s, "acct-a", { weekly_pct: "99" }); acct(s, "acct-b", { weekly_pct: "99" });
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "claude:sonnet";
    expect(builder(s)).toHaveProperty("wait");   // 0 % + 5 × 20 % of load: no room
  });

  test("a session % with no reset epoch still counts; only a reset that passed zeroes it", () => {
    const s = fixture();
    acct(s, "acct-a", { session_pct: "99", session_reset: null });
    expect(ok(builder(s)).account).toBe("acct-b");
    acct(s, "acct-a", { session_reset: String(T - 1) });
    acct(s, "acct-b", { weekly_pct: "99" }); acct(s, "acct-c", { weekly_pct: "99" });
    expect(ok(builder(s)).account).toBe("acct-a");       // its window is over: 0 %
  });

  test("a running Builder weighs its unit's tier", () => {
    const s = fixture();
    s.db.run("INSERT INTO units (project, squad, slug, status, tier, observed_at, updated_at) VALUES ('fx', 'demo', 'u7', 'dispatched', 'hard', ?, ?)", [T, T]);
    member(s, { status: "running", wt: "wt-u7a", suffix: "u7", agent: "claude", model: "opus", account: "acct-a", placed_at: T - 30 });
    member(s, { status: "running", wt: "wt-u7b", suffix: "u7", agent: "claude", model: "opus", account: "acct-a", placed_at: T - 30 });
    expect(ok(builder(s)).account).toBe("acct-b");      // 50 % + 2 × 20 % + 20 % >= 95 %
  });

  test("an override wins until the member's work is done", () => {
    const s = fixture();
    s.db.run("INSERT INTO units (project, squad, slug, status, tier, observed_at, updated_at) VALUES ('fx', 'demo', 'u1', 'dispatched', 'hard', ?, ?)", [T, T]);
    const id = wanted(s, { suffix: "u1" });
    s.db.run("INSERT INTO overrides (member, model, account, scope, set_by, set_at) VALUES (?, 'sonnet', 'acct-c', 'member', 'operator', ?)", [String(id), T]);
    s.db.run("INSERT INTO overrides (member, model, scope, set_at) VALUES (?, 'fable', 'squad', ?)", [String(id), T + 1]); // a squad row whose target is no squad of this member: ignored
    const p = ok(builder(s, { member: id }));
    expect([p.model, p.account, p.why]).toEqual(["sonnet", "acct-c", "override"]);
    reconcile(ctx(s));
    expect(s.db.query("SELECT cleared_at FROM overrides WHERE scope = 'member'").get()).toEqual({ cleared_at: null });
    s.db.run("UPDATE units SET status = 'done'");
    reconcile(ctx(s, T + 5));
    expect(s.db.query("SELECT cleared_at FROM overrides WHERE scope = 'member'").get()).toEqual({ cleared_at: T + 5 });
    expect(events(s, "override_cleared").length).toBe(1);
    expect(ok(builder(s, { member: id })).model).toBe("opus");
  });

  // U205: a pin carries an effort and a plan.
  const pin = (s: Store, set: string) => {
    s.db.run("INSERT INTO units (project, squad, slug, status, tier, observed_at, updated_at) VALUES ('fx', 'demo', 'u1', 'dispatched', 'hard', ?, ?)", [T, T]);
    const id = wanted(s, { suffix: "u1" });
    s.db.run(`INSERT INTO overrides (member, ${set.split("|")[0]}, scope, set_by, set_at) VALUES (?, ${set.split("|")[1]}, 'member', 'board', ?)`, [String(id), T]);
    return id;
  };
  test("a pin's effort runs the pinned model on that effort", () => {
    const s = fixture();
    const id = pin(s, "model, effort|'sonnet', 'high'");
    expect(ok(builder(s, { member: id })).effort).toBe("high");
  });
  test("a pin's plan picks only among that plan's accounts and waits when none has room", () => {
    const s = fixture();
    acct(s, "acct-a", { plan: "Max", session_pct: "0" });
    acct(s, "acct-b", { plan: "Ultra", session_pct: "0" });
    acct(s, "acct-c", { plan: "Max", session_pct: "0" });
    const id = pin(s, "model, effort, plan|'opus', 'high', 'Ultra'");
    expect(ok(builder(s, { member: id })).account).toBe("acct-b");
    acct(s, "acct-b", { session_pct: "99" });
    expect(builder(s, { member: id })).toHaveProperty("wait");
  });
  test("a pinned account stays as it was, with the pin's effort", () => {
    const s = fixture();
    const id = pin(s, "model, effort, account|'sonnet', 'low', 'acct-c'");
    const p = ok(builder(s, { member: id }));
    expect([p.account, p.effort]).toEqual(["acct-c", "low"]);
  });

  test("an explicit agent/model replaces the ladder", () => {
    const s = fixture();
    expect(tuple(ok(builder(s, { agent: "claude", model: "fable", effort: "high" })))).toBe("claude\tfable\thigh\tacct-a\t0");
  });
});

describe("work completion and overrides", () => {
  const unit = (s: Store, slug: string, status: string, builder_wt: string | null = null) =>
    s.upsert("units", { project: "fx", squad: "demo", slug }, { status, builder_wt, observed_at: T, updated_at: T });
  const overridden = (s: Store, set: Row = {}) => {
    const id = wanted(s, { suffix: "own", ...set });
    s.upsert("overrides", { member: String(id) }, { model: "sonnet", account: "acct-c", scope: "member", set_at: T });
    return { m: s.get("members", { id })!, ov: s.get("overrides", { member: String(id) })! };
  };
  const retained = (s: Store, m: Row, ov: Row) => {
    expect(workDone(s, m)).toBe(false);
    expect(overrideOf(s, m)?.id).toBe(ov.id);
    reconcile(ctx(s));
    expect(s.get("overrides", { id: ov.id })?.cleared_at).toBeNull();
    expect(s.get("picks", { member: m.id })).toMatchObject({ model: "sonnet", account: "acct-c", slot: 1 });
    expect(events(s, "override_cleared")).toHaveLength(0);
  };

  test.each([null, ""])("exact-unit regression: unrelated done empty worktree keeps a wanted Builder override (wt=%p)", (wt) => {
    const s = fixture();
    unit(s, "other", "done", "");
    unit(s, "own", "planned");
    const { m, ov } = overridden(s, { wt });
    retained(s, m, ov);
  });

  test.each([null, ""])("no slug match and no worktree cannot inherit unrelated completion (wt=%p)", (wt) => {
    const s = fixture();
    unit(s, "other", "done", "");
    const { m, ov } = overridden(s, { wt });
    retained(s, m, ov);
  });

  test.each(["done", "merged", "cancelled"])("own unit %s clears its override exactly once", (status) => {
    const s = fixture();
    unit(s, "other", "done", "");
    unit(s, "own", "planned");
    const { m, ov } = overridden(s);
    retained(s, m, ov);
    unit(s, "own", status);
    expect(workDone(s, m)).toBe(true);
    expect(overrideOf(s, m)).toBeNull();
    reconcile(ctx(s, T + 5));
    reconcile(ctx(s, T + 10));
    expect(s.get("overrides", { id: ov.id })?.cleared_at).toBe(T + 5);
    expect(events(s, "override_cleared")).toHaveLength(1);
    expect(s.get("picks", { member: m.id })).toBeNull();   // a finished Builder reads archived: no start, no pick (U152)
  });

  test.each(["planned", "done"])("nonempty worktree fallback finds the unit when no slug matches (%s)", (status) => {
    const s = fixture();
    unit(s, "other", "done", "");
    unit(s, "legacy", status, "wt-own");
    const { m, ov } = overridden(s, { wt: "wt-own" });
    if (status === "planned") retained(s, m, ov);
    else {
      expect(workDone(s, m)).toBe(true);
      expect(overrideOf(s, m)).toBeNull();
      reconcile(ctx(s));
      expect(s.get("overrides", { id: ov.id })?.cleared_at).toBe(T);
      expect(events(s, "override_cleared")).toHaveLength(1);
    }
  });

  test.each(["planned", "done"])("exact slug wins conflicting worktree evidence (%s)", (status) => {
    const s = fixture();
    unit(s, "other", status === "planned" ? "done" : "planned", "wt-conflict");
    unit(s, "own", status);
    const { m, ov } = overridden(s, { wt: "wt-conflict" });
    if (status === "planned") retained(s, m, ov);
    else {
      expect(workDone(s, m)).toBe(true);
      reconcile(ctx(s));
      expect(s.get("overrides", { id: ov.id })?.cleared_at).toBe(T);
      expect(events(s, "override_cleared")).toHaveLength(1);
    }
  });

  test("a standing Lead is not finished by another unit, even with matching suffix or worktree", () => {
    const s = fixture();
    unit(s, "other", "done", "");
    unit(s, "own", "done", "wt-lead");
    for (const wt of [null, "", "wt-lead"]) {
      const { m, ov } = overridden(s, { role: "lead", wt, suffix: wt ? "own" : "" });
      retained(s, m, ov);
    }
  });

  test.each([{ status: "gone" }, { status: "closed" }, { want: "gone" }])("real retirement still clears an override once (%p)", (retirement) => {
    const s = fixture();
    unit(s, "own", "planned");
    const { m, ov } = overridden(s, { role: "lead", ...retirement });
    expect(workDone(s, m)).toBe(true);
    expect(overrideOf(s, m)).toBeNull();
    reconcile(ctx(s));
    reconcile(ctx(s, T + 5));
    expect(s.get("overrides", { id: ov.id })?.cleared_at).toBe(T);
    expect(events(s, "override_cleared")).toHaveLength(1);
  });
});

describe("pick reconciler", () => {
  test("host-wide start budget: four picks hold a slot, the rest queue; load is reserved in order", () => {
    const s = fixture();
    const ids = [...Array(6)].map((_, i) => wanted(s, { project: i < 3 ? "fx" : "fy", want_at: T + i }));
    const up = wanted(s, { want_at: T, status: "running", wt: "wt-up" });               // its agent runs: not pending
    s.upsert("observed_workers", { project: "fx", wt: "wt-up" }, { presence: "running", observed_at: T });
    void up;
    reconcile(ctx(s));
    const ps = picks(s);
    expect(ps.map((p) => p.member)).toEqual(ids);
    expect(ps.map((p) => p.slot)).toEqual([1, 1, 1, 1, 0, 0]);
    expect(ps.map((p) => p.account)).toEqual(["acct-a", "acct-a", "acct-b", "acct-b", null, null]);
    expect(String(ps[4].reason)).toContain("queued: 4 of 4");
    expect(slotBudget(s)).toEqual({ max: 4, used: 4, free: 0 });
    // Two start: they leave the pending set and their slots go to the queue.
    s.db.run("UPDATE members SET status = 'running', placed_at = ?, agent = 'claude', account = 'acct-a' WHERE id IN (?, ?)", [T + 1, ids[0], ids[1]]);
    reconcile(ctx(s, T + 5));
    expect(picks(s).map((p) => [p.member, p.slot])).toEqual([[ids[2], 1], [ids[3], 1], [ids[4], 1], [ids[5], 1]]);
  });

  test("U270: starts waiting out a retry give up their slots; a fifth wanted member gets one", () => {
    const s = fixture();
    const ids = [...Array(5)].map((_, i) => wanted(s, { project: i < 3 ? "fx" : "fy", want_at: T + i }));
    // The first four failed to start; their retries are 15 minutes away (the transient refusal path).
    for (const id of ids.slice(0, 4)) s.db.run("INSERT INTO episodes (project, subject, kind, state, next_at, source, observed_at) VALUES ('fx', ?, 'action:member', 'pending', ?, 'loop', ?)", [`member:${id}`, T + 900, T - 10]);
    reconcile(ctx(s));
    const ps = picks(s);
    expect(ps.map((p) => [p.member, p.slot])).toEqual([[ids[0], 0], [ids[1], 0], [ids[2], 0], [ids[3], 0], [ids[4], 1]]);
    expect(ps.slice(0, 4).map((p) => String(p.reason))).toEqual(Array(4).fill(`waiting: start retry at ${new Date((T + 900) * 1000).toISOString().slice(0, 19)}Z`));
    expect(ps[4].account).not.toBeNull();
    expect(slotBudget(s)).toEqual({ max: 4, used: 1, free: 3 });
    // A retry a minute or less away keeps its slot, and so does one that is due.
    s.db.run("UPDATE episodes SET next_at = ? WHERE subject = ?", [T + 5 + 60, `member:${ids[0]}`]);
    s.db.run("UPDATE episodes SET next_at = ? WHERE subject = ?", [T + 5, `member:${ids[1]}`]);
    reconcile(ctx(s, T + 5));
    expect(picks(s).map((p) => [p.member, p.slot])).toEqual([[ids[0], 1], [ids[1], 1], [ids[2], 0], [ids[3], 0], [ids[4], 1]]);
  });

  test("one pick event per (project, role) per tick, and none while nothing changed", () => {
    const s = fixture();
    wanted(s); wanted(s); wanted(s, { role: "reviewer", tier: null }); wanted(s, { project: "fy" });
    reconcile(ctx(s));
    const ev = events(s);
    expect(ev.map((e) => `${e.project}/${JSON.parse(String(e.payload)).role}`).sort()).toEqual(["fx/builder", "fx/reviewer", "fy/builder"]);
    const fx = JSON.parse(String(ev.find((e) => e.project === "fx" && JSON.parse(String(e.payload)).role === "builder")!.payload));
    expect([fx.tier, fx.account, fx.model, fx.picks.length]).toEqual(["hard", "acct-a", "opus", 2]);
    expect(fx.reason).toContain("acct-a");
    reconcile(ctx(s, T + 5));
    expect(events(s).length).toBe(3);
    acct(s, "acct-a", { limited_until: String(T + 3600) });
    reconcile(ctx(s, T + 10));
    expect(events(s).length).toBe(5); // both builder groups moved off acct-a; the reviewer did not
  });

  test("no room writes one pick event and keeps the wait, with no known reset (U1)", () => {
    const s = fixture();
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "claude:sonnet";
    process.env.DS_PICK_WAIT_S = "600";
    for (const a of ["acct-a", "acct-b", "acct-c"]) acct(s, a, { weekly_pct: "99", weekly_reset: null });
    wanted(s);
    reconcile(ctx(s));
    reconcile(ctx(s, T + 5));
    reconcile(ctx(s, T + 10));
    expect(events(s).length).toBe(1);   // the moving fallback wait is not part of the pick's signature
    expect(picks(s)[0]).toMatchObject({ reason: "no account free", wait_until: T + 10 + 600, wait_known: 0, slot: 0 });
  });

  test("an account wait keeps its known reset; an unchanged wait fires no new event (U1)", () => {
    const s = fixture();
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "claude:sonnet";
    for (const a of ["acct-a", "acct-b", "acct-c"]) acct(s, a, { weekly_pct: "99", weekly_reset: String(T + 7200) });
    wanted(s);
    reconcile(ctx(s));
    reconcile(ctx(s, T + 5));
    expect(events(s).length).toBe(1);
    expect(picks(s)[0]).toMatchObject({ reason: "no account free", wait_until: T + 7200, wait_known: 1, slot: 0 });
  });

  test("a member below the floor stays idle without a slot, shows its reset, and is placed when it passes", () => {
    const s = fixture();
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "claude:opus";
    process.env.DS_LOOP_START_SLOTS = "1";
    for (const a of ["acct-a", "acct-b", "acct-c"]) acct(s, a, { weekly_pct: "99" });
    const a = wanted(s), b = wanted(s, { role: "reviewer", tier: null });
    acct(s, "acct-c", { weekly_pct: "10" });
    acct(s, "acct-c", { limited_until: String(T + 300) });
    reconcile(ctx(s));
    expect(picks(s).map((p) => [p.member, p.slot, p.wait_until])).toEqual([[a, 0, T + 300], [b, 0, T + 300]]);   // U1: kept for the board
    reconcile(ctx(s, T + 301));
    expect(picks(s).map((p) => [p.member, p.slot, p.account])).toEqual([[a, 1, "acct-c"], [b, 0, null]]);
  });
});

describe("ds pick", () => {
  function ds(root: string, ...args: string[]) {
    const p = Bun.spawnSync([DS, "--state", root, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DS_NOW: String(T) } });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
  }
  test("prints the tuple, or WAIT <epoch> with exit 3, and records a pick event", () => {
    const s = fixture();
    for (const a of ["acct-a", "acct-b", "acct-c"]) acct(s, a, { weekly_pct: "99" });
    acct(s, "acct-b", { weekly_pct: "50" });
    expect(ds(s.root, "pick", "fx", "builder", "--tier", "standard")).toMatchObject({ code: 0, out: "claude\tsonnet\t-\tacct-b\t0" });
    acct(s, "acct-b", { weekly_pct: "99" });
    const r = ds(s.root, "pick", "fx", "builder", "--tier", "hard", "--phase", "build", "--limited", "claude:acct-b=1800000600");
    expect(r).toMatchObject({ code: 0, out: "muse\tmuse-spark-1.3\t-\t-\t1" });
    s.upsert("config", { project: "fx", file: "limits.conf", key: "pick_floor_builder" }, { value: "claude:sonnet", observed_at: T });
    expect(ds(s.root, "pick", "fx", "builder", "--tier", "hard")).toMatchObject({ code: 3, out: "WAIT 1800086400" });
    expect(events(s).map((e) => JSON.parse(String(e.payload)).source)).toEqual(["ds pick", "ds pick", "ds pick"]);
    expect(ds(s.root, "pick", "fx").code).toBe(2);
  });
  test("ported from the retired shell picker: a malformed --limited, a role with no roster row, and an explicit --effort", () => {
    const s = fixture();
    expect(ds(s.root, "pick", "fx", "builder", "--limited", "a").code).toBe(2);
    const none = ds(s.root, "pick", "fx", "nosuchrole");
    expect(none.code).toBe(1);
    expect(none.err).toContain("nosuchrole");
    expect(ds(s.root, "pick", "fx", "builder", "--model", "sonnet", "--effort", "high").out.split("\t").slice(0, 3)).toEqual(["claude", "sonnet", "high"]);
  });
  test("U92 through the CLI: a hard Builder in babysit takes the builder-hard-babysit row, in build the builder row", () => {
    const s = fixture();
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value: "claude opus ondemand - claude:sonnet", observed_at: T });
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder-hard-babysit" }, { value: "claude sonnet ondemand - claude:opus", observed_at: T });
    expect(ds(s.root, "pick", "fx", "builder", "--tier", "hard", "--phase", "babysit").out.split("\t").slice(0, 2)).toEqual(["claude", "sonnet"]);
    expect(ds(s.root, "pick", "fx", "builder", "--tier", "hard", "--phase", "build").out.split("\t").slice(0, 2)).toEqual(["claude", "opus"]);
    expect(ds(s.root, "pick", "fx", "builder", "--tier", "hard").out.split("\t").slice(0, 2)).toEqual(["claude", "opus"]);
    const rows = events(s).map((e) => JSON.parse(String(e.payload)));
    expect(rows.map((r) => r.phase)).toEqual(["babysit", "build", "build"]);
  });
});

describe("U145: max_builders", () => {
  const at = { observed_at: T, updated_at: T };
  const squad = (s: Store, topic = "demo") => s.upsert("squads", { project: "fx", topic }, { status: "running", ...at });
  const unit = (s: Store, slug: string, status = "planned", sq = "demo") => s.upsert("units", { project: "fx", squad: sq, slug }, { status, ...at });
  const max = (s: Store, n: number | string) => s.upsert("config", { project: "fx", file: "limits.conf", key: "max_builders" }, { value: String(n), observed_at: T });
  // A Builder whose agent runs: an observed worker that is working, on a dispatched unit.
  function live(s: Store, suffix: string): number {
    squad(s); unit(s, suffix, "dispatched");
    const id = member(s, { suffix, status: "running", wt: `wt-${suffix}` });
    s.upsert("observed_workers", { project: "fx", wt: `wt-${suffix}` }, { state: "working", presence: "running", observed_at: T });
    return id;
  }
  // A Builder that asks to start: an open start wish, no agent yet.
  function asks(s: Store, suffix: string, status = "planned"): number {
    squad(s); unit(s, suffix, status);
    return wanted(s, { suffix });
  }
  const waits = (p: unknown) => p as Waiting;

  test("no limit (the default -): a Builder picks as before", () => {
    const s = fixture();
    for (const u of ["a", "b", "c"]) live(s, u);
    expect(ok(builder(s, { member: asks(s, "d"), squad: "demo" })).account).toBeTruthy();
  });

  test("at the limit a new Builder waits with WAIT slot and no reset; a live Builder's restart pick goes ahead", () => {
    const s = fixture();
    max(s, 2);
    const a = live(s, "a"); live(s, "b");
    const p = waits(builder(s, { member: asks(s, "c"), squad: "demo" }));
    expect(p).toMatchObject({ why: "slot", known: false, wait: T, reason: "WAIT slot: fx at max_builders 2", slot: { limit: 2, live: 2, ahead: 0 } });
    // A start with no member row yet names its unit by squad + suffix.
    unit(s, "d");
    expect(waits(builder(s, { squad: "demo", suffix: "d" })).why).toBe("slot");
    ok(builder(s, { member: a, squad: "demo" }));
    // Leads and Thinkers are never limited.
    for (const role of ["lead", "thinker"]) expect(pick(s, { project: "fx", role, phase: "build" }, T)).not.toHaveProperty("wait");
  });

  test("oldest first: a dispatched unit before a planned one, then the lower unit id", () => {
    const s = fixture();
    max(s, 3);
    live(s, "a"); live(s, "b");                       // one slot free
    const p1 = asks(s, "p1"), p2 = asks(s, "p2"), d = asks(s, "d", "dispatched");
    expect(ok(builder(s, { member: d, squad: "demo" }))).toBeTruthy();
    expect(waits(builder(s, { member: p1, squad: "demo" })).slot).toMatchObject({ live: 2, ahead: 1 });
    // The dispatched one starts (and so counts live): the planned ones are next, the lower unit id first.
    s.upsert("observed_workers", { project: "fx", wt: "wt-d" }, { state: "working", presence: "running", observed_at: T });
    s.db.run("UPDATE members SET wt = 'wt-d', status = 'running', want_result = 'done' WHERE id = ?", [d]);
    max(s, 4);
    ok(builder(s, { member: p1, squad: "demo" }));
    expect(waits(builder(s, { member: p2, squad: "demo" })).slot).toMatchObject({ live: 3, ahead: 1 });
  });

  test("an older resume pause-resume holds back (its retained worktree missing) keeps no place in line", () => {
    const s = fixture();
    max(s, 1);
    squad(s); unit(s, "old", "dispatched");
    member(s, { suffix: "old", status: "running", wt: "wt-old" });
    s.upsert("observed_workers", { project: "fx", wt: "wt-old" }, { state: "idle", presence: "none", observed_at: T });
    s.upsert("observed_worktrees", { project: "fx", wt: "wt-old" }, { path: join(s.root, "no-such-tree"), doc: JSON.stringify({ agents: 0 }), observed_at: T });
    s.upsert("pause_members", { project: "fx", squad: "demo", role: "builder", suffix: "old" }, { state: "resuming", generation: "g1", requested_at: T, reason: "retained worktree missing" });
    const young = asks(s, "young");
    ok(builder(s, { member: young, squad: "demo" }));
    // The worktree is back: the older resume can go ahead, so it is first in line again.
    mkdirSync(join(s.root, "no-such-tree"));
    expect(waits(builder(s, { member: young, squad: "demo" })).slot).toMatchObject({ live: 0, ahead: 1 });
    // Its open resume wish counts the same way: a worktree gone again frees the line.
    s.db.run("UPDATE members SET want = 'running', want_at = ?, want_result = NULL, want_payload = ? WHERE suffix = 'old'", [T, JSON.stringify({ pauseResume: "g1" })]);
    expect(waits(builder(s, { member: young, squad: "demo" })).slot).toMatchObject({ ahead: 1 });
    rmSync(join(s.root, "no-such-tree"), { recursive: true });
    ok(builder(s, { member: young, squad: "demo" }));
    // A given-up resume (failed; it waits on the operator's retry) keeps no place either.
    mkdirSync(join(s.root, "no-such-tree"));
    s.db.run("UPDATE members SET want_result = 'failed: start refused' WHERE suffix = 'old'");
    ok(builder(s, { member: young, squad: "demo" }));
  });

  test("a paused Builder whose worker reads idle with no agent does not count as live", () => {
    const s = fixture();
    max(s, 1);
    squad(s); unit(s, "a", "dispatched");
    member(s, { suffix: "a", status: "running", wt: "wt-a" });
    s.upsert("observed_workers", { project: "fx", wt: "wt-a" }, { state: "idle", presence: "none", observed_at: T });
    s.upsert("observed_worktrees", { project: "fx", wt: "wt-a" }, { doc: JSON.stringify({ agents: 0 }), observed_at: T });
    const b = asks(s, "b");
    ok(builder(s, { member: b, squad: "demo" }));
    // With its agent process back it is live again, and the slot is taken.
    s.upsert("observed_workers", { project: "fx", wt: "wt-a" }, { presence: "running", observed_at: T });
    expect(waits(builder(s, { member: b, squad: "demo" })).why).toBe("slot");
  });

  test("DS_LIMIT_MAX_BUILDERS overrides limits.conf, and slot() says why", () => {
    const s = fixture();
    max(s, 1);
    live(s, "a");
    const b = asks(s, "b");
    expect(slot(s, "fx", { member: s.get("members", { id: b }) }, T)).toMatchObject({ ok: false, live: 1, why: "WAIT slot: fx at max_builders 1" });
    process.env.DS_LIMIT_MAX_BUILDERS = "2";
    expect(slot(s, "fx", { member: s.get("members", { id: b }) }, T)).toEqual({ ok: true, limit: 2 });
  });

  test("the reconciler holds no start slot and stores the WAIT slot reason with no wait_until", () => {
    const s = fixture();
    max(s, 1);
    live(s, "a");
    const b = asks(s, "b");
    reconcile(ctx(s));
    expect(s.get("picks", { member: b })).toMatchObject({ slot: 0, wait_until: null, reason: "WAIT slot: fx at max_builders 1" });
    expect(slotBudget(s).used).toBe(0);
  });

  test("ds pick prints WAIT slot: … with exit 3 for --squad/--suffix", () => {
    const s = fixture();
    max(s, 1);
    live(s, "a");
    unit(s, "b");
    const p = Bun.spawnSync([DS, "--state", s.root, "pick", "fx", "builder", "--tier", "hard", "--squad", "demo", "--suffix", "b"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DS_NOW: String(T) } });
    expect({ code: p.exitCode, out: p.stdout.toString().trim() }).toEqual({ code: 3, out: "WAIT slot: fx at max_builders 1" });
  });

  test("Builders with no unit row never tie: the lower member id goes first", () => {
    const s = fixture();
    max(s, 1); squad(s);
    const x = wanted(s, { suffix: "x" }), y = wanted(s, { suffix: "y" });
    ok(builder(s, { member: x, squad: "demo" }));
    expect(waits(builder(s, { member: y, squad: "demo" })).slot).toMatchObject({ live: 0, ahead: 1 });
  });

  test("a Builder being paused keeps its place until its agent is seen gone", () => {
    const s = fixture();
    max(s, 1);
    live(s, "a");
    s.pause({ scope: "member", project: "fx", squad: "demo", role: "builder", suffix: "a" });
    const b = asks(s, "b");
    expect(waits(builder(s, { member: b, squad: "demo" })).slot).toMatchObject({ live: 1 });
    s.upsert("observed_workers", { project: "fx", wt: "wt-a" }, { state: "idle", presence: "none", observed_at: T });
    s.upsert("observed_worktrees", { project: "fx", wt: "wt-a" }, { doc: JSON.stringify({ agents: 0 }), observed_at: T });
    ok(builder(s, { member: b, squad: "demo" }));
  });

  test("a start in the spawn grace counts live, until it parks (waiting)", () => {
    const s = fixture();
    max(s, 1); squad(s); unit(s, "a", "dispatched");
    const a = member(s, { suffix: "a", status: "starting", wt: "wt-a", started: new Date((T - 60) * 1000).toISOString() });
    const b = asks(s, "b");
    expect(waits(builder(s, { member: b, squad: "demo" })).slot).toMatchObject({ live: 1 });
    s.db.run("UPDATE members SET status = 'waiting' WHERE id = ?", [a]);
    ok(builder(s, { member: b, squad: "demo" }));
  });

  test("a ds pick Builder slot holds its place for the spawn grace: a second shell start waits", () => {
    const s = fixture();
    max(s, 1); squad(s); unit(s, "b"); unit(s, "c");
    const run = (suffix: string, at = T) => {
      const p = Bun.spawnSync([DS, "--state", s.root, "pick", "fx", "builder", "--tier", "hard", "--squad", "demo", "--suffix", suffix], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DS_NOW: String(at) } });
      return { code: p.exitCode, out: p.stdout.toString().trim() };
    };
    expect(run("b").code).toBe(0);
    expect(run("c")).toEqual({ code: 3, out: "WAIT slot: fx at max_builders 1" });
    expect(run("b").code).toBe(0);                    // its own repick goes ahead
    expect(run("c", T + 6 * 60).code).toBe(0);        // past the grace the hold lapses
  });
});

describe("U204: no avoid mark, and a kept pick", () => {
  test("keep: the earlier pick's account wins on its own rung while it has room; without room, the next account", () => {
    const s = fixture();
    expect(ok(builder(s)).account).toBe("acct-a");
    const keep = { agent: "claude", model: "opus", account: "acct-b" };
    expect(ok(builder(s, { keep })).account).toBe("acct-b");
    acct(s, "acct-b", { session_pct: "95" });
    expect(ok(builder(s, { keep })).account).toBe("acct-a");
  });
});


// U124: account plans distinguish otherwise identical pipeline steps.
describe("plan steps", () => {
  const plans = (s: Store, value = "claude opus ondemand - claude:opus:-:Ultra Max") => {
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value, observed_at: T });
    acct(s, "acct-a", { plan: "Max", session_pct: "0" });
    acct(s, "acct-b", { plan: "Ultra", session_pct: "0" });
    acct(s, "acct-c", { plan: null, session_pct: "0" });
  };
  test("a named step filters before fill-first; a full step falls to the same model on another plan", () => {
    const s = fixture(); plans(s);
    expect(ok(builder(s)).account).toBe("acct-a");
    expect(ok(builder(s)).reason).toContain("claude:opus:Max");
    acct(s, "acct-a", { session_pct: "95" });
    const p = ok(builder(s));
    expect([p.account, p.rung, p.plan]).toEqual(["acct-b", 2, "Ultra"]);
  });
  test("unknown plans match only Any; missing named plans cannot use the default login", () => {
    const s = fixture(); plans(s, "claude opus ondemand - claude:opus Missing");
    expect(ok(builder(s)).account).toBe("acct-a");
    acct(s, "acct-a", { session_pct: "95" }); acct(s, "acct-b", { session_pct: "95" });
    expect(ok(builder(s)).account).toBe("acct-c"); // only the unknown-plan account can take Any
    plans(s, "newagent opus ondemand - - Missing");
    expect(builder(s)).toHaveProperty("wait");
  });
  test("a plan-qualified floor reaches the second identical model; old floors keep their first match", () => {
    const s = fixture(); plans(s); acct(s, "acct-a", { session_pct: "95" });
    s.upsert("config", { project: "fx", file: "limits.conf", key: "pick_floor_builder" }, { value: "claude:opus:Ultra", observed_at: T });
    expect(ok(builder(s)).rung).toBe(2);
    s.upsert("config", { project: "fx", file: "limits.conf", key: "pick_floor_builder" }, { value: "claude:opus", observed_at: T });
    expect(builder(s)).toHaveProperty("wait");
  });
  test("a kept Ultra account cannot win the Max step; plan changes invalidate a kept step", () => {
    const s = fixture(); plans(s);
    expect(ok(builder(s, { keep: { agent: "claude", model: "opus", account: "acct-b", plan: "Ultra" } })).account).toBe("acct-a");
    acct(s, "acct-a", { session_pct: "95" });
    expect(ok(builder(s, { keep: { agent: "claude", model: "opus", account: "acct-b", plan: "Ultra" } })).rung).toBe(2);
  });
  test("Any retains fill-first across Max and Ultra and scales actual destination load", () => {
    const s = fixture(); plans(s, "claude opus ondemand - -");
    // Both known plans are eligible; the account resetting soonest still fills first.
    expect(ok(builder(s))).toMatchObject({ account: "acct-a", plan: null, rung: 1 });
    acct(s, "acct-a", { session_pct: "16" }); // hard load: Max 80 versus Ultra 20
    expect(ok(builder(s))).toMatchObject({ account: "acct-b", plan: null, rung: 1 });
    s.upsert("config", { project: "fx", file: "limits.conf", key: "pick_load_scale_claude_Max" }, { value: "1", observed_at: T });
    expect(ok(builder(s)).account).toBe("acct-a");
  });
  test("plan load scales new, reserved and recently placed work; unlisted plans stay at one", () => {
    const s = fixture(); plans(s);
    acct(s, "acct-a", { session_pct: "16" }); // 16 + hard 20 * 4 >= 95
    expect(ok(builder(s)).account).toBe("acct-b");
    acct(s, "acct-a", { session_pct: "0" });
    running(s, "acct-a", "standard"); // 40 reserved + 80 new >= 95
    expect(ok(builder(s)).account).toBe("acct-b");
    s.upsert("config", { project: "fx", file: "limits.conf", key: "pick_load_scale_claude_Max" }, { value: "1", observed_at: T });
    expect(ok(builder(s)).account).toBe("acct-a");
    const t = fixture(); plans(t); const id = wanted(t, { suffix: "reserved", tier: "standard" });
    t.upsert("picks", { member: id }, { project: "fx", role: "builder", agent: "claude", account: "acct-a", tier: "standard", slot: 1, picked_at: T });
    expect(ok(builder(t)).account).toBe("acct-b");
  });
});

describe("U180: per-role load and fallback reservations", () => {
  const maxPlans = (s: Store) => {
    acct(s, "acct-a", { plan: "Max", session_pct: "0", session_reset: String(T + 3600) });
    acct(s, "acct-b", { plan: "Max", session_pct: "0", session_reset: String(T + 7200) });
    acct(s, "acct-c", { plan: "Max", session_pct: "0", session_reset: String(T + 10800) });
  };
  const lim = (s: Store, key: string, value: string) => s.upsert("config", { project: "fx", file: "limits.conf", key }, { value, observed_at: T });
  const reserve = (s: Store, id: number, account: string, at = T - 30) =>
    s.upsert("episodes", { project: "fx", subject: `member:${id}`, kind: "fallback-reserve" },
      { squad: "demo", episode_key: JSON.stringify({ agent: "claude", model: "opus", account }), started_at: at, ended_at: at + 600, state: "reserved", source: "loop", observed_at: at });

  test("a Lead on Max with pick_load_lead 5 and scale 4 counts 20%; a hard Builder still counts 80%", () => {
    const s = fixture(); maxPlans(s); lim(s, "pick_load_lead", "5");
    expect(ok(pick(s, { project: "fx", role: "lead", phase: "build" }, T)).reason).toContain("acct-a resets soonest (1800003600) with room: 0% + 20% < 95%");
    expect(ok(builder(s)).reason).toContain("0% + 80% < 95%");
    // A Lead placed a minute ago weighs its role's load on the next pick, not its tier's.
    member(s, { status: "running", role: "lead", agent: "claude", model: "sonnet", account: "acct-a", placed_at: T - 60, wt: "wt-lead" });
    acct(s, "acct-a", { session_pct: "50" });
    const lead = () => ok(pick(s, { project: "fx", role: "lead", phase: "build" }, T)).account;
    expect(lead()).toBe("acct-a");   // 50% + placed Lead 20% + new Lead 20% < 95%
    s.db.run("UPDATE members SET role = 'builder', tier = 'standard' WHERE wt = 'wt-lead'");
    expect(lead()).toBe("acct-b");   // the same member as a standard Builder: 50% + 40% + 20% >= 95%
  });

  test("the defaults: a Thinker counts pick_load_thinker 1 x the Max scale", () => {
    const s = fixture(); maxPlans(s);
    expect(ok(pick(s, { project: "fx", role: "thinker", phase: "build" }, T)).reason).toContain("0% + 4% < 95%");
  });

  test("another member's reservation is load on the account it aims for until it is placed or expires", () => {
    const s = fixture(); maxPlans(s); lim(s, "pick_load_thinker", "20");   // 80% on Max
    const away = member(s, { status: "running", role: "thinker", squad: "other", agent: "codex", model: "gpt", account: "-", want: "running", placed_at: T - 3600, wt: "wt-away" });
    reserve(s, away, "acct-a");
    expect(ok(pick(s, { project: "fx", role: "thinker", phase: "build" }, T)).account).toBe("acct-b");
    // Its own pick does not count its own reservation.
    expect(ok(pick(s, { project: "fx", role: "thinker", phase: "build", squad: "other", member: away }, T)).account).toBe("acct-a");
    expect(ok(pick(s, { project: "fx", role: "thinker", phase: "build" }, T + 600)).account).toBe("acct-a");   // pick_ttl_s passed
    s.db.run("UPDATE members SET placed_at = ? WHERE id = ?", [T, away]);
    expect(ok(pick(s, { project: "fx", role: "thinker", phase: "build" }, T)).account).toBe("acct-a");        // placed: its own row counts (on codex)
  });

  test("a fallback-reserved member gets the reserved rung and account while it fits", () => {
    const s = fixture(); maxPlans(s);
    const id = wanted(s, { role: "thinker", tier: null, suffix: "" });
    reserve(s, id, "acct-b");   // fill-first alone would pick acct-a
    reconcile(ctx(s));
    expect(picks(s).map((p) => [p.member, p.account, p.slot])).toEqual([[id, "acct-b", 1]]);
    acct(s, "acct-b", { session_pct: "94" });   // no longer fits: the ladder's own choice
    reconcile(ctx(s, T + 1));
    expect(picks(s)[0].account).toBe("acct-a");
  });
});

describe("U2: an account out of credits", () => {
  function museFirst(s: Store, fallback = " claude:opus:high") {
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value: `muse muse-spark-1.3 ondemand max${fallback}`, observed_at: T });
    s.upsert("observed_accounts", { agent: "muse", account: "default" }, { session_pct: "-", weekly_pct: "-", observed_at: T });
    holdCredits(s, { agent: "muse", account: "default", until: T + 86400, from: "screen" }, T - 60);
  }
  test("leaves every rung until the operator clears it, then Muse is picked again", () => {
    const s = fixture();
    museFirst(s);
    const p = ok(builder(s));
    expect(p).toMatchObject({ agent: "claude", model: "opus", effort: "high", fallback: true });
    expect(p.why).toContain("default out of credits");
    // A day's hold outlasts the one-hour limit guess: still out an hour on.
    expect(ok(pick(s, { project: "fx", role: "builder", tier: "hard", phase: "build" }, T + 3600)).agent).toBe("claude");
    expect(setAccountEnabled(s, { agent: "muse", account: "default", enabled: true, by: "test" }, T)).toMatchObject({ cleared: true });
    expect(ok(builder(s))).toMatchObject({ agent: "muse", model: "muse-spark-1.3", effort: "max", fallback: false });
  });
  test("a ladder with no other rung waits and names the account out of credits", () => {
    const s = fixture();
    museFirst(s, " -");
    const w = builder(s) as Waiting;
    expect(w.wait).toBe(T + 86400);
    expect(w.reason).toContain("muse:default out of credits");
  });
});

// claude-login-ended U2: a login hold (login.ts) blocks like credits, and the pick names it `login ended`.
describe("claude-login-ended U2: an account whose login ended", () => {
  function museFirst(s: Store, fallback = " claude:opus:high") {
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value: `muse muse-spark-1.3 ondemand max${fallback}`, observed_at: T });
    s.upsert("observed_accounts", { agent: "muse", account: "default" }, { session_pct: "-", weekly_pct: "-", observed_at: T });
    holdLogin(s, { agent: "muse", account: "default", from: "probe" }, T - 60);
  }
  test("leaves the account out with block `login` until the operator clears it", () => {
    const s = fixture();
    museFirst(s);
    expect(accountBlock(s, "muse", "default", T)).toBe("login");
    const p = ok(builder(s));
    expect(p).toMatchObject({ agent: "claude", fallback: true });
    expect(p.why).toContain("default login ended");
    expect(setAccountEnabled(s, { agent: "muse", account: "default", enabled: true, by: "test" }, T)).toMatchObject({ cleared: true });
    expect(ok(builder(s))).toMatchObject({ agent: "muse", fallback: false });
  });
  test("a ladder with no other rung waits until the hold's end and names it", () => {
    const s = fixture();
    museFirst(s, " -");
    const w = builder(s) as Waiting;
    expect(w.wait).toBe(T - 60 + 3600);
    expect(w.reason).toContain("muse:default login ended");
  });
});

// U24: an override's scope: member, squad, role, project (overrides.member holds the target).
describe("override scopes", () => {
  const ov = (s: Store, scope: string, member: string, set: Row = {}) => {
    const ks = Object.keys(set);
    return Number(s.db.run(`INSERT INTO overrides (member, scope, set_by, set_at${ks.map((k) => `, ${k}`).join("")}) VALUES (?, ?, 'board', ?${ks.map(() => ", ?").join("")})`,
      [member, scope, T, ...ks.map((k) => set[k] as string)]).lastInsertRowid);
  };
  const squadRow = (s: Store, topic: string, status = "running") => s.upsert("squads", { project: "fx", topic }, { status, observed_at: T, updated_at: T });
  const target = { squad: "fx/demo", role: "fx/builder", project: "fx" } as Record<string, string>;
  const mem = (s: Store) => { const id = wanted(s, { suffix: "own" }); return { id, m: s.get("members", { id })! }; };

  test.each(["squad", "role", "project"])("a %s override alone applies to a member in its scope and names the scope", (scope) => {
    const s = fixture();
    const { id, m } = mem(s);
    const o = ov(s, scope, target[scope], { model: "sonnet", account: "acct-c" });
    expect(overrideOf(s, m)).toMatchObject({ id: o, scope, target: target[scope], model: "sonnet" });
    const p = ok(builder(s, { member: id }));
    expect([p.model, p.account, p.why]).toEqual(["sonnet", "acct-c", "override"]);
    expect(p.reason).toContain(`override #${o} (pinned for ${scope} ${scope === "squad" ? "demo" : scope === "role" ? "builder" : "fx"})`);
  });

  test.each([
    ["squad", "fx/other", "builder"],
    ["role", "fx/reviewer", "builder"],
    ["project", "fy", "builder"],
  ])("a %s override on %s does not reach this member", (scope, tgt) => {
    const s = fixture();
    const { id, m } = mem(s);
    ov(s, scope, tgt, { model: "sonnet" });
    expect(overrideOf(s, m)).toBeNull();
    expect(ok(builder(s, { member: id })).model).toBe("opus");
  });

  test("the narrowest wins: member, then squad, then role, then project", () => {
    const s = fixture();
    const { id, m } = mem(s);
    ov(s, "project", "fx", { model: "haiku" });
    expect(overrideOf(s, m)?.model).toBe("haiku");
    ov(s, "role", "fx/builder", { model: "fable" });
    expect(overrideOf(s, m)?.model).toBe("fable");
    const sq = ov(s, "squad", "fx/demo", { model: "sonnet" });
    expect(overrideOf(s, m)?.model).toBe("sonnet");
    expect(ok(builder(s, { member: id })).reason).toContain("pinned for squad demo");
    ov(s, "member", String(id), { model: "opus" });
    expect(overrideOf(s, m)).toMatchObject({ model: "opus", scope: "member", scopes: ["member"] });
    expect(sq).toBeGreaterThan(0);
  });

  test("a field the narrower override does not set comes from a broader one", () => {
    const s = fixture();
    const { id, m } = mem(s);
    ov(s, "project", "fx", { model: "sonnet", effort: "low", account: "acct-c" });
    ov(s, "squad", "fx/demo", { effort: "high" });
    const o = overrideOf(s, m)!;
    expect([o.model, o.effort, o.account, o.scope, o.scopes]).toEqual(["sonnet", "high", "acct-c", "squad", ["squad", "project"]]);
    const p = ok(builder(s, { member: id }));
    expect([p.model, p.effort, p.account]).toEqual(["sonnet", "high", "acct-c"]);
    // an account and a plan are one choice: the narrowest that sets either wins, the other is left out
    ov(s, "member", String(id), { plan: "Max" });
    expect([overrideOf(s, m)?.account, overrideOf(s, m)?.plan]).toEqual([null, "Max"]);
  });

  test("work done clears the member override and keeps the squad one on the same member", () => {
    const s = fixture();
    s.db.run("INSERT INTO units (project, squad, slug, status, tier, observed_at, updated_at) VALUES ('fx', 'demo', 'own', 'dispatched', 'hard', ?, ?)", [T, T]);
    squadRow(s, "demo");
    const { id } = mem(s);
    const mo = ov(s, "member", String(id), { model: "fable" });
    const so = ov(s, "squad", "fx/demo", { model: "sonnet" });
    const ro = ov(s, "role", "fx/builder", { model: "fable" });
    reconcile(ctx(s));
    expect(s.get("overrides", { id: mo })?.cleared_at).toBeNull();
    s.db.run("UPDATE units SET status = 'done'");
    reconcile(ctx(s, T + 5));
    expect(s.get("overrides", { id: mo })?.cleared_at).toBe(T + 5);
    for (const o of [so, ro]) expect(s.get("overrides", { id: o })?.cleared_at).toBeNull();
  });

  test("a squad override clears when its squad closes; role and project ones stay", () => {
    const s = fixture();
    squadRow(s, "demo");
    const so = ov(s, "squad", "fx/demo", { model: "sonnet" }), ro = ov(s, "role", "fx/builder", { model: "sonnet" }), po = ov(s, "project", "fx", { model: "sonnet" });
    reconcile(ctx(s));
    expect(s.get("overrides", { id: so })?.cleared_at).toBeNull();
    squadRow(s, "demo", "closed");
    reconcile(ctx(s, T + 7));
    expect(s.get("overrides", { id: so })?.cleared_at).toBe(T + 7);
    expect(events(s, "override_cleared").map((e) => JSON.parse(String(e.payload)))).toEqual([{ override: so, reason: "squad closed" }]);
    for (const o of [ro, po]) expect(s.get("overrides", { id: o })?.cleared_at).toBeNull();
  });
});
