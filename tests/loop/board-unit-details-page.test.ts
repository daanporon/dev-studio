import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// htm turns `<word …>` in a template into an element, so a hint such as `<what it does>` written
// as literal text makes the page render an element named "what" (and the overlay fail). The page
// has no build step, so this reads the templates the way htm would and checks every element name.
const page = readFileSync(join(import.meta.dir, "..", "..", "web", "board.html"), "utf8");

const HTML_TAGS = new Set(("a abbr b br button caption code col colgroup dd details div dl dt em fieldset form h1 h2 h3 h4 h5 h6 header hr i img input kbd label legend li main nav ol optgroup option p path pre select small span strong summary sup sub svg g circle rect line polyline polygon text table tbody td textarea tfoot th thead tr u ul canvas section article aside footer figure figcaption dialog mark output progress template time tspan defs title").split(" "));

// every html`…` template: its literal text with each ${…} replaced by a marker, and its start line
function templates(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const skipExpr = (i: number): number => { // i is just after "${"; returns the index after the matching "}"
    let depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === "`") { i = readTemplate(i + 1).end - 1; }
      else if (c === '"' || c === "'") { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; } }
      i++;
    }
    return i;
  };
  const readTemplate = (i: number, record = false): { text: string; end: number } => { // i is just after the opening backtick
    let text = "";
    const start = i;
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") { text += src[i + 1] ?? ""; i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") { i = skipExpr(i + 2); text += "\u0000"; continue; }
      text += src[i++];
    }
    if (record) out.push({ text, line: src.slice(0, start).split("\n").length });
    return { text, end: i + 1 };
  };
  const re = /\bhtml`/g;
  let m: RegExpExecArray | null;
  let from = 0;
  while ((m = re.exec(src))) {
    if (m.index < from) continue; // nested inside a template already read
    const r = readTemplate(m.index + m[0].length, true);
    from = r.end;
    re.lastIndex = r.end;
  }
  return out;
}

// element names written literally in the template text (a component is `<${Name}`, so it reads `<\0`)
function badElements(text: string): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/<([A-Za-z][\w-]*)/g)) if (!HTML_TAGS.has(m[1]!.toLowerCase())) bad.push(m[1]!);
  return bad;
}

const hint = 'add-unit --about "<what it does>"';

test("the checker catches the placeholder the Details fallback used to hold", () => {
  const old = 'const lack = html`${none("x")} <span class="mut">for an ad-hoc unit pass <code>add-unit --about "<what it does>"</code></span>`;';
  const found = templates(old).flatMap((t) => badElements(t.text));
  expect(found).toEqual(["what"]);
});

test("the Details window holds no add-unit hint and no \"not stored\" placeholder", () => {
  const fn = page.slice(page.indexOf("function UnitDetails("), page.indexOf("// StartSquad"));
  expect(fn).not.toContain("add-unit");
  expect(fn).not.toContain("not stored");
});

test("no html template in web/board.html holds an angle-bracket placeholder htm would parse as an element", () => {
  const ts = templates(page);
  expect(ts.length).toBeGreaterThan(50);
  const found = ts.flatMap((t) => badElements(t.text).map((n) => `line ${t.line}: <${n}`));
  expect(found).toEqual([]);
});
