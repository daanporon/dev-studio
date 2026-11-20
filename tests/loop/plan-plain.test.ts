// plan-plain.ts (the plain section, fallback) and plan-lines.ts (planUnitFacts): the shared readers behind the
// board's plan-approval question data (plan-approval-view U1).
import { describe, expect, test } from "bun:test";
import { PLAIN_LABELS, REVISION_LABELS, approvedCopyPath, planFallback, planRevisions, planPlain, plainSection } from "../../bin/lib/plan-plain.ts";
import { planUnitFacts } from "../../bin/loop/squad/plan-lines.ts";

const SECTION = `# Plan

**PROBLEM:** the old problem.

## In plain words

- **What you get:** a readable approval.
- **Steps:** three changes,
  each its own pull request.
- **Risky or can't be undone:** nothing.
- **Cost and time:** a few hours.
- **You are approving:** the plain section.

## Goal
body
`;

describe("plainSection", () => {
  test("finds the five lines, joins continuations, stops at the next heading", () => {
    const s = plainSection(SECTION)!;
    expect(s.missing).toEqual([]);
    expect(s.lines.map((l) => l.label)).toEqual([...PLAIN_LABELS]);
    expect(s.lines[1].text).toBe("three changes, each its own pull request.");
    expect(s.lines[4].text).toBe("the plain section.");
  });
  test("a missing label is named; the colon outside the bold and a curly apostrophe still match", () => {
    const md = "## In plain words\n- **What you get**: x\n- **Steps:** y\n- **Risky or can’t be undone:** z\n- **You are approving:** w\n";
    const s = plainSection(md)!;
    expect(s.missing).toEqual(["Cost and time"]);
    expect(s.lines.map((l) => l.label)).toEqual(["What you get", "Steps", "Risky or can't be undone", "You are approving"]);
  });
  test("an empty label text counts as missing", () => {
    expect(plainSection("## In plain words\n- **Steps:**\n")!.missing).toContain("Steps");
  });
  test("no heading is null", () => { expect(plainSection("# Plan\n\ntext\n")).toBeNull(); });
});

describe("planFallback / planPlain", () => {
  test("PROBLEM and DONE lines", () => {
    const md = "**PROBLEM:** a dense\nparagraph.\n\n**WHY NOW:** x\n\n**DONE:** it works.\n";
    expect(planFallback(md)).toEqual([{ label: "Problem", text: "a dense paragraph." }, { label: "Done", text: "it works." }]);
    expect(planPlain(md).plain_from).toBe("fallback");
  });
  test("neither is null", () => { expect(planFallback("# x\n")).toBeNull(); expect(planPlain("# x\n")).toEqual({ plain: null, plain_from: null }); });
  test("a complete section wins; an incomplete one falls back", () => {
    expect(planPlain(SECTION).plain_from).toBe("section");
    expect(planPlain("**PROBLEM:** p\n\n## In plain words\n- **Steps:** s\n").plain_from).toBe("fallback");
  });
});

describe("planUnitFacts", () => {
  const unit = (id: string, deps: string, tier: string, extra = "") => `${id} — title ${id} — deps: ${deps} — Tier: ${tier}${extra}\n  Done: x\n`;
  test("counts steps, hard steps and the units that can start now (a held no-deps unit does not)", () => {
    const md = unit("U1", "none", "standard") + unit("U2", "U1", "hard") + unit("U3", "none", "standard", " — HELD") + unit("U4", "none", "hard");
    expect(planUnitFacts(md)).toEqual({ steps: 4, hard: 2, start_now: 2 });
  });
  test("a malformed unit line or no unit line is null, not a throw", () => {
    expect(planUnitFacts("U1 — no tier — deps: none\n")).toBeNull();
    expect(planUnitFacts("# nothing\n")).toBeNull();
  });
});

