// shortTitle (bin/board/board-data.ts): an untitled question's one-line row.
import { describe, expect, test } from "bun:test";
import { shortTitle } from "../../bin/board/board-data.ts";

describe("shortTitle", () => {
  test("a plan question reads Approve plan: <x>?", () => {
    expect(shortTitle(
      "Plan ready for your approval: /home/x/state/acme/squads/u4-suspend-offboard-build-plan.md — Planning route: hard, first …",
      "plan-build",
    )).toBe("Approve plan: build?");
  });
  test("a plan id with dashes keeps the suffix", () => {
    expect(shortTitle("Plan ready for your approval: /home/x/state/acme/squads/u4-offboard-plan.md …", "plan-u4-offboard")).toBe(
      "Approve plan: u4-offboard?",
    );
  });
  test("an untitled non-plan question cuts an absolute path to its file name", () => {
    expect(shortTitle("Should we merge /home/x/state/acme/squads/u4-thing-plan.md now?", "q-123")).toBe(
      "Should we merge u4-thing-plan.md now?",
    );
  });
  test("a ~/ path is cut to its file name", () => {
    expect(shortTitle("Review ~/state/acme/notes.md before merging?", "q-1")).toBe("Review notes.md before merging?");
  });
  test("old behavior without an id: first sentence, cut at 80 chars", () => {
    expect(shortTitle("Short question? Second sentence here.")).toBe("Short question?");
    const long = "a".repeat(100) + " end";
    expect(shortTitle(long)).toBe("a".repeat(80).replace(/\s\S*$/, "") + "…");
    expect(shortTitle("no plan id here")).toBe("no plan id here");
  });
});
