// orca-lite-squad.test.ts — orca-backend-alternatives U16a part 1: a squad spawned on `orca-lite` runs
// end to end through the real orca-lite adapter (bin/backend/orca-lite.ts) on the fake Orca
// (bin/loop/fakes/orca.ts), with no test seam for the backend: the actuator makes orca-lite on its own
// Orca runner, the `orca` worktree provider makes the Lead's and the Builder's worktrees through
// wt-make (the Builder's nested under the Lead's), the tabs are opened with terminal-create and the
// launch line typed with terminal-type, and nothing about the squad touches a Run. Hermetic: a copy of
// the fixture state, a temp repo, DS_ORCA_WORKSPACES and the trusted HOME under the temp dir.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import decider from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { canon, git } from "../../bin/loop/io/worktrees.ts";
import { useOrca } from "../../bin/loop/io/providers/orca.ts";
import { chooseSquadBackend } from "../../bin/backend/registry.ts";
import { studioOn } from "./studio-on.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const SQ = "onlite";
const ENV = ["DS_LOOP_RETRY_S", "DS_ORCA_WORKSPACES", "DS_CLAUDE_SYSTEM_JSON_DIR", "DS_TOKEN_CACHE"] as const;

const temps: string[] = [], stores: Store[] = [];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
afterEach(() => {
  useOrca(null);
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const reconcilers = await load<Reconciler>(DIRS.reconcilers);
const system: Picker = async () => ({ agent: "claude", model: "opus", effort: null, account: "system" });

async function rig() {
  const d = canon(mkdtempSync(join(tmpdir(), "zzorcalite-"))); temps.push(d);
  const state = join(d, "state"), repo = join(d, "repo"), home = join(d, "home");
  cpSync(FIXTURE, state, { recursive: true });
  for (const x of [repo, home]) mkdirSync(x);
  for (const a of [["init", "-q", "-b", "main"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]]) {
    const g = await git(["-C", repo, ...a]);
    if (g.code !== 0) throw new Error(g.err);
  }
  writeFileSync(join(home, ".claude.json"), `${JSON.stringify({ numStartups: 1 })}\n`);
  process.env.DS_LOOP_RETRY_S = "1";
  process.env.DS_CLAUDE_SYSTEM_JSON_DIR = home;
  process.env.DS_TOKEN_CACHE = "0";
  const orca = new FakeOrca();
  orca.wtRoot = process.env.DS_ORCA_WORKSPACES = join(d, "ws");
  useOrca(orca);   // the `orca` worktree provider on the same fake Orca
  const s = open(state); stores.push(s);
  importJson(s);
  for (const [role, value] of [["lead", "claude sonnet always"], ["thinker", "claude opus ondemand"], ["builder", "claude opus ondemand"]] as const)
    s.upsert("config", { project: "fx", file: "roles.conf", key: role }, { value, observed_at: T });
  s.upsert("projects", { label: "fx" }, { doc: JSON.stringify({ ...JSON.parse(String(s.get("projects", { label: "fx" })?.doc ?? "{}")), studio_backend: "orca-lite" }), observed_at: T });   // U57: the Studio's backend
  studioOn(s, "fx", "orca-lite", T);   // U54: one backend per project
  const act = new LoopActuator({ orca, pick: system, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
  // What spawn-squad writes for a project whose Studio runs on orca-lite (registry.ts).
  const c = chooseSquadBackend({ studioBackend: "orca-lite", which: () => "/usr/bin/orca" });
  if (!c.ok) throw new Error(c.error);
  s.want("squad", `fx/${SQ}`, "running", { payload: { repo: `path:${repo}`, type: "feature" },
    fill: { repo: `path:${repo}`, type: "feature", backend: c.backend, worktree_provider: c.provider }, by: "test" });
  return { s, orca, tick, now: () => at, d, repo };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const members = (s: Store) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = ? AND COALESCE(status, '') != 'gone' ORDER BY id").all(SQ) as Row[];
const pathOf = (m: Row) => String(m.wt).replace(/^local::/, "");
const running = (r: Rig, m: Row) => r.s.upsert("observed_workers", { project: "fx", wt: String(m.wt) }, { state: "idle", walk: "running", presence: "running", observed_at: r.now() });
async function started(r: Rig, find: () => Row | undefined): Promise<Row> {
  for (let i = 0; i < 10 && !String(find()?.wt ?? "").startsWith("local::"); i++) await r.tick();
  const m = find()!;
  expect(String(m.wt)).toStartWith("local::");
  running(r, m);
  return m;
}

test("a squad on orca-lite: Lead and Builder in Orca-made worktrees, nested, tabs opened, no Run", async () => {
  const r = await rig();
  const lead = await started(r, () => members(r.s).find((m) => m.role === "lead"));
  r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, observed_at, updated_at) VALUES ('fx', ?, 'builder', 'u1', 'claude', 'opus', 'system', ?, ?)", [SQ, T, T]);
  const id = Number((r.s.db.query("SELECT id FROM members WHERE squad = ? AND suffix = 'u1'").get(SQ) as Row).id);
  r.s.want("member", String(id), "running", { payload: { prompt: "build u1" } });
  const b = await started(r, () => members(r.s).find((m) => m.id === id));
  const lp = pathOf(lead), bp = pathOf(b), ws = join(r.d, "ws", "repo");
  expect(lp).toStartWith(ws);
  expect(bp).toStartWith(ws);
  // Orca made both worktrees (wt-make, no agent): the Builder's nested under the Lead's, as Orca's window shows it.
  const lw = r.orca.wts.get(lp)!, bw = r.orca.wts.get(bp)!;
  expect(bw.parent).toBe(lw.id);
  for (const [p, w] of [[lp, lw], [bp, bw]] as const)
    expect(r.s.get("worktrees", { host: "local", path: p })).toMatchObject({ provider: "orca", orca_id: w.id, squad: SQ });
  // One tab per member, opened in its worktree with the identity exported, the launch line typed once.
  const tabs = r.orca.of("terminal-create").filter((c) => String(c.args[0]).includes(ws));
  expect(tabs.map((c) => c.args[0])).toEqual([lw.id, bw.id]);
  expect(tabs[1].args[2]).toContain(`DS_BACKEND='orca-lite'`);
  expect(tabs[1].args[2]).toContain(`DS_MEMBER='fx/${SQ}/builder-u1'`);
  const row = r.s.db.query("SELECT * FROM orca_calls WHERE op = 'terminal.create' AND payload LIKE ?").get(`%${bp}%`) as Row;
  expect(row.state).toBe("completed");
  expect(tabs[1].args[2]).toContain(`DS_GEN='${row.retry_id}'`);
  expect(r.orca.of("terminal-type").filter((c) => String(c.args[1]).startsWith("exec bash "))).toHaveLength(2);
  // No Run, task, coordinator or worker start for this squad.
  expect(r.s.db.query("SELECT run_id, task_id FROM squads WHERE project = 'fx' AND topic = ?").get(SQ)).toEqual({ run_id: null, task_id: null });
  const runOps = r.orca.calls.filter((c) => /^(run-|worker-|task-|adopt|dispatch)/.test(c.op) && JSON.stringify(c).includes(SQ));
  expect(runOps).toEqual([]);
});

// U21f: the tree stays in Orca for an orca-lite squad: Studio (on Orca) > Lead > the Lead's other members.
describe("orca-lite squad nesting (U21f)", () => {
  const STUDIO_PATH = "/orca/studio-wt";
  async function nested() {
    const r = await rig();
    r.orca.wts.set(STUDIO_PATH, { id: "wt-studio", path: STUDIO_PATH, repo: "r", branch: "studio", parent: null });
    r.s.db.run("UPDATE projects SET studio_wt = ? WHERE label = 'fx'", [`studio-repo::${STUDIO_PATH}`]);   // Orca's `<id>::<path>` form
    const lead = await started(r, () => members(r.s).find((m) => m.role === "lead"));
    r.s.db.run("INSERT INTO members (project, squad, role, suffix, agent, model, account, observed_at, updated_at) VALUES ('fx', ?, 'thinker', '', 'claude', 'opus', 'system', ?, ?)", [SQ, T, T]);
    const id = Number((r.s.db.query("SELECT id FROM members WHERE squad = ? AND role = 'thinker'").get(SQ) as Row).id);
    r.s.want("member", String(id), "running", { payload: { prompt: "think" } });
    const th = await started(r, () => members(r.s).find((m) => m.id === id));
    return { r, lead, th };
  }
  const observe = (r: Rig, m: Row, parent: string | null) =>
    r.s.upsert("observed_worktrees", { project: "fx", wt: String(m.wt) }, { path: pathOf(m), branch: "b", parent, observed_at: r.now(), gone_at: null });
  const sets = (r: Rig) => r.orca.of("wt-set-parent");

  test("the Lead starts under an Orca-form Studio, the Thinker under the Lead, and a hand move is repaired through the backend", async () => {
    const { r, lead, th } = await nested();
    expect(r.orca.wts.get(pathOf(lead))!.parent).toBe("wt-studio");
    expect(r.orca.wts.get(pathOf(th))!.parent).toBe(r.orca.wts.get(pathOf(lead))!.id);
    const before = sets(r).length;
    // A hand move in Orca: the Thinker is seen at the top level (the observer reads Orca's parent as a `local::` folder).
    r.orca.wts.get(pathOf(th))!.parent = null;
    observe(r, lead, `local::${STUDIO_PATH}`); observe(r, th, null);
    await r.tick(3);
    const made = sets(r).slice(before);
    expect(made.map((c) => c.args)).toEqual([[r.orca.wts.get(pathOf(th))!.id, r.orca.wts.get(pathOf(lead))!.id]]);
    // Seen under its Lead by folder: nothing more.
    observe(r, th, lead.wt as string);
    await r.tick(3);
    expect(sets(r)).toHaveLength(before + 1);
  }, 30_000);

  test("a squad on tmux files no wt-set-parent for a worktree seen under the wrong parent", async () => {
    const { r, lead, th } = await nested();
    r.s.db.run("DROP TRIGGER IF EXISTS squads_backend_once");   // test only: the backend is written once at spawn
    r.s.db.run("UPDATE squads SET backend = 'tmux' WHERE project = 'fx' AND topic = ?", [SQ]);
    const before = sets(r).length;
    observe(r, lead, null); observe(r, th, null);
    await r.tick(3);
    expect(sets(r)).toHaveLength(before);
  }, 30_000);
});
