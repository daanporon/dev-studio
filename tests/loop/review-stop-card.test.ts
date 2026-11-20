// review-stop-card.test.ts — U199: a "Reviews stopped" card (kind review_stopped) leaves the board once
// its unit is done/cancelled, its squad closed, its worktree removed, or the stop lifted.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { alertGone, dropAlerts } from "../../bin/loop/reconcilers/alerts.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzrsc-")); temps.push(d); return d; };

function setup(status: string, count: number | null) {
  const wt = tmp();
  spawnSync("git", ["init", "-q", wt]);
  if (count !== null) writeFileSync(join(wt, ".git", "ds-review-stop"), `${count}\t1\tfp\terr\n`);
  const s = open(tmp());
  stores.push(s);
  s.db.run("INSERT INTO squads (project, topic, status, observed_at, updated_at) VALUES ('p', 'sq', 'running', ?, ?)", [T, T]);
  s.db.run("INSERT INTO units (project, squad, slug, status, builder_wt, plan_unit, observed_at, updated_at) VALUES ('p', 'sq', 'u1', ?, ?, 'U1', ?, ?)", [status, `id::${wt}`, T, T]);
  const card: Row = { id: "review-stopped:b1", asker: "sweep", kind: "review_stopped", squad: "sq", unit: "U1", slug: "u1", branch: "b1", wt, since: "2027-01-15T08:00:00Z" };
  return { s, wt, card };
}

test("a review_stopped card stays while its unit runs with a count-2 stop file", () => {
  const { s, card } = setup("dispatched", 2);
  expect(alertGone(s, "p", card, T)).toBe(false);
});
test("it goes when the unit is done or cancelled", () => {
  const d = setup("done", 2);
  expect(alertGone(d.s, "p", d.card, T)).toBe("the unit is done");
  const c = setup("cancelled", 2);
  expect(alertGone(c.s, "p", c.card, T)).toBe("the unit is cancelled");
});
test("it goes when its squad is closed", () => {
  const { s, card } = setup("dispatched", 2);
  s.db.run("UPDATE squads SET status = 'gone'");
  expect(alertGone(s, "p", card, T)).toBe("its squad is closed");
});
test("it goes when the worktree is removed", () => {
  const { s, wt, card } = setup("dispatched", 2);
  rmSync(wt, { recursive: true, force: true });
  expect(alertGone(s, "p", card, T)).toBe("the worktree is removed");
});
test("it goes when the stop file is missing or under 2", () => {
  const a = setup("dispatched", null);
  expect(alertGone(a.s, "p", a.card, T)).toBe("the stop was lifted");
  const b = setup("dispatched", 1);
  expect(alertGone(b.s, "p", b.card, T)).toBe("the stop was lifted");
});
test("an older card with only the id goes when no unit has the branch, and dropAlerts clears it", () => {
  const { s } = setup("done", 2);
  const old: Row = { id: "review-stopped:nobranch", asker: "sweep", since: "2027-01-15T08:00:00Z" };
  expect(alertGone(s, "p", old, T)).toBe("no unit has this branch");
  s.db.run("INSERT INTO observed_alerts (project, id, doc, observed_at) VALUES ('p', ?, ?, ?)", [String(old.id), JSON.stringify(old), T]);
  expect(dropAlerts({ store: s, project: "p", now: T } as TickCtx)).toEqual([expect.objectContaining({ payload: { id: old.id, why: "no unit has this branch" } })]);
});
