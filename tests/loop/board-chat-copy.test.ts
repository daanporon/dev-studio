// chat-polish U2: the chat panel's Copy button, on the real page mounted in happy-dom (board-mount.ts).
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
const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |\nkey [redacted] done";
const chat = {
  agent: "claude", source: "transcript", working: false, updated_at: 1,
  turns: [
    { role: "assistant", text: TABLE, at: now - 100 },
    { role: "user", from: "operator", text: "please rebase", at: now - 90 },
    { role: "assistant", text: "no time here" },
    { role: "assistant", tool: "2 tools", text: "2 tools", tools: ["Bash ls"], counts: { Bash: 2 }, at: now - 50 },
  ],
  sends: [{ id: 9, text: "pending line", state: "queued", at: now - 5 }],
};

const label = (el: any) => el.getAttribute("aria-label");
async function open(secure: boolean, exec?: (c: string) => boolean) {
  const r = await mount(board, false, { "api/chat": chat });
  const w = r.window, doc = w.document, wait = (ms: number) => new Promise((x) => setTimeout(x, ms));
  const written: string[] = [];
  Object.defineProperty(w, "isSecureContext", { value: secure, configurable: true });
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (t: string) => { written.push(t); } }, configurable: true });
  let fell = 0;
  doc.execCommand = (c: string) => { fell++; return exec ? exec(c) : true; };
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(30); };
  const until = async (f: () => any) => { for (let i = 0; i < 200 && !f(); i++) await wait(25); if (!f()) throw new Error("page never showed it"); return f(); };
  (await until(() => doc.getElementById("flow"))).open = true;
  await click(await until(() => [...doc.querySelectorAll(".fcard")].find((c: any) => c.querySelector(".t").textContent.trim() === "u6")));
  await click(await until(() => doc.querySelector(".ud-chat")));
  await until(() => doc.querySelectorAll(".chat-turn").length >= 5);
  return { r, doc, written, click, wait, fell: () => fell };
}

test("one Copy per member reply and operator turn; none on tool or pending rows", async () => {
  const t = await open(true);
  try {
    expect(t.doc.querySelectorAll(".chat-turn").length).toBe(5);
    expect(t.doc.querySelectorAll(".chat-copy").length).toBe(3);
    for (const b of t.doc.querySelectorAll(".chat-copy")) {
      expect(b.querySelector("svg")).not.toBeNull();
      expect(b.textContent.trim()).toBe("");
      expect(b.getAttribute("aria-label")).toBe("Copy this message");
    }
    expect(t.doc.querySelectorAll(".chat-turn.tool .chat-copy, .chat-turn.op.wait .chat-copy").length).toBe(0);
    expect(t.doc.querySelectorAll(".chat-turn.agent")[1].querySelector(".chat-copy")).not.toBeNull();   // the reply with no time
    expect(t.r.errors).toEqual([]);
  } finally { await t.r.window.happyDOM.close(); }
});

test("secure context: the raw text is written, Copied, then Copy again after the timeout", async () => {
  const t = await open(true);
  try {
    const btn = t.doc.querySelector(".chat-turn.agent .chat-copy");
    expect(label(btn)).toBe("Copy this message");
    await t.click(btn);
    expect(t.written).toEqual([TABLE]);
    expect(label(btn)).toBe("Copied");
    expect(btn.querySelector("svg path:not([d*='a1.5'])")?.getAttribute("d")).toBe("M3 8.5l3.2 3.2L13 4.5");   // the check mark
    expect(label(t.doc.querySelectorAll(".chat-copy")[1])).toBe("Copy this message");   // only that button
    await t.wait(1600);
    expect(label(t.doc.querySelector(".chat-turn.agent .chat-copy"))).toBe("Copy this message");
  } finally { await t.r.window.happyDOM.close(); }
});

test("plain http: the textarea fallback copies; a refused copy reads Copy failed", async () => {
  const ok = await open(false);
  try {
    await ok.click(ok.doc.querySelector(".chat-turn.agent .chat-copy"));
    expect(ok.fell()).toBe(1);
    expect(ok.written).toEqual([]);
    expect(ok.doc.querySelector(".chat-turn.agent .chat-copy").getAttribute("aria-label")).toBe("Copied");
  } finally { await ok.r.window.happyDOM.close(); }
  const bad = await open(false, () => false);
  try {
    await bad.click(bad.doc.querySelector(".chat-turn.agent .chat-copy"));
    expect(label(bad.doc.querySelector(".chat-turn.agent .chat-copy"))).toBe("Copy failed");
    await bad.wait(1600);
    expect(label(bad.doc.querySelector(".chat-turn.agent .chat-copy"))).toBe("Copy this message");
  } finally { await bad.r.window.happyDOM.close(); }
});
