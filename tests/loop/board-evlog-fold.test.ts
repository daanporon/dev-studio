// event-log-filters U6: one row per message (evMsgFold) and back-to-back repeats folded ×N (evRepeats),
// after U281's action folding (evFolded); and the mounted log: a message row opens the Messages view, a ×3
// row opens in place.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mount } from "./board-mount";

const page = readFileSync(join(import.meta.dir, "..", "..", "web", "board.html"), "utf8");
const block = page.slice(page.indexOf("function evFolded("), page.indexOf("// Ids a person cannot read"));
const { evFolded, evMsgFold, evRepeats, evMsgLine, evRetries } = new Function(`${block} return { evFolded, evMsgFold, evRepeats, evMsgLine, evRetries };`)();
const sentenceBlock = page.slice(page.indexOf("function evSentence("), page.indexOf("// The rows the event log shows"));
const evSentence = new Function("hhmmss", "resetOutcome", `${sentenceBlock} return evSentence;`)((d: Date) => d.toTimeString().slice(0, 8), (x: any) => x);
const pipe = (evs: any[], messages: any) => evRetries(evRepeats(evMsgFold(evFolded(evs), messages)));

let id = 0;
const ev = (kind: string, at: number, extra: any = {}) => ({ id: ++id, kind, at, project: "p", squad: "sq", member: null, sev: null, payload: {}, ...extra });
const newest = (...rows: any[]) => rows.sort((a, b) => b.at - a.at || b.id - a.id);
const msg = (mid: number, o: any = {}) => ({ id: mid, project: "p", squad: "sq", from: "thinker", to: "lead", subject: "handoff " + mid, kind: "message",
  sent_at: 1000, delivered_at: 1010, read_at: 1020, replied_at: null, needs_reply: false, reply_due: false, to_wt: "wt-lead", ...o });
const sent = (mid: number, at: number) => ev("message_sent", at, { member: "wt-lead", payload: { key: "k" + mid }, msgs: [mid] });
const deliv = (ids: number[], at: number) => ev("message_delivered", at, { squad: null, member: "wt-lead", payload: { ids }, msgs: ids });
const read = (ids: number[], at: number) => ev("message_read", at, { member: "wt-lead", payload: { ids }, msgs: ids });
const t = (x: number) => new Date(x * 1000).toTimeString().slice(0, 5);

test("sent + delivered + read is one row, at the newest event, with the message's own times", () => {
  const rows = newest(sent(1, 1000), deliv([1], 1010), read([1], 1020));
  const out = evMsgFold(rows, { 1: msg(1) });
  expect(out).toHaveLength(1);
  expect(out[0].id).toBe(rows[0].id);
  expect(out[0].kind).toBe("message_read");
  expect(out[0].evs.map((e: any) => e.kind)).toEqual(["message_read", "message_delivered", "message_sent"]);
  expect(out[0].sev).toBe("ok");
  expect(evMsgLine(out[0].msg)).toBe(`thinker → lead: handoff 1 · delivered ${t(1010)} · read ${t(1020)}`);
});

test("unread or reply due is orange and says so in words", () => {
  const un = evMsgFold(newest(sent(1, 1000)), { 1: msg(1, { delivered_at: null, read_at: null }) })[0];
  expect(un.sev).toBe("wait");
  expect(evMsgLine(un.msg)).toBe(`thinker → lead: handoff 1 · sent ${t(1000)} · unread`);
  const due = evMsgFold(newest(sent(1, 1000)), { 1: msg(1, { needs_reply: true, reply_due: true }) })[0];
  expect(due.sev).toBe("wait");
  expect(evMsgLine(due.msg)).toContain("· reply due");
  expect(evMsgLine(msg(1, { needs_reply: true, replied_at: 1030 }))).toContain(`· replied ${t(1030)}`);
});

test("a batch read of three messages gives three rows at its place", () => {
  const rows = newest(ev("unit_done", 1040), read([1, 2, 3], 1030), sent(1, 1000), sent(2, 1001), sent(3, 1002), ev("pick", 900));
  const out = evMsgFold(rows, { 1: msg(1), 2: msg(2), 3: msg(3) });
  expect(out.map((e: any) => e.msg ? "m" + e.msg.id : e.kind)).toEqual(["unit_done", "m1", "m2", "m3", "pick"]);
  expect(new Set(out.map((e: any) => e.key || e.id)).size).toBe(5);
});

test("an event whose message is unknown stays a plain row; a db without messages folds nothing", () => {
  const rows = newest(sent(9, 1000), read([9], 1010));
  expect(evMsgFold(rows, {})).toEqual(rows);
  const plain = ev("message_sent", 1000, { payload: { key: "x" } }); // no msgs: an old loop.db
  expect(evMsgFold([plain], undefined)).toEqual([plain]);
});

