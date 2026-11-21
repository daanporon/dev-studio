// board-phone.ts — the phone proof for the web board: opens each popup at 375x812 and 414x896 (touch) and at 1280x800 on the
// tests/lib/board-setup.sh fixture board and checks the phone rules. Not part of tests/ci.sh (no browser there).
//
//   bun tests/browser/board-phone.ts [--out <dir>] [--base <git ref, default origin/main>] [--url <running board>]
//
// Strict at 375/414: the popup box is the viewport, its close ✕ and primary button are on screen and >= 44 px, every input is
// >= 16 px, nothing sticks out past the right edge. The keyboard views (phone only) stub window.visualViewport 300 px shorter, as an
// iPhone keyboard leaves it, focus the question's text box / the chat input and need the sheet to fit above it with Send and the
// field inside and kb-open set, then the full sheet back once the stub's height is restored. At 1280 each view's measures must equal the same page from the base ref
// (the base html is served through a route). Every non-GET /api call is aborted: nothing is sent. Needs playwright-core and a
// Chromium (PLAYWRIGHT_CORE=<path to playwright-core/index.mjs>, else the bunx cache or node_modules). Exit 1 on a break.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const arg = (k: string, d = "") => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = resolve(arg("--out", join(ROOT, ".scratch/board-phone")));
const BASE = arg("--base", "origin/main");
mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  const found: string[] = [];
  if (process.env.PLAYWRIGHT_CORE) found.push(process.env.PLAYWRIGHT_CORE);
  found.push("playwright-core");
  for (const root of ["/tmp", join(homedir(), ".bun/install/cache")]) {
    try { for (const d of readdirSync(root)) if (/playwright/.test(d)) found.push(join(root, d, "node_modules/playwright-core/index.mjs"), join(root, d, "index.mjs")); } catch {}
  }
  for (const f of found) { if (f.startsWith("/") && !existsSync(f)) continue; try { return await import(f); } catch {} }
  throw new Error("playwright-core not found: set PLAYWRIGHT_CORE=<path>/playwright-core/index.mjs");
}
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });

let url = arg("--url"); let fixture: ReturnType<typeof spawn> | null = null;
if (!url) {
  const port = await freePort();
  fixture = spawn("bash", [join(ROOT, "tests/browser/fixture-board.sh"), String(port)], { stdio: "ignore" });
  url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url + "board.json")).ok) break; } catch {} await Bun.sleep(300); }
}
const baseHtml = spawnSync("git", ["-C", ROOT, "show", `${BASE}:web/board.html`], { encoding: "utf8", maxBuffer: 1 << 26 });
if (baseHtml.status !== 0) { console.error(`cannot read web/board.html at ${BASE}: ${baseHtml.stderr}`); process.exit(2); }

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });

