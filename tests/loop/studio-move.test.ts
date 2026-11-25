// studio-move.test.ts — U264: the Studio moved to another account on a limit. The limits reconciler
// (studio_move auto|ask|off, the studioReady guard, the hold, one move at a time) and the
// `studio-move` fulfiller (fulfil/studio.ts: only the Studio's own tab closed, studio-start on the
// pick, the new handle recorded, a failed start carded), on a temp copy of tests/fixtures/loop/state.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import studio, { claudePrompt } from "../../bin/loop/fulfil/studio.ts";
import { fakeContract, type FakeContract } from "../../bin/loop/fakes/contract.ts";
import { BACKEND_WANTED, MOVE, RESTART_APPROVED, START_WANTED, studioReady, wantStudioBackend, wantStudioStart } from "../../bin/loop/squad/studio.ts";
import studioRec from "../../bin/loop/reconcilers/studio.ts";
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

  test("claude-login-ended U2: auto, a Studio whose login ended is moved off the held account; ask names it on the card", async () => {
    const login = readFileSync(join(ROOT, "tests", "fixtures", "login", "claude-login-ended.txt"), "utf8");
    // U3 adds the login-ended card (login-card.ts); only the Studio's own cards are asserted here.
    const own = (x: { cards(): Action[] }) => x.cards().filter((c) => !c.subject.startsWith("login."));
    const s = rig(), d = decider(s, OTHER);
    s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { tail: login });
    await d.loop.tick(T);
    expect(s.get("episodes", { project: "fx", subject: STUDIO, kind: "limited" })?.state).toBe("login");
    expect(s.get("episodes", { project: "", subject: "login|claude/acct-a", kind: "account" })?.ended_at).toBe(T + 3600);
    expect(d.moves()).toHaveLength(1);
    expect(d.moves()[0]).toMatchObject({ subject: MOVE, member: STUDIO, payload: { handle: "term_s", account: "acct-b", from: "claude:acct-a" } });
    expect(own(d)).toEqual([]);
    const a = rig(), e = decider(a, OTHER);
    conf(a, "studio_move", "ask");
    a.upsert("observed_workers", { project: "fx", wt: STUDIO }, { tail: login });
    await e.loop.tick(T);
    expect(e.moves()).toEqual([]);
    expect(own(e)[0]!.payload).toMatchObject({ title: "Studio's login ended", option: "move it" });
    expect(String((own(e)[0]!.payload as Row).text)).toStartWith("Studio's account claude/acct-a: login ended");
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
    expect(payloads(s, "studio_moved")).toEqual([{ handle, previous: "term_s", from: "claude:acct-a", to: "claude:acct-b", model: "sonnet", why: "limit" }]);
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

describe("configurable-role-elevation U3: the Studio moves back up", () => {
  const TOP: Pick = { agent: "claude", model: "opus", effort: "-", account: "acct-b", fallback: false, rung: 1 };
  const LOW: Pick = { agent: "claude", model: "sonnet", effort: "-", account: "acct-a", fallback: true, rung: 2 };
  const ROW = "claude opus ondemand - claude:sonnet -";
  // The rig's Studio, not limited (no notice on screen), on rung 2 of its ladder (sonnet on acct-a), its
  // studio row `row` (column 8 `up` by default) and studio_move `mode` (auto by default).
  function low(o: { row?: string; mode?: string; model?: string; draft?: string } = {}): Store {
    const s = rig(o.draft ? { draft: o.draft } : {});
    s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { tail: "❯ " });
    s.upsert("members", { project: "fx", squad: "_studio", wt: STUDIO }, { model: o.model ?? "sonnet" });
    s.upsert("config", { project: "fx", file: "roles.conf", key: "studio" }, { value: o.row ?? `${ROW} up`, observed_at: T });
    if (o.mode) conf(s, "studio_move", o.mode);
    return s;
  }
  const upCards = (d: ReturnType<typeof decider>) => d.cards().filter((a) => a.subject === "studio.up");

  test("the default stay: no move, no card", async () => {
    const s = low({ row: ROW }), d = decider(s, TOP);
    await d.loop.tick(T);
    expect(d.moves()).toEqual([]);
    expect(d.cards()).toEqual([]);
  });

  test("up with auto: one move from rung 2 to rung 1 when ready, why back-up, picked for the studio role; no card", async () => {
    const s = low(), d = decider(s, TOP);
    await d.loop.tick(T);
    expect(d.calls.map((c) => [c.role, c.limited])).toEqual([["studio", undefined]]);
    expect(d.moves()).toHaveLength(1);
    expect(d.moves()[0]).toMatchObject({ subject: MOVE, member: STUDIO, payload: { handle: "term_s", agent: "claude", account: "acct-b", model: "opus",
      from: "claude:acct-a", why: "back-up", notice: "moving back up to opus" } });
    expect(d.cards()).toEqual([]);
  });

  test("not ready (text at the prompt, or busy): it waits with no time limit and never posts the held card", async () => {
    process.env.DS_LOOP_STUDIO_MOVE_HOLD_S = "600";
    const s = low({ draft: "half a thought" }), d = decider(s, TOP);
    for (const at of [T, T + 700, T + 1900, T + 7200]) await d.loop.tick(at);
    expect(d.moves()).toEqual([]);
    expect(d.cards()).toEqual([]);
    s.upsert("observed_terminals", { project: "fx", handle: "term_s" }, { tail: "│ ❯  │\n" });
    await d.loop.tick(T + 7300);
    expect(d.moves()).toHaveLength(1);
  });

  test("at most once per fallback_return_min: the studio:up marker holds the next one; 0 never moves", async () => {
    const s = low(), d = decider(s, TOP);
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:up" }, { episode_key: "x", state: "started", started_at: T, ended_at: T, source: "loop", observed_at: T });
    await d.loop.tick(T + 400);
    expect(d.moves()).toEqual([]);
    await d.loop.tick(T + 15 * 60 + 1);
    expect(d.moves()).toHaveLength(1);
    const z = low(), e = decider(z, TOP);
    conf(z, "fallback_return_min", "0");
    await e.loop.tick(T);
    expect(e.moves()).toEqual([]);
  });

  test("ask: one \"move it\" card on studio.up (move_up); once approved it moves as in auto; off: nothing", async () => {
    const s = low({ mode: "ask" }), d = decider(s, TOP);
    await d.loop.tick(T);
    await d.loop.tick(T + 60);
    expect(d.moves()).toEqual([]);
    expect(upCards(d)).toHaveLength(1);
    expect(upCards(d)[0]!.payload).toMatchObject({ card: "studio_move_up", option: "move it", fields: { move: true, move_up: true, acts_on_answer: true } });
    expect(String((upCards(d)[0]!.payload as Row).text)).toContain("claude:opus@acct-b");
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:up-approved" }, { episode_key: "x", state: "approved", started_at: T + 90, ended_at: null, source: "board", observed_at: T + 90 });
    await d.loop.tick(T + 120);
    expect(d.moves()).toHaveLength(1);
    expect(d.moves()[0]!.payload).toMatchObject({ why: "back-up" });
    const off = low({ mode: "off" }), e = decider(off, TOP);
    await e.loop.tick(T);
    expect(e.moves()).toEqual([]);
    expect(e.cards()).toEqual([]);
  });

  test("ask: the card and the approval clear once the move is no longer owed", async () => {
    const s = low({ mode: "ask" }), m = mover(s, TOP);
    await m.tick(T);
    expect(cardsIn(s, "loop-studio.up-")).toHaveLength(1);
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:up-approved" }, { episode_key: "x", state: "approved", started_at: T + 30, ended_at: null, source: "board", observed_at: T + 30 });
    s.upsert("config", { project: "fx", file: "roles.conf", key: "studio" }, { value: ROW });
    await m.tick(T + 60);
    expect(cardsIn(s, "loop-studio.up-")).toEqual([]);
    expect(s.get("episodes", { project: "fx", subject: MOVE, kind: "studio:up-approved" })!.ended_at).toBe(T + 60);
    expect(m.orca.of("terminal-close")).toEqual([]);
    // Owed again on the same place and rung: a new card, not the cleared one's key.
    s.upsert("config", { project: "fx", file: "roles.conf", key: "studio" }, { value: `${ROW} up` });
    await m.tick(T + 120);
    await m.tick(T + 180);
    expect(cardsIn(s, "loop-studio.up-")).toHaveLength(1);
  });

  test("a limited Studio takes the limit move, and its studio:approved is not cleared by the move-up", async () => {
    const s = low({ mode: "ask" });
    s.upsert("observed_workers", { project: "fx", wt: STUDIO }, { tail: notice });
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:approved" }, { episode_key: "x", state: "approved", started_at: T - 5, ended_at: null, source: "board", observed_at: T - 5 });
    const d = decider(s, OTHER);
    await d.loop.tick(T);
    expect(d.moves()).toHaveLength(1);
    expect(d.moves()[0]!.payload).toMatchObject({ why: "limit", account: "acct-b" });
    expect(upCards(d)).toEqual([]);
    expect(s.get("episodes", { project: "fx", subject: MOVE, kind: "studio:approved" })!.ended_at).toBeNull();
  });

  test("no move: rung 1 full (the pick stays on rung 2), an unplaceable Studio, rungs that differ only in effort, a Studio on rung 1", async () => {
    const cases: [Store, Pick][] = [
      [low(), LOW],
      [low({ model: "haiku" }), TOP],
      [low({ row: "claude opus ondemand high claude:opus:low - up", model: "opus" }), { ...TOP, rung: 1 }],
      [low({ model: "opus" }), TOP],
    ];
    for (const [s, p] of cases) {
      const d = decider(s, p);
      await d.loop.tick(T);
      expect(d.moves()).toEqual([]);
      expect(d.cards()).toEqual([]);
    }
  });

  test("moved back up: the new tab on the pick, studio_moved why back-up, studio:up stamped, studio:up-approved ended", async () => {
    const s = low({ mode: "ask" }), m = mover(s, TOP);
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:up-approved" }, { episode_key: "x", state: "approved", started_at: T - 5, ended_at: null, source: "board", observed_at: T - 5 });
    await m.tick(T);
    expect(m.orca.of("terminal-close").map((c) => c.args)).toEqual([["term_s"]]);
    const start = m.orca.of("studio-start");
    expect(start).toHaveLength(1);
    expect(start[0]!.args.slice(0, 3)).toEqual([STUDIO, "acct-b", "opus"]);
    expect(start[0]!.args[5]).toContain("moved back up from claude:acct-a to claude:acct-b");
    expect(payloads(s, "studio_moved")).toMatchObject([{ previous: "term_s", from: "claude:acct-a", to: "claude:acct-b", model: "opus", why: "back-up" }]);
    expect(studioMember(s)).toMatchObject({ account: "acct-b", model: "opus" });
    expect(s.get("episodes", { project: "fx", subject: MOVE, kind: "studio:up" })).toMatchObject({ state: "started", started_at: T });
    expect(s.get("episodes", { project: "fx", subject: MOVE, kind: "studio:up-approved" })!.ended_at).toBe(T);
  });

  test("the started move-up ends only studio:up-approved, never the limit path's studio:approved", async () => {
    const s = low({ mode: "ask" }), d = decider(s, TOP);
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:up-approved" }, { episode_key: "x", state: "approved", started_at: T - 5, ended_at: null, source: "board", observed_at: T - 5 });
    await d.loop.tick(T);
    const a = d.moves()[0]!;
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:approved" }, { episode_key: "y", state: "approved", started_at: T, ended_at: null, source: "board", observed_at: T });
    const orca = new FakeBackend(), act = new LoopActuator({ orca });
    expect(await studio.exec(a, { store: s, project: "fx", tick: 1, now: T + 5, fired: [], poked: new Set<string>(), act })).toMatchObject({ done: true });
    expect(s.get("episodes", { project: "fx", subject: MOVE, kind: "studio:up-approved" })!.ended_at).toBe(T + 5);
    expect(s.get("episodes", { project: "fx", subject: MOVE, kind: "studio:approved" })!.ended_at).toBeNull();
  });
});

