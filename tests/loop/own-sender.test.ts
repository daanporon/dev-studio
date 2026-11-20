// own-sender.test.ts — U210: a squad created `from` an asker's terminal is held by that terminal only
// until its Lead has a worktree; then the loop opens its own `ds-loop <squad>` pane and takes the Run.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000, RUN = "run_fixture01", ASKER = "term_asker";
const temps: string[] = [], stores: Store[] = [];
const env = process.env.DS_STATE_ROOT;
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (env === undefined) delete process.env.DS_STATE_ROOT; else process.env.DS_STATE_ROOT = env;
});
const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);

// The squad's Run is held by the asker's terminal (no pane_key), as fulfil/squad.ts leaves it.
async function rig(o: { lead?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "zzown-")); temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d); stores.push(s);
  importJson(s);
  process.env.DS_STATE_ROOT = d;
  const orca = new FakeBackend();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const lead = String((s.db.query("SELECT lead_wt FROM squads WHERE project = 'fx' AND topic = 'demo'").get() as Row).lead_wt);
  orca.terminals.set(ASKER, { pane: "tab0:leaf0", wt: "wt-asker" });
  await orca.run("adopt", [RUN], { from: ASKER });
  s.db.run("DELETE FROM coordinators WHERE project = 'fx' AND squad = 'demo'");
  s.db.run("INSERT INTO coordinators (project, squad, run_id, handle, pane_key, wt, created_at, bound_at) VALUES ('fx', 'demo', ?, ?, NULL, NULL, ?, ?)", [RUN, ASKER, T, T]);
  if (o.lead === false) s.db.run("UPDATE squads SET lead_wt = NULL WHERE project = 'fx' AND topic = 'demo'");
  // A tick re-reads the Lead's worktree from the squad's state file, so a squad still without one is
  // driven through seats() alone.
  const tick = async (at: number) => {
    if (o.lead === false) { await act.seats({ store: s, project: "fx", now: at } as never); return; }
    const r = await loop.tick(at); await act.drain(); return r;
  };
  const rebound = () => s.db.query("SELECT payload FROM events WHERE kind = 'coordinator_rebound'").all() as Row[];
  const row = () => s.db.query("SELECT * FROM coordinators WHERE project = 'fx' AND squad = 'demo'").get() as Row;
  const panes = () => orca.of("terminal-create").filter((c) => String(c.args?.[1] ?? c.argv?.[1] ?? "").includes("ds-loop demo"));
  return { s, orca, tick, lead, rebound, row, panes };
}

test("once the Lead has a worktree the loop opens its own pane, adopts the Run and records the pane key; the next tick does nothing", async () => {
  const { orca, tick, lead, rebound, row, panes } = await rig();
  await tick(T + 5);
  expect(panes()).toHaveLength(1);
  const r = row();
  expect(r.handle).not.toBe(ASKER);
  expect(r.pane_key).toBeTruthy();
  expect(r.wt).toBe(lead);
  expect(r.run_id).toBe(RUN);
  expect(rebound()).toHaveLength(1);
  expect(JSON.parse(String(rebound()[0].payload)).was).toBe(ASKER);
  expect((await orca.run("run-coordinator", [RUN])).out.trim()).toBe(r.handle as string);
  await tick(T + 10);
  expect(panes()).toHaveLength(1);
  expect(rebound()).toHaveLength(1);
});

test("a squad with no Lead worktree yet keeps the asker's terminal", async () => {
  const { tick, rebound, row, panes } = await rig({ lead: false });
  await tick(T + 5);
  expect(panes()).toHaveLength(0);
  expect(row().handle).toBe(ASKER);
  expect(rebound()).toHaveLength(0);
});

test("a paused squad is left alone", async () => {
  const { s, tick, rebound, row, panes } = await rig();
  s.db.run("UPDATE squads SET status = 'suspended' WHERE project = 'fx' AND topic = 'demo'");
  await tick(T + 5);
  expect(panes()).toHaveLength(0);
  expect(row().handle).toBe(ASKER);
  expect(rebound()).toHaveLength(0);
});

test("a failed adopt is tried again next tick and opens no second pane", async () => {
  const { orca, tick, row, panes } = await rig();
  const real = orca.run.bind(orca);
  let fail = true;
  orca.run = (async (cmd: string, args: string[], via?: never) => {
    if (cmd === "adopt" && fail) return { code: 1, out: "", err: "refused" };
    return real(cmd, args, via);
  }) as typeof orca.run;
  await tick(T + 5);
  expect(row().run_id).toBe("");          // the new pane is kept, unbound
  expect(panes()).toHaveLength(1);
  fail = false;
  await tick(T + 10);
  expect(panes()).toHaveLength(1);
  expect(row().run_id).toBe(RUN);
  expect(row().pane_key).toBeTruthy();
});
