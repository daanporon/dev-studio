// account-skills.test.ts — account-skills U3: accounts.tsv's 11th column (`skills`) through accountRows,
// the account-skills reconciler (one Studio alert per project per broken spell, warn and unknown raise
// none) and alerts.ts's alertGone branch that clears it once the account heals.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { accountRows } from "../../bin/loop/db/import-json.ts";
import type { Action, Actuator, Reconciler } from "../../bin/loop/core/plugins.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import accountSkills from "../../bin/loop/reconcilers/account-skills.ts";
import alerts from "../../bin/loop/reconcilers/alerts.ts";

const T = 1_800_000_000, DAY = 86_400;
const PROJECTS = ["pa", "pb"];
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
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
function skills(s: Store, account: string, value: string | null, label = "Work") {
  s.upsert("observed_accounts", { agent: "claude", account }, { label, skills: value, observed_at: T });
}
function loopOf(s: Store, ...reconcilers: Reconciler[]) {
  const got: Action[] = [];
  const rec: Actuator = { act(a) { got.push(a); } };
  const loop = new Loop(s, { observers: [], reconcilers }, rec, { projects: () => PROJECTS });
  return { tick: async (at: number) => (await loop.tick(at)).acted };
}
const alertsOf = (acted: Action[]) => acted.filter((a) => a.kind === "alert");
const ids = (acted: Action[]) => alertsOf(acted).map((a) => `${a.project} ${(a.payload as Row).id}`);
// The alert card the Studio shows after an alert action, as the alerts observer imports it.
function card(s: Store, a: Action, since = T) {
  const id = String((a.payload as Row).id);
  s.upsert("observed_alerts", { project: a.project, id },
    { doc: JSON.stringify({ id, asker: "sweep", title: (a.payload as Row).title, question: (a.payload as Row).text, since: new Date(since * 1000).toISOString() }), observed_at: T });
}
const cleared = (acted: Action[]) => acted.filter((a) => a.kind === "alert-clear").map((a) => `${a.project} ${(a.payload as Row).id}`);

describe("accountRows: the skills column", () => {
  test("an 11-column accounts.tsv sets skills; a 10-column one leaves it null; `-` is null", () => {
    const d = mkdtempSync(join(tmpdir(), "zzacc-"));
    temps.push(d);
    const head10 = "agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote";
    writeFileSync(join(d, "accounts.tsv"), [`${head10}\tskills`,
      "claude\ta\t1\t-\t2\t-\t-\t1\tA\t-\tbroken: compound-engineering not installed",
      "claude\tb\t1\t-\t2\t-\t-\t1\tB\t-\tok",
      "codex\tc\t1\t-\t2\t-\t-\t1\tC\t-\t-", ""].join("\n"));
    const by = (rows: ReturnType<typeof accountRows>) => Object.fromEntries(rows.filter((r) => r.table === "observed_accounts").map((r) => [r.key.account, r.set.skills]));
    expect(by(accountRows(d))).toEqual({ a: "broken: compound-engineering not installed", b: "ok", c: null });
    writeFileSync(join(d, "accounts.tsv"), [head10, "claude\ta\t1\t-\t2\t-\t-\t1\tA\t-", ""].join("\n"));
    expect(by(accountRows(d))).toEqual({ a: null });
  });
});

