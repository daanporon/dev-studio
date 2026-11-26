// fulfil/link.ts — side-loop-host U2 (issue #127, KTD2): main's link server (bin/link/server.ts) as a service the
// loop runs, patterned on fulfil/board.ts. The services reconciler keeps one `services` row named `link` (project
// and topic empty) whose wish follows the settings (`linkWish`):
//   link_listen   auto (default) = run while a pending or accepted host row exists; on = always (so a first
//                 `ds join` can reach main); off = never
//   link_port     the port side hosts dial (default 7790); fixed, never hunted, since side hosts are told it
// Both are host-level: the env var (DS_LIMIT_LINK_LISTEN, DS_LIMIT_LINK_PORT), else any project's own row (`on`
// wins over `off`; the port of the first project that sets one), else the default row (`linkListen`, `linkPort`).
// The reconciler emits these kinds; this file does them:
//   link_start    spawn `bun bin/link/server.ts <binds> <port>` with DS_STATE_ROOT, in its own transient user unit
//                 `ds-link-<id>` when `systemctl --user` works (so it outlives a loop restart, which adopts it),
//                 else detached; wait up to DS_LOOP_BOARD_WAIT_MS for /healthz from that pid. Exited or silent:
//                 status=failed, the log's tail in `result`, the wish given up until the next change of wish.
//   link_restart  stop the old pid, count the restart (payload.counted), then the same start
//   link_stop     stop the pid; status=stopped
//   link_giveup   the restart cap: stop the pid, status=failed, one Studio alert
// It binds loopback and this host's tailnet address (KTD2); DS_LINK_BIND replaces that list (the server still
// refuses an address that is neither, unless DS_LINK_BIND_ANY=1). Its log is state/link-serve.log (the one before
// it kept as .log.1); DS_LINK_SERVER replaces the server file (tests).
import { closeSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { alert, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { childEnv } from "../io/orca.ts";
import { discoverProjects } from "../settings/projects.ts";
import { limit, limitEnv, limitInt } from "../settings/limits.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { tailnetIp } from "../io/tailnet.ts";
import { boardUp, isProc, markStarting, restartsOf, set, startUnit, stopProc, systemdUp, type Handle } from "./board.ts";
import { listHosts } from "../../link/host-keys.ts";

export const DEFAULT_LINK_PORT = 7790;
const waitMs = () => envInt("DS_LOOP_BOARD_WAIT_MS", 10_000);

const children = new Map<number, Bun.Subprocess>();

export function isLink(pid: unknown): boolean { return isProc(pid, /link\/server\.ts|ds-link-server/); }
const stop = (pid: unknown) => stopProc(pid, isLink);

/** Where the link listens: DS_LINK_BIND, else loopback and the tailnet address. */
export function linkBinds(): string {
  return process.env.DS_LINK_BIND || ["127.0.0.1", tailnetIp()].filter(Boolean).join(" ");
}

// Host-level keys until U25 gives them per-host rows (the builder_host_brake rule, KTD16): the env var wins;
// else any project's own row (`ds config set <project> limits.conf link_listen on`), `on` over `off`; else the
// default row.
const projectValues = (store: Store, key: string): string[] =>
  (store.db.query("SELECT value FROM config WHERE project != '' AND file = 'limits.conf' AND key = ? ORDER BY project").all(key) as { value: string | null }[])
    .map((r) => String(r.value ?? "").trim().split(/\s+/)[0]).filter(Boolean);

export type LinkListen = "auto" | "on" | "off";
export function linkListen(store: Store): LinkListen {
  const norm = (v: string | null | undefined): LinkListen | null => (v === "on" || v === "off" || v === "auto" ? v : null);
  const ev = norm(process.env[limitEnv("link_listen")]?.trim());
  if (ev) return ev;
  const own = projectValues(store, "link_listen").map(norm);
  if (own.includes("on")) return "on";
  if (own.includes("off")) return "off";
  return norm(limit(store, "", "link_listen")) ?? "auto";
}
function linkPort(store: Store): number {
  const ok = (v: unknown) => /^\d+$/.test(String(v ?? "")) && Number(v) > 0 && Number(v) <= 65535;
  const ev = process.env[limitEnv("link_port")]?.trim();
  if (ok(ev)) return Number(ev);
  const own = projectValues(store, "link_port").find(ok);
  if (own) return Number(own);
  const d = limitInt(store, "", "link_port", DEFAULT_LINK_PORT);
  return ok(d) ? d : DEFAULT_LINK_PORT;
}

/** What the link's services row should want now, and on which port. */
export function linkWish(store: Store, at: number): { want: "running" | "stopped"; port: number; listen: LinkListen } {
  const listen = linkListen(store);
  const port = linkPort(store);
  const want = listen === "on" || (listen === "auto" && listHosts(store, {}, at).some((h) => h.status === "pending" || h.status === "accepted")) ? "running" : "stopped";
  return { want, port, listen };
}

/** Keep the `link` services row's wish in step with the settings and the host list; a change is a new wish
 *  (want_at moves, a failed wish is asked again). Returns the row (null when there is none and none is wanted). */
export function syncLinkWish(store: Store, at: number): Row | null {
  const w = linkWish(store, at);
  const r = store.get("services", { name: "link", project: "", topic: "" });
  if (!r) {
    if (w.want !== "running") return null;
    store.db.run("INSERT INTO services (name, project, topic, port, want, want_by, want_at, observed_at, updated_at) VALUES ('link', '', '', ?, 'running', 'loop', ?, ?, ?)", [w.port, at, at, at]);
  } else if (r.want !== w.want || Number(r.port) !== w.port) {
    store.db.run("UPDATE services SET want = ?, port = ?, want_by = 'loop', want_at = ?, want_result = NULL, updated_at = ? WHERE id = ?", [w.want, w.port, at, at, r.id]);
  } else return r;
  return store.get("services", { name: "link", project: "", topic: "" });
}

export const linkUp = (r: Row) => boardUp(Number(r.port), linkBinds(), r.pid);

export function logPath(root: string): string { return join(root, "link-serve.log"); }
const tail = (path: string) => { try { return readFileSync(path, "utf8").trim().split("\n").slice(-3).join(" ").slice(-600); } catch { return ""; } };

const rowOf = (s: Store, a: { payload?: unknown }) => s.wish("service", Number((a.payload as { id?: number })?.id));
function fail(s: Store, r: Row, why: string, at: number): void {
  set(s, "service_failed", r, { status: "failed", pid: null, result: why, want_result: `failed: ${why}` }, at, { error: why });
}

async function start(x: Exec, r: Row): Promise<Result> {
  const { store, now: at } = x, id = Number(r.id), port = Number(r.port);
  const served = Math.max(at, Number(r.want_at ?? 0));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) { fail(store, r, `no valid port (${r.port})`, at); return { failed: `no valid port (${r.port})` }; }
  const log = logPath(store.root);
  mkdirSync(store.root, { recursive: true });
  try { renameSync(log, `${log}.1`); } catch { /* none yet */ }
  closeSync(openSync(log, "w"));
  const b = linkBinds();
  const argv = [process.execPath, process.env.DS_LINK_SERVER || join(ROOT, "bin", "link", "server.ts"), b, String(port)];
  const env = childEnv({ DS_STATE_ROOT: store.root, DS_READY_FILE: null });
  let h: Handle | null = null;
  if (systemdUp()) h = await startUnit(`ds-link-${id}`, argv, env, log, isLink);
  if (!h) {
    const fd = openSync(log, "a");
    let p: Bun.Subprocess;
    try { p = Bun.spawn(argv, { cwd: ROOT, detached: true, stdio: ["ignore", fd, fd], env } as Parameters<typeof Bun.spawn>[1]); }
    catch (e) { closeSync(fd); const why = `spawn failed: ${(e as Error).message}`; fail(store, r, why, at); return { failed: why }; }
    closeSync(fd);
    p.unref();
    for (const [pid, c] of children) if (c.exitCode !== null || c.signalCode) children.delete(pid);
    children.set(p.pid, p);
    h = { pid: p.pid, exited: () => (p.exitCode !== null || p.signalCode ? { code: p.exitCode } : null) };
  }
  const { pid } = h;
  markStarting(id, true);
  set(store, "service_starting", r, { status: "starting", pid, started_at: served, result: null }, at, { pid, port });
  return {
    background: (async (): Promise<Result> => {
      try {
        for (let t = 0; t < waitMs(); t += 200) {
          const gone = h.exited();
          if (gone) { const why = tail(log) || `the link server exited ${gone.code ?? "(signal)"}`; fail(store, r, why, at); return { failed: why }; }
          if (await boardUp(port, b, pid)) {
            set(store, "service_started", r, { status: "running", pid, last_ping_at: at }, at, { pid });
            return { done: true, result: { pid, port } };
          }
          await Bun.sleep(200);
        }
        await stop(pid);
        const t = tail(log), why = `the link server didn't answer /healthz on :${port} within ${waitMs() / 1000}s${t ? `: ${t}` : ""}`;
        fail(store, r, why, at);
        return { failed: why };
      } finally { markStarting(id, false); }
    })(),
  };
}

/** The exit code of a link server this loop process spawned detached (75 = its code changed); null otherwise. */
export function linkExitCode(pid: number): number | null { return children.get(pid)?.exitCode ?? null; }

const link: Fulfiller = {
  name: "link",
  scope: "host",
  kinds: ["link_start", "link_restart", "link_stop", "link_giveup"],
  run: () => [],
  async exec(a, x) {
    const r = rowOf(x.store, a);
    if (!r) return { dropped: "no such services row" };
    const p = (a.payload ?? {}) as { counted?: boolean; why?: string };
    if (a.kind === "link_stop") {
      await stop(r.pid);
      set(x.store, "service_stopped", r, { status: "stopped", pid: null }, x.now);
      return { done: true };
    }
    if (a.kind === "link_giveup") {
      await stop(r.pid);
      const why = p.why ?? "restarted too often";
      fail(x.store, r, why, x.now);
      const project = discoverProjects(x.store.root)[0];
      if (project) await alert(x.store, project, "link", a.episode,
        `the side-host link server ${why} — the loop stopped restarting it; see ${logPath(x.store.root)}; it starts again when link_listen or link_port changes, or the host list does`);
      return { done: true };
    }
    if (a.kind === "link_restart") {
      await stop(r.pid);
      const restarts = restartsOf(r);
      if (p.counted) restarts.push(x.now);
      set(x.store, "service_restarted", r, { restarts: JSON.stringify(restarts.slice(-20)), pid: null }, x.now, { why: p.why ?? null, counted: !!p.counted });
    } else if (isLink(r.pid) && await linkUp(r)) {
      set(x.store, "service_started", r, { status: "running", last_ping_at: x.now }, x.now, { pid: r.pid, adopted: true });
      return { done: true };
    }
    return start(x, rowOf(x.store, a) ?? r);
  },
};
export default link;
