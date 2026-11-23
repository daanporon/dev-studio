// board-card-actions.test.ts — debrief-modal-actions U1: a Needs-you card and the window it opens take their
// actions from one list (web/board.html cardActions / windowActions); acting from the window closes it and hides
// the card at once. Real page in happy-dom (board-mount).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const root = join(import.meta.dir, "../..");
const page = readFileSync(join(root, "web/board.html"), "utf8");
const board = { ...JSON.parse(readFileSync(join(root, "tests/fixtures/board-empty.json"), "utf8")), project: "fixture", page_version: "v1" };
const fn = (name: string) => { const i = page.indexOf(`function ${name}(`); return page.slice(i, page.indexOf("\n}\n", i) + 2); };
const lists = new Function("docLabel", `${fn("cardActions")}\nconst windowActions = (n, data) => cardActions(n, data).filter((a) => !a.opens && a.card !== false);\nreturn { cardActions, windowActions };`)((n: any) => "Plan") as any;

const item = (over: any) => ({ squad: "one", label: "fixture", kind: "question", card_squad: null, id: "q1", title: "T", titled: true, text: "T", choices: [], options: [], act: null, age_min: 3, about: null, from: "lead", ...over });
const debrief = item({ squad: "_studio", kind: "studio", id: "sweep-debrief-newy-1", debrief: "newy", options: ["Mark read"], title: "Debrief: newy" });
const done = item({ squad: "dn", kind: "done", id: null, card_squad: "dn", act: { action: "close", label: "Close squad", topic: "dn" } });
const studioCard = item({ squad: "_studio", kind: "studio", id: "a1", card_squad: "one", act: { action: "restart", label: "Restart", topic: "one" } });
const quest = item({ doc: { name: "plan", markdown: "# plan" }, act: null });
const brief = item({ squad: "_studio", kind: "studio", id: "brief-1" });
const data = { squads: [{ label: "fixture", topic: "dn", debrief: "DONE-DEBRIEF" }] };

test("parity: for each card kind the window's labels are the card's labels less the ones that open a window", () => {
  for (const n of [debrief, done, studioCard, quest, brief]) {
    const card = lists.cardActions(n, data).filter((a: any) => a.card !== false);
    expect(lists.windowActions(n, data).map((a: any) => a.label)).toEqual(card.filter((a: any) => !a.opens).map((a: any) => a.label));
  }
  expect(lists.windowActions(debrief, data).map((a: any) => a.label)).toEqual(["Mark read"]);
  expect(lists.windowActions(done, data).map((a: any) => a.label)).toEqual(["Close squad"]);
  expect(lists.windowActions(quest, data).map((a: any) => a.label)).toEqual(["Answer"]);
  expect(lists.cardActions(done, { squads: [] }).map((a: any) => a.key)).toEqual(["show", "act"]); // no debrief: nothing to open
});

const rig = async (b: any) => {
  const r = await mount(b, false);
  const w = r.window, doc = w.document, posts: any[] = [];
  w.fetch = async (url: string, init?: any) => {
    if (init && init.body && /^api\/(answer|request)$/.test(String(url))) posts.push({ url: String(url), ...JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ id: 7 }), text: async () => "{}" };
  };
  w.confirm = () => true;
  const wait = (ms = 60) => new Promise((x) => setTimeout(x, ms));
  const click = (el: any) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  for (let k = 0; k < 80 && doc.querySelectorAll(".qnote").length === 0; k++) await wait(25);
  return { r, w, doc, posts, wait, click };
};

test("Mark read in a debrief window: one answer, the window and the card are gone with no new board data", async () => {
  const { r, w, doc, posts, wait, click } = await rig({ ...board, needs_you: [debrief], loop_notes: [], archived: [{ topic: "newy", label: "fixture", closed_at: "2026-11-20T10:00:00Z", type: "feature", framing: "f", progress: { total: 1, done: 1 }, prs: [], plans: [], lavish: [], debrief: "NEWY-BODY" }] });
  try {
    click(doc.querySelector('.qnote [data-ev="open-debrief"]')); await wait();
    expect(doc.body.textContent).toContain("NEWY-BODY");
    const foot = doc.querySelector('.modal .qfoot[data-ev="plan-foot"]');
    expect([...foot.querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Mark read"]);
    click(foot.querySelector("button")); await wait(100);
    expect(posts).toEqual([expect.objectContaining({ url: "api/answer", topic: "_studio", id: debrief.id, answer: "Mark read" })]);
    expect(doc.querySelector(".modal")).toBeNull();
    expect(doc.querySelectorAll(".qnote").length).toBe(0);
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); }
});

test("a done row with a debrief opens it; Close squad (confirmed) files one close request, closes the window and hides the row", async () => {
  const { r, w, doc, posts, wait, click } = await rig({ ...board, needs_you: [done], loop_notes: [], squads: [{ label: "fixture", topic: "dn", status: "done", display_status: "done", display_key: "done", members: [], units: [], plans: [], prs: [], lavish: [], type: "feature", autonomy: "checkpoint", ship_mode: "ce-pipeline", debrief: "DONE-DEBRIEF" }] });
  try {
    const row = doc.querySelector(".qnote"); click(row); await wait();
    expect(doc.body.textContent).toContain("DONE-DEBRIEF");
    const foot = doc.querySelector('.modal .qfoot[data-ev="plan-foot"]');
    expect([...foot.querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Close squad"]);
    click(foot.querySelector("button")); await wait(100);
    expect(posts).toEqual([expect.objectContaining({ url: "api/request", action: "close", topic: "dn" })]);
    expect(doc.querySelector(".modal")).toBeNull();
    expect(doc.querySelectorAll(".qnote").length).toBe(0);
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); }
});

test("a question card's doc window has Answer, which opens the question's card", async () => {
  const { r, w, doc, wait, click } = await rig({ ...board, needs_you: [quest], loop_notes: [] });
  try {
    click(doc.querySelector('.qnote [data-ev="open-doc"]')); await wait();
    const foot = doc.querySelector('.modal .qfoot[data-ev="plan-foot"]');
    expect([...foot.querySelectorAll("button")].map((b: any) => b.textContent)).toEqual(["Answer"]);
    click(foot.querySelector("button")); await wait(100);
    expect(doc.querySelectorAll(".modal").length).toBe(1);
    expect(doc.querySelector(".modal .qbody")).not.toBeNull();
    expect(r.errors).toEqual([]);
  } finally { await w.happyDOM.close(); }
});
