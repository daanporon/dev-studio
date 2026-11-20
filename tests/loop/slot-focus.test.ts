// slot-focus.test.ts — squad-priority U1: the focus squad's queued Builder work takes the next free seat,
// after urgent and unblocking work and inside the limit; the last seat of each lane still goes oldest
// first; a focus that does not count (suspended, no limit, nothing asking) changes nothing; a closed
// squad's focus is cleared; every change logs one `focus_set`; slotted() and the board read the line
// slot() walks. Direct slot() checks on a small store (the shape slot-lanes.test.ts uses).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { DIRS, load, type Reconciler, type TickCtx } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { queue, slot } from "../../bin/loop/capacity/slot.ts";
import { readyLine, slotted } from "../../bin/loop/reconcilers/ready.ts";
import focusReconciler from "../../bin/loop/reconcilers/focus.ts";
import { historyOf, set } from "../../bin/loop/settings/settings.ts";
import { focusSquad } from "../../bin/loop/squad/focus.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const T = 1_800_000_000;
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type UnitOpts = { light?: boolean; urgent?: boolean; deps?: string[]; hold?: boolean };
// Squads `one` (the focus in most tests) and `two`, both live feature squads. Units are numbered in the
// order they are made, so the one made first is the older.
function setup(max: number | null, light = 0) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "slot-focus-")); roots.push(root);
  const store = open(root); stores.push(store);
  store.upsert("projects", { label: "p" }, { observed_at: 1 });
  for (const topic of ["one", "two"])
    store.upsert("squads", { project: "p", topic }, { status: "running", run_id: `run_${topic}`, repo: "path:/fake", lead_wt: `wt_lead_${topic}`, observed_at: 1, updated_at: 1 });
  const conf = (key: string, value: string) => store.upsert("config", { project: "p", file: "limits.conf", key }, { value, observed_at: T });
  if (max != null) conf("max_builders", String(max));
  conf("max_light_builders", String(light));
  const unit = (squad: string, slug: string, status: string, o: UnitOpts = {}) =>
    store.upsert("units", { project: "p", squad, slug },
      { status, builder_wt: "", tier: "standard", deps: JSON.stringify(o.deps ?? []), hold: o.hold ? 1 : null, observed_at: 1, updated_at: 1,
        doc: JSON.stringify({ slug, status, ...(o.light ? { lane: "light" } : {}), ...(o.urgent ? { urgent: true } : {}) }) });
  const member = (squad: string, slug: string, waits: boolean) =>
    store.upsert("members", { project: "p", squad, role: "builder", suffix: slug },
      { wt: `wt_${squad}_${slug}`, status: waits ? "waiting" : "running", ...(waits ? { want: "running", want_at: T } : {}),
        agent: "claude", model: "opus", observed_at: 1, updated_at: 1 });
  // A dispatched unit with a live Builder, and a dispatched unit whose Builder waits for a seat.
  const live = (squad: string, slug: string, o: UnitOpts = {}) => { unit(squad, slug, "dispatched", o); member(squad, slug, false); };
  const waiting = (squad: string, slug: string, o: UnitOpts = {}) => { unit(squad, slug, "dispatched", o); member(squad, slug, true); };
  const focus = (squad: string) => conf("focus_squad", squad);
  return { store, root, unit, member, live, waiting, focus, conf };
}
type F = ReturnType<typeof setup>;
const ask = (f: F, squad: string, slug: string) => slot(f.store, "p", { squad, suffix: slug }, T);
const ok = (f: F, squad: string, slug: string) => ask(f, squad, slug).ok;
const focusEvents = (s: Store) =>
  (s.db.query("SELECT squad, payload FROM events WHERE kind = 'focus_set' ORDER BY id").all() as Row[]).map((e) => ({ squad: e.squad, ...JSON.parse(String(e.payload)) }));

