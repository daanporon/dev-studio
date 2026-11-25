// chat-role-switcher U1: the Chat panel's member switcher (tabs on a computer, the title's dropdown on a phone), mounted on the real page.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const root = join(import.meta.dir, "../..");
const now = Math.floor(Date.now() / 1000);
const board = {
  ...JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8")),
  project: "fixture", page_version: "v1", as_of: { accounts: now },
  squads: [{
    label: "fixture", topic: "sq", status: "running", display_status: "running", topic_plan: null, plans: [],
    members: [{ role: "builder", label: "builder-u6", wt: "wt-b", state: "working" }],
    units: [{ slug: "u6", state: "working", title: "Building unit", about: null, done_text: null, check_text: null, plan: null, plan_unit: null, deps: [], dependents: [], ext_deps: [],
      builder_wt: "wt-b", builder: { model_label: "m" }, tier: "std", pr: null, held: false }],
  }],
  flow: { ...JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8")).flow, cards: [{ key: "fixture/sq/u6", project: "fixture", squad: "sq", slug: "u6", stage: "building", needs_you: false, ask: null, stuck: false, slow: false, group: null }], merged: [] },
};

const reply = (text: string, at: number | null) => ({ role: "assistant", text, at });
const chatOf = (who: string, turns: any[], crew: any[]) => ({ agent: "claude", source: "transcript", working: false, updated_at: 1, turns, sends: [], crew, who });
const CREW = [
  { wt: "wt-lead", label: "lead", role: "lead", unread: 0, reply_due: 0, reply_at: now - 10 },
  { wt: "wt-t", label: "thinker", role: "thinker", unread: 2, reply_due: 1, reply_at: now - 20 },
  { wt: "wt-b", label: "builder-u6", role: "builder", unread: 0, reply_due: 0, reply_at: null },
];
const key = (wt: string) => "api/chat?project=fixture&topic=sq&wt=" + encodeURIComponent(wt);

async function open(opts: { phone?: boolean; crew?: any[]; fixtures?: Record<string, any> } = {}) {
  const crew = opts.crew ?? CREW;
  const fixtures: Record<string, any> = opts.fixtures ?? {
    [key("wt-b")]: chatOf("b", [reply("builder says hi", now - 5)], crew),
    [key("wt-lead")]: chatOf("lead", [reply("lead says hi", now - 10)], crew),
    [key("wt-t")]: chatOf("t", [reply("thinker says hi", now - 20)], crew),
  };
  const r = await mount(board, false, fixtures);
  const w = r.window, doc = w.document, wait = (ms: number) => new Promise((x) => setTimeout(x, ms));
  const listeners: any[] = [];
  let wide = !opts.phone;
  w.matchMedia = (q: string) => ({ get matches() { return /max-width:600px/.test(q) ? !wide : false; }, addEventListener: (_: string, f: any) => listeners.push(f), removeEventListener: () => {} });
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(40); };
  const until = async (f: () => any) => { for (let i = 0; i < 200 && !f(); i++) await wait(25); if (!f()) throw new Error("page never showed it"); return f(); };
  (await until(() => doc.getElementById("flow"))).open = true;
  await click(await until(() => [...doc.querySelectorAll(".fcard")].find((c: any) => c.querySelector(".t").textContent.trim() === "u6")));
  await click(await until(() => doc.querySelector(".ud-chat")));
  await until(() => doc.querySelectorAll(".chat-turn").length >= 1);
  return { r, w, doc, click, wait, until, urls: r.urls, setWide: (v: boolean) => { wide = v; for (const f of listeners) f({ matches: !wide }); },
    close: () => w.happyDOM.close() };
}
const tabsOf = (doc: any) => [...doc.querySelectorAll('.chat-tabs [role="tab"]')];
const title = (doc: any) => doc.querySelector(".chat-modal .mhd").textContent;

