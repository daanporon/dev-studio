// alerts.ts — sweep steps 5 and 8 as one reconciler (U10, R17). Ported from the removed sweep on main
// at 0fbb8be654cda578a94410017c6a1d8c63f2e3e8 (runaway_units, reap_pickers, alert).
//
//   5. runaway unit: a dispatched unit whose Builder's cache_write (observed_tokens, the board's
//      mangled worktree path, never <synthetic>) is over unit_token_x x the median of the project's
//      done units of its tier (untagged = hard; needs 3 with spend), else over unit_token_max, gets
//      ONE alert on its squad (key unit-tokens.<topic>.<unit>, episode unit-tokens).
//   8. picker entries: a source:"picker" entry (observed_pickers) whose picker is gone gets ONE
//      `picker` request {op: resolve, id, squad, reason}, which the actuator (U11) carries out as
//      `squad-state.sh resolve-question`. Gone: its picker closed (a tool_result in the transcript,
//      or the picker-done tombstone); its worktree (card_wt, else the asker's member row) has no
//      worker state; it has no live terminal; or it is not `waiting` and the entry is over 2 min
//      old. A missing transcript is no signal; with no worktree known only the transcript reaps.
// An alert is an `alert` action {target: squad|project, id, text, option, why}: the tick's claim
// keeps it to one per (subject, episode), and an episode the sweep already alerted (its
// <key>.alerted marker, imported as an `alerted` episodes row) is not alerted again.
//
// U56, what is no longer true leaves the board:
//   usage-limit questions  an open sweep question on a squad (`sweep-<topic>.<who>-<n>`, "usage limit")
//            whose member is gone or no longer limited is answered by `reality`; of several for one
//            member only the newest stays open.
//   Studio alerts          a sweep alert in alerts.json (asker sweep) whose condition is gone gets an
//            `alert-clear` of its exact id: the Studio runs again, its context is under context_compact,
//            the member it names is gone or recovered, a refusal card's row (U150) no longer stands.
//            A kind this cannot judge goes once it is over a day old without a repeat (alerts.sh add
//            of the same id restamps `since`).
//   U67, Restart failed    one card per member (fulfil/request.ts giveUp, kind restart_failed, its member's
//            worktree and episode): gone once the member is gone, its limit episode closed, or it runs on
//            a listed account; a card from before U67 is matched by its text "<who> of <squad> (…".
//   U199, Reviews stopped   (`review-stopped:<branch>`, kind review_stopped, from bin/review/review-unit.sh): gone once its
//            unit is done or cancelled, its squad closed, its worktree removed, or the worktree's
//            ds-review-stop file is missing or under 2 (the stop was lifted); an older card with no kind
//            finds its unit by the branch and goes with "no unit has this branch" when none is found.
//            The board shows one for a squad's unit as a loop note first and in Needs-you after refusal_needs_min.
//   account-skills U3, a broken account   (`sweep-account-skills.<account>-<n>`, reconcilers/account-skills.ts):
//            gone once the account's skills read `ok` or `warn:`, or its row is gone; skills NULL (a
//            10-column accounts.tsv) cannot be judged, so the day-old rule applies.
//   disk-pressure U3, a low disk   (`sweep-disk-pressure.<path>-<n>`, reconcilers/disk-pressure.ts):
//            gone once the disk's spell closed (free space above disk_card_free_pct + 5 points, the limit 0, or the disk unlisted).
import { existsSync, readFileSync } from "node:fs";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { limitInt } from "../settings/limits.ts";
import { accountList } from "../capacity/pick.ts";
import { mangle, wtPath } from "../observers/orca.ts";
import { answer } from "../messages/questions.ts";
import { liveCtx } from "./compaction.ts";
import { skillsOf } from "./account-skills.ts";
import { STRAY_KIND } from "./members.ts";
import { REFUSAL_KIND } from "../io/refusals.ts";
import { paused } from "../pause/pause.ts";
import { headOf } from "../squad/pr-ready.ts";
import { envInt } from "../core/tick.ts";
import { allDone } from "../pause/wake.ts";
import { retestDue } from "../squad/retest.ts";
import { gitDir } from "../io/git-dir.ts";
import { cancellationReality, cancellationRepository, sharedBuilder, sharedPr, prNumber } from "../squad/cancel.ts";

const PICKER_STALE_S = 120;

