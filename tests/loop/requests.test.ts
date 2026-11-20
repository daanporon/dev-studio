// requests.test.ts — U12: `ds request <role>` through the loop. The request is a member wish; the pick
// reconciler (U9) picks it through the ladder, the member fulfiller (U11) starts it on the fake Orca
// with add-role.sh's worktree name and prompt, and reconcilers/requests.ts tells the Lead. Works on a
// copy of tests/fixtures/loop/state with tests/fixtures/loop/accounts.tsv (acct-a/b/c resetting in
// 1 h, 2 h, 4 h) and a copy of conventions/.
import { beforeAll, afterAll, afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { since } from "../../bin/loop/core/events.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import picker from "../../bin/loop/core/decide.ts";
import requests from "../../bin/loop/reconcilers/requests.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

// U150: a transient refusal is tried again every 15 minutes (DS_LOOP_RETRY_S); these tests step
// a retry one tick at a time. The spacing itself is tested in actuator.test.ts ("refusals").
beforeAll(() => { process.env.DS_LOOP_RETRY_S = "1"; });
afterAll(() => { delete process.env.DS_LOOP_RETRY_S; });

const ROOT = join(import.meta.dir, "..", "..");
const DS = join(ROOT, "bin", "ds");
const T = 1_800_000_000;
const LEAD = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-lead-demo";
const U3 = "u3-loop-daemon-skeleton-health";
const ENV = ["DS_LIMIT_PICK_FLOOR_BUILDER", "DS_LOOP_SEND_TRIES"];

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  for (const e of ENV) delete process.env[e];
});
function fixture(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzloop-")), conv = mkdtempSync(join(tmpdir(), "zzconv-"));
  temps.push(d, conv);
  cpSync(join(ROOT, "tests", "fixtures", "loop", "state"), d, { recursive: true });
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(d, "accounts.tsv"));
  const s = open(d);
  stores.push(s);
  importJson(s);
  importConfig(s, d, conv);
  s.upsert("observed_workers", { project: "fx", wt: LEAD }, { state: "idle", observed_at: T });
  return s;
}

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
// The production order: the reconcilers (pick, requests), then the fulfillers; U9's ladder picks.
function rig(s: Store) {
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [picker, requests, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { const r = await loop.tick(at); await act.drain(); return r; };
  return { orca, tick };
}
function dsAt(s: Store, at: number, ...args: string[]) {
  const p = Bun.spawnSync([DS, "--state", s.root, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DS_NOW: String(at) } });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString() };
}
const ds = (s: Store, ...args: string[]) => dsAt(s, T, ...args);
const requestAt = (s: Store, at: number, ...args: string[]) => {
  const r = dsAt(s, at, "request", ...args, "--squad", "fx/demo");
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as Row & { pick: Row | null };
};
const request = (s: Store, ...args: string[]) => requestAt(s, T, ...args);
const row = (s: Store, id: unknown) => s.db.query("SELECT * FROM members WHERE id = ?").get(Number(id)) as Row;
const unit = (s: Store, slug: string) => s.get("units", { project: "fx", squad: "demo", slug })!;
const acct = (s: Store, account: string, set: Row) => s.upsert("observed_accounts", { agent: "claude", account }, set);
const leadPokes = (o: FakeOrca) => o.of("poke").filter((c) => c.args[0] === LEAD).map((c) => String(c.args[1]));

