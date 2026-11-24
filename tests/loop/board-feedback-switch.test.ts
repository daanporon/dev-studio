// board-feedback-switch.test.ts — ds-feedback-github-issues U8: Settings → Limits shows `feedback` as an off|on
// select (off by default) and `feedback_repo` as a read-only override that names the repo in use.
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feedbackLine, feedbackSummary, limitsJson } from "../../bin/board/board-data.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { open } from "../../bin/loop/core/store.ts";

const ROOT = join(import.meta.dir, "..", "..");
const roots: string[] = [];
const saved = process.env.DS_FEEDBACK_ORIGIN;
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); if (saved === undefined) delete process.env.DS_FEEDBACK_ORIGIN; else process.env.DS_FEEDBACK_ORIGIN = saved; });

function rig() {
  const d = mkdtempSync(join(tmpdir(), "fbswitch-")); roots.push(d);
  const state = join(d, "state"), conv = join(d, "conv");
  mkdirSync(join(state, "p", "squads"), { recursive: true });
  cpSync(join(ROOT, "conventions"), conv, { recursive: true });
  const s = open(state);
  importConfig(s, state, conv);
  return { state, s };
}

test("limitsJson: feedback is an off|on select, feedback_repo is read-only and shows the repo in use", () => {
  process.env.DS_FEEDBACK_ORIGIN = "https://github.com/example-org/dev-studio.git";
  const { state, s } = rig();
  const row = (k: string) => (limitsJson("p", state).limits as any[]).find((l) => l.key === k);
  expect(row("feedback")).toMatchObject({ value: "off", allowed: ["off", "on"], fileOnly: false });
  expect(row("feedback_repo")).toMatchObject({ fileOnly: true });
  expect(row("feedback_repo").hint).toContain("Feedback is off");
  s.upsert("config", { project: "p", file: "limits.conf", key: "feedback" }, { value: "on", observed_at: 5_000_000_000 });
  expect(row("feedback").value).toBe("on");
  expect(row("feedback_repo").hint).toBe("in use: example-org/dev-studio");
  process.env.DS_FEEDBACK_ORIGIN = "https://gitlab.com/o/n.git";
  expect(row("feedback_repo").hint).toContain("not a GitHub repo");
  s.close();
});

test("the header facts and text line say why Feedback is not posting", () => {
  expect(feedbackLine({ ...feedbackSummary(null), notes: 2 })).toContain("off (turn Feedback on in Settings → Limits)");
  expect(feedbackLine({ ...feedbackSummary(null), switch: true, notes: 2 })).toContain("origin is not a GitHub repo");
});
