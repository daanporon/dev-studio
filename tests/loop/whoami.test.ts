// whoami.test.ts — U4 of orca-backend-alternatives: who a process is. A Claude terminal the loop starts
// carries DS_MEMBER, DS_WT and DS_GEN; whoAmI() reads DS_MEMBER first, then the Orca handle. A request
// filed from such a terminal carries its member and generation, and the loop's replay runs with them.
// Hermetic: a copy of the fixture state and the FakeBackend.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { filerIdentity, identityEnv, memberLabel, parseMember, whoAmI } from "../../bin/loop/core/whoami.ts";
import { childEnv } from "../../bin/loop/io/orca.ts";
import { senderAt } from "../../bin/loop/messages/messages.ts";
import { dsLoopFront } from "../../bin/lib/shared.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
const KEEP = ["DS_MEMBER", "DS_WT", "DS_GEN", "ORCA_TERMINAL_HANDLE", "DS_STATE_ROOT", "DS_LOOP_RETRY_S"];
const saved = Object.fromEntries(KEEP.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const k of KEEP) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzwho-"));
  temps.push(d);
  cpSync(join(ROOT, "tests", "fixtures", "loop", "state"), d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}

describe("whoAmI", () => {
  const M = "fx/sq/builder-u1-x";
  test("DS_MEMBER only: found by it, with its worktree and generation", () => {
    expect(whoAmI({ DS_MEMBER: M, DS_WT: "/wt/b", DS_GEN: "g1" })).toEqual({ member: M, wt: "/wt/b", gen: "g1", handle: null, via: "member" });
  });
  test("the Orca handle only: found by it, as today", () => {
    expect(whoAmI({ ORCA_TERMINAL_HANDLE: "term_1" })).toEqual({ member: null, wt: null, gen: null, handle: "term_1", via: "handle" });
  });
  test("both: DS_MEMBER wins, the handle stays for Orca's own calls", () => {
    expect(whoAmI({ DS_MEMBER: M, DS_GEN: "g1", ORCA_TERMINAL_HANDLE: "term_1" })).toMatchObject({ member: M, gen: "g1", handle: "term_1", via: "member" });
  });
  test("neither: nobody", () => {
    expect(whoAmI({})).toEqual({ member: null, wt: null, gen: null, handle: null, via: null });
    expect(whoAmI({ DS_MEMBER: "not-a-member", ORCA_TERMINAL_HANDLE: " " }).via).toBeNull();
  });
  test("parseMember and memberLabel read each other back", () => {
    expect(parseMember(M)).toEqual({ project: "fx", squad: "sq", role: "builder", suffix: "u1-x" });
    expect(parseMember("fx/_studio/studio")).toEqual({ project: "fx", squad: "_studio", role: "studio", suffix: "" });
    for (const bad of ["", "fx/sq", "fx/sq/a/b", "fx//lead", "fx/sq/-x"]) expect(parseMember(bad)).toBeNull();
    expect(memberLabel({ project: "fx", squad: "sq", role: "builder", suffix: "u1-x" })).toBe(M);
    expect(memberLabel({ project: "fx", squad: "sq", role: "lead", suffix: null })).toBe("fx/sq/lead");
  });
  test("a request carries the filer's identity and its replay gets it back; childEnv never passes one on", () => {
    expect(filerIdentity({ DS_MEMBER: M, DS_GEN: "g1", DS_WT: "/wt/b" })).toEqual({ member: M, gen: "g1", wt: "/wt/b" });
    expect(filerIdentity({ ORCA_TERMINAL_HANDLE: "term_1" })).toEqual({});
    expect(identityEnv({ member: M, gen: "g1", wt: "/wt/b" })).toEqual({ DS_MEMBER: M, DS_GEN: "g1", DS_WT: "/wt/b" });
    expect(identityEnv({ member: "junk" })).toEqual({});
    process.env.DS_MEMBER = M; process.env.DS_GEN = "g1"; process.env.DS_WT = "/wt/b";
    const env = childEnv();
    for (const k of ["DS_MEMBER", "DS_GEN", "DS_WT", "DS_START_MEMBER", "DS_START_GEN"]) expect(env[k]).toBeUndefined();
  });
});

describe("senderAt reads DS_MEMBER first", () => {
  test("the member named wins over the handle; an unknown one falls through to the handle", () => {
    const s = imported();
    s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, observed_at, updated_at) VALUES ('fx', 'sq', 'repo::/wt/lead', 'lead', '', 'running', ?, ?)", [T, T]);
    s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, handle, observed_at, updated_at) VALUES ('fx', 'sq', 'repo::/wt/thinker', 'thinker', '', 'running', 'term_t', ?, ?)", [T, T]);
    const by = (env: Record<string, string>) => senderAt(s, "/nowhere", env);
    expect(by({ DS_MEMBER: "fx/sq/lead", ORCA_TERMINAL_HANDLE: "term_t" })).toMatchObject({ role: "lead" });
    expect(by({ DS_MEMBER: "fx/sq/builder-gone", ORCA_TERMINAL_HANDLE: "term_t" })).toMatchObject({ role: "thinker" });
  });
});

