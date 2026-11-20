// credits-card.test.ts — provider-billing-fallback U4: the Needs-you card for an account out of credits
// (bin/loop/capacity/credits-card.ts, run by the limits reconciler), on a temp copy of tests/fixtures/loop/state with
// a fake picker. The actuator's claim rows are written by `settle` the way it records a sent action.
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { alertId } from "../../bin/loop/core/actuator.ts";
import type { Action, TickCtx } from "../../bin/loop/core/plugins.ts";
import { makeLimits, type Pick, type PickArgs } from "../../bin/loop/reconcilers/limits.ts";
import { clearCredits, creditsHold, creditsNotice, liveHolds } from "../../bin/loop/capacity/credits.ts";
import { cardText, CREDITS_KIND, FIXED, MOVED_KIND, SWITCH_OFF } from "../../bin/loop/capacity/credits-card.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const CR = join(ROOT, "tests", "fixtures", "credits");
const T = 1_792_144_800;
const WS = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/ds-dev-studio-";
const LEAD = `${WS}lead-demo`, BUILDER = `${WS}builder-u1-spike-loop-as-coordinator-demo`;
const ACCT = "6b9a19e7-e78f-4a78-ba77-b573b3c9f95d";
const CARD = "credits.card|muse/default", MOVED = "credits.moved|muse/default";

const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzcredits-card-")); temps.push(d);
  cpSync(FIXTURE, d, { recursive: true });
  rmSync(join(d, "fx", "loop", "limited.json"), { force: true });
  const s = open(d); stores.push(s); importJson(s, d, () => {});
  for (const [key, value] of [["lead", "claude sonnet spawn -"], ["thinker", "claude opus spawn -"], ["builder", "claude opus spawn -"]])
    s.upsert("config", { project: "fx", file: "roles.conf", key }, { value, observed_at: T });
  s.upsert("accounts", { agent: "claude", account: ACCT }, { observed_at: T });
  for (const account of [ACCT, "acct-b"]) s.upsert("observed_accounts", { agent: "claude", account }, { updated: String(T), observed_at: T });
  s.db.run("UPDATE observed_accounts SET limited_until = NULL WHERE agent = 'claude'");
  s.db.run("UPDATE units SET status = 'dispatched' WHERE slug = 'u1-spike-loop-as-coordinator'");
  s.upsert("observed_prs", { project: "fx", ref: "demo/u1-spike-loop-as-coordinator" }, { state: "OPEN", observed_at: T });
  return s;
}
// `wt` runs Muse on its default login, idle since `at`, showing `tail` (a 402 screen, or a prompt).
function muse(s: Store, wt: string, tail: string, at = T) {
  s.db.run("UPDATE members SET agent = 'muse', model = 'muse-spark-1.3', account = 'default' WHERE wt = ?", [wt]);
  s.upsert("observed_accounts", { agent: "muse", account: "default" }, { updated: String(at), observed_at: at });
  s.upsert("observed_workers", { project: "fx", wt }, { state: "idle", tail, tail_at: at, since: at - 900, last_output_at: at - 900, limited: null, gone_at: null, suspect: 0, observed_at: at });
}
const SCREEN = readFileSync(join(CR, "muse-402-a.txt"), "utf8");
const WAIT: Pick = { wait: T + 3600 };
const OTHER: Pick = { agent: "claude", model: "sonnet", effort: "-", account: "acct-b", fallback: false };
const ctx = (s: Store, at: number): TickCtx => ({ store: s, project: "fx", tick: 1, now: at, fired: [], poked: new Set<string>() });
async function tick(s: Store, at: number, next: Pick | ((a: PickArgs) => Pick)): Promise<Action[]> {
  const r = makeLimits({ pick: (a) => (typeof next === "function" ? next(a) : next) });
  const out = (await r.run(ctx(s, at))) ?? [];
  settle(s, out, at);
  return out.filter((a) => a.subject.startsWith("credits."));
}
// The actuator's claim row for each sent action (one per subject and kind; a new episode replaces it).
function settle(s: Store, actions: Action[], at: number) {
  for (const a of actions) s.upsert("episodes", { project: a.project, subject: a.subject, kind: `action:${a.kind}` }, { episode_key: a.episode, state: "done", started_at: at, source: "loop", observed_at: at });
}
const pay = (a: Action) => a.payload as Row;

