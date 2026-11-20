// override-cli.test.ts — U24: `ds override` lists the open overrides with their scope and clears one by id or by
// squad / role / project target, with an `override_cleared` event each; no match exits 2. Real `bin/ds` on a temp state root.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row } from "../../bin/loop/core/store.ts";

const DS = join(import.meta.dir, "../../bin/ds");
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "override-cli-")); roots.push(root);
  const state = join(root, "state"), s = open(state);
  const add = (member: string, scope: string, model: string) => Number(s.db.run("INSERT INTO overrides (member, scope, model, set_by, set_at) VALUES (?, ?, ?, 'board', 1)", [member, scope, model]).lastInsertRowid);
  const ids = { member: add("wt-1", "member", "sonnet"), squad: add("p/t", "squad", "sonnet"), role: add("p/builder", "role", "sonnet"), project: add("p", "project", "sonnet"), other: add("q", "project", "sonnet") };
  s.upsert("members", { project: "p", squad: "t", wt: "r::/work/ds-p-builder-t" }, { role: "builder", suffix: "", status: "running", observed_at: 1, updated_at: 1 });
  const wtPin = add("r::/work/ds-p-builder-t", "member", "sonnet");
  s.close();
  const ds = (...args: string[]) => { const o = Bun.spawnSync([DS, "override", ...args], { env: { ...process.env, DS_STATE_ROOT: state }, stdout: "pipe", stderr: "pipe" }); return { code: o.exitCode, out: o.stdout.toString(), err: o.stderr.toString() }; };
  const open_ = () => { const d = open(state); try { return (d.db.query("SELECT id FROM overrides WHERE cleared_at IS NULL ORDER BY id").all() as Row[]).map((r) => Number(r.id)); } finally { d.close(); } };
  const reasons = () => { const d = open(state); try { return (d.db.query("SELECT payload FROM events WHERE kind = 'override_cleared' ORDER BY id").all() as Row[]).map((r) => JSON.parse(String(r.payload))); } finally { d.close(); } };
  return { ids: { ...ids, wtPin }, ds, open_, reasons };
}

test("list shows each open override with its scope and target; --project narrows it", () => {
  const f = fixture();
  expect((JSON.parse(f.ds("list").out) as Row[]).map((r) => [r.scope, r.target])).toEqual([["member", "wt-1"], ["squad", "p/t"], ["role", "p/builder"], ["project", "p"], ["project", "q"], ["member", "r::/work/ds-p-builder-t"]]);
  // a member pin keyed by its worktree belongs to its project through the members table; an unknown member's belongs to none
  expect((JSON.parse(f.ds("--project", "p").out) as Row[]).map((r) => r.scope)).toEqual(["squad", "role", "project", "member"]);
});

test("clear by id, by squad, by role and by project drops only that one and records the event", () => {
  const f = fixture();
  expect(f.ds("clear", String(f.ids.member)).out).toContain(`#${f.ids.member} (member wt-1)`);
  expect(f.ds("clear", "--squad", "p/t").code).toBe(0);
  expect(f.ds("clear", "--role", "p/builder").code).toBe(0);
  expect(f.ds("clear", "--project", "p").code).toBe(0);
  expect(f.ds("clear", String(f.ids.wtPin)).code).toBe(0);
  expect(f.open_()).toEqual([f.ids.other]);
  expect(f.reasons().map((r) => r.scope)).toEqual(["member", "squad", "role", "project", "member"]);
  expect(f.reasons().at(-1)).toMatchObject({ override: f.ids.wtPin });
});

test("clear with nothing open or no target exits 2", () => {
  const f = fixture();
  expect(f.ds("clear", "--squad", "p/nosuch").code).toBe(2);
  expect(f.ds("clear").code).toBe(2);
  expect(f.ds("clear", "abc").code).toBe(2);
  expect(f.open_().length).toBe(6);
});
