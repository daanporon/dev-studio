// fulfil/member-move.ts — kind `member-move`: the board's "Move to main" on one member of a side host
// (side-loop-host U16). Payload {id: the member row, request}. The decider waits for the member to be idle, asks its
// journal checkpoint (pause/stop-checkpoint.ts), then sends this action under its member subject:
//   1. a Builder with a worktree: no uncommitted file there (only commits move), then its branch is pushed from the host
//   2. its terminals there are closed; the old worktree stays on the host
//   3. squad/host-requeue.ts requeue(): the member ends, a Builder's unit goes to the next attempt, and the slot is
//      wished again `main_only`, so it starts on main (`<name>-r<n>` from the pushed commit) when main has room
// Uncommitted files refuse the move (the member runs on); a failed push or close is tried again, and the request fails
// when the tries run out. While the host is unreachable it waits: the host's fence (U15) requeues the member then.
// run(): an open request whose member ended or is no longer wished running is closed as failed.
import { probeOn, pushOn } from "../../link/host-jobs.ts";
import { failRequest, finishRequest, type Exec, type Fulfiller } from "../core/actuator.ts";
import { payloadOf } from "../core/kinds.ts";
import type { Action, TickCtx } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { SECURED_DIRS } from "../io/wt-probe.ts";
import { onSide } from "../squad/backend.ts";
import { lookups, pathOf, requeue } from "../squad/host-requeue.ts";
import { hostUnreachable } from "../squad/host-reach.ts";
import { unmovable } from "../squad/move.ts";
import { contractCloseTerminals } from "../squad/removal.ts";

// A side member with an open request the decider will never act on: close it with the reason.
function dead(ctx: TickCtx): Action[] {
  const rows = ctx.store.db.query("SELECT * FROM requests WHERE done_at IS NULL AND kind = 'member-move' ORDER BY id").all() as Row[];
  return rows.flatMap((r) => {
    const id = Number(JSON.parse(String(r.payload ?? "{}")).id);
    if (!unmovable(ctx.store, ctx.store.get("members", { id }))) return [];
    return [{ project: String(r.project ?? ""), squad: (r.squad as string | null) ?? null, member: (r.member as string | null) ?? null,
      subject: `req:${r.id}`, kind: "member-move", episode: `req:${r.id}`, payload: { id, request: Number(r.id) } }];
  });
}

// The files that would stay behind: dirty paths of the probe, leaving the agent's scratch folders out.
// The probe names at most 20, so more than that counts as left behind.
function leftBehind(out: string): string[] {
  const [head, ...names] = out.replace(/\n+$/, "").split("\n");
  const dirty = Number(head.split("\t")[0]);
  const kept = names.filter((n) => !SECURED_DIRS.some((d) => n.startsWith(d)));
  return dirty > names.length && !kept.length ? [`${dirty} files`] : kept;
}

const memberMove: Fulfiller = {
  name: "member-move",
  scope: "host",
  kinds: ["member-move"],
  run: dead,
  async exec(a: Action, x: Exec) {
    const p = payloadOf<"member-move">(a);
    if (x.store.get("requests", { id: p.request })?.done_at != null) return { dropped: "the request is finished" };
    const m = x.store.get("members", { id: p.id });
    const refuse = (why: string) => { failRequest(a, x, why); return { dropped: why }; };
    const why = unmovable(x.store, m);
    if (why || !m) return refuse(why ?? "this member has ended");
    const host = String(m.host), project = String(m.project), squad = String(m.squad), path = pathOf(m);
    if (hostUnreachable(x.store, host)) return { wait: `host ${host} is unreachable` };
    if (m.role === "builder" && m.wt) {
      const branch = x.store.get("worktrees", { host, path })?.branch;
      if (!branch) return refuse(`no branch is recorded for ${path} on ${host}`);
      const jobs = x.act.hostJobs();
      const probe = await probeOn(host, path, 60_000, undefined, jobs);
      if (probe.code !== 0) return { retry: `reading the worktree on ${host} failed` };
      const left = leftBehind(probe.out);
      if (left.length) return refuse(`uncommitted files would stay on ${host}: ${left.slice(0, 5).join(", ")}; commit them, then move again`);
      const push = await pushOn(host, path, String(branch), undefined, jobs);
      if (push.code !== 0) return { retry: `push of ${branch} from ${host}: ${(push.err || push.out).trim().slice(0, 300)}` };
    }
    if (m.wt) {
      const closed = await contractCloseTerminals(a, x, { project, squad, wt: String(m.wt), path });
      if (closed.code !== 0) return { retry: `closing the terminals on ${host}: ${closed.err}` };
    }
    const found = (await lookups(x.store, host, [m])).get(p.id);
    const moved = x.store.tx(() => {
      const r = requeue(x.store, host, m, found, x.now, true);
      finishRequest(x.store, a, { ok: true, host, branch: r.branch, sha: r.sha, attempt: r.attempt }, x.now);
      return r;
    });
    return { done: true, result: `moved from ${host} to main${moved.attempt ? ` (attempt ${moved.attempt})` : ""}` };
  },
  giveUp: failRequest,
};
export default memberMove;
