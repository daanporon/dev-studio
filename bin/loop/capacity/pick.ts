// pick.ts — the host-wide account picker (U9, R18, KTD1–3): which agent, model, effort and account
// a member starts on, from rows only (Bun). The loop's picker; `ds pick` prints it.
//
//   pick(store, { project, role, tier?, phase?, member?, agent?, model?, effort?, limited? }, now)
//     -> { agent, model, effort, account, fallback, rung, reason, why }   start on this
//     |  { wait, reason, why }                                             nothing at or above the floor
//     |  { wait, reason, why: "slot", slot }                               a Builder over max_builders (U145)
//     |  { wait, reason, why: "host" }                                     a Builder start under the host brake (U4)
//     |  { error }                                                         no roster row and no agent/model
//
// The ladder (role × tier × phase): the first roles.conf row of `<role>-<tier>-<phase>`,
// `<role>-<tier>`, `<role>` (a `-standard` row only in the ce-pipeline ship mode, as ds_role_row),
// its own agent:model first, then each fallback in the written order, without grouping by agent. The floor
// (limits `pick_floor_<role>_<tier>`, else `pick_floor_<role>`, `agent:model` or `any`) is the last
// rung tried; below it the pick is WAIT at the soonest time a skipped account frees up.
//
// Fill-first (KTD2): on a rung, the accounts of its agent with room, soonest reset first (known before
// unknown, fuller first on a tie). An account is out while limited (observed_accounts.limited_until,
// an `account` episode — the sweep's .accounts.episodes and U8's — or a member limited on it), at or
// over pick_weekly_max on claude or muse (the weekly window is account-wide), draining (v2, U25), disabled
// by the operator (accounts.ts; out on every rung, never the default login in its place), or without
// room: its real session % plus the expected load of this member and of members placed on it in the
// last pick_ttl_s seconds (pick_load_lead / pick_load_thinker for those roles, else pick_load_<tier>, in
// session % times the plan's pick_load_scale_<agent>_<plan>: their use is not in the usage numbers yet;
// older members are), plus each fallback reservation (U180: a Thinker the fallback switch stopped, until it
// is placed or pick_ttl_s passes), must stay under pick_room_pct. A fallback pick's `why` names each higher rung skipped. An account with no session pct and no reset has no
// 5-hour window (reason no_session_window): only its weekly cap and a limit can block it, and it
// sorts by its weekly reset. A window whose reset has passed counts as 0 %.
//
// An active override (overrides.member = the member's id, worktree or <project>/<squad>/<role>[/<suffix>],
// scope NULL or `member`; other scopes are v2, U24) wins until the member's work is done (KTD3): its
// model replaces the ladder (no floor), its account replaces fill-first (no room check; a limit still
// waits — the loop never moves an overridden member). An override or explicit account that names a
// disabled account waits too (reason `account disabled`), with no exception like draining's.
// --agent/--model (an explicit choice) also replace the ladder with one rung.
//
// max_builders (U145, slot.ts) comes first: a Builder with no live agent in a project at its limit
// waits for a slot whatever its rung or override: WAIT with why `slot`, no reset time (wait = now,
// known false), reason `WAIT slot: <project> at max_builders <n>` (with the light lane on, U3:
// `WAIT slot: <project> normal <live>/<n>, light <live>/<m>`). Ask again next tick.
//
// The host brake (U4) comes next: with `builder_host_brake on`, a Builder start that needs a new agent
// waits while the latest observed_machine sample crosses a machine_*_crit line (load, memory, swap,
// pressure: machine-level.ts, the levels the board colours): WAIT with why `host`, no reset time, reason
// `WAIT host: <metric> <value> ≥ crit <line>`. A missing or stale sample never brakes; a live Builder
// replacing its own agent and every other role are never braked. Ask again next tick.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { memberIds, type Row, type Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { accountDisabled, DISABLED } from "./accounts.ts";
import { creditsHolds, OUT_OF_CREDITS } from "./credits.ts";
import { newBuilderStart, slot, type Asker } from "./slot.ts";
import { memo } from "./walk-memo.ts";
import { hostCrit, hostCritHit, sampleState, type CritHit, type SampleState } from "./machine-level.ts";
import { loopProjects } from "../settings/projects.ts";
import { effectiveRoster } from "../settings/roster.ts";

