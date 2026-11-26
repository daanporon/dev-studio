// reconcilers/services.ts — keep each wished service the way its row asks (U16, R7, KTD16). Every
// tick, for each `services` row (the web board, one row per scope; and the side-host link server, side-loop-host
// U2, one row named `link` whose wish follows link_listen, link_port and the host list: fulfil/link.ts
// syncLinkWish, written here before the rows are read; its kinds are link_* where the board's are board_*):
//   want=running  no live pid yet (new, stopped, or a new wish after a failure) -> board_start
//                 running, pid gone (whatever the wish times say)                -> board_restart (counted)
//                 running, a newer wish (another port) than the start           -> board_restart
//                 running, /healthz unanswered by its live pid (two pings)       -> board_restart (counted)
//                 the restart would be the 4th within DS_LOOP_BOARD_WINDOW_S (default 600) of
//                 the wish -> board_giveup: failed with one Studio alert until the next wish
//                 running and answering: last_ping_at moves on
//   want=stopped  a live pid -> board_stop; none: status=stopped
// A server that exited 75 (its code changed on disk, a pull) is restarted without counting. A
// healthy pid the row already holds is adopted at loop boot: nothing to do. A wish the loop gave up
// on (want_result `failed: …`) waits for the next `ds want board`.
import { bindsOf, boardUp, exitCodeOf, isBoard, isStarting, restartsOf, set } from "../fulfil/board.ts";
import { isLink, linkExitCode, linkUp, syncLinkWish } from "../fulfil/link.ts";
import type { Action, Reconciler } from "../core/plugins.ts";
import type { Row } from "../core/store.ts";
import { envInt } from "../core/tick.ts";

const MAX_RESTARTS = 3;
const windowS = () => envInt("DS_LOOP_BOARD_WINDOW_S", 600);

const services: Reconciler = {
  name: "services",
  scope: "host",
  async run(ctx) {
    const { store, now: at } = ctx, out: Action[] = [];
    syncLinkWish(store, at);
    const rows = store.db.query("SELECT * FROM services WHERE name IN ('board', 'link') ORDER BY id").all() as Row[];
    const isLinkRow = (r: Row) => r.name === "link";
    // The pings of every running row at once: one hung board must not hold up the others.
    const alive = rows.map((r) => (isLinkRow(r) ? isLink(r.pid) : isBoard(r.pid)));
    const answers = await Promise.all(rows.map((r, i) => r.want === "running" && r.status === "running" && alive[i] && !isStarting(Number(r.id))
      ? (isLinkRow(r) ? linkUp(r) : boardUp(Number(r.port), bindsOf(r), r.pid)) : false));
    for (const [i, r] of rows.entries()) {
      const id = Number(r.id), subject = `service:${id}`, svc = isLinkRow(r) ? "link" : "board";
      // Kinds are named board_*; a link row gets the same verb as link_* (fulfil/link.ts).
      const act = (kind: string, episode: string, payload: Record<string, unknown> = {}) =>
        out.push({ project: String(r.project), squad: String(r.topic) || null, subject, kind: kind.replace(/^board_/, `${svc}_`), episode, payload: { id, ...payload } });
      if (r.want !== "running") {
        if (alive[i]) act("board_stop", `stop:${r.want_at}`);
        else if (r.status !== "stopped" && r.status != null) {
          set(store, "service_stopped", r, { status: "stopped", pid: null }, at, { gone: true });
        }
        continue;
      }
      if (String(r.want_result ?? "").startsWith("failed")) continue;   // until the next wish
      if (isStarting(id)) continue;                                   // fulfil/board.ts settles it
      const up = answers[i];
      // Not running yet (new, stopped, a new wish after a failure, a start a loop crash cut short):
      // the start keeps a healthy pid the row already holds.
      if (r.status !== "running") { act("board_start", `start:${r.want_at}:${r.started_at ?? 0}`); continue; }
      // Liveness first: a pid that is gone is a dead board, whatever the wish times say, so it is
      // restarted (counted) below. A start records the want_at it served (started_at is never older),
      // so a wish already served never reads as newer here.
      // A newer wish (another port) than the start, on a live pid: restart on it, uncounted — before
      // the ping's verdict, since the row already holds the new port nothing listens on yet.
      if (alive[i] && Number(r.want_at ?? 0) > Number(r.started_at ?? 0)) { act("board_restart", `rewish:${r.want_at}`, { why: "a new wish" }); continue; }
      if (up) {
        store.upsert("services", { id }, { last_ping_at: at, observed_at: at });
        continue;
      }
      // Down: a pid gone (or never recorded) or a live one that does not answer.
      const pid = Number(r.pid ?? 0), reload = !alive[i] && pid > 0 && (exitCodeOf(pid) ?? (isLinkRow(r) ? linkExitCode(pid) : null)) === 75;
      const why = reload ? "its code changed (exit 75)" : alive[i] ? "it stopped answering /healthz" : "its process is gone";
      if (reload) { act("board_restart", `reload:${pid}:${r.started_at}`, { why }); continue; }
      const since = Math.max(at - windowS(), Number(r.want_at ?? 0));
      const recent = restartsOf(r).filter((t) => t >= since).length;
      if (recent >= MAX_RESTARTS) act("board_giveup", `cap:${r.want_at}:${r.started_at}`, { why: `was restarted ${recent} times in ${Math.round(windowS() / 60)} minutes and ${why}` });
      else act("board_restart", `${alive[i] ? "hung" : "gone"}:${pid}:${r.started_at}`, { why, counted: true });
    }
    return out;
  },
};
export default services;
