// event-log-filters U4: GET /api/events' bounded search (`q`, the id slice and `searched`) and the
// message details of a page (`messages`, each message event's `msgs`, the unread colour) on a temp
// loop.db built through the store and its migrations. The route's checks are in tests/board-serve.sh.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEV_SQL, eventsPage, eventsQuery, sevSql } from "../../bin/board/board-data.ts";
import { open } from "../../bin/loop/core/store.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
afterEach(() => { delete process.env.DS_EVLOG_SEARCH_SLICE; });

const T0 = 1_800_000_000;
const wt = (role: string, squad: string) => `0a1b2c3d-0000-4000-8000-00000000d3a0::/x/ds-p-${role}-${squad}`;

function newRoot() {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "evsearch-")); roots.push(root);
  const s = open(root);
  const ev = (project: string | null, squad: string | null, member: string | null, kind: string, payload: unknown = {}, unit: string | null = null) =>
    Number(s.db.run("INSERT INTO events (at, project, squad, unit, member, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [T0 + Number(s.db.query("SELECT COUNT(*) AS n FROM events").get()!.n) * 60, project, squad, unit, member, kind, JSON.stringify(payload)]).lastInsertRowid);
  return { root, s, ev };
}

// 30 rows, ids 1..30. "needle" at ids 5 and 25 (payload), a member path holding "zebra" at 27, the
// kind "unit_pr" at 28, and the literal-wildcard pairs at 10-13.
function searchFixture() {
  const { root, s, ev } = newRoot();
  const id: Record<string, number> = {};
  for (let i = 1; i <= 30; i++) {
    const at = i;
    if (at === 5) id.oldNeedle = ev("p", "alpha", null, "unit_done", { note: "an old Needle here" });
    else if (at === 25) id.newNeedle = ev("p", "alpha", null, "unit_done", { note: "the needle in #584" });
    else if (at === 27) id.zebra = ev("p", "alpha", wt("builder-zebra", "alpha"), "member_started");
    else if (at === 28) id.pr = ev("p", "alpha", null, "unit_pr", { pr: 9 });
    else if (at === 10) id.pct = ev("p", "alpha", null, "toast", { text: "at 100% now" });
    else if (at === 11) ev("p", "alpha", null, "toast", { text: "at 1000 now" });
    else if (at === 12) id.under = ev("p", "alpha", null, "toast", { text: "key a_b set" });
    else if (at === 13) ev("p", "alpha", null, "toast", { text: "key axb set" });
    else ev("p", "alpha", null, "squad_state", { n: i });
  }
  s.close();
  return { root, id };
}
const S = searchFixture();
const page = (o: Parameters<typeof eventsPage>[0], root = S.root) => eventsPage(o, root) as any;
const ids = (o: Parameters<typeof eventsPage>[0], root = S.root) => page(o, root).events.map((e: any) => e.id);

test("q matches payload text (case-insensitive), a member path and a kind", () => {
  expect(ids({ project: "p", q: "needle" })).toEqual([S.id.newNeedle, S.id.oldNeedle]);
  expect(ids({ project: "p", q: "#584" })).toEqual([S.id.newNeedle]);
  expect(ids({ project: "p", q: "zebra" })).toEqual([S.id.zebra]);
  expect(ids({ project: "p", q: "unit_pr" })).toEqual([S.id.pr]);
});

test("% and _ (and \\) in q are taken literally", () => {
  expect(ids({ project: "p", q: "100%" })).toEqual([S.id.pct]);
  expect(ids({ project: "p", q: "a_b" })).toEqual([S.id.under]);
  expect(ids({ project: "p", q: "a\\b" })).toEqual([]);
});

test("q composes with the other filters (a squad, a kind)", () => {
  expect(ids({ project: "p", squad: "alpha", kind: "unit_done", q: "needle" })).toEqual([S.id.newNeedle, S.id.oldNeedle]);
  expect(ids({ project: "p", squad: "beta", q: "needle" })).toEqual([]);
  const { where, args } = eventsQuery({ project: "p", q: "x%" });
  expect(where).toContain("payload LIKE ? ESCAPE '\\'");
  expect(args.filter((a) => a === "%x\\%%").length).toBe(5);
});

test("a slice that ends first says how far back it looked; before = to_id searches on to the older match", () => {
  process.env.DS_EVLOG_SEARCH_SLICE = "10";
  const first = page({ project: "p", q: "needle" });
  expect(first.events.map((e: any) => e.id)).toEqual([S.id.newNeedle]);   // ids 21..30
  expect(first.older).toBe(null);
  expect(first.newer).toBe(null);
  expect(first.searched).toEqual({ to_id: 21, to_at: T0 + 20 * 60, more: true });
  const second = page({ project: "p", q: "needle", before: first.searched.to_id });   // ids 11..20: nothing
  expect(second.events).toEqual([]);
  expect(second.searched).toEqual({ to_id: 11, to_at: T0 + 10 * 60, more: true });
  const third = page({ project: "p", q: "needle", before: second.searched.to_id });   // ids 1..10
  expect(third.events.map((e: any) => e.id)).toEqual([S.id.oldNeedle]);
  expect(third.searched).toEqual({ to_id: 1, to_at: T0, more: false });
});

test("a search reads back from until, and at most one slice", () => {
  process.env.DS_EVLOG_SEARCH_SLICE = "10";
  // until the 24th row's time: before is 25, so ids 15..24 are the slice, no needle there.
  const r = page({ project: "p", q: "needle", until: T0 + 23 * 60 });
  expect(r.events).toEqual([]);
  expect(r.searched.to_id).toBe(15);
});

test("a full page of matches gives older (its last match) and no searched", () => {
  const r = page({ project: "p", q: "toast", limit: 3 });
  expect(r.events.map((e: any) => e.kind)).toEqual(["toast", "toast", "toast"]);
  expect(r.older).toBe(r.events[2].id);
  expect(r.searched).toBeUndefined();
  const next = page({ project: "p", q: "toast", limit: 3, before: r.older });
  expect(next.events.map((e: any) => e.id)).toEqual([S.id.pct]);
  expect(next.searched.more).toBe(false);
});

test("a page with no q keeps its old cursors and has no searched", () => {
  const r = page({ project: "p", limit: 5 });
  expect(r.newer).toBe(null);
  expect(r.older).toBe(26);
  expect(r.searched).toBeUndefined();
  expect(r.messages).toEqual({});
});

// Messages: m1 sent + delivered + read (lead → builder-u1-x, live), m2 and m3 unread to the lead (gone
// lead member: no to_wt), m4 needs a reply and has none, m5 replied.
function messageFixture(dropTable = false) {
  const { root, s, ev } = newRoot();
  const mem = (w: string, role: string, suffix: string, status: string) =>
    s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, want, observed_at, updated_at) VALUES ('p', 'alpha', ?, ?, ?, ?, ?, ?, ?)",
      [w, role, suffix, status, status === "gone" ? "gone" : "running", T0, T0]);
  mem(wt("builder-u1-x", "alpha"), "builder", "u1-x", "running");
  mem(wt("lead", "alpha"), "lead", "", "gone");
  const msg = (key: string, toRole: string, toSuffix: string, from: string, subject: string, extra: Record<string, unknown> = {}) => {
    const cols = { key, project: "p", squad: "alpha", to_role: toRole, to_suffix: toSuffix, from_role: from, kind: "message", subject, body: "SECRET BODY", sent_at: T0, ...extra };
    return Number(s.db.run(`INSERT INTO messages (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map(() => "?").join(", ")})`, Object.values(cols) as any).lastInsertRowid);
  };
  const m1 = msg("k1", "builder", "u1-x", "lead", "handoff", { delivered_at: T0 + 60, read_at: T0 + 120 });
  const m2 = msg("k2", "lead", "", "thinker", "plan ready");
  const m3 = msg("k3", "lead", "", "builder", "pr open");
  const m4 = msg("k4", "builder", "u1-x", "lead", "question", { needs_reply: 1, read_at: T0 + 10 });
  const m5 = msg("k5", "builder", "u1-x", "lead", "answered", { needs_reply: 1, read_at: T0 + 10, replied_at: T0 + 20 });
  const e: Record<string, number> = {};
  e.sent1 = ev("p", "alpha", wt("lead", "alpha"), "message_sent", { key: "k1", to: "builder-u1-x", from: "lead", kind: "message", subject: "handoff" });
  e.sent2 = ev("p", "alpha", null, "message_sent", { key: "k2", to: "lead", from: "thinker", kind: "message", subject: "plan ready" });
  e.sent3 = ev("p", "alpha", null, "message_sent", { key: "k3", to: "lead", from: "builder", kind: "message", subject: "pr open" });
  e.sent4 = ev("p", "alpha", null, "message_sent", { key: "k4", to: "builder-u1-x", from: "lead", kind: "message", subject: "question" });
  e.sent5 = ev("p", "alpha", null, "message_sent", { key: "k5", to: "builder-u1-x", from: "lead", kind: "message", subject: "answered" });
  e.lost = ev("p", "alpha", null, "message_sent", { key: "nope", to: "lead", from: "x", kind: "message", subject: "?" });
  e.delivered1 = ev("p", null, wt("builder-u1-x", "alpha"), "message_delivered", { ids: [m1] });
  e.read1 = ev("p", "alpha", null, "message_read", { ids: [m1], by: "builder-u1-x" });
  e.batch = ev("p", "alpha", null, "message_read", { ids: [m1, m2, m3, 999], by: "lead" });
  e.replied = ev("p", "alpha", null, "message_replied", { id: m5, reply: 77 });
  e.other = ev("p", "alpha", null, "unit_done", { id: m1 });
  if (dropTable) s.db.run("DROP TABLE messages");
  s.close();
  return { root, e, m: { m1, m2, m3, m4, m5 } };
}
const M = messageFixture();

