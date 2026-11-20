// slot.ts — a project runs at most `max_builders` live Builder agents (U145), oldest work first.
// pick() (bin/loop/capacity/pick.ts) asks it before anything else, so every start that picks — add-role,
// restart-role, the loop's member wishes and their pause resumes — waits the same way.
//   live        a Builder member of a live squad, not gone, whose agent runs: its lock held (a start
//               or other lifecycle act in flight, member-state.ts), holding a loop start slot
//               (picks.slot = 1), a start or restart within the spawn grace that no walk since has read
//               gone, or a worker whose presence (U149) is running or not known yet, or a `running`
//               member not observed yet. A Builder being paused holds its place until its presence
//               reads running no more.
//   held        a `ds pick` (add-role, restart-role) that gave a Builder a slot in the spawn grace,
//               for one not live yet: a shell start the observer has not seen. ds pick checks and
//               records it in one immediate transaction, so two shell starts never share a slot.
//   candidate   a Builder with no live agent that asks to run: its standing wish reads running (not
//               given up, not paused, its unit not finished; member-state.ts view), plus the one
//               asking. A pause resume that cannot go ahead (a dependency hold, its retained worktree
//               missing, or given up: a failed resume waits on the operator's retry) does not ask.
//   slot        free = limit − live. The asker gets one when fewer than `free` candidates are older:
//               an urgent unit before every non-urgent one, then a unit that blocks started work (a dep
//               of another `dispatched` unit, U221) before one that does not, then a unit of the focus
//               squad while its focus key is on (squad-priority U1: `focus_squad`, see Focus below), then a
//               dispatched unit before a planned (or unit-less) one, then the lower units.id, then the lower
//               member id (an asker with no row yet last). Blocking and focus never go over the limit; only urgent does. An urgent unit's Builder always gets one: the project goes one over
//               the limit until a Builder finishes (U168).
// A Builder that is already live (a hung restart, a run-switch, a limit move, a phase switch)
// replaces its own agent and is never refused; Studio, Leads, Thinkers and the rest are never limited.
// Light lane (adaptive-builder-capacity U3), on when `max_light_builders` > 0 (0, the default, takes the
// single-lane path above unchanged). A unit's lane is its doc's `lane` (plan `Lane: light`, U1); a light
// unit whose CPU (unit_cpu, U2) passes `light_lane_cpu_h` counts as normal from then on and records one
// `unit_lane_moved` event (it is never stopped). The line, oldest first as above, is walked slot by slot:
//   normal      starts while live normal < max_builders and the live total < max_builders + max_light_builders
//   light       starts while the live total < that sum: in a light slot while live light < max_light_builders,
//               else in a normal slot, only while no normal unit of the project waits
// An urgent unit still always starts. The wait names both lanes: `WAIT slot: <p> normal 6/6, light 2/2`.
// Read-only views for the board (board-shows-host-brake U1), from the same line and seat walk (`walk`):
//   seats()     each live seat with why it is held (liveWhy: starting, pausing, restarting, working, idle;
//               builderLive is liveWhy != null), the `ds pick` holds and the seats used per lane
//   seatable()  the queue() entries the walk seats now, less a planned unit whose Builder is live and a
//               Builder whose pick waits on an account: what the host brake keeps from starting
import { failedResume, intents, type Target } from "../pause/pause.ts";
import { lastStart, lock, view } from "../squad/member-state.ts";
import { existsSync } from "node:fs";
import { dependencyReasons, memberUnit } from "../pause/pause-conditions.ts";
import { limit } from "./pick.ts";
import { focusSquad } from "../squad/focus.ts";
import type { Row, Store } from "../core/store.ts";

export type Slot = { ok: true; limit: number | null } | { ok: false; limit: number; live: number; ahead: number; why: string };
// Who asks: a member row, or (a start with no row yet) squad + suffix.
export type Asker = { member?: Row | null; squad?: string | null; suffix?: string | null };

