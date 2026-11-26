// crew-terminal-access U3: the board's chat panel (web/board.html ChatPanel) and its entry on a question card,
// rendered with stub hooks in the board-pause-page.test.ts style: htm's tagged template becomes {strings, values}.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
const lineOf = (start: string) => { const i = page.indexOf(start); return page.slice(i, page.indexOf("\n", i) + 1); };
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
const mdToHtml = new Function(`${cut("esc")} ${cut("urlTail")} ${cut("mdToHtml")} return mdToHtml;`)();

const goneUrls = new Set<string>();   // stored chat images the fetch stub answers 404 for
function panel(reply: any = { agent: "claude", source: "transcript", turns: [], updated_at: 1, sends: [] }, postGate?: Promise<void>) {
  const h = hooks(), posts: any[] = [], fetches: string[] = [], timers: any[] = [], cleared: any[] = [], listeners = new Map<string, any>();
  let closed = 0;
  const answers: any[] = [], sentQ = new Map<string, string>(), askingKey = (k: string, since: string) => (k && since ? k + "@" + since : k);
  const marks = new Map<string, any>(), lstoreStub = { get: (k: string, d: any) => marks.has(k) ? marks.get(k) : d, set: (k: string, v: any) => { marks.set(k, v); } };
  const drafts = new Map<string, any>(), storeStub = { get: (k: string, d: any) => drafts.has(k) ? JSON.parse(drafts.get(k)) : d, set: (k: string, v: any) => { drafts.set(k, JSON.stringify(v)); }, del: (k: string) => { drafts.delete(k); } };
  const fetchStub = async (url: string) => { fetches.push(url); return { ok: !goneUrls.has(url), status: goneUrls.has(url) ? 404 : 200, json: async () => reply }; };
  const doc = { addEventListener: (k: string, f: any) => listeners.set(k, f), removeEventListener: (k: string, f: any) => { if (listeners.get(k) === f) listeners.delete(k); } };
  const make = new Function("useState", "useEffect", "useRef", "html", "mdToHtml", "post", "fetch", "setInterval", "clearInterval", "document", "lstore", "store", "sendAnswer", "sentQ", "askingKey",
    `${cut("urlTail")} ${cut("linkedQ")} ${cut("QMd")} ${cut("QOptions")} ${cut("ShownText")} ${cut("PermWhy")} ${lineOf("const promptWhere = ")} const docLabel = () => "Open doc"; ${chatSrc} return { QOptions, PermWhy, ChatPanel, ChatCtl, ChatFailCtl, chatCount, chatSendLine, chatTone, chatTools, chatRows, CHAT_MAX, chatSeenKey, chatDraftKey };`);
  const mod = make(h.useState, h.useEffect, h.useRef, html, mdToHtml, async (...a: any[]) => { posts.push(a); if (postGate) await postGate; return { ok: true, id: 7 }; }, fetchStub,
    (f: any, ms: number) => { timers.push({ f, ms }); return timers.length; }, (t: any) => cleared.push(t), doc, lstoreStub, storeStub,
    async (...a: any[]) => { answers.push(a); sentQ.set(askingKey(a[0] + "/" + a[1] + "/" + a[2], a[4]), "12:00"); }, sentQ, askingKey);
  let seen = 0;
  const props: any = { project: "p", topic: "one", wt: "/w/b 1", label: "builder-x", onClose: () => { closed++; }, onSeen: () => { seen++; } };
  const render = () => { h.reset(); return mod.ChatPanel(props); };
  return { h, mod, drafts, answers, sentQ, marks, props, seen: () => seen, posts, fetches, timers, cleared, listeners, render, closed: () => closed, setData: (d: any) => { h.states[0] = d; } };
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
  await attrAfter(p.render(), 'class="btn pri chat-round chat-send"', "onClick")();
  expect(p.posts).toEqual([]);
  at("onInput")({ target: { value: "  check the flaky test  " } });
  expect(attrAfter(p.render(), 'class="btn pri chat-round chat-send"', "disabled")).toBe(false);
  let prevented = 0;
  await at("onKeyDown")({ key: "Enter", preventDefault: () => prevented++ });
  expect(prevented).toBe(1);
  expect(p.posts).toEqual([["api/chat", { project: "p", topic: "one", wt: "/w/b 1", text: "check the flaky test" }]]);
  expect(p.h.states[2]).toBe("");
});

test("a send shrinks the input back to its empty height without waiting for typing", async () => {
  const p = panel();
  p.render();
  const el: any = { value: "", style: {} as any, get scrollHeight() { return this.value ? 120 : 24; } };
  // The stub renderer does not attach refs, so the textarea's ref gets the element here.
  attrAfter(p.render(), 'class="chat-in"', "ref").current = el;
  el.value = "one\ntwo\nthree";
  attrAfter(p.render(), 'class="chat-in"', "onInput")({ target: el });
  expect(el.style.height).toBe("122px");
  await attrAfter(p.render(), 'class="btn pri chat-round chat-send"', "onClick")();
  expect(p.posts.length).toBe(1);
  expect(el.style.height).toBe("26px");
});

