// U284: temp-roots.ts removes a dir after the test that made it, in every file run by one `bun test` call.
// This file and temp-roots-b.test.ts each make a dir; the second also checks the first file's dir is gone.
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "./temp-roots.ts";

test("a dir made here is gone after the test", () => {
  const d = tempRoot("zztemproots-a-");
  writeFileSync(join(d, "f"), "x");
  (globalThis as { __temp_roots_a?: string }).__temp_roots_a = d;
  expect(existsSync(d)).toBe(true);
});
