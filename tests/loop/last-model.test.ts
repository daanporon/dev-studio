import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastEffort, lastModel } from "../../bin/loop/observers/state.ts";

const roots: string[] = [];
const mk = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const entry = (model: string) => JSON.stringify({ type: "assistant", message: { model } });

test("lastModel keeps the last real model past a trailing <synthetic> entry", () => {
  const p = join(mk("zzlm-"), "t.jsonl");
  writeFileSync(p, [entry("claude-sonnet-5-5"), entry("claude-opus-5-5"), entry("<synthetic>")].join("\n") + "\n");
  expect(lastModel(p)).toBe("claude-opus-5-5");
});

test("lastModel is null when only <synthetic> entries exist", () => {
  const p = join(mk("zzlm-"), "t.jsonl");
  writeFileSync(p, entry("<synthetic>") + "\n");
  expect(lastModel(p)).toBeNull();
});

test("entrypointOf reads the newest entrypoint line, null when none", async () => {
  const { entrypointOf } = await import("../../bin/loop/observers/state.ts");
  const p = join(mk("zzep-"), "t.jsonl");
  writeFileSync(p, [
    JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5" }, entrypoint: "cli" }),
    JSON.stringify({ type: "user", message: {}, entrypoint: "sdk-cli" }),
  ].join("\n") + "\n");
  expect(entrypointOf(p)).toBe("sdk-cli");
});

test("entrypointOf is null for a transcript with no entrypoint lines", async () => {
  const { entrypointOf } = await import("../../bin/loop/observers/state.ts");
  const p = join(mk("zzep-"), "t.jsonl");
  writeFileSync(p, JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5" } }) + "\n");
  expect(entrypointOf(p)).toBeNull();
});

test("U105: lastEffort follows the newest line that records perTurnEffort, null without the field", () => {
  const d = mk("zzle-");
  const line = (eff?: string) => JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5" }, ...(eff ? { perTurnEffort: eff } : {}) });
  const p = join(d, "t.jsonl");
  writeFileSync(p, [line("low"), line("medium"), line()].join("\n") + "\n");
  expect(lastEffort(p)).toBe("medium");
  const q = join(d, "u.jsonl");
  writeFileSync(q, [line(), line()].join("\n") + "\n");
  expect(lastEffort(q)).toBeNull();
  expect(lastEffort(join(d, "missing.jsonl"))).toBeNull();
});