// A panel whose post stays pending until `ok()`, with a box element on the textarea's ref.
function inFlight() {
  let ok!: () => void;
  const gate = new Promise<void>((r) => { ok = r; });
  const p = panel(undefined, gate);
  p.render();
  const el: any = { value: "", style: {} as any, get scrollHeight() { return this.value ? 120 : 24; } };
  attrAfter(p.render(), 'class="chat-in"', "ref").current = el;
  const type = (v: string) => { el.value = v; attrAfter(p.render(), 'class="chat-in"', "onInput")({ target: el }); };
  const send = () => attrAfter(p.render(), 'class="btn pri chat-round chat-send"', "onClick")();
  const key = p.mod.chatDraftKey("p", "one", "/w/b 1");
  const draft = () => (p.drafts.has(key) ? JSON.parse(p.drafts.get(key)!) : null);
  return { p, el, type, send, ok, draft };
}

test("text typed while a send is in flight stays in the box and its draft", async () => {
  const f = inFlight();
  f.type("first line");
  const sending = f.send();
  f.type("first line\nand the next one");
  f.ok();
  await sending;
  expect(f.el.value).toBe("\nand the next one");
  expect(f.p.h.states[2]).toBe("\nand the next one");
  expect(f.draft()).toEqual({ text: "\nand the next one" });
  expect(f.el.style.height).toBe("122px");
});

test("a sent text that was edited while in flight is kept whole", async () => {
  const f = inFlight();
  f.type("first line");
  const sending = f.send();
  f.type("a new thought");
  f.ok();
  await sending;
  expect(f.el.value).toBe("a new thought");
  expect(f.draft()).toEqual({ text: "a new thought" });
});

test("a send that succeeds after a switch to another member keeps what was typed for its own member", async () => {
  const f = inFlight();
  f.type("first line");
  const sending = f.send();
  f.type("first line, more");
  f.p.h.refs[2].current = "/w/other";   // cur: the panel now shows someone else
  f.el.value = "for the other one";
  f.ok();
  await sending;
  expect(f.el.value).toBe("for the other one");
  expect(f.draft()).toEqual({ text: ", more" });
});

test("an image attached while a send is in flight stays; the sent one goes", async () => {
  const f = inFlight();
  const held = () => f.p.h.refs.find((r: any) => r.current?.["/w/b 1"])!.current;
  const files = () => f.p.h.states.find((s: any) => Array.isArray(s) && s[0]?.url);
  const a = { id: "a.png", url: "api/chat-file/a.png", name: "a.png" }, b = { id: "b.png", url: "api/chat-file/b.png", name: "b.png" };
  f.p.drafts.set(f.p.mod.chatDraftKey("p", "one", "/w/b 1"), JSON.stringify({ text: "look", files: [a] }));
  f.type("look");
  const sending = f.send();
  expect(f.p.posts[0][1].files).toEqual(["a.png"]);
  // An upload that finishes now: attach() adds it to held and the draft (putHeld).
  held()["/w/b 1"] = [a, b];
  f.p.drafts.set(f.p.mod.chatDraftKey("p", "one", "/w/b 1"), JSON.stringify({ text: "look", files: [a, b] }));
  f.ok();
  await sending;
  expect(held()["/w/b 1"]).toEqual([b]);
  expect(files()).toEqual([b]);
  expect(f.draft()).toEqual({ files: [b] });
  expect(f.el.value).toBe("");
  expect(f.el.style.height).toBe("26px");
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
  expect(String(at("title"))).toContain("Enter sends, Shift+Enter a new line");
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
    const n = nodes(p.render()).find((n) => n.strings.includes('class="chat-in"'))!;
    const i = n.values.findIndex((v: any) => typeof v === "string" && v.startsWith("chat-left"));
    return n.values.slice(i, i + 2);
  };
  at("onInput")({ target: { value: "x".repeat(10) } });
  expect(left()).toEqual(["chat-left", "1990 left"]);
  at("onInput")({ target: { value: "x".repeat(1950) } });
  expect(left()).toEqual(["chat-left low", "50 left"]);
  // chat-multiline-send-fails U2: the counter counts code points of the posted text, as the server does.
  at("onInput")({ target: { value: "x".repeat(2000) } });
  expect(left()).toEqual(["chat-left low", "0 left"]);
  at("onInput")({ target: { value: "x".repeat(2001) } });
  expect(left()).toEqual(["chat-left low", "1 over"]);
  at("onInput")({ target: { value: "😀".repeat(2000) } });
  expect(left()).toEqual(["chat-left low", "0 left"]);
  at("onInput")({ target: { value: "a\r\nb" + "x".repeat(1997) } });   // CR LF counts 1: 2000 in all
  expect(left()).toEqual(["chat-left low", "0 left"]);
  // Over the limit Send posts nothing and keeps the text.
  at("onInput")({ target: { value: "y".repeat(2013) } });
  const before = p.posts.length;
  await attrAfter(p.render(), 'class="btn pri chat-round chat-send"', "onClick")();
  expect(p.posts.length).toBe(before);
  expect(p.h.states).toContain("not sent: 2013 characters, the limit is 2000");
  expect(p.h.states).toContain("y".repeat(2013));
  // Only line breaks: nothing to send.
  at("onInput")({ target: { value: "\n\n" } });
  expect(attrAfter(p.render(), 'class="btn pri chat-round chat-send"', "disabled")).toBe(true);
});

test("U19: on a touch screen Enter is a new line and only Send sends", async () => {
  const had = (globalThis as any).matchMedia;
  (globalThis as any).matchMedia = (q: string) => ({ matches: q === "(pointer:coarse)" });
  try {
    const p = panel();
    p.render();
    const at = (attr: string) => attrAfter(p.render(), 'class="chat-in"', attr);
    expect(String(at("title"))).toContain("Send sends");
    expect(at("enterkeyhint")).toBe("enter");
    at("onInput")({ target: { value: "line one" } });
    let prevented = 0;
    await at("onKeyDown")({ key: "Enter", preventDefault: () => prevented++ });
    expect([prevented, p.posts]).toEqual([0, []]);
    at("onInput")({ target: { value: "line one\nline two" } });
    await attrAfter(p.render(), 'class="btn pri chat-round chat-send"', "onClick")();
    expect(p.posts).toEqual([["api/chat", { project: "p", topic: "one", wt: "/w/b 1", text: "line one\nline two" }]]);
  } finally { (globalThis as any).matchMedia = had; }
});

