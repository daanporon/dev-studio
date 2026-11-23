// modal-scroll-lock U1: while a .modal is open the board page behind it is frozen, and each popup scroller keeps its scroll.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const css = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(), body: m[2] }));
const find = (sel: string) => rules.filter((r) => r.sel.split(",").map((x) => x.trim()).includes(sel));

test("the page root is frozen while any .modal is in the page", () => {
  expect(find("html:has(.modal)").some((r) => /overflow:\s*hidden/.test(r.body))).toBe(true);
  expect(find("html:has(.modal)").some((r) => /overscroll-behavior:\s*none/.test(r.body))).toBe(true);
});

test("the scrollbar gutter is reserved so the layout does not shift", () => {
  expect(find("html").some((r) => /scrollbar-gutter:\s*stable/.test(r.body))).toBe(true);
});

for (const sel of [".modal", ".modal .mbox", ".modal .md", ".modal .qbody", ".modal .msg-list", ".modal .chat-log", ".modal .set-body", ".modal .set-box", ".modal textarea"]) {
  test(`${sel} keeps its scroll to itself`, () => {
    expect(find(sel).some((r) => /overscroll-behavior:\s*contain/.test(r.body))).toBe(true);
  });
}