// What a view measures, run in the page. `popup` is the topmost .modal .mbox.
const MEASURE = `(() => {
  const vw = innerWidth, vh = innerHeight, r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  const boxes = [...document.querySelectorAll(".modal .mbox")], box = boxes[boxes.length - 1] || null, root = box || document.body;
  const vis = (e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 0 && b.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const scrolls = (e) => { for (let p = e.parentElement; p && p !== root.parentElement; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden") return true; if (p === root) break; } return false; };
  const inputs = [...root.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]),textarea,select")].filter(vis);
  const small = inputs.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).length;
  const btns = [...root.querySelectorAll("button")].filter(vis);
  const tiny = btns.filter((e) => { const b = e.getBoundingClientRect(); return b.width < 44 || b.height < 44; }).length;
  const out = [...root.querySelectorAll("*")].filter((e) => vis(e) && e.getBoundingClientRect().right > vw + 1 && !scrolls(e)).slice(0, 5).map((e) => e.tagName.toLowerCase() + "." + String(e.className).slice(0, 30));
  const close = box && (box.querySelector(".mclose") || [...box.querySelectorAll("button")].find((b) => b.textContent.trim() === "✕"));
  const foot = box && [...box.children].filter((c) => /qfoot|mhd/.test(c.className)).pop();
  const prim = box && [...box.querySelectorAll(".qfoot .btn.pri, .mhd .btn.pri")].filter(vis).pop();
  const fonts = inputs.map((e) => Math.round(parseFloat(getComputedStyle(e).fontSize)));
  const bv = (sel) => [...document.querySelectorAll(sel)].filter(vis);
  const flowLefts = bv(".flow-col").map((e) => Math.round(e.getBoundingClientRect().left));
  const units = bv(".units .u:not(.head)").map((e) => { const n = e.querySelector(".un .unit-open") || e.querySelector(".un"), d = e.querySelector(".dot"), t = e.querySelector(".tier"); return { nameW: Math.round(n.getBoundingClientRect().width), clipped: n.scrollWidth > n.clientWidth + 1, h: Math.round(e.getBoundingClientRect().height), dotY: Math.round(d.getBoundingClientRect().top), tierY: t ? Math.round(t.getBoundingClientRect().top) : null }; });
  const evs = bv(".ev").slice(0, 8).map((e) => { const s = e.querySelector(".s"); return { timeY: Math.round(e.children[0].getBoundingClientRect().top), textY: s ? Math.round(s.getBoundingClientRect().top) : null, textW: s ? Math.round(s.getBoundingClientRect().width) : null }; });
  const menu = r(bv(".amenu")[0]), menuTiny = bv(".amenu .btn").filter((e) => e.getBoundingClientRect().height < 44).length;
  const tinyList = btns.filter((e) => { const b = e.getBoundingClientRect(); return b.width < 44 || b.height < 44; }).slice(0, 12).map((e) => e.className.slice(0, 22) + "|" + e.textContent.trim().slice(0, 14) + "|" + Math.round(e.getBoundingClientRect().width) + "x" + Math.round(e.getBoundingClientRect().height));
  return { tinyList, flowLefts, units, evs, menu, menuTiny, vw, vh, popup: r(box), docW: document.documentElement.scrollWidth, boxScrollW: box ? box.scrollWidth : null, inputs: inputs.length, small, fonts, btns: btns.length, tiny,
    close: r(close), primary: r(prim), foot: r(foot), out };
})()`;

type Open = (p: any) => Promise<boolean>;
const click = async (p: any, sel: string, text?: RegExp) => { const l = text ? p.locator(sel).filter({ hasText: text }).first() : p.locator(sel).first(); if (!(await l.count())) return false; await l.click(); await p.waitForTimeout(500); return true; };
const openSettings: Open = async (p) => { await p.evaluate(() => { location.hash = "#settings"; }); await p.waitForTimeout(800); return (await p.locator("#settings").count()) > 0; };
const VIEWS: { name: string; strict: boolean; kind?: string; field?: string; open: Open }[] = [
  { name: "question", strict: true, open: (p) => click(p, ".qrow, .qnote") },
  { name: "chat", strict: true, open: async (p) => (await click(p, ".qrow, .qnote")) && (await click(p, ".modal .chat-btn")) },
  { name: "start-squad", strict: true, open: (p) => click(p, "button", /Start squad/) },
  { name: "page", strict: true, kind: "page", open: async () => true },
  { name: "squad", strict: true, kind: "page", open: (p) => click(p, ".row.squad") },
  { name: "flow", strict: true, kind: "page", open: async (p) => { await p.locator("#flow").scrollIntoViewIfNeeded(); await p.waitForTimeout(300); return (await p.locator(".flow-col").count()) > 1; } },
  { name: "evlog", strict: true, kind: "page", open: async (p) => { const d = p.locator("details#events"); if (!(await d.count())) return false; await d.locator("summary").first().click(); await p.waitForTimeout(800); return (await p.locator(".ev").count()) > 0; } },
  { name: "menu", strict: true, kind: "page", open: (p) => click(p, ".row.squad .acts-btn") },
  { name: "settings", strict: true, open: openSettings },
  ...["Roles", "Skills", "Pins"].map((t) => ({ name: `settings-${t.toLowerCase()}`, strict: true, open: async (p: any) => (await openSettings(p)) && (await click(p, ".set-tab", new RegExp("^" + t))) })),
  { name: "flow-card", strict: true, open: (p) => click(p, ".fcard") },
  { name: "unit-details", strict: true, open: async (p) => (await click(p, ".row.squad")) && (await click(p, ".units .u.openable")) && (await p.locator(".mbox.ud").count()) > 0 },
  { name: "plan-viewer", strict: true, open: async (p) => (await click(p, ".row.squad")) && (await click(p, '.docbox .plan, .docbox button, [data-ev="open-doc"]')) },
  { name: "kb-question", strict: true, kind: "keyboard", field: ".modal .qbody textarea", open: (p) => click(p, ".qrow, .qnote") },
  { name: "kb-chat", strict: true, kind: "keyboard", field: ".chat-modal .chat-in", open: async (p) => (await click(p, ".qrow, .qnote")) && (await click(p, ".modal .chat-btn")) },
  { name: "event-data", strict: true, open: async (p) => { await p.evaluate(() => { const d = document.querySelector("#events") as any; if (d) d.open = true; }); await p.waitForTimeout(500); return click(p, '#events .ev[role="button"], #events .evmore'); } },
];

