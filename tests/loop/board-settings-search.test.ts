// board-settings-search.test.ts — settings-search-filter U1: the search box in the board's Settings window
// filters and opens the Limits groups without touching the folds the operator stored. The real page runs in
// happy-dom on a three-group api/limits fixture.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const ROOT = join(import.meta.dir, "..", "..");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const row = (group: string, key: string, comment: string, value = "1", extra: any = {}) =>
  ({ group, key, comment, value, source: "default", env: "", ...extra });
const LIMITS = [
  row("Context & compaction", "auto_compact_builder", "compaction point of a builder", "80"),
  row("Context & compaction", "context_window", "the window size", "200"),
  row("Review", "review_model", "who reviews", "opus"),
  row("Review", "review_rounds", "how many rounds", "3"),
  row("Machine", "restart_rss_gb", "memory before a restart", "4", { source: "env", env: "DS_RESTART_RSS" }),
];
const GROUPS = ["Context & compaction", "Review", "Machine"];

async function start() {
  const board = { ...JSON.parse(readFileSync(join(ROOT, "tests/fixtures/board-empty.json"), "utf8")), project: "p", page_version: "v1" };
  const r = await mount(board, false, { "api/limits": { limits: LIMITS, groups: GROUPS }, "api/roles": { roles: [] }, "api/skills": { roles: [] } });
  const w = r.window, doc = w.document;
  const posts: { url: string; body: any }[] = [];
  const base = w.fetch;
  w.fetch = async (url: string, init?: any) => {
    if (init?.method !== "POST") return base(url, init);
    posts.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await tick(); };
  await click([...doc.querySelectorAll("button")].find((b: any) => b.textContent.includes("Settings")));
  const cats = () => [...doc.querySelectorAll("#settings details.set-cat")] as any[];
  // React drops the toggle happy-dom fires inside its commit, so a browser's search-driven toggle is sent by hand.
  const toggles = async () => { for (const d of cats()) d.dispatchEvent(new w.Event("toggle")); await tick(); };
  const box = () => doc.querySelector('#settings input[aria-label="Search settings"]') as any;
  // React reads a typed value through the prototype setter; a plain assignment would look unchanged to it.
  const setValue = async (el: any, value: string) => {
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new w.Event("input", { bubbles: true })); await tick();
  };
  const type = async (q: string) => { await setValue(box(), q); await toggles(); };
  const esc = async () => { box().dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick(); await toggles(); };
  const fold = async (d: any, open: boolean) => { d.open = open; d.dispatchEvent(new w.Event("toggle")); await tick(); };
  const view = () => cats().map((d) => ({
    summary: d.querySelector("summary").textContent, open: d.open,
    keys: [...d.querySelectorAll("tbody tr code:first-child")].map((c: any) => c.textContent),
  }));
  const opens = () => cats().map((d) => d.open);
  const stored = () => Object.keys(w.localStorage).filter((k) => k.includes("set:limits:"));
  return { r, w, doc, posts, click, cats, box, type, setValue, esc, fold, view, opens, stored };
}

test("typing opens only matching groups and rows; Esc restores the folds and keeps the window", async () => {
  const p = await start();
  try {
    expect(p.opens()).toEqual([false, false, false]);
    await p.type("compact"); // also the group's name, so the whole group shows
    expect(p.view()).toEqual([{ summary: "Context & compaction · 2 of 2 match", open: true, keys: ["auto_compact_builder", "context_window"] }]);
    await p.type("auto compact");
    expect(p.view()).toEqual([{ summary: "Context & compaction · 1 of 2 match", open: true, keys: ["auto_compact_builder"] }]);
    await p.type("re"); // key, meaning and env-name hits across groups
    expect(p.cats().length).toBe(2);
    await p.fold(p.cats()[0], false);
    expect(p.opens()).toEqual([false, true]);
    await p.type("rev"); // the next keystroke drops the hand fold
    expect(p.view()).toEqual([{ summary: "Review · 2 of 2 match", open: true, keys: ["review_model", "review_rounds"] }]);
    await p.fold(p.cats()[0], false);
    await p.esc();
    expect(p.box().value).toBe("");
    expect(p.doc.getElementById("settings")).not.toBeNull();
    expect(p.opens()).toEqual([false, false, false]);
    expect(p.cats()[1].querySelector("summary").textContent).toBe("Review · 2 settings");
    expect(p.stored()).toEqual([]);
    p.w.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(p.doc.getElementById("settings")).toBeNull();
    expect(p.r.errors).toEqual([]);
  } finally { await p.w.happyDOM.close(); }
});

