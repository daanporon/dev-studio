// The Flow section of web/board.html (U2), rendered on U1's Flow fixture. The components are cut out of
// the page and run with a fake `html` tag (a {str, values} tree), fake hooks and a fake lstore, like the
// other board-*-page tests.
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FX_NOW, flowFixture } from "./flow-fixture.ts";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const a = page.indexOf("// ---- Flow section (U2)"), b = page.indexOf("// The users of one account", a);
const src = page.slice(a, b);
const html = (strings: TemplateStringsArray, ...values: any[]) => ({ str: strings.join("\u0000"), values });

function lstoreOf(init: Record<string, any> = {}) {
  const m = new Map(Object.entries(init)), writes: [string, any][] = [];
  return { m, writes, get: (k: string, d: any) => (m.has(k) ? m.get(k) : d), set: (k: string, v: any) => { m.set(k, v); writes.push([k, v]); } };
}
const lib: any = new Function("useState", "useEffect", "useMemo", "useRef", "html", "document", "setTimeout", "window",
  `${src} return { FlowCard, flowGroupLabel, FlowSection, movedKeys, visibleCards, flowGroups, dayBars, flowTiles, flowSummary, flowDur };`);
const opened: any[][] = [], win = { open: (...a: any[]) => { opened.push(a); } };
const hooks = () => {
  const effects: (() => void)[] = [];
  return { effects, args: [(i: any) => [typeof i === "function" ? i() : i, () => {}], (f: () => void) => { effects.push(f); },
    (f: () => any) => f(), (v: any) => ({ current: v }), html, { getElementById: () => null }, () => 0, win] };
};
const L = (h = hooks()) => ({ h, ...lib(...h.args) });

// All text of a view, depth first; functions and style objects are skipped.
const text = (v: any): string => Array.isArray(v) ? v.map(text).join("") : v && typeof v === "object" && "str" in v
  ? v.str.split("\u0000").map((s: string, i: number) => s + (i < v.values.length ? text(v.values[i]) : "")).join("") : typeof v === "string" || typeof v === "number" ? String(v) : "";
const nodes = (v: any): any[] => Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === "object" && "str" in v ? [v, ...v.values.flatMap(nodes)] : [];
const click = (n: any) => n.values.find((x: any) => typeof x === "function")();

const fx = flowFixture();
afterAll(() => fx.cleanup());
const flow = fx.board().flow;
const render = (o: any = {}, store = lstoreOf()) => {
  const l = L();
  const view = l.FlowSection({ flow, lstore: store, focus: null, onOpen: () => {}, now: FX_NOW, showProject: false, ...o });
  return { ...l, view, store };
};
const col = (view: any, stage: string) => nodes(view).find((n) => String(n.values[0]).startsWith("flow-col") && n.values.includes("flow-col-" + stage));

test("1. collapsed, the summary line carries flow.counts", () => {
  const { view } = render({}, lstoreOf({ "b:flow": false }));
  const c = flow.counts;
  expect(text(view)).toContain(`${c.queued} queued · ${c.building} building · ${c.pr_open} PR open · ${c.merging} merging · ${c.stuck} stuck${c.slow ? ` · ${c.slow} slow` : ""} · ${c.needs_you} needs you · ${c.merged_today} merged today`);
  expect(view.values[0]).toBe(false);   // details open=false
});

test("2. open state is read from and written to b:flow", () => {
  const store = lstoreOf({ "b:flow": false });
  const { view } = render({}, store);
  expect(view.values[0]).toBe(false);
  const toggle = view.values.find((x: any) => typeof x === "function");
  toggle({ currentTarget: { open: true } });
  expect(store.writes).toContainEqual(["b:flow", true]);
  expect(render({}, lstoreOf()).view.values[0]).toBe(true);
});

test("3. Building and PR open render their groups in KD3 order; Queued has no fold buttons", () => {
  const { view, flowGroups } = render();
  const building = text(col(view, "building"));
  const bOrder = ["coding", "reviewing", "fixing findings", "review stopped"];
  expect(bOrder.map((g) => building.indexOf(g)).every((i, k, all) => i >= 0 && (k === 0 || i > all[k - 1]))).toBe(true);
  expect(flowGroups(flow.cards.filter((c: any) => c.stage === "building" && c.group !== "reviewing"), "building").map((x: any) => x.group))
    .toEqual(["coding", "fixing findings", "review stopped"]);
  const pr = text(col(view, "pr_open"));
  expect(["draft", "checks running", "checks failing", "in review", "blocked"].map((g) => pr.indexOf(g)).every((i, k, all) => i >= 0 && (k === 0 || i > all[k - 1]))).toBe(true);
  const { visibleCards } = L();
  const cards = [{ key: "a", stuck: false, needs_you: false }, { key: "b", stuck: true, needs_you: false }, { key: "c", stuck: false, needs_you: true }];
  expect(visibleCards(cards, true).map((c: any) => c.key)).toEqual(["b", "c"]);
  expect(visibleCards(cards, false)).toHaveLength(3);
  // U6 scenario 9: Queued has no fold buttons (only the not-ready toggle), Building still does
  expect(nodes(col(view, "queued")).filter((n) => n.str.includes('class="fgrp" aria-expanded=${f}'))).toHaveLength(0);
  expect(nodes(col(view, "building")).filter((n) => n.str.includes('class="fgrp"')).length).toBeGreaterThan(0);
});

