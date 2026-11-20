// messages.test.ts — U45: role-to-role messages are loop.db rows; the loop only wakes the receiver.
// Against the fake Orca on a copy of tests/fixtures/loop/state (as poke-verify.test.ts): a sleeping
// receiver is woken once, a poke Orca refuses is tried again without a duplicate, a loop restart
// mid-delivery types nothing twice, and the receiver reads, acks and replies through messages.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishRequest, LoopActuator, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import messages, { DOUBT_S, wakeText } from "../../bin/loop/reconcilers/messages.ts";
import { run as msgCli } from "../../bin/commands/msg.ts";
import { rowsTick } from "../../bin/commands/watch-ts.ts";
import { ack, inbox, line, reply, scriptSend, senderAt, sendMessage, splitRole, type Message, type Sender } from "../../bin/loop/messages/messages.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const WS = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo";
const LEAD = `${WS}/ds-dev-studio-lead-demo`;
const THINKER = `${WS}/ds-dev-studio-thinker-demo`;
const BUILDER = `${WS}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzmsg-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
const picked: Picker = async () => ({ agent: "claude", model: "opus", effort: null, account: "acct-b" });

function rig(s: Store, orca = new FakeOrca()) {
  const act = new LoopActuator({ orca, pick: picked, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: [...fulfillers, messages] }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { const r = await loop.tick(at); await act.drain(); return r; };
  return { orca, tick, act };
}

const lead: Sender = { project: "fx", squad: "demo", role: "lead", suffix: "", member: LEAD };
const toBuilder = { project: "fx", squad: "demo", role: "builder", suffix: "u1-spike-loop-as-coordinator" };
const asleep = (s: Store, wt: string, at = T) => s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", since: at - 600, observed_at: at });
const send = (s: Store, subject: string, at = T) => sendMessage(s, { to: toBuilder, from: lead, subject, body: `${subject} body` }, at).message.id;
const row = (s: Store, id: number) => s.get("messages", { id }) as Row;
const pokesTo = (orca: FakeOrca, wt: string) => orca.of("poke").filter((c) => c.args[0] === wt);

describe("messages (U45)", () => {
  test("a sleeping receiver is woken once and its rows are delivered", async () => {
    const s = imported();
    asleep(s, BUILDER);
    const id = send(s, "base moved");
    const { orca, tick } = rig(s);
    await tick(T);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    expect(String(pokesTo(orca, BUILDER)[0].args[1])).toContain(`#${id} [msg] from demo/lead — base moved`);
    expect(row(s, id)).toMatchObject({ delivered_at: T, to_member: BUILDER, read_at: null });
    for (let t = T + 5; t <= T + 600; t += 5) await tick(t);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    // A second message is a new batch: one more poke, naming only it.
    const id2 = send(s, "and another", T + 605);
    await tick(T + 605);
    expect(pokesTo(orca, BUILDER).length).toBe(2);
    expect(String(pokesTo(orca, BUILDER)[1].args[1])).toContain(`#${id2} `);
    expect(String(pokesTo(orca, BUILDER)[1].args[1])).not.toContain(`#${id} `);
  });

  test("two messages before the tick are one poke", async () => {
    const s = imported();
    asleep(s, BUILDER);
    const a = send(s, "one"), b = send(s, "two");
    const { orca, tick } = rig(s);
    await tick(T);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    expect(row(s, a).delivered_at).toBe(T);
    expect(row(s, b).delivered_at).toBe(T);
  });

  test("the backend fails, then recovers: delivered once, no duplicate", async () => {
    const s = imported(), orca = new FakeOrca();
    orca.pokes.set(BUILDER, [1, 1, 0]);
    asleep(s, BUILDER);
    const id = send(s, "while down");
    const { tick } = rig(s, orca);
    await tick(T);
    expect(row(s, id).delivered_at).toBeNull();
    let t = T;
    while (row(s, id).delivered_at == null && t < T + 3600) { t += 5; await tick(t); }
    expect(row(s, id).delivered_at).not.toBeNull();
    expect(pokesTo(orca, BUILDER).length).toBe(3);
    for (let u = t + 5; u <= t + 600; u += 5) await tick(u);
    expect(pokesTo(orca, BUILDER).length).toBe(3);
  });

  test("a gone receiver's rows wait undelivered; a fresh member on the unit gets them", async () => {
    const s = imported();
    s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [BUILDER]);
    asleep(s, BUILDER);
    const id = send(s, "for whoever builds u1");
    const { orca, tick } = rig(s);
    await tick(T);
    expect(orca.of("poke").length).toBe(0);
    expect(row(s, id).delivered_at).toBeNull();
    s.db.run("UPDATE members SET status = 'running' WHERE wt = ?", [BUILDER]);
    await tick(T + 5);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    expect(row(s, id).delivered_at).toBe(T + 5);
  });

  test("a loop restart mid-delivery types nothing twice and settles the row", async () => {
    const s = imported(), orca = new FakeOrca();
    asleep(s, BUILDER);
    const id = send(s, "across a restart");
    await rig(s, orca).tick(T);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    // The crash: the row was written ahead and Orca typed the poke, but the loop died before it
    // marked the row delivered.
    s.db.run("UPDATE messages SET delivered_at = NULL, sending_at = ? WHERE id = ?", [T, id]);
    const again = rig(s, orca);
    for (let t = T + 5; t <= T + 600; t += 5) await again.tick(t);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    expect(row(s, id)).toMatchObject({ delivered_at: T + DOUBT_S, to_member: BUILDER, sending_at: null });
  });

  test("a reply row held for its open Orca reply request is not settled in doubt; once the request is done it is", async () => {
    const s = imported();
    asleep(s, BUILDER);
    const id = send(s, "re: which base?");
    s.db.run("UPDATE messages SET sending_at = ?, to_member = ? WHERE id = ?", [T, BUILDER, id]);
    const req = Number(s.request("reply", { id: "msg_q", answer: "loop-v1", message: id }, { key: "reply:msg_q:x", project: "fx", squad: "demo", by: "lead" }).row.id);
    // Only the messages reconciler: no fulfiller works the request, so it stays open past DOUBT_S (a seat wait, retries).
    const act = new LoopActuator({ orca: new FakeOrca(), pick: picked, fulfillers: [] });
    const loop = new Loop(s, { observers: [], reconcilers: [messages] }, act, { projects: () => ["fx"] });
    loop.boot(T);
    await loop.tick(T + DOUBT_S + 5);
    expect(row(s, id)).toMatchObject({ delivered_at: null, sending_at: T });
    s.db.run("UPDATE requests SET done_at = ? WHERE id = ?", [T + DOUBT_S + 6, req]);
    await loop.tick(T + DOUBT_S + 10);
    expect(row(s, id)).toMatchObject({ delivered_at: T + DOUBT_S + 10, sending_at: null });
  });

  test("a poke action replayed after a fast restart takes no row already sending", async () => {
    const s = imported(), orca = new FakeOrca();
    asleep(s, BUILDER);
    const id = send(s, "replayed");
    await rig(s, orca).tick(T);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    // The crash: the poke action was still running (typed, not settled: its action kept, as the
    // actuator writes it while a background call runs) and the row sending.
    const ep = `msg:demo/builder-u1-spike-loop-as-coordinator:${id}#1`;
    const a = { project: "fx", squad: "demo", member: BUILDER, subject: BUILDER, kind: "poke", episode: ep,
      payload: { messages: [id], text: wakeText([row(s, id) as Message]), reason: "msg", attempt: 1 } };
    const n = s.db.run("UPDATE episodes SET state = 'running', ended_at = NULL, result = NULL, action = ? WHERE kind = 'action:poke' AND episode_key = ?",
      [JSON.stringify({ action: a, tries: 0 }), ep]).changes;
    expect(n).toBe(1);
    s.db.run("UPDATE messages SET delivered_at = NULL, sending_at = ? WHERE id = ?", [T, id]);
    const again = rig(s, orca);
    await again.act.boot(s, T);   // as main.ts does: the running action goes back to pending; the next tick replays it
    for (let t = T + 5; t < T + DOUBT_S; t += 5) await again.tick(t);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    expect(s.get("episodes", { project: "fx", subject: BUILDER, kind: "action:poke", episode_key: ep })).toMatchObject({ state: "done", result: "delivered or being sent already" });
    expect(row(s, id)).toMatchObject({ delivered_at: null, sending_at: T });
    await again.tick(T + DOUBT_S);
    expect(row(s, id)).toMatchObject({ delivered_at: T + DOUBT_S, sending_at: null });
    expect(pokesTo(orca, BUILDER).length).toBe(1);
  });

  test("a restart between ticks resumes from the rows: nothing delivered is poked again", async () => {
    const s = imported(), orca = new FakeOrca();
    asleep(s, BUILDER);
    send(s, "before the restart");
    await rig(s, orca).tick(T);
    const again = rig(s, orca);
    for (let t = T + 5; t <= T + 600; t += 5) await again.tick(t);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
  });

  test("ack, inbox and reply", () => {
    const s = imported();
    const a = send(s, "q1"), b = send(s, "q2");
    expect(inbox(s, toBuilder).map((m) => m.id)).toEqual([a, b]);
    // Only the receiver's own unread rows are marked.
    expect(ack(s, { project: "fx", squad: "demo", role: "thinker", suffix: "" }, [a], T)).toEqual([]);
    expect(ack(s, toBuilder, [a, 999], T)).toEqual([a]);
    expect(inbox(s, toBuilder).map((m) => m.id)).toEqual([b]);
    expect(inbox(s, toBuilder, { all: true }).length).toBe(2);
    const r = reply(s, { ...toBuilder, member: BUILDER }, b, "answer", T + 1);
    if ("error" in r) throw new Error(r.error);
    expect(r.message).toMatchObject({ kind: "reply", reply_to: b, squad: "demo", to_role: "lead", to_suffix: "", subject: "re: q2 body".replace(" body", ""), from_role: "builder" });
    expect(row(s, b)).toMatchObject({ read_at: T + 1, replied_at: T + 1 });
    expect(inbox(s, { project: "fx", squad: "demo", role: "lead", suffix: "" }).map((m) => m.id)).toEqual([r.message!.id]);
    const notMine = reply(s, { project: "fx", squad: "demo", role: "thinker", suffix: "", member: THINKER }, b, "not mine", T + 2);
    expect("error" in notMine).toBe(true);
    // Same squad, another role's inbox: the refusal names the owner and the working command; another squad or a missing id stays plain.
    expect((notMine as { error: string }).error).toContain(`message ${b} is not in your inbox (it is in builder-u1-spike-loop-as-coordinator's)`);
    expect((notMine as { error: string }).error).toContain("send-role.sh demo lead");
    // A row the loop wrote is no squad member: no send-role hint for it.
    s.db.run("UPDATE messages SET from_role = 'loop', from_squad = NULL WHERE id = ?", [b]);
    const fromLoop = (reply(s, { project: "fx", squad: "demo", role: "thinker", suffix: "", member: THINKER }, b, "x", T + 2) as { error: string }).error;
    expect(fromLoop).toContain("is not in your inbox (it is in builder-u1");
    expect(fromLoop).not.toContain("send-role.sh");
    expect(reply(s, { project: "fx", squad: "other", role: "thinker", suffix: "", member: THINKER }, b, "x", T + 2)).toEqual({ error: `message ${b} is not in your inbox` });
    expect(reply(s, { project: "fx", squad: "demo", role: "thinker", suffix: "", member: THINKER }, 99999, "x", T + 2)).toEqual({ error: "message 99999 is not in your inbox" });
    expect(ack(s, toBuilder, "all", T + 3)).toEqual([]);
  });

  test("the same send twice in one window is one row", () => {
    const s = imported();
    const one = sendMessage(s, { to: toBuilder, from: lead, subject: "s", body: "b" }, T);
    const two = sendMessage(s, { to: toBuilder, from: lead, subject: "s", body: "b" }, T + 10);
    expect([one.created, two.created]).toEqual([true, false]);
    expect(two.message.id).toBe(one.message.id);
    expect(sendMessage(s, { to: toBuilder, from: lead, subject: "s", body: "b" }, T + 600).created).toBe(true);
  });

  test("scriptSend finds the project from the squad and refuses a non-role", () => {
    const s = imported();
    const r = scriptSend(s, { squad: "demo", want: "thinker", subject: "hi", body: "there", kind: "message", from: { ...lead, project: null }, top: null }, T);
    if ("error" in r) throw new Error(r.error);
    expect(r.message).toMatchObject({ project: "fx", to_role: "thinker", to_suffix: "" });
    expect(scriptSend(s, { squad: "demo", want: "nobody", subject: "x", body: "y", kind: "message", from: lead, top: null }, T)).toEqual({ error: "'nobody' is no role" });
    expect(splitRole("builder-u1-x")).toEqual({ role: "builder", suffix: "u1-x" });
  });

  test("ds msg send / inbox / ack / reply / show, and watch.sh's reader", async () => {
    const s = imported(), was = process.env.DS_STATE_ROOT, log = console.log, err = console.error;
    let out: string[] = [];
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
    process.env.DS_STATE_ROOT = s.root;
    const cli = async (...a: string[]) => { out = []; const rc = await msgCli(a); return { rc, text: out.join("\n") }; };
    try {
      const sent = await cli("send", "demo", "builder-u1-spike-loop-as-coordinator", "hello", "the body", "--needs-reply", "--project", "fx", "--as", "demo/lead");
      expect(sent.rc).toBe(0);
      const id = JSON.parse(sent.text).id as number;
      expect((await cli("send", "demo", "builder-nosuch", "x", "y", "--project", "fx", "--as", "demo/lead")).rc).toBe(2);
      expect((await cli("send", "nosuch", "lead", "x", "y", "--project", "fx", "--as", "demo/lead")).rc).toBe(2);
      const as = ["--project", "fx", "--as", "demo/builder-u1-spike-loop-as-coordinator"];
      const box = await cli("inbox", ...as);
      expect(box.text).toContain(`#${id} [needs reply] from demo/lead — hello  (not yet delivered)\n    the body`);
      expect(box.text).toContain(`ds msg ack ${id}`);
      expect((await rowsTick(s.root, toBuilder, { ack: "", ms: 0, poll: true, all: false })).map((m) => m.id)).toEqual([id]);
      expect(await rowsTick(s.root, { project: "fx", squad: "demo", role: "lead", suffix: "" }, { ack: "", ms: 0, poll: true, all: false })).toEqual([]);
      const rep = await cli("reply", String(id), "yes", ...as);
      expect(rep.rc).toBe(0);
      expect((await cli("inbox", ...as)).text).toBe("no unread messages for demo/builder-u1-spike-loop-as-coordinator");
      expect((await cli("show", String(JSON.parse(rep.text).id), "--json", ...as)).text).toContain('"reply_to": ' + id);
      expect((await cli("show", String(id), "--project", "fx", "--as", "demo/thinker")).rc).toBe(1);
      const lead = ["--project", "fx", "--as", "demo/lead"];
      expect(JSON.parse((await cli("ack", "--all", ...lead)).text)).toEqual({ acked: [JSON.parse(rep.text).id] });
      expect(JSON.parse((await cli("ack", "999", ...lead)).text)).toEqual({ acked: [], not_unread_in_your_inbox: [999] });
    } finally {
      console.log = log; console.error = err;
      if (was === undefined) delete process.env.DS_STATE_ROOT; else process.env.DS_STATE_ROOT = was;
    }
  });

  test("U285: the sender comes from the session, never a made-up operator", () => {
    const s = imported(), leadPath = LEAD.slice(LEAD.indexOf("::") + 2), builderPath = BUILDER.slice(BUILDER.indexOf("::") + 2);
    s.upsert("observed_terminals", { project: "fx", handle: "term_lead" }, { wt: LEAD, observed_at: T });
    const host = "/nonexistent/host-checkout";
    // the handle beats the folder the command runs in
    expect(senderAt(s, host, { ORCA_TERMINAL_HANDLE: "term_lead" })).toMatchObject({ project: "fx", squad: "demo", role: "lead", member: LEAD });
    // the session's start folder is next
    expect(senderAt(s, host, { CLAUDE_PROJECT_DIR: leadPath })).toMatchObject({ role: "lead", member: LEAD });
    // a handle nobody observed falls through to the folder
    expect(senderAt(s, builderPath, { ORCA_TERMINAL_HANDLE: "term_nobody" })).toMatchObject({ role: "builder", member: BUILDER });
    // from the member's own worktree: unchanged
    expect(senderAt(s, leadPath, {})).toMatchObject({ role: "lead", member: LEAD });
    // no member: unknown with the folder, never operator
    const none = senderAt(s, host, {});
    expect(none).toMatchObject({ squad: null, role: "unknown", member: host });
    const sent = sendMessage(s, { to: toBuilder, from: none, subject: "who", body: "b" }, T).message;
    expect(row(s, sent.id)).toMatchObject({ from_role: "unknown", from_member: host });
    expect(line(row(s, sent.id) as Message)).toContain("from unknown (host-checkout)");
    // an explicit operator send still records the operator
    const op = sendMessage(s, { to: toBuilder, from: { project: "fx", squad: null, role: "operator", suffix: "", member: null }, subject: "op", body: "b" }, T).message;
    expect(row(s, op.id).from_role).toBe("operator");
  });

  test("U285: ds msg send --as operator records the operator; no handle and no member records unknown", async () => {
    const s = imported(), was = process.env.DS_STATE_ROOT, wasH = process.env.ORCA_TERMINAL_HANDLE, wasP = process.env.CLAUDE_PROJECT_DIR, log = console.log;
    console.log = () => {};
    process.env.DS_STATE_ROOT = s.root; delete process.env.ORCA_TERMINAL_HANDLE; delete process.env.CLAUDE_PROJECT_DIR;
    try {
      expect(await msgCli(["send", "demo", "builder-u1-spike-loop-as-coordinator", "a", "b", "--project", "fx", "--as", "operator"])).toBe(0);
      expect(await msgCli(["send", "demo", "builder-u1-spike-loop-as-coordinator", "c", "d", "--project", "fx"])).toBe(0);
      const rows = s.db.query("SELECT subject, from_role FROM messages WHERE subject IN ('a','c') ORDER BY id").all();
      expect(rows).toEqual([{ subject: "a", from_role: "operator" }, { subject: "c", from_role: "unknown" }]);
    } finally {
      console.log = log;
      for (const [k, v] of [["DS_STATE_ROOT", was], ["ORCA_TERMINAL_HANDLE", wasH], ["CLAUDE_PROJECT_DIR", wasP]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
});

describe("messages chase (U277)", () => {
  const alerts = (s: Store) => {
    const f = join(s.root, "fx", "alerts.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((a) => String(a.id).startsWith("loop-msg-reply")) : [];
  };

  test("an unread message gets one more poke after msg_chase_min, none before, none while the receiver works", async () => {
    const s = imported();
    asleep(s, BUILDER);
    const id = send(s, "please look");
    const { orca, tick } = rig(s);
    await tick(T);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    // Before the window: nothing more.
    for (let t = T + 60; t < T + 900; t += 60) { asleep(s, BUILDER, t); await tick(t); }
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    // Past the window but the receiver is working: skipped, nothing recorded.
    s.upsert("observed_workers", { project: "fx", wt: BUILDER }, { state: "working", since: T + 900, observed_at: T + 900 });
    await tick(T + 900);
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    // Idle again: the one chase poke goes out, and only one, however long it stays unread.
    asleep(s, BUILDER, T + 960);
    await tick(T + 960);
    expect(pokesTo(orca, BUILDER).length).toBe(2);
    expect(String(pokesTo(orca, BUILDER)[1].args[1])).toContain(`#${id} `);
    expect(String(pokesTo(orca, BUILDER)[1].args[1])).toContain("still unread");
    for (let t = T + 1020; t <= T + 5000; t += 60) { asleep(s, BUILDER, t); await tick(t); }
    expect(pokesTo(orca, BUILDER).length).toBe(2);
  });

  test("a read message is not chased, and msg_chase_min 0 turns the chase off", async () => {
    const s = imported();
    asleep(s, BUILDER);
    const id = send(s, "read me");
    const { orca, tick } = rig(s);
    await tick(T);
    ack(s, { ...toBuilder }, [id], T + 10);
    for (let t = T + 60; t <= T + 1200; t += 60) { asleep(s, BUILDER, t); await tick(t); }
    expect(pokesTo(orca, BUILDER).length).toBe(1);
    const s2 = imported();
    asleep(s2, BUILDER);
    send(s2, "off");
    process.env.DS_LIMIT_MSG_CHASE_MIN = "0";
    try {
      const r = rig(s2);
      await r.tick(T);
      for (let t = T + 60; t <= T + 1200; t += 60) { asleep(s2, BUILDER, t); await r.tick(t); }
      expect(pokesTo(r.orca, BUILDER).length).toBe(1);
    } finally { delete process.env.DS_LIMIT_MSG_CHASE_MIN; }
  });

  test("a needs-reply message with no reply raises one alert, the reply clears it, it is not raised again", async () => {
    const s = imported();
    asleep(s, BUILDER);
    const id = sendMessage(s, { to: toBuilder, from: lead, subject: "which base?", body: "tell me", needsReply: true }, T).message.id;
    const { tick } = rig(s);
    await tick(T);
    for (let t = T + 300; t < T + 3600; t += 300) { asleep(s, BUILDER, t); await tick(t); }
    expect(alerts(s).length).toBe(0);
    for (let t = T + 3600; t <= T + 4500; t += 300) { asleep(s, BUILDER, t); await tick(t); }
    const raised = alerts(s);
    expect(raised.length).toBe(1);
    expect(JSON.stringify(raised[0])).toContain("demo/lead");
    expect(JSON.stringify(raised[0])).toContain("demo/builder-u1-spike-loop-as-coordinator");
    expect(JSON.stringify(raised[0])).toContain("which base?");
    // The reply clears it and nothing raises it again.
    ack(s, toBuilder, [id], T + 4600);
    const r = reply(s, { ...toBuilder, member: BUILDER }, id, "main", T + 4600);
    expect("error" in r).toBe(false);
    for (let t = T + 4800; t <= T + 9000; t += 300) { asleep(s, BUILDER, t); await tick(t); }
    expect(alerts(s).length).toBe(0);
  });

  // unread-counts-mismatch U1: the alert uses the shared WAITING test, so an ended asker raises none and one up is cleared.
  test("no reply card for an ended asker; a card is cleared when its asker ends", async () => {
    const s = imported();
    asleep(s, BUILDER);
    sendMessage(s, { to: toBuilder, from: lead, subject: "which base?", body: "tell me", needsReply: true }, T);
    const { tick } = rig(s);
    await tick(T);
    for (let t = T + 300; t <= T + 4500; t += 300) { asleep(s, BUILDER, t); await tick(t); }
    expect(alerts(s).length).toBe(1);
    // The asker (the Lead) ends: its card goes and nothing raises it again.
    s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [LEAD]);
    for (let t = T + 4800; t <= T + 9000; t += 300) { asleep(s, BUILDER, t); await tick(t); }
    expect(alerts(s).length).toBe(0);
    // A question from an already ended asker never raises one.
    sendMessage(s, { to: toBuilder, from: lead, subject: "from the ended lead", body: "x", needsReply: true }, T + 9000);
    for (let t = T + 9300; t <= T + 14000; t += 300) { asleep(s, BUILDER, t); await tick(t); }
    expect(alerts(s).length).toBe(0);
  });
});

// answered-questions-stop-count U1: a later plain message from the receiver to the asker answers the question.
describe("answered by a plain message", () => {
  const alerts = (s: Store) => {
    const f = join(s.root, "fx", "alerts.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((a) => String(a.id).startsWith("loop-msg-reply")) : [];
  };
  const builder: Sender = { project: "fx", squad: "demo", role: "builder", suffix: "u1-spike-loop-as-coordinator", member: BUILDER };

  test("no reply card once a later message exists, and a card up is cleared", async () => {
    const s = imported();
    asleep(s, BUILDER);
    sendMessage(s, { to: toBuilder, from: lead, subject: "which base?", body: "tell me", needsReply: true }, T);
    const { tick } = rig(s);
    await tick(T);
    for (let t = T + 300; t <= T + 4500; t += 300) { asleep(s, BUILDER, t); await tick(t); }
    expect(alerts(s).length).toBe(1);
    // The Builder answers with a plain message, not `ds msg reply`: the card goes.
    sendMessage(s, { to: { project: "fx", squad: "demo", role: "lead", suffix: "" }, from: builder, subject: "base is main", body: "use main" }, T + 4600);
    for (let t = T + 4800; t <= T + 9000; t += 300) { asleep(s, BUILDER, t); await tick(t); }
    expect(alerts(s).length).toBe(0);
  });

  test("ds msg inbox lists a waiting question, and stops once a later message answers it", async () => {
    const s = imported(), was = process.env.DS_STATE_ROOT, log = console.log;
    let out: string[] = [];
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    process.env.DS_STATE_ROOT = s.root;
    const as = ["--project", "fx", "--as", "demo/builder-u1-spike-loop-as-coordinator"];
    try {
      const q = sendMessage(s, { to: toBuilder, from: lead, subject: "which base?", body: "tell me", needsReply: true }, T).message.id;
      expect(await msgCli(["ack", String(q), ...as])).toBe(0);
      out = [];
      expect(await msgCli(["inbox", ...as])).toBe(0);
      expect(out.join("\n")).toContain(`waiting for your reply (1):`);
      expect(out.join("\n")).toContain(`ds msg reply ${q} "<answer>"`);
      sendMessage(s, { to: { project: "fx", squad: "demo", role: "lead", suffix: "" }, from: builder, subject: "base is main", body: "use main" }, T + 10);
      out = [];
      expect(await msgCli(["inbox", ...as])).toBe(0);
      expect(out.join("\n")).not.toContain("waiting for your reply");
    } finally {
      console.log = log;
      if (was === undefined) delete process.env.DS_STATE_ROOT; else process.env.DS_STATE_ROOT = was;
    }
  });
});

describe("redaction on write (crew-terminal-access U10)", () => {
  const FAKE = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2";
  test("a message stores subject and body redacted, dedupes on the raw text, and leaves clean text alone", () => {
    const s = imported();
    const m = { to: toBuilder, from: lead, subject: `token ${FAKE}`, body: `use ${FAKE} now` };
    const a = sendMessage(s, m, T), b = sendMessage(s, m, T + 5);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.message.subject).toBe("token [redacted]");
    expect(a.message.body).toBe("use [redacted] now");
    expect(JSON.stringify(s.db.query("SELECT payload FROM events WHERE kind = 'message_sent'").all())).not.toContain(FAKE);
    const clean = sendMessage(s, { to: toBuilder, from: lead, subject: "plain", body: "nothing secret here" }, T);
    expect(clean.message).toMatchObject({ subject: "plain", body: "nothing secret here" });
  });
  test("a finished request payload is redacted, an open one and a clean one are kept", () => {
    const s = imported();
    const open = s.request("chat", { text: `hi ${FAKE}` } as never, { project: "fx" } as never).row as Row;
    expect(String(s.get("requests", { id: open.id })?.payload)).toContain(FAKE);
    const clean = s.request("chat", { text: "ok" } as never, { project: "fx" } as never).row as Row;
    const before = String(s.get("requests", { id: clean.id })?.payload);
    const a = { kind: "chat", project: "fx", squad: null, member: null, payload: { request: open.id } } as never;
    const c = { kind: "chat", project: "fx", squad: null, member: null, payload: { request: clean.id } } as never;
    finishRequest(s, a, { ok: true }, T);
    finishRequest(s, c, { ok: true }, T);
    expect(String(s.get("requests", { id: open.id })?.payload)).toBe('{"text":"hi [redacted]"}');
    expect(s.get("requests", { id: clean.id })?.payload).toBe(before);
  });
});
