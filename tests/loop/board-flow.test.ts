// The board's Flow (U1): stage, group, time in stage and stuck per open unit, merges per day and
// typical stage times. The fixture board (tests/fixtures/flow/, built by flow-fixture.ts) covers the
// board-data.ts wiring; the tables below feed bin/board/flow.ts directly for the edge rules.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { flowLine, flowOf, ordinal, unitStage, type FlowEvent, type FlowReview, type FlowUnit } from "../../bin/board/flow.ts";
import { pausedFacts, renderText } from "../../bin/board/board-data.ts";
import { FX_NOW, flowFixture } from "./flow-fixture.ts";

const N = FX_NOW, D = 86400;

describe("the fixture board", () => {
  let f: ReturnType<typeof flowFixture>, b: any, all: any;
  const card = (slug: string) => b.flow.cards.find((c: any) => c.slug === slug);
  beforeAll(() => { f = flowFixture(); b = f.board(); all = f.board(""); });
  afterAll(() => f.cleanup());

  test("Queued: each group with its note, and the time since its deps finished", () => {
    expect(card("u1-dep-wait")).toMatchObject({ stage: "queued", group: "waiting on another unit", note: "waits on u2-building" });
    expect(card("u3-held")).toMatchObject({ stage: "queued", group: "held", note: "after the demo" });
    expect(card("u4-plan")).toMatchObject({ stage: "queued", group: "held", note: "plan not approved" });
    expect(card("u5-slot")).toMatchObject({ group: "waiting for a slot", note: "at max_builders 6", since: null, in_stage_s: null });
    expect(card("u6-account")).toMatchObject({ group: "waiting for an account", note: "no room until 13:30" });
    expect(card("u20-starting")).toMatchObject({ group: "waiting for a slot", note: "starting" });
    expect(card("u7-next")).toMatchObject({ group: "waiting for a slot", note: "next in line", since: N - 3600, stuck: false });
  });

  test("Building: since the first dispatch; a closed PR is back here since the dispatch after it", () => {
    expect(card("u2-building")).toMatchObject({ stage: "building", group: "coding", since: N - 1800, note: null, stuck: false });
    expect(card("u9-closed")).toMatchObject({ stage: "building", since: N - 900 });
  });

  test("Building splits by the seeded reviews (U4): coding, reviewing, fixing findings, review stopped", () => {
    expect(card("u2-building")).toMatchObject({ group: "coding", note: null });
    expect(card("u19-slow")).toMatchObject({ stage: "building", group: "reviewing", note: "2nd review · delta 4m" });
    expect(card("u9-closed")).toMatchObject({ stage: "building", group: "fixing findings", note: "6 findings 12m" });
    expect(card("u8-gone")).toMatchObject({ stage: "building", group: "review stopped", note: "reviews stopped · needs --retry" });
  });

  test("PR open: groups by precedence, since the first unit_pr", () => {
    expect(["u10-review", "u11-draft", "u12-fixing", "u13-checks", "u14-blocked"].map((s) => card(s).group))
      .toEqual(["in review", "draft", "fixing", "checks running", "blocked"]);   // u11 is a draft with failing checks
    expect(card("u10-review")).toMatchObject({ stage: "pr_open", since: N - 400, pr: { ref: "acme/flow#10", num: "10" } });
  });

  test("Needs you: a blocking question naming the unit, or a question naming its PR, since its time", () => {
    expect(card("u15-asks")).toMatchObject({ stage: "needs_you", group: null, since: N - 300, needs_you: true, ask: `${f.a}/flow/q-u15`, stuck: false });
    expect(card("u16-pr-ask")).toMatchObject({ stage: "needs_you", since: N - 600, ask: `${f.a}/flow/q-pr16`, stuck: false });
  });

  test("Merging: armed after its PR opened (since then), or a merged PR on a unit not done (since unknown)", () => {
    expect(card("u17-armed")).toMatchObject({ stage: "merging", since: N - 200 });
    expect(card("u18-merged")).toMatchObject({ stage: "merging", since: null, in_stage_s: null, stuck: false });
  });

  test("Stuck: past 2 × typical, a stale PR or a gone Builder", () => {
    // the five done units carry tier standard (U279): the tier has its own medians, here the same numbers
    expect(b.flow.typical_s).toEqual({ [f.a]: { building: 1200, pr_open: 500, merging: 100, tiers: { standard: { building: 1200, pr_open: 500, merging: 100 } } } });
    // late, but a review runs (u19) or checks run (u11): the Builder is at work, so slow, not stuck
    expect(card("u19-slow")).toMatchObject({ in_stage_s: 3000, stuck: false, slow: true, stale: false });   // > 2400
    expect(card("u11-draft")).toMatchObject({ in_stage_s: 1500, stuck: false, slow: true });                // > 1000
    expect(card("u8-gone")).toMatchObject({ in_stage_s: 300, stuck: true, stale: true });
  });

  test("merges: the last week with took_s, per local day over 30 days, a closed squad's included", () => {
    expect(b.flow.merged.map((m: any) => [m.squad, m.slug, m.pr, m.took_s])).toEqual([
      ["flow", "u31-done", "31", 960], ["flow", "u32-done", "32", 1380], ["flow", "u33-done", "33", 1800],
      ["shipped", "u1-old", "41", 3600], ["flow", "u34-done", "34", 2220], ["flow", "u35-done", "35", 2640]]);
    expect(b.flow.per_day).toHaveLength(30);
    expect(b.flow.per_day[0]).toEqual({ day: "2026-12-17", merged: 0 });
    expect(b.flow.per_day.filter((d: any) => d.merged)).toEqual([{ day: "2027-01-05", merged: 1 }, { day: "2027-01-11", merged: 1 },
      { day: "2027-01-12", merged: 1 }, { day: "2027-01-13", merged: 2 }, { day: "2027-01-14", merged: 1 }, { day: "2027-01-15", merged: 1 }]);
    expect(b.flow.counts.merged_today).toBe(1);
    expect(b.flow.median_total_s).toBe(2010);
  });

  test("counts: each its cards, all of them the header's units left; a suspended squad has none", () => {
    const c = b.flow.counts, of = (st: string) => b.flow.cards.filter((x: any) => x.stage === st && !x.paused).length;
    expect(c).toEqual({ queued: 7, building: 4, pr_open: 5, needs_you: 2, merging: 2, paused: 0, stuck: 1, slow: 2, open_prs: 7, merged_today: 1 });
    for (const st of ["queued", "building", "pr_open", "needs_you", "merging"]) expect(c[st]).toBe(of(st));
    expect(c.queued + c.building + c.pr_open + c.needs_you + c.merging + c.paused).toBe(b.header.units_left);
    expect(b.flow.cards.filter((x: any) => x.squad !== "flow")).toEqual([]);
    expect(b.flow.cards.some((x: any) => "open_pr" in x)).toBe(false);
  });

  test("squads: stuck with the longest, needs you, last merge (a done squad by its merge)", () => {
    expect(b.flow.squads).toEqual({
      [`${f.a}/flow`]: { stuck: 1, slow: 2, longest_stuck_s: 300, needs_you: 2, last_merge_at: N - 3600 },
      [`${f.a}/shipped`]: { stuck: 0, slow: 0, longest_stuck_s: null, needs_you: 0, last_merge_at: N - 2 * D - 7200 },
    });
  });

  test("every project: counts and per_day summed, each card against its own project's typical", () => {
    expect(all.flow.counts).toMatchObject({ building: 5, stuck: 1, slow: 3, merged_today: 2 });
    expect(all.flow.per_day.reduce((n: number, d: any) => n + d.merged, 0)).toBe(12);
    expect(all.flow.typical_s[f.b]).toEqual({ building: 300, pr_open: 100, merging: 50 });
    expect(all.flow.cards.find((c: any) => c.project === f.b)).toMatchObject({ slug: "u1-quick", in_stage_s: 1000, stuck: false, slow: true });   // late (> 600 in b, < 2400 in a) with its Builder working
  });

  test("text: one FLOW line under the STUDIO line, with flow.counts' numbers", () => {
    const lines = renderText(b).split("\n").filter((l) => l.startsWith("FLOW "));
    expect(lines).toEqual(["FLOW 7 queued · 4 building · 5 PR open · 2 merging · 1 stuck · 2 slow · 2 needs you · 1 merged today"]);
    expect(renderText(b).split("\n")[1]).toBe(lines[0]);
  });
});

