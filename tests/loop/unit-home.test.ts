// unit-home.test.ts — U213: a unit follows its Builder's live worktree. reconcilers/unit-home.ts
// repoints a unit whose builder_wt no live member holds at the one live Builder named by its slug;
// the start in fulfil/member.ts moves every unit of the old worktree (shared Builders too).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

async function rig() {
  const d = mkdtempSync(join(tmpdir(), "zzhome-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  const reconcilers = await load<Reconciler>(DIRS.reconcilers);
  const act = new LoopActuator({ orca: new FakeOrca(), fulfillers: [] });
  const loop = new Loop(s, { observers: [], reconcilers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  let at = T;
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { at += 5; await loop.tick(at); await act.drain(); } };
  s.upsert("squads", { project: "fx", topic: "h" }, { run_id: "run_h", repo: "r", lead_wt: "L", status: "running", observed_at: T, updated_at: T });
  return { s, tick };
}
const member = (s: Store, role: string, suffix: string, wt: string | null, status = "running") =>
  s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, observed_at, updated_at) VALUES ('fx', 'h', ?, ?, ?, ?, ?, ?)", [wt, role, suffix, status, T, T]);
const unit = (s: Store, slug: string, wt: string | null, status = "dispatched") =>
  s.db.run("INSERT INTO units (project, squad, slug, status, builder_wt, observed_at, updated_at) VALUES ('fx', 'h', ?, ?, ?, ?, ?)", [slug, status, wt, T, T]);
const wtOf = (s: Store, slug: string) => (s.db.query("SELECT builder_wt FROM units WHERE project = 'fx' AND squad = 'h' AND slug = ?").get(slug) as Row).builder_wt;
const moves = (s: Store) => s.db.query("SELECT payload FROM events WHERE kind = 'unit_builder_moved'").all() as Row[];

describe("unit follows its Builder (U213)", () => {
  test("a unit whose old worktree has no member is repointed at the one live Builder with its slug, once", async () => {
    const { s, tick } = await rig();
    member(s, "lead", "", "L"); member(s, "builder", "u1", "B-2");
    unit(s, "u1", "B-old");
    await tick(3);
    expect(wtOf(s, "u1")).toBe("B-2");
    expect(moves(s)).toHaveLength(1);
    expect(JSON.parse(String(moves(s)[0].payload))).toEqual({ old: "B-old", new: "B-2" });
  });
  test("a shared Builder: both units of the old worktree end on its new one", async () => {
    const { s, tick } = await rig();
    member(s, "builder", "u1", "B-2");
    unit(s, "u1", "B-old"); unit(s, "u2", "B-old");
    await tick(3);
    expect([wtOf(s, "u1"), wtOf(s, "u2")]).toEqual(["B-2", "B-2"]);
    expect(moves(s)).toHaveLength(2);
  });
  test("no live Builder with the slug, or two of them, leaves the unit alone", async () => {
    const { s, tick } = await rig();
    member(s, "builder", "other", "B-x"); member(s, "builder", "u2", "B-a"); member(s, "builder", "u2", "B-b");
    member(s, "builder", "u3", null, "suspended");
    unit(s, "u1", "B-old"); unit(s, "u2", "B-old2"); unit(s, "u3", "B-old3");
    await tick(2);
    expect([wtOf(s, "u1"), wtOf(s, "u2"), wtOf(s, "u3")]).toEqual(["B-old", "B-old2", "B-old3"]);
    expect(moves(s)).toHaveLength(0);
  });
  test("a unit whose worktree a live member holds, and a done unit, are left alone", async () => {
    const { s, tick } = await rig();
    member(s, "builder", "u1", "B-1"); member(s, "builder", "u2", "B-2");
    unit(s, "u1", "B-1"); unit(s, "u2", "gone-wt", "done");
    await tick(2);
    expect([wtOf(s, "u1"), wtOf(s, "u2")]).toEqual(["B-1", "gone-wt"]);
  });
});
