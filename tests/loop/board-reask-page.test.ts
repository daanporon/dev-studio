// board-reask-page.test.ts — reasked-question-shows-answered U1: the page tells two askings of one question id
// apart by `since` (web/board.html: askingKey, akey, pruneSent, sentQ, AskOverlay). The page's own functions are cut
// out and run with a small hook runtime that keeps state and refs between renders, so one overlay can be rendered
// again with new Needs-you data the way a refresh does.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(join(import.meta.dir, "../../web/board.html"), "utf8");
const cut = (start: string, end: string) => { const i = page.indexOf(start); return page.slice(i, page.indexOf(end, i) + end.length); };
const sentSrc = cut("const sentQ = new Map();", "sentQ.delete(k);\n};");
const ak = page.indexOf("const akey = (n) =>");
const keysSrc = page.slice(page.indexOf("const nkey = (n) =>"), page.indexOf("\n", ak));
const overlay = cut("function AskOverlay(", "\n}\n");

function rig() {
  const slots: any[] = []; let at = 0; const fns: any[] = [];
  const useState = (init: any) => { const i = at++; if (!(i in slots)) slots[i] = init; return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; };
  const useRef = (init: any) => { const i = at++; if (!(i in slots)) slots[i] = { current: init }; return slots[i]; };
  const html = (s: TemplateStringsArray, ...v: any[]): string => s.reduce((o, t, k) => {
    const str = (y: any): string => Array.isArray(y) ? y.map(str).join("") : typeof y === "function" ? `[fn:${fns.push(y) - 1}]` : y === false || y == null ? "" : String(y);
    return o + t + (k < v.length ? str(v[k]) : "");
  }, "");
  const make = new Function("useState", "useRef", "useEffect", "html", "sendAnswer", "sqName", "fmtAge", "linkedQ", "docLabel", "copy", "QPr", "ActBtn", "ChatPanel", "hhmmss", "post",
    `${sentSrc}\n${keysSrc}\nconst sendAnswer2 = async (label, topic, id, answer, since) => { sentQ.set(askingKey(label + "/" + topic + "/" + id, since), "10:00"); };\n${overlay.replace("sendAnswer(", "sendAnswer2(")}\nreturn { AskOverlay, sentQ, pruneSent, akey };`);
  const api = make(useState, useRef, () => {}, html, null, () => "sq", () => "1m", (t: string) => t, () => "doc", () => {}, null, null, null, (d: Date) => d.toISOString().slice(11, 19), null);
  const q = (id: string, since: string | null, label = "p", squad = "one") => ({ squad, label, kind: "question", id, since, title: id, titled: true, text: id, options: [], choices: [], age_min: 1 });
  const render = (items: any[], atKey: string) => { at = 0; fns.length = 0;
    const out = api.AskOverlay({ items, at: atKey, setAt() {}, onClose() {}, onShow() {}, toast() {}, onPlan() {}, planOpen: false }) as string;
    const press = (re: RegExp) => { const m = re.exec(out); expect(m).not.toBeNull(); return fns[+m![1]]; };
    const type = (t: string) => press(/<textarea[^>]*onInput=\[fn:(\d+)\]/s)({ target: { value: t } });
    const send = async () => { await press(/<button class="btn pri"[^>]*\[fn:(\d+)\][^>]*>/s)(); };
    return { out, type, send, sent: out.includes("✓ sent"), sendOff: /<button class="btn pri" disabled=true/.test(out), tabs: [...out.matchAll(/<button[^>]*class=tab[^>]*>([^<]*)</g)].map((m) => m[1]) };
  };
  return { api, q, render };
}
const A1 = "2026-11-23T10:00:00Z", A2 = "2026-11-23T11:07:00Z", A3 = "2026-11-23T12:30:00Z";

test("an asking answered from the board does not mark the same id asked again", async () => {
  const { api, q, render } = rig();
  let r = render([q("plan-x", A1)], "p/one/plan-x"); r.type("go"); r = render([q("plan-x", A1)], "p/one/plan-x");
  await r.send(); r = render([q("plan-x", A1)], "p/one/plan-x");
  expect(r.sent).toBe(true); expect(r.out).toContain("✓ sent 10:00"); expect(r.tabs[0]).toContain("✓");
  // the loop closed that row and the agent asked again: the new asking is the only item
  api.pruneSent({ needs_you: [q("plan-x", A2)] });
  r = render([q("plan-x", A2)], "p/one/plan-x");
  expect(r.sent).toBe(false); expect(r.out).not.toContain("✓ sent"); expect(r.tabs[0]).toContain("□");
  r.type("again"); r = render([q("plan-x", A2)], "p/one/plan-x");
  expect(r.sendOff).toBe(false);
});

test("a question asked again while its overlay is open keeps the overlay, drops the draft and says so", () => {
  const { q, render } = rig();
  let r = render([q("plan-x", A2)], "p/one/plan-x"); r.type("my draft"); r = render([q("plan-x", A2)], "p/one/plan-x");
  expect(r.out).toContain("my draft"); expect(r.out).not.toContain("asked again");
  r = render([q("plan-x", A3)], "p/one/plan-x");
  expect(r.out).not.toContain("my draft"); expect(r.out).toContain("asked again 12:30 — read it before sending");
});

test("asking question A again leaves the overlay open on question B with its draft", () => {
  const { q, render } = rig();
  const items = (aSince: string) => [q("a", aSince), q("b", A1)];
  let r = render(items(A1), "p/one/b"); r.type("b draft"); r = render(items(A1), "p/one/b");
  r = render(items(A3), "p/one/b");
  expect(r.out).toContain("b draft"); expect(r.out).not.toContain("asked again");
});

test("an answer that left the board and came back as the same asking shows open", async () => {
  const { api, q, render } = rig();
  let r = render([q("plan-x", A1)], "p/one/plan-x"); r.type("go"); r = render([q("plan-x", A1)], "p/one/plan-x"); await r.send();
  expect(api.sentQ.size).toBe(1);
  api.pruneSent({ needs_you: [] });
  expect(api.sentQ.size).toBe(0);
  r = render([q("plan-x", A1)], "p/one/plan-x");
  expect(r.sent).toBe(false); expect(r.tabs[0]).toContain("□");
});

test("pruneSent keeps a Studio note's mark while the note is listed", () => {
  const { api } = rig();
  api.sentQ.set("p/_studio/n1", "10:00"); api.sentQ.set("p/_studio/gone", "10:00");
  api.pruneSent({ needs_you: [], loop_notes: [{ project: "p", id: "n1" }] });
  expect([...api.sentQ.keys()]).toEqual(["p/_studio/n1"]);
});
