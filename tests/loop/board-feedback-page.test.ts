// ds-feedback-github-issues U4: the board's Feedback panel (web/board.html FeedbackPanel) and its header button,
// rendered with stub hooks in the board-chat-page.test.ts style: htm's tagged template becomes {strings, values}.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const src = (() => { const i = page.indexOf("const FB_TABS = "); const j = page.indexOf("function FeedbackPanel("); return page.slice(i, page.indexOf("\n}\n", j) + 2); })();
const html = (strings: TemplateStringsArray, ...values: any[]) => ({ strings: strings.join("\u0000"), values });
const nodes = (v: any): any[] => Array.isArray(v) ? v.flatMap(nodes) : v?.strings !== undefined ? [v, ...v.values.flatMap(nodes)] : [];
// The value filling `attr=${…}` after `marker` in the template that holds it.
const attr = (root: any, marker: string, name: string) => {
  const n = nodes(root).find((x) => x.strings.includes(marker))!;
  const seg = n.strings.split("\u0000"); let seen = false;
  for (let i = 0; i < n.values.length; i++) { seen ||= seg[i].includes(marker); if (seen && seg[i].trimEnd().endsWith(name + "=")) return n.values[i]; }
  throw new Error(`no ${name} after ${marker}`);
};
function hooks() {
  const states: any[] = []; let slot = 0; const effects: (() => any)[] = [];
  return { states, effects, reset() { slot = 0; effects.length = 0; },
    useState: (initial: any) => { const i = slot++; if (!(i in states)) states[i] = initial; return [states[i], (v: any) => { states[i] = typeof v === "function" ? v(states[i]) : v; }]; },
    useEffect: (fn: () => any) => { effects.push(fn); } };
}
const draft = (o: any = {}) => ({ id: 3, kind: "issue", title: "Lead restarts lose the plan", body: "Body text", area: "lead", label: "bug", target: null, evidence: "bin/x.ts at main",
  checked_at: "abcdef1234", leak: "ok", leak_why: null, state: "review", reason: null, repo: null, issue: null, url: null, fix_pr: null, fix_here: false, created_at: 1,
  notes: [{ id: 11, project: "p", text: "raw local note", state: "drafted" }], ...o });
const note = (o: any = {}) => ({ id: 21, project: "p", squad: null, role: null, text: "a note", source: "cli", state: "new", draft: null, evidence: null, reason: null, at: 1, issue: null, url: null, fix_pr: null, fix_here: false, ...o });

function panel(reply: any, summary: any = { on: true, repo: "o/r", review: 1, notes: 1 }, project: string | undefined = "p") {
  const h = hooks(), posts: any[] = [], toasts: string[] = [];
  const fetchStub = async () => ({ ok: true, status: 200, json: async () => reply });
  const mod = new Function("useState", "useEffect", "html", "post", "fetch", "setInterval", "clearInterval", "document", `${src} return { FeedbackPanel, fbNoteState };`)(
    h.useState, h.useEffect, html, async (...a: any[]) => { posts.push(a); return { ok: true, id: 1 }; }, fetchStub, () => 1, () => {}, { addEventListener() {}, removeEventListener() {} });
  const props = { summary, project, toast: (t: string) => toasts.push(t), onClose: () => {} };
  return { h, posts, toasts, mod, render: () => { h.reset(); return mod.FeedbackPanel(props); }, setData: (d: any) => { h.states[1] = d; } };
}
const click = async (root: any, marker: string) => { await attr(root, marker, "onClick")(); };

test("the header button counts the drafts and reads off with no repo, between Studio and Settings", () => {
  const i = page.indexOf("${studioBtns}"), f = page.indexOf("fb-btn", i), s = page.indexOf("⚙ Settings", i);
  expect(i > 0 && f > i && s > f).toBe(true);
  expect(page.slice(f, s)).toContain('" off"');
  expect(page.slice(f, s)).toContain("F.review");
});

