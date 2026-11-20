import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
const lib = new Function(`${cut("fbRows")} ${cut("fbStr")} ${cut("pipelineOf")} ${cut("normalizeSteps")} ${cut("draftOfPipeline")} async ${cut("saveRoleRows")} return { fbRows, fbStr, pipelineOf, normalizeSteps, draftOfPipeline, saveRoleRows };`)();
const role = { agent: "claude", model: "opus", effort: "high", fallbacks: "codex:gpt-5:low,claude:sonnet" };

test("a role with fallbacks shows its own model first and the fallbacks after", () => {
  expect(lib.pipelineOf(role).map((s: any) => s.agent + ":" + s.model + ":" + s.effort)).toEqual(["claude:opus:high", "codex:gpt-5:low", "claude:sonnet:high"]);
});
test("a role with no fallbacks shows one step", () => {
  expect(lib.pipelineOf({ ...role, fallbacks: "" })).toHaveLength(1);
});
test("moving a fallback to first swaps it with the role's own model and saves in screen order", () => {
  const steps = lib.pipelineOf(role);
  [steps[0], steps[1]] = [steps[1], steps[0]];
  expect(lib.draftOfPipeline(steps)).toEqual({ agent: "codex", model: "gpt-5", effort: "low", plan: "", fallbacks: "claude:opus:high,claude:sonnet:high" });
  // round trip: what is saved reads back in the same order
  expect(lib.pipelineOf(lib.draftOfPipeline(steps))).toEqual(steps);
});
test("the pipeline control keeps one step and the page offers up, down, remove, add", () => {
  expect(page).toContain('disabled=${steps.length === 1}');
  for (const t of ['title="up"', 'title="down"', 'title="remove"', "+ add step"]) expect(page).toContain(t);
});
test("Save is disabled and reads Saving… from the click, and a second press is ignored", () => {
  const i = page.indexOf("const saveAll = async () => {\n    if (savingRef.current) return;\n    savingRef.current = true; setSaving(true);");
  expect(i).toBeGreaterThan(0);
  expect(page).toContain('saving ? "Saving…"');
  expect(page).toContain("|| saving}");
});
test("rows are filed together, each once; a refused row keeps its error while the others clear", async () => {
  const filed: string[] = [], results: Record<string, string | null> = {};
  const post = async (role: string) => { filed.push(role); return { id: role }; };
  const refusal = async (b: any) => (b.id === "bad" ? "no such model" : null);
  const r = await lib.saveRoleRows([{ role: "a", body: {} }, { role: "bad", body: {} }, { role: "c", body: {} }], post, refusal, (role: string, err: string | null) => { results[role] = err; });
  expect(filed.sort()).toEqual(["a", "bad", "c"]);
  expect(results).toEqual({ a: null, bad: "no such model", c: null });
  expect(r).toEqual({ ok: 2, failed: ["bad"] });
});
test("a post that throws fails only its row", async () => {
  const results: Record<string, string | null> = {};
  const r = await lib.saveRoleRows([{ role: "a", body: {} }, { role: "b", body: {} }], async (role: string) => { if (role === "a") throw new Error("HTTP 500"); return {}; }, async () => null, (role: string, err: string | null) => { results[role] = err; });
  expect(results).toEqual({ a: "HTTP 500", b: null });
  expect(r.failed).toEqual(["a"]);
});
test("moving a same-agent fallback first keeps the effort it ran at, and nothing silently changes", () => {
  const steps = lib.pipelineOf({ agent: "claude", model: "opus", effort: "high", fallbacks: "claude:sonnet" });
  expect(steps[1].effort).toBe("high");
  const swapped = [steps[1], steps[0]];
  expect(lib.draftOfPipeline(swapped)).toEqual({ agent: "claude", model: "sonnet", effort: "high", plan: "", fallbacks: "claude:opus:high" });
  expect(lib.normalizeSteps(swapped)).toEqual(swapped);
});
test("a same-agent step left at default takes the first step's effort, so shown equals saved", () => {
  const steps = [{ agent: "claude", model: "sonnet", effort: "high" }, { agent: "claude", model: "opus", effort: "default" }, { agent: "codex", model: "gpt-5", effort: "default" }];
  expect(lib.normalizeSteps(steps).map((s: any) => s.effort)).toEqual(["high", "high", "default"]);
  expect(lib.normalizeSteps([{ agent: "claude", model: "a", effort: "default" }, { agent: "claude", model: "b", effort: "default" }])).toHaveLength(2);
});
test("adding a step on an effortful role lands at the effort it will run at, and survives a save round trip", () => {
  const d = { agent: "claude", model: "opus", effort: "high", fallbacks: "" };
  const next = lib.draftOfPipeline(lib.normalizeSteps([...lib.pipelineOf(d), { agent: "claude", model: "fable", effort: "default" }]));
  expect(next.fallbacks).toBe("claude:fable:high");
  expect(lib.pipelineOf(next).map((s: any) => s.effort)).toEqual(["high", "high"]);
});
test("the page runs every edit through normalizeSteps", () => {
  expect(page).toContain("draftOfPipeline(normalizeSteps(next))");
});

 test("plans survive reorder and serialization, including a plan with default effort", () => {
  const steps = lib.pipelineOf({ agent: "claude", model: "opus", plan: "Max", fallbacks: "claude:opus:-:Ultra" });
  expect(steps.map((s: any) => s.plan)).toEqual(["Max", "Ultra"]);
  const d = lib.draftOfPipeline([steps[1], steps[0]]);
  expect(d.plan).toBe("Ultra"); expect(d.fallbacks).toBe("claude:opus:-:Max");
  expect(lib.pipelineOf(d).map((s: any) => s.plan)).toEqual(["Ultra", "Max"]);
 });
test("U131: one summary line per role, a plan picker on every step, folded help, pinned Save", () => {
  expect(page).toContain('class="rt-help"');
  expect(page).toContain("rt-save");
  expect(page).toContain("ROLE_GROUPS");
  expect(page).not.toContain("data.plans?.[r.agent] || []).length > 1");
  expect(page).toContain("aria-expanded=${isOpen}");
  expect(page).toContain("const isOpen = dirty || !!msg[x.role]");
});

test("U282: review-leaf renders in the Review group right after builder-review-standard", () => {
  expect(page).toMatch(/"builder-review-standard", "review-leaf", "reviewer"\]/);
  const data = readFileSync(join(import.meta.dir, "..", "..", "bin", "board", "board-data.ts"), "utf8");
  expect(data).toMatch(/"builder-review-standard", "review-leaf", "reviewer"/);
});

// U151: the crew row's wish text — the effective state unless running, then each pending one-time
// wish with its age and author.
const wishLib = new Function(`const fmtAge = ${page.match(/const fmtAge = ([^\n]+);/)![1]}; ${cut("wishText")} return { wishText };`)();
test("the crew row shows a member's own wish and every pending wish with age and author", () => {
  expect(wishLib.wishText(null)).toBe("");
  expect(wishLib.wishText({ state: "running", own: "running", pending: [] })).toBe("");
  // A pause or suspension is not the member's own wish: the pause label shows it.
  expect(wishLib.wishText({ state: "suspended", own: "running", pending: [] })).toBe("");
  expect(wishLib.wishText({ state: "stopped", own: "stopped", pending: [
    { wish: "restart", mode: "idle", age_s: 300, by: "op" }, { wish: "reload", age_s: 20, by: null }, { wish: "clear", age_s: 4 * 3600, by: "lead" }] }))
    .toBe("wants stopped · restart idle 5m by op · reload <1m by someone · clear 4h by lead");
  expect(page).toContain("wishText(m.wish)");
});