test("a message whose rows straddle two pages shows once on each, with the full status", () => {
  const m = { 1: msg(1, { replied_at: 1050, needs_reply: true }) };
  const p1 = evMsgFold(newest(read([1], 1020), ev("pick", 1015)), m), p2 = evMsgFold(newest(deliv([1], 1010), sent(1, 1000)), m);
  for (const p of [p1, p2]) {
    const rows = p.filter((e: any) => e.msg);
    expect(rows).toHaveLength(1);
    expect(evMsgLine(rows[0].msg)).toBe(`thinker → lead: handoff 1 · delivered ${t(1010)} · read ${t(1020)} · replied ${t(1050)}`);
  }
});

test("a run of three folds to its newest row ×3; a run of two does not", () => {
  const three = newest(ev("pick", 100, { member: "a" }), ev("pick", 101, { member: "a" }), ev("pick", 102, { member: "a" }));
  const out = evRepeats(three);
  expect(out).toHaveLength(1);
  expect(out[0].id).toBe(three[0].id);
  expect(out[0].reps).toEqual(three);
  const two = newest(ev("pick", 100, { member: "a" }), ev("pick", 101, { member: "a" }), ev("unit_done", 102));
  expect(evRepeats(two)).toEqual(two);
  // another squad, member or colour breaks the run
  const mixed = newest(ev("pick", 100, { member: "a" }), ev("pick", 101, { member: "b" }), ev("pick", 102, { member: "a" }), ev("pick", 103, { member: "a", sev: "bad" }));
  expect(evRepeats(mixed)).toHaveLength(4);
});

test("actions or requests of different payload.kind do not fold; the same kind does", () => {
  const a = (k: string, at: number) => ev("action_pending", at, { payload: { kind: k, subject: "s" + at } });
  expect(evRepeats(newest(a("member", 1), a("merge", 2), a("member", 3)))).toHaveLength(3);
  expect(evRepeats(newest(a("member", 1), a("member", 2), a("member", 3)))).toHaveLength(1);
  const r = (k: string, at: number) => ev("request", at, { payload: { kind: k, id: at } });
  expect(evRepeats(newest(r("chat", 1), r("poke", 2), r("chat", 3)))).toHaveLength(3);
});

test("a folded message row never joins a run", () => {
  const rows = newest(sent(1, 1000), sent(2, 1001), sent(3, 1002));
  const out = evRepeats(evMsgFold(rows, { 1: msg(1), 2: msg(2), 3: msg(3) }));
  expect(out).toHaveLength(3);
  expect(out.every((e: any) => e.msg && !e.reps)).toBe(true);
  // the same events with no known message are plain rows and do fold
  expect(evRepeats(evMsgFold(rows, {}))).toHaveLength(1);
});

test("U281 pairs still fold first, and folded action rows can then form a run", () => {
  const act = (k: string, at: number, subject: string) => ev(k, at, { member: "m", payload: { kind: "member", subject } });
  const rows = newest(act("action", 100, "a"), act("action_done", 101, "a"), act("action", 110, "b"), act("action_done", 112, "b"),
    act("action", 120, "c"), act("action_done", 121, "c"));
  const out = pipe(rows, {});
  expect(out).toHaveLength(1);
  expect(out[0].reps.map((e: any) => e.took)).toEqual(["1s", "2s", "1s"]);
  expect(out[0].reps.every((e: any) => e.fold && e.kind === "action")).toBe(true);
});

test("the page wires the pipeline: EvRows skips the message fold when one kind is picked", () => {
  expect(page).toContain("exact ? evRepeats(evs) : evRetries(evRepeats(evMsgFold(evs, (page && page.messages) || {})))");
  expect(page).toContain("exact=${!!exact}");
});

// ---- U7: action rows say what and why ----
const ACT = (at: number, member: string, extra: any = {}, ep = "e1") => ev("action", at, { member: "ds-p-" + member + "-sq", payload: { kind: "member", subject: "member:" + member, episode: ep, payload: {}, ...extra } });
const PEND = (at: number, member: string, wait: string, ep = "e1", extra: any = {}) => ev("action_pending", at, { member: "ds-p-" + member + "-sq", payload: { kind: "member", subject: "member:" + member, episode: ep, wait, ...extra } });

test("a member action names the role and why; unknown why passes through; other kinds keep today's sentence", () => {
  expect(evSentence(ACT(1, "lead", { payload: { stop: true, why: "limit" } }))).toBe("acting: stop lead in sq: its account is at its usage limit, moving it");
  expect(evSentence(ACT(1, "lead", { payload: { stop: true, why: "restart" } }))).toBe("acting: stop lead in sq: restart");
  expect(evSentence(ACT(1, "lead", { payload: { stop: true, why: "hung" } }))).toContain("it looks hung");
  expect(evSentence(ACT(1, "lead", { payload: { stop: true, why: "odd" } }))).toBe("acting: stop lead in sq: odd");
  expect(evSentence(ACT(1, "builder"))).toBe("acting: start builder in sq");
  expect(evSentence(ev("action", 1, { payload: { kind: "alert", subject: "a:1" } }))).toBe("acting: alert a:1 in sq");
});