// ---- flow.ts on tables ---------------------------------------------------------------------------
const P = "p", S = "s";
const unit = (slug: string, o: Partial<FlowUnit> = {}): FlowUnit => ({
  project: P, squad: S, slug, tier: null, status: "dispatched", hold: false, plan_blocked: false, paused: false,
  blocked_by: [], deps: [], pick: null, question: null, pr: null, verdict: null, reasons: null, stale: false, ...o });
const ev = (unit: string, kind: string, ago: number, project = P): FlowEvent => ({ project, squad: S, unit, kind, at: N - ago });
const pr = (num: string, status: string | null = "open") => ({ ref: `o/r#${num}`, num, url: null, status });
// n finished units, each `building` s from dispatch to PR, 100 s to armed, 50 s to done.
const finished = (n: number, building = 600) => Array.from({ length: n }, (_, i) => {
  const u = `d${i}`, done = 3600 * (i + 1);
  return [ev(u, "unit_dispatched", done + 150 + building), ev(u, "unit_pr", done + 150), ev(u, "auto_merge_armed", done + 50), ev(u, "unit_done", done)];
}).flat();
const flow = (units: FlowUnit[], events: FlowEvent[] = [], floor = 10, reviews?: FlowReview[]) =>
  flowOf({ now: N, units, events, squads: [{ project: P, squad: S }], floor_min: { [P]: floor }, reviews });
