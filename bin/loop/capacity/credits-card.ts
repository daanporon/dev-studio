// credits-card.ts — the Needs-you card for an account out of credits (provider-billing-fallback U4).
//
// Run by the limits reconciler each tick, per project, with the workers it built (any role, the Studio
// too). For every account with a live credits hold (credits.ts), the project's members running on it:
//   a member is STUCK when the picker has nowhere else for it (every other rung blocked, a pin, a wait).
//   The Studio is never stuck here: limits.ts moves it (studio_move auto) or files its own studio.limit
//   card (ask, off, nowhere to go), so it is not picked again; it only counts as still on the account.
// While any member is stuck: one `alert` per account, subject `credits.card|<agent>/<account>`, card kind
// out_of_credits (card-place.ts: Needs-you once it has lasted needs_grace_min), titled
// `<agent>/<account> out of credits`, naming the notice, the provider's link, who is stuck and the two
// answers, which fulfil/studio.ts's dismiss acts on (the card carries `credits: {agent, account}`):
//   Fixed          ends the hold (accounts.ts setAccountEnabled true -> credits.ts clearCredits)
//   Switch it off  switches the account off (setAccountEnabled false)
// It clears itself (alert-clear) when the hold ends or nobody is stuck any more; one that comes back
// within the same hold is a new card (episode `<hold>@<t>`). An answered card stays answered.
// When every member moved (none left on the account, at least one of those seen on it now runs elsewhere):
// one loop note, subject `credits.moved|<agent>/<account>`, "<agent>/<account> out of credits — moved <n>
// members to <rungs>", cleared when the hold ends. The members seen on a held account are kept in the
// episode {subject credits.card|<agent>/<account>, kind credits-seen}, state {hold, wts}.
import { alertId } from "../core/actuator.ts";
import type { Action, TickCtx } from "../core/plugins.ts";
import type { Row } from "../core/store.ts";
import { creditsNotice, liveHolds, type Hold } from "./credits.ts";
import { overrideOf } from "./pick.ts";
import type { Picker, Worker } from "../reconcilers/limits.ts";

export const CREDITS_KIND = "out_of_credits";
export const MOVED_KIND = "credits_moved";
export const FIXED = "Fixed";
export const SWITCH_OFF = "Switch it off";
const CARD = "credits.card|", MOVED = "credits.moved|";

type On = { w: Worker; stuck: boolean };

// Is the crew member stuck on its held account: the picker finds no other place (or it is pinned there)?
export function stuck(ctx: TickCtx, pick: Picker, w: Worker, h: { agent: string; account: string; until: number }): boolean {
  const { store, project: P } = ctx;
  if (overrideOf(store, w.m)) return true;
  const unit = store.db.query("SELECT tier FROM units WHERE project = ? AND squad = ? AND slug = ?").get(P, w.squad, w.suffix) as Row | null;
  const p = pick({ project: P, squad: w.squad, role: w.role, suffix: w.suffix,
    tier: (w.m?.tier as string | null) ?? (unit?.tier as string | null) ?? null, phase: (w.m?.phase as string | null) ?? "build",
    ...(w.m?.id != null ? { member: Number(w.m.id) } : {}), limited: { agent: h.agent, account: h.account, until: h.until } }, ctx);
  if (!p || "wait" in p) return true;
  return p.agent === h.agent && (p.account === h.account || p.account === "-");
}

const name = (h: { agent: string; account: string }) => `${h.agent}/${h.account}`;
const whoOf = (o: On) => `${o.w.who} (${o.w.squad})`;

export function cardText(h: Hold, notice: string | null, link: string | null, who: string[]): string {
  const fix = link ? `Fix the billing at ${link}, then press ${FIXED}.` : `Fix the billing with the provider, then press ${FIXED}.`;
  return `${name(h)} is out of credits${notice ? `: ${notice}` : ""}. Stuck on it: ${who.join(", ")}. ${fix} Or switch the account off and restart them.`;
}