test("4. toggling a Building group writes its fold key, and a later render keeps it", () => {
  const store = lstoreOf();
  const { view } = render({}, store);
  click(nodes(col(view, "building")).find((n) => n.str.includes('class="fgrp"')));
  expect(store.writes).toContainEqual(["b:flow:fold:building:coding", true]);
  expect(text(col(render({}, store).view, "building"))).toContain("▸ coding");
});

test("5. Merged column: 3 newest, show all, and the 7-day window", () => {
  const day = flow.merged.filter((m: any) => m.at >= FX_NOW - 86400);
  const week = flow.merged;
  expect(week.length).toBeGreaterThan(day.length);
  const r = render({}, lstoreOf({ "b:flow:merged": "24h" }));
  const m = col(r.view, "merged");
  const cardsIn = (c: any) => nodes(c).filter((n) => n.values.includes("fcard merged"));
  expect(cardsIn(m)).toHaveLength(Math.min(3, day.length));
  expect(text(m)).toContain("took ");
  expect(text(m)).toContain(" ago");
  const r7 = render({}, lstoreOf({ "b:flow:merged": "7d" }));
  expect(text(col(r7.view, "merged"))).toContain(String(week.length));
  if (week.length > 3) expect(text(col(r7.view, "merged"))).toContain("show all " + week.length);
  expect(cardsIn(col(r7.view, "merged"))).toHaveLength(3);
});

test("6. chart: 8 bars by default, 30 on toggle; today's bar is merged plus open-PR cap", () => {
  const { dayBars, view } = render();
  const b8 = dayBars(flow.per_day, 8, flow.counts.open_prs);
  expect(b8).toHaveLength(8);
  expect(dayBars(flow.per_day, 30, flow.counts.open_prs)).toHaveLength(30);
  const today = b8[7], max = Math.max(...b8.map((x: any) => x.merged + x.cap));
  expect(today.merged).toBe(flow.per_day[flow.per_day.length - 1].merged);
  expect(today.cap).toBe(flow.counts.open_prs);
  expect(today.mh).toBeCloseTo(today.merged / max * 100);
  expect(today.ch).toBeCloseTo(flow.counts.open_prs / max * 100);
  expect(b8.slice(0, 7).every((x: any) => x.cap === 0)).toBe(true);
  const bars = (v: any) => nodes(v).filter((n) => /^fbar( |$)/.test(String(n.values[1] ?? "")));
  expect(bars(view)).toHaveLength(8);
  const store = lstoreOf({ "b:flow:days": 30 });
  expect(bars(render({}, store).view)).toHaveLength(30);
  const t = text(view);
  expect(t).toContain(`today ${flow.per_day[29].merged} merged + ${flow.counts.open_prs} PRs open`);
  expect(t).toContain("median dispatch → merge " + render().flowDur(flow.median_total_s));
});

test("7. squad filter narrows the columns; the summary numbers stay", () => {
  const squads = [...new Set(flow.cards.map((c: any) => c.project + "/" + c.squad))];
  // the fake useState can't change state, so drive the filter through its initial value is not possible:
  // render with a filter chip clicked by replaying the component with a stateful useState
  const states: any[] = [];
  let i = 0;
  const stateful = (init: any) => { const k = i++; if (!(k in states)) states[k] = typeof init === "function" ? init() : init; return [states[k], (v: any) => { states[k] = typeof v === "function" ? v(states[k]) : v; }]; };
  const h = hooks();
  const lib2: any = new Function("useState", "useEffect", "useMemo", "useRef", "html", "document", "setTimeout", `${src} return { FlowSection };`);
  const draw = () => { i = 0; return lib2(stateful, h.args[1], h.args[2], h.args[3], html, h.args[5], h.args[6]).FlowSection({ flow, lstore: lstoreOf(), focus: null, onAsk: () => {}, now: FX_NOW, showProject: true }); };
  const first = draw();
  const chips = nodes(first).filter((n) => /^fchip/.test(String(n.values[1] ?? ""))), mineChip = chips.find((n) => n.values[n.values.length - 1] === "flow");
  expect(mineChip).toBeTruthy();
  const all = text(col(first, "building"));
  click(mineChip);
  const filtered = draw();
  expect(text(col(filtered, "building"))).toContain("u2-building");
  // fb has one Building card: narrowing to the fa squad removes it
  const fbCard = flow.cards.find((c: any) => c.project !== "fa");
  if (fbCard) expect(text(col(filtered, fbCard.stage))).not.toContain(fbCard.slug);
  expect(text(filtered)).toContain(`${flow.counts.queued} queued`);
  expect(squads.length).toBeGreaterThan(0);
  expect(all.length).toBeGreaterThan(0);
});

