// close-drift.ts (U231) — a close or suspend wish is granted against the worktrees and agents that
// really exist. Two reads the decider shares:
//   driftCleared  a member of an archived/suspended squad whose recorded worktree has no folder and
//                 no live worker or terminal is drift: clear its wt and give it the end state close.ts
//                 writes (gone / suspended), with one event naming the missing path. The squad's archive
//                 check then sees no wt and archives.
//   stopRetry     close.ts's stop reported done, yet the member still reads running: after one dispatch
//                 read plus one walk, stop it again under a new episode; after 3 tries, one card.
//   removeRetry   close.ts dropped the worktree removal as stale (Orca still lists the stopped agent's
//                 dispatch as live, so presence reads running): try it again under a new episode, the
//                 first time after one dispatch read plus one walk, then doubling up to REMOVE_WAIT_MAX_MIN.
//                 No cap: a closing squad never gives up. From the third stale drop on, one card too.
import { existsSync } from "node:fs";
import { effective } from "../pause/pause.ts";
import { view } from "./member-state.ts";
import { knob } from "../reconcilers/liveness.ts";
import { wtPath } from "../observers/orca.ts";
import type { Row, Store } from "../core/store.ts";

export const STOP_TRIES = 3;
export const REMOVE_CARD_TRIES = 3;
export const REMOVE_WAIT_MAX_MIN = 30;

export function driftCleared(store: Store, m: Row, now: number): boolean {
  if (!m.wt) return false;
  const v = view(store, m);
  const squad = effective(store, m).why === "squad";
  if (v === "archived" ? !(squad || m.want === "gone") : v !== "suspended") return false;
  const wt = String(m.wt), project = String(m.project);
  const tree = store.get("observed_worktrees", { project, wt });
  const path = tree?.path ? String(tree.path) : wtPath(wt);
  if (!path || existsSync(path)) return false;
  if (tree && tree.gone_at == null) return false;
  const w = store.get("observed_workers", { project, wt });
  if (w && w.gone_at == null) return false;
  if (store.db.query("SELECT 1 FROM observed_terminals WHERE project = ? AND wt = ? AND gone_at IS NULL LIMIT 1").get(project, wt)) return false;
  const suspended = v === "suspended";
  store.fact("member_drift_cleared", [{ table: "members", key: { id: m.id }, set: suspended ? { status: "suspended", wt: null, updated_at: now } : { status: "gone", wt: null, doc: null, want_result: "done: worktree already gone", updated_at: now } }],
    { project, squad: String(m.squad), member: wt, payload: { id: m.id, path, status: suspended ? "suspended" : "gone" } });
  if (m.role === "lead") store.db.run("UPDATE squads SET lead_wt = NULL WHERE project = ? AND topic = ? AND lead_wt = ?", [project, String(m.squad), wt]);
  return true;
}

export type Retry = { episode: string; wait?: boolean; card?: boolean; tries: number };
export function stopRetry(store: Store, m: Row, episode: string, now: number): Retry {
  const wt = String(m.wt ?? "");
  const done = (store.db.query("SELECT at, payload FROM events WHERE kind = 'member_closed' AND project = ? AND member = ? AND at >= ? ORDER BY at")
    .all(String(m.project), wt, Number(m.want_at ?? 0)) as { at: number; payload: string | null }[])
    .filter((e) => { try { return JSON.parse(e.payload ?? "{}").phase === "stop"; } catch { return false; } });
  if (!done.length) return { episode, tries: 0 };
  const after = (knob(store, String(m.project), "DISPATCH_READ_MIN", 5) + knob(store, String(m.project), "WALK_MIN", 1)) * 60;
  if (now - done[done.length - 1].at < after) return { episode, wait: true, tries: done.length };
  if (done.length >= STOP_TRIES) return { episode, card: true, tries: done.length };
  return { episode: `${episode}:retry${done.length}`, tries: done.length };
}

// The remove's claim row (one per member, the newest episode). A remove that close.ts dropped as stale stays
// held under its episode key for ever (tick.ts claim() renews only a `generation changed` drop), so a fresh
// key is the only way to try it again: `<episode>:retry<n>`. `tries` counts the stale drops so far, `wait`
// is set while the backoff runs, `next_at` is when the next try may go, `reason` the last stale reason.
export type RemoveRetry = Retry & { next_at?: number; reason?: string };
export function removeWaitS(store: Store, project: string, n: number): number {
  const first = knob(store, project, "DISPATCH_READ_MIN", 5) + knob(store, project, "WALK_MIN", 1);
  return Math.min(first * 2 ** n, REMOVE_WAIT_MAX_MIN) * 60;
}
export function removeRetry(store: Store, m: Row, episode: string, now: number): RemoveRetry {
  const project = String(m.project);
  const row = store.get("episodes", { project, subject: `member:${m.id}`, kind: "action:member.close" });
  const key = String(row?.episode_key ?? "");
  const n = key === episode ? 0 : key.startsWith(`${episode}:retry`) ? Number(key.slice(episode.length + 6)) : NaN;
  if (!Number.isInteger(n) || n < 0) return { episode, tries: 0 };
  const result = String(row!.result ?? "");
  // A try under way (or ended on anything but a stale drop) keeps its key: the claim decides.
  if (row!.state !== "dropped" || !/^stale(:|$)/.test(result)) return { episode: key, tries: n };
  const tries = n + 1, next = Number(row!.ended_at ?? now) + removeWaitS(store, project, n);
  const reason = result.replace(/^stale:?\s*/, "") || "stale";
  const card = tries >= REMOVE_CARD_TRIES || undefined;
  if (now < next) return { episode: key, wait: true, card, tries, next_at: next, reason };
  return { episode: `${episode}:retry${tries}`, card, tries, next_at: next, reason };
}
