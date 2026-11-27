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

const ROLES = {
  catalog: [{ agent: "claude", model: "opus", label: "Opus", efforts: ["high"] }, { agent: "claude", model: "sonnet", label: "Sonnet", efforts: ["high"] }],
  roles: [["lead", "sonnet", ""], ["thinker", "opus", ""], ["builder", "sonnet", "claude:opus"], ["tester", "sonnet", ""]]
    .map(([role, model, fallbacks]) => ({ role, agent: "claude", model, effort: "", spawn: "always", fallbacks, source: "default" })),
};
const skill = (name: string, description: string, group = "Plan") => ({ name, description, group, level: "on", required: false });
const skillRole = (role: string, skills: any[], hooks: any[] = [], mcp: any[] = []) =>
  ({ role, skills, hooks, mcp, other: { level: "on" }, summary: { required: 0, on: skills.length, name_only: 0, off: 0, saved_tokens: 0 } });
const SKILLS = {
  groups: ["Plan", "Ship"],
  roles: [
    skillRole("lead", [skill("ce-plan", "write a plan"), skill("ce-brainstorm", "explore before the plan"), skill("commit", "make a commit", "Ship")]),
    skillRole("thinker", [skill("ce-plan", "write a plan")], [skill("hook:resume", "restores a session")]),
    skillRole("builder", [skill("commit", "make a commit", "Ship")], [], [skill("mcp:browser", "drives a page")]),
  ],
};

