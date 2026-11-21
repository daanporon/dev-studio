// flow.ts — the board's Flow: one stage per open unit, merges per day, typical stage times (U1).
//
// Pure: bin/board/board-data.ts gathers the rows (the active squads' open units with what squad()
// already worked out, the Builders' picks, the stage events of the last 30 days) and calls flowOf
// once per board build. No database access here, so tests feed tables.
//
// Stage, first match wins: needs_you (an open blocking question names the unit, or a question names
// its PR) → merging (open PR with a ready verdict or auto_merge_armed after its first unit_pr; or a
// merged PR on a unit not done yet) → pr_open (an open PR) → building (dispatched) → queued (planned).
// A stage's `since` is the first event of its kind (a restart does not reset it); none reads null.
// Typical time per stage is the project's median over units done in the last 7 days (5 samples or
// none), and one per (project, tier) from the units table's tier (U279): a card uses its tier's
// median when that tier has 5 samples, else the project's. A card past max(2 × typical,
// flow_stuck_floor_min) is late; late is stuck when its Builder shows no sign of work for
// flow_quiet_min (active_at null or older), else slow. A stale card is stuck at any age, a paused one
// never, a queued or needs-you one never by time.
// Building splits by the unit's review (U4, observed_reviews), first match wins: review stopped →
// reviewing → fixing findings → coding; no review row (or no table) reads coding. The group never
// changes Building's since or its stuck threshold.

import type { ReviewState } from "../loop/observers/reviews.ts";   // type only: flow.ts stays pure

export type Stage = "queued" | "building" | "pr_open" | "needs_you" | "merging";

export type FlowPick = { reason: string | null; wait_until: number | null; wait_known: number | null; slot: number | null; account: string | null };
export type FlowPr = { ref: string | null; num: string; url: string | null; status: string | null; updated_at?: number | null };  // updated_at: GitHub's last update
export type FlowUnit = {
  project: string; squad: string; slug: string; tier: string | null;
  status: string;                       // planned | dispatched
  hold: boolean; hold_reason?: string | null;
  plan_blocked: boolean;                // dep-ready but its plan is not approved
  resuming?: boolean;                   // the unit's Builder is resuming (pause.ts): not paused, it waits for a seat
  paused: boolean;                      // the unit's Builder (or the Lead's hold on a dispatched unit)
  blocked_by: string[];                 // unmet deps and open ext deps (squad()'s satisfied() rule)
  deps: string[];                       // its in-squad deps (Queued's since: the last one's unit_done)
  pick: FlowPick | null;                // its Builder's picks row
  question: { id: string | null; since: number | null } | null;   // the open question naming it or its PR
  pr: FlowPr | null;
  verdict: string | null;               // PR health verdict (ready | blocked | …)
  reasons: string | null;
  stale: boolean;                       // stale PR health, unitPhase stale, or its Builder gone/unknown
  place?: number[] | null;              // slot.ts placeOf: the loop's pickup rank (queued units; focus included)
  urgent?: boolean;                     // the unit's doc urgent flag (⚡)
  unlocks?: number; unlock?: "on";    // open units waiting on this one (⬆N); `unlock` on while the line ranks it by that
  focus?: "on" | "held" | "muted" | null;  // open unit of the focus squad: next in line / the squad holds its share / any other
  lane?: string; lane_rule?: string | null; lane_cpu_h?: number; lane_limit_h?: number;   // a light-tagged unit's lane (board-data unitLane)
  tier_key?: string | null;             // units.tier (standard | hard), not the display label
  paused_at?: number | null;            // when the pause began (earliest open source); null: unknown or a Lead hold
  paused_why?: string | null;           // paused by you | waits on … | plan taken back | Lead hold | pausing | resuming
  active_at?: number | null;            // newest sign of work of its Builder (U279); null: none seen
};
export type FlowReview = { project: string; squad: string; slug: string; state: ReviewState; since: number | null;
  kind: string | null; round: number | null; findings: number | null };
