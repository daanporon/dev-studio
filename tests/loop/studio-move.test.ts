// studio-move.test.ts — U264: the Studio moved to another account on a limit. The limits reconciler
// (studio_move auto|ask|off, the studioReady guard, the hold, one move at a time) and the
// `studio-move` fulfiller (fulfil/studio.ts: only the Studio's own tab closed, studio-start on the
// pick, the new handle recorded, a failed start carded), on a temp copy of tests/fixtures/loop/state.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import type { Action, Actuator } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { since } from "../../bin/loop/core/events.ts";
import { makeLimits, type Pick, type PickArgs } from "../../bin/loop/reconcilers/limits.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import studio from "../../bin/loop/fulfil/studio.ts";
import { MOVE } from "../../bin/loop/squad/studio.ts";
import { setAccountEnabled } from "../../bin/loop/capacity/accounts.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const SCREENS = join(ROOT, "tests", "fixtures", "loop", "screens");
const T = 1_792_144_800;
const STUDIO = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-fx-studio";
const OTHER: Pick = { agent: "claude", model: "sonnet", effort: "-", account: "acct-b", fallback: false };
const SAME: Pick = { agent: "claude", model: "sonnet", effort: "-", account: "acct-a", fallback: false };
const notice = readFileSync(join(SCREENS, "weekly-notice.txt"), "utf8");

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.DS_LOOP_STUDIO_MOVE_HOLD_S;
});

// The fixture project with its Studio adopted on term_s (acct-a), idle at an empty prompt, out of
// credits (the weekly notice on its worker screen), and a ds-loop pane beside it.
function rig(o: { draft?: string; out?: number; handle?: string | null } = {}): Store {
  const d = mkdtempSync(join(tmpdir(), "zzstudiomove-")); temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  rmSync(join(d, "fx", "loop", "limited.json"), { force: true });
  const s = open(d); stores.push(s); importJson(s, d, () => {});
  s.db.run("UPDATE requests SET done_at = ? WHERE project = 'fx' AND key LIKE 'file:fx/_studio/%'", [T]);
  for (const account of ["acct-a", "acct-b"]) s.upsert("observed_accounts", { agent: "claude", account }, { updated: String(T), observed_at: T });
  s.db.run("UPDATE observed_accounts SET limited_until = NULL WHERE agent = 'claude'");
  const handle = o.handle === undefined ? "term_s" : o.handle;
  s.upsert("members", { project: "fx", squad: "_studio", wt: STUDIO }, { role: "studio", suffix: "", agent: "claude", model: "opus", account: "acct-a", handle, status: "running", observed_at: T, updated_at: T });
  const out = o.out ?? T - 900;
  for (const [h, title] of [["term_s", "claude"], ["term_l", "ds-loop briefing"]] as const)
    s.upsert("observed_terminals", { project: "fx", handle: h }, { wt: STUDIO, title, tail: h === "term_s" ? `│ ❯ ${o.draft ?? ""} │\n` : "", tail_at: T,
      doc: JSON.stringify({ identity: h === "term_s" ? "claude" : "codex", last_output_at: out, unread: 0 }), gone_at: null, observed_at: T });
  s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { state: "idle", tail: notice, tail_at: T, since: T - 900, last_output_at: out, limited: null, gone_at: null, suspect: 0, observed_at: T });
  return s;
}
const conf = (s: Store, key: string, value: string) => s.upsert("config", { project: "fx", file: "limits.conf", key }, { value, observed_at: T });

// The reconciler alone: what it asks for, and the pick arguments it used.
function decider(s: Store, pick: Pick) {
  const got: Action[] = [], calls: PickArgs[] = [];
  const act: Actuator = { act: (a) => { got.push(a); } };
  const loop = new Loop(s, { observers: [], reconcilers: [makeLimits({ pick: (a) => { calls.push(a); return pick; } })] }, act, { projects: () => ["fx"] });
  return { got, calls, loop, moves: () => got.filter((a) => a.kind === "studio-move"), cards: () => got.filter((a) => a.kind === "alert") };
}

