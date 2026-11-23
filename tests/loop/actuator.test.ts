// actuator.test.ts — U11: the actuator, its fulfillers, the drivers and handoff, against the fake
// Orca (bin/loop/fakes/orca.ts). Every test works on a copy of tests/fixtures/loop/state in a temp
// dir (a hermetic state root); nothing here talks to a real Orca.
import { beforeAll, afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failRequest, LoopActuator, ladderPick, type Exec, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { codex } from "../../bin/loop/drivers/codex.ts";
import { muse } from "../../bin/loop/drivers/muse.ts";
import { standingNote, type Member, type Seat } from "../../bin/loop/drivers/types.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { handoff, withRoleNotes, NO_HEARTBEAT_NOTE, notesNote, PR_NOTE, TELL, worksAgain } from "../../bin/loop/squad/handoff.ts";
import { holdCredits } from "../../bin/loop/capacity/credits.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { childEnv, shell } from "../../bin/loop/io/orca.ts";
import { DIRS, load, type Action, type Reconciler, type TickCtx } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import requestsReconciler, { roleSpec } from "../../bin/loop/reconcilers/requests.ts";
import liveness from "../../bin/loop/reconcilers/liveness.ts";
import { pick } from "../../bin/loop/capacity/pick.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

import { classify, clear, fingerprint, lapse, launchRetryAt, LAUNCH_TRIES, refuse } from "../../bin/loop/io/refusals.ts";
import phases from "../../bin/loop/reconcilers/phases.ts";
import decider from "../../bin/loop/core/decide.ts";
import { alertGone, dropAlerts } from "../../bin/loop/reconcilers/alerts.ts";
import { wake } from "../../bin/loop/pause/wake.ts";
import { markStopping, resetStopping } from "../../bin/loop/core/stopping.ts";

// U150: a transient refusal is tried again every 15 minutes (DS_LOOP_RETRY_S); these tests step
// a retry one tick at a time. The spacing itself is tested in actuator.test.ts ("refusals").
beforeAll(() => { process.env.DS_LOOP_RETRY_S = "1"; });
afterAll(() => { delete process.env.DS_LOOP_RETRY_S; });

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const WS = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo";
const LEAD = `${WS}/ds-dev-studio-lead-demo`;
const THINKER = `${WS}/ds-dev-studio-thinker-demo`;
const ACCT = "6b9a19e7-e78f-4a78-ba77-b573b3c9f95d";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(d); return d; }
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

// A loop over the decider (U152: it files the starts) and the real fulfillers (plus `extra`
// reconcilers after them), with the fake Orca.
function rig(s: Store, o: { orca?: FakeOrca; pick?: Picker; extra?: Reconciler[] } = {}) {
  const orca = o.orca ?? new FakeOrca();
  const act = new LoopActuator({ orca, pick: o.pick ?? picked(), fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...fulfillers, ...(o.extra ?? [])] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { const r = await loop.tick(at); await act.drain(); return r; };
  return { orca, act, loop, tick };
}
const once = (actions: Action[]): Reconciler => { let done = false; return { name: "once", run: () => (done ? [] : ((done = true), actions)) }; };
const claim = (s: Store, a: { subject: string; kind: string }) => s.get("episodes", { project: "fx", subject: a.subject, kind: `action:${a.kind}` });
const member = (s: Store, id: number) => s.db.query("SELECT * FROM members WHERE id = ?").get(id) as Row & { wt: string };
const req = (s: Store, id: number) => s.db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row;
const working = (s: Store, wt: string, at: number) => s.upsert("observed_workers", { project: "fx", wt }, { state: "working", observed_at: at });
const builder = (s: Store, suffix: string, wt: string | null = `${WS}/ds-dev-studio-builder-${suffix}-demo`) => {
  s.db.run("INSERT INTO members (project, squad, role, suffix, wt, agent, model, account, observed_at, updated_at) VALUES ('fx', 'demo', 'builder', ?, ?, 'claude', 'opus', ?, ?, ?)", [suffix, wt, ACCT, T, T]);
  return Number((s.db.query("SELECT id FROM members WHERE suffix = ?").get(suffix) as Row).id);
};
const pokeReq = (s: Store, text: string, key: string | null = null) =>
  Number(s.request("poke", { text }, { project: "fx", squad: "demo", member: LEAD, key }).row.id);

describe("Orca calls", () => {
  test("the retry id is stored before the call; a crash mid-call is settled with request-show and not started twice", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u9");
    s.want("member", String(id), "running", { payload: { prompt: "build u9" } });
    let before: Row | null = null;
    orca.onCall = (c) => { if (c.op === "worker-start") before = s.db.query("SELECT * FROM orca_calls WHERE retry_id = ?").get(c.via.retry ?? "") as Row | null; };
    orca.hang = true;
    const a = rig(s, { orca });
    await a.loop.tick(T);                      // the start lands in Orca, the loop "dies" before the answer
    while (!orca.started.length) await Bun.sleep(1);
    expect(before).not.toBeNull();
    expect(before!.state).toBe("sent");
    expect(before!.sender).toBe("term_1");
    const sent = s.db.query("SELECT * FROM orca_calls WHERE op = 'worker-start'").get() as Row;
    expect(sent.settled_at).toBeNull();
    expect(orca.started.length).toBe(1);

    orca.hang = false;                         // a new loop process, the same Orca
    const b = rig(s, { orca });
    await b.act.boot(s, T + 10);
    const settled = s.db.query("SELECT * FROM orca_calls WHERE id = ?").get(sent.id as number) as Row;
    expect(settled.state).toBe("completed");
    expect(String(settled.dispatch)).toMatch(/^ctx_/);
    expect(settled.result).toBeNull();          // request-show gives no output: the replay gets it
    expect(claim(s, { subject: `member:${id}`, kind: "member" })!.state).toBe("pending");
    await b.tick(T + 10);
    expect(orca.started.length).toBe(1);       // no second worker
    const ws = orca.of("worker-start");
    expect(ws.length).toBe(2);                 // the replay, answered from Orca's receipt
    expect(ws[1].via.retry).toBe(ws[0].via.retry ?? "");
    expect(member(s, id).status).toBe("running");
  });

  test("a role-start a crash cut short gets its worktree from the replay, not the dispatch id", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u8", null);
    s.want("member", String(id), "running");
    orca.hang = true;
    const a = rig(s, { orca });
    await a.loop.tick(T);
    while (!orca.started.length) await Bun.sleep(1);
    orca.hang = false;
    const b = rig(s, { orca });
    await b.act.boot(s, T + 10);
    await b.tick(T + 10);
    expect(orca.started.length).toBe(1);
    expect(member(s, id)).toMatchObject({ status: "running", wt: "fakerepo::/wt/ds-fx-builder-u8-demo" });
  });

  test("a start that landed but answered an error is replayed under its retry id, never started twice", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u4");
    s.want("member", String(id), "running");
    orca.lose = true;                          // Orca started it; the backend timed out on the answer
    const { tick } = rig(s, { orca });
    await tick(T);
    expect(member(s, id).status).not.toBe("running");
    orca.lose = false;
    await tick(T + 5);
    const ws = orca.of("worker-start");
    expect(ws.length).toBe(2);
    expect(ws[1].via.retry).toBe(ws[0].via.retry ?? "");
    expect(orca.started.length).toBe(1);
    expect(member(s, id).status).toBe("running");
  });

  test("a call request-show calls pending waits, and is asked again on the next call", async () => {
    const s = imported(), orca = new FakeOrca();
    const act = new LoopActuator({ orca, fulfillers: [] });
    s.db.run("INSERT INTO orca_calls (retry_id, key, op, sender, at, state) VALUES ('rid-2', 'k', 'keys', 'term_9', ?, 'sent')", [T]);
    orca.pending.add("rid-2");
    await act.boot(s, T);
    const k = { key: "k", project: "fx", squad: "demo", member: null, sender: "term_9", at: T + 5 };
    expect((await act.call(s, "keys", ["x", "y"], k)).code).toBe(75);
    expect(orca.of("keys").length).toBe(0);
    orca.pending.delete("rid-2");              // Orca never got to it after all
    expect((await act.call(s, "keys", ["x", "y"], k)).code).toBe(0);
    expect(orca.of("keys")[0].via.retry).toBe("rid-2");
    expect(orca.of("request-show").length).toBe(3);   // at boot, then once per call
  });

  test("a claim a crash left 'acted' is put back to pending on boot and acted again", async () => {
    const s = imported();
    const id = pokeReq(s, "ping");
    const hung: Fulfiller = { name: "hung", kinds: ["poke"], run: () => [], exec: () => new Promise(() => {}) };
    const dead = new Loop(s, { observers: [], reconcilers: fulfillers }, new LoopActuator({ orca: new FakeOrca(), fulfillers: [hung] }), { projects: () => ["fx"] });
    void dead.tick(T);                         // the loop dies inside exec
    await Bun.sleep(5);
    expect(claim(s, { subject: `req:${id}`, kind: "poke" })!.state).toBe("running");
    const { orca, act, tick } = rig(s);
    await act.boot(s, T + 10);
    expect(claim(s, { subject: `req:${id}`, kind: "poke" })!.state).toBe("pending");
    await tick(T + 10);
    expect(orca.of("poke").length).toBe(1);
    expect(req(s, id).done_at).toBe(T + 10);
  });

  test("an adapter that says the start is still pending keeps its retry id, waits, and uses no try", async () => {
    process.env.DS_LOOP_SEND_TRIES = "2";
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u5");
    s.want("member", String(id), "running");
    for (let i = 0; i < 3; i++) orca.fail("worker-start", { code: 1, out: "", err: "orca adapter: cannot list worktrees to look for nm: the create is still pending" });
    const { tick } = rig(s, { orca });
    for (let t = T; t <= T + 15; t += 5) await tick(t);
    const ws = orca.of("worker-start");
    expect(ws.length).toBe(4);
    expect(new Set(ws.map((w) => w.via.retry)).size).toBe(1);
    expect(orca.of("request-show").length).toBe(0);
    expect(member(s, id).status).toBe("running");
    expect(orca.started.length).toBe(1);
  });

  test("a replay asks what the first try asked, and the member records that, whatever a new pick says", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u6");
    s.want("member", String(id), "running");
    orca.lose = true;
    let n = 0;
    const { tick } = rig(s, { orca, pick: async () => ({ agent: "claude", model: n++ ? "sonnet" : "opus", effort: null, account: n > 1 ? "acct-c" : "acct-b" }) });
    await tick(T);
    orca.lose = false;
    await tick(T + 5);
    const ws = orca.of("worker-start");
    expect(ws.length).toBe(2);
    expect(ws[1].via.retry).toBe(ws[0].via.retry ?? "");
    expect(ws[1].args).toEqual(ws[0].args);
    expect(member(s, id).account).toBe("acct-b");
    expect(member(s, id).model).toBe("opus");
  });

  test("a limit replay stays a fresh start on its first account, though the context crossed the line and the pick moved (U95)", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u8");
    const wt = member(s, id).wt;
    s.upsert("observed_tokens", { worker: wt, model: "opus" }, { ctx: 40_000, observed_at: T });
    s.want("member", String(id), "running", { payload: { why: "limit" } });
    orca.lose = true;
    let n = 0;
    const { tick } = rig(s, { orca, pick: async () => ({ agent: "claude", model: "opus", effort: null, account: n++ ? "acct-c" : "acct-b" }) });
    await tick(T);
    orca.lose = false;
    s.upsert("observed_tokens", { worker: wt, model: "opus" }, { ctx: 150_000, observed_at: T + 1 });
    await tick(T + 5);
    expect(orca.of("worker-resume").length).toBe(0);
    const ws = orca.of("worker-start");
    expect(ws.length).toBe(2);
    expect(ws[1].via.retry).toBe(ws[0].via.retry ?? "");
    expect(ws[1].args).toEqual(ws[0].args);
    expect(member(s, id)).toMatchObject({ status: "running", want_result: "fresh", account: "acct-b" });
    expect(n).toBe(1);
  });

  test("a fresh replay stays fresh and keeps its brief, though the context fell under the line", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u9");
    const wt = member(s, id).wt;
    s.upsert("observed_tokens", { worker: wt, model: "opus" }, { ctx: 150_000, observed_at: T });
    s.want("member", String(id), "running", { payload: { why: "limit" } });
    orca.lose = true;
    const { tick } = rig(s, { orca, pick: picked("acct-b") });
    await tick(T);
    orca.lose = false;
    s.upsert("observed_tokens", { worker: wt, model: "opus" }, { ctx: 40_000, observed_at: T + 1 });
    await tick(T + 5);
    expect(orca.of("worker-resume").length).toBe(0);
    const ws = orca.of("worker-start");
    expect(ws.length).toBe(2);
    expect(ws[1].args).toEqual(ws[0].args);
    expect(member(s, id)).toMatchObject({ want_result: "fresh", account: "acct-b" });
    const brief = s.db.query("SELECT text FROM deliveries WHERE member = ? AND kind = 'brief'").get(wt) as Row | null;
    expect(String(brief?.text)).toBe(ws[0].args[2]);
  });

  test("a fresh start Orca still works on waits past the tries, on one retry id, and is not given up (U95)", async () => {
    process.env.DS_LOOP_SEND_TRIES = "2";
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u10");
    s.upsert("observed_tokens", { worker: member(s, id).wt, model: "opus" }, { ctx: 40_000, observed_at: T });
    s.want("member", String(id), "running", { payload: { why: "limit" } });
    for (let i = 0; i < 4; i++) orca.fail("worker-start", { code: 1, out: "", err: "orca adapter: cannot list worktrees to look for nm: the create is still pending" });
    const { tick } = rig(s, { orca });
    for (let t = T; t <= T + 25; t += 5) await tick(t);
    const ws = orca.of("worker-start");
    expect(ws.length).toBe(5);
    expect(new Set(ws.map((c) => c.via.retry)).size).toBe(1);
    expect(member(s, id)).toMatchObject({ status: "running", want_result: "fresh" });
  });

  test("after a refused start a new try picks again", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u7");
    s.want("member", String(id), "running");
    orca.fail("worker-start", { code: 1, out: "", err: "boom" });
    let n = 0;
    const { tick } = rig(s, { orca, pick: async () => ({ agent: "claude", model: "opus", effort: null, account: n++ ? "acct-c" : "acct-b" }) });
    await tick(T);
    await tick(T + 5);
    expect(member(s, id).account).toBe("acct-c");
  });

  test("an unsettled call Orca never saw is replayed under the same retry id from the same sender", async () => {
    const s = imported(), orca = new FakeOrca();
    const act = new LoopActuator({ orca, fulfillers: [] });
    s.db.run("INSERT INTO orca_calls (retry_id, key, op, sender, at, state) VALUES ('rid-1', 'k', 'worker-start', 'term_9', ?, 'sent')", [T]);
    await act.boot(s, T);
    expect((s.db.query("SELECT state FROM orca_calls").get() as Row).state).toBe("absent");
    await act.call(s, "keys", ["x", "y"], { key: "k", project: "fx", squad: "demo", member: null, sender: "term_9", at: T });
    expect(orca.of("keys")[0].via).toMatchObject({ from: "term_9", retry: "rid-1" });
    expect((s.db.query("SELECT COUNT(*) AS n FROM orca_calls").get() as Row).n).toBe(1);
  });

  test("a spawned child sees DS_LOOP_CHILD=1, the sender and the retry id, and no ORCA_* of the loop", async () => {
    const d = tmp(), stub = join(d, "backend.sh");
    writeFileSync(stub, '#!/bin/sh\necho "op=$1 child=$DS_LOOP_CHILD from=$DS_ORCA_FROM retry=$DS_ORCA_RETRY_REQUEST orca=${ORCA_TERMINAL_HANDLE:-none}"\n');
    chmodSync(stub, 0o755);
    process.env.ORCA_TERMINAL_HANDLE = "term_agent";
    try {
      const o = await shell(stub).run("poke", ["wt"], { from: "term_loop", retry: "r1" });
      expect(o.out.trim()).toBe("op=poke child=1 from=term_loop retry=r1 orca=none");
    } finally { delete process.env.ORCA_TERMINAL_HANDLE; }
  });
});

