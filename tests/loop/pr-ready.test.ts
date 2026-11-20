// pr-ready.test.ts — human gates and the ask verdict over observed PR rows.
import { describe, expect, test } from "bun:test";
import type { Row } from "../../bin/loop/core/store.ts";
import { askState, checksOf, humanGates } from "../../bin/loop/squad/pr-ready.ts";

const cr = (name: string, status: string, conclusion: string | null = null, extra: Row = {}) =>
  ({ __typename: "CheckRun", name, databaseId: 1, status, conclusion, isRequired: false, ...extra });
const sc = (context: string, state: string, extra: Row = {}) => ({ __typename: "StatusContext", context, state, isRequired: false, ...extra });
const row = (checks: unknown[], reasons = "", set: Row = {}): Row => ({
  state: "OPEN", reasons: JSON.stringify(reasons),
  doc: JSON.stringify({ headRefOid: "aaa", commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks } } } }] }, reviews: { nodes: [] } }),
  ...set,
});

describe("pr-ready", () => {
  test("an older cancelled run of an expected check is dropped for its newer success", () => {
    const r = row([
      { __typename: "CheckRun", name: "e2e", databaseId: 1, status: "COMPLETED", conclusion: "CANCELLED", isRequired: false },
      { __typename: "CheckRun", name: "e2e", databaseId: 2, status: "COMPLETED", conclusion: "SUCCESS", isRequired: false },
      cr("build", "COMPLETED", "SUCCESS", { isRequired: true }),
    ]);
    expect(checksOf(r, ["e2e"]).map((c) => c.name)).toEqual(["e2e", "build"]);
    expect(askState(r, [], ["e2e"])?.blockers).toEqual([]);
  });

  test("a StatusContext can fail and pend; a required human gate pending does not block", () => {
    const failing = row([sc("Proof hold", "FAILURE")]);
    expect(humanGates(failing)).toEqual(["Proof hold"]);
    const pending = row([sc("signoff", "PENDING", { isRequired: true }), cr("build", "COMPLETED", "SUCCESS", { isRequired: true })]);
    expect(askState(pending)?.blockers).toEqual([]);
    expect(humanGates(pending)).toEqual(["signoff"]);
  });

  test("a running review-bot CheckRun blocks even though its name matches a gate", () => {
    const r = row([cr("capy/review", "IN_PROGRESS"), cr("Proof hold", "COMPLETED", "FAILURE")]);
    expect(askState(r)?.blockers).toEqual(["checks-running"]);
  });
});
