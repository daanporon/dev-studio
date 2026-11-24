// archive-debrief.test.ts — debrief-on-archive U1: an archive asks the live Lead for the final debrief,
// keeps it (and only it) up while the step is open, then archives with its text or the done-time one
// under a line naming the late units, and raises one Debrief card once the squad reads closed.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../../bin/loop/core/decide.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import type { Action, TickCtx } from "../../bin/loop/core/plugins.ts";
import type { Exec } from "../../bin/loop/core/actuator.ts";
import { effective } from "../../bin/loop/pause/pause.ts";
import { archiveDebrief } from "../../bin/loop/reconcilers/archive-debrief.ts";
import { archiveDebriefStep, finalDebrief } from "../../bin/loop/squad/archive-debrief.ts";
import { seedWish } from "../../bin/loop/db/seed.ts";
import { limitValueProblem } from "../../bin/lib/operator.ts";
import { explainState, LIMIT_GROUPS, limitGroup } from "../../bin/board/board-data.ts";
import squadFulfiller from "../../bin/loop/fulfil/squad.ts";

const T = 1_800_000_000;
const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const ENV = "DS_LIMIT_ARCHIVE_DEBRIEF_MIN", saved = process.env[ENV];
const OFF = "DS_LIMIT_DEBRIEF", savedOff = process.env[OFF];
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  if (savedOff === undefined) delete process.env[OFF]; else process.env[OFF] = savedOff;
});

const DONE_DEBRIEF = "Set out to do: the debrief step\nShipped: #1\nTry it: nothing to try by hand — loop only";
// Squad `one` of project p: a Lead, a Thinker and a Builder, all live and idle; units u1 (in the
// done-time debrief) and u2, u3 (added after it). The squad doc carries the done-time debrief.
function fixture(squad: Row = {}, doc: Row = {}): Store {
  const root = mkdtempSync(join(tmpdir(), "zzad-")); roots.push(root);
  const s = open(root); stores.push(s);
  s.upsert("projects", { label: "p" }, { observed_at: 1 });
  s.upsert("episodes", { project: "p", subject: "seed", kind: "wish_seed" }, { state: "done", started_at: T, observed_at: T, source: "loop" });
  const d = { topic: "one", debrief: DONE_DEBRIEF, debrief_at: iso(T - 3600), debrief_units: ["u1"], ...doc };
  s.upsert("squads", { project: "p", topic: "one" }, { repo: "path:/fake", status: "running", want: "running", observed_at: 1, updated_at: 1, doc: JSON.stringify(d), ...squad });
  [["u1", "done", "#1"], ["u2", "done", "#12"], ["u3", "planned", null]].forEach(([slug, status, pr], i) =>
    s.upsert("units", { project: "p", squad: "one", slug }, { status, pr, ord: i, observed_at: 1, updated_at: 1 }));
  for (const [role, suffix] of [["lead", ""], ["thinker", ""], ["builder", "u3"]]) {
    const wt = `r::/nowhere/${role}`;
    s.upsert("members", { project: "p", squad: "one", role, suffix }, { wt, status: "running", want: "running", observed_at: 1, updated_at: 1 });
    s.upsert("observed_workers", { project: "p", wt }, { presence: "running", walk: "running", state: "idle", account_at: T, observed_at: T });
  }
  return s;
}
const member = (s: Store, role: string) => s.db.query("SELECT * FROM members WHERE project = 'p' AND squad = 'one' AND role = ?").get(role) as Row;
const sq = (s: Store) => s.get("squads", { project: "p", topic: "one" })!;
const ctx = (s: Store, now: number, project = ""): TickCtx => ({ store: s, project, tick: 1, now, fired: [], poked: new Set() });
const archiveWish = (s: Store, at = T, set: Row = {}) => s.upsert("squads", { project: "p", topic: "one" }, { want: "gone", want_at: at, want_result: null, ...set });
const forMember = (acts: Action[], s: Store, role: string) => acts.filter((a) => a.subject === `member:${member(s, role).id}`);
const reconcile = (s: Store, now: number) => archiveDebrief(ctx(s, now, "p"));
const setDoc = (s: Store, d: Row) => s.upsert("squads", { project: "p", topic: "one" }, { doc: JSON.stringify({ ...JSON.parse(String(sq(s).doc)), ...d }) });

