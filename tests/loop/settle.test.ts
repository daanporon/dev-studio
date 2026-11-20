// settle.test.ts — U56: the board drops what is no longer true. Each test works on an empty temp
// state root with one project; rows are written as the observers write them, and a Loop with a
// recording actuator stands for the tick (requests.ts settles switch/restart requests, alerts.ts
// answers stale usage-limit questions and returns `alert-clear` for stale Studio alerts).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import type { Action, Actuator, Reconciler } from "../../bin/loop/core/plugins.ts";
import alerts from "../../bin/loop/reconcilers/alerts.ts";
import requests from "../../bin/loop/reconcilers/requests.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const L = "lbl";
const T = 1_800_000_000;
const ws = (n: string) => `id::/home/me/ws/ds-${L}-${n}`;
const LEAD = ws("lead-auth"), BUILDER = ws("builder-u2-auth"), STUDIO = ws("studio");
const iso = (t: number) => new Date(t * 1000).toISOString();

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function root(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzloop-"));
  temps.push(d);
  mkdirSync(join(d, L, "squads"), { recursive: true });
  const s = open(d);
  stores.push(s);
  importConfig(s, d);
  s.upsert("projects", { label: L }, { studio_wt: STUDIO, observed_at: T });
  s.upsert("squads", { project: L, topic: "auth" }, { status: "running", doc: JSON.stringify({ topic: "auth", status: "running" }), observed_at: T, updated_at: T });
  member(s, "lead", "", LEAD);
  member(s, "builder", "u2", BUILDER);
  return s;
}
function member(s: Store, role: string, suffix: string, wt: string, set: Row = {}) {
  s.upsert("members", { project: L, squad: "auth", wt }, { role, suffix, status: "running", since: iso(T - 3600), observed_at: T, updated_at: T, ...set });
  worker(s, wt);
}
function worker(s: Store, wt: string, set: Row = {}) {
  s.upsert("observed_workers", { project: L, wt }, { state: "working", since: T - 600, unread: 0, observed_at: T, gone_at: null, ...set });
  s.upsert("observed_worktrees", { project: L, wt }, { doc: JSON.stringify({ agents: 1 }), observed_at: T, gone_at: null });
}
// A request file and its row, as the state observer imports it (requestRows).
function requestFile(s: Store, name: string, text: string, at: number, target = "auth") {
  const rel = join(L, "requests", target, name);
  mkdirSync(join(s.root, L, "requests", target), { recursive: true });
  writeFileSync(join(s.root, rel), text);
  const kind = text.startsWith("switch:") ? "switch" : "restart";
  s.upsert("requests", { key: `file:${L}/${target}/${name}` }, { project: L, squad: target, kind, payload: JSON.stringify({ file: rel, text }), requested_by: "sweep", created_at: at });
  return rel;
}
const reqRow = (s: Store, rel: string) => s.db.query("SELECT done_at, result FROM requests WHERE json_extract(payload, '$.file') = ?").get(rel) as Row;
function question(s: Store, id: string, at: number, text = "builder-u2 of auth (usage limit on acct-a: resets 14:00) — restart it on acct-b") {
  s.db.run("INSERT INTO questions (id, project, squad, asker, question, asked_at, status) VALUES (?, ?, 'auth', 'sweep', ?, ?, 'open')", [id, L, text, at]);
}
const questionsOf = (s: Store) => s.db.query("SELECT id, status, answered_via FROM questions ORDER BY asked_at").all() as Row[];
function alert(s: Store, id: string, text: string, since: number) {
  s.upsert("observed_alerts", { project: L, id }, { doc: JSON.stringify({ id, asker: "sweep", title: "Agent broken", question: text, since: iso(since) }), observed_at: T });
}
function loopOf(s: Store, ...reconcilers: Reconciler[]) {
  const got: Action[] = [], rec: Actuator = { act(a) { got.push(a); } };
  const loop = new Loop(s, { observers: [], reconcilers }, rec, { projects: () => [L] });
  return async (at: number) => (await loop.tick(at)).acted;
}
const dropped = (acted: Action[]) => acted.filter((a) => a.kind === "alert-clear").map((a) => (a.payload as Row).id);

