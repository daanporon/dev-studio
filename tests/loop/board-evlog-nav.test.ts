// The event log page's search box and jump-to-day (U5): typing sends `q=` after a pause, the "searched back to
// ... search older" row sends `before=<to_id>`, a date sends `until=`, Clear filters empties both, and a searched
// or jumped page does not refetch on a board tick.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const page = readFileSync(join(import.meta.dir, "..", "..", "web", "board.html"), "utf8");
const cut = (a: string, b: string, name: string) => new Function(`${page.slice(page.indexOf(a), page.indexOf(b, page.indexOf(a)))} return ${name};`)();
const live: (cur: any, q?: string, day?: string) => boolean = cut("const evLive =", "\n", "evLive");
const dayEnd: (v: string) => number | null = cut("const evDayEnd =", "\n", "evDayEnd");

test("evLive: a searched or day-jumped page is not live", () => {
  expect(live({})).toBe(true);
  expect(live({}, "584")).toBe(false);
  expect(live({}, "", "2026-11-15")).toBe(false);
  expect(live({ before: 5 }, "", "")).toBe(false);
});

test("evDayEnd is the local end of the day", () => {
  expect(dayEnd("2026-11-15")).toBe(new Date(2026, 10, 15, 23, 59, 59).getTime() / 1000);
  expect(dayEnd("")).toBeNull();
  expect(dayEnd("nonsense")).toBeNull();
});

const fx = (n: string) => readFileSync(join(import.meta.dir, "../fixtures/evlog", n), "utf8");
const now = Math.floor(Date.now() / 1000), old = now - 3 * 86400;
const fill = (t: string) => JSON.parse(t.replace("__NEW__", String(now)).replace("__OLD__", String(old)));
const board = { ...JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/board-empty.json"), "utf8")), project: "fixture", page_version: "v1", squads: [] };
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test("search, search older, jump to day, Clear filters, and no refetch on a board tick", async () => {
  const r = await mount(board, true, { "api/events/lists": JSON.parse(fx("lists.json")), "api/events?": fill(fx("page.json")) });
  try {
    const win = r.window, doc = win.document, ev = doc.getElementById("events");
    const plain = win.fetch;
    win.fetch = async (url: string) => (String(url).startsWith("api/events?") && String(url).includes("q=")
      ? (r.urls.push(String(url)), { ok: true, status: 200, json: async () => fill(fx("search.json")) }) : plain(url));
    await settle();
    const q = ev.querySelector('[data-ev="q"]'), day = ev.querySelector('[data-ev="day"]');
    expect(q.getAttribute("maxlength")).toBe("100");
    const type = (el: any, v: string, evName: string) => {
      Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new win.Event(evName, { bubbles: true }));
    };
    const evUrls = () => r.urls.filter((u: string) => u.startsWith("api/events?"));
    r.urls.length = 0;
    type(q, "#584", "input"); await settle(100);
    expect(evUrls()).toEqual([]); // still inside the 300 ms pause
    await settle(400);
    const sent = evUrls();
    expect(sent.length).toBe(1);
    expect(new URLSearchParams(sent[0].split("?")[1]).get("q")).toBe("#584");
    expect(ev.querySelector('[data-ev="searched"]').textContent).toContain("searched back to");
    // the search page does not refetch on a board tick
    r.urls.length = 0; await settle(300);
    expect(evUrls()).toEqual([]);
    // click: search older sends before=<to_id>; newer returns to the first slice
    ev.querySelector('[data-ev="search-older"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true })); await settle();
    expect(new URLSearchParams(evUrls().pop()!.split("?")[1]).get("before")).toBe("30");
    expect(ev.querySelector('[data-ev="newer"]')).not.toBeNull();
    ev.querySelector('[data-ev="newer"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true })); await settle();
    expect(new URLSearchParams(evUrls().pop()!.split("?")[1]).get("before")).toBeNull();
    expect(ev.querySelector('[data-ev="newer"]')).toBeNull();
    // Clear filters empties the search and the date
    ev.querySelector('[data-ev="clear"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true })); await settle();
    expect(q.value).toBe("");
    expect(evUrls().pop()).not.toContain("q=");
    // picking a day sends until= (local end of that day)
    r.urls.length = 0;
    type(day, "2026-11-15", "change"); await settle();
    const u = new URLSearchParams(evUrls().pop()!.split("?")[1]);
    expect(u.get("until")).toBe(String(dayEnd("2026-11-15")));
    expect(ev.textContent).not.toContain("· live");
    r.urls.length = 0; await settle(300);
    expect(evUrls()).toEqual([]);
    ev.querySelector('[data-ev="clear"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true })); await settle();
    expect(day.value).toBe("");
    expect(evUrls().pop()).not.toContain("until=");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});