test("8. movedKeys: a stage change is returned; a group change and the first payload are not", () => {
  const { movedKeys } = L();
  const cards = [{ key: "a", stage: "building", group: "coding" }, { key: "b", stage: "pr_open", group: "in review" }, { key: "c", stage: "queued", group: "held" }];
  expect(movedKeys(null, cards).size).toBe(0);
  const prev = new Map([["a", "queued"], ["b", "pr_open"]]);   // a moved, b stayed (its group may have changed), c is new
  expect([...movedKeys(prev, cards)]).toEqual(["a"]);
  // the section marks that card
  const l = L();
  const draw = (prevMap: any) => { const h = hooks(); h.args[3] = () => ({ current: prevMap });
    return new Function("useState", "useEffect", "useMemo", "useRef", "html", "document", "setTimeout", `${src} return { FlowSection };`)(...h.args).FlowSection({ flow: { ...flow, cards: [{ ...flow.cards.find((c: any) => c.stage === "building"), key: "k" }] }, lstore: lstoreOf(), focus: null, onAsk: () => {}, now: FX_NOW }); };
  expect(text(draw(new Map([["k", "queued"]])))).toContain("moved");
  expect(text(draw(new Map([["k", "building"]])))).not.toContain(" moved");
  expect(l.movedKeys).toBeTruthy();
});

test("9. tiles take the Flow's counts, and a click targets the column", () => {
  const { flowTiles } = L();
  const t = flowTiles(flow), c = flow.counts;
  expect(t.builders).toBe(c.building);
  expect(t.left).toBe(c.queued + c.building + c.pr_open + c.needs_you + c.merging);
  expect(t.left).toBe(fx.board().header.units_left);
  expect(t.prs).toBe(c.open_prs);
  expect(t.prsDetail).toBe("5 PR open · 1 merging · 1 needs you");
  expect(t.prsStage).toBe("pr_open");
  // the page wires them to flow-col-building / queued / pr_open
  expect(page).toContain('openFlow("building")');
  expect(page).toContain('openFlow("queued")');
  expect(page).toContain("openFlow(FT.prsStage)");
  // a focus opens the section and scrolls to the column
  const store = lstoreOf({ "b:flow": false }), scrolled: string[] = [];
  const h = hooks();
  h.args[5] = { getElementById: (id: string) => ({ scrollIntoView: () => scrolled.push(id) }) };
  h.args[6] = (f: () => void) => f();
  const l = new Function("useState", "useEffect", "useMemo", "useRef", "html", "document", "setTimeout", `${src} return { FlowSection };`)(...h.args);
  l.FlowSection({ flow, lstore: store, focus: { stage: "pr_open", n: 1 }, onAsk: () => {}, now: FX_NOW });
  h.effects.forEach((f) => f());
  expect(store.writes).toContainEqual(["b:flow", true]);
  expect(scrolled).toEqual(["flow-col-pr_open"]);
  for (const [st] of [["queued"], ["building"], ["pr_open"], ["needs_you"], ["merging"], ["merged"]]) expect(col(render().view, st)).toBeTruthy();
});

test("9b. the summary adds up to Units left; the PRs tile splits its count and opens the first non-empty column", () => {
  const { flowTiles, flowSummary } = L(), c = flow.counts;
  const n = (s: string) => Number(flowSummary(c).match(new RegExp(`(\\d+) ${s}`))![1]);
  expect(n("queued") + n("building") + n("PR open") + n("merging") + n("needs you")).toBe(fx.board().header.units_left);
  const card = (stage: string, open_pr = true) => ({ stage, open_pr, pr: { status: open_pr ? "open" : "merged" } });
  const tile = (cards: any[]) => flowTiles({ counts: { ...c, open_prs: cards.filter((x) => x.open_pr).length }, cards });
  expect(tile([card("merging")])).toMatchObject({ prs: 1, prsDetail: "1 merging", prsStage: "merging" });
  expect(tile([card("pr_open"), card("pr_open"), card("merging")])).toMatchObject({ prs: 3, prsDetail: "2 PR open · 1 merging", prsStage: "pr_open" });
  expect(tile([card("needs_you")])).toMatchObject({ prsDetail: "1 needs you", prsStage: "needs_you" });
  expect(tile([card("merging", false)])).toMatchObject({ prs: 0, prsDetail: "no PRs open", prsStage: "pr_open" });
});

test("10. in the page markup the Flow sits after Squads and before Accounts", () => {
  const i = page.indexOf('id="squads"'), j = page.indexOf("<${FlowSection}"), k = page.indexOf('id="accounts"', j);
  expect(i).toBeGreaterThan(0);
  expect(j).toBeGreaterThan(i);
  expect(k).toBeGreaterThan(j);
  expect(src).toContain('id="flow"');
});

test("11. a board.json without flow has no Flow, and the tiles fall back to header", () => {
  expect(L().flowTiles(undefined)).toBeNull();
  expect(L().flowTiles({})).toBeNull();
  expect(page).toContain("${data.flow && html`<${FlowSection}");
  expect(page).toContain("FT ? FT.builders : H.builders_working");
});