export type FlowEvent = { project: string; squad: string; unit: string; kind: string; at: number; pr?: string | null };
export type FlowInput = {
  now: number;
  units: FlowUnit[];
  seated?: { project: string; squad: string; unit: string }[];   // units whose Builder holds a seat: never shown as queued
  events: FlowEvent[];                  // unit_dispatched, unit_pr, auto_merge_armed, unit_done of the window
  squads: { project: string; squad: string }[];   // the active squads (scope)
  floor_min: Record<string, number>;    // flow_stuck_floor_min per project
  repo_slug?: Record<string, string>;   // "owner/repo" per project, for a merged card's PR link
  reviews?: FlowReview[];               // observed_reviews (U4); absent when the table is missing
  tier_of?: Record<string, string | null>;   // "project/squad/slug" -> units.tier, for done units (U279)
  quiet_min?: Record<string, number>;   // flow_quiet_min per project
  focus_squad?: Record<string, string | null>;   // the project's focus squad: its merged cards get a dim ★
};

const DAY = 86400, WEEK = 7 * DAY;
type Times = { dispatched: number[]; pr: number[]; armed: number[]; done: number[] };
const KIND: Record<string, keyof Times> = { unit_dispatched: "dispatched", unit_pr: "pr", auto_merge_armed: "armed", unit_done: "done" };
const ukey = (project: string, squad: string, unit: string) => `${project}/${squad}/${unit}`;
const first = (a: number[]) => a[0] ?? null;
const last = (a: number[]) => a[a.length - 1] ?? null;
const firstFrom = (a: number[], t: number | null) => (t == null ? null : a.find((x) => x >= t) ?? null);

export function timesOf(events: FlowEvent[]): Map<string, Times> {
  const out = new Map<string, Times>();
  for (const e of events) {
    const k = KIND[e.kind];
    if (!k) continue;
    const key = ukey(e.project, e.squad, e.unit);
    if (!out.has(key)) out.set(key, { dispatched: [], pr: [], armed: [], done: [] });
    out.get(key)![k].push(e.at);
  }
  for (const t of out.values()) for (const a of Object.values(t)) a.sort((x, y) => x - y);
  return out;
}

