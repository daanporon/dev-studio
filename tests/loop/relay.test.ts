// relay.test.ts — U61: while the loop's pane holds a squad's Run, a worker's Run mail reaches the
// Lead — since U276 as a loop.db message row (kind `run`), never an Orca inbox — and the Lead's answer
// (`ds msg reply`, or `ds reply`) reaches the worker's parked ask from that pane.
// Hermetic: a copy of tests/fixtures/loop/state and the fake Orca (bin/loop/fakes/orca.ts).
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, resolveAlert, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { sender } from "../../bin/loop/messages/coordinator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { STUCK_AFTER } from "../../bin/loop/messages/relay.ts";
import { coordinatorMail, type Unread } from "../../bin/loop/observers/orca.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { reply as msgReply, type Message } from "../../bin/loop/messages/messages.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { run as dsReply } from "../../bin/commands/reply.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000, RUN = "run_fixture01", BUILDER = "dispatch:ctx_builder", CLAUDE = "term_lead_claude";

const temps: string[] = [], stores: Store[] = [];
const env = process.env.DS_STATE_ROOT;
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (env === undefined) delete process.env.DS_STATE_ROOT; else process.env.DS_STATE_ROOT = env;
});

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
// The Lead's worktree has its Claude terminal (CLAUDE) unless o.agent is false.
async function rig(o: { agent?: boolean; unread?: () => string[]; terminals?: () => string[] } = {}) {
  const d = mkdtempSync(join(tmpdir(), "zzrelay-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  process.env.DS_STATE_ROOT = d;
  const orca = new FakeBackend();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const seen = o.unread || o.terminals ? [{ name: "facts", run: (c: { facts?: { unreadRuns?: Set<string>; terminalHandles?: Set<string> } }) => {
    if (!c.facts) return;
    if (o.unread) c.facts.unreadRuns = new Set(o.unread());
    if (o.terminals) c.facts.terminalHandles = new Set(o.terminals());
  } }] : [];
  const loop = new Loop(s, { observers: seen as never, reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const pane = await sender(s, orca, "fx", "demo", T);              // the loop's pane holds the Run
  const lead = String((s.db.query("SELECT lead_wt FROM squads WHERE project = 'fx' AND topic = 'demo'").get() as Row).lead_wt);
  if (o.agent !== false) orca.agent(lead, CLAUDE, "claude");
  const tick = async (at: number) => { const r = await loop.tick(at); await act.drain(); return r; };
  return { s, orca, act, tick, pane, lead };
}
const events = (s: Store, kind: string) => (s.db.query("SELECT payload FROM events WHERE kind = ? ORDER BY id").all(kind) as { payload: string }[]).map((e) => JSON.parse(e.payload));
const request = (s: Store) => s.db.query("SELECT * FROM requests WHERE kind = 'reply' ORDER BY id DESC").get() as Row;
const quietly = async <T>(f: () => Promise<T>): Promise<T> => {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await f(); } finally { console.log = log; console.error = err; }
};
const reply = (id: string, answer: string) => quietly(() => dsReply([id, answer, "--wait", "0"]));

describe("U244: Orca is read when something can have changed", () => {
  test("steady ticks do not ask for the Run's holder or peek its inbox until the check interval passes", async () => {
    const { orca, tick } = await rig({ unread: () => [] });
    await tick(T + 5);
    const n = () => [orca.of("run-coordinator").length, orca.of("run-inbox-peek").length];
    const first = n();
    for (const dt of [10, 15, 20, 25]) await tick(T + dt);
    expect(n()).toEqual(first);
    await tick(T + 70);
    expect(n()).toEqual([first[0] + 1, first[1]]);                  // U264: the holder is checked again, the inbox is not
  });
  test("a seat holder missing from this tick's terminal list is checked that tick, not at the next interval", async () => {
    const { orca, tick } = await rig({ terminals: () => [] });
    await tick(T + 5);
    const before = orca.of("run-coordinator").length;
    orca.bound.set(RUN, "term_lead");
    await tick(T + 10);
    expect(orca.of("run-coordinator").length).toBe(before + 1);
  });
  test("mail in the Run is peeked and forwarded the tick it arrives, not at the next check", async () => {
    let mail: string[] = [];
    const { orca, tick } = await rig({ unread: () => mail });
    for (const dt of [5, 10, 15]) await tick(T + dt);
    const before = orca.of("run-inbox-peek").length;
    orca.post(RUN, BUILDER, "escalation", "hello", "body");
    mail = [RUN];
    await tick(T + 20);
    expect(orca.of("run-inbox-peek").length).toBe(before + 1);
    expect(orca.unread(RUN)).toEqual([]);
  });
});

// U264: the unread read is the relay's signal. A Run with no unread mail for its coordinator and no due stored
// message is not peeked: not on the loop's first sight of it, not every minute, not every tick after a failed peek.
describe("U264: a Run with no unread mail and nothing due is not peeked", () => {
  test("no peek on first sight or in the first minutes; one safety peek by DS_LOOP_RELAY_CHECK_S (900 s)", async () => {
    const { orca, tick } = await rig({ unread: () => [] });
    for (let dt = 5; dt <= 300; dt += 5) await tick(T + dt);
    expect(orca.of("run-inbox-peek").length).toBe(0);
    await tick(T + 905);
    expect(orca.of("run-inbox-peek").length).toBe(1);
  });
  test("a failed peek of shown mail is peeked again while the mail stays unread, and not once it is gone", async () => {
    let mail: string[] = [RUN];
    const { orca, tick } = await rig({ unread: () => mail });
    orca.fail("run-inbox-peek", { code: 1, out: "", err: "boom" });
    await tick(T + 5);
    await tick(T + 10);
    expect(orca.of("run-inbox-peek").length).toBe(2);
    mail = [];
    for (const dt of [15, 20, 25]) await tick(T + dt);
    expect(orca.of("run-inbox-peek").length).toBe(2);
  });
  test("with no unread read (the observer failed) the Run is peeked every tick", async () => {
    const { orca, tick } = await rig();
    for (const dt of [5, 10, 15]) await tick(T + dt);
    expect(orca.of("run-inbox-peek").length).toBe(3);
  });
});

// U252: the gate counts only what the Run's coordinator reads; a kept misdelivered row is resent with no peek.
describe("U252: the Run's inbox is peeked for its coordinator's mail only", () => {
  test("Run mail and mail to the seat's handle count; mail to the Run's workers does not", async () => {
    const { s, pane } = await rig();
    const u = (to: string, run: string): Unread => ({ to, run });
    expect([...coordinatorMail(s, [u(`run:${RUN}`, RUN), u(BUILDER, "run_other"), u("term_builder", "run_other"), u(pane, "run_seat")])].sort()).toEqual([RUN, "run_seat"]);
  });
  test("worker mail and a forwarded row the relay keeps do not peek between checks; Run mail is peeked and forwarded that tick", async () => {
    let unread: Unread[] = [];
    const r = await rig({ unread: () => [...coordinatorMail(r.s, unread)] });
    const { s, orca, tick } = r;
    await tick(T + 5);
    s.db.run("INSERT INTO relayed (msg_id, project, squad, run_id, seen_at, forwarded_at, taken_at) VALUES ('m_old', 'fx', 'demo', ?, ?, ?, ?)", [RUN, T, T, T]);
    unread = [{ to: BUILDER, run: RUN }];
    const before = orca.of("run-inbox-peek").length;
    for (const dt of [10, 15, 20, 25, 30]) await tick(T + dt);
    expect(orca.of("run-inbox-peek").length).toBe(before);
    orca.post(RUN, BUILDER, "escalation", "hello", "body");
    unread = [{ to: `run:${RUN}`, run: RUN }];
    await tick(T + 33);
    expect(orca.of("run-inbox-peek").length).toBe(before + 1);
    expect(orca.unread(RUN)).toEqual([]);
  });
});

// The Lead's message rows the relay wrote, oldest first.
const leadRows = (s: Store) => s.db.query("SELECT * FROM messages WHERE project = 'fx' AND squad = 'demo' AND to_role = 'lead' AND kind = 'run' ORDER BY id").all() as Message[];
const second = (m: Message) => String(m.body).split("\n")[1];
const builderWt = (s: Store) => String((s.db.query("SELECT wt FROM members WHERE project = 'fx' AND squad = 'demo' AND role = 'builder'").get() as Row).wt);
const LEAD = { project: "fx", squad: "demo", role: "lead", suffix: "" };

describe("a worker's Run mail reaches the Lead as a message row", () => {
  test("a Builder's ask is one needs-reply row for the Lead with its question id, and is read in the Run after; no Orca send", async () => {
    const { s, orca, tick, pane, lead } = await rig();
    const q = orca.ask(RUN, BUILDER, "Which base branch?", ["main", "loop-v1"]);
    await tick(T + 5);
    await tick(T + 10);
    const got = leadRows(s);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ key: `relay:${q}`, subject: "Question", needs_reply: 1, from_role: "worker", from_member: null, read_at: null });
    expect(got[0].body).toContain(`question from ${BUILDER} · id ${q}`);
    expect(got[0].body).toContain("Which base branch?");
    expect(got[0].body).toContain("options: main | loop-v1");
    expect(orca.inbox(lead)).toEqual([]);
    expect(orca.of("send-run-worker")).toEqual([]);
    expect(orca.unread(RUN)).toEqual([]);
    expect(orca.of("run-inbox-take").map((c) => c.via.from)).toEqual([pane]);
    expect(events(s, "run_mail_relayed")).toEqual([{ run: RUN, id: q, type: "question", from: BUILDER, message: got[0].id }]);
  });

  test("U9: a secret shape in Run mail is redacted in relayed and in the Lead's row; plain mail is unchanged", async () => {
    const { s, orca, tick } = await rig();
    const key = "sk-ant-" + "abcdefghij1234567890";
    orca.post(RUN, BUILDER, "status", `key ${key}`, `use ${key} now`);
    orca.post(RUN, BUILDER, "status", "plain", "PR #12 open");
    await tick(T + 5);
    const rel = s.db.query("SELECT subject, body, payload FROM relayed ORDER BY rowid").all() as Row[];
    expect(JSON.stringify(rel)).not.toContain("sk-ant-");
    expect(rel[0].subject).toBe("key [redacted]");
    expect(rel[0].body).toBe("use [redacted] now");
    expect(rel[1].body).toBe("PR #12 open");
    const rows = leadRows(s);
    expect(JSON.stringify(rows)).not.toContain("sk-ant-");
    expect(rows[1].body).toContain("PR #12 open");
  });

  test("a sender the loop knows by its terminal is named as that member; a replayed row stays one row", async () => {
    const { s, orca, tick } = await rig();
    const builder = builderWt(s);
    orca.agent(builder, "term_b");
    orca.post(RUN, "term_b", "status", "status", "PR #12 open");
    await tick(T + 5);
    expect(leadRows(s)).toEqual([expect.objectContaining({ from_role: "builder", from_member: builder, needs_reply: 0 })]);
    s.db.run("UPDATE relayed SET forwarded_at = NULL");
    await tick(T + 10);
    expect(leadRows(s)).toHaveLength(1);
  });

  test("a status and a worker_done are relayed too, in the order they came", async () => {
    const { s, orca, tick } = await rig();
    orca.post(RUN, BUILDER, "status", "status", "PR #12 open");
    orca.post(RUN, BUILDER, "worker_done", "done", "U3 shipped");
    await tick(T + 5);
    expect(leadRows(s).map(second)).toEqual(["PR #12 open", "U3 shipped"]);
    expect(leadRows(s)[1].body).toContain("worker_done from");
  });

  test("mail that lands between the peek and the take is read with the batch and written from the table next tick", async () => {
    const { s, orca, tick } = await rig();
    orca.post(RUN, BUILDER, "status", "status", "first");
    let late = "";
    orca.onCall = (c) => { if (c.op === "run-inbox-take" && !late) late = orca.post(RUN, BUILDER, "status", "status", "late"); };
    await tick(T + 5);
    expect(leadRows(s).map(second)).toEqual(["first"]);
    expect(orca.unread(RUN)).toEqual([]);
    await tick(T + 10);
    expect(leadRows(s).map(second)).toEqual(["first", "late"]);
  });

  test("a Run the loop doesn't hold is bound again first, then relayed from the loop's pane", async () => {
    const { s, orca, tick, pane } = await rig();
    orca.bound.set(RUN, "term_lead");                                 // a Lead's stopgap adopt
    orca.ask(RUN, BUILDER, "Which base branch?");
    await tick(T + 5);
    expect(events(s, "coordinator_rebound")).toEqual([{ run: RUN, was: "term_lead", handle: pane }]);
    expect(leadRows(s)).toHaveLength(1);
    expect(orca.of("run-inbox-peek").map((c) => c.via.from)).toEqual([pane]);
  });

  test("a Lead with no live terminal still gets its rows: nothing waits on a terminal", async () => {
    const { s, orca, tick } = await rig({ agent: false });
    orca.post(RUN, BUILDER, "status", "status", "one");
    orca.post(RUN, BUILDER, "status", "status", "two");
    await tick(T + 5);
    expect(leadRows(s).map(second)).toEqual(["one", "two"]);
    expect(orca.unread(RUN)).toEqual([]);
    expect(orca.of("dispatch")).toEqual([]);
  });
});

// Orca's stop escalation of the Lead's own turn-end never goes back to the Lead; a newer reload drops an older
// one; mail that can't be written (no terminal list) raises one card.
describe("stop mail, reloads and stuck mail", () => {
  const cards = (s: Store) => { const f = join(s.root, "fx", "alerts.json"); return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((x) => String(x.title ?? "").startsWith("Run mail stuck")) : []; };
  const stop = (orca: FakeBackend, id: string, from: string) =>
    orca.msgs.push({ id, run: RUN, to: `run:${RUN}`, from_handle: from, type: "escalation", subject: "Worker stopped without reporting", body: "The worker's turn ended with no report.", payload: null, read: false });

  test("a msg_stop_ escalation from the Lead's own terminal is marked self; one from a Builder is marked stop, logs one worker_stopped per episode, and is not written", async () => {
    const { s, orca, tick, lead } = await rig();
    const builder = builderWt(s);
    orca.agent(lead, "term_lead");
    orca.agent(builder, "term_b");
    stop(orca, "msg_stop_lead", "term_lead");
    stop(orca, "msg_stop_b", "term_b");
    await tick(T + 5);
    expect(s.get("relayed", { msg_id: "msg_stop_lead" })).toMatchObject({ forwarded_at: T + 5, error: "self" });
    expect(s.get("relayed", { msg_id: "msg_stop_b" })).toMatchObject({ forwarded_at: T + 5, error: "stop" });
    expect(leadRows(s)).toEqual([]);
    expect(orca.unread(RUN)).toEqual([]);
    expect(events(s, "worker_stopped")).toEqual([{ handle: "term_b", worktree: builder }]);
    expect(events(s, "run_mail_relayed")).toEqual([]);

    stop(orca, "msg_stop_b2", "term_b");                              // same Builder, same episode
    await tick(T + 10);
    expect(s.get("relayed", { msg_id: "msg_stop_b2" })).toMatchObject({ error: "stop" });
    expect(events(s, "worker_stopped")).toHaveLength(1);
  });

  test("a question and a worker_done from the Builder are still written, and ending that stop episode lets the next stop log again", async () => {
    const { s, orca, tick } = await rig();
    orca.agent(builderWt(s), "term_b");
    stop(orca, "msg_stop_1", "term_b");
    await tick(T + 5);
    orca.msgs.push({ id: "msg_done", run: RUN, to: `run:${RUN}`, from_handle: "term_b", type: "worker_done", subject: "done", body: "merge-ready", payload: null, read: false });
    const q = orca.ask(RUN, "term_b", "Which base branch?", ["main"]);
    await tick(T + 10);
    expect(leadRows(s).map((m) => String(m.body).split("\n")[0])).toEqual([expect.stringContaining("id msg_done"), expect.stringContaining(`id ${q}`)]);
    stop(orca, "msg_stop_2", "term_b");
    await tick(T + 15);
    expect(events(s, "worker_stopped")).toHaveLength(2);
    expect(leadRows(s)).toHaveLength(2);
  });

  test("an older reload still queued is dropped once a newer reload is queued", async () => {
    const { s, orca, tick } = await rig();
    orca.post(RUN, BUILDER, "status", "reload", "re-read your files, batch one");
    orca.post(RUN, BUILDER, "status", "reload", "re-read your files, batch two");
    await tick(T + 5);
    expect(leadRows(s).map(second)).toEqual(["re-read your files, batch two"]);
    expect(s.get("relayed", { msg_id: "msg_1" })).toMatchObject({ error: "superseded" });
    expect(s.get("relayed", { msg_id: "msg_2" })).toMatchObject({ forwarded_at: T + 5, error: null });
    expect(events(s, "run_mail_superseded")).toEqual([{ id: "msg_1" }]);
  });

  test("mail stuck STUCK_AFTER (no terminal list) raises one card naming the questions, re-raises hourly, and clears once it is written", async () => {
    const { s, orca, tick } = await rig();
    for (let i = 0; i < 40; i++) orca.fail("agent-handles", { code: 1, out: "", err: "orca: terminal list failed" });
    orca.ask(RUN, BUILDER, "Which base branch?");
    orca.post(RUN, BUILDER, "status", "status", "later");
    await tick(T + 5);
    expect(leadRows(s)).toEqual([]);
    expect(orca.unread(RUN)).toHaveLength(2);                          // the Run keeps it until it is written
    await tick(T + 5 + STUCK_AFTER - 1);
    expect(cards(s)).toEqual([]);
    await tick(T + 5 + STUCK_AFTER);
    expect(cards(s)).toHaveLength(1);
    expect(cards(s)[0].title).toBe("Run mail stuck: demo");
    expect(JSON.stringify(cards(s)[0])).toContain("2 Run messages for the Lead of demo");
    expect(JSON.stringify(cards(s)[0])).toContain("1 of them is a question waiting for an answer");
    const ep = { project: "fx", subject: "relay.demo", kind: "relay-stuck" };
    const raised = s.get("episodes", ep)?.observed_at as number;
    await tick(T + 5 + STUCK_AFTER + 3599);
    expect(s.get("episodes", ep)?.observed_at as number).toBe(raised);
    await resolveAlert(s, "fx", "relay.demo", `stuck:${T + 5}`);   // the operator dismisses the card
    await tick(T + 5 + STUCK_AFTER + 3600);                         // an hour on: back again
    expect(cards(s)).toHaveLength(1);
    (orca as unknown as { failures: Map<string, unknown> }).failures.delete("agent-handles");
    await tick(T + 5 + STUCK_AFTER + 3605);
    expect(leadRows(s)).toHaveLength(2);
    expect(cards(s)).toEqual([]);
  });
});

describe("the Lead's answer reaches the parked ask", () => {
  test("ds msg reply on a relayed question: a reply row linked to it and the Orca reply from the pane; the row is read once the ask has it", async () => {
    const { s, orca, tick, pane } = await rig();
    const builder = builderWt(s);
    orca.agent(builder, "term_b");
    const q = orca.ask(RUN, "term_b", "Which base branch?");
    await tick(T + 5);
    const [m] = leadRows(s);
    const r = msgReply(s, { ...LEAD, member: null }, m.id, "loop-v1", T + 6);
    if ("error" in r) throw new Error(r.error);
    expect(r.message).toMatchObject({ kind: "reply", reply_to: m.id, to_role: "builder", to_member: builder, sending_at: T + 6, read_at: null });
    expect(s.get("messages", { id: m.id })).toMatchObject({ replied_at: T + 6, read_at: T + 6 });
    expect(request(s)).toMatchObject({ project: "fx", squad: "demo", done_at: null });
    await tick(T + 10);
    expect(orca.questions.get(q)!.answer).toBe("loop-v1");
    expect(orca.of("reply").map((c) => [c.args, c.via.from])).toEqual([[[q, RUN, "loop-v1"], pane]]);
    expect(s.get("messages", { id: r.message!.id })).toMatchObject({ delivered_at: T + 10, read_at: T + 10 });
    expect(events(s, "message_read").map((e) => e.ids)).toEqual([[r.message!.id]]);
    expect(msgReply(s, { ...LEAD, member: null }, m.id, "loop-v1", T + 11)).toMatchObject({ created: false });   // the same answer again: the same rows
    await tick(T + 15);
    expect(orca.of("reply")).toHaveLength(1);
  });

  test("an answer Orca refuses (the ask timed out) leaves the reply row as plain mail for the worker", async () => {
    const { s, orca, tick } = await rig();
    orca.agent(builderWt(s), "term_b");
    const q = orca.ask(RUN, "term_b", "Which base branch?");
    await tick(T + 5);
    orca.questions.get(q)!.closed = true;
    const r = msgReply(s, { ...LEAD, member: null }, leadRows(s)[0].id, "loop-v1", T + 6);
    if ("error" in r) throw new Error(r.error);
    await tick(T + 10);
    await tick(T + 15);
    expect(JSON.parse(String(request(s).result))).toEqual({ ok: false, error: expect.stringContaining("dispatch_inactive") });
    expect(s.get("messages", { id: r.message!.id })).toMatchObject({ sending_at: null, read_at: null });
  });

  test("a question from a terminal no member owns is answered in Orca only", async () => {
    const { s, orca, tick } = await rig();
    const q = orca.ask(RUN, BUILDER, "Which base branch?");
    await tick(T + 5);
    const r = msgReply(s, { ...LEAD, member: null }, leadRows(s)[0].id, "main", T + 6);
    expect(r).toMatchObject({ message: null, request: expect.any(Number) });
    await tick(T + 10);
    expect(orca.questions.get(q)!.answer).toBe("main");
  });

  test("ds reply writes a request; the loop sends the reply from its pane and the ask gets the answer", async () => {
    const { s, orca, tick, pane } = await rig();
    const q = orca.ask(RUN, BUILDER, "Which base branch?");
    await tick(T + 5);
    expect(await reply(q, "loop-v1")).toBe(0);
    expect(request(s)).toMatchObject({ project: "fx", squad: "demo", done_at: null });
    await tick(T + 10);
    expect(orca.questions.get(q)!.answer).toBe("loop-v1");
    expect(orca.of("reply").map((c) => [c.args, c.via.from])).toEqual([[[q, RUN, "loop-v1"], pane]]);
    expect(JSON.parse(String(request(s).result))).toEqual({ ok: true });
    expect(await reply(q, "loop-v1")).toBe(0);                       // the same answer again: the same row
    await tick(T + 15);
    expect(orca.of("reply")).toHaveLength(1);
  });

  test("a rebind between the ask and the reply still delivers the answer", async () => {
    const { s, orca, tick, pane } = await rig();
    const q = orca.ask(RUN, BUILDER, "Which base branch?");
    await tick(T + 5);
    await reply(q, "loop-v1");
    orca.bound.set(RUN, "term_lead");
    // U244: Orca is asked who holds the Run once a DS_LOOP_SEAT_CHECK_S (60 s), so the rebind comes at the next check.
    await tick(T + 70);
    expect(orca.questions.get(q)!.answer).toBe("loop-v1");
    expect(orca.of("reply").map((c) => c.via.from)).toEqual([pane]);
    expect(events(s, "question_replied")).toEqual([{ id: q, run: RUN }]);
  });

  test("a pane fenced at the reply itself binds again and replies once", async () => {
    const { orca, tick, pane } = await rig();
    const q = orca.ask(RUN, BUILDER, "Which base branch?");
    await tick(T + 5);
    await reply(q, "loop-v1");
    orca.onCall = (c) => { if (c.op === "reply" && orca.of("reply").length === 1) orca.bound.set(RUN, "term_lead"); };
    await tick(T + 10);
    expect(orca.questions.get(q)!.answer).toBe("loop-v1");
    expect(orca.of("reply").map((c) => c.via.from)).toEqual([pane, pane]);
  });

  test("an answer to a question whose ask timed out, or that has another answer, is recorded and not retried", async () => {
    const { s, orca, tick } = await rig();
    const late = orca.ask(RUN, BUILDER, "Which base branch?"), taken = orca.ask(RUN, BUILDER, "Squash?");
    await tick(T + 5);
    orca.questions.get(late)!.closed = true;
    orca.questions.get(taken)!.answer = "yes";
    await reply(late, "loop-v1");
    await reply(taken, "no");
    await tick(T + 10);
    await tick(T + 15);
    expect(orca.of("reply").map((c) => c.args[0])).toEqual([late, taken]);
    const done = s.db.query("SELECT payload, result FROM requests WHERE kind = 'reply' ORDER BY id").all() as Row[];
    expect(done.map((r) => JSON.parse(String(r.result)))).toEqual([
      { ok: false, error: expect.stringContaining("dispatch_inactive") },
      { ok: false, error: expect.stringContaining("answer_conflict") },
    ]);
    expect(events(s, "question_reply_refused").map((e) => e.id)).toEqual([late, taken]);
  });

  test("ds reply refuses an id the loop never relayed", async () => {
    await rig();
    expect(await reply("msg_nope", "x")).toBe(2);
  });
});
