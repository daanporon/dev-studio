// login-card.ts — the Needs-you card for an account whose Claude login ended (claude-login-ended U3).
//
// Run by the limits reconciler each tick, per project, with the workers it built (any role, the Studio
// too), next to credits-card.ts. For every live login hold (login.ts) with a member of this project on it:
// one `alert`, subject `login.card|<agent>/<account>`, card kind login_ended (card-place.ts: Needs-you at
// once), titled `<label>: login ended`, saying where to run /login and who is on the account (the ones the
// picker cannot move first, marked). Unlike the credits card, a member that moved does not take it away:
// the login still needs the operator. It is raised while anyone is on the account, the Studio included.
// The card carries `login: {agent, account}`; fulfil/studio.ts's dismiss acts on the answers:
//   Logged in      ends the hold (login.ts clearLogin, by board); a reading after it that still says
//                  ended holds the account again, as a new hold (a new card)
//   Switch it off  switches the account off (setAccountEnabled false)
// It clears itself (alert-clear) when the hold ends or nobody of the project is on the account. When every
// member moved: one loop note, subject `login.moved|<agent>/<account>`, card kind login_moved, cleared when
// the hold ends. The members seen on a held account are kept in the episode
// {subject login.card|<agent>/<account>, kind login-seen}, state {hold, wts}.
import { alertId } from "../core/actuator.ts";
import type { Action, TickCtx } from "../core/plugins.ts";
import type { Row } from "../core/store.ts";
import { SWITCH_OFF, stuck } from "./credits-card.ts";
import { liveLoginHolds, LOGIN_ENDED, type LoginHold } from "./login.ts";
import type { Picker, Worker } from "../reconcilers/limits.ts";

export const LOGIN_KIND = "login_ended";
export const LOGIN_MOVED_KIND = "login_moved";
export const LOGGED_IN = "Logged in";
export { SWITCH_OFF };
const CARD = "login.card|", MOVED = "login.moved|";

type On = { w: Worker; studio: boolean; stuck: boolean };

const name = (h: { agent: string; account: string }) => `${h.agent}/${h.account}`;
const whoOf = (o: On) => `${o.w.who} (${o.w.squad})${o.stuck ? " — cannot move" : ""}`;

// The command to run, from the probe note's `· <where>` tail (`default config` or `CLAUDE_CONFIG_DIR=<dir>`).
export function loginCommand(note: string | null): string {
  const where = note?.startsWith(LOGIN_ENDED) ? note.split("·").slice(1).join("·").trim() : "";
  if (where.startsWith("CLAUDE_CONFIG_DIR=")) return `${where} claude /login`;
  if (where === "default config") return "claude /login";
  return "claude /login with that account's config dir";
}

export function cardText(label: string, terminal: string, cmd: string, who: string[]): string {
  return `${label}: login ended — run /login in ${terminal} (or \`${cmd}\`). Stuck on it: ${who.join(", ")}. Press ${LOGGED_IN} once it works, or ${SWITCH_OFF} to disable the account and restart them.`;
}

// One tick's cards. `workers` are the project's running members the limits reconciler looked at.
export function loginCards(ctx: TickCtx, pick: Picker, workers: { w: Worker; studio: boolean }[]): Action[] {
  const { store, project: P, now: t } = ctx;
  const actions: Action[] = [];
  const claim = (subject: string, kind: string) => store.get("episodes", { project: P, subject, kind: `action:${kind}` });
  const up = (subject: string): string | null => {
    const sent = claim(subject, "alert")?.episode_key;
    if (typeof sent !== "string") return null;
    return claim(subject, "alert-clear")?.episode_key === `cleared@${sent}` ? null : sent;
  };
  const clear = (subject: string) => {
    const ep = up(subject);
    if (ep) actions.push({ project: P, squad: null, member: null, subject, kind: "alert-clear", episode: `cleared@${ep}`, payload: { target: "project", id: alertId(subject, ep) } });
  };
  const live = new Set<string>();
  for (const h of liveLoginHolds(store, t) as LoginHold[]) {
    const key = name(h), base = `login|${key}@${h.started}`, subject = `${CARD}${key}`;
    live.add(key);
    const on: On[] = workers.filter(({ w }) => w.agent === h.agent && w.account === h.account)
      .map(({ w, studio }) => ({ w, studio, stuck: !studio && stuck(ctx, pick, w, h) }))
      .sort((a, b) => Number(b.stuck) - Number(a.stuck));
    const seenKey = { project: P, subject, kind: "login-seen" };
    let seen: string[] = [];
    try { const s = JSON.parse(String(store.get("episodes", seenKey)?.state ?? "{}")); if (s.hold === base && Array.isArray(s.wts)) seen = s.wts.map(String); } catch { /* another hold's, or none */ }
    const add = on.map((o) => o.w.wt).filter((wt) => !seen.includes(wt));
    if (add.length) {
      seen = [...seen, ...add];
      store.upsert("episodes", seenKey, { state: JSON.stringify({ hold: base, wts: seen }), started_at: h.started, source: "loop", observed_at: t });
    }
    if (on.length) {
      const last = up(subject);
      const ep = last && (last === base || last.startsWith(`${base}@`)) ? last : `${base}@${t}`;
      if (ep !== last) {
        clear(subject);
        const acct = store.get("observed_accounts", { agent: h.agent, account: h.account });
        const label = String(acct?.label ?? "").trim() && acct?.label !== "-" ? String(acct?.label) : key;
        const terminal = on.some((o) => o.studio) ? "the Studio's terminal" : `${on[0].w.who}'s terminal`;
        actions.push({ project: P, squad: null, member: null, subject, kind: "alert", episode: ep, payload: {
          title: `${label}: login ended`, text: cardText(label, terminal, loginCommand(String(acct?.note ?? "")), on.map((o) => o.studio ? "the Studio" : whoOf(o))),
          card: LOGIN_KIND, fields: { login: { agent: h.agent, account: h.account }, options: [LOGGED_IN, SWITCH_OFF] } } });
      }
      continue;
    }
    clear(subject);
    const moved = workers.filter(({ w }) => seen.includes(w.wt));
    if (!moved.length) continue;
    const msub = `${MOVED}${key}`;
    if (claim(msub, "alert")?.episode_key === base) continue;
    const rungs = [...new Set(moved.map(({ w }) => `${w.agent}/${w.model || "-"}`))].join(", ");
    actions.push({ project: P, squad: null, member: null, subject: msub, kind: "alert", episode: base, payload: {
      title: `${key} login ended`, text: `${key} login ended — moved ${moved.length} member${moved.length === 1 ? "" : "s"} to ${rungs}`, card: LOGIN_MOVED_KIND } });
  }
  for (const r of store.db.query("SELECT DISTINCT subject FROM episodes WHERE project = ? AND kind = 'action:alert' AND (substr(subject, 1, ?) = ? OR substr(subject, 1, ?) = ?)")
    .all(P, CARD.length, CARD, MOVED.length, MOVED) as Row[]) {
    const subject = String(r.subject), key = subject.slice(subject.indexOf("|") + 1);
    if (!live.has(key)) clear(subject);
  }
  return actions;
}