test("12. with only coding cards in Building, one group header renders", () => {
  const only = { ...flow, cards: flow.cards.filter((c: any) => c.stage !== "building" || c.group === "coding") };
  const headers = nodes(col(render({ flow: only }).view, "building")).filter((n) => n.str.includes('class="fgrp"'));
  expect(headers).toHaveLength(1);
});

test("a stuck card reads in text: time and a multiple of the typical time, or why", () => {
  const { view } = render({}, lstoreOf());
  const t = text(col(view, "building"));
  expect(t).toMatch(/\d+m/);
  expect(t).toMatch(/× typical|stuck · no Builder/);
  expect(t).not.toContain("stale");
  const slow = flow.cards.find((c: any) => c.slug === "u19-slow");
  expect(text(col(view, "building"))).toContain("u19-slow");
  expect(slow.stuck).toBe(false);   // a review runs: late, but its Builder is at work
  expect(slow.slow).toBe(true);
});

test("U279. a slow card has an amber class and says slow · n× typical · working; a stuck one is red", () => {
  const fc = (c: any) => L().FlowCard({ card: c, typicalS: null, moved: false, onAsk: () => {}, showProject: false });
  const s = fc(card({ slow: true, stage: "building", in_stage_s: 3000, typical_s: 1200, active_at: null }));
  expect(s.values[0]).toContain("slow");
  expect(s.values[0]).not.toContain("stuck");
  expect(text(s)).toContain("slow · 2.5× typical · working");
  const old = fc(card({ slow: true, stage: "building", in_stage_s: 3000, typical_s: 1200, active_at: Date.now() / 1000 - 600 }));
  expect(text(old)).toContain("output 10m ago");
  const red = fc(card({ stuck: true, stage: "building", in_stage_s: 3000 }));
  expect(red.values[0]).toContain("stuck");
  expect(text(red)).not.toContain("slow ·");
});

test("U279. a folded Flow keeps stuck and needs-you cards, not slow ones", () => {
  const cards = [{ key: "a", slow: true }, { key: "b", stuck: true }, { key: "c", needs_you: true }];
  expect(L().visibleCards(cards, true).map((c: any) => c.key)).toEqual(["b", "c"]);
});

// The squad row: "N slow" in amber beside "N stuck" in red (UnitsCell's bits, cut out of the page).
const sa = page.indexOf("function flowStats("), sb = page.indexOf("function UnitsCell(");
const sc = page.indexOf("\n}\n", sb);
const rowLib: any = new Function("html", "fmtTok", "dayOf", `${page.slice(sa, sc + 3)} return { flowStats, UnitsCell };`);
test("U279. a squad row with one slow and one stuck card shows 1 slow in amber and 1 stuck in red", () => {
  const rl = rowLib(html, String, String);
  const f = { squads: { "p/s": { stuck: 1, slow: 1, longest_stuck_s: 600, needs_you: 0, last_merge_at: null } },
    cards: [{ project: "p", squad: "s", slug: "a", stuck: true }, { project: "p", squad: "s", slug: "b", slow: true }] };
  const st = rl.flowStats({ label: "p", topic: "s" }, f, [{ slug: "a", state: "working" }, { slug: "b", state: "working" }]);
  expect(st).toMatchObject({ stuck: 1, slow: 1 });
  const v = rl.UnitsCell({ st: { total: 4, merged: 2, seg: { merged: 2, working: 1, stuck: 1 }, ...st } });
  const bits = nodes(v).filter((n) => n.str.includes('class="bad"') || n.str.includes('class="warn"'));
  expect(bits.map((n) => [n.str.includes("bad") ? "red" : "amber", text(n).replace(/<[^>]+>/g, "")])).toEqual([["red", "1 stuck 10m"], ["amber", "1 slow"]]);
});

// ---- U5: card links and group headers
const card = (o: any = {}) => ({ key: "p/s/u", project: "p", squad: "s", slug: "u", stage: "pr_open", group: null, in_stage_s: 60, stuck: false, needs_you: false, ask: null, note: null, pr: null, ...o });
const fcard = (c: any, onOpen: any = () => {}) => L().FlowCard({ card: c, typicalS: null, moved: false, onOpen, showProject: false });
const root = (v: any) => v.values.filter((x: any) => typeof x === "function");

// crew-terminal-access U6: every card opens the window; the card never opens the PR or the question itself.
test("U6-1. a card with a PR is a dialog button: click, Enter and Space open the window, not the PR", () => {
  opened.length = 0; const got: string[] = [];
  const v = fcard(card({ pr: { num: "7", url: "https://github.com/o/r/pull/7" } }), (x: any) => got.push(x.key));
  expect(v.str).toContain('role="button"'); expect(v.str).toContain('aria-haspopup="dialog"'); expect(v.values).toContain(0);
  expect(v.values).not.toContain("link");
  const [clk, key] = root(v);
  clk(); key({ key: "Enter", target: 1, currentTarget: 1, preventDefault() {} }); key({ key: " ", target: 1, currentTarget: 1, preventDefault() {} });
  key({ key: "x", target: 1, currentTarget: 1, preventDefault() {} });
  key({ key: "Enter", target: 1, currentTarget: 2, preventDefault() {} });
  expect(got).toEqual(["p/s/u", "p/s/u", "p/s/u"]); expect(opened).toEqual([]);
});

