// board-limits-groups.test.ts — U241: every key of conventions/limits.conf sits in a named Limits category,
// and the page's folded-line helper reads as the plan says.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMIT_GROUPS, limitGroup } from "../../bin/board/board-data.ts";

const root = join(import.meta.dir, "../..");
const keys = readFileSync(join(root, "conventions/limits.conf"), "utf8").split("\n")
  .filter((l) => l.trim() && !/^\s*#/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
const page = readFileSync(join(root, "web/board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
const summary = new Function(`${cut("limitGroupSummary")} return limitGroupSummary;`)();

test("every limits.conf key has a named category, none Other", () => {
  expect(keys.length).toBe(107);
  expect(keys.filter((k) => limitGroup(k) === "Other")).toEqual([]);
});
test("the nine categories hold the planned counts", () => {
  const n: Record<string, number> = {};
  for (const k of keys) n[limitGroup(k)] = (n[limitGroup(k)] ?? 0) + 1;
  expect(LIMIT_GROUPS[0].name).toBe("Context & compaction");
  expect(LIMIT_GROUPS.map((g) => n[g.name])).toEqual([18, 15, 25, 8, 5, 24, 3, 7, 2]);
});
test("an unknown key is Other", () => { expect(limitGroup("brand_new_key")).toBe("Other"); });
test("the folded line counts overridden, unsaved (not env) and error", () => {
  const rows = [{ key: "a", value: "1", source: "override" }, { key: "b", value: "2", source: "default" }, { key: "c", value: "3", source: "env" }];
  expect(summary("Review", rows.slice(1), {}, {})).toBe("Review · 2 settings");
  expect(summary("Review", rows, { a: "9", b: "2", c: "7" }, { b: "bad" })).toBe("Review · 3 settings · 1 overridden · 1 unsaved · error");
  expect(summary("X", [rows[0]], {}, {})).toBe("X · 1 setting · 1 overridden");
});
