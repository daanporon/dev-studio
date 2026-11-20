import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flowFixture, FX_NOW } from "./flow-fixture.ts";

// U3: the Squads table's Units bar and the Work units list read the board's `flow` key.
// The page's own functions are cut out of web/board.html and run against the Flow fixture's board.json.
const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const cut = (name: string, kind = "function") => {
  const i = page.indexOf(`${kind} ${name}`);
  return page.slice(i, kind === "const" ? page.indexOf("\n", i) : page.indexOf("\n}\n", i) + 2);
};
const html = (strings: TemplateStringsArray, ...values: any[]) => ({ strings: strings.join("\u0000"), values });
const mod = new Function("html", `${cut("fmtSpan", "const")} ${cut("flowLabel")} const WORKING_NOT = ${page.match(/const WORKING_NOT = (\[.*?\]);/)![1]};
  ${cut("flowStats")} ${cut("stats")} ${cut("UnitsCell")} const suspendedLike = (s) => s.status === "suspended" || s.status === "on-hold";
  return { stats, UnitsCell, flowLabel, fmtSpan };`)(html);

const fx = flowFixture();
afterAll(() => fx.cleanup());
const flat = (v: any): string => v == null || v === false ? "" : typeof v === "string" || typeof v === "number" ? String(v)
  : Array.isArray(v) ? v.map(flat).join("") : !v.strings ? "" : v.strings.split("\u0000").map((p: string, i: number) => p + (i < v.values.length ? flat(v.values[i]) : "")).join("");
const text = (v: any) => flat(v).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

const board = fx.board();
const squad = board.squads.find((s: any) => s.topic === "flow");

test("the Flow fixture's squad reads like the mockup, in order", () => {
  const st = mod.stats(squad, board.flow);
  const t = text(mod.UnitsCell({ st }));
  const order = ["merged", "working", "stuck", "needs you", "ready", "last merge"].map((w) => t.indexOf(w)).filter((i) => i >= 0);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(st.stuck).toBe(board.flow.squads["fa/flow"].stuck);
  expect(st.needsYou).toBe(board.flow.squads["fa/flow"].needs_you);
  if (st.stuck) expect(t).toMatch(/\d+ stuck (<1m|\d+h?( \d+m)?)/);
  expect(t).toContain("last merge");
});

test("a stuck and a needs-you unit take a red and an amber segment out of working", () => {
  const units = Array.from({ length: 9 }, (_, i) => ({ slug: "u" + i, state: i < 3 ? "done" : i === 3 || i === 4 ? "working" : i === 5 || i === 6 ? "working" : "ready" }));
  const s = { label: "p", topic: "t", units, prs: [] };
  const flow = { squads: { "p/t": { stuck: 1, longest_stuck_s: 9600, needs_you: 1, last_merge_at: FX_NOW - 2400 } },
    cards: [{ project: "p", squad: "t", slug: "u3", stuck: true, needs_you: false }, { project: "p", squad: "t", slug: "u4", stuck: false, needs_you: true }] };
  const st = mod.stats(s, flow);
  const v = mod.UnitsCell({ st });
  const nums = v.values.slice(0, 5).map((x: any) => x.width as string);
  const pct = (x: string) => parseFloat(x);
  expect(nums.map((x: string) => Math.round(pct(x) * 9 / 100))).toEqual([3, 2, 1, 1, 2]);
  expect(text(v)).toContain("3/9 merged · 2 working · 1 stuck 2h 40m · 1 needs you · 2 ready");
  expect(pct(nums[0]) + pct(nums[1]) + pct(nums[2]) + pct(nums[3]) + pct(nums[4])).toBeLessThanOrEqual(100.0001);
  expect(st.barStuck).toBe(1);
  expect(st.barNeeds).toBe(1);
});

test("a squad with no merges shows no last merge", () => {
  const s = { label: "p", topic: "t", units: [{ slug: "a", state: "working" }], prs: [] };
  const flow = { squads: { "p/t": { stuck: 0, longest_stuck_s: null, needs_you: 0, last_merge_at: null } }, cards: [] };
  expect(text(mod.UnitsCell({ st: mod.stats(s, flow) }))).not.toContain("last merge");
});

test("an archived row and a squad with no flow entry render as today", () => {
  expect(text(mod.UnitsCell({ st: { total: 4, merged: 4 } }))).toBe("4/4 merged");
  const s = { label: "p", topic: "paused", units: [{ slug: "a", state: "working" }, { slug: "b", state: "done" }], prs: [] };
  const withFlow = text(mod.UnitsCell({ st: mod.stats(s, { squads: {}, cards: [] }) }));
  expect(withFlow).toBe(text(mod.UnitsCell({ st: mod.stats(s, undefined) })));
  expect(withFlow).toBe("1/2 merged · 1 working");
});

test("each Work units row gets its card's group or stage and its time in stage", () => {
  expect(mod.flowLabel({ stage: "building", group: "fixing findings", in_stage_s: 540 })).toBe("fixing findings · 9m");
  expect(mod.flowLabel({ stage: "building", group: "coding", in_stage_s: 26 * 60 })).toBe("coding · 26m");
  expect(mod.flowLabel({ stage: "needs_you", group: null, in_stage_s: 3600 })).toBe("needs you · 1h");
  expect(mod.flowLabel({ stage: "merging", group: null, in_stage_s: null })).toBe("merging");
  expect(mod.flowLabel(undefined)).toBe("");
  // every open unit of the fixture's squad has a card, keyed <label>/<topic>/<slug>
  for (const c of board.flow.cards.filter((c: any) => c.squad === "flow")) expect(c.key).toBe(`${c.project}/${c.squad}/${c.slug}`);
});
