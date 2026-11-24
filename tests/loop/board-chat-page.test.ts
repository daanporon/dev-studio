// crew-terminal-access U3: the board's chat panel (web/board.html ChatPanel) and its entry on a question card,
// rendered with stub hooks in the board-pause-page.test.ts style: htm's tagged template becomes {strings, values}.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
// CHAT_MAX, chatTone, chatTurn and ChatPanel sit together, from the panel's comment to ChatPanel's closing brace.
const chatSrc = (() => { const i = page.indexOf("const CHAT_MAX = "); const j = page.indexOf("function ChatPanel("); return page.slice(i, page.indexOf("\n}\n", j) + 2); })();
const html = (strings: TemplateStringsArray, ...values: any[]) => ({ strings: strings.join("\u0000"), values });
const nodes = (v: any): any[] => Array.isArray(v) ? v.flatMap(nodes) : v?.strings !== undefined ? [v, ...v.values.flatMap(nodes)] : [];
const fnIn = (n: any) => n.values.find((v: any) => typeof v === "function");
// The value filling `attr=${…}` after `marker` in the one template that holds it (the panel is one html call).
const attrAfter = (root: any, marker: string, attr: string) => {
  const n = nodes(root).find((x) => x.strings.includes(marker))!, seg = n.strings.split("\u0000");
  let seen = false;
  for (let i = 0; i < n.values.length; i++) { seen ||= seg[i].includes(marker); if (seen && seg[i].trimEnd().endsWith(attr + "=")) return n.values[i]; }
  throw new Error(`no ${attr} after ${marker}`);
};

// A tiny hook runtime: useState by call order, effects kept to run (and clean up) by hand.
function hooks() {
  const states: any[] = [], refs: any[] = []; let slot = 0, rslot = 0; const effects: (() => any)[] = [];
  return {
    states, effects, refs,
    reset() { slot = 0; rslot = 0; effects.length = 0; },
    useState: (initial: any) => { const i = slot++; if (!(i in states)) states[i] = initial; return [states[i], (v: any) => { states[i] = typeof v === "function" ? v(states[i]) : v; }]; },
    useEffect: (fn: () => any) => { effects.push(fn); },
    useRef: (initial: any) => { const i = rslot++; if (!(i in refs)) refs[i] = { current: initial }; return refs[i]; },
  };
}
// The page's own markdown renderer (it escapes before it formats).
const mdToHtml = new Function(`${cut("esc")} ${cut("mdToHtml")} return mdToHtml;`)();

function panel(reply: any = { agent: "claude", source: "transcript", turns: [], updated_at: 1, sends: [] }) {
  const h = hooks(), posts: any[] = [], fetches: string[] = [], timers: any[] = [], cleared: any[] = [], listeners = new Map<string, any>();
  let closed = 0;
  const marks = new Map<string, any>(), lstoreStub = { get: (k: string, d: any) => marks.has(k) ? marks.get(k) : d, set: (k: string, v: any) => { marks.set(k, v); } };
  const drafts = new Map<string, any>(), storeStub = { get: (k: string, d: any) => drafts.has(k) ? JSON.parse(drafts.get(k)) : d, set: (k: string, v: any) => { drafts.set(k, JSON.stringify(v)); }, del: (k: string) => { drafts.delete(k); } };
  const fetchStub = async (url: string) => { fetches.push(url); return { ok: true, status: 200, json: async () => reply }; };
  const doc = { addEventListener: (k: string, f: any) => listeners.set(k, f), removeEventListener: (k: string, f: any) => { if (listeners.get(k) === f) listeners.delete(k); } };
  const make = new Function("useState", "useEffect", "useRef", "html", "mdToHtml", "post", "fetch", "setInterval", "clearInterval", "document", "lstore", "store",
    `${chatSrc} return { ChatPanel, ChatCtl, chatSendLine, chatTone, chatTools, chatRows, CHAT_MAX, chatSeenKey, chatDraftKey };`);
  const mod = make(h.useState, h.useEffect, h.useRef, html, mdToHtml, async (...a: any[]) => { posts.push(a); return { ok: true, id: 7 }; }, fetchStub,
    (f: any, ms: number) => { timers.push({ f, ms }); return timers.length; }, (t: any) => cleared.push(t), doc, lstoreStub, storeStub);
  let seen = 0;
  const props: any = { project: "p", topic: "one", wt: "/w/b 1", label: "builder-x", onClose: () => { closed++; }, onSeen: () => { seen++; } };
  const render = () => { h.reset(); return mod.ChatPanel(props); };
  return { h, mod, marks, props, seen: () => seen, posts, fetches, timers, cleared, listeners, render, closed: () => closed, setData: (d: any) => { h.states[0] = d; } };
}

