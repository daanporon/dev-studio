// fulfil-plan-revoke.test.ts — hold-cancels-queue-undo-approval U3: the `plan-revoke` fulfiller behind the board's
// "Take back approval". A copy of tests/fixtures/loop/state whose squad fx/demo has demo-plan.md approved.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function imported(approve = true): Store {
  const d = mkdtempSync(join(tmpdir(), "zzpr-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const file = join(d, "fx", "squads", "demo.json"), doc = JSON.parse(readFileSync(file, "utf8"));
  const plan = join(d, "fx", "squads", "demo-plan.md");
  doc.approved_plans = approve ? [plan] : [];
  writeFileSync(file, JSON.stringify(doc));
  writeFileSync(plan + "", "# plan\n");
  if (approve) writeFileSync(join(d, "fx", "squads", "demo-plan.approved.md"), "# plan\n");
  const s = open(d);
  stores.push(s);
  importJson(s);
  writeFileSync(join(d, ".loop-migrated"), "test\n"); // squad-state now writes the store, as on a loop root
  return s;
}
const fulfillers = (await load<Fulfiller & Reconciler>(DIRS.fulfil)).filter((f) => f.kinds) as Fulfiller[];
async function run(s: Store, payload: unknown): Promise<Row> {
  const id = Number(s.requestAny("plan-revoke", payload, { project: "fx", squad: "demo", by: "board" }).row.id);
  const act = new LoopActuator({ orca: new FakeOrca(), fulfillers });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers as unknown as Reconciler[] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  await loop.tick(T); await act.drain();
  const r = s.db.query("SELECT done_at, result FROM requests WHERE id = ?").get(id) as Row;
  return { done: r.done_at != null, ...(r.result ? JSON.parse(String(r.result)) : {}) };
}
// The store is the truth (the squad file is not rewritten): read the doc through squad-state itself.
const doc = (s: Store) => JSON.parse(Bun.spawnSync([join(ROOT, "bin", "role", "squad-state.sh"), join(s.root, "fx", "squads", "demo.json"), "get"], { env: { ...process.env, DS_STATE_ROOT: s.root } }).stdout.toString());

describe("plan-revoke", () => {
  test("runs revoke-plan: the approval goes, the reason carries (board), the approved copy moves aside", async () => {
    const s = imported();
    const r = await run(s, { plan: "demo-plan.md", why: "misread ok" });
    expect(r).toMatchObject({ done: true, ok: true, plan: "demo-plan.md" });
    expect(String(r.lines[0])).toContain("revoked:");
    const d = doc(s);
    expect(d.approved_plans ?? []).toEqual([]);
    expect(d.revoked_plans[0].why).toBe("misread ok (board)");
    expect(existsSync(join(s.root, "fx", "squads", "demo-plan.approved.md"))).toBe(false);
    expect(readdirSync(join(s.root, "fx", "squads")).some((f) => f.startsWith("demo-plan.revoked-"))).toBe(true);
  });

  test("a plan that is no longer approved finishes as a no-op line", async () => {
    const s = imported(false);
    const r = await run(s, { plan: "demo-plan.md", why: "x" });
    expect(r).toMatchObject({ done: true, ok: true });
    expect(String(r.lines[0])).toContain("not approved");
  });

  test("a name that is not a plan file of the squad fails and changes nothing", async () => {
    const s = imported();
    expect(await run(s, { plan: "../demo-plan.md", why: "x" })).toMatchObject({ done: true, ok: false });
    expect(await run(s, { plan: "demo.json", why: "x" })).toMatchObject({ done: true, ok: false });
    expect(doc(s).approved_plans.length).toBe(1);
  });

  test("an empty reason fails", async () => {
    const s = imported();
    expect(await run(s, { plan: "demo-plan.md", why: "  " })).toMatchObject({ done: true, ok: false });
    expect(doc(s).approved_plans.length).toBe(1);
  });
});