const one = (u: FlowUnit, events: FlowEvent[] = [], floor = 10) => flow([u], events, floor).cards[0];

describe("flow.ts", () => {
  test("Queued groups: a queued: reason is a slot wait; an unknown or missing reset reads no account free", () => {
    const q = (pick: FlowUnit["pick"]) => one(unit("u", { status: "planned", pick }));
    const p = { reason: null, wait_until: null, wait_known: null, slot: 0, account: null };
    expect(q({ ...p, reason: "queued: 4 of 4 start slots in flight" })).toMatchObject({ group: "waiting for a slot", note: "4 of 4 start slots in flight" });
    expect(q({ ...p, reason: "WAIT host: psi cpu 40 ≥ crit 25" })).toMatchObject({ group: "waiting for a slot", note: "host busy: psi cpu 40 ≥ crit 25" });   // U4 host brake
    expect(q({ ...p, reason: "no account free", wait_until: N + 600, wait_known: 0 })).toMatchObject({ group: "waiting for an account", note: "no account free" });
    expect(q({ ...p, reason: "no account free" })).toMatchObject({ group: "waiting for an account", note: "no account free" });
    expect(one(unit("u", { status: "planned", paused: true, blocked_by: ["x"] }))).toMatchObject({ group: "held", note: "paused" });
  });

  test("U8 held notes carry the open deps; not-ready cards have no time, a slot waiter keeps it", () => {
    const h = (o: object, deps: string[]) => one(unit("u", { status: "planned", hold: true, blocked_by: deps, ...o }));
    expect(h({}, ["u1", "u2"]).note).toBe("held · waits on u1, u2");
    expect(h({ hold_reason: "operator" }, ["u1", "u2"]).note).toBe("operator · waits on u1, u2");
    expect(h({}, ["a", "b", "c", "d", "e"]).note).toBe("held · waits on a, b, c, +2");
    expect(h({}, []).note).toBe("held");
    const st = (o: object) => unitStage(unit("u", { status: "planned", ...o }), undefined, 500);
    expect(st({ hold: true })).toMatchObject({ group: "held", since: null });
    expect(st({ blocked_by: ["x"] })).toMatchObject({ group: "waiting on another unit", since: null });
    expect(st({})).toMatchObject({ group: "waiting for a slot", since: 500 });
  });

  test("Building: a restart keeps since; a closed PR with no dispatch after it has no since and is not stuck", () => {
    expect(one(unit("u"), [ev("u", "unit_dispatched", 900), ev("u", "unit_dispatched", 60)]).since).toBe(N - 900);
    expect(one(unit("u", { pr: pr("1", "closed") }), [...finished(5), ev("u", "unit_dispatched", 99999), ev("u", "unit_pr", 90000)]))
      .toMatchObject({ stage: "building", note: "PR closed", since: null, in_stage_s: null, stuck: false });
  });

  test("paused (paused-in-swimlanes U1): a paused building, pr_open and merging card leaves its count for group paused", () => {
    const pu = (slug: string, o: Partial<FlowUnit> = {}) => unit(slug, { paused: true, paused_at: N - 90000, paused_why: "paused by you", ...o });
    const f = flow([pu("b"), pu("p", { pr: pr("1") }), pu("m", { pr: pr("2"), verdict: "ready" }), unit("w"), unit("q", { status: "planned", paused: true, paused_why: "Lead hold", hold: true })],
      [ev("b", "unit_dispatched", 900), ev("m", "unit_pr", 900), ev("m", "auto_merge_armed", 300)]);
    const by = (k: string) => f.cards.find((c) => c.slug === k)!;
    expect(["b", "p", "m"].map((k) => [by(k).stage, by(k).group, by(k).note, by(k).paused_s])).toEqual([
      ["building", "paused", "paused by you", 90000], ["pr_open", "paused", "paused by you", 90000], ["merging", "paused", "paused by you", 90000]]);
    expect(f.counts).toMatchObject({ building: 1, pr_open: 0, merging: 0, paused: 3, queued: 1 });
    expect(by("w")).toMatchObject({ group: "coding", paused: false });
    expect(by("q")).toMatchObject({ stage: "queued", group: "held", note: "Lead hold", paused: false });
    expect(by("b").since).not.toBeNull();   // the stage's own time stays
    expect(flowLine(f)).toContain("0 needs you · 3 paused · 0 merged today");
    expect(flowLine(flow([unit("w")]))).not.toContain("paused");
    expect(one(pu("x", { paused_at: null })).paused_s).toBeNull();
  });

  test("paused_why: manual, dependency, plan, Lead hold, and pausing / resuming while in flight", () => {
    const db = { s: { get: () => ({ requested_at: 500 }) } }, bm = { role: "builder", suffix: "" };
    const st = (state: string, sources: any[]) => ({ state, sources });
    const why = (pause: any, hold = false) => pausedFacts(db, "p", "s", bm, pause, hold);
    expect(why(st("paused", [{ source: "manual", requested_at: 900 }, { source: "dependency", requested_at: 700, prerequisites: [], remaining: ["x"] }]))).toEqual({ paused_at: 700, paused_why: "paused by you" });
    expect(why(st("paused", [{ source: "dependency", requested_at: 700, prerequisites: [{ kind: "unit" }], remaining: ["prerequisite unresolved: p/s/u1", "prerequisite unresolved: o/r#4"] }]))).toEqual({ paused_at: 700, paused_why: "waits on p/s/u1, o/r#4" });
    expect(why(st("paused", [{ source: "dependency", requested_at: 700, prerequisites: [{ kind: "plan" }], remaining: ["plan not approved: a.md"] }])).paused_why).toBe("plan taken back");
    expect(why(st("pausing", [{ source: "manual", requested_at: 900 }])).paused_why).toBe("pausing");
    expect(why(st("resuming", []))).toEqual({ paused_at: 500, paused_why: "resuming" });
    expect(why(st("active", []), true)).toEqual({ paused_at: null, paused_why: "Lead hold" });
    expect(why(null)).toEqual({ paused_at: null, paused_why: null });
  });

  test("Building review groups (U4): stopped, reviewing, fixing findings, coding; paused keeps its note", () => {
    const rv = (state: FlowReview["state"], o: Partial<FlowReview> = {}): FlowReview =>
      ({ project: P, squad: S, slug: "u", state, since: null, kind: null, round: null, findings: null, ...o });
    const at = (r: FlowReview | undefined, u = unit("u")) => flow([u], [ev("u", "unit_dispatched", 900)], 10, r ? [r] : undefined).cards[0];
    expect(at(undefined)).toMatchObject({ group: "coding", note: null });
    expect(at(rv("coding"))).toMatchObject({ group: "coding", note: null });
    expect(at(rv("reviewing", { since: N - 59, kind: "full", round: 1 }))).toMatchObject({ group: "reviewing", note: "1st review · full 0m", since: N - 900 });
    expect(at(rv("reviewing", { since: N - 600, kind: "delta-wide", round: 3 })).note).toBe("3rd review · delta-wide 10m");
    expect(at(rv("fixing", { since: N - 120, findings: 1 }))).toMatchObject({ group: "fixing findings", note: "1 finding 2m" });
    expect(at(rv("stopped"))).toMatchObject({ group: "review stopped", note: "reviews stopped · needs --retry" });
    expect(at(rv("fixing", { findings: 3 }), unit("u", { paused: true }))).toMatchObject({ group: "paused", stage: "building", note: "paused" });
    expect(at(rv("reviewing", { since: N - 60 }), unit("u", { pr: pr("1", "closed") })).note).toBe("review 1m");
    // a review row for a unit with an open PR changes nothing: the PR stage wins
    expect(flow([unit("u", { pr: pr("1") })], [], 10, [rv("stopped")]).cards[0]).toMatchObject({ stage: "pr_open", group: "in review" });
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st", "111th"]);
  });

  test("a review group never changes Building's since or its stuck threshold", () => {
    const evs = [...finished(5), ev("u", "unit_dispatched", 1300)];   // typical building 600 s; 1300 > 2 × 600
    for (const state of ["coding", "reviewing", "fixing", "stopped"] as const) {
      const c = flow([unit("u")], evs, 0, [{ project: P, squad: S, slug: "u", state, since: N - 10, kind: null, round: 1, findings: 2 }]).cards[0];
      expect(c).toMatchObject({ stage: "building", since: N - 1300, in_stage_s: 1300, stuck: true });
    }
  });

  test("PR groups: stale wins over draft; a blocked verdict needs a reason", () => {
    expect(one(unit("u", { pr: pr("1", "draft"), stale: true })).group).toBe("blocked");
    expect(one(unit("u", { pr: pr("1", "failing"), verdict: "blocked" })).group).toBe("fixing");
  });

  test("Merging: a ready verdict without armed (no since); armed only counts after the first unit_pr", () => {
    expect(one(unit("u", { pr: pr("1"), verdict: "ready" }), [ev("u", "unit_pr", 500)])).toMatchObject({ stage: "merging", since: N - 500, note: "ready · waiting for finish-unit" });
    expect(one(unit("u", { pr: pr("1") }), [ev("u", "auto_merge_armed", 900), ev("u", "unit_pr", 500)]).stage).toBe("pr_open");
    expect(one(unit("u", { pr: pr("1"), question: { id: "q", since: N - 30 } }), [ev("u", "unit_pr", 500)]))
      .toMatchObject({ stage: "needs_you", since: N - 30, ask: `${P}/${S}/q` });
  });

  test("U7 ready, not armed: waits from GitHub's last update, stuck past the floor alone", () => {
    const ready = (ago: number | null) => unit("u", { pr: { ...pr("1"), updated_at: ago == null ? null : N - ago }, verdict: "ready" });
    expect(one(ready(1800), [ev("u", "unit_pr", 5000)], 10)).toMatchObject({ stage: "merging", note: "ready · waiting for finish-unit", since: N - 1800, in_stage_s: 1800, stuck: true });
    expect(one(ready(300), [ev("u", "unit_pr", 5000)], 10)).toMatchObject({ in_stage_s: 300, stuck: false });
    // no GitHub update time: the latest unit_pr
    expect(one(ready(null), [ev("u", "unit_pr", 5000), ev("u", "unit_pr", 900)], 10)).toMatchObject({ since: N - 900, in_stage_s: 900, stuck: true });
    // armed keeps its armed since and the typical-time rule (no typical: never red by time)
    expect(one(ready(1800), [ev("u", "unit_pr", 5000), ev("u", "auto_merge_armed", 4000)], 10)).toMatchObject({ since: N - 4000, note: null, stuck: false });
  });

  test("typical time: 5 finished units give medians, 4 give none and nothing goes red by time", () => {
    expect(flow([], finished(5, 600)).typical_s).toEqual({ [P]: { building: 600, pr_open: 100, merging: 50 } });
    const four = flow([unit("u")], [...finished(4, 60), ev("u", "unit_dispatched", 99999)]);
    expect(four.typical_s[P]).toEqual({ building: null, pr_open: null, merging: null });
    expect(four.cards[0].stuck).toBe(false);
  });

  test("stuck: past max(2 × typical, floor); with floor 0 exactly 2 × typical; paused, queued and needs-you never", () => {
    const at = (ago: number, floor = 10, o: Partial<FlowUnit> = {}) => one(unit("u", o), [...finished(5, 600), ev("u", "unit_dispatched", ago)], floor).stuck;
    expect([at(1200), at(1201)]).toEqual([false, true]);          // 2 × 600 over a 600 s floor
    expect([at(1500, 30), at(1801, 30)]).toEqual([false, true]);  // a 30 min floor holds it to 1800
    expect([at(1200, 0), at(1201, 0)]).toEqual([false, true]);
    expect(at(99999, 10, { paused: true, stale: true })).toBe(false);
    expect(at(99999, 10, { stale: true })).toBe(true);
    expect(one(unit("u", { status: "planned", deps: ["d0"] }), [...finished(5), ev("u", "unit_dispatched", 99999)]).stuck).toBe(false);
    expect(one(unit("u", { stale: true, question: { id: "q", since: N - 99999 } })).stuck).toBe(false);
  });

  describe("U279: typical per tier, stuck means quiet, else slow", () => {
    const MIN = 60;
    // `n` units of `tier` done in the window, each building `building` s; names tn0.., 100 s PR open and 50 s merging.
    const tiered = (tier: string, n: number, building: number, off = 0) => {
      const names = Array.from({ length: n }, (_, i) => `${tier}${i}`);
      const evs = names.flatMap((u, i) => { const done = 3600 * (i + 1 + off); return [ev(u, "unit_dispatched", done + 150 + building), ev(u, "unit_pr", done + 150), ev(u, "auto_merge_armed", done + 50), ev(u, "unit_done", done)]; });
      return { evs, tier_of: Object.fromEntries(names.map((u) => [`${P}/${S}/${u}`, tier])) };
    };
    const hist = (hard = 5) => {
      const s = tiered("standard", 6, 38 * MIN), h = tiered("hard", hard, 120 * MIN, 6);
      return { evs: [...s.evs, ...h.evs], tier_of: { ...s.tier_of, ...h.tier_of } };
    };
    const run = (u: FlowUnit, ago: number, hard = 5, quiet = 20) => {
      const h = hist(hard);
      return flowOf({ now: N, units: [u], events: [...h.evs, ev(u.slug, "unit_dispatched", ago)], squads: [{ project: P, squad: S }],
        floor_min: { [P]: 10 }, quiet_min: { [P]: quiet }, tier_of: h.tier_of });
    };
    const hardU = (o: Partial<FlowUnit> = {}) => unit("u", { tier: "hard", tier_key: "hard", ...o });

    test("typical_s keeps the project median and adds one per tier with 5 samples", () => {
      const f = run(hardU(), 60, 5);
      expect(f.typical_s[P]).toEqual({ building: 38 * MIN, pr_open: 100, merging: 50, tiers: { hard: { building: 120 * MIN, pr_open: 100, merging: 50 }, standard: { building: 38 * MIN, pr_open: 100, merging: 50 } } });
    });
    test("U2 at-prompt: active_at is the episode's start (the end of the turn), so a late unit is stuck, not slow", () => {
      // board-data.ts passes the open at-prompt episode's started_at instead of "now" for a working Builder.
      expect(run(hardU({ active_at: N - 45 * MIN }), 250 * MIN).cards[0]).toMatchObject({ stuck: true, slow: false });
      expect(run(hardU({ active_at: N }), 250 * MIN).cards[0]).toMatchObject({ stuck: false, slow: true });   // no episode: a working Builder is "now"
    });
    test("a hard unit building 90 min is not late against the hard median (120 min), though the project's is 38", () => {
      expect(run(hardU(), 90 * MIN).cards[0]).toMatchObject({ stuck: false, slow: false });
    });
    test("late and its Builder worked 5 min ago: slow, not stuck; 30 min ago or never: stuck", () => {
      expect(run(hardU({ active_at: N - 5 * MIN }), 250 * MIN).cards[0]).toMatchObject({ stuck: false, slow: true });
      expect(run(hardU({ active_at: N - 30 * MIN }), 250 * MIN).cards[0]).toMatchObject({ stuck: true, slow: false });
      expect(run(hardU({ active_at: null }), 250 * MIN).cards[0]).toMatchObject({ stuck: true, slow: false });
      expect(run(hardU({ active_at: N - 30 * MIN }), 250 * MIN, 5, 45).cards[0]).toMatchObject({ stuck: false, slow: true });   // flow_quiet_min 45
    });
    test("with only 3 hard samples the project median is used", () => {
      // 90 min is past 2 × 38 min: late, and quiet, so stuck
      expect(run(hardU(), 90 * MIN, 3).cards[0]).toMatchObject({ stuck: true });
      expect(run(hardU(), 90 * MIN, 3).typical_s[P].tiers?.hard).toBeUndefined();
    });
    test("a unit with no tier uses the project median", () => {
      expect(run(unit("u"), 90 * MIN).cards[0]).toMatchObject({ stuck: true });
    });
    test("stale stays stuck whatever the activity; a ready card waiting for finish-unit too", () => {
      expect(run(hardU({ stale: true, active_at: N }), 60).cards[0]).toMatchObject({ stuck: true, slow: false });
      const ready = unit("u", { pr: { ...pr("1"), updated_at: N - 1800 }, verdict: "ready", active_at: N });
      expect(one(ready, [ev("u", "unit_pr", 5000)], 10)).toMatchObject({ stuck: true, slow: false });
    });
    test("counts and squad rows: only stuck cards count as stuck; slow has its own number; paused is neither", () => {
      const h = hist(), a = hardU({ active_at: N - 5 * MIN }), b = hardU({ slug: "v" }), c = hardU({ slug: "w", paused: true, active_at: N });
      const f = flowOf({ now: N, units: [a, b, c], events: [...h.evs, ...["u", "v", "w"].map((s) => ev(s, "unit_dispatched", 250 * MIN))], squads: [{ project: P, squad: S }],
        floor_min: { [P]: 10 }, tier_of: h.tier_of });
      expect(f.counts).toMatchObject({ stuck: 1, slow: 1 });
      expect(f.squads[`${P}/${S}`]).toMatchObject({ stuck: 1, slow: 1, longest_stuck_s: 250 * MIN });
      expect(flowLine(f)).toContain("1 stuck · 1 slow · 0 needs you");
    });
  });

  test("an empty Flow still has 30 days, the scope's squads and no typical times", () => {
    const e = flow([]);
    expect(e.counts).toEqual({ queued: 0, building: 0, pr_open: 0, needs_you: 0, merging: 0, paused: 0, stuck: 0, slow: 0, open_prs: 0, merged_today: 0 });
    expect(e.per_day).toHaveLength(30);
    expect(e.squads).toEqual({ [`${P}/${S}`]: { stuck: 0, slow: 0, longest_stuck_s: null, needs_you: 0, last_merge_at: null } });
    expect(e.median_total_s).toBeNull();
    expect(Object.keys(e)).toEqual(["counts", "cards", "queued_order", "merged", "per_day", "typical_s", "median_total_s", "squads"]);
  });
});