test("an empty box passes Esc on to the window, which closes", async () => {
  const p = await start();
  try {
    await p.esc();
    expect(p.doc.getElementById("settings")).toBeNull();
  } finally { await p.w.happyDOM.close(); }
});

test("the ✕ button clears, focuses the box and restores a hand-opened fold", async () => {
  const p = await start();
  try {
    await p.fold(p.cats()[2], true);
    const before = p.opens(), kept = p.stored();
    expect(before).toEqual([false, false, true]);
    p.w.localStorage.clear();
    await p.type("review opus");
    expect(p.view()).toEqual([{ summary: "Review · 1 of 2 match", open: true, keys: ["review_model"] }]);
    await p.fold(p.cats()[0], false);
    await p.click(p.doc.querySelector('[aria-label="Clear search"]'));
    for (const d of p.cats()) d.dispatchEvent(new p.w.Event("toggle"));
    await tick();
    expect(p.box().value).toBe("");
    expect(p.doc.activeElement).toBe(p.box());
    expect(p.opens()).toEqual(before);
    expect(kept.length).toBe(1);
    expect(p.stored()).toEqual([]);
    expect(p.doc.querySelector('[aria-label="Clear search"]')).toBeNull();
  } finally { await p.w.happyDOM.close(); }
});

test("an edit the search hides is announced and still saved", async () => {
  const p = await start();
  try {
    await p.fold(p.cats()[1], true);
    await p.setValue(p.cats()[1].querySelectorAll("input")[1], "5");
    await p.type("compact");
    expect(p.doc.querySelector(".set-hidden").textContent).toBe("1 edited setting is hidden by the search Show all");
    await p.click([...p.doc.querySelectorAll("#settings button")].find((b: any) => b.textContent === "Save 1 change"));
    expect(p.posts).toEqual([{ url: "api/limits", body: { project: "p", key: "review_rounds", value: "5" } }]);
  } finally { await p.w.happyDOM.close(); }
});

test("Show all clears the search; no match says so; the box is disabled with its text on other tabs", async () => {
  const p = await start();
  try {
    expect(p.doc.querySelector(".set-backend").textContent).toContain("--backend <name>");
    await p.type("zzz");
    expect(p.cats().length).toBe(0);
    expect(p.doc.querySelector('#settings [role="status"]').textContent).toBe('No setting matches "zzz"');
    for (const name of ["Roles", "Skills", "Pins"]) {
      await p.click([...p.doc.querySelectorAll(".set-tab")].find((b: any) => b.textContent === name));
      expect(p.box().disabled).toBe(true);
      expect(p.box().value).toBe("zzz");
      expect(p.box().getAttribute("title")).toBe("This tab is not searched");
    }
    await p.click([...p.doc.querySelectorAll(".set-tab")].find((b: any) => b.textContent === "Limits"));
    expect(p.box().disabled).toBe(false);
    await p.type("");
    await p.fold(p.cats()[1], true);
    await p.setValue(p.cats()[1].querySelectorAll("input")[1], "5");
    await p.type("compact");
    await p.click(p.doc.querySelector(".set-showall"));
    expect(p.box().value).toBe("");
    expect(p.cats().length).toBe(3);
    expect(p.doc.querySelector(".set-hidden")).toBeNull();
  } finally { await p.w.happyDOM.close(); }
});