// The worktrees go (as the closes would), then the squad fulfiller archives: the archived doc.
async function archive(s: Store, now: number): Promise<Row> {
  s.db.run("UPDATE members SET wt = NULL WHERE project = 'p' AND squad = 'one'");
  const acts = (await squadFulfiller.run!(ctx(s, now)) as Action[]).filter((a) => (a.payload as Row).op === "archive");
  expect(acts.length).toBe(1);
  const r = await squadFulfiller.exec(acts[0], { ...ctx(s, now), act: {} } as unknown as Exec);
  expect(r).toMatchObject({ done: true, result: "archived" });
  const dir = join(s.root, "p", "archive");
  return JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.startsWith("one-") && f.endsWith(".json"))!), "utf8"));
}
const card = (acts: Action[]) => acts.filter((a) => a.kind === "alert").map((a) => a.payload as Row);

describe("the archive's final-debrief step", () => {
  test("written: the Lead is held and asked once, other members close at once; its set-debrief settles the step, the archive keeps its text and one card follows", async () => {
    const s = fixture({ status: "done" });
    archiveWish(s);
    // The tick the wish lands: the decider runs before the step exists and must not close the Lead.
    const first = decide(ctx(s, T));
    expect(forMember(first, s, "lead")).toEqual([]);
    expect(forMember(first, s, "thinker").map((a) => a.kind)).toEqual(["member.close"]);
    expect(forMember(first, s, "builder").map((a) => a.kind)).toEqual(["member.close"]);
    expect(effective(s, member(s, "lead"))).toMatchObject({ state: "running", why: "archive-debrief" });
    expect(effective(s, member(s, "thinker"))).toMatchObject({ state: "archived", why: "squad" });
    expect(seedWish(s, member(s, "lead"), T)).toBeNull();
    expect(seedWish(s, member(s, "thinker"), T)).toBe("gone");

    const asked = reconcile(s, T);
    expect(asked.map((a) => [a.kind, (a.payload as Row).reason])).toEqual([["poke", "archive-debrief"]]);
    expect(String((asked[0].payload as Row).text)).toContain("set-debrief --file");
    expect(archiveDebriefStep(s, "p", "one")).toMatchObject({ state: "open", asked_at: T, limit_s: 600, settled_at: null });
    expect(reconcile(s, T + 60)).toEqual([]);                      // asked once
    expect(forMember(decide(ctx(s, T + 60)), s, "lead")).toEqual([]);

    setDoc(s, { debrief: "Final: u1 #1, u2 #12 (added late), u3 cancelled", debrief_at: iso(T + 120), debrief_units: ["u1", "u2", "u3"] });
    expect(reconcile(s, T + 130)).toEqual([]);
    expect(archiveDebriefStep(s, "p", "one")).toMatchObject({ state: "written", settled_at: T + 130 });
    expect(effective(s, member(s, "lead"))).toMatchObject({ state: "archived", why: "squad" });
    expect(forMember(decide(ctx(s, T + 140)), s, "lead").map((a) => a.kind)).toEqual(["member.close"]);

    const doc = await archive(s, T + 200);
    expect(doc).toMatchObject({ status: "closed", debrief: "Final: u1 #1, u2 #12 (added late), u3 cancelled", debrief_source: "archive" });
    const cards = card(reconcile(s, T + 210));
    expect(cards).toEqual([expect.objectContaining({ target: "project", title: "Debrief: one", option: "Mark read",
      text: "Final: u1 #1, u2 #12 (added late), u3 cancelled — written at archive by the Lead." })]);
    expect(String(cards[0].id)).toMatch(/^sweep-debrief-one-\d+$/);
    expect(reconcile(s, T + 220)).toEqual([]);                     // one card per step
  });

  test("timeout: a silent Lead is let go after the limit and the archive names exactly the late units", async () => {
    const s = fixture();
    archiveWish(s);
    reconcile(s, T);
    expect(reconcile(s, T + 599)).toEqual([]);
    expect(archiveDebriefStep(s, "p", "one")?.state).toBe("open");
    reconcile(s, T + 600);
    expect(archiveDebriefStep(s, "p", "one")).toMatchObject({ state: "timeout", settled_at: T + 600 });
    expect(forMember(decide(ctx(s, T + 610)), s, "lead").map((a) => a.kind)).toEqual(["member.close"]);
    const doc = await archive(s, T + 700);
    expect(doc.debrief_source).toBe("done");
    expect(doc.debrief).toBe(`Written at done (${iso(T - 3600)}); 2 units were added after it: u2 #12 (done), u3 (planned).\n\n${DONE_DEBRIEF}`);
    expect(card(reconcile(s, T + 710))[0].text).toBe("Set out to do: the debrief step — written at done; 2 units added after it.");
  });

  test("a Lead that reads working is still asked, once", () => {
    const s = fixture();
    s.upsert("observed_workers", { project: "p", wt: "r::/nowhere/lead" }, { state: "working" });
    archiveWish(s);
    const acts = reconcile(s, T);
    expect(acts.length).toBeGreaterThan(0);
    expect(archiveDebriefStep(s, "p", "one")).toMatchObject({ state: "open", poked_at: T });
    expect(reconcile(s, T + 30)).toEqual([]);
  });

  test("skipped: a suspended squad archives with no wait", () => {
    const s = fixture({ status: "suspended", want: "suspended" });
    archiveWish(s);
    expect(effective(s, member(s, "lead"))).toMatchObject({ state: "archived", why: "squad" });
    expect(forMember(decide(ctx(s, T)), s, "lead").map((a) => a.kind)).toEqual(["member.close"]);
    expect(reconcile(s, T)).toEqual([]);
    expect(archiveDebriefStep(s, "p", "one")).toMatchObject({ state: "skipped", why: "the squad is suspended", settled_at: T });
  });

  test("lead-gone: a Lead that dies mid-step is not restarted and the step settles", () => {
    const s = fixture();
    archiveWish(s);
    reconcile(s, T);
    s.upsert("observed_workers", { project: "p", wt: "r::/nowhere/lead" }, { presence: "none", walk: "none", gone_at: T + 30 });
    const mid = forMember(decide(ctx(s, T + 40)), s, "lead");
    expect(mid).toEqual([]);                                       // held: no start, no close
    reconcile(s, T + 40);
    expect(archiveDebriefStep(s, "p", "one")).toMatchObject({ state: "lead-gone", why: "the Lead's agent is gone" });
    const after = forMember(decide(ctx(s, T + 50)), s, "lead");
    expect(after.filter((a) => a.kind === "member")).toEqual([]);  // never a start
    expect(effective(s, member(s, "lead")).state).toBe("archived");
  });

  test("archive_debrief_min 0: no hold, the step is skipped, the archive runs as before and the card still comes", async () => {
    process.env[ENV] = "0";
    const s = fixture({}, { debrief: undefined, debrief_at: undefined, debrief_units: undefined });
    archiveWish(s);
    expect(forMember(decide(ctx(s, T)), s, "lead").map((a) => a.kind)).toEqual(["member.close"]);
    expect(reconcile(s, T)).toEqual([]);
    expect(archiveDebriefStep(s, "p", "one")).toMatchObject({ state: "skipped", why: "archive_debrief_min is 0" });
    const doc = await archive(s, T + 60);
    expect(doc).toMatchObject({ debrief: "No debrief was written (skipped: archive_debrief_min is 0).", debrief_source: "done" });
    expect(card(reconcile(s, T + 70))).toEqual([expect.objectContaining({ title: "Debrief: one", text: "No debrief was written (skipped: archive_debrief_min is 0). — no debrief (skipped: archive_debrief_min is 0)." })]);
  });

  test("a paused or limited Lead, or none at all, is skipped at once", () => {
    const s = fixture();
    s.upsert("members", { project: "p", squad: "one", role: "lead", suffix: "" }, { limited_until: T + 3600 });
    archiveWish(s);
    reconcile(s, T);
    expect(archiveDebriefStep(s, "p", "one")).toMatchObject({ state: "skipped", why: "the Lead is limited" });
    expect(finalDebrief({}, [], archiveDebriefStep(s, "p", "one")).debrief).toBe("No debrief was written (skipped: the Lead is limited).");
    const t = fixture();
    t.db.run("UPDATE members SET wt = NULL WHERE role = 'lead'");
    archiveWish(t);
    reconcile(t, T);
    expect(archiveDebriefStep(t, "p", "one")).toMatchObject({ state: "skipped", why: "no Lead" });
  });

  test("a later archive of the same topic is a new step", () => {
    const s = fixture();
    archiveWish(s);
    reconcile(s, T);
    s.upsert("squads", { project: "p", topic: "one" }, { want: "running", want_at: T + 100 });
    expect(archiveDebriefStep(s, "p", "one")).toBeNull();
    archiveWish(s, T + 200);
    expect(archiveDebriefStep(s, "p", "one")).toBeNull();
    reconcile(s, T + 200);
    expect(archiveDebriefStep(s, "p", "one")).toMatchObject({ state: "open", asked_at: T + 200 });
  });
});