// POSIX cksum of a string: the sweep's alert ids end in it (`sweep-<key>-<cksum of the episode>`).
export function cksum(s: string): number {
  let crc = 0;
  const step = (byte: number) => {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  };
  const b = Buffer.from(s, "utf8");
  for (const x of b) step(x);
  for (let n = b.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
  return ~crc >>> 0;
}

// The sweep's alert(): one per episode, on the squad (enqueue-question) or on the project (alerts.json).
// `idEpisode` names the alert id when the claim's episode carries more than the sweep's (a Studio rise
// after a clear), so the loop and the sweep file one alert id for one condition.
export function alertAction(store: Store, a: { project: string; squad: string | null; key: string; episode: string; idEpisode?: string; text: string; option: string; why: string;
  title?: string; unit?: string; card?: string; fields?: Record<string, unknown> }): Action[] {
  if (sweepAlerted(store, a.project, a.key, a.episode)) return [];
  return [{ project: a.project, squad: a.squad, subject: a.key, kind: "alert", episode: a.episode,
    payload: { target: a.squad ? "squad" : "project", id: `sweep-${a.key}-${cksum(a.idEpisode ?? a.episode)}`, title: a.title ?? a.key, text: a.text,
      option: a.option, why: a.why, reason: a.key, episode: a.episode, ...(a.unit ? { unit: a.unit } : {}), ...(a.card ? { card: a.card } : {}), ...(a.fields ? { fields: a.fields } : {}) } }];
}

// Did the sweep's <key>.alerted marker already record this episode?
export function sweepAlerted(store: Store, project: string, key: string, episode: string): boolean {
  const r = store.get("episodes", { project, subject: key, kind: "alerted" });
  if (!r) return false;
  try { return (JSON.parse(String(r.state)) as string[]).includes(episode); } catch { return r.episode_key === episode; }
}

// unit_tokens: each worker's cache_write over its tokens.tsv rows; a Builder worktree is its mangled path.
// The Builder's `<path>:review` row (its headless review session and sub-agents, U102) counts with it.
function cacheWrites(store: Store): (wt: string) => number {
  const by = new Map((store.db.query("SELECT worker, SUM(cache_write) AS n FROM observed_tokens WHERE model != '<synthetic>' GROUP BY worker").all() as { worker: string; n: number | null }[])
    .map((r) => [r.worker, r.n ?? 0]));
  return (wt) => { const k = mangle(wtPath(wt) ?? wt); return (by.get(k) ?? 0) + (by.get(`${k}:review`) ?? 0); };
}

const mega = (n: number) => `${Math.floor(n / 1_000_000)}.${Math.floor(n / 100_000) % 10}M`;
const RUNAWAY_KIND = "runaway_unit";
export const MERGE_CARD = "merge_card";
const hours = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.max(1, Math.round(s / 60))}min`);

// U232: a unit's whole spend, or null when no full figure exists. observed_tokens only holds the
// DS_TOKEN_DAYS window of session logs, so a figure counts as full only for a unit whose Builder started
// inside that window. A dispatched unit's figure is written to an `episodes` row (kind unit-spend, the
// highest seen, count 1 while full) so it outlives the session rows and the removed worktree; a done unit
// reads that row, or the live rows when it never had one.
export function unitSpend(store: Store, project: string, u: Row, now: number, record: boolean, writes = cacheWrites(store)): number | null {
  const wt = String(u.builder_wt ?? "");
  if (!wt) return null;
  const live = writes(wt);
  const key = { project, subject: `unit-spend:${u.squad}/${u.slug}`, kind: "unit-spend" };
  const row = store.get("episodes", key);
  const first = (store.db.query("SELECT MIN(since) AS s FROM members WHERE project = ? AND wt = ? AND since IS NOT NULL").get(project, wt) as { s: string | null } | null)?.s;
  const started = first ? Math.floor(Date.parse(first) / 1000) : NaN;
  const fullNow = Number.isFinite(started) && started >= now - envInt("DS_TOKEN_DAYS", 7) * 86400;
  const full = row ? Number(row.count ?? 0) === 1 && (u.status !== "dispatched" || fullNow) : fullNow;
  const figure = Math.max(live, Number(row?.state ?? 0) || 0);
  if (record && u.status === "dispatched" && (live > 0 || row))
    store.upsert("episodes", key, { squad: String(u.squad), episode_key: "unit-spend", count: full ? 1 : 0, state: String(figure), source: "loop", started_at: Number(row?.started_at ?? now), observed_at: now });
  return full && figure > 0 ? figure : null;
}

// Is a runaway card for this unit on the board now? (the card keeps squad and unit as fields.)
function runawayCard(store: Store, project: string, squad: string, slug: string): boolean {
  const rows = store.db.query("SELECT doc FROM observed_alerts WHERE project = ?").all(project) as { doc: string | null }[];
  return rows.some((r) => { try { const a = JSON.parse(String(r.doc)) as Row; return a.kind === RUNAWAY_KIND && a.squad === squad && a.unit === slug; } catch { return false; } });
}

export function runawayUnits(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx, out: Action[] = [];
  const x = limitInt(store, project, "unit_token_x", 3), max = limitInt(store, project, "unit_token_max", 20_000_000);
  // Live squads only, as the sweep reads squads/*.json and never the archive.
  const units = store.db.query(`SELECT u.squad, u.slug, COALESCE(u.tier, 'hard') AS tier, u.builder_wt, u.status, u.pr FROM units u
    JOIN squads s ON s.project = u.project AND s.topic = u.squad
    WHERE u.project = ? AND s.doc IS NOT NULL AND COALESCE(s.status, '') NOT IN ('closed', 'gone') AND u.builder_wt IS NOT NULL AND u.builder_wt != ''
    ORDER BY u.squad, u.ord, u.slug`).all(project) as Row[];
  const running = units.filter((u) => u.status === "dispatched");
  if (!running.length) return out;
  const writes = cacheWrites(store); // one read of observed_tokens for the whole sweep (U242)
  for (const u of running) {
    if (paused(store, { project, squad: String(u.squad), member: String(u.builder_wt) })) continue;
    const cw = unitSpend(store, project, u, now, true, writes) ?? writes(String(u.builder_wt));
    if (cw <= 0) continue;
    // Only a done unit with a full figure counts toward the basis.
    const done = units.filter((d) => d.status === "done" && d.tier === u.tier).map((d) => unitSpend(store, project, d, now, false, writes) ?? 0).filter((n) => n > 0).sort((a, b) => a - b);
    let lim = max, basis = `the ${Math.floor(max / 1_000_000)}M cap`;
    if (done.length >= 3) {
      const n = done.length, med = n % 2 ? done[(n - 1) / 2] : Math.floor((done[n / 2 - 1] + done[n / 2]) / 2);
      lim = med * x;
      basis = `${x}x the median ${mega(med)} of ${n} done ${u.tier} units`;
    }
    const key = `unit-tokens.${u.squad}.${u.slug}`, mark = { project, subject: key, kind: "runaway" };
    const mk = store.get("episodes", mark);
    const open = runawayCard(store, project, String(u.squad), String(u.slug));
    if (open) {                                     // the card is up: remember the spend it was last seen at
      store.upsert("episodes", mark, { squad: String(u.squad), episode_key: String(mk?.episode_key ?? "unit-tokens"), count: Number(mk?.count ?? 1), state: String(cw), source: "loop", observed_at: now });
      continue;
    }
    // "looked at it" holds until the spend doubles from where it was answered; then once more.
    let episode = "unit-tokens";
    if (mk) {
      if (Number(mk.count ?? 1) >= 2 || cw < 2 * (Number(mk.state) || cw)) continue;
      episode = "unit-tokens@2x";
    } else if (cw <= lim) continue;
    const m = store.db.query("SELECT MIN(since) AS s FROM members WHERE project = ? AND wt = ? AND since IS NOT NULL").get(project, String(u.builder_wt)) as { s: string | null } | null;
    const ran = m?.s && Number.isFinite(Date.parse(m.s)) ? hours(now - Math.floor(Date.parse(m.s) / 1000)) : "an unknown time";
    const text = `${u.slug} in ${u.squad} has spent ${mega(cw)} cache_write tokens, over ${basis}; its Builder has run ${ran}${u.pr ? `, PR ${u.pr}` : ", no PR yet"}. ` +
      `What you can do: open the Builder's terminal and check it is not looping.`;
    const acts = alertAction(store, { project, squad: String(u.squad), key, episode, title: "Unit spending a lot", unit: String(u.slug), card: RUNAWAY_KIND, text,
      option: "looked at it", why: "a Builder may be looping; check its terminal", fields: { spend: cw } });
    if (!acts.length) continue;
    store.upsert("episodes", mark, { squad: String(u.squad), episode_key: episode, count: mk ? 2 : 1, state: String(cw), source: "loop", started_at: now, observed_at: now });
    out.push(...acts);
  }
  return out;
}

