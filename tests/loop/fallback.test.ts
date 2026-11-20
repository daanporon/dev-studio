// fallback.test.ts — U66/U154: a Thinker on a fallback rung moves back up when a higher rung has
// room. U154 routes the move through the decider (decide.ts, switches.ts): it stops the member when
// idle, and the start picks the higher rung. Only Thinkers move back up; a pinned or limited member
// is left to its row.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { Action, TickCtx } from "../../bin/loop/core/plugins.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { decide } from "../../bin/loop/core/decide.ts";
import memberFulfiller from "../../bin/loop/fulfil/member.ts";
import record from "../../bin/loop/reconcilers/record.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_792_144_800;
const WT = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-thinker-demo";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.db.close(); for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

// The Thinker of the fixture squad, on `on` (agent:model), with the roster row `row` ("<agent> <model> spawn - <fallbacks>")
// and each account `agent:account=pct` listed with that session pct. `o.key` names the roster row
// (default `thinker`); role/suffix/tier/phase/doc reshape the member (a builder babysitter for U101).
function setup(row: string, on: string, accts: string[], o: { state?: string; min?: string; key?: string; role?: string; suffix?: string; tier?: string; phase?: string; doc?: string } = {}): Store {
  const d = mkdtempSync(join(tmpdir(), "zzfallback-")); temps.push(d);
  cpSync(join(ROOT, "tests", "fixtures", "loop", "state"), d, { recursive: true });
  const s = open(d); stores.push(s); importJson(s, d, () => {});
  s.db.run("DELETE FROM accounts"); s.db.run("DELETE FROM observed_accounts");
  s.upsert("config", { project: "fx", file: "roles.conf", key: o.key ?? "thinker" }, { value: row, observed_at: T });
  if (o.min !== undefined) s.upsert("config", { project: "fx", file: "limits.conf", key: "fallback_return_min" }, { value: o.min, observed_at: T });
  const [agent, model] = on.split(":");
  s.db.run("UPDATE members SET agent = ?, model = ?, account = '-', role = ?, suffix = ?, tier = ?, phase = ?, doc = ?, want = 'running', want_at = ?, want_result = 'fresh', status = 'running' WHERE wt = ?",
    [agent, model, o.role ?? "thinker", o.suffix ?? "", o.tier ?? null, o.phase ?? null, o.doc ?? null, T - 60, WT]);
  for (const a of accts) {
    const [ag, rest] = a.split(":"), [account, pct] = rest.split("=");
    s.upsert("accounts", { agent: ag, account }, { observed_at: T });
    s.upsert("observed_accounts", { agent: ag, account }, { updated: String(T), session_pct: pct, session_reset: String(T + 7200), weekly_pct: "10", weekly_reset: String(T + 86400), observed_at: T });
  }
  s.upsert("observed_workers", { project: "fx", wt: WT }, { state: o.state ?? "idle", tail: "❯", tail_at: T, since: T - 900, last_output_at: T - 900, limited: null, gone_at: null, suspect: 0, presence: "running", account_at: T, observed_at: T });
  // U266: a move up asks for a journal checkpoint first (stop-checkpoint.test.ts); these tests are
  // about the move, so each checkpoint is proved the moment it is asked.
  s.db.run("CREATE TRIGGER proved AFTER INSERT ON stop_checkpoints BEGIN UPDATE stop_checkpoints SET state = 'verified' WHERE id = NEW.id; END");
  return s;
}
const ctx = (s: Store, at = T): TickCtx => ({ store: s, project: "fx", tick: 1, now: at, fired: [], poked: new Set() });
const stops = (s: Store, at = T) => decide(ctx(s, at)).filter((a) => a.kind === "member" && (a.payload as Row)?.stop);
const memberId = (s: Store) => Number((s.db.query("SELECT id FROM members WHERE wt = ?").get(WT) as Row).id);
const stopAct = (s: Store, episode: string): Action => ({ project: "fx", squad: "demo", member: WT, subject: `member:${memberId(s)}`, kind: "member", episode, payload: { id: memberId(s), stop: true, why: "fallback" } });
const x = (s: Store, at = T) => ({ store: s, now: at });