// The reconciler with the real actuator and fulfillers over a fake Orca.
function mover(s: Store, pick: Pick) {
  const orca = new FakeBackend();
  orca.agents = [{ wt: STUDIO, handle: "term_s", title: "claude" }, { wt: STUDIO, handle: "term_l", title: "ds-loop briefing" }];
  const act = new LoopActuator({ orca });
  const loop = new Loop(s, { observers: [], reconcilers: [makeLimits({ pick: () => pick })] }, act, { projects: () => ["fx"] });
  return { orca, tick: async (at: number) => { await loop.tick(at); await act.drain(); } };
}
const cardsIn = (s: Store, prefix: string) => {
  const f = join(s.root, "fx", "alerts.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((a) => String(a.id).startsWith(prefix)) : [];
};
const studioMember = (s: Store) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = '_studio'").get() as Row;
const payloads = (s: Store, kind: string) => since(s, 0, { kinds: [kind] }).map((e) => JSON.parse(String(e.payload)));

describe("deciding a Studio move (limits.ts)", () => {
  test("AE3: auto, idle with an empty prompt and room elsewhere: one move to the pick, picked for the studio role, no card", async () => {
    const s = rig(), d = decider(s, OTHER);
    await d.loop.tick(T);
    expect(d.calls.map((c) => c.role)).toEqual(["studio"]);
    expect(d.moves()).toHaveLength(1);
    expect(d.moves()[0]).toMatchObject({ subject: MOVE, member: STUDIO, payload: { handle: "term_s", agent: "claude", account: "acct-b", model: "sonnet", from: "claude:acct-a" } });
    expect(d.cards()).toEqual([]);
  });

  test("U3: auto, a Studio on Claude's credit-balance 402 is moved off the held account like a limited one", async () => {
    const s = rig(), d = decider(s, OTHER);
    s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { tail: readFileSync(join(ROOT, "tests", "fixtures", "credits", "claude-402.txt"), "utf8") });
    await d.loop.tick(T);
    expect(s.get("episodes", { project: "fx", subject: STUDIO, kind: "limited" })?.state).toBe("credits");
    expect(d.calls.map((c) => c.role)).toEqual(["studio"]);
    expect(d.moves()).toHaveLength(1);
    expect(d.moves()[0]).toMatchObject({ subject: MOVE, member: STUDIO, payload: { handle: "term_s", account: "acct-b", from: "claude:acct-a" } });
    expect(d.cards()).toEqual([]);
  });

  test("U267: the loop's own picker on a project roster without a studio row moves it on the default row", async () => {
    const s = rig();
    importConfig(s, s.root, join(ROOT, "conventions"));
    expect(s.db.query("SELECT count(*) AS n FROM config WHERE project = 'fx' AND file = 'roles.conf' AND key = 'studio'").get()).toEqual({ n: 0 });
    const got: Action[] = [];
    const loop = new Loop(s, { observers: [], reconcilers: [makeLimits()] }, { act: (a) => { got.push(a); } }, { projects: () => ["fx"] });
    await loop.tick(T);
    const moves = got.filter((a) => a.kind === "studio-move");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ subject: MOVE, member: STUDIO, payload: { handle: "term_s", agent: "claude", model: "sonnet", account: "acct-b", from: "claude:acct-a" } });
  });

  test("no second move while one is claimed or just made", async () => {
    const s = rig(), d = decider(s, OTHER);
    await d.loop.tick(T);
    const ep = d.moves()[0]!.episode;
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "action:studio-move" }, { episode_key: ep, state: "running", source: "loop", observed_at: T });
    await d.loop.tick(T + 60);
    expect(d.moves()).toHaveLength(1);
    // Settled, but the last try is within the settle window: still nothing.
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "action:studio-move" }, { state: "done", ended_at: T + 90, observed_at: T + 90 });
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:move" }, { episode_key: ep, state: "not moved", started_at: T + 90, ended_at: T + 90, source: "loop", observed_at: T + 90 });
    await d.loop.tick(T + 120);
    expect(d.moves()).toHaveLength(1);
    await d.loop.tick(T + 400);
    expect(d.moves()).toHaveLength(2);
  });

  test("busy or a typed line: no move and no card until the hold runs out, then the card names why", async () => {
    for (const [busy, why] of [[false, "text at the prompt"], [true, "busy: terminal output"]] as const) {
      process.env.DS_LOOP_STUDIO_MOVE_HOLD_S = "600";
      const s = rig(busy ? {} : { draft: "half a thought" }), d = decider(s, OTHER);
      const tick = async (at: number) => {
        if (busy) s.db.run("UPDATE observed_terminals SET doc = json_set(doc, '$.last_output_at', ?) WHERE handle = 'term_s'", [at - 10]);
        await d.loop.tick(at);
      };
      await tick(T + 1240);
      await tick(T + 1500);
      expect(d.got.filter((a) => a.kind === "studio-move" || a.kind === "alert")).toEqual([]);
      await tick(T + 1900);
      expect(d.moves()).toEqual([]);
      expect(d.cards()).toHaveLength(1);
      expect(String((d.cards()[0]!.payload as Row).text)).toContain(`now: ${why}`);
    }
  });

  test("no room anywhere: today's card, no move", async () => {
    const s = rig(), d = decider(s, { wait: T + 7200 });
    await d.loop.tick(T);
    expect(d.moves()).toEqual([]);
    expect(String((d.cards()[0]!.payload as Row).text)).toContain("every account is out until");
  });

  test("the pick is where it already runs: no move, no card", async () => {
    const s = rig(), d = decider(s, { ...SAME, model: "opus" });
    await d.loop.tick(T);
    expect(d.moves()).toEqual([]);
    expect(d.cards()).toEqual([]);
  });

  test("off, or no adopted handle: today's restart card, no move", async () => {
    for (const s of [(() => { const x = rig(); conf(x, "studio_move", "off"); return x; })(), rig({ handle: null })]) {
      const d = decider(s, OTHER);
      await d.loop.tick(T);
      expect(d.moves()).toEqual([]);
      expect(String((d.cards()[0]!.payload as Row).text)).toContain("restart it on claude:sonnet@acct-b");
    }
  });

  test("ask: a card with \"move it\"; once answered the Studio moves as in auto", async () => {
    const s = rig(); conf(s, "studio_move", "ask");
    const d = decider(s, OTHER);
    await d.loop.tick(T);
    expect(d.moves()).toEqual([]);
    expect(d.cards()[0]!.payload).toMatchObject({ option: "move it", fields: { move: true } });
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:approved" }, { episode_key: "x", state: "approved", started_at: T + 30, ended_at: null, source: "board", observed_at: T + 30 });
    await d.loop.tick(T + 60);
    expect(d.moves()).toHaveLength(1);
    // The answer stands until a move is made (fulfil/studio.ts ends it), so a guard refusal tries again.
    expect(s.get("episodes", { project: "fx", subject: MOVE, kind: "studio:approved" })!.ended_at).toBeNull();
  });

  test("ask: answered \"move it\" but it stays not ready: the held card still shows, once", async () => {
    const s = rig({ draft: "half a thought" }); conf(s, "studio_move", "ask");
    const m = mover(s, OTHER);
    await m.tick(T);
    expect(cardsIn(s, "loop-studio.limit-").map((c) => c.suggestion)).toEqual(["move it"]);
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:approved" }, { episode_key: "x", state: "approved", started_at: T + 30, ended_at: null, source: "board", observed_at: T + 30 });
    await m.tick(T + 60);
    await m.tick(T + 700);
    await m.tick(T + 760);
    const held = cardsIn(s, "loop-studio.limit-").filter((c) => String(c.question).includes("now: text at the prompt"));
    expect(held).toHaveLength(1);
    expect(m.orca.of("terminal-close")).toEqual([]);
  });
});

