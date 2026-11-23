// contract.ts — the backend contract v2 (orca-backend-alternatives U2; conventions/backend.md,
// "Contract v2"). A backend runs terminals and nothing else: worktrees, launch lines, accounts, the
// parents tree and start idempotency stay in the loop. Every op is one JSON request and one JSON
// answer, so a later remote backend (the sideloop on another host) can carry it over ssh or a socket:
//
//   const a = await backend.call("terminal.create", { cwd, env: { DS_GEN: gen }, label: "builder", group: "squad" });
//   if (a.ok) a.terminal.id
//
// One shape per request and per answer (core/schema.ts) gives both the TypeScript type and the run
// time check: `checkRequest`/`checkAnswer` name the field that is wrong, `handle` is the wire entry
// (an envelope in, an answer out, a bad request answered `bad_request` before the backend sees it),
// and `checked` wraps a backend so an answer outside its type throws (the conformance suite runs every
// adapter through it, tests/loop/backend-conformance.ts).
//
// Capabilities (`backend.info`) say what a backend can do; the loop does the rest itself:
//   parents       native  the backend nests a terminal's worktree under its `parent` (Orca)
//                 groups  the backend places a terminal in its `group` (a tmux session, a herdr workspace)
//                 none    neither; the tree lives in loop.db only
//   state         native  `agent.state` reads the agent's state; none: it always answers `unknown`
//   turn_confirm  native  `terminal.send` with submit answers `turn_started` once it saw a turn start;
//                 none: a send only ever answers `accepted`
//   keys          native  `terminal.send {keys}` types named keys; none: it answers `unsupported`
import { arr, bool, lit, num, obj, opt, rec, str, type Shape, type Val } from "../loop/core/schema.ts";

export const CAPABILITY_VALUES = {
  parents: ["native", "groups", "none"],
  state: ["native", "none"],
  turn_confirm: ["native", "none"],
  keys: ["native", "none"],
} as const;

const capabilities = obj({
  parents: lit(...CAPABILITY_VALUES.parents),
  state: lit(...CAPABILITY_VALUES.state),
  turn_confirm: lit(...CAPABILITY_VALUES.turn_confirm),
  keys: lit(...CAPABILITY_VALUES.keys),
});
export type Capabilities = Val<typeof capabilities>;

// Every capability mix (3 × 2 × 2 × 2 = 24): the conformance suite runs the fake in each.
export function capabilityMixes(): Capabilities[] {
  const out: Capabilities[] = [];
  for (const parents of CAPABILITY_VALUES.parents)
    for (const state of CAPABILITY_VALUES.state)
      for (const turn_confirm of CAPABILITY_VALUES.turn_confirm)
        for (const keys of CAPABILITY_VALUES.keys) out.push({ parents, state, turn_confirm, keys });
  return out;
}

// The named keys `terminal.send {keys}` may carry, plus any single digit or lowercase letter (a menu
// pick). Anything else is a bad request.
export const KEYS = ["Enter", "Escape", "Tab", "Backspace", "Up", "Down", "Left", "Right", "C-c", "C-d"] as const;
export type Key = (typeof KEYS)[number] | string;
const key: Shape<Key> = {
  name: "a key",
  check: (v, path) => (typeof v === "string" && ((KEYS as readonly string[]).includes(v) || /^[0-9a-z]$/.test(v))
    ? null : `${path} must be one of ${KEYS.join("|")} or one digit or lowercase letter, got ${JSON.stringify(v)}`),
};
// A string-to-string map (a terminal's env).
const strMap: Shape<Record<string, string>> = {
  name: "a map of strings",
  check(v, path) {
    const m = rec.check(v, path);
    if (m) return m;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return `${path} has a bad name ${JSON.stringify(k)}`;
      if (typeof x !== "string") return `${path}.${k} must be a string`;
    }
    return null;
  },
};
const nullable = <V>(s: Shape<V>): Shape<V | null> => ({ name: `${s.name} or null`, check: (v, path) => (v === null ? null : s.check(v, path)) });
const nonEmpty: Shape<string> = { name: "a non-empty string", check: (v, path) => str.check(v, path) ?? ((v as string).length ? null : `${path} must not be empty`) };

// A terminal as the backend lists it. `id` is the backend's own handle, opaque to the loop. `gen` is
// the `DS_GEN` the terminal was created with (null without one): the loop matches a retried start on
// it. `group` echoes the request's group when parents is `groups`, else null; `parent` echoes the
// request's parent when parents is `native`, else null. `created_at` is epoch seconds.
const terminal = obj({
  id: nonEmpty,
  cwd: str,
  label: str,
  group: nullable(str),
  parent: nullable(str),
  gen: nullable(str),
  created_at: num,
});
export type Terminal = Val<typeof terminal>;