describe("the next free seat", () => {
  test("a focus unit takes it ahead of an older unit of another squad", () => {
    const f = setup(3);
    f.live("two", "x1"); f.live("two", "x2");                    // 2/3 live, one seat free
    f.waiting("two", "old");                                     // older, another squad
    f.waiting("one", "f1");
    expect([ok(f, "two", "old"), ok(f, "one", "f1")]).toEqual([true, false]);   // no focus: oldest first
    f.focus("one");
    expect([ok(f, "two", "old"), ok(f, "one", "f1")]).toEqual([false, true]);
    const w = ask(f, "two", "old");
    if (!w.ok) { expect(w.why).toBe("WAIT slot: p at max_builders 3"); expect(w.ahead).toBe(1); }
  });

  test("an urgent unit and a unit that blocks started work still go ahead of the focus", () => {
    const f = setup(3);
    f.live("two", "x1");
    f.live("two", "d", { deps: ["b"] });                          // started work that waits on b
    f.unit("two", "b", "planned"); f.member("two", "b", true);  // its Builder waits for a seat
    f.waiting("one", "f1");
    f.focus("one");
    expect([ok(f, "two", "b"), ok(f, "one", "f1")]).toEqual([true, false]);
    f.waiting("two", "u", { urgent: true });                     // urgent: starts even at the limit
    expect(ok(f, "two", "u")).toBe(true);
  });

  test("the focus never goes over the limit", () => {
    const f = setup(3);
    f.live("two", "x1"); f.live("two", "x2"); f.live("one", "a");
    f.waiting("one", "f1");
    f.focus("one");
    const r = ask(f, "one", "f1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toBe("WAIT slot: p at max_builders 3");
  });

  test("no limit: nothing changes, and the line is empty", () => {
    const f = setup(null);
    f.live("two", "x1"); f.waiting("two", "old"); f.waiting("one", "f1");
    f.focus("one");
    expect([ok(f, "two", "old"), ok(f, "one", "f1")]).toEqual([true, true]);
    expect(queue(f.store, "p", T)).toEqual([]);
  });
});

describe("the last seat of each lane goes oldest first", () => {
  test("6 normal seats: the focus holds five, so the sixth goes to the other squad's older unit", () => {
    const f = setup(6, 2);
    f.waiting("two", "old");                                     // the oldest waiting normal unit
    for (const s of ["a1", "a2", "a3", "a4", "a5"]) f.live("one", s);
    f.waiting("one", "f6");
    f.focus("one");
    expect([ok(f, "two", "old"), ok(f, "one", "f6")]).toEqual([true, false]);
  });

  test("with four held, the focus still takes the fifth normal seat", () => {
    const f = setup(6, 2);
    f.live("two", "x1");
    f.waiting("two", "old");
    for (const s of ["a1", "a2", "a3", "a4"]) f.live("one", s);   // 5/6 live, the focus holds 4
    f.waiting("one", "f5");
    f.focus("one");
    expect([ok(f, "two", "old"), ok(f, "one", "f5")]).toEqual([false, true]);
  });

  test("2 light seats: the focus holds one, so the last light seat goes to the older light unit", () => {
    const f = setup(6, 2);
    for (const s of ["x1", "x2", "x3", "x4", "x5", "x6"]) f.live("two", s);   // normal full
    f.waiting("two", "lold", { light: true });
    f.live("one", "l1", { light: true });
    f.waiting("one", "lf", { light: true });
    f.focus("one");
    expect([ok(f, "two", "lold"), ok(f, "one", "lf")]).toEqual([true, false]);
  });

  test("the light lane with room: the focus light unit goes first", () => {
    const f = setup(2, 3);
    f.live("two", "x1"); f.live("two", "x2");                    // normal full, light 0/3
    f.live("two", "l0", { light: true }); f.live("two", "l1", { light: true });   // light 2/3
    f.waiting("two", "lold", { light: true });
    f.waiting("one", "lf", { light: true });
    f.focus("one");
    expect([ok(f, "two", "lold"), ok(f, "one", "lf")]).toEqual([false, true]);
  });

  test("a lane with one seat ignores the focus", () => {
    const n = setup(1);
    n.waiting("two", "old"); n.waiting("one", "f1"); n.focus("one");
    expect([ok(n, "two", "old"), ok(n, "one", "f1")]).toEqual([true, false]);
    const l = setup(1, 1);
    l.live("two", "x1");                                         // normal 1/1
    l.waiting("two", "lold", { light: true }); l.waiting("one", "lf", { light: true }); l.focus("one");
    expect([ok(l, "two", "lold"), ok(l, "one", "lf")]).toEqual([true, false]);
  });
});

describe("a focus that does not count", () => {
  test("the focus squad asks nothing (held, waiting): the seat goes elsewhere the same tick", () => {
    const f = setup(2);
    f.live("two", "x1");
    f.unit("one", "h1", "planned", { hold: true });              // the focus squad's work is held
    f.unit("two", "p1", "planned");
    f.focus("one");
    expect(slotted(f.store, "p", T)).toEqual(new Set(["two\0p1"]));
    f.waiting("two", "w1");
    expect(ok(f, "two", "w1")).toBe(true);
  });

  test("a suspended focus is ignored and keeps its key; on resume it counts again", () => {
    const f = setup(3);
    f.live("two", "x1"); f.live("two", "x2");
    f.waiting("two", "old");
    f.unit("one", "f1", "planned");
    f.focus("one");
    f.store.upsert("squads", { project: "p", topic: "one" }, { status: "suspended", updated_at: 2 });
    expect(focusSquad(f.store, "p")).toBeNull();
    expect(ok(f, "two", "old")).toBe(true);
    focusReconciler.run({ store: f.store, project: "p" } as TickCtx);
    expect(f.store.get("config", { project: "p", file: "limits.conf", key: "focus_squad" })?.value).toBe("one");
    f.store.upsert("squads", { project: "p", topic: "one" }, { status: "running", updated_at: 3 });
    expect(focusSquad(f.store, "p")).toBe("one");
  });

  test("a closed, done or gone focus squad: the loop clears the key, one focus_set by loop", () => {
    for (const status of ["closed", "done", "gone"]) {
      const f = setup(3);
      set(f.store, "p", "limits.conf", "focus_squad", "one", "ds");
      f.store.upsert("squads", { project: "p", topic: "one" }, { status, updated_at: 2 });
      focusReconciler.run({ store: f.store, project: "p" } as TickCtx);
      focusReconciler.run({ store: f.store, project: "p" } as TickCtx);   // nothing left to clear
      expect(f.store.get("config", { project: "p", file: "limits.conf", key: "focus_squad" })).toBeNull();
      expect(focusEvents(f.store)).toEqual([
        { squad: "one", from: "-", to: "one", by: "ds" },
        { squad: "one", from: "one", to: "-", by: "loop" },
      ]);
      expect(historyOf(f.store, "p", "limits.conf", "focus_squad").map((h) => h.actor)).toEqual(["ds", "loop"]);
    }
  });
});

describe("one line for slot(), slotted() and the board", () => {
  test("slotted() takes the head of the line slot() walks, and readyLine is that order", () => {
    const f = setup(4);
    f.live("two", "x1"); f.live("two", "x2");                    // two seats free
    f.unit("two", "o1", "planned"); f.unit("two", "o2", "planned");
    f.unit("one", "f1", "planned"); f.unit("one", "f2", "planned");
    expect(slotted(f.store, "p", T)).toEqual(new Set(["two\0o1", "two\0o2"]));
    f.focus("one");
    // room = 4 − 1 − 0 = 3: both focus units go first, then the older others.
    expect(readyLine(f.store, "p", T).map((c) => `${c.topic}/${c.slug}`)).toEqual(["one/f1", "one/f2", "two/o1", "two/o2"]);
    expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0f1", "one\0f2"]));
    const line = queue(f.store, "p", T, readyLine(f.store, "p", T).map((c) => ({ squad: c.topic, suffix: c.slug })));
    expect(line.map((p) => [p.squad, p.suffix, p.focus])).toEqual([["one", "f1", true], ["one", "f2", true], ["two", "o1", false], ["two", "o2", false]]);
  });

  test("the focus room runs out inside the line: later focus units rank by age", () => {
    const f = setup(3);
    f.unit("two", "o1", "planned");
    for (const s of ["f1", "f2", "f3"]) f.unit("one", s, "planned");
    f.focus("one");
    // room = 3 − 1 = 2: f1, f2 first; f3 is younger than o1.
    expect(readyLine(f.store, "p", T).map((c) => c.slug)).toEqual(["f1", "f2", "o1", "f3"]);
    expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0f1", "one\0f2", "two\0o1"]));
  });

  test("a planned unit whose Builder already waits is in the line once, so it takes focus room once", () => {
    const f = setup(3);
    f.live("two", "x1"); f.live("two", "x2");                    // one seat free; room = 3 − 1 − 0 = 2
    // ready.ts wishes a Builder for every ready unit, so the planned units each have a waiting member.
    f.unit("two", "o1", "planned"); f.member("two", "o1", true);
    for (const s of ["f1", "f2", "f3"]) { f.unit("one", s, "planned"); f.member("one", s, true); }
    f.focus("one");
    const ready = readyLine(f.store, "p", T);
    expect(ready.map((c) => `${c.topic}/${c.slug}`)).toEqual(["one/f1", "one/f2", "two/o1", "one/f3"]);
    const line = queue(f.store, "p", T, ready.map((c) => ({ squad: c.topic, suffix: c.slug })));
    expect(line.map((p) => [p.suffix, !!p.m, p.focus])).toEqual([["f1", true, true], ["f2", true, true], ["o1", true, false], ["f3", true, false]]);
    expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0f1"]));
    expect(["f1", "f2", "f3"].map((s) => ok(f, "one", s))).toEqual([true, false, false]);
  });
});

describe("every change logs one focus_set", () => {
  test("set refuses a squad that is not a live feature squad, and changes nothing", () => {
    const f = setup(3);
    f.store.upsert("squads", { project: "p", topic: "t" }, { status: "running", type: "testing", run_id: "run_t", repo: "path:/fake", lead_wt: "wt_t", observed_at: 1, updated_at: 1 });
    f.store.upsert("squads", { project: "p", topic: "two" }, { status: "suspended", updated_at: 2 });
    expect(() => set(f.store, "p", "limits.conf", "focus_squad", "t", "ds")).toThrow(/only a feature squad/);
    expect(() => set(f.store, "p", "limits.conf", "focus_squad", "two", "ds")).toThrow(/two is suspended/);
    expect(() => set(f.store, "p", "limits.conf", "focus_squad", "nope", "ds")).toThrow(/no squad 'nope'/);
    expect(focusEvents(f.store)).toEqual([]);
  });

  test("ds focus: show, set, replace, clear", () => {
    const f = setup(3);
    const ds = (...a: string[]) => {
      const r = Bun.spawnSync([DS, "focus", "p", ...a], { env: { ...process.env, DS_STATE_ROOT: f.root, DS_NOW: String(T) } });
      return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
    };
    expect(ds()).toMatchObject({ code: 0, out: "none" });
    expect(ds("one")).toMatchObject({ code: 0, out: "one" });
    expect(ds("two")).toMatchObject({ code: 0, out: "two" });
    expect(ds("nope")).toMatchObject({ code: 2, err: "ds focus: no squad 'nope' in p" });
    f.store.upsert("squads", { project: "p", topic: "two" }, { status: "suspended", updated_at: 2 });
    expect(ds()).toMatchObject({ code: 0, out: "two (not live: no effect)" });
    expect(ds("--clear")).toMatchObject({ code: 0, out: "none" });
    expect(ds("--clear")).toMatchObject({ code: 0, out: "none" });   // no change, no event
    expect(focusEvents(f.store).map((e) => [e.from, e.to, e.by])).toEqual([["-", "one", "ds"], ["one", "two", "ds"], ["two", "-", "ds"]]);
  });

  test("the board's limits POST and a Settings undo each log one", async () => {
    const f = setup(3);
    const fulfillers = (await load<Fulfiller & Reconciler>(DIRS.fulfil)).filter((x) => x.kinds);
    const act = new LoopActuator({ orca: undefined as never, fulfillers });
    const loop = new Loop(f.store, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["p"] });
    loop.boot(T);
    const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
    const board = (kind: string, payload: unknown) => f.store.request(kind, payload, { project: "p", by: "board" });
    board("limits", { key: "focus_squad", value: "one" });
    await tick(T);
    board("limits", { key: "focus_squad", value: "two" });
    await tick(T + 1);
    const last = historyOf(f.store, "p", "limits.conf", "focus_squad").at(-1)!;
    board("config-undo", { file: "limits.conf", key: "focus_squad", history: last.id });
    await tick(T + 2);
    expect(focusEvents(f.store).map((e) => [e.squad, e.from, e.to, e.by])).toEqual([
      ["one", "-", "one", "board"], ["two", "one", "two", "board"], ["one", "two", "one", "board"]]);
  });
});