test("U6-2. a card without a PR is also a button that opens the window", () => {
  const got: string[] = [];
  const v = fcard(card(), (x: any) => got.push(x.key));
  expect(v.str).toContain('role="button"'); root(v)[0]();
  expect(got).toEqual(["p/s/u"]);
});

test("U6-3. a Needs-you card opens the window (Answer lives there), and its #N link carries the URL", () => {
  const got: string[] = [];
  const v = fcard(card({ stage: "needs_you", needs_you: true, ask: "p/s/q1", pr: { num: "7", url: "https://github.com/o/r/pull/7" } }), (x: any) => got.push(x.key));
  root(v)[0]();
  expect(got).toEqual(["p/s/u"]);
  expect(nodes(v).some((n) => n.str.includes("<a ") && n.values.includes("https://github.com/o/r/pull/7"))).toBe(true);
});

test("U6-4. a merged card is a button too: its click opens the window, its #N link only the PR", () => {
  const got: string[] = [];
  const m = { key: "p/s/m", project: "p", squad: "s", slug: "m", at: FX_NOW - 60, took_s: 60, pr: "9", pr_url: "https://github.com/o/r/pull/9" };
  const col_ = col(L().FlowSection({ flow: { ...flow, merged: [m] }, lstore: lstoreOf(), focus: null, onOpen: (c: any) => got.push(c.key + ":" + c.stage), now: FX_NOW, showProject: false }), "merged");
  const cardN = nodes(col_).find((n) => n.values.includes("fcard merged"));
  expect(cardN.str).toContain('role="button"');
  root(cardN)[0]();
  expect(got).toEqual(["p/s/m:merged"]);
  const a = nodes(cardN).find((n) => n.str.includes("<a "));
  let stopped = 0; a.values.find((x: any) => typeof x === "function")({ stopPropagation: () => stopped++ });
  expect(stopped).toBe(1);
});

// ---- crew-terminal-access U4: a card whose unit is on the board opens the unit's details window
const wcard = (c: any, onOpen: any, onAsk: any = () => {}) => L().FlowCard({ card: c, typicalS: null, moved: false, onOpen, showProject: false });

test("U4-1. a Building card with its unit on the board is a dialog button: click, Enter and Space open the window, not the PR", () => {
  opened.length = 0; const got: string[] = [];
  const c = card({ stage: "building", pr: { num: "7", url: "https://github.com/o/r/pull/7" } });
  const v = wcard(c, (x: any) => got.push(x.key));
  expect(v.str).toContain('role="button"'); expect(v.str).toContain('aria-haspopup="dialog"'); expect(v.values).toContain(0);
  const [clk, key] = root(v);
  clk(); key({ key: "Enter", target: 1, currentTarget: 1, preventDefault() {} }); key({ key: " ", target: 1, currentTarget: 1, preventDefault() {} });
  key({ key: "x", target: 1, currentTarget: 1, preventDefault() {} });
  expect(got).toEqual(["p/s/u", "p/s/u", "p/s/u"]); expect(opened).toEqual([]);
});

test("U4-2. a Needs-you card with its unit on the board opens the window (Answer lives there), not the question", () => {
  const asked: string[] = [], got: string[] = [];
  const v = wcard(card({ stage: "needs_you", needs_you: true, ask: "p/s/q1" }), (x: any) => got.push(x.key), (k: string) => asked.push(k));
  root(v)[0]();
  expect(got).toEqual(["p/s/u"]); expect(asked).toEqual([]);
});

test("U4-3. the #N link on a window card still opens the PR alone", () => {
  const got: string[] = [];
  const v = wcard(card({ pr: { num: "7", url: "https://github.com/o/r/pull/7" } }), (x: any) => got.push(x.key));
  const a = nodes(v).find((n) => n.str.includes("<a "));
  let stopped = 0; a.values.find((x: any) => typeof x === "function")({ stopPropagation: () => stopped++ });
  expect(stopped).toBe(1); expect(got).toEqual([]);
});

test("U4-5. every card in every column, Merged included, is a dialog button", () => {
  const r = render();
  const dialogs = nodes(r.view).filter((n) => n.str.includes('aria-haspopup="dialog"')).length;
  const shown = nodes(r.view).filter((n) => n.values.some((v: any) => typeof v === "string" && v.startsWith("fcard "))).length;
  expect(shown).toBeGreaterThan(0); expect(dialogs).toBe(shown);
});

test("U5-4. the #N link stops propagation so the PR opens once", () => {
  const v = fcard(card({ pr: { num: "7", url: "https://github.com/o/r/pull/7" } }));
  const a = nodes(v).find((n) => n.str.includes("<a "));
  let stopped = 0; a.values.find((x: any) => typeof x === "function")({ stopPropagation: () => stopped++ });
  expect(stopped).toBe(1);
});