describe("credits card (provider-billing-fallback U4)", () => {
  test("a stuck member gets one card per account, with the notice, the link, who is stuck and the two answers", async () => {
    const s = imported();
    muse(s, BUILDER, SCREEN);
    muse(s, LEAD, "❯");
    const a = await tick(s, T, WAIT);
    expect(creditsHold(s, "muse", "default", T)).not.toBeNull();
    expect(a.map((x) => [x.kind, x.subject])).toEqual([["alert", CARD]]);
    const p = pay(a[0]);
    expect(p).toMatchObject({ title: "muse/default out of credits", card: CREDITS_KIND });
    expect((p.fields as Row).options).toEqual([FIXED, SWITCH_OFF]);
    expect((p.fields as Row).credits).toEqual({ agent: "muse", account: "default" });
    expect(String((p.fields as Row).link)).toMatch(/^https:\/\/dev\.meta\.ai\/billing\//);
    expect(String(p.text)).toContain(String((p.fields as Row).link));
    expect(String(p.text)).toContain("builder-u1-spike-loop-as-coordinator (demo)");
    expect(String(p.text)).toContain("lead (demo)");
    expect(String(p.text)).toMatch(/Billing/);
    // Still stuck a minute on: nothing new.
    expect(await tick(s, T + 60, WAIT)).toEqual([]);
  });

  test("a pinned member is stuck even when the picker has another place", async () => {
    const s = imported();
    muse(s, BUILDER, SCREEN);
    const id = String((s.db.query("SELECT id FROM members WHERE wt = ?").get(BUILDER) as Row).id);
    s.db.run("INSERT INTO overrides (member, model, account, scope, set_by, set_at) VALUES (?, 'muse-spark-1.3', 'default', 'member', 'test', ?)", [id, T]);
    expect((await tick(s, T, OTHER)).map((x) => x.kind)).toEqual(["alert"]);
  });

  test("nobody stuck: no card; one that was up clears, by the id the actuator filed it under", async () => {
    const s = imported();
    muse(s, BUILDER, SCREEN);
    expect(await tick(s, T, OTHER)).toEqual([]);
    const up = await tick(s, T + 60, WAIT);
    expect(up.map((x) => x.kind)).toEqual(["alert"]);
    const clr = await tick(s, T + 120, OTHER);
    expect(clr.map((x) => [x.kind, x.episode])).toEqual([["alert-clear", `cleared@${up[0].episode}`]]);
    expect(pay(clr[0])).toEqual({ target: "project", id: alertId(CARD, up[0].episode) });
    // Stuck again in the same hold: a new card (a new episode), not the cleared one.
    const again = await tick(s, T + 180, WAIT);
    expect(again.map((x) => x.kind)).toEqual(["alert"]);
    expect(again[0].episode).not.toBe(up[0].episode);
  });

  test("the hold ends (Fixed, or it ran out): the card clears", async () => {
    const s = imported();
    muse(s, BUILDER, SCREEN);
    const up = await tick(s, T, WAIT);
    clearCredits(s, "muse", "default", "test", T + 60);
    muse(s, BUILDER, "❯", T + 60);
    const a = await tick(s, T + 60, WAIT);
    expect(a.map((x) => [x.kind, x.subject, x.episode])).toEqual([["alert-clear", CARD, `cleared@${up[0].episode}`]]);
    expect(await tick(s, T + 120, WAIT)).toEqual([]);
  });

  test("every member moved off: one loop note naming where, cleared when the hold ends", async () => {
    const s = imported();
    muse(s, BUILDER, SCREEN);
    expect(await tick(s, T, OTHER)).toEqual([]);
    // The switch restarted it on claude/acct-b.
    s.db.run("UPDATE members SET agent = 'claude', model = 'sonnet', account = 'acct-b' WHERE wt = ?", [BUILDER]);
    s.upsert("observed_workers", { project: "fx", wt: BUILDER }, { state: "idle", tail: "❯", tail_at: T + 60, since: T + 60, last_output_at: T + 60, limited: null, observed_at: T + 60 });
    const a = await tick(s, T + 60, OTHER);
    expect(a.map((x) => [x.kind, x.subject])).toEqual([["alert", MOVED]]);
    expect(pay(a[0])).toMatchObject({ card: MOVED_KIND, text: "muse/default out of credits — moved 1 member to claude/sonnet" });
    expect(await tick(s, T + 120, OTHER)).toEqual([]);
    clearCredits(s, "muse", "default", "test", T + 180);
    expect((await tick(s, T + 180, OTHER)).map((x) => [x.kind, x.subject])).toEqual([["alert-clear", MOVED]]);
  });

  test("an account with no member of this project on it raises nothing", async () => {
    const s = imported();
    muse(s, BUILDER, SCREEN);
    await tick(s, T, WAIT);
    clearCredits(s, "muse", "default", "test", T + 1);
    // A hold from another project's member: nobody here runs on it, nobody here moved off it.
    s.db.run("UPDATE members SET agent = 'claude', model = 'opus', account = ? WHERE wt = ?", [ACCT, BUILDER]);
    s.upsert("observed_workers", { project: "fx", wt: BUILDER }, { state: "idle", tail: "❯", tail_at: T + 60, limited: null, observed_at: T + 60 });
    s.upsert("episodes", { project: "", subject: "credits|codex/x", kind: "account" }, { episode_key: "k", state: "codex/x", started_at: T + 60, ended_at: T + 86400, source: "test", observed_at: T + 60 });
    expect((await tick(s, T + 60, WAIT)).filter((x) => x.kind === "alert")).toEqual([]);
    expect(liveHolds(s, T + 60).map((h) => `${h.agent}/${h.account}`)).toEqual(["codex/x"]);
  });

  test("the notice and link come from the hold's events; the text says what to do without a link", () => {
    const s = imported();
    s.event("account_credits_held", { project: "", payload: { agent: "a", account: "b", until: T + 10, from: "probe", notice: "out of credits" } });
    expect(creditsNotice(s, "a", "b", 0)).toEqual({ notice: "out of credits", link: null });
    s.event("limited", { project: "fx", payload: { kind: "credits", account: "a/b", notice: "402 Billing", link: "https://x.test/pay" } });
    expect(creditsNotice(s, "a", "b", 0)).toEqual({ notice: "402 Billing", link: "https://x.test/pay" });
    expect(creditsNotice(s, "a", "c", 0)).toEqual({ notice: null, link: null });
    const h = { agent: "a", account: "b", started: T, until: T + 1 };
    expect(cardText(h, null, null, ["lead (sq)"])).toBe("a/b is out of credits. Stuck on it: lead (sq). Fix the billing with the provider, then press Fixed. Or switch the account off and restart them.");
  });
});