describe("studio-hung-agent-broken U2: the operator's Restart Studio", () => {
  // The broken Studio's card as liveness.ts files it, stood in observed_alerts the way the observer keeps it.
  const card = (s: Store, handle = "term_s") => s.upsert("observed_alerts", { project: "fx", id: "loop-_studio-x" },
    { doc: JSON.stringify({ id: "loop-_studio-x", title: "Studio not responding", kind: "agent_broken", restart: true, handle, options: ["Restart Studio", "It's fine"] }), observed_at: T });
  const x = (s: Store, act = new LoopActuator({ orca: new FakeBackend() })) => ({ store: s, project: "fx", tick: 1, now: T, fired: [], poked: new Set<string>(), act });
  const answer = (s: Store, said?: string) => studio.exec({ project: "fx", squad: null, member: null, subject: "req:1", kind: "dismiss", episode: "req:1",
    payload: { id: "loop-_studio-x", ...(said === undefined ? {} : { answer: said }) } }, x(s));
  // The Studio reconciler with the real actuator and fulfillers over a fake Orca.
  function restarter(s: Store) {
    const orca = new FakeBackend();
    orca.agents = [{ wt: STUDIO, handle: "term_s", title: "claude" }, { wt: STUDIO, handle: "term_l", title: "ds-loop briefing" }];
    const act = new LoopActuator({ orca });
    const loop = new Loop(s, { observers: [], reconcilers: [studioRec] }, act, { projects: () => ["fx"] });
    return { orca, tick: async (at: number) => { await loop.tick(at); await act.drain(); } };
  }
  const approval = (s: Store) => s.get("episodes", { project: "fx", subject: MOVE, kind: RESTART_APPROVED });

  test("answered Restart Studio while it is not ready: one restart on its own account and model, its tab closed once, the approval ended", async () => {
    const s = rig({ draft: "half a thought" }), r = restarter(s);
    expect(studioReady(s, "fx", T).ready).toBe(false);
    card(s);
    expect(await answer(s, " restart studio ")).toMatchObject({ done: true });
    expect(approval(s)).toMatchObject({ state: "approved", ended_at: null, source: "board", result: "term_s" });
    expect(payloads(s, "studio_move_approved")).toEqual([{ alert: "loop-_studio-x", why: "restart", handle: "term_s" }]);
    await r.tick(T + 10);
    expect(r.orca.of("terminal-close").map((c) => c.args)).toEqual([["term_s"]]);
    const start = r.orca.of("studio-start");
    expect(start).toHaveLength(1);
    expect(start[0]!.args.slice(0, 4)).toEqual([STUDIO, "acct-a", "opus", "-"]);
    expect(start[0]!.args[5]).toContain("the operator restarted it from the board");
    const handle = String(studioMember(s).handle);
    expect(handle).toMatch(/^term_\d+$/);
    expect(studioMember(s)).toMatchObject({ account: "acct-a", agent: "claude", model: "opus" });
    expect(payloads(s, "studio_moved")).toEqual([{ handle, previous: "term_s", from: "claude:acct-a", to: "claude:acct-a", model: "opus", why: "restart" }]);
    expect(approval(s)).toMatchObject({ state: "ended", ended_at: T + 10 });
    await r.tick(T + 400);
    expect(r.orca.of("terminal-close")).toHaveLength(1);
    expect(r.orca.of("studio-start")).toHaveLength(1);
  });

  test("a restart whose close fails: nothing started, the approval ended, one Needs-you Studio move failed card", async () => {
    const s = rig({ draft: "half a thought" }), r = restarter(s);
    r.orca.closeFails.add("term_s");
    card(s);
    await answer(s, "Restart Studio");
    await r.tick(T + 10);
    expect(r.orca.of("studio-start")).toEqual([]);
    expect(approval(s)).toMatchObject({ state: "ended" });
    const cards = cardsIn(s, "loop-studio.move-");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "Studio move failed", kind: "restart_failed" });
    expect(String(cards[0]!.question)).toContain("could not close the Studio's tab term_s to restart it");
    await r.tick(T + 400);
    expect(r.orca.of("terminal-close")).toHaveLength(1);
  });

  test("a restart whose own claim ended without move() ending it: the approval is ended, nothing filed again", async () => {
    const s = rig({ draft: "half a thought" });
    card(s);
    await answer(s, "Restart Studio");
    const ep = `restart|term_s@${approval(s)!.started_at}`;
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "action:studio-move" }, { episode_key: ep, state: "failed", started_at: T, ended_at: T + 5, source: "loop", observed_at: T + 5 });
    const ctx = { store: s, project: "fx", tick: 1, now: T + 10, fired: [], poked: new Set() } as never;
    expect(studioRec.run(ctx).filter((y) => y.kind === "studio-move")).toEqual([]);
    expect(approval(s)).toMatchObject({ state: "ended", ended_at: T + 10 });
  });

  test("a replay of the restart closes nothing: after the close it only starts, after the start it does nothing", async () => {
    const s = rig({ draft: "half a thought" });
    card(s);
    await answer(s, "Restart Studio");
    const a = studioRec.run({ store: s, project: "fx", tick: 1, now: T + 5, fired: [], poked: new Set() } as never).find((y) => y.kind === "studio-move")!;
    expect(a.payload).toMatchObject({ handle: "term_s", agent: "claude", account: "acct-a", model: "opus", why: "restart" });
    const orca = new FakeBackend(), ex = x(s, new LoopActuator({ orca }));
    s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:move" }, { episode_key: a.episode, state: "closed", started_at: T, source: "loop", observed_at: T });
    expect(await studio.exec(a, ex)).toMatchObject({ done: true });
    expect(orca.of("terminal-close")).toEqual([]);
    expect(orca.of("studio-start")).toHaveLength(1);
    expect(await studio.exec(a, ex)).toMatchObject({ done: true, result: "already started" });
    expect(orca.of("terminal-close")).toEqual([]);
    expect(orca.of("studio-start")).toHaveLength(1);
  });

  test("It's fine, Dismiss or any other answer only clears the card: no approval, no move", async () => {
    for (const said of ["It's fine", undefined, "restarted it myself"]) {
      const s = rig(), r = restarter(s);
      card(s);
      expect(await answer(s, said)).toMatchObject({ done: true });
      expect(s.db.query("SELECT 1 FROM observed_alerts WHERE project = 'fx' AND id = 'loop-_studio-x'").get()).toBeNull();
      expect(approval(s)).toBeNull();
      await r.tick(T + 10);
      expect(r.orca.of("terminal-close")).toEqual([]);
      expect(r.orca.of("studio-start")).toEqual([]);
    }
  });

  test("an approval for a terminal that is no longer the Studio's ends with no move; a limit card's \"move it\" files no restart", async () => {
    const s = rig(), r = restarter(s);
    card(s, "term_old");
    await answer(s, "Restart Studio");
    await r.tick(T + 10);
    expect(r.orca.of("terminal-close")).toEqual([]);
    expect(approval(s)).toMatchObject({ state: "ended", ended_at: T + 10 });
    const u = rig(), ru = restarter(u);
    u.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:approved" }, { episode_key: "x", state: "approved", started_at: T - 5, ended_at: null, source: "board", observed_at: T - 5 });
    await ru.tick(T + 10);
    expect(ru.orca.of("terminal-close")).toEqual([]);
  });
});

