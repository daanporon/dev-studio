// U2: review-unit's check for a reviewer that left ce-code-review part-way and wrote its own result.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { leftSkill, runSnap, stopClass, STOP_AFTER } from "../../bin/review/review-unit.ts";

const HEAD = "a".repeat(40);
let runs = "";
const folder = (name: string, files: Record<string, string>): string => {
  const d = join(runs, name);
  mkdirSync(d, { recursive: true });
  for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
  return d;
};
const ev = (...xs: [string, string][]) => xs.map(([stage, phase]) => JSON.stringify({ stage, phase }) + "\n").join("");
const done = { "stages.jsonl": ev(["scope", "start"], ["scope", "end"], ["report", "start"], ["report", "end"]), "metadata.json": JSON.stringify({ head_sha: HEAD }), "review.json": "{}" };

beforeEach(() => { runs = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "left-")); });
afterEach(() => { rmSync(runs, { recursive: true, force: true }); });

describe("leftSkill", () => {
  test("a complete skill run, or none at all, is not leaving the skill", () => {
    const before = runSnap(runs);
    expect(leftSkill(runs, before, HEAD)).toBeNull();
    folder("20261118-120000-0a1b2c3d", done);
    folder("20261118-120001-0a1b2c3e", { ...done, "stages.jsonl": ev(["scope", "start"], ["receipt", "start"], ["receipt", "end"]) });
    expect(leftSkill(runs, before, HEAD)).toBeNull();
  });

  test("a skill folder stalled at scope", () => {
    const before = runSnap(runs);
    const d = folder("20261118-120000-0a1b2c3d", { "stages.jsonl": ev(["scope", "start"]) });
    expect(leftSkill(runs, before, HEAD)).toEqual({ stage: "scope", folder: d });
  });

  test("a hand-made …-delta folder is named over a stalled one", () => {
    const before = runSnap(runs);
    folder("20261118-120000-0a1b2c3d", { "stages.jsonl": ev(["scope", "start"], ["scope", "end"], ["review", "start"]) });
    const d = folder("20261118-120100-delta", { "metadata.json": JSON.stringify({ run_id: "x", head_sha: HEAD, verdict: "Ready" }), "review.json": "{}" });
    expect(leftSkill(runs, before, HEAD)).toEqual({ stage: "review", folder: d });
  });

  test("an older folder's review.json rewritten during the call", () => {
    const old = folder("20261101-000000-0123abcd", done);
    utimesSync(join(old, "review.json"), 1_700_000_000, 1_700_000_000);
    const before = runSnap(runs);
    writeFileSync(join(old, "review.json"), '{"status":"complete"}');
    expect(leftSkill(runs, before, HEAD)).toEqual({ stage: "none", folder: old });
  });

  test("another HEAD's folders are another worktree's review", () => {
    const before = runSnap(runs);
    folder("20261118-120100-delta", { "metadata.json": JSON.stringify({ head_sha: "b".repeat(40) }) });
    folder("20261118-120000-0a1b2c3d", { "stages.jsonl": ev(["scope", "start"]), "metadata.json": JSON.stringify({ head_sha: "b".repeat(40) }) });
    expect(leftSkill(runs, before, HEAD)).toBeNull();
  });
});

test("stop classes: off-script stops at 3, tooling (or no class) at 2", () => {
  expect([stopClass("off-script"), stopClass("tooling"), stopClass(""), stopClass(undefined), stopClass("off-script\n")]).toEqual(["off-script", "tooling", "tooling", "tooling", "off-script"]);
  expect(STOP_AFTER).toEqual({ tooling: 2, "off-script": 3 });
});
