// kinds.ts — every kind the loop writes and the shape of its payload, in one place (U43).
//
//   WISHES     the states a squad, member or service can be wished into, and a wish's payload
//   FACTS      `store.fact(kind, …)`: the kind and the payload of its `events` row
//   REQUESTS   `store.request(kind, …)`: the one-off rows a person, a script or a reconciler writes
//   ACTIONS    what the actuator hands a fulfiller: every request kind, plus the kinds reconcilers raise
//
// store.ts checks a wish, fact or request when it is written: an unknown kind or a payload that does
// not match is thrown with the kind and the field named, and nothing is written (no row, no event).
// A row already in loop.db is never checked again: fulfillers read old rows as they always did.
// A fulfiller takes its payload from `payloadOf(action)`, typed by ACTIONS, instead of asserting it.
//
// Adding a kind: add a line here; the type of its payload follows from the shape (`Val<…>`).
// The unknown-action-kind alert in actuator.ts stays for rows written before this module.
import { any, arr, bool, either, lit, num, obj, opt, rec, str, type ObjShape, type Shape, type Val } from "./schema.ts";

// ---------------------------------------------------------------- wishes
export const WANTS = ["running", "suspended", "gone"] as const;
export const MEMBER_WANTS = ["running", "stopped", "gone"] as const;
export const SERVICE_WANTS = ["running", "stopped"] as const;
export const ONE_TIME = ["restart", "reload", "clear"] as const;
export const RESTART_MODES = ["now", "idle"] as const;

// A wish's payload (`want_payload`), by subject. A string is a stored replay and is not checked.
export const WISH_PAYLOADS = {
  squad: obj({ from: opt(str), id: opt(num) }),
  member: obj({ why: opt(str), prompt: opt(str), agent: opt(str), model: opt(str), effort: opt(str), account: opt(str), ctx: opt(num),
    request: opt(bool), unit: opt(str), spec: opt(str), pauseResume: opt(str) }),
  service: obj({ bind: opt(str), hosts: opt(str) }),
} as const;
export type WishPayload<S extends keyof typeof WISH_PAYLOADS> = Val<(typeof WISH_PAYLOADS)[S]>;

// ---------------------------------------------------------------- requests
const replay = obj({ argv: arr(str), kind: opt(str), key: opt(str), cwd: opt(str), from: opt(str) });
const MERGE = obj({ n: opt(num), repo: opt(str), method: opt(str), unit: opt(str), topic: opt(str), base: opt(str), ref: opt(str), head: opt(str), ep: opt(str) });
const THROUGH = { request: opt(num) };

export const REQUESTS = {
  account: obj({ agent: str, account: str, enabled: opt(bool) }),
  // account-free-resets U4: one press of a grant's Use button; `key` is the idempotency key every try reuses.
  "account-reset": obj({ agent: str, account: str, grant: str, key: str, ...THROUGH }),
  alert: obj({ title: opt(str), text: opt(str), option: opt(str), why: opt(str), unit: opt(str), card: opt(str), reason: opt(str), fields: opt(rec) }),
  "alert-clear": obj({ prefix: opt(str), id: opt(str) }),
  answer: obj({ id: str, answer: str, seq: opt(num), card_wt: opt(str), choices: opt(arr(any)), transcript: opt(str), tool_use_id: opt(str), via: opt(str) }),
  board: obj({ file: str, text: str }),
  chat: obj({ text: str, via: opt(str), request: opt(num) }),
  dismiss: obj({ id: str, answer: opt(str) }),
  duplicate: obj({ wt: opt(str), handle: opt(str), newest: opt(str), runHandle: opt(str), mismatch: opt(bool), first: opt(num) }),
  "finish-unit": replay,
  keys: obj({ text: str, enter: opt(bool) }),
  lavish: obj({ port: either(num, str) }),
  "config-undo": obj({ file: str, key: str, history: num }),
  "limit-lift": obj({ agent: str, account: str, ...THROUGH }),
  limits: obj({ key: str, value: opt(either(str, num)) }),
  merge: MERGE,
  "notify-squads": replay,
  override: obj({ model: opt(str), effort: opt(str), plan: opt(str), account: opt(str), clear: opt(bool), scope: opt(str), role: opt(str) }),
  picker: obj({ op: str, id: str, squad: opt(str), reason: opt(str) }),
  poke: obj({ text: str, reason: opt(str), request: opt(num), delivery: opt(num), wt: opt(str), handle: opt(str), quietS: opt(num), messages: opt(arr(num)) }),
  "reassert-roles": replay,
  reply: obj({ id: str, answer: str, run: opt(str), message: opt(num) }),
  "request-restart": obj({ target: opt(str), key: opt(str), who: opt(str), topic: opt(str), cause: opt(str), since: opt(num), what: opt(str), command: opt(str), path: opt(str), text: opt(str) }),
  "request-switch": obj({ target: opt(str), key: opt(str), who: opt(str), topic: opt(str), cause: opt(str), since: opt(num), what: opt(str), command: opt(str), path: opt(str), text: opt(str) }),
  "request.file": obj({ target: opt(str), key: opt(str), who: opt(str), topic: opt(str), cause: opt(str), since: opt(num), what: opt(str), command: opt(str), path: opt(str), text: opt(str) }),
  roles: obj({ role: str, agent: opt(str), model: opt(str), effort: opt(str), spawn: opt(str), fallbacks: opt(str), reset: opt(bool), plan: opt(str) }),
  "send-peer": replay,
  "send-role": replay,
  skills: obj({ role: opt(str), reset: opt(bool), set: opt(rec) }),
  squad: obj({ id: opt(num), op: opt(str) }),
  studio: obj({ action: str, topic: opt(str), line: opt(str), framing: opt(str), id: opt(str), answer: opt(str), request: opt(num), label: opt(str), date: opt(str), since: opt(num), until: opt(num), spend: opt(any), merges_upto: opt(any) }),
  "studio-move": obj({ handle: opt(str), agent: opt(str), account: opt(str), model: opt(str), effort: opt(str), from: opt(str) }),
  withdraw: obj({ of: opt(str), key: opt(str), episode: opt(str) }),
  "worktree.remove": obj({ label: opt(str), topic: opt(str), wt: opt(str), path: opt(str), unit: opt(str), merged: opt(bool) }),
  "plan-revoke": obj({ plan: str, why: str, keep_started: opt(bool) }),
  "unit-action": obj({ action: str, slug: str, why: opt(str) }),
  "wt-set-parent": obj({ wt: str, parent: str, request: opt(num) }),
} as const satisfies Record<string, ObjShape<any>>;
export type RequestKind = keyof typeof REQUESTS;
export type RequestPayload<K extends RequestKind> = Val<(typeof REQUESTS)[K]>;
export const isRequestKind = (k: string): k is RequestKind => Object.hasOwn(REQUESTS, k);

