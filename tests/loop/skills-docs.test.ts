// skills-docs.test.ts — U229: every skill a role doc names is on and required for that role in
// conventions/skills.conf. Adding a skill to a role doc without adding it to the defaults fails here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { levelOf, matches, parseRules, shippedRules, type Rule } from "../../bin/loop/settings/skills.ts";

const ROOT = join(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
// ce-pipeline is a ship mode, not a skill.
const NOT_SKILLS = new Set(["ce-pipeline"]);

// The skills a doc names: a backticked `name` or `/name` of the Compound Engineering skills (ce-*, lfg),
// no-mistakes, lavish and orchestration. Listed names carry the plugin prefix.
export function skillsNamed(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`\/?(ce-[a-z][a-z-]*|lfg|no-mistakes|lavish|orchestration)(?=[`\s])/g)) {
    if (NOT_SKILLS.has(m[1])) continue;
    out.add(m[1].startsWith("ce-") || m[1] === "lfg" ? `compound-engineering:${m[1]}` : m[1]);
  }
  return [...out].sort();
}

// Is `name` required (and so listed, on or name-only) for `role`: the best shipped rule that names it
// is a `required` one. Mirrors levelOf's shipped step.
export function missing(text: string, role: string, rules: Rule[]): string[] {
  return skillsNamed(text).filter((s) => {
    const l = levelOf(s, role, rules, []);
    const required = rules.some((r) => r.required && (r.role === role || r.role === "*") && matches(r.pattern, s));
    return !(required && (l === "on" || l === "name-only"));
  });
}

// AGENTS.md is read by every role. conventions/*.md are shared references that name other roles' skills
// too (ce-plan for the Thinker), so a convention doc is checked against the role it is about: none here.
const everyRole = ["AGENTS.md"];
const DOCS: Record<string, string[]> = {
  builder: ["roles/builder.md"], thinker: ["roles/thinker.md"], lead: ["roles/lead.md"],
  tester: ["roles/tester.md"], researcher: ["roles/researcher.md"], reviewer: ["roles/reviewer.md"],
  studio: ["studio/studio.md"],
};

describe("role docs name only skills their role has required", () => {
  const rules = shippedRules();
  for (const [role, own] of Object.entries(DOCS)) {
    test(role, () => {
      const text = [...everyRole, ...own].map(read).join("\n");
      expect(missing(text, role, rules)).toEqual([]);
    });
  }
  test("a planted role doc naming a skill outside the role's required list fails", () => {
    const planted = "Use `ce-ideate` and `ce-work` before shipping.";
    expect(missing(planted, "builder", rules)).toEqual(["compound-engineering:ce-ideate"]);
    expect(missing(planted, "thinker", rules)).toEqual([]);
  });
  test("a project-only rule file with no required rule fails every named skill", () => {
    expect(missing("`ce-work`", "builder", parseRules("builder compound-engineering:ce-work on"))).toEqual(["compound-engineering:ce-work"]);
  });
});