test("action_pending shows the wait; one with only retry keeps today's text", () => {
  expect(evSentence(PEND(1, "lead", "agent still running after stop"))).toBe("member lead in sq — waiting: agent still running after stop");
  expect(evSentence(PEND(1, "lead", "", "e1", { wait: undefined, retry: "boom" }))).toBe("will retry: member lead in sq: boom");
});

const stuck = (members: string[], ticks: number, ep = "e1") => {
  const rows: any[] = [];
  for (let k = 0; k < ticks; k++) for (const m of members) { rows.push(ACT(100 + k * 5, m, { payload: { stop: true, why: "limit" } }, ep)); rows.push(PEND(100 + k * 5, m, "agent still running after stop", ep)); }
  return newest(...rows);
};

test("three members' interleaved action/pending pairs over 5 ticks give three rows, each tried 5×", () => {
  const out = evRetries(stuck(["lead", "thinker", "builder"], 5));
  expect(out).toHaveLength(3);
  for (const r of out) {
    expect(r.reps).toHaveLength(10);
    expect(evSentence(r)).toMatch(/^stop (lead|thinker|builder) in sq: its account is at its usage limit, moving it — waiting: agent still running after stop · tried 5× since \d\d:\d\d$/);
  }
  expect(evSentence(out[0])).toContain("since " + t(100));
});

test("a run that ends in action_done shows done after N tries; a later run is its own", () => {
  const rows = newest(...stuck(["lead"], 3), ev("action_done", 200, { member: "ds-p-lead-sq", payload: { kind: "member", subject: "member:lead", episode: "e1" } }), ...stuck(["lead"], 2).map((r: any) => ({ ...r, at: r.at + 300 })));
  const out = evRetries(rows);
  expect(out.map((r: any) => (r.tries ? r.tries.end || "open" : r.kind))).toEqual(["open", "action_done"]);
  const done = out.find((r: any) => r.tries && r.tries.end);
  expect(evSentence(done)).toBe("stop lead in sq: its account is at its usage limit, moving it · done after 3 tries");
});

test("different episodes of one subject, and rows of other subjects, do not fold together", () => {
  const a = stuck(["lead"], 2, "e1"), b = stuck(["lead"], 2, "e2").map((r: any) => ({ ...r, at: r.at + 100 }));
  expect(evRetries(newest(...a, ...b)).map((r: any) => (r.reps || []).length)).toEqual([4, 4]);
  const odd = ev("unit_done", 112);
  const out = evRetries(newest(...stuck(["lead"], 3), odd));
  expect(out.some((r: any) => r.id === odd.id)).toBe(true);
  expect(out).toHaveLength(2);
});

test("fewer than three rows stay; the folded row keeps its newest row's colour", () => {
  const two = newest(ACT(1, "lead"), PEND(2, "lead", "w"));
  expect(evRetries(two)).toEqual(two);
  const rows = newest(ACT(1, "lead"), PEND(2, "lead", "w", "e1", {}), { ...PEND(3, "lead", "w"), sev: "wait" });
  expect(evRetries(rows)[0].sev).toBe("wait");
});

test("the page runs evRetries after evRepeats, and skips it when one kind is picked", () => {
  expect(page).toContain("evRetries(evRepeats(evMsgFold(");
});

// ---- the mounted page ----
const now = Math.floor(Date.now() / 1000);
const E = (o: any) => ({ project: "fixture", squad: "alpha", unit: null, member: null, sev: null, cat: "other", payload: {}, ...o });
const events = [
  E({ id: 9, at: now - 10, kind: "message_read", member: "wt-lead", cat: "messages", payload: { ids: [41] }, msgs: [41] }),
  E({ id: 8, at: now - 20, kind: "pick", member: "wt-b1", payload: { role: "builder", agent: "claude", model: "opus" } }),
  E({ id: 7, at: now - 30, kind: "pick", member: "wt-b1", payload: { role: "builder", agent: "claude", model: "opus" } }),
  E({ id: 6, at: now - 40, kind: "pick", member: "wt-b1", payload: { role: "builder", agent: "claude", model: "opus" } }),
  E({ id: 5, at: now - 50, kind: "message_delivered", squad: null, member: "wt-lead", cat: "messages", payload: { ids: [41] }, msgs: [41] }),
  E({ id: 4, at: now - 60, kind: "message_sent", member: "wt-lead", sev: "wait", cat: "messages", payload: { key: "k41" }, msgs: [41] }),
  E({ id: 3, at: now - 70, kind: "unit_done", sev: "ok", cat: "work" }),
];
const messages = { 41: { id: 41, project: "fixture", squad: "alpha", from: "thinker", to: "lead", subject: "handoff", kind: "message", sent_at: now - 60,
  delivered_at: now - 50, read_at: now - 10, replied_at: null, needs_reply: true, reply_due: true, to_wt: "wt-lead" } };