describe("the account-skills reconciler", () => {
  test("a broken account: one alert per project, naming the account, the reason and the repair; no repeat", async () => {
    const s = root();
    skills(s, "acct-1", "broken: compound-engineering not installed");
    skills(s, "acct-2", "ok");
    const { tick } = loopOf(s, accountSkills);
    const first = await tick(T);
    expect(alertsOf(first).map((a) => a.project).sort()).toEqual(PROJECTS);
    const a = alertsOf(first)[0], p = a.payload as Row;
    expect(String(p.id)).toMatch(/^sweep-account-skills\.acct-1-[0-9]+$/);
    expect(String(p.text)).toContain("Work (acct-1)");
    expect(String(p.text)).toContain("compound-engineering not installed");
    expect(String(p.text)).toContain("bin/host/install-skills.sh");
    expect(alertsOf(await tick(T + 60)), "no repeat").toEqual([]);
    skills(s, "acct-1", "broken: ce-code-review missing");
    expect(alertsOf(await tick(T + 120)), "a changed reason is the same spell").toEqual([]);
  });

  test("warn and unknown raise no alert", async () => {
    const s = root();
    skills(s, "acct-w", "warn: the backend has no Claude config dir for this account — not checked");
    skills(s, "acct-n", null);
    const { tick } = loopOf(s, accountSkills);
    expect(alertsOf(await tick(T))).toEqual([]);
  });

  test("a heal clears the alert; a re-break raises a new one with a new id", async () => {
    const s = root();
    skills(s, "acct-1", "broken: x");
    const { tick } = loopOf(s, accountSkills, alerts);
    const first = alertsOf(await tick(T));
    for (const a of first) card(s, a);
    expect(cleared(await tick(T + 60)), "still broken: kept").toEqual([]);

    skills(s, "acct-1", "ok");
    const heal = await tick(T + 120);
    expect(cleared(heal).sort()).toEqual(first.map((a) => `${a.project} ${(a.payload as Row).id}`).sort());
    for (const a of first) s.db.run("DELETE FROM observed_alerts WHERE project = ? AND id = ?", [a.project, String((a.payload as Row).id)]);

    skills(s, "acct-1", "broken: y");
    const again = await tick(T + 180);
    expect(alertsOf(again).map((a) => a.project).sort()).toEqual(PROJECTS);
    const oldIds = new Set(ids(first)), newIds = ids(again);
    for (const id of newIds) expect(oldIds.has(id), `${id} is a new id`).toBe(false);
  });

  test("warn heals too; a gone row clears; unknown never clears before a day", async () => {
    const s = root();
    for (const acct of ["w", "g", "n"]) skills(s, acct, "broken: x");
    const { tick } = loopOf(s, accountSkills, alerts);
    const first = alertsOf(await tick(T));
    for (const a of first) card(s, a);
    skills(s, "w", "warn: y");
    s.db.run("DELETE FROM observed_accounts WHERE account = 'g'");
    skills(s, "n", null);
    const got = cleared(await tick(T + 60));
    const idOf = (acct: string) => first.filter((a) => a.subject === `account-skills.${acct}`).map((a) => `${a.project} ${(a.payload as Row).id}`).sort();
    expect(got.filter((c) => c.includes(".w-")).sort()).toEqual(idOf("w"));
    expect(got.filter((c) => c.includes(".g-")).sort()).toEqual(idOf("g"));
    expect(got.filter((c) => c.includes(".n-")), "unknown: not before a day").toEqual([]);
    expect(cleared(await tick(T + DAY + 60)).filter((c) => c.includes(".n-")).sort(), "the day-old rule").toEqual(idOf("n"));
  });
});

describe("accountRows: the plan column (U123)", () => {
  test("a 12th column sets observed_accounts.plan; `-` and an 11-column file leave it null; a change is picked up", () => {
    const d = mkdtempSync(join(tmpdir(), "zzplan-"));
    temps.push(d);
    const head = "agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\tskills";
    const by = () => Object.fromEntries(accountRows(d).filter((r) => r.table === "observed_accounts").map((r) => [r.key.account, r.set.plan]));
    writeFileSync(join(d, "accounts.tsv"), [`${head}\tplan`,
      "claude\ta\t1\t-\t2\t-\t-\t1\tA\t-\tok\tMax", "claude\tb\t1\t-\t2\t-\t-\t1\tB\t-\tok\tUltra",
      "claude\tc\t1\t-\t2\t-\t-\t1\tC\t-\tok\tteam_new_tier", "codex\td\t1\t-\t2\t-\t-\t1\tD\t-\t-\t-", ""].join("\n"));
    expect(by()).toEqual({ a: "Max", b: "Ultra", c: "team_new_tier", d: null });
    writeFileSync(join(d, "accounts.tsv"), [`${head}\tplan`, "claude\ta\t1\t-\t2\t-\t-\t1\tA\t-\tok\tUltra", ""].join("\n"));
    expect(by()).toEqual({ a: "Ultra" });
    writeFileSync(join(d, "accounts.tsv"), [head, "claude\ta\t1\t-\t2\t-\t-\t1\tA\t-\tok", ""].join("\n"));
    expect(by()).toEqual({ a: null });
  });
});