// The keyboard stub: a visualViewport whose height __kb(h) sets (null = the window's) and announces with a resize, as iOS does.
const KB_STUB = `(() => {
  const t = new EventTarget(); let h = null;
  const g = { height: () => (h == null ? innerHeight : h), width: () => innerWidth, offsetTop: () => 0, offsetLeft: () => 0, pageTop: () => scrollY, pageLeft: () => scrollX, scale: () => 1 };
  for (const k in g) Object.defineProperty(t, k, { get: g[k] });
  Object.defineProperty(window, "visualViewport", { configurable: true, get: () => t });
  window.__kb = (v) => { h = v; t.dispatchEvent(new Event("resize")); };
})()`;
// What a keyboard view measures: the sheet, its primary button, the focused field, the folded secondary buttons, kb-open.
const KB_MEASURE = `((field) => {
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).display !== "none"; };
  const boxes = [...document.querySelectorAll(".modal .mbox")], box = boxes[boxes.length - 1];
  const f = document.querySelector(field);
  return { vh: innerHeight, popup: r(box), primary: r(box && [...box.querySelectorAll(".qfoot .btn.pri")].filter(vis).pop()), field: r(f), focused: document.activeElement === f,
    kb: document.documentElement.classList.contains("kb-open"), secondary: box ? [...box.querySelectorAll(".qfoot>.qsec, .qfoot>.chat-btn")].filter(vis).length : 0,
    vvh: document.documentElement.style.getPropertyValue("--vvh") };
})`;
const SIZES = [{ w: 375, h: 812, phone: true }, { w: 414, h: 896, phone: true }, { w: 1280, h: 800, phone: false }];
const report: any = {}; const breaks: string[] = [];
const shoot = async (size: any, view: string, base: boolean) => {
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2, isMobile: size.phone, hasTouch: size.phone });
  const v = VIEWS.find((x) => x.name === view)!;
  if (v.kind === "keyboard") await ctx.addInitScript(KB_STUB);
  const p = await ctx.newPage();
  await p.route("**/api/**", (r: any) => (r.request().method() === "GET" ? r.continue() : r.abort()));
  // the fixture has no loop events: give the event log one (a long payload line, to prove the data popup wraps) so its data popup can open
  await p.route("**/api/events?*", (r: any) => r.request().url().includes("/lists") ? r.continue() : r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [{ id: 1, at: Math.floor(Date.now() / 1000) - 60, project: "x", squad: "sq", member: null, kind: "spawn", sev: "ok", payload: { note: "a long unbroken value " + "x".repeat(200), list: ["a", "b"] } }], older: null, newer: null, names: {}, messages: {}, squads: [], kinds: ["spawn"] }) }));
  if (base) await p.route(url!, (r: any) => r.fulfill({ status: 200, contentType: "text/html", body: baseHtml.stdout }));
  await p.goto(url!, { waitUntil: "networkidle" }); await p.waitForTimeout(1200);
  const opened = await v.open(p);
  if (v.kind === "keyboard") {
    if (!opened || !(await p.locator(v.field!).count())) { await ctx.close(); return { opened: false, m: null }; }
    await p.locator(v.field!).first().focus();
    await p.evaluate((h: number) => (window as any).__kb(h), size.h - 300); await p.waitForTimeout(400);
    const kb = await p.evaluate(`${KB_MEASURE}(${JSON.stringify(v.field)})`);
    await p.screenshot({ path: join(OUT, `${size.w}-${view}.png`) });
    await p.evaluate(() => (window as any).__kb(null)); await p.waitForTimeout(400);
    const back = await p.evaluate(`${KB_MEASURE}(${JSON.stringify(v.field)})`);
    await ctx.close();
    return { opened, m: null, kb, back };
  }
  const m = opened ? await p.evaluate(MEASURE) : null;
  if (opened && !base) await p.screenshot({ path: join(OUT, `${size.w}-${view}.png`) });
  await ctx.close();
  return { opened, m } as any;
};