// ---------------------------------------------------------------- actions
// The kinds a reconciler raises that no request row carries.
const ONLY_ACTIONS = {
  member: obj({ id: num, stop: opt(bool), why: opt(str) }),
  "member.close": obj({ id: opt(num), phase: opt(str), why: opt(str) }),
  rebind: obj({ wt: opt(str), handle: opt(str), dispatch: opt(str), redo: opt(str), giveup: opt(bool), settle: opt(str), task: opt(str), tasks: opt(arr(str)), count: opt(num), status: opt(str) }),
  unbind: obj({ wt: opt(str), handle: opt(str), dispatch: opt(str), redo: opt(str), giveup: opt(bool), settle: opt(str), task: opt(str), tasks: opt(arr(str)), count: opt(num), status: opt(str) }),
  stray: obj({ wt: opt(str), handle: opt(str), state: opt(str), title: opt(str) }),
  "pause-control": obj({ id: opt(num) }),
  "cancel.stop": obj({ wt: opt(str), unit: opt(str) }),
  "cancel.remove": obj({ wt: opt(str), unit: opt(str) }),
  "cancel.pr": obj({ wt: opt(str), unit: opt(str) }),
  "cleanup.act": obj({ class: str, key: str, path: opt(str) }),
  "cleanup.report": obj({ refused: opt(str) }),
  // exposed-cleanup U2: run one group of queued stop commands (exposed rows `ids`, one command) once.
  "expose.stop": obj({ ids: arr(num), cmd: str, cwd: opt(str) }),
  board_start: obj({ id: opt(num), counted: opt(bool), why: opt(str) }),
  board_restart: obj({ id: opt(num), counted: opt(bool), why: opt(str) }),
  board_stop: obj({ id: opt(num), counted: opt(bool), why: opt(str) }),
  board_giveup: obj({ id: opt(num), counted: opt(bool), why: opt(str) }),
} as const satisfies Record<string, ObjShape<any>>;
export const ACTIONS = { ...REQUESTS, ...ONLY_ACTIONS } as const;
export type ActionKind = keyof typeof ACTIONS;
export type ActionPayload<K extends ActionKind> = Val<(typeof ACTIONS)[K]>;

/** An action's payload as its kind's shape (a missing payload is `{}`; an old row may lack fields, so treat optional ones as such). */
export function payloadOf<K extends ActionKind>(a: { kind: string; payload?: unknown }, _kind?: K): ActionPayload<K> {
  return (a.payload ?? {}) as ActionPayload<K>;
}