describe("fallback through the decider (U66, U154)", () => {
  test("an idle member on rung 2 whose rung 1 account has room gets one stop", async () => {
    const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=20", "muse:mu=10"]);
    const a = stops(s);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ member: WT, payload: { stop: true, why: "fallback" } });
    expect(String(a[0].episode)).toBe("stop:fallback:rung2->1");
  });

  test("U149: the 2026-11-07 shape (record codex on rung 2, live claude/opus on rung 1): no move, and the record is corrected", async () => {
    const s = setup("claude opus spawn - codex:gpt-6.1-sol", "codex:gpt-6.1-sol", ["claude:a1=20", "codex:default=10"]);
    s.db.run("UPDATE observed_workers SET walk = 'running', presence = 'running', agent = 'claude', account = 'a1', live_model = 'opus', account_at = ? WHERE wt = ?", [T, WT]);
    for (const at of [T, T + 120]) {
      s.db.run("UPDATE observed_workers SET account_at = ?, observed_at = ? WHERE wt = ?", [at, at, WT]);
      expect(stops(s, at)).toEqual([]);
      await record.run(ctx(s, at));
    }
    const m = s.db.query("SELECT agent, model, account FROM members WHERE wt = ?").get(WT);
    expect(m).toEqual({ agent: "claude", model: "opus", account: "a1" });
    expect(stops(s, T + 1200)).toEqual([]);
  });

  test("U149: a walk that doesn't know the agent keeps placing it by the record", async () => {
    const s = setup("claude opus spawn - codex:gpt-6.1-sol", "codex:gpt-6.1-sol", ["claude:a1=20", "codex:default=10"]);
    s.db.run("UPDATE observed_workers SET walk = 'unknown', agent = 'claude', account = 'a1', live_model = 'opus', account_at = ? WHERE wt = ?", [T, WT]);
    expect(stops(s)).toHaveLength(1);
  });

  for (const role of ["builder", "lead", "tester", "reviewer"]) {
    test(`an idle ${role} stays on its fallback even when rung 1 has room`, async () => {
      const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=20", "muse:mu=10"], { key: role, role });
      expect(stops(s)).toEqual([]);
    });
  }

  test("a member on rung 3 whose rung 1 is full but rung 2 has room goes to rung 2", async () => {
    const s = setup("ag1 x spawn - ag2:y,ag3:z", "ag3:z", ["ag1:a=99", "ag2:b=10", "ag3:c=10"]);
    const a = stops(s);
    expect(a).toHaveLength(1);
    expect(String(a[0].episode)).toBe("stop:fallback:rung3->2");
  });

  test("a row whose first rung is not claude moves back to that agent the same way", async () => {
    const s = setup("codex x spawn - claude:sonnet", "claude:sonnet", ["codex:cx=30", "claude:a1=10"]);
    expect(stops(s)).toHaveLength(1);
  });

  test("a member already on its first rung is left alone", async () => {
    const s = setup("claude opus spawn - muse:m", "claude:opus", ["claude:a1=20"]);
    expect(stops(s)).toEqual([]);
  });

  test("a busy member waits until idle", async () => {
    const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=20"], { state: "working" });
    expect(stops(s)).toEqual([]);
    s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "waiting" });
    expect(stops(s)).toEqual([]);
    s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "idle" });
    expect(stops(s)).toHaveLength(1);
  });

  test("no room above means no switch", async () => {
    const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=97", "claude:a2=96"]);
    expect(stops(s)).toEqual([]);
  });

  test("fallback_return_min=0 never switches", async () => {
    const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=20"], { min: "0" });
    expect(stops(s)).toEqual([]);
  });

  test("an idle Thinker with live sub-agents is not switched", async () => {
    const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=20", "muse:mu=10"]);
    s.db.run("UPDATE observed_workers SET sub_agents = ? WHERE wt = ?", [JSON.stringify([{ wt: "child" }]), WT]);
    expect(stops(s)).toEqual([]);
  });

  test("an idle Thinker with an open background step is not switched", async () => {
    const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=20", "muse:mu=10"]);
    const path = join(s.root, "bg.jsonl"), use = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { run_in_background: true } }] } }),
      res = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "Command running in background with ID: bx1" }] } });
    writeFileSync(path, `${use}\n${res}\n`);
    s.upsert("observed_transcripts", { path }, { project: "fx", wt: WT, mtime: T, size: 1, observed_at: T });
    expect(stops(s)).toEqual([]);
  });

  test("a pinned member is never moved by fallback", async () => {
    const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=20", "muse:mu=10"]);
    s.upsert("overrides", { member: memberId(s) }, { model: "muse", account: null, scope: "member", set_by: "board", set_at: T - 30 });
    expect(stops(s)).toEqual([]);
  });

  test("a member in a usage-limit episode is left to the limits row", async () => {
    const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=20", "muse:mu=10"]);
    s.upsert("episodes", { project: "fx", subject: WT, kind: "limited" },
      { episode_key: "muse/-|test", state: "usage", source: "loop", started_at: T - 60, ended_at: T + 600, observed_at: T });
    const a = decide(ctx(s)).filter((x) => x.kind === "member" && (x.payload as Row)?.stop);
    expect(a.map((x) => (x.payload as { why: string }).why)).toEqual(["limit"]);
  });

  test("a pending switch stop drops once the member works again or reaches the top", async () => {
    const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=20", "muse:mu=10"]);
    const [a] = stops(s);
    expect(memberFulfiller.stale!(a, x(s) as never)).toBe(false);
    s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "working" });
    expect(memberFulfiller.stale!(a, x(s) as never)).toBe(true);
    s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "idle", walk: "running", agent: "claude", account: "a1", live_model: "opus", account_at: T });
    s.db.run("UPDATE members SET agent = 'claude', model = 'opus', account = 'a1' WHERE wt = ?", [WT]);
    expect(memberFulfiller.stale!(a, x(s) as never)).toBe(true);
  });

  test("a rung-3 Thinker stops, starts on top, and stays quiet for a window", async () => {
    const s = setup("claude opus spawn - muse:m", "muse:m", ["claude:a1=20", "muse:mu=10"]);
    const orca = new FakeBackend(), act = new LoopActuator({ orca });
    const fulfillers = await load<Reconciler>(DIRS.fulfil);
    const decider = (await import("../../bin/loop/core/decide.ts")).default;
    s.upsert("coordinators", { project: "fx", squad: "demo" }, { handle: "term_loop", run_id: "run1", created_at: T - 3600, bound_at: T - 3600 });
    const loop = new Loop(s, { observers: [], reconcilers: [decider, ...fulfillers] }, act, { projects: () => ["fx"] });
    const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
    await tick(T);
    expect(orca.of("worker-stop").filter((c) => c.args[1] === WT)).toHaveLength(1);
    expect(orca.of("worker-start")).toHaveLength(0);
    // The observer reads no agent: the start lands on the top rung.
    s.upsert("observed_workers", { project: "fx", wt: WT }, { presence: "none", account_at: T + 1, observed_at: T + 1 });
    await tick(T + 1);
    const started = orca.of("worker-start").filter((c) => c.args[1] === WT);
    expect(started).toHaveLength(1);
    expect(String(started[0].args[4])).toContain("opus");
    // The new agent works the brief (its delivery verifies), then the operator moves it back down.
    s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "working", presence: "running", walk: "running", agent: "claude", account: "a1",
      live_model: "opus", account_at: T + 2, observed_at: T + 2 });
    await tick(T + 2);
    s.db.run("UPDATE members SET agent = 'muse', model = 'm', account = '-' WHERE wt = ?", [WT]);
    s.upsert("observed_workers", { project: "fx", wt: WT }, { state: "idle", presence: "running", walk: null, agent: null, account: null, live_model: null, account_at: T + 3, observed_at: T + 3 });
    // Inside the window: no second stop; past it, the same episode again.
    await tick(T + 60);
    expect(orca.of("worker-stop").filter((c) => c.args[1] === WT)).toHaveLength(1);
    await tick(T + 16 * 60);
    const again = orca.of("worker-stop").filter((c) => c.args[1] === WT);
    expect(again).toHaveLength(2);
  });
});