export type PickReq = {
  project: string; role: string; tier?: string | null; phase?: string | null; squad?: string | null;
  member?: number | null;                       // members.id: its override, its own load left out
  suffix?: string | null;                       // with squad, the Builder's unit when no member is named (its max_builders place)
  agent?: string | null; model?: string | null; effort?: string | null; account?: string | null;
  limited?: string[];                           // `<agent>:<account>=<epoch>` on top of the rows
  load?: Map<string, number>;                   // extra load per `<agent>\t<account>` (the reconciler's)
  sessionMax?: number; weeklyMax?: number;      // in place of pick_session_max / pick_weekly_max (U8's early pick)
  keep?: { agent: string; model: string; account: string; plan?: string | null };   // an earlier pick (U65): on its own rung it wins while it still has room
};
export type Picked = { plan: string | null; agent: string; model: string; effort: string | null; account: string | null; fallback: boolean; rung: number; reason: string; why: string };
export type Waiting = { wait: number; known: boolean; reason: string; why: string;   // known: a real reset, not now + DS_PICK_WAIT_S
  slot?: { limit: number; live: number; ahead: number } };                           // why "slot": over max_builders (U145); "host": the host brake (U4)
export type PickResult = Picked | Waiting | { error: string };

export type Rung = { agent: string; model: string; effort: string | null; plan: string | null };
export const rungTag = (r: { agent: string; model: string; plan?: string | null }) => `${r.agent}:${r.model}${r.plan ? `:${r.plan}` : ""}`;
export const accountPlan = (store: Store, agent: string, account: string | null): string | null =>
  account ? (store.get("observed_accounts", { agent, account })?.plan as string | null) ?? null : null;
export const matchesPlan = (plan: string | null, actual: string | null) => !plan || plan === actual;
type Acct = { plan: string | null; account: string; pct: number; reset: number | null; weekly: number; wreset: number | null; noWindow: boolean; unknown: boolean; until: number; draining: boolean; disabled: boolean; credits?: boolean };

export const ENV: Record<string, string> = { pick_session_max: "DS_PICK_SESSION_MAX", pick_weekly_max: "DS_PICK_WEEKLY_MAX" };
const DEFAULTS: Record<string, string> = {
  pick_session_max: "95", pick_weekly_max: "95", pick_room_pct: "95", pick_load_hard: "20", pick_load_standard: "10", pick_load_lead: "1", pick_load_thinker: "1", pick_ttl_s: "600", fallback_return_min: "15",
};
const n = (v: unknown): number | null => (v === null || v === undefined || v === "" || v === "-" || !Number.isFinite(Number(v)) ? null : Number(v));
export const loadKey = (agent: string, account: string | null) => `${agent}\t${account ?? "-"}`;

// A limit as ds_limit reads it: the env var (DS_LIMIT_<KEY> or its old name), the project's
// limits.conf row, the conventions row, else the built-in default.
export function limit(store: Store, project: string, key: string): string | null {
  const ev = process.env[ENV[key] ?? `DS_LIMIT_${key.toUpperCase()}`];
  if (ev) return ev;
  return memo(store, null, "limit", `${project}\0${key}`, () => limitRow(store, project, key));
}
function limitRow(store: Store, project: string, key: string): string | null {
  for (const p of [project, ""]) {
    const r = store.get("config", { project: p, file: "limits.conf", key });
    const v = r ? String(r.value ?? "").split(/\s+/)[0] : "";
    if (v) return v;
  }
  return DEFAULTS[key] ?? null;
}
export const limitNum = (store: Store, project: string, key: string) => Number(limit(store, project, key) ?? 0);

// A whole-number line as the board reads it (board-data.ts dsLimit): the env var, the project's row,
// the conventions row; the first whole number wins, else null (no line).
function wholeLimit(store: Store, project: string, key: string): number | null {
  const ev = process.env[ENV[key] ?? `DS_LIMIT_${key.toUpperCase()}`];
  if (ev && /^[0-9]+$/.test(ev)) return Number(ev);
  return memo(store, null, "whole-limit", `${project}\0${key}`, () => wholeRow(store, project, key));
}
function wholeRow(store: Store, project: string, key: string): number | null {
  for (const p of [project, ""]) {
    const v = String(store.get("config", { project: p, file: "limits.conf", key })?.value ?? "").trim().split(/\s+/)[0];
    if (/^[0-9]+$/.test(v)) return Number(v);
  }
  return null;
}

// The host brake (U4): with builder_host_brake on, the crit line a fresh machine sample crosses, for a
// start that needs a new Builder agent; null = go ahead.
export function hostBrake(store: Store, project: string, who: Asker, now: number, role: string): string | null {
  if (limit(store, project, "builder_host_brake") !== "on") return null;
  const r = memo(store, null, "machine", "", () => store.db.query("SELECT * FROM observed_machine ORDER BY observed_at DESC LIMIT 1").get() as Row | null);
  const crit = hostCrit(r, (k) => wholeLimit(store, project, k), now);
  return crit && newBuilderStart(store, project, who, now, role) ? crit : null;
}

