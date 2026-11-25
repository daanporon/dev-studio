// studio-reload.test.ts — elsewhere-no-other-work U1: an update's reload reaches the Studio. update-squads finds
// the recorded Studio member (studioMember; the wishes themselves: tests/update-squads.sh), reconcilers/studio.ts
// types one reload line into the adopted handle only while studioReady() holds, the ack from that handle clears it,
// an old session's or another pane's ack is refused, and a Studio adopted after the wish satisfies it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { orcaObserver, type LiveTerminal } from "../../bin/loop/observers/orca.ts";
import studioReconciler, { reloadStudio, reloadStudioSkills, studioReloadText } from "../../bin/loop/reconcilers/studio.ts";
import { studioMember } from "../../bin/commands/update-squads-ts.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const RECORDED = join(ROOT, "tests", "fixtures", "loop", "orca");
const T = 1_800_000_000;
const W = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo";
const STUDIO = `${W}/ds-fx-studio`;

const temps: string[] = [], stores: Store[] = [];
let savedNow: string | undefined;
beforeEach(() => { savedNow = process.env.DS_NOW; process.env.DS_NOW = String(T); });
afterEach(() => {
  if (savedNow === undefined) delete process.env.DS_NOW; else process.env.DS_NOW = savedNow;
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const ctxOf = (s: Store, now: number): TickCtx => ({ store: s, project: "fx", tick: 1, now, fired: [], poked: new Set() });
const tab = (handle: string, title: string, agentIdentity: string | undefined): LiveTerminal =>
  ({ handle, worktreeId: STUDIO, title, agentIdentity, connected: true, writable: true, lastOutputAt: (T - 600) * 1000 });
const studio = (s: Store) => s.db.query("SELECT * FROM members WHERE project = 'fx' AND squad = '_studio'").get() as Row;

// The Studio adopted on term_s1 at T (a codex ds-loop pane and a shell beside it), idle with an empty prompt.
async function adopted(): Promise<Store> {
  const d = mkdtempSync(join(tmpdir(), "zzloop-"));
  temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  const o = FakeOrca.recorded(RECORDED);
  o.tabs = [tab("term_s1", "claude", "claude"), tab("term_s2", "ds-loop briefing", "codex"), tab("term_s3", "bash", undefined)];
  o.screens.set("term_s1", "│ ❯ │\n");
  const l = new Loop(s, { observers: [orcaObserver(o)], reconcilers: [] }, { act() {} }, { projects: () => ["fx"] });
  l.boot(T);
  await l.tick(T);
  await l.tick(T + 30);
  s.db.run("UPDATE requests SET done_at = ? WHERE project = 'fx' AND key LIKE 'file:fx/_studio/%'", [T]);
  return s;
}

describe("update-squads finds the Studio member", () => {
  test("a recorded live Studio is named; a gone one, another project or no loop.db is not", async () => {
    const s = await adopted();
    expect(studioMember(s.root, "fx")).toBe("fx/_studio/studio");
    expect(studioMember(s.root, "other")).toBeNull();
    s.db.run("UPDATE members SET status = 'gone' WHERE squad = '_studio'");
    expect(studioMember(s.root, "fx")).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), "zzloop-"));
    temps.push(empty);
    expect(studioMember(empty, "fx")).toBeNull();
  });
});