test("U5-5. merged cards: pr_url renders a link, null pr_url plain #N, no pr neither", () => {
  const m = (o: any) => ({ key: "p/s/m", project: "p", squad: "s", slug: "m", at: FX_NOW - 60, took_s: 60, pr: null, pr_url: null, ...o });
  const of = (row: any) => { const f = { ...flow, merged: [row] }; return col(L().FlowSection({ flow: f, lstore: lstoreOf(), focus: null, onOpen: () => {}, now: FX_NOW, showProject: false }), "merged"); };
  const linked = of(m({ pr: "9", pr_url: "https://github.com/o/r/pull/9" }));
  expect(nodes(linked).some((n) => n.str.includes("<a ") && n.values.includes("https://github.com/o/r/pull/9"))).toBe(true);
  const plain = of(m({ pr: "9" }));
  expect(nodes(plain).some((n) => n.str.includes("<a "))).toBe(false); expect(text(plain)).toContain("#9");
  const none = of(m({}));
  expect(text(none)).not.toContain("#");
});

test("U5-6. group headers: short labels, full name in the tooltip", () => {
  const { flowGroupLabel } = L();
  expect(["waiting for a slot", "waiting for an account", "waiting on another unit", "held", "coding"].map(flowGroupLabel))
    .toEqual(["for a slot", "for an account", "on another unit", "held", "coding"]);
  const q = col(render({}, lstoreOf({ "b:flow:notready": true })).view, "queued"), hdr = nodes(q).find((n) => n.str.includes('class="fgrp static"'));
  expect(hdr).toBeTruthy(); expect(hdr.values[0]).toMatch(/^waiting |^held/);   // title = the full group name
});

test("U5-7. the page CSS: flush-left ellipsis header, divider on every group after the first", () => {
  expect(page).toContain("[data-group]:first-child>.fgrp{border-top:0");
  expect(page).not.toContain(".fgrp:first-of-type");
  expect(page).toMatch(/\.fgrp>\.fgl\{[^}]*text-overflow:ellipsis[^}]*text-align:left/);
});

// ---- U6: Queued in pickup order
const qcards = (n: number, pos: boolean, group = "waiting for a slot", from = 0) => Array.from({ length: n }, (_, i) => ({
  key: `p/s/${group[0]}${from + i}`, project: "p", squad: "s", slug: `${group[0]}${from + i}`, stage: "queued", group, queue_pos: pos ? from + i + 1 : null,
  since: null, in_stage_s: 60, stuck: false, needs_you: false, ask: null, note: group === "held" ? "later" : null, pr: null, tier: null }));
const withQ = (cards: any[], counts = {}) => ({ ...flow, cards, merged: [], counts: { ...flow.counts, queued: cards.length, ...counts } });
const rq = (cards: any[], store = lstoreOf(), o: any = {}) => { const l = L(); return { l, store, view: l.FlowSection({ flow: withQ(cards), lstore: store, focus: null, onAsk: () => {}, now: FX_NOW, showProject: false, ...o }) }; };
const cardsIn = (view: any) => nodes(col(view, "queued")).filter((n) => n.values.some((x: any) => typeof x === "string" && x.startsWith("fcard ")));
const mixed = () => [...qcards(5, true), ...qcards(2, false, "waiting on another unit"), ...qcards(1, false, "held")];

test("U6-5. next up shows the first 3 numbered cards, show all 5 shows five, a second click shows 3 again", () => {
  const { view } = rq(mixed());
  expect(cardsIn(view)).toHaveLength(3);
  expect(text(cardsIn(view)[0])).toContain("1st");
  const btn = (v: any) => nodes(col(v, "queued")).find((n) => n.str.includes('class="fmore"'));
  expect(text(btn(view))).toContain(">show all 5<");
  expect(text(col(view, "queued"))).not.toContain("waits");
  expect(btn(view).values.some((x: any) => typeof x === "function")).toBe(true);
  expect(text(col(view, "queued"))).not.toContain("5th");
});

test("U6-5b. show all renders all five and the toggle reads show first 3", () => {
  // a stateful useState so the click re-renders with the new value
  const mem: any[] = []; let k = 0;
  const useState = (i: any) => { const n = k++; if (!(n in mem)) mem[n] = typeof i === "function" ? i() : i; return [mem[n], (v: any) => { mem[n] = typeof v === "function" ? v(mem[n]) : v; }]; };
  const lib2: any = new Function("useState", "useEffect", "useMemo", "useRef", "html", "document", "setTimeout", "window",
    `${src} return { FlowSection };`);
  const draw = () => { k = 0; return lib2(useState, () => {}, (f: any) => f(), (v: any) => ({ current: v }), html, { getElementById: () => null }, () => 0, win)
    .FlowSection({ flow: withQ(mixed()), lstore: lstoreOf(), focus: null, onAsk: () => {}, now: FX_NOW, showProject: false }); };
  const more = (v: any) => nodes(col(v, "queued")).find((n) => n.str.includes('class="fmore"'));
  let v = draw();
  click(more(v)); v = draw();
  expect(cardsIn(v)).toHaveLength(5); expect(text(more(v))).toContain(">show first 3<");
  click(more(v)); v = draw();
  expect(cardsIn(v)).toHaveLength(3);
});

