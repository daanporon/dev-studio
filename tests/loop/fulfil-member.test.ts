// fulfil-member.test.ts — U21c (orca-backend-alternatives): the start of a member Orca still shows
// `working` after its agent died. When U21a's rule reads it gone, the start walks that worktree again
// right before the call; only a walk that succeeds and finds no agent sends DS_START_OLD_GONE, with which
// the backend guard closes the old agent terminals and starts. Against the fake Orca (bin/loop/fakes/orca.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import decider from "../../bin/loop/core/decide.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { walkOne } from "../../bin/loop/squad/old-gone.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const T = 1_800_000_000;
const WS = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo";
const ACCT = "6b9a19e7-e78f-4a78-ba77-b573b3c9f95d";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzloop-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}
const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const picked: Picker = async () => ({ agent: "claude", model: "opus", effort: null, account: "acct-b" });
function rig(s: Store, orca: FakeBackend) {
  const act = new LoopActuator({ orca, pick: picked, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  return async (at: number) => { await loop.tick(at); await act.drain(); };
}
const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row & { wt: string };
const path = (suffix: string) => `/home/user/orca/workspaces/demo/ds-dev-studio-builder-${suffix}-demo`;

// A Builder started at T-1000 under generation g1, whose old agent terminal Orca still shows mid-turn.
// `noneSince`: when the walks began finding no agent (null: the walk still finds it, so the rule is off and
// reality reads running; the picked account differs, so the decider files a switch start).
function killed(s: Store, orca: FakeBackend, suffix: string, noneSince: number | null) {
  const wt = `${WS}/ds-dev-studio-builder-${suffix}-demo`;
  s.db.run("INSERT INTO members (project, squad, role, suffix, wt, agent, model, account, gen, placed_at, observed_at, updated_at) VALUES ('fx', 'demo', 'builder', ?, ?, 'claude', 'opus', ?, 'g1', ?, ?, ?)",
    [suffix, wt, ACCT, T - 1000, T, T]);
  const id = Number((s.db.query("SELECT id FROM members WHERE suffix = ?").get(suffix) as Row).id);
  s.upsert("observed_workers", { project: "fx", wt }, { presence: "running", state: "working", walk: noneSince == null ? "running" : "none", walk_none_at: noneSince, account_at: T - 10, observed_at: T - 10 });
  orca.agent(wt, "term_old", "claude", true);
  s.want("member", String(id), "running", { payload: { why: "phase", prompt: "build" } });
  return { id, wt };
}
const flag = (orca: FakeBackend) => orca.of("worker-start").map((c) => c.via.env?.DS_START_OLD_GONE ?? null);

describe("U21c: a start into a worktree Orca still shows working", () => {
  test("rule held and the fresh walk finds no agent: the old terminal is closed and the start goes", async () => {
    const s = imported(), orca = new FakeBackend();
    orca.procs = [{ cwd: "/home/user/elsewhere", agent: "claude", account: ACCT, kind: "main" }];
    const { id } = killed(s, orca, "dead", T - 400);
    await rig(s, orca)(T);
    expect(orca.of("agent-accounts")).toHaveLength(1);
    expect(flag(orca)).toEqual(["1"]);
    expect(orca.started).toHaveLength(1);
    expect(orca.agents.map((a) => a.handle)).not.toContain("term_old");
    expect(member(s, id).status).toBe("running");
  });

  test("rule held but the fresh walk finds the agent: no flag, agent_busy, nothing closed or started", async () => {
    const s = imported(), orca = new FakeBackend();
    orca.procs = [{ cwd: `${path("alive")}/sub`, agent: "claude", account: ACCT, kind: "main" }];
    killed(s, orca, "alive", T - 400);
    await rig(s, orca)(T);
    expect(flag(orca)).toEqual([null]);
    expect(orca.started).toEqual([]);
    expect(orca.agents.map((a) => a.handle)).toEqual(["term_old"]);
  });

  test("rule held but the fresh walk fails: no flag, no start", async () => {
    const s = imported(), orca = new FakeBackend();
    orca.procs = null;
    killed(s, orca, "nowalk", T - 400);
    await rig(s, orca)(T);
    expect(orca.of("agent-accounts")).toHaveLength(1);
    expect(flag(orca)).toEqual([null]);
    expect(orca.started).toEqual([]);
    expect(orca.agents.map((a) => a.handle)).toEqual(["term_old"]);
  });

  test("not on the rule's path: no walk, no flag, agent_busy as before", async () => {
    const s = imported(), orca = new FakeBackend();
    orca.procs = [];
    const { id } = killed(s, orca, "stale", null);
    await rig(s, orca)(T);
    expect(orca.of("agent-accounts")).toHaveLength(0);
    expect(flag(orca)).toEqual([null]);
    expect(orca.started).toEqual([]);
    expect(s.get("episodes", { project: "fx", subject: `member:${id}`, kind: "agent_busy" })?.state).toBe("waiting");
  });

  test("the agent_busy wait ends when the rule starts to hold, and that try passes the flag", async () => {
    const s = imported(), orca = new FakeBackend();
    orca.procs = [];
    const { id, wt } = killed(s, orca, "late", null);   // a switch start, refused agent_busy
    const tick = rig(s, orca);
    await tick(T);
    expect(flag(orca)).toEqual([null]);
    // The agent dies; the walks find none from T-100, so the rule holds at T-100 + GONE_MIN (3 min) = T+80.
    s.upsert("observed_workers", { project: "fx", wt }, { walk: "none", walk_none_at: T - 100, account_at: T + 50, observed_at: T + 50 });
    await tick(T + 60);                               // the 60 s retry: still refused, next try at T+80, not T+120
    expect(flag(orca)).toEqual([null, null]);
    expect(orca.of("agent-accounts")).toHaveLength(0);
    await tick(T + 80);                               // the switch drops; the decider's start walks and passes the flag
    expect(flag(orca)).toEqual([null, null, "1"]);
    expect(orca.of("agent-accounts")).toHaveLength(1);
    expect(orca.started).toHaveLength(1);
    expect(member(s, id).status).toBe("running");
  });
});

describe("walkOne", () => {
  test("a process in a nested member worktree is that worktree's, not this one's", async () => {
    const s = imported(), orca = new FakeBackend();
    const outer = `${WS}/ds-dev-studio-builder-outer-demo`;
    s.db.run("INSERT INTO members (project, squad, role, suffix, wt, agent, observed_at, updated_at) VALUES ('fx', 'demo', 'builder', 'inner', ?, 'claude', ?, ?)", [`${outer}/inner`, T, T]);
    orca.procs = [{ cwd: `${path("outer")}/inner/src`, agent: "claude", account: ACCT, kind: "main" },
      { cwd: path("outer"), agent: "claude", account: ACCT, kind: "sub" }];
    expect(await walkOne(s, orca, outer)).toBe("none");
    orca.procs.push({ cwd: path("outer"), agent: "claude", account: ACCT, kind: "main" });
    expect(await walkOne(s, orca, outer)).toBe("running");
    expect(await walkOne(s, orca, "no-path-id")).toBe("failed");
  });
});
