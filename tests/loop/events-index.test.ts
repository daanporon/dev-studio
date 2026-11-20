// events-index.test.ts — event-log-filters U2: migration 0047's events_squad serves the event log's
// squad and crew pages, and takes nothing from the loop's own lookups.
// The plans are read through EXPLAIN QUERY PLAN on eventsQuery's SQL, twice: on a seeded db after
// ANALYZE, and with the live db's sqlite_stat1 (measured on a copy after 0047) loaded, so the planner
// sees the live-size row counts as it does on the host.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventsQuery } from "../../bin/board/board-data.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const KINDS = ["action", "action_done", "member_phase", "member_closed", "member_rebound", "pick", "message_sent", "message_read", "tick_slow", "want", "squad_state", "unit_pr"];
const SQUADS = ["alpha", "beta", "gamma", "_studio"];
const wt = (p: string, s: string, i: number) => `id-${i}::/home/u/orca/workspaces/${p}/ds-${p}-builder-u${i}-${s}`;

// A migrated loop.db with rows like the live ones: two projects, squads of very different size, a
// few members each, a slice of rows with no squad, every kind the lookups below read.
function seeded(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzevidx-")); temps.push(d);
  const s = open(d); stores.push(s);
  const ins = s.db.query("INSERT INTO events (at, project, squad, unit, member, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?)");
  s.db.transaction(() => {
    for (let i = 0; i < 20000; i++) {
      const project = i % 7 === 0 ? "q" : "p";
      const squad = i % 13 === 0 ? null : i % 3 === 0 ? SQUADS[i % 4] : "alpha";
      const member = i % 5 === 0 || !squad ? null : wt(project, squad, i % 4);
      ins.run(1_700_000_000 + i, project, squad, null, member, KINDS[i % KINDS.length], JSON.stringify({ phase: "babysit", n: i }));
    }
  })();
  s.db.run("ANALYZE events");
  return s;
}

// The live db's stats after 0047 (copy of state/loop.db, 2026-11-17: 545,729 events). Loaded into
// sqlite_stat1, then `ANALYZE sqlite_schema` makes the connection read them again.
const LIVE_STAT1: [string, string][] = [
  ["events_at", "545729 3"],
  ["events_kind_at", "545729 4198 2"],
  ["events_kind_member", "545729 4198 1869 236 47"],
  ["events_squad", "518992 7415"],
];
function liveStats(): Store {
  const s = seeded();
  s.db.run("DELETE FROM sqlite_stat1 WHERE tbl = 'events'");
  for (const [idx, stat] of LIVE_STAT1) s.db.run("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES ('events', ?, ?)", [idx, stat]);
  s.db.run("ANALYZE sqlite_schema");
  return s;
}

function plan(s: Store, sql: string, args: unknown[]): string {
  return (s.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as never[])) as { detail: string }[]).map((r) => r.detail).join(" | ");
}

// eventsPage's statements around eventsQuery's where-clause: the page each way and the probes for
// another page. The text is checked against board-data.ts below.
const PAGE = {
  older: (w: string) => `SELECT * FROM events WHERE ${w} AND id < ? ORDER BY id DESC LIMIT ?`,
  newer: (w: string) => `SELECT * FROM events WHERE ${w} AND id > ? ORDER BY id ASC LIMIT ?`,
  probe: (w: string) => `SELECT 1 FROM events WHERE ${w} AND id < ? LIMIT 1`,
};
const pagePlans = (s: Store, o: Parameters<typeof eventsQuery>[0]) => {
  const { where, args } = eventsQuery(o);
  return [plan(s, PAGE.older(where), [...args, 1e9, 50]), plan(s, PAGE.newer(where), [...args, 0, 50]), plan(s, PAGE.probe(where), [...args, 1e9])];
};

test("eventsPage still builds its pages around eventsQuery as this test reads them", () => {
  const src = readFileSync(join(ROOT, "bin/board/board-data.ts"), "utf8");
  expect(src).toContain("FROM events WHERE ${scope} AND id < ? ORDER BY id DESC LIMIT ?");
  expect(src).toContain("FROM events WHERE ${scope} AND id > ? ORDER BY id ASC LIMIT ?");
  expect(src).toContain("SELECT 1 FROM events WHERE ${scope} AND id ${op} ? LIMIT 1");
});