test("messages: a sent + delivered + read message, with from, to, times and to_wt, and no body", () => {
  const r = page({ project: "p" }, M.root);
  const m1 = r.messages[String(M.m.m1)];
  expect(m1).toEqual({
    id: M.m.m1, project: "p", squad: "alpha", from: "lead", to: "builder-u1-x", subject: "handoff", kind: "message",
    sent_at: T0, delivered_at: T0 + 60, read_at: T0 + 120, replied_at: null, needs_reply: false, reply_due: false,
    to_wt: wt("builder-u1-x", "alpha"),
  });
  expect(JSON.stringify(r.messages)).not.toContain("SECRET BODY");
  const by = (id: number) => r.events.find((e: any) => e.id === id);
  expect(by(M.e.sent1).msgs).toEqual([M.m.m1]);
  expect(by(M.e.delivered1).msgs).toEqual([M.m.m1]);
  expect(by(M.e.read1).msgs).toEqual([M.m.m1]);
  expect(by(M.e.replied).msgs).toEqual([M.m.m5]);
  expect(by(M.e.other).msgs).toBeUndefined();               // only message_* events name messages
  expect(by(M.e.lost).msgs).toEqual([]);                    // an unknown key names none
  expect(r.messages[String(M.m.m2)].to_wt).toBe(null);      // the lead's member is gone
});

