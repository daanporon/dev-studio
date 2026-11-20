// seed.ts — each member's standing wish, seeded once per project from reality (U152).
//
// Before the decider, a member's `want` was a one-shot request: written, started, then left behind
// with a want_result. The decider reads it as a standing wish, so the first time a project's process
// walk succeeds (and before its first compare) every member's wish is set from what is there, in
// this order:
//   1. a member wanted gone stays gone (no event)
//   2. a member of a closed squad (closed, archived, gone, or wanted gone) -> gone
//   3. its agent present (the walk this tick saw it) -> running
//   4. open work -> running: a standing role (Lead, Thinker) of a running or suspended squad, or a
//      Builder whose unit is dispatched and not done, merged or cancelled
//   5. everything else, a NULL wish too -> stopped
// A wish already running whose start is pending (want_result empty) or given up (failed) is left as
// it is: the seed never retries a start the loop gave up on, nor drops one asked for. Pause intents
// are never touched: a paused member seeded running still reads paused. Each change is one
// `wish_seeded` event; the project's `wish_seed` episode row marks it done.
import { mergedUnit } from "../pause/pause-conditions.ts";
import { STANDING } from "../drivers/types.ts";
import type { TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";

const CLOSED = ["closed", "archived", "gone", "cancelled"];
type Wish = "running" | "stopped" | "gone";

// The host walk read this tick: some worktree's main-agent columns were refreshed now.
const walked = (store: Store, now: number) => !!store.db.query("SELECT 1 FROM observed_workers WHERE account_at >= ? LIMIT 1").get(now);

// A member's main agent seen by this tick's walk. Only the main: the walk names a worktree's main
// agent, never a child of review-unit.sh (U149's sub_agents hold those).
function present(store: Store, m: Row, now: number): boolean {
  if (!m.wt) return false;
  const w = store.get("observed_workers", { project: m.project, wt: m.wt });
  return !!w && w.gone_at == null && Number(w.account_at ?? 0) >= now && w.walk === "running";
}

export function seedWish(store: Store, m: Row, now: number): Wish | null {
  if (m.want === "gone") return null;
  const sq = store.get("squads", { project: m.project, topic: m.squad });
  if (!sq || CLOSED.includes(String(sq.status)) || sq.want === "gone") return "gone";
  if (present(store, m, now)) return "running";
  const squadOpen = (sq.want ?? sq.status) === "running" || (sq.want ?? sq.status) === "suspended";
  if (STANDING.has(String(m.role)) && squadOpen) return "running";
  if (m.role === "builder") {
    const u = store.get("units", { project: m.project, squad: m.squad, slug: m.suffix ?? "" });
    if (u && u.status === "dispatched" && !mergedUnit(store, u)) return "running";
  }
  return "stopped";
}

export function seed(ctx: TickCtx): void {
  const { store, now } = ctx;
  if (!walked(store, now)) return;
  const projects = store.db.query(`SELECT DISTINCT project FROM members WHERE project NOT IN
    (SELECT project FROM episodes WHERE subject = 'seed' AND kind = 'wish_seed')`).all() as { project: string }[];
  for (const { project } of projects) store.tx(() => {
    const seen = new Set<string>();
    for (const m of store.db.query("SELECT * FROM members WHERE project = ? AND role != 'studio' ORDER BY id DESC").all(project) as Row[]) {
      const key = `${m.squad}\t${m.role}\t${m.suffix ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const want = seedWish(store, m, now);
      if (!want || want === m.want) continue;
      if (m.want === "running" && (m.want_result == null || String(m.want_result).startsWith("failed"))) continue;
      store.fact("wish_seeded", [{ table: "members", key: { id: m.id }, set: { want, want_by: "seed", want_at: now, want_result: "seed", want_payload: null, updated_at: now } }],
        { project, squad: String(m.squad), member: (m.wt as string | null) ?? null, payload: { id: m.id, field: "want", old: m.want ?? null, new: want, who: "seed" } });
    }
    store.upsert("episodes", { project, subject: "seed", kind: "wish_seed" }, { started_at: now, state: "done", source: "loop", observed_at: now });
  });
}