// Why a picker entry is stale, or null while it may still be open.
export function pickerStale(store: Store, project: string, squad: string, q: Row, now: number): string | null {
  if (q.closed === true) return q.tombstone ? "its picker closed (picker-done tombstone)" : "its picker closed (tool_result in the transcript)";
  let wt = typeof q.card_wt === "string" ? q.card_wt : "";
  if (!wt && q.asker) {
    const m = store.db.query("SELECT wt FROM members WHERE project = ? AND squad = ? AND wt IS NOT NULL AND (role || CASE WHEN suffix != '' THEN '-' || suffix ELSE '' END) = ? ORDER BY ord DESC, id DESC")
      .get(project, squad, String(q.asker)) as { wt: string } | null;
    wt = m?.wt ?? "";
  }
  if (!wt) return null;
  if (paused(store, { project, squad, member: wt })) return null;
  const w = store.db.query("SELECT state FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, wt) as { state: string | null } | null;
  if (!w?.state) return "its agent's worktree is gone";
  // The sweep's HAVE_AT: with no terminal list at all there is no telling, so no reap on it.
  const terms = store.db.query("SELECT COUNT(*) AS n, SUM(wt = ?) AS mine FROM observed_terminals WHERE project = ? AND gone_at IS NULL").get(wt, project) as { n: number; mine: number | null };
  if (terms.n > 0 && !terms.mine) return "its agent has no live terminal";
  const since = typeof q.since === "string" ? Date.parse(q.since) : NaN;
  if (w.state !== "waiting" && Number.isFinite(since) && now - Math.floor(since / 1000) > PICKER_STALE_S) return `its agent is ${w.state} and the entry is over 2 min old`;
  return null;
}

export function reapPickers(ctx: TickCtx): void {
  const { store, project, now } = ctx;
  const rows = store.db.query("SELECT squad, id, doc FROM observed_pickers WHERE project = ? ORDER BY squad, id").all(project) as { squad: string; id: string; doc: string }[];
  for (const r of rows) {
    let q: Row;
    try { q = JSON.parse(r.doc) as Row; } catch { continue; }
    const reason = pickerStale(store, project, r.squad, q, now);
    if (!reason) continue;
    store.request("picker", { op: "resolve", id: r.id, squad: r.squad, reason }, { key: `picker:${project}/${r.squad}/${r.id}`, project, squad: r.squad, by: "loop:alerts" });
  }
}

// --- U56: settle what is no longer true -----------------------------------------------------------

const DAY_S = 86_400;
const isoS = (v: unknown): number | null => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
const lit = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "\\$&");