// The key row's buttons: [key, label, node] in order. Chat has none; Screen shows them all.
const keyButtons = (root: any) => nodes(root).filter((n) => n.strings.startsWith("<button key=") && n.strings.includes("chat-key"))
  .map((n) => [n.values[0], n.values[n.values.length - 1], n]);
const stopBtn = (root: any) => nodes(root).find((n) => n.strings.includes("chat-stop"));
const cardOf = (root: any) => nodes(root).find((n) => n.strings.startsWith("<div class=\u0000>") && n.values[0] && String(n.values[0]).startsWith("chat-dock "));
const dockOf = (root: any): string | null => cardOf(root) ? String(cardOf(root).values[0]).slice("chat-dock ".length) : null;
const lineBtn = (root: any) => nodes(root).find((n) => n.strings.includes("chat-dline"));
const questionView = (root: any) => nodes(root).find((n) => n.strings.includes("data-chat-question"));
const dockBtn = (root: any, cls: string) => nodes(root).find((n) => n.strings.includes(cls) && n.strings.startsWith("<div class=\"chat-dhd\""));
const hasKeyRow = (root: any) => nodes(root).some((n) => n.strings.includes('class="chat-keys"'));
const menuTail = "❯ 1. Yes\n  2. No\n  3. Other";
const scrToggle = (root: any) => nodes(root).find((n) => n.strings.includes('class="btn chat-round chat-scrtog"'));
// The toggle's icon names where a press goes: [aria-label and title, the drawn path].
const MONITOR = "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM12 17v4M8 21h8", BUBBLE = "M21 11.5a8.4 8.4 0 0 1-12.2 7.5L3 21l2-5.8A8.4 8.4 0 1 1 21 11.5z";
const expectIcon = (t: any, label: string, path: string) => {
  expect(t.values.filter((v: any) => typeof v !== "function")).toEqual([label, label, path]);
  const markup = t.strings.split('class="btn chat-round chat-scrtog"')[1].split("</button>")[0];
  expect(markup).not.toContain("aria-pressed");
  expect(markup.slice(markup.indexOf("<svg")).replace(/<[^>]*>|\u0000/g, "").trim()).toBe("");   // no visible text
};
// The card's header buttons, in order: [‹, ›,] ⤢, ▾ (functions of the one header template).
const headFns = (root: any) => {
  const n = nodes(root).find((x) => x.strings.includes('class="chat-dhd"'))!;
  return n.values.filter((v: any) => typeof v === "function");
};
const pressFull = (p: any) => headFns(p.render()).at(-2)();
const pressFold = (p: any) => headFns(p.render()).at(-1)();
const navFns = (root: any) => nodes(root).find((x) => x.strings.includes('aria-label="Next question"'))!.values.filter((v: any) => typeof v === "function");
// What the panel draws between the .mhd opening and the log: the header and the member tabs.
const headerText = (root: any) => flat(root).split('class="mhd"')[1].split('class="chat-wrap"')[0];
// Switch the panel to Screen with the message box's toggle.
const toScreen = (p: any) => { const t = scrToggle(p.render()); if (t.values.includes("Show the live screen")) fnIn(t)(); };
const idle = { agent: "claude", source: "transcript", sends: [], turns: [], working: false };

test("chat-view-switcher U1: the header has no view switch; on a phone the screen toggle is an icon in the message box row; none without a screen", () => {
  const had = (globalThis as any).matchMedia;
  (globalThis as any).matchMedia = (q: string) => ({ matches: q === "(max-width:600px)" });
  try {
    const p = panel();
    p.render();
    p.setData(idle);
    expect(scrToggle(p.render())).toBeUndefined();
    p.setData({ ...idle, questions: [bq("q1")], screen: { tail: "x", menu: 0, at: T, age_s: 1 } });
    let root = p.render();
    expect(headerText(root)).not.toMatch(/chat-seg|chat-scr|Question|Screen/);
    const row = nodes(root).find((n) => n.strings.includes('class="chat-row"'));
    expect(row.values).toContain(scrToggle(root));
    expectIcon(scrToggle(root), "Show the live screen", MONITOR);
    fnIn(scrToggle(root))();
    root = p.render();
    expect(hasKeyRow(root)).toBe(true);
    expect(dockOf(root)).toBe("open");   // the card stays in both views
    fnIn(scrToggle(root))();
    expect(hasKeyRow(p.render())).toBe(false);
  } finally { (globalThis as any).matchMedia = had; }
});

