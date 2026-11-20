// fulfil-chat.test.ts — KTD5/KTD6 (board chat): a `chat` request is typed into the member's own agent
// terminal only once memberReady() holds, oldest first, never while paused; it fails after
// chat_queue_min with the last why; an accepted send is a `chat` delivery that is verified or
// escalated (never resent); a chat to a non-hub member leaves one crew-chat.md line and sends no mail.
// Against the fake Orca on a copy of tests/fixtures/loop/state, like poke-verify.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller, type Picker } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { pause, resume } from "../../bin/loop/pause/pause.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const T = 1_800_000_000;
const WS = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo";
const LEAD = `${WS}/ds-dev-studio-lead-demo`;
const STUDIO = `${WS}/ds-fx-studio`;
const B = `${WS}/ds-dev-studio-builder-u1-spike-loop-as-coordinator-demo`;
const SAYS = "dev-studio board, the operator says: ";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzchat-"));
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
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { const r = await loop.tick(at); await act.drain(); return r; };
  return { orca, tick };
}

// What the observer would write for a member sitting at an empty prompt, quiet since `at - 60`.
const idleAt = (s: Store, wt: string, at: number) =>
  s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", since: at - 60, last_output_at: at - 60, tail: "│ ❯ │\n", tail_at: at - 30, unread: 0, gone_at: null, observed_at: at });
const working = (s: Store, wt: string, at: number) =>
  s.upsert("observed_workers", { project: "fx", wt }, { state: "working", last_output_at: at, observed_at: at });