describe("a start stuck behind a live lock holder", () => {
  const alerts = (s: Store) => { const f = join(s.root, "fx", "alerts.json"); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((x) => x.title === "Start stuck") : []; };
  const stuckRow = (s: Store, id: number) => s.get("episodes", { project: "fx", subject: `member:${id}`, kind: "start-stuck" });
  const heldFor = (wts: Set<string>) => (c: { op: string; args: string[] }) => (c.op === "worker-start" && wts.has(c.args[1]) ? { code: 1, out: "", err: "orca adapter: nm is still pending: pid 4242 holds its lock after 120s" } : undefined);

  test("one alert after 10 minutes, a try every 5 minutes on one retry id, and the start finishes when the holder ends", async () => {
    const s = imported(), orca = new FakeOrca(), id = builder(s, "u42"), wt = member(s, id).wt;
    s.want("member", String(id), "running");
    orca.answer = heldFor(new Set([wt]));
    const { tick } = rig(s, { orca });
    await tick(T);
    expect(claim(s, { subject: `member:${id}`, kind: "member" })).toMatchObject({ state: "pending", next_at: T + 300 });
    for (let t = T + 60; t < T + 300; t += 60) await tick(t);
    expect(orca.of("worker-start").length).toBe(1);
    for (let t = T + 300; t < T + 600; t += 60) await tick(t);
    expect(orca.of("worker-start").length).toBe(2);
    expect(alerts(s).length).toBe(0);
    await tick(T + 600);
    expect(orca.of("worker-start").length).toBe(3);
    expect(alerts(s).length).toBe(1);
    expect(String(alerts(s)[0].question)).toContain("builder u42 of demo");
    expect(String(alerts(s)[0].question)).toContain("pid 4242");
    expect(stuckRow(s, id)).toMatchObject({ started_at: T, state: "alerted", ended_at: null });
    for (let t = T + 660; t <= T + 3600; t += 60) await tick(t);
    expect(alerts(s).length).toBe(1);
    const held = orca.of("worker-start");
    expect(held.length).toBe(13);
    expect(new Set(held.map((c) => c.via.retry)).size).toBe(1);
    expect(orca.of("request-show").length).toBe(0);
    expect(orca.started.length).toBe(0);
    expect(member(s, id).want_result).toBeNull();

    orca.answer = undefined;
    await tick(T + 3900);
    expect(new Set(orca.of("worker-start").map((c) => c.via.retry)).size).toBe(1);
    expect(orca.started.length).toBe(1);
    expect(member(s, id)).toMatchObject({ status: "running", want_result: "fresh" });
    expect(alerts(s).length).toBe(0);
    expect(stuckRow(s, id)).toMatchObject({ state: "closed", ended_at: T + 3900 });
  });

  test.each([false, true])("a free placement does not shorten a backend name-lock retry deadline (diagnostic WAIT %s)", async diagnostic => {
    const s = imported(), orca = new FakeOrca(), id = builder(s, "held");
    s.want("member", String(id), "running");
    const held = heldFor(new Set([member(s, id).wt]));
    orca.answer = c => { const out = held(c); return out && diagnostic ? { ...out, err: `${out.err}\nWAIT ${T + 7200}` } : out; };
    const r = rig(s, { orca, extra: [requestsReconciler] });
    await r.tick(T);
    s.upsert("picks", { member: id }, { project: "fx", squad: "demo", role: "builder", agent: "claude", model: "opus", account: "acct-b", slot: 1, picked_at: T });
    await r.tick(T + 1); await r.tick(T + 299);
    expect(orca.of("worker-start")).toHaveLength(1);
    expect(claim(s, { subject: `member:${id}`, kind: "member" })?.next_at).toBe(T + 300);
    orca.answer = undefined; await r.tick(T + 300);
    expect(orca.started).toHaveLength(1);
    const calls = orca.of("worker-start");
    expect(calls[1].via.retry).toBe(calls[0].via.retry);
    expect(calls[1].args).toEqual(calls[0].args);
  });

  test("stuck members leave the start slots to the others", async () => {
    const s = imported(), orca = new FakeOrca(), stuck = ["a", "b", "c", "d"].map((x) => builder(s, `u42${x}`));
    const other = builder(s, "u42z");
    for (const id of [...stuck, other]) s.want("member", String(id), "running");
    // Each wait answers late, as the adapter does after its 120 s, so it holds its slot meanwhile.
    const held = heldFor(new Set(stuck.map((id) => member(s, id).wt)));
    orca.answer = async (c) => { const a = held(c); if (a) await Bun.sleep(5); return a; };
    const { tick } = rig(s, { orca });
    await tick(T);
    expect(orca.of("worker-start").length).toBe(4);
    expect(member(s, other).status).not.toBe("running");
    await tick(T + 1);
    expect(orca.of("worker-start").length).toBe(5);
    expect(member(s, other).status).toBe("running");
    for (const id of stuck) expect(member(s, id).status).not.toBe("running");
  });

  test("the first wait survives a loop restart, so the alert still comes once and on time", async () => {
    const s = imported(), orca = new FakeOrca(), id = builder(s, "u42r");
    s.want("member", String(id), "running");
    orca.answer = heldFor(new Set([member(s, id).wt]));
    await rig(s, { orca }).tick(T);
    const { tick } = rig(s, { orca });
    for (let t = T + 300; t <= T + 900; t += 300) await tick(t);
    expect(stuckRow(s, id)!.started_at).toBe(T);
    expect(alerts(s).length).toBe(1);
    expect(new Set(orca.of("worker-start").map((c) => c.via.retry)).size).toBe(1);
  });

  test("a holder gone within 10 minutes raises nothing, and a later wait counts from its own start", async () => {
    const s = imported(), orca = new FakeOrca(), id = builder(s, "u42q");
    s.want("member", String(id), "running");
    orca.answer = heldFor(new Set([member(s, id).wt]));
    const { tick } = rig(s, { orca });
    await tick(T);
    orca.answer = undefined;
    await tick(T + 300);
    expect(member(s, id).status).toBe("running");
    expect(alerts(s).length).toBe(0);
    expect(stuckRow(s, id)).toMatchObject({ state: "closed", ended_at: T + 300 });

    // U152: its agent gone (the walk reads it), the decider starts it again.
    s.upsert("observed_workers", { project: "fx", wt: member(s, id).wt }, { presence: "none", account_at: T + 1999, observed_at: T + 1999 });
    orca.answer = heldFor(new Set([member(s, id).wt]));
    await tick(T + 2000);
    expect(stuckRow(s, id)).toMatchObject({ state: "waiting", started_at: T + 2000, ended_at: null });
    await tick(T + 2300);
    expect(alerts(s).length).toBe(0);
  });

  test("a wish withdrawn while stuck closes the alert and starts nothing", async () => {
    const s = imported(), orca = new FakeOrca(), id = builder(s, "u42w");
    s.want("member", String(id), "running");
    orca.answer = heldFor(new Set([member(s, id).wt]));
    const { tick } = rig(s, { orca });
    for (let t = T; t <= T + 600; t += 300) await tick(t);
    expect(alerts(s).length).toBe(1);
    s.want("member", String(id), "gone");
    orca.answer = undefined;
    await tick(T + 900);
    expect(alerts(s).length).toBe(0);
    expect(stuckRow(s, id)!.ended_at).toBe(T + 900);
    expect(orca.started.length).toBe(0);
  });

  test("a failed try between two waits does not end the episode or raise a second alert", async () => {
    const s = imported(), orca = new FakeOrca(), id = builder(s, "u42b");
    s.want("member", String(id), "running");
    orca.answer = heldFor(new Set([member(s, id).wt]));
    const { tick } = rig(s, { orca });
    for (let t = T; t <= T + 600; t += 300) await tick(t);
    expect(alerts(s).length).toBe(1);
    const since = String(alerts(s)[0].since);
    const held = orca.answer;
    orca.answer = (c) => (c.op === "worker-start" ? { code: 1, out: "", err: "boom" } : undefined);
    await tick(T + 900);
    orca.answer = held;
    await tick(T + 901);
    await tick(T + 1201);
    expect(stuckRow(s, id)).toMatchObject({ started_at: T, state: "alerted", ended_at: null });
    expect(alerts(s).length).toBe(1);
    expect(String(alerts(s)[0].since)).toBe(since);
  });

  test("an alert that could not be written is tried again at the next wait", async () => {
    const s = imported(), orca = new FakeOrca(), id = builder(s, "u42e");
    s.want("member", String(id), "running");
    orca.answer = heldFor(new Set([member(s, id).wt]));
    const { tick } = rig(s, { orca });
    const f = join(s.root, "fx", "alerts.json"), good = existsSync(f) ? readFileSync(f, "utf8") : "";
    writeFileSync(f, "not json");
    for (let t = T; t <= T + 600; t += 300) await tick(t);
    expect(stuckRow(s, id)!.state).toBe("waiting");
    expect(s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'plugin_error'").get()).toMatchObject({ n: 1 });
    writeFileSync(f, good);
    await tick(T + 900);
    expect(alerts(s).length).toBe(1);
    expect(stuckRow(s, id)!.state).toBe("alerted");
  });
});

describe("member wishes", () => {
  test("end to end: want=running -> pick -> worker-start from the sender -> running -> brief verified next tick", async () => {
    const s = imported();
    const id = builder(s, "u5");
    const wt = member(s, id).wt as string;
    s.want("member", String(id), "running", { payload: { prompt: "build u5" } });
    const { orca, tick } = rig(s, { pick: picked("acct-b") });
    await tick(T);
    expect(orca.calls.map((c) => c.op)).toEqual(["terminal-create", "adopt", "worker-start"]);
    const ws = orca.of("worker-start")[0];
    expect(ws.args).toEqual(["run_fixture01", wt, withRoleNotes("builder", "build u5"), "claude", "opus", "-", "-", "acct-b", "-", "builder"]);
    expect(ws.via.from).toBe("term_1");
    expect(s.get("coordinators", { project: "fx", squad: "demo" })).toMatchObject({ handle: "term_1", run_id: "run_fixture01", wt: LEAD });
    expect(member(s, id)).toMatchObject({ status: "running", account: "acct-b", model: "opus", want_result: "fresh" });
    const d = s.db.query("SELECT * FROM deliveries").get() as Row;
    expect(d).toMatchObject({ kind: "brief", state: "accepted", member: wt, text: withRoleNotes("builder", "build u5") });
    working(s, wt, T + 5);
    await tick(T + 5);
    expect((s.db.query("SELECT state FROM deliveries").get() as Row).state).toBe("verified");
    expect(orca.of("worker-start").length).toBe(1);
  });

  test("a member with no worktree yet is started with role-start under its add-role name", async () => {
    const s = imported();
    const id = builder(s, "u7", null);
    s.want("member", String(id), "running");
    const { orca, tick } = rig(s);
    await tick(T);
    expect(orca.of("role-start")[0].args[6]).toBe("ds-fx-builder-u7-demo");
    expect(member(s, id)).toMatchObject({ status: "running", wt: "fakerepo::/wt/ds-fx-builder-u7-demo" });
  });

  test("four start slots: ten queued starts never run more than four at once, and all start", async () => {
    const s = imported(), orca = new FakeOrca();
    const ids = Array.from({ length: 10 }, (_, i) => builder(s, `q${i}`));
    for (const id of ids) s.want("member", String(id), "running");
    const { loop, act, tick } = rig(s, { orca });
    const release = orca.hold();
    await loop.tick(T);
    await Bun.sleep(5);
    expect(orca.inflight).toBe(4);
    expect(ids.filter((id) => claim(s, { subject: `member:${id}`, kind: "member" })!.state === "pending").length).toBe(6);
    release();
    await act.drain();
    for (let t = T + 5; t < T + 30; t += 5) await tick(t);
    expect(orca.most).toBe(4);
    expect(orca.started.length).toBe(10);
    expect(ids.every((id) => member(s, id).status === "running")).toBe(true);
    expect(orca.of("terminal-create").length).toBe(1);   // one sender for the squad
  });

  test("an unfinished member stays idle and starts on the next tick with room before reset", async () => {
    const s = imported(), id = builder(s, "u6", null);
    s.want("member", String(id), "running");
    let free = false, checked = 0;
    const r = rig(s, { pick: async () => { checked++; return free
      ? { agent: "claude", model: "opus", effort: null, account: "acct-c" } : { wait: T + 7200 }; } });
    for (let i = 0; i < 100; i++) await r.tick(T + i);
    expect(checked).toBe(100);
    expect(member(s, id).status).not.toBe("waiting");
    expect(member(s, id).want_result).toBeNull();
    expect(claim(s, { subject: `member:${id}`, kind: "member" })).toBeNull();
    expect(r.orca.of("worker-start")).toHaveLength(0);
    free = true;
    await r.tick(T + 100); await r.tick(T + 101);
    expect(r.orca.started).toHaveLength(1);
    expect(member(s, id)).toMatchObject({ status: "running", account: "acct-c" });
  });

  test("a restarted loop retires an old member capacity deadline without creating two starts", async () => {
    const s = imported(), id = builder(s, "legacy");
    s.want("member", String(id), "running");
    const before = rig(s, { pick: async () => ({ wait: T + 7200 }) });
    const a = (await before.tick(T)).actions.find(a => a.kind === "member")!;
    s.upsert("episodes", { project: "fx", subject: a.subject, kind: "action:member" }, { state: "pending", next_at: T + 7200,
      episode_key: a.episode, action: JSON.stringify({ action: a, tries: 0 }), started_at: T, source: "loop", observed_at: T });
    s.event("action_pending", { project: "fx", payload: { subject: a.subject, kind: a.kind, episode: a.episode, wait: "no account free", at: T + 7200 } });
    s.upsert("members", { id }, { status: "waiting" });
    const after = rig(s); await after.act.boot(s, T + 1);
    await after.tick(T + 1); await after.tick(T + 2);
    expect(after.orca.started).toHaveLength(1);
    expect(member(s, id)).toMatchObject({ status: "running", account: "acct-b" });
    expect(claim(s, a)).toMatchObject({ state: "done", next_at: null });
  });

  test.each(["cx", null])("an unfinished limit wish walks the allowed pipeline from the top (account %s)", async (account) => {
    const s = imported(), id = builder(s, "pipeline");
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value: "claude opus ondemand - codex:gpt-6.1-sol:low", observed_at: T });
    s.db.run("UPDATE observed_accounts SET limited_until = ? WHERE agent = 'claude'", [String(T + 7200)]);
    if (account) {
      s.upsert("accounts", { agent: "codex", account }, { observed_at: T });
      s.upsert("observed_accounts", { agent: "codex", account }, { session_pct: "10", session_reset: String(T + 7200), weekly_pct: "10", updated: String(T), observed_at: T });
    }
    s.want("member", String(id), "running", { payload: { why: "limit" } });
    const r = rig(s, { pick: ladderPick });
    await r.tick(T); await r.tick(T + 1);
    expect(r.orca.started).toHaveLength(1);
    expect(member(s, id)).toMatchObject({ status: "running", agent: "codex", model: "gpt-6.1-sol", account });
  });

  test("limited Builders under and over the ctx line both start fresh on the new account (U95)", async () => {
    const s = imported();
    const small = builder(s, "c1"), big = builder(s, "c2");
    s.upsert("observed_tokens", { worker: member(s, small).wt, model: "opus" }, { ctx: 40_000, observed_at: T });
    s.upsert("observed_tokens", { worker: member(s, big).wt, model: "opus" }, { ctx: 150_000, observed_at: T });
    for (const id of [small, big]) s.want("member", String(id), "running", { payload: { why: "limit" } });
    // U154: the start's pick excludes the account of the member's open `limited` episode.
    for (const id of [small, big]) s.upsert("episodes", { project: "fx", subject: member(s, id).wt, kind: "limited" },
      { episode_key: `claude/${ACCT}|test limit`, state: "usage", started_at: T - 60, ended_at: T + 3600, source: "loop", observed_at: T });
    const seen: string[] = [];
    const { orca, tick } = rig(s, { pick: async (_s, m, o) => { seen.push(`${m.suffix}:${o.limited}`); return { agent: "claude", model: "opus", effort: null, account: "acct-b" }; } });
    await tick(T);
    expect(seen).toEqual([`c1:claude:${ACCT}=${T + 3600}`, `c2:claude:${ACCT}=${T + 3600}`]);
    expect(orca.of("worker-resume").length).toBe(0);
    expect(orca.of("worker-start").map((c) => c.args[1])).toEqual([member(s, small).wt, member(s, big).wt]);
    expect(orca.of("worker-start")[0].args[7]).toBe("acct-b");
    expect(member(s, small)).toMatchObject({ want_result: "fresh", account: "acct-b" });
    expect(member(s, big)).toMatchObject({ want_result: "fresh", account: "acct-b" });
  });

  test("U3: a Muse Builder out of credits starts on the next rung, briefed from its journal", async () => {
    const s = imported(), id = builder(s, "cr1");
    s.upsert("config", { project: "fx", file: "roles.conf", key: "builder" }, { value: "muse muse-spark-1.3 ondemand max claude:opus:high", observed_at: T });
    s.db.run("UPDATE members SET agent = 'muse', model = 'muse-spark-1.3', account = 'default' WHERE id = ?", [id]);
    s.upsert("observed_accounts", { agent: "muse", account: "default" }, { session_pct: "-", weekly_pct: "-", note: "out of credits", observed_at: T });
    s.upsert("episodes", { project: "fx", subject: member(s, id).wt, kind: "limited" },
      { episode_key: "muse/default|◆ model failed: API error 402", state: "credits", started_at: T - 60, ended_at: T + 86400, source: "loop", observed_at: T });
    holdCredits(s, { agent: "muse", account: "default", until: T + 86400, from: "screen" }, T - 60);
    s.want("member", String(id), "running", { payload: { why: "limit" } });
    const { orca, tick } = rig(s, { pick: ladderPick });
    await tick(T); await tick(T + 1);
    const ws = orca.of("worker-start");
    expect(ws).toHaveLength(1);
    expect(member(s, id)).toMatchObject({ want_result: "fresh", agent: "claude", model: "opus" });
    expect(ws[0].args[2]).toContain("You were restarted on opus");   // a new model: the restart handoff
    expect(ws[0].args[2]).toContain("journal.sh fx demo builder-cr1 briefing");
  });

  test("a limited member with nowhere to move stays idle with its wish unfinished", async () => {
    const s = imported();
    const id = builder(s, "t1");
    s.want("member", String(id), "running", { payload: { why: "limit" } });
    const { orca, tick } = rig(s, { pick: async () => ({ wait: T + 600 }) });
    await tick(T);
    expect(orca.of("poke")).toEqual([]);
    expect(orca.of("worker-start").length + orca.of("worker-resume").length).toBe(0);
    expect(member(s, id).want_result).toBeNull();
  });

  test("the sender terminal is found again by pane after an Orca restart, and re-created when it is gone", async () => {
    const s = imported(), orca = new FakeOrca();
    const { tick } = rig(s, { orca });
    const start = async (suffix: string, at: number) => { const id = builder(s, suffix); s.want("member", String(id), "running"); await tick(at); return member(s, id); };
    await start("s1", T);
    const seen = (handles: string[], at: number) => { for (const h of handles) s.upsert("observed_terminals", { project: "fx", handle: h }, { observed_at: at }); };
    seen(["term_1"], T);

    orca.restart();                                       // same pane, new handle term_2
    seen(["term_2"], T + 5);
    expect((await start("s2", T + 5)).status).toBe("running");
    expect(orca.of("terminal-find").length).toBe(1);
    expect(s.get("coordinators", { project: "fx", squad: "demo" })!.handle).toBe("term_2");

    orca.gone("term_2");                                  // the tab is closed; the observer marks it gone
    seen(["term_x"], T + 10);
    s.db.run("UPDATE observed_terminals SET gone_at = ? WHERE project = 'fx' AND handle = 'term_2'", [T + 10]);
    expect((await start("s3", T + 10)).status).toBe("running");
    expect(orca.of("terminal-create").length).toBe(2);
    const c = s.get("coordinators", { project: "fx", squad: "demo" })!;
    expect(c.handle).toBe("term_3");
    expect(orca.of("adopt").map((a) => a.via.from)).toEqual(["term_1", "term_2", "term_3"]);
  });

  test("a failed adopt keeps its terminal unbound; the next try binds that one, so one terminal in all (U54)", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "a1");
    s.want("member", String(id), "running");
    orca.fail("adopt", { code: 1, out: "", err: "orca adapter: adopt (run-use) failed for run run_fixture01: invalid_argument: Unknown flag --full" });
    const { tick } = rig(s, { orca });
    await tick(T);
    expect(s.get("coordinators", { project: "fx", squad: "demo" })).toMatchObject({ handle: "term_1", run_id: "", bound_at: null });
    expect(member(s, id).status).not.toBe("running");
    await tick(T + 1);
    expect(member(s, id).status).toBe("running");
    expect(orca.of("terminal-create").length).toBe(1);
    expect(orca.of("adopt").map((a) => a.via.from)).toEqual(["term_1", "term_1"]);
    expect(s.get("coordinators", { project: "fx", squad: "demo" })).toMatchObject({ handle: "term_1", run_id: "run_fixture01" });
  });

  test("a sender Orca fenced (restarted, nothing observed) is found again by its pane and the start goes through", async () => {
    const s = imported(), orca = new FakeOrca();
    const a = builder(s, "f1"), b = builder(s, "f2");
    s.want("member", String(a), "running");
    const { tick } = rig(s, { orca });
    await tick(T);
    orca.restart();                            // new handles, nothing bound; no observer saw it
    s.want("member", String(b), "running");
    await tick(T + 5);
    expect(member(s, b).status).toBe("running");
    expect(orca.of("terminal-find").length).toBe(1);
    expect(s.get("coordinators", { project: "fx", squad: "demo" })!.handle).toBe("term_2");
  });
});