test("a batch event names each of its messages; an unknown id stays in msgs with no messages entry", () => {
  const r = page({ project: "p" }, M.root);
  const batch = r.events.find((e: any) => e.id === M.e.batch);
  expect(batch.msgs).toEqual([M.m.m1, M.m.m2, M.m.m3, 999]);
  expect(Object.keys(r.messages).map(Number).sort((a, b) => a - b)).toEqual([M.m.m1, M.m.m2, M.m.m3, M.m.m5, M.m.m4].sort((a, b) => a - b));
  expect(r.messages["999"]).toBeUndefined();
});

test("an unread or reply-due message_sent is sev=wait and sev=wait finds it; a read one is not", () => {
  const r = page({ project: "p" }, M.root);
  const sev = (id: number) => r.events.find((e: any) => e.id === id).sev;
  expect(sev(M.e.sent1)).toBe(null);        // read
  expect(sev(M.e.sent2)).toBe("wait");      // unread
  expect(sev(M.e.sent4)).toBe("wait");      // read, reply due
  expect(sev(M.e.sent5)).toBe(null);        // replied
  expect(ids({ project: "p", sev: "wait" }, M.root)).toEqual([M.e.sent4, M.e.sent3, M.e.sent2]);
  expect(SEV_SQL).toBe(sevSql(false));
  expect(SEV_SQL).not.toContain("messages");
});

test("a loop.db without the messages table: no messages, plain sev, the page still reads", () => {
  const old = messageFixture(true);
  const r = page({ project: "p" }, old.root);
  expect(r.messages).toEqual({});
  expect(r.events.length).toBe(11);
  expect(r.events.find((e: any) => e.id === old.e.sent2).sev).toBe(null);
  expect(r.events.find((e: any) => e.id === old.e.sent2).msgs).toEqual([]);
  expect(r.events.find((e: any) => e.id === old.e.batch).msgs).toEqual([old.m.m1, old.m.m2, old.m.m3, 999]);
  expect(ids({ project: "p", sev: "wait" }, old.root)).toEqual([]);
  expect(ids({ project: "p", q: "plan ready" }, old.root)).toEqual([old.e.sent2]);
});