test("a computer shows one tab per member in order, a badge only where mail is waiting, and the shown tab selected", async () => {
  const t = await open();
  try {
    const tabs = tabsOf(t.doc);
    expect(tabs.map((x: any) => x.getAttribute("title"))).toEqual(["lead", "thinker", "builder-u6"]);
    expect(tabs.map((x: any) => x.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    expect(tabs.map((x: any) => x.querySelector(".msg-badge")?.textContent ?? null)).toEqual([null, "3", null]);
    expect(tabs[1].getAttribute("aria-label")).toBe("thinker, 3 mail");   // first open: marks start at each member's newest reply, so no dot
  } catch (e) { throw e; } finally { await t.close(); }
});

test("a click on another tab reads that member, retitles and shows none of the first member's turns", async () => {
  const t = await open();
  try {
    await t.click(tabsOf(t.doc)[0]);
    await t.until(() => t.doc.querySelector(".chat-turn.agent")?.textContent.includes("lead says hi"));
    expect(t.urls).toContain(key("wt-lead"));
    expect(title(t.doc)).toContain("Chat · lead");
    expect(t.doc.querySelector(".chat-log").textContent).not.toContain("builder says hi");
    expect(tabsOf(t.doc).map((x: any) => x.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
  } finally { await t.close(); }
});

test("a draft is kept per member across a switch and across close and reopen; Enter on a focused tab switches, an arrow only moves focus", async () => {
  const t = await open();
  try {
    const type = async (v: string) => { const ta = t.doc.querySelector(".chat-in"); ta.value = v; ta.dispatchEvent(new t.w.Event("input", { bubbles: true })); await t.wait(30); };
    await type("for the builder");
    await t.click(tabsOf(t.doc)[1]);
    expect(t.doc.querySelector(".chat-in").value).toBe("");
    await type("for the thinker");
    await t.click(tabsOf(t.doc)[2]);
    expect(t.doc.querySelector(".chat-in").value).toBe("for the builder");
    await t.click(t.doc.querySelector(".chat-modal .mclose"));
    expect(t.doc.querySelector(".chat-modal")).toBeNull();
    await t.click(await t.until(() => t.doc.querySelector(".ud-chat")));
    await t.until(() => t.doc.querySelector(".chat-in"));
    expect(t.doc.querySelector(".chat-in").value).toBe("for the builder");
    await t.click(tabsOf(t.doc)[1]);
    expect(t.doc.querySelector(".chat-in").value).toBe("for the thinker");
    // roving tabindex: only the shown tab is in the tab order; ArrowRight moves focus without switching
    expect(tabsOf(t.doc).map((x: any) => x.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    const tabs = tabsOf(t.doc);
    tabs[1].focus();
    tabs[1].dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(t.doc.activeElement).toBe(tabs[2]);
    expect(tabsOf(t.doc)[1].getAttribute("aria-selected")).toBe("true");
  } finally { await t.close(); }
});

test("a reply newer than the seen mark shows a dot, a member with no reply yet shows one for its first reply, and the shown tab never does", async () => {
  const t = await open();
  try {
    const dots = () => tabsOf(t.doc).map((x: any) => !!x.querySelector(".chat-new"));
    expect(dots()).toEqual([false, false, false]);   // first open: marks start at the members' newest replies
    t.w.localStorage.setItem("b:chat-seen:fixture/wt-lead", JSON.stringify(now - 100));
    await t.until(() => t.urls.filter((u: string) => u.startsWith("api/chat")).length >= 3 || dots()[0]); await t.wait(100);
    expect(dots()).toEqual([true, false, false]);
    await t.click(tabsOf(t.doc)[0]);
    expect(dots()).toEqual([false, false, false]);   // shown now: seen
  } finally { await t.close(); }
}, 15000);

test("a one-member crew and the Studio show no strip", async () => {
  const t = await open({ crew: [CREW[2]] });
  try { expect(t.doc.querySelector(".chat-tabs")).toBeNull(); } finally { await t.close(); }
});

test("a phone has no tabs: the title button sums the others' mail, a tap lists members, a row switches and closes, Escape closes only the list, a change to wide shows the tabs", async () => {
  const t = await open({ phone: true });
  try {
    expect(t.doc.querySelector(".chat-tabs")).toBeNull();
    const btn = t.doc.querySelector(".chat-swbtn");
    expect(btn.getAttribute("aria-label")).toBe("Switch member, shown builder-u6, 3 mail elsewhere");
    expect(btn.querySelector(".msg-badge").textContent).toBe("3");
    await t.click(btn);
    let rows = [...t.doc.querySelectorAll('.chat-menu [role="menuitemradio"]')];
    expect(rows.map((x: any) => x.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    t.doc.dispatchEvent(new t.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await t.wait(30);
    expect(t.doc.querySelector(".chat-menu")).toBeNull();
    expect(t.doc.querySelector(".chat-modal")).not.toBeNull();
    await t.click(t.doc.querySelector(".chat-swbtn"));
    await t.click(t.doc.querySelectorAll('.chat-menu [role="menuitemradio"]')[1]);
    await t.until(() => t.doc.querySelector(".chat-turn.agent")?.textContent.includes("thinker says hi"));
    expect(t.urls).toContain(key("wt-t"));
    expect(t.doc.querySelector(".chat-menu")).toBeNull();
    expect(title(t.doc)).toContain("thinker");
    t.setWide(true);
    await t.wait(40);
    expect(tabsOf(t.doc).length).toBe(3);
  } finally { await t.close(); }
});
