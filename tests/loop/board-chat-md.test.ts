// chat-polish U1: tables and safe links in the board's markdown renderer (mdToHtml in web/board.html), the one the
// chat panel's member replies and the plan view use. (a) mdToHtml cut from the page: exact HTML for each case, then
// every output parsed in happy-dom for safety (no script/img element, no on… attribute, every href http(s)). Escaped
// attack text such as `onerror=alert(1)` is correct output, so the safety check reads the DOM, never the string.
// (b) The real page: a member reply with a table and links in the chat panel, and a plan with a table in the plan view.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { mount } from "./board-mount";

const root = join(import.meta.dir, "../..");
const page = readFileSync(join(root, "web/board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
const mdToHtml: (src: string, soft?: boolean) => string = new Function(`${cut("esc")} ${cut("urlTail")} ${cut("mdToHtml")} return mdToHtml;`)();

const A = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
const p = (s: string) => `<p>${s}</p>`;

// Parse in a DOM and list what would be unsafe: script/img/iframe/… elements, on… attributes, a non-http(s) href.
const win = new Window();
function unsafe(out: string): string[] {
  const div = win.document.createElement("div");
  div.innerHTML = out;
  const bad: string[] = [];
  for (const el of [...div.querySelectorAll("*")] as any[]) {
    const tag = el.tagName.toLowerCase();
    if (["script", "img", "iframe", "object", "embed", "svg", "style", "link", "meta", "form", "input"].includes(tag)) bad.push("element " + tag);
    for (const at of [...el.attributes]) {
      if (/^on/i.test(at.name)) bad.push(`${tag} attribute ${at.name}`);
      if (at.name === "href" && !/^https?:\/\//i.test(at.value)) bad.push(`href ${at.value}`);
      if (at.name === "src" || at.name === "srcdoc" || at.name === "formaction") bad.push(`${tag} attribute ${at.name}`);
    }
    if (tag === "a" && (el.getAttribute("target") !== "_blank" || el.getAttribute("rel") !== "noopener noreferrer")) bad.push("anchor without target/rel");
  }
  return bad;
}

const cases: [string, string, string, boolean?][] = [
  ["a table with alignment, a \\| cell, a ragged short row and a long one",
    "| a | b | c | d |\n|:---|:---:|---:|---|\n| 1 | x \\| y | `z` | **w** |\n| only |\n| 1 | 2 | 3 | 4 | 5 |",
    '<div class="md-table"><table><thead><tr><th style="text-align:left">a</th><th style="text-align:center">b</th><th style="text-align:right">c</th><th>d</th></tr></thead>'
    + '<tbody><tr><td style="text-align:left">1</td><td style="text-align:center">x | y</td><td style="text-align:right"><code>z</code></td><td><strong>w</strong></td></tr>'
    + '<tr><td style="text-align:left">only</td><td style="text-align:center"></td><td style="text-align:right"></td><td></td></tr>'
    + '<tr><td style="text-align:left">1</td><td style="text-align:center">2</td><td style="text-align:right">3</td><td>4</td></tr></tbody></table></div>'],
  ["a table without outer pipes ends at a blank line, a link in a cell",
    "a | b\n--- | ---\n[d](https://example.test/d) | 2\n\nafter",
    `<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>${A("https://example.test/d", "d")}</td><td>2</td></tr></tbody></table></div>\n<p>after</p>`],
  ["a table with only a header", "| h |\n| --- |", '<div class="md-table"><table><thead><tr><th>h</th></tr></thead></table></div>'],
  ["a table ends at a line with no pipe; a paragraph before it closes", "intro\n| h | i |\n|---|---|\n| 1 | 2 |\nnext line",
    '<p>intro</p>\n<div class="md-table"><table><thead><tr><th>h</th><th>i</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>\n<p>next line</p>'],
  ["a pipe line with no separator stays a paragraph", "a | b\n| c | d |", p("a | b | c | d |")],
  ["a separator of two dashes is no separator", "| a | b |\n|--|--|", p("| a | b | |--|--|")],
  ["a table inside a fence stays code", "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```", "<pre><code>| a | b |\n|---|---|\n| 1 | 2 |</code></pre>"],
  ["a bare URL with a trailing . and an unmatched )", "see https://example.test/a. and (https://example.test/b) ok",
    p(`see ${A("https://example.test/a", "https://example.test/a")}. and (${A("https://example.test/b", "https://example.test/b")}) ok`)],
  ["a bare URL keeps its matched parens and drops trailing ,;:!?", "https://example.test/w_(x), https://example.test/q?!",
    p(`${A("https://example.test/w_(x)", "https://example.test/w_(x)")}, ${A("https://example.test/q", "https://example.test/q")}?!`)],
  ["a bare URL ending in & leaves the escaped & outside, whole", "see https://x.test/?a=1& now",
    p(`see ${A("https://x.test/?a=1", "https://x.test/?a=1")}&amp; now`)],
  ["a bare URL with & in it", "https://example.test/a?b=1&c=2", p(A("https://example.test/a?b=1&amp;c=2", "https://example.test/a?b=1&amp;c=2"))],
  ["an <url> autolink drops its brackets", "<https://example.test>", p(A("https://example.test", "https://example.test"))],
  ["the scheme is matched case-insensitively", "HTTPS://example.test/U and [up](HTTP://example.test/v)",
    p(`${A("HTTPS://example.test/U", "HTTPS://example.test/U")} and ${A("HTTP://example.test/v", "up")}`)],
  ["a URL in backticks stays code", "run `https://example.test/c` now", p("run <code>https://example.test/c</code> now")],
  ["a markdown link with & in its URL is linked once", "[docs](https://example.test/d?a=1&b=2)", p(A("https://example.test/d?a=1&amp;b=2", "docs"))],
  ["a markdown link whose text is a URL is linked once", "[https://example.test/t](https://example.test/u)", p(A("https://example.test/u", "https://example.test/t"))],
  ["a link inside bold", "**https://example.test/a**", p(`<strong>${A("https://example.test/a", "https://example.test/a")}</strong>`)],
  ["bold inside a link's text", "[**b**](https://example.test/b)", p(A("https://example.test/b", "<strong>b</strong>"))],
  ["a link around a code span", "[`cmd`](https://example.test)", p(A("https://example.test", "<code>cmd</code>"))],
  ["a bare URL right before a markdown link never lands in its href",
    "https://a.test[x](https://b.test/q/onmouseover=alert(1)//)",
    p(`${A("https://a.test", "https://a.test")}${A("https://b.test/q/onmouseover=alert(1", "x")}//)`)],
  ["a source holding the placeholder character cannot forge one", "`c` x\u00000\u0000y https://a.test \u00001\u0000",
    p(`<code>c</code> x0y ${A("https://a.test", "https://a.test")} 1`)],
  ["a $ pattern in a URL is kept as text", "https://example.test/$&$1", p(A("https://example.test/$&amp;$1", "https://example.test/$&amp;$1"))],
  ["unsafe schemes stay text",
    "[x](javascript:alert(1)) [y](data:text/html,hi) [v](vbscript:x) [f](file:///etc/passwd) [z](//evil.test) javascript://x",
    p("[x](javascript:alert(1)) [y](data:text/html,hi) [v](vbscript:x) [f](file:///etc/passwd) [z](//evil.test) javascript://x")],
  ["markup stays text", '<script>alert(1)</script> <img src=x onerror=alert(1)>',
    p("&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;")],
  ["a quote and on…= inside a URL end the URL", 'https://example.test/"onmouseover="alert(1) https://example.test/<b>',
    p(`${A("https://example.test/", "https://example.test/")}&quot;onmouseover=&quot;alert(1) ${A("https://example.test/", "https://example.test/")}&lt;b&gt;`)],
  ["markup and on…= in a table cell stay text", '| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | x" onclick="alert(1) |',
    '<div class="md-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>&lt;img src=x onerror=alert(1)&gt;</td><td>x&quot; onclick=&quot;alert(1)</td></tr></tbody></table></div>'],
  ["soft mode (the plan view): a table and a bare URL", "U1 — x\n  see https://example.test/p\n\n| h | i |\n| --- | :---: |\n| 1 | 2 |",
    `<p>U1 — x<br>&nbsp;&nbsp;see ${A("https://example.test/p", "https://example.test/p")}</p>\n`
    + '<div class="md-table"><table><thead><tr><th>h</th><th style="text-align:center">i</th></tr></thead><tbody><tr><td>1</td><td style="text-align:center">2</td></tr></tbody></table></div>', true],
];

for (const [name, src, want, soft] of cases) {
  test("mdToHtml: " + name, () => {
    const out = mdToHtml(src, soft);
    expect(out).toBe(want);
    expect(unsafe(out)).toEqual([]);
  });
}

test("mdToHtml: no XSS string turns into markup", () => {
  const attacks = [
    "[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](data:text/html;base64,PHNjcmlwdD4=)", "[x](//evil.test)",
    "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<a href=javascript:alert(1)>x</a>",
    'https://e.test/" onmouseover="alert(1)', "https://e.test/'onmouseover='alert(1)'", "[a](https://e.test/\" onclick=\"x)",
    "[`x\" onclick=\"y`](https://e.test)", "**[x](https://e.test/a**b)**", "https://e.test/`x` [y](https://f.test)",
    "| <script>x</script> | b |\n|---|---|\n| [x](javascript:y) | https://e.test/\"onfocus=\"z |",
    "| a |\n| :---: |\n| b |\n|---|", "\u0000" + "0\u0000 https://e.test \u00000\u0000",
  ];
  for (const s of attacks) for (const soft of [false, true]) expect([s, unsafe(mdToHtml(s, soft))]).toEqual([s, []]);
});

// ---- (b) the real page
const now = Math.floor(Date.now() / 1000);
const reply = [
  "Here is the summary:",
  "",
  "| Unit | State | PR |",
  "|:-----|:-----:|---:|",
  "| u1 | **done** | [#12](https://example.test/pull/12) |",
  "| u2 \\| u3 | waiting |",
  "",
  "Docs at https://example.test/a?b=1&c=2, see <https://example.test> and [docs](https://example.test/d).",
  "Not links: [x](javascript:alert(1)) [y](data:text/html,hi) [z](//evil.test) <img src=x onerror=alert(1)>",
].join("\n");
const boardJson = {
  ...JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8")),
  project: "fixture", page_version: "v1",
  squads: [{
    label: "fixture", topic: "sq", status: "running", display_status: "running", topic_plan: null,
    plans: [{ name: "sq-plan.md", mtime: now - 3600, markdown: "# plan\n\n| Unit | Tier |\n|---|---|\n| U1 | hard |\n\nSee https://example.test/plan." }],
    members: [{ role: "builder", label: "builder-u1", wt: "wt-b", state: "working" }],
    units: [{ slug: "u1-md", state: "working", title: "Markdown unit", about: null, done_text: null, check_text: null, plan: "/p/sq-plan.md", plan_unit: "U1",
      deps: [], dependents: [], ext_deps: [], builder_wt: "wt-b", builder: null, tier: "hard", pr: null, held: false }],
  }],
};
boardJson.flow = { ...boardJson.flow, cards: [{ key: "fixture/sq/u1-md", project: "fixture", squad: "sq", slug: "u1-md", stage: "building", pr: null, needs_you: false, ask: null, stuck: false, slow: false, group: null, in_stage_s: 60 }] };
const chat = { agent: "claude", source: "transcript", working: false, sends: [], turns: [{ role: "user", from: "operator", text: "status?", at: now - 60 }, { role: "assistant", text: reply, at: now - 30 }] };

test("the real page: a member reply's table and links in the chat panel, a plan's table in the plan view", async () => {
  const r = await mount(boardJson, false, { "api/chat": chat });
  const w = r.window, doc = w.document;
  const wait = () => new Promise((x) => setTimeout(x, 30));
  // Under a loaded host the page renders late: wait for each element (up to 10 s) instead of a fixed settle.
  const until = async <T>(get: () => T, what: string): Promise<T> => {
    for (let k = 0; k < 330; k++) { const v = get(); if (v) return v; await wait(); }
    throw new Error("timed out waiting for " + what);
  };
  const click = async (el: any) => { el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(); };
  try {
    (await until(() => doc.getElementById("flow"), "#flow")).open = true;
    await click(await until(() => [...doc.querySelectorAll(".fcard")].find((c: any) => c.querySelector(".t")?.textContent.trim() === "u1-md"), "the u1-md flow card"));
    await click(await until(() => doc.querySelector(".ud-chat"), ".ud-chat"));
    await until(() => doc.querySelector(".chat-turn.agent .md-table"), "the reply's table");
    expect(r.urls).toContain("api/chat?project=fixture&topic=sq&wt=wt-b");
    const turn = doc.querySelector(".chat-turn.agent") as any;
    expect(turn).toBeTruthy();
    expect(turn.querySelector(".md-table > table")).toBeTruthy();
    expect([...turn.querySelectorAll("table th")].map((e: any) => e.textContent)).toEqual(["Unit", "State", "PR"]);
    expect([...turn.querySelectorAll("table th")].map((e: any) => e.getAttribute("style"))).toEqual(["text-align:left", "text-align:center", "text-align:right"]);
    expect([...turn.querySelectorAll("table tbody tr")].map((tr: any) => [...tr.querySelectorAll("td")].map((e: any) => e.textContent))).toEqual([["u1", "done", "#12"], ["u2 | u3", "waiting", ""]]);
    expect(turn.querySelector("td strong")?.textContent).toBe("done");
    const links = [...turn.querySelectorAll("a")].map((a: any) => [a.textContent, a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]);
    const L = (t: string, h: string) => [t, h, "_blank", "noopener noreferrer"];
    expect(links).toEqual([
      L("#12", "https://example.test/pull/12"),
      L("https://example.test/a?b=1&c=2", "https://example.test/a?b=1&c=2"),
      L("https://example.test", "https://example.test"),
      L("docs", "https://example.test/d"),
    ]);
    expect(turn.textContent).toContain("Not links: [x](javascript:alert(1)) [y](data:text/html,hi) [z](//evil.test) <img src=x onerror=alert(1)>");
    expect(turn.querySelector("img, script")).toBeNull();
    // the operator's line stays plain text
    expect(doc.querySelector(".chat-turn.op .bubble")?.textContent).toBe("status?");
    // the CSS keeps a wide table inside the bubble
    expect(page).toMatch(/\.md-table\{overflow-x:auto;max-width:100%/);
    // the plan view (mdToHtml soft) shows the plan's table and links its URL
    doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => !doc.querySelector(".chat-turn.agent"), "the chat panel to close");
    await click(await until(() => doc.querySelector(".ud-planlink"), ".ud-planlink"));
    const plan = (await until(() => doc.querySelector(".mbox .md-table"), "the plan's table")).closest(".md") as any;
    expect([...plan.querySelectorAll(".md-table th")].map((e: any) => e.textContent)).toEqual(["Unit", "Tier"]);
    expect([...plan.querySelectorAll(".md-table td")].map((e: any) => e.textContent)).toEqual(["U1", "hard"]);
    expect([...plan.querySelectorAll("a")].map((a: any) => a.getAttribute("href"))).toEqual(["https://example.test/plan"]);
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); await win.happyDOM.close(); }
}, 30000);