// One tick's cards. `workers` are the project's running members the limits reconciler looked at
// (paused and finished ones left out), with the Studio flagged.
export function creditsCards(ctx: TickCtx, pick: Picker, workers: { w: Worker; studio: boolean }[]): Action[] {
  const { store, project: P, now: t } = ctx;
  const actions: Action[] = [];
  const holds = liveHolds(store, t);
  const claim = (subject: string, kind: string) => store.get("episodes", { project: P, subject, kind: `action:${kind}` });
  // The card under `subject` that is still up (sent, not cleared), or null.
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
  for (const h of holds) {
    const key = name(h), base = `credits|${key}@${h.started}`;
    live.add(key);
    const on: On[] = workers.filter(({ w }) => w.agent === h.agent && w.account === h.account)
      .map(({ w, studio }) => ({ w, stuck: !studio && stuck(ctx, pick, w, h) }));
    // The members seen on the account during this hold (by worktree), for the moved note.
    const seenKey = { project: P, subject: `${CARD}${key}`, kind: "credits-seen" };
    const seenRow = store.get("episodes", seenKey);
    let seen: string[] = [];
    try { const s = JSON.parse(String(seenRow?.state ?? "{}")); if (s.hold === base && Array.isArray(s.wts)) seen = s.wts.map(String); } catch { /* another hold's, or none */ }
    const add = on.map((o) => o.w.wt).filter((wt) => !seen.includes(wt));
    if (add.length) {
      seen = [...seen, ...add];
      store.upsert("episodes", seenKey, { state: JSON.stringify({ hold: base, wts: seen }), started_at: h.started, source: "loop", observed_at: t });
    }
    const stuckOn = on.filter((o) => o.stuck);
    const subject = `${CARD}${key}`;
    if (stuckOn.length) {
      const last = up(subject);
      const ep = last && (last === base || last.startsWith(`${base}@`)) ? last : `${base}@${t}`;
      if (ep !== last) {
        clear(subject);
        const { notice, link } = creditsNotice(store, h.agent, h.account, h.started - 60);
        actions.push({ project: P, squad: null, member: null, subject, kind: "alert", episode: ep, payload: {
          title: `${key} out of credits`, text: cardText(h, notice, link, stuckOn.map(whoOf)), card: CREDITS_KIND,
          fields: { credits: { agent: h.agent, account: h.account }, options: [FIXED, SWITCH_OFF], ...(link ? { link } : {}) } } });
      }
      continue;
    }
    clear(subject);
    // Nobody stuck. When nobody of this project is left on it and some moved away: one loop note.
    if (on.length) continue;
    const moved = workers.filter(({ w }) => seen.includes(w.wt) && !(w.agent === h.agent && w.account === h.account));
    if (!moved.length) continue;
    const msub = `${MOVED}${key}`;
    if (claim(msub, "alert")?.episode_key === base) continue;
    const rungs = [...new Set(moved.map(({ w }) => `${w.agent}/${w.model || "-"}`))].join(", ");
    actions.push({ project: P, squad: null, member: null, subject: msub, kind: "alert", episode: base, payload: {
      title: `${key} out of credits`, text: `${key} out of credits — moved ${moved.length} member${moved.length === 1 ? "" : "s"} to ${rungs}`, card: MOVED_KIND } });
  }
  // A card or note whose hold is over.
  for (const r of store.db.query("SELECT DISTINCT subject FROM episodes WHERE project = ? AND kind = 'action:alert' AND (substr(subject, 1, ?) = ? OR substr(subject, 1, ?) = ?)")
    .all(P, CARD.length, CARD, MOVED.length, MOVED) as Row[]) {
    const subject = String(r.subject), key = subject.slice(subject.indexOf("|") + 1);
    if (!live.has(key)) clear(subject);
  }
  return actions;
}
