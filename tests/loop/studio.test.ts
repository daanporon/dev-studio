// studio.test.ts — U261: the project's running Studio adopted as a loop member (bin/loop/squad/studio.ts)
// through the Orca observer on a copy of tests/fixtures/loop/state: which terminal is adopted, the
// re-adoption after it goes, the `studio.adopt` card, the handle-only screen read, the studioReady
// guard, and the squad paths (decide, pause-all, export) that must leave the Studio alone.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { since } from "../../bin/loop/core/events.ts";
import { FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { orcaObserver, type LiveTerminal } from "../../bin/loop/observers/orca.ts";
import { promptDraft, studioReady } from "../../bin/loop/squad/studio.ts";
import { adoptCard } from "../../bin/loop/reconcilers/studio.ts";
import { decide } from "../../bin/loop/core/decide.ts";
import { pause } from "../../bin/loop/pause/pause.ts";
import { exportJson } from "../../bin/loop/db/export-json.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const RECORDED = join(ROOT, "tests", "fixtures", "loop", "orca");
const T = 1_800_000_000;
const W = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo";
const STUDIO = `${W}/ds-fx-studio`;

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzloop-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}
function loopOf(s: Store, orca: FakeOrca) {
  const l = new Loop(s, { observers: [orcaObserver(orca)], reconcilers: [] }, { act() {} }, { projects: () => ["fx"] });
  l.boot(T);
  return l;
}
const ctxOf = (s: Store, now = T): TickCtx => ({ store: s, project: "fx", tick: 1, now, fired: [], poked: new Set() });
const tab = (handle: string, title: string, agentIdentity: string | undefined, lastOutputAt = (T - 600) * 1000): LiveTerminal =>
  ({ handle, worktreeId: STUDIO, title, agentIdentity, connected: true, writable: true, lastOutputAt });
// AE1: the Studio's claude tab, a ds-loop pane running codex, a plain shell.
const AE1 = () => [tab("term_s1", "claude", "claude"), tab("term_s2", "ds-loop briefing", "codex"), tab("term_s3", "bash", undefined)];
const member = (s: Store) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = '_studio'").all() as Row[];
const facts = (s: Store, kind: string) => since(s, 0, { kinds: [kind] });