// The project's max_builders (DS_LIMIT_MAX_BUILDERS, its limits.conf, the conventions'); null = no limit.
function maxBuilders(store: Store, project: string): number | null {
  const v = String(limit(store, project, "max_builders") ?? "").trim();
  return /^[1-9]\d*$/.test(v) ? Number(v) : null;
}
// max_light_builders: extra slots only light units take (0 = no light lane, today's single lane).
function maxLight(store: Store, project: string): number {
  const v = String(limit(store, project, "max_light_builders") ?? "").trim();
  return /^\d+$/.test(v) ? Number(v) : 0;
}
// light_lane_cpu_h: CPU-hours after which a light unit counts as normal (default 3).
function lightCpuH(store: Store, project: string): number {
  const v = Number(String(limit(store, project, "light_lane_cpu_h") ?? "").trim() || NaN);
  return Number.isFinite(v) && v > 0 ? v : 3;
}

// How `ds pick` (and so add-role.sh / restart-role.sh, exit 3) says it: no reset time, ask again.
// `WAIT host:` is the Builder host brake (pick.ts, U4): a start wait just like a slot's.
export const SLOT_WAIT = /^WAIT (slot|host):/m;
// A pick that waits for a start (a slot or the host brake), not for an account's reset.
export const startWait = (p: { why?: string }) => p.why === "slot" || p.why === "host";

export const graceS = () => (Number(process.env.DS_SWEEP_SPAWN_GRACE_MIN) || 5) * 60;
const iso = (v: unknown) => (v ? Date.parse(String(v)) / 1000 : NaN);
// Wished running and not given up (the decider's standing wish, U152).
const open = (m: Row) => m.want === "running" && !String(m.want_result ?? "").startsWith("failed");
const target = (m: Row): Target => ({ project: String(m.project), squad: String(m.squad), role: String(m.role), suffix: String(m.suffix ?? ""), member: (m.wt as string | null) ?? null });
const hardPaused = (store: Store, m: Row) => intents(store, target(m)).length > 0;

// Is this Builder's worker present (U149)? `strict`: unknown presence is not proof.
function agentRuns(store: Store, project: string, wt: string, strict: boolean): boolean {
  const w = store.db.query("SELECT presence, gone_at FROM observed_workers WHERE project = ? AND wt = ?").get(project, wt) as { presence: string | null; gone_at: number | null } | null;
  if (!w || w.gone_at != null) return false;
  return strict ? w.presence === "running" : w.presence !== "none";
}

// Why a live Builder holds its seat (the board explains each seat with it, through seats()):
//   starting    its lifecycle lock is held, it holds a loop start slot (picks.slot = 1), a start or restart
//               in the spawn grace, or a `running` member the observer has not seen yet
//   pausing     a pause intent is on it and its agent still runs
//   restarting  U153: a restart newer than its observed process start keeps the seat
//   working     its agent runs and the observer reads it working
//   idle        its agent runs in any other state (at its prompt, waiting for its PR's merge, unknown)
export type SeatWhy = "starting" | "pausing" | "restarting" | "working" | "idle";

// Does this Builder member hold a live agent now, and why? null: it holds no seat.
export function liveWhy(store: Store, m: Row, now: number): SeatWhy | null {
  if (m.status === "gone" || m.want === "gone") return null;
  if (lock(store, m)) return "starting";
  const wt = m.wt ? String(m.wt) : "";
  // Being paused: live until its agent is seen gone (a paused one reads idle with no agent).
  if (hardPaused(store, m)) return wt && agentRuns(store, String(m.project), wt, true) ? "pausing" : null;
  if (open(m) && store.get("picks", { member: m.id })?.slot === 1) return "starting";
  // A start the loop just placed (placed_at) or a restart that stamped `started`/`restarting`, not
  // parked since (`waiting`): its worker may not be observed yet, until a walk after it reads none.
  const t = Math.max(...[Number(m.placed_at ?? NaN), iso(m.started), iso(m.restarting)].filter((v) => !Number.isNaN(v)), -Infinity);
  if (m.status !== "waiting" && t > now - graceS()) {
    const w = wt ? store.get("observed_workers", { project: m.project, wt }) : null;
    if (!(w && w.presence === "none" && Number(w.account_at ?? 0) > t)) return "starting";
  }
  // U153: a restarting Builder keeps its slot: wished running with a restart newer than the
  // observed process start counts live across the close and the start. No stored reservation.
  // Only a Builder that has started before keeps one: a wish on a never-started Builder is a
  // queued start like any other, not a slot to keep.
  if (open(m) && Number(m.restart_at ?? 0) > 0 && lastStart(m) > 0) {
    const w = store.db.query("SELECT started_at FROM observed_workers WHERE project = ? AND wt = ?").get(String(m.project), wt) as { started_at: number | null } | null;
    if (Number(m.restart_at) > Math.max(Number(w?.started_at ?? 0), lastStart(m))) return "restarting";
  }
  if (!wt) return null;
  const w = store.db.query("SELECT presence, gone_at, state FROM observed_workers WHERE project = ? AND wt = ?").get(String(m.project), wt) as { presence: string | null; gone_at: number | null; state: string | null } | null;
  // Never observed yet (a start the observer has not seen): its `running` status says so.
  if (!w) return m.status === "running" ? "starting" : null;
  // Its worker is present unless it is gone or its presence reads none (unknown counts, U149).
  if (w.gone_at != null || w.presence === "none") return null;
  return w.state === "working" ? "working" : "idle";
}
const builderLive = (store: Store, m: Row, now: number) => liveWhy(store, m, now) != null;