// The host brake as one host-wide state (board-shows-host-brake U1), for the board: the host's latest
// sample (`fresh`/`stale`/`missing`, its age), the crit line it crosses (`hit`, null = none or not fresh)
// and every loop project with its effective `builder_host_brake`. With `hit` set, a new Builder start of a
// project whose `on` is true waits `WAIT host:` now. The lines are read as `project` reads them (the
// board passes its own; default: the env and the conventions rows), since a project can move them.
// Only reads: no pick, no event.
export type BrakeView = { setting: "builder_host_brake"; sample: SampleState["state"]; age_s: number | null; hit: CritHit | null; projects: { project: string; on: boolean }[] };
export function brakeView(store: Store, now: number, project = "", projects = loopProjects(store.root)): BrakeView {
  const r = store.db.query("SELECT * FROM observed_machine ORDER BY observed_at DESC LIMIT 1").get() as Row | null;
  const s = sampleState(r, now);
  return { setting: "builder_host_brake", sample: s.state, age_s: s.age_s, hit: hostCritHit(r, (k) => wholeLimit(store, project, k), now),
    projects: projects.map((p) => ({ project: p, on: limit(store, p, "builder_host_brake") === "on" })) };
}

// ds_ship_mode: the project's ship-mode, else the first projects.conf selector that is the label or
// part of the repo, else ce-pipeline.
export function shipMode(store: Store, project: string, repo: string | null): string {
  const own = store.get("config", { project, file: "ship-mode", key: "mode" })?.value;
  if (own) return String(own).trim();
  const rows = store.db.query("SELECT key, value FROM config WHERE project = '' AND file = 'projects.conf' ORDER BY rowid").all() as { key: string; value: string }[];
  for (const r of rows) {
    const mode = String(r.value ?? "").split(/\s+/)[0];
    if (mode && (r.key === project || (repo && repo.includes(r.key)))) return mode;
  }
  return "ce-pipeline";
}

// The ladder's rungs and the row they came from.
export function ladder(store: Store, req: PickReq, repo: string | null): { row: string; rungs: Rung[] } | null {
  const conf = effectiveRoster(store, req.project);
  const names = [req.tier && req.phase ? `${req.role}-${req.tier}-${req.phase}` : "", req.tier ? `${req.role}-${req.tier}` : "", req.role]
    .filter((name) => name && conf.has(name) && !(name.endsWith("-standard") && shipMode(store, req.project, repo) !== "ce-pipeline"));
  if (!names.length) return null;
  const [agent = "", model = "", , effort0 = "-", fbs = "-", plan0 = "-"] = conf.get(names[0])!.split(/\s+/);
  if (!agent || !model) return null;
  const effort = effort0 === "-" ? null : effort0;
  const rungs: Rung[] = [{ agent, model, effort, plan: plan0 === "-" ? null : plan0 }];
  for (const f of fbs === "-" ? [] : fbs.split(",")) {
    const [fa, fm, fe, fp] = f.split(":");
    // A fallback's own effort, else the row's on the same agent, else the agent's default.
    if (fa && fm) rungs.push({ agent: fa, model: fm, effort: fe && fe !== "-" ? fe : fa === agent ? effort : null, plan: fp && fp !== "-" ? fp : null });
  }
  return { row: names[0], rungs };
}

// How many rungs the floor allows (all of them for `any`, an unset key or a floor not on the ladder).
function floorOf(store: Store, req: PickReq, rungs: Rung[]): { n: number; floor: string } {
  const f = (req.tier && limit(store, req.project, `pick_floor_${req.role}_${req.tier}`)) || limit(store, req.project, `pick_floor_${req.role}`) || "any";
  const i = rungs.findIndex((r) => f.split(":").length > 2 ? rungTag(r) === f : `${r.agent}:${r.model}` === f);
  return { n: f === "any" || i < 0 ? rungs.length : i + 1, floor: f };
}

// Every key an overrides row may name a member by (store.ts, which writes pins too).
export { memberIds };

export const SCOPES = ["member", "squad", "role", "project"] as const;

// The keys a broader override names this member by: `<project>/<squad>`, `<project>/<role>`, `<project>`.
export function scopeTargets(m: Row): Record<string, string> {
  const p = String(m.project ?? "");
  return { squad: `${p}/${String(m.squad ?? "")}`, role: `${p}/${String(m.role ?? "")}`, project: p };
}

// U24: the member's open overrides, narrowest first (member, squad, role, project). A broader row's
// `member` column holds its target (scopeTargets); the scope column says what kind of target it is.
export function overridesOf(store: Store, m: Row | null): Row[] {
  if (!m || workDone(store, m)) return [];
  const t = scopeTargets(m);
  const rows = store.db.query(`SELECT * FROM overrides WHERE cleared_at IS NULL AND (
      (COALESCE(scope, 'member') = 'member' AND member IN (SELECT value FROM json_each(?1)))
      OR (scope = 'squad' AND member = ?2) OR (scope = 'role' AND member = ?3) OR (scope = 'project' AND member = ?4)) ORDER BY id DESC`)
    .all(JSON.stringify(memberIds(m)), t.squad, t.role, t.project) as Row[];
  const rank = (r: Row) => SCOPES.indexOf((r.scope || "member") as typeof SCOPES[number]);
  return rows.sort((a, b) => rank(a) - rank(b) || Number(b.id) - Number(a.id));
}

