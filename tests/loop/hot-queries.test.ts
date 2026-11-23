// hot-queries.test.ts — U242: the loop's per-member queries on events, orca_calls and episodes use an
// index. A statement that goes back to a full scan of one of them fails here. The statements are the
// code's own where the code exposes them (lock() is run with a spy on the db) and listed here otherwise.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "../../bin/loop/squad/member-state.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function fresh(): Store { const d = mkdtempSync(join(tmpdir(), "zzhotq-")); temps.push(d); const s = open(d); stores.push(s); return s; }

const GUARDED = ["events", "orca_calls", "episodes", "observed_prs", "requests"];
// Statements as the code runs them; `from` names the file that holds the text, checked below.
const HOT: { from: string; sql: string; args: unknown[]; probe?: string }[] = [
  { from: "bin/loop/reconcilers/members.ts", sql: "SELECT payload FROM events WHERE kind = 'member_rebound' AND project = ? AND squad = ? AND member = ? ORDER BY id", args: ["p", "s", "w"] },
  { from: "bin/loop/reconcilers/members.ts", sql: "SELECT 1 FROM events WHERE kind = ? AND project = ? AND squad = ? AND member = ? AND payload LIKE ?", args: ["member_rebound", "p", "s", "w", "%x%"] },
  { from: "bin/loop/reconcilers/members.ts", sql: "SELECT payload FROM events WHERE kind = ? AND project = ? AND squad = ? AND member = ? AND payload LIKE ? ORDER BY id", args: ["member_rebound", "p", "s", "w", "%x%"] },
  { from: "bin/loop/reconcilers/members.ts", sql: "SELECT key FROM orca_calls WHERE project = ? AND member = ? AND key LIKE 'rebind-fence:%' GROUP BY key\n    HAVING SUM(state = 'completed') = 0 ORDER BY MIN(id)", args: ["p", "w"] },
  { from: "bin/loop/fulfil/rebind.ts", sql: "SELECT 1 FROM events WHERE kind = 'member_rebound' AND member = ? AND payload LIKE ?", args: ["w", "%x%"] },
  // loop-tick-8s U1: the episodes, observed_prs and requests lookups of the tick (migration 0056).
  { from: "bin/loop/capacity/pick.ts", sql: "WHERE e.kind = ? AND e.state = 'reserved' AND e.ended_at > ?", args: ["fallback-reserve", 1], probe: "SELECT e.*, m.id AS mid FROM episodes e JOIN members m ON 'member:' || m.id = e.subject WHERE e.kind = ? AND e.state = 'reserved' AND e.ended_at > ?" },
  { from: "bin/loop/capacity/pick.ts", sql: "SELECT state, ended_at FROM episodes WHERE kind = 'account' AND ended_at > ?", args: [1] },
  { from: "bin/loop/observers/github.ts", sql: "SELECT * FROM episodes WHERE kind = ? AND ended_at IS NULL ORDER BY id", args: ["read-failing"] },
  { from: "bin/loop/observers/disk-usage.ts", sql: "SELECT 1 FROM episodes WHERE kind = ? AND ended_at IS NULL LIMIT 1", args: ["disk-pressure"] },
  { from: "bin/loop/reconcilers/lifecycle.ts", sql: "SELECT 1 FROM observed_prs WHERE project = ? AND repo = ? AND head = ? AND state = 'MERGED'", args: ["p", "r", "h"] },
  { from: "bin/loop/reconcilers/lifecycle.ts", sql: "SELECT MAX(pr) AS n FROM observed_prs WHERE project = ? AND repo = ? AND head = ? AND state = 'OPEN' AND gone_at IS NULL AND pr IS NOT ?", args: ["p", "r", "h", 1] },
  { from: "bin/loop/reconcilers/lifecycle.ts", sql: "SELECT 1 FROM requests WHERE project = ? AND squad = ? AND kind = 'finish-unit' AND done_at IS NOT NULL AND key LIKE ?", args: ["p", "s", "%x%"] },
];

function plan(s: Store, sql: string, args: unknown[]): string[] {
  return (s.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as { detail: string }[]).map((r) => r.detail);
}
const scans = (lines: string[]) => lines.filter((l) => GUARDED.some((t) => new RegExp(`^SCAN (TABLE )?${t}\\b(?! USING)`).test(l.trim())));

test("each hot statement is still in the code it is taken from", () => {
  for (const h of HOT) expect(readFileSync(join(ROOT, h.from), "utf8").replace(/\s+/g, " ")).toContain(h.sql.replace(/\s+/g, " "));
});

test("no hot statement scans events, orca_calls or episodes", () => {
  const s = fresh();
  for (const h of HOT) expect({ sql: h.sql, scans: scans(plan(s, h.probe ?? h.sql, h.args)) }).toEqual({ sql: h.sql, scans: [] });
});

test("the per-member events and fence lookups use the new indexes, not events_kind_at's whole kind", () => {
  const s = fresh();
  for (const h of HOT.slice(0, 3)) expect(plan(s, h.sql, h.args).join(" ")).toContain("events_kind_member");
  expect(plan(s, HOT[3].sql, HOT[3].args).join(" ")).toContain("orca_calls_member_key");
});

test("member-state lock() reads orca_calls and episodes through an index", () => {
  const s = fresh(), seen: string[] = [];
  const real = s.db.query.bind(s.db);
  (s.db as { query: unknown }).query = (sql: string) => { seen.push(sql); return real(sql); };
  lock(s, { id: 1, project: "p", squad: "s", role: "builder", suffix: "", wt: "w" });
  (s.db as { query: unknown }).query = real;
  expect(seen.length).toBeGreaterThanOrEqual(2);
  for (const sql of seen) {
    const lines = plan(s, sql, sql.split("?").slice(1).map(() => "x"));
    expect({ sql, scans: scans(lines) }).toEqual({ sql, scans: [] });
  }
});

test("the per-member lookups on members and units use their index", () => {
  const s = fresh();
  expect(plan(s, "SELECT MIN(since) AS s FROM members WHERE project = ? AND wt = ? AND since IS NOT NULL", ["p", "w"]).join(" ")).toContain("members_project_wt");
  expect(plan(s, "SELECT 1 FROM units WHERE project = ? AND squad = ? AND builder_wt = ? AND status = 'cancelled'", ["p", "s", "w"]).join(" ")).toMatch(/units_project_wt|sqlite_autoindex_units/);
});

test("the tick's episodes, observed_prs and requests lookups use their new index, never an automatic one", () => {
  const s = fresh();
  // The planner only prefers (project, repo, head) over observed_prs_repo once it has stats: many PRs per repo, one per head.
  for (let i = 0; i < 300; i++) s.db.query("INSERT INTO observed_prs (project, ref, pr, state, observed_at, repo, head) VALUES ('p', ?, ?, 'MERGED', 1, ?, ?)").run(`r#${i}`, i, `o/r${i % 2}`, `b${i}`);
  s.db.exec("ANALYZE observed_prs");
  const want: [number, string][] = [[5, "episodes_kind"], [6, "episodes_kind"], [7, "episodes_kind"], [8, "episodes_kind"], [9, "observed_prs_head"], [10, "observed_prs_head"], [11, "requests_squad_kind"]];
  for (const [i, idx] of want) {
    const h = HOT[i], lines = plan(s, h.probe ?? h.sql, h.args).join(" ");
    expect({ sql: h.sql, lines }).toEqual({ sql: h.sql, lines: expect.stringContaining(idx) });
    expect(lines).not.toContain("AUTOMATIC");
  }
});
