// U289: the real board page rendered in a DOM, plus a tag-balance check over every html`` template.
// Why: #587's AccountDetail left two divs open; htm then returns its raw build array, React throws error #31
// only when an account row is opened, and the grep-only tests/board-page.sh let it (and #561's Details) ship.
//   1. render: web/board.html's own script runs in happy-dom on the pinned React/htm builds (no network), fed a
//      fixture board.json; every openable thing (aria-expanded rows, closed <details>) is opened, and nothing may
//      throw or console.error. It names no project, account or squad.
//   2. balance: each html`…` literal is parsed with the real htm; an unclosed tag makes htm return
//      ["tag", props, …children] instead of an element, which is what this flags (with the template's line).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount as mountPage, type Run } from "./board-mount";
import { BACKEND_NAMES } from "../../bin/backend/registry.ts";

const root = join(import.meta.dir, "../..");
const page = readFileSync(join(root, "web/board.html"), "utf8");
const nm = (p: string) => readFileSync(join(root, "node_modules", p), "utf8");
const scriptStart = page.indexOf("<script>\n") + "<script>\n".length;
const pageScript = page.slice(scriptStart, page.indexOf("</script>", scriptStart));

// ---- the fixture: one account with a usable free-reset grant, a used one, a disabled one; no emails, no tokens.
const now = Math.floor(Date.now() / 1000);
const grant = { id: "g1", label: "Weekly reset", refills: ["weekly"], total: 2, left: 1, use_by: now + 86400 * 5, usable_now: true };
const account = (over: any) => ({
  agent: "claude", account: "acct-a", label: "acct-a", plan: "max", disabled: false, limited: false, session_pct: 40, weekly_pct: 20,
  session_reset: now + 3600, weekly_reset: now + 86400, note: "", users: [], users_other: 0, skills: "ok", ...over,
});
// board-empty.json is a real `board.sh --json` over an empty state root; the accounts are the fixture's.
const board = {
  ...JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8")),
  project: "fixture", page_version: "v1", as_of: { accounts: now },
  accounts_summary: { total: 3, free: 3, limited: [], near: [], level: "ok" },
  accounts: [
    account({ resets: { state: "reported", count: 1, first_use_by: grant.use_by, grants: [grant] }, reset_last: { outcome: "used", at: now - 600, detail: "ok" } }),
    account({ account: "acct-b", label: "acct-b", resets: { state: "reported", count: 0, grants: [] } }),
    account({ agent: "codex", account: "acct-c", label: "acct-c", disabled: true, resets: { state: "not_reported" } }),
  ],
};

const mount = (b: any = board, open = true) => mountPage(b, open);

test("the board page renders and every openable row and details opens without an error", async () => {
  const r = await mount();
  try {
    expect(r.root.children.length).toBeGreaterThan(0);
    expect(r.opened).toBeGreaterThan(0);
    // An opened account shows its detail panel (the #587 regression: opening one blanked the page).
    expect(r.root.querySelector(".ainfo")).not.toBeNull();
    expect(r.errors).toEqual([]);
    expect(r.root.textContent!.length).toBeGreaterThan(0);
  } finally { await r.window.happyDOM.close(); }
});

// ---- U6: every Flow card opens a details window. Squads: one on the board (with the unit "live"), the rest gone.
const flowCard = (over: any) => ({ key: "fixture/gone/x", project: "fixture", squad: "gone", slug: "x", stage: "building", pr: null, needs_you: false, ask: null, stuck: false, slow: false, group: null, in_stage_s: 60, ...over });
const flowBoard = {
  ...board,
  squads: [{ label: "fixture", topic: "live", status: "running", members: [], display_status: "running", units: [{ slug: "u-live", state: "done", title: "A live unit", deps: [], dependents: [], ext_deps: [] }] }],
  flow: {
    ...board.flow,
    cards: [
      flowCard({ key: "fixture/gone/b1", slug: "b1", stage: "building", pr: { num: 7, url: "https://example.test/pull/7" } }),
      flowCard({ key: "fixture/gone/n1", slug: "n1", stage: "needs_you", needs_you: true, ask: "fixture/gone/q1" }),
    ],
    merged: [
      { key: "fixture/live/u-live", project: "fixture", squad: "live", slug: "u-live", focus: "muted", pr: 5, pr_url: "https://example.test/pull/5", at: now - 600, took_s: 5400 },
      { key: "fixture/gone/m1", project: "fixture", squad: "gone", slug: "m1", pr: 6, pr_url: "https://example.test/pull/6", at: now - 1200, took_s: 3600 },
    ],
  },
};
test("paused-in-swimlanes: the lane header counts paused apart, its paused group starts folded, an unfolded dim card says why and for how long", async () => {
  const pz = (slug: string) => flowCard({ key: "fixture/gone/" + slug, slug, stage: "building", group: "paused", paused: true, paused_s: 90000, note: "paused by you" });
  const pb = { ...flowBoard, flow: { ...flowBoard.flow, cards: [flowCard({ key: "fixture/gone/w1", slug: "w1", stage: "building", group: "coding" }), pz("p1"), pz("p2")],
    counts: { ...flowBoard.flow.counts, building: 1, pr_open: 0, needs_you: 0, merging: 0, queued: 0, paused: 2 } } };
  const r = await mount(pb, false);
  const doc = r.window.document;
  try {
    doc.getElementById("flow").open = true;
    await new Promise((x) => setTimeout(x, 30));
    expect(doc.querySelector("#flow-col-building h4")?.textContent).toContain("1 · 2 paused");
    expect(doc.querySelector("#flow small")?.textContent).toContain("2 paused");
    const g = doc.querySelector('#flow-col-building [data-group="paused"]') as any;
    expect(g.querySelector(".fgl").textContent).toBe("▸ paused");
    expect(g.querySelectorAll(".fcard").length).toBe(0);
    g.querySelector(".fgrp").dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
    await new Promise((x) => setTimeout(x, 30));
    const c = doc.querySelector('#flow-col-building [data-group="paused"] .fcard.paused') as any;
    expect(c).not.toBeNull();
    expect(c.querySelector(".m").textContent).toContain("paused by you");
    expect(c.querySelector(".m").textContent).toContain("25h");
  } finally { r.window.close?.(); }
});
test("every Flow card opens a details window; a PR number opens the PR, not the window", async () => {
  const r = await mount(flowBoard, false);
  const w = r.window, doc = w.document;
  const opened: string[] = [];
  w.open = (u: string) => { opened.push(u); };
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await new Promise((x) => setTimeout(x, 30)); };
  const card = (slug: string) => [...doc.querySelectorAll(".fcard")].find((c: any) => c.querySelector(".t .tn").textContent.trim() === slug) as any;
  const close = async () => { const b = doc.querySelector(".ud-close"); if (b) await click(b); };
  try {
    doc.getElementById("flow").open = true;
    await new Promise((x) => setTimeout(x, 30));
    // every card, merged included, is a button that opens a dialog
    for (const slug of ["b1", "n1", "u-live", "m1"]) { expect(card(slug).getAttribute("role")).toBe("button"); expect(card(slug).tabIndex).toBe(0); }
    // 1. merged card of a squad on the board: that unit's UnitDetails
    await click(card("u-live"));
    expect(doc.querySelector(".ud-title")?.textContent).toBe("A live unit");
    await close();
    // 2. merged card of a closed squad: FlowCardDetails with the PR link, merged ago and took
    await click(card("m1"));
    expect(doc.querySelector(".fcd")).not.toBeNull();
    expect(doc.querySelector(".fcd-pr a")?.getAttribute("href")).toBe("https://example.test/pull/6");
    expect(doc.querySelector(".fcd-merged")?.textContent).toContain("ago");
    expect(doc.querySelector(".fcd-took")?.textContent).toBe("1h");
    expect(doc.querySelector(".fcd-gone")?.textContent).toContain("no longer on the board");
    expect(doc.querySelector(".fcd-answer")).toBeNull();
    await close();
    // 3. Building card of a gone squad opens the window, not the PR
    await click(card("b1"));
    expect(doc.querySelector(".fcd-stage")?.textContent).toBe("building");
    expect(opened).toEqual([]);
    await close();
    // 4. Needs-you card of a gone squad: Answer
    await click(card("n1"));
    expect(doc.querySelector(".fcd-answer")).not.toBeNull();
    await close();
    // 5. a click on #num opens the PR and not the window (open card and merged card)
    for (const slug of ["b1", "m1"]) { await click(card(slug).querySelector("a")); expect(doc.querySelector(".ud")).toBeNull(); }
    // 6. Enter on a focused merged card opens the window
    card("m1").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((x) => setTimeout(x, 30));
    expect(doc.querySelector(".fcd")).not.toBeNull();
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); }
});

