// slot-lanes.test.ts — adaptive-builder-capacity U3: the light lane in the Builder slot. With
// `max_light_builders` > 0 a unit marked `lane: light` (U1) starts in a light slot while every normal slot
// is taken, takes a normal slot only while no normal unit waits, and counts as normal once its CPU (U2,
// unit_cpu) passes `light_lane_cpu_h`. With `max_light_builders 0` slot() answers as it always did.
// Direct slot() checks on a small store (the shape blocker-slot.test.ts uses).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { noteLaneMove, slot } from "../../bin/loop/capacity/slot.ts";
import { slotted } from "../../bin/loop/reconcilers/ready.ts";

const T = 1_800_000_000;
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type UnitOpts = { light?: boolean; rule?: string; urgent?: boolean; cpuH?: number };
function setup(max: number, light: number, cpuH?: number) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "slot-lanes-")); roots.push(root);
  const store = open(root); stores.push(store);
  store.upsert("projects", { label: "p" }, { observed_at: 1 });
  store.upsert("squads", { project: "p", topic: "one" }, { status: "running", run_id: "run_one", repo: "path:/fake", lead_wt: "wt_lead", observed_at: 1, updated_at: 1 });
  const conf = (key: string, value: string) => store.upsert("config", { project: "p", file: "limits.conf", key }, { value, observed_at: T });
  conf("max_builders", String(max));
  conf("max_light_builders", String(light));
  if (cpuH != null) conf("light_lane_cpu_h", String(cpuH));
  const unit = (slug: string, status: string, o: UnitOpts = {}) => {
    store.upsert("units", { project: "p", squad: "one", slug },
      { status, builder_wt: "", tier: "standard", deps: "[]", observed_at: 1, updated_at: 1,
        doc: JSON.stringify({ slug, status, ...(o.light ? { lane: "light", ...(o.rule ? { lane_rule: o.rule } : {}) } : {}), ...(o.urgent ? { urgent: true } : {}) }) });
    if (o.cpuH != null) store.upsert("unit_cpu", { project: "p", squad: "one", slug }, { cpu_s: o.cpuH * 3600, wt: `wt_${slug}`, first_at: 1, updated_at: 1 });
  };
  const live = (slug: string) =>
    store.upsert("members", { project: "p", squad: "one", role: "builder", suffix: slug },
      { wt: `wt_${slug}`, status: "running", agent: "claude", model: "opus", observed_at: 1, updated_at: 1 });
  const waiting = (slug: string) =>
    store.upsert("members", { project: "p", squad: "one", role: "builder", suffix: slug },
      { wt: `wt_${slug}`, status: "waiting", want: "running", want_at: T, agent: "claude", model: "opus", observed_at: 1, updated_at: 1 });
  return { store, unit, live, waiting };
}
type F = ReturnType<typeof setup>;
const ask = (f: F, s: string) => slot(f.store, "p", { squad: "one", suffix: s }, T);
const moves = (f: F) => f.store.db.query("SELECT unit, payload FROM events WHERE kind = 'unit_lane_moved'").all() as { unit: string; payload: string }[];

