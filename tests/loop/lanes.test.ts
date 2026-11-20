// lanes.test.ts — light-lane plan U5: the lane record written when a unit's PR merges, the report
// `ds lanes` prints (rules with units/misses/median CPU-hours, per-folder medians of unmarked units),
// and the GitHub query asking for a tracked PR's files.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { formatReport, laneReport, recordLane, topFolders } from "../../bin/loop/capacity/unit-lanes.ts";
import { buildQuery } from "../../bin/loop/observers/github.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const P = "acme";
const H = 3600;

const files = (...paths: string[]) => ({ files: { nodes: paths.map((path) => ({ path })) } });

// Four finished units: two light under rule contracts-only (u2 was moved), two unmarked.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zzlanes-")); temps.push(root);
  const s = open(root); stores.push(s);
  mkdirSync(join(root, P), { recursive: true });
  writeFileSync(join(root, P, "lanes.md"), "- contracts-only: light — only contracts/ and docs/ files change — acme 4-day sample, 0.3 CPU-h\n- never-used: light — a rule nobody tagged — guess\n");
  const unit = (slug: string, doc: object, cpuH: number, moved: boolean, pr: object, n: number) => {
    s.upsert("units", { project: P, squad: "sq", slug }, { status: "done", doc: JSON.stringify(doc), observed_at: 1, updated_at: 1 });
    s.db.run("INSERT INTO unit_cpu (project, squad, slug, cpu_s, peak_cpu_pct, first_at, updated_at) VALUES (?, 'sq', ?, ?, 150, 1, 1)", [P, slug, cpuH * H]);
    if (moved) s.event("unit_lane_moved", { project: P, squad: "sq", unit: slug, payload: { cpu_h: cpuH } });
    recordLane(s, s.get("units", { project: P, squad: "sq", slug })!, JSON.stringify(pr), n, 100 + n);
  };
  unit("u1", { lane: "light", lane_rule: "contracts-only" }, 0.2, false, files("contracts/a.sol", "docs/x.md"), 1);
  unit("u2", { lane: "light", lane_rule: "contracts-only" }, 4, true, files("contracts/b.sol", "app/z.ts"), 2);
  unit("u3", {}, 1, false, files("app/a.ts", "app/b.ts", "README.md"), 3);
  unit("u4", {}, 3, false, files("app/c.ts", "tests/t.ts"), 4);
  return { root, s };
}

test("a unit's lane record keeps lane, rule, CPU, moved and the PR's top-level folders", () => {
  const { s } = fixture();
  const r = (slug: string) => s.get("unit_lanes", { project: P, squad: "sq", slug })!;
  expect([r("u1").lane, r("u1").lane_rule, r("u1").cpu_s, r("u1").moved, r("u1").peak_cpu_pct]).toEqual(["light", "contracts-only", 0.2 * H, 0, 150]);
  expect(JSON.parse(String(r("u1").folders))).toEqual(["contracts", "docs"]);
  expect([r("u2").moved, r("u3").lane, r("u3").lane_rule]).toEqual([1, "normal", null]);
  expect(JSON.parse(String(r("u3").folders))).toEqual([".", "app"]);
});

test("recording twice refreshes the same row", () => {
  const { s } = fixture();
  recordLane(s, s.get("units", { project: P, squad: "sq", slug: "u1" })!, JSON.stringify(files("x/y")), 1, 999);
  expect(s.db.query("SELECT COUNT(*) AS n FROM unit_lanes WHERE slug = 'u1'").get()).toEqual({ n: 1 });
  expect(JSON.parse(String(s.get("unit_lanes", { project: P, squad: "sq", slug: "u1" })!.folders))).toEqual(["x"]);
});

test("ds lanes: contracts-only: 2 units, 1 moved, median …, and per-folder medians of the unmarked units", () => {
  const { s, root } = fixture();
  const rep = laneReport(s, root, P);
  expect(rep.rules.find((r) => r.id === "contracts-only")).toMatchObject({ units: 2, moved: 1, median_cpu_h: 2.1, lane: "light" });
  expect(rep.rules.find((r) => r.id === "never-used")).toMatchObject({ units: 0, moved: 0 });
  // unmarked: u3 (1 h: ".", app) and u4 (3 h: app, tests)
  expect(rep.folders).toEqual([
    { folder: ".", units: 1, median_cpu_h: 1 },
    { folder: "app", units: 2, median_cpu_h: 2 },
    { folder: "tests", units: 1, median_cpu_h: 3 },
  ]);
  const text = formatReport(P, rep);
  expect(text).toContain("contracts-only: 2 units, 1 moved, median 2.1 CPU-h");
  expect(text).toContain("app: median 2 CPU-h over 2 units");
});

test("a rule only the records name still shows; no records means empty sections", () => {
  const { s, root } = fixture();
  s.upsert("units", { project: P, squad: "sq", slug: "u9" }, { status: "done", doc: JSON.stringify({ lane: "light", lane_rule: "ghost" }), observed_at: 1, updated_at: 1 });
  recordLane(s, s.get("units", { project: P, squad: "sq", slug: "u9" })!, null, null, 5);
  expect(laneReport(s, root, P).rules.find((r) => r.id === "ghost")).toMatchObject({ units: 1, lane: "(not in lanes.md)" });
  expect(laneReport(s, root, "other")).toEqual({ rules: [], folders: [] });
});

test("topFolders reads a PR doc's files (object or JSON text) and tolerates none", () => {
  expect(topFolders(files("a/b/c", "a/d", "z"))).toEqual([".", "a"]);
  expect(topFolders(JSON.stringify(files("q/r")))).toEqual(["q"]);
  expect(topFolders(null)).toEqual([]);
  expect(topFolders("not json")).toEqual([]);
});

test("the GitHub query asks a tracked PR for its files, and an open-page PR does not", () => {
  const q = buildQuery([{ nwo: "acme/app", tracked: [7] }]);
  expect(q).toContain("files(first: 100) { nodes { path } }");
  expect(buildQuery([{ nwo: "acme/app", page: null }])).not.toContain("files(first");
});
