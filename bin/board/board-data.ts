// board-data.ts — build the overview board once, for both views (Bun).
//
//   bun board-data.ts [<project-selector-or-label>] [--topic <slug>] [--json]
//
// --json prints the one document web/board.html renders (board-server.ts serves it as
// /board.json); without it, the text board. board.sh is the front door for both.
//
// A stateless projection recomputed on each run (R9): it never stores state. It reads loop.db
// alone, opened read-only: the squads, members and units rows (the squad as its JSON
// snapshot, export-json.ts squadDoc), the loop's observed_* rows (Orca worktrees, workers and
// terminals, PRs, tokens, spend, accounts, usage limits, Lavish sessions, Lead beats, alerts), the
// documents rows (plans, closed squads), the config rows (limits, ship mode) and the requests rows.
// It never runs a command and never reads a state file, so it renders with orca, gh and git off
// PATH, and with the loop stopped it shows the last data behind a "loop down" banner.
import { resolveBackUp, returnOf } from "../loop/settings/roster.ts";
import { consumers, consumerLine, disksOf, titleOf } from "../loop/squad/disk-pressure.ts";
import { basename, dirname, join, resolve } from "node:path";
import { familyOf, familyRel, fileMtime, isFile, pageFiles, savedCopy, underRoot } from "./saved-pages.ts";
import { ROOT } from "../lib/shared.ts";
import { unitLinks } from "./unit-links.ts";
import { isTestProject } from "../loop/settings/projects.ts";
import { debriefTopic } from "./card-place.ts";
import { placeAlert, questionsCount, shownStatus, doneWaits, shortTitle, prNumber } from "./needs-rules.ts";
import { githubView, githubLine, budgetCard, dropLeadMergeCopies } from "./github-view.ts";
import { squadDoc } from "../loop/db/export-json.ts";
import { mangle } from "../loop/observers/orca.ts";
import { spentOf } from "../loop/reconcilers/tokens.ts";
import { dispatchVerdict, leadVerdict } from "../loop/reconcilers/liveness.ts";
import { planPlain, planRevisions, approvedCopyPath } from "../lib/plan-plain.ts";
import { planChanges } from "./plan-changes.ts";
import { compareSquads } from "./squad-order.ts";
import { archiveDebriefStep, type Step } from "../loop/squad/archive-debrief.ts";
import { removeWaitS } from "../loop/squad/close-drift.ts";
import { redact, redactDeep } from "../loop/chat/redact.ts";
import { planUnitFacts } from "../loop/squad/plan-lines.ts";
import { blockingForUnit, entryOf, list, questionUnit, waiting as waitingQuestions } from "../loop/messages/questions.ts";
import { DEFAULTS as BRIEFING_DEFAULTS, gaveUp as briefingGaveUp, localDate, nextSlot, parseDays, parseTime, scheduleSince } from "../loop/reconcilers/briefing.ts";
import { limit } from "../loop/settings/limits.ts";
import { ANSWERED, ANSWERED_BY, ENDED, RECEIVER_RUNNING, UNREAD, WAITING } from "../loop/messages/messages.ts";
import { creditsNotice, liveHolds } from "../loop/capacity/credits.ts";
import { LOGIN_ENDED, liveLoginHolds } from "../loop/capacity/login.ts";
import { approvedPlans, readyLine } from "../loop/reconcilers/ready.ts";
import { canonPath } from "../loop/squad/plan-approved.ts";
import { unitWishes } from "../loop/squad/queued-builder.ts";
import { now as clockNow, openReadOnly, pendingWishes, stateRoot, type Pending, type Row, type Store } from "../loop/core/store.ts";
import { effective, memberKey, paused, projection } from "../loop/pause/pause.ts";
import { laneNow, placeOf, queue, seatable, seats, unblockFirst, unlocksOf, type Unlocks } from "../loop/capacity/slot.ts";
import { brakeView } from "../loop/capacity/pick.ts";
import { focusSquad, focusValue, NO_FOCUS } from "../loop/squad/focus.ts";
import { flowLine, flowOf, type FlowEvent, type FlowPick, type FlowReview, type FlowUnit } from "./flow.ts";
import { retestDue, openPrUnits, type Retest } from "../loop/squad/retest.ts";
import { settle, type Finish } from "../loop/squad/squad-finish.ts";
import { LVL, levelOf, machineCadence, machineLevels, machineStale, worst } from "../loop/capacity/machine-level.ts";
import { CAT_SQL, NOISE, catList, catWhere, sqlList as kindList } from "./event-cats.ts";
import { CHAT_FILE_NAME, chatFileUrl } from "../loop/chat/files.ts";
import { feedbackOn, feedbackRepo } from "../loop/feedback/post.ts";
import { DEFAULT_BACKEND, PROVIDER_SETTINGS, defaultProvider, isBackend } from "../backend/registry.ts";
import { studioBackend } from "../loop/squad/studio.ts";

const SQUAD_ROLE = /-(lead|thinker|builder|reviewer|tester|researcher)(-|$)/;

// --- small helpers ------------------------------------------------------------------------------

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const parse = (s: unknown): any => { try { return JSON.parse(String(s)); } catch { return null; } };
// Epoch seconds; DS_NOW pins it (the tests age the loop's health row against it).
const NOW = () => clockNow();

// The ready units that hold the focus key now (squad-priority U1), as `<squad>\0<slug>`: the loop's own
// line (ready.ts readyLine, slot.ts queue), read once per project per buildBoard. Empty with no limit or no
// focus, or on a loop.db an older loop has not migrated.
// `held`: the focus squad's queued units whose key is off now (the squad holds its share). `rank`: each line entry's
// place (slot.ts lineOrder, without the member id), so the Flow orders the queue as the loop does; `count`: the open
// dependents of any unit, for a planned unit not in the line (picker-prefers-unblocking-units U1).
type FocusLine = { on: Set<string>; held: Set<string>; squad: string | null; rank: Map<string, number[]>; count: Unlocks; unblock: boolean; unlock: Set<string> };
const focusMemo = new Map<string, FocusLine>();
function focusLine(store: Store, label: string): FocusLine {
  let got = focusMemo.get(label);
  if (got) return got;
  got = { on: new Set(), held: new Set(), squad: null, rank: new Map(), count: () => 0, unblock: false, unlock: new Set() };
  try {
    const now = NOW();
    const fs = focusSquad(store, label);
    got.squad = fs ?? null;
    got.count = unlocksOf(store, label);
    got.unblock = unblockFirst(store, label);
    for (const p of queue(store, label, now, readyLine(store, label, now).map((c) => ({ squad: c.topic, suffix: c.slug })))) {
      const k = `${p.squad}\0${p.suffix}`;
      if (!got.rank.has(k)) got.rank.set(k, p.rank.slice(0, 6));
      if (p.unlock) got.unlock.add(k);
      if (p.focus) got.on.add(k); else if (fs && p.squad === fs) got.held.add(k);
    }
  } catch { /* an older loop.db: no focus marks */ }
  focusMemo.set(label, got);
  return got;
}
// ★ on every open unit of the focus squad (squad-priority U5): `on` while its key is on (in line for a seat that
// gets the next free one), `held` while the squad holds its share, `muted` for every other open unit of the squad
// (blocked, dispatched, PR open); a unit of another squad has none.
const focusMark = (store: Store, label: string, squad: string, slug: string): "on" | "held" | "muted" | null => {
  const f = focusLine(store, label), k = `${squad}\0${slug}`;
  return f.on.has(k) ? "on" : f.held.has(k) ? "held" : f.squad && f.squad === squad ? "muted" : null;
};
// A queued unit's Flow place (planned or dispatched): its rank in the loop's line, else (not in it: its deps are not
// done yet, or a started unit waiting for a seat) placeOf with the focus key for a unit of the focus squad and, under
// `unblock_first`, its open dependents, so it keeps its place in its group.
const placeIn = (store: Store, label: string, squad: string, slug: string): number[] => {
  const f = focusLine(store, label), k = `${squad}\0${slug}`, u = store.get("units", { project: label, squad, slug });
  return f.rank.get(k) ?? placeOf(store, label, u, f.on.has(k) || (f.squad != null && f.squad === squad), f.unblock ? f.count(u) : 0);
};

// ⬆N on an open unit others wait on (picker-prefers-unblocking-units U2): `unlocks` is its open-dependents count, the
// loop's own (slot.ts unlocksOf); `unlock` is "on" while the line ranks it with the unlock key now (same queue() walk as
// focus), else absent, so the board dims the mark when the key is off, out of room or the unit is not in line.
const unlockFacts = (store: Store, label: string, squad: string, slug: string, status: string): { unlocks?: number; unlock?: "on" } => {
  if (status !== "planned" && status !== "dispatched") return {};
  const f = focusLine(store, label), n = f.count(store.get("units", { project: label, squad, slug }));
  return n > 0 ? { unlocks: n, ...(f.unlock.has(`${squad}\0${slug}`) ? { unlock: "on" as const } : {}) } : {};
};

// The shell's '…' quoting, for commands the operator copies (an agent-written id/topic can't inject).
const shq = (v: unknown) => (typeof v === "string" ? `'${v.replace(/'/g, `'\\''`)}'` : String(v));

// progress-legend-colors U1: started, but nobody is on it (the bar's `stopped` segment; web/board.html's STOPPED).
const STOPPED_STATES = ["paused", "pausing", "resuming", "suspended", "gone"];

// Parked work waits on the operator: a not-started unit that is held or whose plan is not approved (`held`), and
// the not-started units that wait on one, directly or through other units (`behind`). A started unit is never
// parked; an external dep passes nothing on.
export function parkedUnits(units: any[], roots: Set<string>, notStarted: Set<string>): Map<string, "held" | "behind"> {
  const out = new Map<string, "held" | "behind">();
  for (const r of roots) for (const d of openDependents(units, r)) if (notStarted.has(d)) out.set(d, "behind");
  for (const r of roots) out.set(r, "held");
  return out;
}

// Minutes since an ISO "YYYY-MM-DDTHH:MM:SS[.fff]Z" time; null when it isn't one.
// The open (not done, not cancelled) units that depend on `slug`, directly or through other units, in plan order.
export function openDependents(units: any[], slug: string): string[] {
  const out = new Set<string>(), todo = [slug];
  while (todo.length) {
    const at = todo.pop()!;
    for (const x of units) {
      const s = String(x?.slug ?? "");
      if (!s || out.has(s) || s === slug || x?.status === "done" || x?.status === "cancelled") continue;
      if (arr(x?.deps).map(String).includes(at)) { out.add(s); todo.push(s); }
    }
  }
  return units.map((x) => String(x?.slug ?? "")).filter((s) => out.has(s));
}

// archive-leftovers U3: a squad's kept worktrees, each with the loop's last check of it (the `leftover-check`
// episode fulfil/worktree.ts writes: commits and files not on main, `safe`, the fingerprint; `checked_age_s`
// from its last probe), or `check: null` for a tree not checked yet. `waits_on` is an old record's text, kept
// in the JSON and not shown. Live and archived squads read the same way.
function leftoverRows(db: Db, label: string, list: unknown, units: unknown) {
  const checks = db.memo(`leftover-checks:${label}`, () => {
    const m = new Map<string, Row>();
    for (const r of db.all("SELECT subject, result, observed_at FROM episodes WHERE project = ? AND kind = 'leftover-check'", label)) {
      try { const c = JSON.parse(String(r.result)); if (c && typeof c === "object") m.set(String(r.subject), { ...c, checked_age_s: Math.max(0, Math.floor(NOW() - Number(r.observed_at))) }); } catch { /* an unreadable row reads as not checked */ }
    }
    return m;
  });
  // archive-leftovers U4: each leftover's newest Remove press (open: `result` null), shown on its row until it goes.
  const presses = db.memo(`leftover-removes:${label}`, () => {
    const m = new Map<string, Row>();
    for (const r of db.all("SELECT id, created_at, done_at, payload, result FROM requests WHERE project = ? AND kind = 'leftover-remove' ORDER BY id", label)) {
      try {
        const wt = JSON.parse(String(r.payload ?? "{}")).wt;
        if (typeof wt === "string") m.set(wt, { id: Number(r.id), at: r.created_at ?? null, done_at: r.done_at ?? null, result: r.result == null ? null : JSON.parse(String(r.result)) });
      } catch { /* an unreadable row shows no press */ }
    }
    return m;
  });
  return arr(list).map((l) => ({
    wt: l?.wt ?? null, path: l?.path ?? null, branch: l?.branch ?? null,
    n_files: l?.n_files ?? 0, files: arr(l?.files).map(String), unpushed: l?.unpushed ?? 0,
    reason: l?.reason ?? null, waits_on: l?.waits_on ?? null, unit: l?.unit ?? null,
    pr: l?.unit ? (arr(units).find((u) => u?.slug === l.unit)?.pr ?? null) : null,
    age_min: ageMin(l?.recorded_at),
    check: checks.get(String(l?.wt ?? "")) ?? null,
    remove: presses.get(String(l?.wt ?? "")) ?? null,
  }));
}

function ageMin(since: unknown): number | null {
  if (typeof since !== "string") return null;
  const s = since.replace(/\.[0-9]+/, "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor((NOW() * 1000 - t) / 60000);
}

// --- the database -------------------------------------------------------------------------------

// The queries one render runs, over one read-only connection.
class Db {
  private memos = new Map<string, unknown>();
  constructor(readonly s: Store) {}
  // Once per render: a per-project lookup every squad (and every unit's ext_deps) asks for.
  memo<T>(key: string, f: () => T): T {
    if (!this.memos.has(key)) this.memos.set(key, f());
    return this.memos.get(key) as T;
  }
  all(sql: string, ...a: (string | number | null)[]): Row[] { return this.s.db.query(sql).all(...a) as Row[]; }
  one(sql: string, ...a: (string | number | null)[]): Row | null { return (this.s.db.query(sql).get(...a) as Row) ?? null; }
}

// --- the old shell lib, the parts the board needs ------------------------------------------------------

// ds_label: a short, filesystem/Orca-safe project label.
export function dsLabel(s = ""): string {
  s = s.replace(/^path:/, "").replace(/^id:/, "").replace(/^name:/, "").replace(/^runtime:/, "").replace(/\/$/, "");
  s = s.slice(s.lastIndexOf("/") + 1).replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-*$/, "");
  return s || "home";
}
const dsPrefix = () => process.env.DS_PREFIX || "ds-";

// A config row's value: the project's own file first, then conventions/ (project '').
function conf(db: Db, label: string, file: string, key: string): string | null {
  for (const p of [label, ""]) {
    const r = db.one("SELECT value FROM config WHERE project = ? AND file = ? AND key = ?", p, file, key);
    if (r && r.value != null) return String(r.value);
  }
  return null;
}

// ds_ship_mode: the project's ship-mode row > a matching conventions/projects.conf line > ce-pipeline.
function shipMode(db: Db, label: string, repo: string): string {
  const own = db.one("SELECT value FROM config WHERE project = ? AND file = 'ship-mode' AND key = 'mode'", label);
  const m = String(own?.value ?? "").replace(/\s/g, "");
  if (m) return m;
  for (const r of db.all("SELECT key, value FROM config WHERE project = '' AND file = 'projects.conf' ORDER BY rowid")) {
    const sel = String(r.key ?? ""), mode = String(r.value ?? "").trim().split(/\s+/)[0] ?? "";
    if (!sel || !mode) continue;
    if (sel === label || (repo && repo.includes(sel))) return mode;
  }
  return "ce-pipeline";
}

// "owner/repo" of a squad's repo selector: the GitHub observer resolves each one once into a config
// row (file github, key repo:<selector>). "" until it has.
function repoSlug(db: Db, label: string, repo: string): string {
  if (!repo) return "";
  return String(db.one("SELECT value FROM config WHERE project = ? AND file = 'github' AND key = ?", label, `repo:${repo}`)?.value ?? "");
}

// "owner/repo" of a project's own repo for a single-project board: the `projects` row's owner/name, else the
// config row the GitHub observer wrote for its home_repo. null when neither is known.
function homeSlug(db: Db, label: string): string | null {
  const p = db.one("SELECT home_repo, owner, name FROM projects WHERE label = ?", label);
  if (p?.owner && p?.name) return `${p.owner}/${p.name}`;
  return (p?.home_repo ? repoSlug(db, label, String(p.home_repo)) : "") || null;
}

// --- GitHub PR status (observed_prs, the GitHub observer's rows) ----------------------------------

// One PR row -> a status word: merged / closed / draft / failing (a check failed) / running (checks
// in flight) / ready (green AND approved) / open (green, not yet approved). The observer's open page
// lists only open PRs, so a row it marked gone that isn't merged/closed has an unknown status: "" (it
// looks a done unit's such PR up once, U58; the page counts an unknown done unit as finished).
function prWord(p: Row): string {
  if (p.state === "MERGED") return "merged";
  if (p.state === "CLOSED") return "closed";
  if (p.gone_at != null) return "";
  if (Number(p.draft) === 1) return "draft";
  if (p.ci === "red") return "failing";
  if (p.ci === "pending") return "running";
  return p.review === "approved" ? "ready" : "open";
}

// The git branch of each live squad worktree, as the Orca observer saw it.
function squadBranches(db: Db, label: string, st: any): string[] {
  const wts = arr(st.worktrees).map(String);
  if (!wts.length) return [];
  return db.all("SELECT branch FROM observed_worktrees WHERE project = ? AND gone_at IS NULL AND branch IS NOT NULL AND wt IN (SELECT value FROM json_each(?))",
    label, JSON.stringify(wts)).map((r) => String(r.branch)).filter((b) => b && b !== "HEAD");
}

// A unit's pr may be a bare number, "#123", or a full PR URL: reduce it to the number.

// U2: the one action button a Studio card may carry (`act: {action, topic, label}` in its doc). Only these
// board actions (a subset of board-server.ts' ACTIONS that name a squad) are kept; anything else is dropped.
const CARD_ACTIONS = new Set(["close", "restart", "suspend", "resume"]);
export // A Studio alert's answer acts only with 2+ options or the card's `acts_on_answer: true` (the studio_move ask
// card, "move it"); a lone option is an acknowledgement, so it is no choice and shows as `when` ("When done: …").
function alertActs(x: any): boolean { return x?.acts_on_answer === true || arr(x?.options).length >= 2; }
function alertAnswers(x: any) {
  const acts = alertActs(x), opts = arr(x?.options);
  return {
    choices: acts ? opts.map((o: any) => ({ label: String(o), does: null })) : [],
    when: !acts && opts.length === 1 ? String(opts[0]) : null,
    acts_on_answer: x?.acts_on_answer === true,
  };
}

function cardAct(v: any): { action: string; topic: string; label: string } | null {
  if (!v || typeof v !== "object") return null;
  const action = String(v.action ?? ""), topic = String(v.topic ?? ""), label = String(v.label ?? "");
  return CARD_ACTIONS.has(action) && /^[A-Za-z0-9._-]+$/.test(topic) && label ? { action, topic, label } : null;
}

// U2: a card's PR `{num, url, state, status}` from its `ref` ("owner/repo#12", "#12" or a number), read from observed_prs.
function cardPr(db: Db, label: string, ref: unknown, slug: string | null) {
  if (ref == null || String(ref) === "") return null;
  const r = String(ref);
  const row = db.one("SELECT * FROM observed_prs WHERE project = ? AND ref = ?", label, r)
    ?? (slug ? db.one("SELECT * FROM observed_prs WHERE project = ? AND repo = ? AND pr = ?", label, slug, Number(prNumber(r))) : null);
  const num = String(row?.pr ?? prNumber(r));
  if (!/^\d+$/.test(num)) return null;
  const repo = String(row?.repo ?? slug ?? "");
  const state = row ? prWord(row) : null;
  return { num, url: repo ? `https://github.com/${repo}/pull/${num}` : null, state, status: state };
}

// A question about a PR (U86's `pr`, U87): {num, url, state} — the url from the squad's repo
// slug (the same shape as the PR list's), the state from observed_prs. A PR the squad's own
// list doesn't carry (no unit records it) still reads its state. Null without a pr.
const qprOf = (byNum: Map<string, Row>, slug: string, v: unknown) => {
  if (v == null || v === false || String(v) === "") return null;
  const num = prNumber(v), p = byNum.get(num);
  return { num, url: slug ? `https://github.com/${slug}/pull/${num}` : null, state: p ? prWord(p) : null };
};

