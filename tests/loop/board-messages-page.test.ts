// U278: the board's read-only message View (web/board.html MessagesPanel) and the crew badge, rendered with
// stub hooks as board-chat-page.test.ts does. The panel only fetches GET api/messages; it never posts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const i = page.indexOf("function msgTime("), j = page.indexOf("function MessagesPanel(");
const src = page.slice(i, page.indexOf("\n}\n", j) + 2);
const html = (strings: TemplateStringsArray, ...values: any[]) => ({ strings: strings.join("\u0000"), values });
const nodes = (v: any): any[] => Array.isArray(v) ? v.flatMap(nodes) : v?.strings !== undefined ? [v, ...v.values.flatMap(nodes)] : [];

function panel(reply: any) {
  const states: any[] = []; let slot = 0; const effects: (() => any)[] = [], fetches: string[] = [];
  const make = new Function("useState", "useEffect", "html", "fetch", "setInterval", "clearInterval", `${src} return { MessagesPanel };`);
  const mod = make((init: any) => { const k = slot++; if (!(k in states)) states[k] = init; return [states[k], (v: any) => { states[k] = v; }]; },
    (f: () => any) => { effects.push(f); }, html, async (u: string, o?: any) => { fetches.push(u + (o ? " " + JSON.stringify(o) : "")); return { ok: true, json: async () => reply }; },
    () => 1, () => {});
  const render = () => { slot = 0; effects.length = 0; return mod.MessagesPanel({ project: "p", topic: "one", wt: "/w/x", label: "thinker", onClose() {} }); };
  return { render, fetches, states, effects };
}

test("the View lists messages as text, marks unread and reply due, and only reads", async () => {
  const p = panel({ unread: 0, reply_due: 1, ended: 0, messages: [
    { id: 2, subject: "second <b>", body: "two", from: "lead", to: "thinker", sent_at: 200, read_at: null, needs_reply: true, reply_due: true, state: "waiting", waited_s: 7200 },
    { id: 1, subject: "first", body: "one", from: "lead", to: "thinker", sent_at: 100, read_at: 150, needs_reply: false, reply_due: false, state: null }] });
  p.render(); await p.effects[0]();
  expect(p.fetches).toEqual(["api/messages?project=p&topic=one&wt=%2Fw%2Fx&open=1"]);
  p.states[0] = { unread: 0, reply_due: 1, ended: 0, messages: [
    { id: 2, subject: "second <b>", body: "two", from: "lead", to: "thinker", sent_at: 200, read_at: null, needs_reply: true, reply_due: true, state: "waiting", waited_s: 7200 },
    { id: 1, subject: "first", body: "one", from: "lead", to: "thinker", sent_at: 100, read_at: 150, needs_reply: false, reply_due: false, state: null }] };
  const all = nodes(p.render());
  const rows = all.filter((n) => n.values.some((v: any) => typeof v === "string" && v.startsWith("msg")));
  expect(rows.map((r) => r.values.find((v: any) => typeof v === "string" && v.startsWith("msg")))).toEqual(["msg unread", "msg"]);
  expect(all.some((n) => n.strings.includes("<b>"))).toBe(false);
  expect(all.some((n) => n.values.includes("reply due") || n.values.includes("waiting for a reply") || n.values.some((v: any) => v?.values?.includes?.("reply due")))).toBe(true);
  expect(p.fetches.length).toBe(1); // nothing but the one GET
});

// unread-counts-mismatch U1: the squad chip is the button that opens the panel (no separate View), the panel opens on
// All when nothing is open (else Open), and an open row says how long it has waited.
test("the chip opens the panel; the panel starts on All when nothing is open; open rows show their wait", async () => {
  expect(page).toContain("data-msg-chip");
  expect(page).not.toContain(">View</button></span>`);\n  if (s.gates");
  const p = panel({ unread: 0, reply_due: 0, ended: 1, messages: [] });
  p.render(); await p.effects[0](); await new Promise((r) => setTimeout(r, 5));
  expect(p.states[2]).toBe("all"); // `show` is the third state
  expect(p.fetches[0]).toContain("&open=1"); // the first read asks for the open rows; All re-reads without it
  p.render();
  const q = panel({ unread: 1, reply_due: 1, ended: 0, messages: [] });
  q.render(); await q.effects[0](); await new Promise((r) => setTimeout(r, 5));
  expect(q.states[2]).toBe("open");
  q.states[0] = { unread: 1, reply_due: 1, ended: 0, messages: [{ id: 3, subject: "s", body: "b", from: "a", to: "b", sent_at: 1, read_at: null, needs_reply: true, reply_due: true, state: "waiting", waited_s: 10800 }] };
  const text = JSON.stringify(nodes(q.render()).map((n) => n.values));
  expect(text).toContain("3 h");
});

// answered-questions-stop-count U1: an answered question is muted and says which message answered it.
test("an answered question shows `answered in #<id>`, muted, and no reply due", async () => {
  const q = panel({ unread: 0, reply_due: 0, ended: 0, messages: [] });
  q.render(); await q.effects[0](); await new Promise((r) => setTimeout(r, 5));
  q.states[0] = { unread: 0, reply_due: 0, ended: 0, messages: [{ id: 5, subject: "s", body: "b", from: "a", to: "b", sent_at: 1, read_at: 2, needs_reply: true, reply_due: false, replied_at: null, state: "answered", answered_by: 9 }] };
  const all = nodes(q.render());
  const text = JSON.stringify(all.map((n) => n.values));
  expect(text).toContain("msg ended");
  expect(all.some((n) => n.strings.includes('data-msg-state="answered"') && n.values.includes(9))).toBe(true);
  expect(text).not.toContain("reply due");
});
