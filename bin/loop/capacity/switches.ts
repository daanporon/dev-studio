// switches.ts — U154: the decider's switch rows (limit, account off, move back up, phase, pin).
//
// A live member wished running is switched (stopped when idle; the start picks the new place)
// when any of these holds. Every compare uses the live rung from U149 (record.ts liveOf);
// unknown gives nothing. A pinned member (an open override) is never moved by limit or
// fallback. At most one switch per member per tick; U153's own stops win over these.
//
//   limit     limited with another place that has room (the pick proves it, excluding the
//             limited account) -> stop when idle. Limited with nowhere to go -> tell once.
//             Out of credits (episode state `credits`, provider-billing-fallback U3) with nowhere
//             to go -> no tell: "carry on" would be false, its next call fails the same way. Once
//             the hold is cleared (credits.ts clearCredits: the probe or the operator) while it
//             still runs on that account -> one "works again" tell (okKey). An ended login (state
//             `login`, claude-login-ended U2) is the same: no tell while held, one "login works again"
//             tell (key `login-ok|…`) once login.ts clearLogin ends the hold.
//   account   (provider-billing-fallback U5) its live account is switched off (accounts.ts) and the
//             pick, which leaves a disabled account out, lands elsewhere -> stop when idle. One stop
//             per `account_disabled` event (the key carries its id): switching it off again later
//             moves members again, a replay does not. Nowhere to go (a pin to that account makes the
//             pick wait) -> it keeps running. Never a limited one (its limit row moves it, off it too).
//   fallback  a member whose ladder row says `up` (configurable-role-elevation U1: roles.conf
//             column 8, roster.ts resolveBackUp; shipped on for the Thinker only) idle on a lower
//             rung with the top rung free -> stop when idle, at most once per `fallback_return_min`,
//             and only with no live sub-agents and no open
//             background step. U180: the stop needs a start slot whose pick (picks.ts, with every
//             earlier stop of the tick counted as load) still lands above `from`; the stop reserves
//             that place (fulfil/member.ts) until the member is placed or pick_ttl_s passes.
//   phase     a Builder whose phase change is due (phases.ts set babysit after the PR opened,
//             newer than the process start) -> stop when idle. Monotonic: one stop per phase
//             event, so a closed and reopened PR causes no second restart.
//   pin       a pin (overrides row) newer than the process start and differing from the live
//             rung -> stop when idle. A live rung differing from an older pin or from the
//             record is adopted (record.ts), no act.
import { liveAccount, liveOf } from "../reconcilers/record.ts";
import { liveSquads, stepOpen } from "../reconcilers/liveness.ts";
import { worker, type Worker } from "../reconcilers/limits.ts";
import { envInt } from "../core/tick.ts";
import { BABYSIT } from "../reconcilers/phases.ts";
import { agentOf, ladder, limit, overrideOf, pick, placeRung, sameModel, workDone } from "./pick.ts";
import { backUpOf } from "../settings/roster.ts";
import { memberUnit, mergedUnit } from "../pause/pause-conditions.ts";
import type { Target } from "../pause/pause.ts";
import { accountDisabled } from "./accounts.ts";
import { lastStart, view } from "../squad/member-state.ts";
import type { Row, Store } from "../core/store.ts";
import { isLoginKey, loginOkKey } from "./login.ts";

export type SwitchWhy = "limit" | "account" | "fallback" | "phase" | "pin";
export const SWITCH_WHYS: readonly string[] = ["limit", "account", "fallback", "phase", "pin"];
// `from`: a fallback stop's current rung (1-based); its start must land above it (U180).
export type Switch = { why: SwitchWhy; episode: string; from?: number };

// The live worker (limits.ts worker()) the decider reads this member on, or null.
function workerRow(store: Store, m: Row, now: number): Worker | null {
  if (!m.wt) return null;
  const w = worker(store, String(m.project), m, String(m.wt), null, now);
  return w && w.ow.presence === "running" && w.ow.gone_at == null ? w : null;
}

const procStart = (m: Row, w: Worker | null) =>
  Number(w?.ow.started_at ?? 0) || lastStart(m);

// The member's limit episode while it holds, else null. A short known wait (limit-wait) is
// waited out, not switched: the decider leaves it alone until the wait ends.
function limitedEp(store: Store, m: Row, now: number): Row | null {
  const wt = m.wt ? String(m.wt) : null;
  if (!wt) return null;
  const ep = store.get("episodes", { project: m.project, subject: wt, kind: "limited" });
  if (!ep || ep.state === "closed" || ep.state === "expired" || Number(ep.ended_at ?? 0) <= now) return null;
  const wait = store.get("episodes", { project: m.project, subject: wt, kind: "limit-wait" });
  if (wait?.state === "waiting") return null;
  return ep;
}

