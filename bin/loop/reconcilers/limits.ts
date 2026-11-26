// limits.ts — usage limits (U8): the removed sweep step 3 with every sweep-required limit fix, as one
// reconciler that owns the `limited` fact the others consult (Bun). U154: it only detects and
// records; the move is the decider's (switches.ts: another place with room stops the member when
// idle, nowhere to go tells it once).
//
// A member is LIMITED when, for its worker (observed_workers):
//   its screen tail shows a limit notice (limits/fingerprints.ts scan(): the dialog, a weekly or
//     5-hour notice, an aggregator-pool 429), or
//   it is not busy and its account is at limit_pct (100) in observed_accounts: session (only an
//     account that has a 5-hour window: no session pct = none, plan e12), or weekly on a Claude or Muse
//     account (account-wide, every claude model).
//   A `working` worker counts only with the dialog on screen or SILENT_MIN (10) of silence. A
//   dialog whose reset passed (or, with no clock time, whose until passed) is no longer a limit.
// A limited member gets, once per change:
//   members.limited_until and observed_workers.limited (`<reset|->\t<notice>[\tdialog]`), which
//     wake() reads: no informational poke reaches it (sweep-required U16). A pool notice stamps
//     only observed_workers.limited: limited_until takes the account out of every pick, and a
//     pool 429 is not the account's limit (main #138, accounts-refresh.sh);
//   a `limited` episode (subject wt): episode_key `<agent>/<account>|<notice>`, state = the kind
//     (dialog|pool|weekly|notice|usage), started_at first seen, ended_at until;
//   U63: a reset known and within limit_wait_max (30) minutes is waited out instead: no stop, no
//     tell, one `limit_wait` event, and one poke after the reset (shortWait / endWait);
//   its `switching` listing while a decider limit stop is in flight (loop/limited.json, the board).
// A member whose recorded account is no longer listed (pick.ts accountList: a fresh list without it;
// no account or `system` always counts as listed) is treated as limited once it isn't working or
// waiting on an ask, with or without a notice: kind `gone`.
//   The Studio is picked for role `studio`. With studio_move auto (or ask, once its card's "move it"
//   was answered) and an adopted handle, a pick with room becomes one `studio-move` action once
//   studioReady() holds (U264, fulfil/studio.ts: that tab closed, a fresh one opened on the pick).
//   A Studio whose account is switched off (U5, kind `disabled`, like `gone`: no reset, no stamp) moves
//   the same way.
//   configurable-role-elevation U3: a Studio that is not limited, whose `studio` roster row resolves `up`
//   (column 8) and that runs on a lower rung of its ladder than the studio pick, is moved back up the same
//   way (backUp below): auto once studioReady() holds, ask after its own "move it" card (subject studio.up),
//   off never; at most once per fallback_return_min, and never with a "held" card.
//   Otherwise one `alert` per continuous account/notice condition (payload.kind out_of_credits)
//   naming the next pick or wait, cleared when it clears.
// U4 (provider-billing-fallback): an account out of credits with a member stuck on it (nowhere else to
// go) gets one Needs-you card per account, from the workers looked at here (credits-card.ts).
// claude-login-ended U2: an account whose login ended (login.ts: the probe's `login ended` note, or
// Claude's `· Please run /login` line on a screen, kind `login`) is held host-wide; every member on it,
// the Studio too, reads limited (kind `login`, no reset) while the hold lives, and moves like one.
// The episode rows replace the sweep's .limit/.switch markers; loop/limited.json is
// exported from them every tick for the board.
import { alertId, alertPrefix } from "../core/actuator.ts";
import { paused } from "../pause/pause.ts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { wake } from "../pause/wake.ts";
import { scan, type LimitRow } from "../capacity/fingerprints.ts";
import { limit, limitInt } from "../settings/limits.ts";
import { accountList, ladder, overrideOf, pick as pickAccount, placeRung, sameModel, workDone } from "../capacity/pick.ts";
import { defaultFromRows, type AccountRow } from "../../lib/account-dirs.ts";
import { backUpOf } from "../settings/roster.ts";
import { liveAccount, liveOf } from "./record.ts";
import { liveSquads } from "./liveness.ts";
import { MOVE, STUDIO_SQUAD, studioReady, studioRestartCmd, studioView } from "../squad/studio.ts";
import { creditsHoldS, holdCredits, probeCredits } from "../capacity/credits.ts";
import { heldNotice, holdLogin, isLoginKey, loginHold, LOGIN_HOLD_S, loginTold, probeLogin } from "../capacity/login.ts";
import { creditsCards } from "../capacity/credits-card.ts";
import { loginCards } from "../capacity/login-card.ts";
import { accountDisabled } from "../capacity/accounts.ts";

export type Place = { plan?: string | null; agent: string; model: string; effort: string; account: string; fallback: boolean; rung?: number; reason?: string; why?: string };
export type Pick = Place | { wait: number } | null;
export type PickArgs = { project: string; squad: string; role: string; tier?: string | null; phase?: string | null; suffix: string; member?: number; limited?: { agent: string; account: string; until: number };
  keep?: { agent: string; model: string; account: string; plan?: string | null } };
export type Picker = (a: PickArgs, ctx: TickCtx) => Pick;

// The loop's picker (bin/loop/capacity/pick.ts, U9), in-process and from rows only.
export const pickLoop: Picker = (a, ctx) => {
  const r = pickAccount(ctx.store, { project: a.project, role: a.role, tier: a.tier ?? null, phase: a.phase ?? null, squad: a.squad || null, member: a.member ?? null,
    limited: a.limited?.account ? [`${a.limited.agent}:${a.limited.account}=${a.limited.until}`] : [],
    ...(a.keep ? { keep: a.keep } : {}) }, ctx.now);
  if ("error" in r) return null;
  if ("wait" in r) return { wait: r.wait };
  return { plan: r.plan, agent: r.agent, model: r.model, effort: r.effort ?? "-", account: r.account ?? "-", fallback: r.fallback, rung: r.rung, reason: r.reason, why: r.why };
};