describe("the Studio's reload", () => {
  test("nothing pending: no line", async () => {
    const s = await adopted();
    expect(reloadStudio(ctxOf(s, T + 200))).toEqual([]);
  });

  test("one poke with the right text into the adopted handle once studioReady holds; none while it fails", async () => {
    const s = await adopted();
    s.wishOnce("fx/_studio/studio", "reload", { at: T + 100, by: "update-squads" });
    // Not ready (unread mail): nothing typed.
    s.db.run("UPDATE observed_terminals SET doc = json_patch(doc, '{\"unread\":1}') WHERE handle = 'term_s1'");
    expect(reloadStudio(ctxOf(s, T + 200))).toEqual([]);
    s.db.run("UPDATE observed_terminals SET doc = json_patch(doc, '{\"unread\":0}') WHERE handle = 'term_s1'");

    const ctx = ctxOf(s, T + 200);
    const acts = reloadStudio(ctx);
    expect(acts.length).toBe(1);
    const p = acts[0]!.payload as Row;
    expect(acts[0]).toMatchObject({ kind: "poke", member: STUDIO, squad: "_studio", episode: `reload:reload:${T + 100}#1` });
    expect(p).toMatchObject({ handle: "term_s1", reason: "reload", attempt: 1 });
    const text = String(p.text);
    expect(text).toBe(studioReloadText(s, "fx"));
    expect(text).toContain(`${ROOT}/AGENTS.md`);
    expect(text).toContain(`${ROOT}/studio/studio.md`);
    expect(text).not.toContain("roles/");
    expect(text).not.toContain("children");
    expect(text).toContain(`DS_STATE_ROOT='${s.root}'`);
    expect(text.endsWith(`'${ROOT}/bin/ds' 'reload' 'ack' 'fx' '_studio' 'studio' '-'`)).toBe(true);
    // The same tick, or the next within the backoff, types nothing more.
    expect(reloadStudio(ctx)).toEqual([]);
    expect(reloadStudio(ctxOf(s, T + 220))).toEqual([]);
    // The reconciler's run carries it beside the adoption card.
    expect(studioReconciler.run(ctxOf(s, T + 200 + 61)).some((a) => a.kind === "poke")).toBe(true);
  });

  test("the ack from the adopted handle clears it and no second line is typed; an old session's or another pane's ack is refused", async () => {
    const s = await adopted();
    s.wishOnce("fx/_studio/studio", "reload", { at: T + 100, by: "update-squads" });
    expect(reloadStudio(ctxOf(s, T + 200)).length).toBe(1);
    // The codex ds-loop pane in the same worktree is live but not the Studio.
    expect(() => s.acknowledgeReload("fx/_studio/studio", "term_s2", T + 250)).toThrow("adopted terminal");
    // An old Studio session's terminal, gone.
    s.upsert("observed_terminals", { project: "fx", handle: "term_old" }, { wt: STUDIO, gone_at: T - 10, observed_at: T - 10 });
    expect(() => s.acknowledgeReload("fx/_studio/studio", "term_old", T + 250)).toThrow("old session");
    expect(Number(studio(s).reloaded_at ?? 0)).toBe(0);

    s.acknowledgeReload("fx/_studio/studio", "term_s1", T + 250);
    expect(Number(studio(s).reloaded_at)).toBe(T + 250);
    expect(reloadStudio(ctxOf(s, T + 4000))).toEqual([]);
    expect(() => s.acknowledgeReload("fx/_studio/studio", "term_s1", T + 260)).toThrow("stale");
  });

  test("a Studio session adopted after the wish satisfies it without an ack; one adopted before does not", async () => {
    const s = await adopted();
    s.wishOnce("fx/_studio/studio", "reload", { at: T + 100, by: "update-squads" });
    // A move put a fresh Studio on term_s9 after the wish.
    process.env.DS_NOW = String(T + 300);
    s.fact("studio_moved", [{ table: "members", key: { id: Number(studio(s).id) }, set: { handle: "term_s9" } }],
      { project: "fx", squad: "_studio", member: STUDIO, payload: { handle: "term_s9", previous: "term_s1", from: null, to: "x", model: null } });
    expect(reloadStudio(ctxOf(s, T + 400))).toEqual([]);
    expect(Number(studio(s).reloaded_at)).toBe(T + 300);

    // The next wish is newer than that adoption: it is typed again.
    s.upsert("observed_terminals", { project: "fx", handle: "term_s9" }, { wt: STUDIO, tail: "│ ❯ │\n", tail_at: T + 300,
      doc: JSON.stringify({ last_output_at: T - 600 }), observed_at: T + 300 });
    s.wishOnce("fx/_studio/studio", "reload", { at: T + 500, by: "update-squads" });
    const acts = reloadStudio(ctxOf(s, T + 700));
    expect(acts.map((a) => (a.payload as Row).handle)).toEqual(["term_s9"]);
  });

  test("no adopted handle: no line, no error", async () => {
    const s = await adopted();
    s.wishOnce("fx/_studio/studio", "reload", { at: T + 100, by: "update-squads" });
    s.db.run("UPDATE members SET handle = NULL WHERE squad = '_studio'");
    expect(reloadStudio(ctxOf(s, T + 200))).toEqual([]);
  });
});

