// slot-seats.test.ts — board-shows-host-brake U1: who holds each Builder seat and why (seats()), and
// which queued units would get a seat now (seatable()), read from the same line and walk slot() uses.
// Each case checks seats().used against the live count slot() reports in its WAIT slot reason, and
// seatable() against what slot() lets start. Direct calls on a small store (the slot-lanes.test.ts shape).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { liveWhy, queue, seatable, seats, slot } from "../../bin/loop/capacity/slot.ts";

const T = 1_800_000_000;
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type UnitOpts = { light?: boolean; urgent?: boolean; squad?: string };
function setup(max: number, light = 0) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "slot-seats-")); roots.push(root);
  const store = open(root); stores.push(store);
  store.upsert("projects", { label: "p" }, { observed_at: 1 });
  for (const topic of ["one", "two"])
    store.upsert("squads", { project: "p", topic }, { status: "running", run_id: `run_${topic}`, repo: "path:/fake", lead_wt: `wt_lead_${topic}`, observed_at: 1, updated_at: 1 });
  const conf = (key: string, value: string) => store.upsert("config", { project: "p", file: "limits.conf", key }, { value, observed_at: T });
  conf("max_builders", String(max));
  conf("max_light_builders", String(light));
  const unit = (slug: string, status: string, o: UnitOpts = {}) =>
    store.upsert("units", { project: "p", squad: o.squad ?? "one", slug },
      { status, builder_wt: "", tier: "standard", deps: "[]", observed_at: 1, updated_at: 1,
        doc: JSON.stringify({ slug, status, ...(o.light ? { lane: "light" } : {}), ...(o.urgent ? { urgent: true } : {}) }) });
  const member = (slug: string, set: Row, squad = "one") =>
    store.upsert("members", { project: "p", squad, role: "builder", suffix: slug },
      { wt: `wt_${slug}`, agent: "claude", model: "opus", observed_at: 1, updated_at: 1, ...set });
  // A Builder whose agent runs, as the observer reads it (`working`, `idle`, ...).
  const running = (slug: string, state: string, squad = "one") => {
    member(slug, { status: "running", started: "2026-01-01T00:00:00Z" }, squad);
    store.upsert("observed_workers", { project: "p", wt: `wt_${slug}` }, { state, presence: "running", started_at: 1, observed_at: T });
  };
  const waiting = (slug: string, squad = "one") => member(slug, { status: "waiting", want: "running", want_at: T }, squad);
  const row = (slug: string, squad = "one") => store.get("members", { project: "p", squad, role: "builder", suffix: slug }) as Row;
  return { store, unit, member, running, waiting, row };
}
type F = ReturnType<typeof setup>;
const ask = (f: F, s: string, squad = "one") => slot(f.store, "p", { squad, suffix: s }, T);
const whys = (f: F) => Object.fromEntries(seats(f.store, "p", T).holders.map((h) => [h.unit ?? h.suffix, h.why]));
const seated = (f: F, planned: { squad: string; suffix: string }[] = []) => seatable(f.store, "p", T, planned).map((e) => e.suffix);
// The live count slot() reports for a waiting asker.
function liveOf(f: F, s: string): number {
  const r = ask(f, s);
  expect(r.ok).toBe(false);
  return r.ok ? -1 : r.live;
}

test("every seat holder with its why, and used equals slot()'s live count (single lane)", () => {
  const f = setup(5);
  for (const s of ["w1", "i1", "p1", "r1", "s1", "q1"]) f.unit(s, "dispatched");
  f.running("w1", "working");
  f.running("i1", "idle");                                          // idle at its prompt: still a seat
  f.running("p1", "working");                                       // being paused, its agent still runs
  f.store.db.run(`INSERT INTO pause_intents (scope, project, squad, role, suffix, source, generation, requested_at) VALUES ('member', 'p', 'one', 'builder', 'p1', 'manual', 'g-p1', ?)`, [T]);
  // Restarting (U153): wished running, a restart newer than the observed process start.
  f.running("r1", "idle");
  f.member("r1", { want: "running", want_at: T, restart_at: T - 10, placed_at: 100 });
  f.member("s1", { status: "running", placed_at: T - 30 });         // placed in the spawn grace, not observed yet
  f.waiting("q1");
  expect(whys(f)).toEqual({ w1: "working", i1: "idle", p1: "pausing", r1: "restarting", s1: "starting" });
  const st = seats(f.store, "p", T);
  expect(st).toMatchObject({ limit: 5, light: 0, holds: 0, used: { normal: 5, light: 0 } });
  expect(liveOf(f, "q1")).toBe(5);
  for (const h of st.holders) expect(liveWhy(f.store, f.row(h.suffix), T)).toBe(h.why);
  // A paused Builder whose agent has gone holds nothing, and a gone worker holds nothing.
  f.store.upsert("observed_workers", { project: "p", wt: "wt_p1" }, { presence: "none" });
  expect(whys(f).p1).toBeUndefined();
  expect(seats(f.store, "p", T).used.normal).toBe(4);
  expect(ask(f, "q1").ok).toBe(true);                               // the freed seat is q1's
  expect(seated(f)).toEqual(["q1"]);
});