describe("debrief off for the project", () => {
  const off = (s: Store) => s.upsert("config", { project: "p", file: "limits.conf", key: "debrief" }, { value: "off", observed_at: 1 });
  const cardsFor = (s: Store, now: number) => { s.db.run("UPDATE squads SET status = 'closed' WHERE project = 'p'"); return card(reconcile(s, now)); };

  test("no hold before or after a step, no step, no card, and the Lead closes with the squad", () => {
    const s = fixture({ status: "done" });
    off(s); archiveWish(s);
    expect(forMember(decide(ctx(s, T)), s, "lead").map((a) => a.kind)).toEqual(["member.close"]);
    expect(reconcile(s, T)).toEqual([]);
    expect(archiveDebriefStep(s, "p", "one")).toBeNull();
    expect(forMember(decide(ctx(s, T + 5)), s, "lead").map((a) => a.kind)).toEqual(["member.close"]);
    expect(cardsFor(s, T + 10)).toEqual([]);
  });

  test("a step open when the setting flips settles skipped with carded_at set and raises no card", () => {
    const s = fixture({ status: "done" });
    archiveWish(s);
    reconcile(s, T);
    expect(archiveDebriefStep(s, "p", "one")?.state).toBe("open");
    off(s);
    expect(forMember(decide(ctx(s, T + 1)), s, "lead").map((a) => a.kind)).toEqual(["member.close"]);
    expect(reconcile(s, T + 2)).toEqual([]);
    expect(archiveDebriefStep(s, "p", "one")).toMatchObject({ state: "skipped", why: "debriefs are off for this project", carded_at: T + 2 });
    expect(cardsFor(s, T + 10)).toEqual([]);
  });

  test("archive with hand-written text keeps it as written; with none, no debrief field", async () => {
    const a = fixture({ status: "done" });
    off(a); archiveWish(a);
    const kept = await archive(a, T + 60);
    expect(kept.debrief).toBe(DONE_DEBRIEF);
    expect(kept.debrief_source).toBe("done");
    const b = fixture({ status: "done" }, { debrief: undefined, debrief_at: undefined, debrief_units: undefined });
    off(b); archiveWish(b);
    const none = await archive(b, T + 60);
    expect("debrief" in none).toBe(false);
    expect("debrief_source" in none).toBe(false);
  });

  test("the env var switches it off too, and `on` keeps today's behaviour", () => {
    process.env[OFF] = "off";
    const s = fixture({ status: "done" });
    archiveWish(s);
    expect(forMember(decide(ctx(s, T)), s, "lead").map((a) => a.kind)).toEqual(["member.close"]);
    process.env[OFF] = "on";
    expect(forMember(decide(ctx(s, T)), s, "lead")).toEqual([]);
  });
});