const NO_TIMES: Times = { dispatched: [], pr: [], armed: [], done: [] };
const hhmm = (epoch: number) => { const d = new Date(epoch * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

// A planned unit's group and note (KTD6).
// "waits on u1, u2, u3, +2": the first three open deps, then how many more.
const waitsOn = (deps: string[]) => `waits on ${deps.slice(0, 3).join(", ")}${deps.length > 3 ? `, +${deps.length - 3}` : ""}`;
const withDeps = (note: string, deps: string[]) => (deps.length ? `${note} · ${waitsOn(deps)}` : note);

function queuedGroup(u: FlowUnit): { group: string; note: string | null } {
  const q = queuedBase(u);
  // A member that is resuming with no seat waits like any queued unit: it is not paused.
  return u.resuming && q.group === "waiting for a slot" ? { group: q.group, note: "resumed · waiting for a seat" } : q;
}
function queuedBase(u: FlowUnit): { group: string; note: string | null } {
  if (u.paused) return { group: "held", note: "paused" };
  if (u.hold) return { group: "held", note: withDeps(u.hold_reason || "held", u.blocked_by) };
  if (u.blocked_by.length) return { group: "waiting on another unit", note: waitsOn(u.blocked_by) };
  if (u.plan_blocked) return { group: "held", note: "plan not approved" };
  const p = u.pick, reason = String(p?.reason ?? "");
  if (p && reason === "no account free")
    return { group: "waiting for an account", note: p.wait_known === 1 && p.wait_until ? `no room until ${hhmm(p.wait_until)}` : "no account free" };
  if (!p) return { group: "waiting for a slot", note: "next in line" };
  const slot = reason.match(/^WAIT slot:\s*\S+\s+(.*)$/) ?? reason.match(/^queued:\s*(.*)$/);
  if (slot) return { group: "waiting for a slot", note: slot[1].trim() || null };
  const host = reason.match(/^WAIT host:\s*(.*)$/);
  if (host) return { group: "waiting for the host", note: null };   // the lane's banner carries the reason once
  if (p.slot === 1 && p.wait_until == null) return { group: "waiting for a slot", note: "starting" };
  return { group: "waiting for a slot", note: reason || null };
}

function prGroup(u: FlowUnit): string {
  if (u.stale || (u.verdict === "blocked" && !!u.reasons)) return "blocked";
  const s = u.pr?.status;
  if (s === "draft") return "draft";
  if (s === "failing") return "fixing";
  if (s === "running") return "checks running";
  return "in review";
}

const OPEN_PR = (s: string | null | undefined) => s !== "merged" && s !== "closed";

// One open unit's stage, group, entry time and note.
const REVIEW_GROUP: Record<ReviewState, string> = { stopped: "review stopped", reviewing: "reviewing", fixing: "fixing findings", coding: "coding" };
export const ordinal = (n: number): string => {
  const t = n % 100, o = n % 10;
  return `${n}${t >= 11 && t <= 13 ? "th" : o === 1 ? "st" : o === 2 ? "nd" : o === 3 ? "rd" : "th"}`;
};
const mins = (since: number | null, now: number) => (since == null ? "" : ` ${Math.max(0, Math.floor((now - since) / 60))}m`);
// A review's card note: "2nd review · delta 4m", "6 findings 12m", "reviews stopped · needs --retry".
export function reviewNote(r: FlowReview | null, now: number): string | null {
  if (!r) return null;
  if (r.state === "stopped") return "reviews stopped · needs --retry";
  if (r.state === "reviewing") return `${r.round ? `${ordinal(r.round)} ` : ""}review${r.kind ? ` · ${r.kind}` : ""}${mins(r.since, now)}`;
  if (r.state === "fixing") return `${r.findings ?? 0} finding${r.findings === 1 ? "" : "s"}${mins(r.since, now)}`;
  return null;
}

export function unitStage(u: FlowUnit, t: Times = NO_TIMES, depsDoneAt: number | null = null, review: FlowReview | null = null, now = 0, seated = false): { stage: Stage; group: string | null; since: number | null; note: string | null; open_pr: boolean } {
  const prOpen = !!u.pr && OPEN_PR(u.pr.status);
  const paused = u.paused ? "paused" : null;
  if (u.question) return { stage: "needs_you", group: null, since: u.question.since, note: paused, open_pr: prOpen };
  const firstPr = first(t.pr), lastPr = last(t.pr);
  const armed = firstPr != null && t.armed.some((a) => a >= firstPr);
  if ((prOpen && (u.verdict === "ready" || armed)) || u.pr?.status === "merged") {
    // Ready but never armed: the loop told the Builder to run finish-unit.sh and nothing merges until it does.
    // No event records when the verdict turned ready, so the wait counts from the PR's last GitHub update
    // (else its latest unit_pr); never observed_prs.since, which restarts on every ready observation.
    const waiting = prOpen && u.verdict === "ready" && !armed;
    if (waiting) return { stage: "merging", group: null, since: u.pr?.updated_at ?? lastPr, note: paused ?? "ready · waiting for finish-unit", open_pr: true };
    return { stage: "merging", group: null, since: firstFrom(t.armed, lastPr), note: paused, open_pr: prOpen };
  }
  if (prOpen) return { stage: "pr_open", group: prGroup(u), since: firstPr, note: paused, open_pr: true };
  if (u.status === "dispatched" || seated) {
    const closed = u.pr?.status === "closed";
    return { stage: "building", group: REVIEW_GROUP[review?.state ?? "coding"] ?? "coding", since: closed ? firstFrom(t.dispatched, lastPr) : first(t.dispatched),
      note: paused ?? reviewNote(review, now) ?? (closed ? "PR closed" : null), open_pr: false };
  }
  const q = queuedGroup(u);
  // A unit that cannot start has no queue time: only the next-up groups keep their since.
  const notReady = q.group === "held" || q.group === "waiting on another unit";
  return { stage: "queued", group: q.group, since: notReady ? null : depsDoneAt, note: q.note, open_pr: false };
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

type Stages = { building: number | null; pr_open: number | null; merging: number | null };
export type Typical = Stages & { tiers?: Record<string, Stages> };
const MIN_SAMPLES = 5;

// The latest unit_done of each unit in the window, newest first.
function doneRows(events: FlowEvent[]): FlowEvent[] {
  const latest = new Map<string, FlowEvent>();
  for (const e of events) {
    if (e.kind !== "unit_done") continue;
    const k = ukey(e.project, e.squad, e.unit), had = latest.get(k);
    if (!had || e.at > had.at) latest.set(k, e);
  }
  return [...latest.values()].sort((a, b) => b.at - a.at || a.unit.localeCompare(b.unit));
}

// Per project, and per (project, tier) from tier_of: the median of each stage over its units done in
// the last 7 days (KTD5). A tier with no stage at 5 samples is left out of `tiers`.
export function typicalTimes(events: FlowEvent[], now: number, times = timesOf(events), done = doneRows(events), tier_of: Record<string, string | null> = {}): Record<string, Typical> {
  type S = { building: number[]; pr_open: number[]; merging: number[] };
  const fresh = (): S => ({ building: [], pr_open: [], merging: [] });
  const samples = new Map<string, { all: S; tiers: Map<string, S> }>();
  for (const d of done) {
    if (d.at < now - WEEK) continue;
    const k = ukey(d.project, d.squad, d.unit), t = times.get(k) ?? NO_TIMES;
    if (!samples.has(d.project)) samples.set(d.project, { all: fresh(), tiers: new Map() });
    const ps = samples.get(d.project)!, tier = tier_of[k] ?? null;
    if (tier && !ps.tiers.has(tier)) ps.tiers.set(tier, fresh());
    const targets = tier ? [ps.all, ps.tiers.get(tier)!] : [ps.all];
    const disp = first(t.dispatched), pr = first(t.pr), armed = firstFrom(t.armed, pr);
    for (const s of targets) {
      if (disp != null && pr != null && pr >= disp) s.building.push(pr - disp);
      if (pr != null && (armed ?? d.at) >= pr) s.pr_open.push((armed ?? d.at) - pr);
      if (armed != null && d.at >= armed) s.merging.push(d.at - armed);
    }
  }
  const out: Record<string, Typical> = {};
  const med = (xs: number[]) => (xs.length >= MIN_SAMPLES ? median(xs) : null);
  const stages = (s: S): Stages => ({ building: med(s.building), pr_open: med(s.pr_open), merging: med(s.merging) });
  for (const p of [...samples.keys()].sort()) {
    const ps = samples.get(p)!, tiers: Record<string, Stages> = {};
    for (const tn of [...ps.tiers.keys()].sort()) {
      const m = stages(ps.tiers.get(tn)!);
      if (m.building != null || m.pr_open != null || m.merging != null) tiers[tn] = m;
    }
    out[p] = { ...stages(ps.all), ...(Object.keys(tiers).length ? { tiers } : {}) };
  }
  return out;
}

// "YYYY-MM-DD" of the host's local day (TZ).
export const localDay = (epoch: number): string => {
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// The last 30 local days, oldest first, with the units merged on each (zero days included).
export function mergedPerDay(events: FlowEvent[], now: number, days = 30, done = doneRows(events)): { day: string; merged: number }[] {
  const d = new Date(now * 1000), out: { day: string; merged: number }[] = [];
  for (let i = days - 1; i >= 0; i--) out.push({ day: localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12).getTime() / 1000), merged: 0 });
  const at = new Map(out.map((r, i) => [r.day, i]));
  for (const e of done) { const i = at.get(localDay(e.at)); if (i != null) out[i].merged++; }
  return out;
}

// Pickup order of the queued cards, per project (U6): waiting for an account (by wait_until, unknown
// last, then place), waiting for a slot (by place), then units waiting on another unit (by place, so
// units.id) and held, which cannot start and get no position. Sets `queue_pos` on the cards; returns
// their keys in that order. The place comes from slot.ts placeOf, so the board and the loop agree.
const PLACE_LAST = [Infinity];
const cmpPlace = (a: number[] | null | undefined, b: number[] | null | undefined) => {
  const x = a ?? PLACE_LAST, y = b ?? PLACE_LAST;
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
};
function queueOrder(cards: { key: string; project: string; stage: Stage; group: string | null; queue_pos: number | null }[], units: FlowUnit[]): string[] {
  const unit = new Map(units.map((u) => [ukey(u.project, u.squad, u.slug), u]));
  const q = cards.filter((c) => c.stage === "queued");
  const rankOf = (g: string | null) => ["waiting for an account", "waiting for the host", "waiting for a slot", "waiting on another unit", "held"].indexOf(g ?? "");
  const waitOf = (c: { key: string }) => { const p = unit.get(c.key)?.pick; return p?.wait_known === 1 && p.wait_until ? p.wait_until : Infinity; };
  q.sort((a, b) => a.project.localeCompare(b.project) || rankOf(a.group) - rankOf(b.group)
    || (a.group === "waiting for an account" ? waitOf(a) - waitOf(b) || 0 : 0)
    || cmpPlace(unit.get(a.key)?.place, unit.get(b.key)?.place) || a.key.localeCompare(b.key));
  const n = new Map<string, number>();
  for (const c of q) {
    if (c.group === "waiting for an account" || c.group === "waiting for the host" || c.group === "waiting for a slot") { const k = (n.get(c.project) ?? 0) + 1; n.set(c.project, k); c.queue_pos = k; }
  }
  return q.map((c) => c.key);
}

export function flowOf(input: FlowInput) {
  const { now, units, events } = input;
  const times = timesOf(events), done = doneRows(events);
  const typical = typicalTimes(events, now, times, done, input.tier_of ?? {});
  for (const p of [...input.squads.map((s) => s.project), ...units.map((u) => u.project)])
    typical[p] ??= { building: null, pr_open: null, merging: null };
  const reviews = new Map((input.reviews ?? []).map((r) => [ukey(r.project, r.squad, r.slug), r]));
  const seatedKeys = new Set((input.seated ?? []).map((h) => ukey(h.project, h.squad, h.unit)));
  const cards = units.map((u) => {
    const depsDone = u.deps.map((d) => last(times.get(ukey(u.project, u.squad, d))?.done ?? [])).filter((n): n is number => n != null);
    const k = ukey(u.project, u.squad, u.slug);
    const s = unitStage(u, times.get(k), depsDone.length ? Math.max(...depsDone) : null, reviews.get(k) ?? null, now, seatedKeys.has(k));
    const inStage = s.since == null ? null : Math.max(0, now - s.since);
    const st = s.stage === "building" || s.stage === "pr_open" || s.stage === "merging" ? s.stage : null;
    const typ = st ? ((u.tier_key ?? u.tier) ? typical[u.project]?.tiers?.[(u.tier_key ?? u.tier)!]?.[st] : null) ?? typical[u.project]?.[st] ?? null : null;
    const floor = (input.floor_min[u.project] ?? 10) * 60;
    // A ready PR waiting for its Builder has no typical time: the floor alone.
    const readyWait = s.stage === "merging" && s.note === "ready · waiting for finish-unit";
    const late = inStage != null && (readyWait ? inStage > floor : typ != null && inStage > Math.max(2 * typ, floor));
    // A paused building, pr_open or merging card moves to the lane's `paused` group (unitStage keeps its stage and group);
    // its note says why and its time is the pause's, while since / in_stage_s stay the stage's.
    const isPaused = u.paused && (s.stage === "building" || s.stage === "pr_open" || s.stage === "merging");
    const stale = !u.paused && u.status === "dispatched" && u.stale;
    // Late is stuck when its Builder shows no sign of work for flow_quiet_min, else slow. A stale card, and
    // a ready PR waiting for its Builder to run finish-unit, are stuck whatever the activity.
    const quiet = (input.quiet_min?.[u.project] ?? 20) * 60;
    const idle = readyWait || u.active_at == null || now - u.active_at > quiet;
    const live = !u.paused && s.stage !== "needs_you" && s.stage !== "queued";
    const stuck = live && (stale || (late && idle));
    const slow = live && !stuck && late;
    return {
      key: ukey(u.project, u.squad, u.slug), project: u.project, squad: u.squad, slug: u.slug, tier: u.tier,
      stage: s.stage, group: isPaused ? "paused" : s.group, since: s.since, in_stage_s: inStage,
      paused: isPaused, paused_s: isPaused && u.paused_at != null ? Math.max(0, now - u.paused_at) : null, stuck, slow, stale, active_at: u.active_at ?? null, typical_s: typ,
      needs_you: s.stage === "needs_you", ask: u.question?.id ? ukey(u.project, u.squad, u.question.id) : null,
      note: isPaused ? u.paused_why ?? s.note : s.stage === "queued" && u.paused ? u.paused_why ?? s.note : s.note, pr: u.pr, open_pr: s.open_pr, queue_pos: null as number | null, urgent: u.urgent === true, focus: u.focus ?? null, ...(u.unlocks ? { unlocks: u.unlocks, ...(u.unlock ? { unlock: "on" as const } : {}) } : {}),
      ...(u.lane ? { lane: u.lane, lane_rule: u.lane_rule ?? null, lane_cpu_h: u.lane_cpu_h, lane_limit_h: u.lane_limit_h } : {}),
    };
  });
  const queued_order = queueOrder(cards, units);
  const perDay = mergedPerDay(events, now, 30, done);
  const merged = done.filter((e) => e.at >= now - WEEK).map((e) => {
    const disp = first(times.get(ukey(e.project, e.squad, e.unit))?.dispatched ?? []);
    return { key: ukey(e.project, e.squad, e.unit), project: e.project, squad: e.squad, slug: e.unit, pr: e.pr ?? null, pr_url: e.pr != null && input.repo_slug?.[e.project] ? `https://github.com/${input.repo_slug[e.project]}/pull/${e.pr}` : null, at: e.at,
      took_s: disp != null && e.at >= disp ? e.at - disp : null,
      focus: input.focus_squad?.[e.project] === e.squad ? "muted" as const : null };
  });
  const count = (st: Stage) => cards.filter((c) => c.stage === st && !c.paused).length;
  const squads: Record<string, { stuck: number; slow: number; longest_stuck_s: number | null; needs_you: number; last_merge_at: number | null }> = {};
  const sq = (k: string) => (squads[k] ??= { stuck: 0, slow: 0, longest_stuck_s: null, needs_you: 0, last_merge_at: null });
  for (const s of input.squads) sq(`${s.project}/${s.squad}`);
  for (const c of cards) {
    const s = sq(`${c.project}/${c.squad}`);
    if (c.needs_you) s.needs_you++;
    if (c.slow) s.slow++;
    if (c.stuck) { s.stuck++; s.longest_stuck_s = Math.max(s.longest_stuck_s ?? 0, c.in_stage_s ?? 0); }
  }
  for (const e of done) { const s = sq(`${e.project}/${e.squad}`); if (s.last_merge_at == null || e.at > s.last_merge_at) s.last_merge_at = e.at; }
  return {
    counts: {
      queued: count("queued"), building: count("building"), pr_open: count("pr_open"), needs_you: count("needs_you"), merging: count("merging"), paused: cards.filter((c) => c.paused).length,
      stuck: cards.filter((c) => c.stuck).length, slow: cards.filter((c) => c.slow).length, open_prs: cards.filter((c) => c.open_pr).length,
      merged_today: perDay[perDay.length - 1].merged,
    },
    cards: cards.map(({ open_pr, ...c }) => c),
    queued_order,
    merged,
    per_day: perDay,
    typical_s: Object.fromEntries(Object.keys(typical).sort().map((k) => [k, typical[k]])),
    median_total_s: median(merged.map((m) => m.took_s).filter((n): n is number => n != null)),
    squads: Object.fromEntries(Object.keys(squads).sort().map((k) => [k, squads[k]])),
  };
}

export type Flow = ReturnType<typeof flowOf>;

export const flowLine = (f: Flow): string => {
  const c = f.counts;
  return `FLOW ${c.queued} queued · ${c.building} building · ${c.pr_open} PR open · ${c.merging} merging · ${c.stuck} stuck${c.slow ? ` · ${c.slow} slow` : ""} · ${c.needs_you} needs you${c.paused ? ` · ${c.paused} paused` : ""} · ${c.merged_today} merged today`;
};
