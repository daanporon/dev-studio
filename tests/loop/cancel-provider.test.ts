// cancel-provider.test.ts — orca-backend-alternatives U16e: a cancelled Builder of a squad off Orca
// (`local::<path>`) goes by its provider's `worktrees` row (bin/loop/squad/cancel.ts). A returned
// treehouse slot keeps its folder, so the row, not the folder or the contract observer's
// `observed_worktrees` row, says whether the tree is still there; and once the slot is leased to
// another member the cancel leaves that member, its terminals and its slot alone. No treehouse needed.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { cancellationActions, cancellationReality } from "../../bin/loop/squad/cancel.ts";

const roots: string[] = [], stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

const P = "p", SQ = "sq";
function rig() {
  const root = mkdtempSync(join(tmpdir(), "cancel-provider-")); roots.push(root);
  const slot = join(root, "pool", "1", "repo"); mkdirSync(slot, { recursive: true });
  const s = open(join(root, "state")); stores.push(s);
  const wt = `local::${slot}`;
  s.upsert("members", { project: P, squad: SQ, wt }, { role: "builder", suffix: "u1", status: "running", observed_at: 1, updated_at: 1 });
  s.upsert("units", { project: P, squad: SQ, slug: "u1" }, { status: "cancelled", builder_wt: wt, observed_at: 1, updated_at: 1 });
  const tree = (set: Record<string, unknown>) => s.upsert("worktrees", { host: "local", path: slot },
    { project: P, squad: SQ, role: "builder", name: `ds-${P}-builder-u1-${SQ}`, provider: "treehouse", created_at: 10, gone_at: null, ...set });
  const unit = () => s.get("units", { project: P, squad: SQ, slug: "u1" })!;
  const member = () => s.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ?").get(P, SQ, wt) as Record<string, unknown>;
  const tick = (now = 100) => cancellationActions({ store: s, project: P, now } as unknown as TickCtx).map((a) => a.kind);
  return { s, slot, wt, tree, unit, member, tick };
}

test("a provider's row decides presence: gone over an existing folder is not present, live is", () => {
  const r = rig();
  r.tree({ gone_at: 20 });
  expect(cancellationReality(r.s, P, r.wt, r.unit())).toMatchObject({ present: false, live: false, reused: false });
  r.tree({ gone_at: null });
  expect(cancellationReality(r.s, P, r.wt, r.unit())).toMatchObject({ present: true, reused: false });
  r.tree({ provider: "git", gone_at: 20 });
  expect(cancellationReality(r.s, P, r.wt, r.unit())).toMatchObject({ present: false });
});

test("the contract observer's row (never gone while the folder exists) does not hide a returned slot", () => {
  const r = rig();
  r.s.upsert("observed_worktrees", { project: P, wt: r.wt }, { path: r.slot, observed_at: 50, gone_at: null, doc: JSON.stringify({ agents: 1 }) });
  r.tree({ gone_at: null });
  expect(cancellationReality(r.s, P, r.wt, r.unit())).toMatchObject({ present: true, live: true });
  // The slot went back to the pool: the observer still reads the folder, the row reads gone.
  r.tree({ gone_at: 60 });
  expect(cancellationReality(r.s, P, r.wt, r.unit())).toMatchObject({ present: false, live: false });
  expect(r.tick()).toEqual([]);
  expect(r.member()).toMatchObject({ status: "gone", want: "gone", want_result: "done: cancelled Builder removed" });
});

test("a tree with no provider row still goes by Orca's row and the folder", () => {
  const r = rig();
  const wt = `repo::${r.slot}`;
  r.s.upsert("observed_worktrees", { project: P, wt }, { path: r.slot, observed_at: 50, gone_at: 60 });
  expect(cancellationReality(r.s, P, wt)).toMatchObject({ present: true, reused: false });
});

test("a slot leased again to a member of another squad: no stop, no remove, the cancelled Builder's wish ends", () => {
  const r = rig();
  // The slot was returned and leased to squad other's Builder: the row names its worktree now.
  r.tree({ squad: "other", name: `ds-${P}-builder-x-other`, created_at: 200 });
  r.s.upsert("observed_terminals", { project: P, handle: "term_new" }, { wt: r.wt, observed_at: 210, gone_at: null });
  r.s.upsert("observed_workers", { project: P, wt: r.wt }, { state: "working", observed_at: 210, gone_at: null });
  expect(cancellationReality(r.s, P, r.wt, r.unit())).toMatchObject({ present: false, live: false, reused: true });
  expect(r.tick(220)).toEqual([]);
  expect(r.member()).toMatchObject({ status: "gone", want_result: "done: cancelled Builder removed" });
  expect(r.tick(230)).toEqual([]);
});

test("a slot leased again in the same squad under another name is not the cancelled Builder's either", () => {
  const r = rig();
  r.tree({ name: `ds-${P}-tester-${SQ}`, role: "tester", created_at: 200 });
  r.s.upsert("observed_terminals", { project: P, handle: "term_new" }, { wt: r.wt, observed_at: 210, gone_at: null });
  expect(r.tick(220)).toEqual([]);
  // Without the unit (an old caller) the reality is today's: the terminal reads live.
  expect(cancellationReality(r.s, P, r.wt)).toMatchObject({ live: true, reused: false });
});

test("the cancelled Builder's own live slot is stopped, then removed", () => {
  const r = rig();
  r.tree({ gone_at: null });
  r.s.upsert("observed_terminals", { project: P, handle: "term_b" }, { wt: r.wt, observed_at: 50, gone_at: null });
  expect(r.tick()).toEqual(["cancel.stop"]);
  expect(r.member()).toMatchObject({ want: "gone" });
  r.s.upsert("observed_terminals", { project: P, handle: "term_b" }, { gone_at: 60 });
  expect(r.tick()).toEqual(["cancel.remove"]);
});
