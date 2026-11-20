// poke-verify.test.ts — U165: a delivery the agent took is never reported as "not taken".
// A turn that started or ended after the send counts as taken even when no tick ever saw
// the member working (short turns, slow first starts). Against the fake Orca, like
// actuator.test.ts: each test works on a copy of tests/fixtures/loop/state in a temp dir.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const WS = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo";
const LEAD = `${WS}/ds-dev-studio-lead-demo`;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "zzpoke-")); temps.push(d); return d; }
function imported(): Store {
  const d = tmp();
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const picked = (account = "acct-b", agent = "claude", model = "opus"): Picker => async () => ({ agent, model, effort: null, account });

function rig(s: Store, o: { orca?: FakeOrca; pick?: Picker; extra?: Reconciler[] } = {}) {
  const orca = o.orca ?? new FakeOrca();
  const act = new LoopActuator({ orca, pick: o.pick ?? picked(), fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [...fulfillers, ...(o.extra ?? [])] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { const r = await loop.tick(at); await act.drain(); return r; };
  return { orca, act, loop, tick };
}
const pokeReq = (s: Store, text: string, key: string | null = null) =>
  Number(s.request("poke", { text }, { project: "fx", squad: "demo", member: LEAD, key }).row.id);
const deliveryAlerts = (s: Store) =>
  (JSON.parse(readFileSync(join(s.root, "fx", "alerts.json"), "utf8")).alerts as Row[])
    .filter((x) => String(x.id).startsWith("loop-deliver"));

describe("poke verify (U165)", () => {
  test("done with since after the send is verified, no alert", async () => {
    const s = imported(), orca = new FakeOrca();
    orca.pokes.set(LEAD, [3]);
    pokeReq(s, "ping");
    const { tick } = rig(s, { orca });
    await tick(T);
    expect(s.db.query("SELECT state, tries FROM deliveries").get()).toEqual({ state: "accepted", tries: 1 });
    // The turn ran and ended between ticks: never seen working, done since after the send.
    s.upsert("observed_workers", { project: "fx", wt: LEAD }, { state: "done", since: T + 2, observed_at: T + 5 });
    await tick(T + 5);
    expect((s.db.query("SELECT state FROM deliveries").get() as Row).state).toBe("verified");
    expect(orca.of("poke").length).toBe(1);
    expect(deliveryAlerts(s).length).toBe(0);
  });

  test("idle with since before the send still gets the resend then one alert", async () => {
    const s = imported(), orca = new FakeOrca();
    orca.pokes.set(LEAD, [3, 3, 3]);
    pokeReq(s, "ping");
    s.upsert("observed_workers", { project: "fx", wt: LEAD }, { state: "idle", since: T - 600, observed_at: T });
    const { tick } = rig(s, { orca });
    for (let t = T; t <= T + 20; t += 5) await tick(t);
    expect(orca.of("poke").length).toBe(2);
    expect(s.db.query("SELECT state, tries FROM deliveries").get()).toEqual({ state: "escalated", tries: 2 });
    expect(deliveryAlerts(s).length).toBe(1);
  });

  test("idle with since after the send is verified, no resend", async () => {
    const s = imported(), orca = new FakeOrca();
    orca.pokes.set(LEAD, [3]);
    pokeReq(s, "ping");
    const { tick } = rig(s, { orca });
    await tick(T);
    expect(s.db.query("SELECT state, tries FROM deliveries").get()).toEqual({ state: "accepted", tries: 1 });
    // A fresh session that booted after the send: idle, but its state entry postdates the send.
    s.upsert("observed_workers", { project: "fx", wt: LEAD }, { state: "idle", since: T + 2, observed_at: T + 5 });
    await tick(T + 5);
    expect((s.db.query("SELECT state FROM deliveries").get() as Row).state).toBe("verified");
    expect(orca.of("poke").length).toBe(1);
    expect(deliveryAlerts(s).length).toBe(0);
  });

  test("seen working is verified as today", async () => {
    const s = imported(), orca = new FakeOrca();
    orca.pokes.set(LEAD, [3]);
    pokeReq(s, "ping");
    const { tick } = rig(s, { orca });
    await tick(T);
    expect(s.db.query("SELECT state, tries FROM deliveries").get()).toEqual({ state: "accepted", tries: 1 });
    s.upsert("observed_workers", { project: "fx", wt: LEAD }, { state: "working", observed_at: T + 5 });
    await tick(T + 5);
    expect((s.db.query("SELECT state FROM deliveries").get() as Row).state).toBe("verified");
    expect(orca.of("poke").length).toBe(1);
  });
});