describe("the debrief setting", () => {
  test("only on and off are accepted, and it sits in Agents & nudges", () => {
    expect(limitValueProblem("debrief", "off")).toBe("");
    expect(limitValueProblem("debrief", "on")).toBe("");
    expect(limitValueProblem("debrief", "maybe")).toBe("debrief must be on or off (got 'maybe')");
    expect(limitGroup("debrief")).toBe("Agents & nudges");
    expect(LIMIT_GROUPS.length).toBeGreaterThan(0);
  });
  test("the status meanings drop their debrief clause for an off project", () => {
    expect(explainState("done")?.you_can).toContain("debrief");
    expect(explainState("wrapping-up")?.means).toContain("debrief");
    for (const k of ["done", "wrapping-up"]) expect(JSON.stringify(explainState(k, true))).not.toContain("debrief");
  });
});

describe("finalDebrief", () => {
  const units = [{ slug: "u1", status: "done", pr: "#1" }, { slug: "u2", status: "done", pr: "https://github.com/o/r/pull/12" }, { slug: "u3", status: "cancelled", pr: null }];
  test("the fallback line lists the units not in debrief_units, with PR and status", () => {
    const f = finalDebrief({ debrief: "old", debrief_at: "2026-11-20T10:00:00Z", debrief_units: ["u1", "u3"] }, units, null);
    expect(f).toEqual({ debrief: "Written at done (2026-11-20T10:00:00Z); 1 unit was added after it: u2 #12 (done).\n\nold", source: "done", late: 1, first: "old" });
    expect(finalDebrief({ debrief: "old", debrief_at: "x", debrief_units: ["u1", "u2", "u3"] }, units, null).debrief).toBe("Written at done (x); no units were added after it.\n\nold");
  });
  test("an older debrief with no units list, none at all, and the Lead's own", () => {
    expect(finalDebrief({ debrief: "old" }, units, null).debrief).toBe("Written before the archive; units added after it are not known.\n\nold");
    expect(finalDebrief({}, units, null)).toMatchObject({ debrief: "No debrief was written.", source: "done" });
    expect(finalDebrief({}, units, { state: "timeout", why: "no debrief within 10 min" } as never).debrief).toBe("No debrief was written (timeout: no debrief within 10 min).");
    expect(finalDebrief({ debrief: "new", debrief_units: [] }, units, { state: "written" } as never)).toMatchObject({ debrief: "new", source: "archive" });
  });
});
