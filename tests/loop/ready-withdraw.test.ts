// ready-withdraw.test.ts — hold-cancels-queue-undo-approval U1: a Builder wish that has not started
// follows its unit (bin/loop/squad/queued-builder.ts). A hold, a cancel or a lost plan approval
// withdraws it, so a freed seat never starts it; releasing the unit wishes a fresh one.
// Fixture squad `demo` (tests/fixtures/loop/state): u4 is ready once u2 is done; the rest are held.
import { afterEach, afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { exportJson } from "../../bin/loop/db/export-json.ts";
import { DIRS, load } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import picker from "../../bin/loop/core/decide.ts";
import ready from "../../bin/loop/reconcilers/ready.ts";
import { queuedWhy, withdrawRefused } from "../../bin/loop/squad/queued-builder.ts";
import requests from "../../bin/loop/reconcilers/requests.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const W = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/";
const LEAD = `${W}ds-dev-studio-lead-demo`;
const U2 = "u2-sqlite-store-migrations-and", U4 = "u4-orca-state-file-config", U3 = "u3-loop-daemon-skeleton-health";
const DEMO_PLAN = "/state/fx/squads/demo-loop-plan.md";
const TITLE = `ds-fx-builder-${U4}-demo`;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  delete process.env.DS_NOW;
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
beforeAll(() => { process.env.DS_LOOP_RETRY_S = "1"; });
afterAll(() => { delete process.env.DS_LOOP_RETRY_S; });

function setApproved(s: Store, plans: string[]) {
  const row = s.get("squads", { project: "fx", topic: "demo" })!;
  const doc = JSON.parse(String(row.doc ?? "{}"));
  s.upsert("squads", { project: "fx", topic: "demo" }, { doc: JSON.stringify({ ...doc, approved_plans: plans }) });
}
function fixture(): Store {
  const root = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(root, "accounts.tsv"));
  const conv = mkdtempSync(join(tmpdir(), "zzconv-")); temps.push(conv);
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  const s = open(root); stores.push(s);
  importJson(s);
  const doc = JSON.parse(String(s.get("squads", { project: "fx", topic: "demo" })!.doc ?? "{}"));
  setApproved(s, [...(doc.approved_plans ?? []), DEMO_PLAN]);
  importConfig(s, root, conv);
  s.upsert("observed_workers", { project: "fx", wt: LEAD }, { state: "idle", observed_at: T });
  for (const h of [U3, "u6-takes-u5", "u8-waits", "u9-ext-archived"]) s.db.run("UPDATE units SET hold = 1 WHERE slug = ?", [h]);
  return s;
}
const fulfillers = await load<Fulfiller>(DIRS.fulfil);
// `withReady` false leaves out the ready reconciler, so only the start-time check can refuse.
function rig(s: Store, withReady = true) {
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [picker, ...(withReady ? [ready] : []), requests, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { process.env.DS_NOW = String(at); const r = await loop.tick(at); await act.drain(); return r; };
  const starts = () => orca.of("role-start").map((c) => String(c.args[6]));
  return { orca, tick, starts };
}
const rows = (s: Store) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = 'demo' AND role = 'builder' AND suffix = ? ORDER BY id").all(U4) as Row[];
const unit = (s: Store, col: string, v: unknown) => s.db.run(`UPDATE units SET ${col} = ? WHERE slug = ?`, [v as never, U4]);
const withdrawn = (s: Store) => (s.db.query("SELECT payload FROM events WHERE kind = 'builder_wish_withdrawn' ORDER BY id").all() as { payload: string }[]).map((e) => JSON.parse(e.payload));
// One seat, taken by an older live Builder: a wish for u4 waits in the queue.
function fullSeat(s: Store) {
  s.upsert("config", { project: "fx", file: "limits.conf", key: "max_builders" }, { value: "1", observed_at: T });
  s.upsert("members", { project: "fx", squad: "demo", role: "builder", suffix: "older" }, { wt: `${W}older`, status: "running", want: "stopped", observed_at: T, updated_at: T });
}
const freeSeat = (s: Store, at: number) => s.upsert("config", { project: "fx", file: "limits.conf", key: "max_builders" }, { value: "3", observed_at: at });
async function queuedU4(s: Store, tick: (at: number) => Promise<unknown>) {
  fullSeat(s);
  unit(s, "status", "planned");
  s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
  await tick(T);
  await tick(T + 1);
  expect(rows(s)).toHaveLength(1);
  expect(rows(s)[0]).toMatchObject({ want: "running", status: "wanted", want_by: "loop" });
}

describe("a queued Builder follows its unit", () => {
  test("a hold withdraws it, a freed seat starts nothing, the release wishes a fresh one that starts", async () => {
    const s = fixture(), { tick, starts } = rig(s);
    await queuedU4(s, tick);
    const first = Number(rows(s)[0].id);
    unit(s, "hold", 1);
    await tick(T + 2);
    expect(rows(s)[0]).toMatchObject({ want: "gone", status: "gone", want_by: "loop" });
    expect(withdrawn(s)).toEqual([{ id: first, unit: U4, why: "held", by: "loop" }]);
    freeSeat(s, T + 3);
    for (let i = 3; i < 6; i++) await tick(T + i);
    expect(starts()).toEqual([]);
    expect(rows(s)).toHaveLength(1);   // a held unit gets no new wish either
    unit(s, "hold", 0);
    await tick(T + 6);
    await tick(T + 7);
    expect(rows(s)).toHaveLength(2);
    expect(Number(rows(s)[1].id)).not.toBe(first);
    expect(starts()).toEqual([TITLE]);
    expect(s.get("units", { project: "fx", squad: "demo", slug: U4 })?.status).toBe("dispatched");
  });

  test("a cancel withdraws it; nothing starts", async () => {
    const s = fixture(), { tick, starts } = rig(s);
    await queuedU4(s, tick);
    unit(s, "status", "cancelled");
    await tick(T + 2);
    expect(rows(s)[0]).toMatchObject({ want: "gone", status: "gone" });
    expect(withdrawn(s).map((e) => e.why)).toEqual(["cancelled"]);
    freeSeat(s, T + 3);
    for (let i = 3; i < 6; i++) await tick(T + i);
    expect(starts()).toEqual([]);
  });

  test("a plan dropped from approved_plans withdraws the loop's wish", async () => {
    const s = fixture(), { tick, starts } = rig(s);
    await queuedU4(s, tick);
    setApproved(s, []);
    await tick(T + 2);
    expect(withdrawn(s).map((e) => e.why)).toEqual(["plan not approved"]);
    freeSeat(s, T + 3);
    for (let i = 3; i < 6; i++) await tick(T + i);
    expect(starts()).toEqual([]);
    setApproved(s, [DEMO_PLAN]);
    await tick(T + 6);
    await tick(T + 7);
    expect(starts()).toEqual([TITLE]);
  });

  test("a Lead's own wish on a held unit is kept and starts; a cancel still withdraws one", async () => {
    const s = fixture(), { tick, starts } = rig(s);
    fullSeat(s);
    s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
    unit(s, "hold", 1);
    const lead = () => {
      const { row } = s.want("member", `fx/demo/builder/${U4}`, "running", { payload: { why: "start", request: true, unit: U4 }, by: "lead", rearm: true });
      s.db.run("UPDATE members SET status = 'wanted', phase = 'build' WHERE id = ?", [Number(row.id)]);
    };
    lead();
    await tick(T);
    await tick(T + 1);
    expect(rows(s)[0]).toMatchObject({ want: "running", status: "wanted", want_by: "lead" });
    freeSeat(s, T + 2);
    await tick(T + 2);
    expect(starts()).toEqual([TITLE]);
    // A second squad's worth: a fresh Lead wish on another fixture, then the unit cancelled.
    const s2 = fixture(), r2 = rig(s2);
    fullSeat(s2);
    s2.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
    s2.db.run("UPDATE units SET hold = 1 WHERE slug = ?", [U4]);
    const { row } = s2.want("member", `fx/demo/builder/${U4}`, "running", { payload: { why: "start", request: true, unit: U4 }, by: "lead", rearm: true });
    s2.db.run("UPDATE members SET status = 'wanted' WHERE id = ?", [Number(row.id)]);
    s2.db.run("UPDATE units SET status = 'cancelled' WHERE slug = ?", [U4]);
    await r2.tick(T);
    expect(rows(s2)[0]).toMatchObject({ want: "gone", status: "gone", want_by: "loop" });
    expect(withdrawn(s2)).toEqual([{ id: Number(row.id), unit: U4, why: "cancelled", by: "loop" }]);
  });

  test("a builder row wished gone with no worktree is settled, and its unit is wished again", async () => {
    const s = fixture(), { tick, starts } = rig(s);
    s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
    s.upsert("members", { project: "fx", squad: "demo", role: "builder", suffix: U4 },
      { status: "wanted", want: "gone", want_by: "lead", want_at: T - 60, observed_at: T - 60, updated_at: T - 60 });
    await tick(T);
    expect(rows(s)[0]).toMatchObject({ want: "gone", status: "gone" });
    expect((s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'builder_wish_settled'").get() as { n: number }).n).toBe(1);
    expect(rows(s)).toHaveLength(2);
    expect(rows(s)[1]).toMatchObject({ want: "running", want_by: "loop" });
    await tick(T + 1);
    expect(starts()).toEqual([TITLE]);
  });

  test("the start itself refuses a wish whose unit was held since it was written", async () => {
    const s = fixture(), { tick, starts } = rig(s, false);
    s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
    // The wish as ready.ts writes it, then a hold before the start tick (ready.ts is off here).
    const { row } = s.want("member", `fx/demo/builder/${U4}`, "running", { payload: { why: "start", request: true, unit: U4 }, by: "loop", why: "ready" });
    s.fact("member_requested", [{ table: "members", key: { id: row.id }, set: { phase: "build", status: "wanted", updated_at: T } }], { project: "fx", squad: "demo", unit: U4 });
    unit(s, "hold", 1);
    await tick(T);
    await tick(T + 1);
    expect(starts()).toEqual([]);
    expect(rows(s)[0]).toMatchObject({ want: "gone", status: "gone" });
    expect(withdrawn(s)).toEqual([{ id: Number(row.id), unit: U4, why: "held", by: "loop" }]);
  });

  test("a started Builder, a start already sent and a paused wish are never withdrawn", () => {
    const s = fixture();
    for (const slug of [U4, U3, "u6-takes-u5"]) s.db.run("UPDATE units SET hold = 1 WHERE slug = ?", [slug]);
    const add = (suffix: string, set: Row) => {
      s.upsert("members", { project: "fx", squad: "demo", role: "builder", suffix }, { want: "running", want_by: "loop", want_at: T - 5, observed_at: T, updated_at: T, ...set });
      return s.get("members", { project: "fx", squad: "demo", role: "builder", suffix })!;
    };
    const running = add(U4, { wt: `${W}${TITLE}`, status: "running", started: T - 600 });
    const sent = add(U3, { status: "wanted" });
    s.db.run("INSERT INTO orca_calls (key, retry_id, state, at, op) VALUES (?, ?, 'sent', ?, 'role-start')", [`start:${Number(sent.id)}:e1`, "r1", T - 2]);
    const paused = add("u6-takes-u5", { status: "wanted" });
    s.upsert("pause_members", { project: "fx", squad: "demo", role: "builder", suffix: "u6-takes-u5" }, { state: "paused", generation: "g1", requested_at: T });
    expect(queuedWhy(s, sent, false, T)).toBeNull();   // the start fulfiller too sees another start out
    expect(withdrawRefused(s, "fx", "demo", T)).toBe(0);
    for (const m of [running, sent, paused]) expect(s.get("members", { id: m.id })).toMatchObject({ want: "running", status: m.status });
    // The call settles: the same wish is now queued and goes.
    s.db.run("UPDATE orca_calls SET state = 'absent' WHERE key = ?", [`start:${Number(sent.id)}:e1`]);
    expect(withdrawRefused(s, "fx", "demo", T)).toBe(1);
    expect(withdrawn(s)).toEqual([{ id: Number(sent.id), unit: U3, why: "held", by: "loop" }]);
  });
});

describe("squad-state withdraws the queued Builder in its own write", () => {
  const sh = (s: Store, ...args: string[]) => {
    const r = Bun.spawnSync([join(ROOT, "bin", "role", "squad-state.sh"), join(s.root, "fx", "squads", "demo.json"), ...args], { env: { ...process.env, DS_STATE_ROOT: s.root } });
    expect(r.stderr.toString()).not.toContain("error");
    expect(r.exitCode).toBe(0);
  };
  async function queued(lead: boolean) {
    const s = fixture(), { tick } = rig(s);
    writeFileSync(join(s.root, ".loop-migrated"), "test\n");
    fullSeat(s);
    s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
    if (lead) {
      const { row } = s.want("member", `fx/demo/builder/${U4}`, "running", { payload: { why: "start", request: true, unit: U4 }, by: "lead", rearm: true });
      s.db.run("UPDATE members SET status = 'wanted' WHERE id = ?", [Number(row.id)]);
    } else await tick(T);
    exportJson(s);
    expect(rows(s)[0]).toMatchObject({ want: "running", status: "wanted" });
    return s;
  }
  test("set-unit-hold on withdraws a Lead's queued wish at once, with the hold's reason", async () => {
    const s = await queued(true);
    sh(s, "set-unit-hold", U4, "on", "--why", "operator wants it later");
    expect(rows(s)[0]).toMatchObject({ want: "gone", status: "gone", want_by: "set-unit-hold" });
    expect(withdrawn(s)).toEqual([{ id: Number(rows(s)[0].id), unit: U4, why: "held", by: "set-unit-hold", reason: "operator wants it later" }]);
  });
  test("cancel-unit withdraws the loop's queued wish at once", async () => {
    const s = await queued(false);
    sh(s, "cancel-unit", U4, "--why", "folded elsewhere");
    expect(rows(s)[0]).toMatchObject({ want: "gone", status: "gone", want_by: "cancel-unit" });
    expect(withdrawn(s).map((e) => [e.why, e.by, e.reason])).toEqual([["cancelled", "cancel-unit", "folded elsewhere"]]);
  });
});