describe("switch and restart requests", () => {
  test("a switch request for a member no longer limited is settled in one tick", async () => {
    const s = root();
    const rel = requestFile(s, "auth.builder-u2-1799990000.txt", "switch: restart builder-u2 of auth on the next pick — run: x\n", T - 600, "auth");
    await loopOf(s, requests)(T);
    expect(reqRow(s, rel)).toEqual({ done_at: T, result: "member no longer limited" });
    expect(existsSync(join(s.root, rel)), "the file is gone").toBe(false);
  });
  test("obsolete early-switch files are removed even while their member is limited", async () => {
    const s = root();
    s.db.run("UPDATE members SET limited_until = ? WHERE wt = ?", [T + 3600, BUILDER]);
    const rel = requestFile(s, "auth.builder-u2-1799990000.txt", "switch: restart builder-u2 of auth (early, while idle: account at 90%) — run: x\n", T - 600);
    await loopOf(s, requests)(T);
    expect(reqRow(s, rel)).toEqual({ done_at: T, result: "early switching removed" });
    expect(existsSync(join(s.root, rel))).toBe(false);
  });
  test("an expired limit (its dialog still on screen) counts as limited", async () => {
    const s = root();
    s.upsert("episodes", { project: L, subject: BUILDER, kind: "limited" }, { state: "expired", episode_key: "k", source: "loop", started_at: T - 7200, observed_at: T });
    const rel = requestFile(s, "auth.builder-u2-1799990000.txt", "switch: restart builder-u2 of auth — run: x\n", T - 600);
    await loopOf(s, requests)(T);
    expect(reqRow(s, rel).done_at).toBeNull();
  });
  test("a switch request for a still-limited member stays; an older twin is superseded", async () => {
    const s = root();
    s.db.run("UPDATE members SET limited_until = ? WHERE wt = ?", [T + 3600, BUILDER]);
    const old = requestFile(s, "auth.builder-u2-1799980000.txt", "switch: restart builder-u2 of auth — run: x\n", T - 1200);
    const fresh = requestFile(s, "auth.builder-u2-1799990000.txt", "switch: restart builder-u2 of auth — run: x\n", T - 600);
    await loopOf(s, requests)(T);
    expect(reqRow(s, fresh)).toEqual({ done_at: null, result: null });
    expect(reqRow(s, old)).toEqual({ done_at: T, result: "superseded by a newer request" });
  });
  test("a restart request whose member runs again, or no longer exists, is settled; a still-broken one stays", async () => {
    const s = root();
    const back = requestFile(s, "auth.builder-u2-1799999000.txt", "restart builder-u2 of auth (exited since 09:00)\n", T - 300);
    const gone = requestFile(s, "auth.tester-1799999000.txt", "restart tester of auth (exited since 09:00)\n", T - 300);
    const waiting = requestFile(s, "_studio-1799999000.txt", "restart lead of auth (exited since 09:00)\n", T - 300, "_operator");
    const hung = requestFile(s, "auth.lead-1799999000.txt", "restart lead of auth (hung since 09:00)\n", T - 300);
    s.upsert("observed_workers", { project: L, wt: LEAD }, { since: T - 3600, last_output_at: T - 3600 });
    await loopOf(s, requests)(T);
    expect(reqRow(s, back).result).toBe("member runs again");
    expect(reqRow(s, hung).done_at, "hung with no output since: still broken").toBeNull();
    expect(reqRow(s, gone).result).toBe("member no longer exists");
    expect(reqRow(s, waiting).done_at, "a key without a member is left alone").toBeNull();
  });
});

describe("usage-limit questions", () => {
  test("a duplicate limit question is closed and the newest kept", async () => {
    const s = root();
    s.db.run("UPDATE members SET limited_until = ? WHERE wt = ?", [T + 3600, BUILDER]);
    question(s, "sweep-auth.builder-u2-111", T - 1200);
    question(s, "sweep-auth.builder-u2-222", T - 600);
    question(s, "lead-q1", T - 300, "which usage limit should we raise?");
    await loopOf(s, alerts)(T);
    expect(questionsOf(s)).toEqual([
      { id: "sweep-auth.builder-u2-111", status: "answered", answered_via: "reality" },
      { id: "sweep-auth.builder-u2-222", status: "open", answered_via: null },
      { id: "lead-q1", status: "open", answered_via: null },
    ]);
  });
  test("a limit question for a member no longer limited is resolved", async () => {
    const s = root();
    question(s, "sweep-auth.builder-u2-111", T - 600);
    await loopOf(s, alerts)(T);
    expect(questionsOf(s)[0]).toMatchObject({ status: "answered", answered_via: "reality" });
  });
});

