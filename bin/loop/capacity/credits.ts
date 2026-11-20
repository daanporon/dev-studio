// credits.ts — an account out of credits (provider-billing-fallback U2), host-wide.
//
// A billing error on a member's screen (limits/fingerprints.ts, kind `credits`) or the account's usage
// probe noting `out of credits` (the adapter maps the provider's answer to that note; the loop never
// reads a provider word) holds the account: one host-wide episode
//   { project '', subject `credits|<agent>/<account>`, kind 'account', state `<agent>/<account>` }
// whose ended_at is the hold's end, so pick.ts leaves the account out on every rung and names it
// `out of credits`. A billing error has no reset: the hold lasts credits_hold_h (24) hours, not the
// limit's one-hour guess. It ends earlier when
//   - the probe goes from `out of credits` to an allowance (a reading with numbers, or no usage yet in
//     its window), or
//   - the operator clears it: `ds account enable <agent>:<account>` (setAccountEnabled), or `ds
//     limit-lift`.
// A clear (clearCredits) lifts every block of the account (account-lift.ts), ends the hold, marks each
// member's open credits episode `cleared` (the limits reconciler leaves it closed while that same notice
// is on its screen; a new billing line opens a new one) and records one `account_credits_cleared` event
// with `by`. After an operator clear the probe's old `out of credits` note does not hold the account
// again: only a note that recovers and then runs out again does (the `credits-probe` memory below).
import type { Row, Store } from "../core/store.ts";
import { liftAccount, type Lifted } from "./account-lift.ts";
import { limit } from "../settings/limits.ts";

export const OUT_OF_CREDITS = "out of credits";
const DEFAULT_HOLD_H = 24;

export const creditsKey = (agent: string, account: string) => ({ project: "", subject: `credits|${agent}/${account}`, kind: "account" });
// The probe's last word on the account: `out`, `ok`, or `cleared` (the operator cleared it while the
// probe still said out).
const probeKey = (agent: string, account: string) => ({ project: "", subject: `credits|${agent}/${account}`, kind: "credits-probe" });

// credits_hold_h in seconds (a project's own value, else the default's; not a positive number = 24).
export function creditsHoldS(store: Store, project: string): number {
  const h = Number(limit(store, project, "credits_hold_h"));
  return (Number.isFinite(h) && h > 0 ? h : DEFAULT_HOLD_H) * 3600;
}

// The live credits hold's end per `<agent>/<account>`.
export function creditsHolds(store: Store, now: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of store.db.query("SELECT state, ended_at FROM episodes WHERE project = '' AND kind = 'account' AND substr(subject, 1, 8) = 'credits|' AND ended_at > ?").all(now) as Row[]) {
    out.set(String(e.state), Number(e.ended_at));
  }
  return out;
}

export function creditsHold(store: Store, agent: string, account: string, now: number): number | null {
  const end = Number(store.get("episodes", creditsKey(agent, account))?.ended_at ?? 0);
  return end > now ? end : null;
}

// Holds the account until `until` (a live hold is only ever lengthened). A new hold records one
// `account_credits_held` event. True when a new hold started.
export function holdCredits(store: Store, h: { agent: string; account: string; until: number; from: string; project?: string | null; notice?: string; link?: string }, t: number): boolean {
  const key = creditsKey(h.agent, h.account), prev = store.get("episodes", key);
  const end = Number(prev?.ended_at ?? 0);
  if (end > t) {
    if (h.until > end) store.upsert("episodes", key, { ended_at: h.until, observed_at: t });
    return false;
  }
  store.fact("account_credits_held", [{ table: "episodes", key, set: { state: `${h.agent}/${h.account}`, started_at: t, ended_at: h.until, count: 1,
    episode_key: h.from, source: "loop", observed_at: t, picked: null } }],
  { project: h.project ?? null, payload: { agent: h.agent, account: h.account, until: h.until, from: h.from, ...(h.notice ? { notice: h.notice } : {}), ...(h.link ? { link: h.link } : {}) } });
  return true;
}