// U52a (project-start): a Studio off Orca (dispatcher.json studio_backend tmux, a `local::` studio_wt) is closed
// by its own terminal id and started through the contract driver on the fake tmux; a shell beside it stays.
describe("U52a: start and restart a Studio off Orca", () => {
  const env = ["DS_ORCA_DATA", "DS_CLAUDE_SYSTEM_JSON_DIR", "DS_LOOP_STUDIO_PROMPT_S"] as const;
  const saved = Object.fromEntries(env.map((k) => [k, process.env[k]]));
  afterEach(() => { for (const k of env) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

  // The fake tmux, its Claude prompt shown once a launch line is typed (prompt: false keeps a bare shell).
  function tmux(prompt = true) {
    const fake = fakeContract({}, { name: "tmux", now: () => T });
    const backend = { caps: fake.caps, call: (async (op: string, req: { id?: string; text?: string }) => {
      const r = await fake.call(op as never, req as never);
      if (prompt && op === "terminal.send" && String(req.text ?? "").startsWith("exec bash")) fake.terms.get(req.id!)!.lines.push("╭───╮", "│ ❯ │", "╰───╯");
      return r;
    }) as FakeContract["call"] };
    return { fake, act: new LoopActuator({ orca: new FakeBackend(), fulfillers: [], backends: () => ({ backend, caps: fake.caps }) }) };
  }

  // The fixture project with its Studio on tmux in a temp folder: the Studio's terminal (DS_GEN g0, adopted,
  // idle at an empty prompt) and an operator's shell beside it.
  async function offRig(prompt = true) {
    const s = rig(), dir = mkdtempSync(join(tmpdir(), "zzstudiooff-")); temps.push(dir);
    mkdirSync(join(dir, "orca", "claude-profiles", "acct-b", "home"), { recursive: true });
    mkdirSync(join(dir, "orca", "claude-profiles", "acct-a", "home"), { recursive: true });
    process.env.DS_ORCA_DATA = join(dir, "orca");
    process.env.DS_CLAUDE_SYSTEM_JSON_DIR = join(dir, "orca");
    const path = join(dir, "studio"); mkdirSync(path);
    const wt = `local::${path}`, proj = s.get("projects", { label: "fx" })!;
    s.upsert("projects", { label: "fx" }, { studio_wt: wt, doc: JSON.stringify({ ...JSON.parse(String(proj.doc ?? "{}")), studio_backend: "tmux" }), observed_at: T });
    const t = tmux(prompt);
    const old = await t.fake.call("terminal.create", { cwd: path, env: { DS_GEN: "g0" }, label: "studio", group: "_studio" });
    const shell = await t.fake.call("terminal.create", { cwd: path, label: "shell" });
    if (!old.ok || !shell.ok) throw new Error("fake create");
    s.db.run("DELETE FROM members WHERE project = 'fx' AND squad = '_studio'");
    s.upsert("members", { project: "fx", squad: "_studio", wt }, { role: "studio", suffix: "", agent: "claude", model: "opus", account: "acct-a", handle: old.terminal.id, gen: "g0", status: "running", observed_at: T, updated_at: T });
    s.upsert("observed_terminals", { project: "fx", handle: old.terminal.id }, { wt, title: "_studio/studio", tail: "│ ❯  │\n", tail_at: T,
      doc: JSON.stringify({ identity: null, gen: "g0", last_output_at: T - 900, unread: 0 }), gone_at: null, observed_at: T });
    s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", tail: notice, tail_at: T, since: T - 900, last_output_at: T - 900, limited: null, gone_at: null, suspect: 0, observed_at: T });
    return { s, ...t, wt, path, old: old.terminal.id, shell: shell.terminal.id };
  }
  const move = (r: { s: Store; act: LoopActuator; old: string }, p: Row, episode = "e1") => studio.exec({ project: "fx", squad: null, member: null, subject: MOVE, kind: "studio-move", episode,
    payload: { handle: r.old, agent: "claude", model: "opus", effort: "-", ...p } }, { store: r.s, project: "fx", tick: 1, now: T + 10, fired: [], poked: new Set<string>(), act: r.act });
  const ops = (f: FakeContract, op: string) => f.calls.filter((c) => c.op === op).map((c) => c.req as Row);

  test("a restart closes only the Studio's terminal, starts one new Studio with the Studio's launch line, and records it", async () => {
    const r = await offRig();
    const res = await move(r, { account: "acct-a", from: "claude:acct-a", why: "restart" });
    const m = studioMember(r.s), handle = String(m.handle);
    expect(res).toEqual({ done: true, result: `moved to claude:acct-a: ${handle}` });
    expect(ops(r.fake, "terminal.close").map((c) => c.id)).toEqual([r.old]);
    expect(ops(r.fake, "terminal.create")).toHaveLength(3);   // the rig's two, then the new Studio's
    expect([...r.fake.terms.keys()].sort()).toEqual([r.shell, handle].sort());
    const made = r.fake.terms.get(handle)!;
    expect(made.t).toMatchObject({ cwd: r.path, label: "studio", group: "_studio" });
    expect(made.env).toMatchObject({ DS_BACKEND: "tmux", DS_WT: r.path, DS_MEMBER: "fx/_studio/studio" });
    expect(m).toMatchObject({ gen: made.env.DS_GEN, account: "acct-a", model: "opus" });
    const typed = String(ops(r.fake, "terminal.send").at(-1)!.text), file = /^exec bash '(.*)'$/.exec(typed)![1]!;
    const line = readFileSync(file, "utf8");
    expect(line).toContain("--model opus");
    expect(line).not.toContain("--effort");
    expect(line).toContain("--settings");
    expect(line.replace(/\\/g, "")).toContain("the operator restarted it from the board");
    expect(payloads(r.s, "studio_moved")).toEqual([{ handle, previous: r.old, from: "claude:acct-a", to: "claude:acct-a", model: "opus", why: "restart" }]);
    expect(await move(r, { account: "acct-a", from: "claude:acct-a", why: "restart" })).toMatchObject({ done: true, result: "already started" });
    expect(ops(r.fake, "terminal.create")).toHaveLength(3);
  });

  test("an account move gives one new Studio on the picked account in the same folder; the shell stays", async () => {
    const r = await offRig();
    expect(studioReady(r.s, "fx", T + 10).ready).toBe(true);
    expect(await move(r, { account: "acct-b", from: "claude:acct-a" })).toMatchObject({ done: true });
    const m = studioMember(r.s), made = r.fake.terms.get(String(m.handle))!;
    expect(m).toMatchObject({ account: "acct-b" });
    expect(made.t.cwd).toBe(r.path);
    expect(readFileSync(/^exec bash '(.*)'$/.exec(String(ops(r.fake, "terminal.send").at(-1)!.text))![1]!, "utf8")).toContain(join("claude-profiles", "acct-b", "home"));
    expect(r.fake.terms.has(r.shell)).toBe(true);
    expect(r.fake.terms.has(r.old)).toBe(false);
  });

  test("a replay after the start began gets that terminal back: no second Studio", async () => {
    const r = await offRig();
    expect(await move(r, { account: "acct-a", from: "claude:acct-a", why: "restart" })).toMatchObject({ done: true });
    const first = String(studioMember(r.s).handle);
    r.s.upsert("episodes", { project: "fx", subject: MOVE, kind: "studio:move" }, { episode_key: "e1", state: "starting", observed_at: T });
    expect(await move(r, { account: "acct-a", from: "claude:acct-a", why: "restart" })).toEqual({ done: true, result: `moved to claude:acct-a: ${first}` });
    expect(ops(r.fake, "terminal.create")).toHaveLength(3);
    expect(ops(r.fake, "terminal.close")).toHaveLength(1);
  });

  test("a Studio whose Claude prompt never shows is closed again and carded; the shell stays", async () => {
    process.env.DS_LOOP_STUDIO_PROMPT_S = "1";
    const r = await offRig(false);
    const res = await move(r, { account: "acct-a", from: "claude:acct-a", why: "restart" }) as { result: string };
    expect(res.result).toMatch(/^closed, not started: Claude's prompt did not show on its terminal within 1s$/);
    expect([...r.fake.terms.keys()]).toEqual([r.shell]);
    expect(ops(r.fake, "terminal.close")).toHaveLength(2);
    const cards = cardsIn(r.s, "loop-studio.move-");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "Studio move failed" });
    expect(studioMember(r.s).handle).toBeNull();
  });

  test("U53: a first start (why start) closes nothing and starts one Studio with the launch line; the shell stays", async () => {
    const r = await offRig();
    await r.fake.call("terminal.close", { cwd: r.path, id: r.old });
    r.s.db.run("UPDATE members SET handle = NULL, gen = NULL WHERE project = 'fx' AND squad = '_studio'");
    r.s.db.run("UPDATE observed_terminals SET gone_at = ? WHERE project = 'fx' AND handle = ?", [T, r.old]);
    const closes = ops(r.fake, "terminal.close").length;
    const res = await studio.exec({ project: "fx", squad: null, member: null, subject: MOVE, kind: "studio-move", episode: "s1",
      payload: { agent: "claude", account: "acct-a", model: "opus", effort: "-", from: "claude:acct-a", why: "start" } },
    { store: r.s, project: "fx", tick: 1, now: T + 10, fired: [], poked: new Set<string>(), act: r.act });
    const m = studioMember(r.s), handle = String(m.handle);
    expect(res).toEqual({ done: true, result: `moved to claude:acct-a: ${handle}` });
    expect(ops(r.fake, "terminal.close")).toHaveLength(closes);
    expect([...r.fake.terms.keys()].sort()).toEqual([r.shell, handle].sort());
    const made = r.fake.terms.get(handle)!;
    expect(made.env).toMatchObject({ DS_BACKEND: "tmux", DS_WT: r.path, DS_MEMBER: "fx/_studio/studio" });
    expect(m).toMatchObject({ gen: made.env.DS_GEN, account: "acct-a", model: "opus" });
    const file = /^exec bash '(.*)'$/.exec(String(ops(r.fake, "terminal.send").at(-1)!.text))![1]!;
    expect(readFileSync(file, "utf8").replace(/\\/g, "")).toContain("the operator started the project with `ds up`");
    expect(payloads(r.s, "studio_moved")).toEqual([{ handle, previous: null, from: "claude:acct-a", to: "claude:acct-a", model: "opus", why: "start" }]);
  });

  test("claudePrompt: Claude's input row, boxed or not; a shell's `> ` continuation is not one", () => {
    expect(claudePrompt("╭──╮\n│ ❯ │\n╰──╯")).toBe(true);
    expect(claudePrompt("❯ ")).toBe(true);
    expect(claudePrompt("│ > hello │")).toBe(true);
    expect(claudePrompt("$ exec bash '/x'\n> ")).toBe(false);
    expect(claudePrompt("user@host:~$ ")).toBe(false);
  });
});

// U54 (project-start): `ds up fx --backend herdr` on a project whose Studio runs on tmux. The new Studio starts on the
// fake herdr in the new folder, the old one is closed on the fake tmux, and the project switches: dispatcher.json,
// default_backend, the `_studio` row carried with its account history.
describe("U54: moving a project's Studio to another backend (why backend)", () => {
  const env = ["DS_ORCA_DATA", "DS_CLAUDE_SYSTEM_JSON_DIR"] as const;
  const saved = Object.fromEntries(env.map((k) => [k, process.env[k]]));
  afterEach(() => { for (const k of env) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

  function fake(name: string, crash: { close: number }) {
    const f = fakeContract({}, { name, now: () => T });
    const backend = { caps: f.caps, call: (async (op: string, req: { id?: string; text?: string }) => {
      if (op === "terminal.close" && crash.close > 0) { crash.close--; throw new Error("the loop died mid-close"); }
      const r = await f.call(op as never, req as never);
      if (op === "terminal.send" && String(req.text ?? "").startsWith("exec bash")) f.terms.get(req.id!)!.lines.push("╭───╮", "│ ❯ │", "╰───╯");
      return r;
    }) as FakeContract["call"] };
    return { f, backend };
  }

  async function rigMove(o: { crash?: number } = {}) {
    const s = rig(), dir = mkdtempSync(join(tmpdir(), "zzstudiobackend-")); temps.push(dir);
    mkdirSync(join(dir, "orca", "claude-profiles", "acct-a", "home"), { recursive: true });
    process.env.DS_ORCA_DATA = join(dir, "orca");
    process.env.DS_CLAUDE_SYSTEM_JSON_DIR = join(dir, "orca");
    const oldPath = join(dir, "studio"), newPath = join(dir, "studio-herdr"); mkdirSync(oldPath); mkdirSync(newPath);
    const wt = `local::${oldPath}`, newWt = `local::${newPath}`, proj = s.get("projects", { label: "fx" })!;
    s.upsert("projects", { label: "fx" }, { studio_wt: wt, doc: JSON.stringify({ ...JSON.parse(String(proj.doc ?? "{}")), studio_backend: "tmux" }), observed_at: T });
    s.db.run("UPDATE squads SET status = 'closed' WHERE project = 'fx'");
    s.upsert("config", { project: "fx", file: "limits.conf", key: "default_backend" }, { value: "tmux", observed_at: T });
    const crash = { close: o.crash ?? 0 }, tm = fake("tmux", crash), hd = fake("herdr", crash);
    const act = new LoopActuator({ orca: new FakeBackend(), fulfillers: [], backends: (name) => name === "herdr" ? { backend: hd.backend, caps: hd.f.caps } : { backend: tm.backend, caps: tm.f.caps } });
    const old = await tm.f.call("terminal.create", { cwd: oldPath, env: { DS_GEN: "g0" }, label: "studio", group: "_studio" });
    if (!old.ok) throw new Error("fake create");
    s.db.run("DELETE FROM members WHERE project = 'fx' AND squad = '_studio'");
    s.upsert("members", { project: "fx", squad: "_studio", wt }, { role: "studio", suffix: "", agent: "claude", model: "opus", account: "acct-a", limited_until: T + 3600,
      handle: old.terminal.id, gen: "g0", status: "running", observed_at: T, updated_at: T });
    s.upsert("observed_terminals", { project: "fx", handle: old.terminal.id }, { wt, title: "_studio/studio", tail: "│ ❯  │\n", tail_at: T,
      doc: JSON.stringify({ identity: null, gen: "g0", last_output_at: T - 900, unread: 0 }), gone_at: null, observed_at: T });
    const id = studioMember(s).id;
    const episode = wantStudioBackend(s, "fx", { backend: "herdr", provider: "git", wt: newWt }, T);
    return { s, act, tmux: tm.f, herdr: hd.f, wt, newWt, newPath, old: old.terminal.id, id, episode };
  }
  type R = Awaited<ReturnType<typeof rigMove>>;
  const actions = (r: R) => studioRec.run({ store: r.s, project: "fx", tick: 1, now: T + 5, fired: [], poked: new Set<string>() } as never)
    .filter((a) => a.kind === "studio-move");
  const go = (r: R, a: Action) => studio.exec(a, { store: r.s, project: "fx", tick: 1, now: T + 10, fired: [], poked: new Set<string>(), act: r.act });
  const ops = (f: FakeContract, op: string) => f.calls.filter((c) => c.op === op).map((c) => c.req as Row);
  const disp = (r: R) => JSON.parse(readFileSync(join(r.s.root, "fx", "dispatcher.json"), "utf8"));
  const wish = (r: R) => r.s.get("episodes", { project: "fx", subject: MOVE, kind: BACKEND_WANTED });

  test("the wish becomes one studio-move, why backend, on the Studio's own pick and handle", async () => {
    const r = await rigMove(), a = actions(r);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ episode: r.episode, member: r.wt, payload: { handle: r.old, agent: "claude", account: "acct-a", model: "opus", why: "backend", backend: "herdr", provider: "git", wt: r.newWt } });
  });

  test("tmux to herdr: one new Studio on herdr in the new folder, the old one closed on tmux, the project switched, account history kept", async () => {
    const r = await rigMove();
    const res = await go(r, actions(r)[0]!) as { result: string };
    const m = studioMember(r.s), handle = String(m.handle);
    expect(res.result).toBe(`moved to herdr: ${handle}`);
    expect([...r.herdr.terms.keys()]).toEqual([handle]);
    expect(r.herdr.terms.get(handle)!.env).toMatchObject({ DS_BACKEND: "herdr", DS_WT: r.newPath, DS_MEMBER: "fx/_studio/studio" });
    expect(ops(r.tmux, "terminal.close").map((c) => c.id)).toEqual([r.old]);
    expect([...r.tmux.terms.keys()]).toEqual([]);
    expect(m).toMatchObject({ id: r.id, wt: r.newWt, account: "acct-a", limited_until: T + 3600, model: "opus", gen: r.herdr.terms.get(handle)!.env.DS_GEN });
    expect(disp(r)).toMatchObject({ studio_backend: "herdr", studio_wt: r.newWt });
    expect(r.s.get("projects", { label: "fx" })).toMatchObject({ studio_wt: r.newWt });
    expect(r.s.get("config", { project: "fx", file: "limits.conf", key: "default_backend" })).toMatchObject({ value: "herdr" });
    expect(payloads(r.s, "studio_moved")).toEqual([expect.objectContaining({ handle, previous: r.old, why: "backend", backend: "herdr", was: "tmux", wt: r.newWt, old_wt: r.wt })]);
    expect(wish(r)).toMatchObject({ state: "ended" });
    expect(await go(r, actions(r)[0] ?? { project: "fx", squad: null, member: null, subject: MOVE, kind: "studio-move", episode: r.episode,
      payload: { agent: "claude", account: "acct-a", why: "backend", backend: "herdr", wt: r.newWt } })).toMatchObject({ done: true, result: "already started" });
    expect(ops(r.herdr, "terminal.create")).toHaveLength(1);
  });

  test("a crash between the start and the close: the replay starts nothing more and closes the old one: exactly one Studio", async () => {
    const r = await rigMove(), a = actions(r)[0]!, upsert = r.s.upsert.bind(r.s);
    // The loop dies as it records the close step: the new Studio runs, the old one too.
    r.s.upsert = ((t: string, k: Row, set: Row) => { if (set.state === "closing") throw new Error("the loop died"); return upsert(t, k, set); }) as Store["upsert"];
    await expect(go(r, a)).rejects.toThrow("the loop died");
    r.s.upsert = upsert;
    expect(r.s.get("episodes", { project: "fx", subject: MOVE, kind: "studio:move" })).toMatchObject({ state: "begun" });
    expect(r.herdr.terms.size + r.tmux.terms.size).toBe(2);
    expect(existsSync(join(r.s.root, "fx", "dispatcher.json")) ? disp(r).studio_backend : undefined).not.toBe("herdr");
    expect(await go(r, a)).toMatchObject({ done: true });
    expect(ops(r.tmux, "terminal.close").map((c) => c.id)).toEqual([r.old]);
    expect(ops(r.herdr, "terminal.create")).toHaveLength(1);
    expect(r.herdr.terms.size + r.tmux.terms.size).toBe(1);
    expect(studioMember(r.s)).toMatchObject({ id: r.id, wt: r.newWt, handle: [...r.herdr.terms.keys()][0] });
  });

  test("a close that fails: the project still switches to the new Studio, and one card names the old terminal to close", async () => {
    const r = await rigMove({ crash: 1 });
    expect(await go(r, actions(r)[0]!)).toMatchObject({ done: true });
    expect(disp(r)).toMatchObject({ studio_backend: "herdr", studio_wt: r.newWt });
    const cards = cardsIn(r.s, "loop-studio.move-");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "Old Studio still open" });
    expect(JSON.stringify(cards[0])).toContain(r.old);
  });

  test("a crash right after the start: the replay gets that terminal back from the ledger, no second Studio", async () => {
    const r = await rigMove(), a = actions(r)[0]!, upsert = r.s.upsert.bind(r.s);
    // The loop dies as it records the new terminal: the step stays "starting", nothing closed or switched.
    r.s.upsert = ((t: string, k: Row, set: Row) => { if (set.state === "begun") throw new Error("the loop died"); return upsert(t, k, set); }) as Store["upsert"];
    await expect(go(r, a)).rejects.toThrow("the loop died");
    r.s.upsert = upsert;
    expect(r.s.get("episodes", { project: "fx", subject: MOVE, kind: "studio:move" })).toMatchObject({ state: "starting" });
    expect(ops(r.tmux, "terminal.close")).toEqual([]);
    const first = [...r.herdr.terms.keys()][0]!;
    expect(await go(r, a)).toEqual({ done: true, result: `moved to herdr: ${first}` });
    expect(ops(r.herdr, "terminal.create")).toHaveLength(1);
    expect(ops(r.tmux, "terminal.close").map((c) => c.id)).toEqual([r.old]);
    expect(disp(r)).toMatchObject({ studio_backend: "herdr", studio_wt: r.newWt });
    expect(studioMember(r.s)).toMatchObject({ id: r.id, wt: r.newWt, handle: first });
    expect(r.s.db.query("SELECT COUNT(*) AS n FROM events WHERE kind = 'studio_moved'").get()).toMatchObject({ n: 1 });
  });

  test("a paused squad: not moved, naming it; nothing started, closed or switched", async () => {
    const r = await rigMove();
    const topic = String((r.s.db.query("SELECT topic FROM squads WHERE project = 'fx' ORDER BY topic LIMIT 1").get() as Row).topic);
    r.s.db.run("UPDATE squads SET status = 'suspended' WHERE project = 'fx' AND topic = ?", [topic]);
    const res = await go(r, actions(r)[0]!) as { result: string };
    expect(res.result).toContain(`squad ${topic} is still open on tmux (a paused squad counts)`);
    expect(ops(r.herdr, "terminal.create")).toEqual([]);
    expect(ops(r.tmux, "terminal.close")).toEqual([]);
    expect(studioMember(r.s)).toMatchObject({ wt: r.wt, handle: r.old });
    expect(r.s.get("config", { project: "fx", file: "limits.conf", key: "default_backend" })).toMatchObject({ value: "tmux" });
    expect(wish(r)).toMatchObject({ state: "ended" });
    expect(actions(r)).toEqual([]);
  });
});

