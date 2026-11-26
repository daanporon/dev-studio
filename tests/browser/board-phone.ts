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
  const vw = innerWidth, vh = innerHeight, r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(), g = e.closest(".chat-card") && b.width < 44 ? (44 - b.width) / 2 : 0; return { x: Math.round(b.left - g), y: Math.round(b.top - g), w: Math.round(b.width + 2 * g), h: Math.round(b.height + 2 * g) }; }; // a chat-card circle reports its 44px hit area
  const boxes = [...document.querySelectorAll(".modal .mbox")], box = boxes[boxes.length - 1] || null, root = box || document.body;
  const vis = (e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 0 && b.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const scrolls = (e) => { for (let p = e.parentElement; p && p !== root.parentElement; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden") return true; if (p === root) break; } return false; };
  const inputs = [...root.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]),textarea,select")].filter(vis);
  const small = inputs.filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).length;
  const btns = [...root.querySelectorAll("button")].filter(vis);
  const hit = (e) => { const b = e.getBoundingClientRect(); if (!e.closest(".chat-card") || (b.width >= 44 && b.height >= 44)) return b.width >= 44 && b.height >= 44; const cx = b.left + b.width / 2, cy = b.top + b.height / 2; return [[-19, -19], [19, -19], [-19, 19], [19, 19], [0, 0]].every(([dx, dy]) => { const t = document.elementFromPoint(cx + dx, cy + dy); return t && (t === e || e.contains(t)); }); };
  const tiny = btns.filter((e) => !hit(e)).length;
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
  const tinyList = btns.filter((e) => !hit(e)).slice(0, 12).map((e) => e.className.slice(0, 22) + "|" + e.textContent.trim().slice(0, 14) + "|" + Math.round(e.getBoundingClientRect().width) + "x" + Math.round(e.getBoundingClientRect().height));
  return { tinyList, flowLefts, units, evs, menu, menuTiny, vw, vh, popup: r(box), docW: document.documentElement.scrollWidth, boxScrollW: box ? box.scrollWidth : null, inputs: inputs.length, small, fonts, btns: btns.length, tiny,
    close: r(close), primary: r(prim), foot: r(foot), out };
})()`;

type Open = (p: any) => Promise<boolean>;
const click = async (p: any, sel: string, text?: RegExp) => { const l = text ? p.locator(sel).filter({ hasText: text }).first() : p.locator(sel).first(); if (!(await l.count())) return false; await l.click(); await p.waitForTimeout(500); return true; };
const openSettings: Open = async (p) => { await p.evaluate(() => { location.hash = "#settings"; }); await p.waitForTimeout(800); return (await p.locator("#settings").count()) > 0; };
// The chat of another squad member: open the Lead's chat from the question card, then switch (the tab at 1280, the member list on a phone).
const openChat: Open = async (p) => (await click(p, ".qrow, .qnote")) && (await click(p, ".modal .chat-btn"));
const openChatOf = (label: string): Open => async (p) => {
  if (!(await openChat(p))) return false;
  if (await p.locator(".chat-swbtn").count()) { await click(p, ".chat-swbtn"); return click(p, ".chat-mi", new RegExp("^" + label)); }
  return click(p, ".chat-tab", new RegExp("^" + label.slice(0, 12)))   // a long tab label is cut at 14;
};
// mobile-chat-close-hidden U1: a long unit name, with mail and a new reply on another member (set on the api/chat reply), so
// the switcher carries its badge and dot.
const LONG = "builder-u51-compliance-manager-scope";
const openLongName: Open = async (p) => {
  await p.route("**/api/chat?*", async (r: any) => {
    const res = await r.fetch(), j = await res.json();
    for (const m of j.crew ?? []) if (m.label === "tester") { m.unread = 12; m.reply_at = Date.now(); }
    await r.fulfill({ response: res, json: j });
  });
  if (!(await openChatOf(LONG)(p))) return false;
  await p.waitForTimeout(3500);   // the next poll brings a reply newer than the seen mark
  if (await p.locator(".chat .chat-scrtog").count()) {   // the toggle switches the view both ways
    await click(p, ".chat-scrtog"); if (!(await p.locator("pre.chat-screen").count())) return false;
    await click(p, ".chat-scrtog"); if (await p.locator("pre.chat-screen").count()) return false;
  }
  return true;
};
// mobile-chat-close-hidden U2: the member menu, opened with the long-label member shown and in the list.
// One row's label is then made wider than the panel, so the ellipsis is measured at every phone width.
const openLongMenu: Open = async (p) => {
  if (!((await openLongName(p)) && (await click(p, ".chat-swbtn")) && (await p.locator(".chat-menu .chat-mi").filter({ hasText: LONG }).count()))) return false;
  await p.locator(".chat-menu .chat-swlabel").first().evaluate((e: any, t: string) => { e.textContent = t; }, LONG + "-and-a-tail-wider-than-any-phone");
  return true;
};
// chat-view-switcher U1: a question longer than the card (set on the api/chat reply) for builder-platform, with no screen menu.
const longQuestion = (choices: boolean): Open => async (p) => {
  await p.route("**/api/chat?*", async (r: any) => {
    const res = await r.fetch(), j = await res.json();
    if (j.screen) j.screen.menu = 0;
    j.questions = [{ id: "long-q", title: "Which way should the long migration go?", question: choices ? Array.from({ length: 40 }, (_, i) => `- point ${i + 1}: a line of detail the operator reads before answering`).join("\n") : "Say which way.",
      choices: choices ? [{ label: "Yes", does: "do it" }, { label: "No", does: null }] : [], since: "2026-11-25T10:00:00Z", blocking: true, source: "lead", answerable: true }];
    await r.fulfill({ response: res, json: j });
  });
  return openChatOf("builder-platform")(p);
};
// The long card at its open size, then ⤢: the body scrolls on its own, ✕ and Send stay on screen, and ⤢ fills the panel.
const LONG_CARD = `(() => { const q = (s) => document.querySelector(".chat " + s) || document.querySelector(".mbox.chat" + s), bad = [];
  const box = document.querySelector(".mbox.chat"), body = box.querySelector(".chat-dbody"), dock = box.querySelector(".chat-dock"), wrap = box.querySelector(".chat-wrap");
  if (!body || !dock) return ["no open card"];
  const B = box.getBoundingClientRect(), on = (s) => { const b = box.querySelector(s).getBoundingClientRect(); return b.width > 0 && b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight; };
  if (!(body.scrollHeight > body.clientHeight + 20)) bad.push("the card body does not scroll " + body.scrollHeight + "/" + body.clientHeight);
  body.scrollTop = 99999; const top = dock.querySelector(".chat-dhd").getBoundingClientRect(); if (top.top < dock.getBoundingClientRect().top - 1) bad.push("the top line scrolled away"); body.scrollTop = 0;
  if (!on(".mhd .mclose")) bad.push("✕ is off screen"); if (!on(".chat-send")) bad.push("Send is off screen");
  const cap = (innerWidth <= 600 ? 0.5 : 0.6) * B.height; if (dock.getBoundingClientRect().height > cap + 2) bad.push("open card " + Math.round(dock.getBoundingClientRect().height) + " px, cap " + Math.round(cap));
  if (wrap.getBoundingClientRect().height < 100) bad.push("the chat above the card is " + Math.round(wrap.getBoundingClientRect().height) + " px");
  box.querySelector(".chat-dfull").click();
  return new Promise((ok) => setTimeout(() => {
    const d = box.querySelector(".chat-dock").getBoundingClientRect(), hd = box.querySelector(".mhd").getBoundingClientRect(), tabs = box.querySelector(".chat-tabs"), foot = box.querySelector(".qfoot").getBoundingClientRect();
    const from = (tabs || box.querySelector(".mhd")).getBoundingClientRect().bottom;
    if (d.top - from > 2 || foot.top - d.bottom > 12) bad.push("⤢ does not fill the panel: " + Math.round(d.top - from) + " above, " + Math.round(foot.top - d.bottom) + " below");
    if (getComputedStyle(box.querySelector(".chat-wrap")).visibility !== "hidden") bad.push("the log still shows under ⤢");
    if (!on(".mhd .mclose")) bad.push("⤢: ✕ is off screen"); if (!on(".chat-send")) bad.push("⤢: Send is off screen");
    ok(bad);
  }, 300)); })()`;
// chat-key-buttons U1: what each chat view must show, run in the page; returns the list of problems.
const CHAT_CHECK = (want: string) => `((want) => { const q = (s) => document.querySelector(".chat " + s), all = (s) => [...document.querySelectorAll(".chat " + s)], bad = [];
  const card = q(".chat-card"), vis = (e) => e && e.getBoundingClientRect().width > 0;
  if (!card) bad.push("no .chat-card"); else {
    const kids = [...card.querySelectorAll("button:not(.chat-scrtog)")].map((b) => b.className.replace(/btn |chat-round /g, "").trim());
    const okKids = want === "long" || want === "long-menu" || want === "working" || want === "menu" || want === "screen" || want === "question" ? ["chat-attach", "chat-stop", "chat-send pri"] : ["chat-attach", "chat-send pri"];
    if (JSON.stringify(kids.map((k) => k.replace("pri chat-send", "chat-send pri"))) !== JSON.stringify(okKids)) bad.push("card buttons " + kids);
    const r = card.getBoundingClientRect(); if (r.height > 200) bad.push("card is " + Math.round(r.height) + " px tall");
    if (parseFloat(getComputedStyle(card).borderTopLeftRadius) < 16) bad.push("card radius");
    for (const b of card.querySelectorAll("button:not(.chat-scrtog)")) { const x = b.getBoundingClientRect(); if (x.width < 32 || x.height < 32 || x.width > 34 || (b.className.indexOf("chat-attach") < 0 && x.width !== x.height)) bad.push("round button " + b.className + " " + Math.round(x.width) + "x" + Math.round(x.height)); }
  }
  const keys = q(".chat-keys"), scr = q(".chat-row .chat-scrtog");
  if (want === "screen") { const n = keys ? keys.querySelectorAll("button").length : 0; if (n !== 8) bad.push("Screen shows " + n + " keys, not Esc ↑ ↓ ⏎ ⇥ 1 2 3"); if (keys && card && keys.getBoundingClientRect().bottom > card.getBoundingClientRect().top + 1) bad.push("keys not above the card"); }
  else if (keys) bad.push("Chat shows a key row");
  if (want === "idle") { if (q(".chat-stop")) bad.push("idle shows ■"); if (q(".chat-dock")) bad.push("idle shows a question card"); }
  if (want === "working" && !(q(".chat-stop") && q(".chat-stop").closest(".chat-card"))) bad.push("working has no ■ in the card");
  if (want === "question") { const qv = q(".chat-q"); if (!qv) bad.push("no Question view"); else { for (const b of qv.querySelectorAll(".chat-qopt")) { const x = b.getBoundingClientRect(); if (x.height < 44) bad.push("choice " + Math.round(x.height) + " px tall"); } if (!qv.querySelector(".chat-qopt")) bad.push("no choices"); } if (!q(".chat-dock.open")) bad.push("the card is not open"); if (!(q(".chat-wrap") && q(".chat-wrap").getBoundingClientRect().height >= 100)) bad.push("no chat above the card"); if (keys) bad.push("Question shows a key row"); }
  if (want === "menu") { const b = q(".chat-dock.folded .chat-dline"); if (!b || !/▴/.test(b.textContent)) bad.push("no folded menu line"); else if (b.getBoundingClientRect().height > 70) bad.push("the folded line is " + Math.round(b.getBoundingClientRect().height) + " px tall"); }
  if (want === "screen" && !q(".chat-dock.open .chat-qopt")) bad.push("the screen menu has no card with options");
  if (want === "long-menu" && innerWidth <= 600) {
    const m = q(".chat-menu"); if (!m) bad.push("no .chat-menu"); else {
      const b = m.getBoundingClientRect(); if (b.left < 0 || b.right > innerWidth || b.bottom > innerHeight) bad.push("menu " + Math.round(b.left) + "→" + Math.round(b.right) + " (bottom " + Math.round(b.bottom) + ") not inside " + innerWidth + "x" + innerHeight);
      if (b.top < q(".mhd").getBoundingClientRect().bottom - 1) bad.push("the menu does not open under the header");
      const first = m.querySelector(".chat-swlabel"); if (!first || first.scrollWidth <= first.clientWidth) bad.push("the over-wide label is not cut");
      for (const it of m.querySelectorAll(".chat-mi")) { const x = it.getBoundingClientRect(), l = it.querySelector(".chat-swlabel"); if (x.height < 44) bad.push("menu row " + Math.round(x.height) + " px tall"); if (x.right > b.right + 1 || l.getBoundingClientRect().right > x.right + 1) bad.push("menu row sticks out: " + l.textContent); if (l.scrollWidth > l.clientWidth && getComputedStyle(l).textOverflow !== "ellipsis") bad.push("cut without an ellipsis: " + l.textContent); }
    }
  }
  // chat-view-switcher U1: Screen sits in .chat-row, never in the header and never as a row of its own.
  if (want !== "working" && !scr) bad.push("Screen toggle is not in .chat-row");
  if (q(".mhd .chat-scrtog, .mhd .chat-scr, .mhd .chat-seg")) bad.push("a view switch is in the header");
  if (scr) { const a = q(".chat-row .chat-attach").getBoundingClientRect(), t = scr.getBoundingClientRect(); if (Math.abs((a.top + a.bottom) - (t.top + t.bottom)) > 4) bad.push("Screen toggle is on a row of its own"); }
  // mobile-chat-close-hidden U1: on a phone the header is one row with ✕ on screen and never overflows.
  if (want === "long" && innerWidth <= 600) {
    const hd = q(".mhd"), x = q(".mhd .mclose").getBoundingClientRect(), dot = q(".chat-swbtn .chat-new"), mailBadge = q(".chat-swbtn .msg-badge");
    if (!vis(dot) || !vis(mailBadge)) bad.push("the switcher shows no mail badge and new-reply dot");
    else if (mailBadge.scrollWidth > mailBadge.clientWidth) bad.push("the mail badge is squeezed");
    if (x.right > innerWidth) bad.push("✕ right edge " + Math.round(x.right) + " past " + innerWidth);
    if (hd.scrollWidth !== innerWidth) bad.push("header scrollWidth " + hd.scrollWidth + " is not " + innerWidth);
    if (hd.getBoundingClientRect().height > 80) bad.push("the header is " + Math.round(hd.getBoundingClientRect().height) + " px tall, not one row");
  }
  const lab = q(".chat-swbtn .chat-swlabel"); if (lab && lab.textContent === "tester" && lab.scrollWidth > lab.clientWidth) bad.push("the short label tester is cut");
  return bad; })(${JSON.stringify(want)})`;
const VIEWS: { name: string; strict: boolean; kind?: string; field?: string; chat?: string; open: Open }[] = [
  { name: "question", strict: true, open: (p) => click(p, ".qrow, .qnote") },
  { name: "chat", strict: true, open: async (p) => (await click(p, ".qrow, .qnote")) && (await click(p, ".modal .chat-btn")) },
  { name: "chat-working", strict: true, chat: "working", open: openChat },
  { name: "chat-idle", strict: true, chat: "idle", open: openChatOf("tester") },
  { name: "chat-menu", strict: true, chat: "menu", open: async (p) => (await openChatOf("builder-platform")(p)) && (await click(p, ".chat-dfold")) },
  { name: "chat-question", strict: true, chat: "question", open: openChatOf("builder-platform") },
  { name: "chat-screen", strict: true, chat: "screen", open: async (p) => (await openChatOf("builder-platform")(p)) && (await click(p, ".chat-scrtog")) },
  { name: "chat-long-question", strict: true, chat: "long-card", open: longQuestion(true) },
  { name: "long-name-chat", strict: true, chat: "long", open: openLongName },
  { name: "long-name-menu", strict: true, chat: "long-menu", open: openLongMenu },
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
  { name: "kb-chat-question", strict: true, kind: "keyboard", field: ".chat-modal .chat-dock .chat-qtext", open: longQuestion(false) },
  { name: "kb-chat-idle", strict: true, kind: "keyboard", field: ".chat-modal .chat-in", chat: "idle", open: openChatOf("tester") },
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
  const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(), g = e.closest(".chat-card") && b.width < 44 ? (44 - b.width) / 2 : 0; return { x: Math.round(b.left - g), y: Math.round(b.top - g), w: Math.round(b.width + 2 * g), h: Math.round(b.height + 2 * g) }; }; // a chat-card circle reports its 44px hit area
  const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).display !== "none"; };
  const boxes = [...document.querySelectorAll(".modal .mbox")], box = boxes[boxes.length - 1];
  const f = document.querySelector(field);
  return { cardSend: f && f.classList.contains("chat-qtext") ? r(f.nextElementSibling) : undefined, vh: innerHeight, popup: r(box), primary: r(box && [...box.querySelectorAll(".qfoot .btn.pri")].filter(vis).pop()), field: r(f), focused: document.activeElement === f,
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
  // A spinning status dot's box changes with its angle: stop animations so a measure never depends on the moment.
  await p.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
  const y0: number = await p.evaluate(() => scrollY);
  const opened = await v.open(p);
  if (v.kind === "keyboard") {
    if (!opened || !(await p.locator(v.field!).count())) { await ctx.close(); return { opened: false, m: null }; }
    await p.locator(v.field!).first().focus();
    await p.evaluate((h: number) => (window as any).__kb(h), size.h - 300); await p.waitForTimeout(400);
    const kb = await p.evaluate(`${KB_MEASURE}(${JSON.stringify(v.field)})`);
    if (v.chat) kb.chat = await p.evaluate(CHAT_CHECK(v.chat));
    await p.screenshot({ path: join(OUT, `${size.w}-${view}.png`) });
    // The band between the sheet's bottom and the window's bottom (the stub shrinks only visualViewport): iOS 26's see-through chrome
    // shows what is under it, so the sheet must paint and own it. Three points, and the pixel at each is read back from a screenshot.
    const cover: any[] = [];
    const sel = JSON.stringify(v.field);
    const pts: { x: number; y: number }[] = await p.evaluate(`(() => { const m = document.querySelector(${sel}).closest(".mbox"); const b = m.getBoundingClientRect(), H = innerHeight, x = Math.round(innerWidth / 2);
      return [Math.ceil(b.bottom) + 1, Math.round((b.bottom + H) / 2), H - 2].map((y) => ({ x, y })); })()`);
    for (const pt of pts) {
      const hit = await p.evaluate(`(() => { const m = document.querySelector(${sel}).closest(".mbox"); const e = document.elementFromPoint(${pt.x}, ${pt.y}); const top = [...document.querySelectorAll(".modal .mbox")].pop();
        return { inside: !!e && m.contains(e), topmost: m === top }; })()`);
      const png = (await p.screenshot({ clip: { x: pt.x, y: pt.y, width: 1, height: 1 } })).toString("base64");
      const rgb: number[] = await p.evaluate(`new Promise((ok) => { const i = new Image(); i.onload = () => { const c = document.createElement("canvas"); c.width = c.height = 1; const g = c.getContext("2d"); g.drawImage(i, 0, 0); ok([...g.getImageData(0, 0, 1, 1).data].slice(0, 3)); }; i.src = "data:image/png;base64,${png}"; })`);
      cover.push({ ...pt, ...hit, rgb });
    }
    // iOS 26 shows a copy of the rendered page in that strip, so the board under the sheet must not render at all.
    const HIDE = `(() => { const vis = (e) => e ? getComputedStyle(e).visibility : "none";
      return { tiles: vis(document.querySelector(".tiles")), row: vis(document.querySelector("#root tr, #root .sq")), box: vis(document.querySelector(".modal .mbox")), bg: getComputedStyle(document.documentElement).backgroundColor, y: scrollY }; })()`;
    const hide: any = await p.evaluate(HIDE);
    const open0 = await p.locator(".modal").count();
    await p.mouse.click(pts[1].x, pts[1].y); await p.waitForTimeout(200);
    const stays = (await p.locator(".modal").count()) === open0;
    await p.evaluate(() => (window as any).__kb(null)); await p.waitForTimeout(400);
    const back = await p.evaluate(`${KB_MEASURE}(${JSON.stringify(v.field)})`);
    for (let i = 0; i < 4 && (await p.locator(".modal").count()); i++) { await p.keyboard.press("Escape"); await p.waitForTimeout(150); if (await p.locator(".modal").count()) await p.locator(".modal .mclose").last().click({ timeout: 1000 }).catch(() => {}); await p.waitForTimeout(150); }
    const after: any = await p.evaluate(HIDE);
    await ctx.close();
    return { opened, m: null, kb, back, cover, stays, hide, after, y0 };
  }
  const m = opened ? await p.evaluate(MEASURE) : null;
  if (m && v.chat) m.chat = await p.evaluate(v.chat === "long-card" ? LONG_CARD : CHAT_CHECK(v.chat));
  if (opened && !base && v.chat === "long-card") await p.screenshot({ path: join(OUT, `${size.w}-${view}-full.png`) });
  if (opened && !base) await p.screenshot({ path: join(OUT, `${size.w}-${view}.png`) });
  await ctx.close();
  return { opened, m } as any;
};

// The long name and its menu are also measured at 390 px (the middle phone width).
const RUNS = [...SIZES.flatMap((size) => VIEWS.map((v) => ({ size, v }))), ...["long-name-chat", "long-name-menu"].map((n) => ({ size: { w: 390, h: 844, phone: true }, v: VIEWS.find((v) => v.name === n)! }))];
for (const { size, v } of RUNS) {
  if ((v.kind === "keyboard" || v.name === "long-name-menu") && !size.phone) continue;   // the desktop chat has tabs, no member menu
  const key = `${size.w}/${v.name}`; const { opened, m, kb, back, cover, stays, hide, after, y0 } = await shoot(size, v.name, false);
  report[key] = { opened, m, kb, back, cover, stays };
  if (!opened) { if (v.strict) breaks.push(`${key}: did not open`); continue; }
  if (v.kind === "keyboard") {
    const need = (ok: boolean, why: string) => { if (!ok) breaks.push(`${key}: ${why}`); };
    const H = size.h - 300, inside = (b: any) => b && b.y >= 0 && b.y + b.h <= H + 1;
    need(!!kb.popup && kb.popup.y === 0 && Math.abs(kb.popup.h - H) <= 1, `keyboard open: sheet ${JSON.stringify(kb.popup)} is not the ${H} px above the keyboard`);
    need(inside(kb.primary) && kb.primary.h >= 44, `keyboard open: Send ${JSON.stringify(kb.primary)} not above the keyboard`);
    if (v.name === "kb-chat-question") need(!!kb.cardSend && inside(kb.cardSend) && kb.cardSend.h >= 44, `keyboard open: the card's send button ${JSON.stringify(kb.cardSend)} not above the keyboard`);
    need(kb.focused && inside(kb.field), `keyboard open: the focused field ${JSON.stringify(kb.field)} (focused ${kb.focused}) not above the keyboard`);
    for (const c of cover) {
      need(c.inside && c.topmost, `keyboard open: the point (${c.x}, ${c.y}) under the sheet hits the board, not the sheet`);
      need(c.rgb.every((v: number, i: number) => Math.abs(v - [0x15, 0x19, 0x20][i]) <= 2), `keyboard open: the point (${c.x}, ${c.y}) under the sheet paints rgb(${c.rgb}), not the sheet's #151920`);
    }
    need(hide.tiles === "hidden" && hide.row !== "visible", `keyboard open: the board still renders under the sheet (tiles ${hide.tiles}, row ${hide.row})`);
    need(hide.box === "visible", `keyboard open: the sheet itself is ${hide.box}`);
    need((hide.bg.match(/\d+/g) || []).slice(0, 3).every((v: string, i: number) => Math.abs(+v - [0x15, 0x19, 0x20][i]) <= 2), `keyboard open: the page background ${hide.bg} is not the sheet's #151920`);
    need(after.tiles === "visible" && after.y === y0, `sheet closed: tiles ${after.tiles}, scrollY ${after.y} (was ${y0})`);
    need(stays, "keyboard open: a tap on the strip under the sheet closed it");
    need(kb.kb, "keyboard open: no kb-open on the root");
    if (v.chat) need(kb.chat.length === 0, `keyboard open: ${kb.chat}`);
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
  if (v.chat && m) { if (m.chat.length) breaks.push(`${key}: ${m.chat}`); }
  if (size.phone && v.kind !== "page" && m) {
    const need = (ok: boolean, why: string) => { if (!ok && v.strict) breaks.push(`${key}: ${why}`); };
    const pp = m.popup;
    need(!!pp && pp.x === 0 && pp.y === 0 && pp.w === m.vw && Math.abs(pp.h - m.vh) <= 1, `popup box ${JSON.stringify(pp)} is not the ${m.vw}x${m.vh} viewport`);
    const onScreen = (b: any) => b && b.x >= 0 && b.y >= 0 && b.x + b.w <= m.vw + 1 && b.y + b.h <= m.vh + 1;
    need(onScreen(m.close) && m.close.w >= 44 && m.close.h >= 44, `close ✕ ${JSON.stringify(m.close)} not on screen at >= 44 px`);
    if (m.primary) need(onScreen(m.primary) && m.primary.h >= 44, `primary button ${JSON.stringify(m.primary)} not on screen at >= 44 px`);
    else if (v.name === "question") need(false, "no primary button found");
    need(m.tiny === 0, `${m.tiny} button(s) under 44 px`);
    need(m.tiny === 0, `${m.tiny} of ${m.btns} buttons under 44 px: ${m.tinyList.join(" ; ")}`);
    need(m.small === 0, `${m.small} input(s) under 16 px (${m.fonts})`);
    need(m.out.length === 0 && m.boxScrollW <= m.vw + 1, `sticks out past the right edge: ${m.out} (box scrollWidth ${m.boxScrollW})`);
  }
  // The chat views changed on purpose at every width (chat-key-buttons U1); long-name-chat too: its header lost the Screen button (chat-view-switcher U1).
  if (!size.phone && !/^chat/.test(v.name) && v.name !== "long-name-chat") {
    const b = await shoot(size, v.name, true); report[`${key}@base`] = b;
    const pick = (x: any) => x.m && { popup: x.m.popup, fonts: x.m.fonts, btns: x.m.btns, flowLefts: x.m.flowLefts, units: x.m.units, evs: x.m.evs, menu: x.m.menu, close: x.m.close && { w: x.m.close.w, h: x.m.close.h }, foot: x.m.foot && { h: x.m.foot.h }, docW: x.m.docW };
    const a = JSON.stringify(pick({ m })), c = JSON.stringify(pick(b));
    if (a !== c) breaks.push(`${key}: desktop differs from ${BASE}\n    now  ${a}\n    base ${c}`);
  }
}