// The member's active override: each field (model, effort, and the account-or-plan pair) comes from the
// narrowest override that sets it. The row is the narrowest one with those fields filled from broader ones,
// `scope`/`target` naming the narrowest, `scopes` every one that contributed.
export function overrideOf(store: Store, m: Row | null): Row | null {
  const rows = overridesOf(store, m);
  if (!rows.length) return null;
  const model = rows.find((r) => r.model), effort = rows.find((r) => r.effort), acct = rows.find((r) => r.account || r.plan);
  const used = [...new Set([rows[0], model, effort, acct].filter((r): r is Row => !!r))];
  return { ...rows[0], model: model?.model ?? null, effort: effort?.effort ?? null, account: acct?.account ?? null, plan: acct?.plan ?? null,
    scope: rows[0].scope || "member", target: rows[0].member, scopes: used.map((r) => r.scope || "member") };
}

// How a pick names its override: `override #3`, and for a broader one `override #3 (pinned for squad x)`.
export function overrideHow(ov: Row): string {
  const sc = String(ov.scope || "member");
  return sc === "member" ? `override #${ov.id}` : `override #${ov.id} (pinned for ${sc} ${sc === "project" ? String(ov.target) : String(ov.target).split("/").slice(1).join("/")})`;
}

// A member's work is done when the member is gone or no longer wanted, or the unit it builds is
// done, merged or cancelled.
export function workDone(store: Store, m: Row): boolean {
  if (["gone", "closed"].includes(String(m.status ?? "")) || m.want === "gone") return true;
  if (m.role !== "builder") return false;
  let u = m.suffix ? store.get("units", { project: m.project, squad: m.squad, slug: m.suffix }) : null;
  if (!u && m.wt) u = store.db.query("SELECT status FROM units WHERE project = ? AND squad = ? AND builder_wt = ? ORDER BY id DESC")
    .get(String(m.project), String(m.squad), String(m.wt)) as Row | null;
  return !!u && ["done", "merged", "cancelled"].includes(String(u.status ?? ""));
}

// The agent's current rows of accounts.tsv, or null when they say nothing: no rows, or claude's
// `system` alone, which is what `account-list` prints when `orca account list` fails.
function readList(store: Store, agent: string): { accounts: Set<string>; updated: number } | null {
  const rows = store.db.query("SELECT account, updated FROM observed_accounts WHERE agent = ?").all(agent) as Row[];
  if (rows.every((r) => r.account === "system")) return null;
  return { accounts: new Set(rows.map((r) => String(r.account))), updated: Math.max(...rows.map((r) => n(r.updated) ?? 0)) };
}

// The accounts an agent is listed on now, or null when that can't be told: the list is empty, a
// failed read, or has not been refreshed for five rounds (a failed read leaves the file to age).
// An account counts as removed only against a non-null list.
export function accountList(store: Store, agent: string, now: number): Set<string> | null {
  const l = readList(store, agent);
  return l && now - l.updated <= 5 * envInt("DS_LOOP_ACCOUNTS_S", 60) ? l.accounts : null;
}