test("a draft card shows title, body, its notes marked not sent, evidence and the leak state", () => {
  const p = panel({ review: [draft()], filed: [], notes: [] });
  p.render(); p.setData({ review: [draft()], filed: [], notes: [] });
  const s = JSON.stringify(p.render());
  for (const t of ["Lead restarts lose the plan", "Body text", "raw local note", "not sent", "bin/x.ts at main", "leak check: passed"]) expect(s).toContain(t);
});

test("Post, Dismiss on a draft, Add to and Edit post the right body", async () => {
  const reply = { review: [draft()], filed: [], notes: [] };
  const p = panel(reply); p.render(); p.setData(reply);
  let r = p.render();
  await click(r, 'class="btn sm pri fb-post"');
  await click(r, 'class="btn sm fb-dismiss-draft"');
  expect(p.posts.map((x) => x[1])).toEqual([{ project: "p", action: "post", draft: 3 }, { project: "p", action: "dismiss", draft: 3 }]);
  p.h.states[4] = { 3: "#42" };   // target
  r = p.render(); await click(r, 'class="btn sm fb-addto"');
  expect(p.posts[2][1]).toEqual({ project: "p", action: "add-to", draft: 3, target: 42 });
  p.h.states[3] = { id: 3, title: "New", body: "New body" };   // edit
  r = p.render(); await click(r, 'class="btn sm pri fb-save"');
  expect(p.posts[3][1]).toEqual({ project: "p", action: "edit", draft: 3, title: "New", body: "New body" });
});

test("a blocked draft's Post is disabled, and so is Post while posting is off", () => {
  const p = panel({}); p.render(); p.setData({ review: [draft({ leak: "blocked", leak_why: "word" })], filed: [], notes: [] });
  const r = p.render();
  expect(attr(r, 'class="btn sm pri fb-post"', "disabled")).toBe(true);
  expect(JSON.stringify(r)).toContain("leak check: blocked (word)");
  const q = panel({}, { on: false, repo: null }); q.render(); q.h.states[0] = "review"; q.setData({ review: [draft()], filed: [], notes: [] });
  expect(attr(q.render(), 'class="btn sm pri fb-post"', "disabled")).toBe(true);
  const ok = panel({}); ok.render(); ok.setData({ review: [draft()], filed: [], notes: [] });
  expect(attr(ok.render(), 'class="btn sm pri fb-post"', "disabled")).toBe(false);
});

test("Dismiss on a single note carries the reason; a dismissed note offers Restore", async () => {
  const reply = { review: [], filed: [], notes: [note()] };
  const p = panel(reply); p.render(); p.h.states[0] = "notes"; p.setData(reply);
  p.h.states[5] = { 21: " stale " };   // why
  let r = p.render(); await click(r, 'class="btn sm fb-dismiss-note"');
  expect(p.posts[0][1]).toEqual({ project: "p", action: "dismiss", note: 21, why: "stale" });
  p.h.states[0] = "notes"; p.h.states[6] = "dismissed"; p.setData({ review: [], filed: [], notes: [note({ state: "dismissed", reason: "stale" }), note({ id: 22 })] });
  r = p.render();
  expect(JSON.stringify(r)).not.toContain('"fb-dismiss-note"');
  await click(r, 'class="btn sm fb-restore"');
  expect(p.posts[1][1]).toEqual({ project: "p", action: "restore", note: 21 });
});

test("note states read as the plan names them", () => {
  const { fbNoteState } = panel({}).mod;
  expect(fbNoteState({ state: "filed", issue: 7 })).toBe("filed #7");
  expect(fbNoteState({ state: "fixed", fix_pr: 9, fix_here: true })).toBe("fixed in #9 · in your version");
  expect(fbNoteState({ state: "already-fixed" })).toBe("already fixed");
});

test("with no repo the panel opens on the Notes tab", () => {
  const p = panel({}, { on: false, repo: null, review: 0 }); p.render();
  expect(p.h.states[0]).toBe("notes");
});