describe("the Studio's skills after an update (U3)", () => {
  const done = (s: Store, at: number, result: unknown, kind = "update") =>
    s.db.run("INSERT INTO requests (project, kind, payload, key, created_at, done_at, result) VALUES ('fx', ?, '{}', ?, ?, ?, ?)",
      [kind, `k${Math.random()}`, at - 10, at, JSON.stringify(result)]);
  const typed = (s: Store, now: number) => reloadStudioSkills(ctxOf(s, now)).map((a) => String((a.payload as Row).text));

  test("a done update with skills types /reload-skills once when ready, waits while not ready, never twice", async () => {
    const s = await adopted();
    done(s, T + 100, { ok: true, classes: ["skills", "instructions"] });
    s.db.run("UPDATE observed_terminals SET doc = json_patch(doc, '{\"unread\":1}') WHERE handle = 'term_s1'");
    expect(typed(s, T + 200)).toEqual([]);
    s.db.run("UPDATE observed_terminals SET doc = json_patch(doc, '{\"unread\":0}') WHERE handle = 'term_s1'");
    const ctx = ctxOf(s, T + 200);
    const acts = reloadStudioSkills(ctx);
    expect(acts.map((a) => (a.payload as Row).text)).toEqual(["/reload-skills"]);
    expect(acts[0]!.payload).toMatchObject({ handle: "term_s1", reason: "reload-skills" });
    expect(reloadStudioSkills(ctx)).toEqual([]);
    expect(typed(s, T + 300)).toEqual([]);
    expect(typed(s, T + 4000)).toEqual([]);
  });

  test("nothing for a request without skills, a failed or open one, a non-update, another Studio agent, or a Studio adopted after it", async () => {
    const s = await adopted();
    done(s, T + 100, { ok: true, classes: ["instructions"] });
    done(s, T + 110, { ok: false, error: "x", classes: ["skills"] });
    done(s, T + 120, { ok: true, classes: ["skills"] }, "restart");
    expect(typed(s, T + 200)).toEqual([]);
    // Adopted after the update finished: needs none.
    done(s, T + 130, { ok: true, classes: ["skills"] });
    process.env.DS_NOW = String(T + 150);
    s.fact("studio_moved", [{ table: "members", key: { id: Number(studio(s).id) }, set: { handle: "term_s9" } }],
      { project: "fx", squad: "_studio", member: STUDIO, payload: { handle: "term_s9", previous: "term_s1", from: null, to: "x", model: null } });
    s.upsert("observed_terminals", { project: "fx", handle: "term_s9" }, { wt: STUDIO, tail: "│ ❯ │\n", tail_at: T + 300, doc: JSON.stringify({ last_output_at: T - 600 }), observed_at: T + 300 });
    expect(typed(s, T + 400)).toEqual([]);
    // A newer update after that adoption is typed.
    done(s, T + 500, { ok: true, classes: ["skills"] });
    expect(typed(s, T + 600)).toEqual(["/reload-skills"]);
  });

  test("a Codex Studio gets nothing", async () => {
    const s = await adopted();
    done(s, T + 100, { ok: true, classes: ["skills"] });
    expect(typed(s, T + 200)).toEqual(["/reload-skills"]);
    s.db.run("UPDATE projects SET doc = json_patch(COALESCE(doc, '{}'), '{\"studio_agent\":\"codex\"}') WHERE label = 'fx'");
    expect(typed(s, T + 4000)).toEqual([]);
  });
});
