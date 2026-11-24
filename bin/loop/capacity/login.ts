// login.ts — an account whose Claude login ended (claude-login-ended U2), host-wide. Shaped like credits.ts.
//
// Evidence that the account's login ended:
//   - its usage probe (observed_accounts, accounts-refresh) notes `login ended` (U1: `login ended · default
//     config`, `login ended · CLAUDE_CONFIG_DIR=<dir>`), or
//   - a member's screen shows Claude's `… · Please run /login` line (limits/fingerprints.ts, kind `login`).
// Either holds the account: one host-wide episode
//   { project '', subject `login|<agent>/<account>`, kind 'account', state `<agent>/<account>` }
// whose ended_at is renewed to now + 1 h each tick while the evidence stands, so pick.ts leaves the account
// out on every rung and names it `login ended`. A new hold records one `account_login_ended` event
// (from `screen` or `probe`). The hold ends when
//   - the probe goes from `login ended` to an allowance (a reading with numbers, or no usage yet), or
//   - the operator clears it: `ds account enable <agent>:<account>` or `ds limit-lift`, or
//   - an hour passes with no evidence.
// A clear (clearLogin) lifts every block of the account (account-lift.ts), ends the hold, marks each
// member's open login episode `cleared` (the limits reconciler keeps it closed while that same line is on
// its screen) and records one `account_login_cleared` event with `by`. After an operator clear only a
// `login ended` reading taken after the clear (its `updated`, the refresh's time: the state observer bumps
// observed_at on every pass) holds the account again; after the probe's own clear a note that comes back
// holds it at once.
import type { Row, Store } from "../core/store.ts";
import { liftAccount, type Lifted } from "./account-lift.ts";

export const LOGIN_ENDED = "login ended";
export const LOGIN_HOLD_S = 3600;

export const loginKey = (agent: string, account: string) => ({ project: "", subject: `login|${agent}/${account}`, kind: "account" });
// The probe's last word on the account: `out` (login ended), `ok`, or `cleared` (an operator clear, at
// its started_at).
const probeKey = (agent: string, account: string) => ({ project: "", subject: `login|${agent}/${account}`, kind: "login-probe" });

// The notice a member gets while its account is held with no line on its screen (limits.ts loginOf).
export const heldNotice = (agent: string, account: string) => `account ${agent}/${account}: ${LOGIN_ENDED}`;

// The live login hold's end per `<agent>/<account>`.
export function loginHolds(store: Store, now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of liveLoginHolds(store, now)) out.set(`${h.agent}/${h.account}`, h.until);
  return out;
}

export function loginHold(store: Store, agent: string, account: string, now: number): number | null {
  const end = Number(store.get("episodes", loginKey(agent, account))?.ended_at ?? 0);
  return end > now ? end : null;
}

// Holds the account until t + LOGIN_HOLD_S: a live hold is renewed, a new one records one
// `account_login_ended` event. True when a new hold started.
export function holdLogin(store: Store, h: { agent: string; account: string; from: "screen" | "probe"; project?: string | null; notice?: string }, t: number): boolean {
  const key = loginKey(h.agent, h.account), until = t + LOGIN_HOLD_S;
  const end = Number(store.get("episodes", key)?.ended_at ?? 0);
  if (end > t) {
    // Renewed at most once a minute: one write a minute, not one a tick.
    if (until - end >= 60) store.upsert("episodes", key, { ended_at: until, observed_at: t });
    return false;
  }
  store.fact("account_login_ended", [{ table: "episodes", key, set: { state: `${h.agent}/${h.account}`, started_at: t, ended_at: until, count: 1,
    episode_key: h.from, source: "loop", observed_at: t, picked: null } }],
  { project: h.project ?? null, payload: { agent: h.agent, account: h.account, from: h.from, ...(h.notice ? { notice: h.notice } : {}) } });
  return true;
}