// The child a replay runs: logs the identity it was given.
function child(s: Store): string {
  const f = join(s.root, "child.sh");
  writeFileSync(f, `#!/usr/bin/env bash\nprintf 'member=%s gen=%s wt=%s handle=%s\\n' "\${DS_MEMBER:-}" "\${DS_GEN:-}" "\${DS_WT:-}" "\${ORCA_TERMINAL_HANDLE:-}" >> "$DS_STATE_ROOT/child.log"\necho ok\n`);
  chmodSync(f, 0o755);
  return f;
}
const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);

describe("a replayed request runs as its filer", () => {
  test("dsLoopFront files the member, generation and worktree; the replay sees DS_MEMBER and DS_GEN", async () => {
    const s = imported();
    s.db.run("INSERT INTO observed_terminals (project, handle, observed_at) VALUES ('fx', 'term_asker', 100)");
    Object.assign(process.env, { DS_STATE_ROOT: s.root, DS_MEMBER: "fx/x/builder-u1", DS_GEN: "gen-42", DS_WT: "/wt/b1", ORCA_TERMINAL_HANDLE: "term_asker" });
    const code = await dsLoopFront({ label: "fx", kind: "send-role", subject: "x", id: "", key: "send-role:fx:who", script: "bin/role/send-role.sh", argv: ["x", "lead", "s", "b"], wait: "" });
    expect(code).toBe(0);
    const row = s.db.query("SELECT * FROM requests WHERE kind = 'send-role'").get() as Row;
    const p = JSON.parse(String(row.payload));
    expect(p).toMatchObject({ member: "fx/x/builder-u1", gen: "gen-42", wt: "/wt/b1", from: "term_asker" });
    // Replay it through the loop with the child in place of the real script (argv[0] only).
    for (const k of ["DS_MEMBER", "DS_GEN", "DS_WT", "ORCA_TERMINAL_HANDLE"]) delete process.env[k];
    s.db.run("UPDATE requests SET payload = ? WHERE id = ?", [JSON.stringify({ ...p, argv: [child(s), ...p.argv.slice(1)] }), row.id]);
    const orca = new FakeOrca(), act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
    const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
    loop.boot(T);
    await loop.tick(T); await act.drain();
    const log = join(s.root, "child.log");
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8").trim()).toBe("member=fx/x/builder-u1 gen=gen-42 wt=/wt/b1 handle=term_asker");
  }, 30_000);
});

describe("a loop start carries its identity (actuator)", () => {
  async function rig(agent: string) {
    const s = imported();
    process.env.DS_LOOP_RETRY_S = "1";
    for (const role of ["lead", "thinker"]) s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value: `${agent} sonnet always`, observed_at: T });
    s.db.run("UPDATE projects SET studio_wt = 'fakerepo::/wt/studio' WHERE label = 'fx'");
    const orca = new FakeOrca(), act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
    const reconcilers = await load<Reconciler>(DIRS.reconcilers);
    const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers] }, act, { projects: () => ["fx"] });
    loop.boot(T);
    let at = T;
    const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
    s.want("squad", "fx/who1", "running", { payload: { repo: "path:/nonexistent/fixture-repo", type: "feature" }, fill: { repo: "path:/nonexistent/fixture-repo", type: "feature" }, by: "spawn-squad" });
    await tick();
    const ms = () => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = 'who1' ORDER BY id").all() as Row[];
    for (const m of ms()) s.upsert("picks", { member: m.id }, { project: "fx", squad: "who1", role: m.role, agent, model: "sonnet", slot: 1, picked_at: T });
    await tick(2);
    return { s, orca, ms };
  }
  test("a Claude start gets DS_START_MEMBER and DS_START_GEN (its call's retry id), recorded as the member's gen", async () => {
    const { s, orca, ms } = await rig("claude");
    const starts = orca.of("role-start").filter((c) => String(c.args[6]).includes("who1"));
    expect(starts.length).toBe(2);
    for (const c of starts) {
      const role = String(c.args.at(-1));
      expect(c.via.env?.DS_START_MEMBER).toBe(`fx/who1/${role}`);
      expect(c.via.env?.DS_START_GEN).toBe(String(c.via.retry));
      const m = ms().find((x) => x.role === role)!;
      expect(m.gen).toBe(String(c.via.retry));
    }
    const retries = (s.db.query("SELECT retry_id FROM orca_calls WHERE op = 'role-start'").all() as Row[]).map((r) => String(r.retry_id));
    for (const c of starts) expect(retries).toContain(String(c.via.retry));
  }, 30_000);
  test("a Codex start carries none and records no gen", async () => {
    const { orca, ms } = await rig("codex");
    const starts = orca.of("role-start").filter((c) => String(c.args[6]).includes("who1"));
    expect(starts.length).toBe(2);
    for (const c of starts) { expect(c.via.env?.DS_START_MEMBER).toBeUndefined(); expect(c.via.env?.DS_START_GEN).toBeUndefined(); }
    for (const m of ms()) expect(m.gen ?? null).toBeNull();
  }, 30_000);
});