test("U19: Chat never shows a key row; idle has no Stop; working has a round ■ Stop in the card before Send that posts Escape", async () => {
  const p = panel();
  p.render();
  p.setData(idle);
  let root = p.render();
  expect(hasKeyRow(root)).toBe(false);
  expect(keyButtons(root)).toEqual([]);
  expect(stopBtn(root)).toBeUndefined();
  p.setData({ ...idle, working: true });
  root = p.render();
  expect(hasKeyRow(root)).toBe(false);
  const stop = stopBtn(root);
  expect(stop.strings).toContain('aria-label="Stop"');
  expect(stop.strings).toContain("■");
  // It sits inside the card, in the row before Send.
  const card = nodes(root).find((n) => n.strings.includes('class="chat-card"'));
  expect(JSON.stringify(card)).toContain("chat-stop");
  const row = nodes(card).find((n) => n.strings.includes('class="chat-row"'));
  const k = row.values.indexOf(stop);
  expect(k).toBeGreaterThan(-1);
  expect(row.strings.split("\u0000")[k + 1]).toContain("chat-send");   // Stop is the value right before the Send button
  await fnIn(stop)();
  expect(p.posts).toEqual([["api/keys", { project: "p", topic: "one", wt: "/w/b 1", keys: ["Escape"] }]]);
  expect(p.h.states).toContain("pressed Esc");
});

test("U19: a menu on the member's screen opens the docked card; folded it is one line with no key row; tapping the line opens it", () => {
  const p = panel();
  p.render();
  p.setData({ ...idle, screen: { tail: menuTail, menu: 3, prompt: ["Do you want to proceed?"], options: ["Yes", "No", "Other"], at: T, age_s: 1 } });
  let root = p.render();
  expect(dockOf(root)).toBe("open");
  expect(questionView(root)).toBeDefined();
  expect(hasKeyRow(root)).toBe(false);
  pressFold(p);
  root = p.render();
  expect(dockOf(root)).toBe("folded");
  expect(questionView(root)).toBeUndefined();
  expect(hasKeyRow(root)).toBe(false);
  expect(flat(lineBtn(root))).toContain("Do you want to proceed?");
  expect(flat(lineBtn(root))).toContain("▴");
  fnIn(lineBtn(root))();
  root = p.render();
  expect(lineBtn(root)).toBeUndefined();
  expect(questionView(root)).toBeDefined();
  // The same card sits above the screen.
  toScreen(p);
  root = p.render();
  expect(hasKeyRow(root)).toBe(true);
  expect(questionView(root)).toBeDefined();
  // No menu on screen: no card, and the one Screen toggle.
  p.setData({ ...idle, screen: { tail: "> ", menu: 0, at: T, age_s: 1 } });
  root = p.render();
  expect(cardOf(root)).toBeUndefined();
  expect(scrToggle(root)).toBeDefined();
});

test("U19: under Screen every key shows, with the menu digits, in every state; its Esc stays Esc and each press posts api/keys", async () => {
  const p = panel();
  p.render();
  p.setData({ ...idle, screen: { tail: "x", menu: 0, at: T, age_s: 1 } });
  toScreen(p);
  let keys = keyButtons(p.render());
  expect(keys.map((k) => k[0])).toEqual(["Escape", "Up", "Down", "Enter", "Tab"]);
  expect(keys[0][1]).toBe("Esc");
  await fnIn(keys[0][2])();
  expect(p.posts).toEqual([["api/keys", { project: "p", topic: "one", wt: "/w/b 1", keys: ["Escape"] }]]);
  p.setData({ ...idle, working: true, screen: { tail: menuTail, menu: 3, at: T, age_s: 1 } });
  toScreen(p);
  keys = keyButtons(p.render());
  expect(keys.map((k) => k[0])).toEqual(["Escape", "Up", "Down", "Enter", "Tab", "1", "2", "3"]);
  expect(keys[0][1]).toBe("Esc");   // working: Stop is in the card, not here
  expect(stopBtn(p.render())).toBeDefined();
  await fnIn(keys[6][2])();
  expect(p.posts.at(-1)).toEqual(["api/keys", { project: "p", topic: "one", wt: "/w/b 1", keys: ["2"] }]);
});

test("U19: a member with no transcript shows its live screen; a toggle switches between screen and chat", () => {
  const screenOf = (root: any) => nodes(root).find((n) => n.strings.includes('class="chat-screen"'));
  const toggle = scrToggle;
  const p = panel();
  p.render();
  p.setData({ agent: "muse", source: "screen", sends: [], turns: [{ role: "screen", text: "old", at: null }],
    screen: { tail: "Pick one:\n❯ 1. Yes\n  2. No", at: T, age_s: 4 } });
  let root = p.render();
  expect(screenOf(root).values).toContain("Pick one:\n❯ 1. Yes\n  2. No");
  expect(screenOf(root).values).toContain("read 4 s ago");
  expectIcon(toggle(root), "Back to the chat", BUBBLE);
  // The toggle sits in the message box row, not in the header.
  expect(nodes(root).find((n) => n.strings.includes('class="chat-row"')).values).toContain(toggle(root));
  expect(headerText(root)).not.toMatch(/chat-seg|chat-scr|<button[^>]*>(Chat|Screen)/);
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
  expectIcon(toggle(root), "Show the live screen", MONITOR);
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
  const make = new Function("useState", "useEffect", "html", "sendAnswer", "sentQ", "nkey", "sqName", "fmtAge", "QPr", "linkedQ", "ActBtn", "copy", "docLabel", "ChatPanel", "useRef", "akey", "hhmmss", "QOptions", "mdPlain", "QMd", "permChecking", "PermWhy", "CheckingLine",
    `${cut("AskOverlay")} return AskOverlay;`);
  const AskOverlay = make(h.useState, h.useEffect, html, async () => {}, new Map(), (n: any) => n.label + "/" + n.squad + "/" + n.id,
    (n: any) => n.squad, () => "1m", () => null, (t: any) => t, () => null, () => {}, () => "", ChatPanel, (v: any) => ({ current: v }), (n: any) => n.label + "/" + n.squad + "/" + n.id, () => "00:00:00", () => null, (t: any) => t, () => null, () => false, () => null, () => null);
  const q = { label: "p", squad: "one", id: "q1", kind: "blocking", from: "builder-x", chat_wt: "/w/bx", chat_label: "builder-x", title: "T", text: "T", choices: [], suggestion: null, source: "lead" };
  const cardActions = new Function("docLabel", cut("cardActions") + " return cardActions;")(() => "doc");
  const render = (n: any) => { h.reset(); return nodes(AskOverlay({ cardActions, data: { squads: [] }, items: [n], at: "p/one/q1", setAt: () => {}, onClose: () => {}, onShow: () => {}, toast: () => {} })); };
  const btn = render(q).find((n) => n.strings.includes('class="btn chat-btn"'))!;
  expect(btn.values).toContain("builder-x");
  fnIn(btn)();
  const open = render(q).find((n) => n.values[0] === ChatPanel)!;
  expect(open.values[1]).toEqual({ project: "p", topic: "one", wt: "/w/bx", label: "builder-x", qid: "q1" });
  // A card with no worktree of its own (a loop PR gate) is answered at the Lead, so it chats with the Lead.
  expect(render({ ...q, from: "loop", chat_wt: "/w/lead", chat_label: "the Lead" }).find((n) => n.strings.includes('class="btn chat-btn"'))!.values).toContain("the Lead");
  expect(render({ ...q, squad: "_studio", chat_wt: null }).some((n) => n.strings.includes("chat-btn"))).toBe(false);
});

