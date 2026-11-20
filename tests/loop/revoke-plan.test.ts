// revoke-plan.test.ts — hold-cancels-queue-undo-approval U2: `squad-state.sh revoke-plan` takes a plan
// approval back. The plan leaves approved_plans, its approved copy is moved aside, a queued Builder of
// its units goes in the same write, a started one waits on a dependency pause that approving the plan
// again releases (reconcilers/dependency-waits.ts); the Lead gets one message.
// Fixture squad `demo` (tests/fixtures/loop/state): every unit is on demo-loop-plan.md; u4 is ready once u2 is done.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import requests from "../../bin/loop/reconcilers/requests.ts";
import dependencyWaits from "../../bin/loop/reconcilers/dependency-waits.ts";
import { pause } from "../../bin/loop/pause/pause.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "loop", "state");
const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const W = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/";
const LEAD = `${W}ds-dev-studio-lead-demo`;
const U2 = "u2-sqlite-store-migrations-and", U4 = "u4-orca-state-file-config";
const DEMO_PLAN = "/state/fx/squads/demo-loop-plan.md";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  delete process.env.DS_NOW;
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function fixture(): Store {
  const root = mkdtempSync(join(tmpdir(), "zzloop-")); temps.push(root);
  cpSync(FIXTURE, root, { recursive: true });
  copyFileSync(join(ROOT, "tests", "fixtures", "loop", "accounts.tsv"), join(root, "accounts.tsv"));
  const conv = mkdtempSync(join(tmpdir(), "zzconv-")); temps.push(conv);
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  const s = open(root); stores.push(s);
  importJson(s);
  const row = s.get("squads", { project: "fx", topic: "demo" })!;
  const doc = JSON.parse(String(row.doc ?? "{}"));
  s.upsert("squads", { project: "fx", topic: "demo" }, { doc: JSON.stringify({ ...doc, approved_plans: [DEMO_PLAN] }) });
  importConfig(s, root, conv);
  s.upsert("observed_workers", { project: "fx", wt: LEAD }, { state: "idle", observed_at: T });
  s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
  writeFileSync(join(root, ".loop-migrated"), "test\n");
  return s;
}
const fulfillers = await load<Fulfiller>(DIRS.fulfil);
async function queuedWish(s: Store) {
  s.upsert("config", { project: "fx", file: "limits.conf", key: "max_builders" }, { value: "1", observed_at: T });
  s.upsert("members", { project: "fx", squad: "demo", role: "builder", suffix: "older" }, { wt: `${W}older`, status: "running", want: "stopped", observed_at: T, updated_at: T });
  const act = new LoopActuator({ orca: new FakeOrca(), fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [picker, ready, requests, ...fulfillers] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  process.env.DS_NOW = String(T);
  await loop.tick(T); await act.drain();
  expect(builders(s, U4)[0]).toMatchObject({ want: "running", status: "wanted", want_by: "loop" });
}
// u4 started: dispatched, its Builder running in a worktree.
function started(s: Store) {
  s.db.run("UPDATE units SET status = 'dispatched' WHERE slug = ?", [U4]);
  s.upsert("members", { project: "fx", squad: "demo", role: "builder", suffix: U4 },
    { wt: `${W}ds-fx-builder-${U4}-demo`, status: "running", want: "running", want_by: "loop", started: T - 600, observed_at: T, updated_at: T });
}
const env = () => {
  const e: Record<string, string | undefined> = { ...process.env };
  delete e.CLAUDE_PROJECT_DIR; delete e.ORCA_TERMINAL_HANDLE; delete e.DS_WHO;
  return e;
};
function sh(s: Store, ...args: string[]): { out: string; err: string; code: number } {
  exportJson(s);
  const r = Bun.spawnSync([join(ROOT, "bin", "role", "squad-state.sh"), join(s.root, "fx", "squads", "demo.json"), ...args], { env: { ...env(), DS_STATE_ROOT: s.root } });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? -1 };
}
const builders = (s: Store, suffix: string) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = 'demo' AND role = 'builder' AND suffix = ? ORDER BY id").all(suffix) as Row[];
const doc = (s: Store) => JSON.parse(String(s.get("squads", { project: "fx", topic: "demo" })!.doc ?? "{}"));
const intents = (s: Store, suffix = U4) => s.db.query("SELECT * FROM pause_intents WHERE project = 'fx' AND squad = 'demo' AND suffix = ? AND cleared_at IS NULL ORDER BY source").all(suffix) as Row[];
const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
const leadMail = (s: Store) => s.db.query("SELECT * FROM messages WHERE project = 'fx' AND squad = 'demo' AND to_role = 'lead'").all() as Row[];
const reconcile = (s: Store, at: number) => dependencyWaits.run({ store: s, project: "fx", now: at } as never);

describe("squad-state revoke-plan", () => {
  test("drops the approval and the plan's queued Builder in one write; the Lead hears of it", async () => {
    const s = fixture();
    await queuedWish(s);
    const r = sh(s, "revoke-plan", DEMO_PLAN, "--why", "approved by mistake");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`revoked: ${DEMO_PLAN}`);
    expect(r.out).toContain(`${U4}: dropped`);
    expect(doc(s).approved_plans ?? []).not.toContain(DEMO_PLAN);
    expect(doc(s).revoked_plans).toEqual([{ plan: DEMO_PLAN, why: "approved by mistake", at: expect.any(String), by: "operator" }]);
    expect(builders(s, U4)[0]).toMatchObject({ want: "gone", status: "gone", want_by: "revoke-plan" });
    const gone = events(s, "builder_wish_withdrawn");
    expect(gone.length).toBeGreaterThan(0);   // every queued wish of the plan's units, u4's among them
    expect(gone.every((e) => e.why === "plan not approved" && e.by === "revoke-plan" && e.reason === "approved by mistake")).toBe(true);
    expect(gone.map((e) => e.unit)).toContain(U4);
    expect(events(s, "plan_revoked")).toEqual([expect.objectContaining({ plan: DEMO_PLAN, dropped: gone.map((e) => e.unit), paused: [] })]);
    const mail = leadMail(s);
    expect(mail).toHaveLength(1);
    expect(String(mail[0].subject)).toContain("demo-loop-plan.md");
    expect(String(mail[0].body)).toContain("approved by mistake");
    expect(String(mail[0].body)).toContain(`${U4}: dropped`);
  });

  test("a started Builder is paused on the plan; approving it again releases the wait, a manual pause stays", () => {
    const s = fixture();
    started(s);
    const r = sh(s, "revoke-plan", DEMO_PLAN, "--why", "wrong plan");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${U4}: paused`);
    const [dep] = intents(s);
    expect(dep).toMatchObject({ source: "dependency", scope: "member", role: "builder" });
    expect(JSON.parse(String(dep.prerequisites))).toEqual([{ kind: "plan", project: "fx", squad: "demo", plan: DEMO_PLAN }]);
    expect(builders(s, U4)[0]).toMatchObject({ want: "running", status: "running" });   // work and worktree kept
    reconcile(s, T + 1);
    expect(intents(s)).toHaveLength(1);   // still not approved: the wait holds
    pause(s, { scope: "member", project: "fx", squad: "demo", role: "builder", suffix: U4 }, { source: "manual", by: "operator" }, T + 2);
    expect(sh(s, "approve-plan", DEMO_PLAN).code).toBe(0);
    reconcile(s, T + 3);
    expect(intents(s).map((i) => i.source)).toEqual(["manual"]);
  });

  test("a wait-on pause takes the plan as one more prerequisite and keeps it until approval", () => {
    const s = fixture();
    started(s);
    s.db.run("UPDATE units SET status = 'planned' WHERE slug = ?", [U2]);
    s.db.run("UPDATE units SET deps = ? WHERE slug = ?", [JSON.stringify([U2]), U4]);
    reconcile(s, T);
    expect(intents(s)[0]).toMatchObject({ requested_by: "wait-on" });
    expect(sh(s, "revoke-plan", DEMO_PLAN, "--why", "x").out).toContain(`${U4}: paused`);
    const refs = () => JSON.parse(String(intents(s)[0].prerequisites)).map((p: { kind: string }) => p.kind);
    expect(refs()).toEqual(["unit", "plan"]);
    s.db.run("UPDATE units SET status = 'done' WHERE slug = ?", [U2]);
    reconcile(s, T + 1);
    expect(refs()).toEqual(["plan"]);
    expect(sh(s, "approve-plan", DEMO_PLAN).code).toBe(0);
    reconcile(s, T + 2);
    expect(intents(s)).toEqual([]);
  });

  test("--keep-started leaves a started Builder running and unpaused", () => {
    const s = fixture();
    started(s);
    const r = sh(s, "revoke-plan", DEMO_PLAN, "--why", "x", "--keep-started");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${U4}: left — Builder ${U4} keeps working (--keep-started)`);
    expect(intents(s)).toEqual([]);
  });

  test("a plan not approved is a no-op, so a second revoke changes nothing; --why is required", () => {
    const s = fixture();
    expect(sh(s, "revoke-plan", DEMO_PLAN).code).toBe(2);
    expect(sh(s, "revoke-plan", DEMO_PLAN, "--why", " ").code).toBe(2);
    expect(sh(s, "revoke-plan", DEMO_PLAN, "--why", "first").code).toBe(0);
    const again = sh(s, "revoke-plan", DEMO_PLAN, "--why", "second");
    expect(again.code).toBe(0);
    expect(again.out).toBe(`not approved: ${DEMO_PLAN} — nothing to revoke\n`);
    expect(doc(s).revoked_plans).toHaveLength(1);
    expect(events(s, "plan_revoked")).toHaveLength(1);
    expect(leadMail(s)).toHaveLength(1);
  });

  test("the approved copy is moved aside, never deleted", () => {
    const s = fixture();
    const plan = join(s.root, "fx", "squads", "demo-loop-plan.md");
    writeFileSync(plan, "# plan\n");
    expect(sh(s, "approve-plan", plan).code).toBe(0);
    const copy = plan.replace(/\.md$/, ".approved.md");
    expect(existsSync(copy)).toBe(true);
    const r = sh(s, "revoke-plan", plan, "--why", "x");
    expect(r.code).toBe(0);
    expect(existsSync(copy)).toBe(false);
    const kept = readdirSync(join(s.root, "fx", "squads")).filter((f) => /^demo-loop-plan\.revoked-\d{8}-\d{6}\.md$/.test(f));
    expect(kept).toHaveLength(1);
    expect(r.out).toContain(`approved copy moved to ${kept[0]}`);
  });
});