describe("Studio alerts", () => {
  test("obsolete Studio early warnings are cleared for loop and imported sweep alerts", async () => {
    const s = root();
    for (const id of ["loop-studio.early-abc", "sweep-studio.early-123"]) alert(s, id, "Studio at 93% — restart it on another account", T - 60);
    expect(dropped(await loopOf(s, alerts)(T))).toEqual(["loop-studio.early-abc", "sweep-studio.early-123"]);
  });
  test("a Studio-exited alert is dropped once the Studio runs, kept while it does not", async () => {
    const s = root();
    alert(s, "loop-_studio-abc", "studio (exited since 09:00) — nobody above it can restart it", T - 600);
    s.upsert("observed_worktrees", { project: L, wt: STUDIO }, { doc: JSON.stringify({ agents: 0 }), observed_at: T, gone_at: null });
    s.upsert("observed_workers", { project: L, wt: STUDIO }, { state: "idle", observed_at: T, gone_at: null });
    const tick = loopOf(s, alerts);
    expect(dropped(await tick(T)), "still exited: kept").toEqual([]);
    s.upsert("observed_worktrees", { project: L, wt: STUDIO }, { doc: JSON.stringify({ agents: 1 }), observed_at: T, gone_at: null });
    expect(dropped(await tick(T + 60))).toEqual(["loop-_studio-abc"]);
    expect(dropped(await tick(T + 120)), "once per alert").toEqual([]);
  });
  test("a still-true alert stays past a day; a hung member's alert goes once it gives output", async () => {
    const s = root();
    s.upsert("observed_worktrees", { project: L, wt: STUDIO }, { doc: JSON.stringify({ agents: 0 }), observed_at: T, gone_at: null });
    s.upsert("observed_workers", { project: L, wt: STUDIO }, { state: "idle", observed_at: T, gone_at: null });
    alert(s, "loop-_studio-abc", "studio (exited since 09:00) — nobody above it can restart it", T - 3 * 86_400);
    alert(s, "loop-auth.lead-h", "lead of auth (hung since 09:00) — nobody above it can restart it", T - 600);
    s.upsert("observed_workers", { project: L, wt: LEAD }, { since: T - 3600, last_output_at: T - 3600 });
    const tick = loopOf(s, alerts);
    expect(dropped(await tick(T)), "both still true").toEqual([]);
    s.upsert("observed_workers", { project: L, wt: LEAD }, { last_output_at: T + 30 });
    expect(dropped(await tick(T + 60))).toEqual(["loop-auth.lead-h"]);
  });
  test("a day-old alert with no repeat is dropped; a still-true one is kept", async () => {
    const s = root();
    s.upsert("observed_workers", { project: L, wt: BUILDER }, { state: "idle", observed_at: T, gone_at: null });
    s.upsert("observed_worktrees", { project: L, wt: BUILDER }, { doc: JSON.stringify({ agents: 0 }), observed_at: T, gone_at: null });
    alert(s, "sweep-old-1", "unit u9 of auth is over the 20M cap", T - 86_400 - 60);
    alert(s, "loop-auth.builder-u2-x", "builder-u2 of auth (exited since 09:00) — not back 10 min after the restart request", T - 600);
    alert(s, "sweep-fresh-2", "unit u9 of auth is over the 20M cap", T - 3600);
    expect(dropped(await loopOf(s, alerts)(T))).toEqual(["sweep-old-1"]);
  });
  test("a member alert is dropped once the member runs again, or is gone", async () => {
    const s = root();
    alert(s, "loop-auth.builder-u2-x", "builder-u2 of auth (exited since 09:00) — not back 10 min after the restart request", T - 1200);
    alert(s, "loop-auth.tester-y", "tester of auth (exited since 09:00) — nobody above it can restart it", T - 1200);
    expect(dropped(await loopOf(s, alerts)(T)).sort()).toEqual(["loop-auth.builder-u2-x", "loop-auth.tester-y"]);
  });
});
