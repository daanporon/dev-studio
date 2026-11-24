// ds services — the services the loop runs (U16): one row per scope with its wish, pid, port, last
// ping and restarts. `ds want board …` (wantBoard below) writes the web board's wish: a `services`
// row with want=running (or `--stop`: stopped) for one scope — all projects, a project, or a project
// + topic — that the loop's services reconciler makes true. Asking again for the same scope and port
// is a no-op; another port is a new wish (the loop restarts the board on it). The same wish on a
// board whose row says running but whose pid is gone re-arms the wish (a new want_at) and answers
// `was_down: true`: the loop restarts it on its next tick (board.sh --serve says so). --wait polls until the
// row's status matches (or it failed) and exits 1 when it does not in time or the loop gave up.
// The port: --port, else the scope's registered port (the row's `port`: the one its board last bound,
// which the loop moves to the next free one when the asked port is taken), else 8787. Without --port
// the wish keeps the port its last ask named, so asking again for a board the loop moved (8787 taken,
// running on 8788) is a no-op, not a restart.
import { parse, print, seconds, shape, waitFor } from "../loop/core/cli.ts";
import { isBoard } from "../loop/fulfil/board.ts";
import { open, type Row } from "../loop/core/store.ts";

export const DEFAULT_PORT = 8787;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const help = "[--name <service>] — list the services rows";
export async function run(args: string[]): Promise<number> {
  const { pos, opt } = parse(args, ["name"]);
  if (pos.length) { console.error(`usage: ds services ${help}`); return 2; }
  const s = open();
  try {
    const rows = s.db.query("SELECT * FROM services WHERE ? IS NULL OR name = ? ORDER BY name, project, topic").all(opt.name ?? null, opt.name ?? null) as Row[];
    print(rows.map((r) => shape(r)));
    return 0;
  } finally { s.close(); }
}

// The port a stored wish asked for, or null.
function askedPort(payload: string | null | undefined): number | null {
  let wish: { port?: unknown } | null;
  try { wish = JSON.parse(String(payload ?? "null")); } catch { return null; }
  const p = Number(wish?.port);
  return Number.isInteger(p) && p > 0 ? p : null;
}

export const wantHelp = "[--project <label>] [--topic <slug>] [--port <n>] [--bind <addrs>] [--hosts <names>] [--stop] [--by <who>] [--wait <s>]";
export async function wantBoard(args: string[]): Promise<number> {
  const { pos, opt, flag } = parse(args, ["project", "topic", "port", "bind", "hosts", "by", "wait"], ["stop"]);
  const project = opt.project ?? "", topic = opt.topic ?? "";
  if (pos.length || (project && !NAME.test(project)) || (topic && !NAME.test(topic)) || (topic && !project)
    || (opt.port !== undefined && !/^\d{1,5}$/.test(opt.port)) || (flag.has("stop") && (opt.port ?? opt.bind ?? opt.hosts) !== undefined)) {
    console.error(`usage: ds want board ${wantHelp}  (--topic needs --project; --stop takes no port, bind or hosts)`);
    return 2;
  }
  const wait = seconds(opt.wait), stop = flag.has("stop");
  const id = ["board", project, topic].filter(Boolean).join("/");
  const s = open();
  try {
    const by = opt.by ?? process.env.DS_WHO ?? "ds";
    let res: { row: Row; changed: boolean };
    let wasDown = false, startedBefore: unknown = null;
    if (stop) res = s.want("service", id, "stopped", { by });
    else {
      const had = s.db.query("SELECT port, want_payload FROM services WHERE name = 'board' AND project = ? AND topic = ?").get(project, topic) as { port: number | null; want_payload: string | null } | null;
      const port = opt.port !== undefined ? Number(opt.port) : Number(had?.port ?? DEFAULT_PORT);
      const asked = opt.port !== undefined ? port : (askedPort(had?.want_payload) ?? port);
      // The asker's bind addresses and Host names (DS_BIND / DS_BOARD_HOSTS) ride in the wish.
      const payload = { port: asked, ...(opt.bind ? { bind: opt.bind } : {}), ...(opt.hosts ? { hosts: opt.hosts } : {}) };
      res = s.want("service", id, "running", { payload, fill: { port }, by });
      // Asked again about a board the row calls running with no live process: the same wish is a
      // no-op for the store, so re-arm it — the loop's next tick restarts the board.
      if (!res.changed && res.row.status === "running" && !isBoard(res.row.pid)) {
        res = s.want("service", id, "running", { payload, fill: { port }, by, rearm: true });
        wasDown = true;
        startedBefore = res.row.started_at;
      }
    }
    const target = stop ? "stopped" : "running";
    let last = res.row;
    // The wish given up: want_result, which a new wish clears — status keeps the last attempt's "failed".
    const gaveUp = () => String(last.want_result ?? "").startsWith("failed");
    if (wait !== null) {
      const met = await waitFor(wait, () => {
        last = s.wish("service", Number(res.row.id)) ?? last;
        return (last.status === target && (!wasDown || last.started_at !== startedBefore)) || gaveUp();
      });
      print({ ...shape(last), changed: res.changed, ...(wasDown && last.started_at === startedBefore ? { was_down: true } : {}) });
      if (gaveUp()) { console.error(`the loop gave up (row ${last.id}): ${last.want_result ?? last.result}`); return 1; }
      if (!met) { console.error(`still wanted (row ${last.id}); asking again is a no-op`); return 1; }
      return 0;
    }
    print({ ...shape(last), changed: res.changed, ...(wasDown ? { was_down: true } : {}) });
    return 0;
  } finally { s.close(); }
}