// The chat title keeps its leading "Chat ·" on one unbroken line at 390 and 320 px (a squad member's and the Studio's).
const TITLE = `(() => { const lead = document.querySelector(".chat .mhd .chat-lead"); if (!lead) return null;
  const hd = lead.closest(".mhd"), cs = getComputedStyle(lead), r = (e) => e && e.getBoundingClientRect();
  const probe = document.createElement("span"); probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;font:" + cs.font; probe.textContent = lead.textContent.replace(/\\s+$/, ""); hd.appendChild(probe);
  const alone = r(probe).width, aloneH = r(probe).height; probe.remove();
  const sub = hd.querySelector(".chat-sub"), close = hd.querySelector(".mclose");
  return { text: lead.textContent, h: r(lead).height, lh: aloneH, w: r(lead).width, alone, closeMid: r(close).top + r(close).height / 2, leadMid: r(lead).top + r(lead).height / 2, subEllipsis: !sub || getComputedStyle(sub).textOverflow === "ellipsis" || sub.scrollWidth <= sub.clientWidth + 1, hdH: r(hd).height,
    seg: !!hd.querySelector(".chat-seg, .chat-scr, .chat-scrtog"), tog: !!document.querySelector(".chat .chat-row .chat-scrtog") }; })()`;
for (const w of [390, 320]) for (const who of ["member", "studio"]) {
  const key = `${w}/chat-title-${who}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.route("**/api/**", (r: any) => (r.request().method() === "GET" ? r.continue() : r.abort()));
  await p.goto(url!, { waitUntil: "networkidle" }); await p.waitForTimeout(1200);
  const opened = who === "member" ? await openChatOf("builder-platform")(p) : (await click(p, "button", /Studio/)) && (await p.locator(".chat").count()) > 0;
  const t = opened ? await p.evaluate(TITLE) : null;
  await ctx.close();
  if (!t) { if (who === "member") breaks.push(`${key}: the chat did not open`); else console.log(`skip ${key}: no Studio chat in this fixture`); continue; }
  if (who === "studio" && !t.text.startsWith("Chat · Studio")) { console.log(`skip ${key}: opened ${t.text}`); continue; }
  const need = (ok: boolean, why: string) => { if (!ok) breaks.push(`${key}: ${why} ${JSON.stringify(t)}`); };
  need(Math.abs(t.h - t.lh) <= 1, "the Chat · title is not one line");
  need(t.w >= t.alone - 1, "the Chat · title is narrower than its own text");
  need(Math.abs(t.closeMid - t.leadMid) <= 4, "the ✕ is not on the title's row");
  need(!t.seg, "a view switch is in the header");
  if (who === "member") need(t.tog, "no Screen toggle in the message box row");   // this member has a screen read
  need(t.subEllipsis, "the .chat-sub neither fits nor ends in an ellipsis");
  console.log(`ok   ${key}: title ${Math.round(t.w)}x${Math.round(t.h)}`);
}

writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
await browser.close(); fixture?.kill();
for (const [k, r] of Object.entries<any>(report)) if (!k.includes("@")) console.log(`${r.opened ? "ok  " : "skip"} ${k}${r.kb ? `  keyboard: sheet=${r.kb.popup?.h} send=${r.kb.primary ? r.kb.primary.y + r.kb.primary.h : "-"} field=${r.kb.field ? r.kb.field.y + r.kb.field.h : "-"} kb-open=${r.kb.kb} · closed: sheet=${r.back.popup?.h}` : ""}${r.m ? `  popup=${r.m.popup ? r.m.popup.w + "x" + r.m.popup.h : "-"} small-inputs=${r.m.small}/${r.m.inputs} tiny-buttons=${r.m.tiny}/${r.m.btns} out=${r.m.out.length}` : ""}`);
if (breaks.length) { console.error(`\nFAIL (${breaks.length}):\n  ` + breaks.join("\n  ")); process.exit(1); }
console.log(`\nboard-phone: pass; screenshots and report.json in ${OUT}`);