describe("lifecycle capacity and recovery", () => {
  // U159: the wish replay is gone — no script runs a wish as a child anymore, so the role-wish
  // restart path, the start preflight (roleHasRoom), the placed-after-ask drop and the add-role
  // fold are gone with it. What remains is the member wish against capacity; the decider's
  // start, crash and stuck settlement is pinned in decide.test.ts and the lock-holder describe.

  // U159: the wish replay (and its role-wish restart path) is gone; only the member wish remains.
  test("a held member placement is quiet and starts once when room returns", async () => {
    const s = imported(), id = builder(s, "held"), wt = member(s, id).wt;
    let free = false, checks = 0;
    s.want("member", String(id), "running", { payload: { prompt: "build held" } });
    const r = rig(s, { pick: async () => { checks++; return free ? { agent: "claude", model: "opus", effort: null, account: "acct-b" } : { wait: T + 7200 }; } });
    const episodes = s.db.query("SELECT * FROM episodes ORDER BY id").all();
    const events = s.db.query("SELECT * FROM events WHERE kind = 'action'").all();
    for (let i = 0; i < 100; i++) expect((await r.tick(T + i)).acted).toEqual([]);
    expect(checks).toBe(100);
    expect(s.db.query("SELECT * FROM episodes ORDER BY id").all()).toEqual(episodes);
    expect(s.db.query("SELECT * FROM events WHERE kind = 'action'").all()).toEqual(events);
    free = true; await r.tick(T + 100); await r.tick(T + 101);
    expect(r.orca.started).toHaveLength(1);
  });


  test("a dead Builder waiting on capacity makes no claim, call or event, then starts once; gone again soon after gets one card (U152)", async () => {
    const s = imported(), id = builder(s, "auto-capacity"), wt = member(s, id).wt;
    s.db.run("UPDATE units SET status = 'planned', builder_wt = NULL");
    s.upsert("units", { project: "fx", squad: "demo", slug: "auto-capacity" }, { status: "dispatched", builder_wt: wt, observed_at: T, updated_at: T });
    s.upsert("members", { id }, { want: "running", want_at: T - 7200, want_result: "fresh", placed_at: T - 3600, status: "running" });
    let free = false, checked = 0, alive = false;
    const r = rig(s, { extra: [liveness], pick: async () => { checked++; return free ? { agent: "claude", model: "opus", effort: null, account: "acct-b" } : { wait: T + 7200 }; } });
    // The walk: every other member's agent is there; the Builder's only once `alive`.
    r.loop.plugins.observers.push({ name: "world", run(c) {
      for (const m of s.db.query("SELECT wt FROM members WHERE wt IS NOT NULL").all() as Row[]) {
        const up = m.wt !== wt || alive;
        s.upsert("observed_workers", { project: "fx", wt: m.wt }, { state: up ? "idle" : null, presence: up ? "running" : "none", walk: up ? "running" : "none", account_at: c.now, observed_at: c.now, gone_at: null });
      }
    } });
    await r.tick(T);
    const events = s.db.query("SELECT * FROM events WHERE kind = 'action'").all();
    for (let i = 1; i <= 100; i++) expect((await r.tick(T + i * 60)).acted).toEqual([]);
    expect(checked).toBe(101);
    expect(claim(s, { subject: `member:${id}`, kind: "member" })).toBeNull();
    expect(s.db.query("SELECT * FROM episodes WHERE kind IN ('req', 'action:run-switch', 'action:request.file')").all()).toEqual([]);
    expect(s.db.query("SELECT * FROM events WHERE kind = 'action'").all()).toEqual(events);
    expect(r.orca.of("worker-start")).toHaveLength(0);

    const start = T + 7200;
    free = true; await r.tick(start);
    expect(r.orca.started).toHaveLength(1);
    expect(r.orca.started[0].args).toContain(wt);
    expect(s.db.query("SELECT * FROM episodes WHERE kind = 'action:run-switch'").all()).toEqual([]);
    alive = true; await r.tick(start + 60);
    alive = false;
    const later = [];
    for (let t = start + 120; t <= start + 600; t += 60) later.push(...(await r.tick(t)).acted);
    expect(r.orca.started).toHaveLength(1);
    expect(later.filter((a) => a.kind === "alert").map((a) => (a.payload as Row).title)).toEqual(["Agent broke again"]);
  });
});