// The (squad, suffix) keys of `ds pick` Builder slots given in the spawn grace (see `held` above).
function holds(store: Store, project: string, now: number): Set<string> {
  const rows = store.db.query(`SELECT id, squad, json_extract(payload, '$.suffix') AS suffix FROM events WHERE kind = 'pick' AND at > ? AND project = ?
      AND json_extract(payload, '$.source') = 'ds pick' AND json_extract(payload, '$.role') = 'builder' AND json_extract(payload, '$.wait') IS NULL`)
    .all(now - graceS(), project) as { id: number; squad: string | null; suffix: string | null }[];
  return new Set(rows.map((r) => (r.squad == null || r.suffix == null ? `#${r.id}` : `${r.squad}\0${r.suffix}`)));
}

// Would pause-resume go on with this `resuming` row's start? Its own gates: no dependency hold, and
// the retained worktree is there (reconcilers/pause-resume.ts resumeGate).
function resumable(store: Store, m: Row): boolean {
  if (dependencyReasons(store, target(m), []).length) return false;
  const tree = m.wt ? store.get("observed_worktrees", { project: m.project, wt: m.wt }) : null;
  return !!tree?.path && tree.gone_at == null && existsSync(String(tree.path));
}

// Does this Builder ask to run? With a `resuming` pause row (open wish or not), only when that resume
// can go ahead; otherwise an open start wish.
function asks(store: Store, m: Row, resume: Row | undefined): boolean {
  return resume ? !failedResume(m, resume) && resumable(store, m) : open(m) && view(store, m) === "running";
}

// The project's Builder members in live squads: the latest row per (squad, suffix), never a gone one.
function builders(store: Store, project: string): Row[] {
  return store.db.query(`SELECT * FROM members WHERE project = ?1 AND role = 'builder'
      AND id IN (SELECT MAX(id) FROM members WHERE project = ?1 AND role = 'builder' GROUP BY squad, suffix)
      AND COALESCE(status, '') != 'gone' AND COALESCE(want, '') != 'gone'
      AND squad IN (SELECT topic FROM squads WHERE project = ?1 AND COALESCE(status, 'running') NOT IN ('suspended', 'on-hold', 'done', 'failed', 'closed', 'gone'))
    ORDER BY id`).all(project) as Row[];
}