// Each account an agent can run on, with what blocks it. An old `accounts` row the current list no
// longer has is not offered; with no list to go by, the rows stand as they are.
function accounts(store: Store, agent: string, now: number, limited: string[]): Acct[] {
  let rows = store.db.query(`SELECT a.account, o.session_pct, o.session_reset, o.weekly_pct, o.weekly_reset, o.limited_until, o.plan, a.state,
      o.account IS NULL AS unknown
    FROM (SELECT agent, account, state FROM accounts WHERE agent = ?1
          UNION SELECT agent, account, NULL FROM observed_accounts WHERE agent = ?1 AND account NOT IN (SELECT account FROM accounts WHERE agent = ?1)) a
    LEFT JOIN observed_accounts o ON o.agent = a.agent AND o.account = a.account ORDER BY a.account`).all(agent) as Row[];
  const list = readList(store, agent)?.accounts;
  if (list) rows = rows.filter((r) => list.has(String(r.account)));
  const until = new Map<string, number>();
  const later = (acct: string, t: number | null) => { if (t && t > now && t > (until.get(acct) ?? 0)) until.set(acct, t); };
  for (const r of rows) later(String(r.account), n(r.limited_until));
  for (const e of store.db.query("SELECT state, ended_at FROM episodes WHERE kind = 'account' AND ended_at > ?").all(now) as Row[]) {
    const [a, acct] = String(e.state ?? "").split("/");
    if (a === agent && acct) later(acct, n(e.ended_at));
  }
  // U2: a live credits hold (credits.ts) blocks like a limit, and the pick names it `out of credits`.
  const credits = new Set<string>();
  for (const [k, t] of creditsHolds(store, now)) {
    const [a, acct] = k.split("/");
    if (a === agent && acct) { credits.add(acct); later(acct, t); }
  }
  for (const m of store.db.query("SELECT account, limited_until FROM members WHERE agent = ? AND account IS NOT NULL AND limited_until > ? AND COALESCE(status, '') NOT IN ('gone', 'closed')").all(agent, now) as Row[]) {
    later(String(m.account), n(m.limited_until));
  }
  for (const l of limited) {
    const m = /^([^:]+):(.+)=(\d+)$/.exec(l);
    if (m && m[1] === agent) later(m[2], Number(m[3]));
  }
  return rows.map((r) => {
    const sp = n(r.session_pct), sr = n(r.session_reset), wp = n(r.weekly_pct), wr = n(r.weekly_reset);
    // No 5-hour window: no session pct or reset but a weekly reading. All four empty is a failed
    // usage fetch (accounts-refresh writes `-` for each): usage unknown, room check still applies.
    const fetched = sp !== null || sr !== null || wp !== null || wr !== null;
    const noWindow = !r.unknown && fetched && sp === null && sr === null;
    const over = sr !== null && sr <= now;   // a reset in the past: that window is over, 0 %
    return {
      plan: (r.plan as string | null) || null, account: String(r.account), pct: over ? 0 : sp ?? 0, reset: sr !== null && sr > now ? sr : null, weekly: wr !== null && wr <= now ? 0 : wp ?? 0,
      wreset: wr !== null && wr > now ? wr : null, noWindow, unknown: !!r.unknown || !fetched, until: until.get(String(r.account)) ?? 0, draining: r.state === "draining", disabled: r.state === DISABLED,
      ...(credits.has(String(r.account)) ? { credits: true } : {}),
    };
  });
}

// Why an account can't take a member now (disabled, credits, limited, draining, capped, no longer listed), or null. An
// account of `-` (the default login) is never blocked. Room is not looked at: a held pick (U65) keeps
// its account while the others placed on it pile up.
export function accountBlock(store: Store, agent: string, account: string, now: number, limited: string[] = [], project = ""): string | null {
  if (!account || account === "-") return null;
  const list = accountList(store, agent, now);
  if (list && !list.has(account)) return "gone";
  const a = accounts(store, agent, now, limited).find((x) => x.account === account);
  if (!a) return list ? "gone" : null;
  if (a.disabled) return "disabled";
  if (a.credits) return "credits";
  if (a.until > now) return "limited";
  if (a.draining) return "draining";
  if (["claude", "muse"].includes(agent) && a.weekly >= limitNum(store, project, "pick_weekly_max")) return "weekly";
  if (!a.noWindow && a.pct >= limitNum(store, project, "pick_session_max")) return "session";
  return null;
}

// U180: a Lead or Thinker adds its own role's load (pick_load_lead / pick_load_thinker); a Builder and
// every other role its tier's.
const ROLE_LOAD = new Set(["lead", "thinker"]);
const baseLoad = (store: Store, project: string, tier: unknown, role: unknown) =>
  limitNum(store, project, ROLE_LOAD.has(String(role ?? "")) ? `pick_load_${role}` : tier === "hard" ? "pick_load_hard" : "pick_load_standard");
// Loads are session percentages on the destination account. Unlisted plans have the old weight.
export function planLoad(store: Store, project: string, tier: unknown, agent: string, plan: string | null, role: unknown = null): number {
  const scale = plan ? Number(limit(store, project, `pick_load_scale_${agent}_${plan}`) ?? 1) : 1;
  return baseLoad(store, project, tier, role) * (Number.isFinite(scale) && scale > 0 ? scale : 1);
}

// U180: a fallback stop's reservation — the place the stopped Thinker aims for (the stop tick's pick).
// It holds until the member is placed (placed_at after the stop) or pick_ttl_s passes.
export const RESERVE = "fallback-reserve";
export type Reservation = { member: number; project: string; role: string; tier: string | null; agent: string; model: string; account: string | null };
export function reservations(store: Store, now: number): Reservation[] {
  return memo(store, now, "reservations", "", () => reservationsRead(store, now));
}
function reservationsRead(store: Store, now: number): Reservation[] {
  const out: Reservation[] = [];
  for (const e of store.db.query(`SELECT e.*, m.id AS mid, m.role, m.tier FROM episodes e JOIN members m ON 'member:' || m.id = e.subject
      WHERE e.kind = ? AND e.state = 'reserved' AND e.ended_at > ? AND COALESCE(m.placed_at, 0) <= e.started_at
      AND COALESCE(m.status, '') NOT IN ('gone', 'closed') AND COALESCE(m.want, '') = 'running'`).all(RESERVE, now) as Row[]) {
    try {
      const k = JSON.parse(String(e.episode_key ?? "{}")) as { agent?: string; model?: string; account?: string | null };
      if (k.agent && k.model) out.push({ member: Number(e.mid), project: String(e.project), role: String(e.role), tier: (e.tier as string | null) ?? null, agent: k.agent, model: k.model, account: k.account ?? null });
    } catch { /* not a reservation */ }
  }
  return out;
}
export const reservationOf = (store: Store, member: number, now: number): Reservation | null =>
  reservations(store, now).find((r) => r.member === member) ?? null;