test("U6-6. not ready is closed by default, opens into two labelled groups, writes b:flow:notready and stays open", () => {
  const cards = [...qcards(5, true), ...qcards(2, false, "waiting on another unit"), ...qcards(1, false, "held")];
  const { view, store } = rq(cards);
  const q = text(col(view, "queued"));
  expect(q).toContain("▸ not ready"); expect(q).not.toContain("on another unit");
  click(nodes(col(view, "queued")).find((n) => n.str.includes('class="fgrp"') && text(n).includes("not ready")));
  expect(store.writes).toContainEqual(["b:flow:notready", true]);
  const open = text(col(rq(cards, store).view, "queued"));
  expect(open).toContain("▾ not ready"); expect(open).toContain("on another unit"); expect(open).toContain("held");
  const v2 = col(rq(cards, store).view, "queued");
  expect(nodes(v2).filter((n) => n.str.includes('data-group=')).map((n) => n.values[0])).toEqual(["waiting on another unit", "held"]);
  expect(cardsIn(rq(cards, store).view)).toHaveLength(3 + 3);
});

test("U6-7. header count is the total; the line under it reads next up and not ready, leaving out a 0", () => {
  const { view } = rq(mixed());
  expect(nodes(view).find((n) => String(n.values[0]).startsWith("flow-col") && n.values.includes("flow-col-queued")).values.includes(8)).toBe(true);
  expect(text(col(view, "queued"))).toContain("5 next up · 3 not ready");
  const none = rq(qcards(5, true));
  expect(text(col(none.view, "queued"))).toContain("5 next up"); expect(text(col(none.view, "queued"))).not.toContain("not ready");
});

test("U6-8. with the squad filter on, next-up cards keep their project-wide Nth", () => {
  const cards = [...qcards(2, true), ...qcards(2, true, "waiting for a slot", 2).map((c) => ({ ...c, squad: "t", key: c.key.replace("/s/", "/t/") }))];
  const mem: any[] = []; let k = 0;
  const useState = (i: any) => { const n = k++; if (!(n in mem)) mem[n] = typeof i === "function" ? i() : i; return [mem[n], (v: any) => { mem[n] = v; }]; };
  const lib2: any = new Function("useState", "useEffect", "useMemo", "useRef", "html", "document", "setTimeout", "window", `${src} return { FlowSection };`);
  const draw = () => { k = 0; return lib2(useState, () => {}, (f: any) => f(), (v: any) => ({ current: v }), html, { getElementById: () => null }, () => 0, win)
    .FlowSection({ flow: withQ(cards), lstore: lstoreOf(), focus: null, onAsk: () => {}, now: FX_NOW, showProject: false }); };
  let v = draw();
  click(nodes(v).find((n) => n.values.some((x: any) => typeof x === "string" && x.startsWith("fchip")) && text(n).includes(">t<")));
  v = draw();
  expect(cardsIn(v).map((n) => text(n).match(/\d+(st|nd|rd|th)/)?.[0])).toEqual(["3rd", "4th"]);
});

test("U6-10. the old queued fold keys are no longer read", () => {
  const { view } = rq(mixed(), lstoreOf({ "b:flow:fold:queued:waiting for a slot": true }));
  expect(cardsIn(view)).toHaveLength(3);
});

test("U281-1. an empty lane is dimmed with the class empty; the six lanes stay in order", () => {
  const { view } = render({ flow: { ...flow, cards: (flow.cards || []).filter((c: any) => c.stage === "building").slice(0, 1) } });
  const cols = nodes(view).filter((n) => String(n.values[0]).startsWith("flow-col") && typeof n.values[1] === "string" && n.values[1].startsWith("flow-col-"));
  expect(cols.map((n) => n.values[1])).toEqual(["flow-col-queued", "flow-col-building", "flow-col-pr_open", "flow-col-needs_you", "flow-col-merging", "flow-col-merged"]);
  const cls = (st: string) => String(col(view, st).values[0]);
  expect(cls("building")).not.toContain("empty");
  expect(cls("pr_open")).toContain("empty");
});