const fixtures = {
  "api/events/lists": JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/evlog/lists.json"), "utf8")),
  "api/events?": { events, older: null, newer: null, names: {}, messages },
};
const board = { ...JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/board-empty.json"), "utf8")), project: "fixture", page_version: "v1",
  squads: [{ label: "fixture", topic: "alpha", status: "running", members: [], display_status: "running", type: "feature", autonomy: "checkpoint", ship_mode: "ce-pipeline", units: [] }] };
const settle = () => new Promise((r) => setTimeout(r, 60));
const click = (r: any, el: any) => el.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));

test("the mounted log: one orange row for a three-event message that opens its Messages view, and a ×3 row that opens in place", async () => {
  const r = await mount(board, true, fixtures); // opens every details and every closed ×N row
  try {
    const ev = r.window.document.getElementById("events");
    await settle();
    const msgRows = [...ev.querySelectorAll('[data-ev="msg"]')];
    expect(msgRows).toHaveLength(1);
    expect(msgRows[0].className).toContain("wait");
    expect(msgRows[0].textContent).toContain("thinker → lead: handoff");
    expect(msgRows[0].textContent).toContain("reply due");
    expect([...ev.querySelectorAll(".ev .k")].map((k: any) => k.textContent)).not.toContain("message_sent");

    const rep = ev.querySelector('[data-ev="rep"]');
    expect(rep.textContent).toContain("×3");
    expect(rep.getAttribute("aria-expanded")).toBe("true"); // mount opened it
    expect(ev.querySelectorAll(".ev.in")).toHaveLength(3);
    click(r, rep); await settle();
    expect(rep.getAttribute("aria-expanded")).toBe("false");
    expect(ev.querySelectorAll(".ev.in")).toHaveLength(0);
    click(r, rep); await settle();
    expect(ev.querySelectorAll(".ev.in")).toHaveLength(3);

    // the "data" link: the events behind the message
    click(r, ev.querySelector('[data-ev="msg-data"]')); await settle();
    const data = ev.querySelector('[data-ev="data"] .evdata');
    expect(JSON.parse(data.textContent).events.map((e: any) => e.id)).toEqual([9, 5, 4]);
    click(r, ev.querySelector('[data-ev="data"] button[title="Close"]')); await settle();

    // the sentence: the receiver's Messages view
    r.urls.length = 0;
    click(r, ev.querySelector('[data-ev="msg-open"]')); await settle();
    expect(r.urls).toContain("api/messages?project=fixture&topic=alpha&wt=wt-lead");
    expect(r.window.document.querySelector(".chat-modal .mhd").textContent).toContain("Inbox · lead in alpha");
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});

test("the mounted log: an interleaved retry page shows one row per stuck member that expands in place", async () => {
  const mk = (id: number, kind: string, member: string, at: number, extra: any) => E({ id, at, kind, member, cat: "actions", payload: { kind: "member", subject: "member:" + member, episode: "e1", ...extra } });
  const evs: any[] = [];
  let n = 100;
  for (let k = 0; k < 4; k++) for (const m of ["wt-lead", "wt-thinker"]) {
    evs.push(mk(n--, "action_pending", m, now - k * 5, { wait: "agent still running after stop" }));
    evs.push(mk(n--, "action", m, now - k * 5, { payload: { stop: true, why: "limit" } }));
  }
  const r = await mount(board, true, { ...fixtures, "api/events?": { events: evs, older: null, newer: null, names: {}, messages: {} } });
  try {
    const ev = r.window.document.getElementById("events");
    await settle();
    const reps = [...ev.querySelectorAll('[data-ev="rep"]')];
    expect(reps).toHaveLength(2);
    for (const rep of reps) {
      expect(rep.textContent).toContain("its account is at its usage limit, moving it");
      expect(rep.textContent).toContain("waiting: agent still running after stop · tried 4×");
      expect(rep.textContent).toContain("×8");
    }
    expect(ev.querySelectorAll(".ev.in")).toHaveLength(16);
    click(r, reps[0]); await settle();
    expect(ev.querySelectorAll(".ev.in")).toHaveLength(8);
    expect(r.errors).toEqual([]);
  } finally { await r.window.happyDOM.close(); }
});
