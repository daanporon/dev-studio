// send-fail.ts — the failure streak behind the "Can't type into <member>" card (studio-chat-queued-busy U2).
// One episodes row per member (kind `send-fail`, subject `send-fail:<project>/<member>`; the Studio is
// `<project>/_studio`): each failed chat or Studio poke send raises `count` and keeps the last error in
// `state`; the next successful send ends the row. At SEND_FAIL_CARD failures in a row the reconciler
// (reconcilers/send-fail.ts) raises one card, and alertGone clears it when the row ends.
import type { Store } from "../core/store.ts";

export const SEND_FAIL = "send-fail";
export const SEND_FAIL_CARD = 3;
export const STUDIO_MEMBER = "_studio";
export const failSubject = (project: string, member: string) => `send-fail:${project}/${member}`;

export function sendFailed(store: Store, project: string, member: string, err: string, now: number): number {
  const key = { project, subject: failSubject(project, member), kind: SEND_FAIL };
  const ep = store.get("episodes", key), open = !!ep && ep.ended_at == null;
  const count = (open ? Number(ep!.count ?? 0) : 0) + 1;
  store.upsert("episodes", key, { squad: null, count, state: err, started_at: open ? Number(ep!.started_at ?? now) : now, ended_at: null, episode_key: String(open ? ep!.started_at ?? now : now), source: "loop", observed_at: now });
  return count;
}

export function sendOk(store: Store, project: string, member: string, now: number): void {
  const key = { project, subject: failSubject(project, member), kind: SEND_FAIL };
  const ep = store.get("episodes", key);
  if (ep && ep.ended_at == null) store.upsert("episodes", key, { ended_at: now, observed_at: now });
}
