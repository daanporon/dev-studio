import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIEF_SOURCES, INSTRUCTION_GLOBS, classOf, classify, instructionFilesFor, need, reloadTargets } from "../../bin/lib/update-classes";

describe("update-classes", () => {
  test("each class", () => {
    expect(classOf("skills/ds/SKILL.md")).toBe("skills");
    expect(classOf(".claude/commands/ds-update.md")).toBe("skills");
    for (const p of ["AGENTS.md", "roles/builder.md", "studio/studio.md", "conventions/state.md"]) expect(classOf(p)).toBe("instructions");
    for (const p of ["bin/ds.ts", "tests/x.sh", "docs/USAGE.md", "roles/sub/x.md", "conventions/limits.conf", "README.md", "web/board.html"]) expect(classOf(p)).toBe("code");
  });
  test("need: the strongest wins", () => {
    expect(need(classify(["bin/a.ts"]))).toBe("none");
    expect(need(classify([]))).toBe("none");
    expect(need(classify(["bin/a.ts", "roles/lead.md"]))).toBe("reload");
    expect(need(classify(["bin/a.ts", "roles/lead.md", "skills/x/SKILL.md"]))).toBe("restart");
    expect([...classify(["bin/a.ts", "AGENTS.md"])].sort()).toEqual(["code", "instructions"]);
  });
  test("the instruction globs are the ones instrHash() hashes when no role is known", () => {
    expect(instructionFilesFor(null)).toEqual([...INSTRUCTION_GLOBS]);
    const src = readFileSync(join(import.meta.dir, "../../bin/commands/watch-ts.ts"), "utf8");
    expect(src).toContain("instructionFilesFor(myRole())");
  });
  test("reloadTargets: AGENTS.md and brief sources reach everyone", () => {
    expect(reloadTargets(["AGENTS.md"]).all).toBe(true);
    for (const p of BRIEF_SOURCES) expect(reloadTargets([p]).all).toBe(true);
  });
  test("reloadTargets: a role file reaches that role only; a Builder's suffix does not matter", () => {
    const t = reloadTargets(["roles/builder.md", "bin/x.ts"]);
    expect(t.all).toBe(false); expect(t.studio).toBe(false); expect([...t.roles]).toEqual(["builder"]);
    expect([...reloadTargets(["roles/lead.md", "roles/thinker.md"]).roles].sort()).toEqual(["lead", "thinker"]);
  });
  test("reloadTargets: studio.md reaches the Studio only", () => {
    const t = reloadTargets(["studio/studio.md"]);
    expect(t.studio).toBe(true); expect(t.all).toBe(false); expect(t.roles.size).toBe(0);
  });
  test("reloadTargets: conventions alone reach nobody", () => {
    const t = reloadTargets(["conventions/backend.md", "docs/scripts.md"]);
    expect(t.all).toBe(false); expect(t.studio).toBe(false); expect(t.roles.size).toBe(0);
  });
  test("instructionFilesFor: AGENTS.md plus the role's own file, no conventions", () => {
    expect(instructionFilesFor("lead")).toEqual(["AGENTS.md", "roles/lead.md"]);
    expect(instructionFilesFor("studio")).toEqual(["AGENTS.md", "studio/studio.md"]);
  });
});