// The expected load on each account that real usage does not show yet: the pending picks that hold a
// start slot (other than the member being picked), and members placed on the account in the last
// pick_ttl_s seconds (a start, or a run-switch). A member placed longer ago already shows in the
// account's real session %, so counting it again would make a busy but low account look full.
export function loads(store: Store, self: number | null, now: number, project = ""): Map<string, number> {
  const out = new Map<string, number>();
  const add = (agent: string, account: string | null, project: string, tier: unknown, role: unknown) =>
    out.set(loadKey(agent, account), (out.get(loadKey(agent, account)) ?? 0) + planLoad(store, project, tier, agent, accountPlan(store, agent, account), role));
  for (const p of store.db.query("SELECT * FROM picks WHERE slot = 1 AND agent IS NOT NULL AND member IS NOT ?").all(self) as Row[]) add(String(p.agent), (p.account as string | null) ?? null, String(p.project), p.tier, p.role);
  // A running member's tier: its own, else its unit's (nothing writes members.tier for a Builder yet).
  // Placed: members.placed_at (set at a start) or a run-switch episode for its key (<squad>.<role>[-<suffix>]).
  for (const m of store.db.query(`SELECT m.*, COALESCE(m.tier, (SELECT u.tier FROM units u WHERE u.project = m.project AND u.squad = m.squad
        AND (u.slug = m.suffix OR (u.builder_wt IS NOT NULL AND u.builder_wt = m.wt)))) AS tier
      FROM members m WHERE m.status = 'running' AND m.agent IS NOT NULL AND m.id IS NOT ?1
      AND COALESCE(m.want, '') != 'gone' AND m.id NOT IN (SELECT member FROM picks WHERE slot = 1)
      AND (m.placed_at > ?2 OR EXISTS (SELECT 1 FROM episodes e WHERE e.project = m.project AND e.kind = 'action:run-switch' AND COALESCE(e.ended_at, e.started_at) > ?2
        AND e.subject = m.squad || '.' || m.role || CASE WHEN COALESCE(m.suffix, '') = '' THEN '' ELSE '-' || m.suffix END))`)
      .all(self, now - limitNum(store, project, "pick_ttl_s")) as Row[]) {
    add(String(m.agent), (m.account as string | null) ?? null, String(m.project), m.tier, m.role);
  }
  // U180: a fallback reservation counts on the account it aims for while its member holds no start
  // slot pick (that pick counts above) and is not placed yet.
  const held = new Set((store.db.query("SELECT member FROM picks WHERE slot = 1").all() as Row[]).map((p) => Number(p.member)));
  for (const r of reservations(store, now)) {
    if (r.member === self || held.has(r.member)) continue;
    add(r.agent, r.account, r.project, r.tier, r.role);
  }
  return out;
}

// muse family alias -> the newest visible version (ds_muse_resolve); an exact id or no catalog passes.
export function museResolve(model: string): string {
  const dir = process.env.MUSE_MODEL_CATALOG_DIR || join(process.env.HOME || "", ".local/share/muse/model-catalog");
  if (!existsSync(dir)) return model;
  const rows: { model_id: string; release_date?: string }[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try {
      for (const r of (JSON.parse(readFileSync(join(dir, f), "utf8")).rows ?? []) as { model_id?: unknown; visibility?: string; release_date?: string }[]) {
        if (r.visibility === "visible" && typeof r.model_id === "string" && !r.model_id.endsWith("-contributor")) rows.push(r as { model_id: string });
      }
    } catch { /* an unreadable file is skipped, like roles.sh */ }
  }
  if (!rows.length || rows.some((r) => r.model_id === model)) return model;
  const fam = rows.filter((r) => r.model_id.replace(/-[0-9]+(\.[0-9]+)?$/, "") === model).sort((a, b) => (a.release_date ?? "").localeCompare(b.release_date ?? ""));
  return fam.at(-1)?.model_id ?? model;
}

