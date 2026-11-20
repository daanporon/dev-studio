// board-briefs-page.test.ts — the morning brief's own renderer, cut out of web/board.html (as board-skills-page.test.ts does).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const cut = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
const briefHtml: (md: string, prs?: Record<string, string>) => string = new Function(`${cut("briefHtml")} return briefHtml;`)();

const MD = "Merged **3** PRs since yesterday, #409 first.\n\n## Needs you\n- Approve #23408\n\n## Progress\nfeature-a  40% → 70%\nfeature-b  stalled\n- one bullet\nplain after list\n\n## Waiting\nNothing.\n";

test("the opening text is the lead; each ## is a label; bold renders", () => {
  const h = briefHtml(MD);
  expect(h.startsWith('<div class="blead">')).toBe(true);
  expect(h).toContain("<b>3</b>");
  expect(h.match(/class="blabel"/g)?.length).toBe(3);
  expect(h).toContain('<div class="blabel">Needs you</div>');
});
test("Needs you gets the amber class only with a bullet; Nothing. is muted", () => {
  const h = briefHtml(MD);
  expect(h).toContain('class="bsec needs"');
  expect(briefHtml("## Needs you\nNothing.\n")).not.toContain("needs");
  expect(briefHtml("## Needs you\nNothing.\n")).toContain('class="bline bmut"');
});
test("bullets are bullets, plain lines are their own lines, a plain line closes a list", () => {
  const h = briefHtml(MD);
  expect(h).toContain("<ul><li>one bullet</li></ul><div class=\"bline\">plain after list</div>");
  expect(h).toContain('<div class="bline">feature-a  <span');
  expect(h).toContain('<div class="bline">feature-b  stalled</div>');
});
test("a NN% → NN% pair renders as mono numbers with a muted arrow", () => {
  expect(briefHtml(MD)).toContain('<span class="bpct">40%</span> <span class="barrow">→</span> <span class="bpct">70%</span>');
});
test("#<n> links only when the map has it, in a new tab; text is escaped", () => {
  const h = briefHtml(MD, { "409": "https://github.com/acme-org/dev-studio/pull/409" });
  expect(h).toContain('<a href="https://github.com/acme-org/dev-studio/pull/409" target="_blank" rel="noopener">#409</a>');
  expect(h).toContain("Approve #23408");
  expect(h).not.toContain('>#23408</a>');
  expect(briefHtml("<script>x</script> #1", { "1": "javascript:alert(1)" })).not.toContain("<a ");
  expect(briefHtml("<script>x</script>")).toContain("&lt;script&gt;");
});
test("an indented bullet nests inside the bullet above; #n links and the % pair work in it", () => {
  const h = briefHtml("## What happened\n- **sq** 91% → 93%\n  - fixed a thing (#7)\n  - added more\n- Quiet: x\n", { "7": "https://github.com/o/r/pull/7" });
  expect(h).toContain("<li><b>sq</b> ");
  expect(h).toContain("<ul><li>fixed a thing (");
  expect(h).toContain('>#7</a>)</li><li>added more</li></ul></li><li>Quiet: x</li>');
  expect(h).toContain('<span class="bpct">91%</span>');
});
test("a plain run-on line with 3+ parts becomes a lead and a list; 2 parts stays one line", () => {
  const h = briefHtml("## Done\nsq-a: did X (#1); did Y; did Z.\n");
  expect(h).toContain('<div class="bline">sq-a:<ul><li>did X (#1)</li><li>did Y</li><li>did Z</li></ul></div>');
  expect(briefHtml("## Done\nsq-a: did X; did Y.\n")).toContain('<div class="bline">sq-a: did X; did Y.</div>');
});
test("the panel is not capped at 72ch", () => {
  expect(page).not.toContain("max-width:72ch");
});
test("an old run-on brief still renders line by line; no brief says so", () => {
  const h = briefHtml("# Brief 2026-11-12\n\n## Progress\nsq-a: did X. sq-b: did Y.\nsq-c: did Z.\n");
  expect(h.match(/class="bline"/g)?.length).toBe(2);
  expect(page).toContain("No brief yet.");
  expect(page).toContain("<${BriefPanel}");
});
