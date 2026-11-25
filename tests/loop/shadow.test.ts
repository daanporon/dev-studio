// shadow.test.ts — orca-backend-alternatives U10: the new backend-neutral signals computed beside the
// old Orca ones (bin/loop/squad/shadow.ts), the reconciler that logs their disagreements once
// (bin/loop/reconcilers/shadow.ts) and `ds shadow report|explain` (bin/loop/squad/shadow-report.ts).
// Every scenario is rows in a temp store, ticked by hand: a PR finish, a no-PR finish, a failed finish,
// a Tester verdict, a forced crash, a crash after a finish row while the PR is open and a restart all
// agree at every point; a planted mismatch logs one event, a two-tick blip a transient one.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { recordFinish } from "../../bin/loop/squad/finish.ts";
import { forgetRunWorkers, noteRunWorkers, type RunWorker } from "../../bin/loop/squad/run-reads.ts";
import { pairs } from "../../bin/loop/squad/shadow.ts";
import { shadowTick } from "../../bin/loop/reconcilers/shadow.ts";
import { explain, report, reportText } from "../../bin/loop/squad/shadow-report.ts";

const P = "zzshadow", SQ = "sq", ROOT = join(import.meta.dir, "..", "..");
const temps: string[] = [], stores: Store[] = [];
let s: Store, dir: string, tick = 0, now = 1_000_000;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zzshadow-")); temps.push(dir);
  s = open(dir); stores.push(s);
  tick = 0; now = 1_000_000; forgetRunWorkers();
  s.upsert("squads", { project: P, topic: SQ }, { status: "running", type: "feature", observed_at: now, updated_at: now });
});
afterEach(() => {
  for (const x of stores.splice(0)) { try { x.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  forgetRunWorkers();
});

// ------------------------------------------------------------- rows
let ids = 0;
function member(role: string, suffix = "", o: Row = {}): Row {
  const id = ++ids, wt = `/w/${role}${suffix ? `-${suffix}` : ""}-${id}`;
  s.upsert("members", { id }, { project: P, squad: SQ, role, suffix, wt, gen: `g${id}-1`, want: "running", status: "running",
    agent: "claude", placed_at: now - 600, observed_at: now, updated_at: now, ...o });
  s.upsert("observed_workers", { project: P, wt }, { walk: "running", presence: "running", state: "working", account_at: now - 500,
    started_at: now - 590, dispatch_id: `ctx_${id}`, dispatch: "dispatched", observed_at: now, ...(o.worker as Row ?? {}) });
  return s.get("members", { id })!;
}
const m = (id: number) => s.get("members", { id })!;
const work = (wt: string, set: Row) => s.upsert("observed_workers", { project: P, wt }, { ...set, observed_at: now });
const finish = (mm: Row, outcome: string, gen = String(mm.gen)) =>
  recordFinish(s, { member: { project: P, squad: SQ, role: String(mm.role), suffix: String(mm.suffix ?? "") }, unit: mm.role === "builder" ? String(mm.suffix) : null,
    outcome: outcome as never, body: outcome, gen, wt: String(mm.wt) }, now);
let relays = 0;
const workerDone = (mm: Row, outcome: string, age = 0) => s.upsert("relayed", { msg_id: `msg_${++relays}` }, { project: P, squad: SQ, run_id: "run_x", type: "worker_done",
  subject: "done", body: "", payload: JSON.stringify({ dispatchId: s.get("observed_workers", { project: P, wt: mm.wt })!.dispatch_id, outcome }), seen_at: now - age, tries: 0 });
function transcript(wt: string, ended: boolean) {
  const f = join(dir, `t-${wt.replace(/\W/g, "_")}.jsonl`);
  writeFileSync(f, `${JSON.stringify({ type: "assistant", message: { content: [] } })}\n${ended ? `${JSON.stringify({ type: "system", subtype: "stop_hook_summary" })}\n` : ""}`);
  s.upsert("observed_transcripts", { path: f }, { project: P, wt, mtime: now, size: 1, observed_at: now });
}
function restart(mm: Row, gen: string) {
  s.upsert("members", { id: mm.id }, { gen, placed_at: now, updated_at: now });
  work(String(mm.wt), { walk: "running", presence: "running", state: "working", gone_at: null, account_at: now + 1, started_at: now, dispatch_id: `ctx_${gen}`, dispatch: "dispatched" });
}

// ------------------------------------------------------------- ticks
// One tick: the members reconciler's Run read (when given), then the shadow.
function step(workers?: RunWorker[]) {
  tick++; now += 30;
  if (workers) noteRunWorkers(P, SQ, tick, workers);
  shadowTick(s, P, tick, now);
}
const live = (...ms: Row[]): RunWorker[] => ms.map((x) => ({ wt: String(x.wt), live: true, dispatch: `ctx_${x.id}` }));
const events = (kind: string): Row[] => (s.db.query("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[]).map((e) => ({ ...e, p: JSON.parse(String(e.payload)) }));
const disagreements = () => events("shadow_disagree");
const disagreeing = () => pairs(s, P, tick, now).filter((p) => p.old !== p.new);

describe("every scenario agrees at every point", () => {
  test("a Builder's PR finish, through the merge to its retire", () => {
    const b = member("builder", "u1-a");
    s.upsert("units", { project: P, squad: SQ, slug: "u1-a" }, { status: "dispatched", builder_wt: b.wt, observed_at: now, updated_at: now });
    for (let i = 0; i < 3; i++) { step(live(b)); expect(disagreeing()).toEqual([]); }
    finish(b, "ok"); workerDone(b, "ok");
    for (let i = 0; i < 3; i++) { step(live(b)); expect(disagreeing()).toEqual([]); }
    const finished = pairs(s, P, tick, now).find((p) => p.point === "finished")!;
    expect([finished.old, finished.new]).toEqual(["ok", "ok"]);
    // The PR merges; the Builder is at its prompt: both sides retire it.
    s.upsert("units", { project: P, squad: SQ, slug: "u1-a" }, { status: "done", pr: "#41", observed_at: now, updated_at: now });
    s.upsert("observed_prs", { project: P, ref: `${SQ}/u1-a` }, { pr: 41, state: "MERGED", observed_at: now });
    work(String(b.wt), { state: "idle" }); transcript(String(b.wt), true);
    step(live(b));
    const retire = pairs(s, P, tick, now).find((p) => p.point === "retire")!;
    expect([retire.old, retire.new]).toEqual(["retire", "retire"]);
    expect(disagreeing()).toEqual([]);
    expect(disagreements()).toEqual([]);
  });

  test("a no-PR finish and a failed finish", () => {
    const a = member("builder", "u2-b"), c = member("builder", "u3-c");
    step(live(a, c));
    finish(a, "no-pr"); workerDone(a, "ok");
    finish(c, "failed"); workerDone(c, "failed");
    step(live(a, c));
    const f = pairs(s, P, tick, now).filter((p) => p.point === "finished").map((p) => [p.member, p.old, p.new]);
    expect(f).toEqual([[`${P}/${SQ}/builder-u2-b`, "ok", "ok"], [`${P}/${SQ}/builder-u3-c`, "failed", "failed"]]);
    for (let i = 0; i < 3; i++) step(live(a, c));
    expect(disagreements()).toEqual([]);
  });

  test("a Tester's verdict: finished, stopped and retired on both sides", () => {
    const t = member("tester");
    step(live(t));
    finish(t, "verdict"); workerDone(t, "ok");
    work(String(t.wt), { dispatch: "completed", walk: "none", presence: "none", state: "idle" });
    const gone: RunWorker[] = [{ wt: String(t.wt), live: false, dispatch: null, reported: true }];
    for (let i = 0; i < 3; i++) { step(gone); expect(disagreeing()).toEqual([]); }
    const at = Object.fromEntries(pairs(s, P, tick, now).map((p) => [p.point, [p.old, p.new]]));
    expect(at).toEqual({ start: ["stopped", "stopped"], finished: ["ok", "ok"], retire: ["retire", "retire"] });
    expect(disagreements()).toEqual([]);
  });

  test("a forced crash is counted once, and both sides start it again", () => {
    const b = member("builder", "u4-d");
    step(live(b));
    work(String(b.wt), { walk: "none", presence: "none", state: "idle", gone_at: now + 10 });
    step([]);
    const start = pairs(s, P, tick, now).find((p) => p.point === "start")!;
    expect([start.old, start.new]).toEqual(["none", "none"]);
    restart(b, "g-crash-2");
    step(live(m(b.id)));
    expect(events("shadow_crash").map((e) => e.p)).toEqual([{ member: `${P}/${SQ}/builder-u4-d`, id: b.id, gen: String(b.gen), next: "g-crash-2" }]);
    step(live(m(b.id)));
    expect(events("shadow_crash")).toHaveLength(1);
    expect(disagreements()).toEqual([]);
  });

  test("a crash after a finish row while the PR is open is no crash", () => {
    const b = member("builder", "u5-e");
    step(live(b));
    finish(b, "ok"); workerDone(b, "ok");
    step(live(b));
    work(String(b.wt), { walk: "none", presence: "none", gone_at: now + 10 });
    step([]);
    restart(b, "g-after-2");
    step(live(m(b.id))); step(live(m(b.id)));
    expect(events("shadow_crash")).toEqual([]);
    expect(disagreements()).toEqual([]);
  });

  test("a restart the loop made is no crash", () => {
    const b = member("builder", "u6-f");
    step(live(b));
    s.event("member_stopped", { project: P, squad: SQ, member: String(b.wt), payload: { id: b.id } });
    restart(b, "g-restart-2");
    step(live(m(b.id))); step(live(m(b.id)));
    expect(events("shadow_crash")).toEqual([]);
    expect(disagreements()).toEqual([]);
  });
});

describe("disagreements", () => {
  test("a planted mismatch logs one event with both sides and the point", () => {
    const b = member("builder", "u7-g");
    step(live(b));
    finish(b, "ok");   // no worker_done: the old side never sees the finish
    for (let i = 0; i < 6; i++) step(live(b));
    const d = disagreements();
    expect(d).toHaveLength(1);
    expect(d[0].p).toMatchObject({ point: "finished", old: "no", new: "ok", member: `${P}/${SQ}/builder-u7-g`, id: b.id, transient: false, ticks: 2 });
    expect(d[0].member).toBe(b.wt);
    // It agrees again: nothing more is logged.
    workerDone(b, "ok");
    step(live(b)); step(live(b));
    expect(disagreements()).toHaveLength(1);
  });

  test("a disagreement that agrees again within two ticks is logged transient", () => {
    const b = member("builder", "u8-h");
    step(live(b));
    workerDone(b, "ok", 200);   // past the grace the loop gives a Builder's report
    step(live(b));            // the worker_done is here, the finish row not yet
    finish(b, "ok");
    step(live(b));
    const d = disagreements();
    expect(d).toHaveLength(1);
    expect(d[0].p).toMatchObject({ point: "finished", old: "ok", new: "no", transient: true, ticks: 1 });
    expect(report(s, { project: P, now }).points.finished).toEqual({ counted: 0, transient: 1, explained: 0 });
  });

  test("the member point: a live Run worker with no member row, and a member the Run does not list", () => {
    const b = member("builder", "u9-i");
    const stray: RunWorker = { wt: "/w/stray", live: true, dispatch: "ctx_stray" };
    // The Run lists the Builder with its task, not live (members.ts would rebind it), and a stray it holds.
    const dropped: RunWorker = { wt: String(b.wt), live: false, dispatch: null, task: "task_1", status: "failed" };
    for (let i = 0; i < 3; i++) step([dropped, stray]);
    const d = disagreements().map((e) => [e.p.point, e.p.member, e.p.old, e.p.new]);
    expect(d).toEqual([["member", `${P}/${SQ}/builder-u9-i`, "absent", "member"], ["member", "/w/stray", "member", "absent"]]);
    // No Run read this tick: the member point is unknown, its episodes stay open and nothing is logged.
    step(); step();
    expect(disagreements()).toHaveLength(2);
  });

  test("a member the Run does not list, or lists finished, has no member pair", () => {
    member("lead"); const t = member("tester");
    for (let i = 0; i < 3; i++) step([{ wt: String(t.wt), live: false, dispatch: null, task: "task_t", status: "completed" }]);
    expect(pairs(s, P, tick, now).filter((p) => p.point === "member")).toEqual([]);
    expect(disagreements()).toEqual([]);
  });

  test("a Lead bound through a settled rebind is a member on both sides", () => {
    const lead = member("lead");
    s.event("member_rebound_settled", { project: P, squad: SQ, member: String(lead.wt), payload: { task: "task_rb", handle: "term_l" } });
    for (let i = 0; i < 3; i++) step([{ wt: String(lead.wt), live: false, dispatch: null, task: "task_rb", status: "completed" }]);
    expect(pairs(s, P, tick, now).filter((p) => p.point === "member").map((p) => [p.old, p.new])).toEqual([["member", "member"]]);
    expect(disagreements()).toEqual([]);
  });

  test("an explained event leaves the unexplained count; a transient or unknown one is refused", () => {
    const b = member("builder", "u10-j");
    step(live(b)); finish(b, "ok");
    for (let i = 0; i < 6; i++) step(live(b));   // past the grace a finish row gets before its worker_done
    const [d] = disagreements();
    let r = report(s, { project: P, now });
    expect(r.unexplained.map((u) => u.id)).toEqual([d.id]);
    expect(r.points.finished.counted).toBe(1);
    expect(explain(s, Number(d.id), "the relay was paused")).toMatchObject({ ok: true });
    expect(explain(s, Number(d.id), "again")).toEqual({ ok: false, error: `#${d.id} is already explained` });
    expect(explain(s, 999999, "x")).toMatchObject({ ok: false });
    r = report(s, { project: P, now });
    expect(r.unexplained).toEqual([]);
    expect(r.points.finished).toEqual({ counted: 0, transient: 0, explained: 1 });
    expect(events("shadow_explained")[0].p).toEqual({ event: d.id, why: "the relay was paused" });
  });

  test("a Codex member (no generation) is skipped", () => {
    member("builder", "u11-k", { agent: "codex", gen: null });
    for (let i = 0; i < 3; i++) step([]);
    expect(pairs(s, P, tick, now)).toEqual([]);
    expect(disagreements()).toEqual([]);
    expect(s.db.query("SELECT COUNT(*) AS n FROM episodes WHERE kind IN ('shadow', 'shadow-gen')").get()).toEqual({ n: 0 });
  });
});

// U21a: the patterns `ds shadow report --since 2026-11-24T09:05:32Z` listed, each a lag between two
// signals that would come back every day; each now agrees (docs/backends/shadow.md, "Patterns").
describe("U21a patterns agree", () => {
  const unit = (b: Row, set: Row) => s.upsert("units", { project: P, squad: SQ, slug: String(b.suffix) }, { status: "dispatched", builder_wt: b.wt, observed_at: now, updated_at: now, ...set });

  test("A: the finish row lands just before the relayed worker_done (old no, new ok within the grace)", () => {
    const b = member("builder", "pa");
    step(live(b));
    finish(b, "no-pr");
    for (let i = 0; i < 3; i++) step(live(b));                     // 90 s: the relay is late
    workerDone(b, "ok");
    for (let i = 0; i < 3; i++) step(live(b));
    expect(disagreements()).toEqual([]);
  });

  test("B: a Builder with a PR sends worker_done at the PR; its finish row comes from the babysit generation", () => {
    const b = member("builder", "pb");
    unit(b, { pr: "#77" });
    step(live(b));
    workerDone(b, "ok");                                            // the PR is open: the loop ignores this report
    for (let i = 0; i < 4; i++) step(live(b));
    restart(b, "pb-2");                                             // the phase restart: a new generation, no finish row yet
    for (let i = 0; i < 4; i++) step(live(m(b.id)));
    expect(pairs(s, P, tick, now).find((p) => p.point === "finished")).toBeUndefined();
    expect(disagreements()).toEqual([]);
  });

  test("C: a Tester that sends worker_done with no verdict finish row is still flagged (a role gap, not a lag)", () => {
    const t = member("tester", "pc");
    step(live(t));
    workerDone(t, "ok");
    for (let i = 0; i < 6; i++) step(live(t));
    expect(disagreements().map((d) => [d.p.point, d.p.old, d.p.new, d.p.transient])).toEqual([["finished", "ok", "no", false]]);
  });

  test("D: the loop already wants the member gone (retired), the new side reads its end a tick later", () => {
    const t = member("tester", "pd");
    finish(t, "verdict");
    s.upsert("members", { id: t.id }, { want: "gone" });
    const done: RunWorker = { wt: String(t.wt), live: false, dispatch: null, task: "task_pd", status: "completed", reported: true };
    for (let i = 0; i < 3; i++) step([done]);                        // its agent still runs: the new side would keep it
    expect(pairs(s, P, tick, now).filter((p) => p.point === "retire")).toEqual([]);
    expect(disagreements()).toEqual([]);
  });

  test("E: a phase switch's stop in flight, and a squad archived with the member's wish still running", () => {
    const b = member("builder", "pe");
    s.event("member_phase", { project: P, squad: SQ, unit: "pe", member: String(b.wt), payload: { phase: "babysit", was: "build" } });
    const dropped: RunWorker = { wt: String(b.wt), live: false, dispatch: null, task: "task_pe", status: "failed" };
    for (let i = 0; i < 3; i++) step([dropped]);
    expect(disagreements()).toEqual([]);
    const lead = member("lead");
    s.upsert("squads", { project: P, topic: SQ }, { status: "closed" });
    const gone: RunWorker = { wt: String(lead.wt), live: false, dispatch: null, task: "task_l", status: "failed" };
    for (let i = 0; i < 3; i++) step([gone]);
    expect(pairs(s, P, tick, now).filter((p) => p.point === "member")).toEqual([]);
    expect(disagreements()).toEqual([]);
  });

  test("F: a start Orca already lists that no walk has read yet (running against starting)", () => {
    const b = member("builder", "pf", { placed_at: now + 1 });
    work(String(b.wt), { walk: "none", presence: "running", account_at: now - 5 });   // the walk ran before the start
    for (let i = 0; i < 3; i++) step(live(b));
    const st = pairs(s, P, tick, now).find((p) => p.point === "start")!;
    expect([st.old, st.new]).toEqual(["running", "running"]);
    expect(disagreements()).toEqual([]);
  });

  test("G (U21d): a Builder's worker_done younger than DONE_GRACE_S, with no finish row, makes no pair; an old one still compares", () => {
    const b = member("builder", "pg");
    step(live(b));
    workerDone(b, "ok");                                            // the PR follows 22 s later; the loop would ignore this report
    for (let i = 0; i < 3; i++) {
      step(live(b));
      expect(pairs(s, P, tick, now).find((p) => p.point === "finished")).toBeUndefined();
    }
    expect(disagreements()).toEqual([]);
    now += 200;                                                     // past the grace, still no PR: as today
    step(live(b));
    expect(pairs(s, P, tick, now).find((p) => p.point === "finished")).toMatchObject({ old: "ok", new: "no" });
  });

  test("H (U21d): an observed_prs row for the member's branch is a PR the unit has not recorded yet", () => {
    const b = member("builder", "ph");
    s.upsert("squads", { project: P, topic: SQ }, { repo: "r" });
    s.upsert("config", { project: P, file: "github", key: "repo:r" }, { value: "o/r", observed_at: now });
    s.upsert("observed_worktrees", { project: P, wt: String(b.wt) }, { branch: "feat/ph", observed_at: now });
    step(live(b));
    workerDone(b, "ok", 200);
    expect(pairs(s, P, tick, now).find((p) => p.point === "finished")).toMatchObject({ old: "ok", new: "no" });
    s.upsert("observed_prs", { project: P, ref: "o/r#9" }, { repo: "o/r", pr: 9, head: "feat/ph", state: "OPEN", observed_at: now });
    expect(pairs(s, P, tick, now).find((p) => p.point === "finished")).toBeUndefined();
  });

  test("a Builder killed mid-work under a stale Orca view: both sides read it gone past GONE_MIN, and its restart is a crash", () => {
    const b = member("builder", "pk");
    step(live(b));
    work(String(b.wt), { walk: "none", walk_none_at: now, account_at: now });   // KILLed; Orca still reads it working
    step(live(b));
    // Under GONE_MIN the old side still reads it running: a known lag, so the pair agrees.
    expect(pairs(s, P, tick, now).find((p) => p.point === "start")).toMatchObject({ old: "running", new: "running" });
    for (let i = 0; i < 6; i++) { work(String(b.wt), { account_at: now }); step(live(b)); }
    expect(pairs(s, P, tick, now).find((p) => p.point === "start")).toMatchObject({ old: "none", new: "none" });
    expect(disagreements()).toEqual([]);
    restart(b, "pk-2");
    step(live(m(b.id)));
    expect(events("shadow_crash").map((e) => e.p.gen)).toEqual([String(b.gen)]);
  });
});

describe("ds shadow report", () => {
  test("exit is met only with the finishes, the hard ones, the crashes and the days", () => {
    step([]);
    const start = Number(events("shadow_started")[0].at);
    let r = report(s, { project: P, now: start + 86400 });
    expect(r.met).toBe(false);
    expect(r.short).toEqual(["0 of 20 finishes", "0 of 3 no-PR or failed finishes", "0 of 5 crashes", "1.0 of 7 days"]);
    for (let i = 0; i < 20; i++)
      recordFinish(s, { member: { project: P, squad: SQ, role: "builder", suffix: `x${i}` }, unit: `x${i}`, outcome: i < 3 ? "no-pr" : "ok", body: "b", gen: `g${i}`, wt: `/w/x${i}` }, start + 10);
    for (let i = 0; i < 5; i++) s.fact("shadow_crash", [], { project: P, payload: { member: `${P}/${SQ}/builder-x${i}`, id: i, gen: `g${i}`, next: `h${i}` } });
    r = report(s, { project: P, now: start + 8 * 86400 });
    expect(r).toMatchObject({ finishes: 20, hard: 3, crashes: 5, met: true, short: [] });
    expect(reportText(r).at(-1)).toBe("exit: met");
  });

  test("a --since before the shadow's start counts from the start", () => {
    for (let i = 0; i < 3; i++)
      recordFinish(s, { member: { project: P, squad: SQ, role: "builder", suffix: `e${i}` }, unit: `e${i}`, outcome: "ok", body: "b", gen: `e${i}`, wt: `/w/e${i}` }, now - 30 * 86400);
    expect(report(s, { project: P, since: now - 40 * 86400, now }).short).toContain("the shadow has not run");
    step([]);
    const start = Number(events("shadow_started")[0].at);
    const r = report(s, { project: P, since: start - 40 * 86400, now: start + 86400 });
    expect(r).toMatchObject({ since: start, finishes: 0 });
    expect(r.days).toBeCloseTo(1, 5);
  });

  test("the CLI prints the report and records an explanation", () => {
    const b = member("builder", "u12-l");
    step(live(b)); finish(b, "ok");
    for (let i = 0; i < 6; i++) step(live(b));
    const [d] = disagreements();
    s.close();
    const env = { ...process.env, DS_STATE_ROOT: dir } as Record<string, string>;
    delete env.DS_MEMBER;
    const ds = (...a: string[]) => { const p = Bun.spawnSync(["bun", join(ROOT, "bin", "ds.ts"), "shadow", ...a], { env, stdout: "pipe", stderr: "pipe" }); return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }; };
    let r = ds("report", "--project", P);
    expect(r.rc).toBe(0);
    expect(r.out).toContain(`#${d.id} `);
    expect(r.out).toContain("exit: not met — 1 unexplained");
    r = ds("explain", String(d.id), "a", "known", "relay", "lag");
    expect(r.rc).toBe(0);
    r = ds("report", "--project", P, "--json");
    expect(JSON.parse(r.out).unexplained).toEqual([]);
    expect(ds("explain", String(d.id)).rc).toBe(2);
    expect(ds("report", "--since", "yesterday-ish").rc).toBe(2);
    s = open(dir); stores.push(s);
  });
});