describe("U53: ds up's first start of the Studio (why start)", () => {
  // The Studio reconciler with the real actuator and fulfillers over a fake Orca, as restarter() above.
  function starter(s: Store) {
    const orca = new FakeBackend();
    orca.agents = [{ wt: STUDIO, handle: "term_l", title: "ds-loop briefing" }];
    const act = new LoopActuator({ orca });
    const loop = new Loop(s, { observers: [], reconcilers: [studioRec] }, act, { projects: () => ["fx"] });
    return { orca, tick: async (at: number) => { await loop.tick(at); await act.drain(); } };
  }
  // The fixture project whose Studio is not running: no handle, its tab gone, only the ds-loop pane left.
  function fresh(): Store {
    const s = rig({ handle: null });
    s.db.run("UPDATE observed_terminals SET gone_at = ? WHERE project = 'fx' AND handle = 'term_s'", [T]);
    return s;
  }
  const wish = (s: Store) => s.get("episodes", { project: "fx", subject: MOVE, kind: START_WANTED });

  test("one studio-move on the wish's pick: studio-start once, briefed as started by ds up, nothing closed, the wish ended", async () => {
    const s = fresh(), r = starter(s);
    expect(wantStudioStart(s, "fx", { account: "acct-b", model: "sonnet", effort: "high" }, T)).toBe(`start@${T}`);
    await r.tick(T + 10);
    expect(r.orca.of("terminal-close")).toEqual([]);
    const start = r.orca.of("studio-start");
    expect(start).toHaveLength(1);
    expect(start[0]!.args.slice(0, 4)).toEqual([STUDIO, "acct-b", "sonnet", "high"]);
    expect(start[0]!.args[5]).toContain("the operator started the project with `ds up`");
    const handle = String(studioMember(s).handle);
    expect(handle).toMatch(/^term_\d+$/);
    expect(payloads(s, "studio_moved")).toEqual([{ handle, previous: null, from: "claude:acct-b", to: "claude:acct-b", model: "sonnet", why: "start" }]);
    expect(wish(s)).toMatchObject({ state: "ended", ended_at: T + 10 });
    await r.tick(T + 400);
    expect(r.orca.of("studio-start")).toHaveLength(1);
  });

  test("no pick in the wish: the default account and the roster's model, as studio-start's dashes", async () => {
    const s = fresh(), r = starter(s);
    wantStudioStart(s, "fx", {}, T);
    await r.tick(T + 10);
    expect(r.orca.of("studio-start")[0]!.args.slice(0, 4)).toEqual([STUDIO, "-", "-", "-"]);
    expect(studioMember(s)).toMatchObject({ account: null });
  });

  test("a Studio already running in the worktree: the wish ends with no start and no close", async () => {
    const s = rig(), r = starter(s);
    wantStudioStart(s, "fx", { account: "acct-a" }, T);
    await r.tick(T + 10);
    expect(r.orca.of("studio-start")).toEqual([]);
    expect(r.orca.of("terminal-close")).toEqual([]);
    expect(wish(s)).toMatchObject({ state: "running", ended_at: T + 10 });
  });

  test("a project whose Studio worktree the loop does not know yet: it waits, then starts once it is known", async () => {
    const s = fresh(), r = starter(s);
    s.upsert("projects", { label: "fx" }, { studio_wt: null, observed_at: T });
    wantStudioStart(s, "fx", { account: "acct-a" }, T);
    await r.tick(T + 10);
    expect(r.orca.of("studio-start")).toEqual([]);
    expect(wish(s)).toMatchObject({ ended_at: null });
    s.upsert("projects", { label: "fx" }, { studio_wt: STUDIO, observed_at: T });
    await r.tick(T + 20);
    expect(r.orca.of("studio-start")).toHaveLength(1);
  });

  test("a start that fails: one Studio start failed card with the manual command, the wish ended, never tried again", async () => {
    const s = fresh(), r = starter(s);
    r.orca.fail("studio-start", { code: 1, out: "", err: "studio-start: the TUI never came up" });
    wantStudioStart(s, "fx", { account: "acct-a", model: "opus" }, T);
    await r.tick(T + 10);
    expect(payloads(s, "studio_move_failed")).toMatchObject([{ handle: null, to: "claude:acct-a", step: "start" }]);
    const cards = cardsIn(s, `loop-${MOVE}-`);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ title: "Studio start failed" });
    expect(String(cards[0]!.question)).toContain("claude --model opus");
    expect(wish(s)).toMatchObject({ state: "ended" });
    await r.tick(T + 60);
    await r.tick(T + 600);
    expect(r.orca.of("studio-start")).toHaveLength(1);
    expect(r.orca.of("terminal-close")).toEqual([]);
  });
});
