// channels/contract.ts — side-loop-host U4 (issue #127): the side answers main's contract ops for its own members.
// Main's remote adapter (bin/backend/remote.ts) sends `{backend, project, envelope: {op, req}}`; this host makes
// that backend under its own state root (squad/contracts.ts makeContract: tmux, herdr, orca-lite) and answers the
// envelope with `handle()`, so a request outside its op's type is answered `bad_request` here too. The answer goes
// back as is; main checks it (`checked()`). The backend and project are names (they become paths under the side
// state root), checked before anything is made; a backend this host has no adapter for is refused.
// side-loop-host U10: a terminal made here is a side member's, so its env gets DS_MAIN_URL (the side relay's socket
// under this host's state root, relay.ts mainUrlFor: its `bin/ds` calls go up the link) whatever main sent, and its
// folder (a member start: DS_MEMBER set) is marked trusted for the login it runs on (claude stops at the folder-trust prompt otherwise):
// U19: the account's folder main names in CLAUDE_CONFIG_DIR, else this host's own default login.
import { isAbsolute } from "node:path";
import { handle, type Backend } from "../../backend/contract.ts";
import { markTrusted, systemJsonDir } from "../../loop/drivers/claude-launch.ts";
import { mainUrlFor } from "../relay.ts";
import { CONTRACT_CHANNEL } from "../../backend/remote.ts";
import { makeContract } from "../../loop/squad/contracts.ts";
import type { Channel } from "../protocol.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Makes this host's backend `name` of `project` under its state root `root`; null when it has none. */
export type MakeHere = (root: string, name: string, project: string) => Backend | null;

/** A `terminal.create` envelope with DS_MAIN_URL set to this host's relay and its folder trusted; any other as is. */
export function sideCreate(envelope: Record<string, unknown>, root: string, env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const req = envelope.req;
  if (envelope.op !== "terminal.create" || !isObj(req)) return envelope;
  const cwd = req.cwd, given = isObj(req.env) ? req.env : {};
  // Only a member's start (main sets DS_MEMBER) is an agent's folder to trust.
  // U19: in the account's login folder when main named one (CLAUDE_CONFIG_DIR), else this host's own login.
  const home = typeof given.CLAUDE_CONFIG_DIR === "string" && isAbsolute(given.CLAUDE_CONFIG_DIR) ? given.CLAUDE_CONFIG_DIR : null;
  if (given.DS_MEMBER && typeof cwd === "string" && isAbsolute(cwd)) { try { markTrusted(home ?? systemJsonDir(env), cwd); } catch { /* the launch shows the prompt */ } }
  return { ...envelope, req: { ...req, env: { ...given, DS_MAIN_URL: mainUrlFor(root) } } };
}

/** The `contract` channel over `make` (a test's fake), else the side's real adapters, each made once. */
export function contractChannel(make?: MakeHere): Channel {
  const kept = new Map<string, Backend>();
  return {
    name: CONTRACT_CHANNEL,
    answers: "side",
    async handle(body, ctx) {
      if (!isObj(body)) throw new Error("contract: the body is {backend, project, envelope}");
      const { backend, project, envelope } = body;
      if (typeof backend !== "string" || !NAME.test(backend)) throw new Error(`contract: backend is a name, not ${JSON.stringify(backend)}`);
      if (typeof project !== "string" || !NAME.test(project)) throw new Error(`contract: project is a name, not ${JSON.stringify(project)}`);
      if (!isObj(envelope)) throw new Error("contract: envelope is {op, req}");
      const k = `${ctx.root}\t${backend}\t${project}`;
      let b = kept.get(k);
      if (!b) {
        const made = make ? make(ctx.root, backend, project) : makeContract(ctx.root, backend, project);
        if (!made) throw new Error(`contract: backend ${backend}: this host has no adapter for it`);
        b = made;
        kept.set(k, b);
      }
      return handle(b, sideCreate(envelope, ctx.root));
    },
  };
}

export default contractChannel();