// ---------------------------------------------------------------- facts
const ep = obj({ episode: opt(str), account: opt(str), notice: opt(str), reset: opt(num), kind: opt(str), until: opt(num) });
const svc = { id: num, name: opt(str), project: opt(str), topic: opt(str), port: opt(num) };
const delivery = { delivery: num, state: opt(str), settled_at: opt(num), tries: opt(num), at: opt(num), verify_at: opt(num) };
const wishDone = obj({ result: opt(str), want: opt(str), id: opt(num), subject: opt(str) });
const anyOf = obj({}); // payload is the written columns: not fixed

export const FACTS = {
  cancel_wish_cleared: obj({}),
  coordinator: obj({ bound: opt(any), handle: opt(str), pane: opt(str), run: opt(str), was: opt(any) }),
  delivery_escalated: obj(delivery),
  delivery_sent: obj(delivery),
  delivery_verified: obj(delivery),
  exposed: obj({ name: str, role: opt(str), scope: opt(str), suffix: opt(str), url: opt(str), audience: opt(str), stop: opt(bool), ports: opt(arr(num)) }),
  limit_cleared: ep,
  limit_expired: ep,
  limit_wait: ep,
  limited: ep,
  message_delivered: obj({ ids: arr(num) }),
  message_read: obj({ ids: arr(num), by: str }),
  message_replied: obj({ id: num, reply: opt(num), request: opt(num) }),
  message_sent: obj({ key: str, to: str, from: str, kind: str, subject: str }),
  builder_wish_settled: obj({ id: num, unit: str, was: opt(str) }),
  builder_wish_withdrawn: obj({ id: num, unit: str, why: str, by: str, reason: opt(str) }),
  member_drift_cleared: obj({ id: opt(num), path: opt(str), status: opt(str) }),
  member_placed: obj({}),
  member_requested: obj({ by: opt(str), id: opt(num), role: opt(str), suffix: opt(str), tier: opt(str), unit: opt(str) }),
  member_start_failed: anyOf,
  member_started: anyOf,
  member_suspended: obj({ id: opt(num), result: opt(str) }),
  member_told: anyOf,
  member_waiting: obj({}),
  orca_call_settled: obj({ dispatch: opt(str), retry: opt(any), state: opt(str) }),
  request_done: obj({ id: num, kind: opt(str), result: opt(any) }),
  service_failed: obj({ ...svc, error: opt(str), superseded: opt(bool) }),
  service_restarted: obj({ ...svc, counted: opt(bool), why: opt(str) }),
  service_started: obj({ ...svc, pid: opt(num), adopted: opt(bool) }),
  service_starting: obj({ ...svc, pid: opt(num) }),
  service_stopped: obj({ ...svc, gone: opt(bool) }),
  account_credits_held: obj({ agent: str, account: str, until: opt(num), from: opt(str), notice: opt(str), link: opt(str) }),
  spend: obj({ squads: opt(num) }),
  squad_run: obj({ id: num, run_id: str }),
  squad_state: obj({ cmd: opt(str), args: opt(arr(any)) }),
  squad_suspended: obj({ id: opt(num), subject: opt(str), want: opt(str) }),
  squad_task: obj({ id: num, task_id: str }),
  studio_adopted: obj({ agent: opt(str), handle: opt(str), previous: opt(any) }),
  studio_move_approved: obj({ alert: opt(any) }),
  studio_moved: anyOf,
  studio_released: obj({ candidates: opt(arr(any)), previous: opt(any) }),
  unit_builder_moved: anyOf,
  unit_cancelled_builder_started: anyOf,
  unit_dispatched: anyOf,
  units_held_for_revalidation: obj({ units: arr(str), why: str }),
  "unit-status": anyOf,
  wish_done: wishDone,
  wish_given_up: obj({ error: opt(any), id: opt(num), subject: opt(str), want: opt(str) }),
  wish_seeded: obj({ field: opt(str), id: opt(num), new: opt(any), old: opt(any), who: opt(str) }),
} as const satisfies Record<string, Shape<any>>;
export type FactKind = keyof typeof FACTS;
export type FactPayload<K extends FactKind> = Val<(typeof FACTS)[K]>;
export const isFactKind = (k: string): k is FactKind => Object.hasOwn(FACTS, k);

// A problem with a value for a kind's shape, or null. `what` is "request", "fact" or "wish".
export function problem(what: string, kind: string, table: Record<string, Shape<any>>, payload: unknown): string | null {
  const shape = Object.hasOwn(table, kind) ? table[kind] : null;
  if (!shape) return `store: unknown ${what} kind '${kind}' (known: ${Object.keys(table).join(", ")})`;
  const m = typeof payload === "string" ? null : shape.check(payload, "payload");
  return m ? `store: ${what} kind '${kind}': ${m}` : null;
}
export { lit };