describe("U5: a Studio whose account is switched off", () => {
  // The rig's Studio on acct-a with no notice on screen: only the switch moves it.
  function off(mode?: string): Store {
    const s = rig();
    if (mode) conf(s, "studio_move", mode);
    s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { tail: "❯ " });
    setAccountEnabled(s, { agent: "claude", account: "acct-a", enabled: false, by: "test" }, T - 60);
    return s;
  }

  test("auto: one move off it, with no stamp holding the account; switched on again, nothing more", async () => {
    const s = off(), d = decider(s, OTHER);
    await d.loop.tick(T);
    expect(s.get("episodes", { project: "fx", subject: STUDIO, kind: "limited" })).toMatchObject({ state: "disabled", episode_key: "claude/acct-a|account claude/acct-a is switched off" });
    expect(d.moves()).toHaveLength(1);
    expect(d.moves()[0]).toMatchObject({ subject: MOVE, member: STUDIO, payload: { handle: "term_s", account: "acct-b", from: "claude:acct-a" } });
    expect(d.cards()).toEqual([]);
    expect(studioMember(s).limited_until).toBeNull();
    expect(s.get("episodes", { project: "", subject: "limit|claude/acct-a", kind: "account" })).toBeNull();
    setAccountEnabled(s, { agent: "claude", account: "acct-a", enabled: true, by: "test" }, T + 30);
    s.db.run("DELETE FROM episodes WHERE project = 'fx' AND subject = ?", [MOVE]);   // no move in flight
    await d.loop.tick(T + 60);
    expect(d.moves()).toHaveLength(1);
    expect(s.get("episodes", { project: "fx", subject: STUDIO, kind: "limited" })!.state).toBe("closed");
  });

  test("ask: the \"move it\" card names the switch; off: the restart card, no move; mid-turn: nothing yet", async () => {
    const ask = off("ask"), d = decider(ask, OTHER);
    await d.loop.tick(T);
    expect(d.moves()).toEqual([]);
    expect(d.cards()[0]!.payload).toMatchObject({ title: "Studio's account switched off", option: "move it", fields: { move: true } });
    expect(String((d.cards()[0]!.payload as Row).text)).toStartWith("Studio's account claude/acct-a is switched off;");
    const no = off("off"), e = decider(no, OTHER);
    await e.loop.tick(T);
    expect(e.moves()).toEqual([]);
    expect(String((e.cards()[0]!.payload as Row).text)).toContain("restart it on claude:sonnet@acct-b");
    const busy = off(), f = decider(busy, OTHER);
    busy.upsert("observed_workers", { project: "fx", wt: STUDIO }, { state: "working" });
    await f.loop.tick(T);
    expect(f.moves()).toEqual([]);
    expect(f.cards()).toEqual([]);
  });
});