// The dispatched units that wait on this unit (U221): it blocks started work. Their `deps` hold its
// slug (same squad) or `<squad>/<slug>` in `ext_deps`; a done or cancelled dependent no longer waits.
export function blocksOf(store: Store, project: string, u: Row | null): string[] {
  if (!u) return [];
  const rows = store.db.query("SELECT squad, slug, deps, ext_deps FROM units WHERE project = ? AND status = 'dispatched'").all(project) as Row[];
  const list = (v: unknown): string[] => { try { const a = JSON.parse(String(v ?? "[]")); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
  return rows.filter((r) => !(r.squad === u.squad && r.slug === u.slug)
    && ((r.squad === u.squad && list(r.deps).includes(String(u.slug))) || list(r.ext_deps).includes(`${u.squad}/${u.slug}`))).map((r) => String(r.slug));
}

// A candidate's place in line: an urgent unit first (U168, read from the unit row's doc, as
// memberUnit returns it — urgent is a doc-only flag, no column), then a unit that blocks started
// work (U221), then a unit of the focus squad while its focus key is on (squad-priority U1, lineOrder),
// then a dispatched unit, then the lower unit id (no unit = last), then the lower member id, so no two
// candidates tie.
type Rank = [number, number, number, number, number, number];
// A unit row's doc (urgent, lane: doc-only flags, no column); {} when it has none or it does not parse.
const docOf = (u: Row | null): Row => { try { return (u?.doc ? JSON.parse(String(u.doc)) : {}) ?? {}; } catch { return {}; } };
const urgentOf = (u: Row | null) => docOf(u).urgent === true;
// The unit part of a candidate's place: [urgent, blocks started work, focus, dispatched, units.id].
// `focused`: the focus key is on for this unit (lineOrder decides). The board reads it too
// (bin/board/board-data.ts, through queue()), so the board and the loop rank the same way. Only reads.
export function placeOf(store: Store, project: string, u: Row | null, focused = false): [number, number, number, number, number] {
  return [urgentOf(u) ? 0 : 1, blocksOf(store, project, u).length ? 0 : 1, focused ? 0 : 1, u?.status === "dispatched" ? 0 : 1, u ? Number(u.id) : Number.MAX_SAFE_INTEGER];
}
const older = (a: Rank, b: Rank) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };

// One candidate in line: who asks (squad, suffix, its member row when it has one), its unit and lane.
export type Entry = { squad: string; suffix: string; m: Row | null; u: Row | null; lane: Lane };
export type Placed<E extends Entry = Entry> = E & { rank: Rank; focus: boolean };
// The focus squad (squad-priority U1) and, per lane, how many of its units still get the focus key:
// that lane's seats − 1 − what the squad holds there, at least 0 (normal seats = max_builders, light seats =
// max_light_builders; with the light lane off every unit is normal). So a lane with one seat gives none,
// and the last seat of each lane always goes by the usual order. null: no focus that counts.
type Focus = { squad: string; room: Record<Lane, number> } | null;

function focusFor(store: Store, project: string, n: number, light: number, held: (squad: string) => Record<Lane, number>): Focus {
  const squad = focusSquad(store, project);
  if (!squad) return null;
  const h = held(squad);
  return { squad, room: { normal: Math.max(0, n - 1 - h.normal), light: light > 0 ? Math.max(0, light - 1 - h.light) : 0 } };
}

// The line in place order. Without a focus it is a sort on placeOf, then the member id. With one, each
// focus squad unit taken in order (an urgent or unblocking one too: it takes a seat as well) uses one of
// its lane's room; once that room is used up, its later units rank by age like everyone else's.
export function lineOrder<E extends Entry>(store: Store, project: string, entries: E[], focus: Focus): Placed<E>[] {
  const left = entries.map((e) => ({ e, p: placeOf(store, project, e.u), mid: e.m ? Number(e.m.id) : Number.MAX_SAFE_INTEGER }));
  const room = focus ? { ...focus.room } : null;
  const mine = (e: E) => !!focus && e.squad === focus.squad;
  const out: Placed<E>[] = [];
  while (left.length) {
    let best = 0, bestRank: Rank | null = null, bestFocus = false;
    for (let i = 0; i < left.length; i++) {
      const { e, p, mid } = left[i];
      const f = !!room && mine(e) && room[e.lane] > 0;
      const r: Rank = [p[0], p[1], f ? 0 : 1, p[3], p[4], mid];
      if (!bestRank || older(r, bestRank)) { best = i; bestRank = r; bestFocus = f; }
    }
    const [{ e }] = left.splice(best, 1);
    if (room && mine(e)) room[e.lane] = Math.max(0, room[e.lane] - 1);
    out.push({ ...e, rank: bestRank!, focus: bestFocus });
  }
  return out;
}

// Does the unit of this (squad, slug) block started work, and which? For ready.ts's queue order.
export function blocking(store: Store, project: string, squad: string, slug: string): string[] {
  return blocksOf(store, project, store.get("units", { project, squad, slug }));
}

type Lane = "normal" | "light";

// Pure: the lane a unit's doc and CPU-hours give. `light` (doc lane light, CPU not past `cpuH`), `moved` (light, past
// it: counts normal) or `normal`. The board reads this too (bin/board/board-data.ts); it records nothing.
export function laneNow(doc: Row | null | undefined, cpuHours: number, cpuH: number): "light" | "moved" | "normal" {
  if (!doc || doc.lane !== "light") return "normal";
  return cpuHours <= cpuH ? "light" : "moved";
}

// The lane a unit counts in now: light when its doc says so and its CPU has not passed `cpuH`. The first
// time a light unit is read past it, one `unit_lane_moved` event says so (unit, CPU-hours, rule).
function cpuHours(store: Store, project: string, u: Row): number {
  const r = store.db.query("SELECT cpu_s FROM unit_cpu WHERE project = ? AND squad = ? AND slug = ?").get(project, String(u.squad), String(u.slug)) as { cpu_s: number } | null;
  return Number(r?.cpu_s ?? 0) / 3600;
}
// laneOf without the event: what the board's read-only store may call.
function laneRead(store: Store, project: string, u: Row | null, cpuH: number): Lane {
  return u && laneNow(docOf(u), cpuHours(store, project, u), cpuH) === "light" ? "light" : "normal";
}
function laneOf(store: Store, project: string, u: Row | null, cpuH: number): Lane {
  const doc = docOf(u);
  if (!u || doc.lane !== "light") return "normal";
  const h = cpuHours(store, project, u);
  if (laneNow(doc, h, cpuH) === "light") return "light";
  if (!store.db.query("SELECT 1 FROM events WHERE kind = 'unit_lane_moved' AND project = ? AND squad = ? AND unit = ?").get(project, String(u.squad), String(u.slug)))
    store.event("unit_lane_moved", { project, squad: String(u.squad), unit: String(u.slug),
      payload: { unit: String(u.slug), cpu_h: Math.round(h * 100) / 100, rule: doc.lane_rule ?? null, light_lane_cpu_h: cpuH } });
  return "normal";
}

// The procs observer calls this each time it adds CPU to a unit, so a light unit's move to normal is
// recorded when it happens, not only when some Builder next asks for a slot. Light lane off: nothing.
export function noteLaneMove(store: Store, project: string, squad: string, slug: string): void {
  if (maxLight(store, project) > 0) laneOf(store, project, store.get("units", { project, squad, slug }), lightCpuH(store, project));
}

// The asker's member row: the one named, else the latest Builder row of its squad + suffix.
function askerRow(store: Store, project: string, who: Asker): Row | null {
  if (who.member) return who.member;
  if (!who.squad || who.suffix == null) return null;
  return store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = 'builder' AND suffix = ? ORDER BY id DESC").get(project, who.squad, who.suffix) as Row | null;
}

// Does this pick start a new Builder agent? A Builder asker with no live agent; a live Builder that
// replaces its own agent and every other role do not (the host brake's subject, pick.ts).
export function newBuilderStart(store: Store, project: string, who: Asker, now: number, role = "builder"): boolean {
  const me = askerRow(store, project, who);
  return String(me?.role ?? role) === "builder" && !(me && builderLive(store, me, now));
}

// Who is in line now, as slot() and queue() see it: every Builder that waits for a seat (not `exclude`,
// the asker), the live seats per lane and per squad, the lane of a unit, and the focus.
function lineCtx(store: Store, project: string, n: number, now: number, exclude: string, record: boolean) {
  const all = builders(store, project).map((m) => { const why = liveWhy(store, m, now); return { m, why, live: why != null }; });
  const key = (m: Row) => `${m.squad}\0${m.suffix ?? ""}`, liveKeys = new Set(all.filter((b) => b.live).map((b) => key(b.m)));
  const heldKeys = [...holds(store, project, now)].filter((k) => k !== exclude && !liveKeys.has(k));
  const resuming = new Map((store.db.query("SELECT * FROM pause_members WHERE project = ? AND role = 'builder' AND state = 'resuming'").all(project) as Row[])
    .map((r) => [key(r), r]));
  const waiting = all.filter(({ m, live }) => !live && key(m) !== exclude && asks(store, m, resuming.get(key(m))) && !hardPaused(store, m)).map(({ m }) => m);
  const light = maxLight(store, project), cpuH = light > 0 ? lightCpuH(store, project) : 0;
  const unitOf = (sq: string, sf: string, m: Row | null) => memberUnit(store, { project, squad: sq, role: "builder", suffix: sf, member: (m?.wt as string | null) ?? null });
  // With the light lane off every unit is normal (and no lane move is recorded).
  const laneAt = (u: Row | null): Lane => (light <= 0 ? "normal" : record ? laneOf(store, project, u, cpuH) : laneRead(store, project, u, cpuH));
  // Live now, per lane and per squad: the live members, plus the `ds pick` holds (a hold with no squad/suffix counts normal).
  const used = { normal: 0, light: 0 };
  const bySquad = new Map<string, Record<Lane, number>>();
  const take = (sq: string | null, lane: Lane) => {
    used[lane]++;
    if (sq == null) return;
    const h = bySquad.get(sq) ?? { normal: 0, light: 0 };
    h[lane]++; bySquad.set(sq, h);
  };
  // Who holds each member seat and why (seats()); the holds are only counted.
  const holders: SeatHolder[] = [];
  for (const b of all) {
    if (!b.why) continue;
    const sq = String(b.m.squad), sf = String(b.m.suffix ?? ""), u = unitOf(sq, sf, b.m), lane = laneAt(u);
    take(sq, lane);
    holders.push({ squad: sq, suffix: sf, unit: u ? String(u.slug) : null, lane, why: b.why });
  }
  for (const k of heldKeys) { const [sq, sf = ""] = k.startsWith("#") ? [] : k.split("\0"); take(sq ?? null, sq == null ? "normal" : laneAt(unitOf(sq, sf, null))); }
  const focus = focusFor(store, project, n, light, (sq) => bySquad.get(sq) ?? { normal: 0, light: 0 });
  const entry = (sq: string, sf: string, m: Row | null): Entry => { const u = unitOf(sq, sf, m); return { squad: sq, suffix: sf, m, u, lane: laneAt(u) }; };
  // A planned unit whose Builder already waits is in the line once, as that member (so it takes focus room once).
  const waitingKeys = new Set(waiting.map(key));
  const unwished = (p: Asker) => !waitingKeys.has(`${p.squad}\0${p.suffix ?? ""}`);
  return { live: liveKeys.size + heldKeys.length, used, waiting, unwished, light, focus, entry, unitOf, liveKeys, holders, holds: heldKeys.length };
}

// The seat walk slot() gives free seats by, oldest first: does each entry of the line get a seat now?
// Single lane: an urgent unit always (over the limit, U168), else the first `n − live` places. Light lane:
// seat by seat (the rules in the header), an urgent unit always. seatable() walks the same line.
function walk<P extends Placed>(line: P[], n: number, light: number, used: Record<Lane, number>, live: number): boolean[] {
  if (light <= 0) return line.map((p, i) => p.rank[0] === 0 || i < n - live);
  const u = { ...used }, cap = n + light, placed = line.map(() => false);
  const fits = (i: number) => {
    const p = line[i];
    if (p.rank[0] === 0) return true;                                  // urgent: always, over the limit
    if (u.normal + u.light >= cap) return false;
    if (p.lane === "normal") return u.normal < n;
    return u.light < light || !line.some((q, j) => j !== i && !placed[j] && q.lane === "normal");
  };
  for (let i = 0; i < line.length; i++) if (fits(i)) { placed[i] = true; u[line[i].lane]++; }
  return placed;
}

// The line a free seat is given by, oldest first: every waiting Builder and the `planned` units (one entry
// per unit: a planned unit whose Builder waits is that member's entry), in the
// same order slot() walks (lineOrder). ready.ts sorts its queue by it and the board's Flow shows it, so
// the three never disagree. Empty when the project has no limit. Only reads: a lane is read with
// laneNow, never recorded, so the board's read-only store can call it.
export function queue(store: Store, project: string, now: number, planned: Asker[] = []): Placed[] {
  return lineOf(store, project, now, planned)?.line ?? [];
}
function lineOf(store: Store, project: string, now: number, planned: Asker[]) {
  const n = maxBuilders(store, project);
  if (n == null) return null;
  const c = lineCtx(store, project, n, now, "\0\0", false);
  const line = lineOrder(store, project, [
    ...c.waiting.map((m) => c.entry(String(m.squad), String(m.suffix ?? ""), m)),
    ...planned.filter(c.unwished).map((p) => c.entry(String(p.squad), String(p.suffix ?? ""), null)),
  ], c.focus);
  return { n, c, line };
}

// One live Builder seat: whose it is, its unit (null: none found) and lane, and why it is held.
export type SeatHolder = { squad: string; suffix: string; unit: string | null; lane: Lane; why: SeatWhy };
// The project's Builder seats as slot() counts them: `limit` (max_builders, null = none), `light`
// (max_light_builders, 0 = no light lane), each live member's seat with its why, the `ds pick` holds
// (only counted) and `used` per lane (members and holds; with the light lane off all normal).
export type Seats = { limit: number | null; light: number; holders: SeatHolder[]; holds: number; used: Record<Lane, number> };
// Only reads, like queue(): the board's read-only store calls it.
export function seats(store: Store, project: string, now: number): Seats {
  const n = maxBuilders(store, project);
  const c = lineCtx(store, project, n ?? 0, now, "\0\0", false);
  return { limit: n, light: c.light, holders: c.holders, holds: c.holds, used: c.used };
}

// The entries of queue() that would get a seat now, by the same walk slot() uses: the queued units the
// host brake keeps from starting while it holds (the board's `held`). Two entries are dropped before the
// walk because they would not start with the brake off either: a planned unit whose Builder is already
// live (the line lists it again, as a planned entry), and a waiting Builder whose latest pick waits on an
// account. Empty when the project has no limit. Only reads.
export function seatable(store: Store, project: string, now: number, planned: Asker[] = []): Placed[] {
  const q = lineOf(store, project, now, planned);
  if (!q) return [];
  const { n, c } = q;
  const line = q.line.filter((e) => (e.m ? !accountWait(store, e.m) : !c.liveKeys.has(`${e.squad}\0${e.suffix}`)));
  const seat = walk(line, n, c.light, c.used, c.live);
  return line.filter((_, i) => seat[i]);
}
// A pick that waits on an account's room (the pick reconciler's `no account free`, with a wait time),
// not on a start (a slot or the host brake).
function accountWait(store: Store, m: Row): boolean {
  const p = store.get("picks", { member: m.id });
  return !!p && p.wait_until != null && !SLOT_WAIT.test(String(p.reason ?? ""));
}

// May this Builder start now? `role` is the asker's role when no member row says it. `planned`: the
// planned units that also want the next seat but have no wish yet (ready.ts), every one but the asker,
// ranked into the line with the waiting Builders (the asker among them is left out).
export function slot(store: Store, project: string, who: Asker, now: number, role = "builder", planned: Asker[] = []): Slot {
  const n = maxBuilders(store, project);
  const me = askerRow(store, project, who);
  if (n == null || String(me?.role ?? role) !== "builder") return { ok: true, limit: n };
  if (me && builderLive(store, me, now)) return { ok: true, limit: n };
  const squad = String(me?.squad ?? who.squad ?? ""), suffix = String(me?.suffix ?? who.suffix ?? "");
  const c = lineCtx(store, project, n, now, `${squad}\0${suffix}`, true);
  // An urgent asker jumps the queue (U168): nothing counts ahead of it — older non-urgent candidates
  // rank after it, planned units with no wish yet are ignored, and the limit never holds it. Several
  // urgent units at once each start; the rest wait as usual.
  const myUnit = c.unitOf(squad, suffix, me);
  if (urgentOf(myUnit)) return { ok: true, limit: n };
  // The board shows the line as is: a blocker that waits says why it is next (U221).
  const next = () => { const b = blocksOf(store, project, myUnit); return b.length ? ` (next: blocks ${b.join(", ")})` : ""; };
  const cand = (sq: string, sf: string, m: Row | null, isMe = false) => ({ ...c.entry(sq, sf, m), me: isMe });
  const line = lineOrder(store, project, [
    ...c.waiting.map((m) => cand(String(m.squad), String(m.suffix ?? ""), m)),
    ...planned.filter((p) => !(p.squad === squad && p.suffix === suffix) && c.unwished(p)).map((p) => cand(String(p.squad), String(p.suffix ?? ""), null)),
    cand(squad, suffix, me, true),
  ], c.focus);
  const light = c.light, seat = walk(line, n, light, c.used, c.live), mine = line.findIndex((p) => p.me);
  if (light > 0) {
    // Ahead: every other entry the walk seats (the asker has none).
    if (seat[mine]) return { ok: true, limit: n + light };
    return { ok: false, limit: n + light, live: c.used.normal + c.used.light, ahead: seat.filter(Boolean).length,
      why: `WAIT slot: ${project} normal ${c.used.normal}/${n}, light ${c.used.light}/${light}${next()}` };
  }
  if (seat[mine]) return { ok: true, limit: n };
  return { ok: false, limit: n, live: c.live, ahead: mine, why: `WAIT slot: ${project} at max_builders ${n}${next()}` };
}
