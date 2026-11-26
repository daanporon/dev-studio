import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { headerSummary } from "../../bin/board/board-data.ts";
import { flowFixture, FX_NOW } from "./flow-fixture.ts";

// U3: the Squads table's Units bar and the Work units list read the board's `flow` key.
// The page's own functions are cut out of web/board.html and run against the Flow fixture's board.json.
const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const cut = (name: string, kind = "function") => {
  const i = page.indexOf(`${kind} ${name}`);
  return page.slice(i, kind === "const" ? page.indexOf("\n", i) : page.indexOf("\n}\n", i) + 2);
};
const html = (strings: TemplateStringsArray, ...values: any[]) => ({ strings: strings.join("\u0000"), values });
const mod = new Function("html", `${cut("fmtSpan", "const")} ${cut("flowLabel")} const STOPPED = ${page.match(/const STOPPED = (\[.*?\]);/)![1]};
  ${cut("flowStats")} ${cut("segmentOf")} ${cut("stats")} ${cut("UnitsCell")} ${cut("flowTiles")} ${cut("unitsLeftDetail", "const")}
  ${cut("UNIT_KEY", "const")} ${cut("UnitKey")} const suspendedLike = (s) => s.status === "suspended" || s.status === "on-hold";
  return { stats, UnitsCell, flowLabel, fmtSpan, flowTiles, unitsLeftDetail, UnitKey };`)(html);

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
  const order = ["merged", "working", "stuck", "needs you", "queued", "last merge"].map((w) => t.indexOf(w)).filter((i) => i >= 0);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(st.stuck).toBe(board.flow.squads["fa/flow"].stuck);
  expect(st.needsYou).toBe(board.flow.squads["fa/flow"].needs_you);
  if (st.stuck) expect(t).toMatch(/\d+ stuck (<1m|\d+h?( \d+m)?)/);
  expect(t).toContain("last merge");
});

// The bar's widths in bar order, as unit counts: merged, working, stuck, needs you, stopped, parked, queued.
const widths = (v: any, total: number) => v.values.slice(0, 7).map((x: any) => Math.round(parseFloat(x.width) * total / 100));

test("a stuck and a needs-you unit take a red and an amber segment out of working", () => {
  const units = Array.from({ length: 9 }, (_, i) => ({ slug: "u" + i, state: i < 3 ? "done" : i < 7 ? "working" : "ready" }));
  const s = { label: "p", topic: "t", units, prs: [] };
  const flow = { squads: { "p/t": { stuck: 1, longest_stuck_s: 9600, needs_you: 1, last_merge_at: FX_NOW - 2400 } },
    cards: [{ project: "p", squad: "t", slug: "u3", stuck: true, needs_you: false }, { project: "p", squad: "t", slug: "u4", stuck: false, needs_you: true }] };
  const st = mod.stats(s, flow);
  const v = mod.UnitsCell({ st });
  expect(widths(v, 9)).toEqual([3, 2, 1, 1, 0, 0, 2]);
  expect(text(v)).toContain("3 of 9 merged · 2 working · 1 stuck 2h 40m · 1 needs you · 2 queued");
});

test("every unit sits in one segment, and the count line follows the bar's order", () => {
  const u = (slug: string, state: string, parked: string | null = null) => ({ slug, state, parked });
  const units = [u("a", "done"), u("b", "building"), u("c", "gone"), u("d", "paused"), u("e", "gone"),
    u("f", "held", "held"), u("g", "blocked", "behind"), u("h", "blocked", "behind"), u("i", "ready", "held"),
    u("j", "ready"), u("k", "blocked"), u("l", "waiting"), u("m", "cancelled"), u("n", "waiting")];
  // e is stale with its Builder gone: the stuck flag wins. l is a Lead hold (a paused card). n asks a question.
  const flow = { squads: { "p/t": { stuck: 1, longest_stuck_s: 7200, needs_you: 1, last_merge_at: null } },
    cards: [{ project: "p", squad: "t", slug: "e", stuck: true }, { project: "p", squad: "t", slug: "l", paused: true },
      { project: "p", squad: "t", slug: "n", needs_you: true }] };
  const st = mod.stats({ label: "p", topic: "t", units, prs: [] }, flow);
  const v = mod.UnitsCell({ st });
  expect(st.total).toBe(13);
  expect(widths(v, 13)).toEqual([1, 1, 1, 1, 3, 4, 2]);
  expect(v.values.slice(0, 7).reduce((n: number, x: any) => n + parseFloat(x.width), 0)).toBeCloseTo(100);
  expect(text(v)).toBe("1 of 13 merged · 1 working · 1 stuck 2h · 1 needs you · 3 stopped · 1 gone · 4 parked (2 held, 2 behind them) · 2 queued");
});