// The member a sweep label names in a squad (`<role>[-<suffix>]`), newest first, one with a worktree
// before one only wanted; null when no such member is left (none, or retired).
export function memberByLabel(store: Store, project: string, squad: string, who: string): Row | null {
  return store.db.query(`SELECT * FROM members WHERE project = ? AND squad = ? AND COALESCE(status, '') != 'gone'
    AND (role || CASE WHEN suffix != '' THEN '-' || suffix ELSE '' END) = ? ORDER BY wt IS NULL, id DESC`).get(project, squad, who) as Row | null;
}

// Is the member limited now: its limited_until ahead, a limit on its worker, or its open `limited` episode.
export function isLimited(store: Store, project: string, m: Row, now: number): boolean {
  if (Number(m.limited_until ?? 0) > now) return true;
  if (!m.wt) return false;
  const w = store.db.query("SELECT limited FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, String(m.wt)) as { limited: string | null } | null;
  if (w?.limited) return true;
  const ep = store.get("episodes", { project, subject: String(m.wt), kind: "limited" });
  // An `expired` episode still has its dialog on screen (limits.ts): the member is stuck, not free.
  return !!ep && ep.state !== "closed";
}

// Does a worktree run an agent: a live worker row, and its worktree not reporting zero agents.
export function alive(store: Store, project: string, wt: string | null): boolean {
  if (!wt) return false;
  if (!store.db.query("SELECT 1 FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, wt)) return false;
  const r = store.db.query("SELECT doc FROM observed_worktrees WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, wt) as { doc: string | null } | null;
  try { return JSON.parse(r?.doc ?? "null")?.agents !== 0; } catch { return true; }
}

// Has the member recovered from `cause` reported at `at`: an exited or dead agent runs again; any
// other cause (hung, not responding, a failed restart) also needs output or a state change after `at`.
// members.since is not a restart signal: a restart keeps it (squad-state add-member).
export function recovered(store: Store, project: string, wt: string | null, cause: string, at: number): boolean {
  if (!alive(store, project, wt)) return false;
  if (cause === "exited" || cause === "dead") return true;
  const w = store.db.query("SELECT since, last_output_at FROM observed_workers WHERE project = ? AND wt = ?").get(project, wt!) as { since: number | null; last_output_at: number | null } | null;
  return Number(w?.last_output_at ?? 0) > at || Number(w?.since ?? 0) > at;
}

// Open usage-limit questions the sweep filed on a squad, closed once their member is not limited.
export function settleLimitQuestions(ctx: TickCtx): number {
  const { store, project, now } = ctx;
  const rows = store.db.query(`SELECT squad, id, question FROM questions WHERE project = ? AND status = 'open' AND asker = 'sweep'
    AND id LIKE 'sweep-%' ORDER BY COALESCE(asked_at, 0) DESC, seq DESC`).all(project) as { squad: string; id: string; question: string | null }[];
  const kept = new Set<string>();
  let n = 0;
  for (const r of rows) {
    if (!/usage limit/.test(String(r.question ?? ""))) continue;
    const who = r.id.match(new RegExp(`^sweep-${lit(r.squad)}\\.(.+?)(\\|recheck)?-[0-9]+$`))?.[1];
    if (!who) continue;
    const key = `${r.squad}.${who}`, m = memberByLabel(store, project, r.squad, who);
    if (paused(store, { project, squad: r.squad, member: (m?.wt as string | null) ?? null })) continue;
    const why = !m ? "its member no longer exists" : !isLimited(store, project, m, now) ? "its member is no longer limited"
      : kept.has(key) ? "a newer question about the same limit is open" : null;
    if (!why) { kept.add(key); continue; }
    if (answer(store, project, r.squad, r.id, `resolved: ${why}`, "reality")) n++;
  }
  return n;
}

// Why a Studio alert is no longer true; false while a kind this knows is still true; null for a kind
// it cannot judge (only those fall back to the day-old rule, so a still-true alert is never dropped).
// U199: a "Reviews stopped" card (bin/review/review-unit.sh rev_stop_alert) is gone once its unit needs no
// review: done/cancelled, its squad closed, its worktree removed, or the worktree's ds-review-stop
// file missing or under 2. An older card (id review-stopped:<branch>, no kind) finds its unit by the
// branch of an observed worktree; with none, no unit has the branch.
function stopCount(wt: string): number | null {
  const dir = gitDir(wt);
  if (dir === null) return null;
  try { return parseInt(readFileSync(`${dir}/ds-review-stop`, "utf8").split("\t")[0], 10) || 0; } catch { return 0; }
}
function reviewStopGone(store: Store, project: string, a: Row): string | false {
  let wt = typeof a.wt === "string" ? a.wt : "", squad = typeof a.squad === "string" ? a.squad : "", slug = typeof a.slug === "string" ? a.slug : "";
  if (!a.kind) {                                                    // older card: only the id carries the branch
    const branch = String(a.id ?? "").replace(/^review-stopped:/, "");
    const w = store.db.query("SELECT path FROM observed_worktrees WHERE project = ? AND branch IN (?, ?) AND gone_at IS NULL").get(project, branch, `refs/heads/${branch}`) as { path: string | null } | null;
    if (!w?.path) return "no unit has this branch";
    wt = w.path;
  }
  if (squad) {
    const sq = store.get("squads", { project, topic: squad });
    if (sq && (sq.status === "gone" || sq.status === "done")) return "its squad is closed";
    const u = slug ? store.get("units", { project, squad, slug }) : null;
    if (u?.status === "done") return "the unit is done";
    if (u?.status === "cancelled") return "the unit is cancelled";
  } else if (!a.kind) {
    const u = store.db.query("SELECT status FROM units WHERE project = ? AND builder_wt LIKE ?").get(project, `%::${wt}`) as { status: string } | null;
    if (u?.status === "done") return "the unit is done";
    if (u?.status === "cancelled") return "the unit is cancelled";
  }
  if (!wt || !existsSync(wt)) return "the worktree is removed";
  const w = store.db.query("SELECT 1 FROM observed_worktrees WHERE project = ? AND path = ? AND gone_at IS NOT NULL").get(project, wt);
  if (w) return "the worktree is removed";
  const n = stopCount(wt);
  return n === null ? "the worktree is removed" : n < 2 ? "the stop was lifted" : false;
}
// U9: a one-off request's refusal (subject `req:<id>`) never runs again, so nothing would end its row.
// It is moot once the request's squad is done, closed or gone, or the unit it names (finish-unit,
// merge) is done. Other subjects keep the rule that the row stands until the action succeeds.
function requestMoot(store: Store, project: string, subject: string): string | null {
  const id = /^req:(\d+)$/.exec(subject)?.[1];
  if (!id) return null;
  const r = store.db.query("SELECT squad, kind, key, payload FROM requests WHERE id = ?").get(Number(id)) as Row | null;
  if (!r) return null;
  const squad = typeof r.squad === "string" ? r.squad : "";
  if (squad) {
    const sq = store.get("squads", { project, topic: squad });
    if (!sq || sq.status === "gone" || sq.status === "closed" || sq.status === "done") return "its squad is done or closed";
  }
  if (r.kind === "finish-unit" || r.kind === "merge") {
    const fromKey = /^[^:]+:[^/]+\/([^/]+)\/([^@/]+)(?:@|$)/.exec(String(r.key ?? ""));
    let argv: unknown[] = [];
    try { argv = (JSON.parse(String(r.payload ?? "{}")) as { argv?: unknown[] }).argv ?? []; } catch { /* no payload */ }
    const sq = fromKey?.[1] ?? squad, slug = fromKey?.[2] ?? (typeof argv[2] === "string" ? argv[2] : "");
    if (sq && slug && store.get("units", { project, squad: sq, slug })?.status === "done") return "its unit is done";
  }
  return null;
}
export function alertGone(store: Store, project: string, a: Row, now = Math.floor(Date.now() / 1000)): string | false | null {
  if (a.kind === "cancel_failed") {
    const u = store.get("units", { project, squad: a.squad, slug: a.unit });
    if (u?.status !== "cancelled") return "the unit is no longer cancelled";
    if (a.step === "cancel.pr") {
      const repo = cancellationRepository(store, u);
      const pr = store.get("observed_prs", { project, ref: `${repo}#${prNumber(u.pr)}` });
      return !prNumber(u.pr) || sharedPr(store, u) || (pr && (pr.state !== "OPEN" || pr.gone_at != null)) ? "the PR no longer needs closing" : false;
    }
    if (sharedBuilder(store, u)) return "another unit owns the Builder";
    const r = cancellationReality(store, project, String(u.builder_wt ?? ""));
    if (a.step === "cancel.stop") return !r.live && !!r.tree ? "the Builder is stopped" : false;
    return !r.present && r.tree?.gone_at != null ? "the worktree is removed" : false;
  }
  const text = String(a.question ?? ""), id = String(a.id ?? ""), since = isoS(a.since) ?? 0;
  // U240: the loop's merge cards go once their PR merged or closed, or moved to a newer head.
  const mergeCard = a.kind === MERGE_CARD || (!a.kind && /(Auto-merge not armed|Merge-ready PR left open)$/.test(String(a.title ?? "")));
  if (mergeCard) return mergeCardGone(store, project, a, text);
  if (a.kind === "pr_stale" || (!a.kind && /Red PR still blocked$/.test(String(a.title ?? "")))) return prStaleGone(store, project, a, text);
  // U4: Agent broke again clears once its member runs again, like agent_broken.
  if (a.kind === "agent_rebroke") {
    const m = store.db.query("SELECT * FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(project, String(a.member ?? "")) as Row | null;
    if (!m || ["gone", "closed"].includes(String(m.status ?? "")) || m.want === "gone") return "its member no longer exists";
    return recovered(store, project, String(a.member), "exited", since) ? "its member runs again" : false;
  }
  // U4: the loop no longer raises Loop-stalled cards; the board's loop line shows restarts.
  if (/^loop-stall-\d+$/.test(id)) return "loop stalls are shown on the board's loop line now";
  // U232: a poke-capped card clears once the member did what the poke asked.
  if (a.kind === "poke_unanswered") return pokeSettled(store, project, a);
  // U232: a runaway card (or one from before it had a kind, by its text) clears once its unit is not running.
  const old = text.match(/^unit (\S+) of (\S+) has spent/);
  const runaway = a.kind === RUNAWAY_KIND ? [String(a.squad ?? ""), String(a.unit ?? "")] : old ? [old[2], old[1]] : null;
  if (runaway) return store.get("units", { project, squad: runaway[0], slug: runaway[1] })?.status === "dispatched" ? false : "the unit is no longer running";
  if (a.kind === "review_stopped" || (!a.kind && /^review-stopped:/.test(id))) return reviewStopGone(store, project, a);
  if (/^(sweep|loop)-studio\.early-/.test(id)) return "early switching removed";
  // U67: a failed restart (fulfil/request.ts giveUp) names its member; one from before names it in its text.
  if (a.kind === "restart_failed" && typeof a.member === "string" && a.member) {
    const m = store.db.query("SELECT * FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(project, a.member) as Row | null;
    return restartSettled(store, project, m, typeof a.episode === "string" ? a.episode : null, now);
  }
  if (a.kind === STRAY_KIND) return false;                          // U79: members.ts clears it when its terminal goes
  // U150: a refusal card stays while its refusals row stands (the actuator resolves it when the row ends).
  if (a.kind === REFUSAL_KIND) {
    const subject = String(a.subject ?? ""), fingerprint = String(a.fingerprint ?? "");
    if (!store.get("refusals", { project, subject, fingerprint })) return "the refusal no longer stands";
    const moot = requestMoot(store, project, subject);
    if (moot) store.db.run("DELETE FROM refusals WHERE project = ? AND subject = ?", [project, subject]);   // so ready() never cards it again
    return moot ?? false;
  }
  const failed = /(^|[ :·])Restart failed$/.test(String(a.title)) ? text.match(/^(\S+) of (\S+) \(.* — the loop could not restart it/) : null;
  if (failed) return restartSettled(store, project, memberByLabel(store, project, failed[2], failed[1]), null, now);
  const acct = id.match(/^sweep-account-skills\.(.+)-[0-9]+$/);
  if (acct) {
    const v = skillsOf(store, acct[1]);
    if (v === undefined) return "the account is no longer listed";
    if (v === null) return null;
    return v.startsWith("broken:") ? false : `the account's skills read ${v === "ok" ? "ok" : "warn (no longer broken)"}`;
  }
  // disk-pressure U3: a disk's card goes once its spell closed (free space above the limit plus 5 points, the limit off, the disk gone).
  const disk = id.match(/^sweep-disk-pressure\.(.+)-[0-9]+$/);
  if (disk) {
    const ep = store.get("episodes", { project, subject: `disk-pressure.${disk[1]}`, kind: "disk-pressure" });
    return ep && ep.ended_at == null ? false : "the disk has free space again";
  }
  const studio = (store.get("projects", { label: project })?.studio_wt as string | null) ?? null;
  if (/^(sweep|loop)-studio\.limit-/.test(id)) {
    const episode = studio ? store.get("episodes", { project, subject: studio, kind: "limited" }) : null;
    if (!episode || !store.db.query("SELECT 1 FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, studio)) return null;
    return episode.state === "closed" ? "the Studio is no longer limited" : false;
  }
  if (/^Studio context is [0-9]+/.test(text) || /^(sweep|loop)-studio\.ctx-/.test(id)) {
    const c = studio ? liveCtx(store, studio) : null;
    if (c === null) return null;
    return c < limitInt(store, project, "context_compact", 150_000) ? "the Studio's context is under the threshold" : false;
  }
  const studioCause = text.match(/^studio \(([^)]*?) since /);
  if (studioCause) return recovered(store, project, studio, studioCause[1], since) ? "the Studio is running again" : false;
  const named = text.match(/^(\S+) of (\S+) \((.*?) since /), made = text.match(/^The loop could not make the running (\S+)(?: (\S+))? of ([^\s:]+):/);
  const [who, squad, cause] = named ? [named[1], named[2], named[3]] : made ? [made[2] ? `${made[1]}-${made[2]}` : made[1], made[3], "failed"] : [null, null, null];
  if (!who || !squad) return null;
  const m = memberByLabel(store, project, squad, who);
  if (!m) return "its member no longer exists";
  return recovered(store, project, (m.wt as string | null) ?? null, cause!, since) ? "its member runs again" : false;
}

// Why a merge card ("Auto-merge not armed", "Merge-ready PR left open") is settled, or false while its
// PR is open on the head the card names. The card carries its PR `ref` and `head`; one from before names
// the PR number in its text ("PR #430 (topic/unit) is merge-ready"), found by number in the project's rows.
function prRowOf(store: Store, project: string, a: Row, text: string): Row | null {
  const row: Row | null = typeof a.ref === "string" && a.ref ? store.get("observed_prs", { project, ref: a.ref }) : null;
  if (row) return row;
  const n = text.match(/^PR #(\d+)\b/)?.[1];
  if (!n) return null;
  const rows = store.db.query("SELECT * FROM observed_prs WHERE project = ? AND pr = ? ORDER BY observed_at DESC").all(project, Number(n)) as Row[];
  return rows.find((r) => r.state === "OPEN") ?? rows[0] ?? null;
}
function mergeCardGone(store: Store, project: string, a: Row, text: string): string | false | null {
  const row = prRowOf(store, project, a, text);
  if (!row) return null;
  if (row.state === "MERGED") return "the PR merged";
  if (row.state === "CLOSED") return "the PR closed";
  const head = headOf(row);
  return typeof a.head === "string" && a.head && head && head !== a.head ? "the PR has a newer head" : false;
}

// U4: a "Red PR still blocked" card (lifecycle.ts) goes when its PR merged, closed or is gone, is no
// longer blocked, or began a new blocked stretch (its `blocked_since` moved). One from before names the PR in its text.
function prStaleGone(store: Store, project: string, a: Row, text: string): string | false | null {
  const row = prRowOf(store, project, a, text);
  if (!row) return null;
  if (row.state === "MERGED") return "the PR merged";
  if (row.state === "CLOSED" || row.gone_at != null) return "the PR closed";
  if (row.verdict !== "blocked") return "the PR is no longer blocked";
  return a.blocked_since != null && row.since != null && Number(row.since) !== Number(a.blocked_since) ? "a new blocked stretch began" : false;
}

// Why a poke-capped card is settled, or false while the member still owes the poke an answer: its member
// is gone; for an all-done poke the squad is no longer all done; for any other the poke episode was reset
// (a new one began or the row went) or the worker is working again.
export function pokeSettled(store: Store, project: string, a: Row): string | false {
  const wt = String(a.member ?? "");
  const m = store.db.query("SELECT * FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(project, wt) as Row | null;
  if (!m || ["gone", "closed"].includes(String(m.status ?? "")) || m.want === "gone") return "its member no longer exists";
  const reason = String(a.reason ?? "");
  if (reason === "retest-due") return retestDue(store.db, project, String(a.squad ?? m.squad)) ? false : "no retest is due any more";
  if (reason === "all-done") {
    if (!allDone(store, project, String(a.squad ?? m.squad))) return "the squad is no longer all done";
    const ep = store.get("episodes", { project, subject: wt, kind: "wake:all-done" });
    return !ep || ep.state !== "capped" || (typeof a.pokeEpisode === "string" && ep.episode_key !== a.pokeEpisode) ? "the Lead answered" : false;
  }
  const ep = store.get("episodes", { project, subject: wt, kind: `wake:${reason}` });
  if (!ep || ep.state !== "capped" || (typeof a.pokeEpisode === "string" && ep.episode_key !== a.pokeEpisode)) return "its poke episode was reset";
  const w = store.db.query("SELECT state FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, wt) as { state: string | null } | null;
  return w?.state === "working" ? "the worker is working again" : false;
}

// Why a failed restart's card is settled, or false while its member still needs the restart: the
// member is gone or closed, the limited episode it was raised for (`limit|<wt>|<episode_key>`) has
// closed, or the member runs on a listed account and is not limited.
export function restartSettled(store: Store, project: string, m: Row | null, episode: string | null, now: number): string | false {
  if (!m || ["gone", "closed"].includes(String(m.status ?? "")) || m.want === "gone") return "its member no longer exists";
  const sq = store.get("squads", { project, topic: String(m.squad) });
  if (!sq || ["closed", "gone", "done"].includes(String(sq.status ?? ""))) return "its squad is closed";
  const wt = (m.wt as string | null) ?? null;
  if (episode && wt) {
    const ep = store.get("episodes", { project, subject: wt, kind: "limited" });
    if (!ep || ep.state === "closed" || `limit|${wt}|${ep.episode_key}` !== episode) return "the limit it was raised for has closed";
  }
  const account = String(m.account ?? "-"), listed = account === "-" || account === "" || !!accountList(store, String(m.agent ?? ""), now)?.has(account);
  return alive(store, project, wt) && listed && !isLimited(store, project, m, now) ? "its member runs on a listed account" : false;
}

// One `alert-clear` of the exact id per alert that went stale (the claim keys it by its `since`).
export function dropAlerts(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx, out: Action[] = [];
  const rows = store.db.query("SELECT id, doc FROM observed_alerts WHERE project = ? ORDER BY rowid").all(project) as { id: string; doc: string | null }[];
  for (const r of rows) {
    let a: Row;
    try { a = JSON.parse(String(r.doc)) as Row; } catch { continue; }
    if (a.asker !== "sweep") continue;
    const since = isoS(a.since), gone = alertGone(store, project, a, now);
    const why = gone ?? (since !== null && now - since >= DAY_S ? "over a day old with no repeat" : null);
    if (!why) continue;
    out.push({ project, squad: null, subject: `drop:${r.id}`, kind: "alert-clear", episode: `drop@${String(a.since ?? "")}`,
      payload: { id: r.id, why } });
  }
  return out;
}

export default {
  name: "alerts",
  run(ctx: TickCtx) {
    reapPickers(ctx);
    settleLimitQuestions(ctx);
    return [...runawayUnits(ctx), ...dropAlerts(ctx)];
  },
} satisfies Reconciler;