// U291: a member row's button reads Inbox (with its unread count) and opens a panel titled Inbox · <member>.
test("a member with 2 unread messages shows 'Inbox 2' and opens the 'Inbox · <member>' panel", async () => {
  const member = { role: "thinker", label: "thinker", wt: "/w/thinker", state: "idle", unread: 2, reply_due: 0 };
  const squad = { label: "fixture", topic: "one", type: "feature", autonomy: "orchestration", ship_mode: "ce-pipeline", display_status: "working", display_key: "working", phase: "build", status: "active", members: [member], units: [], questions: [] };
  const r = await mount({ ...board, squads: [squad] });
  try {
    const doc = r.window.document;
    const btn = () => [...doc.querySelectorAll("button")].find((b: any) => /^Inbox/.test(b.textContent.trim()));
    const until = async (f: () => any) => { for (let k = 0; k < 40 && !f(); k++) await new Promise((res) => setTimeout(res, 25)); };
    await until(() => doc.querySelector(".row.squad"));
    const sq = doc.querySelector(".row.squad");
    sq.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
    await until(btn);
    expect(btn()).toBeTruthy();
    expect(btn().textContent.trim()).toBe("Inbox 2");
    expect(btn().getAttribute("title")).toBe("Messages sent to thinker, newest first (view only: nothing is marked read)");
    btn().dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
    await until(() => doc.querySelector(".mhd"));
    expect(doc.querySelector(".mhd").textContent).toContain("Inbox · thinker");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});

// ---- board-start-squad-box U1: the Start squad dialog.
async function startDialog(reply: (body: any) => any, b: any = board) {
  const r = await mount(b, false);
  const w = r.window, doc = w.document, posts: any[] = [];
  w.fetch = async (url: string, init?: any) => {
    if (String(url) !== "api/request") return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    const body = JSON.parse(init.body); posts.push(body);
    const x = await reply(body);
    return { ok: x.status < 400, status: x.status, json: async () => x.body, text: async () => JSON.stringify(x.body) };
  };
  const wait = (ms = 30) => new Promise((x) => setTimeout(x, ms));
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(); };
  const set = async (sel: string, v: string, ev = "input") => { const el = doc.querySelector(sel); el.value = v; el.dispatchEvent(new w.Event(ev, { bubbles: true })); await wait(); };
  const btn = (re: RegExp) => [...doc.querySelectorAll("button")].find((b: any) => re.test(b.textContent.trim())) as any;
  for (let k = 0; k < 80 && !btn(/^Start squad$/); k++) await wait(25); // a loaded host renders late
  await click(btn(/^Start squad$/));
  expect(doc.querySelector('[role="dialog"][aria-label="Start squad"]')).not.toBeNull();
  return { r, w, doc, posts, wait, click, set, btn, text: () => doc.querySelector(".start-text") };
}
const BRIEF = "Line one\n\n\tindented 'q' \"d\" $x `b` \\ é\n- bullet";
test("Start squad: a multi-line brief and the fields are one POST that keeps every newline; a second press does nothing", async () => {
  const d = await startDialog(async () => { await new Promise((x) => setTimeout(x, 60)); return { status: 202, body: { ok: true, id: 7 } }; });
  try {
    expect(d.text().getAttribute("maxlength")).toBeNull();
    await d.set(".start-text", BRIEF); await d.set(".start-slug", "my-topic");
    await d.set(".start-type", "feature", "change"); await d.set(".start-autonomy", "lfg", "change"); await d.set(".start-start", "plan", "change");
    expect(d.doc.querySelector(".start-count").textContent).toContain("4 lines");
    await d.click(d.btn(/^Send$/)); await d.click(d.btn(/^Sending…$/));
    d.text()?.dispatchEvent(new d.w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    await d.wait(120);
    expect(d.posts).toEqual([{ project: "fixture", action: "start", text: BRIEF, slug: "my-topic", type: "feature", autonomy: "lfg", start: "plan", backend: "orca" }]);
    expect(d.doc.querySelector('[role="dialog"][aria-label="Start squad"]')).toBeNull();
    expect(d.doc.body.textContent).toContain("sent to the Studio: start squad my-topic (request #7)");
    expect(d.r.errors).toEqual([]);
  } finally { await d.w.happyDOM.close(); }
});
test("Reload instructions: the loop's answer is the toast, not a Studio request id", async () => {
  const r = await mount(board, false);
  const w = r.window, doc = w.document, posts: any[] = [];
  w.confirm = () => true;
  w.fetch = async (url: string, init?: any) => {
    if (String(url) !== "api/request") return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    posts.push(JSON.parse(init.body));
    const b = { ok: true, action: "reload", wishes: 3 };
    return { ok: true, status: 202, json: async () => b, text: async () => JSON.stringify(b) };
  };
  const wait = (ms = 30) => new Promise((x) => setTimeout(x, ms));
  try {
    const find = () => [...doc.querySelectorAll("button")].find((b: any) => /Reload dev-studio instructions/.test(b.getAttribute("title") || "")) as any;
    for (let k = 0; k < 80 && !find(); k++) await wait(25);
    find().dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(100);
    expect(posts).toEqual([{ project: "fixture", action: "reload" }]);
    expect(doc.body.textContent).toContain("asked the loop: 3 members re-read their instructions");
    expect(doc.body.textContent).not.toContain("asked the Studio");
  } finally { await w.happyDOM.close(); }
});
test("Start squad: empty, oversized and bad-slug texts say what is wrong and post nothing", async () => {
  const d = await startDialog(() => ({ status: 202, body: { id: 1 } }));
  try {
    await d.click(d.btn(/^Send$/));
    expect(d.doc.querySelector(".start-err")?.textContent).toBe("say what the squad should do: the text is empty");
    await d.set(".start-text", "x".repeat(32 * 1024 + 1));
    expect(d.doc.querySelector(".start-count")?.className).toContain("bad");
    await d.click(d.btn(/^Send$/));
    expect(d.doc.querySelector(".start-err")?.textContent).toBe("the text is 32.0 KiB; the limit is 32 KiB");
    await d.set(".start-text", "ok"); await d.set(".start-slug", ".bad slug");
    await d.click(d.btn(/^Send$/));
    expect(d.doc.querySelector(".start-err")?.textContent).toBe("topic slug may only use letters, digits, . _ - and must not start with .");
    expect(d.posts).toEqual([]);
  } finally { await d.w.happyDOM.close(); }
});
test("Start squad: a 400 keeps the dialog and the text; testing disables Start and leaves it out", async () => {
  const d = await startDialog(() => ({ status: 400, body: { error: "the text has a control character on line 2" } }));
  try {
    await d.set(".start-text", "a\nb"); await d.set(".start-start", "plan", "change");
    await d.set(".start-type", "testing", "change");
    expect(d.doc.querySelector(".start-start").disabled).toBe(true);
    await d.click(d.btn(/^Send$/));
    expect(d.posts).toEqual([{ project: "fixture", action: "start", text: "a\nb", type: "testing", autonomy: "checkpoints", backend: "orca" }]);
    expect(d.doc.querySelector(".start-text").value).toBe("a\nb");
    expect(d.doc.body.textContent).toContain("not sent: the text has a control character on line 2");
    expect(d.btn(/^Send$/)).toBeTruthy();
    // Escape with text asks before discarding
    d.text().dispatchEvent(new d.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await d.wait();
    expect(d.doc.querySelector(".start-discard")?.textContent).toContain("Discard this brief?");
    await d.click(d.doc.querySelector(".start-discard-yes"));
    expect(d.doc.querySelector('[role="dialog"][aria-label="Start squad"]')).toBeNull();
    expect(d.r.errors).toEqual([]);
  } finally { await d.w.happyDOM.close(); }
});

// ---- the static check
// End of the template literal whose opening backtick is at `i`; `${…}` nests code, which nests templates.
function templateEnd(src: string, i: number): number {
  for (let k = i + 1; k < src.length; k++) {
    const c = src[k];
    if (c === "\\") k++;
    else if (c === "`") return k;
    else if (c === "$" && src[k + 1] === "{") k = exprEnd(src, k + 2);
  }
  throw new Error("unterminated template at offset " + i);
}
// Index of the `}` closing a `${` whose code starts at `i`.
function exprEnd(src: string, i: number): number {
  let depth = 1;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === "`") k = templateEnd(src, k);
    else if (c === '"' || c === "'") { for (k++; src[k] !== c; k++) if (src[k] === "\\") k++; }
    else if (c === "/" && src[k + 1] === "/") k = src.indexOf("\n", k);
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return k;
  }
  throw new Error("unterminated expression at offset " + i);
}
// The literal pieces of a template body (between its backticks) split at each top-level `${…}`.
function pieces(body: string): string[] {
  const out: string[] = []; let from = 0;
  for (let k = 0; k < body.length; k++) {
    if (body[k] === "\\") k++;
    else if (body[k] === "$" && body[k + 1] === "{") { out.push(body.slice(from, k)); k = exprEnd(body, k + 2); from = k + 1; }
  }
  out.push(body.slice(from));
  return out;
}
const cook = (s: string): string => (0, eval)("`" + s + "`");