test("parked units that are all themselves held have no bracket", () => {
  const st = mod.stats({ label: "p", topic: "t", prs: [], units: [{ slug: "a", state: "held", parked: "held" }, { slug: "b", state: "done" }] }, undefined);
  expect(text(mod.UnitsCell({ st }))).toBe("1 of 2 merged · 1 parked");
});

test("the key line names all seven fills", () => {
  const t = text(mod.UnitKey());
  expect(t).toBe("solid: started · striped: not started yet · merged · working · stuck · needs you · stopped · parked: waits on you (Release, or approve the plan) · queued: starts by itself");
});

test("the Units left detail puts every card the number counts in one group", () => {
  const card = (stage: string, o: any = {}) => ({ stage, group: null, ...o });
  const cards = [card("building"), card("pr_open"), card("queued", { group: "waiting for a slot" }),
    card("queued", { group: "waiting on another unit" }), // blocked on a working unit
    card("queued", { group: "held", parked: "held" }),
    card("queued", { group: "waiting on another unit", parked: "behind" }), // blocked behind a held unit
    card("building", { paused: true }), card("queued", { group: "held" }), card("building", { stopped: true })];
  const c = { queued: 5, building: 2, pr_open: 1, needs_you: 0, merging: 0, paused: 1 };
  const t = mod.flowTiles({ counts: c, cards });
  expect(t.left).toBe(9);
  expect(t.groups).toEqual({ working: 2, queued: 2, parked: 2, stopped: 3 });
  expect(Object.values(t.groups as Record<string, number>).reduce((n, x) => n + x, 0)).toBe(t.left);
  expect(mod.unitsLeftDetail(2, t.groups)).toBe("2 squads · 2 working · 2 parked · 3 stopped · 2 queued");
  expect(mod.unitsLeftDetail(1, { working: 0, queued: 0, parked: 4, stopped: 0 })).toBe("1 squad · 4 parked");
  expect(mod.unitsLeftDetail(1, { working: 0, queued: 3, parked: 0, stopped: 0 })).toBe("1 squad · 3 queued");
});

test("the header's groups without the Flow sum to Units left", () => {
  const units = [{ state: "working" }, { state: "ready" }, { state: "blocked" }, { state: "held", parked: "held" },
    { state: "blocked", parked: "behind" }, { state: "paused" }, { state: "done" }, { state: "cancelled" }];
  const h: any = headerSummary(null, "p", [{ status: "running", units }], [], null);
  expect(h).toMatchObject({ units_left: 6, units_working: 1, units_queued: 2, units_parked: 2, units_stopped: 1, ready_units: 1 });
  expect(h.units_working + h.units_queued + h.units_parked + h.units_stopped).toBe(h.units_left);
});

test("a squad with no merges shows no last merge", () => {
  const s = { label: "p", topic: "t", units: [{ slug: "a", state: "working" }], prs: [] };
  const flow = { squads: { "p/t": { stuck: 0, longest_stuck_s: null, needs_you: 0, last_merge_at: null } }, cards: [] };
  expect(text(mod.UnitsCell({ st: mod.stats(s, flow) }))).not.toContain("last merge");
});

test("an archived row and a squad with no flow entry render as today", () => {
  expect(text(mod.UnitsCell({ st: { total: 4, merged: 4 } }))).toBe("4 of 4 merged");
  const s = { label: "p", topic: "paused", units: [{ slug: "a", state: "working" }, { slug: "b", state: "done" }], prs: [] };
  const withFlow = text(mod.UnitsCell({ st: mod.stats(s, { squads: {}, cards: [] }) }));
  expect(withFlow).toBe(text(mod.UnitsCell({ st: mod.stats(s, undefined) })));
  expect(withFlow).toBe("1 of 2 merged · 1 working");
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
