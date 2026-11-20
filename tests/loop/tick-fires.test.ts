// tick-fires.test.ts — U239: a tick reads in parallel and fires its actions without waiting.
// Hermetic: a copy of tests/fixtures/loop/state and fake fulfillers / a fake Orca.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller, type Result } from "../../bin/loop/core/actuator.ts";
import { sender } from "../../bin/loop/messages/coordinator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { Orca, Out, Via } from "../../bin/loop/io/orca.ts";
import type { Action, Reconciler } from "../../bin/loop/core/plugins.ts";
import { reconcile } from "../../bin/loop/reconcilers/members.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.DS_LOOP_READ_SLOTS;
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zztickfires-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}
const claim = (s: Store, subject: string) => s.get("episodes", { project: "fx", subject, kind: "action:poke" });
const pokeAction = (n: number, member = `wt-${n}`, episode = "e1"): Action => ({ project: "fx", squad: "demo", member, subject: `req:${n}`, kind: "poke", episode, payload: { wt: member } });

// A poke fulfiller that takes `ms` and logs what it started; `outcome` decides how it ends.
function rig(actions: () => Action[], o: { ms?: number; outcome?: (a: Action) => Result | Promise<Result>; bgTimeoutMs?: number; bgSlots?: number } = {}) {
  const s = imported(), started: string[] = [];
  const f: Fulfiller = { name: "poke", kinds: ["poke"], run: () => [], exec: async (a) => {
    started.push(a.subject);
    if (o.ms) await Bun.sleep(o.ms);
    return o.outcome ? o.outcome(a) : { done: true };
  } };
  const act = new LoopActuator({ orca: new FakeBackend(), fulfillers: [f], bgTimeoutMs: o.bgTimeoutMs, bgSlots: o.bgSlots });
  const r: Reconciler = { name: "r", run: () => actions() };
  const loop = new Loop(s, { observers: [], reconcilers: [r] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  return { s, started, act, loop };
}

describe("actions fire without the tick waiting", () => {
  test("three 400 ms pokes: the tick returns at once, the pokes settle done later", async () => {
    const { s, act, loop } = rig(() => [1, 2, 3].map((n) => pokeAction(n)), { ms: 400 });
    const t0 = performance.now();
    await loop.tick(T);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(claim(s, "req:1")!.state).toBe("running");
    await act.drain();
    for (const n of [1, 2, 3]) expect(claim(s, `req:${n}`)!.state).toBe("done");
  });

  test("a second poke for the same member, or the same subject, is not started while the first runs", async () => {
    let round = 0;
    const { s, started, act, loop } = rig(() => (round++ === 0 ? [pokeAction(1, "wt-a")] : [pokeAction(2, "wt-a"), pokeAction(1, "wt-b", "e2")]), { ms: 150 });
    await loop.tick(T);
    await loop.tick(T + 5);
    expect(started).toEqual(["req:1"]);
    expect(claim(s, "req:2")).toBeNull();
    await act.drain();
    await loop.tick(T + 10);
    await act.drain();
    expect(started.sort()).toEqual(["req:1", "req:1", "req:2"]);
  });

  test("the slots bound how many run at once", async () => {
    const { started, act, loop } = rig(() => [1, 2, 3].map((n) => pokeAction(n)), { ms: 100, bgSlots: 2 });
    await loop.tick(T);
    expect(started.length).toBe(2);
    await act.drain();
    await loop.tick(T + 5);
    await act.drain();
    expect(started.length).toBe(3);
  });

  test("a failure settles as retry with next_at, and is acted again after it", async () => {
    let n = 0;
    const { s, started, act, loop } = rig(() => [pokeAction(1)], { outcome: () => (n++ === 0 ? { retry: "orca exited 1" } : { done: true }) });
    await loop.tick(T);
    await act.drain();
    const row = claim(s, "req:1")!;
    expect(row.state).toBe("pending");
    expect(Number(row.next_at)).toBeGreaterThan(T);
    await loop.tick(T + 1);
    await act.drain();
    expect(started.length).toBe(1);                                 // not before next_at
    await loop.tick(Number(row.next_at));
    await act.drain();
    expect(started.length).toBe(2);
    expect(claim(s, "req:1")!.state).toBe("done");
  });

  test("a call that hangs past its timeout settles as a retry and frees its subject", async () => {
    const { s, act, loop } = rig(() => [pokeAction(1)], { outcome: () => new Promise<Result>(() => {}), bgTimeoutMs: 60 });
    await loop.tick(T);
    expect(claim(s, "req:1")!.state).toBe("running");
    await act.drain();
    const row = claim(s, "req:1")!;
    expect(row.state).toBe("pending");
    expect(Number(row.next_at)).toBeGreaterThan(T);
    expect((act as unknown as { bgBusy: Set<string> }).bgBusy.size).toBe(0);
  });

  test("a poke running at a crash is put back to pending on boot", async () => {
    const { s, act, loop } = rig(() => [pokeAction(1)], { outcome: () => new Promise<Result>(() => {}), bgTimeoutMs: 60_000 });
    await loop.tick(T);
    expect(claim(s, "req:1")!.state).toBe("running");
    await new LoopActuator({ orca: new FakeBackend(), fulfillers: [] }).boot(s, T + 10);
    expect(claim(s, "req:1")!.state).toBe("pending");
    void act;
  });

  test("tick_slow names the top 5 steps and the actuator's time per kind", async () => {
    const s = imported();
    const f: Fulfiller = { name: "poke", kinds: ["poke"], run: () => [], exec: async () => { await Bun.sleep(20); return { done: true }; } };
    const act = new LoopActuator({ orca: new FakeBackend(), fulfillers: [f] });
    const obs = ["a", "b", "c", "d", "e", "f"].map((name, i) => ({ name, run: () => Bun.sleep(i * 3) }));
    let n = 0;
    const loop = new Loop(s, { observers: obs, reconcilers: [{ name: "r", run: () => [pokeAction(++n)] }] }, act, { tickS: 0.001, projects: () => ["fx"] });
    loop.boot(T);
    await loop.tick(T);
    await act.drain();
    await loop.tick(T + 1);
    const ev = s.db.query("SELECT payload FROM events WHERE kind = 'tick_slow' ORDER BY id").all() as Row[];
    const p = JSON.parse(String(ev[0].payload));
    expect(p.top.length).toBe(5);
    expect(p.top[0]).toEqual(p.slowest);
    expect([...p.top].sort((x: { avg_ms: number }, y: { avg_ms: number }) => y.avg_ms - x.avg_ms)).toEqual(p.top);
    await loop.tick(T + 700);
    await act.drain();
    const all = s.db.query("SELECT payload FROM events WHERE kind = 'tick_slow' ORDER BY id").all() as Row[];
    const names = all.flatMap((e) => (JSON.parse(String(e.payload)).top as { step: string }[]).map((t) => t.step));
    // The poke is a background action: the tick did not wait for it, so it is not a step of the top 5 (U242).
    expect(names.some((k) => k.startsWith("bg:"))).toBe(false);
    expect(all.some((e) => (JSON.parse(String(e.payload)).bg as { step: string }[]).some((b) => b.step === "bg:poke"))).toBe(true);
  });

  test("a background poke shows as bg:poke, an inline action as actuator:<kind>", async () => {
    const s = imported();
    const poke: Fulfiller = { name: "poke", kinds: ["poke"], run: () => [], exec: async () => { await Bun.sleep(300); return { done: true }; } };
    const inl: Fulfiller = { name: "inl", kinds: ["inl-x"], run: () => [], exec: async () => { await Bun.sleep(150); return { done: true }; } };
    const act = new LoopActuator({ orca: new FakeBackend(), fulfillers: [poke, inl] });
    let n = 0;
    const acts = (): Action[] => [pokeAction(++n), { ...pokeAction(100 + n), kind: "inl-x", subject: `inl:${n}` }];
    const loop = new Loop(s, { observers: [], reconcilers: [{ name: "r", run: acts }] }, act, { tickS: 0.001, projects: () => ["fx"] });
    loop.boot(T);
    await loop.tick(T);
    await act.drain();
    await loop.tick(T + 1);
    await act.drain();
    await loop.tick(T + 700); // the window that holds the poke's run
    await act.drain();
    const ps = (s.db.query("SELECT payload FROM events WHERE kind = 'tick_slow' ORDER BY id").all() as Row[]).map((e) => JSON.parse(String(e.payload)));
    const top = ps.flatMap((p) => (p.top as { step: string }[]).map((t) => t.step));
    const bg = ps.flatMap((p) => p.bg as { step: string; avg_ms: number }[]);
    expect(top).toContain("actuator:inl-x");
    expect(top).not.toContain("bg:poke");
    expect(top).not.toContain("actuator:poke");
    expect(bg.find((b) => b.step === "bg:poke")!.avg_ms).toBeGreaterThan(100);
  });
});

describe("members reads in parallel", () => {
  // run-workers takes `ms` per Run; the order of the actions must not depend on how many run at once.
  class Slow implements Orca {
    live = 0; peak = 0;
    constructor(readonly inner: FakeBackend, readonly ms: number) {}
    async run(op: string, args: string[], via?: Via): Promise<Out> {
      if (op !== "run-workers") return this.inner.run(op, args, via);
      this.peak = Math.max(this.peak, ++this.live);
      await Bun.sleep(this.ms);
      this.live--;
      return this.inner.run(op, args, via);
    }
  }
  async function actions(slots: string) {
    process.env.DS_LOOP_READ_SLOTS = slots;
    const s = imported();
    process.env.DS_STATE_ROOT = s.root;
    const inner = new FakeBackend();
    await sender(s, inner, "fx", "demo", T);
    const orca = new Slow(inner, 30);
    const out = await reconcile({ store: s, project: "fx", tick: 1, now: T, fired: [], poked: new Set() }, orca);
    return { out, peak: orca.peak };
  }
  test("the same actions in the same order as with serial reads", async () => {
    const serial = await actions("1"), par = await actions("6");
    expect(par.out).toEqual(serial.out);
    expect(serial.peak).toBeLessThanOrEqual(1);
  });
});