for (const size of SIZES) for (const v of VIEWS) {
  if (v.kind === "keyboard" && !size.phone) continue;
  const key = `${size.w}/${v.name}`; const { opened, m, kb, back } = await shoot(size, v.name, false);
  report[key] = { opened, m, kb, back };
  if (!opened) { if (v.strict) breaks.push(`${key}: did not open`); continue; }
  if (v.kind === "keyboard") {
    const need = (ok: boolean, why: string) => { if (!ok) breaks.push(`${key}: ${why}`); };
    const H = size.h - 300, inside = (b: any) => b && b.y >= 0 && b.y + b.h <= H + 1;
    need(!!kb.popup && kb.popup.y === 0 && Math.abs(kb.popup.h - H) <= 1, `keyboard open: sheet ${JSON.stringify(kb.popup)} is not the ${H} px above the keyboard`);
    need(inside(kb.primary) && kb.primary.h >= 44, `keyboard open: Send ${JSON.stringify(kb.primary)} not above the keyboard`);
    need(kb.focused && inside(kb.field), `keyboard open: the focused field ${JSON.stringify(kb.field)} (focused ${kb.focused}) not above the keyboard`);
    need(kb.kb, "keyboard open: no kb-open on the root");
    need(kb.secondary === 0, `keyboard open: ${kb.secondary} secondary footer button(s) still shown`);
    need(!!back.popup && back.popup.y === 0 && Math.abs(back.popup.h - back.vh) <= 1 && !back.kb, `keyboard closed: sheet ${JSON.stringify(back.popup)} kb-open ${back.kb} is not the full ${back.vh} px sheet`);
    continue;
  }
  if (size.phone && v.kind === "page" && m) {
    const need = (ok: boolean, why: string) => { if (!ok) breaks.push(`${key}: ${why}`); };
    need(m.docW <= m.vw, `page scrolls sideways (scrollWidth ${m.docW} > ${m.vw})`);
    need(m.out.length === 0, `sticks out past the right edge: ${m.out}`);
    need(m.tiny === 0, `${m.tiny} of ${m.btns} buttons under 44 px: ${m.tinyList.join(" ; ")}`);
    need(m.small === 0, `${m.small} input(s) under 16 px (${m.fonts})`);
    if (v.name === "flow") need(m.flowLefts.length > 1 && new Set(m.flowLefts).size === 1, `Flow stages not stacked: left edges ${m.flowLefts}`);
    if (v.name === "squad") { need(m.units.length > 0, "no unit rows"); for (const u of m.units) { need(u.nameW >= 44 && !u.clipped, `unit name clipped/narrow ${JSON.stringify(u)}`); need(u.tierY === null || u.tierY > u.dotY, `unit row not two lines ${JSON.stringify(u)}`); } }
    if (v.name === "evlog") for (const e of m.evs) need(e.textY === null || e.textY > e.timeY, `event text not under time ${JSON.stringify(e)}`);
    if (v.name === "menu") { need(!!m.menu && m.menu.x >= 0 && m.menu.x + m.menu.w <= m.vw && m.menu.y >= 0 && m.menu.y + m.menu.h <= m.vh, `menu ${JSON.stringify(m.menu)} not inside the screen`); need(m.menuTiny === 0, `${m.menuTiny} menu items under 44 px`); }
  }
  if (size.phone && v.kind !== "page" && m) {
    const need = (ok: boolean, why: string) => { if (!ok && v.strict) breaks.push(`${key}: ${why}`); };
    const pp = m.popup;
    need(!!pp && pp.x === 0 && pp.y === 0 && pp.w === m.vw && Math.abs(pp.h - m.vh) <= 1, `popup box ${JSON.stringify(pp)} is not the ${m.vw}x${m.vh} viewport`);
    const onScreen = (b: any) => b && b.x >= 0 && b.y >= 0 && b.x + b.w <= m.vw + 1 && b.y + b.h <= m.vh + 1;
    need(onScreen(m.close) && m.close.w >= 44 && m.close.h >= 44, `close ✕ ${JSON.stringify(m.close)} not on screen at >= 44 px`);
    if (m.primary) need(onScreen(m.primary) && m.primary.h >= 44, `primary button ${JSON.stringify(m.primary)} not on screen at >= 44 px`);
    else if (v.name === "question") need(false, "no primary button found");
    need(m.tiny === 0, `${m.tiny} button(s) under 44 px`);
    need(m.tiny === 0, `${m.tiny} of ${m.btns} buttons under 44 px`);
    need(m.small === 0, `${m.small} input(s) under 16 px (${m.fonts})`);
    need(m.out.length === 0 && m.boxScrollW <= m.vw + 1, `sticks out past the right edge: ${m.out} (box scrollWidth ${m.boxScrollW})`);
  }
  if (!size.phone) {
    const b = await shoot(size, v.name, true); report[`${key}@base`] = b;
    const pick = (x: any) => x.m && { popup: x.m.popup, fonts: x.m.fonts, btns: x.m.btns, flowLefts: x.m.flowLefts, units: x.m.units, evs: x.m.evs, menu: x.m.menu, close: x.m.close && { w: x.m.close.w, h: x.m.close.h }, foot: x.m.foot && { h: x.m.foot.h }, docW: x.m.docW };
    const a = JSON.stringify(pick({ m })), c = JSON.stringify(pick(b));
    if (a !== c) breaks.push(`${key}: desktop differs from ${BASE}\n    now  ${a}\n    base ${c}`);
  }
}

writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
await browser.close(); fixture?.kill();
for (const [k, r] of Object.entries<any>(report)) if (!k.includes("@")) console.log(`${r.opened ? "ok  " : "skip"} ${k}${r.kb ? `  keyboard: sheet=${r.kb.popup?.h} send=${r.kb.primary ? r.kb.primary.y + r.kb.primary.h : "-"} field=${r.kb.field ? r.kb.field.y + r.kb.field.h : "-"} kb-open=${r.kb.kb} · closed: sheet=${r.back.popup?.h}` : ""}${r.m ? `  popup=${r.m.popup ? r.m.popup.w + "x" + r.m.popup.h : "-"} small-inputs=${r.m.small}/${r.m.inputs} tiny-buttons=${r.m.tiny}/${r.m.btns} out=${r.m.out.length}` : ""}`);
if (breaks.length) { console.error(`\nFAIL (${breaks.length}):\n  ` + breaks.join("\n  ")); process.exit(1); }
console.log(`\nboard-phone: pass; screenshots and report.json in ${OUT}`);
