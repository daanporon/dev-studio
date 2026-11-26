// question-card-structure U1: a question's markdown in both views (web/board.html AskOverlay and the chat's
// Question view), the real page mounted in happy-dom: formatting, links, the recommendation, Open doc and Esc.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const root = join(import.meta.dir, "../..");
const page = readFileSync(join(root, "web/board.html"), "utf8");
const now = Math.floor(Date.now() / 1000);
const text = [
  "Start: brainstorm — the shape is open", "The next line stays on its own.", "",
  "- a **bold** point with `code`", "- see https://example.test/body. And #21196", "",
  "<script>window.pwned = 1</script>", "", "**Which one?**",
].join("\n");
const choices = [{ label: "Cards", does: "see https://example.test/does." }, { label: "Tables", does: "as #31000 did" }];
const q = { title: "Pick https://example.test/title", choices, suggestion: "Cards", why: "shown in https://example.test/why", repo_slug: "acme/app", since: "2026-11-25T10:00:00Z" };
const doc = { name: "sq-md-plan.md", markdown: "# The linked plan" };
const need = (id: string, over: any = {}) => ({ ...q, id, label: "fixture", squad: "sq", project: "fixture", kind: "blocking", from: "lead", titled: true, text, options: [], age_min: 1, plain: null, doc: null,
  chat_wt: "wt-l", chat_label: "the Lead", ...over });
const chatQ = (id: string, over: any = {}) => ({ ...q, id, question: text, blocking: true, source: "lead", answerable: true, doc: null, ...over });
const empty = JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8"));
const board = (needs: any[]) => ({ ...empty, project: "fixture", page_version: "v1", needs_you: needs, squads: [] });

async function open(needs: any[], questions: any[]) {
  const r = await mount(board(needs), false, { "api/chat": { agent: "claude", source: "transcript", working: false, sends: [], turns: [], crew: [], questions } });
  const w = r.window, d = w.document;
  const until = async <T>(get: () => T, what: string): Promise<T> => {
    for (let k = 0; k < 330; k++) { const v = get(); if (v) return v; await new Promise((x) => setTimeout(x, 30)); }
    throw new Error("timed out waiting for " + what);
  };
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await new Promise((x) => setTimeout(x, 30)); };
  const esc = async () => { d.body.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await new Promise((x) => setTimeout(x, 50)); };
  const row = await until(() => d.querySelector(".qnote") as any, "the Needs-you row");
  return { r, d, until, click, esc, row };
}
const hrefs = (el: any) => [...el.querySelectorAll("a")].map((a: any) => a.getAttribute("href"));
function drawn(box: any) {
  expect([...box.querySelectorAll("ul li")].length).toBe(2);
  expect([...box.querySelectorAll("strong")].map((e: any) => e.textContent)).toEqual(["bold", "Which one?"]);
  expect(box.querySelector("code")?.textContent).toBe("code");
  expect(box.querySelector("p br")).toBeTruthy();
  expect(box.querySelector('a[href="https://example.test/body"]')?.getAttribute("target")).toBe("_blank");
  expect(box.querySelector('a[href$="/pull/21196"]')?.getAttribute("href")).toBe("https://github.com/acme/app/pull/21196");
  expect(box.querySelector("script")).toBeNull();
  expect(box.textContent).toContain("<script>window.pwned = 1</script>");
}
function linkedParts(view: any) {
  expect(hrefs(view.querySelector("h3"))).toEqual(["https://example.test/title"]);
  const opts = [...view.querySelectorAll(".opts .opt")] as any[];
  expect(hrefs(opts[0])).toEqual(["https://example.test/does", "https://example.test/why"]);
  expect(hrefs(opts[1])).toEqual(["https://github.com/acme/app/pull/31000"]);
}

test("Needs-you and the chat's Question view draw the question's markdown, links and recommendation; Esc closes the doc first", async () => {
  const t = await open([need("q1", { doc })], [chatQ("q1", { doc })]);
  const { d, until, click, esc } = t;
  try {
    // the list row is one plain line
    const det = t.row.querySelector(".lndet");
    expect(det.textContent).not.toContain("**");
    expect(det.textContent).not.toContain("`");
    expect(det.textContent).not.toContain("- a bold");
    expect(det.textContent).toContain("a bold point with code");
    await click(t.row);
    const card = await until(() => d.querySelector(".qbody") as any, "the card");
    drawn(card.querySelector(".md.qtxt"));
    linkedParts(card);
    expect(card.querySelector(".opt .rec")?.textContent).toBe("recommended");
    expect(card.textContent).toContain("Why: shown in");

    await click(d.querySelector(".chat-btn"));
    const view = await until(() => d.querySelector("[data-chat-question]") as any, "the Question view");
    drawn(view.querySelector(".md.chat-qprompt"));
    linkedParts(view);
    expect(view.querySelector(".opt .rec")?.textContent).toBe("recommended");
    expect(view.textContent).toContain("Why: shown in");

    await click(view.querySelector('[data-ev="open-doc"]'));
    await until(() => d.body.textContent.includes("The linked plan"), "the doc modal");
    await esc();
    expect(d.body.textContent).not.toContain("The linked plan");
    expect(d.querySelector(".chat-modal")).toBeTruthy();
    await esc();
    expect(d.querySelector(".chat-modal")).toBeNull();
    expect(t.r.window.pwned).toBeUndefined();
    expect(t.r.errors).toEqual([]);
  } finally { await t.r.window.happyDOM.close(); }
}, 30000);

test("a picker question has no recommendation in the Question view, and no Open doc without a doc", async () => {
  const picker = { source: "picker", picker_answerable: true };
  const t = await open([need("q2", picker)], [chatQ("q2", picker)]);
  try {
    await t.click(t.row);
    await t.click(await t.until(() => t.d.querySelector(".chat-btn") as any, "the Chat button"));
    const view = await t.until(() => t.d.querySelector("[data-chat-question]") as any, "the Question view");
    expect(view.querySelectorAll(".opts .opt").length).toBe(2);
    expect(view.querySelector(".rec")).toBeNull();
    expect(view.textContent).not.toContain("Why:");
    expect(t.d.querySelector('[data-ev="open-doc"]')).toBeNull();
  } finally { await t.r.window.happyDOM.close(); }
}, 30000);

test("mdPlain strips the markers a one-line row would show; a #NN stays out of code and links", () => {
  const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
  const { mdPlain, mdToHtml } = new Function(`${cut("esc")} ${cut("urlTail")} ${cut("mdToHtml")} ${cut("mdPlain")} return { mdPlain, mdToHtml };`)();
  expect(mdPlain("# Head\n\n- **one** `two`\n[the doc](https://example.test/x) #12")).toBe("Head one two the doc #12");
  const out = mdToHtml("`#111` [see #222](https://example.test/a#333) https://example.test/b#444 PRD-555 #7 **#666**", true, "acme/app");
  expect(out.match(/pull\/\d+/g)).toEqual(["pull/666"]);
  expect(mdToHtml("#666")).toBe("<p>#666</p>");
});
