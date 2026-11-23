// slot-memo.test.ts — loop-tick-8s U3: one picks walk reads the facts slot() and pick() need once
// (bin/loop/capacity/walk-memo.ts), and makes the same picks as a walk that reads them every time.
// The fixture: max_builders 3, one Builder working, one held by an open fallback reserve, three waiting.
// The first waiter takes the last seat; the next two, later in the same walk, must see it taken.
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { decide } from "../../bin/loop/core/decide.ts";
import { reconcile } from "../../bin/loop/capacity/picks.ts";
import { RESERVE } from "../../bin/loop/capacity/pick.ts";
import { seats, slot } from "../../bin/loop/capacity/slot.ts";
import { memo, withDecideMemo, withWalkMemo } from "../../bin/loop/capacity/walk-memo.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const T = 1_800_000_000;
const ENV = ["DS_LIMIT_MAX_BUILDERS", "DS_LOOP_START_SLOTS", "DS_PICK_MEMO"];
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const e of ENV) delete process.env[e];
});

const SLUGS = ["u1", "u2", "u3", "u4", "u5"];   // u1 working, u2 reserved, u3-u5 waiting (oldest unit first)

function fixture(): Store {
  const root = mkdtempSync(join(tmpdir(), "slot-memo-")); roots.push(root);
  const store = open(root); stores.push(store);
  copyFileSync(join(import.meta.dir, "../fixtures/loop/accounts.tsv"), join(root, "accounts.tsv"));
  importConfig(store, root, join(import.meta.dir, "../../conventions"));
  for (const r of accountRows(root)) store.upsert(r.table, r.key, r.set);
  store.upsert("projects", { label: "p" }, { observed_at: 1 });
  store.upsert("squads", { project: "p", topic: "one" }, { status: "running", run_id: "run_one", repo: "path:/fake", lead_wt: "wt_lead", observed_at: 1, updated_at: 1 });
  for (const s of SLUGS) store.upsert("units", { project: "p", squad: "one", slug: s }, { status: "dispatched", builder_wt: `wt_${s}`, tier: "hard", observed_at: 1, updated_at: 1 });
  for (const s of SLUGS) {
    const live = s === "u1";
    store.upsert("members", { project: "p", squad: "one", role: "builder", suffix: s }, { wt: `wt_${s}`, status: live ? "running" : "waiting", want: "running",
      want_at: T - 600, agent: "claude", model: "opus", account: "acct-a", tier: "hard", observed_at: 1, updated_at: 1 });
    store.upsert("observed_workers", { project: "p", wt: `wt_${s}` }, { presence: live ? "running" : "none", walk: live ? "running" : "none",
      state: live ? "working" : null, account_at: T - 60, observed_at: T - 60 });
  }
  // u2 was stopped to move back up: its fallback-reserve holds its seat (pick.ts reservations()).
  const u2 = store.get("members", { project: "p", squad: "one", role: "builder", suffix: "u2" })!;
  store.upsert("episodes", { project: "p", subject: `member:${u2.id}`, kind: RESERVE }, { squad: "one", state: "reserved", started_at: T - 60, ended_at: T + 600,
    episode_key: JSON.stringify({ agent: "claude", model: "opus", account: "acct-b" }), source: "loop", observed_at: T - 60 });
  process.env.DS_LIMIT_MAX_BUILDERS = "3";
  process.env.DS_LOOP_START_SLOTS = "5";
  return store;
}

const ctx = (store: Store, now = T): TickCtx => ({ store, project: "", tick: now, now, fired: [], poked: new Set() });
const member = (store: Store, s: string) => store.get("members", { project: "p", squad: "one", role: "builder", suffix: s })!;
const picks = (store: Store) => store.db.query("SELECT m.suffix, p.agent, p.model, p.account, p.slot, p.reason, p.wait_until FROM picks p JOIN members m ON m.id = p.member ORDER BY m.suffix").all();
const slots = (store: Store) => SLUGS.map((s) => slot(store, "p", { member: Number(member(store, s).id), squad: "one", suffix: s }, T));
// The walk, with the memo on or off (DS_PICK_MEMO=0), counting every statement the store runs.
function walk(on: boolean) {
  const store = fixture();
  if (on) delete process.env.DS_PICK_MEMO; else process.env.DS_PICK_MEMO = "0";
  let calls = 0;
  const q = store.db.query.bind(store.db);
  store.db.query = ((sql: string) => { const st = q(sql) as Row; return new Proxy(st, { get(t, k) {
    const v = Reflect.get(t, k); return typeof v === "function" && ["get", "all", "run", "values"].includes(String(k)) ? (...a: unknown[]) => { calls++; return v.apply(t, a); } : v;
  } }); }) as typeof store.db.query;
  const eligible = ["u3", "u4", "u5"].map((s) => member(store, s));
  const go = reconcile(ctx(store), { eligible, moves: new Map() });
  store.db.query = q;
  return { store, go: [...go].map((id) => String(store.get("members", { id })!.suffix)).sort(), picks: picks(store), slots: slots(store), calls };
}

