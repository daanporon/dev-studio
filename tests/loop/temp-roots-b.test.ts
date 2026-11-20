// U284: the second file's dirs are removed too (the module-level hook this replaces reached only the first file).
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tempBase, tempRoot } from "./temp-roots.ts";

test("a dir made in the second file is removed after its test, and the first file's is gone", () => {
  const first = (globalThis as { __temp_roots_a?: string }).__temp_roots_a;
  if (first) expect(existsSync(first)).toBe(false);
  expect(existsSync(tempRoot("zztemproots-b-"))).toBe(true);
});

test("nothing of the previous test is left in the temp base", () => {
  expect(readdirSync(tempBase()).filter((n) => n.startsWith("zztemproots-"))).toEqual([]);
});
