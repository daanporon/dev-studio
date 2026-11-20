// record.ts — U149: a member's record follows reality. `members.agent/model/account` are launch facts;
// the main agent the Orca observer found in the member's worktree (observed_workers: walk, agent,
// account, live_model) is what really runs, whoever started it (a hand restart, /ds-restart, Orca).
// A record that differs is set to it once the two have differed for SETTLE_S (DS_LOOP_ACCOUNT_SETTLE_S,
// 120; an `account-drift` episode holds since when and on what), which outlasts a reading taken just
// before a restart wrote its new record. A record whose account is no longer listed while the live one
// is listed is set at once (U55), on the same agent only. Generalises U55's account follow, which lived in limits.ts.
//
// Only a known main: the last walk found one agent (walk `running`), read within 3 reads. Unknown
// (a failed walk, two mains that disagree, no walk yet) and none never change the record. The model
// changes only when the live one is known (Muse: never) and isn't the record's ladder word (sameModel:
// a record `opus` on claude-opus-5-5 stays). Not during the loop's own move (an open run-switch).
// members.status is not touched here (U152). Pins come from overrides only, so none are honoured here.
import type { Reconciler, TickCtx } from "../core/plugins.ts";
import { accountList, sameModel } from "../capacity/pick.ts";
import type { Row, Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";

export type Live = { agent: string; account: string | null; model: string | null; effort: string | null };

// The main agent a worker row really runs, when the walk knows it and the reading is fresh (no older
// than 3 reads before `now`, default the row's own observed_at); else null.
export function liveOf(ow: Row | null | undefined, now?: number): Live | null {
  if (!ow || ow.gone_at != null || ow.walk !== "running" || !ow.agent || ow.account_at == null) return null;
  if (Number(now ?? ow.observed_at) - Number(ow.account_at) > 3 * envInt("DS_LOOP_LIVE_ACCOUNT_S", 30)) return null;
  const s = (v: unknown) => (v == null || v === "" ? null : String(v));
  return { agent: String(ow.agent), account: s(ow.account), model: s(ow.live_model), effort: s(ow.live_effort) };
}

// The account a member really runs on: the live main's when the walk knows it, else the record's.
// (Never a default-account guess: a switched-off account must not match a member that is not on it.)
export function liveAccount(ow: Row | null | undefined, m: Row, now: number): string | null {
  const live = liveOf(ow, now);
  return live ? live.account : (m.account as string | null) ?? null;
}

// What the record would become: only the columns that differ from the live main.
function drift(m: Row, live: Live): Row {
  const set: Row = {};
  if (live.agent !== m.agent) set.agent = live.agent;
  if (live.account && live.account !== m.account) set.account = live.account;
  if (live.model && !(m.model && sameModel(String(m.model), live.model))) set.model = live.model;
  return set;
}

const keyOf = (m: Row) => `${m.squad}.${m.role}${m.suffix ? `-${m.suffix}` : ""}`;

function follow(ctx: TickCtx, m: Row): void {
  const { store, project: P, now: t } = ctx, wt = String(m.wt);
  const key = { project: P, subject: wt, kind: "account-drift" }, ep = store.get("episodes", key);
  const end = () => { if (ep && ep.ended_at == null) store.upsert("episodes", key, { ended_at: t, observed_at: t }); };
  // A reading taken before the member was last placed shows the agent that start replaced, not this one.
  const ow = store.get("observed_workers", { project: P, wt });
  const live = ow && m.placed_at != null && Number(ow.account_at) < Number(m.placed_at) ? null : liveOf(ow, t);
  const moving = !!store.db.query("SELECT 1 FROM episodes WHERE project = ? AND subject = ? AND kind = 'action:run-switch' AND ended_at IS NULL").get(P, keyOf(m));
  const set = live && !moving ? drift(m, live) : {};
  if (!live || !Object.keys(set).length) { end(); return; }
  const state = [live.agent, live.model ?? "", live.account ?? ""].join("/");
  if (!ep || ep.ended_at != null || ep.state !== state) store.upsert("episodes", key, { state, started_at: t, ended_at: null, source: "loop", observed_at: t });
  const since = ep && ep.ended_at == null && ep.state === state ? Number(ep.started_at) : t;
  const rec = String(m.account ?? ""), list = accountList(store, live.agent, t);
  // Urgent only on the record's own agent: another agent's list says nothing about the record's account.
  const urgent = live.agent === m.agent && !!live.account && !!list?.has(live.account) && !!rec && rec !== "system" && !list.has(rec);
  if (!urgent && t - since < envInt("DS_LOOP_ACCOUNT_SETTLE_S", 120)) return;
  const was = { agent: m.agent ?? null, model: m.model ?? null, account: m.account ?? null };
  if (!setAll(store, Number(m.id), set, was)) return;
  store.event("member_record", { project: P, squad: String(m.squad ?? ""), member: wt, payload: { from: was, to: { ...was, ...set } } });
  if ("account" in set) store.event("member_account", { project: P, squad: String(m.squad ?? ""), member: wt, payload: { from: rec || null, to: set.account } });
  store.upsert("episodes", key, { ended_at: t, observed_at: t });
}

// The changed columns at once, only while the row still holds what was read (a write in between wins).
function setAll(store: Store, id: number, set: Row, was: Row): boolean {
  const cols = Object.keys(set);
  return store.tx(() => {
    const now = store.db.query("SELECT agent, model, account FROM members WHERE id = ?").get(id) as Row | null;
    if (!now || now.agent !== was.agent || now.model !== was.model || now.account !== was.account) return false;
    return cols.every((c) => store.setIf("members", id, c, set[c], was[c]));
  });
}

export const reconciler: Reconciler = {
  name: "record",
  run(ctx: TickCtx) {
    const { store, project: P } = ctx;
    const studioWt = String(store.get("projects", { label: P })?.studio_wt ?? "");
    // The newest row per worktree (an older row of a reused worktree is not this member).
    const members = store.db.query(`SELECT * FROM members WHERE project = ? AND wt IS NOT NULL AND wt != '' AND COALESCE(status, '') != 'gone'
      AND id IN (SELECT MAX(id) FROM members WHERE project = ? GROUP BY wt) ORDER BY id`).all(P, P) as Row[];
    for (const m of members) {
      if (m.wt === studioWt) continue;
      try { follow(ctx, m); }
      catch (e) { store.event("plugin_error", { project: P, payload: { plugin: "record", at: String(m.wt), error: (e as Error)?.message ?? String(e) } }); }
    }
    return [];
  },
};
export default reconciler;
