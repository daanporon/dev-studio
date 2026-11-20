// U253: the loop does not tick a test-named project; import and the readers still see it.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProjects, loopProjects, skippedProjects, isTestProject } from "../../bin/loop/settings/projects.ts";

test("test prefixes are skipped by the loop, listed apart, and still discovered for import", () => {
  const root = mkdtempSync(join(tmpdir(), "projskip-"));
  try {
    for (const n of ["dev-studio", "zzboard_1", "sstate-jrnl-2", "pickseam-3", "_rolestest"]) mkdirSync(join(root, n, "squads"), { recursive: true });
    expect(loopProjects(root)).toEqual(["dev-studio"]);
    expect(skippedProjects(root)).toEqual(["_rolestest", "pickseam-3", "sstate-jrnl-2", "zzboard_1"]);
    expect(discoverProjects(root).length).toBe(5);
    expect(isTestProject("zzx")).toBe(true);
    expect(isTestProject("dev-studio")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