// Ends the account's hold: every block lifted, each member's open credits episode `cleared` (ended now), the hold
// row kept with ended_at now (its episode_key `cleared`), one `account_credits_cleared` event.
export function clearCredits(store: Store, agent: string, account: string, by: string, at: number): Lifted & { held: boolean; members_cleared: number } {
  const held = creditsHold(store, agent, account, at) !== null;
  const lifted = liftAccount(store, agent, account, at);
  return store.tx(() => {
    // ended_at now too: switches.ts and fulfil/member.ts read a member's episode by its ended_at.
    const cleared = store.db.run(`UPDATE episodes SET state = 'cleared', ended_at = ?, observed_at = ? WHERE kind = 'limited' AND state = 'credits'
      AND substr(episode_key, 1, ?) = ?`, [at, at, agent.length + account.length + 2, `${agent}/${account}|`]).changes;
    store.upsert("episodes", creditsKey(agent, account), { state: `${agent}/${account}`, ended_at: at, episode_key: "cleared", source: "loop", observed_at: at });
    const probe = store.get("episodes", probeKey(agent, account));
    if (probe?.state === "out") store.upsert("episodes", probeKey(agent, account), { state: "cleared", observed_at: at });
    const r = { ...lifted, held, members_cleared: cleared };
    store.event("account_credits_cleared", { payload: { ...r, by } });
    return r;
  });
}

const num = (v: unknown) => v != null && /^[0-9]+(\.[0-9]+)?$/.test(String(v));
const noteOf = (a: Row) => { const n = String(a.note ?? "").trim(); return n === "-" ? "" : n; };

// The usage probes (observed_accounts, refreshed by accounts-refresh.sh): a note `out of credits` holds
// the account (no member has to fail first) while it stands; an allowance after it ends the hold.
// Agents whose probe never notes `out of credits` (Claude's and Codex's report subscription windows,
// not credit) never end a hold this way.
export function probeCredits(store: Store, project: string, t: number): void {
  const holdS = creditsHoldS(store, project);
  for (const a of store.db.query("SELECT agent, account, session_pct, weekly_pct, note FROM observed_accounts").all() as Row[]) {
    const agent = String(a.agent), account = String(a.account), note = noteOf(a);
    const was = String(store.get("episodes", probeKey(agent, account))?.state ?? "");
    const set = (state: string) => { if (was !== state) store.upsert("episodes", probeKey(agent, account), { state, started_at: t, source: "loop", observed_at: t }); };
    if (note.startsWith(OUT_OF_CREDITS)) {
      // The operator cleared it while the probe still said so: their word stands until the probe recovers.
      if (was === "cleared") continue;
      set("out");
      if (creditsHold(store, agent, account, t) === null) holdCredits(store, { agent, account, until: t + holdS, from: "probe", project, notice: note }, t);
      continue;
    }
    const allowance = num(a.session_pct) || num(a.weekly_pct) || note.startsWith("no usage yet");
    if (!allowance) continue;
    if (was === "out" && creditsHold(store, agent, account, t) !== null) clearCredits(store, agent, account, "probe", t);
    set("ok");
  }
}

// provider-billing-fallback U4: the card (credits-card.ts) and the board's Accounts rows read these.
export type Hold = { agent: string; account: string; started: number; until: number };

// Every live credits hold, host-wide.
export function liveHolds(store: Store, now: number): Hold[] {
  return (store.db.query("SELECT state, started_at, ended_at FROM episodes WHERE project = '' AND kind = 'account' AND substr(subject, 1, 8) = 'credits|' AND ended_at > ? ORDER BY subject")
    .all(now) as Row[]).flatMap((e) => {
    const s = String(e.state ?? ""), i = s.indexOf("/");
    return i > 0 ? [{ agent: s.slice(0, i), account: s.slice(i + 1), started: Number(e.started_at ?? 0), until: Number(e.ended_at) }] : [];
  });
}

// The notice and the provider's link that held the account, from this hold's events: the hold's own
// (account_credits_held) and its members' (limited, kind credits). A screen's notice wins over the
// probe's bare note; the newest link wins.
export function creditsNotice(store: Store, agent: string, account: string, since: number): { notice: string | null; link: string | null } {
  const rows = store.db.query(`SELECT kind, payload FROM events WHERE kind IN ('account_credits_held', 'limited') AND at >= ? ORDER BY id DESC LIMIT 200`).all(since) as Row[];
  let notice: string | null = null, link: string | null = null, bare: string | null = null;
  for (const r of rows) {
    let p: Row;
    try { p = JSON.parse(String(r.payload ?? "{}")); } catch { continue; }
    const mine = r.kind === "limited" ? p.kind === "credits" && p.account === `${agent}/${account}` : p.agent === agent && p.account === account;
    if (!mine) continue;
    if (!link && typeof p.link === "string" && p.link) link = p.link;
    if (typeof p.notice === "string" && p.notice) {
      if (p.from === "probe") bare ??= p.notice;
      else notice ??= p.notice;
    }
  }
  return { notice: notice ?? bare, link };
}
