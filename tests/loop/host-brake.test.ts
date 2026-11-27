// host-brake.test.ts — U4: with `builder_host_brake on`, no new Builder agent starts while the latest
// observed_machine sample crosses a machine_*_crit line (bin/loop/capacity/pick.ts hostBrake, levels from
// bin/loop/capacity/machine-level.ts, the board's own). Off (the default), a stale or missing sample, a live
// Builder replacing its own agent and every other role go ahead. The picks reconciler, the actuator's
// ladder pick and `ds pick` read the wait as a start wait (no reset time), never an error.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { machineObserver } from "../../bin/loop/observers/machine.ts";
import { disksOf } from "../../bin/loop/squad/disk-pressure.ts";
import { brakeView, pick, type Picked, type PickReq, type Waiting } from "../../bin/loop/capacity/pick.ts";
import { reconcile } from "../../bin/loop/capacity/picks.ts";
import { ladderPick } from "../../bin/loop/core/actuator.ts";
import { hostCrit, hostCritHit, machineLevels, sampleState, worst } from "../../bin/loop/capacity/machine-level.ts";
import type { Member } from "../../bin/loop/drivers/types.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const T = 1_800_000_000;
const ENV = ["DS_LIMIT_BUILDER_HOST_BRAKE", "DS_LOOP_MACHINE_S", "DS_LIMIT_MACHINE_PSI_CRIT", "DS_LIMIT_MAX_BUILDERS"];

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const e of ENV) delete process.env[e];
});
function fixture(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzhostbrake-")), conv = mkdtempSync(join(tmpdir(), "zzhostbrake-conv-"));
  temps.push(d, conv);
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  for (const p of ["fx", "fy"]) mkdirSync(join(d, p, "squads"), { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(d, "accounts.tsv"));
  const s = open(d);
  stores.push(s);
  importConfig(s, d, conv);
  for (const r of accountRows(d)) s.upsert(r.table, r.key, r.set);
  for (const p of ["fx", "fy"]) s.upsert("squads", { project: p, topic: "demo" }, { status: "running", observed_at: T, updated_at: T });
  return s;
}

const at = { observed_at: T, updated_at: T };
// A calm host: 24 cores at load 6, half the memory used, no swap in use, no pressure.
const CALM: Row = { host: "local", cores: 24, load1: 6, load5: 6, load15: 6, mem_total_kb: 64_000_000, mem_avail_kb: 32_000_000, swap_total_kb: 8_000_000, swap_free_kb: 8_000_000,
  psi_cpu_some: 1, psi_mem_some: 0, psi_mem_full: 0, psi_io_some: 0, psi_io_full: 0, disks: "[]", groups: "[]", observed_at: T };
const sample = (s: Store, set: Row = {}) => s.upsert("observed_machine", { host: "local" }, { ...CALM, ...set });
// builder_host_brake and the machine lines are host keys (U25): main's own override, never a project row.
const hostSet = (s: Store, key: string, value: string) =>
  s.db.run("INSERT OR REPLACE INTO host_config (host, key, value, set_at) VALUES ('local', ?, ?, ?)", [key, value, T]);
const brake = (s: Store, value = "on") => hostSet(s, "builder_host_brake", value);
let n = 0;
function member(s: Store, set: Row): number {
  const row: Row = { project: "fx", squad: "demo", role: "builder", suffix: `u${++n}`, ...at, ...set };
  const ks = Object.keys(row);
  return Number(s.db.run(`INSERT INTO members (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`, ks.map((k) => row[k] as string | number | null)).lastInsertRowid);
}
// A Builder that asks to start (an open wish, no agent), and one whose agent runs.
const asks = (s: Store, set: Row = {}) => member(s, { want: "running", want_at: T, tier: "hard", ...set });
function live(s: Store, project = "fx"): number {
  const id = member(s, { project, status: "running", wt: `wt-live-${n + 1}`, tier: "hard" });
  const wt = String((s.db.query("SELECT wt FROM members WHERE id = ?").get(id) as Row).wt);
  s.upsert("observed_workers", { project, wt }, { state: "working", presence: "running", observed_at: T });
  return id;
}
const builder = (s: Store, req: Partial<PickReq> = {}) => pick(s, { project: "fx", role: "builder", tier: "hard", phase: "build", squad: "demo", ...req }, T);
const starts = (p: unknown) => { expect(p).not.toHaveProperty("wait"); expect(p).not.toHaveProperty("error"); return p as Picked; };
const waits = (p: unknown) => { expect(p).toHaveProperty("wait"); return p as Waiting; };
const ctx = (s: Store) => ({ store: s, project: "", tick: 1, now: T, fired: [], poked: new Set() } as TickCtx);

describe("U4: the Builder host brake", () => {
  test("a machine observer tick feeds the brake and the board's brake view", async () => {
    const s = fixture(), proc = mkdtempSync(join(tmpdir(), "zzhostbrake-proc-"));
    temps.push(proc);
    writeFileSync(join(proc, "loadavg"), "40.00 40.00 40.00 1/200 999\n");
    writeFileSync(join(proc, "stat"), "cpu  1 2 3 4\ncpu0 1 2 3 4\n");
    const loop = new Loop(s, { observers: [machineObserver(proc)], reconcilers: [] }, { act() {} }, { projects: () => [] });
    loop.boot(T); await loop.tick(T);
    brake(s);
    expect(waits(builder(s, { member: asks(s) })).reason).toBe("WAIT host: load 4000% ≥ crit 150%");
    expect(brakeView(s, T, "fx")).toMatchObject({ sample: "fresh", hit: { metric: "load" } });
  });

  test("a side host's newer row is never main's: the brake, its view and the disks ignore it", () => {
    const s = fixture();
    brake(s);
    const side = () => s.upsert("observed_machine", { host: "sidebox" }, { ...CALM, host: "sidebox", psi_cpu_some: 40, observed_at: T,
      disks: JSON.stringify([{ path: "/side", total_kb: 100, free_kb: 1 }]) });
    side();                                                            // no row of main's own: nothing to read
    starts(builder(s, { member: asks(s) }));
    expect(brakeView(s, T, "fx")).toMatchObject({ sample: "missing", hit: null });
    expect(disksOf(s)).toEqual([]);
    sample(s, { observed_at: T - 30, disks: JSON.stringify([{ path: "/", total_kb: 100, free_kb: 50 }]) });
    starts(builder(s, { member: asks(s) }));
    expect(brakeView(s, T, "fx")).toMatchObject({ sample: "fresh", age_s: 30, hit: null });
    expect(disksOf(s).map((d) => d.path)).toEqual(["/"]);
  });

  test("crit CPU pressure with the brake on: a new Builder waits with WAIT host and no reset time", () => {
    const s = fixture();
    brake(s);
    sample(s, { psi_cpu_some: 31.24 });
    const p = waits(builder(s, { member: asks(s) }));
    expect(p).toMatchObject({ why: "host", known: false, wait: T, reason: "WAIT host: psi cpu 31.2 ≥ crit 25" });
    expect(p.slot).toBeUndefined();
    // A start with no member row yet (add-role) is braked the same way.
    expect(waits(builder(s, { suffix: "fresh" })).why).toBe("host");
  });

  test("off (the conventions default) the same host starts the Builder", () => {
    const s = fixture();
    sample(s, { psi_cpu_some: 40 });
    starts(builder(s, { member: asks(s) }));
    brake(s, "off");
    starts(builder(s, { member: asks(s) }));
  });

  test("a stale or missing sample never brakes", () => {
    const s = fixture();
    brake(s);
    starts(builder(s, { member: asks(s) }));                           // no observed_machine row at all
    sample(s, { psi_cpu_some: 40, observed_at: T - 91 });               // older than 3 x the default 30 s
    starts(builder(s, { member: asks(s) }));
    sample(s, { psi_cpu_some: 40, observed_at: T - 90 });               // exactly 3 x: still fresh
    expect(waits(builder(s, { member: asks(s) })).why).toBe("host");
    process.env.DS_LOOP_MACHINE_S = "10";                               // a faster cadence makes 90 s stale
    starts(builder(s, { member: asks(s) }));
  });

  test("a live Builder replacing its own agent, a Lead, a Thinker and the rest are never braked", () => {
    const s = fixture();
    brake(s);
    sample(s, { psi_cpu_some: 40 });
    starts(builder(s, { member: live(s) }));
    for (const role of ["lead", "thinker", "tester", "reviewer", "researcher"])
      expect(pick(s, { project: "fx", role, phase: "build" }, T)).not.toHaveProperty("wait");
  });

  test("every crit line brakes: load, memory, swap with memory pressure, cpu/mem/io pressure; full swap alone does not", () => {
    const s = fixture();
    brake(s);
    const cases: [Row, string | null][] = [
      [{ load1: 40 }, "load 166.7% ≥ crit 150%"],
      [{ mem_avail_kb: 2_000_000 }, "mem 96.9% ≥ crit 95%"],
      [{ swap_free_kb: 400_000, psi_mem_some: 12 }, "swap 95% ≥ crit 90%"],
      [{ swap_free_kb: 400_000, psi_mem_some: 2 }, null],               // the board reads this warn, so does the brake
      [{ psi_mem_full: 26 }, "psi mem 26 ≥ crit 25"],
      [{ psi_io_some: 30 }, "psi io 30 ≥ crit 25"],
      [{ load1: 30, mem_avail_kb: 6_000_000 }, null],                    // warn levels only
      [{ disks: JSON.stringify([{ path: "/", total_kb: 100, free_kb: 1 }]) }, null],   // a full disk is the board's, not the brake's
    ];
    for (const [set, reason] of cases) {
      sample(s, set);
      const p = builder(s, { member: asks(s) });
      if (reason) expect(waits(p).reason).toBe(`WAIT host: ${reason}`);
      else starts(p);
    }
  });

  test("the lines are the host's: its override moves them, the env var wins, a project row is never read", () => {
    const s = fixture();
    brake(s);
    sample(s, { psi_cpu_some: 31 });
    hostSet(s, "machine_psi_crit", "50");
    s.upsert("config", { project: "fx", file: "limits.conf", key: "machine_psi_crit" }, { value: "20", observed_at: T });   // now per host, unread
    starts(builder(s, { member: asks(s) }));
    process.env.DS_LIMIT_MACHINE_PSI_CRIT = "30";                      // the env var wins, as on the board
    expect(waits(builder(s, { member: asks(s) })).reason).toBe("WAIT host: psi cpu 31 ≥ crit 30");
    delete process.env.DS_LIMIT_MACHINE_PSI_CRIT;
    brake(s, "off");
    s.upsert("config", { project: "fy", file: "limits.conf", key: "builder_host_brake" }, { value: "on", observed_at: T });   // unread too
    hostSet(s, "machine_psi_crit", "30");
    starts(builder(s, { project: "fy", member: asks(s, { project: "fy" }) }));
    process.env.DS_LIMIT_BUILDER_HOST_BRAKE = "on";                     // DS_LIMIT_<KEY> turns it on everywhere
    expect(waits(builder(s, { project: "fy", member: asks(s, { project: "fy" }) })).why).toBe("host");
  });

  test("max_builders comes first: a Builder over the limit waits for a slot, not the host", () => {
    const s = fixture();
    brake(s);
    sample(s, { psi_cpu_some: 40 });
    process.env.DS_LIMIT_MAX_BUILDERS = "1";
    live(s);
    expect(waits(builder(s, { member: asks(s) })).why).toBe("slot");
  });

  test("the board and the brake read one function: crit on the panel iff the brake names a line", () => {
    const s = fixture();
    const line = (k: string) => Number(String((s.get("config", { project: "", file: "limits.conf", key: k }) as Row).value).split(/\s+/)[0]);
    for (const set of [{}, { load1: 40 }, { psi_cpu_some: 26 }, { swap_free_kb: 0, psi_mem_some: 1 }, { swap_free_kb: 0, psi_mem_some: 11 }, { mem_avail_kb: 0 }]) {
      const row = { ...CALM, ...set }, m = machineLevels(row, line);
      const crit = worst(m.lv.load, m.lv.mem, m.lv.swap, ...m.psi.map((p) => p.level)) === "crit";
      expect(hostCrit(row, line, T) !== null).toBe(crit);
    }
  });
});

describe("board-shows-host-brake U1: the crossed line as data, and the brake as one host state", () => {
  const lineOf = (s: Store) => (k: string) => Number(String((s.get("config", { project: "", file: "limits.conf", key: k }) as Row).value).split(/\s+/)[0]);

  test("hostCritHit names the metric, value, line, key and unit; hostCrit's string is unchanged", () => {
    const s = fixture(), line = lineOf(s);
    const cases: [Row, ReturnType<typeof hostCritHit>, string | null][] = [
      [{ load1: 40 }, { metric: "load", value: 166.7, crit: 150, key: "machine_load_crit_pct", unit: "%" }, "load 166.7% ≥ crit 150%"],
      [{ mem_avail_kb: 2_000_000 }, { metric: "mem", value: 96.9, crit: 95, key: "machine_mem_crit_pct", unit: "%" }, "mem 96.9% ≥ crit 95%"],
      [{ swap_free_kb: 400_000, psi_mem_some: 12 }, { metric: "swap", value: 95, crit: 90, key: "machine_swap_crit_pct", unit: "%" }, "swap 95% ≥ crit 90%"],
      [{ swap_free_kb: 400_000, psi_mem_some: 2 }, null, null],                    // full swap, low PSI: warn only
      [{ psi_cpu_some: 31.24 }, { metric: "psi cpu", value: 31.2, crit: 25, key: "machine_psi_crit", unit: "" }, "psi cpu 31.2 ≥ crit 25"],
      [{}, null, null],
    ];
    for (const [set, hit, text] of cases) {
      const row = { ...CALM, ...set };
      expect(hostCritHit(row, line, T)).toEqual(hit);
      expect(hostCrit(row, line, T)).toBe(text);
    }
  });

  test("a stale or missing sample has no hit, and says which", () => {
    const s = fixture(), line = lineOf(s);
    const hot = { ...CALM, load1: 40 };
    expect(sampleState(null, T)).toEqual({ state: "missing", age_s: null });
    expect(sampleState({ ...hot, observed_at: null }, T)).toEqual({ state: "missing", age_s: null });
    expect(sampleState({ ...hot, observed_at: T - 90 }, T)).toEqual({ state: "fresh", age_s: 90 });
    expect(sampleState({ ...hot, observed_at: T - 91 }, T)).toEqual({ state: "stale", age_s: 91 });
    expect(hostCritHit({ ...hot, observed_at: T - 91 }, line, T)).toBeNull();
    expect(hostCritHit(null, line, T)).toBeNull();
    expect(brakeView(s, T)).toMatchObject({ sample: "missing", age_s: null, hit: null });
    sample(s, { load1: 40, observed_at: T - 200 });
    expect(brakeView(s, T)).toMatchObject({ sample: "stale", age_s: 200, hit: null });
  });

  test("brakeView: one host hit, every project listed with the host's setting, and nothing written", () => {
    const s = fixture();
    brake(s);
    s.upsert("config", { project: "fy", file: "limits.conf", key: "builder_host_brake" }, { value: "off", observed_at: T });   // unread
    sample(s, { load1: 36.72 });                                      // 153% of 24 cores
    const count = () => (s.db.query("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM picks) AS n").get() as { n: number }).n;
    const before = count();
    const v = brakeView(s, T);
    expect(v).toEqual({ setting: "builder_host_brake", sample: "fresh", age_s: 0,
      hit: { metric: "load", value: 153, crit: 150, key: "machine_load_crit_pct", unit: "%" },
      projects: [{ project: "fx", on: true }, { project: "fy", on: true }] });
    expect(count()).toBe(before);
    // It agrees with the brake itself: both projects' next Builder waits on that line.
    expect(waits(builder(s, { member: asks(s) })).reason).toBe("WAIT host: load 153% ≥ crit 150%");
    expect(waits(builder(s, { project: "fy", member: asks(s, { project: "fy" }) })).why).toBe("host");
    // A project's own line is not read; the host's override is, whichever project asks.
    s.upsert("config", { project: "fy", file: "limits.conf", key: "machine_load_crit_pct" }, { value: "200", observed_at: T });
    expect(brakeView(s, T, "fy").hit?.crit).toBe(150);
    hostSet(s, "machine_load_crit_pct", "200");
    expect(brakeView(s, T, "fx").hit).toBeNull();
  });
});

describe("U4: the brake through the loop and the CLI", () => {
  test("the picks reconciler keeps a braked member waiting with the reason and no slot; the actuator reads it as a start wait", async () => {
    const s = fixture();
    brake(s);
    sample(s, { psi_cpu_some: 40 });
    const id = asks(s);
    const go = reconcile(ctx(s));
    expect(go.has(id)).toBe(false);
    const row = s.get("picks", { member: id }) as Row;
    expect(row).toMatchObject({ slot: 0, wait_until: null, reason: "WAIT host: psi cpu 40 ≥ crit 25" });
    const m = { ...(s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row), id } as unknown as Member;
    expect(await ladderPick(s, m, { at: T })).toEqual({ wait: null, slot: "WAIT host: psi cpu 40 ≥ crit 25" });
    expect(await ladderPick(s, m, { at: T, fresh: true })).toEqual({ wait: T, slot: "WAIT host: psi cpu 40 ≥ crit 25" });
    // The host calms down: the next tick picks it.
    sample(s, { psi_cpu_some: 1 });
    expect(reconcile(ctx(s)).has(id)).toBe(true);
  });

  test("ds pick prints WAIT host with exit 3", () => {
    const s = fixture();
    brake(s);
    sample(s, { load1: 48 });
    const p = Bun.spawnSync([DS, "--state", s.root, "pick", "fx", "builder", "--tier", "hard", "--squad", "demo", "--suffix", "cli"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, DS_NOW: String(T) } });
    expect({ code: p.exitCode, out: p.stdout.toString().trim() }).toEqual({ code: 3, out: "WAIT host: load 200% ≥ crit 150%" });
  });
});