// The member's tier and phase for a move pick (a Builder's unit tier, the member's phase).
function tierPhase(store: Store, project: string, m: Row): { tier: string | null; phase: string } {
  const unit = store.db.query("SELECT tier FROM units WHERE project = ? AND squad = ? AND slug = ?")
    .get(project, String(m.squad), String(m.suffix ?? "")) as { tier: string | null } | null;
  return { tier: (m.tier as string | null) ?? unit?.tier ?? null, phase: (m.phase as string | null) ?? "build" };
}

const liveSquad = (store: Store, m: Row): boolean =>
  liveSquads(store, String(m.project)).some((s) => s.topic === m.squad);

// The rung the member really runs on (the live main's, else the record's), or null when neither
// places it on the ladder. On another agent than the record with its model unknown it is on no rung.
function rungOf(store: Store, lad: { rungs: Parameters<typeof placeRung>[1] }, m: Row, w: Worker, now: number): number | null {
  const live = liveOf(w.ow, now);
  const agent = live?.agent ?? String(m.agent ?? "");
  const account = live ? live.account : (m.account as string | null) ?? null;
  const model = !live ? String(m.model ?? "") : live.agent !== m.agent ? live.model ?? "" : live.model ?? String(m.model ?? "");
  return placeRung(store, lad.rungs, { agent, model, account });
}

function flagged(m: Row): boolean {
  try { return JSON.parse(String(m.doc ?? "{}")).fallback === true; } catch { return false; }
}

// A limited member's stop: another place with room (the pick proves it). Its episode is
// `stop:limit:<limit episode key>@<its started_at>` (U200): a member limited again later, or caught
// by an older key's stop that never ran, gets a fresh stop, and the fulfiller keys its calls by member. Elsewhere the tell
// (tellKey) carries the one "carry on". A pinned member is never moved by a limit.
function limitFacts(store: Store, m: Row, w: Worker, ep: Row, now: number): Facts {
  const project = String(m.project);
  // U3: an account out of credits gets no "carry on": nothing changes until its hold is cleared. Nor
  // one whose login ended (claude-login-ended U2).
  const tell = ep.state === "credits" || ep.state === "login" ? null : tellKey(ep);
  if (overrideOf(store, m)) return { stop: null, tell, ok: null };
  const until = Number(ep.ended_at);
  const { tier, phase } = tierPhase(store, project, m);
  const p = pick(store, { project, role: w.role, tier, phase, squad: w.squad, member: Number(m.id),
    limited: [`${w.agent}:${w.account}=${until}`] }, now);
  if ("error" in p || "wait" in p || !liveSquad(store, m)) return { stop: null, tell, ok: null };
  // The sameness check runs against the worker's live rung: the same agent and account with a
  // matching model is no move, only the one tell.
  const isSame = p.agent === w.agent && (p.account === w.account || p.account === "-") && (!w.model || sameModel(p.model, w.model));
  if (isSame) return { stop: null, tell, ok: null };
  return { stop: { why: "limit", episode: `stop:limit:${String(ep.episode_key)}@${Number(ep.started_at)}` }, tell: null, ok: null };
}

// The wake episode key of the one tell for this limit episode.
function tellKey(ep: Row): string {
  return `tell|${String(ep.episode_key)}`;
}

// U3: the wake key of the one "works again" tell, when the member's credits episode was cleared
// (clearCredits marks it `cleared`; the limits reconciler keeps it so while that notice is on screen)
// and the member still runs on that account. A member that moved, or wrote on (closed), gets none;
// nor one already told, so a told member's act never holds back a due start, reload or clear. The
// key carries the episode's start: Claude's and Codex's notices have no request id, so a second
// 402 on the same account repeats the episode key. A cleared login episode (claude-login-ended U2) gets
// the `login-ok|…` key instead (decide.ts tells "your account's login works again").
function okKey(store: Store, m: Row, w: Worker): string | null {
  const wt = String(m.wt), ep = store.get("episodes", { project: m.project, subject: wt, kind: "limited" });
  if (ep?.state !== "cleared" || ep.source !== "loop" || !w.account) return null;
  if (!String(ep.episode_key ?? "").startsWith(`${w.agent}/${w.account}|`)) return null;
  if (isLoginKey(ep.episode_key)) {
    const key = loginOkKey(ep);
    return toldAlready(store, String(m.project), wt, key, "login-ok") ? null : key;
  }
  const key = `credits-ok|${String(ep.episode_key)}@${Number(ep.started_at)}`;
  return toldAlready(store, String(m.project), wt, key, "credits-ok") ? null : key;
}