test("U5: a safety-check card answered on the board stays, marked checking, with its options and Send disabled", () => {
  const h = hooks();
  const sentQ = new Map<string, string>(), akey = (n: any) => n.label + "/" + n.squad + "/" + n.id;
  const permChecking = new Function("sentQ", "akey", `${lineOf("const permOnly = ")} ${lineOf("const permChecking = ")} return permChecking;`)(sentQ, akey);
  const CheckingLine = () => null, QOptions = () => null;
  const make = new Function("useState", "useEffect", "html", "sendAnswer", "sentQ", "nkey", "sqName", "fmtAge", "QPr", "linkedQ", "ActBtn", "copy", "docLabel", "ChatPanel", "useRef", "akey", "hhmmss", "QOptions", "mdPlain", "QMd", "permChecking", "PermWhy", "CheckingLine",
    `${cut("AskOverlay")} return AskOverlay;`);
  const AskOverlay = make(h.useState, h.useEffect, html, async () => {}, sentQ, akey, (n: any) => n.squad, () => "1m", () => null, (t: any) => t, () => null, () => {}, () => "", () => null,
    (v: any) => ({ current: v }), akey, () => "00:00:00", QOptions, (t: any) => t, () => null, permChecking, () => null, CheckingLine);
  const cardActions = new Function("docLabel", cut("cardActions") + " return cardActions;")(() => "doc");
  const q = { label: "p", squad: "one", id: "q1", kind: "blocking", from: "builder-u1", title: "T", text: "T", choices: [{ label: "Yes" }, { label: "No" }], suggestion: null,
    source: "picker", picker_kind: "permission", picker_answerable: true };
  const render = (n: any) => { h.reset(); return nodes(AskOverlay({ cardActions, data: { squads: [] }, items: [n], at: "p/one/q1", setAt: () => {}, onClose: () => {}, onShow: () => {}, toast: () => {} })); };
  const disabledOpts = (ns: any[]) => { const n = ns.find((x) => x.values[0] === QOptions)!; return n.values[n.strings.split("\u0000").findIndex((seg: string) => /disabled=$/.test(seg))]; };
  const sendBtn = (ns: any[]) => ns.find((n) => n.strings.includes('class="btn pri"') && n.strings.includes("disabled="))!;
  let ns = render(q);
  expect(ns.some((n) => n.values[0] === CheckingLine)).toBe(false);
  expect(disabledOpts(ns)).toBe(false);
  // The server lists it pending (another tab, or after a reload): checking, nothing pressable.
  for (const n of [{ ...q, pending: true }, q]) {
    if (n === q) sentQ.set("p/one/q1", "10:00");   // this tab just sent it
    ns = render(n);
    expect(ns.some((x) => x.values[0] === CheckingLine)).toBe(true);
    expect(disabledOpts(ns)).toBe(true);
    expect(sendBtn(ns).values).toContain(true);
  }
  // A refused press turns it terminal-only: no checking line any more.
  ns = render({ ...q, picker_answerable: false, picker_refused: "the screen shows a different command" });
  expect(ns.some((x) => x.values[0] === CheckingLine)).toBe(false);
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

// Board chat U19b: the digit keys (under Screen) show only while the screen read shows a numbered menu.
test("U19b: digits 1 to N show only for a numbered menu on screen", async () => {
  const { menuOptions } = await import("../../bin/board/board-data.ts");
  const keysFor = (tail: string | null) => {
    const p = panel();
    p.render();
    p.setData({ agent: "claude", source: "transcript", sends: [], turns: [], screen: tail === null ? null : { tail, menu: menuOptions(tail), at: T, age_s: 1 } });
    if (tail !== null) toScreen(p);
    return keyButtons(p.render()).map((k) => k[0]);
  };
  const base = ["Escape", "Up", "Down", "Enter", "Tab"];
  expect(keysFor("● Working on it…\n\n> \n")).toEqual(base);
  expect(keysFor(null)).toEqual([]);   // no screen read: no Screen, no keys
  const perm = " Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No, and tell Claude what to do differently (esc)\n";
  expect(keysFor(perm)).toEqual([...base, "1", "2", "3"]);
  // A numbered list in ordinary output has no selection marker.
  expect(keysFor("Steps:\n1. first\n2. second\n3. third\n\n> ")).toEqual(base);
  expect(menuOptions(" ❯ 1. Yes, I trust this folder\n   2. No, exit\n")).toBe(2);
  expect(menuOptions("❯ 1. a\n  2. b\n  3. c\n  4. d\n  5. e\n  6. f\n")).toBe(6);
});

// chat-multiline-send-fails U2: a failed or cancelled send gets Edit and Dismiss; Edit fills the box.
test("U2: Edit on a failed send fills an empty box as is, appends below a draft, restores its images and notes a gone one", async () => {
  const failed = { id: 5, text: "para one\n\npara two", files: [{ name: "aaaa.png", url: "u/aaaa" }, { name: "bbbb.png", url: "u/bbbb" }], state: "failed", why: "never ready", at: T, done_at: T + 1 };
  const withSends = (p: any) => p.setData({ agent: "claude", source: "transcript", sends: [failed, { ...failed, id: 6, state: "queued" }, { ...failed, id: 7, state: "cancelled" }, { ...failed, id: 8, state: "sent" }], turns: [], working: false });
  const failCtls = (p: any) => nodes(p.render()).filter((m) => m.values.some((v: any) => typeof v === "function" && v.name === "ChatFailCtl"));
  // Only a failed or cancelled send has the pair; a queued one keeps Cancel, a sent one nothing.
  const p = panel(); p.render(); withSends(p);
  expect(failCtls(p)).toHaveLength(2);
  const edit = failCtls(p)[0].values.at(-1);   // <ChatFailCtl x project reload edit>
  expect(typeof edit).toBe("function");
  goneUrls.add("u/bbbb");
  try {
    await edit(failed);
    expect(p.h.states).toContain("para one\n\npara two");   // an empty box takes the text as is
    expect(String(p.h.states.find((v: any) => typeof v === "string" && v.includes("bbbb.png")))).toContain("image bbbb.png is gone, not restored");
    expect(p.h.states.find((v: any) => Array.isArray(v) && v[0]?.id === "aaaa.png")).toEqual([{ id: "aaaa.png", url: "u/aaaa", name: "aaaa.png" }]);
    // A box holding a draft: the text goes below it after a blank line.
    p.setData({ agent: "claude", source: "transcript", sends: [failed], turns: [], working: false });
    attrAfter(p.render(), 'class="chat-in"', "onInput")({ target: { value: "my draft" } });
    await edit(failed);
    expect(p.h.states).toContain("my draft\n\npara one\n\npara two");
  } finally { goneUrls.clear(); }
});

test("U2: Dismiss posts api/chat-dismiss for that send; a refusal shows its text and re-enables the buttons", async () => {
  const x = { id: 5, text: "t", state: "failed" };
  const posts: any[] = [];
  let reloads = 0;
  const h = hooks(), ctl = new Function("useState", "html", "post", `${chatSrc} return { ChatFailCtl };`)(h.useState, html, async (...a: any[]) => { posts.push(a); }).ChatFailCtl;
  const root = ctl({ x, project: "p", reload: () => reloads++, edit: () => {} });
  const dismiss = nodes(root).flatMap((n) => n.values).filter((v: any) => typeof v === "function")[1];
  await dismiss();
  expect(posts).toEqual([["api/chat-dismiss", { project: "p", id: 5 }]]);
  expect(reloads).toBe(1);
});

// chat-key-buttons U2, chat-view-switcher U1: the docked question card.
const bq = (id: string, over: any = {}) => ({ id, title: "Title " + id, question: "Question " + id + "?", choices: [{ label: "Yes", does: "do it" }, { label: "No", does: null }], since: "2026-11-25T10:00:00Z",
  blocking: true, source: "lead", answerable: true, ...over });
// A node's text: its strings with the values filled in (functions and false leave nothing).
const flat = (v: any): string => Array.isArray(v) ? v.map(flat).join("") : v?.strings !== undefined
  ? v.strings.split("\u0000").map((x: string, i: number) => x + (i < v.values.length ? flat(v.values[i]) : "")).join("") : typeof v === "function" || v == null || v === false ? "" : String(v);
const btnWith = (root: any, text: string) => nodes(root).find((n) => n.strings.includes(text) && n.values.some((v: any) => typeof v === "function"))!;
// The rendered QOptions of the question card (the stub html leaves a component as a node): its props come from the attributes.
const component = (fn: any, root: any) => {
  const n = nodes(root).find((x) => x.values[0] === fn);
  if (!n) return null;
  const names = n.strings.split("\u0000").map((seg: string) => /(\w+)=$/.exec(seg)?.[1]);
  const props: any = {};
  names.forEach((k: string | undefined, i: number) => { if (k) props[k] = n.values[i]; });
  return fn(props);
};
const qoptions = (p: any, root: any) => component(p.mod.QOptions, root);
const optBtns = (root: any) => nodes(root).filter((n) => n.strings.startsWith("<button key=") && n.strings.includes("<span class=\"n\">"));
const qopts = (root: any) => nodes(root).filter((n) => n.strings.includes("chat-qopt") || n.values.some((v: any) => typeof v === "string" && v.includes("chat-qopt")));

test("U2: a blocking board question opens the card once; the fold holds until a new since; a non-blocking one starts folded", () => {
  const p = panel();
  p.render();
  p.setData({ ...idle, questions: [bq("q1")] });
  let root = p.render();
  expect(dockOf(root)).toBe("open");
  expect(flat(questionView(root))).toContain("Title q1");
  expect(flat(questionView(root))).toContain("Question q1?");
  expect(flat(cardOf(root))).toContain("builder-x asks");
  expect(flat(cardOf(root))).not.toContain("1 of 1");
  expect(hasKeyRow(root)).toBe(false);
  // The operator folds it: it stays folded while the same asking is open (opened once).
  pressFold(p);
  p.setData({ ...idle, questions: [bq("q1")] });
  root = p.render();
  expect(dockOf(root)).toBe("folded");
  expect(questionView(root)).toBeUndefined();
  expect(flat(lineBtn(root))).toContain("builder-x asks: Title q1");
  // A new asking (another since) opens it again.
  p.setData({ ...idle, questions: [bq("q1", { since: "2026-11-25T11:00:00Z" })] });
  expect(dockOf(p.render())).toBe("open");
  // Non-blocking: no auto-open, the folded line.
  const n = panel();
  n.render();
  n.setData({ ...idle, questions: [bq("q2", { blocking: false })] });
  root = n.render();
  expect(dockOf(root)).toBe("folded");
  expect(flat(lineBtn(root))).toContain("asks: Title q2");
  fnIn(lineBtn(root))();
  expect(dockOf(n.render())).toBe("open");
});

test("chat-view-switcher U1: ⤢ fills the panel and ⤡ returns; ⤢ holds until a new blocking item; answering folds the card", async () => {
  const p = panel();
  p.render();
  p.setData({ ...idle, questions: [bq("q1")] });
  const box = (root: any) => root.values[1];
  expect(box(p.render())).toBe("mbox chat");
  pressFull(p);
  p.setData({ ...idle, questions: [bq("q1")] });
  let root = p.render();
  expect(dockOf(root)).toBe("full");
  expect(box(root)).toBe("mbox chat dock-full");
  expect(flat(cardOf(root))).toContain("⤡");
  pressFull(p);
  root = p.render();
  expect(dockOf(root)).toBe("open");
  expect(flat(cardOf(root))).toContain("⤢");
  pressFull(p);
  p.setData({ ...idle, questions: [bq("q1", { since: "2026-11-25T11:00:00Z" })] });
  root = p.render();
  expect(dockOf(root)).toBe("open");   // a new asking opens at the card size
  const choices = nodes(qoptions(p, questionView(root))).filter((n) => n.strings.startsWith("<button key="));
  await fnIn(choices[0])();
  expect(cardOf(p.render())).toBeUndefined();   // the only question is answered: no card
  // With another, non-blocking one left, the card folds.
  const q = panel();
  q.render();
  q.setData({ ...idle, questions: [bq("q3"), bq("q4", { blocking: false })] });
  await fnIn(nodes(qoptions(q, questionView(q.render()))).filter((n) => n.strings.startsWith("<button key="))[0])();
  root = q.render();
  expect(dockOf(root)).toBe("folded");
  expect(flat(lineBtn(root))).toContain("asks: Title q4");
});

test("U2: two open questions page '1 of 2', the screen menu first; a choice posts the answer with its since and the card's key leaves", async () => {
  const p = panel();
  p.render();
  p.setData({ ...idle, questions: [bq("q1")], screen: { tail: menuTail, menu: 2, prompt: ["Do you want to proceed?"], options: ["Yes", "No"], at: T, age_s: 1 } });
  let root = p.render();
  expect(flat(cardOf(root))).toContain("1 of 2");
  expect(flat(questionView(root))).toContain("Do you want to proceed?");
  // Next: the board question; its choice answers it.
  navFns(root)[1]();
  root = p.render();
  expect(flat(cardOf(root))).toContain("2 of 2");
  expect(flat(questionView(root))).toContain("Title q1");
  const choices = nodes(qoptions(p, questionView(root))).filter((n) => n.strings.startsWith("<button key="));
  expect(choices.map((c) => c.values[0])).toEqual(["Yes", "No"]);
  await fnIn(choices[0])();
  expect(p.answers).toEqual([["p", "one", "q1", "Yes", "2026-11-25T10:00:00Z"]]);
  // Answered: it is gone from the card (the page marks it sent).
  root = p.render();
  expect(flat(questionView(root) ?? "")).not.toContain("Title q1");
});

test("U3: opened for a question id, the Question view starts there, blocking or not; an unknown id starts at the first", () => {
  const open = (qid: string, blocking = true) => {
    const p = panel();
    p.props.qid = qid;
    p.render();
    p.setData({ ...idle, questions: [bq("q1", { blocking }), bq("q2", { blocking })] });
    return { p, root: p.render() };
  };
  for (const blocking of [true, false]) {
    const { root } = open("q2", blocking);
    expect(flat(cardOf(root))).toContain("2 of 2");
    expect(flat(questionView(root))).toContain("Question q2?");
  }
  const unknown = open("gone");
  expect(flat(cardOf(unknown.root))).toContain("1 of 2");
  expect(flat(questionView(unknown.root))).toContain("Question q1?");
  // Paging still works from the named question, and keeps the view open when nothing blocks.
  for (const blocking of [true, false]) {
    const { p, root } = open("q2", blocking);
    navFns(root)[0]();
    expect(flat(cardOf(p.render()))).toContain("1 of 2");
  }
  // A menu that comes up later shows first, over the named question.
  const { p, root } = open("q2", false);
  pressFold(p);
  p.setData({ ...idle, questions: [bq("q1", { blocking: false }), bq("q2", { blocking: false })], screen: { tail: menuTail, menu: 2, prompt: ["Proceed now?"], options: ["Yes", "No"], at: T, age_s: 1 } });
  expect(flat(questionView(p.render()))).toContain("Proceed now?");
});

test("U2: a terminal-only picker shows its text and Open Screen to answer, no answer buttons", () => {
  const p = panel();
  p.render();
  p.setData({ ...idle, questions: [bq("q9", { source: "picker", answerable: false })], screen: { tail: "x", menu: 0, at: T, age_s: 1 } });
  const root = p.render();
  expect(flat(questionView(root))).toContain("Title q9");
  const list = nodes(qoptions(p, questionView(root)));
  expect(list.some((n) => n.strings.startsWith("<button"))).toBe(false);   // read-only rows only
  expect(flat(list)).toContain("Yes");
  btnWith(questionView(root), "Open Screen to answer").values.filter((v: any) => typeof v === "function").pop()();
  expect(hasKeyRow(p.render())).toBe(true);
  expect(dockOf(p.render())).toBe("open");   // the card stays open over the screen
});

describe("U5: a safety-check prompt the board can't press doesn't look pressable", () => {
  const perm = (over: any) => bq("q7", { source: "picker", picker_kind: "permission", shown: "git push origin work", asker: "builder-u1", ...over });
  const view = (q: any) => {
    const p = panel();
    p.render();
    p.setData({ ...idle, questions: [q], screen: { tail: "x", menu: 0, at: T, age_s: 1 } });
    return { p, root: questionView(p.render()) };
  };
  test("a refused card says why, where to answer it and the screen's options as text; Open Screen is its only button", () => {
    const { p, root } = view(perm({ answerable: false, picker_refused: "the screen shows a different command" }));
    const why = flat(component(p.mod.PermWhy, root));
    expect(why).toContain("The board didn't press it: the screen shows a different command.");
    expect(why).toContain("Answer it in builder-u1's terminal");
    expect(why).toContain("On the screen: 1. Yes · 2. No");
    expect(nodes(root).some((n) => n.values[0] === p.mod.QOptions)).toBe(false);   // no choice tiles
    const btns = qopts(root);
    expect(btns).toHaveLength(1);
    expect(flat(btns[0])).toContain("Open Screen to answer");
  });
  test("a card never answerable says the board can't check this command", () => {
    const { p, root } = view(perm({ answerable: false }));
    expect(flat(component(p.mod.PermWhy, root))).toContain("The board can't check this command.");
    expect(qopts(root)).toHaveLength(1);
  });
  test("an answerable card still shows Yes and No as buttons", () => {
    const { p, root } = view(perm({ answerable: true }));
    expect(component(p.mod.PermWhy, root)).toBeNull();
    const list = nodes(qoptions(p, root)).filter((n) => n.strings.startsWith("<button"));
    expect(list.map(flat).join(" ")).toContain("Yes");
    expect(list).toHaveLength(2);
  });
});

test("U2: a screen menu with no board question has one button per option that posts api/keys with its digit, and Esc leaves the menu", async () => {
  const p = panel();
  p.render();
  p.setData({ ...idle, screen: { tail: menuTail, menu: 3, prompt: ["Do you want to proceed?"], options: ["Yes", "No", "Other"], at: T, age_s: 1 } });
  const root = p.render();
  const btns = nodes(questionView(root)).filter((n) => n.strings.startsWith("<button key=") && n.strings.includes("chat-qopt"));
  expect(btns).toHaveLength(3);
  expect(hasKeyRow(root)).toBe(false);
  await fnIn(btns[1])();
  expect(p.posts).toEqual([["api/keys", { project: "p", topic: "one", wt: "/w/b 1", keys: ["2"] }]]);
  // After the press the card folds.
  expect(dockOf(p.render())).toBe("folded");
  await fnIn(btnWith(questionView(root), "Esc · leave the menu"))();
  expect(p.posts.at(-1)).toEqual(["api/keys", { project: "p", topic: "one", wt: "/w/b 1", keys: ["Escape"] }]);
});

test("U2: a member with an open question carries a ? in the switcher and tabs", () => {
  const p = panel();
  p.render();
  p.setData({ ...idle });
  const crew = [{ wt: "/w/b 1", label: "builder-x", role: "builder", unread: 0, reply_due: 0, reply_at: null, asks: 0 }, { wt: "/w/l", label: "lead", role: "lead", unread: 0, reply_due: 0, reply_at: null, asks: 2 }];
  p.h.states[p.h.states.findIndex((v: any) => Array.isArray(v) && v.length === 0)] = crew;
  const marks = nodes(p.render()).filter((n) => n.strings.includes("chat-ask"));
  expect(marks.length).toBeGreaterThan(0);
});

test("U4: the free-text answer box is keyed by question id + since, so paging remounts it empty", () => {
  const p = panel();
  p.render();
  p.setData({ ...idle, questions: [bq("q1", { choices: [] }), bq("q2", { choices: [], since: "2026-11-25T11:00:00Z" })] });
  let root = p.render();
  const boxKey = () => nodes(questionView(root)).find((n) => n.strings.includes("chat-qtext")).values[0];
  const first = boxKey();
  expect(first).toContain("q1");
  navFns(root)[1]();
  root = p.render();
  const second = boxKey();
  expect(second).toContain("q2");
  expect(second).toContain("2026-11-25T11:00:00Z");
  expect(second).not.toBe(first);
});