async function start(extra: any = {}) {
  const board = { ...JSON.parse(readFileSync(join(ROOT, "tests/fixtures/board-empty.json"), "utf8")), project: "p", page_version: "v1", ...extra };
  const r = await mount(board, false, { "api/limits": { limits: LIMITS, groups: GROUPS }, "api/roles": ROLES, "api/skills": SKILLS });
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
  const tab = (name: string) => click([...doc.querySelectorAll(".set-tab")].find((b: any) => b.textContent === name));
  const texts = (el: any, sel: string) => [...el.querySelectorAll(sel)].map((e: any) => e.textContent);
  const blocks = () => [...doc.querySelectorAll("#settings .role-block")] as any[];
  const roleView = () => blocks().map((b) => ({
    role: b.querySelector(".role-name").textContent, open: b.querySelector(".role-name").getAttribute("aria-expanded") === "true",
    heads: texts(b, ".sk-grp"), rows: texts(b, ".sk-table .nm"),
  }));
  const groups = () => texts(doc, "#settings .rt-grp");
  const status = () => doc.querySelector('#settings [role="status"]').textContent;
  const toggleRole = (name: string) => click(blocks().map((b) => b.querySelector(".role-name")).find((b: any) => b.textContent === name));
  // Esc where focus sits after a click outside the box.
  const escOn = async (el: any) => { el.focus(); el.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick(); await toggles(); };
  return { r, w, doc, posts, escOn, click, cats, box, type, setValue, esc, fold, view, opens, stored, tab, blocks, roleView, groups, status, toggleRole };
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

test("Esc clears after a group line took focus; the next Esc closes the window", async () => {
  const p = await start();
  try {
    await p.fold(p.cats()[1], true);
    await p.setValue(p.cats()[1].querySelectorAll("input")[1], "5");
    const before = p.opens();
    await p.type("compact");
    await p.fold(p.cats()[0], false);
    const line = p.cats()[0].querySelector("summary");
    await p.escOn(line);
    expect(p.doc.getElementById("settings")).not.toBeNull();
    expect(p.box().value).toBe("");
    expect(p.doc.activeElement).toBe(p.box());
    expect(p.opens()).toEqual(before);
    expect(p.cats()[1].querySelectorAll("input")[1].value).toBe("5");
    await p.escOn(p.doc.body);
    expect(p.doc.getElementById("settings")).toBeNull();
    expect(p.r.errors).toEqual([]);
  } finally { await p.w.happyDOM.close(); }
});

test("Esc clears after a role name took focus on Skills", async () => {
  const p = await start();
  try {
    await p.tab("Skills");
    const pick = p.doc.querySelector('#settings .role-block .role-name') as any;
    await p.click(pick);
    const level = () => p.doc.querySelector('#settings select[aria-label="commit level"]') as any;
    level().value = "off"; level().dispatchEvent(new p.w.Event("change", { bubbles: true })); await tick();
    const folds = () => p.roleView().map((v) => v.open);
    const before = folds();
    await p.type("ce-plan");
    await p.toggleRole("lead");
    await p.escOn(p.blocks()[0].querySelector(".role-name"));
    expect(p.doc.getElementById("settings")).not.toBeNull();
    expect(p.box().value).toBe("");
    expect(p.doc.activeElement).toBe(p.box());
    expect(folds()).toEqual(before);
    expect(level().value).toBe("off");
    await p.escOn(p.doc.body);
    expect(p.doc.getElementById("settings")).toBeNull();
    expect(p.r.errors).toEqual([]);
  } finally { await p.w.happyDOM.close(); }
});

test("with the Add account dialog open, Esc closes it and keeps the search text", async () => {
  const p = await start({ account_kinds: [{ agent: "claude", label: "Claude" }] });
  try {
    await p.type("compact");
    await p.tab("Accounts");
    await p.click(p.doc.querySelector("#settings button.acct-add"));
    expect(p.doc.querySelector("#settings .acct-dlg")).not.toBeNull();
    await p.escOn(p.doc.body);
    expect(p.doc.querySelector("#settings .acct-dlg")).toBeNull();
    expect(p.doc.getElementById("settings")).not.toBeNull();
    expect(p.box().value).toBe("compact");
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

test("Show all clears the search; no match says so; the box is disabled with its text on Pins", async () => {
  const p = await start();
  try {
    expect(p.doc.querySelector(".set-backend").textContent).toContain("--backend <name>");
    await p.type("zzz");
    expect(p.cats().length).toBe(0);
    expect(p.doc.querySelector('#settings [role="status"]').textContent).toBe('No setting matches "zzz"');
    for (const name of ["Roles", "Skills"]) {
      await p.tab(name);
      expect(p.box().disabled).toBe(false);
      expect(p.box().value).toBe("zzz");
      expect(p.blocks()).toEqual([]);
      expect(p.groups()).toEqual([]);
      expect(p.status()).toBe('No setting matches "zzz"');
    }
    await p.tab("Accounts");
    expect(p.box().disabled).toBe(true);
    expect(p.box().value).toBe("zzz");
    await p.tab("Pins");
    expect(p.box().disabled).toBe(true);
    expect(p.box().value).toBe("zzz");
    expect(p.box().getAttribute("title")).toBe("This tab is not searched");
    expect(p.doc.querySelector('[aria-label="Clear search"]')).toBeNull();
    await p.tab("Limits");
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

test("Skills shows the matching roles and rows, unfolded, and clearing gives the folds back", async () => {
  const p = await start();
  try {
    await p.tab("Skills");
    await p.toggleRole("builder");
    const folds = () => p.roleView().map((v) => v.open);
    expect(folds()).toEqual([false, false, true]);
    await p.type("ce-plan");
    expect(p.roleView()).toEqual([
      { role: "lead", open: true, heads: ["Plan"], rows: ["ce-plan"] },
      { role: "thinker", open: true, heads: ["Plan"], rows: ["ce-plan"] },
    ]);
    expect(p.groups()).toEqual(["Coordinate", "Think"]);
    expect(p.doc.querySelector("#settings .sk-top")).toBeNull();
    expect(p.status()).toBe("");
    await p.toggleRole("lead");
    expect(folds()).toEqual([false, true]);
    await p.type("restores session"); // a start hook, by its description
    expect(p.roleView()).toEqual([{ role: "thinker", open: true, heads: ["Start hooks"], rows: ["hook:resume"] }]);
    await p.type("browser"); // an MCP server
    expect(p.roleView()).toEqual([{ role: "builder", open: true, heads: ["MCP servers"], rows: ["mcp:browser"] }]);
    await p.type("thinker"); // a role's name shows it whole
    expect(p.roleView()).toEqual([{ role: "thinker", open: true, heads: ["Plan", "Start hooks"], rows: ["ce-plan", "hook:resume"] }]);
    expect(p.doc.querySelector("#settings .sk-top")).not.toBeNull();
    await p.esc();
    expect(folds()).toEqual([false, false, true]);
    expect(p.groups()).toEqual(["Coordinate", "Think", "Build"]);
    expect(p.r.errors).toEqual([]);
  } finally { await p.w.happyDOM.close(); }
});

test("Roles shows the roles on a model, keeps the word across tabs and gives the folds back", async () => {
  const p = await start();
  try {
    await p.tab("Roles");
    await p.toggleRole("tester");
    const before = p.roleView().map((v) => v.open);
    expect(before).toEqual([false, false, false, true]);
    await p.type("opus"); // thinker's own model, builder's fallback step
    expect(p.roleView().map((v) => [v.role, v.open])).toEqual([["thinker", true], ["builder", true]]);
    expect(p.groups()).toEqual(["Think", "Build"]);
    await p.toggleRole("thinker");
    expect(p.roleView().map((v) => v.open)).toEqual([false, true]);
    await p.type("");
    expect(p.roleView().map((v) => v.open)).toEqual(before);
    await p.type("opus");
    for (const name of ["Skills", "Pins", "Limits", "Roles"]) {
      await p.tab(name);
      expect(p.box().value).toBe("opus");
      expect(p.box().disabled).toBe(name === "Pins");
    }
    expect(p.blocks().length).toBe(2);
  } finally { await p.w.happyDOM.close(); }
});

test("an edited role the search hides is announced and still saved; so is a hidden skill row", async () => {
  const p = await start();
  try {
    const pick = async (el: any, value: string) => { el.value = value; el.dispatchEvent(new p.w.Event("change", { bubbles: true })); await tick(); };
    const save = () => p.click([...p.doc.querySelectorAll("#settings button")].find((b: any) => b.textContent === "Save 1 change"));
    const note = () => p.doc.querySelector("#settings .set-hidden")?.textContent;
    await p.tab("Roles");
    await pick(p.blocks()[0].querySelector('select[title="spawn"]'), "ondemand");
    await p.type("opus");
    expect(p.blocks().length).toBe(2);
    expect(note()).toBe("1 edited role is hidden by the search Show all");
    await save();
    expect(p.posts.map((x) => [x.url, x.body.role, x.body.spawn])).toEqual([["api/roles", "lead", "ondemand"]]);

    p.posts.length = 0;
    await p.type("");
    await p.tab("Skills");
    await p.toggleRole("lead");
    await pick(p.doc.querySelector('#settings select[aria-label="commit level"]'), "off");
    await p.type("ce-plan"); // lead stays shown, its edited row does not
    expect(note()).toBe("1 edited setting is hidden by the search Show all");
    await p.type("thinker");
    expect(note()).toBe("1 edited setting is hidden by the search Show all");
    await save();
    expect(p.posts).toEqual([{ url: "api/skills", body: { project: "p", role: "lead", set: { commit: "off" } } }]);
    expect(p.r.errors).toEqual([]);
  } finally { await p.w.happyDOM.close(); }
});