// U5: the member's live account is switched off: move it when the pick (which leaves a disabled
// account out on every rung) has somewhere else to go. The episode names the account and the
// `account_disabled` event that switched it off, so a replay is the same stop and a later switch-off
// is a new one. With nowhere to go it keeps running.
function accountStop(store: Store, m: Row, w: Worker, now: number): Switch | null {
  const agent = w.agent, account = liveAccount(w.ow, m, now);
  if (!account || !accountDisabled(store, agent, account)) return null;
  const project = String(m.project), { tier, phase } = tierPhase(store, project, m);
  const p = pick(store, { project, role: w.role, tier, phase, squad: w.squad, member: Number(m.id) }, now);
  if ("error" in p || "wait" in p || !liveSquad(store, m)) return null;
  if (p.agent === agent && (p.account === account || p.account === "-")) return null;
  const ev = store.db.query(`SELECT id FROM events WHERE kind = 'account_disabled'
      AND json_extract(payload, '$.agent') = ? AND json_extract(payload, '$.account') = ? ORDER BY id DESC LIMIT 1`)
    .get(agent, account) as { id: number } | null;
  return { why: "account", episode: `stop:account:${agent}/${account}@${ev?.id ?? 0}` };
}

// A member's move back up (U66, from reconcilers/fallback.ts): idle on a lower rung with the top
// rung free. Only a member whose ladder row (the row its models come from) resolves `up` moves back
// up (configurable-role-elevation U1; shipped: the Thinker); a pinned or limited member is left to
// its row, and a Builder whose unit is finished waits to be retired, not moved.
function fallbackStop(store: Store, m: Row, w: Worker, now: number): Switch | null {
  const project = String(m.project), role = String(m.role);
  if (overrideOf(store, m)) return null;
  if (Number(m.limited_until ?? 0) > now || limitedEp(store, m, now)) return null;
  if (w.state !== "idle" && w.state !== "done") return null;
  if (w.ow.sub_agents != null || stepOpen(store, String(m.wt))) return null;
  const repo = (store.get("squads", { project, topic: String(m.squad) })?.repo as string | null) ?? null;
  const { tier, phase } = tierPhase(store, project, m);
  const lad = ladder(store, { project, role, tier, phase, squad: String(m.squad) }, repo);
  if (!lad || !backUpOf(store, project, lad.row)) return null;
  if (workDone(store, m)) return null;
  const unit = memberUnit(store, m as Target);
  if (unit && mergedUnit(store, unit)) return null;
  const here = rungOf(store, lad, m, w, now);
  if (here === 0 || (here === null && !flagged(m))) return null;
  const p = pick(store, { project, role, tier, phase, squad: String(m.squad), member: Number(m.id) }, now);
  if ("error" in p || "wait" in p) return null;
  const to = p.rung - 1, from = here ?? lad.rungs.length;
  if (to >= from) return null;
  // At most one move per window: the last acted fallback stop's marker starts it (written by
  // fulfil/member.ts when the stop acts, so emission-time checks never see their own try).
  const minRaw = Number(limit(store, project, "fallback_return_min")), min = Number.isFinite(minRaw) && minRaw >= 0 ? minRaw : 15;
  if (min === 0) return null;
  const marker = store.get("episodes", { project, subject: `member:${m.id}`, kind: "fallback-return" });
  if (marker && now - Number(marker.started_at ?? 0) < min * 60) return null;
  // The acted stop's marker starts the window cycle: without it in the key, a return owed after
  // the window would replay the already-completed seat call instead of stopping again.
  const cyc = marker ? `:${Number(marker.started_at ?? 0)}` : "";
  return { why: "fallback", episode: `stop:fallback:rung${from + 1}->${p.rung}${cyc}`, from: from + 1 };
}

