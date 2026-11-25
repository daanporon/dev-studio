// board-focus.test.ts — squad-priority U2: the board shows the focus squad (★), urgent units (⚡) and the Builders
// tile's shared total. The data comes from loop.db alone (buildBoard); the page's menu and marks are checked on
// the page source here and mounted in board-render.test.ts.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildBoard, buildersText, renderText } from "../../bin/board/board-data.ts";
import { open } from "../../bin/loop/core/store.ts";
import { mount } from "./board-mount.ts";

const REPO = join(import.meta.dir, "../..");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

type U = Record<string, unknown>;
// Squad `a` and `b` of project p. `live`: dispatched units with a working Builder; `queued`: planned, ready units.
function fixture(o: { a: { live?: U[]; queued?: U[]; extra?: U }; b: { live?: U[]; queued?: U[] }; limits: Record<string, string> }) {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardfocus-")); roots.push(root);
  mkdirSync(join(root, "p", "squads"), { recursive: true });
  const workers: [string, string][] = [];
  for (const [topic, sq] of [["a", o.a], ["b", o.b]] as const) {
    const live = (sq.live ?? []).map((u, i) => ({ status: "dispatched", deps: [], builder_wt: `wt-${topic}${i}`, ...u }));
    const queued = (sq.queued ?? []).map((u) => ({ status: "planned", deps: [], ...u }));
    const units = [...live, ...queued];
    const members = [{ role: "lead", wt: `lead-${topic}` }, ...live.map((u: any) => ({ role: "builder", suffix: u.slug, wt: u.builder_wt }))];
    workers.push([`lead-${topic}`, "working"], ...live.map((u: any): [string, string] => [u.builder_wt, "working"]));
    writeFileSync(join(root, "p", "squads", `${topic}.json`), JSON.stringify({ task_id: topic, run_id: `run_${topic}`, repo: "path:/r/p", status: "running", members, units, worktrees: [] }));
  }
  writeFileSync(join(root, "seed.json"), JSON.stringify({ workers }));
  const env = { ...process.env, DS_STATE_ROOT: root };
  for (const cmd of [[join(REPO, "bin/ds"), "import"], [process.execPath, join(REPO, "tests/board-db.ts"), join(root, "seed.json"), "p"]]) {
    const r = spawnSync(cmd[0], cmd.slice(1), { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  }
  const s = open(root);
  for (const [key, value] of Object.entries(o.limits)) s.upsert("config", { project: "p", file: "limits.conf", key }, { value, observed_at: 1 });
  s.close();
  return { root, board: () => buildBoard("p", "", root) as any };
}
const squadOf = (b: any, t: string) => b.squads.find((s: any) => s.topic === t);
const unitOf = (b: any, t: string, slug: string) => squadOf(b, t).units.find((u: any) => u.slug === slug);

test("a focus squad: ★ on the squad and on its queued unit, none on another squad's", () => {
  const f = fixture({ a: { queued: [{ slug: "a1" }] }, b: { queued: [{ slug: "b1" }] }, limits: { max_builders: "3", focus_squad: "a" } });
  const b = f.board();
  expect(squadOf(b, "a").focus).toBe(true);
  expect(squadOf(b, "b").focus).toBe(false);
  expect(squadOf(b, "a").focus_squad).toBe("a");
  expect(unitOf(b, "a", "a1").focus).toBe("on");
  expect(unitOf(b, "b", "b1").focus).toBeNull();
  const text = renderText(b);
  expect(text).toContain("▣ ★ a");
  expect(text).toMatch(/a1.*★/);
  expect(text).not.toMatch(/b1.*★/);
});

test("a focus squad holding its share: its queued unit reads held (muted ★)", () => {
  // 2 seats, the squad's own Builder live: seats − 1 − held = 0, so its queued unit ranks by age.
  const f = fixture({ a: { live: [{ slug: "a0" }], queued: [{ slug: "a1" }] }, b: {}, limits: { max_builders: "2", focus_squad: "a" } });
  const b = f.board();
  expect(unitOf(b, "a", "a1").focus).toBe("held");
});

test("every other open unit of the focus squad reads muted (blocked, dispatched with a PR); another squad's has none (U5)", () => {
  const f = fixture({
    a: { live: [{ slug: "a0", pr: { num: 7 } }], queued: [{ slug: "a1", deps: ["a0"] }, { slug: "a2" }] },
    b: { live: [{ slug: "b0" }], queued: [{ slug: "b1", deps: ["b0"] }] },
    limits: { max_builders: "6", focus_squad: "a" },
  });
  const b = f.board();
  expect(unitOf(b, "a", "a1").focus).toBe("muted");      // blocked, queued
  expect(unitOf(b, "a", "a0").focus).toBe("muted");      // PR open
  expect(unitOf(b, "a", "a2").focus).toBe("on");         // next in line
  expect(unitOf(b, "b", "b1").focus).toBeNull();
  expect(unitOf(b, "b", "b0").focus).toBeNull();
  const cards = new Map<string, any>(b.flow.cards.map((c: any) => [c.key, c]));
  expect(cards.get("p/a/a1")?.focus).toBe("muted");
  expect(cards.get("p/a/a0")?.focus).toBe("muted");
  expect(cards.get("p/b/b1")?.focus).toBeNull();
});

test("no focus: no marks, and a suspended focus squad counts for nothing", () => {
  const f = fixture({ a: { queued: [{ slug: "a1" }] }, b: {}, limits: { max_builders: "3" } });
  const b = f.board();
  expect(squadOf(b, "a").focus).toBe(false);
  expect(squadOf(b, "a").focus_squad).toBeNull();
  expect(unitOf(b, "a", "a1").focus).toBeNull();
  expect(renderText(b)).not.toContain("★");
});

test("an urgent unit is marked, in the unit row and the text board", () => {
  const f = fixture({ a: { live: [{ slug: "a0", urgent: true }], queued: [{ slug: "a1", urgent: true }, { slug: "a2" }] }, b: {}, limits: { max_builders: "3" } });
  const b = f.board();
  expect(unitOf(b, "a", "a0").urgent).toBe(true);
  expect(unitOf(b, "a", "a1").urgent).toBe(true);
  expect(unitOf(b, "a", "a2").urgent).toBe(false);
  expect(renderText(b)).toMatch(/a1.*⚡/);
});

// 6 normal + 2 light seats: the tile's numbers.
const tile = (normal: number, urgent: number, light = 0) => {
  const live = (n: number, p: string, x: U = {}) => Array.from({ length: n }, (_, i) => ({ slug: `${p}${i}`, ...x }));
  const f = fixture({
    a: { live: [...live(normal, "n"), ...live(light, "l", { lane: "light" })] },
    b: { live: live(urgent, "u", { urgent: true }) },
    limits: { max_builders: "6", max_light_builders: "2", light_lane_cpu_h: "3" },
  });
  return f.board().header;
};

test("the Builders tile: 5 normal + 2 urgent reads 7/8, normal 7/6 (⚡2), light 0/1 (2)", () => {
  const h = tile(5, 2);
  expect(h.builders_working).toBe(7);
  expect(buildersText(h)).toBe("7/8 · normal 7/6 (⚡2, 7 working) · light 0/1 (2)");
  expect(h.builders_left).toBe(1);
  expect(h.builders_over.list.map((x: any) => x.why)).toEqual(["urgent", "urgent"]);
});

test("the Builders tile: all 8 taken leaves no light seat, 4 live shows the plain numbers", () => {
  expect(buildersText(tile(6, 2))).toBe("8/8 · normal 8/6 (⚡2, 8 working) · light 0/0 (2)");
  expect(buildersText(tile(4, 0))).toBe("4/8 · normal 4/6 (4 working) · light 0/2");
});

test("the Builders tile: a light Builder counts in its own lane, and no light lane drops the light part", () => {
  expect(buildersText(tile(5, 0, 1))).toBe("6/8 · normal 5/6 (6 working) · light 1/2");
  const f = fixture({ a: { live: [{ slug: "a0" }] }, b: {}, limits: { max_builders: "6" } });
  expect(buildersText(f.board().header)).toBe("1/6 · normal 1/6 (1 working)");   // no light lane: no light part
});

test("the page: the ⋯ menu, the ★/⚡ marks, the Builders tile text and no task text on the top line", () => {
  const page = readFileSync(join(REPO, "web/board.html"), "utf8");
  expect(page).toContain("function SquadMenu(");
  expect(page).toContain('key: "focus_squad"');
  expect(page).toContain('"Focus squad (replaces "');
  expect(page).toContain("Unfocus squad");
  expect(page).toContain("<${UnitMarks} u=${card} />");
  expect(page).toContain("urgent: starts next, even over the limit");
  expect(page).toContain("focus squad: goes first inside the limit");
  expect(page).toContain("focus squad holds its share: waits by age now");
  expect(page).toContain("buildersDetail(H)");
  expect(page).toContain('" holding a seat at a later stage."');
  expect(page).not.toContain('s.type + "/" + s.autonomy, "ship " + s.ship_mode');
});

test("the mounted page: ★ chip on the focus squad, ⋯ menu items, one ⋯ per row, no task text, Pause/Focus/Archive post as before", async () => {
  const f = fixture({ a: { queued: [{ slug: "a1", urgent: true }] }, b: { queued: [{ slug: "b1" }] }, limits: { max_builders: "3", focus_squad: "a" } });
  const run = await mount(f.board());
  const doc = run.window.document, W = run.window;
  expect(run.errors).toEqual([]);
  // a plain ★ between the spinner and the name; no `focus` chip or text in the row
  const topic = (t: string) => [...doc.querySelectorAll(".row.squad .topic")].find((x: any) => x.textContent.includes(t)) as any;
  const star = topic("a").querySelector(".sqfocus");
  expect(star.textContent.trim()).toBe("★");
  expect(star.previousElementSibling.classList.contains("dot")).toBe(true);   // spinner, ★, name
  expect(star.nextSibling.textContent).toBe("a");
  expect(topic("b").querySelector(".sqfocus")).toBeNull();
  expect(doc.querySelector(".ust.focus")).toBeNull();
  expect(doc.querySelector(".row.squad .pill").parentElement.textContent).not.toContain("focus");
  expect(doc.body.textContent).not.toContain("feature/checkpoints");
  const settle0 = () => new Promise((r) => setTimeout(r, 30));
  for (const row of [...doc.querySelectorAll(".row.squad")]) { row.dispatchEvent(new run.window.MouseEvent("click", { bubbles: true })); await settle0(); }
  expect(doc.querySelectorAll(".umark").length).toBeGreaterThan(0);
  const menus = [...doc.querySelectorAll("button.squad-menu")];
  expect(menus.length).toBe(2);
  const calls: any[] = [], orig = W.fetch;
  W.fetch = (u: string, init?: any) => { if (init?.method === "POST") calls.push([u, JSON.parse(init.body)]); return orig(u); };
  const items = (m: any) => [...m.parentElement.querySelectorAll(".amenu button")].map((x: any) => x.textContent.trim());
  const settle = () => new Promise((r) => setTimeout(r, 30));
  // the ⋯ is the row's last cell; squad a is the focus: Unfocus squad; the order is fixed and Archive is last
  const [ma, mb] = [menus.find((m: any) => m.getAttribute("aria-label") === "Actions for squad a"), menus.find((m: any) => m.getAttribute("aria-label") === "Actions for squad b")];
  expect(ma.closest(".row.squad").lastElementChild.contains(ma)).toBe(true);
  expect(ma.closest(".detail")).toBeNull();
  expect(items(ma)).toEqual(["Pause squad", "Events", "Unfocus squad", "Restart Lead", "Restart squad", "Suspend squad", "Archive squad"]);
  expect(items(mb)).toEqual(["Pause squad", "Events", "Focus squad (replaces a)", "Restart Lead", "Restart squad", "Suspend squad", "Archive squad"]);
  expect(doc.body.textContent).not.toContain("task task_");
  expect(doc.body.textContent).not.toMatch(/\btask a\b/);
  expect(ma.parentElement.querySelector(".sep")).not.toBeNull();
  expect(doc.querySelector(".detail .dbar")).toBeNull();
  expect(doc.querySelector(".detail [data-ev=squad-events]")).toBeNull();
  // Archive squad is red text on the menu's own background, readable (>= 4.5:1)
  const arch = [...ma.parentElement.querySelectorAll(".amenu button")].find((x: any) => x.textContent.trim() === "Archive squad") as any;
  expect(arch.classList.contains("red")).toBe(true);
  const css = readFileSync(join(REPO, "web/board.html"), "utf8");
  const v = (n: string) => css.match(new RegExp("--" + n + ":(#[0-9a-f]{6})"))![1];
  const lum = (h: string) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const [l1, l2] = [lum(v("red")), lum(v("panel2"))].sort((x, y) => y - x);
  expect((l1 + 0.05) / (l2 + 0.05)).toBeGreaterThanOrEqual(4.5);
  expect(css).toMatch(/\.amenu \.btn\.red\{color:var\(--red\);background:transparent/);
  // opening the menu does not toggle the squad
  const before = doc.querySelectorAll(".row.squad.open").length;
  ma.dispatchEvent(new W.MouseEvent("click", { bubbles: true })); await settle();
  expect(doc.querySelectorAll(".row.squad.open").length).toBe(before);
  expect(ma.getAttribute("aria-expanded")).toBe("true");
  const click = (m: any, test: (x: any) => boolean) => { [...m.parentElement.querySelectorAll(".amenu button")].find(test).dispatchEvent(new W.MouseEvent("click", { bubbles: true })); return settle(); };
  W.confirm = () => true;
  await click(ma, (x: any) => x.textContent.trim() === "Unfocus squad");
  mb.dispatchEvent(new W.MouseEvent("click", { bubbles: true })); await settle();
  await click(mb, (x: any) => x.textContent.startsWith("Focus squad"));
  await click(mb, (x: any) => x.textContent.trim() === "Pause squad");
  await click(mb, (x: any) => x.textContent.trim() === "Archive squad");
  expect(calls.map((c) => [c[0], c[1]])).toEqual([["api/limits", { project: "p", key: "focus_squad", value: null }], ["api/limits", { project: "p", key: "focus_squad", value: "b" }],
    ["api/pause", { scope: "squad", project: "p", topic: "b" }], ...calls.slice(3)]);
  expect(calls.length).toBeGreaterThanOrEqual(3);
});

test("the mounted page: the Builders tile reads seats in use over the total, with the lane line under it", async () => {
  const tileOf = async (h: any, board: any) => {
    const run = await mount(board), doc = run.window.document;
    expect(run.errors).toEqual([]);
    const t = [...doc.querySelectorAll(".tile")].find((x: any) => x.querySelector(".tl")?.textContent === "Builders") as any;
    return { v: t.querySelector(".tv").textContent, d: t.querySelector(".td").textContent, title: t.getAttribute("title") ?? "" };
  };
  const mk = (normal: number, urgent: number, light = 0) => {
    const live = (n: number, p: string, x: U = {}) => Array.from({ length: n }, (_, i) => ({ slug: `${p}${i}`, ...x }));
    return fixture({ a: { live: [...live(normal, "n"), ...live(light, "l", { lane: "light" })] }, b: { live: live(urgent, "u", { urgent: true }) },
      limits: { max_builders: "6", max_light_builders: "2", light_lane_cpu_h: "3" } }).board();
  };
  const t1 = await tileOf(null, mk(5, 2));
  expect(t1.v).toBe("7/8");
  expect(t1.d).toContain("normal 7/6 (⚡2, 7 working) · light 0/1 (2)");
  expect(t1.d).not.toContain("of 8");
  expect((await tileOf(null, mk(5, 0, 1))).v).toBe("6/8");
  const f = fixture({ a: { live: [{ slug: "a0" }] }, b: {}, limits: { max_builders: "6" } });
  expect((await tileOf(null, f.board())).v).toBe("1/6");
});

test("the mounted page: dim and bright ★ on Flow cards, none on another squad's, and the Runs on row (U5)", async () => {
  const f = fixture({
    a: { live: [{ slug: "a0", tier: "hard", lane: "light", lane_rule: "docs-only", pr: { num: 7 } }], queued: [{ slug: "a1", deps: ["a0"] }, { slug: "a2", urgent: true }] },
    b: { queued: [{ slug: "b1" }] },
    limits: { max_builders: "6", max_light_builders: "2", light_lane_cpu_h: "3", focus_squad: "a" },
  });
  const run = await mount(f.board()), doc = run.window.document, W = run.window;
  expect(run.errors).toEqual([]);
  const card = (key: string) => doc.querySelector(`.fcard[data-key="${key}"]`) as any;
  expect(card("p/a/a2").querySelector(".umark.focus:not(.held)")).not.toBeNull();   // next in line: bright
  expect(card("p/a/a0").querySelector(".umark.focus.held")).not.toBeNull();         // PR open: dim
  expect(card("p/b/b1").querySelector(".umark")).toBeNull();
  // a blocked unit has no Flow card: its row in the open squad carries the dim ★
  doc.querySelector(".row.squad")!.dispatchEvent(new W.MouseEvent("click", { bubbles: true })); await new Promise((r) => setTimeout(r, 30));
  const urow = [...doc.querySelectorAll(".detail .u")].find((x: any) => x.textContent.includes("a1")) as any;
  expect(urow.querySelector(".umark.focus.held")).not.toBeNull();
  // the card's details window: tier, lane and the ★ line
  const settle = () => new Promise((r) => setTimeout(r, 30));
  card("p/a/a0").dispatchEvent(new W.MouseEvent("click", { bubbles: true })); await settle();
  const runs = doc.querySelector(".ud-runs") as any;
  expect(runs).not.toBeNull();
  expect(runs.textContent).toContain("hard");
  expect(runs.textContent).toContain("light (rule: docs-only)");
  expect(runs.textContent).toContain("★ focus squad: goes first inside the limit");
  doc.querySelector(".ud-close")!.dispatchEvent(new W.MouseEvent("click", { bubbles: true })); await settle();
  card("p/b/b1").dispatchEvent(new W.MouseEvent("click", { bubbles: true })); await settle();
  expect((doc.querySelector(".ud-runs") as any).textContent).not.toContain("★");
  expect((doc.querySelector(".ud-runs") as any).textContent).toContain("normal");
});

test("finished work of the focus squad keeps a muted ★; cancelled and another squad's done units have none (U6)", () => {
  const f = fixture({
    a: { live: [{ slug: "a0" }], queued: [{ slug: "a1", status: "done" }, { slug: "a2", status: "cancelled" }] },
    b: { queued: [{ slug: "b1", status: "done" }] },
    limits: { max_builders: "6", focus_squad: "a" },
  });
  const b = f.board();
  expect(unitOf(b, "a", "a1").focus).toBe("muted");
  expect(unitOf(b, "a", "a2").focus).toBeNull();
  expect(unitOf(b, "b", "b1").focus).toBeNull();
  const none = fixture({ a: { queued: [{ slug: "a1", status: "done" }] }, b: {}, limits: { max_builders: "6" } }).board();
  expect(unitOf(none, "a", "a1").focus).toBeNull();
});

// .row's minimum width: the fixed and minmax() column minimums, the gaps, the padding and the border (U6).
test("the squads table row fits the narrowest wide layout (935px)", () => {
  const css = readFileSync(join(REPO, "web/board.html"), "utf8").match(/\n\.row\{([^}]*)\}/)![1];
  const cols = css.match(/grid-template-columns:([^;]+);/)![1].trim().split(/\s+(?![^(]*\))/);
  const min = (c: string) => Number((c.match(/minmax\((\d+)px/) ?? c.match(/^(\d+)px/))![1]);
  const gap = Number(css.match(/gap:(\d+)px/)![1]), pad = css.match(/padding:\d+px (\d+)px/)![1], border = Number(css.match(/border-left:(\d+)px/)![1]);
  const total = cols.reduce((n, c) => n + min(c), 0) + gap * (cols.length - 1) + 2 * Number(pad) + border;
  expect(cols.length).toBe(9);
  expect(total).toBeLessThanOrEqual(935);
});

test("squad order: a starred squad sorting last by name renders above running squads, below one with a question", () => {
  const f = fixture({ a: { queued: [{ slug: "a1" }] }, b: { queued: [{ slug: "b1" }] }, limits: { max_builders: "3", focus_squad: "b" } });
  expect(f.board().squads.map((s: any) => s.topic)).toEqual(["b", "a"]);
  const s = open(f.root);
  const doc: any = JSON.parse(readFileSync(join(f.root, "p", "squads", "a.json"), "utf8"));
  doc.waiting_on_you = [{ id: "q", asker: "lead", blocking: true, question: "x", since: "2026-10-08T09:00:00Z" }];
  writeFileSync(join(f.root, "p", "squads", "a.json"), JSON.stringify(doc));
  s.close();
  const r = spawnSync(join(REPO, "bin/ds"), ["import"], { env: { ...process.env, DS_STATE_ROOT: f.root }, encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(f.board().squads.map((x: any) => x.topic)).toEqual(["a", "b"]);
});
