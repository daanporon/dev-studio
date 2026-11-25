// squad-lifecycle.test.ts — U158: squad create, suspend, resume and archive as wishes in
// Bun. A squad wish (squads.want) is acted on by fulfil/squad.ts plus the decider, the
// pause flow and fulfil/close.ts — never by a script replay. Hermetic: a copy of the
// fixture state, the FakeBackend, picks seeded as the pick reconciler would write them.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.DS_LOOP_RETRY_S;
});

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
async function rig() {
  const d = mkdtempSync(join(tmpdir(), "zzsquad-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  process.env.DS_LOOP_RETRY_S = "1";
  // The roster the config observer would import from the project roles.conf (whole-file).
  for (const [role, value] of [["lead", "claude sonnet always"], ["thinker", "claude opus always"], ["builder", "claude opus ondemand"]] as const)
    s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const reconcilers = await load<Reconciler>(DIRS.reconcilers);
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
  return { s, orca, act, loop, tick, now: () => at };
}

const squad = (s: Store, topic: string) => s.db.query("SELECT * FROM squads WHERE project = 'fx' AND topic = ?").get(topic) as Row;
const members = (s: Store, topic: string) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = ? AND COALESCE(status, '') != 'gone' ORDER BY id").all(topic) as Row[];
function seedPicks(s: Store, topic: string) {
  for (const m of members(s, topic))
    s.upsert("picks", { member: m.id }, { project: "fx", squad: topic, role: m.role, agent: "claude", model: m.role === "lead" ? "sonnet" : "opus", slot: 1, picked_at: T });
}
function seedWorkers(s: Store, topic: string, presence: string, state = "idle", path?: string) {
  for (const m of members(s, topic)) if (m.wt) {
    s.upsert("observed_workers", { project: "fx", wt: m.wt }, { presence, state, observed_at: T, account_at: T });
    s.upsert("observed_worktrees", { project: "fx", wt: m.wt }, { path: path ?? s.root, branch: "main", observed_at: T });
  }
}
// A real clean, pushed git repo at <root>/wt-repo, so close.ts's wt_probe passes and the
// removal path (terminal-close + worktree-rm) is exercised, not the already-gone branch.
function cleanRepo(s: Store): string {
  const dir = join(s.root, "wt-repo"), bare = join(s.root, "wt-bare.git");
  const git = (...args: string[]) => { const r = Bun.spawnSync(["git", ...args]); if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`); };
  git("init", "-q", "-b", "main", dir); git("-C", dir, "config", "user.email", "t@t"); git("-C", dir, "config", "user.name", "t");
  git("-C", dir, "commit", "-q", "--allow-empty", "-m", "init");
  git("init", "-q", "--bare", bare); git("-C", dir, "remote", "add", "origin", bare); git("-C", dir, "push", "-q", "-u", "origin", "main");
  return dir;
}

describe("squad create (U158)", () => {
  test("a running wish creates one Run, one task, and the Lead + always-role wishes; their starts follow", async () => {
    const { s, orca, tick } = await rig();
    s.want("squad", "fx/new1", "running", { payload: { repo: "path:/nonexistent/fixture-repo", type: "feature" }, fill: { repo: "path:/nonexistent/fixture-repo", type: "feature" }, by: "spawn-squad" });
    await tick();
    const r = squad(s, "new1");
    expect(String(r.run_id)).toMatch(/^run_/);
    expect(String(r.task_id)).toMatch(/^task_/);
    expect(r.status).toBe("running");
    expect(orca.of("run-create")).toHaveLength(1);
    expect(orca.of("task-create")).toHaveLength(1);
    // U159: the Lead prompt never tells it to adopt — the loop holds the Run seat, and orch.sh
    // refuses adopt. The task spec says so up front.
    expect(orca.of("task-create")[0].args[1]).toContain("never adopt it");
    expect(orca.of("task-create")[0].args[1]).not.toContain("orch.sh adopt");
    const ms = members(s, "new1");
    expect(ms.map((m) => m.role)).toEqual(["lead", "thinker"]);
    expect(ms.every((m) => m.want === "running")).toBe(true);
    // The decider starts them (picks seeded as the pick reconciler writes them), Lead first.
    seedPicks(s, "new1");
    await tick(2);
    expect(orca.started.filter((x) => x.wt.includes("new1")).map((x) => x.op)).toEqual(["role-start", "role-start"]);
    expect(members(s, "new1").every((m) => m.wt != null)).toBe(true);
    expect(squad(s, "new1").lead_wt).toBe(members(s, "new1")[0].wt);
    await tick(2);
    expect(orca.of("run-create")).toHaveLength(1);   // no second Run on later ticks
  });

  test("U2: --start rides the wish into the doc and the feature Thinker's first prompt only", async () => {
    const { s, tick } = await rig();
    const prompt = (topic: string, role: string) => String(JSON.parse(String(members(s, topic).find((m) => m.role === role)!.want_payload)).prompt);
    const wish = (topic: string, payload: Record<string, string>) =>
      s.want("squad", `fx/${topic}`, "running", { payload: { repo: "path:/nonexistent/fixture-repo", ...payload }, fill: { repo: "path:/nonexistent/fixture-repo", type: payload.type ?? "feature", ...(payload.framing ? { framing: payload.framing } : {}) }, by: "spawn-squad" });
    wish("st1", { type: "feature", framing: "think about the board", start: "brainstorm" });
    wish("st2", { type: "feature", framing: "think about the board" });
    wish("st3", { type: "testing", framing: "run it", start: "plan" });
    wish("st4", { type: "feature", framing: "the board crashes", start: "fix" });
    await tick();
    expect(JSON.parse(String(squad(s, "st1").doc)).start).toBe("brainstorm");
    expect(JSON.parse(String(squad(s, "st2").doc)).start).toBeNull();
    expect(prompt("st1", "thinker")).toContain("Framing: think about the board.");
    expect(prompt("st1", "thinker")).toContain("Studio start: brainstorm — run the Start triage in roles/thinker.md from it; overrule it only with a reason.");
    expect(prompt("st2", "thinker")).toContain("Framing: think about the board.");
    expect(prompt("st2", "thinker")).not.toContain("Studio start");
    expect(prompt("st3", "thinker")).not.toContain("Studio start");
    expect(prompt("st3", "thinker")).not.toContain("Framing");
    expect(prompt("st4", "thinker")).toContain("Studio start: fix — run the Start triage in roles/thinker.md from it; overrule it only with a reason.");
    expect(prompt("st1", "lead")).not.toContain("Studio start");
  });

  test("a crash mid-create (task-create fails once) still gives one Run", async () => {
    const { s, orca, tick } = await rig();
    orca.fail("task-create", { code: 1, out: "", err: "boom" });
    s.want("squad", "fx/new2", "running", { payload: { repo: "path:/nonexistent/fixture-repo", type: "feature" }, fill: { repo: "path:/nonexistent/fixture-repo", type: "feature" }, by: "spawn-squad" });
    await tick(3);
    expect(orca.of("run-create")).toHaveLength(1);
    expect(String(squad(s, "new2").run_id)).toMatch(/^run_/);
    expect(String(squad(s, "new2").task_id ?? "")).toMatch(/^task_/);
  });

  test("U11: a squad on another backend gets no Run, task or coordinator; its roles are wished", async () => {
    const { s, orca, tick } = await rig();
    s.upsert("config", { project: "fx", file: "limits.conf", key: "default_backend" }, { value: "tmux", observed_at: T });   // U30: the project's backend
    s.want("squad", "fx/ontmux", "running", { payload: { repo: "path:/nonexistent/fixture-repo", type: "feature" },
      fill: { repo: "path:/nonexistent/fixture-repo", type: "feature", backend: "tmux", worktree_provider: "git" }, by: "test" });
    await tick(3);
    expect(orca.of("run-create")).toHaveLength(0);
    expect(orca.of("task-create")).toHaveLength(0);
    expect(orca.calls.filter((c) => JSON.stringify(c.args).includes("ontmux"))).toEqual([]);
    expect(squad(s, "ontmux").run_id ?? null).toBeNull();
    expect(squad(s, "ontmux").status).toBe("running");
    expect(s.get("coordinators", { project: "fx", squad: "ontmux" })).toBeNull();
    expect((members(s, "ontmux") as { role: string }[]).map((m) => m.role)).toContain("lead");
  });
});

describe("squad suspend and resume (U158)", () => {
  test("suspend writes a pause intent and marks the squad; once agents are gone their worktrees are removed and wt cleared", async () => {
    const { s, orca, tick } = await rig();
    const repo = cleanRepo(s);
    seedWorkers(s, "demo", "running", "idle", repo);
    s.want("squad", "fx/demo", "suspended", { by: "suspend-squad" });
    await tick();
    expect(squad(s, "demo").status).toBe("suspended");
    const intent = s.db.query("SELECT * FROM pause_intents WHERE scope = 'squad' AND project = 'fx' AND squad = 'demo' AND cleared_at IS NULL").get() as Row;
    expect(intent).not.toBeNull();
    // Agents gone (the pause flow closed them): the decider removes worktrees, wt clears.
    seedWorkers(s, "demo", "none", "idle", repo);
    await tick(2);
    const ms = members(s, "demo");
    expect(ms.length).toBeGreaterThan(0);
    expect(ms.every((m) => m.wt == null)).toBe(true);
    expect(ms.filter((m) => ["lead", "thinker"].includes(String(m.role))).every((m) => m.status === "suspended")).toBe(true);
    expect(orca.of("worktree-rm").length).toBeGreaterThanOrEqual(2);   // the removal path ran
  });

  test("a squad suspended through U158 resumes (its own pause intent does not block it) and starts fresh", async () => {
    const { s, orca, tick } = await rig();
    seedWorkers(s, "demo", "running");
    s.want("squad", "fx/demo", "suspended", { by: "suspend-squad" });
    await tick();
    seedWorkers(s, "demo", "none");
    await tick(2);
    s.want("squad", "fx/demo", "running", { by: "resume-squad" });
    await tick();
    expect(squad(s, "demo").status).toBe("running");
    seedPicks(s, "demo");
    await tick(3);
    expect(members(s, "demo").filter((m) => ["lead", "thinker"].includes(String(m.role))).every((m) => m.wt != null)).toBe(true);
  });

  test("a squad suspended through U158 can be closed (its pause intent does not block archive)", async () => {
    const { s, tick } = await rig();
    seedWorkers(s, "demo", "running");
    s.want("squad", "fx/demo", "suspended", { by: "suspend-squad" });
    await tick();
    seedWorkers(s, "demo", "none");
    await tick(2);
    s.want("squad", "fx/demo", "gone", { by: "close-squad" });
    await tick(3);
    expect(squad(s, "demo").status).toBe("closed");
  });

  test("resume of a squad suspended before this unit starts its members fresh", async () => {
    const { s, orca, tick } = await rig();
    // The pre-U158 shape: status suspended, members with no worktree, standing wishes running.
    s.db.run("UPDATE squads SET status = 'suspended', want = 'suspended', want_result = 'done: suspended' WHERE project = 'fx' AND topic = 'demo'");
    s.db.run("UPDATE members SET wt = NULL, status = 'suspended', want = 'running' WHERE project = 'fx' AND squad = 'demo'");
    s.want("squad", "fx/demo", "running", { by: "resume-squad" });
    await tick();
    expect(squad(s, "demo").status).toBe("running");
    seedPicks(s, "demo");
    await tick(3);
    expect(orca.started.length).toBeGreaterThanOrEqual(2);
    expect(members(s, "demo").filter((m) => ["lead", "thinker"].includes(String(m.role))).every((m) => m.wt != null)).toBe(true);
  });

  // U3 (thinker-start-triage): a resumed suspended squad's not-started approved units wait on
  // the Thinker's plan check. demo-plan.md is approved; demo-loop-plan.md is not.
  const unitRow = (s: Store, slug: string) => s.db.query("SELECT * FROM units WHERE project = 'fx' AND squad = 'demo' AND slug = ?").get(slug) as Row;
  const reason = (s: Store, slug: string) => JSON.parse(String(unitRow(s, slug).doc ?? "{}")).hold_reason ?? null;
  const builders = (s: Store) => members(s, "demo").filter((m) => m.role === "builder").map((m) => String(m.suffix));
  // The U158 suspend; the squad is paused first so no Builder is dispatched before it lands.
  async function suspendDemo(s: Store, tick: (n?: number) => Promise<void>) {
    s.pause({ scope: "squad", project: "fx", squad: "demo" }, { source: "manual", by: "suspend-squad" });
    seedWorkers(s, "demo", "running");
    s.want("squad", "fx/demo", "suspended", { by: "suspend-squad" });
    await tick();
    seedWorkers(s, "demo", "none");
    await tick(2);
    expect(squad(s, "demo").status).toBe("suspended");
  }

  test("resume holds the not-started approved units for the Thinker's plan check; dispatched units, unapproved plans and existing holds are left alone", async () => {
    const { s, orca, tick } = await rig();
    await suspendDemo(s, tick);
    // A hold left from an earlier resume, approved again but not yet registered: the new resume drops its mark.
    s.db.run("UPDATE units SET hold = 1, doc = json_set(COALESCE(doc, '{}'), '$.hold', json('true'), '$.hold_reason', 'revalidate after resume', '$.revalidated', json('true')) WHERE project = 'fx' AND squad = 'demo' AND slug = 'u9-ext-archived'");
    const started = orca.started.length;
    s.want("squad", "fx/demo", "running", { by: "resume-squad" });
    await tick();
    expect(JSON.parse(String(unitRow(s, "u9-ext-archived").doc)).revalidated).toBeUndefined();
    const held = ["u6-takes-u5", "u8-waits", "u9-ext-archived", "u10-ext-missing"];
    for (const slug of held) { expect(unitRow(s, slug).hold).toBe(1); expect(reason(s, slug)).toBe("revalidate after resume"); }
    expect(unitRow(s, "u2-sqlite-store-migrations-and").hold).toBe(0);   // dispatched: its Builder goes on
    expect(unitRow(s, "u3-loop-daemon-skeleton-health").hold).toBe(0);   // plan not approved
    expect(reason(s, "u7-held")).toBeNull();                              // its own hold stays as it was
    const ev = s.db.query("SELECT payload FROM events WHERE kind = 'units_held_for_revalidation' AND project = 'fx' AND squad = 'demo'").all() as Row[];
    expect(ev).toHaveLength(1);
    expect(JSON.parse(String(ev[0].payload)).units.slice().sort()).toEqual(held.slice().sort());
    seedPicks(s, "demo");
    await tick(3);
    expect(builders(s).filter((b) => held.includes(b))).toEqual([]);   // nothing held was dispatched
    const thinker = orca.started.slice(started).find((x) => x.wt.includes("thinker"));
    expect(thinker?.args.join(" ")).toContain('held (why "revalidate after resume") until you check the plan');
    const lead = orca.started.slice(started).find((x) => x.wt.includes("lead"));
    expect(lead?.args.join(" ")).not.toContain("revalidate after resume");

    // The Thinker finds the plan still valid and releases one hold: that unit is ready again.
    writeFileSync(join(s.root, ".loop-migrated"), "");
    const off = Bun.spawnSync([join(ROOT, "bin", "role", "squad-state.sh"), join(s.root, "fx", "squads", "demo.json"), "set-unit-hold", "u8-waits", "off"], { env: { ...process.env, DS_STATE_ROOT: s.root } });
    expect(off.exitCode).toBe(0);
    expect(unitRow(s, "u8-waits").hold).toBe(0);
    await tick();
    expect(builders(s).filter((b) => held.includes(b))).toEqual(["u8-waits"]);
  });

  test("resume of a testing squad, and a plain pause and resume, hold nothing", async () => {
    const { s, tick } = await rig();
    const holds = () => (s.db.query("SELECT COUNT(*) AS n FROM units WHERE project = 'fx' AND squad = 'demo' AND hold = 1").get() as Row).n;
    const before = holds();
    s.pause({ scope: "squad", project: "fx", squad: "demo" }, { source: "manual", by: "test" });
    await tick();
    s.resume({ scope: "squad", project: "fx", squad: "demo" });
    await tick();
    expect(holds()).toBe(before);
    s.db.run("UPDATE squads SET type = 'testing' WHERE project = 'fx' AND topic = 'demo'");
    await suspendDemo(s, tick);
    s.want("squad", "fx/demo", "running", { by: "resume-squad" });
    await tick();
    expect(squad(s, "demo").status).toBe("running");
    expect(holds()).toBe(before);
  });

  test("a pre-U158 suspended squad with a live agent gets its pause flow", async () => {
    const { s, tick } = await rig();
    s.db.run("UPDATE squads SET status = 'suspended', want = 'suspended', want_result = 'done: suspended' WHERE project = 'fx' AND topic = 'demo'");
    seedWorkers(s, "demo", "running");
    await tick(2);
    const intent = s.db.query("SELECT * FROM pause_intents WHERE scope = 'squad' AND project = 'fx' AND squad = 'demo' AND cleared_at IS NULL").get() as Row;
    expect(intent).not.toBeNull();
  });
});

describe("squad archive (U158)", () => {
  test("archive closes a live agent, removes worktrees, leaves PRs alone and takes the squad off the live board", async () => {
    const { s, orca, tick } = await rig();
    const lead = members(s, "demo").find((m) => m.role === "lead")!;
    s.upsert("coordinators", { project: "fx", squad: "demo" }, { handle: "term_loop", run_id: "run_fixture01", created_at: T, bound_at: T });
    orca.agent(String(lead.wt), "term_lead");
    seedWorkers(s, "demo", "none");
    s.upsert("observed_workers", { project: "fx", wt: lead.wt }, { presence: "running", state: "idle", observed_at: T, account_at: T });
    const prBefore = (s.db.query("SELECT pr FROM units WHERE project = 'fx' AND squad = 'demo' ORDER BY id").all() as Row[]).map((u) => u.pr);
    const { readdirSync: readDir } = await import("node:fs");
    const archBefore = existsSync(join(s.root, "fx", "archive")) ? readDir(join(s.root, "fx", "archive")) : [];
    // A registered cleanup command runs on archive, as close-squad.sh ran it.
    const marker = join(s.root, "cleanup-ran");
    const sq = squad(s, "demo"), doc0 = JSON.parse(String(sq.doc)) as Row;
    s.upsert("squads", { id: sq.id }, { doc: JSON.stringify({ ...doc0, cleanup: [`touch ${marker}`] }) });
    s.want("squad", "fx/demo", "gone", { by: "close-squad" });
    await tick(2);
    // The observer would now read the stopped Lead as gone; the remove and archive follow.
    seedWorkers(s, "demo", "none");
    await tick(3);
    expect(orca.of("worker-stop").length).toBeGreaterThanOrEqual(1);   // the live Lead was closed
    const r = squad(s, "demo");
    expect(r.status).toBe("closed");
    expect(String(r.want_result)).toContain("archived");
    expect(existsSync(join(s.root, "fx", "squads", "demo.json"))).toBe(false);
    const arch = join(s.root, "fx", "archive");
    const { readdirSync } = await import("node:fs");
    const archived = readdirSync(arch).filter((f) => f.startsWith("demo-") && f.endsWith(".json") && !archBefore.includes(f));
    expect(archived.length).toBe(1);
    const doc = JSON.parse(readFileSync(join(arch, archived[0]), "utf8")) as Row;
    expect(doc.status).toBe("closed");
    expect((s.db.query("SELECT pr FROM units WHERE project = 'fx' AND squad = 'demo' ORDER BY id").all() as Row[]).map((u) => u.pr)).toEqual(prBefore);
    expect(existsSync(marker)).toBe(true);
    // Re-spawning the archived topic makes a new Run instead of a silent no-op.
    const runsBefore = orca.of("run-create").length;
    s.want("squad", "fx/demo", "running", { payload: { repo: "path:/nonexistent/fixture-repo", type: "feature" }, by: "spawn-squad" });
    await tick(2);
    expect(orca.of("run-create").length).toBe(runsBefore + 1);
    expect(String(squad(s, "demo").run_id)).toMatch(/^run_/);
    expect(squad(s, "demo").status).toBe("running");
  });

  test("closing a pre-U158 suspended squad whose worktrees are already gone archives it (stale wt)", async () => {
    const { s, tick } = await rig();
    s.db.run("UPDATE squads SET status = 'suspended', want = 'suspended', want_result = 'done: suspended' WHERE project = 'fx' AND topic = 'demo'");
    seedWorkers(s, "demo", "none");   // worktrees removed by the old script; wt still recorded
    s.want("squad", "fx/demo", "gone", { by: "close-squad" });
    await tick(4);
    expect(squad(s, "demo").status).toBe("closed");
  });
});
