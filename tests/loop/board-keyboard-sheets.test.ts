// board-mobile-fullscreen-popups U4: keyboardSheets() in web/board.html keeps a phone sheet above the keyboard. Run in happy-dom
// with a stubbed visualViewport (an iPhone keyboard leaves it 300 px shorter and fires resize) and a stubbed (max-width:600px).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const src = (() => { const i = page.indexOf("function keyboardSheets("); return page.slice(i, page.indexOf("\n}\n", i) + 2); })();
const keyboardSheets = new Function(`${src} return keyboardSheets;`)();
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup({ phone = true, viewport = true } = {}) {
  const w: any = new Window({ url: "http://localhost/", width: 375, height: 812 });
  w.document.write('<!doctype html><html><body><div id="root"></div></body></html>');
  const mqListeners = new Set<any>();
  const mq = { matches: phone, addEventListener: (_: string, f: any) => mqListeners.add(f), removeEventListener: (_: string, f: any) => mqListeners.delete(f) };
  w.matchMedia = () => mq;
  const vvListeners = new Map<string, Set<any>>();
  const vv = { height: 812, offsetTop: 0, scale: 1,
    addEventListener: (k: string, f: any) => { if (!vvListeners.has(k)) vvListeners.set(k, new Set()); vvListeners.get(k)!.add(f); },
    removeEventListener: (k: string, f: any) => vvListeners.get(k)?.delete(f) };
  if (viewport) w.visualViewport = vv;
  const fire = (k = "resize") => { for (const f of vvListeners.get(k) || []) f(); };
  const count = () => [...vvListeners.values()].reduce((a, s) => a + s.size, 0);
  const root = w.document.documentElement;
  const vars = () => ({ vvh: root.style.getPropertyValue("--vvh"), vvtop: root.style.getPropertyValue("--vvtop"), kb: root.classList.contains("kb-open") });
  const open = async () => { const m = w.document.createElement("div"); m.className = "modal"; m.innerHTML = '<div class="mbox"><div class="qbody"><textarea></textarea></div></div>'; w.document.getElementById("root").appendChild(m); await tick(); return m; };
  const setWidth = (phoneNow: boolean) => { mq.matches = phoneNow; for (const f of mqListeners) f(); };
  return { w, vv, fire, count, vars, open, setWidth, mqListeners };
}

test("no sheet open: no visualViewport listener and no variable", async () => {
  const s = setup();
  const stop = keyboardSheets(s.w);
  await tick();
  expect(s.count()).toBe(0);
  expect(s.vars()).toEqual({ vvh: "", vvtop: "", kb: false });
  stop(); await s.w.happyDOM.close();
});

test("a sheet opens: the variables follow visualViewport, the keyboard sets kb-open, closing it restores the sheet", async () => {
  const s = setup();
  const stop = keyboardSheets(s.w);
  const m = await s.open();
  expect(s.count()).toBe(2); // resize and scroll
  expect(s.vars()).toEqual({ vvh: "812px", vvtop: "0px", kb: false });
  s.vv.height = 512; s.vv.offsetTop = 40; s.fire("resize");
  expect(s.vars()).toEqual({ vvh: "512px", vvtop: "40px", kb: true });
  s.vv.offsetTop = 60; s.fire("scroll");
  expect(s.vars().vvtop).toBe("60px");
  s.vv.height = 812; s.vv.offsetTop = 0; s.fire("resize");
  expect(s.vars()).toEqual({ vvh: "812px", vvtop: "0px", kb: false });
  // A small change (Android's URL bar) is not a keyboard.
  s.vv.height = 760; s.fire("resize");
  expect(s.vars().kb).toBe(false);
  // The last sheet closes: listeners gone, variables and class cleared.
  s.vv.height = 512; s.fire("resize");
  m.remove(); await tick();
  expect(s.count()).toBe(0);
  expect(s.vars()).toEqual({ vvh: "", vvtop: "", kb: false });
  stop(); await s.w.happyDOM.close();
});

test("a nested sheet keeps the listener until the last one closes", async () => {
  const s = setup();
  const stop = keyboardSheets(s.w);
  const a = await s.open(), b = await s.open();
  expect(s.count()).toBe(2);
  b.remove(); await tick();
  expect(s.count()).toBe(2);
  a.remove(); await tick();
  expect(s.count()).toBe(0);
  stop(); await s.w.happyDOM.close();
});

test("Android: the layout shrank with the keyboard (innerHeight = visual height), kb-open still set from the tallest height seen", async () => {
  const s = setup();
  const stop = keyboardSheets(s.w);
  await s.open();
  s.w.happyDOM.setViewport({ width: 375, height: 512 }); s.vv.height = 512; s.fire("resize");
  expect(s.vars()).toEqual({ vvh: "512px", vvtop: "0px", kb: true });
  stop(); await s.w.happyDOM.close();
});

test("a pinch zoom drops the variables; over 600 px wide nothing is set; without visualViewport nothing is installed", async () => {
  const s = setup();
  const stop = keyboardSheets(s.w);
  await s.open();
  s.vv.scale = 2; s.vv.height = 406; s.fire("resize");
  expect(s.vars()).toEqual({ vvh: "", vvtop: "", kb: false });
  s.vv.scale = 1; s.vv.height = 812; s.fire("resize");
  s.setWidth(false); await tick();
  expect(s.count()).toBe(0);
  expect(s.vars()).toEqual({ vvh: "", vvtop: "", kb: false });
  s.setWidth(true); await tick();
  expect(s.count()).toBe(2);
  stop();
  expect(s.count()).toBe(0);
  expect(s.mqListeners.size).toBe(0);
  await s.w.happyDOM.close();

  const d = setup({ phone: false });
  const stopD = keyboardSheets(d.w);
  await d.open();
  expect(d.count()).toBe(0);
  expect(d.vars()).toEqual({ vvh: "", vvtop: "", kb: false });
  stopD(); await d.w.happyDOM.close();

  const n = setup({ viewport: false });
  const stopN = keyboardSheets(n.w);
  await n.open();
  expect(n.vars()).toEqual({ vvh: "", vvtop: "", kb: false });
  expect(n.mqListeners.size).toBe(0);
  stopN(); await n.w.happyDOM.close();
});

test("the page installs it and sizes the phone sheet by the variables", () => {
  expect(page).toContain("keyboardSheets(window);");
  expect(page).toMatch(/@media \(max-width:600px\)\{\n\.modal\{top:var\(--vvtop,0px\);bottom:auto;height:var\(--vvh,100dvh\)\}/);
  expect(page).toContain(".kb-open .mbox>.qfoot>.qsec,.kb-open .mbox>.qfoot>.chat-btn{display:none}");
  expect(page.match(/enterkeyhint="send"/g)?.length).toBe(2);
});