test("paused-in-swimlanes: a lane's paused cards leave its count, sit in a folded paused group, and unfold dim with why · how long", () => {
  const mk = (slug: string, stage: string, o: any = {}) => ({ key: `p/s/${slug}`, project: "p", squad: "s", slug, stage, group: stage === "building" ? "coding" : null, pr: null, needs_you: false, ask: null,
    stuck: false, slow: false, in_stage_s: 60, note: null, ...o });
  const pz = (slug: string, stage: string) => mk(slug, stage, { group: "paused", paused: true, paused_s: 90000, note: "paused by you" });
  const f = { ...flow, cards: [mk("w", "building"), pz("b1", "building"), pz("b2", "building"), pz("m1", "merging")],
    counts: { ...flow.counts, queued: 0, building: 1, pr_open: 0, needs_you: 0, merging: 0, paused: 3, stuck: 0, slow: 0 } };
  const { view, store, FlowCard } = render({ flow: f });
  expect(text(view)).toContain("0 needs you · 3 paused · ");
  expect(text(col(view, "building"))).toContain("1 · 2 paused");
  const g = (stage: string) => nodes(col(view, stage)).find((n) => n.values.includes("paused") && String(n.values[0]).length > 0 && n.str.includes("data-group"));
  expect(text(g("building"))).toContain("▸ paused");
  expect(text(g("building"))).not.toContain("b1");   // folded: no cards drawn
  expect(text(g("merging"))).toContain("▸ paused");
  expect(text(col(view, "building"))).not.toContain("b2");
  // unfolded: the dim card with its why and how long
  const open = render({ flow: f }, lstoreOf({ "b:flow:fold:building:paused": false }));
  expect(text(col(open.view, "building"))).toContain("b1");
  const card = FlowCard({ card: pz("b1", "building"), typicalS: {}, moved: false, onOpen: () => {}, showProject: false, pos: null, now: FX_NOW });
  expect(card.values[0]).toContain(" paused");
  expect(text(card)).toContain("paused by you");
  expect(text(card)).toContain("25h");
  expect(store.writes).toEqual([]);
});

// Merged per day: the number on each bar, and tap-a-bar (bar-pr-counts U1).
const chartDays = [3, 0, 5, 7, 2, 4, 6, 8].map((merged, i) => ({ day: `2026-11-${19 + i}`, merged }));
const chartFlow = (openPrs: number) => ({ ...flow, per_day: chartDays, counts: { ...flow.counts, open_prs: openPrs } });
const barsOf = (v: any) => nodes(v).filter((n) => /^fbar( |$)/.test(String(n.values[1] ?? "")));
// The number's span in a bar's rendered text: [class, text without the <em> around today's open part].
const num = (bar: any) => { const m = text(bar).match(/<span class=(fnum(?: z)?) style=>(.*?)<\/span>/)!; return [m[1], m[2].replace(/<\/?em>/g, "")]; };
const label = (bar: any) => num(bar)[1];
const head = (v: any) => text(v).match(/<b>Merged per day<\/b><span>(.*?) · median/)![1];

test("chart labels: one per bar with its merged count, a 0 day reads 0 and is dim, today's reads merged+open", () => {
  const bars = barsOf(render({ flow: chartFlow(2) }).view);
  expect(bars.map(label)).toEqual(["3", "0", "5", "7", "2", "4", "6", "8+2"]);
  expect(num(bars[1])[0]).toBe("fnum z");
  expect(num(bars[0])[0]).toBe("fnum");
  expect(text(bars[7])).toContain("<em>+2</em>");
  expect(barsOf(render({ flow: chartFlow(0) }).view).map(label)[7]).toBe("8");
});

test("chart labels: the view's width class follows its longest label, at least 2 characters", () => {
  const cls = (openPrs: number) => nodes(render({ flow: chartFlow(openPrs) }).view).flatMap((n) => n.values).includes("flow-bars w" + (openPrs ? String(openPrs).length + 2 : 2));
  expect(cls(0)).toBe(true);
  expect(cls(2)).toBe(true);
  expect(cls(12)).toBe(true);
  for (let n = 2; n <= 7; n++) expect(page).toContain(`.flow-bars.w${n} .fnum{display:none}`);
});

test("chart tap: a past bar sets the header, a second tap restores today, the 8/30 toggle clears it", () => {
  const states: any[] = [];
  let i = 0;
  const stateful = (init: any) => { const k = i++; if (!(k in states)) states[k] = typeof init === "function" ? init() : init; return [states[k], (v: any) => { states[k] = typeof v === "function" ? v(states[k]) : v; }]; };
  const h = hooks(), store = lstoreOf();
  const l: any = lib(stateful, ...h.args.slice(1));
  const draw = () => { i = 0; return l.FlowSection({ flow: chartFlow(2), lstore: store, focus: null, onOpen: () => {}, now: FX_NOW, showProject: false }); };
  const today = "today 8 merged + 2 PRs open";
  const selected = (v: any) => barsOf(v).filter((b) => / sel$/.test(b.values[1])).length;
  expect(head(draw())).toBe(today);
  click(barsOf(draw())[3]);
  expect(head(draw())).toBe("11-22: 7 merged");
  expect(selected(draw())).toBe(1);
  click(barsOf(draw())[3]);
  expect(head(draw())).toBe(today);
  expect(selected(draw())).toBe(0);
  click(barsOf(draw())[7]);
  expect(head(draw())).toBe(today);
  expect(selected(draw())).toBe(1);
  expect(store.writes).toEqual([]);
  click(barsOf(draw())[1]);
  expect(head(draw())).toBe("11-20: 0 merged");
  const thirty = nodes(draw()).find((n) => n.str.includes(" days</button>") && n.values.includes(30));
  click(thirty);
  expect(head(draw())).toBe(today);
  expect(selected(draw())).toBe(0);
  expect(store.writes).toEqual([["b:flow:days", 30]]);
});