describe("off its tier+phase ladder, a Thinker moves to the best rung with room", () => {
  // A Thinker limit-switched off its ladder: the tier comes
  // from its unit, the phase from its member row, and the fallback flag marks it as moved.
  const babysitter = (on: string, accts: string[], extra: { doc?: string } = {}) =>
    setup("claude sonnet spawn - muse:muse-spark-1.3", on, accts, { key: "thinker-standard-babysit",
      role: "thinker", suffix: "u6-takes-u5", phase: "babysit", doc: '{"fallback":true}', ...extra });

  test("spark free, claude full: back to spark (not only rung 1)", async () => {
    const s = babysitter("muse:muse-wonder-1.0", ["claude:a=99", "muse:mu=10"]);
    const a = stops(s);
    expect(a).toHaveLength(1);
    expect(String(a[0].episode)).toContain("rung");
  });

  test("only claude free: back to sonnet on rung 1", async () => {
    const s = babysitter("muse:muse-wonder-1.0", ["claude:a=10", "muse:mu=99"]);
    const a = stops(s);
    expect(a).toHaveLength(1);
  });

  test("nothing free: it stays", async () => {
    const s = babysitter("muse:muse-wonder-1.0", ["claude:a=99", "muse:mu=99"]);
    expect(stops(s)).toEqual([]);
  });

  test("a member already on a rung of its tier+phase ladder behaves as before", async () => {
    const s = babysitter("muse:muse-spark-1.3", ["claude:a=10", "muse:mu=10"], { doc: undefined });
    const a = stops(s);
    expect(a).toHaveLength(1);
  });
});

