// max-builders.test.ts — U145: a project runs at most `max_builders` live Builder agents, oldest work
// first. Twenty-one Builders paused for real (checkpoint, terminals closed) and resumed under
// max_builders 6 through the decider and the real picker (bin/loop/capacity/pick.ts asks bin/loop/capacity/slot.ts): six start, the
// oldest; the rest wait with no orca call and no action row however many ticks pass, and the sweep
// (liveness, alerts, lifecycle) raises nothing for a dispatched unit waiting its turn.
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import pauseLifecycle from "../../bin/loop/fulfil/pause.ts";
import member from "../../bin/loop/fulfil/member.ts";
import pauseResume from "../../bin/loop/reconcilers/pause-resume.ts";
import decider from "../../bin/loop/core/decide.ts";
import liveness from "../../bin/loop/reconcilers/liveness.ts";
import alerts from "../../bin/loop/reconcilers/alerts.ts";
import lifecycle from "../../bin/loop/reconcilers/lifecycle.ts";
import { slot } from "../../bin/loop/capacity/slot.ts";
import { slotted } from "../../bin/loop/reconcilers/ready.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { orcaObserver } from "../../bin/loop/observers/orca.ts";
import { acknowledge, journalPath } from "../../bin/loop/pause/pause.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import type { Action, TickCtx } from "../../bin/loop/core/plugins.ts";

const T = 1_800_000_000, N = 21, MAX = 6;
const ENV = ["DS_LIMIT_MAX_BUILDERS", "DS_LOOP_START_SLOTS"];
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const e of ENV) delete process.env[e];
});

