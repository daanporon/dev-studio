// refusal-card.test.ts — U9: a "Loop action refused" card for a one-off request (subject req:<id>) clears when
// its squad is done or closed, or the unit it names is done, and its refusals row ends with it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { alertGone } from "../../bin/loop/reconcilers/alerts.ts";

const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function setup(squad: string, unit: string, kind = "finish-unit") {
  const d = mkdtempSync(join(tmpdir(), "zzrfc-")); temps.push(d);
  const s = open(d); stores.push(s);
  s.db.run("INSERT INTO squads (project, topic, status, observed_at, updated_at) VALUES ('p', 'sq', ?, ?, ?)", [squad, T, T]);
  s.db.run("INSERT INTO units (project, squad, slug, status, plan_unit, observed_at, updated_at) VALUES ('p', 'sq', 'u1', ?, 'U1', ?, ?)", [unit, T, T]);
  const id = Number(s.db.run("INSERT INTO requests (project, squad, kind, key, payload, requested_by, created_at, done_at) VALUES ('p', 'sq', ?, ?, '{}', 'finish-unit', 1, 2)",
    [kind, `${kind}:p/sq/u1@abc`]).lastInsertRowid);
  const subject = `req:${id}`;
  s.db.run("INSERT INTO refusals (project, subject, fingerprint, kind, class, text, first_at, last_at, count) VALUES ('p', ?, 'fp', ?, 'permanent', 'not on a branch', ?, ?, 1)", [subject, kind, T, T]);
  const card: Row = { id: "refusal.x", asker: "sweep", kind: "loop_refusal", subject, fingerprint: "fp", squad: "sq" };
  return { s, card, subject, id };
}
const stands = (s: Store, subject: string) => !!s.db.query("SELECT 1 FROM refusals WHERE project = 'p' AND subject = ?").get(subject);

test("a req: refusal card stays while its squad runs and its unit is open", () => {
  const { s, card, subject } = setup("running", "dispatched");
  expect(alertGone(s, "p", card, T)).toBe(false);
  expect(stands(s, subject)).toBe(true);
});
test.each(["done", "closed", "gone"])("it clears when its squad is %s, and its refusals row ends", (st) => {
  const { s, card, subject } = setup(st, "dispatched");
  expect(alertGone(s, "p", card, T)).toBe("its squad is done or closed");
  expect(stands(s, subject)).toBe(false);
});
test("it clears when its squad is gone from the table", () => {
  const { s, card } = setup("running", "dispatched");
  s.db.run("DELETE FROM squads");
  expect(alertGone(s, "p", card, T)).toBe("its squad is done or closed");
});
test("it clears when the unit its finish-unit names is done", () => {
  const { s, card, subject } = setup("running", "done");
  expect(alertGone(s, "p", card, T)).toBe("its unit is done");
  expect(stands(s, subject)).toBe(false);
});
test("a non-req: refusal keeps today's rule: stays while its row stands", () => {
  const { s, card } = setup("done", "done");
  s.db.run("UPDATE refusals SET subject = 'start:sq'");
  expect(alertGone(s, "p", { ...card, subject: "start:sq" }, T)).toBe(false);
  s.db.run("DELETE FROM refusals");
  expect(alertGone(s, "p", { ...card, subject: "start:sq" }, T)).toBe("the refusal no longer stands");
});