test("a starting Builder: lifecycle lock or a loop start slot (picks.slot = 1)", () => {
  const f = setup(3);
  f.unit("a", "dispatched"); f.unit("b", "dispatched");
  f.member("a", { status: "waiting", want: "running", want_at: T });
  f.store.upsert("picks", { member: Number(f.row("a").id) }, { project: "p", squad: "one", role: "builder", slot: 1, picked_at: T });
  f.member("b", { status: "running" });                             // never observed, `running`
  expect(whys(f)).toEqual({ a: "starting", b: "starting" });
});

test("a squad whose pause is resuming: its live Builders still hold their seats", () => {
  const f = setup(4);
  for (const s of ["a1", "a2", "a3"]) { f.unit(s, "dispatched", { squad: "two" }); f.running(s, "working", "two"); }
  f.unit("a4", "dispatched", { squad: "two" }); f.waiting("a4", "two");
  f.store.db.run(`INSERT INTO pause_members (project, squad, role, suffix, generation, state, requested_at) VALUES ('p', 'two', 'builder', 'a4', 'g-a4', 'resuming', ?)`, [T]);
  f.unit("b1", "dispatched"); f.running("b1", "idle");
  f.unit("b2", "dispatched"); f.waiting("b2");
  const st = seats(f.store, "p", T);
  expect(st.used.normal).toBe(4);
  expect(st.holders.filter((h) => h.squad === "two").map((h) => h.why)).toEqual(["working", "working", "working"]);
  expect(liveOf(f, "b2")).toBe(4);
});

test("a ds pick hold counts in used (not as a holder), as slot() counts it", () => {
  const f = setup(3);
  f.unit("a", "dispatched"); f.running("a", "working");
  f.unit("b", "dispatched"); f.waiting("b");
  f.store.event("pick", { project: "p", squad: "one", payload: { source: "ds pick", role: "builder", suffix: "shell" } });
  f.store.db.run("UPDATE events SET at = ? WHERE kind = 'pick'", [T - 10]);
  const st = seats(f.store, "p", T);
  expect(st).toMatchObject({ holds: 1, used: { normal: 2, light: 0 } });
  expect(st.holders.map((h) => h.suffix)).toEqual(["a"]);
  // One seat is left: b gets it, so slot() reports no wait; with one more holder it waits at 3.
  expect(ask(f, "b").ok).toBe(true);
  expect(seated(f)).toEqual(["b"]);
  f.unit("c", "dispatched"); f.running("c", "idle");
  expect(liveOf(f, "b")).toBe(3);
  expect(seated(f)).toEqual([]);
});

test("light lane on: used per lane and the holders' lanes", () => {
  const f = setup(2, 1);
  f.unit("n1", "dispatched"); f.running("n1", "working");
  f.unit("l1", "dispatched", { light: true }); f.running("l1", "idle");
  f.unit("n2", "dispatched"); f.running("n2", "working");
  f.unit("n3", "dispatched"); f.waiting("n3");
  const st = seats(f.store, "p", T);
  expect(st).toMatchObject({ limit: 2, light: 1, used: { normal: 2, light: 1 } });
  expect(Object.fromEntries(st.holders.map((h) => [h.suffix, h.lane]))).toEqual({ n1: "normal", l1: "light", n2: "normal" });
  const r = ask(f, "n3");
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.live).toBe(st.used.normal + st.used.light); expect(r.why).toBe("WAIT slot: p normal 2/2, light 1/1"); }
});

test("light lane off: a light unit counts as normal", () => {
  const f = setup(2);
  f.unit("l1", "dispatched", { light: true }); f.running("l1", "working");
  expect(seats(f.store, "p", T).used).toEqual({ normal: 1, light: 0 });
});