const slug = (i: number) => `u${String(i).padStart(2, "0")}`;
const wtOf = (i: number) => `wt_${slug(i)}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "max-builders-")); roots.push(root);
  const store = open(root); stores.push(store);
  copyFileSync(join(import.meta.dir, "../fixtures/loop/accounts.tsv"), join(root, "accounts.tsv"));
  importConfig(store, root, join(import.meta.dir, "../../conventions"));
  for (const r of accountRows(root)) store.upsert(r.table, r.key, r.set);
  store.upsert("projects", { label: "p" }, { observed_at: 1 });
  store.upsert("squads", { project: "p", topic: "one" }, { status: "running", run_id: "run_one", repo: "path:/fake", lead_wt: "wt_lead", observed_at: 1, updated_at: 1 });
  const orca = new FakeBackend();
  // Units inserted newest first, so the oldest work (lowest units.id) is the highest slug: the
  // order the line follows is the unit's, not the member row's or the name's.
  for (let i = N; i >= 1; i--) store.upsert("units", { project: "p", squad: "one", slug: slug(i) }, { status: "dispatched", builder_wt: wtOf(i), tier: "hard", observed_at: 1, updated_at: 1 });
  for (let i = 1; i <= N; i++) {
    const path = join(root, "wt", slug(i)); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "unfinished"), "local changes");
    store.upsert("members", { project: "p", squad: "one", role: "builder", suffix: slug(i) }, { wt: wtOf(i), status: "running", agent: "claude", model: "opus", account: "acct-a", tier: "hard", observed_at: 1, updated_at: 1 });
    store.upsert("observed_worktrees", { project: "p", wt: wtOf(i) }, { path, observed_at: 1 });
    orca.agent(wtOf(i), `term_${slug(i)}`, "claude");
  }
  const observer = orcaObserver(orca.observer(
    () => (store.db.query("SELECT wt FROM members WHERE wt IS NOT NULL").all() as { wt: string }[])
      .map((m) => ({ worktreeId: m.wt, path: String(store.get("observed_worktrees", { project: "p", wt: m.wt })?.path ?? "") })),
    () => (store.db.query("SELECT * FROM members").all() as Row[]).map((m) => ({ squad: "one", role: String(m.role), suffix: String(m.suffix), wt: String(m.wt),
      terminals: orca.agents.filter((a) => a.wt === m.wt).map((a) => a.handle) }))));
  // The process walk (U149): a worktree's main agent runs while Orca shows an agent terminal there.
  // Its first read seeds the Builders' wishes (seed.ts): running, their units dispatched.
  const walk = { name: "walk", run: (c: TickCtx) => {
    for (const m of c.store.db.query("SELECT DISTINCT wt FROM members WHERE wt IS NOT NULL").all() as { wt: string }[]) {
      const up = orca.agents.some((a) => a.wt === m.wt) ? "running" : "none";
      c.store.upsert("observed_workers", { project: "p", wt: m.wt }, { walk: up, presence: up, account_at: c.now, observed_at: c.now });
    }
  } };
  const act = new LoopActuator({ orca, fulfillers: [pauseLifecycle, member] });
  const loop = new Loop(store, { observers: [observer, walk], reconcilers: [pauseResume, decider, pauseLifecycle, member] }, act, { projects: () => ["p"] });
  let at = T;
  // One tick; a started agent shows in its worktree as Orca would show it on the next observation.
  const tick = async () => {
    await loop.tick(at++); await act.drain();
    for (const s of orca.started) if (!orca.agents.some((a) => a.wt === s.wt)) orca.agent(s.wt, `term_new_${s.wt}`, "claude");
  };
  const target = (i: number) => ({ project: "p", squad: "one", role: "builder", suffix: slug(i) });
  const checkpointAll = () => {
    mkdirSync(join(root, "p", "journals"), { recursive: true });
    for (let i = 1; i <= N; i++) {
      const t = target(i), row = store.get("pause_members", t)!, file = journalPath(store, t);
      writeFileSync(file, `- checkpoint ${row.generation}: test green; continue implementation\n`);
      acknowledge(store, t, String(row.generation), String(row.session), String(row.dispatch ?? "-"), file, at);
    }
  };
  const ctx = (): TickCtx => ({ store, project: "p", tick: at, now: at, fired: [], poked: new Set() });
  return { store, orca, loop, tick, target, checkpointAll, ctx, now: () => at };
}

const startOps = (f: ReturnType<typeof fixture>) => f.orca.calls.filter((c) => ["worker-start", "worker-resume", "role-start"].includes(c.op));

test("U153: a restarting Builder keeps its slot; a satisfied restart wish does not", () => {
  const f = fixture(), s = f.store;
  s.upsert("config", { project: "p", file: "limits.conf", key: "max_builders" }, { value: "1", observed_at: T });
  const b = (i: number) => s.db.query("SELECT * FROM members WHERE project = 'p' AND suffix = ?").get(slug(i)) as Row;
  for (let i = 1; i <= N; i++) s.upsert("observed_workers", { project: "p", wt: wtOf(i) }, { presence: "none", started_at: null, observed_at: T });
  // Builder 1 is live; Builder 2's agent is gone but its restart wish is newer than its process
  // start and its last start: it still holds the one slot, so a third Builder waits.
  s.upsert("members", { id: b(1).id }, { want: "running" });
  s.upsert("observed_workers", { project: "p", wt: wtOf(1) }, { presence: "running", started_at: T - 100, observed_at: T });
  s.upsert("members", { id: b(2).id }, { want: "running", restart_at: T - 10, placed_at: T - 100 });
  s.upsert("observed_workers", { project: "p", wt: wtOf(2) }, { presence: "none", started_at: null, observed_at: T });
  s.upsert("observed_workers", { project: "p", wt: wtOf(3) }, { presence: "none", started_at: null, observed_at: T });
  expect(slot(s, "p", { member: b(3) }, T).ok).toBe(false);
  // Once its fresh start lands (placed_at past the wish), the satisfied wish holds nothing.
  s.upsert("members", { id: b(2).id }, { placed_at: T - 5 });
  s.upsert("observed_workers", { project: "p", wt: wtOf(2) }, { presence: "none", started_at: null, account_at: T, observed_at: T });
  // Builder 1 alone is live under the limit of 1, so Builder 3 still waits for it, not for Builder 2:
  // removing Builder 1's agent frees the slot.
  f.orca.agents = f.orca.agents.filter((a) => a.wt !== wtOf(1));
  s.upsert("observed_workers", { project: "p", wt: wtOf(1) }, { presence: "none", started_at: null, observed_at: T });
  expect(slot(s, "p", { member: b(3) }, T).ok).toBe(true);
});

test(`resume of ${N} paused Builders under max_builders ${MAX} starts ${MAX}, the oldest, and the rest wait quietly`, async () => {
  process.env.DS_LOOP_START_SLOTS = "30";   // the host start budget is not what holds them back
  const f = fixture();
  f.loop.boot(T);
  f.store.pause({ scope: "squad", project: "p", squad: "one" });
  await f.tick(); f.checkpointAll(); await f.tick(); await f.tick();
  for (let i = 1; i <= N; i++) expect(f.store.get("pause_members", f.target(i))?.state).toBe("paused");
  expect(f.orca.agents).toHaveLength(0);
  // No wish written by anyone: the first walk seeded each running, its agent seen (U152).
  expect(f.store.db.query("SELECT COUNT(*) AS n FROM members WHERE want = 'running' AND want_by = 'seed'").get()).toEqual({ n: N });

  f.store.upsert("config", { project: "p", file: "limits.conf", key: "max_builders" }, { value: String(MAX), observed_at: T });
  f.store.resume({ scope: "squad", project: "p", squad: "one" });
  for (let n = 0; n < 4; n++) await f.tick();

  // Six started: the oldest units, u21 … u16 (lowest units.id).
  const oldest = Array.from({ length: MAX }, (_, k) => wtOf(N - k)).sort();
  expect(f.orca.started.map((s) => s.wt).sort()).toEqual(oldest);
  const waiting = Array.from({ length: N - MAX }, (_, k) => k + 1);   // u01 … u15
  for (const i of waiting) {
    const m = f.store.get("members", f.target(i))!;
    expect(f.store.get("picks", { member: m.id })).toMatchObject({ slot: 0, wait_until: null, reason: `WAIT slot: p at max_builders ${MAX}` });
    expect(f.store.get("pause_members", f.target(i))?.state).toBe("resuming");
    expect(f.store.get("units", { project: "p", squad: "one", slug: slug(i) })?.wait_until ?? null).toBeNull();
  }

  // Repeat ticks: no orca call, no action row for a refused start.
  const calls = startOps(f).length;
  for (let n = 0; n < 5; n++) await f.tick();
  expect(startOps(f)).toHaveLength(calls);
  for (const i of waiting) {
    const m = f.store.get("members", f.target(i))!;
    expect(f.store.db.query("SELECT 1 FROM episodes WHERE project = 'p' AND kind = 'action:member' AND subject = ?").get(`member:${m.id}`)).toBeNull();
    expect(f.store.db.query("SELECT 1 FROM orca_calls WHERE member = ? AND op IN ('worker-start', 'worker-resume', 'role-start')").get(wtOf(i))).toBeNull();
  }

  // The sweep raises nothing for a dispatched unit waiting its turn: no GONE mark, poke, restart,
  // crash request or alert names a waiting Builder.
  const c = f.ctx(), out: Action[] = [];
  for (const r of [liveness, alerts, lifecycle]) out.push(...((await r.run(c)) ?? []));
  const names = (a: Action) => JSON.stringify(a);
  for (const i of waiting) expect(out.filter((a) => names(a).includes(wtOf(i)) || names(a).includes(`/${slug(i)}`))).toEqual([]);
  for (const i of waiting) expect(f.store.get("members", f.target(i))?.status).not.toBe("gone");

  // A slot frees (one Builder finishes and goes): the next oldest starts, and only it.
  f.store.upsert("members", f.target(N), { status: "gone", want: "gone" });
  f.orca.agents = f.orca.agents.filter((a) => a.wt !== wtOf(N));
  await f.tick(); await f.tick();
  expect(f.orca.started.map((s) => s.wt)).toContain(wtOf(N - MAX));
  expect(f.orca.started).toHaveLength(MAX + 1);
});

// U168: an urgent unit gets the next Builder place, even at the limit. Direct slot() checks on a
// small store: live members hold agents, waiting ones hold open start wishes, planned units ask
// with no member row yet.
function urgentSetup(max: number) {
  const root = mkdtempSync(join(tmpdir(), "urgent-slot-")); roots.push(root);
  const store = open(root); stores.push(store);
  store.upsert("projects", { label: "p" }, { observed_at: 1 });
  store.upsert("squads", { project: "p", topic: "one" }, { status: "running", run_id: "run_one", repo: "path:/fake", lead_wt: "wt_lead", observed_at: 1, updated_at: 1 });
  store.upsert("config", { project: "p", file: "limits.conf", key: "max_builders" }, { value: String(max), observed_at: T });
  const unit = (slug: string, status: string, urgent = false) =>
    store.upsert("units", { project: "p", squad: "one", slug },
      { status, builder_wt: "", tier: "hard",
        doc: JSON.stringify({ slug, status, ...(urgent ? { urgent: true, urgent_why: "operator need" } : {}) }),
        observed_at: 1, updated_at: 1 });
  // A running member the observer never saw holds a live agent; a waiting one with an open start
  // wish asks for a slot.
  const live = (slug: string) =>
    store.upsert("members", { project: "p", squad: "one", role: "builder", suffix: slug },
      { wt: `wt_${slug}`, status: "running", agent: "claude", model: "opus", observed_at: 1, updated_at: 1 });
  const waiting = (slug: string) =>
    store.upsert("members", { project: "p", squad: "one", role: "builder", suffix: slug },
      { wt: `wt_${slug}`, status: "waiting", want: "running", want_at: T, agent: "claude", model: "opus", observed_at: 1, updated_at: 1 });
  const unmark = (slug: string, status: string) =>
    store.upsert("units", { project: "p", squad: "one", slug },
      { doc: JSON.stringify({ slug, status }), observed_at: 1, updated_at: 1 });
  return { store, unit, live, waiting, unmark };
}

test("an urgent planned unit starts at the limit while a non-urgent one still waits (U168)", () => {
  const f = urgentSetup(2);
  for (const s of ["u1", "u2"]) { f.unit(s, "dispatched"); f.live(s); }
  for (const s of ["u3", "u4", "u5"]) { f.unit(s, "dispatched"); f.waiting(s); }
  f.unit("u6", "planned", true);
  f.unit("u7", "planned");
  expect(slot(f.store, "p", { squad: "one", suffix: "u6" }, T).ok).toBe(true);
  const w = slot(f.store, "p", { squad: "one", suffix: "u7" }, T);
  expect(w.ok).toBe(false);
  if (!w.ok) {
    expect(w.live).toBe(2);
    expect(w.ahead).toBe(3);
  }
});

test("two urgent candidates at the limit both start (U168)", () => {
  const f = urgentSetup(2);
  for (const s of ["u1", "u2"]) { f.unit(s, "dispatched"); f.live(s); }
  for (const s of ["u3", "u4", "u5"]) { f.unit(s, "dispatched"); f.waiting(s); }
  f.unit("u6", "planned", true);
  f.unit("u7", "planned");
  f.unit("u8", "planned", true);
  expect(slot(f.store, "p", { squad: "one", suffix: "u6" }, T).ok).toBe(true);
  expect(slot(f.store, "p", { squad: "one", suffix: "u8" }, T).ok).toBe(true);
  // The ready set holds both urgent units, not the non-urgent one between them: planned units with
  // no wish yet (extraAhead) never count ahead of an urgent asker.
  expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0u6", "one\0u8"]));
});

test("an urgent unit below the limit is first in line ahead of older dispatched candidates (U168)", () => {
  const f = urgentSetup(3);
  for (const s of ["u1", "u2"]) { f.unit(s, "dispatched"); f.live(s); }
  f.unit("u3", "dispatched"); f.waiting("u3");
  f.unit("u4", "planned");
  f.unit("u6", "planned", true);
  expect(slot(f.store, "p", { squad: "one", suffix: "u6" }, T).ok).toBe(true);
  // The older dispatched wish blocks the older planned unit, but the urgent one jumps it.
  expect(slotted(f.store, "p", T)).toEqual(new Set(["one\0u6"]));
});

test("urgent off puts a waiting unit back in its normal place; a running Builder keeps running (U168)", () => {
  const f = urgentSetup(2);
  for (const s of ["u1", "u2"]) { f.unit(s, "dispatched"); f.live(s); }
  for (const s of ["u3", "u4", "u5"]) { f.unit(s, "dispatched"); f.waiting(s); }
  f.unit("u6", "planned", true);
  expect(slot(f.store, "p", { squad: "one", suffix: "u6" }, T).ok).toBe(true);
  f.unmark("u6", "planned");
  expect(slot(f.store, "p", { squad: "one", suffix: "u6" }, T).ok).toBe(false);
  // Once its Builder runs, unmarking changes nothing.
  f.unit("u6", "dispatched", true); f.live("u6");
  expect(slot(f.store, "p", { squad: "one", suffix: "u6" }, T).ok).toBe(true);
  f.unmark("u6", "dispatched");
  expect(slot(f.store, "p", { squad: "one", suffix: "u6" }, T).ok).toBe(true);
});
