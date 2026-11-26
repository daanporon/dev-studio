// squad-menu-chat U1: the squad row's ⋯ menu opens the Chat panel on the Thinker (else the Lead), mounted on the real page.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const root = join(import.meta.dir, "../..");
const empty = JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8"));
const lead = { role: "lead", label: "lead", wt: "wt-lead", state: "working" };
const thinker = { role: "thinker", suffix: "", label: "thinker", wt: "wt-t", state: "working" };
const board = (members: any[], status = "running") => ({
  ...empty, project: "fixture", page_version: "v1", as_of: { accounts: Math.floor(Date.now() / 1000) },
  squads: [{ label: "fixture", topic: "sq", status, display_status: status, topic_plan: null, plans: [], members, units: [] }],
});
const crew = [
  { wt: "wt-lead", label: "lead", role: "lead", unread: 0, reply_due: 0, reply_at: null },
  { wt: "wt-t", label: "thinker", role: "thinker", unread: 0, reply_due: 0, reply_at: null },
];
const key = (wt: string) => "api/chat?project=fixture&topic=sq&wt=" + wt;
const chat = (who: string) => ({ agent: "claude", source: "transcript", working: false, updated_at: 1, turns: [{ role: "assistant", text: who + " says hi", at: 1 }], sends: [], crew });

async function open(members: any[], status?: string) {
  const r = await mount(board(members, status), false, { [key("wt-lead")]: chat("lead"), [key("wt-t")]: chat("thinker") });
  const w = r.window, doc = w.document, wait = (ms: number) => new Promise((x) => setTimeout(x, ms));
  w.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(40); };
  const until = async (f: () => any) => { for (let i = 0; i < 200 && !f(); i++) await wait(25); if (!f()) throw new Error("page never showed it"); return f(); };
  const sec = await until(() => doc.getElementById("squads"));
  if (!sec.open) { sec.open = true; sec.dispatchEvent(new w.Event("toggle")); await wait(40); }
  const trigger = await until(() => doc.querySelector("button.squad-menu"));
  await click(trigger);
  const items = () => [...trigger.parentElement.querySelectorAll('[role="menuitem"]')] as any[];
  return { r, w, doc, click, until, trigger, items, close: () => w.happyDOM.close() };
}

test("the first item chats with the Thinker: the row stays closed, focus is in the panel, the switcher reaches the Lead", async () => {
  const t = await open([lead, { ...thinker, suffix: "b", label: "thinker-b", wt: "wt-tb" }, thinker]);
  try {
    const first = t.items()[0];
    expect(first.textContent).toBe("Chat with Thinker");
    expect(first.getAttribute("title")).toContain("switch");
    await t.click(first);
    await t.until(() => t.doc.querySelector(".chat-turn.agent")?.textContent.includes("thinker says hi"));
    expect(t.r.urls).toContain(key("wt-t"));
    expect(t.doc.querySelector(".detail")).toBeNull();
    expect(t.trigger.getAttribute("aria-expanded")).toBe("false");
    expect(t.doc.querySelector(".chat-modal").contains(t.doc.activeElement)).toBe(true);
    await t.click([...t.doc.querySelectorAll('.chat-tabs [role="tab"]')].find((x: any) => x.getAttribute("title") === "lead"));
    await t.until(() => t.doc.querySelector(".chat-turn.agent")?.textContent.includes("lead says hi"));
    expect(t.r.urls).toContain(key("wt-lead"));
    await t.click(t.doc.querySelector(".chat-modal .mclose"));
    expect(t.doc.querySelector(".chat-modal")).toBeNull();
    expect(t.doc.querySelector(".detail")).toBeNull();
  } finally { await t.close(); }
});

test("a squad with only a Lead (a Thinker without a worktree does not count) chats with the Lead", async () => {
  const t = await open([lead, { ...thinker, wt: null }]);
  try {
    expect(t.items()[0].textContent).toBe("Chat with Lead");
    await t.click(t.items()[0]);
    await t.until(() => t.doc.querySelector(".chat-turn.agent")?.textContent.includes("lead says hi"));
    expect(t.r.urls).toContain(key("wt-lead"));
  } finally { await t.close(); }
});

test("a suspended squad has no chat item", async () => {
  const t = await open([lead, thinker], "suspended");
  try {
    expect(t.items().length).toBeGreaterThan(0);
    expect(t.items().some((x) => x.textContent.startsWith("Chat"))).toBe(false);
  } finally { await t.close(); }
});

test("with neither member running the item is disabled and says why", async () => {
  const t = await open([{ ...lead, wt: null }, { ...thinker, wt: null }]);
  try {
    const first = t.items()[0];
    expect(first.textContent).toStartWith("Chat with");
    expect(first.disabled).toBe(true);
    expect(first.getAttribute("title")).toContain("No Thinker or Lead");
  } finally { await t.close(); }
});
