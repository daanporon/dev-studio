// squad/side-update.ts — side-loop-host U24: how main's newest update stands on each side host. The steps live in
// that `update` request's own result, `result.hosts[<host>]`, beside `result.target` (the commit main was on after
// its pull, bin/commands/update-run.ts). The loop writes them (fulfil/side-update.ts) and the board reads them.
//   waiting   no job sent yet for this attempt (the host is unreachable)
//   running   the job was sent; the host has not said it ended
//   done      the host runs the target
//   failed    the host said its update failed, or does not know the job
// `sent_at` is the first send of the attempt; `stuck_at` is set STUCK_AFTER_S after it when the host is still
// behind, and is what raises its Needs-you card (stuckHosts). The card's Update starts the next `attempt`.
import type { Row, Store } from "../core/store.ts";

export const STUCK_AFTER_S = 600;

export type HostStep = {
  state: "waiting" | "running" | "done" | "failed"; attempt: number;
  sent_at?: number; stuck_at?: number; at?: number; rev?: string; line?: string; error?: string; log?: string;
};
export type HostUpdate = { id: number; target: string; hosts: Record<string, HostStep>; result: Record<string, unknown> };

/** The newest finished update that left main on a known commit, whatever became of its squad refresh. */
export function latestUpdate(store: Store): HostUpdate | null {
  const r = store.db.query(`SELECT id, result FROM requests WHERE kind = 'update' AND done_at IS NOT NULL
    AND CASE WHEN json_valid(result) THEN json_extract(result, '$.target') END IS NOT NULL ORDER BY done_at DESC, id DESC LIMIT 1`).get() as Row | null;
  if (!r) return null;
  const result = JSON.parse(String(r.result)) as Record<string, unknown>;
  return { id: Number(r.id), target: String(result.target), hosts: (result.hosts as Record<string, HostStep>) ?? {}, result };
}

export function setStep(store: Store, u: HostUpdate, host: string, step: HostStep, at: number): void {
  u.hosts[host] = { ...step, at };
  u.result.hosts = u.hosts;
  store.upsert("requests", { id: u.id }, { result: JSON.stringify(u.result) });
}

/** True unless the commit the host last reported (`hosts.code_rev`, short) is the target. */
export const behindTarget = (codeRev: unknown, target: string): boolean => {
  const rev = String(codeRev ?? "");
  return !rev || !target.startsWith(rev);
};

export const acceptedHosts = (store: Store): Row[] =>
  store.db.query("SELECT name, code_rev FROM hosts WHERE status = 'accepted' ORDER BY name").all() as Row[];

export type StuckHost = { host: string; rev: string; target: string; request: number; step: HostStep };

/** The hosts still behind 10 minutes after their job: one card each. */
export function stuckHosts(store: Store): StuckHost[] {
  const u = latestUpdate(store);
  if (!u) return [];
  return acceptedHosts(store).flatMap((h) => {
    const step = u.hosts[String(h.name)];
    return step?.stuck_at && step.state !== "done" && behindTarget(h.code_rev, u.target)
      ? [{ host: String(h.name), rev: String(h.code_rev ?? ""), target: u.target, request: u.id, step }] : [];
  });
}