describe("adopting the Studio", () => {
  test("AE1: the claude tab is adopted, the codex ds-loop pane and the shell are not", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED);
    o.tabs = AE1();
    const cwd = STUDIO.slice(STUDIO.indexOf("::") + 2);
    o.procs = [{ cwd, agent: "codex", account: "codex-acct", kind: "main", pid: 1, start: T - 60 },
      { cwd, agent: "claude", account: "acct-studio", kind: "main", model: "claude-opus-5-5", pid: 2, start: T - 3600 }];
    await loopOf(s, o).tick(T);
    const m = member(s);
    expect(m.length).toBe(1);
    expect(m[0]).toMatchObject({ role: "studio", suffix: "", wt: STUDIO, agent: "claude", handle: "term_s1", status: "running", account: "acct-studio" });
    expect(facts(s, "studio_adopted").map((e) => JSON.parse(String(e.payload)))).toEqual([{ handle: "term_s1", agent: "claude", previous: null }]);
    expect(adoptCard(ctxOf(s))).toEqual([]);
  });

  test("two claude tabs: nothing adopted, one card naming both, no second card on the next tick", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    o.tabs = [tab("term_s1", "claude", "claude"), tab("term_s4", "claude", "claude"), tab("term_s2", "ds-loop briefing", "codex")];
    await l.tick(T);
    expect(member(s)).toEqual([]);
    const a = adoptCard(ctxOf(s));
    expect(a.length).toBe(1);
    expect(a[0]).toMatchObject({ subject: "studio.adopt", kind: "alert", episode: `adopt|${STUDIO}` });
    const text = String((a[0]!.payload as Row).text);
    expect(text).toContain("term_s1");
    expect(text).toContain("term_s4");
    expect(text).not.toContain("term_s2");
    // The actuator's claim of that action: standing, so the next tick files nothing.
    s.upsert("episodes", { project: "fx", subject: "studio.adopt", kind: "action:alert" }, { episode_key: a[0]!.episode, started_at: T, source: "loop", observed_at: T });
    await l.tick(T + 30);
    expect(adoptCard(ctxOf(s, T + 30))).toEqual([]);
    // One tab closed: the other is adopted and the card cleared.
    o.tabs = [tab("term_s4", "claude", "claude"), tab("term_s2", "ds-loop briefing", "codex")];
    await l.tick(T + 60);
    expect(member(s)[0]?.handle).toBe("term_s4");
    expect(adoptCard(ctxOf(s, T + 60))).toEqual([{ project: "fx", squad: null, member: STUDIO, subject: "studio.adopt", kind: "alert-clear",
      episode: `cleared@adopt|${STUDIO}`, payload: { target: "project", prefix: "sweep-studio.adopt-" } }]);
  });

  test("no Studio terminal: the card lists the worktree's terminals", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED);
    o.tabs = [tab("term_s2", "ds-loop briefing", "codex"), tab("term_s3", "bash", undefined)];
    await loopOf(s, o).tick(T);
    const text = String((adoptCard(ctxOf(s))[0]!.payload as Row).text);
    expect(text).toContain("No claude terminal");
    expect(text).toContain("term_s2 (ds-loop briefing, codex)");
    expect(text).toContain("term_s3 (bash)");
  });

  test("the recorded handle wins over a second candidate; gone, it is released and the next one adopted", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    o.tabs = AE1();
    await l.tick(T);
    o.tabs = [...AE1(), tab("term_s4", "renamed", "claude")];
    await l.tick(T + 30);
    expect(member(s)[0]?.handle).toBe("term_s1");
    // term_s1 closed while two claude tabs remained, then one of them is closed too.
    o.tabs = [tab("term_s4", "claude", "claude"), tab("term_s5", "claude", "claude")];
    await l.tick(T + 60);
    expect(member(s)[0]?.handle).toBeNull();
    expect(facts(s, "studio_released").length).toBe(1);
    o.tabs = [tab("term_s5", "claude", "claude")];
    await l.tick(T + 90);
    expect(member(s).map((m) => m.handle)).toEqual(["term_s5"]);
    expect(JSON.parse(String(facts(s, "studio_adopted").at(-1)!.payload))).toMatchObject({ handle: "term_s5", previous: null });
  });

  test("a recorded tab whose Studio quit to a shell is let go, and the new Studio tab adopted", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    o.tabs = AE1();
    await l.tick(T);
    o.tabs = [tab("term_s1", "bash"), tab("term_s4", "claude", "claude")];
    await l.tick(T + 30);
    expect(member(s).map((m) => m.handle)).toEqual(["term_s4"]);
    expect(JSON.parse(String(facts(s, "studio_adopted").at(-1)!.payload))).toMatchObject({ handle: "term_s4", previous: "term_s1" });
  });

  test("a listing that fails leaves the adoption alone", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    o.tabs = AE1();
    await l.tick(T);
    o.terminals = async () => { throw new Error("terminal list: timeout"); };
    await l.tick(T + 30);
    expect(member(s)[0]?.handle).toBe("term_s1");
  });

  test("dispatcher.json's studio_handle is the recorded handle", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED);
    s.db.run("UPDATE projects SET doc = json_set(COALESCE(doc, '{}'), '$.studio_handle', 'term_s4') WHERE label = 'fx'");
    o.tabs = [tab("term_s1", "claude", "claude"), tab("term_s4", "claude", "claude")];
    await loopOf(s, o).tick(T);
    expect(member(s)[0]?.handle).toBe("term_s4");
  });
});

describe("the Studio's screen", () => {
  test("is read by its handle only, and not at all while none is adopted", async () => {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    o.tabs = [tab("term_s1", "claude", "claude"), tab("term_s4", "claude", "claude")];
    await l.tick(T);
    expect(o.calls.screenTail.filter((x) => x === STUDIO || x.startsWith("term_s"))).toEqual([]);
    o.tabs = AE1();
    o.screens.set("term_s1", "some output\n╭──╮\n│ ❯  │\n╰──╯\n");
    o.reset();
    await l.tick(T + 30);
    expect(o.calls.screenTail).toContain("term_s1");
    expect(o.calls.screenTail).not.toContain(STUDIO);
    const t = s.get("observed_terminals", { project: "fx", handle: "term_s1" })!;
    expect([t.tail_at, promptDraft(String(t.tail))]).toEqual([T + 30, ""]);
    // No new output since: not read again.
    o.reset();
    await l.tick(T + 60);
    expect(o.calls.screenTail).not.toContain("term_s1");
  });
});

