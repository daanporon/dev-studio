// github-budget.test.ts — U286: the shared rate-limit test, pacing and budget room (bin/loop/io/github-budget.ts).
import { expect, test } from "bun:test";
import { budgetBackAt, hasBudget, isRateLimit, pace, RESET_GRACE_S, rateLimitedBody } from "../../bin/loop/io/github-budget.ts";

test("a rate limit is GraphQL's RATE_LIMITED or RATE_LIMIT, or gh's rate limit text; a permission 403 is not", () => {
  // GitHub's answer when the hourly GraphQL budget is spent (seen 2026-11-17).
  expect(rateLimitedBody({ errors: [{ type: "RATE_LIMIT", code: "graphql_rate_limit", message: "API rate limit already exceeded for user ID 71901." }] })).toBe(true);
  expect(rateLimitedBody({ errors: [{ type: "RATE_LIMITED" }] })).toBe(true);
  expect(rateLimitedBody({ errors: [{ type: "NOT_FOUND" }] })).toBe(false);
  expect(rateLimitedBody(null)).toBe(false);
  expect(isRateLimit("GraphQL: API rate limit already exceeded for user ID 71901.")).toBe(true);
  expect(isRateLimit("gh: You have exceeded a secondary rate limit. (HTTP 403)")).toBe(true);
  expect(isRateLimit("HTTP 429: Too Many Requests")).toBe(true);
  expect(isRateLimit("HTTP 403: Resource not accessible by integration")).toBe(false);
  expect(isRateLimit("GraphQL: Auto-merge is not allowed for this repository (enableAutoMerge)")).toBe(false);
});

test("pace spends at most share x limit an hour, never faster than the base", () => {
  expect(pace(30, 110, 5000, 0.5)).toBe(159);   // the live cost before U286: 110 x 3600 / 2500
  expect(pace(30, 8, 5000, 0.5)).toBe(30);
  expect(pace(30, 100, 5000, 0.25)).toBe(288);
  expect(pace(30, null, 5000, 0.5)).toBe(30);
  expect(pace(30, 100, null, 0.5)).toBe(30);
});

test("room is two reads' cost; past its reset a budget is full again; unknown is room", () => {
  const b = { limit: 5000, cost: 100, remaining: 150, resetAt: 1000 };
  expect(hasBudget(b, 900)).toBe(false);
  expect(budgetBackAt(b, 900)).toBe(1000 + RESET_GRACE_S);
  expect(hasBudget(b, 1000)).toBe(true);
  expect(budgetBackAt(b, 1000)).toBeNull();
  expect(hasBudget({ ...b, remaining: 200 }, 900)).toBe(true);
  expect(hasBudget({ limit: null, cost: null, remaining: null, resetAt: null }, 900)).toBe(true);
  expect(hasBudget({ ...b, remaining: 0, resetAt: null }, 900)).toBe(false);
  expect(budgetBackAt({ ...b, remaining: 0, resetAt: null }, 900)).toBeNull();
});
