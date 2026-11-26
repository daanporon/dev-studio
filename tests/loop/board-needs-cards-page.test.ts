// Needs-you cards: a Studio notice shows its text and one Dismiss, a card whose answer acts shows only those
// answers, a squad question keeps its options and text box (web/board.html AskOverlay, rendered with stub hooks
// into a string; each handler is listed as [fn:n] so a button can be pressed).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const i = page.indexOf("function AskOverlay(");
const src = page.slice(i, page.indexOf("\n}\n", i) + 2);

const qi = page.indexOf("function QOptions(");
const qsrc = page.slice(qi, page.indexOf("\n}\n", qi) + 2);

const cardActions = new Function("docLabel", page.slice(page.indexOf("function cardActions("), page.indexOf("\n}\n", page.indexOf("function cardActions(")) + 2) + " return cardActions;")(() => "doc");

function render(n: any) {
  const fns: any[] = [], sent: any[] = [];
  // A self-closing component tag (`<${QOptions} n=${n} />`) renders by calling it with its attributes as props.
  const html = (s: TemplateStringsArray, ...v: any[]): string => {
    if (/^\s*<$/.test(s[0]) && typeof v[0] === "function" && /\/>\s*$/.test(s[s.length - 1])) {
      const props: any = {};
      for (let k = 1; k < v.length; k++) props[/(\w+)=$/.exec(s[k])![1]] = v[k];
      return v[0](props);
    }
    return plain(s, ...v);
  };
  const plain = (s: TemplateStringsArray, ...v: any[]): string => s.reduce((o, t, k) => {
    const x = k < v.length ? v[k] : "";
    const str = (y: any): string => Array.isArray(y) ? y.map(str).join("") : typeof y === "function" ? `[fn:${fns.push(y) - 1}]` : y === false || y == null ? "" : String(y);
    return o + t + str(x);
  }, "");
  const make = new Function("useState", "useEffect", "html", "nkey", "sentQ", "sendAnswer", "sqName", "fmtAge", "linkedQ", "docLabel", "copy", "QPr", "ActBtn", "ChatPanel", "useRef", "akey", "hhmmss", "mdPlain", "QMd",
    `${qsrc}\n${src} return AskOverlay;`);
  const Ask = make((init: any) => [init, () => {}], () => {}, html, (m: any) => `${m.label}/${m.id}`, new Map(),
    async (...a: any[]) => { sent.push(a); }, () => "sq", () => "1m", (t: string) => t, () => "doc", () => {}, null, null, null, (v: any) => ({ current: v }), (m: any) => `${m.label}/${m.id}`, () => "00:00:00", (t: string) => t, () => "");
  const out = Ask({ items: [n], at: `${n.label}/${n.id}`, setAt() {}, onClose() {}, onShow() {}, toast() {}, onPlan() {}, planOpen: false, cardActions, data: { squads: [] } });
  const press = (label: string) => {
    const m = new RegExp(`<button[^>]*\\[fn:(\\d+)\\][^>]*>[^<]*${label}[^<]*</button>`, "s").exec(out);
    expect(m).not.toBeNull(); fns[+m![1]]();
  };
  return { out, sent, press, opts: (out.match(/<span class="n">/g) ?? []).length, area: out.includes("<textarea") };
}
const card = (o: any) => ({ squad: "_studio", label: "p", kind: "studio", id: "a1", title: "T", titled: true, text: "T", choices: [], when: null, acts_on_answer: false, options: [], age_min: 1, ...o });

test("a notice with no option: text, one Dismiss, no text box, no option", () => {
  const r = render(card({}));
  expect(r.area).toBe(false); expect(r.opts).toBe(0); expect(r.out).not.toContain("When done");
  r.press("Dismiss"); expect(r.sent).toEqual([["p", "_studio", "a1", ""]]);
});

test("a lone option that does nothing is a muted 'When done' line", () => {
  const r = render(card({ when: "restart it" }));
  expect(r.area).toBe(false); expect(r.opts).toBe(0);
  expect(r.out).toContain("When done: restart it");
  r.press("Dismiss"); expect(r.sent[0][3]).toBe("");
});

test("a lone option that acts is the primary button beside Dismiss", () => {
  const r = render(card({ choices: [{ label: "move it", does: null }], acts_on_answer: true }));
  expect(r.area).toBe(false); expect(r.opts).toBe(0); expect(r.out).not.toContain("When done");
  r.press("move it"); r.press("Dismiss");
  expect(r.sent.map((s) => s[3])).toEqual(["move it", ""]);
});

test("two options keep their buttons and no text box; Dismiss sends nothing", () => {
  const r = render(card({ choices: [{ label: "Fixed", does: null }, { label: "Switch it off", does: null }] }));
  expect(r.area).toBe(false); expect(r.opts).toBe(2);
  r.press("Dismiss"); expect(r.sent[0][3]).toBe("");
});

test("a squad question keeps its options and text box", () => {
  const q = { squad: "one", label: "p", kind: "question", id: "q1", title: "Q", titled: true, text: "Q", options: ["a", "b"], choices: [{ label: "a", does: null }, { label: "b", does: null }], age_min: 1 };
  const r = render(q);
  expect(r.area).toBe(true); expect(r.opts).toBe(2); expect(r.out).toContain("Send");
  const free = render({ ...q, id: "q2", options: [], choices: [] });
  expect(free.area).toBe(true); expect(free.opts).toBe(0);
});