// Ends the account's hold: every block lifted, each member's open login episode `cleared` (ended now),
// the hold row kept with ended_at now (its episode_key `cleared`), one `account_login_cleared` event.
export function clearLogin(store: Store, agent: string, account: string, by: string, at: number): Lifted & { held: boolean; members_cleared: number } {
  const held = loginHold(store, agent, account, at) !== null;
  const lifted = liftAccount(store, agent, account, at);
  return store.tx(() => {
    // ended_at now too: switches.ts reads a member's episode by its ended_at.
    const cleared = store.db.run(`UPDATE episodes SET state = 'cleared', ended_at = ?, observed_at = ? WHERE kind = 'limited' AND state = 'login'
      AND substr(episode_key, 1, ?) = ?`, [at, at, agent.length + account.length + 2, `${agent}/${account}|`]).changes;
    store.upsert("episodes", loginKey(agent, account), { state: `${agent}/${account}`, ended_at: at, episode_key: "cleared", source: "loop", observed_at: at });
    // The probe's own clear is followed by its `ok`; an operator's is remembered with its time.
    if (by !== "probe") store.upsert("episodes", probeKey(agent, account), { state: "cleared", started_at: at, source: "loop", observed_at: at });
    const r = { ...lifted, held, members_cleared: cleared };
    store.event("account_login_cleared", { payload: { ...r, by } });
    return r;
  });
}

// A member's limited episode key (`<agent>/<account>|<notice>`) is a login one: its notice is Claude's
// `… · Please run /login` line or the held notice above. A cleared episode keeps its key, not its state.
export const isLoginKey = (ek: unknown) => /· Please run \/login\s*$|: login ended$/.test(String(ek ?? ""));

// The wake key of the one "works again" tell after a login clear (switches.ts okKey, decide.ts), and
// whether it went out (the `wake:login-ok` row, as switches.ts toldAlready reads it).
export const loginOkKey = (ep: Row) => `login-ok|${String(ep.episode_key)}@${Number(ep.started_at)}`;
export const loginTold = (store: Store, project: string, wt: string, ep: Row) =>
  store.get("episodes", { project, subject: wt, kind: "wake:login-ok" })?.episode_key === loginOkKey(ep);

const num = (v: unknown) => v != null && /^[0-9]+(\.[0-9]+)?$/.test(String(v));
const noteOf = (a: Row) => { const n = String(a.note ?? "").trim(); return n === "-" ? "" : n; };

// The usage probes: a note `login ended` holds the account (renewed while it stands); an allowance after
// it ends the hold. Rows that are only unknown, `expired` or `refused` neither hold nor clear.
export function probeLogin(store: Store, project: string, t: number): void {
  for (const a of store.db.query("SELECT agent, account, session_pct, weekly_pct, note, updated FROM observed_accounts").all() as Row[]) {
    const agent = String(a.agent), account = String(a.account), note = noteOf(a);
    const probe = store.get("episodes", probeKey(agent, account)), was = String(probe?.state ?? "");
    const set = (state: string) => { if (was !== state) store.upsert("episodes", probeKey(agent, account), { state, started_at: t, source: "loop", observed_at: t }); };
    if (note.startsWith(LOGIN_ENDED)) {
      // An operator cleared it: only a reading taken after the clear holds it again. `updated` is when the
      // refresh read it; observed_at moves on every observer pass, so it cannot tell.
      if (was === "cleared" && (Number(a.updated) || 0) <= Number(probe?.started_at ?? 0)) continue;
      set("out");
      holdLogin(store, { agent, account, from: "probe", project, notice: note }, t);
      continue;
    }
    const allowance = num(a.session_pct) || num(a.weekly_pct) || note.startsWith("no usage yet");
    if (!allowance) continue;
    if (was === "out" && loginHold(store, agent, account, t) !== null) clearLogin(store, agent, account, "probe", t);
    set("ok");
  }
}

// U3 and U4 read these: every live login hold, host-wide.
export type LoginHold = { agent: string; account: string; started: number; until: number; from: string };

export function liveLoginHolds(store: Store, now: number): LoginHold[] {
  return (store.db.query("SELECT state, started_at, ended_at, episode_key FROM episodes WHERE project = '' AND kind = 'account' AND substr(subject, 1, 6) = 'login|' AND ended_at > ? ORDER BY subject")
    .all(now) as Row[]).flatMap((e) => {
    const s = String(e.state ?? ""), i = s.indexOf("/");
    return i > 0 ? [{ agent: s.slice(0, i), account: s.slice(i + 1), started: Number(e.started_at ?? 0), until: Number(e.ended_at), from: String(e.episode_key ?? "") }] : [];
  });
}
