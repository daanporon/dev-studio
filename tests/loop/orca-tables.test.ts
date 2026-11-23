// orca-tables.test.ts — 0055-orca-tables.sql (orca-backend-alternatives U6): every Orca-only value the
// loop holds also sits in an `orca_*` table. On a made-up database at the migration before it the
// backfill copies today's rows; after it the triggers copy every write, so a fake-Orca squad's start,
// dispatch and coordinator land in both places and agree, and the core tables gain no Orca column.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { migrate, open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { FakeBackend, FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { orcaObserver } from "../../bin/loop/observers/orca.ts";

const ROOT = join(import.meta.dir, "..", "..");
const MIGRATIONS = join(ROOT, "bin", "loop", "migrations");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const FILE = "0055-orca-tables.sql";
const T = 1_800_000_000;
const R = "0b5e0c1a-repo";
const id = (p: string) => `${R}::/w/${p}`;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.DS_LOOP_RETRY_S;
});
const all = (s: Store, sql: string, ...a: (string | number)[]) => s.db.query(sql).all(...a) as Row[];
const columns = (s: Store, table: string) => (s.db.query(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => String(c.name));

// Each orca_* table against the old columns it copies, in the same row shape, so agree() is one compare.
const PAIRS: [string, string, string][] = [
  ["runs", "SELECT project, topic AS squad, run_id, task_id FROM squads WHERE run_id IS NOT NULL OR task_id IS NOT NULL ORDER BY 1, 2",
    "SELECT project, squad, run_id, task_id FROM orca_runs WHERE run_id IS NOT NULL OR task_id IS NOT NULL ORDER BY 1, 2"],
  ["coordinators", "SELECT project, squad, run_id, handle, pane_key, wt, wt_path, created_at, bound_at FROM coordinators ORDER BY 1, 2",
    "SELECT project, squad, run_id, handle, pane_key, wt, wt_path, created_at, bound_at FROM orca_coordinators WHERE gone_at IS NULL ORDER BY 1, 2"],
  ["dispatches", "SELECT dispatch_id, project, wt, wt_path, first_seen FROM dispatches ORDER BY 1",
    "SELECT dispatch_id, project, wt, wt_path, first_seen FROM orca_dispatches ORDER BY 1"],
  ["workers", `SELECT project, wt, wt_path, dispatch_id, dispatch, dispatch_at, dispatch_seen_at FROM observed_workers
     WHERE dispatch_id IS NOT NULL OR dispatch IS NOT NULL OR dispatch_at IS NOT NULL OR dispatch_seen_at IS NOT NULL ORDER BY 1, 2`,
    `SELECT project, wt, wt_path, dispatch_id, dispatch, dispatch_at, dispatch_seen_at FROM orca_workers
     WHERE dispatch_id IS NOT NULL OR dispatch IS NOT NULL OR dispatch_at IS NOT NULL OR dispatch_seen_at IS NOT NULL ORDER BY 1, 2`],
  ["pauses", "SELECT project, squad, role, suffix, generation, dispatch, task_completed FROM pause_members WHERE dispatch IS NOT NULL OR task_completed != 0 ORDER BY 1, 2, 3, 4",
    "SELECT project, squad, role, suffix, generation, dispatch, task_completed FROM orca_pauses WHERE dispatch IS NOT NULL OR task_completed != 0 ORDER BY 1, 2, 3, 4"],
];
function agree(s: Store) {
  for (const [name, old, mirror] of PAIRS) expect([name, all(s, mirror)]).toEqual([name, all(s, old)]);
}

// A loop.db at the migration before FILE with a made-up project `realp`: a squad with a Run and task,
// one with only a Run, one not created yet; a squad coordinator and the outside pane; two dispatches;
// workers with and without one; a pause delivered under a dispatch and one not delivered.
function before(): Store {
  const root = mkdtempSync(join(tmpdir(), "zzorcatab-")); temps.push(root);
  const dir = join(root, "migrations"); mkdirSync(dir);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < FILE)) copyFileSync(join(MIGRATIONS, f), join(dir, f));
  const s = open(root, { migrations: dir }); stores.push(s);
  const run = (sql: string, ...a: (string | number | null)[]) => s.db.run(sql, a);
  run("INSERT INTO squads (id, project, topic, status, run_id, task_id, lead_wt, observed_at, updated_at) VALUES (1, 'realp', 'alpha', 'running', 'run_a', 'task_a', ?, 100, 100)", id("alpha-lead"));
  run("INSERT INTO squads (id, project, topic, status, run_id, observed_at, updated_at) VALUES (2, 'realp', 'beta', 'running', 'run_b', 100, 100)");
  run("INSERT INTO squads (id, project, topic, want, observed_at, updated_at) VALUES (3, 'realp', 'gamma', 'running', 100, 100)");
  run("INSERT INTO coordinators (project, squad, run_id, handle, pane_key, wt, created_at, bound_at) VALUES ('realp', 'alpha', 'run_a', 'term_a', 'ds-alpha', ?, 100, 110)", id("alpha-lead"));
  run("INSERT INTO coordinators (project, squad, run_id, handle, created_at) VALUES ('realp', '', '', 'term_out', 90)");
  run("INSERT INTO dispatches (dispatch_id, project, wt, first_seen) VALUES ('ctx_1', 'realp', ?, 120)", id("alpha-lead"));
  run("INSERT INTO dispatches (dispatch_id, project, wt, first_seen) VALUES ('ctx_2', 'realp', '/plain/alpha-u1', 130)");
  run("INSERT INTO observed_workers (project, wt, dispatch_id, dispatch, dispatch_at, dispatch_seen_at, observed_at) VALUES ('realp', ?, 'ctx_1', 'dispatched', 120, 140, 140)", id("alpha-lead"));
  run("INSERT INTO observed_workers (project, wt, dispatch_seen_at, observed_at) VALUES ('realp', ?, 140, 140)", id("alpha-thinker"));
  run("INSERT INTO observed_workers (project, wt, state, observed_at) VALUES ('realp', ?, 'idle', 140)", id("beta-lead"));
  run(`INSERT INTO pause_members (project, squad, role, suffix, generation, state, requested_at, dispatch, session, delivered_at, task_completed)
       VALUES ('realp', 'alpha', 'builder', 'u1', 'gen-1', 'pausing', 150, 'ctx_2', 'term_b', 151, 1)`);
  run("INSERT INTO pause_members (project, squad, role, suffix, generation, state, requested_at) VALUES ('realp', 'alpha', 'thinker', '', 'gen-2', 'pausing', 150)");
  return s;
}
const after = (s: Store) => { migrate(s.db); return s; };

