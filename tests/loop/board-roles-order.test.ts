// board-roles-order.test.ts — U131: GET /api/roles lists roles in one fixed order on every project.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { rolesJson } from "../../bin/board/board-data.ts";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const seed = (s: Store, project: string, keys: string[]) => keys.forEach((k) =>
  s.db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES (?, 'roles.conf', ?, 'claude sonnet always - - -', 1)", [project, k]));

test("two rosters with different row order show the same order; unknown roles go last by name", () => {
  const d = mkdtempSync(join(tmpdir(), "zzorder-")); temps.push(d);
  const s = open(d); stores.push(s);
  seed(s, "", ["tester", "zeta", "builder", "lead", "alpha", "reviewer", "thinker"]);
  seed(s, "p2", ["reviewer", "lead", "beta", "builder", "tester"]);
  const names = (p: string) => rolesJson(p, d)!.roles.map((r) => r.role);
  expect(names("")).toEqual(["lead", "thinker", "builder", "reviewer", "tester", "alpha", "zeta"]);
  // U268: the default fills the roles p2's roster lacks, so both rosters list the same roles.
  expect(names("p2")).toEqual(["lead", "thinker", "builder", "reviewer", "tester", "alpha", "beta", "zeta"]);
});

test("U268: a project roster that lacks studio lists it once, marked default, and no row is missing", () => {
  const d = mkdtempSync(join(tmpdir(), "zzstudio-")); temps.push(d);
  const s = open(d); stores.push(s);
  seed(s, "", ["studio", "lead", "builder"]);
  seed(s, "p3", ["lead", "builder"]);
  s.db.run("UPDATE config SET value = 'claude opus always - - -' WHERE project = 'p3' AND key = 'lead'");
  const roles = rolesJson("p3", d)!.roles;
  expect(roles.filter((r) => r.role === "studio")).toHaveLength(1);
  expect(roles.find((r) => r.role === "studio")).toMatchObject({ source: "default", model: "sonnet" });
  expect(roles.find((r) => r.role === "lead")).toMatchObject({ source: "project", model: "opus", default: { model: "sonnet" } });
  expect(roles.map((r) => r.source).every((x) => x === "default" || x === "project")).toBe(true);
  expect(rolesJson("none", d)!.roles.every((r) => r.source === "default")).toBe(true);
});