export function pick(store: Store, req: PickReq, now: number): PickResult {
  const m = req.member ? store.db.query("SELECT * FROM members WHERE id = ?").get(req.member) as Row | null : null;
  const squad = req.squad ?? (m?.squad as string | null) ?? null;
  const s = slot(store, req.project, { member: m, squad, suffix: req.suffix ?? null }, now, req.role);
  if (!s.ok) return { wait: now, known: false, why: "slot", reason: s.why, slot: { limit: s.limit, live: s.live, ahead: s.ahead } };
  const brake = hostBrake(store, req.project, { member: m, squad, suffix: req.suffix ?? null }, now, req.role);
  if (brake) return { wait: now, known: false, why: "host", reason: `WAIT host: ${brake}` };
  const repo = squad ? (store.get("squads", { project: req.project, topic: squad })?.repo as string | null) ?? null : null;
  const ov = overrideOf(store, m);
  const lad = ladder(store, req, repo);
  const account = ov?.account ?? req.account;
  let rungs: Rung[], floor = { n: 0, floor: "any" }, how: string;
  const explicit = req.agent || req.model || ov?.model;
  if (explicit) {
    const model = String(ov?.model ?? req.model ?? lad?.rungs[0].model ?? "");
    const agent = (ov?.model ? null : req.agent) ?? agentOf(store, req.project, model, lad?.rungs ?? []);
    if (!agent || !model) return { error: `pick: no agent/model for role '${req.role}' (roster row missing; pass --agent/--model)` };
    const own = lad?.rungs.find((r) => r.agent === agent);
    // U205: a pin's effort (else the roster row's, as before) and plan (its accounts only).
    rungs = [{ agent, model, effort: (ov?.effort as string | null) || (own ? lad!.rungs[0].effort : null), plan: (ov?.plan as string | null) || null }];
    floor.n = 1;
    how = ov?.model ? overrideHow(ov) : "explicit";
  } else {
    if (!lad) return { error: `pick: no roles.conf row for role '${req.role}'` };
    rungs = lad.rungs;
    floor = floorOf(store, req, rungs);
    how = lad.row;
    if (account) {
      const owns = (r: Rung) => matchesPlan(r.plan, accountPlan(store, r.agent, String(account))) && (!!store.get("observed_accounts", { agent: r.agent, account: String(account) }) || !!store.get("accounts", { agent: r.agent, account: String(account) }));
      rungs = [{ ...(rungs.find(owns) ?? rungs[0]), plan: null }];
      floor = { n: 1, floor: "override" };
      how = ov ? overrideHow(ov) : "explicit account";
    }
  }
  const effort = (ov?.effort as string | null) || req.effort;
  if (effort) rungs = rungs.map((r) => ({ ...r, effort }));

  const smax = req.sessionMax ?? limitNum(store, req.project, "pick_session_max"), wmax = req.weeklyMax ?? limitNum(store, req.project, "pick_weekly_max");
  const room = limitNum(store, req.project, "pick_room_pct"), tier = req.tier ?? m?.tier;
  const load = loads(store, req.member ?? null, now, req.project);
  for (const [k, v] of req.load ?? []) load.set(k, (load.get(k) ?? 0) + v);
  let wait = 0;
  const free = (t: number | null) => { if (t && t > now && (wait === 0 || t < wait)) wait = t; };
  const tried: string[] = [];
  const skipped: string[] = [];   // each higher rung left and why, for the fallback pick's why
  const broke = new Set<string>();   // U2: <agent>:<account> held out of credits, named in a wait's reason
  let off = false;                // the override's or explicit account is disabled

  for (let i = 0; i < floor.n; i++) {
    const r = rungs[i], tag = rungTag(r);
    let accts = accounts(store, r.agent, now, req.limited ?? []).filter((a) => matchesPlan(r.plan, a.plan));
    if (account) {
      const a = accts.find((x) => x.account === account);
      accts = [a ?? { plan: null, account: String(account), pct: 0, reset: null, weekly: 0, wreset: null, noWindow: false, unknown: true, until: 0, draining: false, disabled: accountDisabled(store, r.agent, String(account)) }];
    }
    const why: string[] = [];
    // The pick's why names each disabled account left out on its own rung (a skipped rung names them in its reasons).
    const out = (account: string | null, base: string, reason: string): Picked => ({
      plan: r.plan, agent: r.agent, model: r.agent === "muse" ? museResolve(r.model) : r.model, effort: r.effort, account,
      fallback: i > 0, rung: i + 1, reason: `${how} rung ${i + 1} ${tag}: ${reason}`,
      why: [base, ...why.filter((w) => w.endsWith(` ${DISABLED}`)), ...(skipped.length ? [`skipped ${skipped.join("; ")}`] : [])].join("; "),
    });
    if (!accts.length && !r.plan) return out(null, "default_login", "no account listed, its default login");
    if (!accts.length) why.push(`no account on plan ${r.plan}`);
    const ok: (Acct & { key: number })[] = [];
    for (const a of accts) {
      if (a.disabled) { why.push(`${a.account} ${DISABLED}`); if (account) off = true; continue; }
      if (a.draining && !account) { why.push(`${a.account} draining`); continue; }
      const blocks: (number | null)[] = [];
      if (a.until > now) {
        blocks.push(a.until); why.push(`${a.account} ${a.credits ? OUT_OF_CREDITS : "limited"}`);
        if (a.credits) broke.add(`${r.agent}:${a.account}`);
      }
      if (["claude", "muse"].includes(r.agent) && a.weekly >= wmax) { blocks.push(a.wreset); why.push(`${a.account} weekly ${a.weekly}% >= ${wmax}%`); }
      if (!account && !a.noWindow) {
        const extra = (load.get(loadKey(r.agent, a.account)) ?? 0) + planLoad(store, req.project, tier, r.agent, a.plan, req.role);
        if (a.pct >= smax || a.pct + extra >= room) { blocks.push(a.reset); why.push(`${a.account} session ${a.pct}%${extra ? ` + ${extra}% new load` : ""} over ${a.pct >= smax ? smax : room}%`); }
      }
      // Wait for the latest blocking reset on an account, then the earliest across accounts.
      // An unknown reset cannot promise that account will be usable at another window's reset.
      if (blocks.length) {
        if (blocks.every((t): t is number => t !== null)) free(Math.max(...blocks));
        continue;
      }
      ok.push({ ...a, key: (a.noWindow ? a.wreset : a.reset) ?? Infinity });
    }
    ok.sort((a, b) => a.key - b.key || b.pct - a.pct || a.account.localeCompare(b.account));
    // An earlier pick (U65) with room on its own rung is kept rather than moved to another account;
    // a higher rung with room still wins, as the loop above reaches it first.
    const best = (req.keep && (req.keep.plan === undefined || req.keep.plan === r.plan) && req.keep.agent === r.agent && (req.keep.model === r.model || req.keep.model === museResolve(r.model)) ? ok.find((a) => a.account === req.keep!.account) : undefined) ?? ok[0];
    if (best) {
      if (account) return out(best.account === "-" ? null : best.account, ov ? "override" : "explicit", `${ov ? overrideHow(ov) : "explicit"} account ${best.account}`);
      const used = (load.get(loadKey(r.agent, best.account)) ?? 0) + planLoad(store, req.project, tier, r.agent, best.plan, req.role);
      if (best.noWindow) return out(best.account, "no_session_window", `${best.account} has no 5-hour window; weekly ${best.weekly}% < ${wmax}%`);
      if (best.unknown) return out(best.account, "unknown_usage", `${best.account}, usage not known yet`);
      return out(best.account, "fill_first", `${best.account} resets soonest${best.reset ? ` (${best.reset})` : ""} with room: ${best.pct}% + ${used}% < ${room}%`);
    }
    tried.push(tag);
    skipped.push(`${tag} (${why.join(", ")})`);
  }
  const known = wait > 0, at = known ? wait : now + (Number(process.env.DS_PICK_WAIT_S) || 3600);
  const below = floor.n < rungs.length ? ` (floor ${floor.floor})` : "";
  const until = `wait until ${known ? at : `${at} (no known reset)`}`;
  if (off) return { wait: at, known, why: "wait", reason: `${how}: account disabled (${account}); ${until}` };
  const credits = broke.size ? `; ${[...broke].join(", ")} ${OUT_OF_CREDITS}` : "";
  return { wait: at, known, why: "wait", reason: `${how}: no account with room on ${tried.join(", ")}${below}${credits}; ${until}` };
}