// [{num, status, url}] per PR the squad touches: branch-matched PRs first (open + merged), then
// recorded unit PRs and #NNNN in owns/framing. A free-text #NN (owns/framing) is only a PR row
// when the repo has that PR — otherwise a stray "#123" in prose would render as a phantom PR.
// A unit-recorded PR the observer hasn't seen yet renders with no status.
function squadPrs(db: Db, label: string, st: any, slug: string) {
  const prs = slug ? db.all("SELECT * FROM observed_prs WHERE project = ? AND repo = ? AND pr IS NOT NULL ORDER BY pr", label, slug) : [];
  const byNum = new Map(prs.map((p) => [String(p.pr), p]));
  const found: [string, string][] = [];
  const branches = prs.length ? squadBranches(db, label, st) : [];
  for (const p of prs) if (branches.includes(String(p.head ?? ""))) found.push([String(p.pr), prWord(p)]);
  const unitNums = arr(st.units).map((u) => u?.pr).filter((v) => v != null && v !== false && v !== "")
    .map((v) => prNumber(v));
  const freeNums = [...arr(st.members).flatMap((m) => arr(m?.owns)), st.framing ?? ""].map(String)
    .flatMap((s) => [...s.matchAll(/#([0-9]{2,})/g)].map((m) => m[1]))
    .filter((n) => byNum.has(n));
  const nums = [...unitNums, ...freeNums];
  const key = (s: string) => parseFloat(s) || 0; // sort -un: numeric order, numeric duplicates dropped
  const seenKeys = new Set<number>();
  for (const n of nums.sort((a, b) => key(a) - key(b))) {
    if (seenKeys.has(key(n))) continue;
    seenKeys.add(key(n));
    if (!found.some(([f]) => f === n)) { const p = byNum.get(n); found.push([n, p ? prWord(p) : ""]); }
  }
  return found.map(([num, s]) => ({ num, status: s || null, url: slug ? `https://github.com/${slug}/pull/${num}` : null }));
}

// --- per-worker token spend -----------------------------------------------------------------------

// observed_tokens (the sweep's `token-usage.sh --by-worker` file, one row per worker and model),
// keyed by mangled worktree path, so a member joins by its wt ("<uuid>::<path>") without parsing names.
// "<uuid>::<path>" or a bare path -> the tokens key.
const wtKey = (wt: unknown) => { const w = String(wt ?? ""); return mangle(w.includes("::") ? w.slice(w.indexOf("::") + 2) : w); };
function tokenSpend(db: Db): Map<string, any> {
  const m = new Map<string, any>();
  for (const r of db.all("SELECT * FROM observed_tokens ORDER BY rowid")) {
    if (r.model === "<synthetic>") continue; // a 0-token placeholder row, never real spend
    const n = (k: string) => Number(r[k]) || 0;
    const turns = n("turns"), cw = n("cache_write"), cr = n("cache_read"), out = n("output"), inp = n("input");
    const spent = spentOf({ model: String(r.model), input: inp, cache_write: cw, cache_read: cr, output: out, cw_1h: r.cw_1h == null ? null : n("cw_1h"), cw_5m: r.cw_5m == null ? null : n("cw_5m") });
    // ctx: the worker's context at its last turn, same on all its rows.
    const ctx = r.ctx == null ? null : Number(r.ctx);
    const worker = String(r.worker), t = m.get(worker);
    if (!t) { m.set(worker, { topic: r.topic, role: r.role, model: r.model, turns, cache_write: cw, cache_read: cr, output: out, input: inp, ctx, spent, _mt: turns }); continue; }
    if (t.ctx == null) t.ctx = ctx;
    // A restarted / model-switched worker has several rows: sum them; model = the one with most turns.
    t.turns += turns; t.cache_write += cw; t.cache_read += cr; t.output += out; t.input += inp; t.spent += spent;
    if (turns > t._mt) { t.model = r.model; t._mt = turns; }
  }
  // Price-weighted spend (tokens.ts spentOf: cache write by TTL, read by model, output 5x), summed per row above.
  for (const t of m.values()) { delete t._mt; t.spent = Math.round(t.spent); }
  return m;
}

// observed_spend (bin/lib/squad-spent.sh, run by the sweep): each squad's spend SINCE IT STARTED,
// archived squads included. topic -> {since, spent, lead, thinker, builders, other}.
const squadSpentFor = (db: Db, label: string): Map<string, any> => db.memo(`spent:${label}`, () => readSquadSpentFor(db, label));
// unit_cpu (light-lane plan U2, procs observer): each unit's CPU while its Builders ran, by `squad/slug`
// -> {cpu_h, peak_cpu_pct, peak_rss_kb}. An older loop.db has no table: no unit has a figure.
const unitCpuFor = (db: Db, label: string): Map<string, any> => db.memo(`unitcpu:${label}`, () => {
  const m = new Map<string, any>();
  if (!db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'unit_cpu'")) return m;
  for (const r of db.all("SELECT squad, slug, cpu_s, peak_cpu_pct, peak_rss_kb FROM unit_cpu WHERE project = ?", label)) {
    m.set(`${r.squad}/${r.slug}`, { cpu_h: Math.round((Number(r.cpu_s) || 0) / 36) / 100,
      peak_cpu_pct: r.peak_cpu_pct == null ? null : Number(r.peak_cpu_pct), peak_rss_kb: r.peak_rss_kb == null ? null : Number(r.peak_rss_kb) });
  }
  return m;
});
// The unit row's light lane (adaptive-builder-capacity): `lane` light | moved | normal and `lane_rule`, from the unit's doc
// and its CPU-hours. Only a light-tagged unit carries the keys, so a project with no light units is unchanged.
const unitLane = (db: Db, label: string, x: any, cpu: any): Record<string, unknown> => {
  if (x?.lane !== "light") return {};
  const cl = Number(String(dsLimit(db, label, "light_lane_cpu_h") ?? "").trim());
  const cpuH = Number.isFinite(cl) && cl > 0 ? cl : 3;
  return { lane: laneNow(x, Number(cpu?.cpu_h ?? 0), cpuH), lane_rule: x.lane_rule ?? null, lane_cpu_h: cpu?.cpu_h ?? 0, lane_limit_h: cpuH };
};
function readSquadSpentFor(db: Db, label: string): Map<string, any> {
  const m = new Map<string, any>();
  for (const r of db.all("SELECT * FROM observed_spend WHERE project = ? ORDER BY squad", label)) {
    const n = (k: string) => Number(r[k]) || 0;
    m.set(String(r.squad), { since: n("since") || null, spent: n("total"), lead: n("lead"), thinker: n("thinker"), builders: n("builders"), other: n("other") });
  }
  return m;
}
const dayOf = (epoch: number | null) => epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : "?";
const sinceLine = (r: any) =>
  `spent ≈${compact(r.spent)} since ${dayOf(r.since)} · lead ≈${compact(r.lead)} · thinker ≈${compact(r.thinker)} · builders ≈${compact(r.builders)} · other ≈${compact(r.other)}`;

// Per-role spent (price-weighted) for a squad, summed from the rows it is built from: members by role, plus
// each unit's Builder row (a closed Builder has no member). Each row is counted once.
function roleTokens(members: any[], units: any[], toks: Map<string, any>) {
  const out: Record<string, number> = { lead: 0, thinker: 0, builders: 0, review: 0, other: 0 };
  const seen = new Set<string>();
  const add = (k: string, role: string) => {
    const t = toks.get(k);
    if (seen.has(k)) return;
    seen.add(k);
    out[role === "lead" || role === "thinker" ? role : role === "builder" ? "builders" : "other"] += t?.spent ?? 0;
    // A Builder's headless review session and its sub-agents are the `<worker>:review` row, shown as its own line.
    const rv = role === "builder" ? toks.get(`${k}:review`) : null;
    if (rv) out.review += rv.spent;
  };
  for (const m of members) if ((m?.wt ?? "") !== "") add(wtKey(m.wt), String(m.role ?? ""));
  for (const x of units) if (x?.builder_wt) add(wtKey(x.builder_wt), "builder");
  return out;
}
const roleLine = (r: Record<string, number>) =>
  `spent 7d · lead ≈${compact(r.lead)} · thinker ≈${compact(r.thinker)} · builders (all units) ≈${compact(r.builders)} · review ≈${compact(r.review)} · other ≈${compact(r.other)}`;

// Sum of the unit rows (each Builder row once) -> the Work units footer.
function unitTokens(units: any[], toks: Map<string, any>) {
  const seen = new Set<string>();
  let spent = 0;
  for (const x of units) {
    if (!x?.builder_wt) continue;
    const k = wtKey(x.builder_wt), t = toks.get(k);
    if (seen.has(k)) continue;
    seen.add(k); spent += (t?.spent ?? 0) + (toks.get(`${k}:review`)?.spent ?? 0);
  }
  return { spent, units: units.length };
}

// A limit (conventions/limits.conf): env var (historical name, or DS_LIMIT_<KEY>) > the project's
// limits.conf row > the conventions row.
const LIMIT_ENV: Record<string, string> = { context_warn: "DS_RESUME_MAX_CTX", limit_pct: "DS_SWEEP_LIMIT_PCT",
  pick_session_max: "DS_PICK_SESSION_MAX", pick_weekly_max: "DS_PICK_WEEKLY_MAX", unit_token_x: "DS_UNIT_TOKEN_X", unit_token_max: "DS_UNIT_TOKEN_MAX" };
// The per-project `debrief on|off` switch, read the way the loop reads it (squad/archive-debrief.ts debriefOn).
function debriefOnDb(db: Db, label: string): boolean {
  const ev = process.env.DS_LIMIT_DEBRIEF;
  if (ev) return ev.trim().split(/\s+/)[0] !== "off";
  for (const p of [label, ""]) {
    const v = String(db.one("SELECT value FROM config WHERE project = ? AND file = 'limits.conf' AND key = 'debrief'", p)?.value ?? "").trim().split(/\s+/)[0];
    if (v) return v !== "off";
  }
  return true;
}
function dsLimit(db: Db, label: string, key: string): number | null {
  const ev = process.env[LIMIT_ENV[key] ?? "DS_LIMIT_" + key.toUpperCase()];
  if (ev && /^[0-9]+$/.test(ev)) return Number(ev);
  for (const p of [label, ""]) {
    const v = String(db.one("SELECT value FROM config WHERE project = ? AND file = 'limits.conf' AND key = ?", p, key)?.value ?? "").trim().split(/\s+/)[0];
    if (/^[0-9]+$/.test(v)) return Number(v);
  }
  return null;
}

// 1_900_000 -> "1.9M": a spend figure that fits on one crew line; one decimal below 10 (848k stays).
const compact = (v: number) => {
  const f = (n: number, u: string) => (n < 10 ? (Math.floor(n * 10) / 10).toFixed(1).replace(/\.0$/, "") : String(Math.floor(n))) + u;
  return v >= 1e9 ? f(v / 1e9, "G") : v >= 1e6 ? f(v / 1e6, "M") : v >= 1e3 ? f(v / 1e3, "k") : String(v);
};
// A unit's CPU-hours cell: "" when unmeasured, else one decimal ("0.4"), two below 0.1 ("0.04").
const cpuH = (c: { cpu_h: number } | null | undefined) => (c == null ? "" : c.cpu_h > 0 && c.cpu_h < 0.1 ? c.cpu_h.toFixed(2) : c.cpu_h.toFixed(1));

// --- the loop itself ----------------------------------------------------------------------------

// The loop's health row: down when its last progress is older than board_stale_ticks ticks (default 12
// of DS_LOOP_TICK_S, 5 s). With no loop.db at all, down with nothing to show.
function loopStatus(db: Db | null, label: string) {
  const tickS = Number(process.env.DS_LOOP_TICK_S) > 0 ? Number(process.env.DS_LOOP_TICK_S) : 5;
  const ticks = (db ? dsLimit(db, label, "board_stale_ticks") : null) ?? 12;
  const h = db?.one("SELECT * FROM health WHERE id = 1") ?? null;
  const at = h?.tick_at == null ? null : Number(h.tick_at);
  const ref = h ? Math.max(Number(h.tick_at ?? 0), Number(h.started_at ?? 0), Number(h.progress_at ?? 0)) : null;
  const age = ref == null ? null : Math.max(0, NOW() - ref);
  // U234: how long a tick takes (the health row's last tick, tick_ms) and the step the latest tick_slow named.
  const slow = db?.one("SELECT payload FROM events WHERE kind = 'tick_slow' ORDER BY id DESC LIMIT 1");
  let slowest: string | null = null;
  try {
    // U239: the top 3 steps with their average ms ("members:acme 12200 ms, …"); an older event names only its slowest.
    const p = slow?.payload ? JSON.parse(String(slow.payload)) : null, top = Array.isArray(p?.top) ? p.top.slice(0, 3) as { step: string; avg_ms: number }[] : [];
    slowest = top.length ? top.map((t) => `${t.step} ${t.avg_ms} ms`).join(", ") : (p?.slowest?.step ?? null);
  } catch { /* a garbled payload names no step */ }
  // U3: the loop's restarts (watchdog.ts logs a loop_restart event each time it restarts a stalled loop).
  const day = db?.one("SELECT COUNT(*) AS n, MAX(at) AS last FROM events WHERE kind = 'loop_restart' AND at >= ?", NOW() - 86400);
  const bn = (db ? dsLimit(db, label, "loop_stall_banner_n") : null) ?? 3, bmin = (db ? dsLimit(db, label, "loop_stall_banner_min") : null) ?? 60;
  const hour = Number(db?.one("SELECT COUNT(*) AS n FROM events WHERE kind = 'loop_restart' AND at >= ?", NOW() - bmin * 60)?.n ?? 0);
  const tickMs = h?.tick_ms == null ? null : Number(h.tick_ms);
  return { down: age == null || age > ticks * tickS, tick_at: at, age_s: age, stale_after_s: ticks * tickS, tick_no: h?.tick_no ?? null,
    tick_ms: tickMs, tick_s: tickS, tick_slow: tickMs != null && tickMs > 4 * tickS * 1000, tick_slowest: slowest,
    restarts_24h: Number(day?.n ?? 0), last_restart_at: day?.last == null ? null : Number(day.last),
    restarts_recent: hour, stall_window_min: bmin, stalling: hour >= bn };
}

// When a section's rows were last observed (max observed_at), for its "data as of" line.
function asOf(db: Db, table: string, label: string): number | null {
  const where = label && db.s.columns(table).has("project") ? "WHERE project = ?" : "";
  const v = db.one(`SELECT MAX(observed_at) AS at FROM ${table} ${where}`, ...(where ? [label] : []))?.at;
  return v == null ? null : Number(v);
}

// --- one squad ----------------------------------------------------------------------------------

// [{name, markdown, mtime, approved, revoked_at?, queued, started}] for each <stem>-*-plan.md documents row (stem:
// "<label>/squads/<topic>" or "<label>/archive/<topic>"). With `st` (a live squad's doc) each plan says whether it
// is approved (hold-cancels-queue-undo-approval U3: the Plans list's "Take back approval"), when it was last
// revoked, and what revoking it would do now: `queued` open units with a queued Builder, `started` with a live one.
function plans(db: Db, label: string, stem: string, st?: any, topic = "") {
  const pre = stem + "-";
  return db.all("SELECT path, body, mtime FROM documents WHERE project = ? AND substr(path, 1, ?) = ? ORDER BY path", label, pre.length, pre)
    .filter((r) => String(r.path).endsWith("-plan.md") && String(r.path).length >= pre.length + 8)
    .map((r) => {
      const base = { name: basename(String(r.path)), markdown: String(r.body ?? ""), mtime: Number(r.mtime) || 0 };
      if (!st) return base;
      const file = join(db.s.root, String(r.path)), same = (p: unknown) => p != null && canonPath(db.s.root, String(p)) === canonPath(db.s.root, file);
      const approved = arr(st.approved_plans).some(same);
      const rv = [...arr(st.revoked_plans)].reverse().find((x: any) => same(x?.plan));
      const open = approved ? arr(st.units).filter((u) => same(u?.plan) && u?.status !== "done" && u?.status !== "cancelled") : [];
      const queued = open.filter((u) => unitWishes(db.s, label, topic, String(u.slug)).length > 0).length;
      return { ...base, approved, ...(rv?.at ? { revoked_at: String(rv.at) } : {}), queued, started: open.filter((u) => u.builder_wt).length };
    });
}

// debrief-in-needs-you pages U1: the squad's Try it page (`<stem>-try-it.md`, the Thinker keeps it current), or null.
// A live squad's stem is "<label>/squads/<topic>", an archived one's "<label>/archive/<topic>".
function tryIt(db: Db, label: string, stem: string) {
  const r = db.one("SELECT path, body, mtime FROM documents WHERE project = ? AND path = ?", label, `${stem}-try-it.md`);
  return r ? { name: basename(String(r.path)), markdown: String(r.body ?? ""), mtime: Number(r.mtime) || 0 } : null;
}

// plan-revisions U2 (R7): the plan's newest revision note and, when the approved copy has a documents row, what
// changed against it. Each is null when there is nothing to show or it cannot be made, never an error.
function revisionOf(db: Db, label: string, path: string, markdown: string, units: any[]) {
  let revision: any = null, changes: any = null;
  try {
    const r = planRevisions(markdown)[0];
    if (r) revision = { rev: r.rev, date: r.date, reason: r.reason, lines: r.lines };
    const copy = db.one("SELECT body FROM documents WHERE project = ? AND path = ?", label, approvedCopyPath(path));
    if (copy) changes = planChanges(markdown, String(copy.body ?? ""), path, r ?? null, units);
  } catch { /* the question still shows without them */ }
  return { revision, changes };
}

// R6: the document a question links, from the documents rows: its `doc_path` (relative to the state root, as the
// rows are keyed), else for a `plan-<short>` id the plan `<topic>-<short>-plan.md` beside the squad's state.
function docPath(label: string, topic: string, x: any): string {
  const id = String(x?.id ?? "");
  return typeof x?.doc_path === "string" && x.doc_path ? x.doc_path : id.startsWith("plan-") && id.length > 5 ? `${label}/squads/${topic}-${id.slice(5)}-plan.md` : "";
}
function linkedDoc(db: Db, label: string, topic: string, x: any): { name: string; markdown: string } | null {
  try {
    const path = docPath(label, topic, x);
    if (!path) return null;
    const row = db.one("SELECT body FROM documents WHERE project = ? AND path = ?", label, path);
    return row ? { name: basename(path), markdown: String(row.body ?? "") } : null;
  } catch { return null; }
}
// `plain`, `plain_from` and `facts` are for plan-* questions only; each is null when it cannot be made, never an error.
function questionDoc(db: Db, label: string, topic: string, x: any, units: any[] = []) {
  const none = { doc: null, plain: null, plain_from: null, facts: null, revision: null, changes: null };
  try {
    const doc = linkedDoc(db, label, topic, x);
    if (!doc) return none;
    if (!String(x?.id ?? "").startsWith("plan-")) return { ...none, doc };
    const markdown = doc.markdown;
    return { doc, ...planPlain(markdown), facts: planUnitFacts(markdown), ...revisionOf(db, label, docPath(label, topic, x), markdown, units) };
  } catch { return none; }
}

// Lavish review pages (observed_sessions) of a squad: the artifact sits in one of its worktrees, or in its
// pages folder `<state root>/<label>/pages/<topic>/` or the legacy `<label>/squads/<topic>-board/`. A live
// and an archived squad read the same way (an archived one has no worktrees: the worktrees its `pages_rescued`
// events name stand in). A page whose file is gone gets `saved`, the path under the state root of the copy the
// rescue made when its worktree closed (served by GET /page/<saved>); a saved page no session stands for is
// listed too, with `key` null. Nothing is listed twice.
function lavish(db: Db, st: any, label: string, topic: string) {
  const rescued = db.all("SELECT payload FROM events WHERE kind = 'pages_rescued' AND project = ? AND squad = ? ORDER BY id", label, topic)
    .map((e) => parse(e.payload) ?? {}).filter((p) => typeof p.path === "string" && typeof p.dest === "string");
  const wts = [...arr(st?.worktrees).map(String).map((w) => w.includes("::") ? w.slice(w.lastIndexOf("::") + 2) : w), ...rescued.map((p) => String(p.path))].filter(Boolean);
  const homes = [`${db.s.root}/${label}/pages/${topic}/`, `${db.s.root}/${label}/squads/${topic}-board/`];
  const sessionFile = new Map<any, string>();
  const taken = new Set<string>(); // absolute files and page families a listed entry stands for
  const out = db.all("SELECT file, url, status, doc FROM observed_sessions WHERE COALESCE(status, '') != 'log' ORDER BY file")
    .filter((s) => wts.some((w) => String(s.file).startsWith(w + "/")) || homes.some((h) => String(s.file).startsWith(h)))
    .map((s) => {
      const d = parse(s.doc) ?? {}, f = String(s.file);
      const e: any = { key: d.key ?? null, name: basename(f), dir: basename(f.slice(0, f.lastIndexOf("/"))), mtime: Number(d.mtime) || 0, url: s.url ?? null, status: s.status ?? null };
      taken.add(f); sessionFile.set(e, f);
      for (const p of rescued) {
        if (!f.startsWith(String(p.path) + "/")) continue;
        const copy = savedCopy(db.s.root, label, topic, String(p.dest), f.slice(String(p.path).length + 1));
        if (!copy) continue;
        taken.add(copy.file); taken.add(familyOf(copy.file));
        if (!isFile(f)) { e.saved = underRoot(db.s.root, copy.file); e.mtime ||= copy.mtime; break; }
      }
      return e;
    });
  // A gone session with no event (a squad archived before the rescue logged one): its saved copy is the file under
  // `rescued/<role>/` whose path inside the worktree ends the session's path.
  const files = pageFiles(db.s.root, label, topic);
  for (const e of out) {
    if (e.saved || e.key == null) continue;
    const f = sessionFile.get(e);
    if (!f || isFile(f)) continue;
    let best: { file: string; mtime: number } | null = null;
    for (const c of files) {
      const rel = c.split("/rescued/").slice(1).join("/rescued/").split("/").slice(1).join("/");
      if (!rel || !f.endsWith("/" + familyRel(rel))) continue;
      const m = fileMtime(c);
      if (!best || m > best.mtime) best = { file: c, mtime: m };
    }
    if (best) { taken.add(best.file); taken.add(familyOf(best.file)); e.saved = underRoot(db.s.root, best.file); e.mtime ||= best.mtime; }
  }
  // Saved pages no session stands for (one per page: the newest of its rescue copies).
  const extra = new Map<string, { file: string; mtime: number }>();
  for (const file of files) {
    const fam = familyOf(file);
    if (taken.has(file) || taken.has(fam)) continue;
    const m = fileMtime(file), cur = extra.get(fam);
    if (!cur || m > cur.mtime) extra.set(fam, { file, mtime: m });
  }
  for (const [fam, x] of extra) out.push({ key: null, name: basename(fam), dir: basename(dirname(fam)), mtime: x.mtime, url: null, status: null, saved: underRoot(db.s.root, x.file) });
  return out;
}

// What a squad's members expose for the operator to open (expose-hosted-services R8): the open `exposed`
// rows (newest first) with the probe's status/reach, plus the legacy `devenv` value as one `dev env`
// entry owned by the Lead, no badge. The page builds the links (R10), from url + reach.
// exposed-cleanup U4: `audience = 'self'` entries (a member's own tool) are never listed, and each other entry
// carries a `state`: open (up and remote, or the never-probed legacy dev env), host-only, down, checking.
export function exposedState(e: { legacy: boolean; status: string | null; reach: string | null }): "open" | "host-only" | "down" | "checking" {
  if (e.legacy) return "open";
  if (e.status === "down" || e.reach === "down") return "down";
  if (e.status === "up" && e.reach === "remote") return "open";
  if (e.status === "up" && e.reach === "host-only") return "host-only";
  return "checking";
}
function exposedFor(db: Db, label: string, topic: string, st: any) {
  let rows: any[] = [];
  try {
    rows = db.all(`SELECT e.id, e.name, e.url, e.note, e.role, e.suffix, e.scope, e.audience, e.created_at, o.status, o.reach, o.down_since
      FROM exposed e LEFT JOIN observed_exposed o ON o.exposed_id = e.id
      WHERE e.project = ? AND e.squad = ? AND e.gone_at IS NULL AND COALESCE(e.audience, 'operator') != 'self' ORDER BY e.created_at DESC, e.id DESC`, label, topic);
  } catch { /* a db from before migration 0038 has no exposed table */ }
  const out = rows.map((r) => ({
    id: Number(r.id), name: String(r.name), url: String(r.url), note: r.note ?? null,
    role: String(r.role) + (r.suffix ? `-${r.suffix}` : ""), scope: String(r.scope),
    age_s: Math.max(0, clockNow() - (Number(r.created_at) || 0)), status: r.status ?? null, reach: r.reach ?? null,
    down_since: r.down_since ?? null, legacy: false, state: "checking" as string,
  }));
  const env = String(st?.devenv ?? "").trim();
  if (env) out.push({ id: 0, name: "dev env", url: env.split(" ")[0], note: env.split(" ").slice(1).join(" ") || null, role: "lead", scope: "squad", age_s: 0, status: null, reach: null, down_since: null, legacy: true, state: "open" });
  for (const e of out) e.state = exposedState(e);
  return out;
}
// The Open cell and the text board's counts: host-only and checking entries are not counted, only listed.
function exposedSummary(list: { state: string }[]) {
  const n = (k: string) => list.filter((e) => e.state === k).length;
  return { open: n("open"), down: n("down"), host_only: n("host-only"), checking: n("checking") };
}
// Each project's Studio worktree (U261): the adopted `_studio` member's, else the project's studio_wt
// while the loop sees a worker there, else the `ds-<label>-studio` worker the loop has seen.
const studioWts = (db: Db): Map<string, string> => db.memo("studio_wts", () => {
  const out = new Map<string, string>();
  const put = (rows: Row[]) => { for (const r of rows) if (r.wt && !out.has(String(r.project))) out.set(String(r.project), String(r.wt)); };
  put(db.all("SELECT project, wt FROM members WHERE squad = '_studio' AND COALESCE(status, '') != 'gone' AND wt IS NOT NULL ORDER BY id DESC"));
  put(db.all(`SELECT p.label AS project, p.studio_wt AS wt FROM projects p WHERE p.studio_wt IS NOT NULL
    AND EXISTS (SELECT 1 FROM observed_workers w WHERE w.project = p.label AND w.wt = p.studio_wt AND w.gone_at IS NULL)`));
  put(db.all("SELECT project, wt FROM observed_workers WHERE name = 'ds-' || project || '-studio' AND gone_at IS NULL ORDER BY rowid DESC"));
  return out;
});
// The project's agents stuck on a usage limit (observed_limited, from the sweep's limited.json), or
// [] when that file is older than 10 min — a sweep that stopped running proves nothing.
const limitedFor = (db: Db, label: string): any[] => db.memo(`limited:${label}`, () => readLimitedFor(db, label));
function readLimitedFor(db: Db, label: string): any[] {
  return db.all("SELECT doc, mtime FROM observed_limited WHERE project = ? ORDER BY rowid", label)
    .filter((r) => NOW() - (Number(r.mtime) || 0) <= 600).map((r) => parse(r.doc)).filter(Boolean);
}

// Per-unit PR verdicts ("<topic>/<slug>" -> {verdict, reasons, poked}): the GitHub observer's row for
// the unit's PR, else the sweep's pr-health.json row; a row older than 10 min proves nothing. A
// GitHub row has no poke count: its `stale` (blocked past pr_stale_min) stands in for "poked".
const prHealthFor = (db: Db, label: string): Record<string, PrHealth> => db.memo(`health:${label}`, () => readPrHealthFor(db, label));
function readPrHealthFor(db: Db, label: string): Record<string, PrHealth> {
  const out: Record<string, PrHealth> = {};
  const rows = db.all(`SELECT ref, unit, repo, verdict, reasons, stale, doc, observed_at FROM observed_prs
    WHERE project = ? AND (unit IS NOT NULL OR repo IS NULL) ORDER BY repo IS NULL, observed_at DESC`, label);
  for (const r of rows) {
    const d = parse(r.doc) ?? {};
    // The sweep's rows age by the file's own `at`: a sweep that stopped writing leaves them behind.
    if (NOW() - (Number(r.repo == null ? d.file_at ?? r.observed_at : r.observed_at) || 0) > 600) continue;
    const unit = String(r.unit ?? r.ref);
    if (unit in out) continue;
    const raw = parse(r.reasons);
    const reasons = Array.isArray(raw) ? raw.join(",") : typeof raw === "string" ? raw : null;
    out[unit] = { verdict: r.verdict == null ? undefined : String(r.verdict), reasons: reasons ?? undefined,
      poked: r.repo == null ? d.poked ?? undefined : Number(r.stale) === 1 ? 1 : undefined };
  }
  return out;
}

const progress = (u: any[]) => ({
  done: u.filter((x) => x?.status === "done").length,
  dispatched: u.filter((x) => x?.status === "dispatched").length,
  planned: u.filter((x) => (x?.status ?? "planned") === "planned").length,
  cancelled: u.filter((x) => x?.status === "cancelled").length,
  total: u.filter((x) => x?.status !== "cancelled").length,
});

// The finished condition (squad-done-definition U1): squad-finish.ts' settle() over the squad JSON, with
// the done units whose PR the loop sees open (the same freshness as the loop's all-done rule). A held
// unit is open work, so a squad whose only open units are held is not finished.
function finishOf(db: Db, label: string, topic: string, st: any): Finish | null {
  if (!st) return null;
  const open = openPrUnits(db.s.db, label, topic, NOW());
  return settle({ type: st.type, units: arr(st.units).map((u: any) => ({ ...u, pr_open: open.has(String(u?.slug ?? "")) })), members: arr(st.members) });
}
// squad-done-definition U4: one name per squad state, with what it means, who set it and what the operator
// can do. Keyed by `display_key` (stable; the label may carry a count). Rendered in the pill's hover, the
// expanded squad panel and the text board.
export type StateExplain = { means: string; set_by: string; you_can: string };
const WORKING: StateExplain = { means: "work is in flight", set_by: "the loop (computed)", you_can: "nothing, unless a question is in Needs-you" };
const EXPLAIN: Record<string, StateExplain> = {
  planning: WORKING, implementing: WORKING, testing: WORKING, fixing: WORKING, "retest due": WORKING, queued: WORKING,
  blocked: { means: "a question or blocker needs you", set_by: "the Lead", you_can: "answer it in Needs-you" },
  "waiting-on-you": { means: "a question or blocker needs you", set_by: "the Lead", you_can: "answer it in Needs-you" },
  "held-only": { means: "nothing is dispatched or ready; the only open work is held units", set_by: "the loop (computed)",
    you_can: "release the held units, cancel them, suspend the squad, or leave it parked" },
  "wrapping-up": { means: "every unit is done or cancelled with no open PR and no Tester; the Lead owes the test check and the debrief",
    set_by: "the loop (computed)", you_can: "nothing; a \"Wrap-up stalled\" card comes only if the Lead stops answering" },
  done: { means: "finished; the Lead marked it done and the squad waits only for you", set_by: "the Lead", you_can: "try it out (Documents → Try it), then Close squad; the Lead writes the debrief when you close it" },
  pausing: { means: "its agents are being stopped", set_by: "you (Pause)", you_can: "Resume" },
  paused: { means: "its agents are stopped; its worktrees are kept", set_by: "you (Pause)", you_can: "Resume" },
  resuming: { means: "its agents are being started again", set_by: "you (Resume)", you_can: "wait" },
  suspended: { means: "its worktrees are removed; branches and conversations are kept", set_by: "you (Suspend)", you_can: "Restore" },
  "on-hold": { means: "its worktrees are removed; branches and conversations are kept", set_by: "you (Suspend)", you_can: "Restore" },
  archiving: { means: "the loop is closing it", set_by: "you (Close squad)", you_can: "wait; it reads stuck after 15 min" },
  suspending: { means: "the loop is suspending it", set_by: "you (Suspend)", you_can: "wait; it reads stuck after 15 min" },
  failed: { means: "the squad never fully started", set_by: "the spawn", you_can: "Close it" },
};
export const STATE_LEGEND = ["paused: you stopped its agents; its worktrees stay",
  "suspended: you removed its worktrees; branches stay",
  "parked: nobody stopped it; it only has held work left"];
// `noDebrief`: the project has `debrief off`, so the meanings drop their debrief clause.
export const explainState = (key: string, noDebrief = false): StateExplain | null => {
  const e = EXPLAIN[key] ?? null;
  if (!e || !noDebrief) return e;
  if (key === "wrapping-up") return { ...e, means: "every unit is done or cancelled with no open PR and no Tester; the Lead owes the test check" };
  if (key === "done") return { ...e, you_can: "try it out (Documents → Try it), then Close squad" };
  return e;
};
const allUnitsDone = (fin: Finish | null): boolean => fin?.state === "wrapping-up";
// A parked squad's hover adds the planned units that can only wait on the held ones (squad-done-definition U8).
const waitingNote = (e: any, m: number) => (e && m > 0 ? { ...e, means: `${e.means} (+${m} waiting on them)` } : e);
const heldOnly = (fin: Finish | null): boolean => fin?.state === "held-only";

// The DISPLAY status. A `running` squad shows `planning` until a unit is dispatched, then
// `implementing`. A FEATURE squad that has gained a Tester (the post-build test/fix loop) shows
// `testing`, or `fixing` while a Builder is dispatched on a bug; a `--type testing` squad always
// has one, so it keeps planning→implementing. Every other stored status shows as-is. A running
// squad meeting the finished condition shows `wrapping up` (only while `status` is `running`,
// so `done` still shows only once the stored status is no longer `running`).
function displayStatus(st: any, status: string, retest: Retest | null = null, fin: Finish | null = null): string {
  // waiting-on-you with nothing queued (state from before resolve-question reset it) is running.
  status = shownStatus(status, arr(st.waiting_on_you).length);
  if (status !== "running") return status;
  // U238: fixes merged after a Tester pass ended, nothing dispatched, no Tester up: the retest is owed.
  if (retest) return "retest due";
  if (allUnitsDone(fin)) return "wrapping up";
  // squad-done-definition U3: only held work is left; nobody stopped the squad, it is parked.
  if (heldOnly(fin)) return `parked · ${fin!.held.length} held`;  // hover: hoverWaiting()
  const u = arr(st.units);
  const disp = u.filter((x) => x?.status === "dispatched").length;
  const impl = u.filter((x) => x?.status === "dispatched" || x?.status === "done").length;
  if ((st.type ?? "feature") === "feature" && arr(st.members).some((m) => m?.role === "tester"))
    return disp > 0 ? "fixing" : "testing";
  return impl > 0 ? "implementing" : "planning";
}

// U237: a running squad's phase says what it is waiting for. `queued`: a feature squad whose plan
// is done (no unit dispatched, a planned unit not held with its deps done) and whose Builder is
// wanted but not started; the hover is the newest wait reason the picker recorded. `archiving` /
// `suspending` / `resuming`: the squad's wish (squads.want) is written and not granted yet; the
// hover says when, by whom and the last wish event; over WISH_STUCK_S it reads stuck.
const WISH_STUCK_S = 15 * 60;
// debrief-on-archive U2: what the archive's final-debrief step says on the hover, "" when it has none.
function debriefNote(step: Step): string {
  if (step.state === "open") return `Lead writing the final debrief (${Math.floor(Math.max(0, NOW() - step.asked_at) / 60)} of ${Math.round(step.limit_s / 60)} min)`;
  return step.state === "written" ? "debrief written" : step.state === "timeout" ? "debrief timed out"
    : step.state === "lead-gone" ? `debrief not written: Lead gone${step.why ? ` (${step.why})` : ""}` : `debrief skipped${step.why ? `: ${step.why}` : ""}`;
}
// archive-stuck-worktrees U2: what an archiving squad still waits on, one bit per member that has a worktree
// (newest row per role[-suffix], not gone): its newest `action:member.close` episode says which step it is on.
function archiveWaits(db: Db, label: string, topic: string, wantAt: number): { bits: string[]; lastAt: number } {
  const rows = db.all(`SELECT id, role, suffix, wt, status FROM members WHERE project = ? AND squad = ? ORDER BY id DESC`, label, topic);
  const seen = new Set<string>(), bits: string[] = [];
  for (const m of rows) {
    const who = m.suffix ? `${m.role}-${m.suffix}` : String(m.role);
    if (seen.has(who)) continue;
    seen.add(who);
    if (!m.wt || m.status === "gone") continue;
    const e = db.one("SELECT episode_key, state, result, ended_at, started_at FROM episodes WHERE project = ? AND subject = ? AND kind = 'action:member.close'", label, `member:${m.id}`);
    const key = String(e?.episode_key ?? ""), remove = key.startsWith("close:remove:"), n = Number(/:retry(\d+)$/.exec(key)?.[1] ?? 0);
    const kept = db.one("SELECT payload FROM events WHERE project = ? AND squad = ? AND kind = 'leftover_recorded' AND member = ? AND at >= ? ORDER BY id DESC LIMIT 1", label, topic, String(m.wt), wantAt);
    let step: string;
    if (kept) step = `kept as a leftover: ${(parse(kept.payload) as any)?.reason ?? "unknown"}`;
    else if (e && remove && e.state === "dropped" && /^stale(:|$)/.test(String(e.result ?? ""))) {
      const reason = String(e.result).replace(/^stale:?\s*/, "") || "stale", at = Number(e.ended_at ?? NOW());
      const next = Math.max(0, at + removeWaitS(db.s, label, n) - NOW());
      step = `removal skipped (${reason}) ${Math.floor(Math.max(0, NOW() - at) / 60)} min ago, try ${n + 1}, next in ${next >= 60 ? Math.ceil(next / 60) + " min" : next + " s"}`;
    } else if (e && remove) step = "removing the worktree";
    else if (e && (e.state === "acted" || e.state === "running")) step = "stopping";
    else step = "waiting for a stop";
    bits.push(`waiting on ${who}: ${step}`);
  }
  const last = db.one("SELECT MAX(at) AS at FROM events WHERE project = ? AND squad = ? AND kind IN ('member_closed', 'leftover_recorded') AND at >= ?", label, topic, wantAt);
  return { bits, lastAt: Number(last?.at ?? 0) };
}
type PhaseFact = { status: string; note: string | null; stuck: boolean };
function phaseFact(db: Db, label: string, topic: string, st: any, status: string, shown: string, ready: boolean): PhaseFact {
  const w = db.one("SELECT want, want_at, want_by, want_result FROM squads WHERE project = ? AND topic = ?", label, topic);
  const want = String(w?.want ?? ""), word = status === "suspended" && want === "running" ? "resuming"
    : want === "gone" && status !== "gone" ? "archiving" : want === "suspended" && status !== "suspended" ? "suspending" : "";
  if (word && !String(w?.want_result ?? "").startsWith("done")) {
    const at = Number(w?.want_at) || 0, age = at ? Math.max(0, NOW() - at) : 0;
    const bits = [`asked ${at ? new Date(at * 1000).toISOString().replace(/\.\d+Z$/, "Z") : "at an unknown time"}${w?.want_by ? ` by ${w.want_by}` : ""}`];
    const ev = at ? db.one(`SELECT kind, payload FROM events WHERE project = ? AND squad = ? AND at >= ?
      AND kind IN ('wish_failed', 'wish_given_up', 'member_drift_cleared') ORDER BY id DESC LIMIT 1`, label, topic, at) : null;
    const failed = String(w?.want_result ?? "").startsWith("failed") ? String(w?.want_result) : null;
    const why = ev ? `${ev.kind}${(parse(ev.payload) as any)?.error ? `: ${(parse(ev.payload) as any).error}` : ""}` : failed;
    // While the debrief step is open the archive is waiting on the Lead, not stuck; once it settles the clock runs from its end.
    const step = word === "archiving" ? archiveDebriefStep(db.s, label, topic) : null;
    const waits = word === "archiving" ? archiveWaits(db, label, topic, at) : null;
    // The clock runs from the newest of the wish, the debrief step's end and the last member close event.
    const base = Math.max(at, step?.settled_at ?? 0, waits?.lastAt ?? 0);
    const stuck = step?.state === "open" ? false : base ? NOW() - base > WISH_STUCK_S : age > WISH_STUCK_S;
    if (step) bits.push(debriefNote(step));
    if (waits) bits.push(...waits.bits);
    if (why) bits.push(`latest: ${why}`);
    if (stuck && !why) bits.push(`no progress for ${Math.floor((word === "archiving" && base ? NOW() - base : age) / 60)} min`);
    return { status: word, note: bits.join("; "), stuck };
  }
  if (shown !== "planning" || !ready || (st.type ?? "feature") !== "feature") return { status: shown, note: null, stuck: false };
  const b = db.one(`SELECT p.reason AS reason FROM members m LEFT JOIN picks p ON p.member = m.id WHERE m.project = ? AND m.squad = ? AND m.role = 'builder'
    AND m.want = 'running' AND m.wt IS NULL AND COALESCE(m.status, '') != 'gone' AND m.want_result IS NULL LIMIT 1`, label, topic);
  if (!b) return { status: shown, note: null, stuck: false };
  let reason = String(b.reason ?? "");
  if (!reason) {
    const e = db.one("SELECT payload FROM events WHERE project = ? AND squad = ? AND kind = 'pick' ORDER BY id DESC LIMIT 1", label, topic);
    reason = String((parse(e?.payload) as any)?.reason ?? "");
  }
  return { status: "queued", note: reason ? `waiting for a Builder: ${reason.replace(/^WAIT slot:\s*/, "").replace(/^WAIT host:\s*/, "host busy: ")}` : "waiting for a Builder to start", stuck: false };
}

// " std·sonnet" / " hard" / " hard↑·opus" / " hard?·opus": the unit's Builder tier + the model
// its Builder runs on. An untagged unit (no tier recorded) renders "hard?" — it is read as
// hard — plus the Builder model when one exists, so the silent fall to hard can be seen.
// A unit's Builder: the member whose wt is the unit's builder_wt, else the builder with the unit's slug as suffix.
const builderOf = (u: any, members: any[]) =>
  (u?.builder_wt ? members.find((m) => m?.wt === u.builder_wt) : null) ?? members.find((m) => m?.role === "builder" && m?.suffix === u.slug) ?? null;

function tierLabel(u: any, builder: any, f: ReturnType<typeof crewFacts> | null): string {
  const t = u?.tier ?? "";
  const md = f ? (f.model_label ?? "") + (f.model_mismatch && f.model ? " ⚠" + f.model : "") : "";
  if (t === "") return " hard?" + (md ? "·" + md : "");
  return " " + (u.escalated === true ? "hard↑" : t === "standard" ? "std" : t) + (md ? "·" + md : "");
}

const nid = (s: unknown) => "n" + String(s).replace(/[^A-Za-z0-9]/g, "_");
// ext_deps ("<squad>/<unit>") resolved against the sibling squads' rows, then the closed squads
// (documents rows of archive/<squad>-*.json). Fail-closed: absent -> "missing".
function extDepList(db: Db, label: string, u: any) {
  const raw = Array.isArray(u?.ext_deps) ? u.ext_deps : [];
  return raw.map(String).map((ref: string) => {
    const [sq, un] = ref.split("/");
    let status: string | null = null;
    if (sq && un) {
      const live = db.one(`SELECT u.status FROM units u JOIN squads s ON s.project = u.project AND s.topic = u.squad
        WHERE u.project = ? AND u.squad = ? AND u.slug = ? AND COALESCE(s.status, '') != 'closed'`, label, sq, un);
      if (live) status = String(live.status ?? "planned");
      else {
        const st = archivedDocs(db, label).filter((a) => a.file.startsWith(`${sq}-`))
          .map((a) => { const x = arr(a.st?.units).find((y: any) => y?.slug === un); return x ? String(x.status ?? "planned") : null; });
        if (st.includes("done")) status = "closed-done";
        else if (st.some((x) => x)) status = "closed";
      }
    }
    return { ref, status: status ?? "missing" };
  });
}

// The closed squads of a project: documents rows of archive/*.json, parsed (st null when it won't).
const archivedDocs = (db: Db, label: string) => db.memo(`archived:${label}`, () => readArchivedDocs(db, label));
function readArchivedDocs(db: Db, label: string): { file: string; mtime: number; st: any }[] {
  const pre = `${label}/archive/`;
  return db.all("SELECT path, mtime, body FROM documents WHERE project = ? AND substr(path, 1, ?) = ? ORDER BY path", label, pre.length, pre)
    .filter((r) => String(r.path).endsWith(".json")).map((r) => ({ file: basename(String(r.path)), mtime: Number(r.mtime) || 0, st: parse(r.body) }));
}

const depList = (u: any) => (Array.isArray(u.deps ?? []) ? (u.deps ?? []) : [u.deps]).map(String);

// Orca's view of the workers (observed_workers): each worktree's state, "gone" once its row has
// gone_at, and whether the Orca observer's rows are current at all. loopDown: the Leads' beat rows
// stopped moving with the loop, so a beat's age says nothing about the Lead.
// The loop's own dispatch verdict per member (U100: liveness.ts dispatchVerdict, read through
// the member's squad) — so an idle standing role is not shown as settled, a rebound-settled one
// is not restarted on, and a stale read keeps the agent state.
/** `backendOk`: the Orca observer's rows are current. `contractOk`: the projects whose contract observer rows are
 *  current (U58), so a member off Orca with no row of its own reads as gone there, else unknown. */
type Live = { ws: Record<string, string>; backendOk: boolean; loopDown: boolean; contractOk?: Set<string> };
/** observed_workers rows the contract observer wrote (bin/loop/observers/contract.ts), not Orca's. */
const CONTRACT_ROW = "COALESCE(json_valid(doc) AND json_extract(doc, '$.backend') = 'contract', 0)";

// A member's display state: a standing role (not lead, not builder) whose agent state reads
// `done` follows the loop's verdict — open and rebound read `waiting` (idle at its prompt,
// the word an idle role already gets), settled reads `⚠ settled`, unknown keeps today's
// word — the same words as watch.sh's TEAM rows. No dispatch on record keeps today's word.
// On a loop.db from before migration 0017 (no dispatch_seen_at, the loop not yet migrated)
// there is no verdict to read: keep the agent state instead of rendering the squad broken.
function memberState(db: Db, label: string, topic: string, m: any, base: string): string {
  if (m.pause && m.pause.state !== "active") return m.pause.state;
  if (!m.wt) return "unplaced";
  if (base !== "done" || m?.role === "lead" || m?.role === "builder") return base;
  if (!db.memo("dispatch_seen_at", () => db.s.columns("observed_workers").has("dispatch_seen_at"))) return base;
  const v = dispatchVerdict(db.s, label, topic, String(m?.wt ?? ""), NOW());
  if (v === "settled") return "⚠ settled";
  if (v === "open" || v === "rebound") return "waiting";
  return base;
}

// U267: the loop filed a failed report for this unit (its Builder's own worker_done, no PR) and the
// Builder's current dispatch is still the one it named: the unit waits on its Lead. Off Orca (U12b) there is
// no dispatch: the report names the Builder's generation (`gen:<gen>`, liveness.ts idleBuilder) instead.
function failedReport(db: Db, label: string, squad: string, slug: string, wt: unknown): boolean {
  if (!wt) return false;
  try {
    return !!db.one(`SELECT 1 FROM episodes e JOIN observed_workers w ON w.project = e.project AND w.wt = ? AND w.gone_at IS NULL
      WHERE e.project = ? AND e.squad = ? AND e.kind = 'idle' AND e.state = 'failed_report' AND e.ended_at IS NULL
        AND (e.episode_key = 'failed|' || ? || '|' || w.dispatch_id
          OR e.episode_key = 'failed|' || ? || '|gen:' || (SELECT m.gen FROM members m WHERE m.project = w.project AND m.wt = w.wt ORDER BY m.id DESC LIMIT 1))`,
      String(wt), label, squad, slug, slug);
  } catch { return false; }
}

// A dispatched unit takes its phase from its PR: none/draft = building (BUILT once the Builder
// reports done — "no PR" when it finished without recording one, so a Builder that stopped
// short of the PR is visible), checks running = testing, a check failed = fixing, green and
// awaiting review/merge = babysitting. The sweep's pr-health verdict refines that: ready =
// merge-ready, and a blocked PR the sweep poked (or whose Builder is gone) = stale; a
// blocked-but-unpoked PR stays babysitting. A waiting/gone/unknown/suspended Builder overrides
// the phase. hasPr is passed separately because a null status is ambiguous (no PR vs unknown).
type PrHealth = { verdict?: string; reasons?: string; poked?: number } | null;
function unitPhase(b: string, ps: string | null | undefined, hasPr: boolean, h: PrHealth = null, hasBuilder = true): string {
  if (b === "waiting" || b === "gone" || b === "unknown" || b === "suspended") return b;
  if (h?.verdict === "ready") return "merge-ready";
  if (h?.verdict === "blocked" && (h.poked != null || !hasBuilder)) return "stale";
  if (ps === "failing") return "fixing";
  if (ps === "running") return "testing";
  if (ps === "open" || ps === "ready") return "babysitting";
  if (ps === "merged") return "merged";
  return b === "done" ? (hasPr ? "built" : "no PR") : "building";
}

// The open overrides by member (the board writes them keyed by worktree), newest per member; once per render.
const ovShape = (o: Record<string, unknown>) => ({ id: Number(o.id), scope: String(o.scope || "member"), target: String(o.member), model: (o.model as string | null) ?? null,
  account: (o.account as string | null) ?? null, effort: (o.effort as string | null) ?? null, plan: (o.plan as string | null) ?? null, set_by: (o.set_by as string | null) ?? null });
const overridesAll = (db: Db) => db.memo("overrides_all", () => db.all("SELECT id, member, scope, model, account, effort, plan, set_by FROM overrides WHERE cleared_at IS NULL ORDER BY id").map(ovShape));
const overrides = (db: Db) => db.memo("overrides", () => new Map(overridesAll(db).filter((o) => o.scope === "member").map((o) => [o.target, o])));
// U24: the open squad / role / project overrides (the narrowest that applies to a member, a squad, or all of them listed).
const broaderOverrides = (db: Db) => overridesAll(db).filter((o) => o.scope !== "member");
const squadOverride = (db: Db, project: string, squad: string) => broaderOverrides(db).filter((o) => o.scope === "squad" && o.target === `${project}/${squad}`).at(-1) ?? null;
const broaderFor = (db: Db, project: string, squad: string, role: string | null) => {
  const bo = broaderOverrides(db), last = (sc: string, t: string) => bo.filter((o) => o.scope === sc && o.target === t).at(-1);
  return last("squad", `${project}/${squad}`) ?? (role ? last("role", `${project}/${role}`) : undefined) ?? last("project", project) ?? null;
};

// A member's wishes (U151), from its loop.db row (the newest per worktree, else per project/squad/role/suffix):
// its effective state (pause.ts effective()), its own wish and its pending one-time wishes with age and author.
const memberRows = (db: Db) => db.memo("member_rows", () => {
  const by = new Map<string, Row>();
  for (const r of db.all("SELECT * FROM members ORDER BY id")) {
    by.set(`${r.project}/${r.squad}/${r.role}/${r.suffix ?? ""}`, r);
    if (r.wt) by.set(String(r.wt), r);
  }
  return by;
});
function wishOf(db: Db, project: string, squad: string, m: any): { state: string | null; own: string | null; pending: Pending[] } | null {
  const rows = memberRows(db), r = (m.wt && rows.get(String(m.wt))) || rows.get(`${project}/${squad}/${m.role ?? ""}/${m.suffix ?? ""}`);
  if (!r) return null;
  const e = effective(db.s, r);
  return { state: e.state, own: e.own, pending: pendingWishes(r, clockNow()) };
}

// --- accounts (observed_accounts, from the sweep's accounts.tsv) -----------------------------------

const clock = (epoch: number) => new Date(epoch * 1000).toTimeString().slice(0, 5);
const epochOf = (v: unknown) => (typeof v === "string" && /^[0-9]+$/.test(v) ? Number(v) : null);
const pctOf = (v: unknown) => (typeof v === "string" && /^[0-9]+(\.[0-9]+)?$/.test(v) ? Math.round(Number(v)) : null);

// account-free-resets U3: the Free resets cell's data from accounts.tsv's 13th column (observed_accounts.resets).
// `state` is reported|not_reported|unknown; a NULL, unparsable or unrecognised value reads `unknown`, never 0.
// `count` and `first_use_by` (the earliest grant expiry) are set when reported; `grants` keeps each grant.
function resetsOf(v: unknown) {
  const unknown = { state: "unknown", count: null as number | null, first_use_by: null as number | null, grants: [] as any[], reason: null as string | null };
  if (typeof v !== "string" || !v || v === "-") return unknown;
  let j: any;
  try { j = JSON.parse(v); } catch { return unknown; }
  if (!j || typeof j !== "object") return unknown;
  if (j.state === "not_reported") return { ...unknown, state: "not_reported" };
  if (j.state === "unknown") return { ...unknown, reason: typeof j.reason === "string" ? j.reason : null };
  if (j.state !== "reported" || !Array.isArray(j.grants)) return unknown;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const grants = j.grants.filter((g: any) => g && typeof g === "object").map((g: any) => ({
    id: String(g.id ?? ""), label: String(g.label ?? ""), left: num(g.left), total: num(g.total), use_by: num(g.use_by),
    refills: Array.isArray(g.refills) ? g.refills.map(String) : [], usable_now: g.usable_now === true }));
  const count = num(j.count) ?? grants.length;
  const uses = grants.map((g: any) => g.use_by).filter((x: number | null): x is number => x != null);
  return { state: "reported", count, first_use_by: uses.length ? Math.min(...uses) : null, grants, reason: null };
}

// account-free-resets U4: each account's newest `account_reset_used` event of the last hour (the Use
// button's answer, from fulfil/account-reset.ts), as {at, outcome, detail, grant}; older ones say nothing.
type ResetUse = { at: number; outcome: string; detail: string | null; grant: string | null };
function resetsUsed(db: Db, now: number): Map<string, ResetUse> {
  const out = new Map<string, ResetUse>();
  try {
    for (const r of db.all("SELECT at, payload FROM events WHERE kind = 'account_reset_used' AND at >= ? ORDER BY id", now - 3600)) {
      let p: any = null;
      try { p = JSON.parse(String(r.payload)); } catch { continue; }
      if (!p || typeof p.agent !== "string" || typeof p.account !== "string") continue;
      out.set(`${p.agent}/${p.account}`, { at: Number(r.at), outcome: String(p.outcome ?? "?"), detail: typeof p.detail === "string" && p.detail ? p.detail : null, grant: typeof p.grant === "string" ? p.grant : null });
    }
  } catch { /* an older loop.db: no events read, nothing shown */ }
  return out;
}

// account-free-resets U7: each account's open `account-reset` request (the Use button's press the loop has not
// finished) as {id, at, project, queued}; `queued` = that project is paused or pausing, so the loop holds it until Resume.
type ResetPending = { id: number; at: number; project: string; queued: boolean };
function resetsPending(db: Db): Map<string, ResetPending> {
  const out = new Map<string, ResetPending>();
  try {
    for (const r of db.all("SELECT id, created_at AS at, project, payload FROM requests WHERE kind = 'account-reset' AND done_at IS NULL ORDER BY id DESC")) {
      let p: any = null;
      try { p = JSON.parse(String(r.payload)); } catch { continue; }
      if (!p || typeof p.agent !== "string" || typeof p.account !== "string") continue;
      let queued = false;
      try { queued = paused(db.s, { project: String(r.project) }); } catch { /* unknown pause state: not queued */ }
      out.set(`${p.agent}/${p.account}`, { id: Number(r.id), at: Number(r.at), project: String(r.project), queued });
    }
  } catch { /* an older loop.db: nothing pending */ }
  return out;
}

// One entry per (agent, account); [] when there are none (the board then shows no strip).
// `text` is the strip cell both views print: `A 72% · resets 15:00 · wk 41%`, `B ?`, or
// `C limited · resets 15:00` while limited_until is in the future, `D out of credits · <link>` while a credits
// hold is live (no reset: the provider's link instead); a non-ok skills value is appended
// (`· skills broken: …`), whether usage is known or not.
function accounts(db: Db, now = NOW()) {
  const rows = db.all("SELECT * FROM observed_accounts ORDER BY rowid");
  // plan "disable" U3: the operator's switch (accounts.state, written by accounts.ts) — NULL is enabled.
  const off = new Set(db.all("SELECT agent, account FROM accounts WHERE state = 'disabled'").map((r) => `${r.agent}/${r.account}`));
  // provider-billing-fallback U4: a live credits hold (credits.ts) reads `out of credits`, with the provider's link.
  const holds = new Map(liveHolds(db.s, now).map((h) => [`${h.agent}/${h.account}`, h]));
  // claude-login-ended U4: a live login hold (login.ts) reads `login ended · run /login`, no percentages.
  const logins = new Map(liveLoginHolds(db.s, now).map((h) => [`${h.agent}/${h.account}`, h]));
  const multi = new Set(rows.map((c) => c.agent)).size > 1;
  const lastReset = resetsUsed(db, now), pending = resetsPending(db);
  const dash = (v: unknown) => (typeof v === "string" && v && v !== "-" ? v : null);
  return rows.map((c) => {
    const agent = String(c.agent), account = String(c.account);
    const session = pctOf(c.session_pct), weekly = pctOf(c.weekly_pct), reset = epochOf(c.session_reset), limitedUntil = epochOf(c.limited_until);
    const limited = limitedUntil != null && limitedUntil > now;
    const plan = dash(c.plan);   // U123: accounts.tsv's 12th column; unknown = null, never a guess
    const name = (multi ? `${agent}:${account}` : account) + (plan ? ` (${plan})` : "");
    const hold = holds.get(`${agent}/${account}`);
    const credits = hold ? { until: hold.until, ...creditsNotice(db.s, agent, account, hold.started - 60) } : null;
    const lh = logins.get(`${agent}/${account}`);
    const login = lh && !credits ? { until: lh.until, notice: LOGIN_ENDED, where: lh.from } : null;
    const text = credits ? `${name} out of credits${credits.link ? ` · ${credits.link}` : ""}`
      : login ? `${name} ${LOGIN_ENDED} · run /login`
      : limited ? `${name} limited · resets ${clock(limitedUntil!)}`
      : [`${name} ${session == null ? "?" : session + "%"}`, reset != null && reset > now ? `resets ${clock(reset)}` : "",
        weekly == null ? "" : `wk ${weekly}%`].filter(Boolean).join(" · ");
    // account-skills U3: `broken: …` / `warn: …` from accounts.tsv's 11th column; `ok` and unknown say nothing.
    const sk = dash(c.skills), skills = sk && sk !== "ok" ? sk : null;
    const resets = resetsOf(c.resets);
    return { disabled: off.has(`${agent}/${account}`), plan, resets, reset_last: lastReset.get(`${agent}/${account}`) ?? null, reset_pending: pending.get(`${agent}/${account}`) ?? null, agent, account, session_pct: session, session_reset: reset, weekly_pct: weekly,
      weekly_reset: epochOf(c.weekly_reset), note: dash(c.note), label: dash(c.label) ?? account, limited_until: limited ? limitedUntil : null, limited, credits, login,
      skills, text: `${text}${resets.state === "reported" ? ` · free resets ${resets.count}` : ""}${skills ? ` · skills ${skills}` : ""}` };
  });
}

// The Accounts tile (plan U3, KTD8): free of total, each out-of-limits account with its reset, the
// near ones (above pick_session_max / pick_weekly_max, the percents the table shows). Disabled
// accounts are left out. Level: crit when none is free, warn when any is limited, out of credits or near.
function accountsSummary(db: Db | null, label: string, accts: any[], now = NOW()) {
  const sMax = (db ? dsLimit(db, label, "pick_session_max") : null) ?? 95, wMax = (db ? dsLimit(db, label, "pick_weekly_max") : null) ?? 95;
  const live = accts.filter((a) => !a.disabled);
  const day = (e: number) => new Date(e * 1000).toDateString();
  const resetText = (e: number) => (day(e) === day(now) ? clock(e) : new Date(e * 1000).toLocaleDateString("en-US", { weekday: "short" }));
  const limited = live.filter((a) => a.limited && !a.credits && !a.login).map((a) => ({ account: a.account, agent: a.agent, label: a.label, until: a.limited_until, reset: resetText(a.limited_until) }));
  // U4: out of credits is not free either; it has no reset, only the provider's link.
  const credits = live.filter((a) => a.credits).map((a) => ({ account: a.account, agent: a.agent, label: a.label, link: a.credits.link ?? null }));
  const login = live.filter((a) => a.login).map((a) => ({ account: a.account, agent: a.agent, label: a.label }));
  const near = live.filter((a) => !a.limited && !a.credits && !a.login && ((a.session_pct != null && a.session_pct > sMax) || (a.weekly_pct != null && a.weekly_pct > wMax)))
    .map((a) => ({ account: a.account, agent: a.agent, label: a.label, session_pct: a.session_pct, weekly_pct: a.weekly_pct }));
  const free = live.length - limited.length - credits.length - login.length;
  return { total: live.length, free, limited, credits, login, near, level: live.length && free === 0 ? "crit" : limited.length || credits.length || login.length || near.length ? "warn" : "ok" };
}

// The Machine tile, section and text line (plan U4, KTD1/KTD6): the host sample the loop's machine
// observer wrote to observed_machine, with each metric's level computed here so web and text agree.
// Levels come from bin/loop/capacity/machine-level.ts, the same function the Builder host brake reads, from the
// machine_*_warn/crit limits; a missing key means no coloring. The board may run before the loop applied
// the migration: no table or no row = no field (null).
function machineSummary(db: Db | null, label: string, worktrees: number | null, terminals: number | null, squads: any[] = [], now = NOW()) {
  if (!db || !db.memo("machine_table", () => !!db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'observed_machine'"))) return null;
  const r = db.one("SELECT * FROM observed_machine ORDER BY observed_at DESC LIMIT 1");
  if (!r) return null;
  const line = (k: string) => dsLimit(db, label, k), level = levelOf(line);
  const rd = (x: number | null, d = 0) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
  const { cores, load1, loadPct, memTotal, memAvail, memPct, swapTotal, swapPct, psi, lv } = machineLevels(r, line);
  const n = (x: any) => (x == null ? null : Number(x));
  const json = (x: any): any[] => { try { return arr(JSON.parse(String(x ?? "[]"))); } catch { return []; } };
  const disks = json(r.disks).filter((d) => Number(d.total_kb) > 0).map((d) => {
    const used = (Number(d.total_kb) - Number(d.free_kb)) / Number(d.total_kb) * 100;
    return { path: String(d.path), used_pct: rd(used)!, free_pct: rd(100 - used)!, total_kb: Number(d.total_kb), level: level(used, "disk") };
  }).sort((a, b) => b.used_pct - a.used_pct);
  const groups = json(r.groups).map((g) => ({ comm: String(g.comm), procs: Number(g.procs) || 0, rss_kb: Number(g.rss_kb) || 0, cpu_pct: g.cpu_pct == null ? null : Number(g.cpu_pct) }))
    .sort((a, b) => b.rss_kb - a.rss_kb).slice(0, 6);
  // The pressure note names the worst resource past machine_psi_warn.
  const hot = psi.filter((p) => p.level !== "ok").sort((a, b) => LVL[b.level] - LVL[a.level] || (b.avg10 ?? 0) - (a.avg10 ?? 0))[0] ?? null;
  const observed = Number(r.observed_at);
  const cadence = machineCadence();
  const disk = disks[0] ?? null;
  const worseOne = swapPct != null && (memPct == null || LVL[lv.swap] > LVL[lv.mem] || (lv.swap === lv.mem && swapPct > memPct)) ? "swap" : "mem";
  return {
    host: String(r.host), cores, observed_at: observed, stale: machineStale(observed, now), cadence_s: cadence,
    load: { load1, load5: n(r.load5), load15: n(r.load15), pct: rd(loadPct), x: rd(loadPct == null ? null : loadPct / 100, 1), level: lv.load },
    mem: { pct: rd(memPct), total_kb: memTotal, avail_kb: memAvail, level: lv.mem },
    swap: { pct: rd(swapPct), total_kb: swapTotal, level: lv.swap },
    disk: disk && { path: disk.path, used_pct: disk.used_pct, free_pct: disk.free_pct, total_kb: disk.total_kb, level: disk.level },
    disks,
    psi: { cpu: psi[0].avg10, mem: psi[1].avg10, io: psi[2].avg10, note: hot && { kind: hot.kind, avg10: hot.avg10, level: hot.level } },
    worse: worseOne, level: worst(lv.load, lv.mem, lv.swap, disk?.level ?? "ok"),
    worktrees, terminals, groups,
    ...machineView(db, label, squads, memTotal != null && memAvail != null ? memTotal - memAvail : null, memTotal, cores),
  };
}

// The Machine section's ranking, total, breakdown and outside block (plan U2, KTD1/KTD2/KTD9). The table
// lists only this project's rows: squad members (`squad / role`), the Studio, and its leftover worktrees
// (observed_procs rows with no live member). Everything else is summed in the breakdown (a memory split)
// or, when one item is big, named in `outside`. No `label` = the all-projects view: every project's rows,
// each tagged with its project. A member with no row has no figure. Tables are read only when they exist.
// RAM (U4, KTD6): `ram_kb` is charged memory counted once (`mem_kb`) when every row and host group of
// the scan has it, else RSS for all of them (`ram_basis` says which); `rss_kb` stays on every item.
// `loop` (U5) is the loop's own load from the host row, the same on every board and in no project's share.
type Resources = { rss_kb: number; mem_kb: number | null; cpu_pct: number | null; procs: number; psi_cpu: number | null; psi_mem: number | null };
type ProcRow = Resources & { project: string; wt: string };
type HostGroup = { label: string; procs: number; rss_kb: number; mem_kb: number | null; cpu_pct: number | null };
const addCpu = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
function procRows(db: Db | null, label: string) {
  const has = (t: string) => !!db && db.memo("tbl_" + t, () => !!db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t));
  const rows: ProcRow[] = [];
  const mine = new Map<string, Resources>();
  if (!db || !has("observed_procs")) return { rows, mine, studio: null as string | null };
  const u4 = db.memo("procs_mem_kb", () => db.s.columns("observed_procs").has("mem_kb"));  // an older loop.db: RSS only
  const u9 = db.memo("procs_cpu_cg", () => db.s.columns("observed_procs").has("cpu_cg_pct"));  // an older loop.db: sampled CPU only
  // CPU is the leaf cgroups' figure (U9) when the scan had one, else the sampled process ticks.
  for (const r of db.all(`SELECT project, wt, procs, rss_kb, cpu_pct${u9 ? ", cpu_cg_pct" : ""}${u4 ? ", mem_kb, psi_cpu, psi_mem" : ""} FROM observed_procs`)) {
    const e: Resources = { rss_kb: Number(r.rss_kb) || 0, mem_kb: numOrNull(r.mem_kb), cpu_pct: numOrNull(r.cpu_cg_pct) ?? numOrNull(r.cpu_pct), procs: Number(r.procs) || 0,
      psi_cpu: numOrNull(r.psi_cpu), psi_mem: numOrNull(r.psi_mem) };
    rows.push({ project: String(r.project), wt: String(r.wt), ...e });
    if (!label || r.project === label) mine.set(String(r.wt), e);
  }
  return { rows, mine, studio: label ? studioWts(db).get(label) ?? null : null };
}
// Adds `resources` to every member (null without a row) so the page can show it in the member detail.
function decorateResources(db: Db | null, label: string, squads: any[]) {
  const { mine } = procRows(db, label);
  for (const s of squads) for (const m of arr(s.members)) m.resources = (m.wt && mine.get(String(m.wt))) || null;
}
// Host groups (the processes no worktree owns), named `label ?? comm`; without observed_host_procs there are none.
function hostGroups(db: Db): HostGroup[] | null {
  if (!db.memo("tbl_observed_host_procs", () => !!db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'observed_host_procs'"))) return null;
  const h = db.one("SELECT groups FROM observed_host_procs ORDER BY observed_at DESC LIMIT 1");
  if (!h) return null;
  try {
    return arr(JSON.parse(String(h.groups ?? "[]"))).map((g: any) => ({ label: String(g.label ?? g.comm), procs: Number(g.procs) || 0, rss_kb: Number(g.rss_kb) || 0, mem_kb: numOrNull(g.mem_kb), cpu_pct: numOrNull(g.cpu_cg_pct) ?? numOrNull(g.cpu_pct) }));
  } catch { return null; }
}
// The loop's own load (U5, R13/KTD12): the latest host row's loop columns, the same on every board and never in a
// project's share. null on an older loop.db (no columns) or when every column is NULL.
function loopLoad(db: Db) {
  if (!db.memo("tbl_observed_host_procs", () => !!db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'observed_host_procs'"))) return null;
  if (!db.memo("host_procs_loop", () => db.s.columns("observed_host_procs").has("loop_source"))) return null;
  const h = db.one("SELECT loop_cpu_pct, loop_mem_kb, loop_cache_kb, loop_source FROM observed_host_procs ORDER BY observed_at DESC LIMIT 1");
  if (!h || (h.loop_cpu_pct == null && h.loop_mem_kb == null && h.loop_cache_kb == null)) return null;
  return { cpu_cores: h.loop_cpu_pct == null ? null : Math.round(Number(h.loop_cpu_pct)) / 100, mem_kb: numOrNull(h.loop_mem_kb),
    cache_kb: numOrNull(h.loop_cache_kb), source: h.loop_source == null ? null : String(h.loop_source) };
}
const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
function machineView(db: Db, label: string, squads: any[], usedKb: number | null, totalKb: number | null, cores: number | null) {
  const { rows, mine, studio } = procRows(db, label);
  const host = hostGroups(db);
  const charged = rows.length + (host?.length ?? 0) > 0 && rows.every((r) => r.mem_kb != null) && (host ?? []).every((g) => g.mem_kb != null);
  const ram = (x: { rss_kb: number; mem_kb: number | null }) => (charged ? x.mem_kb! : x.rss_kb);
  const wtName = (project: string, wt: string) => {
    const w = db.one("SELECT path FROM observed_worktrees WHERE project = ? AND wt = ?", project, wt);
    return baseName(String(w?.path ?? wt));
  };
  type Item = { label: string; kind: "squad" | "leftover"; project: string; ram_kb: number; rss_kb: number; cpu_pct: number | null; procs: number };
  const out: Item[] = [], names = new Map<string, string>();
  const push = (project: string, wt: string, lbl: string, kind: Item["kind"], e: Resources) => {
    names.set(`${project}\0${wt}`, lbl);
    out.push({ label: lbl, kind, project, ram_kb: ram(e), rss_kb: e.rss_kb, cpu_pct: e.cpu_pct, procs: e.procs });
  };
  const claimed = new Set<string>();
  if (label) {
    for (const s of squads) for (const m of arr(s.members)) {
      const e = m.wt ? mine.get(String(m.wt)) : null;
      if (e && !claimed.has(String(m.wt))) { claimed.add(String(m.wt)); push(label, String(m.wt), `${s.topic} / ${m.label}`, "squad", e); }
    }
    const st = studio ? mine.get(studio) : null;
    if (st && studio && !claimed.has(studio)) { claimed.add(studio); push(label, studio, "studio", "squad", st); }
    for (const r of rows) if (r.project === label && !claimed.has(r.wt)) push(label, r.wt, `left over · ${wtName(r.project, r.wt)}`, "leftover", r);
  } else {
    // All projects: the same names as a project view, each led by its project.
    const member = new Map<string, string>();
    for (const s of squads) for (const m of arr(s.members)) if (m.wt && s.label) member.set(`${s.label}\0${m.wt}`, `${s.topic} / ${m.label}`);
    for (const [project, wt] of studioWts(db)) member.set(`${project}\0${wt}`, "studio");
    for (const r of rows) {
      const m = member.get(`${r.project}\0${r.wt}`);
      if (m) push(r.project, r.wt, `${r.project} · ${m}`, "squad", r);
      else push(r.project, r.wt, `${r.project} · left over · ${wtName(r.project, r.wt)}`, "leftover", r);
    }
  }
  type Sum = { ram_kb: number; rss_kb: number; cpu_pct: number | null };
  const sum = (xs: { rss_kb: number; mem_kb: number | null; cpu_pct: number | null }[]) =>
    xs.reduce((a: Sum, x) => ({ ram_kb: a.ram_kb + ram(x), rss_kb: a.rss_kb + x.rss_kb, cpu_pct: addCpu(a.cpu_pct, x.cpu_pct) }), { ram_kb: 0, rss_kb: 0, cpu_pct: null });
  // Machine CPU in use is the whole machine's busy CPU from /proc/stat (observed_machine.cpu_busy_pct, 100 = one core),
  // never the process sum, which misses short-lived processes and small host groups (U6). NULL renders "—".
  let measured: number | null = null;
  try { measured = numOrNull(db.one("SELECT cpu_busy_pct FROM observed_machine ORDER BY observed_at DESC LIMIT 1")?.cpu_busy_pct); } catch { /* a loop.db from before migration 0036 */ }
  const share = (kb: number) => (usedKb ? Math.round(kb / usedKb * 1000) / 10 : null);
  // A project's pressure stall (KTD11): its worst worktree per resource, never summed; the name goes in the tooltip.
  const worst = (xs: ProcRow[], k: "psi_cpu" | "psi_mem") => xs.reduce((w: ProcRow | null, r) => (r[k] != null && (w === null || r[k]! > w[k]!) ? r : w), null);
  const totalOf = (xs: ProcRow[]) => {
    const t = sum(xs), c = worst(xs, "psi_cpu"), m = worst(xs, "psi_mem");
    const nameOf = (r: ProcRow) => names.get(`${r.project}\0${r.wt}`) ?? wtName(r.project, r.wt);
    // "Project consumes <cpu_cores> cores out of <cores> available. Overall machine utilization is <busy_cores>
    // of <cores> cores (<busy_pct>%)": busy = the machine's CPU from /proc/stat.
    return { cpu_cores: t.cpu_pct == null ? null : Math.round(t.cpu_pct) / 100, cores,
      busy_cores: measured == null ? null : Math.round(measured / 10) / 10,
      busy_pct: measured == null || !cores ? null : Math.round(measured / cores),
      ram_kb: t.ram_kb, rss_kb: t.rss_kb, ram_pct: share(t.ram_kb),
      psi: c || m ? { cpu: c?.psi_cpu ?? null, cpu_wt: c && c.psi_cpu! > 0 ? nameOf(c) : null, mem: m?.psi_mem ?? null, mem_wt: m && m.psi_mem! > 0 ? nameOf(m) : null } : null };
  };
  const total = label ? totalOf(rows.filter((r) => r.project === label)) : { projects: [...new Set(rows.map((r) => r.project))].sort().map((p) => ({ project: p, ...totalOf(rows.filter((r) => r.project === p)) })) };
  // Breakdown: this project, each other project (top 3 by RAM; every project when none is chosen), host, and
  // kernel & cache (the rest of used memory).
  const others = new Map<string, { project: string; wts: Set<string>; xs: ProcRow[] }>();
  for (const r of rows) if (r.project !== label) {
    const o = others.get(r.project) ?? { project: r.project, wts: new Set<string>(), xs: [] };
    o.wts.add(r.wt); o.xs.push(r); others.set(r.project, o);
  }
  const otherList = [...others.values()].map((o) => ({ project: o.project, worktrees: o.wts.size, ...sum(o.xs) })).sort((a, b) => b.ram_kb - a.ram_kb);
  const hostSum = host && sum(host);
  const thisRows = rows.filter((r) => r.project === label);
  const thisSum = label ? sum(thisRows) : null;
  const rest = (thisSum?.ram_kb ?? 0) + otherList.reduce((a, o) => a + o.ram_kb, 0) + (hostSum?.ram_kb ?? 0);
  const kernel = usedKb != null && usedKb - rest >= 0 ? usedKb - rest : null; // an RSS overcount can push this below 0: hidden then
  const breakdown = {
    used_kb: usedKb,
    this: thisSum && { project: label, ...thisSum, worktrees: new Set(thisRows.map((r) => r.wt)).size },
    others: otherList.slice(0, 3), others_more: Math.max(0, otherList.length - 3),
    host: hostSum && { ...hostSum, groups: host!.map((g) => ({ label: g.label, procs: g.procs, ram_kb: ram(g), rss_kb: g.rss_kb, cpu_pct: g.cpu_pct })).sort((a, b) => b.ram_kb - a.ram_kb).slice(0, 5) },
    kernel_kb: kernel,
  };
  // Outside block: one other project's worktree or one host group at or past a threshold.
  const ramT = dsLimit(db, label, "machine_outside_ram_pct"), cpuT = dsLimit(db, label, "machine_outside_cpu_pct");
  const outside: { label: string; ram_kb: number; rss_kb: number; cpu_pct: number | null; ram_pct: number | null; ram_hit: boolean; cpu_hit: boolean }[] = [];
  const consider = (lbl: string, x: { rss_kb: number; mem_kb: number | null; cpu_pct: number | null }) => {
    const ram_kb = ram(x), ram_pct = totalKb ? ram_kb / totalKb * 100 : null;
    const ram_hit = ramT != null && ram_pct != null && ram_pct >= ramT, cpu_hit = cpuT != null && x.cpu_pct != null && x.cpu_pct >= cpuT;
    if (ram_hit || cpu_hit) outside.push({ label: lbl, ram_kb, rss_kb: x.rss_kb, cpu_pct: x.cpu_pct, ram_pct: ram_pct == null ? null : Math.round(ram_pct * 10) / 10, ram_hit, cpu_hit });
  };
  // Other projects' worktrees are named as in the all-projects view: `<project> · <squad> / <role>`, the studio, or
  // `<project> · left over · <worktree>`; never a raw folder.
  const memberName = (project: string, wt: string) => {
    if (studioWts(db).get(project) === wt) return "studio";
    const m = db.one("SELECT squad, role, suffix FROM members WHERE project = ? AND wt = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC", project, wt);
    return m ? `${m.squad} / ${m.role}${m.suffix ? "-" + m.suffix : ""}` : null;
  };
  if (label) for (const r of rows) if (r.project !== label) consider(`${r.project} · ${memberName(r.project, r.wt) ?? `left over · ${wtName(r.project, r.wt)}`}`, r);
  for (const g of host ?? []) consider(g.label, g);
  outside.sort((a, b) => b.ram_kb - a.ram_kb);
  // The Resource utilization card (U7): per resource a bar split into this project (one segment per project in the
  // all-projects view), everything else in use (hover: other projects, host, kernel & cache) and free. CPU is in
  // cores, RAM in kB. Segments + other = in use, in use <= cap; a missing figure is null (page: "—", empty bar).
  const r1 = (v: number) => Math.round(v * 100) / 100;
  const loop = loopLoad(db);
  const segsOf = (cpu: boolean) => (label ? [{ project: label, v: cpu ? (total as any).cpu_cores : (total as any).ram_kb }]
    : ((total as any).projects ?? []).map((p: any) => ({ project: p.project, v: cpu ? p.cpu_cores : p.ram_kb })))
    .filter((x: { v: number | null }) => x.v != null) as { project: string; v: number }[];
  const resource = (cpu: boolean) => {
    const cap = cpu ? cores : totalKb, usedRaw = cpu ? (measured == null ? null : measured / 100) : usedKb;
    if (cap == null || usedRaw == null) return { cap: cap ?? null, used: null, segments: [], other: null, parts: [], free: null };
    const used = Math.min(usedRaw, cap);
    const segments = segsOf(cpu).map((x) => ({ project: x.project, value: cpu ? r1(x.v) : x.v }));
    const other = Math.max(0, used - segments.reduce((a, x) => a + x.value, 0));
    const parts: { label: string; value: number }[] = [];
    for (const o of label ? otherList : []) { const v = cpu ? (o.cpu_pct == null ? null : o.cpu_pct / 100) : o.ram_kb; if (v != null) parts.push({ label: o.project, value: cpu ? r1(v) : v }); }
    // The loop is a host process: it is named on its own and taken out of the host part.
    const lv = loop && (cpu ? loop.cpu_cores : loop.mem_kb);
    const hv0 = hostSum && (cpu ? (hostSum.cpu_pct == null ? null : hostSum.cpu_pct / 100) : hostSum.ram_kb);
    const hv = hv0 == null ? null : Math.max(0, hv0 - (lv ?? 0));
    if (hv != null) parts.push({ label: "host", value: cpu ? r1(hv) : hv });
    if (lv != null && hv0 != null) parts.push({ label: "the loop", value: cpu ? r1(Math.min(lv, hv0)) : Math.min(lv, hv0) });
    const rest = other - parts.reduce((a, x) => a + x.value, 0);
    if (rest > 0) parts.push({ label: cpu ? "not attributed" : "kernel & cache", value: cpu ? r1(rest) : rest });
    return { cap, used: cpu ? r1(used) : used, segments, other: cpu ? r1(other) : other, parts, free: cpu ? r1(cap - used) : cap - used };
  };
  const card = { cpu: resource(true), ram: resource(false) };
  return { ram_basis: charged ? "charged" : "rss", consumers: out.sort((a, b) => b.ram_kb - a.ram_kb), total, loop, breakdown, card, outside };
}

// Why a Flow card is paused and since when (paused-in-swimlanes U1): `pausing` / `resuming` while the
// pause is in flight, else its sources (you, a dependency wait, a taken-back plan), else the Lead's hold.
export function pausedFacts(db: { s: any }, label: string, topic: string, bm: any, pause: any, hold: boolean): { paused_at: number | null; paused_why: string | null } {
  const sources: any[] = pause && pause.state !== "active" ? pause.sources ?? [] : [];
  const at = sources.map((x) => Number(x.requested_at)).filter((n) => Number.isFinite(n) && n > 0);
  let row: any = null;
  if (bm?.role) { try { row = db.s.get("pause_members", memberKey({ project: label, squad: topic, role: bm.role, suffix: bm.suffix ?? "" })); } catch { /* no row */ } }
  const rowAt = Number(row?.requested_at);
  const paused_at = at.length ? Math.min(...at) : Number.isFinite(rowAt) && rowAt > 0 && pause && pause.state !== "active" ? rowAt : null;
  if (pause?.state === "resuming") return { paused_at, paused_why: "resuming" };
  if (pause?.state === "pausing") return { paused_at, paused_why: "pausing" };
  const man = sources.find((x) => x.source === "manual");
  if (man) return { paused_at, paused_why: "paused by you" };
  const dep = sources.find((x) => x.source === "dependency");
  if (dep) {
    if ((dep.prerequisites ?? []).some((p: any) => p.kind === "plan")) return { paused_at, paused_why: "plan taken back" };
    const rem = (dep.remaining ?? []).map((r: string) => r.replace(/^[^:]*:\s*/, ""));
    return { paused_at, paused_why: rem.length ? `waits on ${rem.join(", ")}` : "waits on another unit" };
  }
  return { paused_at, paused_why: hold ? "Lead hold" : pause && pause.state !== "active" ? "paused" : null };
}

// The squads the header and the Flow count: not done, failed, suspended, on hold or paused. A squad whose
// pause state is `resuming` still counts: pause.ts gives it that state while any one member resumes, and
// a squad that is itself paused is `pausing` or `paused`, so a resuming member must not hide its squad.
const activeSquads = (squads: any[]) => squads.filter((s) => s.status !== "done" && s.status !== "failed"
  && s.status !== "suspended" && s.status !== "on-hold" && (!s.pause || (s.pause.state !== "pausing" && s.pause.state !== "paused")));

// The header tiles' numbers (plan U3, KTD8), from the squads the board renders: the page only lays
// them out. "Active" squads are the page's (not done/failed/parked, pause active).
function headerSummary(db: Db | null, label: string, squads: any[], needs: any[], loop: any) {
  const active = activeSquads(squads);
  const units = active.flatMap((s) => arr(s.units));
  const open = units.filter((u: any) => u.state !== "done" && u.state !== "cancelled");
  const ready = open.filter((u: any) => u.state === "ready").length;
  // The Units left detail without a Flow, from the units the tile counts; a unit blocked on live work is not named.
  const left = { units_working: 0, units_ready: 0, units_parked: 0, units_stopped: 0 };
  for (const u of open as any[]) {
    if (u.parked) left.units_parked++;
    else if (STOPPED_STATES.includes(u.state)) left.units_stopped++;
    else if (u.state === "ready") left.units_ready++;
    else if (u.state !== "blocked") left.units_working++;
  }
  const prs = squads.flatMap((s) => arr(s.prs)).filter((p: any) => p.status !== "merged" && p.status !== "closed");
  const maxB = db ? dsLimit(db, label, "max_builders") : null;
  const working = active.flatMap((s) => arr(s.members)).filter((m: any) => m.role === "builder" && m.state === "working").length;
  // Light lane (adaptive-builder-capacity): working Builders whose unit is light now (a moved one counts normal).
  // Read-only: the lane comes from each unit row's `lane`, never from slot.ts's event-writing laneOf.
  const maxL = db ? Number(String(dsLimit(db, label, "max_light_builders") ?? "").trim()) : 0;
  const lightOf = Number.isFinite(maxL) && maxL > 0 ? maxL : 0;
  const lightWorking = lightOf ? active.reduce((n, s) => n + arr(s.members).filter((m: any) => m.role === "builder" && m.state === "working"
    && arr(s.units).some((u: any) => u.lane === "light" && u.builder_wt && m.wt && wtKey(u.builder_wt) === wtKey(m.wt))).length, 0) : 0;
  // The Builders tile's numbers (squad-priority U2, board-shows-host-brake U2): the seats as the loop counts them
  // (slot.ts seats(): every live Builder in any squad, whatever its pause or state, and the `ds pick` holds), not
  // the working Builders of the active squads. Normal and light share one total (max_builders + max_light_builders);
  // the light seats usable now are what the light limit allows or what is left of the total; `over` says why
  // normal is past its limit, for each live normal Builder over it. Read-only, like queue().
  const seat = (() => {
    if (!db || maxB == null) return null;
    try { return seats(db.s, label, NOW()); } catch { return null; }   // an older loop.db: the old count
  })();
  const lane = (() => {
    if (!seat || maxB == null) return {};
    const total = maxB + lightOf, normal = seat.used.normal, light = seat.used.light, taken = normal + light;
    const usable = Math.max(0, Math.min(lightOf, light + (total - taken)));
    const unitOf = (sq: string, slug: string | null) => squads.find((s) => s.topic === sq)?.units?.find((x: any) => x.slug === slug);
    const over: { squad: string; unit: string; why: string }[] = [];
    if (normal > maxB) {
      for (const h of seat.holders) {
        if (h.lane === "light") continue;
        const u = unitOf(h.squad, h.unit);
        const why = u?.urgent ? "urgent" : u?.lane === "moved" ? "moved" : "other";
        if (why !== "other") over.push({ squad: h.squad, unit: h.unit ?? "?", why });
      }
      // Every live normal Builder whose unit is urgent or moved is named; what stays over the limit after those is `other`.
      for (let i = over.length; i < normal - maxB; i++) over.push({ squad: "", unit: "", why: "other" });
    }
    const n = (w: string) => over.filter((o) => o.why === w).length;
    const by_why: Record<string, number> = { working: 0, idle: 0, pausing: 0, restarting: 0, starting: 0, hold: seat.holds };
    for (const h of seat.holders) by_why[h.why]++;
    return { builders_total: total, builders_light_usable: usable, builders_left: Math.max(0, total - taken),
      builders_over: over.length ? { urgent: n("urgent"), moved: n("moved"), other: n("other"), list: over.filter((o) => o.unit) } : null,
      builders_seats: { used: taken, total, by_why, list: seat.holders.map((h) => ({ squad: h.squad, unit: h.unit ?? h.suffix, lane: h.lane, why: h.why })) } };
  })();
  const laneNums = seat ? { builders_normal: seat.used.normal, builders_light: seat.used.light, ...(lightOf ? { builders_light_of: lightOf } : {}) }
    : lightOf ? { builders_normal: working - lightWorking, builders_light: lightWorking, builders_light_of: lightOf } : {};
  return {
    ...laneNums, ...lane,
    needs: needs.length, blocking: needs.filter((n) => n.kind === "blocking").length,
    quiet: squads.filter((s) => s.lead && s.lead.silent).length,
    builders_working: working, builders_of: maxB ?? ready, builders_of_kind: maxB != null ? "max" : "ready",
    units_left: open.length, squads_active: active.filter((s) => arr(s.units).some((u: any) => u.state !== "done" && u.state !== "cancelled")).length, ready_units: ready, ...left,
    prs_open: prs.length, ci_running: prs.filter((p: any) => p.status === "running").length,
    ci_failing: prs.filter((p: any) => p.status === "failing").length, drafts: prs.filter((p: any) => p.status === "draft").length,
    tick_age_s: loop?.age_s ?? null,
    tick_ms: loop?.tick_ms ?? null, tick_slow: loop?.tick_slow ?? false, tick_slowest: loop?.tick_slowest ?? null,
    brake: brakeOf(db, label, seat),
  };
}

// The host brake as the header shows it (board-shows-host-brake U2): one host signal, present only while the host's
// fresh sample crosses a crit line. `on` is this project's builder_host_brake and `projects` every project that has it
// on; with `on` false it is only a host note, never holding. `held` is how many queued units the loop's own seat walk
// would start now with the brake off (slot.ts seatable()), `free` the free seats; with none free the brake only waits
// for the next one (`holding` false). Read-only.
function brakeOf(db: Db | null, label: string, seat: ReturnType<typeof seats> | null) {
  if (!db) return null;
  try {
    const now = NOW(), v = brakeView(db.s, now, label);
    if (!v.hit) return null;
    const on = v.projects.some((p) => p.project === label && p.on);
    const held = on && seat ? seatable(db.s, label, now, readyLine(db.s, label, now).map((c) => ({ squad: c.topic, suffix: c.slug }))).length : 0;
    const free = seat && seat.limit != null ? Math.max(0, seat.limit + seat.light - seat.used.normal - seat.used.light) : 0;
    return { setting: v.setting, sample: v.sample, hit: v.hit, on, projects: v.projects.filter((p) => p.on).map((p) => p.project), holding: on && held > 0, held, free };
  } catch { return null; }   // an older loop.db
}

// The crew chip: the account's LABEL (id -> label from accounts.tsv; unknown id -> the id), or for a
// member with no recorded account the agent's default login (first row for the agent), `account_default`.
function acctChip(m: any, accts: any[]) {
  const agent = typeof m.agent === "string" && m.agent ? m.agent : "claude";
  const id = typeof m.account === "string" && m.account ? m.account : "";
  if (id) { const c = accts.find((a) => a.agent === agent && a.account === id); return { account_label: c?.label ?? id, account_plan: c?.plan ?? null, account_default: false }; }
  const d = accts.find((a) => a.agent === agent);
  return { account_label: d ? d.label : null, account_plan: d?.plan ?? null, account_default: !!d };
}

// --- real model + account (observed_workers.account, observed_transcripts.last_model) ---------------

// `claude-opus-5-5` -> `opus-5.5`; anything else as-is. The one place a label is derived; the page uses it.
export function modelShort(m: unknown): string | null {
  if (typeof m !== "string" || !m) return null;
  const r = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/.exec(m);
  return r ? `${r[1]}-${r[2]}.${r[3]}` : m;
}

// Does the real model match the configured one? Lowercase, a trailing [...] stripped; equal, or a
// family alias (no digit: opus, sonnet) against a real `claude-<alias>…`; a pinned id must be equal.
export function modelMatches(configured: string, real: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\[[^\]]*\]$/, "");
  const c = norm(configured), r = norm(real);
  return c === r || (!/\d/.test(c) && r.startsWith("claude-" + c));
}

// Per worktree, once per render: the live worker's real account, the newest transcript's model
// (`<synthetic>` and friends are not models), and its live sub-agents (U90: a `claude -p` review
// beside the member's own agent). The model counts only while the real account is known: a role
// now on Muse keeps a stale Claude transcript. Transcript models are Claude's, so crewFacts only
// reads one for Claude members; a muse Builder's review child is named by the sub chip instead.
// A reviewer's own transcript never reads as the member's model (U98): the newest transcript
// whose entrypoint is not `sdk-cli` wins, so a headless `claude -p` review (newer, opus) does
// not flag a Sonnet member's row.
type Real = { account: string | null; model: string | null; effort: string | null; subs: { agent: string; model: string; account: string; effort?: string }[] };
const parseSubs = (v: unknown): Real["subs"] => {
  if (typeof v !== "string" || !v) return [];
  try {
    const a = JSON.parse(v) as unknown;
    return Array.isArray(a) ? a.filter((s): s is Real["subs"][number] =>
      !!s && typeof (s as any).agent === "string" && typeof (s as any).account === "string") : [];
  } catch { return []; }
};
function realMap(db: Db): Map<string, Real> {
  return db.memo("real", () => {
    const m = new Map<string, Real>();
    const key = (p: unknown, wt: unknown) => `${p}\u0000${wt}`;
    for (const r of db.all("SELECT project, wt, account, sub_agents FROM observed_workers WHERE gone_at IS NULL ORDER BY rowid"))
      m.set(key(r.project, r.wt), { account: typeof r.account === "string" && r.account ? r.account : null, model: null, effort: null,
        subs: parseSubs(r.sub_agents) });
    const seen = new Set<string>();
    for (const r of db.all("SELECT project, wt, last_model, last_effort, entrypoint FROM observed_transcripts WHERE wt IS NOT NULL ORDER BY mtime DESC, rowid DESC")) {
      const k = key(r.project, r.wt);
      if (seen.has(k)) continue;
      if (r.entrypoint === "sdk-cli") continue; // a reviewer's `claude -p` transcript, not the member's (U98)
      seen.add(k);
      const e = m.get(k);
      if (e?.account && typeof r.last_model === "string" && r.last_model && !r.last_model.startsWith("<")) e.model = r.last_model;
      if (e?.account && typeof r.last_effort === "string" && r.last_effort) e.effort = r.last_effort; // U105
    }
    return m;
  });
}
const realOf = (db: Db, project: string, wt: unknown): Real | null => realMap(db).get(`${project}\u0000${wt}`) ?? null;

// An account id -> its card: a real id prefers (agent, id), then the single card with that id under
// any agent; a configured id matches (agent, id) only. null = no card.
function cardOf(accts: any[], agent: string, id: string, real: boolean) {
  const own = accts.find((a) => a.agent === agent && a.account === id);
  if (own || !real) return own ?? null;
  const any = accts.filter((a) => a.account === id);
  return any.length === 1 ? any[0] : null;
}

// What a member really runs on vs what it was configured with, plus the live sub-agents beside
// its own agent (U90: each a "+ sub: <model> @<account>" chip). The ⚠ compares the main agent
// only: a sub's model and account never feed model/account_mismatch.
export type SubView = { agent: string; model: string | null; model_label: string | null; effort: string | null; account: string; account_label: string; account_plan?: string | null };
function crewFacts(db: Db, project: string, m: any, accts: any[]) {
  const agent = typeof m.agent === "string" && m.agent ? m.agent : "claude";
  const real = realOf(db, project, m.wt);
  const cfgModel = typeof m.model === "string" && m.model ? m.model : null;
  const cfgAcct = typeof m.account === "string" && m.account ? m.account : null;
  // Transcript models are Claude's: a muse/codex member keeps a stale Claude transcript (a past
  // review child, a claude→agent move), which must never read as its running model (U90 review).
  const rm = agent === "claude" ? real?.model ?? null : null, ra = real?.account ?? null;
  const card = ra ? cardOf(accts, agent, ra, true) : null;
  // U105: the effort reads like the model. A Claude transcript's real value (only while the real
  // account is known, as the model) against the configured one; a non-Claude member has no real
  // value, so it shows its configured effort and no warning; neither known shows nothing.
  const cfgEffort = typeof m.effort === "string" && m.effort && m.effort !== "-" ? m.effort : null;
  const re = agent === "claude" ? real?.effort ?? null : null;
  const effortMismatch = !!(re && cfgEffort && re !== cfgEffort);
  const effortLabel = re ? (effortMismatch ? `${re} ⚠${cfgEffort}` : re) : cfgEffort;
  // A Builder's loop phase (members.phase; NULL reads `build`, as phases.ts treats it).
  const phase = String(m.role ?? "") === "builder"
    ? ((db.one("SELECT phase FROM members WHERE project = ? AND wt = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC", project, m.wt)?.phase as string | null) || "build")
    : null;
  const subs: SubView[] = (real?.subs ?? []).map((s) => ({
    agent: s.agent, model: s.model && s.model !== "-" ? s.model : null,
    model_label: s.model && s.model !== "-" ? modelShort(s.model) : null, effort: s.effort || null,
    account: s.account, account_label: cardOf(accts, s.agent, s.account, true)?.label ?? s.account,
    account_plan: cardOf(accts, s.agent, s.account, true)?.plan ?? null,
  }));
  return {
    account_cfg: cfgAcct, account_cfg_label: cfgAcct ? cardOf(accts, agent, cfgAcct, false)?.label ?? cfgAcct : null,
    account_cfg_plan: cfgAcct ? cardOf(accts, agent, cfgAcct, false)?.plan ?? null : null,
    model: cfgModel, model_real: rm, model_label: modelShort(rm ?? cfgModel),
    account_real: ra, account_real_label: ra ? card?.label ?? ra : null, account_real_plan: card?.plan ?? null,
    effort: cfgEffort, effort_real: re, effort_label: effortLabel, effort_mismatch: effortMismatch, phase,
    model_mismatch: !!(rm && cfgModel && !modelMatches(cfgModel, rm)),
    account_mismatch: !!(ra && cfgAcct && ra !== cfgAcct),
    subs,
  };
}

// The project's Studio (U261): the loop's `_studio` member, the terminal it adopted, and what that
// Studio really runs (its walk is the Studio's agent only, so a ds-loop pane beside it never reads
// as it). null when the project has no Studio worktree. The header's Studio button (chat-with-studio U1)
// reads `unread` / `reply_due` (the Crew box's counts for role studio), `working` (mid-turn) and `reply_at`
// (the newest assistant text turn's time, null when none, gone or a screen tail).
function studioOf(db: Db, label: string, accts: any[]) {
  const wt = studioWts(db).get(label);
  if (!wt) return null;
  const m = db.one("SELECT * FROM members WHERE project = ? AND squad = '_studio' AND wt = ? ORDER BY id DESC", label, wt);
  const w = db.one("SELECT * FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL", label, wt);
  const agent = String(m?.agent ?? "claude");
  const f = crewFacts(db, label, { wt, role: "studio", agent, model: m?.model ?? null, account: m?.account ?? null }, accts);
  const c = db.one("SELECT ctx FROM observed_tokens WHERE worker = ? AND ctx IS NOT NULL AND model != '<synthetic>' ORDER BY rowid LIMIT 1", wtKey(wt));
  const ctx = c?.ctx == null ? null : Number(c.ctx);
  const handle = (m?.handle as string | null) ?? null;
  const mc = msgCounts(db, label, "_studio").get("studio\0");
  let replyAt: number | null = null;
  try {
    const oc = db.one("SELECT source, turns, gone_at FROM observed_chat WHERE project = ? AND wt = ?", label, wt);
    if (oc && oc.gone_at == null && oc.source !== "screen") {
      const turns = JSON.parse(String(oc.turns ?? "[]"));
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        if (t && t.role === "assistant" && !t.tool && t.at != null) { replyAt = Number(t.at); break; }
      }
    }
  } catch { /* loop.db before migration 0044, or unreadable turns: no reply time */ }
  return { label, wt, handle, adopted: !!handle, unread: mc?.unread ?? 0, reply_due: mc?.reply_due ?? 0,
    working: w?.state === "working", reply_at: Number.isFinite(replyAt as number) ? replyAt : null, agent, walk: (w?.walk as string | null) ?? null, model_label: f.model_label,
    account: f.account_real ?? f.account_cfg, account_label: f.account_real_label ?? f.account_cfg_label, ctx, ctx_level: ctxLevel(db, ctx, label) };
}

// The live roles on each account card (a real account first, else the configured one). On a
// one-project board (`label`) users holds that project's roles only and users_other counts the
// other projects' live roles; each user carries its Crew row's state / tokens / ctx_level, joined by
// worktree from the squads already built.
function accountUsers(db: Db, accts: any[], label: string, squads: any[]) {
  const crew = new Map<string, any>();
  for (const s of squads) for (const m of s?.members ?? []) crew.set(String(m.wt), m);
  const other = new Map<any, number>(accts.map((a) => [a, 0]));
  const users = new Map<any, any[]>(accts.map((a) => [a, []]));
  for (const m of db.all("SELECT project, squad, role, suffix, wt, agent, model, effort, account FROM members WHERE COALESCE(status, '') != 'gone' AND wt IS NOT NULL ORDER BY project, squad, ord IS NULL, ord, id")) {
    const real = realOf(db, String(m.project), m.wt);
    if (!real) continue; // no live worker
    const agent = typeof m.agent === "string" && m.agent ? m.agent : "claude";
    const cfg = typeof m.account === "string" && m.account ? m.account : null;
    const card = (real.account ? cardOf(accts, agent, real.account, true) : null) ?? (cfg ? cardOf(accts, agent, cfg, false) : null);
    if (!card) continue;
    const away = label && String(m.project) !== label;
    const f = crewFacts(db, String(m.project), m, accts), c = crew.get(String(m.wt));
    const row = (extra: object) => ({ project: String(m.project), squad: String(m.squad), role: String(m.role), label: String(m.role) + (m.suffix ? "-" + m.suffix : ""),
      phase: f.phase, effort: f.effort, effort_real: f.effort_real, effort_label: f.effort_label, effort_mismatch: f.effort_mismatch,
      model_label: f.model_label, mismatch: f.model_mismatch || f.account_mismatch, model: f.model, account: cfg, sub: false,
      state: c?.state ?? "unknown", tokens: c?.tokens ?? null, ctx_level: c?.ctx_level ?? null, ...extra });
    if (away) { other.set(card, (other.get(card) ?? 0) + 1); }
    else users.get(card)!.push(row({}));
    // The same worker under each account it runs on: one row per live sub-agent, marked sub (U90).
    for (const s of f.subs) {
      const scard = s.account ? cardOf(accts, s.agent, s.account, true) : null;
      if (!scard) continue;
      if (away) { other.set(scard, (other.get(scard) ?? 0) + 1); continue; }
      users.get(scard)!.push(row({ effort: s.effort, effort_real: null, effort_label: s.effort, effort_mismatch: false, model_label: s.model_label ?? s.agent, mismatch: false, model: s.model, account: s.account, sub: true }));
    }
  }
  for (const [a, u] of users) { a.users = u; a.users_count = u.length; a.users_other = other.get(a) ?? 0; }
}

// Context now: amber at context_warn (100k), red from context_compact (150k); null = unknown.
const ctxLevel = (db: Db, c: number | null, label: string) => {
  if (c == null) return null;
  return c >= (dsLimit(db, label, "context_compact") ?? 150000) ? "red" : c >= (dsLimit(db, label, "context_warn") ?? 100000) ? "amber" : "ok";
};

// U9: the backend a squad runs on and its worktree tool (squads.backend, squads.worktree_provider, migration 0054).
function squadBackend(db: Db, label: string, topic: string): { backend: string; worktree_provider: string; provider_default: boolean } {
  let r: any = null;
  try { r = db.one("SELECT backend, worktree_provider FROM squads WHERE project = ? AND topic = ?", label, topic); } catch { /* a db before migration 0054 */ }
  const backend = String(r?.backend ?? DEFAULT_BACKEND), provider = String(r?.worktree_provider ?? (isBackend(backend) ? defaultProvider(backend) : "orca"));
  return { backend, worktree_provider: provider, provider_default: !isBackend(backend) || provider === defaultProvider(backend) };
}

// One squad. Units are listed in NATURAL ORDER (first u-number in the slug; none -> last); a
// planned unit is READY when every dep is done, else BLOCKED; a dispatched unit carries its
// Builder's live state, or "gone" when that worktree vanished. The mermaid text draws the DAG.
function squad(db: Db, label: string, topic: string, st: any, live: Live, toks: Map<string, any>, accts: any[]) {
  const status = st.status ?? "?";
  const inactive = ["suspended", "closed", "gone", "archived", "cancelled"].includes(status);
  const activity = inactive ? { state: "active", sources: [] } : projection(db.s, { project: label, squad: topic });
  const slug = repoSlug(db, label, String(st.repo ?? ""));
  // A worker the Orca observer marked gone (or never saw) is GONE — unless its rows are stale
  // (unknown), or the squad is suspended (its worktrees were removed on purpose).
  const wst = (w: unknown) => status === "suspended" ? "suspended"
    : live.ws[String(w ?? "")] || ((String(w ?? "").startsWith("local::") ? live.contractOk?.has(label) : live.backendOk) ? "gone" : "unknown");
  const wts = arr(st.worktrees).map(String);
  const activeWts = wts.filter((w) => !paused(db.s, { project: label, squad: topic, member: w }));
  const working = activeWts.filter((w) => live.ws[w] === "working").length;
  const waiting = activeWts.filter((w) => live.ws[w] === "waiting").length;
  const prs = squadPrs(db, label, st, slug);
  const gates = 0;
  const terms: Record<string, number> = {}; // live agent terminals per worktree; more than 1 = duplicates. doc.agent is the orca observer's rule (no agent identity, a ds-loop pane and a `claude -p` child are false), the set the loop's `agentsOf` keeps.
  for (const r of db.all(`SELECT wt, COUNT(*) AS n FROM observed_terminals WHERE project = ? AND gone_at IS NULL
    AND json_extract(doc, '$.squad') = ? AND json_extract(doc, '$.agent') = 1 AND wt IS NOT NULL GROUP BY wt`, label, topic)) terms[String(r.wt)] = Number(r.n);
  const bm = db.one("SELECT mtime FROM observed_markers WHERE project = ? AND path = ?", label, `${label}/squads/${topic}.beat`);
  const beat = bm?.mtime == null ? null : NOW() - Number(bm.mtime);
  // A Lead's activity is the newest of watch.sh's .beat, its worktree's last output and the
  // last Run mail the loop relayed to it (run_mail_relayed): the .beat stopped moving once Run
  // mail started being typed into the Lead's terminal, so it counts only when it is newer.
  const leadWt = arr(st.members).find((m) => m?.role === "lead")?.wt ?? null;
  const lastOut = leadWt == null ? null
    : db.one("SELECT last_output_at FROM observed_workers WHERE project = ? AND wt = ?", label, String(leadWt))?.last_output_at;
  // The last Run mail the loop got through to the Lead: relay.ts stamps forwarded_at and
  // clears the error in the same step that logs the run_mail_relayed event, and the
  // relayed_open (project, squad, forwarded_at) index covers this where the events table has
  // no project/squad/kind index.
  const lastRelay = db.one("SELECT MAX(forwarded_at) AS at FROM relayed WHERE project = ? AND squad = ? AND error IS NULL", label, topic)?.at;
  const ages = [beat, lastOut == null ? null : NOW() - Number(lastOut), lastRelay == null ? null : NOW() - Number(lastRelay)]
    .filter((n) => n != null && Number.isFinite(Number(n))).map(Number);
  const active = ages.length ? Math.min(...ages) : null;
  // A relay that keeps failing: Run mail the loop could not deliver to the Lead. relay.ts
  // keeps the failure in the relayed row (any error text: a misdelivery reads differently
  // from a NOT delivered send failure) and clears it on a successful forward, while the
  // plugin_error event is deduped to the first failure, so the row is the live signal. Such
  // a Lead needs a restart, not patience.
  const relayStuck = db.one(`SELECT 1 AS stuck FROM relayed WHERE project = ? AND squad = ? AND forwarded_at IS NULL
    AND error IS NOT NULL LIMIT 1`, label, topic)?.stuck;
  const unreachable = relayStuck != null;
  // The Lead's verdict is the loop's own (liveness.leadVerdict: unread mail on an idle Lead, or a
  // hung one); a healthy idle Lead shows nothing however long it has been idle. Same guards as
  // before: squad running, Lead not paused, loop up.
  const leadCheck = status === "running" && !paused(db.s, { project: label, squad: topic, role: "lead" }) && !live.loopDown;
  const lv = leadCheck && leadWt != null && st.run_id ? leadVerdict(db.s, label, String(leadWt), NOW()) : null;
  const limited = limitedFor(db, label);
  const health = prHealthFor(db, label);
  const u = arr(st.units);
  const members = arr(st.members);
  // U1's dep rule, mirrored (squad-state.sh ready-units `satisfied`): a dep counts when done,
  // or cancelled with its work landed elsewhere — folded into this unit, into a done unit via a
  // cancelled chain of at most 10 hops, or into a merged PR (into_merged). Cancelled with no
  // into (work dropped) never counts.
  const bySlug = new Map(u.map((x) => [x?.slug, x]));
  const satisfied = (s: string, self: string): boolean => {
    let t = s;
    for (let n = 0; n <= 10; n++) {
      const hit = bySlug.get(t);
      if (!hit) return false;
      const hs = hit.status ?? "planned";
      if (hs === "done") return true;
      if (hs !== "cancelled") return false;
      const into = hit.superseded_by ?? "";
      if (!into) return false;
      if (into === self) return true;
      if (into.startsWith("PR#")) return hit.into_merged === true;
      t = into;
    }
    return false;
  };
  const blockedNote = (d: string): string => {
    const hit = bySlug.get(d);
    return hit?.status === "cancelled" && !(hit.superseded_by ?? "") ? `${d} (work dropped)` : d;
  };
  const prmap = Object.fromEntries(prs.map((p) => [p.num, p]));
  const prref = (n: string) => prmap[n] ?? { num: n, status: null, url: slug ? `https://github.com/${slug}/pull/${n}` : null };
  const obByNum = new Map((slug ? db.all("SELECT * FROM observed_prs WHERE project = ? AND repo = ? AND pr IS NOT NULL", label, slug) : []).map((p) => [String(p.pr), p]));
  const qpr = (v: unknown) => qprOf(obByNum, slug, v);
  const ukey = (s: string) => { const m = s.match(/u([0-9]+)/); return m ? Number(m[1]) : 1000000; };
  const ready = u.some((x) => (x?.status ?? "planned") === "planned" && !(x?.hold ?? x?.held) && depList(x).every((d: string) => satisfied(d, String(x?.slug ?? ""))));
  const retest = retestDue(db.s.db, label, topic, NOW());
  const fin = finishOf(db, label, topic, st);
  const shown = activity.state !== "active" ? activity.state : displayStatus(st, status, retest, fin);
  const heldN = fin ? fin.held.length : 0;
  const displayKey = String(shown).startsWith("parked · ") ? "held-only" : shown === "wrapping up" ? "wrapping-up" : shown;
  const phase = activity.state !== "active" ? { status: shown, note: null, stuck: false } : phaseFact(db, label, topic, st, status, shown, ready);
  const nodes = u.map((x) => ({ id: nid(x?.slug ?? "?"), s: x?.slug ?? "?", st: x?.status ?? "planned", deps: depList(x) }));
  const cls = (name: string, pick: (s: string) => boolean) => {
    const ids = nodes.filter((n) => pick(n.st)).map((n) => n.id);
    return ids.length ? [`  class ${ids.join(",")} ${name}`] : [];
  };
  const env = String(st.devenv ?? "");
  const q = (x: string) => shq(x);
  const unitWaits = waitingQuestions(db.s, label, topic).map(entryOf);
  const ago = (s: number) => { const m = Math.max(0, Math.round((clockNow() - s) / 60)); return m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };
  const displayNote = retest ? `Retest due: ${retest.units.map((x) => (x.pr ? `${x.slug} #${x.pr}` : x.slug)).join(", ")} merged since the last test pass; the last one ${ago(retest.lastAt)} ago.` : null;
  const picks = builderPicks(db, label), repo = slug;
  const flowUnits: (FlowUnit & { order: number })[] = [];
  const parkRoots = new Set<string>(), notStarted = new Set<string>();
  const exposed = exposedFor(db, label, topic, st);
  const out = {
    limits: { context_warn: dsLimit(db, label, "context_warn") ?? 100000, context_compact: dsLimit(db, label, "context_compact") ?? 150000 },
    topic, label, status, display_status: phase.status, display_key: displayKey, explain: waitingNote(explainState(String(phase.status === shown ? displayKey : phase.status), !debriefOnDb(db, label)), displayKey === "held-only" ? fin?.waiting.length ?? 0 : 0), held: heldN, phase_note: phase.note ?? displayNote, phase_stuck: phase.stuck,
    pause: { ...activity, descendants_paused: !inactive && members.some((m) => ["pausing", "paused"].includes(m.pause?.state)) },
    type: st.type ?? "feature", autonomy: st.autonomy ?? "checkpoints", ship_mode: shipMode(db, label, String(st.repo ?? "")),
    task_id: st.task_id ?? null, run_id: st.run_id ?? null, framing: st.framing ?? null,
    // U9: written once at spawn. The page shows a chip only off `orca`, the tool only when not the default.
    ...squadBackend(db, label, topic),
    // The focus squad (squad-priority U2): `focus` = this squad is the one that counts now; `focus_squad` = the
    // project's focus value while it is not (a suspended focus keeps it), for the menu's "replaces <squad>".
    focus: focusSquad(db.s, label) === topic,
    focus_squad: ((v) => (v === NO_FOCUS ? null : v))(focusValue(db.s, label)),
    can_focus: (st.type ?? "feature") === "feature" && !["suspended", "on-hold", "done", "failed", "closed", "gone"].includes(String(status)),
    debrief: typeof st.debrief === "string" && st.debrief.trim() ? st.debrief : null,
    repo_slug: slug || null,
    devenv: env ? { url: env.split(" ")[0], note: env.split(" ").slice(1).join(" ") } : null,
    exposed, exposed_summary: exposedSummary(exposed),
    live: { working, waiting },
    gates, lfg_assumptions: arr(st.lfg_assumptions).length,
    still_active: status === "done" && working > 0,
    close_nudge: status === "done" && working === 0,
    lead: { active_age_s: active, silent: leadCheck && (unreachable || lv != null), unreachable: leadCheck && unreachable,
      verdict: !leadCheck ? null : unreachable ? "unreachable" : lv?.verdict ?? null,
      since_s: !leadCheck || unreachable || !lv ? null : Math.max(0, NOW() - lv.since) },
    dup_terminals: Object.values(terms).some((n) => n > 1),
    limited: limited.filter((l) => l?.topic === topic).map((l) => l.who),
    progress: progress(u),
    prs,
    questions: arr(st.waiting_on_you).map((x) => ({
      id: x.id ?? null, asker: x.asker ?? null, blocking: x.blocking === true, question: x.question ?? null,
      unit: questionUnit(x),
      // The member an answer is typed into (the card's worktree, else the Lead): the card's Chat opens its panel.
      chat_wt: (typeof x.card_wt === "string" && x.card_wt) || (typeof st.lead_wt === "string" && st.lead_wt) || leadWt || null,
      chat_label: typeof x.card_wt === "string" && x.card_wt ? String(x.asker ?? "the asker") : "the Lead",
      // titled: the asker wrote the one-line title; an older question gets its first sentence.
      title: x.title ?? shortTitle(String(x.question ?? ""), x.id ?? null), titled: !!x.title,
      suggestion: x.suggestion ?? null, why: x.why ?? null, options: arr(x.options),
      choices: arr(x.choices).length ? arr(x.choices)
        : (arr(x.options).length ? arr(x.options) : x.suggestion ? [x.suggestion] : []).map((l) => ({ label: String(l), does: null })),
      since: x.since ?? null, age_min: ageMin(x.since),
      // A terminal-picker mirror (bin/hooks/picker-hook.sh): the board answers it by keystroke when
      // picker_answerable (one single-select question); otherwise "answer it in the terminal".
      source: x.source ?? null, picker_answerable: x.picker_answerable ?? null, ...shownFields(x),
      pr: qpr(x?.pr),
      ...questionDoc(db, label, topic, x, u),
    })).sort((a, b) => (a.blocking ? 0 : 1) - (b.blocking ? 0 : 1) || (b.age_min ?? 0) - (a.age_min ?? 0)),
    override: squadOverride(db, label, topic),
    messages: msgTotals(db, label, topic),
    members: members.map((m) => ({
      role: m.role ?? null, suffix: m.suffix ?? "", label: (m.role ?? "") + (m.suffix ? "-" + m.suffix : ""), wt: m.wt ?? null,
      pause: inactive ? { state: "active", sources: [] } : m.pause ?? { state: "active", sources: [] },
      stop_checkpoint: inactive ? null : m.stop_checkpoint ?? null,
      account: typeof m.account === "string" && m.account ? m.account : null, fallback: m.fallback === true,
      ...acctChip(m, accts),
      ...crewFacts(db, label, m, accts),
      // U278: this member's unread mail (read_at NULL) and the needs-reply ones nobody answered, from the message rows.
      unread: msgCounts(db, label, topic).get(`${m.role ?? ""}\0${m.suffix ?? ""}`)?.unread ?? 0,
      reply_due: msgCounts(db, label, topic).get(`${m.role ?? ""}\0${m.suffix ?? ""}`)?.reply_due ?? 0,
      ended: msgCounts(db, label, topic).get(`${m.role ?? ""}\0${m.suffix ?? ""}`)?.ended ?? 0,
      // The board's "until done" model/account override on this member (overrides, keyed by worktree).
      override: overrides(db).get(String(m.wt)) ?? broaderFor(db, label, topic, (m.role as string | null) ?? null),
      wish: wishOf(db, label, topic, m),
      state: inactive ? wst(m.wt) : memberState(db, label, topic, m, wst(m.wt)), owns: arr(m.owns).map(String).join(", "), for: m.for ?? "",
      limited: ((l) => (l ? { line: l.line ?? null, since: l.since ?? null, switching: l.switching === true,
        wait_until: null, wait_label: null } : null))(limited.find((l) => l?.wt === m.wt)),
      terminals: terms[m.wt] ?? 0,
      at_prompt: m.role === "builder" && !inactive && promptOf(db, label, topic).byWt.has(String(m.wt)) ? { since: promptOf(db, label, topic).byWt.get(String(m.wt)) } : null,
      // The worker's 7-day cache_write (the money column), joined by mangled worktree path.
      tokens: toks.get(wtKey(m.wt)) ?? null,
      ctx_level: ctxLevel(db, toks.get(wtKey(m.wt))?.ctx ?? null, label),
    })),
    units: u.map((x) => {
      const us = x?.status ?? "planned";
      const slug = x?.slug ?? "?";
      const deps = depList(x);
      const extDeps = extDepList(db, label, x);
      const extOpen = extDeps.some((d) => d.status !== "done" && d.status !== "closed-done");
      const bm = builderOf(x, members), bf = bm ? crewFacts(db, label, bm, accts) : null;
      const tier = tierLabel(x, bm, bf).replace(/^ /, "");
      const pr = (x?.pr ?? "") === "" ? null : prref(prNumber(x.pr));
      const h = health[`${topic}/${x?.slug}`] ?? null;
      const reasons = typeof h?.reasons === "string" && h.reasons ? h.reasons : null;
      const active = us === "planned" || us === "dispatched";
      const waiting = active ? blockingForUnit(unitWaits, slug) : null;
      // A planned held unit is not running anything: it reads `held` (an approved plan or the Lead holds
      // it back). Only a dispatched one is a paused Builder, so only that reads "Lead hold".
      const heldPlanned = us === "planned" && !!x.hold && !waiting;
      const waitTitle = waiting ? String(waiting.title || waiting.question || waiting.id)
        : us === "dispatched" && x.hold ? "Lead hold"
        : us === "dispatched" && !pr && failedReport(db, label, topic, slug, x?.builder_wt) ? "Lead · ended with no PR" : null;
      const depReady = deps.every((d) => satisfied(d, slug)) && !extOpen;
      // A dep-ready planned unit whose plan the operator has not approved reads `ready, plan not
      // approved` (the loop's ready_unapproved event is the alert) instead of plain planned.
      const planBlocked = us === "planned" && depReady && !approvedPlans(db.s.root, st.approved_plans, x?.plan ?? null);
      const state = us === "done" ? "done"
        : us === "cancelled" ? "cancelled"
        : !inactive && bm?.pause && bm.pause.state !== "active" ? bm.pause.state
        : waitTitle ? "waiting"
        : heldPlanned ? "held"
        : us === "planned" ? (depReady ? "ready" : "blocked")
        : us === "dispatched" ? unitPhase(wst(x.builder_wt), pr?.status, pr != null, h, !!x?.builder_wt)
        : us;
      if (us === "planned" && !STOPPED_STATES.includes(state)) {
        notStarted.add(String(slug));
        if (x.hold || !approvedPlans(db.s.root, st.approved_plans, x?.plan ?? null)) parkRoots.add(String(slug));
      }
      if (us !== "done" && us !== "cancelled") {
        // The Flow's view of this open unit (bin/board/flow.ts): what it needs beyond the rows above.
        const ask = waiting ?? (pr ? unitWaits.find((e) => e.pr != null && e.pr !== false && String(e.pr) !== "" && prNumber(e.pr) === pr.num) ?? null : null);
        const askAt = ask ? Date.parse(String(ask.since ?? "")) : NaN;
        const b = wst(x?.builder_wt);
        flowUnits.push({
          project: label, squad: topic, slug, stopped: STOPPED_STATES.includes(state), tier: tier || null, tier_key: x?.tier ? String(x.tier) : null, status: us, order: ukey(slug),
          active_at: activeAt(db, label, topic, slug, x?.builder_wt, b === "working", reasons, pr?.status, pr ? null : promptOf(db, label, topic).bySlug.get(slug) ?? null),
          hold: !!x?.hold, hold_reason: x?.hold_reason ?? null, plan_blocked: planBlocked,
          // `resuming` is a member waiting for a seat, not a pause (it queues like any unit)
          resuming: !inactive && bm?.pause?.state === "resuming",
          paused: (!inactive && !!bm?.pause && bm.pause.state !== "active" && bm.pause.state !== "resuming") || (us === "dispatched" && !!x?.hold),
          ...pausedFacts(db, label, topic, bm, !inactive ? bm?.pause : null, us === "dispatched" && !!x?.hold),
          blocked_by: [...deps.filter((d) => !satisfied(d, slug)).map(blockedNote), ...extDeps.filter((d) => d.status !== "done" && d.status !== "closed-done").map((d) => d.ref)],
          deps, pick: picks.get(`${topic}/${slug}`) ?? null,
          question: ask ? { id: ask.id == null ? null : String(ask.id), since: Number.isFinite(askAt) ? Math.floor(askAt / 1000) : null } : null,
          pr: pr ? { ref: repo ? `${repo}#${pr.num}` : null, num: pr.num, url: pr.url, status: pr.status ?? null,
            updated_at: (obByNum.get(pr.num)?.updated_at as number | null | undefined) ?? null } : null,
          place: us === "planned" || us === "dispatched" ? placeIn(db.s, label, topic, slug) : null,
          urgent: x?.urgent === true, focus: us === "cancelled" ? null : focusMark(db.s, label, topic, slug), ...unlockFacts(db.s, label, topic, slug, us),
          ...unitLane(db, label, x, unitCpuFor(db, label).get(`${topic}/${slug}`)),
          verdict: h?.verdict ?? null, reasons,
          stale: (h?.verdict === "blocked" && (h.poked != null || !x?.builder_wt)) || (us === "dispatched" && (b === "gone" || b === "unknown")),
        });
      }
      return {
        slug, status: us, urgent: x?.urgent === true && us !== "done" && us !== "cancelled", focus: us === "cancelled" ? null : focusMark(db.s, label, topic, slug), ...unlockFacts(db.s, label, topic, slug, us), deps, ext_deps: extDeps, builder_wt: x?.builder_wt ?? null, tier: tier || null, builder: bf,
        waiting_on: waiting ? { id: waiting.id, title: waitTitle } : null,
        wait_until: null, wait_label: waitTitle ? `waiting · ${waitTitle}` : heldPlanned ? (x.hold_reason ? `held · ${x.hold_reason}` : "held") : planBlocked ? "ready, plan not approved" : null,
        reasons,
        state,
        blocked_by: us === "planned" ? deps.filter((d) => !satisfied(d, slug)).map(blockedNote) : [],
        superseded_by: x?.superseded_by ?? null, into_merged: x?.into_merged ?? null, cancel_reason: x?.cancel_reason ?? null,
        // U5: what the ⋯ menu needs. `held` is the unit's own hold (Release shows for it only); `dependents` are
        // the open units that depend on it, directly or through others (the Cancel confirm lists them).
        held: !!x?.hold && us !== "done" && us !== "cancelled",
        dependents: openDependents(u, slug),
        parked: null as "held" | "behind" | null,
        // U6: what the details overlay shows. The text comes from the plan's unit block (register-plan) or add-unit --about.
        title: x?.title ?? null, about: x?.about ?? null, done_text: x?.done ?? null, check_text: x?.check ?? null,
        links: unitLinks(x?.links),
        plan: x?.plan ? String(x.plan) : null, plan_unit: x?.plan_unit ?? null,
        // When the loop marked the unit done on its PR's merge (units.done_at); the window's `merged <age>`.
        done_at: us === "done" ? ((db.s.get("units", { project: label, squad: topic, slug }) as any)?.done_at ?? null) : null,
        hold_reason: x?.hold_reason ?? null,
        hold_kind: !x?.hold || us === "done" || us === "cancelled" ? null : x?.hold_reason ? "frozen with a reason (an operator or Lead freeze)" : x?.hold_by === "plan" || (!x?.hold_by && x?.plan_unit) ? "plan HELD line" : "parked follow-up",
        busy: wst(x.builder_wt) === "working" && (!bm?.pause || bm.pause.state === "active"),
        // Keyed on builder_wt, so a closed Builder (no crew row) still counts.
        tokens: x?.builder_wt ? toks.get(wtKey(x.builder_wt)) ?? null : null,
        review_tokens: x?.builder_wt ? toks.get(`${wtKey(x.builder_wt)}:review`) ?? null : null,
        cpu: unitCpuFor(db, label).get(`${topic}/${slug}`) ?? null,
        ...unitLane(db, label, x, unitCpuFor(db, label).get(`${topic}/${slug}`)),
        pr,
        key: ukey(String(x?.slug ?? "")),
      };
    }).sort((a, b) => a.key - b.key).map(({ key, ...x }) => x),
    role_tokens: roleTokens(members, u, toks),
    spent_since: squadSpentFor(db, label).get(topic) ?? null,
    unit_tokens: unitTokens(u, toks),
    mermaid: u.length < 2 ? null : [
      "flowchart LR",
      ...nodes.flatMap((n) => [`  ${n.id}["${n.s}"]`, ...n.deps.map((d) => `  ${nid(d)} --> ${n.id}`)]),
      "  classDef mdone fill:#14321f,stroke:#57d38c,color:#9fe6bd;",
      "  classDef mrun fill:#13233a,stroke:#7ab7ff,color:#cfe6ff;",
      "  classDef mplan fill:#1b1e24,stroke:#5a5f6a,color:#8a94a6;",
      "  classDef mcancel fill:#23262c,stroke:#5a5f6a,stroke-dasharray:5 3,color:#8a94a6,text-decoration:line-through;",
      ...cls("mdone", (s) => s === "done"), ...cls("mrun", (s) => s === "dispatched"),
      ...cls("mcancel", (s) => s === "cancelled"),
      ...cls("mplan", (s) => s !== "done" && s !== "dispatched" && s !== "cancelled"),
    ].join("\n"),
    plans: plans(db, label, `${label}/squads/${topic}`, st, topic),
    try_it: tryIt(db, label, `${label}/squads/${topic}`),
    lavish: lavish(db, st, label, topic),
    proposals: arr(st.proposed_squads).filter((p) => p?.status !== "spawned").map((p) => ({
      id: p.id ?? null, topic: p.topic ?? null,
      command: `~/.dev-studio/bin/commands/approve-fix.sh ${q(label)} ${q(topic)} ${shq(p.id ?? null)}`,
    })),
    // Kept worktrees (close-role couldn't remove one without losing work): path, branch, dirty
    // files, why it was kept, what it waits on. The sweep removes them when provably safe.
    leftovers: leftoverRows(db, label, st.leftovers, st.units),
  };
  // progress-legend-colors U1: computed once here; the page's bar and tile and the Flow cards all read it.
  const parked = parkedUnits(u, parkRoots, notStarted);
  for (const x of out.units) x.parked = parked.get(String(x.slug)) ?? null;
  for (const f of flowUnits) f.parked = parked.get(String(f.slug)) ?? null;
  flowUnitsOf.set(out, flowUnits.sort((a, b) => a.order - b.order).map(({ order, ...f }) => f));
  return out;
}

// Kept worktrees of a squad's state (live or archived): path, branch, dirty files, why it was kept, what it waits on.

// The open units squad() handed the Flow, per squad object (kept off the squad's JSON).
const flowUnitsOf = new WeakMap<object, FlowUnit[]>();

// Each planned Builder's picks row, by "<topic>/<slug>" (members.suffix = units.slug, KTD6).
const builderPicks = (db: Db, label: string): Map<string, FlowPick> => db.memo(`picks:${label}`, () => new Map(
  db.all(`SELECT m.squad, m.suffix, p.reason, p.wait_until, p.wait_known, p.slot, p.account FROM picks p JOIN members m ON m.id = p.member
    WHERE m.project = ? AND m.role = 'builder' AND COALESCE(m.status, '') != 'gone' ORDER BY m.id`, label)
    .map((r) => [`${r.squad}/${r.suffix}`, { reason: (r.reason as string | null) ?? null, wait_until: (r.wait_until as number | null) ?? null,
      wait_known: (r.wait_known as number | null) ?? null, slot: (r.slot as number | null) ?? null, account: (r.account as string | null) ?? null }])));

const FLOW_KINDS = ["unit_dispatched", "unit_pr", "auto_merge_armed", "unit_done"];
const FLOW_WINDOW_S = 30 * 86400;
// The Flow over the active squads' open units (the header's scope, KTD12) and every squad's stage
// events of the last 30 days (merges count closed squads too, KTD7).
// U2 (builder-idle-no-pr-card): a Builder at its prompt with only a background command left. The loop's
// liveness reconciler keeps one open `at-prompt` episode for it (started_at = the end of its turn,
// episode_key `prompt|<slug>|<wt>`); the board only reads it. A cleared or absent episode reads as none.
function promptOf(db: Db, label: string, squad: string): { byWt: Map<string, number>; bySlug: Map<string, number> } {
  return db.memo(`at_prompt:${label}/${squad}`, () => {
    const byWt = new Map<string, number>(), bySlug = new Map<string, number>();
    const has = !!db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'episodes'");
    if (!has) return { byWt, bySlug };
    for (const r of db.all("SELECT started_at, episode_key FROM episodes WHERE project = ? AND squad = ? AND kind = 'at-prompt' AND ended_at IS NULL", label, squad)) {
      const m = /^prompt\|([^|]*)\|(.*)$/.exec(String(r.episode_key ?? ""));
      const since = Number(r.started_at);
      if (!m || !Number.isFinite(since)) continue;
      bySlug.set(m[1], since); byWt.set(m[2], since);
    }
    return { byWt, bySlug };
  });
}
// The marker words, shared by the web crew row and the text board.
function atPromptText(since: number): string { return `at prompt ${Math.max(0, Math.floor((NOW() - since) / 60))} min · background only · no PR`; }

// The newest sign of work of a unit's Builder (U279): now while it works, a review of the unit runs or its
// PR's checks run; else the later of the worker's last output and its newest process sample that used 5% CPU
// or more. null with no Builder or no rows. Read-only; the tables an older loop.db lacks read as no signal.
const WORK_CPU_PCT = 5;
function activeAt(db: Db, label: string, squad: string, slug: string, wt: unknown, working: boolean, reasons: string | null, prStatus: unknown, promptSince: number | null = null): number | null {
  const has = (t: string) => db.memo("tbl_" + t, () => !!db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t));
  if (working && promptSince == null) return NOW();
  if (promptSince != null && working) return promptSince;   // at its prompt: the end of its turn, not now
  if (has("observed_reviews") && db.one("SELECT 1 AS x FROM observed_reviews WHERE project = ? AND squad = ? AND slug = ? AND state = 'reviewing'", label, squad, slug)) return NOW();
  if (reasons && reasons.split(",").includes("checks-running") && (prStatus == null || prStatus === "open")) return NOW();
  if (!wt) return null;
  const out = Number(db.one("SELECT last_output_at FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL", label, String(wt))?.last_output_at) || null;
  let cpuAt: number | null = null;
  if (has("observed_procs")) {
    const cg = db.memo("procs_cpu_cg", () => db.s.columns("observed_procs").has("cpu_cg_pct"));
    const r = db.one(`SELECT ${cg ? "COALESCE(cpu_cg_pct, cpu_pct)" : "cpu_pct"} AS cpu, observed_at FROM observed_procs WHERE project = ? AND wt = ?`, label, String(wt));
    if (r && Number(r.cpu) >= WORK_CPU_PCT) cpuAt = Number(r.observed_at) || null;
  }
  return out == null && cpuAt == null ? null : Math.max(out ?? 0, cpuAt ?? 0);
}

function flowFor(db: Db | null, labels: string[], squads: any[]) {
  const now = NOW();
  const active = activeSquads(squads);
  // Every Builder that holds a seat (slot.ts seats()), whatever the unit row says: its card is never Queued.
  const seated: { project: string; squad: string; unit: string }[] = [];
  if (db) for (const l of labels) {
    try { for (const h of seats(db.s, l, now).holders) if (h.unit) seated.push({ project: l, squad: h.squad, unit: h.unit }); } catch { /* an older loop.db: no seat list */ }
  }
  const events: FlowEvent[] = db && labels.length ? db.all(`SELECT project, squad, unit, kind, at, CASE WHEN json_valid(payload) THEN json_extract(payload, '$.pr') END AS pr
    FROM events WHERE kind IN (${FLOW_KINDS.map(() => "?").join(", ")}) AND at >= ? AND project IN (SELECT value FROM json_each(?))
      AND squad IS NOT NULL AND unit IS NOT NULL ORDER BY at, id`, ...FLOW_KINDS, now - FLOW_WINDOW_S, JSON.stringify(labels))
    .map((r) => ({ project: String(r.project), squad: String(r.squad), unit: String(r.unit), kind: String(r.kind), at: Number(r.at), pr: r.pr == null ? null : String(r.pr) })) : [];
  return flowOf({
    now, events, seated,
    units: active.flatMap((s) => flowUnitsOf.get(s) ?? []),
    squads: active.map((s) => ({ project: String(s.label), squad: String(s.topic) })),
    floor_min: Object.fromEntries(labels.map((l) => [l, db ? dsLimit(db, l, "flow_stuck_floor_min") ?? 10 : 10])),
    quiet_min: Object.fromEntries(labels.map((l) => [l, db ? Number(dsLimit(db, l, "flow_quiet_min")) || 20 : 20])),
    focus_squad: Object.fromEntries(labels.map((l) => [l, db ? focusSquad(db.s, l) : null])),
    tier_of: db && labels.length ? Object.fromEntries(db.all("SELECT project, squad, slug, tier FROM units WHERE tier IS NOT NULL AND project IN (SELECT value FROM json_each(?))", JSON.stringify(labels))
      .map((r) => [`${r.project}/${r.squad}/${r.slug}`, String(r.tier)])) : {},
    repo_slug: Object.fromEntries(active.filter((s) => s.repo_slug).map((s) => [String(s.label), String(s.repo_slug)])),
    reviews: reviewsFor(db, labels),
  });
}

// observed_reviews (U4), only when the table exists: an un-migrated loop.db lacks it, and then Building is
// one group, coding.
function reviewsFor(db: Db | null, labels: string[]): FlowReview[] {
  if (!db || !labels.length || !db.memo("tbl_observed_reviews", () => !!db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'observed_reviews'"))) return [];
  return db.all("SELECT project, squad, slug, state, since, kind, round, findings FROM observed_reviews WHERE project IN (SELECT value FROM json_each(?))", JSON.stringify(labels))
    .map((r) => ({ project: String(r.project), squad: String(r.squad), slug: String(r.slug), state: r.state as FlowReview["state"],
      since: (r.since as number | null) ?? null, kind: (r.kind as string | null) ?? null, round: (r.round as number | null) ?? null,
      findings: (r.findings as number | null) ?? null }));
}

// A placeholder for a squad whose row can't be rendered, so the board names it (and the operator can
// fix it) instead of failing as a whole.
function broken(label: string, topic: string) {
  console.error(`board: can't render squad ${label}/${topic} — check it with: bin/ds squads --project ${label}`);
  return {
    topic, label, status: "broken", display_status: "broken", display_key: "broken", held: 0, error: true,
    type: "?", autonomy: "?", ship_mode: "?", framing: `squad ${label}/${topic} could not be read from loop.db`,
    live: { working: 0, waiting: 0 }, gates: 0, lfg_assumptions: 0, lead: { active_age_s: null, silent: false, unreachable: false, verdict: null, since_s: null },
    progress: { done: 0, dispatched: 0, planned: 0, cancelled: 0, total: 0 }, prs: [], questions: [], members: [], units: [],
    limited: [], leftovers: [],
    mermaid: null, plans: [], lavish: [], proposals: [], spent_since: null,
  };
}

// --- the whole board ----------------------------------------------------------------------------

// The board with no loop.db to read: empty, behind the loop-down banner.
function noDb(label: string, why: string) {
  console.error(`board: no loop.db to read (${why}) — start the loop: bin/loop/loop.sh --ensure`);
  return board(null, label, [], [], [], { ws: {}, backendOk: false, loopDown: true });
}

// The checkout's own state/ is the live root; a test's temp DS_STATE_ROOT is not (U253), and `liveRoot`
// lets a test say which it is. On the live root a project the loop treats as a test project is not listed.
export function isLiveRoot(root: string): boolean { return resolve(root) === resolve(join(ROOT, "state")); }
export function buildBoard(project = "", topic = "", root = stateRoot(), liveRoot = isLiveRoot(root)) {
  const label = project ? dsLabel(project) : "";
  let s: Store;
  try { s = openReadOnly(root); } catch (e) { return noDb(label, String(e)); }
  focusMemo.clear();
  try { return fromDb(new Db(s), label, topic, liveRoot); } finally { s.close(); focusMemo.clear(); }
}

function fromDb(db: Db, label: string, topic: string, liveRoot = false) {
  // The Orca observer's rows are current when its newest is younger than the loop's stale window.
  const loop = loopStatus(db, label);
  const live: Live = { ws: {}, backendOk: false, loopDown: loop.down };
  // U58: Orca's own rows only; a contract observer's rows say nothing about Orca, and are current per project.
  const orcaAt = Number(db.one(`SELECT MAX(observed_at) AS at FROM observed_workers WHERE NOT ${CONTRACT_ROW}`)?.at ?? 0);
  live.backendOk = orcaAt > 0 && NOW() - orcaAt <= loop.stale_after_s;
  live.contractOk = new Set(db.all(`SELECT project, MAX(observed_at) AS at FROM observed_workers WHERE ${CONTRACT_ROW} GROUP BY project`)
    .filter((r) => NOW() - Number(r.at ?? 0) <= loop.stale_after_s).map((r) => String(r.project)));
  for (const r of db.all(`SELECT wt, state, gone_at FROM observed_workers ${label ? "WHERE project = ?" : ""} ORDER BY rowid`, ...(label ? [label] : []))) {
    live.ws[String(r.wt)] = r.gone_at != null ? "gone" : String(r.state ?? "idle");
  }

  // Every squad that isn't closed, by project then topic; one that can't be read renders as broken.
  const rows = db.all(`SELECT project, topic FROM squads WHERE COALESCE(status, '') != 'closed' AND doc IS NOT NULL
    ${label ? "AND project = ?" : ""} ${topic ? "AND topic = ?" : ""} ORDER BY project, topic`, ...[label, topic].filter(Boolean));
  const read = rows.filter((r) => !(liveRoot && !label && isTestProject(String(r.project)))).map((r) => {
    const l = String(r.project), t = String(r.topic);
    let st: any = null;
    try { st = squadDoc(db.s, l, t); } catch { /* a doc that won't parse */ }
    const ok = st && typeof st === "object" && !Array.isArray(st) ? st : null;
    return { l, t, st: ok };
  });
  const toks = tokenSpend(db), accts = accounts(db);
  const squads = read.map(({ l, t, st }) => {
    if (!st) return broken(l, t);
    try { return squad(db, l, t, st, live, toks, accts); } catch { return broken(l, t); }
  }).sort(compareSquads);
  accountUsers(db, accts, label, squads);
  const labels = label ? [label] : db.all("SELECT label FROM projects UNION SELECT project AS label FROM squads ORDER BY label").map((r) => String(r.label)).filter((l) => !(liveRoot && !label && isTestProject(l)));
  return { ...board(db, label, labels, squads, accts, live), project_controls: !topic };
}

// The Studio's morning briefs (documents rows of <label>/briefings/<date>.md), newest first; only the
// latest carries its markdown (older ones load through GET /api/briefing).
function briefings(db: Db | null, label: string, labels: string[]) {
  if (!db) return [];
  const l = label || (labels.length === 1 ? labels[0] : "");
  if (!l) return [];
  const pre = `${l}/briefings/`;
  const rows = db.all("SELECT path, mtime FROM documents WHERE project = ? AND substr(path, 1, ?) = ? ORDER BY path DESC", l, pre.length, pre)
    .map((r) => ({ date: basename(String(r.path)).replace(/\.md$/, ""), mtime: Number(r.mtime) || 0 }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  return rows.map((r, i) => {
    if (i) return r;
    const markdown = briefingMarkdown(db, l, r.date) ?? "";
    return { ...r, markdown, prs: briefingPrs(db, l, markdown) };
  });
}
// The project's brief schedule for the board: {time, days, on, next}. time and days are the effective
// limits (env, project, default, as the Limits tab reads them); `on` is false for `off` or a bad value;
// `next` is the epoch of the next slot (<= now means due now), null when off.
export function briefingSchedule(db: Db, label: string, labels: string[]) {
  const l = label || (labels.length === 1 ? labels[0] : "");
  const time = limit(db.s, l, "briefing_time") ?? BRIEFING_DEFAULTS.briefing_time;
  const days = limit(db.s, l, "briefing_days") ?? BRIEFING_DEFAULTS.briefing_days;
  const on = parseTime(time) != null && !!parseDays(days);
  if (!on || !l) return { time, days, on: on && !!l, next: null as number | null };
  const now = NOW();
  const hit = db.one("SELECT done_at, result FROM requests WHERE key = ?", `briefing:${l}:${localDate(now)}`);
  const sentToday = !!hit && !briefingGaveUp(hit);
  return { time, days, on, next: nextSlot(now, time, days, sentToday, scheduleSince(db.s, l, time, days) ?? -Infinity) };
}
// {"<n>": url} for the `#<n>` numbers a brief names, from the loop's own PR record (observed_prs).
// A number with no record, or one that two of the project's repos share, is left out (plain text).
export function briefingPrs(db: Db, label: string, markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of new Set([...markdown.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])))) {
    const urls = new Set(db.all("SELECT url FROM observed_prs WHERE project = ? AND pr = ? AND url IS NOT NULL AND url != ''", label, n).map((r) => String(r.url)));
    if (urls.size === 1) out[String(n)] = [...urls][0];
  }
  return out;
}
export function briefingMarkdown(db: Db, label: string, date: string): string | null {
  const row = db.one("SELECT body FROM documents WHERE project = ? AND path = ?", label, `${label}/briefings/${date}.md`);
  return row ? String(row.body ?? "") : null;
}
// GET /api/briefing: one brief's {markdown, prs}, or null when there is none.
export function briefingJson(project: string, date: string, root = stateRoot()) {
  return withDb((db) => {
    const markdown = briefingMarkdown(db, project, date);
    return markdown === null ? null : { markdown, prs: briefingPrs(db, project, markdown) };
  }, root);
}

function board(db: Db | null, label: string, labels: string[], squads: any[], accts: any[], live: Live) {
  const loop = loopStatus(db, label);
  // Closed squads (documents rows of archive/*.json) with progress, PRs and plans.
  const archived = db ? labels.flatMap((l) => archivedDocs(db, l).filter((a) => a.st && typeof a.st === "object").map((a) => {
    const st = a.st, t = String(st.topic ?? "?");
    return {
      label: l, spent_since: squadSpentFor(db, l).get(t) ?? null,
      topic: st.topic ?? "?", closed_at: st.closed_at ?? null, type: st.type ?? "feature",
      framing: String(st.framing ?? "").slice(0, 160), progress: progress(arr(st.units)),
      debrief: typeof st.debrief === "string" && st.debrief.trim() ? st.debrief : null,
      prs: squadPrs(db, l, st, repoSlug(db, l, String(st.repo ?? ""))), plans: plans(db, l, `${l}/archive/${t}`),
      try_it: tryIt(db, l, `${l}/archive/${t}`),
      lavish: lavish(db, null, l, t),
      leftovers: leftoverRows(db, l, st.leftovers, st.units),
    };
  })) : [];

  // Requests waiting for the Studio (the sweep's restart requests and the board's own), oldest
  // first: requests rows filed under requests/_studio/, gone once the Studio has done them, and the
  // board's `studio` rows the loop hasn't written out as such a file yet.
  // board-actions-as-wishes U6: the loop's own board Starts too, "starting a squad: <the brief's first words>",
  // open ones and ones failed in the last hour (with the error), so a refused start is seen.
  const requests = db ? labels.flatMap((l) => db.all(`SELECT id, key, kind, payload, result, created_at, done_at FROM requests WHERE project = ?
    AND ((done_at IS NULL AND (substr(key, 1, ?) = ? OR kind IN ('studio', 'squad-start')))
      OR (kind = 'squad-start' AND done_at > ? AND json_extract(result, '$.ok') = 0)) ORDER BY id`,
    l, `file:${l}/_studio/`.length, `file:${l}/_studio/`, NOW() - 3600).map((r) => {
    const p = parse(r.payload) ?? {};
    const age_min = Math.max(0, Math.floor((NOW() - (Number(r.created_at) || NOW())) / 60));
    if (r.kind === "squad-start") {
      const words = String(p.framing ?? "").replace(/\s+/g, " ").trim(), brief = words.length > 60 ? `${words.slice(0, 60)}…` : words;
      const err = r.done_at != null ? String((parse(r.result) ?? {}).error ?? "failed") : null;
      return { label: l, file: `squad-start-${r.id}`, text: `starting a squad: ${brief}${err ? ` — failed: ${err}` : ""}`, ...(err ? { error: err } : {}), age_min };
    }
    const text = r.kind === "studio" ? String(p.line ?? "") : String(p.text ?? "").split("\n")[0];
    return { label: l, file: r.kind === "studio" ? "(queued)" : basename(String(p.file ?? r.key)), text, age_min };
  })).sort((a, b) => b.age_min - a.age_min) : [];

  const active = squads.filter((s) => questionsCount(s.status));
  const kind = { blocking: 0, approval: 1, question: 2 } as Record<string, number>;
  // The Studio's own alerts (observed_alerts, from state/<label>/alerts.json): the project's, not any squad's.
  // U2: a card's repo (its squad's, else the project's first resolved one), its PR (from `ref`) and its one action.
  const slugOf = (l: string, topic: string | null) => squads.find((s) => s.label === l && s.topic === topic)?.repo_slug
    ?? squads.find((s) => s.label === l && s.repo_slug)?.repo_slug ?? null;
  // U287: the GitHub budget (the PR observer's schedule row) and the open merge-ready PRs it keeps waiting.
  const ghView = db ? githubView(db.one("SELECT * FROM observed_github WHERE repo = ''"), NOW()) : null;
  const waitingPrs = db && ghView?.level === "out" ? labels.flatMap((l) => db.all(
    "SELECT pr FROM observed_prs WHERE project = ? AND verdict = 'ready' AND state = 'OPEN' AND gone_at IS NULL ORDER BY pr", l)
    .map((r) => ({ project: l, num: String(r.pr) }))) : [];
  const githubCards: any[] = labels.flatMap((l) => {
    const c = budgetCard(l, ghView, waitingPrs);
    return c ? [{ repo_slug: null, pr: null, act: null, project: l, id: c.id, from: null, text: c.text, title: c.title, card: c.kind, reason: null,
      squad: null, unit: null, suggestion: null, why: null, options: [], choices: [], when: null, acts_on_answer: false, age_min: null, place: "needs" }] : [];
  });
  const allAlerts = (db ? labels.flatMap((l) => db.all("SELECT doc FROM observed_alerts WHERE project = ? ORDER BY rowid", l).map((r) => {
    const x = parse(r.doc) ?? {};
    const text = String(x.question ?? x.text ?? "");
    // A debrief card's repo is its archived squad's (resolved like a live squad's), before the project's.
    const dTopic = debriefTopic(x);
    const dRepo = dTopic ? archivedDocs(db, l).filter((a) => a.st && typeof a.st === "object" && String(a.st.topic ?? "") === dTopic && a.st.repo).sort((p, q) => String(q.st.closed_at ?? "").localeCompare(String(p.st.closed_at ?? "")))[0]?.st.repo : null;
    const aslug = (dRepo && repoSlug(db, l, String(dRepo))) || slugOf(l, typeof x.squad === "string" ? x.squad : null);
    const acts = alertActs(x);
    return {
      debrief: dTopic, repo_slug: aslug, pr: cardPr(db, l, x.ref, aslug), act: cardAct(x.act),
      project: l, id: x.id ?? null, from: typeof x.asker === "string" && x.asker !== "sweep" ? x.asker : null, text, title: x.title ?? shortTitle(text, x.id ?? null),
      card: typeof x.kind === "string" ? x.kind : typeof x.card === "string" ? x.card : null, reason: typeof x.reason === "string" ? x.reason : null,
      squad: typeof x.squad === "string" ? x.squad : null, unit: typeof x.unit === "string" ? x.unit : null,
      // A notice's one option is an acknowledgement, so it is no answer: `choices` are the options only when
      // the answer acts (2+ options, or the card's `acts_on_answer` marker); a lone option is shown as `when`.
      ...alertAnswers(x),
      suggestion: acts ? (x.suggestion ?? null) : null, why: x.why ?? null, options: arr(x.options),
      age_min: ageMin(x.since),
      place: placeAlert({ ...x, text }, NOW(), db ? dsLimit(db, l, "needs_grace_min") : null, db ? dsLimit(db, l, "refusal_needs_min") : null),
    };
  })) : []).concat(githubCards).filter((a) => a.id).sort((a, b) => (b.age_min ?? 0) - (a.age_min ?? 0));
  // U1: only the asks are Needs-you. The rest are loop notes (newest first), also on their squad's row;
  // a card still in its grace period is held back until it has lasted.
  const studioAlerts = allAlerts.filter((a) => a.place === "needs");
  // U287: one card per PR: a Lead's copy of a merge card goes when the Studio's card names the same PR.
  const studioMergePrs = new Set(studioAlerts.filter((a) => a.card === "merge_card" && a.pr).map((a) => `${a.project}:${a.pr!.num}`));
  for (const s of squads) s.questions = dropLeadMergeCopies(s.questions, (q: any) => q.pr?.num != null && studioMergePrs.has(`${s.label}:${q.pr.num}`));
  // squad-done-definition U4: a squad the Lead marked `done` waits only for the operator. Read-only: no alert is
  // written, so the row is gone once the squad is closed, archiving, or set back to running.
  const doneRows = squads.filter((s) => doneWaits(s.status, s.display_status, !!s.error)).map((s) => {
    const dTail = db && !debriefOnDb(db, s.label) ? "" : " (the Lead writes the debrief then)";
    return {
    squad: s.topic, label: s.label, kind: "done", id: null, from: "lead", card_squad: s.topic, repo_slug: s.repo_slug ?? null, pr: null,
    act: { action: "close", topic: s.topic, label: "Close squad" }, open: true,
    title: `${s.topic} is done — try it out, then Close squad${dTail}`, titled: true,
    text: `${s.topic} is done — try it out, then Close squad${dTail}`, choices: [], suggestion: null, why: null, options: [], age_min: null, command: null,
  }; });
  const loopNotes = allAlerts.filter((a) => a.place === "note").sort((a, b) => (a.age_min ?? 0) - (b.age_min ?? 0))
;
  for (const s of squads) s.notes = loopNotes.filter((n) => n.project === s.label && n.squad === s.topic);
  // `stall`: 3+ running Leads' activity went stale within ~2 minutes of each other — that's
  // the watcher/session host stopping, not N separate squads.
  const stale = squads.filter((s) => s.lead.verdict === "not responding" && s.lead.since_s != null).map((s) => s.lead.since_s as number);
  // Project total spent since the first squad started (archived squads included).
  const spentRows = db ? labels.flatMap((l) => [...squadSpentFor(db, l).values()]) : [];
  const spentTotal = spentRows.length
    ? { spent: spentRows.reduce((a, r) => a + r.spent, 0), since: Math.min(...spentRows.map((r) => r.since).filter(Boolean)) || null } : null;
  // First squad repo that resolves to a GitHub slug links the project's name to GitHub.
  // No squad yet: the project's own repo (the `projects` row's owner/name, else the GitHub observer's slug for its home_repo).
  const projSlug = squads.map((s) => s.repo_slug).find(Boolean) ?? (label && db ? homeSlug(db, label) : null);
  const pref = label ? `${dsPrefix()}${label}-` : "";
  const scope = label ? "AND project = ?" : "";
  const sargs = label ? [label] : [];
  const terminals = db ? Number(db.one(`SELECT COUNT(*) AS n FROM observed_terminals WHERE gone_at IS NULL ${scope}`, ...sargs)?.n ?? 0) : 0;
  const at = (table: string) => (db ? asOf(db, table, label) : null);
  // A current observer, Orca's or a contract's (U58): the host-wide worktree and terminal counts are read.
  const seen = live.backendOk || (live.contractOk?.size ?? 0) > 0;
  const out = {
    generated_at: new Date(NOW() * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
    backend_ok: live.backendOk,
    // U58: the "Orca isn't answering" warning, only while a project shown has its Studio or an open squad on Orca.
    orca_warning: !live.backendOk && (!db || labels.some((project) => studioBackend(db.s.get("projects", { label: project })) === "orca"
      || !!db.one("SELECT 1 FROM squads WHERE project = ? AND COALESCE(backend, 'orca') = 'orca' AND COALESCE(status, '') NOT IN ('closed', 'gone') LIMIT 1", project))),
    project: label || null,
    projects: db ? labels.map((project) => ({ label: project, pause: { ...projection(db.s, { project }),
      descendants_paused: !!db.one("SELECT 1 FROM pause_intents WHERE project = ? AND cleared_at IS NULL LIMIT 1", project) },
      // U9, U57: the backend the Start squad dialog shows: the Studio's, which new squads start on.
      studio_backend: studioBackend(db.s.get("projects", { label: project })) })) : [],
    prerequisites: db ? labels.flatMap((project) => [
      ...db.all("SELECT squad, slug, status, hold FROM units WHERE project = ? ORDER BY squad, id", project).map((u) => ({ kind: "unit", project, squad: u.squad, slug: u.slug,
        label: `${project}/${u.squad}/${u.slug}`, state: u.status, hold: !!u.hold, url: `#sq-${project}/${u.squad}` })),
      ...db.all("SELECT ref, repo, pr, state FROM observed_prs WHERE project = ? ORDER BY ref", project).map((p) => ({ kind: "pr", project, ref: p.ref,
        label: String(p.ref), state: p.state, url: p.repo && p.pr ? `https://github.com/${p.repo}/pull/${p.pr}` : null })),
    ]) : [],
    project_url: label && projSlug ? "https://github.com/" + projSlug : null,
    live_worktrees: db && seen ? Number(db.one("SELECT COUNT(DISTINCT wt) AS n FROM observed_worktrees WHERE gone_at IS NULL")?.n ?? 0) : null,
    capacity: db && seen ? { label: "terminals", count: terminals } : null,
    gh: { ok: !!db && (at("observed_prs") ?? 0) > 0, cmd: "loop" },
    github: ghView ? { ...ghView, waiting: waitingPrs.map((p) => ({ project: p.project, num: p.num })) } : null,
    accounts: accts,
    spent_total: spentTotal,
    needs_count: active.reduce((n, s) => n + s.questions.length, 0) + studioAlerts.length + doneRows.length,
    studio_alerts: studioAlerts,
    studio: db ? labels.flatMap((l) => studioOf(db, l, accts) ?? []) : [],
    loop_notes: loopNotes,
    // U24: every open squad / role / project override (the squad card and the Settings tab list them, each with Clear).
    overrides: db ? broaderOverrides(db) : [],
    // The inbox: every question and proposed fix from squads that aren't on hold: blocking first,
    // then approvals, then questions, oldest first; each carries the command to copy.
    needs_you: [...studioAlerts.map((a) => ({
      squad: "_studio", label: a.project, kind: "studio", card_squad: a.squad, repo_slug: a.repo_slug, pr: a.pr, act: a.act, card: a.card, reason: a.reason, debrief: a.debrief ?? null, about: a.squad ? [a.squad, a.unit].filter(Boolean).join(" ") : null, id: a.id, from: a.from, text: a.text, title: a.title, titled: true,
      choices: a.choices, when: a.when, acts_on_answer: a.acts_on_answer, suggestion: a.suggestion, why: a.why, options: a.options, age_min: a.age_min, command: null,
    })), ...active.flatMap((s) => [
      ...s.questions.map((q: any) => ({
        squad: s.topic, label: s.label, kind: q.blocking ? "blocking" : "question", id: q.id, since: q.since ?? null, from: q.asker, chat_wt: q.chat_wt ?? null, chat_label: q.chat_label ?? null,
        text: q.question, title: q.title, titled: q.titled, choices: q.choices,
        suggestion: q.suggestion, why: q.why, options: q.options, age_min: q.age_min, command: null,
        source: q.source ?? null, picker_answerable: q.picker_answerable ?? null, ...shownFields(q),
        pr: q.pr ?? null, repo_slug: s.repo_slug ?? null,
        doc: q.doc ?? null, plain: q.plain ?? null, plain_from: q.plain_from ?? null, facts: q.facts ?? null, revision: q.revision ?? null, changes: q.changes ?? null,
      })),
      ...s.proposals.map((p: any) => ({
        squad: s.topic, label: s.label, kind: "approval", from: "thinker", text: `Proposed fix squad: ${p.topic}`,
        id: null, title: `Approve fix squad ${p.topic}?`, titled: true, choices: [],
        suggestion: null, why: null, options: [], age_min: null, command: p.command,
      })),
    ]).sort((a, b) => kind[a.kind] - kind[b.kind] || (b.age_min ?? 0) - (a.age_min ?? 0)), ...doneRows],
    // Live backstop: squad workers Orca reports waiting for input that the Lead hasn't enqueued
    // yet (the Studio itself is left out).
    live_waiting: db ? db.all(`SELECT project, wt, name FROM observed_workers WHERE state = 'waiting' AND gone_at IS NULL AND name IS NOT NULL ${scope} ORDER BY rowid`, ...sargs)
      .filter((r) => !paused(db.s, { project: String(r.project), member: String(r.wt) }))
      .map((r) => String(r.name)).filter((n) => SQUAD_ROLE.test(n) && (!pref || n.includes(pref))) : [],
    stall: !loop.down && stale.length >= 3 && Math.max(...stale) - Math.min(...stale) <= 120
      ? { count: stale.length, minutes: Math.floor(Math.min(...stale) / 60) } : null,
    // The loop's own health (the "loop down / data as of" banner), and per section when its rows
    // were last observed (epoch s; null = never).
    loop,
    as_of: { squads: at("squads"), workers: at("observed_workers"), prs: at("observed_prs"), tokens: at("observed_tokens"),
      accounts: at("observed_accounts"), spend: at("observed_spend"), documents: at("documents") },
    squads,
    requests,
    archived,
    briefings: briefings(db, label, labels),
    briefing_schedule: db ? briefingSchedule(db, label, labels) : { time: BRIEFING_DEFAULTS.briefing_time, days: BRIEFING_DEFAULTS.briefing_days, on: false, next: null },
  };
  decorateResources(db, label, squads);
  const machine = machineSummary(db, label, out.live_worktrees, db && seen ? terminals : null, squads);
  const update = updateSummary(db, label);
  const disk = diskSummary(db, label);
  const header = headerSummary(db, label, squads, out.needs_you, loop);
  return { ...out, ...(update ? { update } : {}), ...(disk.length ? { disk } : {}), feedback: feedbackSummary(db, label), accounts_summary: accountsSummary(db, label, accts), header, flow: { ...flowFor(db, labels, squads), brake: header.brake ?? null }, ...(machine ? { machine, as_of: { ...out.as_of, machine: machine.observed_at } } : {}) };
}

// The open disk-pressure spells of this project (disk-pressure U3): the episodes, the machine row's disk and the
// consumers the card names — the board adds no read of its own beyond them.
function diskSummary(db: Db | null, label: string) {
  if (!db) return [];
  try {
    const open = new Set(db.all("SELECT subject FROM episodes WHERE project = ? AND kind = 'disk-pressure' AND ended_at IS NULL", label).map((r) => String(r.subject).slice("disk-pressure.".length)));
    if (!open.size) return [];
    const list = consumers(db.s).map(consumerLine);
    return disksOf(db.s).filter((d) => open.has(d.path)).map((d) => ({ path: d.path, free_kb: d.free_kb, free_pct: Math.round(d.free_pct), title: titleOf(d), consumers: list }));
  } catch { return []; } // a loop.db the migrations have not reached yet
}

// The dev-studio update banner (board-update-button U3): the `observed_update` row alone, plus this
// project's live members and its pending `update` request. Absent when there is nothing to say.
const UPDATE_ADVANCED_S = 300; // a success needs only a short confirmation
const UPDATE_OLD_S = 3600; // a refused/failed result that names no commit (an old file)
// An update-host result worth showing: advanced for 5 minutes; refused/failed (and unknown outcomes) until the
// checkout's HEAD moves past it; "already current" is no news.
function liveResult(last: any, head: any, now: number) {
  if (!last || typeof last !== "object" || last.outcome === "already") return null;
  const age = now - Number(last.at ?? 0);
  if (last.outcome === "advanced") return age <= UPDATE_ADVANCED_S ? last : null;
  const ref = String(last.after || last.before || "");
  if (!ref) return age <= UPDATE_OLD_S ? last : null;
  return head && String(head) !== ref ? null : last;
}
// board-actions-as-wishes U2: this project's `update` request, open or finished within the hour, as the banner
// shows it. The fulfiller (bin/loop/fulfil/update.ts) keeps the job's fields in the request's `result`.
const UPDATE_RUN_S = 3600; // an open or failed request shows this long
const UPDATE_DONE_S = 300; // a request that worked leaves after this, like update-host's "advanced"
function updateRun(db: any, label: string, now: number) {
  let q: any = null;
  try { q = db.one("SELECT id, created_at, done_at, result FROM requests WHERE kind = 'update' AND project = ? AND (done_at IS NULL OR done_at > ?) ORDER BY id DESC LIMIT 1", label, now - UPDATE_RUN_S); } catch { return null; }
  if (!q) return null;
  const res = parse(q.result) ?? {};
  const open = q.done_at == null;
  const state = open ? String(res.state ?? "queued") : res.ok === false || res.state === "failed" ? "failed" : "done";
  if (state === "done" && now - Number(q.done_at) > UPDATE_DONE_S) return null;
  const since = Number(res.started_at ?? 0) || Number(q.created_at ?? 0) || now;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    id: q.id, state, why: text(res.why), line: (state === "done" ? text(res.line)?.replace(/^DS-UPDATE: /, "") : text(res.line)) ?? (state === "failed" ? text(res.error) : null),
    error: text(res.error), warnings: arr(res.warnings).filter((w: unknown) => typeof w === "string"), squads_line: text(res.squads_line),
    log: text(res.log), age_min: Math.max(0, Math.floor(((open ? now : Number(q.done_at)) - since) / 60)),
  };
}
function updateSummary(db: any, label: string) {
  if (!db || !label) return null;
  let r: any = null;
  try { r = db.one("SELECT * FROM observed_update ORDER BY observed_at DESC LIMIT 1"); } catch { return null; } // a loop.db the migration 0042 has not reached yet
  if (!r) return null;
  const now = NOW();
  const every = Number(r.every_s ?? 0);
  const checked = Number(r.checked_at ?? 0) || Number(r.observed_at ?? 0);
  const stale = every > 0 && checked > 0 && now - checked > 3 * every;
  const live = (l: string) => db.all("SELECT role, suffix FROM members WHERE project = ? AND squad != '_studio' AND COALESCE(want,'') != 'gone' AND COALESCE(status,'') != 'gone'", l);
  const workers = live(label).length;
  // Other projects with a live worker: their loops restart too. Not the leftover test projects of a live loop.db.
  const others = (db.all("SELECT DISTINCT project FROM members WHERE squad != '_studio' AND COALESCE(want,'') != 'gone' AND COALESCE(status,'') != 'gone'") as any[])
    .map((x) => String(x.project)).filter((p) => p && p !== label && !isTestProject(p)).sort();
  const mine = parse(r.squads)?.[label] ?? null;
  const squadsBehind = mine && workers > 0 && mine.need && mine.need !== "none" ? mine : null;
  // An update filed before the deploy as a Studio request still shows until it is done.
  const pending = db.one(`SELECT id, created_at FROM requests WHERE kind = 'studio' AND project = ? AND done_at IS NULL AND squad IS NULL AND json_extract(payload, '$.action') = 'update'
    UNION ALL SELECT id, created_at FROM requests WHERE project = ? AND done_at IS NULL AND key GLOB ? LIMIT 1`, label, label, `file:${label}/_studio/board-update-[0-9]*.txt`);
  const run = updateRun(db, label, now);
  const last = liveResult(parse(r.last_update), r.head, now);
  const behind = Number(r.behind ?? 0);
  const state = String(r.state ?? "ok");
  const quiet = behind === 0 && state === "ok" && !stale && !squadsBehind && !pending && !run && !last;
  if (quiet) return null;
  return {
    behind, branch: r.branch ?? null, commits: arr(parse(r.commits)), classes: arr(parse(r.classes)), need: r.need ?? "none",
    state, error: r.error ?? null, error_at: r.error_at ?? null, checked_at: r.checked_at ?? null, stale,
    ahead: Number(r.ahead ?? 0), dirty: Number(r.dirty ?? 0) > 0, last_update: last, squads_behind: squadsBehind,
    pending: pending ? { id: pending.id, age_min: Math.max(0, Math.floor((now - (Number(pending.created_at) || now)) / 60)) } : null,
    run, others, workers, project: label,
  };
}

// An untitled (older) question's one-line row. A plan question reads "Approve plan: <x>?";
// otherwise the first sentence with absolute paths cut to file names, cut at 80 characters.
export { shortTitle };

// --- the text board -----------------------------------------------------------------------------

type Board = ReturnType<typeof buildBoard>;
const RULE = "------------------------------------------------------------";

// `MACHINE  load 29.8/34.5/32.4 on 24 · mem 74% of 125G · swap 100% ✖ · disk / 52% free · psi mem 12 ⚠`
// (⚠ warn, ✖ crit; psi only when a pressure note applies).
function machineLine(m: NonNullable<Board["machine"]>): string {
  const mk = (l: string) => (l === "crit" ? " ✖" : l === "warn" ? " ⚠" : "");
  const g = (kb: number | null) => (kb == null ? "?" : kb >= 1048576 ? Math.round(kb / 1048576) + "G" : Math.round(kb / 1024) + "M");
  const f = (x: number | null) => (x == null ? "?" : x.toFixed(1));
  const parts = [`load ${f(m.load.load1)}/${f(m.load.load5)}/${f(m.load.load15)} on ${m.cores ?? "?"}${mk(m.load.level)}`,
    `mem ${m.mem.pct ?? "?"}% of ${g(m.mem.total_kb)}${mk(m.mem.level)}`,
    m.swap.total_kb ? `swap ${m.swap.pct ?? "?"}%${mk(m.swap.level)}` : "swap none"];
  if (m.disk) parts.push(`disk ${m.disk.path} ${m.disk.free_pct}% free${mk(m.disk.level)}`);
  if (m.psi.note) parts.push(`psi ${m.psi.note.kind} ${Math.round(m.psi.note.avg10 ?? 0)}${mk(m.psi.note.level)}`);
  return `MACHINE  ${parts.join(" · ")}${m.stale ? `  (as of ${clock(m.observed_at)})` : ""}`;
}

// The text board's line for an `update` request (board-actions-as-wishes U2): running, waiting, done or failed.
function runLine(r: NonNullable<NonNullable<Board["update"]>["run"]>): string {
  const warn = r.warnings.map((w) => `\n  ${w}`).join("");
  if (r.state === "done") return `UPDATE ${r.line ?? "done"}${r.squads_line ? ` — ${r.squads_line.replace(/^update-squads: \[[^\]]*\] /, "")}` : ""}${warn}`;
  if (r.state === "failed") return `UPDATE failed: ${r.line ?? r.error ?? "see the log"}${r.log ? ` — log ${r.log}` : ""}${warn}`;
  if (r.state === "waiting") return `UPDATE waiting — ${r.why ?? "another update is running"} (${r.age_min} min)${warn}`;
  const what = r.state === "refreshing" ? "refreshing squads…" : r.state === "pulling" ? "pulling…" : "starting…";
  return `UPDATE running — ${what} (${r.age_min} min)${warn}`;
}
const NEED_TEXT: Record<string, string> = { none: "no restarts", reload: "reload, no restarts", restart: "workers restart once idle" };
function updateLine(u: NonNullable<Board["update"]>): string {
  const hm = (t: number | null) => (t ? clock(t) : "never");
  if (u.run) return runLine(u.run);
  if (u.pending) return `UPDATE asked — waiting for the Studio to run /ds-update (${u.pending.age_min} min)`;
  if (u.state === "detached") return "UPDATE can't check: the checkout is detached — check out its branch";
  if (u.state === "no_upstream" || u.state === "fetch_failed") return `UPDATE can't check: ${u.error ?? u.state} (last checked ${hm(u.checked_at)})`;
  if (u.stale) return `UPDATE can't check: no fresh check since ${hm(u.checked_at)} — is the loop running?`;
  const lo = u.last_update?.outcome, bad = !!lo && lo !== "advanced";
  const tried = bad ? ` — last try ${lo}` : "";
  if (u.behind > 0) return `UPDATE ${u.behind} new on ${u.branch ?? "?"} (${u.classes.join(", ") || "code"}) — ${NEED_TEXT[u.need] ?? u.need} — /ds-update${tried}`;
  if (u.squads_behind) return `UPDATE this project's squads run an older dev-studio (${u.squads_behind.classes.join(", ")}) — ${NEED_TEXT[u.squads_behind.need] ?? u.squads_behind.need} — /ds-update${tried}`;
  if (u.last_update && bad) return `UPDATE ${lo}: ${u.last_update.line ?? lo} — fix it, then /ds-update ${u.project ?? ""}`.trimEnd();
  if (u.last_update) return `UPDATE ${u.last_update.line ?? u.last_update.outcome}`;
  return "UPDATE current";
}

// The Builders tile's second line (squad-priority U2), whenever max_builders is set:
// `6/8 · normal 6/6 (4 working, 1 idle, 1 pausing) · light 0/2`; with the light lane off no light part.
// The page (web/board.html) builds the same text from the same header fields.
export function buildersText(h: any): string | null {
  if (h?.builders_total == null) return null;
  const o = h.builders_over, bw = h.builders_seats?.by_why ?? {};
  const over = o ? [o.urgent ? `⚡${o.urgent}` : "", o.moved ? `${o.moved} moved` : "", o.held ? `${o.held} held` : "", o.other ? `${o.other} other` : ""].filter(Boolean) : [];
  const reasons = ["working", "idle", "pausing", "restarting", "starting", "hold"].filter((k) => bw[k] > 0).map((k) => `${bw[k]} ${k === "hold" ? "held by a pick" : k}`);
  const why = over.length || reasons.length ? ` (${[...over, ...reasons].join(", ")})` : "";
  const light = h.builders_light_of > 0 ? ` · light ${h.builders_light}/${h.builders_light_usable}${h.builders_light_usable < h.builders_light_of ? ` (${h.builders_light_of})` : ""}` : "";
  return `${h.builders_normal + h.builders_light}/${h.builders_total} · normal ${h.builders_normal}/${h.builders_of}${why}${light}`;
}

// The BRAKE line while the host's sample crosses a crit line (board-shows-host-brake U2): holding (this project has
// the brake on and a start waits), armed (on, no start waits now) or a host note when it is off here.
export function brakeText(br: any): string | null {
  if (!br?.hit) return null;
  const h = br.hit, line = `${h.metric} ${h.value}${h.unit} ≥ crit ${h.crit}${h.unit} (${h.key})`;
  if (!br.on) return `BRAKE  host over crit: ${line} · the brake is off here${br.projects.length ? `, on for ${br.projects.join(", ")}` : ""}`;
  if (br.holding) return `BRAKE  holding ${br.held} start${br.held === 1 ? "" : "s"}: ${line} · set ${br.setting} off to start anyway`;
  return `BRAKE  armed: ${line} · ${br.free > 0 ? "no unit waits for a seat" : "no free seat now"}`;
}

// The Feedback panel's header facts (ds-feedback-github-issues U4): the repo drafts go to (null: posting off),
// the drafts waiting for review (`blocked` of them with a leak hit) and the notes by state. Host-wide, so a
// project board shows the same numbers; an older loop.db without the tables reads as none.
export function feedbackSummary(db: Db | null, project = "") {
  const none = { on: false, switch: false, repo: null as string | null, review: 0, blocked: 0, notes: 0, new: 0, drafted: 0, filed: 0, fixed: 0, closed: 0, dismissed: 0 };
  if (!db) return none;
  try {
    const repo = feedbackRepo(db.s), sw = feedbackOn(db.s, project);
    const d = db.one("SELECT COUNT(*) AS n, COALESCE(SUM(leak = 'blocked'), 0) AS b FROM feedback_drafts WHERE state IN ('review', 'posting')");
    const by: Record<string, number> = {};
    for (const r of db.all("SELECT state, COUNT(*) AS n FROM feedback_notes GROUP BY state")) by[String(r.state)] = Number(r.n);
    const sum = Object.values(by).reduce((a, b) => a + b, 0);
    return { on: sw && repo != null, switch: sw, repo, review: Number(d?.n ?? 0), blocked: Number(d?.b ?? 0), notes: sum, new: by.new ?? 0, drafted: by.drafted ?? 0,
      filed: by.filed ?? 0, fixed: by.fixed ?? 0, closed: by.closed ?? 0, dismissed: by.dismissed ?? 0 };
  } catch { return none; }
}
export function feedbackLine(f: ReturnType<typeof feedbackSummary> | undefined): string | null {
  if (!f || (!f.on && f.notes === 0)) return null;
  const head = f.on ? `${f.review} draft${f.review === 1 ? "" : "s"} to review${f.blocked ? ` (${f.blocked} blocked by the leak check)` : ""}`
    : f.switch ? "on, but this checkout's origin is not a GitHub repo (set feedback_repo with ds config)" : "off (turn Feedback on in Settings → Limits)";
  return `FEEDBACK  ${head} · notes: ${f.notes} (${f.new} new, ${f.drafted} drafted, ${f.filed} filed, ${f.fixed} fixed, ${f.closed} closed, ${f.dismissed} dismissed)`;
}

// GET /api/feedback: what the Feedback panel shows. `review` = drafts in review (or posting) with the notes they
// came from, `filed` = drafts already sent (newest 100), `notes` = every note, newest first (at most 500), each
// with its draft's issue when it has one. null: no loop.db.
export function feedbackJson(root = stateRoot(), project = "") {
  return withDb((db) => {
    const notes = db.all(`SELECT n.id, n.project, n.squad, n.role, n.text, n.source, n.state, n.draft_id, n.evidence, n.reason, n.at,
        d.issue, d.url, d.fix_pr, d.fix_here FROM feedback_notes n LEFT JOIN feedback_drafts d ON d.id = n.draft_id ORDER BY n.id DESC LIMIT 500`)
      .map((r) => ({ id: Number(r.id), project: String(r.project), squad: r.squad as string | null, role: r.role as string | null, text: String(r.text), source: String(r.source),
        state: String(r.state), draft: r.draft_id == null ? null : Number(r.draft_id), evidence: r.evidence as string | null, reason: r.reason as string | null, at: Number(r.at),
        issue: r.issue == null ? null : Number(r.issue), url: r.url as string | null, fix_pr: r.fix_pr == null ? null : Number(r.fix_pr), fix_here: r.fix_here === 1 }));
    const draft = (r: Row) => ({ id: Number(r.id), kind: String(r.kind), title: r.title as string | null, body: String(r.body), area: r.area as string | null, label: r.label as string | null,
      target: r.target == null ? null : Number(r.target), evidence: r.evidence as string | null, checked_at: r.checked_at as string | null, leak: String(r.leak), leak_why: r.leak_why as string | null,
      state: String(r.state), reason: r.reason as string | null, repo: r.repo as string | null, issue: r.issue == null ? null : Number(r.issue), url: r.url as string | null,
      fix_pr: r.fix_pr == null ? null : Number(r.fix_pr), fix_here: r.fix_here === 1, created_at: Number(r.created_at),
      notes: notes.filter((n) => n.draft === Number(r.id)).sort((a, b) => a.id - b.id) });
    return {
      ...feedbackSummary(db, project),
      review: db.all("SELECT * FROM feedback_drafts WHERE state IN ('review', 'posting') ORDER BY id").map(draft),
      filed: db.all("SELECT * FROM feedback_drafts WHERE state IN ('filed', 'fixed', 'closed') ORDER BY updated_at DESC, id DESC LIMIT 100").map(draft),
      notes,
    };
  }, root);
}

export function renderText(b: Board): string {
  const o: string[] = [];
  const cap = b.capacity ? ` · ${b.capacity.label} ${b.capacity.count}` : "";
  o.push(`STUDIO — overview (${new Date().toTimeString().slice(0, 8)})   live worktrees: ${b.live_worktrees ?? "?"}${cap}   `
    + (b.needs_count > 0 ? `● ${b.needs_count} answer(s) needed` : "● nothing needs you"), flowLine(b.flow), RULE);
  if (b.spent_total) o.push(`SPENT  ≈${compact(b.spent_total.spent)} since ${dayOf(b.spent_total.since)} (all squads, archived included)`, RULE);
  if (b.accounts.length) o.push(`ACCOUNTS  ${b.accounts.map((a) => a.text + (a.disabled ? " · disabled" : "") + (a.users_count ? ` · ${a.users_count} roles` : "")).join(" | ")}`, RULE);
  if (b.machine) o.push(machineLine(b.machine), RULE);
  for (const d of b.disk ?? []) o.push(`DISK  ⚠ ${d.title}${d.consumers.length ? ` — ${d.consumers[0]}` : ""}`, RULE);
  { const bl = buildersText(b.header); if (bl) o.push(`BUILDERS  ${bl}`, RULE); }
  { const br = brakeText(b.header?.brake); if (br) o.push(br, RULE); }
  if (b.loop.stalling) o.push(`LOOP  ⚠ the loop keeps stalling — ${b.loop.restarts_recent} restarts in the last ${b.loop.stall_window_min} min; see loop.log / journalctl --user -u ds-loop.service`, RULE);
  if (b.loop.down) o.push(`LOOP  ⚠ loop down — ${b.loop.tick_at == null ? "it has never ticked" : `data as of ${clock(b.loop.tick_at)} (${Math.floor((b.loop.age_s ?? 0) / 60)} min ago)`}; pokes, restarts and PR status are paused. Start it: bin/loop/loop.sh --ensure`, RULE);
  { const gl = githubLine(b.github, b.github?.waiting.length ?? 0); if (gl) o.push(gl, RULE); }
  { const fl = feedbackLine(b.feedback); if (fl) o.push(fl, RULE); }
  if (b.update) o.push(updateLine(b.update), RULE);
  if (b.live_waiting.length) {
    o.push("LIVE — waiting for input (not yet enqueued; poke the Lead to route it):", ...b.live_waiting.map((l) => `  ⚠ ${l}`), RULE);
  }
  for (const a of b.studio_alerts) {
    const ag = a.age_min == null || a.age_min < 0 ? "?" : a.age_min >= 60 ? `${Math.floor(a.age_min / 60)}h` : `${a.age_min}m`;
    o.push(`studio: ${(a.debrief ? a.text.split("\n")[0] : a.text).replace(/[\t\n]/g, " ")} (${ag}) — then dismiss it on the web board${a.suggestion ? ` ("${a.suggestion}")` : ""}`);
  }
  if (b.studio_alerts.length) o.push(RULE);
  for (const st of b.studio) {
    o.push(`studio ${st.label}: ` + (st.adopted
      ? [`${st.agent}${st.model_label ? " " + st.model_label : ""}`, st.account_label ? `@${st.account_label}` : null, st.ctx == null ? null : `ctx ${compact(st.ctx)}`, st.handle].filter(Boolean).join(" · ")
      : "no Studio terminal adopted — see the studio.adopt card") + (st.adopted && st.unread + st.reply_due > 0 ? ` · mail:${st.unread + st.reply_due}` : ""));
  }
  if (b.studio.length) o.push(RULE);
  if (b.squads.some((s) => ["held-only", "paused", "suspended", "on-hold"].includes(s.display_key))) o.push(`not working: ${STATE_LEGEND.join(" · ")}`);
  for (const s of b.squads) {
    let live = "";
    if (s.live.working > 0) live += ` ▶${s.live.working}`;
    if (s.live.waiting > 0) live += ` ⏸${s.live.waiting}`;
    if (s.gates) live += ` ⛳${s.gates}`;
    if (s.lfg_assumptions) live += ` lfg:${s.lfg_assumptions}`;
    if (s.still_active) live += " ⚠still-active";
    if (s.lead.verdict === "unreachable") live += " ⚠LEAD-UNREACHABLE";
    else if (s.lead.verdict) live += ` ⚠LEAD-${s.lead.verdict === "hung" ? "HUNG" : "NOT-RESPONDING"}(${Math.floor((s.lead.since_s ?? 0) / 60)}m)`;
    o.push("", `▣ ${s.type === "testing" ? "🧪 " : ""}${(s as any).focus ? "★ " : ""}${s.topic}  [${s.display_status}${s.phase_stuck ? " ⚠stuck" : ""}]${s.held && s.display_key !== "held-only" ? ` ${s.held} held` : ""}  ${s.type}/${s.autonomy} · ship:${s.ship_mode}${s.backend && s.backend !== "orca" ? ` · on:${s.backend}${s.provider_default ? "" : `/${s.worktree_provider}`}` : ""}${live}${s.exposed_summary && s.exposed_summary.open ? `  open:${s.exposed_summary.open}` : ""}${s.exposed_summary && s.exposed_summary.down ? ` (${s.exposed_summary.down} down)` : ""}`);
    if ("error" in s) o.push(`   ${s.framing}`);
    else {
      if (s.explain) o.push(`   ${s.display_status}: ${s.explain.means} (set by ${s.explain.set_by}). You can: ${s.explain.you_can}.`);
      if (s.phase_note) o.push(`   ${s.display_status}: ${s.phase_note}`);
    }
    const p = s.progress;
    if (p.total || p.cancelled) o.push(`   units ✓${p.done} ⟳${p.dispatched} ○${p.planned}${p.cancelled ? ` ✗${p.cancelled}` : ""}`);
    if (s.prs.length) o.push(`   PRs${s.prs.map((r) => ` #${r.num}${r.status ? ` (${r.status})` : ""}`).join("")}`);
    for (const q of s.questions) {
      if (!q.asker) continue;
      const a = q.age_min;
      const ag = a == null || a < 0 ? "?" : a >= 60 ? `${Math.floor(a / 60)}h` : `${a}m`;
      const text = String(q.title ?? q.question ?? "").replace(/[\t\n]/g, " ");
      // A picker mirror lives in the asker's terminal (not the Lead's) and recommends nothing.
      const where = q.source === "picker" ? `answer it in ${q.asker}'s terminal${q.picker_answerable === true ? " or on the web board" : ""}` : `answer at the ${s.topic} Lead`;
      o.push(`   ${q.blocking ? "‼ BLOCKING" : "❗"} ${q.asker}: ${text.length > 100 ? text.slice(0, 100) + "…" : text} (${ag}) — ${where}`);
      if (q.shown) o.push(...String(q.shown).split("\n").map((l) => `      │ ${l}`));
      if (q.suggestion && q.source !== "picker") o.push(`      suggested: ${q.suggestion}${q.why ? " — " + q.why : ""}`.replace(/[\t\n]/g, " "));
    }
    for (const m of s.members) if (m.limited) o.push(`   ⏸ usage limit: ${m.label} — ${m.limited.line}${m.limited.wait_label ? ` (${m.limited.wait_label})` : m.limited.switching ? " (restart on the next account requested)" : ""}`);
    if (s.devenv) o.push(`   dev env: ${s.devenv.url}${s.devenv.note ? " " + s.devenv.note : ""}`);
    for (const e of arr(s.exposed)) {
      if (e.legacy || e.state !== "open") continue;   // the dev env line above says the legacy one; only what opens is listed
      o.push(`   exposed: ${e.name} ${e.url} (${e.role})${e.note ? " — " + e.note : ""}`.replace(/[\t\n]/g, " "));
    }
    const xs = s.exposed_summary ?? { down: 0, host_only: 0, checking: 0 };
    const rest = [["down", xs.down], ["host only", xs.host_only], ["checking", xs.checking]].filter(([, n]) => n as number > 0);
    if (rest.length) o.push(`   not shown: ${rest.map(([k, n]) => `${n} ${k}`).join(" · ")}`);
    // Crew and units as tables: one column each for the numbers, so they line up.
    if (s.members.length) o.push(`      ${"ROLE".padEnd(22)} ${"CONTEXT".padStart(13)} ${"".padEnd(7)} ${"STATE".padEnd(8)} ACCOUNT`);
    for (const m of s.members) {
      const t = (m as any).tokens, lv = (m as any).ctx_level;
      const ctx = t ? `context ${t.ctx == null ? "?" : compact(t.ctx)}` : "";
      const fb = m.fallback ? " (fallback)" : "";
      const pl = (v: unknown) => (typeof v === "string" && v ? ` (${v})` : "");   // U123: the account's plan, when known
      const cfgAcct = m.account ? `@${m.account_label ?? m.account}${pl(m.account_plan)}` : m.account_default ? `@${m.account_label}${pl(m.account_plan)} (default)` : "";
      const mism = m.model_mismatch || m.account_mismatch;
      // Real values when known (else the configured ones); a mismatch says what was configured.
      const acct = (m.model_label ? m.model_label + " " : "") + ((m as any).effort_label ? "· " + (m as any).effort_label + " " : "") + ((m as any).phase ? "· " + (m as any).phase + " " : "") + (m.account_real ? `@${m.account_real_label}${pl(m.account_real_plan)}${fb}` : cfgAcct ? cfgAcct + fb : fb.trim())
        + (mism ? ` ⚠ configured ${m.model ?? ""}${m.account ? "@" + m.account : ""}` : "");
      const subchips = ((m.subs ?? []) as SubView[])
        .map((s) => `+ sub: ${s.model_label ?? s.agent}${s.effort ? " · " + s.effort : ""} @${s.account_label}${pl(s.account_plan)}`).join(" ");
      const mail = (m as any).unread > 0 || (m as any).reply_due > 0 ? ` ✉ ${(m as any).unread} unread · ${(m as any).reply_due} waiting for a reply` : "";
      o.push(`      • ${m.label.padEnd(20)} ${ctx.padStart(13)} ${(t && lv && lv !== "ok" ? `(${lv})` : "").padEnd(7)} ${m.state.padEnd(8)} ${acct}${subchips ? ` ${subchips}` : ""}${(m as any).terminals > 1 ? ` ⚠ ${(m as any).terminals} sessions` : ""}${m.for ? ` for:${m.for}` : ""}${m.owns ? `  owns: ${m.owns}` : ""}${mail}${(m as any).at_prompt ? ` ⚠ ${atPromptText((m as any).at_prompt.since)}` : ""}`.trimEnd());
    }
    if ((s as any).role_tokens && Object.values((s as any).role_tokens).some((v) => v)) o.push(`      ${roleLine((s as any).role_tokens)}`);
    const sw = Math.max(4, ...s.units.map((u) => u.slug.length)), tw = Math.max(4, ...s.units.map((u) => (u.tier ?? "").length));
    if (s.units.length) o.push(`      ${"".padEnd(1)} ${"UNIT".padEnd(sw)} ${"TIER".padEnd(tw)} ${"SPENT".padStart(8)} ${"CPU-H".padStart(6)}  STATE`);
    for (const u of s.units) {
      const mk = ((u as any).urgent ? " ⚡" : "") + ((u as any).focus ? (u as any).focus === "on" ? " ★" : " ☆" : "") + ((u as any).unlocks ? ` unlocks:${(u as any).unlocks}` : "");
      const ut = (u as any).tokens ? `≈${compact((u as any).tokens.spent)}` : "";
      const cell = `${u.slug.padEnd(sw)} ${(u.tier ?? "").padEnd(tw)} ${ut.padStart(8)} ${cpuH((u as any).cpu).padStart(6)}`;
      const dep = u.state === "blocked" && u.deps.length ? ` · ${u.deps.length} deps` : "";
      const waits = (u.ext_deps ?? []).filter((d) => d.status !== "done" && d.status !== "closed-done");
      const bbd = (u as any).blocked_by ?? [];
      const bb = bbd.length ? `blocked by ${bbd.join(", ")}` : "";
      const ustate = u.state === "stale" && u.reasons ? `stale: ${u.reasons}` : u.state;
      const row = (t: string) => t + (u.status === "done" || u.status === "cancelled" ? "" : mk);
      o.push(row(u.status === "done" ? `      ✓ ${cell}  done`
        : u.status === "cancelled" ? `      ✗ ${cell}  ${u.superseded_by ? `folded into ${u.superseded_by}` : "cancelled"}`
        : u.wait_label ? `      ○ ${cell}  (${u.wait_label})`
        : u.status === "planned" ? `      ○ ${cell}  (${bb || `planned — no builder yet${dep}`})`
        : u.status === "dispatched" ? (u.state === "gone" ? `      ⚠ ${cell}  (dispatched — builder GONE, re-dispatch)` : `      ⟳ ${cell}  (${ustate})`)
        : `      ? ${cell}  (${u.status})`));
      if (u.status !== "done") for (const d of waits) o.push(`        waits on ${d.ref} (${d.status})`);
    }
    leftoverText(o, s.leftovers);
    const ut = (s as any).unit_tokens;
    if (ut?.spent) o.push(`      spent ≈${compact(ut.spent)} over ${ut.units} units (7 days)`);
    if ((s as any).spent_since) o.push(`      ${sinceLine((s as any).spent_since)}`);
  }
  if (!b.squads.length) o.push("  (no squads)");
  // archive-leftovers U2: an archived squad still holding kept worktrees stays in sight.
  for (const a of (b.archived ?? []).filter((x: any) => (x.leftovers ?? []).length)) {
    o.push(`  ARCHIVED ${a.topic}${a.closed_at ? ` (closed ${String(a.closed_at).slice(0, 10)})` : ""}`);
    leftoverText(o, a.leftovers);
  }
  return o.join("\n") + "\n";
}

function leftoverText(o: string[], leftovers: any[] | undefined): void {
  if (!(leftovers ?? []).length) return;
  o.push(`   LEFTOVERS`);
  for (const l of leftovers!) {
    const c = l.check, ca = c?.checked_age_s;
    const lag = (n: number | null) => n == null ? "?" : n >= 3600 ? `${Math.floor(n / 3600)}h` : `${Math.max(1, Math.floor(n / 60))}m`;
    const what = !c ? "not checked yet" : c.safe ? "safe, removing on the next check"
      : `look first: ${c.commits.length} commit${c.commits.length === 1 ? "" : "s"}, ${c.n_differ} file${c.n_differ === 1 ? "" : "s"} not on main · checked ${lag(ca)}`;
    o.push(`      ⚑ ${l.path}  (${l.branch ?? "?"}) — ${what}`);
  }
}

// --- the server's other reads (board-server.ts GET routes) ----------------------------------------

// Run `fn` over one read-only connection; null when there is no loop.db.
function withDb<T>(fn: (db: Db) => T, root = stateRoot()): T | null {
  let s: Store;
  try { s = openReadOnly(root); } catch { return null; }
  try { return fn(new Db(s)); } finally { s.close(); }
}

// The Limits tab's categories, in display order: `keys` are listed by name (checked first, across every group),
// `prefixes` claim the rest. A key nobody placed is "Other" (tests/loop/board-limits-groups.test.ts fails on one).
export const LIMIT_GROUPS: { name: string; keys?: string[]; prefixes?: string[] }[] = [
  { name: "Context & compaction", keys: ["studio_move"], prefixes: ["context_", "compact_", "auto_compact_"] },
  { name: "Accounts & model picking", keys: ["limit_pct", "limit_wait_max", "credits_hold_h", "fallback_return_min"], prefixes: ["pick_"] },
  { name: "Agents & nudges", keys: ["quiet_nudge_min", "long_step_min", "max_builders", "max_light_builders", "light_lane_cpu_h", "focus_squad", "unblock_first", "builder_host_brake", "worktree_provider", "restart_rss_gb", "crash_window_min", "unit_token_x", "unit_token_max", "stale_min", "prompt_wait_min", "gone_min", "stale_lead_min", "stale_alert_min", "chat_quiet_s", "chat_queue_min", "chat_files_keep_d", "msg_chase_min", "msg_reply_alert_min", "debrief", "archive_debrief_min", "notes_cap"] },
  { name: "PRs & merging", keys: ["expected_checks", "auto_merge", "base_update", "github_budget_share", "pr_stale_min", "stale_repoke_min", "required_wait_min", "red_repoke_min"] },
  { name: "Review", prefixes: ["review_"] },
  { name: "Board & machine", keys: ["update_run_max_min", "board_stale_ticks", "flow_stuck_floor_min", "flow_quiet_min", "needs_grace_min", "refusal_needs_min", "loop_stall_banner_n", "loop_stall_banner_min", "tick_alarm_ms", "tick_alarm_windows", "expose_down_min", "expose_stop_s", "expose_warn_min"], prefixes: ["machine_"] },
  { name: "Morning brief", prefixes: ["briefing_"] },
  { name: "Host tidy", keys: ["host_tidy"], prefixes: ["cleanup_", "disk_"] },
  { name: "Feedback", keys: ["feedback"], prefixes: ["feedback_"] },
];
export function limitGroup(key: string): string {
  return (LIMIT_GROUPS.find((g) => g.keys?.includes(key)) ?? LIMIT_GROUPS.find((g) => g.prefixes?.some((p) => key.startsWith(p))))?.name ?? "Other";
}

// U258: the last change of one config row, from config_history: who (board, ds, migration), when, the
// value it replaced and whether Undo is offered (not for the import: there is nothing before it to go
// back to). null when the row has no history or the db has no such table yet (an unmigrated loop.db).
export function lastChange(db: Db, project: string, file: string, key: string) {
  try {
    const h = db.one("SELECT id, old_value, actor, at FROM config_history WHERE project = ? AND file = ? AND key = ? ORDER BY id DESC LIMIT 1", project, file, key);
    if (!h) return null;
    const by = String(h.actor);
    return { id: Number(h.id), by, at: Number(h.at), from: h.old_value == null ? null : String(h.old_value), imported: by === "migration", undo: by !== "migration" };
  } catch { return null; }
}

// GET /api/limits: what the limits script's `show --json` prints, from the limits.conf config rows — every key
// of conventions/limits.conf with its value and source (env | override | default | unset).
// Limits the board shows as read-only text: globs and a command run in worktrees are edited in
// through `ds config import` (docs/settings.md), never from a web form. `reset` of an override stays allowed.
export const FILE_ONLY_LIMITS = new Set(["cleanup_tmp_globs", "cleanup_trim_globs", "cleanup_on_close", "disk_watch_paths", "feedback_repo"]);
export function limitsJson(project: string, root = stateRoot()) {
  return withDb((db) => {
    const limits = db.all("SELECT key, value, comment FROM config WHERE project = '' AND file = 'limits.conf' ORDER BY rowid").map((d) => {
      const key = String(d.key), env = LIMIT_ENV[key] ?? "DS_LIMIT_" + key.toUpperCase();
      const own = db.one("SELECT value FROM config WHERE project = ? AND file = 'limits.conf' AND key = ?", project, key);
      const fileOnly = FILE_ONLY_LIMITS.has(key);
      // A file-only value is shown whole (a glob list may be space-separated); the rest keep their first token.
      const first = (v: unknown) => fileOnly ? String(v ?? "").trim() : String(v ?? "").trim().split(/\s+/)[0] ?? "";
      const [value, source] = process.env[env] ? [process.env[env]!, "env"]
        : first(own?.value) ? [first(own?.value), "override"] : first(d.value) ? [first(d.value), "default"] : ["", "unset"];
      const hint = key === "feedback_repo" ? `in use: ${feedbackRepo(db.s) ?? (feedbackOn(db.s, project) ? "none (the checkout's origin is not a GitHub repo)" : "none (Feedback is off)")}` : key === "briefing_time" ? "off or HH:MM (24h), e.g. 08:30" : key === "briefing_days" ? "daily, mon-fri, or mon,wed,fri" : null;
      const changed = source === "override" ? lastChange(db, project, "limits.conf", key) : null;
      return { key, value, source, env, changed, hint, comment: String(d.comment ?? ""), allowed: key === "review_block_severity" || key === "review_block_severity_risky" ? ["P0", "P1", "P2", "P3"] : key === "compact_mode_studio" ? ["compact", "off"] : key === "studio_move" ? ["auto", "ask", "off"] : key.startsWith("compact_mode_") ? ["compact", "clear", "off"] : key === "host_tidy" ? ["report", "apply"] : key === "builder_host_brake" || key === "feedback" ? ["off", "on"] : key === "unblock_first" || key === "debrief" ? ["on", "off"] : key === "worktree_provider" ? [...PROVIDER_SETTINGS] : null, fileOnly, list: key === "expected_checks" || key === "review_risk_paths" || key === "review_skip_lenses", group: limitGroup(key) };
    });
    const used = new Set(limits.map((l) => l.group));
    return { project, groups: [...LIMIT_GROUPS.map((g) => g.name).filter((n) => used.has(n)), ...(used.has("Other") ? ["Other"] : [])], limits };
  }, root);
}

// GET /api/roles: the roster for the Roles tab, from the roles.conf and models.conf config
// rows (the roles script's `list --json` shape, plus U85): the project's roster (its override
// rows laid over the default rows, per role) with each row's default: every role once, source
// "project" for a row the project set, "default" for one it follows; and the model catalog the
// pickers offer (models.conf, plus any agent:model a roster uses that it lacks, flagged custom).
const ROLE_ORDER = ["studio", "lead", "thinker", "thinker-deep", "builder", "builder-standard", "builder-hard-babysit", "builder-standard-babysit", "builder-review", "builder-review-standard", "review-leaf", "reviewer", "tester", "researcher"];
const backOf = (role: string, own: Map<string, string>, dflt: Map<string, string>) => {
  const b = resolveBackUp(role, own, dflt);
  return { back_up: b.back_up, back_up_from: b.from };
};
export function rolesJson(project: string, root = stateRoot()) {
  return withDb((db) => {
    type Role = { agent: string; model: string; spawn: string; effort: string; fallbacks: string; plan: string; return: string };
    const roster = (p: string) => new Map(db.all("SELECT key, value FROM config WHERE project = ? AND file = 'roles.conf' ORDER BY rowid", p).map((r) => {
      const [agent = "", model = "", spawn = "", effort = "-", fallbacks = "-", plan = "-"] = String(r.value ?? "").trim().split(/\s+/);
      const ret = returnOf(String(r.value ?? ""));
      return [String(r.key), { agent, model, spawn, effort: effort === "-" ? "" : effort, fallbacks: fallbacks === "-" ? "" : fallbacks, plan: plan === "-" ? "" : plan, return: ret } as Role];
    }));
    // U267/U268: one roster rule. A project row overrides its role, the default row fills every other
    // role; each role is listed once, "project" when the project has a row of its own, else "default".
    const dflt = roster(""), own = roster(project), conf = new Map([...dflt, ...own]);
    const val = (m: Map<string, Role>) => new Map([...m].map(([k, r]) => [k, [r.agent, r.model, r.spawn, "-", "-", "-", r.return || "-"].join(" ")]));
    const ownV = val(own), dfltV = val(dflt);
    const roles = [...conf].map(([role, r]) => ({ role, ...r, ...backOf(role, ownV, dfltV), default: dflt.get(role) ? { ...dflt.get(role)!, ...backOf(role, new Map(), dfltV) } : null, source: own.has(role) ? "project" : "default",
      changed: own.has(role) ? lastChange(db, project, "roles.conf", role) : null }));
    const rank = (n: string) => { const i = ROLE_ORDER.indexOf(n); return i < 0 ? ROLE_ORDER.length : i; };
    roles.sort((a, b) => rank(a.role) - rank(b.role) || (rank(a.role) === ROLE_ORDER.length ? a.role.localeCompare(b.role) : 0));
    const ownModels = db.all("SELECT key, value FROM config WHERE project = ? AND file = 'models.conf' ORDER BY rowid", project);
    const models = ownModels.length ? ownModels : db.all("SELECT key, value FROM config WHERE project = '' AND file = 'models.conf' ORDER BY rowid");
    const liveModels = db.all("SELECT key, value FROM config WHERE project = '' AND file = 'codex-models' ORDER BY rowid");
    const catalog = [...models.filter((r) => !liveModels.some((c) => c.key === r.key)), ...liveModels].map((r) => {
      const [agent = "", model = ""] = String(r.key).split("|"), [label = "", efforts = "-"] = String(r.value ?? "").split("|").map((x) => x.trim());
      return { agent, model, label, efforts: efforts === "-" || !efforts ? [] : efforts.split(","), custom: false };
    });
    const used = [...dflt.values(), ...conf.values()].flatMap((r) => [`${r.agent}:${r.model}`,
      ...r.fallbacks.split(",").filter(Boolean).map((f) => f.split(":").slice(0, 2).join(":")).filter((f) => f.split(":")[1])]);
    for (const u of [...new Set(used)].sort()) {
      const [agent, model] = u.split(":");
      if (!catalog.some((c) => c.agent === agent && c.model === model)) catalog.push({ agent, model, label: `${agent}:${model} (custom)`, efforts: [], custom: true });
    }
    const plans: Record<string, string[]> = {};
    for (const a of db.all("SELECT DISTINCT agent, plan FROM observed_accounts WHERE plan IS NOT NULL AND plan != '' ORDER BY agent, plan")) {
      (plans[String(a.agent)] ??= []).push(String(a.plan));
    }
    return { project, roles, catalog, plans };
  }, root);
}

// An event's colour on the board's event log: 'bad' (failed, red), 'wait' (waiting or retrying,
// orange), 'ok' (done, green), or NULL (neutral bookkeeping, and any kind not named here). One SQL
// expression, so the `sev` each row carries and the `sev=` filter can never disagree. With the
// messages table (migration 0045; event-log-filters U4) a `message_sent` row is 'wait' while its
// message (found by its unique `key`) is unread or awaits a reply, as the page colours a message row.
const jx = (path: string) => `(CASE WHEN json_valid(payload) THEN json_extract(payload, '${path}') END)`;
const sqlList = (ks: string) => ks.split(" ").map((k) => `'${k}'`).join(", ");
export const sevSql = (hasMessages: boolean) => `(CASE${hasMessages ? `
  WHEN kind = 'message_sent' AND EXISTS (SELECT 1 FROM messages m WHERE m.key = (CASE WHEN json_valid(events.payload) THEN json_extract(events.payload, '$.key') END)
    AND (m.read_at IS NULL OR (m.needs_reply = 1 AND m.replied_at IS NULL))) THEN 'wait'` : ""}
  WHEN kind IN (${sqlList("action_failed action_unhandled wish_failed wish_given_up service_failed github_error plugin_error delivery_escalated")}) THEN 'bad'
  WHEN kind = 'request_done' THEN CASE WHEN ${jx("$.result.ok")} = 0 THEN 'bad' ELSE 'ok' END
  WHEN kind = 'toast' THEN CASE WHEN ${jx("$.level")} = 'error' THEN 'bad' END
  WHEN kind IN (${sqlList("action_pending action_dropped limited ready_deferred tick_slow worker_stopped stray_terminal_closed fallback_missed")}) THEN 'wait'
  WHEN kind = 'unit_pr_blocked' THEN CASE WHEN COALESCE(${jx("$.reasons")}, '') <> '' THEN 'wait' ELSE 'ok' END
  WHEN kind = 'pick' THEN CASE WHEN COALESCE(${jx("$.wait")}, '') NOT IN ('', 0) THEN 'wait' END
  WHEN kind IN (${sqlList("action_done wish_done unit_done unit_pr unit_into_merged unit_dispatched squad_all_done member_started service_started service_restarted delivery_verified limit_cleared question_answered question_replied")}) THEN 'ok'
END)`;
export const SEV_SQL = sevSql(false);
const hasTable = (db: Db, name: string) => !!db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name);

// A worktree's short name, as the page's who() gives it: the role and suffix of its folder
// (`.../ds-dev-studio-builder-u8-x-sq` in squad `sq` reads `builder-u8-x`). The `ds-<project>-`
// prefix goes first, so a project named like a role (dev-studio) does not read as one.
export function wtName(wt: string, squad?: string | null, project?: string | null): string {
  let b = String(wt).split("/").pop()!;
  if (project && b.startsWith("ds-" + project + "-")) b = b.slice(project.length + 4);
  else if (!/^(lead|thinker|builder|reviewer|tester|researcher|studio)(-|$)/.test(b)) b = b.replace(/^.*?-(?=(lead|thinker|builder|reviewer|tester|researcher|studio)(-|$))/, "");
  if (squad && b.endsWith("-" + squad)) b = b.slice(0, -squad.length - 1);
  return b;
}
const WT_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}::\/[\w\/.-]*\w/g, CTX_ID = /\bctx_[0-9a-f]{6,}\b/g;

// The names of the ids a page of events carries (U1, event-log-polish): each `<uuid>::<path>`
// worktree id and each `ctx_<hex>` dispatch id the loop can place, mapped to the member's short name.
// A dispatch is placed through the worktree that held it: the dispatches history first (U2, so an
// old id still names its member after a re-dispatch), then the current holder (observed_workers).
// One it cannot place is left out, and the page reads it as "an earlier dispatch". A loop.db from
// before U2's migration has no dispatches table and reads as before.
function eventNames(db: Db, evs: Row[]): Record<string, string> {
  // Each worktree id with the squad and project of an event that carries it; a members row wins.
  const wts = new Map<string, { squad?: unknown; project?: unknown }>(), ctxs = new Set<string>();
  for (const e of evs) {
    const text = String(e.member ?? "") + " " + String(e.payload ?? "");
    for (const m of text.match(WT_ID) ?? []) if (!wts.get(m)?.squad) wts.set(m, { squad: e.squad, project: e.project });
    for (const m of text.match(CTX_ID) ?? []) ctxs.add(m);
  }
  const inCtx = JSON.stringify([...ctxs]);
  const hasHistory = ctxs.size && !!db.one("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'dispatches'");
  const history = hasHistory ? db.all("SELECT project, dispatch_id, wt FROM dispatches WHERE dispatch_id IN (SELECT value FROM json_each(?))", inCtx) : [];
  const held = ctxs.size ? db.all("SELECT project, dispatch_id, wt FROM observed_workers WHERE dispatch_id IN (SELECT value FROM json_each(?))", inCtx) : [];
  for (const r of [...history, ...held]) if (!wts.has(String(r.wt))) wts.set(String(r.wt), { project: r.project });
  const known = wts.size ? db.all("SELECT wt, squad, project FROM members WHERE wt IN (SELECT value FROM json_each(?))", JSON.stringify([...wts.keys()])) : [];
  for (const r of known) wts.set(String(r.wt), r);
  const names: Record<string, string> = {};
  for (const [wt, at] of wts) names[wt] = wtName(wt, at.squad as string, at.project as string);
  for (const r of held) names[String(r.dispatch_id)] = names[String(r.wt)];
  for (const r of history) names[String(r.dispatch_id)] = names[String(r.wt)];
  return names;
}

// The event log's filters (event-log-filters U1). `project` is the board's scope (or the project a
// host-wide board picked); `squad` one squad (`_studio` too), `nosquad` the rows with no squad,
// `member` one worktree (only with a squad: the crew picker sits under the squad picker), `cat` one
// category (event-cats.ts), `sev` one colour, `kind` one kind, `hide` kinds left out, `noise` leaves
// the noise kinds out (all but a kind `kind` names). `q` (U4) is search text: a row whose kind, squad,
// unit, member or payload holds it (LIKE, ASCII case-insensitive; `%`, `_` and `\` taken literally).
export type EventsFilter = {
  project?: string; squad?: string; nosquad?: boolean; member?: string; cat?: string;
  sev?: string; kind?: string; hide?: string[]; noise?: boolean; q?: string;
  // The short `role/suffix` keys of the picked member's members row: early events carry them instead
  // of the worktree id, so the member filter matches both (set by eventsPage, never by a caller).
  memberKeys?: string[];
};
const likeArg = (q: string) => `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
const SEARCH_COLS = ["kind", "squad", "unit", "member", "payload"];

// The WHERE clause of one filtered event page, without the paging term: pure, so tests can EXPLAIN it.
// With a squad picked it is `project = ? AND squad = ?` (a squad's rows always carry their project),
// else a project's board reads its own rows and the host-wide ones (`project IS NULL`). `hasMessages`
// says the db has the messages table, for the `sev` colour rule (sevSql).
export function eventsQuery(o: EventsFilter, hasMessages = false): { where: string; args: (string | number)[] } {
  const where: string[] = [], args: (string | number)[] = [];
  if (o.squad) {
    if (o.project) { where.push("project = ?"); args.push(o.project); }
    where.push("squad = ?"); args.push(o.squad);
    if (o.member) {
      const ks = [o.member, ...(o.memberKeys ?? [])];
      where.push(ks.length > 1 ? `member IN (${ks.map(() => "?").join(", ")})` : "member = ?"); args.push(...ks);
    }
  } else {
    if (o.project) { where.push("(project = ? OR project IS NULL)"); args.push(o.project); }
    if (o.nosquad) where.push("squad IS NULL");
  }
  if (o.hide?.length) { where.push(`kind NOT IN (${o.hide.map(() => "?").join(", ")})`); args.push(...o.hide); }
  if (o.kind) { where.push("kind = ?"); args.push(o.kind); }
  if (o.cat) { const c = catWhere(o.cat); if (c) where.push(c); }
  if (o.noise) {
    const noise = NOISE.filter((k) => k !== o.kind);
    if (noise.length) where.push(`kind NOT IN (${kindList(noise)})`);
  }
  if (o.sev) { where.push(`${sevSql(hasMessages)} = ?`); args.push(o.sev); }
  if (o.q) {
    where.push(`(${SEARCH_COLS.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    args.push(...SEARCH_COLS.map(() => likeArg(o.q!)));
  }
  return { where: where.length ? where.join(" AND ") : "1", args };
}

// How many ids one search request reads back from its cursor (DS_EVLOG_SEARCH_SLICE, for tests).
const searchSlice = () => {
  const n = Number(process.env.DS_EVLOG_SEARCH_SLICE);
  return Number.isInteger(n) && n > 0 ? n : 100_000;
};

// The message rows a page's message_* events name (U4): `message_sent` by its `key`, the others by
// `payload.ids` / `payload.id`. `messages` maps id → the stored status (no body); `to_wt` is the
// receiver's live worktree (as the Messages panel takes it), else null. `msgs` gives each event's ids.
// A loop.db from before migration 0045 has no table: no messages, and each event names its ids only.
function eventMessages(db: Db, page: Row[]): { messages: Record<string, unknown>; msgs: Map<Row, number[]> } {
  const msgs = new Map<Row, number[]>(), keys = new Set<string>(), ids = new Set<number>();
  const named = (p: any): number[] => [...(Array.isArray(p?.ids) ? p.ids : []), ...(p?.id != null ? [p.id] : [])].map(Number).filter(Number.isInteger);
  for (const e of page) {
    if (!String(e.kind).startsWith("message_")) continue;
    const p = parse(e.payload);
    if (e.kind === "message_sent") { if (p?.key != null) keys.add(String(p.key)); }
    else for (const id of named(p)) ids.add(id);
  }
  const messages: Record<string, unknown> = {};
  if (!keys.size && !ids.size) return { messages, msgs };
  let rows: Row[] = [];
  try {
    rows = db.all(`SELECT id, key, project, squad, to_role, to_suffix, from_role, from_suffix, subject, kind, sent_at, delivered_at,
      read_at, replied_at, needs_reply FROM messages WHERE key IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?))`,
      JSON.stringify([...keys]), JSON.stringify([...ids]));
  } catch { /* no messages table yet */ }
  const byKey = new Map(rows.map((r) => [String(r.key), Number(r.id)]));
  const wts = new Map<string, string | null>();
  const toWt = (r: Row): string | null => {
    const k = `${r.project}\0${r.squad}\0${r.to_role}\0${r.to_suffix ?? ""}`;
    if (!wts.has(k)) {
      let wt: string | null = null;
      if (r.squad === "_studio") wt = studioWts(db).get(String(r.project)) ?? null;
      else {
        const m = db.one(`SELECT wt FROM members WHERE project = ? AND squad = ? AND role = ? AND COALESCE(suffix, '') = ? AND wt IS NOT NULL
          AND COALESCE(status, '') != 'gone' AND COALESCE(want, '') != 'gone' ORDER BY id DESC`, String(r.project), String(r.squad), String(r.to_role), String(r.to_suffix ?? ""));
        wt = m ? String(m.wt) : null;
      }
      wts.set(k, wt);
    }
    return wts.get(k)!;
  };
  for (const r of rows) messages[String(r.id)] = { ...msgView(r), project: r.project, squad: r.squad, to_wt: toWt(r) };
  for (const e of page) {
    if (!String(e.kind).startsWith("message_")) continue;
    const p = parse(e.payload);
    if (e.kind === "message_sent") { const id = byKey.get(String(p?.key)); msgs.set(e, id != null ? [id] : []); }
    else msgs.set(e, [...new Set(named(p))]);
  }
  return { messages, msgs };
}

// GET /api/events: one page of the loop's event log, newest first. Pages by the events primary key
// (`before`: rows older than that id; `after`: the page just newer than that id), never by OFFSET,
// so a page stays put while the loop appends. `until` (epoch seconds) starts the page at the newest
// row at or before that time (ids rise with `at`). The filters are eventsQuery's. `older` / `newer`
// are the cursors for the next page that way, null when there is none. Each event carries its `sev`
// and `cat`; `names` names the ids its payloads carry (eventNames). `squads` and `kinds` fill the old
// page's pickers; `lists: false` leaves them (and their scan) out — eventsLists has the new ones.
// U4: `messages` holds the message rows the page's message_* events name, each such event its `msgs`
// ids (eventMessages). With `q` a request reads at most one slice of ids, `[before − slice, before)`
// (searchSlice): a full page's `older` is its last match; a slice that ends first gives
// `searched: {to_id, to_at, more}`, and asking again with `before = to_id` searches on (`more`: older
// ids exist). A searched page has no `newer` (`after` with `q` is refused; the page keeps its cursors).
// A member's short event key: `role/suffix`, or `role` alone (`builder/u1-x`, `lead`).
const shortKey = (role: unknown, suffix: unknown) => (suffix ? `${role}/${suffix}` : String(role));
function memberKeysOf(db: Db, project: string | undefined, squad: string, wt: string): string[] {
  const at = project ? "project = ? AND squad = ?" : "squad = ?", a = project ? [project, squad] : [squad];
  return [...new Set(db.all(`SELECT role, suffix FROM members WHERE ${at} AND wt = ?`, ...a, wt).map((r) => shortKey(r.role, r.suffix)))];
}

export function eventsPage(o: EventsFilter & { before?: number; after?: number; until?: number; limit?: number; lists?: boolean }, root = stateRoot()) {
  return withDb((db) => {
    const limit = Math.min(Math.max(Math.floor(o.limit ?? 50), 1), 200);
    const hasMessages = hasTable(db, "messages");
    const mk = o.squad && o.member && o.member.includes("::") ? memberKeysOf(db, o.project, o.squad, o.member) : [];
    const { where: scope, args } = eventsQuery(mk.length ? { ...o, memberKeys: mk } : o, hasMessages);
    let before = o.before ?? Number.MAX_SAFE_INTEGER;
    if (o.until != null) before = Math.min(before, Number(db.one("SELECT id FROM events WHERE at <= ? ORDER BY at DESC, id DESC LIMIT 1", o.until)?.id ?? 0) + 1);
    const cols = `*, ${sevSql(hasMessages)} AS sev, ${CAT_SQL} AS cat`;
    const more = (op: string, id: unknown) => id != null && !!db.one(`SELECT 1 FROM events WHERE ${scope} AND id ${op} ? LIMIT 1`, ...args, Number(id));
    let page: Row[], older: number | null, newer: number | null, searched: { to_id: number; to_at: number | null; more: boolean } | undefined;
    if (o.q) {
      before = Math.min(before, Number(db.one("SELECT MAX(id) AS id FROM events")?.id ?? 0) + 1);
      const low = Math.max(before - searchSlice(), 0);
      page = db.all(`SELECT ${cols} FROM events WHERE id < ? AND id >= ? AND ${scope} ORDER BY id DESC LIMIT ?`, before, low, ...args, limit);
      newer = null;
      if (page.length === limit) older = Number(page[page.length - 1].id);
      else {
        older = null;
        const at = db.one("SELECT at FROM events WHERE id >= ? ORDER BY id LIMIT 1", low)?.at;
        searched = { to_id: low, to_at: at == null ? null : Number(at), more: !!db.one("SELECT 1 AS x FROM events WHERE id < ? LIMIT 1", low) };
      }
    } else {
      page = o.after != null
        ? db.all(`SELECT ${cols} FROM events WHERE ${scope} AND id > ? ORDER BY id ASC LIMIT ?`, ...args, o.after, limit).reverse()
        : db.all(`SELECT ${cols} FROM events WHERE ${scope} AND id < ? ORDER BY id DESC LIMIT ?`, ...args, before, limit);
      const top = page[0]?.id, bottom = page[page.length - 1]?.id;
      older = more("<", bottom) ? Number(bottom) : null;
      newer = more(">", top) ? Number(top) : null;
    }
    const { messages, msgs } = eventMessages(db, page);
    const out: Record<string, unknown> = {
      events: page.map((e) => ({
        id: e.id, at: e.at, project: e.project, squad: e.squad, unit: e.unit, member: e.member, kind: e.kind, sev: e.sev ?? null, cat: e.cat,
        payload: parse(e.payload) ?? e.payload, ...(msgs.has(e) ? { msgs: msgs.get(e) } : {}),
      })),
      older, newer,
      ...(searched ? { searched } : {}),
      names: eventNames(db, page),
      messages,
    };
    if (o.lists !== false) {
      // One scan for both pickers (as cheap as the squads list alone): squads of this project, kinds in scope.
      const pickers = o.project ? "(project = ? OR project IS NULL)" : "1", pickArgs = o.project ? [o.project, o.project] : [];
      const seen = db.all(`SELECT DISTINCT kind, CASE WHEN ${o.project ? "project = ?" : "1"} THEN squad END AS squad FROM events WHERE ${pickers}`, ...pickArgs);
      const uniq = (xs: unknown[]) => [...new Set(xs.filter((x) => x != null).map(String))].sort();
      out.squads = uniq(seen.map((r) => r.squad));
      out.kinds = uniq(seen.map((r) => r.kind));
    }
    return out;
  }, root);
}

// GET /api/events/lists: what the event log's pickers offer, fetched apart from the 5 s page poll.
// `squads` are the squads with rows in scope plus the squads table's, `_studio` left out (the
// `studio` flag, and `studios` per project on a host-wide board, make that option); `group` is
// `live` while a squads row is not closed, else `closed`. `crew` is the picked squad's members that
// logged rows, by short name (a second one of the same name reads ` (2)`), `gone` when no live
// members row holds the worktree. `kinds` are the kinds in scope, `cats` the categories, `noise` the
// noise kinds.
export function eventsLists(o: { project?: string; squad?: string }, root = stateRoot()) {
  return withDb((db) => {
    const p = o.project || "";
    const seen = db.all(`SELECT DISTINCT project, squad, kind FROM events${p ? " WHERE (project = ? OR project IS NULL)" : ""}`, ...(p ? [p] : []));
    const status = new Map<string, string>(), key = (pr: unknown, sq: unknown) => `${pr ?? ""}\0${sq}`;
    const pairs = new Map<string, { project: string | null; squad: string }>();
    for (const r of db.all(`SELECT project, topic, status FROM squads${p ? " WHERE project = ?" : ""}`, ...(p ? [p] : []))) {
      status.set(key(r.project, r.topic), String(r.status ?? ""));
      pairs.set(key(r.project, r.topic), { project: r.project as string, squad: String(r.topic) });
    }
    const studios = new Set<string>();
    for (const r of seen) {
      if (r.squad == null || (p && r.project !== p)) continue;
      if (r.squad === "_studio") { studios.add(String(r.project ?? "")); continue; }
      pairs.set(key(r.project, r.squad), { project: (r.project as string) ?? null, squad: String(r.squad) });
    }
    const squads = [...pairs.entries()].filter(([, v]) => v.squad !== "_studio")
      .map(([k, v]) => ({ ...v, group: status.has(k) && status.get(k) !== "closed" ? "live" : "closed" }))
      .sort((a, b) => String(a.project ?? "").localeCompare(String(b.project ?? "")) || a.squad.localeCompare(b.squad));
    let crew: { wt: string; name: string; gone: boolean }[] = [];
    if (o.squad) {
      const at = p ? "project = ? AND squad = ?" : "squad = ?", atArgs = p ? [p, o.squad] : [o.squad];
      const live = new Set(db.all(`SELECT wt FROM members WHERE ${at} AND wt IS NOT NULL AND COALESCE(status, '') != 'gone' AND COALESCE(want, '') != 'gone'`, ...atArgs).map((r) => String(r.wt)));
      // A short key (`builder/u1-x`) folds into the worktree of its members row; one with no row stays alone.
      const byKey = new Map<string, string>();
      for (const r of db.all(`SELECT role, suffix, wt FROM members WHERE ${at} AND wt IS NOT NULL`, ...atArgs)) byKey.set(shortKey(r.role, r.suffix), String(r.wt));
      const folded = new Map<string, string>();
      for (const r of db.all(`SELECT member, MIN(project) AS project FROM events WHERE ${at} AND member IS NOT NULL GROUP BY member`, ...atArgs)) {
        const wt = byKey.get(String(r.member)) ?? String(r.member);
        if (!folded.has(wt)) folded.set(wt, String(r.project ?? ""));
      }
      crew = [...folded.entries()]
        .map(([wt, project]) => {
          const r = { project };
          // A worktree id reads as its short name; a role/slug key (`builder/u1-x`) as itself.
          return { wt, name: wt.includes("::") ? wtName(wt, o.squad, (r.project as string) || p) : wt, gone: !live.has(wt) };
        })
        .sort((a, b) => Number(a.gone) - Number(b.gone) || a.name.localeCompare(b.name) || a.wt.localeCompare(b.wt));
      const count = new Map<string, number>();
      for (const c of crew) {
        const n = (count.get(c.name) ?? 0) + 1;
        count.set(c.name, n);
        if (n > 1) c.name = `${c.name} (${n})`;
      }
    }
    return {
      squads,
      studio: studios.size > 0,
      studios: [...studios].sort(),
      crew,
      kinds: [...new Set(seen.map((r) => String(r.kind)))].sort(),
      cats: catList(),
      noise: [...NOISE],
    };
  }, root);
}

// GET /api/questions: a squad's answered questions, newest answer first (questions.ts list), 50 a page;
// `older` is the seq to pass as `before` for the next page, null at the end.
export function questionsPage(o: { project: string; squad: string; before?: number; limit?: number }, root = stateRoot()) {
  return withDb((db) => {
    const limit = Math.min(Math.max(Math.floor(o.limit ?? 50), 1), 200);
    const rows = list(db.s, o.project, o.squad, { before: o.before, limit: limit + 1 });
    // The squad's repo slug, for the answered questions' PR links (U87); "" until resolved.
    const st = squadDoc(db.s, o.project, o.squad) as any;
    const slug = repoSlug(db, o.project, String(st?.repo ?? ""));
    const byNum = new Map(slug ? db.all("SELECT * FROM observed_prs WHERE project = ? AND repo = ? AND pr IS NOT NULL", o.project, slug).map((p) => [String(p.pr), p]) : []);
    const aqpr = (v: unknown) => qprOf(byNum, slug, v);
    return {
      questions: rows.slice(0, limit).map((r) => ({ seq: Number(r.seq), id: r.id, asker: r.asker ?? null, title: r.title ?? null, question: r.question ?? null,
        answer: r.answer ?? null, via: r.answered_via ?? null, asked_at: r.asked_at ?? null, answered_at: r.answered_at ?? null,
        pr: aqpr(parse(String(r.doc))?.pr) })),
      older: rows.length > limit ? Number(rows[limit - 1].seq) : null,
    };
  }, root);
}

// U278 + U1 (unread-counts-mismatch): the message rows (U45) per receiver of one squad, counted with the shared
// predicates of messages.ts (UNREAD, WAITING, ENDED): mail to or from an ended member is shown, never counted.
// Counted from the rows alone, so a View never changes them; a loop.db before migration 0045 has no table and
// reads as none. Cached per db handle and squad for the one build.
type MsgCount = { unread: number; reply_due: number; ended: number };
const msgCache = new WeakMap<object, Map<string, Map<string, MsgCount>>>();
function msgCounts(db: Db, project: string, squad: string): Map<string, MsgCount> {
  let per = msgCache.get(db);
  if (!per) msgCache.set(db, (per = new Map()));
  const k = `${project}\0${squad}`;
  let m = per.get(k);
  if (m) return m;
  m = new Map();
  try {
    for (const r of db.all(`SELECT m.to_role, m.to_suffix, SUM(${UNREAD}) AS unread, SUM(${WAITING}) AS reply_due, SUM(${ENDED}) AS ended
      FROM messages m WHERE m.project = ? AND m.squad = ? GROUP BY m.to_role, m.to_suffix`, project, squad))
      m.set(`${r.to_role}\0${r.to_suffix ?? ""}`, { unread: Number(r.unread ?? 0), reply_due: Number(r.reply_due ?? 0), ended: Number(r.ended ?? 0) });
  } catch { /* no messages table yet */ }
  per.set(k, m);
  return m;
}
const msgTotals = (db: Db, project: string, squad: string) => {
  const all = [...msgCounts(db, project, squad).values()];
  return { unread: all.reduce((n, c) => n + c.unread, 0), reply_due: all.reduce((n, c) => n + c.reply_due, 0), ended: all.reduce((n, c) => n + c.ended, 0) };
};

// One message row as the board shows it (U278's Messages panel, U4's event log): who, what and when,
// without the body.
const msgTime = (v: unknown) => (v == null ? null : Number(v));
const msgName = (role: unknown, suffix: unknown) => String(role) + (suffix ? "-" + suffix : "");
function msgView(r: Row) {
  return {
    id: Number(r.id), subject: String(r.subject ?? ""), kind: String(r.kind ?? "message"),
    from: r.from_role ? msgName(r.from_role, r.from_suffix) : "unknown", to: msgName(r.to_role, r.to_suffix),
    sent_at: Number(r.sent_at), delivered_at: msgTime(r.delivered_at), read_at: msgTime(r.read_at), replied_at: msgTime(r.replied_at),
    needs_reply: r.needs_reply === 1, reply_due: r.needs_reply === 1 && r.replied_at == null && r.state !== "answered",
  };
}

// GET /api/messages: one member's messages (wt given) or the whole squad's, newest first, as stored. The counts
// (`unread`, `reply_due`, `ended`) cover all of the receiver's or squad's rows by SQL, never the 200-row page; each
// row has a `state` (unread, waiting, ended or null); `open: true` returns only the unread and waiting rows (at most
// 500). Read-only: a select, never read_at, delivered_at or an ack. {missing: true} when the member is not live.
export function messagesJson(o: { project: string; topic: string; wt?: string; open?: boolean }, root = stateRoot()) {
  return withDb((db) => {
    let who: Row | null = null;
    if (o.wt) { who = chatMember(db, o.project, o.topic, o.wt); if (!who) return { missing: true as const }; }
    const scope = who ? " AND m.to_role = ? AND m.to_suffix = ?" : "", args = who ? [String(who.role ?? ""), String(who.suffix ?? "")] : [];
    const state = `CASE WHEN ${UNREAD} THEN 'unread' WHEN ${WAITING} THEN 'waiting' WHEN ${ENDED} THEN 'ended' WHEN m.needs_reply = 1 AND ${ANSWERED} THEN 'answered' END`;
    let rows: Row[] = [], c: Row = {};
    try {
      c = db.one(`SELECT SUM(${UNREAD}) AS unread, SUM(${WAITING}) AS reply_due, SUM(${ENDED}) AS ended FROM messages m WHERE m.project = ? AND m.squad = ?${scope}`, o.project, o.topic, ...args) ?? {};
      rows = db.all(`SELECT * FROM (SELECT m.*, ${state} AS state, ${ANSWERED_BY} AS answered_by, CASE WHEN ${RECEIVER_RUNNING} THEN 'asker ended' ELSE 'to an ended member' END AS ended_why FROM messages m WHERE m.project = ? AND m.squad = ?${scope}) WHERE ${o.open ? "state IN ('unread', 'waiting')" : "1"}
        ORDER BY sent_at DESC, id DESC LIMIT ${o.open ? 500 : 200}`, o.project, o.topic, ...args);
    } catch { /* no messages table yet */ }
    return {
      unread: Number(c.unread ?? 0), reply_due: Number(c.reply_due ?? 0), ended: Number(c.ended ?? 0),
      messages: rows.map((r) => ({ ...msgView(r), body: String(r.body ?? ""), reply_to: msgTime(r.reply_to),
        state: r.state == null ? null : String(r.state), answered_by: r.state === "answered" ? (r.answered_by == null ? null : Number(r.answered_by)) : null, ended_why: r.state === "ended" ? String(r.ended_why) : null, waited_s: r.state === "unread" || r.state === "waiting" ? Math.max(0, clockNow() - Number(r.sent_at)) : null })),
    };
  }, root);
}

// The chat panel's member (crew-terminal-access U3): a live member of the squad, or for squad `_studio`
// the project's Studio worktree. null when there is none (the routes answer 404).
export function chatMember(store: Store | Db, project: string, topic: string, wt: string): Row | null {
  const db = store instanceof Db ? store : new Db(store);
  if (topic === "_studio") return studioWts(db).get(project) === wt ? { project, squad: topic, wt, role: "studio" } : null;
  return db.one(`SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? AND COALESCE(want, '') != 'gone'
    AND COALESCE(status, '') != 'gone' ORDER BY id DESC`, project, topic, wt) ?? null;
}

// Where one `chat` request is, for the panel: queued (with why), sent, turn started, not taken or failed.
// A send the agent only accepted is "sent" until poke.ts's verify settles its deliveries row.
// A send's text is redacted as its transcript turn is, so the two match and no secret is shown back.
// U4: a queued send also carries `age_s` (from created_at), `failing`, `now` (Send now asked), `gives_up_at`
// (the result's `since` + chat_queue_min, null while no clock runs: paused or behind an earlier chat) and `first`
// (the member's oldest queued send, the only one Send now applies to; set by chatJson). A cancelled result is state `cancelled`.
function chatSend(db: Db, r: Row, topic: string, now = Math.floor(Date.now() / 1000)) {
  const p = parse(String(r.payload ?? "")) ?? {}, res = parse(String(r.result ?? "")) ?? {};
  const files = (Array.isArray(p.files) ? p.files : []).filter((n: unknown): n is string => typeof n === "string" && CHAT_FILE_NAME.test(n))
    .map((name: string) => ({ name, url: chatFileUrl(String(r.project ?? ""), topic, name) }));
  const base = { id: Number(r.id), text: redact(String(p.text ?? "")), files, at: Number(r.created_at), done_at: r.done_at == null ? null : Number(r.done_at) };
  if (r.done_at == null) {
    const since = res.state === "queued" && res.since != null ? Number(res.since) : null;
    return { ...base, state: "queued", why: res.state === "queued" ? String(res.why ?? "") : "waiting for the loop", age_s: Math.max(0, now - Number(r.created_at)),
      failing: res.failing === true, now: p.now === true, first: false,
      gives_up_at: since == null ? null : since + ((v) => (v !== null && /^\d+$/.test(v) ? Number(v) : 30))(limit(db.s, String(r.project ?? ""), "chat_queue_min")) * 60 };
  }
  if (res.state === "cancelled") return { ...base, state: "cancelled", why: null };
  if (res.ok === false) return { ...base, state: "failed", why: String(res.error ?? "the loop refused it") };
  if (res.state === "turn started") return { ...base, state: "turn started", why: null };
  const d = res.delivery == null ? null : db.one("SELECT state FROM deliveries WHERE id = ?", Number(res.delivery));
  const state = d?.state === "verified" ? "turn started" : d?.state === "escalated" ? "not taken" : "sent";
  return { ...base, state, why: state === "not taken" ? "typed, but no turn started" : null };
}

// The chat panel's member switcher (chat-role-switcher U1): the squad's live members `chatMember` accepts, in the
// Crew box's order (member rows by id, one per worktree), each with the box's mail counts (`msgCounts`) and
// `reply_at`, the time of the newest assistant text turn in its observed_chat row (null: none, gone or a screen
// tail). One members read and one observed_chat read for the squad. `[]` for the Studio.
function chatCrew(db: Db, project: string, topic: string) {
  if (topic === "_studio") return [];
  const seen = new Set<string>(), live: Row[] = [];
  for (const m of db.all(`SELECT * FROM members WHERE project = ? AND squad = ? AND wt IS NOT NULL AND COALESCE(want, '') != 'gone'
    AND COALESCE(status, '') != 'gone' ORDER BY id`, project, topic)) {
    const wt = String(m.wt);
    if (seen.has(wt)) continue;
    seen.add(wt); live.push(m);
  }
  const chats = new Map<string, Row>();
  try { for (const c of db.all("SELECT wt, source, turns, gone_at FROM observed_chat WHERE project = ?", project)) chats.set(String(c.wt), c); }
  catch { /* loop.db before migration 0044 */ }
  const counts = msgCounts(db, project, topic);
  const asks = new Map<string, number>();
  for (const q of chatQuestionsAll(db, project, topic)) if (q.wt) asks.set(String(q.wt), (asks.get(String(q.wt)) ?? 0) + 1);
  return live.map((m) => {
    const c = chats.get(String(m.wt)), n = counts.get(`${m.role ?? ""}\0${m.suffix ?? ""}`);
    let reply_at: number | null = null;
    if (c && c.gone_at == null && c.source !== "screen")
      for (const t of arr(parse(String(c.turns ?? "[]"))))
        if (t?.role === "assistant" && !t.tool && t.at != null && Number.isFinite(Number(t.at)) && (reply_at == null || Number(t.at) > reply_at)) reply_at = Number(t.at);
    return { wt: String(m.wt), label: (m.role ?? "") + (m.suffix ? "-" + m.suffix : ""), role: m.role ?? null, unread: n?.unread ?? 0, reply_due: n?.reply_due ?? 0, reply_at, asks: asks.get(String(m.wt)) ?? 0 };
  });
}

// Board chat U19b: the option count of a numbered menu at the bottom of a screen (a Claude permission prompt,
// the folder-trust prompt), else 0. The last run of option lines numbered 1, 2, 3… within the last 25 non-blank
// lines counts, and only when one of them carries the selection marker; a numbered list in plain output has none.
export function menuOptions(tail: string): number { return menuText(tail).count; }

// The same scan with the menu's text (the Question view): `options` are the last run's labels with the marker and
// number stripped, `prompt` the up to 4 non-blank lines just above the run (the question the menu asks).
export function menuText(tail: string): { count: number; prompt: string[]; options: string[] } {
  const lines = tail.split("\n").filter((l) => l.trim() !== "").slice(-25);
  let run: { mark: boolean; label: string; at: number }[] = [];
  let last: typeof run = [];
  lines.forEach((l, at) => {
    const m = /^\s*([❯>›▶»])?\s*(\d{1,2})\.\s+(\S.*)$/.exec(l);
    if (!m) return;
    if (Number(m[2]) === 1) run = [];
    if (Number(m[2]) === run.length + 1) { run.push({ mark: !!m[1], label: m[3].trim(), at }); last = run.slice(); }
  });
  if (last.length < 2 || !last.some((o) => o.mark)) return { count: 0, prompt: [], options: [] };
  const prompt = lines.slice(Math.max(0, last[0].at - 4), last[0].at).map((l) => l.trim());
  return { count: last.length, prompt, options: last.map((o) => o.label) };
}

// What a prompt in a terminal is about, on the entries that carry it (picker-hook.sh permission): the
// text a card draws as a code block, where it runs and which helper agent asks. Absent fields are left out.
function shownFields(x: any): Record<string, string> {
  return Object.fromEntries(["picker_kind", "shown", "agent", "cwd"].filter((k) => typeof x?.[k] === "string" && x[k]).map((k) => [k, x[k]]));
}

// The open questions whose card opens a chat with this member (the cards' chat_wt rule in squad(): the card's
// worktree, else the Lead's), as the Question view shows them. Blocking first, then oldest first. [] for the Studio.
function chatQuestionsAll(db: Db, project: string, topic: string) {
  if (topic === "_studio") return [];
  let st: any = null;
  try { st = squadDoc(db.s, project, topic); } catch { return []; }
  if (!st || typeof st !== "object") return [];
  const leadWt = arr(st.members).find((m: any) => m?.role === "lead")?.wt ?? null;
  const slug = repoSlug(db, project, String(st.repo ?? "")) || null;
  return arr(st.waiting_on_you).map((x: any) => ({
      wt: (typeof x.card_wt === "string" && x.card_wt) || (typeof st.lead_wt === "string" && st.lead_wt) || leadWt || null,
      id: x.id ?? null, title: String(x.title ?? shortTitle(String(x.question ?? ""), x.id ?? null)), question: redact(String(x.question ?? "")),
      choices: (arr(x.choices).length ? arr(x.choices) : (arr(x.options).length ? arr(x.options) : x.suggestion ? [x.suggestion] : []).map((l: any) => ({ label: String(l), does: null })))
        .map((c: any) => ({ label: redact(String(c?.label ?? "")), does: c?.does ? redact(String(c.does)) : null })),
      since: x.since ?? null, blocking: x.blocking === true, source: x.source ?? null, answerable: !(x.source === "picker" && x.picker_answerable !== true),
      // The suggestion is redacted as the labels are, so the Question view can match it to its option.
      suggestion: x.suggestion == null ? null : redact(String(x.suggestion)), why: x.why == null ? null : redact(String(x.why)),
      repo_slug: slug, doc: linkedDoc(db, project, topic, x),
      ...(typeof x.shown === "string" ? redactDeep({ ...shownFields(x), asker: String(x.asker ?? "") }) : {}),
    })).sort((a: any, b: any) => (a.blocking ? 0 : 1) - (b.blocking ? 0 : 1) || String(a.since ?? "").localeCompare(String(b.since ?? "")));
}
function chatQuestions(db: Db, project: string, topic: string, wt: string) {
  return chatQuestionsAll(db, project, topic).filter((q: any) => q.wt === wt).map(({ wt: _w, ...q }: any) => q);
}

// GET /api/chat: one member's recent turns (observed_chat, redacted and capped by the loop) and its last
// 10 chat requests, newest last. U19: `screen` {tail, at, age_s} is the loop's newest screen read (redacted
// by the loop): observed_workers.tail by worktree, the Studio's observed_terminals.tail by its adopted handle;
// null when none. Nothing else: no transcript, file or terminal is read here. null: no loop.db;
// {missing: true}: no such live member.
export function chatJson(o: { project: string; topic: string; wt: string }, root = stateRoot()) {
  return withDb((db) => {
    const m = chatMember(db, o.project, o.topic, o.wt);
    if (!m) return { missing: true as const };
    let c: Row | null = null;
    try { c = db.one("SELECT agent, source, turns, updated_at, gone_at FROM observed_chat WHERE project = ? AND wt = ?", o.project, o.wt) ?? null; }
    catch { /* loop.db before migration 0044: no turns yet */ }
    // chat-multiline-send-fails U2: a dismissed send (`dismissed_at` in its result, set by fulfil/chat.ts) is left out, so it is gone on every device
    const sends = db.all("SELECT id, project, payload, result, created_at, done_at FROM requests WHERE kind = 'chat' AND project = ? AND member = ? AND COALESCE(json_extract(CASE WHEN json_valid(result) THEN result END, '$.dismissed_at'), 0) = 0 ORDER BY id DESC LIMIT 10",
      o.project, o.wt).reverse().map((r) => chatSend(db, r, o.topic) as ReturnType<typeof chatSend> & { first?: boolean });
    const firstQueued = sends.find((x) => x.state === "queued");
    if (firstQueued) firstQueued.first = true;
    // Mid-turn, as the board's crew row reads it (observed_workers.state), for the panel's "Working…" line.
    const w = db.one("SELECT state, gone_at, tail, tail_at FROM observed_workers WHERE project = ? AND wt = ?", o.project, o.wt);
    const t = o.topic === "_studio" ? db.one(`SELECT t.tail, t.tail_at FROM observed_terminals t JOIN members m ON m.project = t.project AND m.handle = t.handle
      WHERE t.project = ? AND t.gone_at IS NULL AND m.squad = '_studio' AND m.role = 'studio' ORDER BY m.id DESC`, o.project) : w?.gone_at == null ? w : null;
    const now = Math.floor(Date.now() / 1000), tailAt = t?.tail_at == null ? null : Number(t.tail_at);
    return {
      crew: chatCrew(db, o.project, o.topic),
      agent: (c?.agent as string | null) ?? (m.agent as string | null) ?? null, source: (c?.source as string | null) ?? null,
      turns: c && c.gone_at == null ? (parse(String(c.turns ?? "[]")) ?? []) : [], updated_at: c?.updated_at == null ? null : Number(c.updated_at),
      working: w?.gone_at == null && w?.state === "working", sends, questions: chatQuestions(db, o.project, o.topic, o.wt),
      screen: t && t.tail != null ? { tail: String(t.tail), ...((x) => ({ menu: x.count, prompt: x.prompt, options: x.options }))(menuText(String(t.tail))), at: tailAt, age_s: tailAt == null ? null : Math.max(0, now - tailAt) } : null,
    };
  }, root);
}

// GET /api/stream: the events after `after` (null: none, just the newest id), oldest first, scoped as
// eventsPage scopes them; `last` is the newest id in the project's log.
export function eventsAfter(project: string, after: number | null, limit: number, root = stateRoot()) {
  return withDb((db) => {
    const scope = project ? "(project = ? OR project IS NULL)" : "1", args = project ? [project] : [];
    const last = Number(db.one(`SELECT MAX(id) AS id FROM events WHERE ${scope}`, ...args)?.id ?? 0);
    const rows = after == null ? [] : db.all(`SELECT * FROM events WHERE ${scope} AND id > ? ORDER BY id ASC LIMIT ?`, ...args, after, limit);
    return { last, events: rows.map((e) => ({ id: e.id, at: e.at, project: e.project, squad: e.squad, unit: e.unit, member: e.member, kind: e.kind, payload: parse(e.payload) ?? e.payload })) };
  }, root);
}

// The Lavish review page of a session key (observed_sessions), for GET /lavish/<key>.
export function lavishUrl(key: string, root = stateRoot()): string | null {
  return withDb((db) => {
    const r = db.all("SELECT url, doc FROM observed_sessions WHERE url IS NOT NULL ORDER BY rowid").find((x) => parse(x.doc)?.key === key);
    return r ? String(r.url) : null;
  }, root);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let project = "", topic = "", asJson = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") asJson = true;
    else if (args[i] === "--topic") topic = args[++i] ?? "";
    else project = args[i];
  }
  const b = buildBoard(project, topic);
  process.stdout.write(asJson ? JSON.stringify(b) + "\n" : renderText(b));
}
