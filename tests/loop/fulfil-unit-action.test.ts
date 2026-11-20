// fulfil-unit-action.test.ts — squad-done-definition U5: the `unit-action` fulfiller behind the board's
// ⋯ menu on a Work units row. A copy of tests/fixtures/loop/state with a chain of units added to squad
// fx/demo (a <- b <- c, an unrelated d, and e that depends on the done u1).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { dependentsOf } from "../../bin/loop/fulfil/unit-action.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzua-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const file = join(d, "fx", "squads", "demo.json"), doc = JSON.parse(readFileSync(file, "utf8"));
  const u = (slug: string, deps: string[], extra: Record<string, unknown> = {}) => ({ slug, status: "planned", builder_wt: "", plan: "", plan_unit: "", deps, hold: false, tier: "standard", ...extra });
  doc.units = [...doc.units, u("ua", [], { hold: true }), u("ub", ["ua"]), u("uc", ["ub"]), u("ud", []), u("ue", ["u1-spike-loop-as-coordinator"])];
  writeFileSync(file, JSON.stringify(doc));
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}
const loaded = (await load<Fulfiller & Reconciler>(DIRS.fulfil)).filter((f) => f.kinds);
let snapOf: Store | null = null;
const fulfillers = loaded.map((f) => f.kinds.includes("unit-action") ? { ...f, async exec(a: any, x: any) { const r = await f.exec(a, x); if (snapOf) snap(snapOf); return r; } } : f) as typeof loaded;
function rig(s: Store) {
  snapOf = s; for (const k of Object.keys(seen)) delete seen[k];
  const act = new LoopActuator({ orca: new FakeOrca(), fulfillers });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  return async (at = T) => { await loop.tick(at); await act.drain(); };
}
const act = (s: Store, payload: unknown) => Number(s.requestAny("unit-action", payload, { project: "fx", squad: "demo", by: "board" }).row.id);
const result = (s: Store, id: number) => {
  const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) };
};
// A later tick re-reads the squad's file (these tests do not rewrite it), so the units' state is read right
// after each unit-action ran, through squad-state itself: slug -> [status, cancel_reason].
const seen: Record<string, [string, string | undefined]> = {};
const snap = (s: Store) => {
  const r = Bun.spawnSync([join(ROOT, "bin", "role", "squad-state.sh"), join(s.root, "fx", "squads", "demo.json"), "get"], { env: { ...process.env, DS_STATE_ROOT: s.root } });
  for (const u of JSON.parse(r.stdout.toString()).units as Row[]) seen[String(u.slug)] = [String(u.status), u.cancel_reason as string | undefined];
};
const cancelled = () => Object.entries(seen).filter(([, [st]]) => st === "cancelled").map(([slug, [, why]]) => [slug, why]).filter(([slug]) => /^u[a-e]$/.test(String(slug)));
const pokes = (s: Store) => (s.db.query("SELECT payload FROM requests WHERE kind = 'poke' AND squad = 'demo' ORDER BY id").all() as Row[]).map((r) => String(JSON.parse(String(r.payload)).text));

describe("unit-action", () => {
  test("dependentsOf walks the open dependents through others and skips closed ones", () => {
    const s = imported();
    expect(dependentsOf(s, "fx", "demo", "ua")).toEqual(["ub", "uc"]);
    expect(dependentsOf(s, "fx", "demo", "ud")).toEqual([]);
    expect(dependentsOf(s, "fx", "demo", "u1-spike-loop-as-coordinator")).toContain("ue");
  });

  test("cancel takes the unit and both dependents along with the reason and tells the Lead once", async () => {
    const s = imported(), tick = rig(s);
    const id = act(s, { action: "cancel", slug: "ua", why: "not needed" });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: true, cancelled: ["ua", "ub", "uc"] });
    expect(cancelled()).toEqual([["ua", "not needed (board)"], ["ub", "depends on ua, cancelled from the board"], ["uc", "depends on ua, cancelled from the board"]]);
    const told = pokes(s).filter((t) => t.includes("cancelled ua"));
    expect(told.length).toBe(1);
    expect(told[0]).toContain("ub, uc");
    expect(told[0]).toContain("not needed");
    await tick(T + 1);
    expect(pokes(s).filter((t) => t.includes("cancelled ua")).length).toBe(1);
  });

  test("cancel of a unit with no dependents cancels just it", async () => {
    const s = imported(), tick = rig(s);
    const id = act(s, { action: "cancel", slug: "ud", why: "dropped" });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: true, cancelled: ["ud"] });
    expect(cancelled()).toEqual([["ud", "dropped (board)"]]);
  });

  test("cancel of a done unit fails and cancels nothing", async () => {
    const s = imported(), tick = rig(s);
    const id = act(s, { action: "cancel", slug: "u1-spike-loop-as-coordinator", why: "x" });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: false });
    expect(cancelled()).toEqual([]);
  });

  test("release of a held unit in a paused squad resumes it and tells the Lead; a unit that is not held fails", async () => {
    const s = imported(), tick = rig(s);
    s.pause({ scope: "squad", project: "fx", squad: "demo" }, { by: "test" });
    const id = act(s, { action: "release", slug: "ua" });
    await tick();
    expect(result(s, id)).toMatchObject({ done: true, ok: true, released: "ua", resumed: true });
    expect(pokes(s).some((t) => t.includes("release ua"))).toBe(true);
    const bad = act(s, { action: "release", slug: "ud" });
    await tick(T + 1);
    expect(result(s, bad)).toMatchObject({ done: true, ok: false });
  });
});