describe("ds request", () => {
  test("request -> pick -> start with add-role's worktree and prompt; the Lead is told once", async () => {
    const s = fixture(), { orca, tick } = rig(s);
    const r = request(s, "builder", "--unit", "U3");
    expect(r).toMatchObject({ role: "builder", suffix: U3, want: "running", status: "wanted", phase: "build", changed: true });
    expect(r.want_payload).toEqual({ why: "start", request: true, unit: U3 });

    await tick(T);
    const start = orca.of("role-start");
    expect(start.length).toBe(1);
    expect(start[0].args[6]).toBe(`ds-fx-builder-${U3}-demo`);
    expect(String(start[0].args[3])).toContain("Work the assigned unit of squad demo as the builder");
    expect(String(start[0].args[3])).toContain("Do not send heartbeats");
    expect(String(start[0].args[3])).toContain("/bin/role/notes.sh fx builder print");
    // The ladder: the unit's tier (hard), fill-first on acct-a (resets soonest).
    const m = row(s, r.id);
    expect(m).toMatchObject({ status: "running", wt: `fakerepo::/wt/ds-fx-builder-${U3}-demo`, agent: "claude", account: "acct-a", want_result: "fresh" });
    expect(start[0].args[5]).toBe(m.model);
    expect(unit(s, U3)).toMatchObject({ status: "dispatched", builder_wt: m.wt, wait_until: null });
    expect(JSON.parse(String(m.doc)).owns).toEqual([U3]);

    await tick(T + 1);
    await tick(T + 600);
    const told = leadPokes(orca);
    expect(told.length).toBe(1);
    expect(told[0]).toContain(`builder ${U3} you requested has started`);
    expect(told[0]).toContain("acct-a");
  });

  test("below the floor the member stays idle without a unit deadline and starts on the first tick with room", async () => {
    const s = fixture(), { orca, tick } = rig(s);
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "claude:sonnet";
    for (const a of ["acct-a", "acct-b", "acct-c"]) acct(s, a, { weekly_pct: "99" });
    const r = request(s, "builder", "--unit", U3);

    await tick(T);
    expect(orca.of("role-start").length).toBe(0);
    expect(row(s, r.id).status).not.toBe("waiting");
    expect(s.get("picks", { member: r.id })).toMatchObject({ slot: 0, reason: "no account free", wait_until: expect.any(Number) });   // U1: shown on the board, never a deadline
    expect(unit(s, U3)).toMatchObject({ status: "planned", wait_until: null });
    const shown = request(s, "builder", "--unit", U3, "--wait", "0");
    expect(shown).toMatchObject({ status: "wanted", changed: false, pick: { slot: 0, reason: "no account free" } });

    await tick(T + 30);
    expect(orca.of("role-start").length).toBe(0);
    acct(s, "acct-b", { weekly_pct: "30" });                // acct-b resets, long before the wait time
    await tick(T + 60);
    expect(orca.of("role-start").length).toBe(1);
    expect(row(s, r.id)).toMatchObject({ status: "running", account: "acct-b" });
    expect(unit(s, U3)).toMatchObject({ status: "dispatched", wait_until: null });
  });

  test("two idle unfinished requests keep their identities through a squad-state write", async () => {
    const s = fixture(), { orca, tick } = rig(s);
    writeFileSync(join(s.root, ".loop-migrated"), "");
    process.env.DS_LIMIT_PICK_FLOOR_BUILDER = "claude:sonnet";
    for (const a of ["acct-a", "acct-b", "acct-c"]) acct(s, a, { weekly_pct: "99" });
    const a = request(s, "builder", "--unit", "U3"), b = request(s, "builder", "--unit", "U4");
    await tick(T);
    expect([row(s, a.id).status, row(s, b.id).status]).toEqual(["wanted", "wanted"]);

    const file = join(s.root, "fx", "squads", "demo.json");
    const ss = Bun.spawnSync([join(ROOT, "bin", "role", "squad-state.sh"), file, "set-unit-pr", "u1-spike-loop-as-coordinator", "900"],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, DS_STATE_ROOT: s.root, BACKEND: "true" } });
    expect(ss.exitCode).toBe(0);
    expect([row(s, a.id).suffix, row(s, b.id).suffix]).toEqual([U3, "u4-orca-state-file-config"]);
    expect((JSON.parse(readFileSync(file, "utf8")).members as Row[]).filter((m) => m.wt == null)).toEqual([]);

    acct(s, "acct-b", { weekly_pct: "30" });
    await tick(T + 60);
    expect(orca.of("role-start").map((c) => c.args[6]).sort()).toEqual([`ds-fx-builder-${U3}-demo`, "ds-fx-builder-u4-orca-state-file-config-demo"]);
  });

  test("an override on the member wins over the ladder", async () => {
    const s = fixture(), { orca, tick } = rig(s);
    const r = request(s, "builder", "--unit", U3);
    s.db.run("INSERT INTO overrides (member, model, account, scope, set_by, set_at) VALUES (?, 'sonnet', 'acct-c', 'member', 'operator', ?)", [String(r.id), T]);
    await tick(T);
    expect(row(s, r.id)).toMatchObject({ status: "running", model: "sonnet", account: "acct-c" });
    expect(orca.of("role-start")[0].args.slice(5, 6)).toEqual(["sonnet"]);
  });

  test("a second identical request is a no-op: one wish, one start", async () => {
    const s = fixture(), { orca, tick } = rig(s);
    const a = request(s, "reviewer", "--suffix", "r1", "--tier", "hard");
    const b = request(s, "reviewer", "--suffix", "r1", "--tier", "hard");
    expect([a.id, a.changed, b.id, b.changed]).toEqual([a.id, true, a.id, false]);
    await tick(T);
    const c = request(s, "reviewer", "--suffix", "r1", "--spec", "something else");
    expect(c).toMatchObject({ id: a.id, changed: false, status: "running" });
    await tick(T + 1);
    expect(orca.of("role-start").length).toBe(1);
    expect(since(s, 0, { kinds: ["want"] }).length).toBe(1);
    expect(row(s, a.id).tier).toBe("hard");
  });

  test("a start that fails is told to the Lead once, and asking again starts it afresh", async () => {
    const s = fixture(), { orca, tick } = rig(s);
    process.env.DS_LOOP_SEND_TRIES = "1";
    orca.fail("role-start", { code: 1, out: "", err: "boom" });
    const r = request(s, "builder", "--unit", U3);
    await tick(T);
    expect(row(s, r.id).want_result).toStartWith("failed: ");
    await tick(T + 1);
    await tick(T + 2);
    const told = leadPokes(orca);
    expect(told.length).toBe(1);
    expect(told[0]).toContain(`builder ${U3} you requested could not be started`);

    // A start that waited before it failed leaves status waiting; asking again resets it, so --wait follows the new try.
    s.db.run("UPDATE members SET status = 'waiting' WHERE id = ?", [Number(r.id)]);
    s.upsert("picks", { member: r.id }, { project: "fx", squad: "demo", role: "builder", slot: 0, reason: "no account free", picked_at: T + 100 });
    const waiting = dsAt(s, T + 100, "request", "builder", "--unit", U3, "--squad", "fx/demo", "--wait", "0");
    expect(waiting.code).toBe(1); // The prior wish's pick cannot finish this new --wait.
    expect(waiting.err).toBe("");
    const again = JSON.parse(waiting.out);
    expect(again).toMatchObject({ id: r.id, changed: true, want_result: null, status: "wanted" });
    await tick(T + 100);
    expect(orca.of("role-start").length).toBe(2);
    expect(row(s, r.id)).toMatchObject({ status: "running", want_result: "fresh" });
    await tick(T + 101);
    expect(leadPokes(orca).slice(1).map((p) => p.includes("has started"))).toEqual([true]);
  });

  test("a unit the squad does not have is refused, and nothing is written", () => {
    const s = fixture();
    const r = ds(s, "request", "builder", "--unit", "U99", "--squad", "fx/demo");
    expect(r.code).toBe(2);
    expect(r.err).toContain("no unit 'U99' in squad fx/demo");
    expect(s.db.query("SELECT count(*) AS n FROM members WHERE role = 'builder' AND suffix = 'U99'").get()).toEqual({ n: 0 });
    expect(s.get("units", { project: "fx", squad: "demo", slug: "U99" })).toBeNull();
  });

  test("an unknown role is refused: the CLI writes nothing; a wish from elsewhere is rejected with an event and a Lead poke", async () => {
    const s = fixture(), { orca, tick } = rig(s);
    for (const role of ["designer", "lead"]) {
      const r = ds(s, "request", role, "--suffix", "x", "--squad", "fx/demo");
      expect(r.code).toBe(2);
      expect(r.err).toContain(role === "lead" ? "exactly one Lead" : "unknown role 'designer'");
    }
    expect(s.db.query("SELECT count(*) AS n FROM members WHERE role IN ('designer', 'lead') AND suffix = 'x'").get()).toEqual({ n: 0 });

    const { row: w } = s.want("member", "fx/demo/designer/x", "running", { payload: { why: "start", request: true }, by: "lead" });
    await tick(T);
    await tick(T + 1);
    expect(orca.of("role-start").length).toBe(0);
    expect(row(s, w.id).want_result).toBe("rejected: unknown role 'designer' (one of builder, thinker, reviewer, tester, researcher)");
    expect(since(s, 0, { kinds: ["request_rejected"] }).map((e) => JSON.parse(String(e.payload)).role)).toEqual(["designer"]);
    const told = leadPokes(orca);
    expect(told.length).toBe(1);
    expect(told[0]).toContain("your request for a designer x was not started");
  });

  test("--help prints the usage roles/lead.md quotes", () => {
    const s = fixture();
    const r = ds(s, "request", "--help");
    expect(r.code).toBe(0);
    const usage = r.out.replace(/^usage: /, "").split(" — ")[0];
    expect(usage).toStartWith("ds request <role> [--unit <slug>]");
    expect(readFileSync(join(ROOT, "roles", "lead.md"), "utf8")).toContain(usage);
  });
});