test("a light unit starts in a free light slot while every normal slot is taken", () => {
  const f = setup(2, 1);
  for (const s of ["n1", "n2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("n3", "dispatched"); f.waiting("n3");                 // an older normal unit waits for a normal slot
  f.unit("l1", "dispatched", { light: true });
  expect(ask(f, "l1").ok).toBe(true);
  const n = ask(f, "n3");
  expect(n.ok).toBe(false);
  if (!n.ok) { expect(n.why).toBe("WAIT slot: p normal 2/2, light 0/1"); expect(n.limit).toBe(3); expect(n.live).toBe(2); }
});

test("a normal unit never takes a light slot", () => {
  const f = setup(2, 2);
  for (const s of ["n1", "n2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("n3", "dispatched");
  const r = ask(f, "n3");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.why).toBe("WAIT slot: p normal 2/2, light 0/2");
});

test("the light lane is full: the next light unit waits, and says both lanes", () => {
  const f = setup(2, 1);
  for (const s of ["n1", "n2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("l1", "dispatched", { light: true }); f.live("l1");
  f.unit("l2", "dispatched", { light: true });
  const r = ask(f, "l2");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.why).toBe("WAIT slot: p normal 2/2, light 1/1");
});

test("a light unit takes a free normal slot only while no normal unit waits", () => {
  const f = setup(2, 1);
  f.unit("l1", "dispatched", { light: true }); f.live("l1");   // the light slot is taken
  f.unit("l2", "dispatched", { light: true });
  expect(ask(f, "l2").ok).toBe(true);                          // two normal slots free, no normal unit waits
  f.unit("n9", "planned"); f.waiting("n9");                    // a younger normal unit asks
  expect(ask(f, "l2").ok).toBe(false);                         // so the light unit leaves the normal slot to it
  expect(ask(f, "n9").ok).toBe(true);
});

test("in the light lane the order is today's: the older light unit first", () => {
  const f = setup(2, 1);
  for (const s of ["n1", "n2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("l1", "dispatched", { light: true }); f.waiting("l1");
  f.unit("l2", "dispatched", { light: true }); f.waiting("l2");
  expect(ask(f, "l1").ok).toBe(true);
  expect(ask(f, "l2").ok).toBe(false);
});

test("a light unit past light_lane_cpu_h counts as normal, blocks the next normal start, and is recorded once", () => {
  const f = setup(2, 1, 3);
  f.unit("n1", "dispatched"); f.live("n1");
  f.unit("l1", "dispatched", { light: true, rule: "contracts-only", cpuH: 3.5 }); f.live("l1");
  f.unit("n2", "dispatched");
  const r = ask(f, "n2");
  expect(r.ok).toBe(false);                                    // normal 2/2 now: l1 moved
  if (!r.ok) expect(r.why).toBe("WAIT slot: p normal 2/2, light 0/1");
  f.unit("l2", "dispatched", { light: true });
  expect(ask(f, "l2").ok).toBe(true);                          // the light slot l1 left is free
  const m = moves(f);
  expect(m.length).toBe(1);
  expect(m[0].unit).toBe("l1");
  expect(JSON.parse(m[0].payload)).toEqual({ unit: "l1", cpu_h: 3.5, rule: "contracts-only", light_lane_cpu_h: 3 });
});

test("the procs observer's noteLaneMove records a move with no slot asked for, once, and only with the lane on", () => {
  const on = setup(2, 1, 3);
  on.unit("l1", "dispatched", { light: true, rule: "docs", cpuH: 3.2 }); on.live("l1");
  on.unit("l2", "dispatched", { light: true, cpuH: 1 }); on.live("l2");
  for (let i = 0; i < 2; i++) for (const s of ["l1", "l2"]) noteLaneMove(on.store, "p", "one", s);
  expect(moves(on).map((m) => m.unit)).toEqual(["l1"]);
  const off = setup(2, 0, 3);
  off.unit("l1", "dispatched", { light: true, cpuH: 9 }); off.live("l1");
  noteLaneMove(off.store, "p", "one", "l1");
  expect(moves(off)).toEqual([]);
});

test("a light unit under light_lane_cpu_h stays light", () => {
  const f = setup(2, 1, 3);
  f.unit("n1", "dispatched"); f.live("n1");
  f.unit("l1", "dispatched", { light: true, cpuH: 2.9 }); f.live("l1");
  f.unit("n2", "dispatched");
  expect(ask(f, "n2").ok).toBe(true);
  expect(moves(f)).toEqual([]);
});

test("a moved unit keeps running: over max_builders no new normal unit starts", () => {
  const f = setup(2, 1, 3);
  for (const s of ["n1", "n2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("l1", "dispatched", { light: true, cpuH: 4 }); f.live("l1");   // normal 3 of 2
  expect(slot(f.store, "p", { member: f.store.get("members", { project: "p", squad: "one", role: "builder", suffix: "l1" }) }, T).ok).toBe(true);
  f.unit("n3", "dispatched");
  const r = ask(f, "n3");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.why).toBe("WAIT slot: p normal 3/2, light 0/1");
  f.unit("l2", "dispatched", { light: true });
  expect(ask(f, "l2").ok).toBe(false);                         // total 3 = 2 + 1: the cap holds
});

test("an urgent unit still starts over every limit", () => {
  const f = setup(1, 1);
  f.unit("n1", "dispatched"); f.live("n1");
  f.unit("l1", "dispatched", { light: true }); f.live("l1");
  f.unit("n2", "planned", { urgent: true });
  expect(ask(f, "n2").ok).toBe(true);
});

test("planned queue: the light unit is ready on the light slot while the older normal unit waits", () => {
  const f = setup(2, 1);
  for (const s of ["n1", "n2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("n3", "planned");
  f.unit("l1", "planned", { light: true });
  expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0l1"]));
});

test("planned queue: a light unit does not take the normal slot a younger planned normal unit needs", () => {
  const f = setup(2, 1);
  f.unit("n1", "dispatched"); f.live("n1");
  f.unit("l0", "dispatched", { light: true }); f.live("l0");  // light 1/1, one normal slot free
  f.unit("l1", "planned", { light: true });
  f.unit("n3", "planned");
  expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0n3"]));
});

// max_light_builders 0: the same fixtures, lanes marked, answer exactly as the single lane does.
test("max_light_builders 0 gives today's answers and records nothing", () => {
  const f = setup(2, 0, 3);
  f.unit("n1", "dispatched"); f.live("n1");
  f.unit("l1", "dispatched", { light: true, cpuH: 9 }); f.live("l1");
  f.unit("l2", "dispatched", { light: true });
  f.unit("n2", "dispatched"); f.waiting("n2");
  for (const s of ["l2", "n2"]) {
    const r = ask(f, s);
    expect(r).toMatchObject({ ok: false, limit: 2, live: 2, why: "WAIT slot: p at max_builders 2" });
  }
  expect(moves(f)).toEqual([]);
  f.store.db.query("DELETE FROM members WHERE suffix = 'l1'").run();
  expect(ask(f, "n2").ok).toBe(true);                          // one slot free, n2 the only one that waits
  f.waiting("l2");                                              // l2 (lower unit id) waits too: oldest first, lane or not
  expect(ask(f, "l2").ok).toBe(true);
  expect(ask(f, "n2")).toMatchObject({ ok: false, live: 1, ahead: 1, why: "WAIT slot: p at max_builders 2" });
});
