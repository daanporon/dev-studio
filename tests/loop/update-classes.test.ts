import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTRUCTION_GLOBS, classOf, classify, need } from "../../bin/lib/update-classes";

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
  test("the instruction globs are the ones instrHash() hashes", () => {
    const src = readFileSync(join(import.meta.dir, "../../bin/commands/watch-ts.ts"), "utf8");
    const line = src.split("\n").find((l) => l.includes('join(ROOT, "AGENTS.md")'))!;
    const fromWatch = [...line.matchAll(/join\(ROOT((?:, "[^"]+")+)\)/g)].map((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).join("/"));
    expect(fromWatch).toEqual([...INSTRUCTION_GLOBS]);
  });
});