type Tpl = { line: number; strings: string[] };
function templates(src: string): Tpl[] {
  const found: Tpl[] = [];
  const scan = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      const c = src[k];
      if (c === "`") {
        const end = templateEnd(src, k);
        if (/\bhtml$/.test(src.slice(Math.max(0, k - 5), k))) found.push({ line: src.slice(0, k).split("\n").length, strings: pieces(src.slice(k + 1, end)) });
        // nested templates live inside the ${…} of this one
        for (let j = k + 1; j < end; j++) {
          if (src[j] === "\\") j++;
          else if (src[j] === "$" && src[j + 1] === "{") { const e = exprEnd(src, j + 2); scan(j + 2, e); j = e; }
        }
        k = end;
      } else if (c === '"' || c === "'") { for (k++; src[k] !== c; k++) if (src[k] === "\\") k++; }
      else if (c === "/" && src[k + 1] === "/") k = src.indexOf("\n", k);
    }
  };
  scan(0, src.length);
  return found;
}

test("every html`` template in web/board.html closes its tags", () => {
  const htm = new Function("module", "exports", nm("htm/dist/htm.js") + "\nreturn module.exports;")({ exports: {} }, {});
  const H = Symbol("h");
  const build = htm.bind((...a: any[]) => ({ [H]: true, a }));
  const tpls = templates(pageScript);
  expect(tpls.length).toBeGreaterThan(100);
  const startLine = page.slice(0, scriptStart).split("\n").length - 1;
  const bad: string[] = [];
  for (const t of tpls) {
    const strings: any = t.strings.map(cook); strings.raw = strings;
    const res = build(strings, ...t.strings.slice(1).map(() => null));
    // htm's signature for an unclosed tag: the raw build array, tag name first, then its props.
    if (Array.isArray(res) && typeof res[0] === "string" && /^[A-Za-z][\w.:-]*$/.test(res[0]) && res.length > 1 && (res[1] === null || (typeof res[1] === "object" && !(H in res[1]))))
      bad.push(`web/board.html:${startLine + t.line}: unclosed <${res[0]}> in html\`${t.strings[0].slice(0, 60).replace(/\s+/g, " ")}…`);
  }
  expect(bad).toEqual([]);
});

test("the tag-balance check flags a template that leaves a tag open", () => {
  const htm = new Function("module", "exports", nm("htm/dist/htm.js") + "\nreturn module.exports;")({ exports: {} }, {});
  const res = htm.bind((...a: any[]) => a)`<div class="ainfo"><div class="ai-sec"><span>x</span></div>`;
  expect(Array.isArray(res) && res[0] === "div").toBe(true);
});