describe("0055 orca tables", () => {
  test("the migration copies every Orca-only value already held, and nothing more", () => {
    const s = after(before());
    agree(s);
    expect(all(s, "SELECT squad, run_id, task_id FROM orca_runs ORDER BY squad")).toEqual([
      { squad: "alpha", run_id: "run_a", task_id: "task_a" }, { squad: "beta", run_id: "run_b", task_id: null }]);
    expect(all(s, "SELECT squad, handle, wt_path, gone_at FROM orca_coordinators ORDER BY squad")).toEqual([
      { squad: "", handle: "term_out", wt_path: null, gone_at: null }, { squad: "alpha", handle: "term_a", wt_path: "/w/alpha-lead", gone_at: null }]);
    expect(all(s, "SELECT dispatch_id, wt_path FROM orca_dispatches ORDER BY 1")).toEqual([
      { dispatch_id: "ctx_1", wt_path: "/w/alpha-lead" }, { dispatch_id: "ctx_2", wt_path: "/plain/alpha-u1" }]);
    expect(all(s, "SELECT wt_path, dispatch_id FROM orca_workers ORDER BY wt")).toEqual([
      { wt_path: "/w/alpha-lead", dispatch_id: "ctx_1" }, { wt_path: "/w/alpha-thinker", dispatch_id: null }]);   // beta-lead holds no dispatch value
    expect(all(s, "SELECT role, generation, dispatch, task_completed FROM orca_pauses")).toEqual([
      { role: "builder", generation: "gen-1", dispatch: "ctx_2", task_completed: 1 }]);   // the thinker's pause holds none yet
  });

  test("every later write lands in both places: insert, update, clear, delete and re-insert", () => {
    const s = after(before());
    // squads: a Run and task created, a re-spawn clearing them, a write of other columns only.
    s.upsert("squads", { id: 3 }, { run_id: "run_g", updated_at: 200 });
    s.upsert("squads", { id: 3 }, { task_id: "task_g", updated_at: 201 });
    s.upsert("squads", { id: 1 }, { run_id: null, task_id: null, updated_at: 202 });
    s.upsert("squads", { id: 2 }, { status: "done", updated_at: 203 });
    s.db.run("INSERT INTO squads (project, topic, run_id, observed_at, updated_at) VALUES ('realp', 'delta', 'run_d', 204, 204)");
    expect(all(s, "SELECT squad, run_id, task_id FROM orca_runs ORDER BY squad")).toEqual([
      { squad: "alpha", run_id: null, task_id: null }, { squad: "beta", run_id: "run_b", task_id: null },
      { squad: "delta", run_id: "run_d", task_id: null }, { squad: "gamma", run_id: "run_g", task_id: "task_g" }]);
    // coordinators: rebind, unbind, a re-spawn's delete (kept with gone_at), then a new coordinator.
    s.upsert("coordinators", { project: "realp", squad: "alpha" }, { handle: "term_a2", wt: id("alpha-lead2"), bound_at: 210 });
    s.upsert("coordinators", { project: "realp", squad: "" }, { run_id: "", bound_at: null });
    s.db.run("DELETE FROM coordinators WHERE project = 'realp' AND squad = 'alpha'");
    expect(all(s, "SELECT handle, wt_path, gone_at IS NOT NULL AS gone FROM orca_coordinators WHERE squad = 'alpha'")).toEqual([
      { handle: "term_a2", wt_path: "/w/alpha-lead2", gone: 1 }]);
    agree(s);
    s.upsert("coordinators", { project: "realp", squad: "alpha" }, { run_id: "run_a3", handle: "term_a3", created_at: 220 });
    expect(all(s, "SELECT handle, gone_at FROM orca_coordinators WHERE squad = 'alpha'")).toEqual([{ handle: "term_a3", gone_at: null }]);
    // dispatches: the observer's INSERT OR IGNORE, first sighting wins.
    s.db.run("INSERT OR IGNORE INTO dispatches (dispatch_id, project, wt, first_seen) VALUES ('ctx_3', 'realp', ?, 230)", [id("beta-lead")]);
    s.db.run("INSERT OR IGNORE INTO dispatches (dispatch_id, project, wt, first_seen) VALUES ('ctx_3', 'realp', ?, 231)", [id("other")]);
    // observed_workers: a new dispatch, a settle, a clear, and a write of other columns only.
    s.upsert("observed_workers", { project: "realp", wt: id("beta-lead") }, { dispatch_id: "ctx_3", dispatch: "dispatched", dispatch_at: 230, dispatch_seen_at: 230 });
    s.upsert("observed_workers", { project: "realp", wt: id("alpha-lead") }, { dispatch: "completed", dispatch_at: 232 });
    s.upsert("observed_workers", { project: "realp", wt: id("alpha-thinker") }, { dispatch_seen_at: 233 });
    s.upsert("observed_workers", { project: "realp", wt: id("alpha-lead") }, { state: "busy", observed_at: 234 });
    const kept = all(s, "SELECT * FROM orca_workers WHERE wt = ?", id("alpha-lead"));
    s.upsert("observed_workers", { project: "realp", wt: id("alpha-lead") }, { tail: "> hi", observed_at: 235 });
    expect(all(s, "SELECT * FROM orca_workers WHERE wt = ?", id("alpha-lead"))).toEqual(kept);   // no write without a dispatch change
    s.upsert("observed_workers", { project: "realp", wt: id("alpha-lead") }, { dispatch_id: null, dispatch: null, dispatch_at: null });
    s.db.run("INSERT INTO observed_workers (project, wt, state, observed_at) VALUES ('realp', ?, 'idle', 236)", [id("fresh")]);
    expect(s.get("orca_workers", { project: "realp", wt: id("fresh") })).toBeNull();
    // pause_members: delivered under a dispatch, then the generation cleared back to active.
    s.upsert("pause_members", { project: "realp", squad: "alpha", role: "thinker", suffix: "" }, { dispatch: "ctx_9", session: "term_t", delivered_at: 240 });
    s.upsert("pause_members", { project: "realp", squad: "alpha", role: "builder", suffix: "u1" }, { generation: "gen-3", state: "active", dispatch: null, task_completed: 0 });
    expect(all(s, "SELECT role, generation, dispatch, task_completed FROM orca_pauses ORDER BY role")).toEqual([
      { role: "builder", generation: "gen-3", dispatch: null, task_completed: 0 }, { role: "thinker", generation: "gen-2", dispatch: "ctx_9", task_completed: 0 }]);
    agree(s);
  });

  test("the core tables gain no Orca column: the copies live in orca_* tables only", () => {
    const old = before(), had = Object.fromEntries(["squads", "coordinators", "dispatches", "observed_workers", "pause_members", "members"].map((t) => [t, columns(old, t)]));
    after(old);
    for (const [t, cols] of Object.entries(had)) expect([t, columns(old, t)]).toEqual([t, cols]);
    expect(all(old, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orca\\_%' ESCAPE '\\' ORDER BY name").map((r) => r.name))
      .toEqual(["orca_calls", "orca_coordinators", "orca_dispatches", "orca_pauses", "orca_runs", "orca_workers"]);
  });
});

describe("a fake-Orca squad", () => {
  const fulfillers = load<Fulfiller & Reconciler>(DIRS.fulfil);
  test("its start, dispatch and coordinator land in both places and agree", async () => {
    const d = mkdtempSync(join(tmpdir(), "zzorcasq-")); temps.push(d);
    cpSync(FIXTURE, d, { recursive: true });
    const s = open(d); stores.push(s);
    importJson(s);
    agree(s);   // the fixture's squads, imported through the store
    process.env.DS_LOOP_RETRY_S = "1";
    for (const [role, value] of [["lead", "claude sonnet always"], ["thinker", "claude opus always"]] as const)
      s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
    const orca = new FakeBackend(), seen = FakeOrca.recorded(join(ROOT, "tests", "fixtures", "loop", "orca")), fs = await fulfillers;   // the actuator's backend, the observer's reads
    const act = new LoopActuator({ orca, fulfillers: fs.filter((f) => f.kinds) });
    const loop = new Loop(s, { observers: [orcaObserver(seen)], reconcilers: [decider, ...(await load<Reconciler>(DIRS.reconcilers)), ...fs] }, act, { projects: () => ["fx"] });
    loop.boot(T);
    let at = T;
    const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };

    const repo = "path:/nonexistent/fixture-repo";
    s.want("squad", "fx/orc1", "running", { payload: { repo, type: "feature", from: "term_asker" }, fill: { repo, type: "feature" }, by: "spawn-squad" });
    await tick();
    const sq = s.db.query("SELECT * FROM squads WHERE project = 'fx' AND topic = 'orc1'").get() as Row;
    expect(String(sq.run_id)).toMatch(/^run_/);
    expect(String(sq.task_id)).toMatch(/^task_/);
    expect(s.get("orca_runs", { project: "fx", squad: "orc1" })).toMatchObject({ run_id: sq.run_id, task_id: sq.task_id });
    expect(s.get("orca_coordinators", { project: "fx", squad: "orc1" })).toMatchObject({ run_id: sq.run_id, handle: "term_asker", gone_at: null });

    // The Lead starts (its pick seeded as the pick reconciler writes it) and the Run dispatches it: the
    // observer's read lands in observed_workers and dispatches, and in orca_workers and orca_dispatches.
    for (const m of all(s, "SELECT id, role FROM members WHERE project = 'fx' AND squad = 'orc1'"))
      s.upsert("picks", { member: m.id }, { project: "fx", squad: "orc1", role: m.role, agent: "claude", model: m.role === "lead" ? "sonnet" : "opus", slot: 1, picked_at: T });
    await tick(2);
    const wt = String((s.db.query("SELECT wt FROM members WHERE project = 'fx' AND squad = 'orc1' AND role = 'lead'").get() as Row).wt);
    expect(wt).toContain("orc1");
    s.upsert("observed_workers", { project: "fx", wt }, { presence: "live", state: "idle", observed_at: at });
    seen.worktrees.push({ ...seen.worktrees[0], worktreeId: wt, path: wt.split("::")[1], branch: "orc1-lead" });
    seen.runs.set(String(sq.run_id), [{ wt, id: "ctx_orc1", status: "dispatched" }]);
    await tick();
    expect(seen.calls.dispatches).toContain(String(sq.run_id));
    expect(s.get("observed_workers", { project: "fx", wt })).toMatchObject({ dispatch_id: "ctx_orc1", dispatch: "dispatched" });
    expect(s.get("orca_workers", { project: "fx", wt })).toMatchObject({ dispatch_id: "ctx_orc1", dispatch: "dispatched" });
    expect(s.get("orca_dispatches", { dispatch_id: "ctx_orc1" })).toMatchObject({ project: "fx", wt });
    agree(s);
  });
});