test("the walk makes the same picks with the memo as without it, in far fewer reads", () => {
  const off = walk(false), on = walk(true);
  // The working Builder and the reserved one hold two of three seats: u3 (the oldest waiting unit) takes
  // the last, and u4 and u5, picked after it in the same walk, see it taken.
  expect(off.go).toEqual(["u3"]);
  const byS = Object.fromEntries((off.picks as Row[]).map((p) => [p.suffix, p]));
  expect(byS.u3.slot).toBe(1);
  for (const s of ["u4", "u5"]) { expect(byS[s].slot).toBe(0); expect(String(byS[s].reason)).toStartWith("WAIT slot:"); }
  expect(on.go).toEqual(off.go);
  expect(on.picks).toEqual(off.picks);
  expect(on.slots).toEqual(off.slots);
  expect(on.calls).toBeLessThan(off.calls / 2);
});

test("slot() reads the same inside a walk scope as outside it", () => {
  const store = fixture();
  const outside = slots(store);
  const inside = withWalkMemo(store, T, () => [slots(store), slots(store)]);
  expect(inside[0]).toEqual(outside);
  expect(inside[1]).toEqual(outside);
  expect(seats(store, "p", T)).toEqual(withWalkMemo(store, T, () => seats(store, "p", T)));
  // The seats: u1 working, u2 restarting on its reserve.
  expect(seats(store, "p", T).holders.map((h) => [h.suffix, h.why])).toEqual([["u1", "working"], ["u2", "restarting"]]);
});

test("a start slot given in the walk is read live, the rest is kept", () => {
  const store = fixture();
  const u3 = Number(member(store, "u3").id), u4 = Number(member(store, "u4").id);
  withWalkMemo(store, T, () => {
    expect(slot(store, "p", { member: u4, squad: "one", suffix: "u4" }, T).ok).toBe(false);   // u3 is ahead of it
    expect(slot(store, "p", { member: u3, squad: "one", suffix: "u3" }, T).ok).toBe(true);
    store.db.run("CREATE TEMP TABLE picks AS SELECT * FROM main.picks WHERE 0");
    store.db.run("INSERT INTO temp.picks (member, project, squad, role, agent, model, account, slot, reason) VALUES (?, 'p', 'one', 'builder', 'claude', 'opus', 'acct-a', 1, 'test')", [u3]);
    // u3 now holds a start slot: the last seat is taken for u4 too, and u3's own seat counts.
    const s4 = slot(store, "p", { member: u4, squad: "one", suffix: "u4" }, T);
    expect(s4.ok).toBe(false);
    expect(seats(store, "p", T).holders.map((h) => [h.suffix, h.why])).toEqual([["u1", "working"], ["u2", "restarting"], ["u3", "starting"]]);
    store.db.run("DROP TABLE temp.picks");
  });
});

test("decide gives the same actions and picks with the memo as without it", () => {
  const run = (on: boolean) => {
    const store = fixture();
    if (!on) process.env.DS_PICK_MEMO = "0"; else delete process.env.DS_PICK_MEMO;
    const out = decide(ctx(store));
    return { out: out.map((a) => ({ ...a, payload: a.payload })), picks: picks(store) };
  };
  const off = run(false), on = run(true);
  // u2 starts on its reserve (its own seat), u3 takes the last one; u4 and u5, picked later, wait.
  expect((off.picks as Row[]).map((p) => [p.suffix, p.slot])).toEqual([["u2", 1], ["u3", 1], ["u4", 0], ["u5", 0]]);
  for (const p of (off.picks as Row[]).slice(2)) expect(String(p.reason)).toStartWith("WAIT slot:");
  expect(on).toEqual(off);
});

test("a memo keeps only its own store and time, and nothing outside a scope", () => {
  const a = fixture(), b = fixture();
  let reads = 0;
  const read = () => ++reads;
  expect([memo(a, T, "k", "x", read), memo(a, T, "k", "x", read)]).toEqual([1, 2]);   // no scope: read each time
  withWalkMemo(a, T, () => {
    expect(memo(a, T, "k", "x", read)).toBe(3);
    expect(memo(a, T, "k", "x", read)).toBe(3);
    expect(memo(a, null, "k", "x", read)).toBe(3);
    expect(memo(a, T + 1, "k", "y", read)).toBe(4);   // another time: not kept
    expect(memo(a, T + 1, "k", "y", read)).toBe(5);
    expect(memo(b, T, "k", "x", read)).toBe(6);       // another store: not kept
    expect(memo(b, T, "k", "x", read)).toBe(7);
  });
  expect(memo(a, T, "k", "x", read)).toBe(8);
  // The decide scope keeps only the facts no decide writes; a walk scope inside it keeps the rest.
  withDecideMemo(a, T, () => {
    expect([memo(a, null, "limit", "p\0x", read), memo(a, null, "limit", "p\0x", read)]).toEqual([9, 9]);
    expect([memo(a, null, "builders", "p", read), memo(a, null, "builders", "p", read)]).toEqual([10, 11]);
    withWalkMemo(a, T, () => {
      expect(memo(a, null, "limit", "p\0x", read)).toBe(9);
      expect([memo(a, null, "builders", "p", read), memo(a, null, "builders", "p", read)]).toEqual([12, 12]);
    });
    expect(memo(a, null, "builders", "p", read)).toBe(13);
  });
  process.env.DS_PICK_MEMO = "0";
  withWalkMemo(a, T, () => expect([memo(a, T, "k", "x", read), memo(a, T, "k", "x", read)]).toEqual([14, 15]));
});