// ---- unit-detail-cleanup U2: the window's heading, status line, filled rows only and bottom bar, on three units.
const udUnit = (slug: string, over: any) => ({ slug, state: "planned", title: null, about: null, done_text: null, check_text: null, plan: null, plan_unit: null, deps: [], dependents: [], ext_deps: [], builder_wt: null, builder: null, tier: null, pr: null, held: false, ...over });
const udBoard = {
  ...board,
  squads: [{
    label: "fixture", topic: "sq", status: "running", display_status: "running", topic_plan: null,
    plans: [{ name: "sq-plan.md", mtime: now - 3600, markdown: "# plan\n\nU6 text" }],
    members: [{ role: "builder", label: "builder-u6", wt: "wt-b", state: "working" }],
    exposed: [{ id: 1, name: "stack", url: "http://localhost:3000", role: "builder-u6", state: "open", status: "up", reach: "remote", age_s: 60, legacy: false },
      { id: 2, name: "old", url: "http://localhost:3001", role: "builder-u6", state: "down", status: "down", reach: "down", age_s: 60, legacy: false }],
    units: [
      udUnit("u1-titled", { state: "done", title: "A titled unit", dependents: ["adhoc-done", "u9-bare"] }),
      udUnit("adhoc-done", { state: "done", about: "Fixes the stale lane label on the flow card. It also renames a key.", deps: ["u1-titled"], pr: { num: 24508, status: "merged", url: "https://example.test/pull/24508" }, done_at: now - 7200, builder_wt: "wt-gone", tier: "std" }),
      udUnit("u6-building", { state: "working", title: "Building unit", done_text: "it opens.", check_text: "tests/x.sh", plan: "/p/sq-plan.md", plan_unit: "U6", deps: ["u1-titled"], builder_wt: "wt-b", tier: "hard·sonnet-5.5 ⚠opus-5.5", builder: { model_label: "sonnet-5.5", model: "opus-5.5", model_mismatch: true } }),
      udUnit("u9-bare", { deps: ["u1-titled", "u6-building"] }),
    ],
  }],
  flow: { ...board.flow, cards: ["u6-building", "u9-bare"].map((slug) => flowCard({ key: "fixture/sq/" + slug, squad: "sq", slug, stage: "building" })), merged: [{ key: "fixture/sq/adhoc-done", project: "fixture", squad: "sq", slug: "adhoc-done", pr: 24508, pr_url: "https://example.test/pull/24508", at: now - 7200, took_s: 60 }] },
};
test("the unit window: title, status line, only filled rows, Builder model, Plan link, buttons in the bottom bar", async () => {
  const r = await mount(udBoard, false);
  const w = r.window, doc = w.document;
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await new Promise((x) => setTimeout(x, 30)); };
  const card = (slug: string) => [...doc.querySelectorAll(".fcard")].find((c: any) => c.querySelector(".t").textContent.trim() === slug) as any;
  const rows = () => [...doc.querySelectorAll(".ud dd")].map((d: any) => d.className);
  const text = (sel: string) => doc.querySelector(sel)?.textContent ?? "";
  try {
    doc.getElementById("flow").open = true;
    await new Promise((x) => setTimeout(x, 30));
    // 1. done ad-hoc unit: title from about, status line, What it did, titled Needs/none, no Builder/Plan/Done/Check rows
    console.log("STEP1"); await click(card("adhoc-done")); console.log("STEP1b");
    expect(text(".ud-title")).toBe("Fixes the stale lane label on the flow card");
    expect(text(".ud-slug")).toBe("adhoc-done");
    expect(text(".ud-status")).toContain("done");
    expect(text(".ud-status")).toContain("#24508 · merged");
    expect(text(".ud-merged")).toBe("merged 2h ago");
    expect(rows()).toEqual(["ud-about", "ud-waits"]);
    expect(doc.querySelector(".ud dt")?.textContent).toBe("What it did");
    expect(text(".ud-waits")).toContain("✓ A titled unit");
    expect(doc.querySelector(".ud-bar")).toBeNull(); // done: no button applies
    expect(text(".ud").includes("not stored") || text(".ud").includes("add-unit")).toBe(false);
    await click(doc.querySelector(".ud-close"));
    // 2. building plan unit: title, Done when, Check, Needs ✓, Builder with tier and the running model + the set one, Plan link, buttons in the bar
    await click(card("u6-building"));
    expect(text(".ud-title")).toBe("Building unit");
    expect(text(".ud-slug")).toBe("u6-building · plan U6");
    expect(rows()).toEqual(["ud-done", "ud-check", "ud-waits", "ud-builder", "ud-runs", "ud-plan"]);
    expect(text(".ud-waits")).toContain("✓ A titled unit");
    expect(text(".ud-builder")).toContain("builder-u6 · working · hard · sonnet-5.5 (set: opus-5.5)");
    // U2 (exposed-optimise): the Builder row lists its open entries as links, never the down one
    const bl = [...doc.querySelectorAll(".ud-builder a")];
    expect(bl.map((x: any) => x.textContent)).toEqual(["stack"]);
    expect((bl[0] as any).getAttribute("href")).toBe("http://localhost:3000/");
    // ... and Show in squad lands on its crew row: the chip counts the open entry, the ⋯ menu opens it, no Down entry in it
    await click(doc.querySelector(".ud-show"));
    expect(text(".link-chip")).toContain("1");
    const row = doc.querySelector(".link-chip")?.closest(".m") as any;
    await click(row.querySelector(".acts-btn"));
    const items = [...row.querySelectorAll(".mlink-item")];
    expect(items.map((x: any) => x.textContent)).toEqual(["open stack"]);
    expect((items[0] as any).getAttribute("href")).toBe("http://localhost:3000/");
    doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await click(card("u6-building"));
    const bar = doc.querySelector(".ud-bar");
    expect(bar?.querySelector(".ud-chat")).not.toBeNull();
    expect(bar?.querySelector(".ud-cancel")).not.toBeNull();
    expect(doc.querySelector(".ud-planlink")?.textContent).toBe("sq-plan.md");
    await click(doc.querySelector(".ud-planlink"));
    expect(doc.querySelector(".ud")).toBeNull();
    expect(doc.querySelector(".mbox .mhd span")?.textContent).toBe("sq-plan.md");
    doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise((x) => setTimeout(x, 30));
    // 3. bare planned unit: title from the slug, only Needs (titles, state for an open dep), Cancel in the bar
    await click(card("u9-bare"));
    expect(text(".ud-title")).toBe("bare");
    expect(rows()).toEqual(["ud-waits", "ud-runs"]);
    expect(text(".ud-waits")).toContain("Building unit · working");
    expect(doc.querySelector(".ud-bar .ud-cancel")).not.toBeNull();
    expect(doc.querySelector(".ud-chat")).toBeNull();
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});

// ---- hold-cancels-queue-undo-approval U3: the Plans list's approved chip and "Take back approval".
test("the Plans list: an approved plan shows its chip and a menu item that opens the confirm", async () => {
  const sq = { ...udBoard.squads[0], plans: [
    { name: "sq-a-plan.md", mtime: now - 3600, markdown: "# a", approved: true, queued: 2, started: 1 },
    { name: "sq-b-plan.md", mtime: now - 7200, markdown: "# b", approved: false, revoked_at: "2026-11-18T10:00:00Z", queued: 0, started: 0 }] };
  const r = await mount({ ...udBoard, squads: [sq] }, false);
  const w = r.window, doc = w.document;
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await new Promise((x) => setTimeout(x, 30)); };
  try {
    doc.getElementById("squads").open = true;
    await new Promise((x) => setTimeout(x, 30));
    await click(doc.querySelector(".row.squad"));
    expect(doc.querySelectorAll(".plan-approved").length).toBe(1);
    expect(doc.querySelectorAll(".plan-menu-btn").length).toBe(1);
    expect(doc.querySelector(".plan-revoked")?.textContent).toBe("approval taken back");
    await click(doc.querySelector(".plan-menu-btn"));
    await click(doc.querySelector(".plan-revoke"));
    expect(doc.querySelector(".revoke-what")?.textContent).toContain("2 queued Builders are dropped, 1 started Builder is paused");
    const go = doc.querySelector(".revoke-go") as any;
    expect(go.disabled).toBe(true);
    const why = doc.querySelector(".revoke-why") as any;
    why.value = "misread ok"; why.dispatchEvent(new w.Event("input", { bubbles: true }));
    await new Promise((x) => setTimeout(x, 30));
    expect((doc.querySelector(".revoke-go") as any).disabled).toBe(false);
    await click(doc.querySelector(".revoke-keep"));
    expect(doc.querySelector(".revoke-what")?.textContent).not.toContain("paused");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});

