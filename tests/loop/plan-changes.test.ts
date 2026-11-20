import { describe, expect, test } from "bun:test";
import { planChanges, DIFF_CAP } from "../../bin/board/plan-changes.ts";
import { planRevisions } from "../../bin/lib/plan-plain.ts";

const rev = (steps: string) => `## Revisions\n\n### Rev 2 — 2026-11-17 — r\n- **What changed:** a.\n- **Why:** b.\n- **Steps touched:** ${steps}\n- **Stays as approved:** d.\n`;
const base = "# P\n\n## Units\n\nU1 — alpha builder — deps: none — Tier: standard\n  Done: a\nU2 — beta — deps: U1 — Tier: standard\n";

describe("planChanges", () => {
  test("step states come from the squad unit that names the plan and step", () => {
    const now = base.replace("Done: a", "Done: b") + "U3 — gamma tester — deps: U2 — Tier: standard\n" + rev("alpha builder");
    const units = [{ plan: "/s/p-plan.md", plan_unit: "U1", status: "dispatched", pr: "12" }, { plan: "/s/p-plan.md", plan_unit: "U2", status: "done" }];
    const c = planChanges(now, base, "/s/p-plan.md", planRevisions(now)[0], units);
    expect(c.steps).toEqual([{ id: "U1", title: "alpha builder", kind: "changed", state: "PR open" }, { id: "U3", title: "gamma tester", kind: "added", state: "not started" }]);
    expect(c.uncovered).toEqual([{ kind: "step", name: "gamma tester" }]);
  });
  test("a removed step and a one-word title covered by one word", () => {
    const now = base.replace(/U2 — beta[^\n]*\n/, "");
    const c = planChanges(now + rev("beta"), base, "/s/p-plan.md", planRevisions(now + rev("beta"))[0], [{ plan: "/s/p-plan.md", plan_unit: "U2", status: "cancelled" }]);
    expect(c.steps).toEqual([{ id: "U2", title: "beta", kind: "removed", state: "cancelled" }]);
    expect(c.uncovered).toEqual([]);
  });
  test("no revision means nothing is flagged; identical plans give an empty result", () => {
    const c = planChanges(base, base, "/s/p-plan.md", null, []);
    expect(c).toEqual({ steps: [], sections: [], uncovered: [], diff: [], changed_lines: 0, truncated: false });
  });
  test("the line view is capped", () => {
    const many = Array.from({ length: DIFF_CAP + 50 }, (_, i) => `line ${i}`).join("\n");
    const c = planChanges("## Notes\n\n" + many, "## Notes\n", "/s/p-plan.md", null, []);
    expect(c.truncated).toBe(true);
    expect(c.diff[0].lines.length).toBe(DIFF_CAP);
    expect(c.changed_lines).toBeGreaterThan(DIFF_CAP);
  });
  test("identical edits on two steps land under two unit sub-groups", () => {
    const a = "# P\n\n## Units\n\nU1 — alpha builder — deps: none — Tier: standard\n  Check: x\nU2 — beta — deps: U1 — Tier: standard\n  Check: x\n";
    const b = a.replaceAll("Check: x", "Check: tests pass.");
    const c = planChanges(b, a, "/s/p-plan.md", null, []);
    expect(c.diff.map((d) => [d.heading, d.unit])).toEqual([["Units", "U1 — alpha builder"], ["Units", "U2 — beta"]]);
    expect(c.diff[0].lines).toEqual([{ t: "-", text: "  Check: x" }, { t: "+", text: "  Check: tests pass." }]);
  });
  test("a changed line outside any unit stays grouped by section only", () => {
    const c = planChanges(base.replace("# P", "# P\n\n## Notes\n\nnew"), base, "/s/p-plan.md", null, []);
    expect(c.diff.find((d) => d.heading === "Notes")!.unit).toBeUndefined();
  });
});