const isPlace = (p: Pick): p is Place => !!p && "agent" in p;
const pct = (v: unknown) => (typeof v === "string" && /^[0-9]+(\.[0-9]+)?$/.test(v) ? Number(v) : typeof v === "number" ? v : null);
const epoch = (v: unknown) => (v != null && /^[0-9]+$/.test(String(v)) ? Number(v) : null);
const hhmm = (t: number) => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

export type Worker = { m: Row | null; wt: string; state: string; since: number | null; lastOutput: number | null; tail: string; ow: Row;
  squad: string; role: string; suffix: string; who: string; key: string; agent: string; account: string; model: string; expired?: boolean; cleared?: boolean };
// `probe`: a login limit read off the account's hold, not off this worker's screen (loginOf).
type Limit = { reset: number | null; notice: string; dialog: boolean; kind: string; link?: string; probe?: true };
export type Listed = { wt: string; who: string; topic: string; line: string; since: number; wait_until?: number; switching?: true };

export function makeLimits(opts: { pick?: Picker } = {}): Reconciler {
  const pick = opts.pick ?? pickLoop;
  return { name: "limits", run: (ctx) => run(ctx, pick) };
}
export default makeLimits();

const confNum = (s: Store, p: string, k: string, d: number) => { const v = Number(limit(s, p, k)); return Number.isFinite(v) && v > 0 ? v : d; };

function run(ctx: TickCtx, pick: Picker): Action[] {
  const { store, project: P, now: t } = ctx;
  const S = {
    limitPct: confNum(store, P, "limit_pct", 100),
    silentMin: envInt("DS_SWEEP_SILENT_MIN", 10), limitS: envInt("DS_ACCOUNTS_LIMIT_S", 3600),
    limitWaitMin: limitInt(store, P, "limit_wait_max", 30), creditsS: creditsHoldS(store, P),
    live: new Set(liveSquads(store, P).map((s) => String(s.topic))),
  };
  const actions: Action[] = [], listed: Listed[] = [], running: { w: Worker; studio: boolean }[] = [];
  // U2: an account whose usage probe notes `out of credits` is held before any member fails on it.
  try { probeCredits(store, P, t); } catch (e) { store.event("plugin_error", { project: P, payload: { plugin: "limits", at: "credits-probe", error: (e as Error)?.message ?? String(e) } }); }
  // claude-login-ended U2: and one whose probe notes `login ended`.
  try { probeLogin(store, P, t); } catch (e) { store.event("plugin_error", { project: P, payload: { plugin: "limits", at: "login-probe", error: (e as Error)?.message ?? String(e) } }); }
  const proj = store.get("projects", { label: P });
  const studioWt = (proj?.studio_wt as string) || "";
  const members = store.db.query(`SELECT * FROM members WHERE project = ? AND wt IS NOT NULL AND wt != '' AND COALESCE(status, '') != 'gone'
    ORDER BY squad, role != 'lead', role != 'thinker', id`).all(P) as Row[];
  // A throw is logged and costs only its own member: the state the others' actions rest on (a poke
  // counted, a request withdrawn) is already written, so their actions must still go out.
  const guarded = (what: string, fn: () => void) => {
    try { fn(); } catch (e) { store.event("plugin_error", { project: P, payload: { plugin: "limits", at: what, error: (e as Error)?.message ?? String(e) } }); }
  };
  for (const m of members) {
    if (m.wt === studioWt) continue;
    guarded(String(m.wt), () => {
      const w = worker(store, P, m, String(m.wt), null, t);
      if (!w) return;
      if (paused(store, m as { project: string })) return;
      // Finished work only counts while still working (the sweep never restarts it).
      if (w.state !== "working" && workDone(store, m)) { close(ctx, w); return; }
      running.push({ w, studio: false });
      member(ctx, w, S, actions, listed);
    });
  }
  if (studioWt) guarded(studioWt, () => {
    const w = worker(store, P, store.db.query("SELECT * FROM members WHERE wt = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC").get(studioWt) as Row | null, studioWt, proj, t);
    if (!w) return;
    running.push({ w, studio: true });
    studio(ctx, w, S, pick, actions, listed);
  });
  // U4: one Needs-you card per account out of credits that still has a member stuck on it (credits-card.ts).
  guarded("credits-card", () => { actions.push(...creditsCards(ctx, pick, running)); });
  // claude-login-ended U3: one Needs-you card per account whose login ended with a member on it (login-card.ts).
  guarded("login-card", () => { actions.push(...loginCards(ctx, pick, running)); });
  guarded("limited.json", () => exportLimited(store.root, P, listed));
  return actions;
}