// ---- debrief-in-needs-you pages U1: the Try it group sits in Documents, after the debrief, and opens like a plan.
test("Documents: a squad's Try it page shows as its own group and opens", async () => {
  const sq = { ...udBoard.squads[0], debrief: "set out: x", try_it: { name: "sq-try-it.md", mtime: now - 600, markdown: "# Try it — sq\n\n1. Open the board; see the squad." } };
  const r = await mount({ ...udBoard, squads: [sq] }, false);
  const w = r.window, doc = w.document;
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await new Promise((x) => setTimeout(x, 30)); };
  try {
    doc.getElementById("squads").open = true;
    await new Promise((x) => setTimeout(x, 30));
    await click(doc.querySelector(".row.squad"));
    const groups = [...doc.querySelectorAll(".docbox .docs")].map((g: any) => g.getAttribute("data-docs"));
    expect(groups.slice(0, 2)).toEqual(["debrief", "tryit"]);
    await click(doc.querySelector('.docs[data-docs="tryit"] .plan'));
    expect(doc.querySelector(".mbox .mhd span")?.textContent).toBe("sq — try it");
    expect(doc.querySelector(".mbox")?.textContent).toContain("Open the board; see the squad.");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});

test("Documents: a squad without a Try it page has no Try it group", async () => {
  const r = await mount({ ...udBoard, squads: [{ ...udBoard.squads[0], try_it: null }] }, false);
  const w = r.window, doc = w.document;
  try {
    doc.getElementById("squads").open = true;
    await new Promise((x) => setTimeout(x, 30));
    doc.querySelector(".row.squad").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await new Promise((x) => setTimeout(x, 30));
    expect(doc.querySelector('.docs[data-docs="tryit"]')).toBeNull();
  } finally { await r.window.happyDOM.close(); }
});

test("the dim ★ on a Merged card reads at opacity .7, dimmer than the bright ★ (U6)", async () => {
  const bright = { ...flowBoard.flow.cards[0], focus: "on", key: "fixture/gone/bright", slug: "bright" };
  const r = await mount({ ...flowBoard, flow: { ...flowBoard.flow, cards: [bright, ...flowBoard.flow.cards] } }, false);
  const doc = r.window.document;
  const css = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8").match(/<style>([\s\S]*?)<\/style>/)![1];
  const st = doc.createElement("style"); st.textContent = css; doc.head.appendChild(st);
  doc.getElementById("flow").open = true;
  await new Promise((x) => setTimeout(x, 30));
  const dim = doc.querySelector('.fcard[data-key="fixture/live/u-live"] .umark.focus.held') as any;
  expect(dim).not.toBeNull();
  expect(dim.getAttribute("title")).toBe("focus squad");
  expect(doc.querySelector('.fcard[data-key="fixture/gone/m1"] .umark')).toBeNull();
  const op = (el: any) => Number(r.window.getComputedStyle(el).opacity || 1);
  expect(op(dim)).toBeGreaterThanOrEqual(0.6);
  expect(op(dim)).toBeLessThan(op(doc.querySelector(".fcard .umark.focus:not(.held)")));
});

test("the ★ and ⚡ come before the unit name, outside the part that is cut (U7)", async () => {
  const slug = "u7-marks-in-front-of-the-unit-nm"; // 32 characters
  expect(slug.length).toBe(32);
  const card = { ...flowBoard.flow.cards[0], key: "fixture/live/" + slug, slug, focus: "on", urgent: true };
  const sq = { ...flowBoard.squads[0], units: [{ slug, state: "building", focus: "on", urgent: true, title: "t", deps: [], dependents: [], ext_deps: [], tier: "standard" }] };
  const r = await mount({ ...flowBoard, squads: [sq], flow: { ...flowBoard.flow, cards: [card, ...flowBoard.flow.cards] } }, false);
  const doc = r.window.document;
  const css = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8").match(/<style>([\s\S]*?)<\/style>/)![1];
  const st = doc.createElement("style"); st.textContent = css; doc.head.appendChild(st);
  doc.getElementById("flow").open = true; doc.getElementById("squads").open = true;
  await new Promise((x) => setTimeout(x, 30));
  const before = (a: any, b: any) => !!(a.compareDocumentPosition(b) & 4); // b follows a
  const ell = (el: any) => r.window.getComputedStyle(el).textOverflow;
  const t = doc.querySelector(`.fcard[data-key="fixture/live/${slug}"] .t`) as any;
  expect(before(t.querySelector(".umark.urgent"), t.querySelector(".tn"))).toBe(true);
  expect(before(t.querySelector(".umark.focus"), t.querySelector(".tn"))).toBe(true);
  expect(t.querySelector(".tn").textContent).toBe(slug);
  expect(ell(t.querySelector(".tn"))).toBe("ellipsis");
  expect(ell(t.querySelector(".umark"))).not.toBe("ellipsis");
  doc.querySelector(".row.squad")!.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
  await new Promise((x) => setTimeout(x, 30));
  const un = doc.querySelector(".detail .u .un") as any;
  expect(before(un.querySelector(".umark.focus"), un.querySelector(".unit-open"))).toBe(true);
  expect(before(un.querySelector(".umark.urgent"), un.querySelector(".unit-open"))).toBe(true);
  expect(ell(un.querySelector(".unit-open"))).toBe("ellipsis");
  expect(ell(un.querySelector(".umark"))).not.toBe("ellipsis");
  expect(doc.querySelector('.fcard[data-key="fixture/gone/m1"] .umark')).toBeNull();
});

// ---- debrief-on-archive U2: a `sweep-debrief-<topic>-<n>` card opens the archived squad's debrief; Mark read answers the _studio card.
test("a Debrief card shows 'Debrief · <topic>', opens the archived debrief and Mark read posts the _studio answer", async () => {
  const card = { squad: "_studio", label: "fixture", kind: "studio", card_squad: null, id: "sweep-debrief-wrap-1", debrief: "wrap", from: "loop", title: "Debrief: wrap", titled: true,
    text: "Wrapped up cleanly — written at archive by the Lead.", choices: [], options: ["Mark read"], act: null, age_min: 1, about: null };
  const archived = { topic: "wrap", closed_at: "2026-11-20T10:00:00Z", type: "feature", framing: "f", progress: { total: 1, done: 1 }, prs: [], plans: [], lavish: [],
    debrief: "Wrapped up cleanly.\n\nUNIQUE-DEBRIEF-BODY" };
  const r = await mount({ ...board, needs_you: [card], archived: [archived] }, false);
  const w = r.window, doc = w.document, posts: any[] = [];
  w.fetch = async (url: string, init?: any) => {
    if (String(url) === "api/answer") posts.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
  const wait = (ms = 30) => new Promise((x) => setTimeout(x, ms));
  try {
    for (let k = 0; k < 80 && !doc.querySelector(".qnote"); k++) await wait(25);
    const note = doc.querySelector(".qnote");
    expect(note.textContent).toContain("Debrief · wrap");
    note.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await wait(100);
    expect(doc.body.textContent).toContain("UNIQUE-DEBRIEF-BODY");
    expect(posts).toEqual([]); // opening it is not reading it
    const mark = [...doc.querySelectorAll(".qnote button")].find((b: any) => b.textContent.trim() === "Mark read") as any;
    mark.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await wait(100);
    expect(posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ project: "fixture", topic: "_studio", id: "sweep-debrief-wrap-1", answer: "Mark read" });
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); }
});