// Match the running/held place to its step, including the account's plan. A stored step plan
// further disambiguates Any from a named step when both offer the same account.
// U149: a recorded or ladder model against a live one. A ladder word (opus, sonnet: letters only)
// matches a live model id that contains it (claude-opus-5-5); anything else matches exactly.
export function sameModel(word: string, live: string): boolean {
  return word === live || (/^[a-z]+$/.test(word) && live.includes(word));
}

export function placeRung(store: Store, rungs: Rung[], place: { agent: string; model: string; account: string | null; plan?: string | null }): number | null {
  const actual = accountPlan(store, place.agent, place.account);
  const i = rungs.findIndex((r) => r.agent === place.agent && (sameModel(r.model, place.model) || museResolve(r.model) === place.model)
    && matchesPlan(r.plan, actual) && (place.plan === undefined || r.plan === place.plan));
  return i < 0 ? null : i;
}

// The agent of a model: a ladder rung with it, else models.conf (`<agent>|<model>`), else null.
export function agentOf(store: Store, project: string, model: string, rungs: Rung[]): string | null {
  const r = rungs.find((x) => x.model === model);
  if (r) return r.agent;
  const c = store.db.query("SELECT key FROM config WHERE project IN (?, '') AND file = 'models.conf' AND key LIKE ? ORDER BY project DESC").get(project, `%|${model}`) as { key: string } | null;
  return c ? c.key.split("|")[0] : rungs[0]?.agent ?? null;
}

// The pick as `ds pick` prints it: agent model effort account fallback, `-` for none.
export function tuple(p: Picked): string {
  return [p.agent, p.model, p.effort ?? "-", p.account ?? "-", p.fallback ? "1" : "0"].join("\t");
}
