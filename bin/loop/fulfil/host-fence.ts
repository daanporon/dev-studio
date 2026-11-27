// fulfil/host-fence.ts — side-loop-host U15 (issue #127, KTD11): what acts on reconcilers/host-fence.ts.
//   host.fence   first each Builder's old branch and its commit on origin are read (a failure is a retry, nothing
//                written); then `hosts.fenced_at` is set (placement refuses the host), `host_fenced` is written and
//                every member still live there is requeued (squad/host-requeue.ts requeue).
//   host.return  the terminals of each member moved off the host are closed there (squad/removal.ts, through the
//                host's seat), each marked `fence_closed_at`; once none is left `fenced_at` is cleared and
//                `host_returned` is written. A close that fails is a retry: the host stays fenced until it is done.
import type { Fulfiller } from "../core/actuator.ts";
import type { Action } from "../core/plugins.ts";
import type { Row } from "../core/store.ts";
import { liveOn, lookups, pathOf, requeue } from "../squad/host-requeue.ts";
import { contractCloseTerminals } from "../squad/removal.ts";
import { staleOn } from "../reconcilers/host-fence.ts";

const hostOf = (a: Action): string => String((a.payload as { host?: unknown } | null)?.host ?? "");

const hostFence: Fulfiller = {
  name: "host-fence",
  kinds: ["host.fence", "host.return"],
  run: () => [],
  async exec(a, x) {
    const { store, now } = x, host = hostOf(a);
    if (!host || !store.get("hosts", { name: host })) return { dropped: `no host '${host}'` };
    if (a.kind === "host.fence") {
      const live = liveOn(store, host);
      let found;
      try { found = await lookups(store, host, live); } catch (e) { return { retry: (e as Error).message }; }
      store.db.run("UPDATE hosts SET fenced_at = COALESCE(fenced_at, ?) WHERE name = ?", [now, host]);
      const moved = live.map((m) => requeue(store, host, m, found.get(Number(m.id)), now));
      store.fact("host_fenced", [], { payload: { name: host, since: Number((a.payload as { since?: unknown }).since ?? now),
        members: moved.map((r) => `${r.role}${r.suffix ? `-${r.suffix}` : ""}`),
        units: moved.filter((r) => r.unit && r.attempt).map((r) => `${r.unit}#${r.attempt}${r.branch ? ` ${r.branch}@${(r.sha ?? "unpushed").slice(0, 12)}` : ""}`) } });
      return { done: true, result: `${moved.length} requeued` };
    }
    const failed: string[] = [];
    for (const m of staleOn(store, host)) {
      if (m.wt) {
        const o = await contractCloseTerminals(a, x, { project: String(m.project), squad: String(m.squad), wt: String(m.wt), path: pathOf(m) });
        if (o.code !== 0) { failed.push(`${pathOf(m)}: ${o.err}`); continue; }
      }
      store.db.run("UPDATE members SET fence_closed_at = ? WHERE id = ?", [now, m.id as number]);
    }
    if (failed.length) return { retry: `closing terminals on ${host}: ${failed.join("; ").slice(0, 400)}` };
    const was = store.get("hosts", { name: host }) as Row;
    store.db.run("UPDATE hosts SET fenced_at = NULL WHERE name = ?", [host]);
    store.fact("host_returned", [], { payload: { name: host, fenced_at: Number(was.fenced_at ?? 0) } });
    return { done: true };
  },
};
export default hostFence;