test("migration 0047 adds the partial squad index, and no member or crew index", () => {
  const s = seeded();
  const idx = (s.db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND sql IS NOT NULL").all() as { name: string; sql: string }[]);
  const by = Object.fromEntries(idx.map((r) => [r.name, r.sql]));
  expect(by.events_squad).toContain("ON events (squad) WHERE squad IS NOT NULL");
  // (squad, member) was measured and left out: 10,000 inserts 46 % slower, the db 61 MB larger.
  expect(by.events_squad_member).toBeUndefined();
  const leads = Object.fromEntries(idx.map((r) => [r.name, /ON events \((\w+)/.exec(r.sql)?.[1]]));
  expect(Object.entries(leads).filter(([, col]) => col === "member" || col === "project")).toEqual([]);
});

const STATS = [["seeded + ANALYZE", seeded], ["live stats", liveStats]] as const;
for (const [label, make] of STATS) {
  test(`${label}: a squad page walks events_squad in id order`, () => {
    const s = make();
    for (const o of [{ project: "p", squad: "gamma" }, { project: "p", squad: "_studio", noise: true }, { project: "p", squad: "beta", cat: "messages", noise: true }, { squad: "alpha" }]) {
      const [older, newer, probe] = pagePlans(s, o);
      for (const p of [older, newer]) {
        expect({ o, p, idx: /USING (COVERING )?INDEX events_squad \(squad=\?/.test(p) }).toEqual({ o, p, idx: true });
        expect(p).not.toContain("TEMP B-TREE");
      }
      // The another-page probe has no ORDER BY: with a category the live stats seek the covering
      // events_kind_member per kind instead, which is as cheap (measured 3.5 ms for the whole page).
      expect({ o, probe, idx: /USING (COVERING )?INDEX events_(squad|kind_member) \(/.test(probe) }).toEqual({ o, probe, idx: true });
    }
  });

  // With no crew index, the live stats walk the squad's rows in id order and skip other members
  // (before 0047 it read events_kind_member for every kind and sorted: 253 ms on the busiest member,
  // 81 ms after). The seeded db's few members make events_kind_member look better: no table scan there.
  test(`${label}: a squad + crew page reads through an index${label === "live stats" ? ", events_squad in id order" : ""}`, () => {
    const s = make();
    for (const o of [{ project: "p", squad: "alpha", member: wt("p", "alpha", 1) }, { project: "p", squad: "alpha", member: wt("p", "alpha", 2), noise: true }, { squad: "alpha", member: wt("p", "alpha", 1), cat: "actions" }]) {
      for (const p of pagePlans(s, o)) {
        expect({ o, p, scan: /^SCAN events\b/.test(p) }).toEqual({ o, p, scan: false });
        if (label !== "live stats") continue;
        expect({ o, p, idx: /USING (COVERING )?INDEX events_squad \(squad=\?/.test(p) }).toEqual({ o, p, idx: true });
        expect(p).not.toContain("TEMP B-TREE");
      }
    }
  });

  test(`${label}: the default page still walks the primary key with no temp b-tree`, () => {
    const s = make();
    for (const o of [{ project: "p" }, { project: "p", noise: true }, {}, { noise: true }, { project: "p", nosquad: true }]) {
      const [older, newer] = pagePlans(s, o);
      expect({ o, older }).toEqual({ o, older: "SEARCH events USING INTEGER PRIMARY KEY (rowid<?)" });
      expect({ o, newer }).toEqual({ o, newer: "SEARCH events USING INTEGER PRIMARY KEY (rowid>?)" });
    }
  });
}

// The loop's per-member and per-squad lookups on events, as the code runs them: they keep the
// indexes they used before 0047 (events_kind_member / events_kind_at), never the new squad ones.
const LOOKUPS: { from: string; sql: string; args: unknown[] }[] = [
  { from: "bin/loop/capacity/switches.ts", sql: "SELECT at FROM events WHERE kind = 'member_phase' AND project = ? AND member = ? AND json_extract(payload, '$.phase') = 'babysit' ORDER BY at DESC LIMIT 1", args: ["p", wt("p", "alpha", 1)] },
  { from: "bin/loop/squad/close-drift.ts", sql: "SELECT at, payload FROM events WHERE kind = 'member_closed' AND project = ? AND member = ? AND at >= ? ORDER BY at", args: ["p", wt("p", "alpha", 1), 0] },
  { from: "bin/loop/fulfil/rebind.ts", sql: "SELECT 1 FROM events WHERE kind = 'member_rebound' AND member = ? AND payload LIKE ?", args: [wt("p", "alpha", 1), "%x%"] },
  { from: "bin/board/board-data.ts", sql: "SELECT payload FROM events WHERE project = ? AND squad = ? AND kind = 'pick' ORDER BY id DESC LIMIT 1", args: ["p", "alpha"] },
  { from: "bin/loop/reconcilers/members.ts", sql: "SELECT payload FROM events WHERE kind = 'member_rebound' AND project = ? AND squad = ? AND member = ? ORDER BY id", args: ["p", "alpha", wt("p", "alpha", 1)] },
];

test("each loop lookup is still in the code it is taken from", () => {
  for (const l of LOOKUPS) expect(readFileSync(join(ROOT, l.from), "utf8").replace(/\s+/g, " ")).toContain(l.sql.replace(/\s+/g, " "));
});

for (const [label, make] of STATS) {
  test(`${label}: the loop's lookups keep events_kind_member / events_kind_at`, () => {
    const s = make();
    for (const l of LOOKUPS) {
      const p = plan(s, l.sql, l.args);
      expect({ sql: l.sql, p, kindIdx: /INDEX events_kind_(member|at) /.test(p), squadIdx: /events_squad/.test(p) }).toEqual({ sql: l.sql, p, kindIdx: true, squadIdx: false });
    }
  });
}