describe("moving the Studio (fulfil/studio.ts)", () => {
  test("closes only the Studio's tab, starts it on the pick briefed from its journal, records the new handle", async () => {
    const s = rig(), m = mover(s, OTHER);
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:approved" }, { episode_key: "x", state: "approved", started_at: T - 5, ended_at: null, source: "board", observed_at: T - 5 });
    await m.tick(T);
    expect(m.orca.of("terminal-close").map((c) => c.args)).toEqual([["term_s"]]);
    expect(m.orca.of("terminal-close-worktree")).toEqual([]);
    expect(m.orca.agents.map((a) => a.handle)).toContain("term_l");
    const start = m.orca.of("studio-start");
    expect(start).toHaveLength(1);
    expect(start[0]!.args.slice(0, 4)).toEqual([STUDIO, "acct-b", "sonnet", "-"]);
    expect(start[0]!.args[5]).toContain("journal.sh fx studio studio briefing");
    const handle = String(studioMember(s).handle);
    expect(handle).toMatch(/^term_\d+$/);
    expect(studioMember(s)).toMatchObject({ account: "acct-b", agent: "claude", model: "sonnet", limited_until: null });
    expect(payloads(s, "studio_moved")).toEqual([{ handle, previous: "term_s", from: "claude:acct-a", to: "claude:acct-b", model: "sonnet" }]);
    // The old tab reads gone at once (the coordinator re-binds a Run it held; adoption won't keep it).
    expect(s.get("observed_terminals", { project: "fx", handle: "term_s" })!.gone_at).toBe(T);
    expect(s.get("observed_terminals", { project: "fx", handle: "term_l" })!.gone_at).toBeNull();
    expect(s.get("episodes", { project: "fx", subject: MOVE, kind: "studio:approved" })!.ended_at).toBe(T);
    await m.tick(T + 60);
    expect(m.orca.of("terminal-close")).toHaveLength(1);
  });

  test("the guard is checked again right before the close: a line typed meanwhile closes nothing", async () => {
    const s = rig(), d = decider(s, OTHER);
    await d.loop.tick(T);
    const a = d.moves()[0]!;
    s.upsert("observed_terminals", { project: "fx", handle: "term_s" }, { tail: "│ ❯ wait │\n" });
    const orca = new FakeBackend(), act = new LoopActuator({ orca });
    const r = await studio.exec(a, { store: s, project: "fx", tick: 1, now: T + 5, fired: [], poked: new Set(), act });
    expect(r).toMatchObject({ done: true, result: "not moved: text at the prompt" });
    expect(orca.of("terminal-close")).toEqual([]);
    expect(studioMember(s).handle).toBe("term_s");
  });

  test("a replay never closes twice: after the close it only starts, after the start it does nothing", async () => {
    const s = rig(), d = decider(s, OTHER);
    await d.loop.tick(T);
    const a = d.moves()[0]!;
    const orca = new FakeBackend(), act = new LoopActuator({ orca });
    const x = { store: s, project: "fx", tick: 1, now: T + 5, fired: [], poked: new Set<string>(), act };
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:move" }, { episode_key: a.episode, state: "closed", started_at: T, source: "loop", observed_at: T });
    expect(await studio.exec(a, x)).toMatchObject({ done: true });
    expect(orca.of("terminal-close")).toEqual([]);
    expect(orca.of("studio-start")).toHaveLength(1);
    expect(await studio.exec(a, x)).toMatchObject({ done: true, result: "already started" });
    expect(orca.of("studio-start")).toHaveLength(1);
  });

  test("a handle that is no longer the Studio's, or a close that fails: nothing else is closed or started", async () => {
    const s = rig(), d = decider(s, OTHER);
    await d.loop.tick(T);
    const a = d.moves()[0]!;
    const orca = new FakeBackend(), act = new LoopActuator({ orca });
    const x = { store: s, project: "fx", tick: 1, now: T + 5, fired: [], poked: new Set<string>(), act };
    s.upsert("members", { id: studioMember(s).id }, { handle: "term_x" });
    expect(await studio.exec(a, x)).toMatchObject({ done: true, result: "not moved: term_s is no longer the Studio's terminal" });
    expect(orca.of("terminal-close")).toEqual([]);

    const s2 = rig(), d2 = decider(s2, OTHER);
    await d2.loop.tick(T);
    const o2 = new FakeBackend(); o2.closeFails.add("term_s");
    const r = await studio.exec(d2.moves()[0]!, { ...x, store: s2, act: new LoopActuator({ orca: o2 }) });
    expect(String((r as Row).result)).toContain("not moved:");
    expect(o2.of("studio-start")).toEqual([]);
    expect(studioMember(s2).handle).toBe("term_s");
    expect(payloads(s2, "studio_move_failed")).toMatchObject([{ handle: "term_s", step: "close" }]);
    expect(s2.get("episodes", { project: "fx", subject: MOVE, kind: "studio:move" })!.state).toBe("not moved");
  });

  test("a replay from \"closing\": a tab Orca no longer lists only starts; one still listed is guarded and closed once", async () => {
    for (const listed of [false, true]) {
      const s = rig(), d = decider(s, OTHER);
      await d.loop.tick(T);
      const a = d.moves()[0]!;
      const orca = new FakeBackend(); orca.agents = [{ wt: STUDIO, handle: "term_s", title: "claude" }];
      s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:move" }, { episode_key: a.episode, state: "closing", started_at: T, source: "loop", observed_at: T });
      if (!listed) s.upsert("observed_terminals", { project: "fx", handle: "term_s" }, { gone_at: T });
      expect(await studio.exec(a, { store: s, project: "fx", tick: 1, now: T + 5, fired: [], poked: new Set<string>(), act: new LoopActuator({ orca }) })).toMatchObject({ done: true });
      expect(orca.of("terminal-close")).toHaveLength(listed ? 1 : 0);
      expect(orca.of("studio-start")).toHaveLength(1);
    }
  });

  test("a replay from \"starting\" (a crash or a timed-out call): it records that start's tab, or waits, before starting again", async () => {
    const s = rig(), d = decider(s, OTHER);
    await d.loop.tick(T);
    const a = d.moves()[0]!;
    const orca = new FakeBackend(), act = new LoopActuator({ orca });
    const x = (now: number) => ({ store: s, project: "fx", tick: 1, now, fired: [], poked: new Set<string>(), act });
    s.upsert("observed_terminals", { project: "fx", handle: "term_s" }, { gone_at: T });
    s.upsert("members", { id: studioMember(s).id }, { handle: null });
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:move" }, { episode_key: a.episode, state: "starting", started_at: T, source: "loop", observed_at: T });
    // No new tab yet: the first start may still be running.
    expect(await studio.exec(a, x(T + 5))).toMatchObject({ wait: expect.any(String), at: T + 300 });
    expect(orca.of("studio-start")).toEqual([]);
    // That start's tab shows up: it becomes the Studio's, no second start.
    s.upsert("observed_terminals", { project: "fx", handle: "term_n" }, { wt: STUDIO, title: "claude", tail: "", tail_at: T + 9,
      doc: JSON.stringify({ identity: "claude", last_output_at: T + 9, unread: 0 }), gone_at: null, observed_at: T + 9 });
    expect(await studio.exec(a, x(T + 10))).toMatchObject({ done: true, result: "moved to claude:acct-b: term_n" });
    expect(orca.of("studio-start")).toEqual([]);
    expect(studioMember(s).handle).toBe("term_n");
    // With no tab past the window, it starts again.
    const s2 = rig(), d2 = decider(s2, OTHER);
    await d2.loop.tick(T);
    s2.upsert("observed_terminals", { project: "fx", handle: "term_s" }, { gone_at: T });
    s2.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:move" }, { episode_key: d2.moves()[0]!.episode, state: "starting", started_at: T, source: "loop", observed_at: T });
    expect(await studio.exec(d2.moves()[0]!, { ...x(T + 400), store: s2 })).toMatchObject({ done: true });
    expect(orca.of("studio-start")).toHaveLength(1);
  });

  test("a start that fails after the close: a card with the manual command, an event, no second close", async () => {
    const s = rig(), m = mover(s, OTHER);
    m.orca.fail("studio-start", { code: 1, out: "", err: "studio-start: the TUI never came up" });
    await m.tick(T);
    expect(m.orca.of("terminal-close")).toHaveLength(1);
    expect(payloads(s, "studio_move_failed")).toMatchObject([{ handle: "term_s", to: "claude:acct-b", step: "start" }]);
    const cards = cardsIn(s, `loop-${MOVE}-`);
    expect(cards).toHaveLength(1);
    expect(String(cards[0]!.question)).toContain("claude --model sonnet");
    await m.tick(T + 60);
    await m.tick(T + 600);
    expect(m.orca.of("terminal-close")).toHaveLength(1);
  });

  test("U270: a studio-start that never came up keeps its screen in a start_failed event; the card keeps only a pointer", async () => {
    const s = rig(), m = mover(s, OTHER);
    const failure = "claude on account acct-b never came up in wt_studio";
    const doc = { failure, worktree: "wt_studio", account: "acct-b", screen: "Error: ~/.claude.json is locked", orca: "exit 1" };
    m.orca.fail("studio-start", { code: 1, out: "", err: `orca adapter: ${failure}\norca adapter: start_failed ${JSON.stringify(doc)}\n` });
    await m.tick(T);
    expect(payloads(s, "start_failed")).toMatchObject([{ worktree: "wt_studio", account: "acct-b", screen: doc.screen }]);
    const id = (s.db.query("SELECT id FROM events WHERE kind = 'start_failed'").get() as { id: number }).id;
    const card = String(cardsIn(s, `loop-${MOVE}-`)[0]!.question);
    expect(card).toContain(`never came up in wt_studio (screen in event start_failed ${id})`);
    expect(card).not.toContain("start_failed {");
  });
});