// debrief-in-needs-you U3: an old-id card (`loop-debrief-…` with reason `debrief-<topic>`) is a Debrief card like the new one.
test("an old-id and a new-id Debrief card both show in Needs you, with linked PRs; Open falls back to the card text; Mark read answers only its card", async () => {
  const mk = (id: string, topic: string, extra: any = {}) => ({ squad: "_studio", label: "fixture", kind: "studio", card_squad: null, id, debrief: topic, reason: `debrief-${topic}`, from: null,
    title: "Debrief: " + topic, titled: true, text: `1. Set out to do ${topic}.\n2. Shipped #123 and #45.`, choices: [], options: ["Mark read"], act: null, age_min: 3000, about: null, repo_slug: "o/r", ...extra });
  const oldC = mk("loop-debrief-oldy-1uy1p7zj2un2e", "oldy"), newC = mk("sweep-debrief-newy-1", "newy");
  const archived = { topic: "newy", closed_at: "2026-11-20T10:00:00Z", type: "feature", framing: "f", progress: { total: 1, done: 1 }, prs: [], plans: [], lavish: [], debrief: "NEWY-ARCHIVED-BODY" };
  const r = await mount({ ...board, needs_you: [oldC, newC], loop_notes: [], archived: [archived] }, false);
  const w = r.window, doc = w.document, posts: any[] = [];
  w.fetch = async (url: string, init?: any) => {
    if (String(url) === "api/answer") posts.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
  };
  const wait = (ms = 30) => new Promise((x) => setTimeout(x, ms));
  try {
    for (let k = 0; k < 80 && doc.querySelectorAll(".qnote").length < 2; k++) await wait(25);
    const notes = [...doc.querySelectorAll(".qnote")] as any[];
    expect(notes.map((n) => n.querySelector(".sq").textContent)).toEqual([expect.stringContaining("Debrief · oldy"), expect.stringContaining("Debrief · newy")]);
    expect(notes[0].querySelectorAll('a[href="https://github.com/o/r/pull/123"]').length).toBe(1);
    expect(notes[0].querySelector(".lndet.dbr")).not.toBeNull();
    expect(doc.querySelectorAll(".lnnote").length).toBe(0);
    notes[1].querySelector('[data-ev="open-debrief"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await wait(100);
    expect(doc.body.textContent).toContain("NEWY-ARCHIVED-BODY");
    notes[0].querySelector('[data-ev="open-debrief"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await wait(100);
    expect(doc.body.textContent).toContain("The full debrief of this squad is not on the board.");
    expect(doc.body.textContent).toContain("Set out to do oldy.");
    notes[0].querySelector('[data-ev="mark-read"]').dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await wait(100);
    expect(posts).toEqual([expect.objectContaining({ topic: "_studio", id: "loop-debrief-oldy-1uy1p7zj2un2e", answer: "Mark read" })]);
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); }
});

// chat-with-studio U1: the header's Studio button(s), the badge, the new-reply dot and the opener, on the real page.
const studio = (over: any = {}) => ({ label: "fixture", wt: "/w/st", handle: "term_s", adopted: true, unread: 0, reply_due: 0, working: false, reply_at: null,
  agent: "claude", walk: null, model_label: null, account: null, account_label: null, ctx: null, ctx_level: null, ...over });
const btns = (r: Run) => [...r.root.querySelectorAll(".hdr .studio-btn")] as any[];
const wait = (ms = 60) => new Promise((x) => setTimeout(x, ms));

test("chat-with-studio U1: an adopted Studio's button opens the chat on _studio; no badge or dot while quiet", async () => {
  const r = await mountPage({ ...board, studio: [studio()] }, false, { "api/chat": { agent: "claude", source: "transcript", turns: [], sends: [] } });
  try {
    expect(btns(r)).toHaveLength(1);
    expect(btns(r)[0].disabled).toBe(false);
    expect(btns(r)[0].querySelector(".msg-badge")).toBeNull();
    expect(btns(r)[0].querySelector(".studio-dot")).toBeNull();
    btns(r)[0].click(); await wait();
    expect(r.urls).toContain("api/chat?project=fixture&topic=_studio&wt=%2Fw%2Fst");
    expect(r.root.querySelector(".chat .mhd")!.textContent).toContain("Chat · Studio · fixture");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});

test("chat-with-studio U1: the badge shows unread + reply_due, a reply newer than the seen mark gives a dot until the panel was open", async () => {
  const at = Math.floor(Date.now() / 1000);
  const turns = [{ role: "assistant", text: "hello", at }];
  const b = { ...board, studio: [studio({ unread: 1, reply_due: 2, working: true, reply_at: at })] };
  const r = await mountPage(b, false, { "api/chat": { agent: "claude", source: "transcript", turns, sends: [] } });
  try {
    // first visit: no mark, so reply_at becomes the mark and there is no dot
    expect(btns(r)[0].querySelector(".msg-badge")!.textContent).toBe("3");
    expect(btns(r)[0].querySelector(".studio-dot")).toBeNull();
    expect(btns(r)[0].textContent).toContain("working");
  } finally { await r.window.happyDOM.close(); }
  const r2 = await mountPage({ ...b, studio: [studio({ reply_at: at + 100 })] }, false, { "api/chat": { agent: "claude", source: "transcript", turns: [{ role: "assistant", text: "newer", at: at + 100 }], sends: [] } });
  try {
    r2.window.localStorage.setItem("b:chat-seen:fixture//w/st", JSON.stringify(at));
    btns(r2)[0].click(); await wait();   // opening re-renders; the panel loads and marks the newer reply seen
    expect(r2.window.localStorage.getItem("b:chat-seen:fixture//w/st")).toBe(JSON.stringify(at + 100));
    (r2.root.querySelector(".chat .mhd button") as any).click(); await wait();
    expect(r2.root.querySelector(".chat")).toBeNull();
    expect(btns(r2)[0].querySelector(".studio-dot")).toBeNull();
  } finally { await r2.window.happyDOM.close(); }
});

test("chat-with-studio U1: a non-adopted Studio's button is disabled with its reason; a host-wide board has one labelled button each", async () => {
  const r = await mountPage({ ...board, studio: [studio({ adopted: false, handle: null })] }, false);
  try {
    expect(btns(r)[0].disabled).toBe(true);
    expect(btns(r)[0].title).toContain("has not adopted");
  } finally { await r.window.happyDOM.close(); }
  const r2 = await mountPage({ ...board, project: "", studio: [studio({ label: "a", wt: "/w/a" }), studio({ label: "b", wt: "/w/b" })] }, false);
  try {
    expect(btns(r2).map((x) => x.textContent.trim().replace(/\s+/g, " "))).toEqual(["💬 Studio · a", "💬 Studio · b"]);
  } finally { await r2.window.happyDOM.close(); }
});

// ---- orca-backend-alternatives U9: the dialog presets the project's default_backend and sends the backend picked.
test("Start squad: Backend is a line showing the project's backend, follows the project, offers no choice, and is sent", async () => {
  const b = { ...board, projects: [{ ...(board.projects?.[0] ?? {}), label: "fixture", default_backend: "tmux" }, { label: "other", default_backend: "orca" }] };
  const d = await startDialog(() => ({ status: 202, body: { ok: true, id: 3 } }), b);
  try {
    expect(d.doc.querySelector(".start-backend").textContent).toBe("tmux");
    expect(d.doc.querySelector("select.start-backend")).toBeNull();
    await d.set(".start-project", "other", "change");
    expect(d.doc.querySelector(".start-backend").textContent).toBe("orca");
    await d.set(".start-project", "fixture", "change");
    await d.set(".start-text", "go");
    await d.click(d.btn(/^Send$/));
    expect(d.posts).toEqual([{ project: "fixture", action: "start", text: "go", type: "feature", autonomy: "checkpoints", backend: "tmux" }]);
    expect(d.r.errors).toEqual([]);
  } finally { await d.w.happyDOM.close(); }
});

test("Settings shows the project's backend with one line on what changing it does", async () => {
  const b = { ...board, projects: [{ ...(board.projects?.[0] ?? {}), label: "fixture", default_backend: "tmux" }] };
  const r = await mount(b, false, { "api/limits": { limits: [], groups: [] }, "api/roles": { roles: [] }, "api/skills": { roles: [] } });
  try {
    r.window.location.hash = "#settings";
    for (let k = 0; k < 40 && !r.window.document.querySelector(".set-backend"); k++) await new Promise((res) => setTimeout(res, 25));
    const t = r.window.document.querySelector(".set-backend").textContent;
    expect(t).toContain("Backend: tmux");
    expect(t).toContain("default_backend");
    expect(t).toContain("already running keep theirs");
  } finally { await r.window.happyDOM.close(); }
});

test("a squad off orca shows its backend chip, with the worktree tool only when it is not the backend's default", async () => {
  const sq = (topic: string, over: any) => ({ label: "fixture", topic, type: "feature", autonomy: "orchestration", ship_mode: "ce-pipeline", display_status: "working", display_key: "working", phase: "build", status: "active", members: [], units: [], questions: [], ...over });
  const r = await mount({ ...board, squads: [sq("plain", { backend: "orca", worktree_provider: "orca", provider_default: true }),
    sq("ontmux", { backend: "tmux", worktree_provider: "git", provider_default: true }), sq("ontree", { backend: "tmux", worktree_provider: "treehouse", provider_default: false })] }, false);
  try {
    const doc = r.window.document;
    for (let k = 0; k < 40 && doc.querySelectorAll(".row.squad").length < 3; k++) await new Promise((res) => setTimeout(res, 25));
    const rowOf = (t: string) => [...doc.querySelectorAll(".row.squad")].find((e: any) => e.textContent.includes(t)) as any;
    expect(rowOf("plain").querySelector(".sqbackend")).toBeNull();
    expect(rowOf("ontmux").querySelector(".sqbackend").textContent).toBe("tmux");
    expect(rowOf("ontree").querySelector(".sqbackend").textContent).toBe("tmux · treehouse");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});

// ---- archive-leftovers U3: a leftover shows its check: look first with the commits and files, safe, or not checked.
test("a squad's Leftovers block shows look first with commits, files and Keep it; a safe one and an unchecked one", async () => {
  const lo = (wt: string, check: any) => ({ wt, path: "/w/" + wt, branch: "work-" + wt, n_files: 0, files: [], unpushed: 0, reason: "kept: 1 uncommitted, 2 unpushed", waits_on: "old text", unit: "u1", pr: "12", age_min: 5, check });
  const check = (over: any) => ({ at: now - 120, safe: false, commits: [{ sha: "aaaa1111bbbb", title: "first change" }, { sha: "cccc2222dddd", title: "second change" }], differ: ["src/only-here.ts"], n_differ: 1, target: "origin/main", target_sha: "e".repeat(40), head: "f".repeat(40), fingerprint: "fp1", checked_age_s: 180, ...over });
  const squad = { label: "fixture", topic: "one", type: "feature", autonomy: "orchestration", ship_mode: "ce-pipeline", display_status: "working", display_key: "working", phase: "build", status: "active", members: [], units: [], questions: [],
    leftovers: [lo("look", check({})), lo("safe", check({ safe: true, commits: [], differ: [], n_differ: 0 })), lo("none", null)] };
  const r = await mount({ ...board, squads: [squad] });
  try {
    const doc = r.window.document;
    const until = async (f: () => any) => { for (let k = 0; k < 40 && !f(); k++) await new Promise((res) => setTimeout(res, 25)); };
    await until(() => doc.querySelector(".row.squad"));
    doc.querySelector(".row.squad").dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
    await until(() => doc.querySelector(".lo"));
    const rows = [...doc.querySelectorAll(".lo")].map((e: any) => e.textContent as string);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("look first");
    expect(rows[0]).toContain("first change");
    expect(rows[0]).toContain("second change");
    expect(rows[0]).toContain("src/only-here.ts");
    expect(rows[0]).toContain("PR #12");
    expect(rows[0]).toContain("checked 3m ago");
    expect(rows[0]).toContain("Keep it");
    expect(rows[1]).toContain("safe, removing on the next check");
    expect(rows[2]).toContain("not checked yet");
    expect(doc.querySelector(".box h3")!.parentElement!.textContent).not.toContain("waits on");
    const keep = [...doc.querySelectorAll(".lo a")].find((a: any) => /Keep it/.test(a.textContent)) as any;
    expect(keep.getAttribute("title")).toContain("git -C /w/look push origin HEAD:refs/heads/work-look");
    expect(keep.getAttribute("title")).toContain("git -C /w/look diff --binary HEAD > ~/.dev-studio/state/fixture/pages/one/leftovers/look.patch");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});

// archive-leftovers U4: Remove on a look-first leftover asks first (commits, files, the patch line) and posts the
// check's fingerprint; on a safe one it posts at once; a finished press shows its outcome on the row.
test("Remove on a leftover: look first confirms with the commits and posts the fingerprint; safe posts at once", async () => {
  const lo = (wt: string, check: any, remove: any = null) => ({ wt, path: "/w/" + wt, branch: "work-" + wt, n_files: 0, files: [], unpushed: 0, reason: "kept", waits_on: null, unit: "u1", pr: null, age_min: 5, check, remove });
  const check = (over: any) => ({ at: now - 120, safe: false, commits: [{ sha: "aaaa1111bbbb", title: "first change" }], differ: ["src/only-here.ts"], n_differ: 1, target: "origin/main", target_sha: "e".repeat(40), head: "f".repeat(40), fingerprint: "0123456789abcdef01234567", checked_age_s: 60, ...over });
  const squad = { label: "fixture", topic: "one", type: "feature", autonomy: "orchestration", ship_mode: "ce-pipeline", display_status: "working", display_key: "working", phase: "build", status: "active", members: [], units: [], questions: [],
    leftovers: [lo("look", check({})), lo("safe", check({ safe: true, commits: [], differ: [], n_differ: 0, fingerprint: "89abcdef0123456789abcdef" })),
      lo("gone", check({}), { id: 9, at: now - 30, done_at: now - 20, result: { ok: false, state: "refused", error: "refused: the tree changed since you looked" } })] };
  const r = await mount({ ...board, squads: [squad] });
  const w = r.window, doc = w.document, posts: any[] = [];
  w.fetch = async (url: string, init?: any) => {
    if (String(url) === "api/leftover-remove") { posts.push(JSON.parse(init.body)); return new w.Response(JSON.stringify({ ok: true, id: posts.length }), { status: 202 }); }
    return new w.Response("{}", { status: 404 });
  };
  const until = async (f: () => any) => { for (let k = 0; k < 40 && !f(); k++) await new Promise((res) => setTimeout(res, 25)); };
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await new Promise((x) => setTimeout(x, 30)); };
  try {
    await until(() => doc.querySelector(".row.squad"));
    await click(doc.querySelector(".row.squad"));
    await until(() => doc.querySelector(".lo"));
    const rows = () => [...doc.querySelectorAll(".lo")] as any[];
    expect(rows()[2].textContent).toContain("not removed: the tree changed since you looked");
    await click(rows()[0].querySelector(".lo-rm"));
    expect(posts).toEqual([]);
    const ask = doc.querySelector(".lo-confirm") as any;
    expect(ask.textContent).toContain("first change");
    expect(ask.textContent).toContain("src/only-here.ts");
    expect(ask.querySelector(".lo-save").textContent).toBe("uncommitted changes are saved to a patch; commits stay on branch work-look");
    await click(ask.querySelector(".lo-go"));
    expect(posts).toEqual([{ project: "fixture", topic: "one", wt: "look", fingerprint: "0123456789abcdef01234567" }]);
    expect(doc.querySelector(".lo-confirm")).toBeNull();
    expect(rows()[0].textContent).toContain("removing…");
    await click(rows()[1].querySelector(".lo-rm"));
    expect(doc.querySelector(".lo-confirm")).toBeNull();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual({ project: "fixture", topic: "one", wt: "safe", fingerprint: "89abcdef0123456789abcdef" });
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); }
});

// archive-leftovers U2: an archived squad's box lists its kept worktrees in the same Leftovers block as a live squad.
test("an archived squad's box shows the Leftovers block", async () => {
  const archived = { topic: "oldsq", closed_at: "2026-11-20T10:00:00Z", type: "feature", framing: "f", progress: { total: 1, done: 1 }, prs: [], plans: [], lavish: [],
    leftovers: [{ wt: "wt-arch", path: "/tmp/wt-arch-UNIQUE", branch: "br-arch", n_files: 1, files: ["a.txt"], unpushed: 0, reason: "kept", waits_on: null, unit: "u1", age_min: 5 }] };
  const r = await mount({ ...board, archived: [archived] }, false);
  const w = r.window, doc = w.document;
  const wait = (ms = 30) => new Promise((x) => setTimeout(x, ms));
  try {
    for (let k = 0; k < 80 && !doc.querySelector(".arch"); k++) await wait(25);
    const show = [...doc.querySelectorAll(".arch button")].find((b: any) => b.textContent.trim() === "show") as any;
    show.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await wait(100);
    const row = [...doc.querySelectorAll(".row.squad")].find((e: any) => e.textContent.includes("oldsq")) as any;
    expect(row).toBeTruthy();
    row.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    await wait(100);
    expect(doc.body.textContent).toContain("Leftovers");
    expect(doc.body.textContent).toContain("/tmp/wt-arch-UNIQUE");
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); }
});

// ---- board-actions-as-wishes U2: the update banner follows the loop's `update` request; Show commits is a dialog.
const upBoard = (u: any) => ({ ...board, project: "fixture", update: { behind: 0, branch: "main", commits: [], classes: [], need: "none", state: "ok", stale: false, ahead: 0, dirty: false, last_update: null, squads_behind: null, pending: null, others: [], workers: 0, project: "fixture", run: null, ...u } });
const banner = (r: any) => r.root.querySelector("#ds-update");
const bannerText = (r: any) => (banner(r)?.textContent ?? "").replace(/\s+/g, " ").trim();
test("update banner: running, done with warnings, and failed with its log path", async () => {
  const run = (o: any) => ({ id: 1, state: "pulling", why: null, line: null, error: null, warnings: [], squads_line: null, log: null, age_min: 2, ...o });
  const a = await mountPage(upBoard({ run: run({}) }), false);
  try { expect(bannerText(a)).toContain("Dev-studio update running — pulling… (2 min)"); expect(banner(a).textContent).not.toContain("waiting for the Studio"); } finally { await a.window.happyDOM.close(); }
  const b = await mountPage(upBoard({ run: run({ state: "done", line: "advanced a -> b", squads_line: "update-squads: [fixture] reload — instructions — 7 wishes", warnings: ["update: WARNING disk low"] }) }), false);
  try { expect(bannerText(b)).toContain("advanced a -> b — 7 workers on older code reload"); expect(bannerText(b)).toContain("update: WARNING disk low"); } finally { await b.window.happyDOM.close(); }
  const d = await mountPage(upBoard({ run: run({ state: "done", line: "already current (fe92a557…)", squads_line: "update-squads: [fixture] restart — code, instructions, skills — 25 wish(es) (one a reload of the Studio)" }) }), false);
  try { expect(bannerText(d)).toContain("already current (fe92a55) — 25 workers on older code restart once idle; the Studio reloads"); } finally { await d.window.happyDOM.close(); }
  const e = await mountPage(upBoard({ run: run({ state: "done", line: "already current (fe92a557…)" }) }), false);
  try { expect(bannerText(e)).toContain("already current (fe92a55)"); expect(bannerText(e)).not.toContain("workers"); } finally { await e.window.happyDOM.close(); }
  const c = await mountPage(upBoard({ run: run({ state: "failed", line: "DS-UPDATE: refused: dirty", log: "/x/state/loop/update/3.log" }) }), false);
  try { expect(bannerText(c)).toContain("Dev-studio update failed: DS-UPDATE: refused: dirty"); expect(bannerText(c)).toContain("/x/state/loop/update/3.log"); expect(banner(c).className).toContain("err"); } finally { await c.window.happyDOM.close(); }
});
test("update banner: Show commits opens a dialog with each commit and Esc closes it; the banner itself stays short", async () => {
  const commits = [{ sha: "a1", title: "feat: first thing", classes: ["code"] }, { sha: "b2", title: "fix: second thing", classes: ["skills"] }];
  const r = await mountPage(upBoard({ behind: 3, commits, classes: ["code", "skills"], need: "restart" }), false);
  try {
    const before = bannerText(r);
    expect(before).not.toContain("feat: first thing");
    expect(r.root.querySelector('[role="dialog"]')).toBeNull();
    const btn = [...banner(r).querySelectorAll("button")].find((x: any) => x.textContent.trim() === "Show commits") as any;
    btn.click();
    await new Promise((x) => setTimeout(x, 20));
    const dlg = r.root.querySelector('[role="dialog"]') as any;
    expect(dlg).not.toBeNull();
    expect(dlg.textContent).toContain("feat: first thing");
    expect(dlg.textContent).toContain("fix: second thing");
    expect(dlg.textContent).toContain("and 1 more");
    expect(dlg.querySelectorAll(".utag").length).toBe(2);
    r.window.document.dispatchEvent(new r.window.KeyboardEvent("keydown", { key: "Escape" }));
    await new Promise((x) => setTimeout(x, 20));
    expect(r.root.querySelector('[role="dialog"]')).toBeNull();
  } finally { await r.window.happyDOM.close(); }
});