export const AGENT_STATES = ["working", "waiting", "idle", "unknown"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

// Each op: its request and its answer (without the `ok` field every answer carries).
const OPS = {
  "backend.info": {
    req: obj({}),
    ans: obj({ name: nonEmpty, version: str, capabilities }),
  },
  "terminal.create": {
    req: obj({ cwd: nonEmpty, env: opt(strMap), label: str, group: opt(str), parent: opt(str) }),
    ans: obj({ terminal }),
  },
  "terminal.list": {
    req: obj({}),
    ans: obj({ terminals: arr(terminal) }),
  },
  // Closing a terminal that is already gone answers closed:false, not an error: a replayed close is safe.
  "terminal.close": {
    req: obj({ id: nonEmpty }),
    ans: obj({ closed: bool }),
  },
  // Exactly one of text and keys. submit (text only) presses Enter after the text.
  "terminal.send": {
    req: obj({ id: nonEmpty, text: opt(str), keys: opt(arr(key)), submit: opt(bool) }),
    ans: obj({ delivery: lit("turn_started", "accepted") }),
  },
  // screen true: the visible screen only; false or absent: the scrollback too, at most `lines` lines.
  "terminal.read": {
    req: obj({ id: nonEmpty, screen: opt(bool), lines: opt(num) }),
    ans: obj({ text: str }),
  },
  // When the terminal last printed anything, epoch seconds; null when it never did or cannot tell.
  "terminal.last_output": {
    req: obj({ id: nonEmpty }),
    ans: obj({ at: nullable(num) }),
  },
  "agent.state": {
    req: obj({ id: nonEmpty }),
    ans: obj({ state: lit(...AGENT_STATES) }),
  },
} as const;

export type Op = keyof typeof OPS;
export const OP_NAMES = Object.keys(OPS) as Op[];
export type Request<O extends Op> = Val<(typeof OPS)[O]["req"]>;
export type Reply<O extends Op> = Val<(typeof OPS)[O]["ans"]>;

// A failed op: `not_found` (no such terminal), `unsupported` (the capability is off), `bad_request`
// (the request is outside its type, or text and keys both or neither), `failed` (the backend could
// not do it; message says why).
export const ERROR_CODES = ["not_found", "unsupported", "bad_request", "failed"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type Failure = { ok: false; error: { code: ErrorCode; message: string } };
export type Answer<O extends Op> = ({ ok: true } & Reply<O>) | Failure;

export interface Backend {
  call<O extends Op>(op: O, req: Request<O>): Promise<Answer<O>>;
}

export const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, error: { code, message } });
export const okAnswer = <O extends Op>(_op: O, r: Reply<O>): Answer<O> => ({ ok: true, ...r }) as Answer<O>;

export const isOp = (v: unknown): v is Op => typeof v === "string" && Object.prototype.hasOwnProperty.call(OPS, v);

// Null when the request fits the op, else a message naming the field.
export function checkRequest(op: Op, req: unknown): string | null {
  const m = OPS[op].req.check(req, "req");
  if (m) return m;
  if (op === "terminal.send") {
    const r = (req ?? {}) as { text?: unknown; keys?: unknown; submit?: unknown };
    const hasText = r.text !== undefined && r.text !== null, hasKeys = r.keys !== undefined && r.keys !== null;
    if (hasText === hasKeys) return "req must carry exactly one of text and keys";
    if (hasKeys && (r.keys as unknown[]).length === 0) return "req.keys must not be empty";
    if (hasKeys && r.submit) return "req.submit goes with text, not keys";
  }
  return null;
}

// Null when the answer fits the op (an ok answer its shape, a failure the failure shape).
export function checkAnswer(op: Op, ans: unknown): string | null {
  if (typeof ans !== "object" || ans === null || Array.isArray(ans)) return "answer must be an object";
  const ok = (ans as { ok?: unknown }).ok;
  if (ok === true) return OPS[op].ans.check(ans, "answer");
  if (ok === false) {
    const e = (ans as { error?: { code?: unknown; message?: unknown } }).error;
    if (typeof e !== "object" || e === null) return "answer.error must be an object";
    if (!(ERROR_CODES as readonly unknown[]).includes(e.code)) return `answer.error.code must be one of ${ERROR_CODES.join("|")}, got ${JSON.stringify(e.code)}`;
    if (typeof e.message !== "string") return "answer.error.message must be a string";
    return null;
  }
  return "answer.ok must be true or false";
}

// The wire entry: an envelope `{op, req}` (parsed JSON) in, an answer out. An unknown op or a bad
// request is answered `bad_request` without calling the backend; a backend that throws is `failed`.
export async function handle(backend: Backend, envelope: unknown): Promise<Answer<Op>> {
  const e = (envelope ?? {}) as { op?: unknown; req?: unknown };
  if (!isOp(e.op)) return fail("bad_request", `unknown op ${JSON.stringify(e.op)}`);
  const req = e.req ?? {};
  const m = checkRequest(e.op, req);
  if (m) return fail("bad_request", m);
  try { return await backend.call(e.op, req as Request<Op>); }
  catch (x) { return fail("failed", (x as Error)?.message ?? String(x)); }
}

export class ContractError extends Error {}

// A backend whose every answer is checked: one outside its op's type throws a ContractError naming
// the op and the field. A request outside its type throws too, before the backend sees it.
export function checked(backend: Backend): Backend {
  return {
    async call<O extends Op>(op: O, req: Request<O>): Promise<Answer<O>> {
      const rm = checkRequest(op, req);
      if (rm) throw new ContractError(`${op}: ${rm}`);
      const a = await backend.call(op, req);
      const am = checkAnswer(op, a);
      if (am) throw new ContractError(`${op}: ${am}`);
      return a;
    },
  };
}