// A Builder's phase stop: its babysit event is newer than its process start (monotonic: one stop
// per phase event, so a closed and reopened PR causes no second restart).
function phaseStop(store: Store, m: Row, w: Worker, _now: number): Switch | null {
  if (String(m.role) !== "builder" || String(m.phase ?? "") !== BABYSIT) return null;
  const squad = store.get("squads", { project: String(m.project), topic: String(m.squad) });
  if (!squad || String(squad.status ?? "") === "closed") return null;
  const ev = store.db.query(`SELECT at FROM events WHERE kind = 'member_phase' AND project = ? AND member = ?
      AND json_extract(payload, '$.phase') = 'babysit' ORDER BY at DESC LIMIT 1`)
    .get(String(m.project), String(m.wt)) as { at: number } | null;
  if (!ev || Number(ev.at) <= procStart(m, w)) return null;
  return { why: "phase", episode: `stop:phase:${Number(ev.at)}` };
}

// A pin's stop: the override is newer than the process start and names another rung than the
// live one. An older pin, or one the live agent already matches, is adopted: no act.
function pinStop(store: Store, m: Row, w: Worker, now: number): Switch | null {
  const ov = overrideOf(store, m);
  if (!ov) return null;
  if (!(Number(ov.set_at ?? 0) > procStart(m, w))) return null;
  const live = liveOf(w.ow, now);
  if (!live?.model && !live?.account) return null;
  const modelDiffers = !!((ov.model as string | null) && live?.model && !sameModel(String(ov.model), live.model));
  const accountDiffers = !!((ov.account as string | null) && live?.account && ov.account !== live.account);
  if (!modelDiffers && !accountDiffers) return null;
  // The pin's rung differs from the live rung: confirm on the ladder (a ladder word matches a
  // live model id that contains it; an agent mismatch alone is not a move without a model).
  if (ov.model && live?.model) {
    const project = String(m.project);
    const repo = (store.get("squads", { project, topic: String(m.squad) })?.repo as string | null) ?? null;
    const { tier, phase } = tierPhase(store, project, m);
    const lad = ladder(store, { project, role: String(m.role), tier, phase, squad: String(m.squad) }, repo);
    if (lad) {
      const agent = (ov.model ? agentOf(store, project, String(ov.model), lad.rungs) : null) ?? live.agent;
      const pinRung = placeRung(store, lad.rungs, { agent, model: String(ov.model), account: (ov.account as string | null) ?? live.account });
      const liveRung = placeRung(store, lad.rungs, { agent: live.agent, model: live.model, account: live.account });
      if (pinRung !== null && liveRung !== null && pinRung === liveRung) return null;
    }
  }
  return { why: "pin", episode: `stop:pin:${Number(ov.id)}` };
}

// The one switch this member is owed now (limit, account, fallback, phase, pin, in that order), the tell key
// when it is limited with nowhere to go, and the "works again" key once its credits hold was
// cleared (U3). Unknown gives nothing.
type Facts = { stop: Switch | null; tell: string | null; ok: string | null };
export function switchFacts(store: Store, m: Row, now: number): Facts {
  const none: Facts = { stop: null, tell: null, ok: null };
  if (view(store, m) !== "running") return none;
  const w = workerRow(store, m, now);
  if (!w) return none;
  const ep = limitedEp(store, m, now);
  if (ep) return limitFacts(store, m, w, ep, now);
  return {
    stop: accountStop(store, m, w, now) ?? fallbackStop(store, m, w, now) ?? phaseStop(store, m, w, now) ?? pinStop(store, m, w, now),
    tell: null, ok: okKey(store, m, w),
  };
}

// A working member stuck on its limit switches like an idle one: the dialog sits on its screen,
// or it has been silent past SILENT_MIN (the usage path only limits working members that far
// gone). The old run-switch moved any state except waiting; waiting members still wait.
export function limitStuck(store: Store, m: Row, now: number): boolean {
  if (switchFacts(store, m, now).stop?.why !== "limit") return false;
  const w = workerRow(store, m, now);
  if (!w || w.state !== "working") return false;
  const dialog = String(w.ow.limited ?? "").split("\t").includes("dialog");
  const silent = w.lastOutput !== null && now - w.lastOutput >= envInt("DS_SWEEP_SILENT_MIN", 10) * 60;
  return dialog || silent;
}

// The tell key's wake row already told it: the tell went out once (`reason` credits-ok: U3's; login-ok:
// claude-login-ended U2's).
export function toldAlready(store: Store, project: string, wt: string, key: string, reason = "limit"): boolean {
  return store.get("episodes", { project, subject: wt, kind: `wake:${reason}` })?.episode_key === key;
}