test("an off-ladder Builder stays until a restart re-picks it", async () => {
  const s = setup("claude sonnet spawn - muse:muse-spark-1.3", "muse:muse-wonder-1.0",
    ["claude:a=10", "muse:mu=10"], { key: "builder-standard-babysit", role: "builder",
      suffix: "u6-takes-u5", phase: "babysit", doc: '{"fallback":true}' });
  expect(stops(s)).toEqual([]);
});

 test("U124: identical models on separate plans return to the higher plan and then stay quiet", async () => {
  const s = setup("claude opus spawn - claude:opus:-:Ultra Max", "claude:opus", ["claude:small=0", "claude:large=0"]);
  s.upsert("observed_accounts", { agent: "claude", account: "small" }, { plan: "Max" });
  s.upsert("observed_accounts", { agent: "claude", account: "large" }, { plan: "Ultra" });
  s.db.run("UPDATE members SET account = 'large' WHERE wt = ?", [WT]);
  expect(stops(s)).toHaveLength(1);
 });

describe("U180: a fallback move up stops only the Thinkers that fit", () => {
  // Three idle Thinkers on the codex fallback; claude a1 is a Max account (scale 4, pick_load_thinker 1: 4% each).
  const three = (pct: string): { s: Store; wts: string[] } => {
    const s = setup("claude opus spawn - codex:gpt", "codex:gpt", [`claude:a1=${pct}`, "codex:default=10"]);
    s.db.run("UPDATE observed_accounts SET plan = 'Max' WHERE account = 'a1'");
    s.upsert("config", { project: "fx", file: "limits.conf", key: "pick_load_scale_claude_Max" }, { value: "4", observed_at: T });
    const cols = (s.db.query("PRAGMA table_info(members)").all() as Row[]).map((c) => String(c.name)).filter((c) => !["id", "wt", "suffix"].includes(c));
    const wts = [WT];
    for (const sfx of ["b", "c"]) {
      const wt = `${WT}-${sfx}`; wts.push(wt);
      s.db.run(`INSERT INTO members (${cols.join(", ")}, wt, suffix) SELECT ${cols.join(", ")}, ?, ? FROM members WHERE wt = ?`, [wt, sfx, WT]);
      const w = s.db.query("SELECT * FROM observed_workers WHERE wt = ?").get(WT) as Row;
      s.upsert("observed_workers", { project: "fx", wt }, Object.fromEntries(Object.entries(w).filter(([k]) => !["project", "wt"].includes(k))));
    }
    return { s, wts };
  };

  const looped = async (s: Store) => {
    const orca = new FakeBackend(), act = new LoopActuator({ orca });
    const fulfillers = await load<Reconciler>(DIRS.fulfil);
    s.upsert("coordinators", { project: "fx", squad: "demo" }, { handle: "term_loop", run_id: "run1", created_at: T - 3600, bound_at: T - 3600 });
    const loop = new Loop(s, { observers: [], reconcilers: [{ name: "decide", run: async (c) => decide(c) }, ...fulfillers] }, act, { projects: () => ["fx"] });
    return { orca, tick: async (at: number) => { await loop.tick(at); await act.drain(); } };
  };

  test("room for one: one stop, its start lands on top, and no stop while the estimate stays full", async () => {
    const { s, wts } = three("88");   // 88 + 4 fits; 88 + 4 + 4 does not
    expect(stops(s)).toHaveLength(1);
    const { tick, orca } = await looped(s);
    await tick(T);
    const stopped = orca.of("worker-stop");
    expect(stopped).toHaveLength(1);
    const wt = String(stopped[0].args[1]);
    expect(wts).toContain(wt);
    const held = s.db.query("SELECT state, episode_key FROM episodes WHERE kind = 'fallback-reserve'").all() as Row[];
    expect(held).toEqual([{ state: "reserved", episode_key: JSON.stringify({ agent: "claude", model: "opus", account: "a1" }) }]);
    // The stopped one starts on the reserved place; the other two get no stop.
    s.upsert("observed_workers", { project: "fx", wt }, { presence: "none", account_at: T + 1, observed_at: T + 1 });
    await tick(T + 1);
    expect(orca.of("worker-start").map((c) => [c.args[1], String(c.args[4]).includes("opus")])).toEqual([[wt, true]]);
    expect(orca.of("worker-stop")).toHaveLength(1);
    expect((s.db.query("SELECT state FROM episodes WHERE kind = 'fallback-reserve'").get() as Row).state).toBe("placed");
    s.upsert("observed_workers", { project: "fx", wt }, { state: "working", presence: "running", walk: "running", agent: "claude", account: "a1",
      live_model: "opus", account_at: T + 2, observed_at: T + 2 });
    await tick(T + 2);
    expect(stops(s, T + 3)).toEqual([]);   // a1: 88% + the placed Thinker 4% + 4% >= 95%
    expect(orca.of("worker-stop")).toHaveLength(1);
  });

  test("room for all three: three stops", () => {
    const { s } = three("10");
    expect(stops(s)).toHaveLength(3);
  });

  test("a start that lands lower anyway says why, and the window holds", async () => {
    const { s } = three("88");
    const { tick, orca } = await looped(s);
    await tick(T);
    const wt = String(orca.of("worker-stop")[0].args[1]);
    s.db.run("UPDATE observed_accounts SET session_pct = '99' WHERE account = 'a1'");   // full before the start
    s.upsert("observed_workers", { project: "fx", wt }, { presence: "none", account_at: T + 1, observed_at: T + 1 });
    await tick(T + 1);
    expect(String(orca.of("worker-start")[0].args[4])).not.toContain("opus");
    expect((s.db.query("SELECT state FROM episodes WHERE kind = 'fallback-reserve'").get() as Row).state).toBe("missed");
    const missed = s.db.query("SELECT payload FROM events WHERE kind = 'fallback_missed'").all() as Row[];
    expect(missed).toHaveLength(1);
    expect(JSON.parse(String(missed[0].payload))).toMatchObject({ aimed: "claude:opus@a1", landed: expect.stringContaining("codex:gpt") });
    expect(JSON.parse(String(missed[0].payload)).why).toContain("fallback_return_min");
  });
});