describe("studioReady", () => {
  async function adopted(screen = "│ ❯ │\n") {
    const s = imported(), o = FakeOrca.recorded(RECORDED), l = loopOf(s, o);
    o.tabs = AE1();
    o.screens.set("term_s1", screen);
    await l.tick(T);
    await l.tick(T + 30);
    // The fixture's request file for the Studio (requests/_studio/) was handled.
    s.db.run("UPDATE requests SET done_at = ? WHERE project = 'fx' AND key LIKE 'file:fx/_studio/%'", [T]);
    return { s, o, l };
  }

  test("an idle Studio with an empty prompt is ready", async () => {
    const { s } = await adopted();
    expect(studioReady(s, "fx", T + 60)).toEqual({ ready: true, why: "idle" });
  });

  test("not ready: busy, a draft at the prompt, unread mail, a pending request, an open question, no adoption", async () => {
    const draft = await adopted("│ ❯ half a thought │\n");
    expect(studioReady(draft.s, "fx", T + 60)).toMatchObject({ ready: false, why: "text at the prompt" });

    const { s } = await adopted();
    expect(studioReady(s, "fx", T - 500)).toMatchObject({ ready: false, why: "busy: terminal output" });
    const doc = (patch: Row) => s.db.run("UPDATE observed_terminals SET doc = json_patch(doc, ?) WHERE handle = 'term_s1'", [JSON.stringify(patch)]);
    doc({ unread: 1 });
    expect(studioReady(s, "fx", T + 60)).toMatchObject({ ready: false, why: "unread mail" });
    doc({ unread: 0 });
    s.upsert("requests", { key: "file:fx/_studio/board-spawn-x-1.txt" }, { project: "fx", squad: null, kind: "file", requested_by: "board", created_at: T });
    expect(studioReady(s, "fx", T + 60)).toMatchObject({ ready: false, why: "a request waits for the Studio" });
    s.db.run("UPDATE requests SET done_at = ? WHERE key = 'file:fx/_studio/board-spawn-x-1.txt'", [T]);
    expect(studioReady(s, "fx", T + 60).ready).toBe(true);
    s.db.run("INSERT INTO questions (id, project, squad, asker, status) VALUES ('q-studio', 'fx', 'demo', ?, 'open')", [STUDIO]);
    expect(studioReady(s, "fx", T + 60)).toMatchObject({ ready: false, why: "an open question from the Studio" });
    s.db.run("UPDATE questions SET status = 'answered' WHERE id = 'q-studio'");
    expect(studioReady(s, "fx", T + 60).ready).toBe(true);
    doc({ last_output_at: T + 40 });
    expect(studioReady(s, "fx", T + 200)).toMatchObject({ ready: false, why: "screen not read since its last output" });
    doc({ last_output_at: T - 600 });
    s.db.run("UPDATE members SET handle = NULL WHERE squad = '_studio'");
    expect(studioReady(s, "fx", T + 60)).toMatchObject({ ready: false, why: "no Studio terminal adopted" });
  });

  test("promptDraft reads the last prompt row, boxed or not", () => {
    expect(promptDraft("> \n")).toBe("");
    expect(promptDraft("│ > draft text   │\n│ footer │")).toBe("draft text");
    expect(promptDraft("❯ old\n…\n› \n")).toBe("");
    expect(promptDraft("no prompt here")).toBeNull();
  });
});

describe("squad paths leave the Studio alone", () => {
  async function withStudio() {
    const s = imported(), o = FakeOrca.recorded(RECORDED);
    o.tabs = AE1();
    await loopOf(s, o).tick(T);
    expect(member(s).length).toBe(1);
    return s;
  }

  test("decide emits no start, stop or switch for the _studio member, whatever its want", async () => {
    const s = await withStudio();
    for (const [want, status] of [["running", "gone"], ["stopped", "running"], ["gone", "running"]]) {
      s.db.run("UPDATE members SET want = ?, status = ?, want_at = ? WHERE squad = '_studio'", [want, status, T]);
      expect(decide(ctxOf(s, T + 30)).filter((a) => a.squad === "_studio" || a.member === STUDIO)).toEqual([]);
    }
  });

  test("pause-all pauses no Studio", async () => {
    const s = await withStudio();
    pause(s, { scope: "project", project: "fx" }, {}, T + 30);
    expect(s.db.query("SELECT * FROM pause_members WHERE project = 'fx' AND (squad = '_studio' OR role = 'studio')").all()).toEqual([]);
  });

  test("ds export writes no _studio.json", async () => {
    const s = await withStudio();
    const r = exportJson(s);
    expect([...r.written, ...r.unchanged].filter((p) => p.includes("_studio"))).toEqual([]);
    expect(existsSync(join(s.root, "fx", "squads", "_studio.json"))).toBe(false);
  });
});