// `now` is the tick time: a reading the observer stopped refreshing ages against it, not against its own row.
export function worker(store: Store, P: string, m: Row | null, wt: string, proj?: Row | null, now?: number): Worker | null {
  const ow = store.db.query("SELECT rowid AS _rowid, * FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(P, wt) as Row | null;
  if (!ow?.state) return null;
  // The adopted Studio's member row (U261, squad _studio) keeps the Studio's card keys and squad-less actions.
  const crew = !!m && m.squad !== STUDIO_SQUAD;
  const squad = crew ? String(m!.squad ?? "") : "", role = String(m?.role ?? "studio"), suffix = String(m?.suffix ?? "");
  let agent = (m?.agent as string) || "", model = (m?.model as string) || "";
  if (!m) {
    // A legacy Studio was launched as Claude by up.sh. The editable Lead row
    // describes its next start, not the Studio's running agent (U8).
    const doc = (() => { try { return JSON.parse(String(proj?.doc ?? "{}")); } catch { return {}; } })();
    const row = String((store.db.query("SELECT value FROM config WHERE file = 'roles.conf' AND key = 'lead' AND project IN (?, '') ORDER BY project = '' LIMIT 1").get(P) as Row | null)?.value ?? "").split(/\s+/);
    agent = doc.studio_agent || doc.agent || "claude";
    model = doc.studio_model || doc.model || (row[0] === agent ? row[1] : "") || "";
  }
  // U149: the main agent the walk found (record.ts liveOf) is what runs; the record is its launch. On
  // another agent than the record its model is the live one, or unknown ("").
  const live = liveOf(ow, now);
  if (live && live.agent !== agent) { agent = live.agent; model = live.model ?? ""; }
  else if (live?.model && !(model && sameModel(model, live.model))) model = live.model;
  agent ||= "claude";
  const account = live?.account || (m?.account as string) || defaultAccount(store, agent);
  const who = crew ? `${role}${suffix ? `-${suffix}` : ""}` : "studio";
  return { m, wt, ow, state: String(ow.state), since: epoch(ow.since), lastOutput: epoch(ow.last_output_at), tail: String(ow.tail ?? ""),
    squad, role, suffix, who, key: crew ? `${squad}.${who}` : "studio", agent, account, model };
}

// The account of a worker none is recorded for: dev-studio's default for its agent (`ds account default`).
function defaultAccount(store: Store, agent: string): string {
  return defaultFromRows(store.db.query("SELECT * FROM accounts WHERE agent = ?").all(agent) as AccountRow[], agent).account;
}

const silent = (w: Worker, t: number, min: number) => w.state === "working" && w.lastOutput !== null && t - w.lastOutput >= min * 60;

// usage_for: the account at `max` — session (when it has a 5-hour window), or weekly on Claude or Muse.
// A working worker counts only when silent (stuck on the dialog, not busy).
export function usageFor(store: Store, w: Worker, max: number, t: number, silentMin: number): Limit | null {
  if (!["idle", "done", "waiting", "working"].includes(w.state) || (w.state === "working" && !silent(w, t, silentMin))) return null;
  const a = store.get("observed_accounts", { agent: w.agent, account: w.account });
  if (!a) return null;
  const s = pct(a.session_pct), wk = pct(a.weekly_pct);
  const sr = epoch(a.session_reset), wr = epoch(a.weekly_reset);
  const session = s !== null && s >= max && (sr === null || sr > t);
  const weekly = ["claude", "muse"].includes(w.agent) && wk !== null && wk >= max && (wr === null || wr > t);
  // Both windows can block the account: the earlier reset cannot make it usable.
  if (weekly && (!session || (wr ?? 0) >= (sr ?? 0))) return { reset: wr, notice: `account ${w.account} at ${a.weekly_pct}% (weekly)`, dialog: false, kind: "usage" };
  if (session) return { reset: sr, notice: `account ${w.account} at ${a.session_pct}% (session)`, dialog: false, kind: "usage" };
  return null;
}

function kindOf(r: LimitRow): string {
  return r.kind === "credits" || r.kind === "login" ? r.kind : r.dialog ? "dialog" : /429|cooling down/i.test(r.notice) ? "pool" : /weekly/i.test(r.notice) ? "weekly" : "notice";
}

// The notices accounts-refresh.sh's skip list calls the pool's, not the account's. Not kindOf's
// `pool`: that also labels a bare `API Error: 429`, which accounts-refresh treats as a real limit.
const POOL_NOTICE = /Request rejected \(429\)|All credentials.*cooling down/;

// The until accounts-refresh keyed for this wt|notice (host-wide episode), when it has one.
function accountUntil(store: Store, wt: string, notice: string): number | null {
  return epoch(store.get("episodes", { project: "", subject: `${wt}|${notice}`, kind: "account" })?.ended_at);
}

// The worker's limit now, or null. Also asks the Orca observer to re-read a silent working
// worker's screen (its state and tokens stand still while it sits on the dialog).
function limitOf(ctx: TickCtx, w: Worker, S: { limitPct: number; silentMin: number }): Limit | null {
  const { store, now: t } = ctx;
  const r = scan(w.tail, { agent: w.agent, state: w.state, since: w.since, lastOutput: w.lastOutput, now: t, silentMin: S.silentMin });
  if (!r && silent(w, t, S.silentMin) && Number(w.ow.tail_at ?? 0) <= Number(w.lastOutput ?? 0) + S.silentMin * 60 && !w.ow.suspect) {
    store.setIf("observed_workers", Number(w.ow._rowid), "suspect", 1, w.ow.suspect ?? null);
  }
  if (r) {
    const lim = { ...r, kind: kindOf(r) };
    if (lim.kind === "credits" || lim.kind === "login") {
      // U2: the operator (or the probe) cleared this account while the notice is still on screen: the
      // old notice stays cleared; a new billing line (another request_id) opens a new episode. Same for
      // an ended login's line (claude-login-ended U2).
      const ep = store.get("episodes", { project: ctx.project, subject: w.wt, kind: "limited" });
      if (ep?.source === "loop" && ep.state === "cleared" && ep.episode_key === `${w.agent}/${w.account}|${lim.notice}`) { w.cleared = true; return null; }
      return lim;
    }
    if (lim.dialog) {
      if (lim.reset !== null && lim.reset <= t) return null;
      const key = { project: ctx.project, subject: w.wt, kind: "limited" }, ep = store.get("episodes", key);
      const own = lim.reset === null && ep?.source === "loop" && ep.state !== "closed" && ep.episode_key === `${w.agent}/${w.account}|${lim.notice}`;
      const acct = accountUntil(store, w.wt, lim.notice), until = acct ?? (own ? epoch(ep.ended_at) : null);
      if (until !== null && until <= t) {
        // Expired on its own until: it stays expired (not re-limited) while the dialog stays on
        // screen, so the stuck agent goes on to the hung path (U11) instead of an hourly re-limit.
        if (acct === null && ep!.state !== "expired") {
          store.fact("limit_expired", [{ table: "episodes", key, set: { state: "expired", observed_at: t } }],
            { project: ctx.project, squad: w.squad || null, member: w.wt, payload: { episode: ep!.episode_key } });
        }
        w.expired = acct === null;
        return null;
      }
    }
    return lim;
  }
  return usageFor(store, w, S.limitPct, t, S.silentMin);
}

// Its account (the live one when known, else the record's) is no longer on the agent's list. No
// account, or `system`, counts as listed.
function onRemoved(store: Store, w: Worker, t: number): boolean {
  const account = w.m ? w.account : "";
  if (!account || account === "system") return false;
  const list = accountList(store, w.agent, t);
  return !!list && !list.has(account);
}

function goneOf(ctx: TickCtx, w: Worker): Limit | null {
  return w.state !== "working" && w.state !== "waiting" && onRemoved(ctx.store, w, ctx.now) ? { reset: null, notice: `account ${w.m!.account} is no longer listed`, dialog: false, kind: "gone" } : null;
}

// claude-login-ended U2: the account it runs on has a live login hold (login.ts) and its own screen shows
// no login line: it reads limited all the same, with no reset, so it moves off the account.
function loginOf(ctx: TickCtx, w: Worker): Limit | null {
  const account = w.m ? liveAccount(w.ow, w.m, ctx.now) : w.account;
  if (!account || account === "-" || loginHold(ctx.store, w.agent, account, ctx.now) === null) return null;
  return { reset: null, notice: heldNotice(w.agent, account), dialog: false, kind: "login", probe: true };
}

// A login episode cleared (login.ts clearLogin) whose "works again" tell has not gone out yet is kept
// `cleared` for an hour, so the decider can send it (switches.ts okKey); the screen keeps one with its
// line on screen anyway (limitOf).
function keepLoginCleared(ctx: TickCtx, w: Worker): void {
  const ep = ctx.store.get("episodes", { project: ctx.project, subject: w.wt, kind: "limited" });
  if (ep?.state === "cleared" && isLoginKey(ep.episode_key) && ctx.now - Number(ep.ended_at ?? 0) < LOGIN_HOLD_S
    && !loginTold(ctx.store, ctx.project, w.wt, ep)) w.cleared = true;
}

// provider-billing-fallback U5: the Studio's account is switched off (accounts.ts). Read like `gone`:
// no reset and no stamp, so the account is held only by its switch, and it ends when it is switched on.
function disabledOf(ctx: TickCtx, w: Worker): Limit | null {
  if (w.state === "working" || w.state === "waiting" || !w.m) return null;
  const account = liveAccount(w.ow, w.m, ctx.now);
  return account && accountDisabled(ctx.store, w.agent, account)
    ? { reset: null, notice: `account ${w.agent}/${account} is switched off`, dialog: false, kind: "disabled" } : null;
}

const accountLimitKey = (agent: string, account: string) => ({ project: "", subject: `limit|${agent}/${account}`, kind: "account" });

// Opens (or keeps) the limited episode, stamps limited_until / observed_workers.limited; returns its
// until and first-seen (which keys the Studio's alert, so a recurrence alerts again).
// U2: a billing error (kind credits) holds the account for credits_hold_h from first seen (no reset, and
// not accounts-refresh's one-hour guess), host-wide as `credits|<agent>/<account>` (credits.ts). A later
// billing line on the same member, while its credits episode is open, is the same hold: the episode
// takes the new notice and keeps its start.
// claude-login-ended U2: an ended login (kind login) holds the account through login.ts, renewed while its
// line stays on screen (a limit read off the hold, `probe`, renews nothing); the episode's until is the
// hold's end. Its line and the hold's notice on the same account are one episode, as for credits.
function open(ctx: TickCtx, w: Worker, lim: Limit, S: { limitS: number; creditsS: number }): { until: number; first: number } {
  const { store, project: P, now: t } = ctx;
  const key = { project: P, subject: w.wt, kind: "limited" }, ek = `${w.agent}/${w.account}|${lim.notice}`;
  const ep = store.get("episodes", key);
  const credits = lim.kind === "credits", login = lim.kind === "login";
  const same = ep && ep.state !== "closed" && ep.state !== "expired" && ep.state !== "cleared"
    && (ep.episode_key === ek || ((credits || login) && ep.state === lim.kind && Number(ep.ended_at ?? 0) > t && String(ep.episode_key ?? "").startsWith(`${w.agent}/${w.account}|`)));
  const first = same ? Number(ep.started_at ?? t) : t;
  const acct = w.account && w.account !== "-" ? w.account : null;
  if (login && !lim.probe && acct) holdLogin(store, { agent: w.agent, account: acct, from: "screen", project: P, notice: lim.notice }, t);
  const until = credits ? first + S.creditsS
    : login ? (acct ? loginHold(store, w.agent, acct, t) : null) ?? t + LOGIN_HOLD_S
    : accountUntil(store, w.wt, lim.notice) ?? lim.reset ?? first + S.limitS;
  if (same && ep.episode_key !== ek) store.upsert("episodes", key, { episode_key: ek, observed_at: t });
  if (!same) {
    store.fact("limited", [{ table: "episodes", key, set: { squad: w.squad || null, started_at: t, ended_at: until, count: 1, state: lim.kind, episode_key: ek, source: "loop", observed_at: t, picked: null } }],
      { project: P, squad: w.squad || null, member: w.wt, payload: { kind: lim.kind, account: `${w.agent}/${w.account}`, notice: lim.notice, until, ...(lim.link ? { link: lim.link } : {}) } });
  } else if (Number(ep.ended_at) !== until || ep.state !== lim.kind) {
    store.upsert("episodes", key, { ended_at: until, state: lim.kind, observed_at: t });
  }
  const stamp = POOL_NOTICE.test(lim.notice) || lim.kind === "gone" || lim.kind === "disabled" ? null : until;
  // A worker moving away does not reset the account's allowance. Keep the block host-wide,
  // even if usage becomes unknown and the member's limited episode closes on its new account.
  // An ended login is held by login.ts (above), not by a stamp here.
  if (credits && stamp > t && w.account && w.account !== "-") {
    holdCredits(store, { agent: w.agent, account: w.account, until: stamp, from: "screen", project: P, notice: lim.notice, link: lim.link }, t);
  } else if (!login && stamp && stamp > t && lim.kind !== "pool" && w.account && w.account !== "-") {
    const acctKey = accountLimitKey(w.agent, w.account);
    const prev = store.get("episodes", acctKey);
    if (!prev || stamp > Number(prev.ended_at ?? 0)) {
      store.upsert("episodes", acctKey, { state: `${w.agent}/${w.account}`, ended_at: stamp,
        started_at: Number(prev?.ended_at ?? 0) > t ? prev!.started_at : t, source: "loop", observed_at: t });
    }
  }
  if (w.m && Number(w.m.limited_until ?? 0) !== (stamp ?? 0)) store.setIf("members", Number(w.m.id), "limited_until", stamp, w.m.limited_until ?? null);
  const row = `${lim.reset ?? "-"}\t${lim.notice}${lim.dialog ? "\tdialog" : ""}`;
  if (w.ow.limited !== row) store.setIf("observed_workers", Number(w.ow._rowid), "limited", row, w.ow.limited ?? null);
  return { until, first };
}

// The limit is over: close the episode, clear the stamps, lift a park. True when one was open.
// Host-wide `account` episodes (imported .accounts.episodes) whose notice is off the screen are
// dropped, as accounts-refresh did: a later recurrence of the same notice gets a fresh until.
function close(ctx: TickCtx, w: Worker): boolean {
  const { store, project: P, now: t } = ctx;
  for (const a of store.db.query("SELECT rowid AS r, subject FROM episodes WHERE project = '' AND kind = 'account' AND substr(subject, 1, ?) = ?").all(w.wt.length + 1, `${w.wt}|`) as { r: number; subject: string }[]) {
    if (!w.tail.includes(a.subject.slice(w.wt.length + 1))) store.db.run("DELETE FROM episodes WHERE rowid = ?", [a.r]);
  }
  if (w.m?.limited_until != null) store.setIf("members", Number(w.m.id), "limited_until", null, w.m.limited_until);
  if (w.ow.limited != null) store.setIf("observed_workers", Number(w.ow._rowid), "limited", null, w.ow.limited);
  const key = { project: P, subject: w.wt, kind: "limited" }, ep = store.get("episodes", key);
  if (!ep || ep.state === "closed" || ep.source !== "loop") return false;
  // An expired dialog keeps its episode until the dialog is gone (limitOf); so does a cleared billing error (U2).
  if (ep.state === "expired") { if (!w.expired) store.upsert("episodes", key, { state: "closed", observed_at: t }); return false; }
  if (ep.state === "cleared") { if (!w.cleared) store.upsert("episodes", key, { state: "closed", observed_at: t }); return false; }
  store.fact("limit_cleared", [{ table: "episodes", key, set: { state: "closed", ended_at: t, observed_at: t } }],
    { project: P, squad: w.squad || null, member: w.wt, payload: { episode: ep.episode_key } });
  return true;
}

// U154: the move itself is the decider's (switches.ts). The pick, its hold (U65) and the
// one-at-a-time run-switch state are gone with it; a failed stop retries through the refusals
// classifier's backoff (refusals.ts).

// quiet_since: a working worker's last output (the dialog case), else when it entered its state.
const quietSince = (w: Worker, t: number) => (w.state === "working" && w.lastOutput !== null ? w.lastOutput : w.since ?? t);

type Settings = { limitPct: number; silentMin: number; limitS: number; creditsS: number; limitWaitMin: number; live: Set<string> };

// A decider limit stop for this member in flight (claimed, not settled): the board's `switching`.
function switching(store: Store, P: string, m: Row | null): boolean {
  if (!m) return false;
  return !!store.db.query(`SELECT 1 FROM episodes WHERE project = ? AND subject = ? AND kind = 'action:member'
      AND state IN ('pending', 'acted', 'running') AND episode_key LIKE 'stop:limit:%' LIMIT 1`)
    .get(P, `member:${Number(m.id)}`);
}

function member(ctx: TickCtx, w: Worker, S: Settings, actions: Action[], listed: Listed[]): void {
  const lim = limitOf(ctx, w, S) ?? (S.live.has(w.squad) ? goneOf(ctx, w) ?? loginOf(ctx, w) : null);
  if (!lim) {
    keepLoginCleared(ctx, w);
    close(ctx, w);
    actions.push(...endWait(ctx, w));
    return;
  }
  open(ctx, w, lim, S);
  // A known reset soon is waited out (U63); the move itself is the decider's (switches.ts).
  shortWait(ctx, w, lim, S.limitWaitMin);
  listed.push({ wt: w.wt, who: w.who, topic: w.squad, line: lim.notice, since: quietSince(w, ctx.now),
    ...(switching(ctx.store, ctx.project, w.m) ? { switching: true as const } : {}) });
}

// U63: a limit whose reset is known and at most limit_wait_max minutes away (0 = never wait) is waited
// out: no switch is picked or requested, one `limit_wait` event records it, and endWait() pokes the
// worker once the reset has passed. A further or unknown reset, or a gone account, switches as before.
const waitKey = (P: string, w: Worker) => ({ project: P, subject: w.wt, kind: "limit-wait" });
function shortWait(ctx: TickCtx, w: Worker, lim: Limit, waitMin: number): boolean {
  const { store, project: P, now: t } = ctx;
  if (!w.m || lim.kind === "gone" || waitMin <= 0 || lim.reset === null || lim.reset <= t || lim.reset - t > waitMin * 60) {
    // The limit changed under a wait: that wait is over, and no "it has reset" poke should follow.
    if (store.get("episodes", waitKey(P, w))?.state === "waiting") store.upsert("episodes", waitKey(P, w), { state: "done", observed_at: t });
    return false;
  }
  const ek = `${w.agent}/${w.account}|${lim.notice}|${lim.reset}`, ep = store.get("episodes", waitKey(P, w));
  if (ep?.episode_key !== ek || ep.state !== "waiting") {
    store.fact("limit_wait", [{ table: "episodes", key: waitKey(P, w), set: { squad: w.squad || null, state: "waiting", episode_key: ek, started_at: t, ended_at: lim.reset, source: "loop", observed_at: t } }],
      { project: P, squad: w.squad || null, member: w.wt, payload: { account: `${w.agent}/${w.account}`, notice: lim.notice, reset: lim.reset } });
  }
  return true;
}

// The wait is over (no limit on screen): poke the worker once to carry on, then close the wait.
function endWait(ctx: TickCtx, w: Worker): Action[] {
  const { store, project: P, now: t } = ctx;
  const ep = store.get("episodes", waitKey(P, w));
  if (ep?.state !== "waiting") return [];
  const wk = wake(ctx, w.wt, "The usage limit you waited out has reset — carry on with your task.", "limit-wait", String(ep.episode_key));
  // Retry while the poke is held back (busy, tick cap); give up an hour after the reset.
  if (wk.actions.length > 0 || t - Number(ep.ended_at ?? t) > 3600) store.upsert("episodes", waitKey(P, w), { state: "done", observed_at: t });
  return wk.actions;
}

function studio(ctx: TickCtx, w: Worker, S: Settings, pick: Picker, actions: Action[], listed: Listed[]): void {
  const { store, project: P, now: t } = ctx;
  const lim = limitOf(ctx, w, S) ?? goneOf(ctx, w) ?? disabledOf(ctx, w) ?? loginOf(ctx, w);
  // The sweep's .alerted memory (imported) holds the episodes it already alerted on.
  const alerted = (subject: string, episode: string) => {
    const a = store.get("episodes", { project: P, subject, kind: "alerted" });
    try { return a?.source === "sweep" && (JSON.parse(String(a.state)) as string[]).includes(episode); } catch { return false; }
  };
  const sent = store.get("episodes", { project: P, subject: "studio.limit", kind: "action:alert" });
  const done = store.get("episodes", { project: P, subject: "studio.limit", kind: "action:alert-clear" });
  const previous = typeof sent?.episode_key === "string" ? sent.episode_key : null;
  const cleared = previous !== null && done?.episode_key === `cleared@${previous}`;
  const prefix = alertPrefix("studio.limit"), sweepPrefix = "sweep-studio.limit-";
  const cards = store.db.query("SELECT id, doc FROM observed_alerts WHERE project = ? AND (substr(id, 1, ?) = ? OR substr(id, 1, ?) = ?) ORDER BY rowid")
    .all(P, prefix.length, prefix, sweepPrefix.length, sweepPrefix) as { id: string; doc: string }[];
  const collapse = (keep: string | null) => {
    const stale = new Map(cards.map((c) => [c.id, c.doc]));
    if (keep && previous && !cleared) stale.set(alertId("studio.limit", previous), previous);
    if (keep) stale.delete(keep);
    for (const [id, doc] of stale) actions.push({ project: P, squad: null, member: w.wt,
      subject: `drop:${id}`, kind: "alert-clear", episode: `studio-limit:${doc}`, payload: { id } });
  };
  const alert = (subject: string, episode: string, payload: Row, base = episode) => {
    if (alerted(subject, base)) {
      collapse(cards.filter((c) => c.id.startsWith(sweepPrefix)).at(-1)?.id ?? null);
      return;
    }
    const imported = store.get("episodes", { project: P, subject, kind: "alerted" });
    if (imported?.source === "sweep" && imported.state !== "[]") store.upsert("episodes", { project: P, subject, kind: "alerted" }, { state: "[]", ended_at: t, observed_at: t });
    collapse(alertId(subject, episode));
    actions.push({ project: P, squad: null, member: w.wt, subject, kind: "alert", episode, payload });
  };
  const resolve = (subject: string) => {
    // The sweep's alert_clear: forget its .alerted memory and clear its open alert (sweep-<key>-<cksum>).
    const imp = store.get("episodes", { project: P, subject, kind: "alerted" });
    if (imp?.source === "sweep" && imp.state !== "[]") {
      store.upsert("episodes", { project: P, subject, kind: "alerted" }, { state: "[]", ended_at: t, observed_at: t });
      actions.push({ project: P, squad: null, member: w.wt, subject: `${subject}|sweep`, kind: "alert-clear", episode: `cleared@${imp.started_at}`, payload: { target: "project", prefix: `sweep-${subject}-` } });
    }
    // The loop's own alert (fulfil/alert.ts ids it loop-<subject>-<hash>), as compaction's alert-clear.
    const ep = `cleared@${sent?.episode_key}`;
    if (sent?.episode_key && done?.episode_key !== ep) actions.push({ project: P, squad: null, member: w.wt, subject, kind: "alert-clear", episode: ep, payload: { target: "project", id: alertId(subject, String(sent.episode_key)) } });
  };
  if (!lim) {
    close(ctx, w);
    endMoveHold(store, P, t, ["studio:hold", "studio:approved"]);
    collapse(null);
    resolve("studio.limit");
    backUp(ctx, w, pick, actions);
    return;
  }
  // While the Studio is limited the limit path wins: no move-up is owed.
  upGone(ctx, w, actions);
  const { until, first } = open(ctx, w, lim, S);
  listed.push({ wt: w.wt, who: "studio", topic: "", line: lim.notice, since: quietSince(w, t) });
  const base = `limit|${w.wt}|${w.agent}/${w.account}|${lim.notice}`;
  // The held card's episode is this one plus "|held" (below), so strip that to keep one episode per limit.
  const last = previous?.replace(/\|held$/, "") ?? null;
  const ep = last?.startsWith(`${base}|`) && !cleared ? last : `${base}|${first}`;
  const text = lim.kind === "gone" || lim.kind === "disabled" ? `Studio's ${lim.notice}`
    : lim.kind === "login" ? `Studio's account ${w.agent}/${w.account || "-"}: login ended`
    : `Studio is out of credits on ${w.agent}/${w.account || "-"} (${lim.notice})`;
  const title = lim.kind === "gone" ? "Studio's account removed" : lim.kind === "disabled" ? "Studio's account switched off" : lim.kind === "login" ? "Studio's login ended" : "Studio out of credits";
  const p = pick({ project: P, squad: "", role: "studio", suffix: "", limited: { agent: w.agent, account: w.account, until } }, ctx);
  if (p && "wait" in p) {
    alert("studio.limit", ep, { kind: "out_of_credits", title, text: `${text} — every account is out until ${hhmm(p.wait)}; the loop does not restart the Studio`,
      option: "done — it is back", why: "no account has room until then; the loop does not restart the Studio", until: p.wait }, base);
    return;
  }
  if (!isPlace(p)) {
    const keep = previous && !cleared ? alertId("studio.limit", previous) : cards.at(-1)?.id ?? null;
    collapse(keep);
    return;
  }
  if (p.agent === w.agent && (p.account === w.account || p.account === "-") && sameModel(p.model, w.model || p.model)) { collapse(null); resolve("studio.limit"); return; }
  // U264: move it there (studio_move auto, or ask once the operator answered "move it"), through the one
  // adopted handle, once studioReady() holds. A move in flight or just made waits; a guard that keeps
  // holding past DS_LOOP_STUDIO_MOVE_HOLD_S gives the card below, naming why.
  const mode = limit(store, P, "studio_move") ?? "auto";
  const handle = (studioView(store, P)?.member?.handle as string | null) || null;
  let held: string | null = null;
  if (handle && (mode === "auto" || (mode === "ask" && approved(store, P)))) {
    if (moving(store, P, t)) return;
    const r = studioReady(store, P, t);
    if (r.ready) {
      endMoveHold(store, P, t);
      actions.push({ project: P, squad: null, member: w.wt, subject: MOVE, kind: "studio-move", episode: `move|${handle}|${p.agent}:${p.account}@${t}`,
        payload: { handle, agent: p.agent, account: p.account, model: p.model, effort: p.effort, from: `${w.agent}:${w.account || "-"}`, why: "limit", notice: lim.notice } });
      return;
    }
    if (t - openMoveHold(store, P, t) < moveHoldS()) return;
    held = r.why;
  }
  const cmd = studioRestartCmd(w.wt, p.model, p.account), where = `${p.agent}:${p.model}@${p.account}`;
  const card = { kind: "out_of_credits", title, why: cmd, pick: p, option: "done — restarted it there" };
  // The held card has its own episode: in ask mode the "move it" card already used `ep`, and a done alert claim is never acted again.
  if (held) alert("studio.limit", `${ep}|held`, { ...card, text: `${text}; the loop moves it to ${where} once it is idle with an empty prompt (now: ${held}) — or restart it yourself: ${cmd}` }, base);
  else if (mode === "ask" && handle) alert("studio.limit", ep, { ...card, option: "move it", fields: { move: true, acts_on_answer: true },
    text: `${text}; answer "move it" and the loop moves it to ${where} (its tab only, briefed from its journal) — or restart it yourself: ${cmd}` }, base);
  else alert("studio.limit", ep, { ...card, text: `${text}; restart it on ${where} — run: ${cmd}` }, base);
}

// configurable-role-elevation U3: the Studio's move back up. Owed when its `studio` row resolves `up`
// (roster.ts backUpOf), it is not pinned, it has an adopted handle, placeRung puts its live agent, model
// and account on a rung below the top (a Studio on no rung is owed nothing; rungs that differ only in
// effort place as the first of them), the studio pick lands on a higher rung, and the last move-up
// (studio:up, stamped by fulfil/studio.ts when it started) is over fallback_return_min ago (0 = never).
// auto (or ask once its card was answered "move it"): one studio-move with why "back-up" once
// studioReady() holds, behind moving()'s settle guard; it waits without a time limit and never posts the
// held card. ask: one card on subject studio.up. off: nothing. Not owed: its card and approval clear.
function backUp(ctx: TickCtx, w: Worker, pick: Picker, actions: Action[]): void {
  const { store, project: P, now: t } = ctx;
  const mode = limit(store, P, "studio_move") ?? "auto";
  const handle = (studioView(store, P)?.member?.handle as string | null) || null;
  const owed = (): { p: Place; to: number; from: number } | null => {
    if (mode !== "auto" && mode !== "ask") return null;
    if (!handle || !backUpOf(store, P, "studio") || overrideOf(store, w.m)) return null;
    const lad = ladder(store, { project: P, role: "studio" }, null);
    if (!lad) return null;
    const from = placeRung(store, lad.rungs, { agent: w.agent, model: w.model, account: w.account || null });
    if (from === null || from === 0) return null;
    const min = limitInt(store, P, "fallback_return_min", 15);
    if (min <= 0) return null;
    const marker = store.get("episodes", { project: P, subject: MOVE, kind: "studio:up" });
    if (marker && t - Number(marker.started_at ?? 0) < min * 60) return null;
    const p = pick({ project: P, squad: "", role: "studio", suffix: "", ...(w.m?.id != null ? { member: Number(w.m.id) } : {}) }, ctx);
    if (!isPlace(p) || typeof p.rung !== "number") return null;
    const to = p.rung - 1;
    return to < from ? { p, to, from } : null;
  };
  const o = owed();
  if (!o) { upGone(ctx, w, actions); return; }
  const { p } = o, where = `${p.agent}:${p.model}@${p.account}`;
  if (mode === "auto" || upApproved(store, P)) {
    if (moving(store, P, t) || !studioReady(store, P, t).ready) return;
    actions.push({ project: P, squad: null, member: w.wt, subject: MOVE, kind: "studio-move", episode: `up|${handle}|${p.agent}:${p.account}@${t}`,
      payload: { handle, agent: p.agent, account: p.account, model: p.model, effort: p.effort, from: `${w.agent}:${w.account || "-"}`,
        why: "back-up", notice: `moving back up to ${p.model}` } });
    return;
  }
  // ask: one card per place and target rung; a card for another one is cleared first, and one the
  // loop cleared (the move stopped being owed) comes back as a new card (`@<now>`).
  const base = `up|${w.agent}:${w.model}@${w.account || "-"}|rung${o.to + 1}`;
  const sent = store.get("episodes", { project: P, subject: UP, kind: "action:alert" });
  const prev = typeof sent?.episode_key === "string" ? sent.episode_key : null;
  const same = prev !== null && (prev === base || prev.startsWith(`${base}@`));
  const cleared = prev !== null && store.get("episodes", { project: P, subject: UP, kind: "action:alert-clear" })?.episode_key === `cleared@${prev}`;
  if (same && !cleared) return;
  if (prev && !cleared) clearUp(ctx, w, actions, prev);
  const ep = same ? `${base}@${t}` : base;
  actions.push({ project: P, squad: null, member: w.wt, subject: UP, kind: "alert", episode: ep, payload: {
    card: "studio_move_up", title: "Studio can move back up",
    text: `Studio can move back up to ${where} (it runs on ${w.agent}:${w.model || "?"}@${w.account || "-"}, rung ${o.from + 1} of its ladder); answer "move it" and the loop moves it once it is idle with an empty prompt (its tab only, briefed from its journal)`,
    option: "move it", why: "the studio row says move back up (roles.conf column 8)",
    fields: { move: true, move_up: true, acts_on_answer: true } } });
}

// The move-up card's subject (its own, so the studio.limit collapse and sweep never touch it).
const UP = "studio.up";
// The move-up is no longer owed: clear its card and end its approval.
function upGone(ctx: TickCtx, w: Worker, actions: Action[]): void {
  const { store, project: P, now: t } = ctx;
  endMoveHold(store, P, t, ["studio:up-approved"]);
  const sent = store.get("episodes", { project: P, subject: UP, kind: "action:alert" });
  if (typeof sent?.episode_key === "string") clearUp(ctx, w, actions, sent.episode_key);
}
function clearUp(ctx: TickCtx, w: Worker, actions: Action[], episode: string): void {
  const { store, project: P } = ctx, ep = `cleared@${episode}`;
  const done = store.get("episodes", { project: P, subject: UP, kind: "action:alert-clear" });
  if (done?.episode_key !== ep) actions.push({ project: P, squad: null, member: w.wt, subject: UP, kind: "alert-clear", episode: ep, payload: { target: "project", id: alertId(UP, episode) } });
}
function upApproved(store: Store, P: string): boolean {
  const a = store.get("episodes", { project: P, subject: MOVE, kind: "studio:up-approved" });
  return !!a && a.ended_at == null;
}

// U264's move bookkeeping, all on subject `studio.move` (episodes):
//   action:studio-move  the move's claim (fulfil/studio.ts); open while pending, acted or running
//   studio:move         the last move tried (state closing|closed|started|failed|not moved), started_at
//   studio:hold         since when the guard has kept a wanted move back
//   studio:approved     the operator answered the ask card's "move it" (fulfil/studio.ts dismiss)
//   studio:up-approved  the same for the move-up card (U3, fields.move_up)
//   studio:up           when the last move back up started (fulfil/studio.ts): fallback_return_min's window
const moveHoldS = () => envInt("DS_LOOP_STUDIO_MOVE_HOLD_S", 600);
// After a move (made or not) the next waits this long: the observers must see the new tab and account.
const moveSettleS = () => envInt("DS_LOOP_STUDIO_MOVE_SETTLE_S", 300);
function moving(store: Store, P: string, t: number): boolean {
  const claim = store.get("episodes", { project: P, subject: MOVE, kind: "action:studio-move" });
  if (claim && ["pending", "acted", "running"].includes(String(claim.state))) return true;
  const last = store.get("episodes", { project: P, subject: MOVE, kind: "studio:move" });
  return !!last && t - Number(last.started_at ?? 0) < moveSettleS();
}
function approved(store: Store, P: string): boolean {
  const a = store.get("episodes", { project: P, subject: MOVE, kind: "studio:approved" });
  return !!a && a.ended_at == null;
}
function openMoveHold(store: Store, P: string, t: number): number {
  const h = store.get("episodes", { project: P, subject: MOVE, kind: "studio:hold" });
  if (h && h.ended_at == null) return Number(h.started_at);
  store.upsert("episodes", { project: P, subject: MOVE, kind: "studio:hold" }, { started_at: t, ended_at: null, state: "holding", source: "loop", observed_at: t });
  return t;
}
function endMoveHold(store: Store, P: string, t: number, kinds = ["studio:hold"]): void {
  for (const kind of kinds) {
    const h = store.get("episodes", { project: P, subject: MOVE, kind });
    if (h && h.ended_at == null) store.upsert("episodes", { project: P, subject: MOVE, kind }, { ended_at: t, state: "ended", observed_at: t });
  }
}

// loop/limited.json for the board and old readers; written only when it changes.
export function exportLimited(root: string, project: string, listed: Listed[]): boolean {
  const f = join(root, project, "loop", "limited.json"), text = `${JSON.stringify(listed)}\n`;
  let prev = "";
  try { prev = readFileSync(f, "utf8"); } catch { /* none yet */ }
  if (prev === text || (prev === "" && listed.length === 0)) return false;
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, text);
  renameSync(`${f}.tmp`, f);
  return true;
}
