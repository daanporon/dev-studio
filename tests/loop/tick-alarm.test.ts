// tick-alarm.test.ts — loop-tick-8s U4: the slow-ticks Studio card (reconcilers/tick-alarm.ts), its clearing
// through alerts.ts, the limit keys and the Needs-you place.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import type { Action, Actuator, Reconciler } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import tickAlarm from "../../bin/loop/reconcilers/tick-alarm.ts";
import alerts from "../../bin/loop/reconcilers/alerts.ts";
import { limitValueProblem } from "../../bin/lib/operator.ts";
import { cardPlace } from "../../bin/board/card-place.ts";
const T = 1_800_000_000, EVERY = 600;
const PROJECTS = ["pa", "pb"];
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  delete process.env.DS_LIMIT_TICK_ALARM_MS;
  delete process.env.DS_LIMIT_TICK_ALARM_WINDOWS;
});
function root(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzloop-"));
  temps.push(d);
  for (const p of PROJECTS) mkdirSync(join(d, p, "squads"), { recursive: true });
  const s = open(d);
  stores.push(s);
  importConfig(s, d);
  return s;
}
// One tick_slow row at `at` averaging `avg` ms.
function slow(s: Store, at: number, avg: number, top: [string, number][] = [["observe:orca", avg / 2], ["reconcile:pa", avg / 4], ["act", avg / 8], ["x", 1]]) {
  s.db.run("INSERT INTO events (at, kind, payload) VALUES (?, 'tick_slow', ?)", [at, JSON.stringify({ avg_ms: avg, top: top.map(([step, avg_ms]) => ({ step, avg_ms })) })]);
}
function loopOf(s: Store, ...reconcilers: Reconciler[]) {
  const got: Action[] = [];
  const rec: Actuator = { act(a) { got.push(a); } };
  const loop = new Loop(s, { observers: [], reconcilers }, rec, { projects: () => PROJECTS });
  return { tick: async (at: number) => (await loop.tick(at)).acted };
}
const alertsOf = (acted: Action[]) => acted.filter((a) => a.kind === "alert");
const cleared = (acted: Action[]) => acted.filter((a) => a.kind === "alert-clear").map((a) => `${a.project} ${(a.payload as Row).id}`);
function card(s: Store, a: Action) {
  const id = String((a.payload as Row).id);
  s.upsert("observed_alerts", { project: a.project, id },
    { doc: JSON.stringify({ id, asker: "sweep", title: (a.payload as Row).title, question: (a.payload as Row).text, since: new Date(T * 1000).toISOString() }), observed_at: T });
}
describe("the tick-alarm reconciler", () => {
  test("raises after three slow windows and not before; names the top three steps", async () => {
    const s = root();
    const { tick } = loopOf(s, tickAlarm);
    slow(s, T, 9000); slow(s, T + EVERY, 9000);
    expect(alertsOf(await tick(T + EVERY + 1)), "two windows are not enough").toEqual([]);
    slow(s, T + 2 * EVERY, 9000);
    const got = alertsOf(await tick(T + 2 * EVERY + 1));
    expect(got.map((a) => a.project).sort(), "one card per project").toEqual(PROJECTS);
    const p = got[0].payload as Row, text = String(p.text);
    expect(p.title).toBe("Loop ticks slow: 9.0 s");
    expect(String(p.id)).toMatch(/^sweep-tick-alarm\.slow-[0-9]+$/);
    expect(text).toContain("observe:orca 4.5 s; reconcile:pa 2.3 s; act 1.1 s");
    expect(text).not.toContain("x 0.0");
    expect(text).toContain("slow for 20 min");
    expect(p.option).toBe("Seen");
    expect(alertsOf(await tick(T + 2 * EVERY + 60)), "no repeat in one spell").toEqual([]);
  });
  test("a window at or under the limit breaks the run", async () => {
    const s = root();
    slow(s, T, 9000); slow(s, T + EVERY, 6000); slow(s, T + 2 * EVERY, 9000);
    expect(alertsOf(await loopOf(s, tickAlarm).tick(T + 2 * EVERY + 1))).toEqual([]);
  });
  test("clears when the newest window is at or under the limit; a later spell is a new card", async () => {
    const s = root();
    const { tick } = loopOf(s, tickAlarm, alerts);
    for (let i = 0; i < 3; i++) slow(s, T + i * EVERY, 9000);
    const first = alertsOf(await tick(T + 2 * EVERY + 1));
    for (const a of first) card(s, a);
    slow(s, T + 3 * EVERY, 5000);
    expect(cleared(await tick(T + 3 * EVERY + 1)).length).toBe(2);
    for (let i = 4; i < 7; i++) slow(s, T + i * EVERY, 9000);
    const again = alertsOf(await tick(T + 6 * EVERY + 1));
    expect(again.length).toBe(2);
    expect(String((again[0].payload as Row).id)).not.toBe(String((first[0].payload as Row).id));
  });
  test("clears when no tick_slow row came for two windows", async () => {
    const s = root();
    const { tick } = loopOf(s, tickAlarm, alerts);
    for (let i = 0; i < 3; i++) slow(s, T + i * EVERY, 9000);
    for (const a of alertsOf(await tick(T + 2 * EVERY + 1))) card(s, a);
    expect(cleared(await tick(T + 4 * EVERY)), "still inside two windows").toEqual([]);
    expect(cleared(await tick(T + 4 * EVERY + 2)).length).toBe(2);
    expect(alertsOf(await tick(T + 4 * EVERY + 60)), "stale rows do not open a spell").toEqual([]);
  });
  test("tick_alarm_ms 0 turns it off and clears an open card; windows follow the limit", async () => {
    const s = root();
    process.env.DS_LIMIT_TICK_ALARM_MS = "0";
    for (let i = 0; i < 3; i++) slow(s, T + i * EVERY, 9000);
    const { tick } = loopOf(s, tickAlarm, alerts);
    expect(alertsOf(await tick(T + 2 * EVERY + 1))).toEqual([]);
    delete process.env.DS_LIMIT_TICK_ALARM_MS;
    process.env.DS_LIMIT_TICK_ALARM_WINDOWS = "1";
    for (const a of alertsOf(await tick(T + 2 * EVERY + 2))) card(s, a);
    process.env.DS_LIMIT_TICK_ALARM_MS = "0";
    expect(cleared(await tick(T + 2 * EVERY + 3)).length).toBe(2);
  });
});
describe("the limit keys and the card's place", () => {
  test("value checks", () => {
    expect(limitValueProblem("tick_alarm_ms", "6000")).toBe("");
    expect(limitValueProblem("tick_alarm_ms", "0")).toBe("");
    expect(limitValueProblem("tick_alarm_ms", "-1")).not.toBe("");
    expect(limitValueProblem("tick_alarm_windows", "3")).toBe("");
    expect(limitValueProblem("tick_alarm_windows", "0")).not.toBe("");
    expect(limitValueProblem("tick_alarm_windows", "21")).not.toBe("");
  });
  test("the card is Needs-you", () => {
    expect(cardPlace({ id: "sweep-tick-alarm.slow-123", title: "Loop ticks slow: 9.0 s" }, T)).toBe("needs");
  });
});