describe("pokes", () => {
  test("a request inserted mid-tick is fulfilled on the next tick and its row marked done with a result", async () => {
    const s = imported();
    let id = 0;
    const inserter: Reconciler = { name: "zz-insert", run: () => { if (!id) id = pokeReq(s, "ping"); } };
    const { orca, tick } = rig(s, { extra: [inserter] });
    await tick(T);
    expect(orca.of("poke").length).toBe(0);
    expect(req(s, id).done_at).toBeNull();
    await tick(T + 5);
    expect(orca.of("poke").map((c) => c.args)).toEqual([[LEAD, "ping"]]);
    expect(req(s, id).done_at).toBe(T + 5);
    expect(JSON.parse(String(req(s, id).result))).toEqual({ ok: true, delivered: "started", delivery: null });
  });

  test("a second request with the same key is a no-op", async () => {
    const s = imported();
    const a = pokeReq(s, "once", "k1"), b = pokeReq(s, "once", "k1");
    expect(b).toBe(a);
    const { orca, tick } = rig(s);
    await tick(T);
    await tick(T + 5);
    expect(orca.of("poke").length).toBe(1);
  });

  test("a failed send leaves the episode pending, and the next tick sends it", async () => {
    const s = imported(), orca = new FakeOrca();
    orca.pokes.set(LEAD, [1, 0]);
    const id = pokeReq(s, "ping");
    const { tick } = rig(s, { orca });
    await tick(T);
    const c = claim(s, { subject: `req:${id}`, kind: "poke" })!;
    expect(c.state).toBe("pending");
    expect(JSON.parse(String(c.action)).tries).toBe(1);
    expect(req(s, id).done_at).toBeNull();
    await tick(T + 5);
    expect(orca.of("poke").length).toBe(2);
    expect(claim(s, { subject: `req:${id}`, kind: "poke" })!.state).toBe("done");
    expect(req(s, id).done_at).toBe(T + 5);
  });

  test("--wait-submit: accepted, verified on the next tick once the member is working", async () => {
    const s = imported(), orca = new FakeOrca();
    orca.pokes.set(LEAD, [3]);
    pokeReq(s, "ping");
    const { tick } = rig(s, { orca });
    await tick(T);
    expect(s.db.query("SELECT state, tries FROM deliveries").get()).toEqual({ state: "accepted", tries: 1 });
    working(s, LEAD, T + 5);
    await tick(T + 5);
    expect((s.db.query("SELECT state FROM deliveries").get() as Row).state).toBe("verified");
    expect(orca.of("poke").length).toBe(1);
  });

  test("--wait-submit: not taken, sent again, then one Studio alert", async () => {
    const s = imported(), orca = new FakeOrca();
    orca.pokes.set(LEAD, [3, 3, 3]);
    pokeReq(s, "ping");
    const { tick } = rig(s, { orca });
    for (let t = T; t <= T + 20; t += 5) await tick(t);
    expect(orca.of("poke").length).toBe(2);
    expect(s.db.query("SELECT state, tries FROM deliveries").get()).toEqual({ state: "escalated", tries: 2 });
    const alerts = JSON.parse(readFileSync(join(s.root, "fx", "alerts.json"), "utf8")).alerts.filter((x: Row) => String(x.id).startsWith("loop-deliver"));
    expect(alerts.length).toBe(1);
    expect(alerts[0].title).toBe("demo · lead: Poke not taken");
    expect(alerts[0].question).not.toContain("::");
  });

  test("a wake() poke whose episode ended before it was acted is dropped", async () => {
    const s = imported();
    s.upsert("observed_workers", { project: "fx", wt: THINKER }, { state: "idle", observed_at: T });
    const ctx: TickCtx = { store: s, project: "fx", tick: 1, now: T, fired: [], poked: new Set() };
    const w = wake(ctx, THINKER, "you have mail", "mail", "m1");
    expect(w.status).toBe("sent");
    s.db.run("UPDATE episodes SET ended_at = ? WHERE kind = 'wake:mail'", [T]);   // it answered meanwhile
    const { orca, tick } = rig(s, { extra: [once(w.actions)] });
    await tick(T);
    expect(orca.of("poke").length).toBe(0);
    expect(claim(s, w.actions[0])!.state).toBe("dropped");
  });

  test("keys and a picker answer by keystroke; a plain answer is the board's message", async () => {
    const s = imported();
    const k = Number(s.request("keys", { text: "2", enter: false }, { project: "fx", squad: "demo", member: LEAD }).row.id);
    // The picker is still open: its transcript has the tool_use and no tool_result.
    const t = join(s.root, "t.jsonl");
    writeFileSync(t, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "AskUserQuestion" }] } })}\n`);
    s.request("answer", { id: "q1", answer: "free text", choices: [{ label: "yes" }, { label: "no" }], transcript: t, tool_use_id: "toolu_1" }, { project: "fx", squad: "demo", member: LEAD });
    s.request("answer", { id: "q2", answer: "ship it" }, { project: "fx", squad: "demo", member: THINKER });
    process.env.DS_LOOP_PICKER_TYPE_MS = "1";
    try {
      const { orca, tick } = rig(s);
      await tick(T);
      expect(orca.of("keys").map((c) => c.args)).toEqual([[LEAD, "3"], [LEAD, "free text", "enter"], [LEAD, "2"]]);
      expect(orca.of("poke")[0].args[1]).toStartWith("dev-studio board: the operator answered question q2: ship it");
      expect(req(s, k).done_at).toBe(T);
    } finally { delete process.env.DS_LOOP_PICKER_TYPE_MS; }
  });
});

describe("giving up", () => {
  afterEach(() => { delete process.env.DS_LOOP_SEND_TRIES; });

  test("a poke that never sends is given up after DS_LOOP_SEND_TRIES, its request done with the error", async () => {
    process.env.DS_LOOP_SEND_TRIES = "2";
    const s = imported(), orca = new FakeOrca();
    orca.pokes.set(LEAD, [1, 1, 1]);
    const id = pokeReq(s, "ping");
    const { tick } = rig(s, { orca });
    for (let t = T; t <= T + 10; t += 5) await tick(t);
    expect(orca.of("poke").length).toBe(2);
    expect(claim(s, { subject: `req:${id}`, kind: "poke" })!.state).toBe("failed");
    expect(req(s, id).done_at).toBe(T + 5);
    expect(JSON.parse(String(req(s, id).result))).toMatchObject({ ok: false });
  });

  test("a start that keeps failing is given up: want_result failed and one Start failed alert", async () => {
    process.env.DS_LOOP_SEND_TRIES = "2";
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u3");
    s.want("member", String(id), "running");
    for (let i = 0; i < 3; i++) orca.fail("worker-start", { code: 1, out: "", err: "boom" });
    const { tick } = rig(s, { orca });
    for (let t = T; t <= T + 10; t += 5) await tick(t);
    expect(orca.of("worker-start").length).toBe(2);
    expect(member(s, id).want_result).toBe("failed: boom");
    const alerts = JSON.parse(readFileSync(join(s.root, "fx", "alerts.json"), "utf8")).alerts.filter((x: Row) => x.title === "Start failed");
    expect(alerts.length).toBe(1);
  });

  test("keys whose Enter failed after the text landed are not typed again", async () => {
    const s = imported(), orca = new FakeOrca();
    orca.fail("keys", { code: 1, out: "", err: `orca adapter: keys: Enter failed for ${LEAD}` });
    const k = Number(s.request("keys", { text: "hello", enter: true }, { project: "fx", squad: "demo", member: LEAD }).row.id);
    const { tick } = rig(s, { orca });
    await tick(T);
    await tick(T + 5);
    expect(orca.of("keys").length).toBe(1);
    expect(JSON.parse(String(req(s, k).result))).toMatchObject({ ok: false });
  });
});

describe("request files", () => {
  // bun test runs in UTC without exporting TZ, so jq gets the zone the loop's Date sees.
  const sweepHhmm = (since: number) => Bun.spawnSync(["jq", "-rn", "--argjson", "s", String(since), '$s|strflocaltime("%H:%M")'],
    { env: { ...process.env, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone } }).stdout.toString().trim();
  const listSweep = (s: Store) => { const d = join(s.root, "fx", "sweep"); return existsSync(d) ? readdirSync(d).sort() : []; };

  test("a dead Lead's restart request has the sweep's name and content, and no marker file is written", async () => {
    const s = imported(), before = listSweep(s), since = T - 1234;
    const a: Action = { project: "fx", squad: "demo", member: LEAD, subject: "demo.lead", kind: "request-restart", episode: "dead|1",
      payload: { target: "_studio", key: "demo.lead", who: "lead", topic: "demo", cause: "dead", since } };
    const sw: Action = { project: "fx", squad: "demo", member: THINKER, subject: "demo.thinker", kind: "request-switch", episode: "limit|1",
      payload: { target: "demo", key: "demo.thinker", what: "thinker of demo (usage limit on acct-a: weekly)", command: "bin/commands/restart-role.sh fx demo thinker" } };
    const { tick } = rig(s, { extra: [once([a, sw])] });
    await tick(T);
    expect(readFileSync(join(s.root, "fx", "requests", "_studio", `demo.lead-${T}.txt`), "utf8")).toBe(`restart lead of demo (dead since ${sweepHhmm(since)})\n`);
    expect(readFileSync(join(s.root, "fx", "requests", "demo", `demo.thinker-${T}.txt`), "utf8"))
      .toBe("switch: restart thinker of demo (usage limit on acct-a: weekly) on the next pick — run: bin/commands/restart-role.sh fx demo thinker\n");
    expect(listSweep(s)).toEqual(before);
  });

  test("nobody above (_operator): a Studio alert instead of a file", async () => {
    const s = imported();
    const a: Action = { project: "fx", subject: "studio", kind: "request-restart", episode: "dead|2",
      payload: { target: "_operator", key: "studio", who: "studio", cause: "dead", since: T } };
    const { tick } = rig(s, { extra: [once([a])] });
    await tick(T);
    expect(existsSync(join(s.root, "fx", "requests", "_operator"))).toBe(false);
    const alerts = JSON.parse(readFileSync(join(s.root, "fx", "alerts.json"), "utf8")).alerts as Row[];
    expect(alerts.some((x) => String(x.question).startsWith("studio (dead since") && String(x.question).endsWith("nobody above it can restart it"))).toBe(true);
  });

  // U154: the board no longer files run-switch requests and the U153 interim (a run-switch that
  // writes a restart wish) is gone: switches run through the decider (decide.ts, switches.ts).
});

describe("handoff (§5b)", () => {
  const m = (o: Partial<Member> = {}): Member => ({ id: 1, project: "fx", squad: "demo", wt: "wt", role: "builder", suffix: "u1", agent: "claude", model: "opus", effort: null, account: "a1", ...o });
  test.each([
    ["start", m(), { why: "start", model: "opus", account: "a2", prompt: "go" }, { launch: "fresh", model: "opus", account: "a2", context: withRoleNotes("builder", "go") }],
    ["phase change", m(), { why: "phase", model: "sonnet", account: "a2", prompt: "babysit" }, { launch: "fresh", model: "sonnet", account: "a2", context: withRoleNotes("builder", "babysit") }],
    ["wrong model", m({ model: "sonnet" }), { why: "model", model: "opus", account: "a1" }, { launch: "fresh", model: "opus", account: "a1" }],
    ["limit, Builder under the line starts fresh (U95)", m(), { why: "limit", account: "a2", ctx: 99_999 }, { launch: "fresh", model: "opus", account: "a2" }],
    ["limit, Builder over the line", m(), { why: "limit", account: "a2", ctx: 100_000 }, { launch: "fresh", model: "opus", account: "a2" }],
    ["limit, Builder ctx unknown", m(), { why: "limit", account: "a2" }, { launch: "fresh", account: "a2" }],
    ["limit, a Lead", m({ role: "lead", suffix: "" }), { why: "limit", account: "a2", ctx: 10 }, { launch: "fresh", model: "opus", account: "a2" }],
    ["limit, a muse Builder", m({ agent: "muse", model: "muse-spark" }), { why: "limit", account: "a2", ctx: 10 }, { launch: "fresh", model: "muse-spark", account: "a2" }],
    ["limit, nowhere to move", m(), { why: "limit", account: null }, { launch: "tell", model: "opus", account: "a1", context: TELL }],
    ["limit, same account", m(), { why: "limit", account: "a1", ctx: 10 }, { launch: "tell", account: "a1" }],
  ] as const)("%s", (_name, mem, reason, want) => {
    expect(handoff(mem, reason as Parameters<typeof handoff>[1])).toMatchObject(want);
  });
  // The sentences a role's start spec carries (roleSpec: add-role's prompt and the loop's role requests), pinned
  // by a literal piece each, so a brief or a spec that drifts from them fails here.
  const spec = (role: string) => roleSpec("fx", role, "demo", "run_1", "/s.json");
  const carried = (v: string, pin: string, role: string) => {
    expect(v).toContain(pin);
    expect(spec(role)).toContain(v.trim());
    return v;
  };
  const prNote = () => carried(PR_NOTE, "(set-unit-pr) per the ship mode in roles/builder.md", "builder");
  const beatNote = (role: string) => carried(NO_HEARTBEAT_NOTE, "Do not send heartbeats: the loop tracks liveness", role);
  const notesFor = (role: string) => carried(notesNote({ project: "fx", role }), `notes.sh fx ${role} print`, role);
  const briefs = (mem: Member) => [
    handoff(mem, { why: "start", run: "run_1" }).context,
    handoff(mem, { why: "phase", run: "run_1" }).context,
    handoff(mem, { why: "model", model: "opus", run: "run_1" }).context,
    handoff(mem, { why: "limit", account: "a2", ctx: 200_000, run: "run_1" }).context,
  ];
  test("a Builder's brief carries restart-role.sh's sentences in its start spec's words, the run last", () => {
    const pr = prNote(), beat = beatNote("builder"), notes = notesFor("builder");
    expect(pr).toContain("don't post to GitHub");
    for (const b of briefs(m())) {
      expect(b).toContain(pr);
      expect(b).toContain(beat);
      expect(b).toContain(notes);
      expect(b).toEndWith(" Squad run=run_1.");
    }
  });
  test("any other role's brief has the heartbeat and notes sentences for its role, and no PR note", () => {
    const beat = beatNote("thinker"), notes = notesFor("thinker");
    for (const b of briefs(m({ role: "thinker", suffix: "" }))) {
      expect(b).toContain(beat);
      expect(b).toContain(notes);
      expect(b).not.toContain(PR_NOTE);
    }
  });
  test("a Lead's and a Thinker's briefs carry standingNote in their start spec's words; a Builder's do not (U64)", () => {
    const standing = carried(standingNote("lead"), "never call worker_done", "lead");
    expect(standingNote("builder")).toBe("");
    for (const role of ["lead", "thinker"]) for (const b of briefs(m({ role, suffix: "" }))) expect(b).toContain(standing);
    for (const b of briefs(m())) expect(b).not.toContain(standing);
  });
  test("U3: the works-again tell names the account that is back", () => {
    expect(worksAgain("muse", "default")).toBe("dev-studio loop: the muse/default account works again — carry on where you left off.");
  });

  test("a fresh start after a limit points the new session at its journal", () => {
    expect(handoff(m(), { why: "limit", account: "a2", ctx: 200_000, run: "run_1" }).context).toContain("journal.sh fx demo builder-u1 briefing");
  });
});

describe("drivers", () => {
  const seat = (orca: FakeOrca): Seat => ({
    squad: { project: "fx", topic: "demo", run_id: "run_1", repo: "path:/r", lead_wt: LEAD },
    call: (op, args) => orca.run(op, args, { from: "term_1" }),
    send: (op, args) => orca.run(op, args),
  });
  const mem: Member = { id: 1, project: "fx", squad: "demo", wt: THINKER, role: "thinker", suffix: "", agent: "muse", model: "muse-spark", effort: null, account: null };

  test("muse starts and wakes by poke, and never resumes", async () => {
    const orca = new FakeOrca();
    orca.bound.set("run_1", "term_1");
    const d = muse.make(seat(orca));
    expect(muse.resumes).toBe(false);
    expect(await d.start(mem, "muse-spark", null, "think")).toEqual({ ok: true, wt: THINKER });
    expect(orca.of("worker-start")[0].args.slice(3, 5)).toEqual(["muse", "muse-spark"]);
    expect(await d.poke(mem, "wake up")).toBe("started");
    expect((await d.resume(mem)).ok).toBe(false);
    expect(orca.of("worker-resume").length).toBe(0);
    expect(d.answerMenu("What do you want to do?\n1. Stop and wait")).toBeNull();
  });

  test("start and resume carry the role's auto-compact window when the seat knows it (U104)", async () => {
    const { claude } = await import("../../bin/loop/drivers/claude.ts");
    const orca = new FakeOrca();
    orca.bound.set("run_1", "term_1");
    const d = claude.make({ ...seat(orca), window: (role) => (role === "builder" ? "200000" : "-") });
    await d.start({ ...mem, role: "builder" }, "opus", null, "build");
    await d.start({ ...mem, wt: null, role: "builder", suffix: "u1" }, "opus", null, "build");
    await d.resume({ ...mem, role: "builder" });
    expect(orca.of("worker-start")[0].args[8]).toBe("200000");
    expect(orca.of("role-start")[0].args[10]).toBe("200000");
    expect(orca.of("worker-resume")[0].args[6]).toBe("200000");
  });

  test("the actuator's seat reads the window from the limits rows: role key, else other, else -", async () => {
    const s = imported();
    const row = (key: string, value: string) => s.upsert("config", { project: "fx", file: "limits.conf", key }, { value, observed_at: T });
    row("auto_compact_builder", "200000"); row("auto_compact_other", "400000"); row("auto_compact_lead", "off");
    const { act } = rig(s);
    const w = act.seat(s, "fx", "demo", "k", null, T).window!;
    expect([w("builder"), w("researcher"), w("lead"), w("thinker")]).toEqual(["200000", "400000", "-", "-"]);
  });

  test("claude answers its known menus", async () => {
    const { claude } = await import("../../bin/loop/drivers/claude.ts");
    const d = claude.make(seat(new FakeOrca()));
    expect(d.answerMenu("You've hit your limit\nWhat do you want to do?\n❯ 1. Stop and wait for limit to reset\n  2. Upgrade")).toBe("1");
    expect(d.answerMenu("Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit")).toBe("1");
    expect(d.answerMenu("$ ls")).toBeNull();
  });

  test("every start op carries the member's role last, so the backend keeps a standing role open (U64)", async () => {
    const { claude } = await import("../../bin/loop/drivers/claude.ts");
    const orca = new FakeOrca();
    orca.bound.set("run_1", "term_1");
    const d = claude.make(seat(orca));
    await d.start(mem, "opus", null, "think");
    await d.start({ ...mem, wt: null, role: "builder", suffix: "u1" }, "opus", null, "build");
    await d.resume({ ...mem, role: "lead" });
    expect(orca.of("worker-start")[0].args.at(-1)).toBe("thinker");
    expect(orca.of("role-start")[0].args.at(-1)).toBe("builder");
    const r = orca.of("worker-resume")[0].args;
    expect(r.at(-1)).toBe("lead");
    expect(r[2]).toContain("never call worker_done");
  });

  test("codex starts with model and effort, wakes by poke, and restarts fresh", async () => {
    const orca = new FakeOrca();
    orca.bound.set("run_1", "term_1");
    const d = codex.make(seat(orca));
    const worker = { ...mem, agent: "codex", model: "gpt-6.1-sol", effort: "high", account: "default" };
    expect(codex.resumes).toBe(false);
    expect(await d.start(worker, worker.model, worker.account, "think")).toEqual({ ok: true, wt: THINKER });
    expect(orca.of("worker-start")[0].args).toEqual([
      "run_1", THINKER, "think", "codex", "gpt-6.1-sol", "-", "high", "default", "-", "thinker",
    ]);
    expect(await d.poke(worker, "answer from operator")).toBe("started");
    expect(await d.resume(worker)).toEqual({ ok: false, error: "codex restarts start fresh from the squad state" });
    expect(orca.of("worker-resume")).toHaveLength(0);
    expect(d.answerMenu("What do you want to do?\n1. Stop and wait")).toBeNull();
    expect(await d.start({ ...worker, wt: null, role: "builder", suffix: "u1" }, worker.model, worker.account, "build")).toMatchObject({ ok: true });
    expect(orca.of("role-start")[0].args.slice(3, 6)).toEqual(["build", "codex", "gpt-6.1-sol"]);
    expect(orca.of("role-start")[0].args.at(-1)).toBe("builder");
  });
});

// U97: the backend's fresh-start guard (bin/backend/orca.sh) refuses a start into a worktree whose
// old agent is mid-turn with `agent_busy`. The loop reads that as a wait: the wish stays open and
// retries next tick. A close that fails is a plain refusal: the wish fails, no second session made.
describe("a babysit phase start the backend guard refuses", () => {
  test("agent_busy keeps the wish open and retries; once idle the start closes the old agent and starts", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u97busy");
    const wt = member(s, id).wt;
    orca.agent(wt, "term_old", "claude", true);
    s.want("member", String(id), "running", { payload: { why: "phase", prompt: "babysit" } });
    const a = rig(s, { orca });
    await a.tick(T);
    expect(orca.of("worker-start")).toHaveLength(1);
    expect(orca.started).toEqual([]);
    expect(member(s, id).want_result).toBeNull();
    expect(member(s, id).status).not.toBe("running");
    orca.agents.find((x) => x.handle === "term_old")!.busy = false;
    await a.tick(T + 70);
    expect(orca.of("worker-start")).toHaveLength(2);
    expect(orca.started).toHaveLength(1);
    expect(orca.agents.map((x) => x.handle)).toEqual([]);
    expect(member(s, id).status).toBe("running");
  });

  test("still busy after 30 min gets one agent_busy card; a later start resolves it", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u97card");
    const wt = member(s, id).wt;
    orca.agent(wt, "term_old", "claude", true);
    s.want("member", String(id), "running", { payload: { why: "phase", prompt: "babysit" } });
    const a = rig(s, { orca });
    const cards = () => { const f = join(s.root, "fx", "alerts.json"); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((x) => x.kind === "agent_busy") : []; };
    await a.tick(T);
    await a.tick(T + 1801);
    expect(cards()).toHaveLength(1);
    orca.agents.find((x) => x.handle === "term_old")!.busy = false;
    await a.tick(T + 1862);
    expect(member(s, id).status).toBe("running");
    expect(cards()).toEqual([]);
    expect(s.get("episodes", { project: "fx", subject: `member:${id}`, kind: "agent_busy" })?.ended_at).not.toBeNull();
  });

  test("a failed close fails the wish and makes no worker-start", async () => {
    const s = imported(), orca = new FakeOrca();
    const id = builder(s, "u97fail");
    const wt = member(s, id).wt;
    orca.agent(wt, "term_old", "claude");
    orca.closeFails.add("term_old");
    s.want("member", String(id), "running", { payload: { why: "phase", prompt: "babysit" } });
    const a = rig(s, { orca });
    for (let i = 0; i < 8; i++) await a.tick(T + i * 10);
    expect(orca.started).toEqual([]);
    expect(String(member(s, id).want_result)).toStartWith("failed:");
    expect(String(member(s, id).want_result)).toContain("could not close the old agent");
  });
});

test("childEnv: no ORCA_* reaches a child, but Orca's data path does, as DS_ORCA_DATA", () => {
  const saved = { path: process.env.ORCA_USER_DATA_PATH, ds: process.env.DS_ORCA_DATA };
  try {
    process.env.ORCA_USER_DATA_PATH = "/custom/orca";
    delete process.env.DS_ORCA_DATA;
    expect(childEnv().DS_ORCA_DATA).toBe("/custom/orca");
    expect(Object.keys(childEnv()).filter((k) => k.startsWith("ORCA_"))).toEqual([]);
    process.env.DS_ORCA_DATA = "/test/orca";
    expect(childEnv().DS_ORCA_DATA).toBe("/test/orca");
  } finally {
    for (const [k, v] of [["ORCA_USER_DATA_PATH", saved.path], ["DS_ORCA_DATA", saved.ds]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});


test("childEnv preserves CLI choice as DS_ORCA_CLI_BIN_DIR and explicit DS wins", () => {
  const saved = { orca: process.env.ORCA_CLI_BIN_DIR, ds: process.env.DS_ORCA_CLI_BIN_DIR };
  try {
    process.env.ORCA_CLI_BIN_DIR = "/custom/cli/bin";
    delete process.env.DS_ORCA_CLI_BIN_DIR;
    expect(childEnv().DS_ORCA_CLI_BIN_DIR).toBe("/custom/cli/bin");
    expect(childEnv().ORCA_CLI_BIN_DIR).toBeUndefined();
    process.env.DS_ORCA_CLI_BIN_DIR = "/test/cli/bin";
    expect(childEnv().DS_ORCA_CLI_BIN_DIR).toBe("/test/cli/bin");
  } finally {
    for (const [k, v] of [["ORCA_CLI_BIN_DIR", saved.orca], ["DS_ORCA_CLI_BIN_DIR", saved.ds]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// U150: one classifier reads every backend answer; a refusal that will not change is reality (the
// `refusals` table), with one event and one card, and no further call while its fingerprint holds.
// A probe fulfiller proposes its action every tick (as every reconciler does) through a real Loop
// tick with claims; `answers` scripts what Orca says to its call.
describe("refusals", () => {
  const cards = (s: Store) => { const f = join(s.root, "fx", "alerts.json"); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((x) => x.title === "Loop action refused") : []; };
  const evs = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
  const rows = (s: Store) => s.db.query("SELECT * FROM refusals ORDER BY first_at").all() as Row[];
  const saved = { gap: process.env.DS_LOOP_RETRY_S, tries: process.env.DS_LOOP_SEND_TRIES };
  afterEach(() => {
    for (const [k, v] of [["DS_LOOP_RETRY_S", saved.gap], ["DS_LOOP_SEND_TRIES", saved.tries]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  function probe(o: { gap?: string; answers: () => { code: number; out?: string; err?: string } | undefined; facts?: () => unknown; episode?: () => string; room?: () => boolean; show?: () => { code: number; out: string } | undefined;
    giveUp?: (a: Action, x: Exec, why: string) => unknown; payload?: () => unknown; subject?: string; squad?: string }) {
    if (o.gap === undefined) delete process.env.DS_LOOP_RETRY_S; else process.env.DS_LOOP_RETRY_S = o.gap;
    process.env.DS_LOOP_SEND_TRIES = "5";
    const s = imported(), orca = new FakeOrca();
    orca.answer = (c) => c.op === "probe" ? (() => { const a = o.answers(); return a && { code: a.code, out: a.out ?? "", err: a.err ?? "" }; })()
      : c.op === "request-show" ? o.show?.() && { ...o.show()!, err: "" } : undefined;
    const f: Fulfiller & Reconciler = {
      name: "probe", kinds: ["probe"],
      run: () => [{ project: "fx", subject: o.subject ?? "probe:1", kind: "probe", ...(o.squad ? { squad: o.squad } : {}), episode: o.episode?.() ?? "wish-1", ...(o.payload ? { payload: o.payload() } : {}) }],
      ready: () => o.room?.() ?? true,
      ...(o.facts ? { fingerprint: () => o.facts!() } : {}),
      ...(o.giveUp ? { giveUp: async (a: Action, x: Exec, why: string) => o.giveUp!(a, x, why) } : {}),
      exec: async (a, x) => {
        const out = await x.act.call(x.store, "probe", [a.episode], { key: `probe:${a.episode}`, project: "fx", squad: null, member: null, sender: "term_probe", at: x.now });
        return out.code === 0 ? { done: true } : { retry: out.err };
      },
    };
    const act = new LoopActuator({ orca, pick: picked(), fulfillers: [f] });
    const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
    loop.boot(T);
    const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
    return { s, orca, tick, calls: () => orca.of("probe") };
  }

  test("a permanent refusal is one event, one card and no further call until its fingerprint changes; done clears it", async () => {
    // rebind's live storm: the episode flips between two readings of one reality, the facts do not.
    let n = 0, facts = { member: "started-1" }, answer: { code: number; err?: string } = { code: 1, err: "orca: terminal term_x already has an active dispatch (ctx_1)" };
    const { s, tick, calls } = probe({ answers: () => answer, facts: () => facts, episode: () => (n++ % 2 ? "live|term_a" : "live|term_b") });
    for (let t = T; t < T + 40; t++) await tick(t);
    expect(calls()).toHaveLength(1);
    expect(evs(s, "refusal")).toEqual([expect.objectContaining({ subject: "probe:1", kind: "probe", class: "permanent", was: null, count: 1 })]);
    expect(rows(s)).toEqual([expect.objectContaining({ class: "permanent", count: 1, carded_at: T })]);
    expect(cards(s)).toHaveLength(1);
    expect(String(cards(s)[0].question)).toContain("already has an active dispatch");
    facts = { member: "started-2" };                       // what it depends on changed: one more try
    await tick(T + 40); await tick(T + 41);
    expect(calls()).toHaveLength(2);
    expect(rows(s)).toEqual([expect.objectContaining({ count: 1, first_at: T + 40 })]);   // the old row lapsed
    expect(cards(s)).toHaveLength(1);                      // its card resolved; the new refusal has its own
    answer = { code: 0 }; facts = { member: "started-3" };
    await tick(T + 42);
    expect(calls()).toHaveLength(3);
    expect(rows(s)).toEqual([]);
    expect(cards(s)).toEqual([]);                          // the subject went through: its cards resolve
    expect(evs(s, "refusal")).toHaveLength(2);
  });

  test("a permanent refusal of the same episode is tried again once its facts change", async () => {
    let facts = { dispatch: "dispatched" };
    const { s, tick, calls } = probe({ answers: () => ({ code: 1, err: "Terminal term_x already has an active dispatch (ctx_1)" }), facts: () => facts });
    for (let t = T; t < T + 10; t++) await tick(t);
    expect(calls()).toHaveLength(1);
    facts = { dispatch: "completed" };                     // the conflicting dispatch ended; the episode did not change
    await tick(T + 10); await tick(T + 11);
    expect(calls()).toHaveLength(2);
    expect(evs(s, "refusal")).toHaveLength(2);
    expect(cards(s)).toHaveLength(1);
  });

  test("a refusal card alerts.sh could not write is written by a later tick, at most once a minute", async () => {
    const { s, tick, calls } = probe({ answers: () => ({ code: 1, err: "no managed account for claude" }) });
    const file = join(s.root, "fx", "alerts.json");
    rmSync(file, { force: true }); mkdirSync(file, { recursive: true });   // alerts.sh cannot write it
    for (let t = T; t < T + 60; t++) await tick(t);
    expect(calls()).toHaveLength(1);
    expect(rows(s)).toEqual([expect.objectContaining({ class: "permanent", carded_at: null })]);
    expect(evs(s, "plugin_error")).toHaveLength(2);        // the settle's try, then ready()'s first
    rmSync(file, { recursive: true });
    await tick(T + 61);
    expect(calls()).toHaveLength(1);
    expect(rows(s)).toEqual([expect.objectContaining({ carded_at: T + 61 })]);
    expect(cards(s)).toEqual([expect.objectContaining({ kind: "loop_refusal", subject: "probe:1" })]);
  });

  test("U9: a permanent refusal of a squad's request types one line to its Lead and its card says so; no live Lead terminal: the card alone", async () => {
    const x = probe({ answers: () => ({ code: 1, err: "no managed account for claude" }), subject: "req:7", squad: "sq" });
    x.s.db.run("INSERT INTO members (project, squad, role, wt, status, observed_at, updated_at) VALUES ('fx', 'sq', 'lead', 'id::/wt/lead', 'running', ?, ?)", [T, T]);
    x.s.db.run("INSERT INTO observed_terminals (project, handle, wt, observed_at) VALUES ('fx', 'term_lead', 'id::/wt/lead', ?)", [T]);
    for (let t = T; t < T + 5; t++) await x.tick(t);
    const pokes = x.orca.of("poke-terminal");
    expect(pokes).toHaveLength(1);
    expect(JSON.stringify(pokes[0])).toContain("term_lead");
    expect(cards(x.s)).toEqual([expect.objectContaining({ kind: "loop_refusal", subject: "req:7", squad: "sq" })]);
    expect(String(cards(x.s)[0].question)).toContain("Lead was told");
    expect(String(cards(x.s)[0].question)).not.toContain("tries again");
    const y = probe({ answers: () => ({ code: 1, err: "no managed account for claude" }), subject: "req:8", squad: "sq" });
    await y.tick(T);
    expect(y.orca.of("poke-terminal")).toHaveLength(0);
    expect(cards(y.s)).toHaveLength(1);
    expect(String(cards(y.s)[0].question)).not.toContain("Lead was told");
  });

  test("a fulfiller that wrote its own card gets no refusal card beside it; one whose card failed gets the actuator's", async () => {
    const own = probe({ answers: () => ({ code: 1, err: "no managed account for claude" }), giveUp: () => true });
    await own.tick(T);
    expect(rows(own.s)).toEqual([expect.objectContaining({ class: "permanent", carded_at: T })]);
    expect(cards(own.s)).toEqual([]);
    const failed = probe({ answers: () => ({ code: 1, err: "no managed account for claude" }), giveUp: () => false });
    await failed.tick(T);
    expect(rows(failed.s)).toEqual([expect.objectContaining({ class: "permanent", carded_at: T })]);
    expect(cards(failed.s)).toHaveLength(1);
  });

  test("a request-backed action given up fails its request, which tells the requester: no refusal card (the board's answer)", async () => {
    let id = 0;
    const x = probe({ answers: () => ({ code: 1, err: "no managed account for claude" }), giveUp: failRequest, payload: () => ({ request: id }) });
    // "probe" is no request kind: a row from before U43 stands in (the store would refuse it)
    id = Number(x.s.db.run("INSERT INTO requests (project, kind, payload, requested_by, created_at) VALUES ('fx', 'probe', '{}', 'board', 1)").lastInsertRowid);
    await x.tick(T);
    expect(rows(x.s)).toEqual([expect.objectContaining({ class: "permanent", carded_at: T })]);
    expect(cards(x.s)).toEqual([]);
    expect(JSON.parse(String(x.s.get("requests", { id })?.result))).toEqual({ ok: false, error: expect.stringContaining("no managed account") });
  });

  test("another action kind on the same subject never lapses or clears a refusal (liveness's run-switch and alert share a key)", () => {
    const s = imported();
    const r = (kind: string, facts: unknown) => refuse(s, { project: "fx", subject: "key:1", kind, fingerprint: fingerprint(kind, "key:1", facts), text: "no managed account for claude", at: T }, "permanent");
    r("run-switch", { to: "opus" });
    expect(lapse(s, "fx", "key:1", "alert", fingerprint("alert", "key:1", {}))).toEqual([]);
    expect(clear(s, "fx", "key:1", "alert")).toEqual([]);
    expect(rows(s)).toEqual([expect.objectContaining({ kind: "run-switch", class: "permanent" })]);
    expect(lapse(s, "fx", "key:1", "run-switch", fingerprint("run-switch", "key:1", { to: "sonnet" }))).toHaveLength(1);
    expect(rows(s)).toEqual([]);
  });

  test("a refusal card stays on the board while its row stands, past the day-old rule, and goes with it", async () => {
    const { s, tick } = probe({ answers: () => ({ code: 1, err: "no managed account for claude" }) });
    await tick(T);
    const [card] = cards(s);
    s.db.run("INSERT INTO observed_alerts (project, id, doc, observed_at) VALUES ('fx', ?, ?, ?)", [String(card.id), JSON.stringify(card), T]);   // the state observer's row
    expect(dropAlerts({ store: s, project: "fx", now: T + 3 * 86_400 } as TickCtx)).toEqual([]);
    expect(alertGone(s, "fx", card, T + 3 * 86_400)).toBe(false);
    s.db.run("DELETE FROM refusals");
    expect(alertGone(s, "fx", card, T + 3 * 86_400)).toBe("the refusal no longer stands");
    expect(dropAlerts({ store: s, project: "fx", now: T + 3 * 86_400 } as TickCtx)).toEqual([expect.objectContaining({ payload: { id: card.id, why: "the refusal no longer stands" } })]);
  });

  test("a transient failure is tried once every 15 minutes; after 5 tries it is one card and no more calls", async () => {
    const { s, tick, calls } = probe({ answers: () => ({ code: 1, err: "orca: dispatch store busy, try later" }) });
    for (let t = T; t <= T + 5 * 900 + 3600; t += 60) await tick(t);
    expect(calls().map((c) => c.via.retry)).toHaveLength(5);
    expect(new Set(calls().map((c) => c.via.retry)).size).toBe(5);   // request-show absent: refused, a new id each try
    const at = (s.db.query("SELECT at FROM orca_calls WHERE op = 'probe' ORDER BY id").all() as { at: number }[]).map((r) => r.at - T);
    expect(at).toEqual([0, 900, 1800, 2700, 3600]);
    expect(evs(s, "refusal").map((e) => [e.class, e.was, e.count])).toEqual([["transient", null, 1], ["permanent", "transient", 5]]);
    expect(cards(s)).toHaveLength(1);
    expect(String(cards(s)[0].question)).toContain("after 5 tries");
    expect(evs(s, "action_failed")).toHaveLength(1);
  });

  // U270: a Claude launch that failed (the adapter's "never came up" / "could not open a terminal").
  const NEVER = "orca adapter: claude on account acctA never came up in wt_1";
  const callsAt = (s: Store) => (s.db.query("SELECT at FROM orca_calls WHERE op = 'probe' ORDER BY id").all() as { at: number }[]).map((r) => r.at - T);
  // Tick at the probe's next try until it has none.
  async function untilDone(s: Store, tick: (at: number) => Promise<void>) {
    await tick(T);
    for (let i = 0; i < 20; i++) {
      const e = s.db.query("SELECT next_at FROM episodes WHERE kind = 'action:probe' AND subject = 'probe:1' AND state = 'pending'").get() as { next_at: number } | null;
      const r = s.db.query("SELECT next_at FROM refusals WHERE subject = 'probe:1' AND class = 'transient'").get() as { next_at: number } | null;
      const next = e?.next_at ?? r?.next_at;
      if (!next) return;
      await tick(Number(next));
    }
  }

  test("U270: the launch texts are their own class", () => {
    expect(classify(NEVER)).toBe("launch");
    expect(classify("orca adapter: could not open a terminal in wt_1 for account acctA")).toBe("launch");
    expect(classify("orca adapter: worker-resume — claude --continue never came up in wt_1 (screen in event start_failed 9)")).toBe("launch");
    expect(classify("orca: dispatch store busy, try later")).toBe("transient");
  });

  test("U270: a launch failure is tried again after 60–90 s, three times uncounted, then every 15 minutes, counted", async () => {
    const { s, tick } = probe({ answers: () => ({ code: 1, err: NEVER }) });
    await untilDone(s, tick);
    const at = callsAt(s), gaps = at.slice(1).map((x, i) => x - at[i]);
    expect(at).toHaveLength(LAUNCH_TRIES + 5);
    expect(gaps.slice(0, LAUNCH_TRIES)).toEqual([1, 2, 3].map((n) => launchRetryAt("probe:1", n, 0)));
    for (const g of gaps.slice(0, LAUNCH_TRIES)) { expect(g).toBeGreaterThanOrEqual(60); expect(g).toBeLessThanOrEqual(90); }
    expect(gaps.slice(LAUNCH_TRIES)).toEqual([900, 900, 900, 900]);
    expect(evs(s, "refusal").map((e) => [e.class, e.was, e.count])).toEqual([["transient", null, 1], ["permanent", "transient", 5]]);
    expect(cards(s)).toHaveLength(1);
  });

  test("U270: subjects whose launches failed in the same tick come back at different times", () => {
    const next = ["member:1", "member:2", "member:3", "member:4"].map((m) => launchRetryAt(m, 1, T));
    expect(new Set(next).size).toBe(4);
    for (const n of next) { expect(n - T).toBeGreaterThanOrEqual(60); expect(n - T).toBeLessThanOrEqual(90); }
    expect(launchRetryAt("member:1", 1, T)).not.toBe(launchRetryAt("member:1", 2, T));   // and each try of one subject moves
  });

  test("U270: a start_failed line is one event with the screen and load1; the answer keeps only a pointer", async () => {
    const doc = { failure: NEVER.slice("orca adapter: ".length), worktree: "wt_1", account: "acctA", screen: "Error: ~/.claude.json is locked", orca: "orca: wait timed out\nexit 1" };
    const { s, tick } = probe({ answers: () => ({ code: 1, err: `${NEVER}\norca adapter: start_failed ${JSON.stringify(doc)}\n` }) });
    s.db.run("INSERT INTO observed_machine (host, cores, load1, observed_at) VALUES ('h', 8, 3.5, ?), ('h2', 8, 12.25, ?)", [T - 60, T - 5]);
    await tick(T);
    const ev = s.db.query("SELECT id, project, payload FROM events WHERE kind = 'start_failed'").all() as { id: number; project: string; payload: string }[];
    expect(ev).toHaveLength(1);
    expect(ev[0].project).toBe("fx");
    expect(JSON.parse(ev[0].payload)).toEqual({ worktree: "wt_1", account: "acctA", failure: doc.failure, screen: doc.screen, orca: doc.orca, load1: 12.25 });
    const result = (s.db.query("SELECT result FROM orca_calls WHERE op = 'probe'").get() as { result: string }).result;
    expect(result).toBe(`${NEVER} (screen in event start_failed ${ev[0].id})`);
    expect(classify(result)).toBe("launch");
  });

  test("a fixable cause gets one more try, uncounted; seen again it is a transient refusal", async () => {
    let n = 0;
    const answers = [{ code: 1, err: "orca: run_not_bound: the sender is not bound to Run run_x" }, { code: 0 }];
    const once = probe({ gap: "1", answers: () => answers[n++] });
    await once.tick(T); await once.tick(T + 1);
    expect(once.calls()).toHaveLength(2);
    expect(rows(once.s)).toEqual([]);
    expect(evs(once.s, "refusal")).toEqual([]);
    const again = probe({ answers: () => ({ code: 1, err: "orca: run_not_bound: the sender is not bound to Run run_x" }) });
    for (let t = T; t < T + 60; t++) await again.tick(t);
    expect(again.calls()).toHaveLength(2);                  // the fix, then a refusal like any other
    expect(rows(again.s)).toEqual([expect.objectContaining({ class: "transient", count: 1, next_at: T + 1 + 900 })]);
    expect(cards(again.s)).toEqual([]);
  });

  test("a retry recorded while the loop is stopping is tried on the next tick, uncounted, with no refusal row", async () => {
    const err = "orca: dispatch store busy, try later";
    let n = 0;
    // The child answers, then the signal handler sets the flag before the actuator records the result.
    const stop = probe({ answers: () => { if (n++ === 0) markStopping(); return { code: n === 1 ? 143 : 0, err }; } });
    try {
      await stop.tick(T);
      expect(rows(stop.s)).toEqual([]);
      expect(evs(stop.s, "refusal")).toEqual([]);
      resetStopping();
      await stop.tick(T + 1);                                // the next loop process: its first tick
      expect(stop.calls()).toHaveLength(2);
      expect(claim(stop.s, { subject: "probe:1", kind: "probe" })!.state).toBe("done");
      expect(rows(stop.s)).toEqual([]);
    } finally { resetStopping(); }
  });

  test("the same retry while the loop is not stopping is a transient refusal that waits the retry gap", async () => {
    resetStopping();
    const run = probe({ answers: () => ({ code: 143, err: "orca: dispatch store busy, try later" }) });
    await run.tick(T); await run.tick(T + 1);
    expect(run.calls()).toHaveLength(1);
    expect(rows(run.s)).toEqual([expect.objectContaining({ class: "transient", count: 1, next_at: T + 900 })]);
  });

  test("no room is no claim, no call and no card; agent_busy waits uncounted", async () => {
    const full = probe({ answers: () => ({ code: 0 }), room: () => false });
    for (let t = T; t < T + 20; t++) await full.tick(t);
    expect(full.calls()).toEqual([]);
    expect(claim(full.s, { subject: "probe:1", kind: "probe" })).toBeNull();
    expect(evs(full.s, "action")).toEqual([]);
    expect(cards(full.s)).toEqual([]);
    let busy = true;
    const b = probe({ answers: () => busy ? { code: 1, err: "orca: agent_busy: the terminal is mid-turn" } : { code: 0 } });
    for (let t = T; t <= T + 300; t += 10) await b.tick(t);
    expect(b.calls().length).toBe(11);                      // once per 30 s, never counted towards 5
    expect(rows(b.s)).toEqual([]);
    expect(cards(b.s)).toEqual([]);
    busy = false; await b.tick(T + 330);
    expect(claim(b.s, { subject: "probe:1", kind: "probe" })!.state).toBe("done");
  });

  test("a refusal marks the call failed so the next try gets a new id; an unknown outcome replays the same id", async () => {
    let lost = false;
    const { tick, calls } = probe({ gap: "1", answers: () => ({ code: 1, err: "orca: something odd" }), show: () => lost ? { code: 1, out: "" } : undefined });
    await tick(T); await tick(T + 1);
    const [a, b] = calls().map((c) => c.via.retry);
    expect(a).not.toBe(b);
    lost = true;                                            // request-show cannot say: the outcome is unknown
    await tick(T + 2); await tick(T + 3); await tick(T + 4);
    const ids = calls().slice(2).map((c) => c.via.retry);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
  });
});

describe("one event per wait (account-move-slow U3)", () => {
  test("the same wait on 5 ticks writes one action and one action_pending event; a changed text writes one more of each", async () => {
    const s = imported();
    let text = "agent still running after stop";
    const a: Action = { project: "fx", squad: "demo", member: LEAD, subject: "demo.waiter", kind: "poke", episode: "wait|1", payload: {} };
    const waiter: Fulfiller = { name: "waiter", kinds: ["poke"], run: () => [a], exec: async () => ({ wait: text }) };
    const act = new LoopActuator({ orca: new FakeOrca(), fulfillers: [waiter] });
    const loop = new Loop(s, { observers: [], reconcilers: [waiter] }, act, { projects: () => ["fx"] });
    loop.boot(T);
    const n = (kind: string) => (s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = ? AND json_extract(payload, '$.subject') = 'demo.waiter'").get(kind) as { n: number }).n;
    const na = () => (s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'action' AND json_extract(payload, '$.subject') = 'demo.waiter'").get() as { n: number }).n;
    for (let i = 0; i < 5; i++) { await loop.tick(T + i * 5); await act.drain(); }
    expect(na()).toBe(1);
    expect(n("action_pending")).toBe(1);
    text = "agent still running after stop (2)";
    await loop.tick(T + 30); await act.drain();
    expect(na()).toBe(2);
    expect(n("action_pending")).toBe(2);
  });
});