function chat(s: Store, text: string, member = B, at = T): number {
  const id = Number(s.request("chat", { text, via: "board" }, { project: "fx", squad: "demo", member }).row.id);
  s.db.run("UPDATE requests SET created_at = ? WHERE id = ?", [at, id]);
  return id;
}
const req = (s: Store, id: number) => s.get("requests", { id }) as Row;
const result = (s: Store, id: number) => JSON.parse(String(req(s, id).result ?? "null"));
const typed = (o: FakeOrca) => o.of("poke").map((c) => c.args[1]);
const crewLog = (s: Store) => { const f = join(s.root, "fx", "crew-chat.md"); return existsSync(f) ? readFileSync(f, "utf8") : ""; };
const alerts = (s: Store) => {
  const f = join(s.root, "fx", "alerts.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((x) => String(x.id).startsWith("loop-deliver")) : [];
};

describe("chat fulfiller", () => {
  test("a fake token is typed as written but no event holds it", async () => {
    const s = imported(), { orca, tick } = rig(s);
    idleAt(s, B, T);
    const tok = "ghp_" + "a1B2c3D4e5F6g7H8i9J0".repeat(2);
    chat(s, `use ${tok} for it`);
    await tick(T);
    expect(typed(orca)).toEqual([`${SAYS}use ${tok} for it`]);
    const ev = JSON.stringify(s.db.query("SELECT * FROM events").all());
    expect(ev).not.toContain(tok);
    expect(ev).toContain("[redacted]");
  });

  test("a ready member gets the prefixed line in its own terminal, once", async () => {
    const s = imported(), { orca, tick } = rig(s);
    idleAt(s, B, T);
    const id = chat(s, "use the fixture, not the shell");
    await tick(T);
    expect(orca.of("poke").map((c) => c.args[0])).toEqual([B]);
    expect(typed(orca)).toEqual([`${SAYS}use the fixture, not the shell`]);
    expect(req(s, id).done_at).toBe(T);
    expect(result(s, id)).toMatchObject({ ok: true, state: "turn started", delivered: "started", delivery: null });
    await tick(T + 5);
    expect(orca.of("poke").length).toBe(1);
  });

  test("mid-turn it stays queued with the why, then is typed once the prompt is empty", async () => {
    const s = imported(), { orca, tick } = rig(s);
    working(s, B, T);
    const id = chat(s, "hold on");
    await tick(T);
    expect(req(s, id).done_at).toBeNull();
    expect(result(s, id)).toEqual({ state: "queued", why: "busy: working", since: T });
    // still mid-turn, output still moving: the why changes, nothing typed
    s.upsert("observed_workers", { project: "fx", wt: B }, { state: "idle", last_output_at: T + 8, tail: "│ ❯ │\n", tail_at: T + 9 });
    await tick(T + 10);
    expect(result(s, id)).toEqual({ state: "queued", why: "busy: terminal output", since: T });
    expect(orca.of("poke").length).toBe(0);
    idleAt(s, B, T + 120);
    await tick(T + 120);
    expect(typed(orca)).toEqual([`${SAYS}hold on`]);
    expect(req(s, id).done_at).toBe(T + 120);
  });

  test("an accepted send is a chat delivery: verified once working, never resent", async () => {
    const s = imported(), orca = new FakeOrca(), { tick } = rig(s, orca);
    orca.pokes.set(B, [3]);
    idleAt(s, B, T);
    const id = chat(s, "ping");
    await tick(T);
    expect(result(s, id)).toMatchObject({ ok: true, state: "sent", delivered: "accepted" });
    const d = s.db.query("SELECT id, kind, state, request FROM deliveries").get() as Row;
    expect(d).toMatchObject({ kind: "chat", state: "accepted", request: id });
    expect(result(s, id).delivery).toBe(d.id);
    await tick(T + 5);
    expect(orca.of("poke").length).toBe(1);
    working(s, B, T + 10);
    await tick(T + 10);
    expect((s.db.query("SELECT state FROM deliveries").get() as Row).state).toBe("verified");
    expect(orca.of("poke").length).toBe(1);
  });

  test("an accepted send never taken is one alert after a minute, without a resend", async () => {
    const s = imported(), orca = new FakeOrca(), { tick } = rig(s, orca);
    orca.pokes.set(B, [3, 3]);
    idleAt(s, B, T - 100);
    chat(s, "ping");
    for (let t = T; t <= T + 70; t += 10) await tick(t);
    expect(orca.of("poke").length).toBe(1);
    expect((s.db.query("SELECT state FROM deliveries").get() as Row).state).toBe("escalated");
    expect(alerts(s).length).toBe(1);
  });

  test("never ready: fails after chat_queue_min with the last why", async () => {
    const s = imported(), { orca, tick } = rig(s);
    working(s, B, T);
    const id = chat(s, "are you there");
    await tick(T);
    await tick(T + 29 * 60);
    expect(req(s, id).done_at).toBeNull();
    await tick(T + 30 * 60);
    expect(req(s, id).done_at).not.toBeNull();
    expect(result(s, id)).toMatchObject({ ok: false });
    expect(result(s, id).error).toContain("never ready: busy: working");
    expect(orca.of("poke").length).toBe(0);
  });

  test("two chats go out in order, one per ready window", async () => {
    const s = imported(), { orca, tick } = rig(s);
    idleAt(s, B, T);
    const one = chat(s, "first"), two = chat(s, "second");
    await tick(T);
    expect(typed(orca)).toEqual([`${SAYS}first`]);
    expect(result(s, two)).toEqual({ state: "queued", why: "an earlier message waits" });
    expect(req(s, one).done_at).toBe(T);
    working(s, B, T + 5);
    await tick(T + 5);
    expect(result(s, two)).toEqual({ state: "queued", why: "busy: working", since: T + 5 });
    idleAt(s, B, T + 200);
    await tick(T + 200);
    expect(typed(orca)).toEqual([`${SAYS}first`, `${SAYS}second`]);
  });

  test("a paused member's chat stays queued and is never typed", async () => {
    const s = imported(), { orca, tick } = rig(s);
    pause(s, { scope: "squad", project: "fx", squad: "demo" }, {}, T - 10);
    idleAt(s, B, T);
    const id = chat(s, "while paused");
    await tick(T);
    await tick(T + 60);
    expect(orca.of("poke").length).toBe(0);
    expect(req(s, id).done_at).toBeNull();
    expect(result(s, id)).toEqual({ state: "queued", why: "paused" });
  });

  test("time spent paused does not count toward chat_queue_min", async () => {
    const s = imported(), { orca, tick } = rig(s);
    pause(s, { scope: "squad", project: "fx", squad: "demo" }, {}, T - 10);
    const id = chat(s, "after the pause");
    await tick(T);
    resume(s, { scope: "squad", project: "fx", squad: "demo" }, T + 40 * 60);
    working(s, B, T + 40 * 60);
    await tick(T + 40 * 60 + 5);
    expect(req(s, id).done_at).toBeNull();
    expect(result(s, id)).toEqual({ state: "queued", why: "busy: working", since: T + 40 * 60 + 5 });
    idleAt(s, B, T + 41 * 60);
    await tick(T + 41 * 60);
    expect(typed(orca)).toEqual([`${SAYS}after the pause`]);
  });

  test("a Studio chat goes to its adopted handle only, behind studioReady", async () => {
    const s = imported(), { orca, tick } = rig(s);
    s.db.run("UPDATE requests SET done_at = ? WHERE project = 'fx' AND key LIKE 'file:fx/_studio/%'", [T]);
    s.upsert("members", { project: "fx", squad: "_studio", wt: STUDIO }, { role: "studio", suffix: "", agent: "claude", handle: "term_s1", status: "running", observed_at: T, updated_at: T });
    const term = (lastOut: number) => s.upsert("observed_terminals", { project: "fx", handle: "term_s1" },
      { wt: STUDIO, title: "claude", tail: "│ ❯ │\n", tail_at: lastOut + 5, doc: JSON.stringify({ agent: true, identity: "claude", last_output_at: lastOut, unread: 0 }), observed_at: T, gone_at: null });
    term(T - 30);
    const id = Number(s.request("chat", { text: "morning", via: "board" }, { project: "fx", squad: "_studio", member: STUDIO }).row.id);
    s.db.run("UPDATE requests SET created_at = ? WHERE id = ?", [T, id]);
    await tick(T);
    expect(result(s, id)).toEqual({ state: "queued", why: "busy: terminal output", since: T });
    expect(orca.of("poke-terminal").length).toBe(0);
    term(T - 600);
    await tick(T + 10);
    expect(orca.of("poke-terminal").map((c) => c.args)).toEqual([["term_s1", `${SAYS}morning`]]);
    expect(orca.of("poke").length).toBe(0);
    expect(result(s, id)).toMatchObject({ ok: true, state: "sent" });
    expect(crewLog(s)).toBe("");
  });

  test("a builder chat leaves one crew-chat line and no mail; a Lead chat leaves none", async () => {
    const s = imported(), { orca, tick } = rig(s);
    idleAt(s, B, T);
    idleAt(s, LEAD, T);
    chat(s, "to the builder");
    chat(s, "to the lead", LEAD);
    await tick(T);
    expect(orca.of("poke").length).toBe(2);
    const lines = crewLog(s).split("\n").filter(Boolean);
    expect(lines).toEqual([`- 2027-01-15T08:00:00Z operator → demo/builder-u1-spike-loop-as-coordinator: to the builder`]);
    expect(orca.calls.filter((c) => /^(send|reply|ask|inbox)/.test(c.op)).length).toBe(0);
  });

  test("the store refuses a chat without text", () => {
    const s = imported();
    expect(() => s.requestAny("chat", { via: "board" }, { project: "fx", squad: "demo", member: B })).toThrow(/payload\.text/);
    expect(s.db.query("SELECT COUNT(*) AS n FROM requests WHERE kind = 'chat'").get()).toEqual({ n: 0 });
  });

  test("multi-line text is refused and the request fails", async () => {
    const s = imported(), { orca, tick } = rig(s);
    idleAt(s, B, T);
    const id = chat(s, "two\nlines");
    await tick(T);
    expect(orca.of("poke").length).toBe(0);
    expect(result(s, id)).toMatchObject({ ok: false });
  });
});
