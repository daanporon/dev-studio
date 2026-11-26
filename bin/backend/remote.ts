// remote.ts — side-loop-host U4 (issue #127; conventions/backend.md, "A backend on another host"): the contract
// backend of a member on a named side host. It runs no terminal itself: each op goes down that host's link on the
// `contract` channel (bin/link/channels/contract.ts), the side host answers it with its own backend through
// `handle()`, and the answer comes back as is. Wrap it in `checked()` (squad/contracts.ts and
// bin/lib/contract-roles.ts do), so an answer outside its op's type throws a ContractError on main.
//
//   const b = checked(remoteBackend({ root, host: "side-a", backend: "tmux", project: "realp" }));
//   await b.call("terminal.create", { cwd: "/home/me/wt/u4", label: "builder" });   // runs on side-a
//
// Terminal ids carry the host on main, like the replica's handles (KTD8, drivers/contract.ts handleUp): an id
// in an answer goes up as `<host>:<id>`; an id in a request loses that prefix going down. An id without this
// host's prefix names no terminal there: it answers `not_found` (a close `closed:false`) without a round trip.
// Folders (`cwd`, `parent`) are the side host's own paths and pass through unchanged.
//
// It works from any process on main: the loop and a role-side CLI call both reach the host through the link
// server's unix socket (bin/link/request.ts). A link that is down, a host not linked or a side that failed
// answers `failed` naming the host; it never throws.
import { checkRequest, fail, type Answer, type Backend, type Op, type Request, type Terminal } from "./contract.ts";
import { linkRequest } from "../link/request.ts";

/** The link channel a side host answers contract ops on. */
export const CONTRACT_CHANNEL = "contract";
/** How long one op waits for the side's answer (a create may start the side's tmux or herdr server). */
export const REMOTE_TIMEOUT_MS = 30_000;

/** What one request on the `contract` channel carries: the backend and project to answer it with, and the
 *  contract envelope (`{op, req}`) the side hands to `handle()`. */
export type ContractBody = { backend: string; project: string; envelope: { op: Op; req: unknown } };
/** Send one body to `host` and resolve with the side's raw answer; a test passes its own. */
export type RemoteSend = (host: string, body: ContractBody, timeoutMs: number) => Promise<unknown>;

// As drivers/contract.ts handleUp/handleDown, without that module's imports (role-side code loads this file).
const idUp = (host: string, id: string) => `${host}:${id}`;
const idDown = (host: string, id: string): string | null => (id.startsWith(`${host}:`) ? id.slice(host.length + 1) : null);

function termUp(host: string, t: Terminal): Terminal {
  return { ...t, id: idUp(host, t.id) };
}

/** The answer with every terminal id it names prefixed `<host>:`; anything else (a failure, a malformed
 *  answer) as is, so `checked()` judges what the side sent. */
function answerUp(host: string, op: Op, a: unknown): unknown {
  if (!a || typeof a !== "object" || (a as { ok?: unknown }).ok !== true) return a;
  const r = a as Record<string, unknown>;
  if (op === "terminal.create" && r.terminal && typeof (r.terminal as Terminal).id === "string") return { ...r, terminal: termUp(host, r.terminal as Terminal) };
  if (op === "terminal.list" && Array.isArray(r.terminals)) {
    return { ...r, terminals: r.terminals.map((t) => (t && typeof (t as Terminal).id === "string" ? termUp(host, t as Terminal) : t)) };
  }
  return a;
}

export type RemoteOpts = {
  /** Main's state root: the link server's unix socket is under it. */
  root: string;
  /** The side host's name (`hosts.name`, `members.host`). */
  host: string;
  /** The backend the side host runs the terminals on (the squad's `backend`). */
  backend: string;
  project: string;
  send?: RemoteSend;
  timeoutMs?: number;
};

/** The contract backend `backend` of `project` on side host `host`, over that host's link. */
export function remoteBackend(o: RemoteOpts): Backend {
  const send: RemoteSend = o.send ?? ((h, body, ms) => linkRequest(o.root, h, CONTRACT_CHANNEL, body, ms));
  const timeout = o.timeoutMs ?? REMOTE_TIMEOUT_MS;
  return {
    async call<O extends Op>(op: O, req: Request<O>): Promise<Answer<O>> {
      const bad = checkRequest(op, req);
      if (bad) return fail("bad_request", bad) as Answer<O>;
      let down: unknown = req;
      const id = (req as { id?: unknown }).id;
      if (typeof id === "string") {
        const local = idDown(o.host, id);
        if (local === null) {
          if (op === "terminal.close") return { ok: true, closed: false } as Answer<O>;
          return fail("not_found", `no terminal ${id} on host ${o.host}`) as Answer<O>;
        }
        down = { ...(req as object), id: local };
      }
      let a: unknown;
      try { a = await send(o.host, { backend: o.backend, project: o.project, envelope: { op, req: down } }, timeout); }
      catch (e) { return fail("failed", `host ${o.host}: ${(e as Error).message}`) as Answer<O>; }
      return answerUp(o.host, op, a) as Answer<O>;
    },
  };
}