test("seatable: one free seat, a light and a normal unit waiting; slot() agrees per unit", () => {
  const f = setup(2, 1);
  f.unit("n1", "dispatched"); f.running("n1", "working");
  f.unit("n2", "dispatched"); f.running("n2", "working");
  f.unit("n3", "dispatched"); f.waiting("n3");                      // older, normal: no normal seat
  f.unit("l1", "dispatched", { light: true }); f.waiting("l1");     // the free light seat
  expect(seated(f)).toEqual(["l1"]);
  expect(ask(f, "l1").ok).toBe(true);
  expect(ask(f, "n3")).toMatchObject({ ok: false, ahead: 0 });     // l1, seated behind it, is not ahead
  // Single lane, one free seat: only the first in line.
  const g = setup(2);
  g.unit("a", "dispatched"); g.running("a", "working");
  g.unit("b", "dispatched"); g.waiting("b");
  g.unit("c", "dispatched"); g.waiting("c");
  expect(seated(g)).toEqual(["b"]);
  expect([ask(g, "b").ok, ask(g, "c").ok]).toEqual([true, false]);
});

test("seatable: an urgent unit over the limit is seated, as slot() lets it start", () => {
  for (const light of [0, 1]) {
    const f = setup(1, light);
    f.unit("a", "dispatched"); f.running("a", "working");
    if (light) { f.unit("l", "dispatched", { light: true }); f.running("l", "working"); }
    f.unit("old", "dispatched"); f.waiting("old");
    f.unit("hot", "dispatched", { urgent: true }); f.waiting("hot");
    expect(seated(f)).toEqual(["hot"]);
    expect([ask(f, "hot").ok, ask(f, "old").ok]).toEqual([true, false]);
  }
});

test("seatable: a planned unit whose Builder is live is left out, and counted once in seats()", () => {
  const f = setup(3);
  f.unit("a", "planned"); f.running("a", "working");               // its unit still reads planned
  f.unit("b", "planned");
  const planned = [{ squad: "one", suffix: "a" }, { squad: "one", suffix: "b" }];
  expect(queue(f.store, "p", T, planned).map((e) => e.suffix)).toEqual(["a", "b"]);   // the line lists it again
  expect(seated(f, planned)).toEqual(["b"]);
  expect(seats(f.store, "p", T).used.normal).toBe(1);
  expect(seats(f.store, "p", T).holders.map((h) => h.unit)).toEqual(["a"]);
});

test("seatable: a first-in-line Builder whose pick waits on an account is left out", () => {
  const f = setup(2);
  f.unit("a", "dispatched"); f.running("a", "working");
  f.unit("b", "dispatched"); f.waiting("b");
  f.unit("c", "dispatched"); f.waiting("c");
  f.store.upsert("picks", { member: Number(f.row("b").id) }, { project: "p", squad: "one", role: "builder", slot: 0,
    reason: "no account free", wait_until: T + 600, wait_known: 1, picked_at: T });
  // A start wait is not an account wait: c still counts.
  f.store.upsert("picks", { member: Number(f.row("c").id) }, { project: "p", squad: "one", role: "builder", slot: 0,
    reason: "WAIT host: load 160% ≥ crit 150%", picked_at: T });
  expect(seated(f)).toEqual(["c"]);
});

test("no max_builders: no limit, no seatable line, the holders still listed", () => {
  const f = setup(1);
  f.store.db.run("DELETE FROM config WHERE key = 'max_builders'");
  f.unit("a", "dispatched"); f.running("a", "working");
  f.unit("b", "dispatched"); f.waiting("b");
  expect(seats(f.store, "p", T)).toMatchObject({ limit: null, used: { normal: 1, light: 0 } });
  expect(seated(f)).toEqual([]);
});

test("seats() and seatable() write nothing", () => {
  const f = setup(2, 1);
  f.unit("l1", "dispatched", { light: true }); f.running("l1", "working");
  f.store.upsert("unit_cpu", { project: "p", squad: "one", slug: "l1" }, { cpu_s: 99 * 3600, wt: "wt_l1", first_at: 1, updated_at: 1 });
  f.unit("n1", "dispatched"); f.waiting("n1");
  const count = () => (f.store.db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
  const before = count();
  seats(f.store, "p", T); seatable(f.store, "p", T);
  expect(count()).toBe(before);                                     // no unit_lane_moved from a read
});