const REV = `# Plan

## In plain words

- **What you get:** x

## Revisions

### Rev 2 — 2026-11-17 — fix the card
- **What changed:** the card
  now opens first.
- **Why:** it was hidden.
- **Steps touched:** the board step.
- **Stays as approved:** everything else.

### Rev 1 — 2026-11-10 — first change
- **What changed:** a.
- **Why:** b.

## Goal
`;

describe("planRevisions", () => {
  test("finds entries newest first with their four lines and joined continuations", () => {
    const r = planRevisions(REV);
    expect(r.map((e) => e.rev)).toEqual([2, 1]);
    expect(r[0]).toMatchObject({ date: "2026-11-17", reason: "fix the card", missing: [] });
    expect(r[0].lines.map((l) => l.label)).toEqual([...REVISION_LABELS]);
    expect(r[0].lines[0].text).toBe("the card now opens first.");
  });
  test("an entry with a missing line names it", () => {
    expect(planRevisions(REV)[1].missing).toEqual(["Steps touched", "Stays as approved"]);
  });
  test("an entry written oldest first still sorts newest first", () => {
    const md = "## Revisions\n### Rev 1 — 2026-01-01 — a\n- **Why:** w\n### Rev 3 — 2026-01-03 — c\n- **Why:** w\n";
    expect(planRevisions(md).map((e) => e.rev)).toEqual([3, 1]);
  });
  test("no section or no entries gives an empty list", () => {
    expect(planRevisions("# Plan\n## Goal\n")).toEqual([]);
    expect(planRevisions("## Revisions\n\nnothing yet\n")).toEqual([]);
  });
});

describe("approvedCopyPath", () => {
  test("is the plan name with .approved.md", () => {
    expect(approvedCopyPath("/s/squads/t-x-plan.md")).toBe("/s/squads/t-x-plan.approved.md");
  });
});

describe("unbulleted label lines", () => {
  const body = ["## In plain words", "**What you get:** a", "**Steps:** b", "**Risky or can't be undone:** c", "**Cost and time:** d", "**You are approving:** e"].join("\n");
  test("plainSection reads them like bulleted ones", () => {
    const bul = body.split("\n").map((l, i) => (i ? "- " + l : l)).join("\n");
    expect(plainSection(body)).toEqual(plainSection(bul));
    expect(plainSection(body)!.missing).toEqual([]);
  });
  test("planRevisions reads them like bulleted ones", () => {
    const rev = (p: string) => `## Revisions\n### Rev 2 — 2026-11-17 — r\n${p}**What changed:** a\n${p}**Why:** b\n${p}**Steps touched:** c\n${p}**Stays as approved:** d\n`;
    expect(planRevisions(rev(""))).toEqual(planRevisions(rev("- ")));
    expect(planRevisions(rev(""))[0].missing).toEqual([]);
  });
});

describe("indented bold lines stay part of the label above", () => {
  test("plainSection appends an indented bold line to the open label", () => {
    const md = SECTION.replace("each its own pull request.", "each its own pull request.\n  **Note:** more");
    const steps = plainSection(md)!.lines.find((l) => l.label === "Steps")!.text;
    expect(steps).toBe("three changes, each its own pull request. **Note:** more");
    expect(plainSection(md)!.missing).toEqual([]);
  });
  test("planRevisions appends an indented bold line to the open label", () => {
    const md = "## Revisions\n### Rev 2 — 2026-11-17 — r\n**What changed:** a\n ** Note:** more\n**Why:** b\n**Steps touched:** c\n**Stays as approved:** d\n";
    const r = planRevisions(md)[0];
    expect(r.lines[0].text).toBe("a ** Note:** more");
    expect(r.missing).toEqual([]);
  });
  test("an unindented unknown bold line still closes the open label", () => {
    const md = SECTION.replace("each its own pull request.", "each its own pull request.\n**Other:** x\n  tail");
    expect(plainSection(md)!.lines.find((l) => l.label === "Steps")!.text).toBe("three changes, each its own pull request.");
  });
});