// The class of a rendered row (`class="…"` written out, or `class=${…}` as the second value after key).
const cls = (n: any): string | null => {
  const m = /^<div key=\u0000 class="(chat-[a-z -]+)"/.exec(n.strings);
  return m ? m[1] : n.strings.startsWith("<div key=\u0000 class=\u0000") && String(n.values[1]).startsWith("chat-") ? n.values[1] : null;
};
const rowsOf = (root: any) => nodes(root).filter((n) => cls(n) !== null);
const textOf = (n: any) => JSON.stringify(n);
const hhmm = (at: number) => new Date(at * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const T = 1_800_000_000;

test("crew-terminal-access U5: an operator row, a markdown reply, a tool line and an in line, each with its time", () => {
  const p = panel();
  p.render();
  p.setData({ agent: "claude", source: "transcript", sends: [], turns: [
    { role: "user", from: "operator", text: "please rebase", at: T },
    { role: "assistant", text: "Rebasing:\n- **first** step\n- second", at: T + 60 },
    { role: "assistant", tool: "5 tools", text: "5 tools · last: Edit a.ts", tools: ["Bash ls", "Read a.ts", "Bash git status", "Bash git rebase", "Edit a.ts"],
      counts: { Bash: 3, Read: 1, Edit: 1 }, at: T + 120 },
    { role: "user", text: "Lead: main moved, merge it", at: T + 180 }] });
  const rows = rowsOf(p.render());
  expect(rows.map(cls)).toEqual(["chat-turn op", "chat-turn agent", "chat-turn tool", "chat-turn in"]);
  expect(textOf(rows[0])).toContain("please rebase");
  const md = nodes(rows[1]).flatMap((n) => n.values).find((v: any) => v && typeof v === "object" && "__html" in v).__html;
  expect(md).toContain("<ul>");
  expect(md).toContain("<strong>first</strong>");
  expect(textOf(rows[2])).toContain("Ran 3 commands, read 1 file, edited 1 file");
  expect(rows[2].values[1]).toBe("Bash ls\nRead a.ts\nBash git status\nBash git rebase\nEdit a.ts");
  expect(textOf(rows[3])).toContain("Lead: main moved, merge it");
  expect(textOf(rows[3])).toContain(" · " + hhmm(T + 180));
  for (const [i, at] of [[0, T], [1, T + 60], [2, T + 120]] as const) expect(textOf(rows[i])).toContain(hhmm(at));
  // A Lead line is never in the operator's box.
  expect(rows.filter((r) => cls(r) === "chat-turn op")).toHaveLength(1);
});

test("crew-terminal-access U7: a terminal line is in the operator box with a muted in Orca, line breaks and markup as text; an interrupt is a muted line", () => {
  const p = panel();
  p.render();
  p.setData({ agent: "claude", source: "transcript", sends: [], turns: [
    { role: "user", from: "operator", via: "terminal", text: "one\n<script>x</script>", at: T },
    { role: "user", from: "operator", text: "from board", at: T + 60 },
    { role: "user", from: "interrupted", text: "[Request interrupted by user]", at: T + 120 }] });
  const rows = rowsOf(p.render());
  expect(rows.map(cls)).toEqual(["chat-turn op", "chat-turn op", "chat-turn in"]);
  expect(textOf(rows[0])).toContain("in Orca");
  expect(textOf(rows[0])).toContain(hhmm(T));
  expect(textOf(rows[0])).toContain("one\\n<script>x</script>");
  expect(textOf(rows[1])).not.toContain("in Orca");
  expect(textOf(rows[2])).toContain("Interrupted");
  // A terminal line is never the board's send: the same text still leaves the send pending.
  expect(p.mod.chatRows([{ role: "user", from: "operator", via: "terminal", text: "next", at: T }], [{ id: 9, text: "next", at: T, state: "queued" }]).map((r: any) => !!r.send)).toEqual([false, true]);
});

test("crew-terminal-access U5: <script> and <img onerror> in agent text render as text", () => {
  const p = panel();
  p.render();
  p.setData({ agent: "claude", source: "transcript", sends: [], turns: [
    { role: "assistant", text: "look <script>alert(1)</script> and <img src=x onerror=alert(2)> [x](javascript:alert(3))", at: T }] });
  const all = nodes(p.render());
  const md = all.flatMap((n) => n.values).find((v: any) => v && typeof v === "object" && "__html" in v).__html;
  expect(md).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(md).toContain("&lt;img src=x onerror=alert(2)&gt;");
  expect(md).not.toMatch(/<script|<img|href="javascript/);
  expect(all.some((n) => n.strings.includes("<script") || n.strings.includes("<img"))).toBe(false);
});

test("crew-terminal-access U5: tool verbs, a date line when the day changes, Working… while mid-turn, a screen tail", () => {
  const p = panel();
  expect(p.mod.chatTools({ tool: "Bash", text: "Bash ls" })).toBe("Ran 1 command");
  expect(p.mod.chatTools({ tool: "4 tools", counts: { Grep: 1, Glob: 1, Task: 1, Write: 1 } })).toBe("Searched 2 patterns, used Task, edited 1 file");
  expect(p.mod.chatTools({ tool: "2 tools", counts: { Task: 2 } })).toBe("Used Task 2×");
  p.render();
  p.setData({ agent: "claude", source: "transcript", sends: [], working: true, turns: [
    { role: "assistant", text: "late", at: T }, { role: "assistant", text: "next morning", at: T + 86400 }] });
  const all = p.render(), rows = rowsOf(all);
  expect(rows.map(cls)).toEqual(["chat-turn agent", "chat-day", "chat-turn agent"]);
  expect(nodes(all).some((n) => n.strings.includes('class="chat-work">Working…'))).toBe(true);
  p.setData({ agent: "claude", source: "transcript", sends: [], working: false, turns: [] });
  expect(nodes(p.render()).some((n) => n.strings.includes("Working…"))).toBe(false);
  const muse = panel(); muse.render();
  muse.setData({ agent: "muse", source: "screen", sends: [], turns: [{ role: "screen", text: "$ make test\nok", at: null }] });
  const screen = nodes(muse.render());
  expect(screen.some((n) => cls(n) === "chat-turn screen")).toBe(true);
  expect(screen.some((n) => n.values.includes(" · screen tail"))).toBe(true);
});

test("the panel reads api/chat every 3 s while open and stops on close; Escape closes it", async () => {
  const p = panel();
  p.render();
  const cleanup = p.h.effects[0]();
  await Promise.resolve();
  expect(p.fetches).toEqual(["api/chat?project=p&topic=one&wt=%2Fw%2Fb%201"]);
  expect(p.timers.map((t) => t.ms)).toEqual([3000]);
  await p.timers[0].f();
  expect(p.fetches).toHaveLength(2);
  p.listeners.get("keydown")({ key: "Escape", stopPropagation() {} });
  expect(p.closed()).toBe(1);
  cleanup();
  expect(p.cleared).toEqual([1]);
  expect(p.listeners.has("keydown")).toBe(false);
});

test("Send posts one chat request with the trimmed line and clears the input; an empty line posts nothing", async () => {
  const p = panel();
  p.render();
  const at = (attr: string) => attrAfter(p.render(), 'class="chat-in"', attr);
  expect(at("maxLength")).toBe(2000);
  await attrAfter(p.render(), 'class="btn pri"', "onClick")();
  expect(p.posts).toEqual([]);
  at("onInput")({ target: { value: "  check the flaky test  " } });
  expect(attrAfter(p.render(), 'class="btn pri"', "disabled")).toBe(false);
  let prevented = 0;
  await at("onKeyDown")({ key: "Enter", preventDefault: () => prevented++ });
  expect(prevented).toBe(1);
  expect(p.posts).toEqual([["api/chat", { project: "p", topic: "one", wt: "/w/b 1", text: "check the flaky test" }]]);
  expect(p.h.states[2]).toBe("");
});

test("each send not yet in the transcript shows at the bottom where it is: queued with why, sent, turn started, not taken, failed", () => {
  const p = panel();
  p.render();
  p.setData({ agent: "claude", source: "transcript", turns: [], sends: [
    { id: 1, text: "a", state: "queued", why: "working" }, { id: 2, text: "b", state: "sent", why: null },
    { id: 3, text: "c", state: "turn started", why: null }, { id: 4, text: "d", state: "not taken", why: "typed, but no turn started" },
    { id: 5, text: "e", state: "failed", why: "never ready: working" }] });
  const rows = rowsOf(p.render());
  expect(rows.map(cls)).toEqual(["chat-turn op wait", "chat-turn op ok", "chat-turn op ok", "chat-turn op bad", "chat-turn op bad"]);
  expect(textOf(rows[0])).toContain("queued");
  expect(textOf(rows[0])).toContain(" · working");
  expect(textOf(rows[4])).toContain("never ready: working");
});

test("chat-missing-replies U2: a delivered send with no operator turn sits among the turns at its typed time (done_at), queued and failed at the bottom", () => {
  const p = panel();
  p.render();
  const turns = [{ role: "assistant", text: "before", at: T - 60 }, { role: "assistant", text: "after", at: T + 300 }];
  const sends = [{ id: 1, text: "lost question", at: T - 30, done_at: T, state: "turn started", why: null },
    { id: 2, text: "waiting", at: T + 10, done_at: null, state: "queued", why: "busy" },
    { id: 3, text: "broken", at: T + 20, done_at: null, state: "failed", why: "never ready" },
    { id: 4, text: "typed late", at: T + 400, done_at: T + 500, state: "sent", why: null }];
  p.setData({ agent: "claude", source: "transcript", turns, sends });
  const rows = rowsOf(p.render());
  expect(rows.map((r) => (textOf(r).match(/before|lost question|after|waiting|broken|typed late/) || [])[0])).toEqual(["before", "lost question", "after", "typed late", "waiting", "broken"]);
  expect(textOf(rows[1])).toContain("turn started");
  expect(p.mod.chatRows(turns, sends.slice(0, 1)).map((r: any) => r.day ? "day" : r.send ? "send" : "turn")).toEqual(["turn", "send", "turn"]);
});

test("crew-terminal-access U5: a send is shown once: pending at the bottom, then as its timed operator turn", () => {
  const p = panel();
  p.render();
  const sends = [{ id: 0, text: "long gone", at: T - 3600, state: "turn started", why: null },
    { id: 1, text: "check  it", at: T - 5, state: "turn started", why: null }, { id: 2, text: "next", at: T + 100, state: "queued", why: "busy: working" }];
  p.setData({ agent: "claude", source: "transcript", sends, turns: [
    { role: "user", from: "operator", text: "check it", at: T }, { role: "assistant", text: "checked", at: T + 30 }] });
  let rows = rowsOf(p.render());
  expect(rows.map(cls)).toEqual(["chat-turn op", "chat-turn agent", "chat-turn op wait"]);
  expect(rows.filter((r) => textOf(r).includes("check")).map(cls)).toEqual(["chat-turn op", "chat-turn agent"]);
  expect(textOf(rows[2])).toContain("next");
  // The loop read the second send into the transcript: it becomes a timed row, shown once.
  p.setData({ agent: "claude", source: "transcript", sends: [...sends.slice(0, 2), { ...sends[2], state: "turn started", why: null }], turns: [
    { role: "user", from: "operator", text: "check it", at: T }, { role: "assistant", text: "checked", at: T + 30 },
    { role: "user", from: "operator", text: "next", at: T + 140 }] });
  rows = rowsOf(p.render());
  expect(rows.map(cls)).toEqual(["chat-turn op", "chat-turn agent", "chat-turn op"]);
  expect(textOf(rows[2])).toContain(hhmm(T + 140));
  // A same text sent again later is its own row, not matched to the earlier turn.
  expect(p.mod.chatRows([{ role: "user", from: "operator", text: "next", at: T }], [{ id: 9, text: "next", at: T + 500, state: "sent" }]).map((r: any) => !!r.send)).toEqual([false, true]);
});

test("crew-terminal-access U5, U19: the input wraps, a multi-line message keeps its line breaks, Shift+Enter is a new line, a 2000-character counter", async () => {
  const p = panel();
  p.render();
  const at = (attr: string) => attrAfter(p.render(), 'class="chat-in"', attr);
  expect(nodes(p.render()).some((n) => n.strings.includes('<textarea class="chat-in" rows="1"'))).toBe(true);
  expect(at("maxLength")).toBe(2000);
  expect(String(at("placeholder"))).toContain("Enter sends, Shift+Enter a new line");
  at("onInput")({ target: { value: "a\nb\r\n\tc\u0085d\re\u0007f\n" } });
  let prevented = 0;
  // Shift+Enter is left to the browser, which puts the line break in.
  await at("onKeyDown")({ key: "Enter", shiftKey: true, preventDefault: () => prevented++ });
  expect(prevented).toBe(0);
  expect(p.posts).toEqual([]);
  await at("onKeyDown")({ key: "Enter", isComposing: true, preventDefault: () => prevented++ });
  expect(p.posts).toEqual([]);
  await at("onKeyDown")({ key: "Enter", preventDefault: () => prevented++ });
  expect(prevented).toBe(1);
  expect(p.posts).toEqual([["api/chat", { project: "p", topic: "one", wt: "/w/b 1", text: "a\nb\n\tc d\ne f" }]]);
  const left = () => {
    const n = nodes(p.render()).find((n) => n.strings.includes(" left</span>"))!;
    const i = n.values.findIndex((v: any) => typeof v === "string" && v.startsWith("chat-left"));
    return n.values.slice(i, i + 2);
  };
  at("onInput")({ target: { value: "x".repeat(10) } });
  expect(left()).toEqual(["chat-left", 1990]);
  at("onInput")({ target: { value: "x".repeat(1950) } });
  expect(left()).toEqual(["chat-left low", 50]);
  // Only line breaks: nothing to send.
  at("onInput")({ target: { value: "\n\n" } });
  expect(attrAfter(p.render(), 'class="btn pri"', "disabled")).toBe(true);
});

test("U19: on a touch screen Enter is a new line and only Send sends", async () => {
  const had = (globalThis as any).matchMedia;
  (globalThis as any).matchMedia = (q: string) => ({ matches: q === "(pointer:coarse)" });
  try {
    const p = panel();
    p.render();
    const at = (attr: string) => attrAfter(p.render(), 'class="chat-in"', attr);
    expect(String(at("placeholder"))).toContain("Send sends");
    expect(at("enterkeyhint")).toBe("enter");
    at("onInput")({ target: { value: "line one" } });
    let prevented = 0;
    await at("onKeyDown")({ key: "Enter", preventDefault: () => prevented++ });
    expect([prevented, p.posts]).toEqual([0, []]);
    at("onInput")({ target: { value: "line one\nline two" } });
    await attrAfter(p.render(), 'class="btn pri"', "onClick")();
    expect(p.posts).toEqual([["api/chat", { project: "p", topic: "one", wt: "/w/b 1", text: "line one\nline two" }]]);
  } finally { (globalThis as any).matchMedia = had; }
});

// The key strip's buttons: [key, label, node] in order.
const keyButtons = (root: any) => nodes(root).filter((n) => n.strings.startsWith("<button key=") && String(n.values[1]).includes("chat-key"))
  .map((n) => [n.values[0], n.values[n.values.length - 1], n]);

test("U19: the key strip posts one api/keys press per button, Esc reads Stop while the member works", async () => {
  const p = panel();
  p.render();
  p.setData({ agent: "claude", source: "transcript", sends: [], turns: [], working: false });
  const keys = keyButtons(p.render());
  expect(keys.map((k) => k[0])).toEqual(["Escape", "Up", "Down", "Enter", "Tab"]);
  expect(keys[0][1]).toBe("Esc");
  await fnIn(keys[0][2])();
  expect(p.posts).toEqual([["api/keys", { project: "p", topic: "one", wt: "/w/b 1", keys: ["Escape"] }]]);
  expect(p.h.states).toContain("pressed Esc");
  await fnIn(keyButtons(p.render())[2][2])();
  p.setData({ agent: "claude", source: "transcript", sends: [], turns: [], working: false, screen: { tail: "❯ 1. Yes\n  2. No\n  3. Other", menu: 3, at: T, age_s: 1 } });
  await fnIn(keyButtons(p.render())[6][2])();
  expect(p.posts.slice(1)).toEqual([["api/keys", { project: "p", topic: "one", wt: "/w/b 1", keys: ["Down"] }], ["api/keys", { project: "p", topic: "one", wt: "/w/b 1", keys: ["2"] }]]);
  // Mid-turn the Esc button is the red Stop.
  p.setData({ agent: "claude", source: "transcript", sends: [], turns: [], working: true });
  const stop = keyButtons(p.render())[0];
  expect(stop[1]).toBe("■ Stop");
  expect(String(stop[2].values[1])).toContain("stop");
  await fnIn(stop[2])();
  expect(p.posts.at(-1)).toEqual(["api/keys", { project: "p", topic: "one", wt: "/w/b 1", keys: ["Escape"] }]);
});

test("U19: a member with no transcript shows its live screen; a toggle switches between screen and chat", () => {
  const screenOf = (root: any) => nodes(root).find((n) => n.strings.includes('class="chat-screen"'));
  const toggle = (root: any) => nodes(root).find((n) => n.strings.includes('class="btn sm chat-scr"'));
  const p = panel();
  p.render();
  p.setData({ agent: "muse", source: "screen", sends: [], turns: [{ role: "screen", text: "old", at: null }],
    screen: { tail: "Pick one:\n❯ 1. Yes\n  2. No", at: T, age_s: 4 } });
  let root = p.render();
  expect(screenOf(root).values).toContain("Pick one:\n❯ 1. Yes\n  2. No");
  expect(screenOf(root).values).toContain("read 4 s ago");
  expect(toggle(root).values).toContain("Chat");
  fnIn(toggle(root))();
  root = p.render();
  expect(screenOf(root)).toBeUndefined();
  expect(rowsOf(root).map(cls)).toEqual(["chat-turn screen"]);
  // A member with a transcript opens on the conversation, its screen one press away.
  const q = panel();
  q.render();
  q.setData({ agent: "claude", source: "transcript", sends: [], turns: [{ role: "assistant", text: "hi", at: T }], screen: { tail: "x", at: T, age_s: 90 } });
  root = q.render();
  expect(screenOf(root)).toBeUndefined();
  expect(toggle(root).values).toContain("Screen");
  fnIn(toggle(root))();
  expect(screenOf(q.render()).values).toContain("read 2 min ago");
  // No screen read: no toggle.
  q.setData({ agent: "claude", source: "transcript", sends: [], turns: [], screen: null });
  expect(toggle(q.render())).toBeUndefined();
});

test("crew-terminal-access U5: the log follows the newest row, stays put once scrolled up, and ↓ jumps back", () => {
  const p = panel();
  p.render();
  p.setData({ agent: "claude", source: "transcript", sends: [], turns: [{ role: "assistant", text: "hi", at: T }] });
  p.render();
  const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 };
  p.h.refs[0].current = el;
  p.h.effects[1]();
  expect(el.scrollTop).toBe(1000);
  expect(nodes(p.render()).some((n) => n.strings.includes("chat-down"))).toBe(false);
  // The operator scrolls up: new rows arrive, the view stays.
  el.scrollTop = 200;
  attrAfter(p.render(), 'class="chat-log"', "onScroll")({ currentTarget: el });
  const root = p.render();
  el.scrollHeight = 1400;
  p.h.effects[1]();
  expect(el.scrollTop).toBe(200);
  const down = nodes(root).find((n) => n.strings.includes("chat-down"))!;
  fnIn(down)();
  expect(el.scrollTop).toBe(1400);
  p.render(); p.h.effects[1]();
  expect(nodes(p.render()).some((n) => n.strings.includes("chat-down"))).toBe(false);
});

test("a squad question card opens the chat panel of the member its answer goes to; a Studio alert has none", () => {
  const h = hooks();
  const ChatPanel = () => null;
  const make = new Function("useState", "useEffect", "html", "sendAnswer", "sentQ", "nkey", "sqName", "fmtAge", "QPr", "linkedQ", "ActBtn", "copy", "docLabel", "ChatPanel", "useRef", "akey", "hhmmss",
    `${cut("AskOverlay")} return AskOverlay;`);
  const AskOverlay = make(h.useState, h.useEffect, html, async () => {}, new Map(), (n: any) => n.label + "/" + n.squad + "/" + n.id,
    (n: any) => n.squad, () => "1m", () => null, (t: any) => t, () => null, () => {}, () => "", ChatPanel, (v: any) => ({ current: v }), (n: any) => n.label + "/" + n.squad + "/" + n.id, () => "00:00:00");
  const q = { label: "p", squad: "one", id: "q1", kind: "blocking", from: "builder-x", chat_wt: "/w/bx", chat_label: "builder-x", title: "T", text: "T", choices: [], suggestion: null, source: "lead" };
  const cardActions = new Function("docLabel", cut("cardActions") + " return cardActions;")(() => "doc");
  const render = (n: any) => { h.reset(); return nodes(AskOverlay({ cardActions, data: { squads: [] }, items: [n], at: "p/one/q1", setAt: () => {}, onClose: () => {}, onShow: () => {}, toast: () => {} })); };
  const btn = render(q).find((n) => n.strings.includes('class="btn chat-btn"'))!;
  expect(btn.values).toContain("builder-x");
  fnIn(btn)();
  const open = render(q).find((n) => n.values[0] === ChatPanel)!;
  expect(open.values[1]).toEqual({ project: "p", topic: "one", wt: "/w/bx", label: "builder-x" });
  // A card with no worktree of its own (a loop PR gate) is answered at the Lead, so it chats with the Lead.
  expect(render({ ...q, from: "loop", chat_wt: "/w/lead", chat_label: "the Lead" }).find((n) => n.strings.includes('class="btn chat-btn"'))!.values).toContain("the Lead");
  expect(render({ ...q, squad: "_studio", chat_wt: null }).some((n) => n.strings.includes("chat-btn"))).toBe(false);
});

test("crew-terminal-access U8: each send claims its own turn, the earlier of two identical sends scrolls out with its turn", () => {
  const p = panel();
  const op = (text: string, at: number) => ({ role: "user", from: "operator", text, at });
  const send = (id: number, text: string, at: number, state = "sent") => ({ id, text, at, state });
  const sendsIn = (rows: any[]) => rows.filter((r) => r.send);
  const turnsIn = (rows: any[]) => rows.filter((r) => r.turn);
  // Both turns in the window: two operator rows, no pending row.
  let rows = p.mod.chatRows([op("a", T + 5), op("a", T + 105)], [send(1, "a", T), send(2, "a", T + 100)]);
  expect(turnsIn(rows)).toHaveLength(2);
  expect(sendsIn(rows)).toHaveLength(0);
  // Only the second turn in the window: one operator row, the first send is not shown as pending.
  rows = p.mod.chatRows([{ role: "assistant", text: "x", at: T + 90 }, op("a", T + 105)], [send(1, "a", T), send(2, "a", T + 100)]);
  expect(turnsIn(rows).filter((r) => r.turn.from === "operator")).toHaveLength(1);
  expect(sendsIn(rows)).toHaveLength(0);
});

test("chat-with-studio U1: the Studio chat titles itself, marks the newest reply seen once loaded, and a squad chat marks nothing", () => {
  const p = panel();
  p.props.topic = "_studio"; p.props.wt = "/w/studio"; p.props.label = "Studio";
  const title = (root: any) => nodes(root).find((n) => n.strings.includes('class="mhd"'))!;
  const root = p.render();
  expect(JSON.stringify(title(root))).toContain("Chat · Studio · p");
  p.setData({ agent: "claude", source: "transcript", sends: [], turns: [
    { role: "assistant", text: "old", at: T }, { role: "assistant", text: "new", at: T + 50 },
    { role: "assistant", tool: "2 tools", text: "x", at: T + 90 }, { role: "user", text: "q", at: T + 99 }] });
  p.render(); p.h.effects[2]();
  expect(p.marks.get("b:chat-seen:p//w/studio")).toBe(T + 50);
  expect(p.seen()).toBe(1);
  const q = panel();
  q.render(); q.setData({ agent: "claude", source: "transcript", sends: [], turns: [{ role: "assistant", text: "a", at: T }] });
  q.render(); q.h.effects[2]();
  expect(q.marks.size).toBe(0);
});

test("studio-chat-queued-busy U4: a waiting send shows its age, why, give-up time and tone, and Cancel / Send now on the right ones", async () => {
  const p = panel();
  p.render();
  const q = { text: "a", state: "queued", failing: false, now: false, first: false, why: "busy: working", age_s: 420, gives_up_at: T + 600 };
  p.setData({ agent: "claude", source: "transcript", turns: [], sends: [
    { id: 1, ...q, first: true },                                                              // plain queued, oldest
    { id: 2, ...q, why: "an earlier message waits", gives_up_at: null, age_s: 5 },             // behind an earlier chat: no clock
    { id: 3, ...q, failing: true, why: "send failed" },                                         // failing: red
    { id: 4, text: "d", state: "cancelled", why: null },
    { id: 5, ...q, now: true, why: "busy: working" }] });
  const rows = rowsOf(p.render());
  expect(rows.map(cls)).toEqual(["chat-turn op wait", "chat-turn op wait", "chat-turn op bad", "chat-turn op mut", "chat-turn op wait"]);
  const t = rows.map(textOf);
  expect(t[0]).toContain("queued 7 min · busy: working");
  expect(t[0]).toContain("gives up at ");
  expect(t[1]).toContain("queued <1 min");
  expect(t[1]).not.toContain("gives up at");
  expect(t[2]).toContain("send failing 7 min · send failed");
  expect(t[3]).toContain("cancelled");
  expect(t[3]).not.toContain("Cancel");
  expect(t[4]).toContain("send now asked · busy: working");
  // the control row: one component per queued send, none on the cancelled one
  const ctls = (n: any) => nodes(n).filter((m) => m.values.some((v: any) => typeof v === "function" && v.name === "ChatCtl")).length;
  expect(rows.map(ctls)).toEqual([1, 1, 1, 0, 1]);
  const btns = (x: any) => [textOf(p.mod.ChatCtl({ x, project: "p", reload: () => {} }))];
  expect(btns({ id: 1, first: true, now: false }).join()).toContain("Send now");
  expect(btns({ id: 2, first: false, now: false }).join()).not.toContain("Send now");
  expect(btns({ id: 5, first: true, now: true }).join()).not.toContain("Send now");
  expect(btns({ id: 5, first: true, now: true }).join()).toContain("Cancel");
});

test("studio-chat-queued-busy U4: a press posts once, disables both buttons and reloads; a 409 says already typed", async () => {
  for (const [status, msg] of [[0, ""], [409, "already typed"]] as const) {
    const p = panel(); let reloads = 0;
    const posts: any[] = [];
    const src = (post: any) => new Function("useState", "html", "post", `${chatSrc} return { ChatCtl };`)(p.h.useState, html, post).ChatCtl;
    const Ctl = src(async (...a: any[]) => { posts.push(a); if (status) throw Object.assign(new Error("already typed"), { status }); return {}; });
    p.h.reset();
    const btn = nodes(Ctl({ x: { id: 8, first: true, now: false }, project: "p", reload: () => { reloads++; } })).find((n) => n.strings.includes('chat-now'))!;
    await fnIn(btn)();
    expect(posts).toEqual([["api/chat-now", { project: "p", id: 8 }]]);
    expect(reloads).toBe(1);
    p.h.reset();
    const after = nodes(Ctl({ x: { id: 8, first: true, now: false }, project: "p", reload: () => {} }));
    expect(after.filter((n) => n.strings.includes("<button")).every((n) => n.values.includes(true))).toBe(true);
    expect(textOf(after)).toContain(msg);
  }
});

// Board chat U19b: the digit keys show only while the screen read shows a numbered menu.
test("U19b: digits 1 to N show only for a numbered menu on screen", async () => {
  const { menuOptions } = await import("../../bin/board/board-data.ts");
  const keysFor = (tail: string | null) => {
    const p = panel();
    p.render();
    p.setData({ agent: "claude", source: "transcript", sends: [], turns: [], screen: tail === null ? null : { tail, menu: menuOptions(tail), at: T, age_s: 1 } });
    return keyButtons(p.render()).map((k) => k[0]);
  };
  const base = ["Escape", "Up", "Down", "Enter", "Tab"];
  expect(keysFor("● Working on it…\n\n> \n")).toEqual(base);
  expect(keysFor(null)).toEqual(base);
  const perm = " Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No, and tell Claude what to do differently (esc)\n";
  expect(keysFor(perm)).toEqual([...base, "1", "2", "3"]);
  // A numbered list in ordinary output has no selection marker.
  expect(keysFor("Steps:\n1. first\n2. second\n3. third\n\n> ")).toEqual(base);
  expect(menuOptions(" ❯ 1. Yes, I trust this folder\n   2. No, exit\n")).toBe(2);
  expect(menuOptions("❯ 1. a\n  2. b\n  3. c\n  4. d\n  5. e\n  6. f\n")).toBe(6);
});