describe("U5: merged rows carry pr_url", () => {
  const evs = [{ ...ev("a", "unit_done", 100), pr: "12" }, ev("b", "unit_done", 90)];
  const rows = (repo_slug?: Record<string, string>) =>
    flowOf({ now: N, units: [], events: evs, squads: [{ project: P, squad: S }], floor_min: { [P]: 10 }, repo_slug }).merged;
  test("built from the project's repo slug, null without one or without a PR", () => {
    expect(rows({ [P]: "o/r" }).sort((x, y) => x.slug.localeCompare(y.slug)).map((m) => m.pr_url)).toEqual(["https://github.com/o/r/pull/12", null]);
    expect(rows().map((m) => m.pr_url)).toEqual([null, null]);
  });

  test("U6 queue positions: account waiters by reset (unknown last), then slot waiters by place; dep-waiting and held get none", () => {
    const pk = (o: Partial<NonNullable<FlowUnit["pick"]>>) => ({ reason: null, wait_until: null, wait_known: null, slot: 0, account: null, ...o });
    const acct = (until: number | null) => pk({ reason: "no account free", wait_until: until, wait_known: until ? 1 : 0 });
    const slotp = pk({ reason: "WAIT slot: p at max_builders 6" });
    const pl = (slug: string, o: Partial<FlowUnit> = {}) => unit(slug, { status: "planned", ...o });
    const f = flow([
      pl("held1", { hold: true, hold_reason: "later" }), pl("dep2", { blocked_by: ["x"], place: [1, 1, 1, 12] }), pl("dep1", { blocked_by: ["x"], place: [1, 1, 1, 11] }),
      pl("s-old", { pick: slotp, place: [1, 1, 1, 5] }), pl("s-block", { pick: slotp, place: [1, 0, 1, 9] }), pl("s-new", { pick: slotp, place: [1, 1, 1, 8] }),
      pl("a-unknown", { pick: acct(null), place: [1, 1, 1, 1] }), pl("a-known", { pick: acct(N + 600), place: [1, 1, 1, 2] }),
    ]);
    const pos = (s: string) => f.cards.find((c) => c.slug === s)!.queue_pos;
    expect(["a-known", "a-unknown", "s-block", "s-old", "s-new"].map(pos)).toEqual([1, 2, 3, 4, 5]);   // a slot waiter that blocks started work beats an older one
    expect(["dep1", "dep2", "held1"].map(pos)).toEqual([null, null, null]);
    expect(f.queued_order.map((k) => k.split("/")[2])).toEqual(["a-known", "a-unknown", "s-block", "s-old", "s-new", "dep1", "dep2", "held1"]);
  });

  test("U6 queue positions count per project", () => {
    const slotp = { reason: "WAIT slot: x", wait_until: null, wait_known: null, slot: 0, account: null };
    const f = flowOf({ now: N, events: [], floor_min: {}, squads: [{ project: "pa", squad: S }, { project: "pb", squad: S }],
      units: [unit("a1", { project: "pa", status: "planned", pick: slotp, place: [1, 1, 1, 1] }), unit("b1", { project: "pb", status: "planned", pick: slotp, place: [1, 1, 1, 2] }),
        unit("a2", { project: "pa", status: "planned", pick: slotp, place: [1, 1, 1, 3] })] });
    expect(f.cards.map((c) => [c.slug, c.queue_pos])).toEqual([["a1", 1], ["b1", 1], ["a2", 2]]);
  });
});
