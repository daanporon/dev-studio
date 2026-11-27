// place-host.test.ts — side-loop-host U11 (KTD10, KTD16): with main full, the next queued Builder is placed on an online
// side host with a free seat under its own `seats` and a fresh machine row that hits no brake of its own (clone or not);
// a draining, fenced, behind, full, braking, stale or unreachable host is never chosen; Leads, Thinkers and the Studio
// never leave main; main's max_builders counts only Builders on main; main's brake reads main's sample, a side host's
// brake its own (bin/loop/capacity/place.ts, slot.ts, pick.ts, picks.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import { pick, type Picked, type PickReq, type Waiting } from "../../bin/loop/capacity/pick.ts";
import { reconcile } from "../../bin/loop/capacity/picks.ts";
import { placeSide, refusal } from "../../bin/loop/capacity/place.ts";
import { LINK_VERSION } from "../../bin/link/protocol.ts";
import { UP_MIGRATION } from "../../bin/link/replica.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const SAVED = { ...process.env };

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});
function fixture(): Store {
  for (const k of Object.keys(process.env)) if (k.startsWith("DS_")) delete process.env[k];
  process.env.DS_LIMIT_LINK_LISTEN = "off";
  process.env.DS_LIMIT_MAX_BUILDERS = "1";
  const d = mkdtempSync(join(tmpdir(), "zzplace-")), conv = mkdtempSync(join(tmpdir(), "zzplace-conv-"));
  temps.push(d, conv);
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  mkdirSync(join(d, "fx", "squads"), { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(d, "accounts.tsv"));
  const s = open(d);
  stores.push(s);
  importConfig(s, d, conv);
  for (const r of accountRows(d)) s.upsert(r.table, r.key, r.set);
  s.upsert("squads", { project: "fx", topic: "demo" }, { status: "running", observed_at: T, updated_at: T });
  return s;
}

const CALM: Row = { cores: 24, load1: 6, load5: 6, load15: 6, mem_total_kb: 64_000_000, mem_avail_kb: 32_000_000, swap_total_kb: 8_000_000, swap_free_kb: 8_000_000,
  psi_cpu_some: 1, psi_mem_some: 0, psi_mem_full: 0, psi_io_some: 0, psi_io_full: 0, disks: "[]", groups: "[]", observed_at: T };
const sample = (s: Store, host: string, set: Row = {}) => s.upsert("observed_machine", { host }, { ...CALM, host, ...set });
const hostSet = (s: Store, host: string, key: string, value: string) =>
  s.db.run("INSERT OR REPLACE INTO host_config (host, key, value, set_at) VALUES (?, ?, ?, ?)", [host, key, value, T]);
// An accepted, online side host on main's link version and migration, with a fresh calm sample and `seats` seats.
function side(s: Store, name: string, set: Row = {}, seats = 2): void {
  const row: Row = { name, status: "accepted", public_key: "a2V5", fingerprint: name, seats, requested_at: T, accepted_at: T, last_seen_at: T,
    link_version: LINK_VERSION, up_migration: UP_MIGRATION, ...set };
  const ks = Object.keys(row);
  s.db.run(`INSERT INTO hosts (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`, ks.map((k) => row[k] as string | number | null));
  hostSet(s, name, "seats", String(seats));
  sample(s, name);
  // U19: each account has a login there (pick-per-host.test.ts covers a host without one).
  for (const a of ["acct-a", "acct-b", "acct-c"])
    s.db.run("INSERT INTO account_folders (agent, account, host, dir, observed_at) VALUES ('claude', ?, ?, ?, ?)", [a, name, `/home/u/.dev-studio-accounts/claude/${a}`, T]);
}
let n = 0;
function member(s: Store, set: Row): number {
  const row: Row = { project: "fx", squad: "demo", role: "builder", suffix: `u${++n}`, observed_at: T, updated_at: T, ...set };
  const ks = Object.keys(row);
  return Number(s.db.run(`INSERT INTO members (${ks.join(", ")}) VALUES (${ks.map(() => "?").join(", ")})`, ks.map((k) => row[k] as string | number | null)).lastInsertRowid);
}
const asks = (s: Store, set: Row = {}) => member(s, { want: "running", want_at: T + n, tier: "hard", ...set });
// A Builder whose agent runs: on main (observed worker), or on a side host (its row names the host and a worktree there).
function live(s: Store, host: string | null = null): number {
  const wt = `${host ?? "local"}::/wt/live-${n + 1}`;
  const id = member(s, { status: "running", want: "running", wt, tier: "hard", host });
  s.upsert("observed_workers", { project: "fx", wt }, { state: "working", presence: "running", observed_at: T });
  return id;
}
const ctx = (s: Store) => ({ store: s, project: "", tick: 1, now: T, fired: [], poked: new Set() } as TickCtx);
const req = (role: string, set: Partial<PickReq> = {}): PickReq => ({ project: "fx", role, tier: "hard", phase: "build", squad: "demo", place: true, ...set });
const starts = (p: unknown) => { expect(p).not.toHaveProperty("wait"); expect(p).not.toHaveProperty("error"); return p as Picked; };
const waits = (p: unknown) => { expect(p).toHaveProperty("wait"); return p as Waiting; };
const hostCol = (s: Store, id: number) => (s.db.query("SELECT host FROM members WHERE id = ?").get(id) as Row).host;

describe("U11: placement picks a side host", () => {
  test("main full: the next queued Builder goes to a side host with a free seat (no clone needed); members.host is written before the start", () => {
    const s = fixture();
    sample(s, "local");
    side(s, "alpha");
    live(s);
    const id = asks(s);
    const go = reconcile(ctx(s));
    expect(go.has(id)).toBe(true);
    expect(s.get("picks", { member: id })).toMatchObject({ slot: 1, host: "alpha" });
    expect(String(s.get("picks", { member: id })!.reason)).toMatch(/; on side host alpha \(main slot: /);
    expect(hostCol(s, id)).toBe("alpha");
    // The next tick keeps it there (a loop placement is not a forced host, and it still fits).
    expect(reconcile(ctx(s)).has(id)).toBe(true);
    expect(hostCol(s, id)).toBe("alpha");
  });

  test("a loop placement stays movable while its member is no candidate (start in flight, suspended): the host can still be left", () => {
    const s = fixture();
    sample(s, "local");
    side(s, "alpha");
    live(s);
    const id = asks(s);
    reconcile(ctx(s));
    expect(hostCol(s, id)).toBe("alpha");
    // Out of the candidate set (suspended, no worktree): its picks row and placement stay.
    s.db.run("UPDATE squads SET status = 'suspended' WHERE topic = 'demo'");
    s.db.run("UPDATE members SET status = 'suspended' WHERE id = ?", [id]);
    reconcile(ctx(s), { eligible: [], moves: new Map() });
    expect(s.get("picks", { member: id })).toMatchObject({ host: "alpha" });
    // Resumed with alpha now draining: placed again, not pinned (main full, so it waits on main).
    s.db.run("UPDATE squads SET status = 'running' WHERE topic = 'demo'");
    s.db.run("UPDATE members SET status = 'wanted' WHERE id = ?", [id]);
    s.db.run("UPDATE hosts SET drain = 1 WHERE name = 'alpha'");
    expect(reconcile(ctx(s)).has(id)).toBe(false);
    expect(String(s.get("picks", { member: id })!.reason)).toMatch(/^WAIT slot: .*alpha draining/s);
  });

  test("main with room: a placed Builder starts on main and its row names no host", () => {
    const s = fixture();
    side(s, "alpha");
    const id = asks(s);
    expect(reconcile(ctx(s)).has(id)).toBe(true);
    expect(s.get("picks", { member: id })).toMatchObject({ slot: 1, host: null });
    expect(hostCol(s, id)).toBeNull();
  });

  test("a draining, fenced, behind, full, braking, stale or unreachable host is never chosen", () => {
    const s = fixture();
    side(s, "drain", { drain: 1 });
    side(s, "fence", { fenced_at: T });
    side(s, "oldlink", { link_version: "0" });
    side(s, "oldmig", { up_migration: "0001-old" });
    side(s, "full", {}, 1);
    live(s, "full");
    side(s, "hot");
    sample(s, "hot", { psi_cpu_some: 40 });                       // its own brake is on by default (KTD16)
    side(s, "stale");
    sample(s, "stale", { observed_at: T - 600 });
    side(s, "gone", { unreachable_since: T - 60 });
    side(s, "zero", {}, 0);
    expect(placeSide(s, "builder", T).host).toBeNull();
    expect(refusal(s, "drain", "builder", T)).toBe("draining");
    expect(refusal(s, "fence", "builder", T)).toBe("fenced");
    expect(refusal(s, "oldlink", "builder", T)).toBe("behind");
    expect(refusal(s, "oldmig", "builder", T)).toBe("behind");
    expect(refusal(s, "full", "builder", T)).toBe("full 1/1");
    expect(refusal(s, "hot", "builder", T)).toBe("brake: psi cpu 40 ≥ crit 25");
    expect(refusal(s, "stale", "builder", T)).toBe("machine sample stale");
    expect(refusal(s, "gone", "builder", T)).toBe("unreachable");
    expect(refusal(s, "zero", "builder", T)).toBe("full 0/0");
    // With main full the Builder waits on main, its reason naming each host passed over.
    live(s);
    const id = asks(s);
    expect(reconcile(ctx(s)).has(id)).toBe(false);
    const row = s.get("picks", { member: id }) as Row;
    expect(row).toMatchObject({ slot: 0, host: null });
    expect(String(row.reason)).toMatch(/^WAIT slot: /);
    expect(String(row.reason)).toContain("side hosts: drain draining, fence fenced");
    expect(hostCol(s, id)).toBeNull();
    // The host's brake turned off: the hot host takes it.
    hostSet(s, "hot", "builder_host_brake", "off");
    expect(reconcile(ctx(s)).has(id)).toBe(true);
    expect(hostCol(s, id)).toBe("hot");
  });

  test("candidates go in name order, and one walk counts its own placements against a host's seats", () => {
    const s = fixture();
    side(s, "beta", {}, 1);
    side(s, "alpha", {}, 1);
    live(s);
    const a = asks(s), b = asks(s), c = asks(s);
    const go = reconcile(ctx(s));
    expect([go.has(a), go.has(b), go.has(c)]).toEqual([true, true, false]);
    expect([hostCol(s, a), hostCol(s, b), hostCol(s, c)]).toEqual(["alpha", "beta", null]);
    expect(String(s.get("picks", { member: c })!.reason)).toContain("alpha full 1/1, beta full 1/1");
  });

  test("Lead, Thinker and Studio starts are never placed off main, even with main critical", () => {
    const s = fixture();
    side(s, "alpha");
    sample(s, "local", { psi_cpu_some: 40 });
    hostSet(s, "local", "builder_host_brake", "on");
    for (const role of ["lead", "thinker", "studio"]) expect(starts(pick(s, req(role), T)).host).toBeUndefined();
    const id = member(s, { role: "lead", suffix: "", want: "running", want_at: T });
    reconcile(ctx(s));
    expect(hostCol(s, id)).toBeNull();
  });

  test("a Tester or Researcher goes to a side host only while main is critical, and to none that is critical too", () => {
    const s = fixture();
    side(s, "alpha");
    sample(s, "local");
    expect(starts(pick(s, req("tester"), T)).host).toBeNull();
    sample(s, "local", { mem_avail_kb: 1_000_000 });
    const t = starts(pick(s, req("tester"), T));
    expect(t.host).toBe("alpha");
    expect(t.reason).toContain("on side host alpha (main host: mem");
    expect(starts(pick(s, req("researcher"), T)).host).toBe("alpha");
    // The side host critical too (its brake off does not matter): the Tester starts on main as before.
    hostSet(s, "alpha", "builder_host_brake", "off");
    sample(s, "alpha", { load1: 48 });
    expect(starts(pick(s, req("tester"), T)).host).toBeNull();
  });

  test("main's max_builders counts only Builders on main", () => {
    const s = fixture();
    side(s, "alpha");
    live(s, "alpha");
    const p = starts(pick(s, req("builder", { member: asks(s) }), T));
    expect(p.host).toBeNull();
    // A Builder an operator forced onto the side host is outside main's line too, full or not.
    live(s);
    const forced = asks(s, { host: "alpha" });
    starts(pick(s, req("builder", { member: forced }), T));
    starts(pick(s, req("builder", { member: forced, place: false }), T));
  });

  test("main's brake reads only main's sample; a side host's brake only its own", () => {
    const s = fixture();
    delete process.env.DS_LIMIT_MAX_BUILDERS;                         // no slot limit: only the brakes hold
    side(s, "alpha");
    hostSet(s, "local", "builder_host_brake", "on");
    sample(s, "local");
    sample(s, "alpha", { psi_cpu_some: 40 });
    expect(starts(pick(s, req("builder", { member: asks(s) }), T)).host).toBeNull();   // alpha's crit never brakes main
    // A Builder pinned to alpha waits on alpha's own brake while main is calm.
    const pinned = asks(s, { host: "alpha" });
    expect(waits(pick(s, req("builder", { member: pinned }), T)).reason).toBe("WAIT host: psi cpu 40 ≥ crit 25");
    // Main critical, alpha calm: main's brake holds the Builder and placement takes it to alpha.
    sample(s, "local", { psi_cpu_some: 40 });
    sample(s, "alpha");
    const moved = starts(pick(s, req("builder", { member: asks(s) }), T));
    expect(moved.host).toBe("alpha");
    expect(moved.reason).toContain("(main host: psi cpu 40 ≥ crit 25)");
    expect(starts(pick(s, req("builder", { member: pinned }), T)).host).toBeUndefined();
  });

  test("a shell pick (no place) never moves a start: main full still waits", () => {
    const s = fixture();
    side(s, "alpha");
    live(s);
    expect(waits(pick(s, req("builder", { member: asks(s), place: false }), T)).why).toBe("slot");
  });
});
