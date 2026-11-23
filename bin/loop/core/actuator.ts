// actuator.ts — the only code that changes Orca or the filesystem (U11, R20–R24, KTD10). The tick
// hands it each action whose episode is new; the fulfiller registered for the action's kind does
// the work. Fulfillers live in bin/loop/fulfil/*.ts, one file per kind group: each is a reconciler
// (it turns open wishes and requests into actions) with an `exec` for the actions of its `kinds`,
// so a later unit adds a kind by adding a file (KTD14).
//
// An action's claim row (episodes, kind `action:<kind>`) is its memory:
//   done      the work happened
//   pending   not yet: a failed try (`retry`, classified once by refusals.ts: a transient one is
//             tried again every DS_LOOP_RETRY_S, 15 minutes, per subject and fingerprint, counted, then
//             permanent; a known cause is fixed and tried once more, uncounted; a Claude launch that failed,
//             U270, is tried again after 60–90 s, three times uncounted, then as a transient one) or nothing to do it
//             with yet (`wait`: no free start slot, Orca busy; not counted). The action is kept in
//             the row and acted again from the tick at next_at (fulfil/pending.ts).
//   running   a start in the background; it holds one of DS_LOOP_START_SLOTS slots (default 4), or a
//             BACKGROUND_KINDS action (U239) holding one of DS_LOOP_BG_SLOTS (6)
//   dropped   its episode ended before it was acted, or the fulfiller says it is stale
//   failed    given up (`failed`, or a refusal that is permanent: its `refusals` row, one card
//             unless the fulfiller's giveUp told someone itself, and no claim of the subject while its
//             fingerprint is unchanged; ready() checks it before the tick claims)
//
// Every Orca mutation goes through call(): an `orca_calls` row with a fresh retry id is written
// first, then the backend runs with `--retry-request <id> --from <sender>`, then the row is settled.
// A call whose outcome is in doubt (a crash cut it short, or it exited non-zero) is asked about with
// `request-show`: completed is settled with its dispatch id, and the next call for the same key
// replays the same id to get the op's output back (Orca answers a seen id without starting again);
// absent after a non-zero exit is a refusal, settled failed; pending waits and is asked again.
// A claim the tick took but a crash never settled (`acted`, `running`) is put back to pending.
//
// A start the adapter says waits behind a live holder of its name lock ("pid N holds its lock") is
// acted again only every HELD_GAP seconds, so a hung holder can't keep the start slots. Its episode
// (kind `start-stuck`, subject as the action's) remembers the first wait: after STUCK_AFTER seconds
// one Studio alert names the member and the pid, and when the action settles for good the alert
// is resolved and the episode ends. The retry id stays and the holder is never killed: it may be
// mid-create, and a second run is what the lock prevents.
import { cardTitle, type Whose } from "../messages/cards.ts";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { actionBlock, actionTargets, actionVersion, deferredMail, paused, version, resumeAction, startBlock, actionStartSent } from "../pause/pause.ts";
import { outside, sender } from "../messages/coordinator.ts";
import { driverModule } from "../drivers/index.ts";
import { startIdentity } from "./whoami.ts";
import { startedOn, type Driver, type Member, type Seat, type Squad } from "../drivers/types.ts";
import { errOf, inDoubt, shell, spawn, type Orca, type Out } from "../io/orca.ts";
import { DIRS, load, type Action, type Actuator, type Reconciler, type TickCtx } from "./plugins.ts";
import { pick } from "../capacity/pick.ts";
import { SLOT_WAIT, startWait } from "../capacity/slot.ts";
import { syncPhase } from "../reconcilers/phases.ts";
import { compactWindow } from "../settings/limits.ts";
import { relay, relayWork } from "../messages/relay.ts";
import { countLine } from "../../backend/orca-cache.ts";
import { discoverProjects } from "../settings/projects.ts";
import { now, ROOT, type Row, type Store } from "./store.ts";
import { spreadDue } from "./timers.ts";
import { retireCapacityFacts } from "../fulfil/pending.ts";
import { envInt } from "./tick.ts";
import { loopStopping } from "./stopping.ts";
import { carded, classify, clear, causeOf, fingerprint, lapse, launchRetryAt, LAUNCH_TRIES, refuse, REFUSAL_KIND, standing } from "../io/refusals.ts";
import { keepStartFailed } from "../squad/start-failed.ts";
import { redact, redactPayload } from "./redact.ts";

export type Result =
  | { done: true; result?: unknown }
  | { idle: true }
  | { retry: string }
  | { wait: string; at?: number; blocked?: string }
  | { failed: string }
  | { dropped: string }
  | { background: Promise<Result> };

export type Exec = TickCtx & { act: LoopActuator };
export type Fulfiller = Reconciler & {
  kinds: string[];
  exec(a: Action, x: Exec): Result | Promise<Result>;
  ready?(a: Action, x: Exec): boolean | Promise<boolean>; // before claim: no room makes no action
  stale?(a: Action, x: Exec): boolean;       // true: the reason for the action has gone, drop it
  // The action given up for good; a truthy return: it told someone itself (its own card, or the
  // request it failed), so no refusal card.
  giveUp?(a: Action, x: Exec, why: string): unknown;
  // The facts a refusal of this action depends on (refusals.ts fingerprint); default its episode
  // and payload (the wish). A fulfiller whose episode flips with no change in reality names its own.
  fingerprint?(a: Action, x: Exec): unknown;
};

export type Pick = { agent: string; model: string; effort: string | null; account: string | null } | { wait: number | null; slot?: string } | { error: string };   // slot: WAIT slot: … (U145)
export type PickOpts = { agent?: string | null; model?: string | null; effort?: string | null; account?: string | null; limited?: string | null; fresh?: boolean; at?: number };
export type Picker = (store: Store, m: Member, opts: PickOpts) => Promise<Pick>;

const HOLDER = /pid (\S+) holds its lock/;
const HELD_GAP = 300;
export const STUCK_AFTER = 600;
// A wait the loop could not fix itself (`blocked`: what is wrong and the operator's next step, U59)
// raises its alert once it has lasted this long, through the same episode as a stuck start.
export const BLOCKED_AFTER = 120;
// A refusal that only says "not now" (no room, agent_busy): asked again after this long, not counted.
const REFUSED_WAIT = 30;

const sendTries = () => envInt("DS_LOOP_SEND_TRIES", 5);
const startSlots = () => envInt("DS_LOOP_START_SLOTS", 4);
// U239: these kinds run in the background like a start: the tick claims, the call runs on its own and
// its result settles the episode. Their own slots; one at a time per subject and per member worktree;
// a call that has not ended after DS_LOOP_BG_TIMEOUT_S (120) settles as a retry and frees its subject.
export const BACKGROUND_KINDS = new Set(["poke", "chat", "send-role", "send-peer", "member.close", "worktree.remove", "rebind", "unbind", "merge", "update-branch", "finish-unit", "studio-move", "expose.stop"]);
const bgSlots = () => envInt("DS_LOOP_BG_SLOTS", 6);
const bgTimeoutMs = () => envInt("DS_LOOP_BG_TIMEOUT_S", 120) * 1000;

const claimKey = (a: Action) => ({ project: a.project, subject: a.subject, kind: `action:${a.kind}` });
const errText = (e: unknown) => (e as Error)?.message ?? String(e);
const stuckKey = (a: Action) => ({ project: a.project, subject: a.subject, kind: "start-stuck" });

// U9's ladder (bin/loop/capacity/pick.ts), the loop's picker since U12. A plain start reads the member's
// `picks` row, which the pick reconciler wrote this tick: started on it when it holds a start slot,
// `wait` while it waits below the floor or is queued behind the start budget. An explicit
// agent/model or a limit move (an account to leave out) picks afresh with those, as does a member
// the reconciler has no row for.
export const ladderPick: Picker = async (store, m, o) => {
  const ok = (p: { agent: unknown; model: unknown; effort?: unknown; account?: unknown }) => ({ agent: String(p.agent), model: String(p.model), effort: (p.effort as string | null) ?? null, account: (p.account as string | null) ?? null });
  // U92: every restart picks for the phase the member is really in; write it first, and a
  // stored picks row from another phase does not win over the phase row.
  const full = store.get("members", { id: m.id });
  const phase = full && String(m.role) === "builder" ? syncPhase(store, m.project, full as Row) : (m.phase ?? "build");
  const row = o.fresh || o.agent || o.model || o.account || o.limited ? null : store.get("picks", { member: m.id });
  if (row && (row.phase == null || String(row.phase) === phase)) {
    if (row.slot === 1 && row.agent && row.model) return ok(row);
    if (row.wait_until != null || row.reason === "no account free" || String(row.reason ?? "").startsWith("queued")) return { wait: (row.wait_until as number | null) ?? null };
    if (SLOT_WAIT.test(String(row.reason ?? ""))) return { wait: null, slot: String(row.reason) };
    return { error: String(row.reason ?? "no pick") };
  }
  const r = full;
  const unit = store.db.query("SELECT tier FROM units WHERE project = ? AND squad = ? AND slug = ?").get(m.project, m.squad, m.suffix) as { tier: string | null } | null;
  const p = pick(store, { project: m.project, role: m.role, squad: m.squad, member: m.id, tier: (r?.tier as string | null) ?? unit?.tier ?? null,
    phase, agent: o.agent ?? null, model: o.model ?? null, effort: o.effort ?? null, account: o.account ?? null, limited: o.limited ? [o.limited] : [] }, o.at ?? now());
  return "error" in p ? p : "wait" in p ? { wait: p.wait, ...(startWait(p) ? { slot: p.reason } : {}) } : ok(p);
};

export class LoopActuator implements Actuator {
  private activity = new AsyncLocalStorage<Action>();
  readonly orca: Orca;
  readonly pick: Picker;
  private registry: Promise<Map<string, Fulfiller>> | null = null;
  private cardTried = new Map<string, number>();   // when ready() last tried a refusal card alerts.sh refused
  private inflight = new Set<Promise<unknown>>();
  private slots = 0;
  private bgBusy = new Set<string>();                      // subjects and worktrees with a background action running
  private times = new Map<string, number>();               // action kind -> ms spent since the tick last took it
  private senders = new Map<string, Promise<string>>();   // squad -> its sender, one lookup at a time
  private moving = new Map<string, number>();              // squad -> its replays that move the Run's seat, running
  private unseated = new Map<string, string>();            // squad -> why its last rebind failed
  private seatSeen = new Map<string, { sig: string; at: number }>(); // squad -> its seat as last checked with Orca (U244)
  private seatFailed = new Set<string>();                  // squads whose start or send failed on the seat (U244)
  private relayPeekAt = new Map<string, number>();         // squad -> when its Run's inbox was last peeked (U244)
  private unrelayed = new Map<string, string>();           // squad -> why its last relay failed

  constructor(private opts: { orca?: Orca; pick?: Picker; fulfillers?: Fulfiller[]; slots?: number; bgSlots?: number; bgTimeoutMs?: number } = {}) {
    this.orca = opts.orca ?? shell();
    this.pick = opts.pick ?? ladderPick;
  }

  private fulfillers(): Promise<Map<string, Fulfiller>> {
    this.registry ??= (async () => {
      const list = this.opts.fulfillers ?? (await load<Fulfiller>(DIRS.fulfil)).filter((f) => Array.isArray(f.kinds) && typeof f.exec === "function");
      const m = new Map<string, Fulfiller>();
      for (const f of list) for (const k of f.kinds) {
        if (m.has(k)) throw new Error(`actuator: kind '${k}' has two fulfillers (${m.get(k)!.name}, ${f.name})`);
        m.set(k, f);
      }
      return m;
    })();
    return this.registry;
  }

  // After a restart: settle the calls a crash cut short, and put back the starts that were running.
  async boot(store: Store, at: number): Promise<void> {
    const open = store.db.query("SELECT * FROM orca_calls WHERE settled_at IS NULL AND state IN ('sent', 'pending') ORDER BY id").all() as Row[];
    for (const c of open) await this.ask(store, c, at);
    store.db.run("UPDATE episodes SET state = 'pending', next_at = ? WHERE kind LIKE 'action:%' AND state IN ('acted', 'running') AND ended_at IS NULL AND action IS NOT NULL", [at]);
  }

  // request-show about a call in doubt, written to its row; the row as it is now. `refused` is the
  // error of a call that exited non-zero: absent then means Orca refused it (a new id is safe next
  // time); request-show failing leaves it unsettled, so the next call replays the same id.
  private async ask(store: Store, c: Row, at: number, refused?: string): Promise<Row> {
    const o = await this.orca.run("request-show", [String(c.retry_id)]);
    const [state = "", dispatch = ""] = o.out.trim().split("\t");
    const id = c.id as number;
    if (o.code === 0 && state === "completed") {
      store.fact("orca_call_settled", [{ table: "orca_calls", key: { id }, set: { state: "completed", dispatch: dispatch || null, result: null, settled_at: at } }],
        { project: c.project as string, squad: c.squad as string, member: c.member as string, payload: { retry: c.retry_id, state, dispatch } });
    } else if (o.code === 0 && state === "pending") {
      store.db.run("UPDATE orca_calls SET state = 'pending' WHERE id = ?", [id]);
    } else if (o.code === 0 && refused !== undefined) {
      store.db.run("UPDATE orca_calls SET state = 'failed', result = ?, settled_at = ? WHERE id = ?", [refused, at, id]);
    } else if (o.code === 0) {
      store.db.run("UPDATE orca_calls SET state = 'absent' WHERE id = ?", [id]);
    }
    return store.db.query("SELECT * FROM orca_calls WHERE id = ?").get(id) as Row;
  }

  // Before the claim: a subject refused for good (its fingerprint unchanged) or waiting its
  // transient retry is not claimed, so it writes no event and makes no call.
  // A permanent refusal whose card could not be written gets it here (at most once a minute). One
  // whose facts changed lapses: its card is resolved and the episode it failed is freed, so the
  // claim takes the same episode again.
  async ready(a: Action, ctx: TickCtx): Promise<boolean> {
    if (this.bgFull(a)) { this.deferred.set(a.kind, (this.deferred.get(a.kind) ?? 0) + 1); return false; }
    const f = (await this.fulfillers()).get(a.kind), x: Exec = { ...ctx, act: this };
    if (f) {
      const store = ctx.store, fp = this.fingerprintOf(f, a, x), stands = standing(store, a.project, a.subject, fp, ctx.now);
      if (stands) {
        const k = `${a.project}|${a.subject}|${fp}`;
        if (stands.class === "permanent" && stands.carded_at == null && (this.cardTried.get(k) ?? -Infinity) + 60 <= ctx.now) {
          this.cardTried.set(k, ctx.now);
          await this.refusalCard(x, a, stands);
        }
        return false;
      }
      const lapsed = lapse(store, a.project, a.subject, a.kind, fp);
      if (lapsed.length) {
        const row = store.get("episodes", claimKey(a));
        if (row?.episode_key === a.episode && row.state === "failed") store.db.run("DELETE FROM episodes WHERE id = ?", [row.id as number]);
        await this.resolveRefusalCards(store, a, lapsed);
      }
    }
    if (!f?.ready || startBlock(ctx.store, a)) return true;
    return f.ready(a, x);
  }

  private fingerprintOf(f: Fulfiller, a: Action, x: Exec): string {
    return fingerprint(a.kind, a.subject, f.fingerprint ? f.fingerprint(a, x) : { episode: a.episode, payload: a.payload ?? null });
  }

  // A background kind waits for a later tick while its subject or worktree has an action running, or the slots are taken.
  private bgKeys(a: Action): string[] {
    const wt = (a.payload as { wt?: unknown } | undefined)?.wt ?? a.member;
    // U249: a merge's subject is its PR, and it holds no worktree: two PRs of one Lead merge side by side (an update-branch too).
    return [`${a.project}|${a.subject}`, ...(a.kind !== "merge" && a.kind !== "update-branch" && typeof wt === "string" && wt ? [`${a.project}|wt|${wt}`] : [])];
  }
  private bgFull(a: Action): boolean {
    return BACKGROUND_KINDS.has(a.kind) && (this.bgCount >= (this.opts.bgSlots ?? bgSlots()) || this.bgKeys(a).some((k) => this.bgBusy.has(k)));
  }
  private bgCount = 0;
  private deferred = new Map<string, number>();   // U249: background actions ready() turned down this tick (slots or subject busy), by kind
  takeDeferred(): Map<string, number> { const d = this.deferred; this.deferred = new Map(); return d; }

  // The ms each kind took (inline and background) since the last call, for the tick's report.
  takeTimes(): Map<string, number> { const t = this.times; this.times = new Map(); return t; }
  // `actuator:<kind>` is what the tick waited for; a background action's whole run is `bg:<kind>` (U242).
  private timed(kind: string, t0: number, bg = false): void { const k = `${bg ? "bg" : "actuator"}:${kind}`; this.times.set(k, (this.times.get(k) ?? 0) + performance.now() - t0); }

  async drop(a: Action, ctx: TickCtx, reason: string): Promise<void> {
    const row = ctx.store.get("episodes", claimKey(a));
    if (row?.episode_key !== a.episode || row.state !== "pending") return;
    const f = (await this.fulfillers()).get(a.kind);
    if (f) await this.settle({ ...ctx, act: this }, f, a, { dropped: reason });
  }

  async act(a: Action, ctx: TickCtx): Promise<unknown> {
    const store = ctx.store, x: Exec = { ...ctx, act: this };
    const f = (await this.fulfillers()).get(a.kind);
    if (!f) return this.unhandled(x, a);
    const row = store.get("episodes", claimKey(a));
    a.pauseVersion ??= actionVersion(store, a);
    // The facts as the action found them: a refusal is kept against these, not what its own try changed.
    const fp = this.fingerprintOf(f, a, x);
    let r: Result;
    const t0 = performance.now(), keys = this.bgKeys(a);
    try {
      const block = startBlock(store, a);
      const skip: Result | null = row?.ended_at != null ? { dropped: "episode ended" } : block === "paused" ? { wait: "paused" }
        : block ? { dropped: block } : f.stale?.(a, x) ? { dropped: "stale" } : null;
      if (skip) r = skip;
      else if (BACKGROUND_KINDS.has(a.kind) && this.bgCount < (this.opts.bgSlots ?? bgSlots()) && !keys.some((k) => this.bgBusy.has(k))) {
        // The call starts on the next microtask, so even its synchronous part is not the tick's.
        this.bgCount++; keys.forEach((k) => this.bgBusy.add(k));
        const run = this.activity.run(a, () => Promise.resolve().then(() => f.exec(a, x)).then((res) => ("background" in res ? res.background : res)));
        let timer: ReturnType<typeof setTimeout>;
        const limit = new Promise<Result>((ok) => { const ms = this.opts.bgTimeoutMs ?? bgTimeoutMs(); timer = setTimeout(() => ok({ retry: `timed out after ${ms / 1000}s` }), ms); timer.unref?.(); });
        const free = () => { clearTimeout(timer); this.bgCount--; keys.forEach((k) => this.bgBusy.delete(k)); this.timed(a.kind, t0, true); };
        r = { background: Promise.race([run, limit]).finally(free) };
      } else r = await this.activity.run(a, () => f.exec(a, x));
    } catch (e) { r = { retry: errText(e) }; }
    if (!BACKGROUND_KINDS.has(a.kind) || !("background" in r)) this.timed(a.kind, t0);
    if (!("background" in r)) return this.settle(x, f, a, r, fp);
    store.db.run("UPDATE episodes SET state = 'running', action = COALESCE(action, ?) WHERE project = ? AND subject = ? AND kind = ? AND episode_key = ?",
      [JSON.stringify({ action: a, tries: 0 }), a.project, a.subject, `action:${a.kind}`, a.episode]);
    const p = r.background.catch((e): Result => ({ retry: errText(e) })).then((res) => this.settle(x, f, a, res, fp))
      // A settle that throws (the db is gone) must not be an unhandled rejection; the episode stays `running` and boot puts it back.
      .catch((e) => { try { store.event("plugin_error", { project: a.project, payload: { plugin: f.name, error: errText(e) } }); } catch { /* no db to tell */ } });
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return { background: true };
  }

  // No fulfiller for this kind: its event every time, one Studio alert per kind per project, so a
  // gap can't stay silent. The claim settles as failed, so a restart doesn't put it back. A host
  // action has no project of its own: the alert goes to the first one.
  private async unhandled(x: Exec, a: Action): Promise<void> {
    const { store, now: at } = x, key = claimKey(a), project = a.project || discoverProjects(store.root)[0];
    store.event("action_unhandled", { project: a.project, squad: a.squad, member: a.member, payload: a });
    store.db.run("UPDATE episodes SET state = 'failed', ended_at = ?, next_at = NULL, action = NULL, observed_at = ? WHERE project = ? AND subject = ? AND kind = ? AND episode_key = ?",
      [at, at, a.project, a.subject, key.kind, a.episode]);
    const once = { project: project ?? "", subject: a.kind, kind: "unhandled" };
    if (!project || store.get("episodes", once)) return;
    const o = await alert(store, project, `unhandled.${a.kind}`, a.kind, `The loop has no fulfiller for action kind ${a.kind} (${a.subject}), so nothing is doing it.`, { title: "Loop action not handled" });
    if (o.code === 0) store.upsert("episodes", once, { state: "alerted", source: "loop", observed_at: at });
    else store.event("plugin_error", { project, payload: { plugin: "actuator", error: errOf(o, "alerts.sh") } });
  }

  // Every background start finished (tests, and a clean shutdown).
  async drain(): Promise<void> { while (this.inflight.size) await Promise.all([...this.inflight]); }

  private async settle(x: Exec, f: Fulfiller, a: Action, r: Result, fp?: string): Promise<Result> {
    const { store, now: at } = x, key = claimKey(a);
    // A refusal after an await during pause is a deferred action, never a spent delivery retry.
    if (!("done" in r) && actionBlock(store, a) === "paused") r = { wait: "paused" };
    const row = store.get("episodes", key);
    if (row?.episode_key !== a.episode) return r;   // a newer episode took the row meanwhile
    const saved = row.action ? JSON.parse(String(row.action)) : { action: a, tries: 0 };
    const tries = Number(saved.tries ?? 0), launches = Number(saved.launches ?? 0);
    // Capacity owns no action or clock. An existing delivery retry retains its serialized
    // identity and count; a retrying lifecycle wish depends on that ordinary pending action.
    if ("idle" in r) {
      if (tries > 0) {
        delete saved.started; // A child that returned WAIT finished; it was not interrupted.
        store.db.run("UPDATE episodes SET state = 'pending', next_at = NULL, action = ?, observed_at = ? WHERE id = ?", [JSON.stringify(saved), at, row.id as number]);
      } else store.db.run("DELETE FROM episodes WHERE project = ? AND subject = ? AND kind = ? AND episode_key = ?", [a.project, a.subject, key.kind, a.episode]);
      retireCapacityFacts(store);
      return r;
    }
    const holder = "wait" in r ? HOLDER.exec(r.wait)?.[1] : undefined;
    // A retry is classified once (refusals.ts): a wait is not counted, a known cause is fixed and
    // tried once more, a launch failure is tried again soon (LAUNCH_TRIES times, uncounted), a transient one is tried again every retryGap per subject until it counts as
    // permanent, and a permanent one is given up with its refusal row, so ready() claims it no more.
    const cls = "retry" in r ? classify(r.retry) : null, cause = "retry" in r ? causeOf(r.retry)?.cause : undefined;
    const refusal = (c: "transient" | "permanent") => refuse(store, { project: a.project, squad: a.squad, member: a.member, subject: a.subject, kind: a.kind,
      fingerprint: fp ?? this.fingerprintOf(f, a, x), text: (r as { retry: string }).retry, at }, c, sendTries()).row;
    let set: Row | null = null, kind = "action_failed", why: string | null = null, refused: Row | null = null;
    const pending = (next: number, more: Row = {}) => {
      set = { state: "pending", next_at: next, action: JSON.stringify({ action: a, tries, ...(saved.fixed ? { fixed: saved.fixed } : {}), ...(saved.launches ? { launches: saved.launches } : {}), ...more }) };
      kind = "action_pending";
    };
    if ("done" in r) { set = { state: "done", ended_at: at, next_at: null, action: null, result: r.result == null ? null : typeof r.result === "string" ? r.result : JSON.stringify(r.result) }; kind = "action_done"; }
    else if ("dropped" in r) { set = { state: "dropped", ended_at: at, next_at: null, action: null, result: r.dropped }; kind = "action_dropped"; }
    // A pending action is acted again from the next tick at the soonest, never twice in this one.
    else if ("wait" in r) pending(holder ? at + HELD_GAP : Math.max(r.at ?? 0, at + 1), { wait: r.wait });
    // A step the loop's own shutdown killed (checked now, when the result is recorded) is no failure: the next loop process runs it
    // on its first tick, uncounted and with no refusal row.
    else if ("retry" in r && loopStopping()) pending(at + 1);
    else if (cls === "wait") pending(at + REFUSED_WAIT);
    // seat().call binds a fresh sender on these causes itself; the action gets one more try, uncounted.
    else if (cls === "fixable" && saved.fixed !== cause) pending(at + 1, { fixed: cause });
    // U270: a Claude launch that failed is tried again within about a minute, apart from the others, uncounted.
    else if (cls === "launch" && launches < LAUNCH_TRIES) pending(launchRetryAt(a.subject, launches + 1, at), { launches: launches + 1 });
    else if (cls === "fixable" || cls === "launch" || cls === "transient") {
      refused = refusal("transient");
      if (refused.class === "transient") pending(Number(refused.next_at), { tries: tries + 1 });
    } else if (cls === "permanent") refused = refusal("permanent");
    if (!set) { why = "retry" in r ? r.retry : "failed" in r ? r.failed : "?"; set = { state: "failed", ended_at: at, next_at: null, action: null }; kind = "action_failed"; }
    store.tx(() => {
      store.db.run(`UPDATE episodes SET ${Object.keys(set).map((k) => `${k} = ?`).join(", ")}, observed_at = ? WHERE project = ? AND subject = ? AND kind = ? AND episode_key = ?`,
        [...Object.values(set) as (string | number | null)[], at, a.project, a.subject, key.kind, a.episode]);
      // One event per wait: the same wait text again (same subject, kind and episode) only updates the row.
      const repeat = "wait" in r && saved.wait === r.wait;
      // The tick skipped the `action` event for a try that followed a wait; a try that ends on anything else writes it now.
      if (typeof saved.wait === "string" && !repeat) store.event("action", { project: a.project, squad: a.squad ?? null, member: a.member ?? null, payload: a });
      if (!repeat) store.event(kind, { project: a.project, squad: a.squad, member: a.member, payload: { kind: a.kind, subject: a.subject, episode: a.episode, ...r } });
    });
    if (holder) {
      await this.stuck(x, a, STUCK_AFTER, "Start stuck", (who, min) => `The ${who} has waited ${min} minutes to start: pid ${holder} holds the lock on its name. The loop tries again every ${HELD_GAP / 60} minutes under the same retry id and leaves that process alone. If it is hung, end it and the start finishes.`);
    } else if ("wait" in r && r.blocked) {
      const blocked = r.blocked;
      await this.stuck(x, a, BLOCKED_AFTER, "Start blocked", (who, min) => `The ${who} has waited ${min} minutes to start: ${blocked}`);
    } else if (set.ended_at != null) await this.unstuck(x, a);
    let ownCard: unknown = false;
    if (why !== null) {
      try { ownCard = await f.giveUp?.(a, x, why); } catch (e) { store.event("plugin_error", { project: a.project, payload: { plugin: f.name, error: errText(e) } }); }
    }
    if (refused?.class === "permanent" && refused.carded_at == null) {
      if (ownCard) carded(store, refused, at);
      else await this.refusalCard(x, a, refused);
    }
    if ("done" in r) await this.resolveRefusalCards(store, a, clear(store, a.project, a.subject, a.kind));
    return r;
  }

  private told = new Set<string>();

  private async resolveRefusalCards(store: Store, a: Action, rows: Row[]): Promise<void> {
    for (const c of rows) {
      if (c.carded_at == null) continue;
      const o = await resolveAlert(store, a.project, `refusal.${a.subject}`, String(c.fingerprint));
      if (o.code !== 0) store.event("plugin_error", { project: a.project, payload: { plugin: "actuator", error: errOf(o, "alerts.sh") } });
    }
  }

  // The one card of a refusal that stands until its facts change (a card alerts.sh could not write
  // is a plugin_error; the row keeps carded_at empty and ready() writes it later). Its fields let
  // reconcilers/alerts.ts keep it while the row stands.
  private async refusalCard(x: Exec, a: Action, r: Row): Promise<void> {
    const n = Number(r.count), req = /^req:/.test(a.subject) && !!a.squad;
    // U9: a refused one-off request of a squad goes to that squad's Lead, once (the card is written once).
    const told = req ? await this.tellLead(x, a, r) : false;
    const tail = /^req:/.test(a.subject) ? (told ? " The squad's Lead was told." : "") : " It tries again once what it depends on changes.";
    const o = await alert(x.store, a.project, `refusal.${a.subject}`, String(r.fingerprint),
      `The loop stopped trying ${a.kind} for ${a.subject}${n > 1 ? ` after ${n} tries` : ""}: ${String(r.text).slice(0, 400)}.${tail}`,
      { title: "Loop action refused", fields: { kind: REFUSAL_KIND, subject: a.subject, fingerprint: String(r.fingerprint), ...(a.squad ? { squad: a.squad } : {}) } });
    if (o.code === 0) carded(x.store, r, x.now);
    else x.store.event("plugin_error", { project: a.project, payload: { plugin: "actuator", error: errOf(o, "alerts.sh") } });
  }

  // One line typed into the squad's Lead terminal (only a live terminal the observer knows in the Lead's
  // worktree, never a shell), the way U75 tells a message's sender. False when it has none: the card stands alone.
  private async tellLead(x: Exec, a: Action, r: Row): Promise<boolean> {
    const { store } = x, key = `${a.subject}:tell-lead`;
    if (this.told.has(`${a.project}|${key}|${r.fingerprint}`)) return true;
    const lead = store.db.query("SELECT wt FROM members WHERE project = ? AND squad = ? AND role = 'lead' AND COALESCE(status, '') NOT IN ('gone', 'closed') ORDER BY id DESC").get(a.project, a.squad ?? null) as { wt: string | null } | null;
    const t = lead?.wt ? store.db.query("SELECT handle FROM observed_terminals WHERE project = ? AND wt = ? AND gone_at IS NULL ORDER BY observed_at DESC").get(a.project, lead.wt) as { handle: string } | null : null;
    if (!t) return false;
    const text = `dev-studio loop: your ${a.kind} request (${a.subject}) was refused and will not be tried again: ${String(r.text).replace(/\s+/g, " ").trim().slice(0, 300)}. Fix it and ask again.`;
    try {
      const ok = (await this.seat(store, a.project, a.squad ?? null, key, null, x.now).send("poke-terminal", [t.handle, text])).code === 0;
      if (ok) this.told.add(`${a.project}|${key}|${r.fingerprint}`);
      return ok;
    } catch { return false; }
  }

  // Another wait behind a live lock holder, or blocked: the first starts the episode, and one past
  // `after` raises its alert. An alert that could not be written is tried again at the next wait.
  private async stuck(x: Exec, a: Action, after: number, title: string, text: (who: string, minutes: number) => string): Promise<void> {
    const { store, now: at } = x, key = stuckKey(a), row = store.get("episodes", key);
    if (!row || row.ended_at != null) {
      store.upsert("episodes", key, { squad: a.squad ?? null, started_at: at, ended_at: null, state: "waiting", source: "loop", observed_at: at });
      return;
    }
    const waited = at - Number(row.started_at);
    if (row.state === "alerted" || waited < after) return;
    const id = (a.payload as { id?: number } | null)?.id, m = id != null ? memberOf(store, { id }) : null;
    const who = m ? `${m.role}${m.suffix ? ` ${m.suffix}` : ""} of ${m.squad}` : a.subject;
    const o = await alert(store, a.project, key.kind + "." + a.subject, a.subject, text(who, Math.floor(waited / 60)), { title });
    if (o.code === 0) store.upsert("episodes", key, { state: "alerted", observed_at: at });
    else store.event("plugin_error", { project: a.project, payload: { plugin: "actuator", error: errOf(o, "alerts.sh") } });
  }

  // The start settled for good (done, failed or dropped): the episode ends with its alert. A retry
// doesn't end it: the holder may still be there, and a blip must not raise a second alert.
  private async unstuck(x: Exec, a: Action): Promise<void> {
    const { store, now: at } = x, key = stuckKey(a), row = store.get("episodes", key);
    if (!row || row.ended_at != null) return;
    if (row.state === "alerted") {
      const o = await resolveAlert(store, a.project, key.kind + "." + a.subject, a.subject);
      if (o.code !== 0) store.event("plugin_error", { project: a.project, payload: { plugin: "actuator", error: errOf(o, "alerts.sh") } });
    }
    store.upsert("episodes", key, { state: "closed", ended_at: at, observed_at: at });
  }

  // One start slot, or null when all are taken; call the returned function to give it back.
  slot(): (() => void) | null {
    if (this.slots >= (this.opts.slots ?? startSlots())) return null;
    this.slots++;
    let freed = false;
    return () => { if (!freed) { freed = true; this.slots--; } };
  }

  // An Orca mutation under `key` (one effect, e.g. one start of one wish): write-ahead, then call.
  // A call request-show settled as completed has no output (result NULL): it is replayed under the
  // same id from the same sender to get it; from another sender only the fact it started is known.
  // U4 (orca-backend-alternatives): with `ident` (a DS_MEMBER) a Claude start or resume carries it and its
  // generation, the call's retry id, to the adapter (startIdentity), which puts them on the terminal's launch line; `gen` hears the
  // generation the call ran (or, settled before, ran) under. The same id on a replay keeps the same generation.
  async call(store: Store, op: string, args: string[], o: { key: string; project: string; squad: string | null; member: string | null; sender: string; at: number;
    ident?: string | null; gen?: (gen: string) => void }): Promise<Out> {
    const target = { project: o.project, squad: o.squad, member: o.member }, block = this.block(store, target);
    if (block) return { code: 75, out: "", err: `activity: ${block}` };
    // U200: a row under this key is this call's only when it is for the same project and member: an
    // episode key shared by several members must never hand one the result of another's call.
    let last = store.db.query("SELECT * FROM orca_calls WHERE key = ? AND (project IS NULL OR project = ?) AND (? IS NULL OR member IS NULL OR member = ?) ORDER BY id DESC LIMIT 1").get(o.key, o.project, o.member, o.member) as Row | null;
    if (last?.state === "pending") last = await this.ask(store, last, o.at);
    if (last?.state === "pending") return { code: 75, out: "", err: `orca: request ${last.retry_id} still pending` };
    if (last?.state === "completed" && (last.result != null || last.sender !== o.sender)) {
      if (identified(o.ident, String(last.op), last.payload ? JSON.parse(String(last.payload)) as string[] : args)) o.gen?.(String(last.retry_id));
      return { code: 0, out: String(last.result ?? ""), err: "" };
    }
    const afterLookup = this.block(store, target);
    if (afterLookup) return { code: 75, out: "", err: `activity: ${afterLookup}` };
    const replay = last != null && (last.settled_at == null || last.state === "completed") && last.sender === o.sender;
    const retry = replay ? String(last!.retry_id) : crypto.randomUUID();
    if (replay) store.db.run("UPDATE orca_calls SET state = 'sent', settled_at = NULL, at = ? WHERE id = ?", [o.at, last!.id as number]);
    else store.db.run("INSERT INTO orca_calls (retry_id, key, op, project, squad, member, sender, payload, at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')",
      [retry, o.key, op, o.project, o.squad, o.member, o.sender, JSON.stringify(args), o.at]);
    // Orca holds an id to its first input, and a replay's pick or prompt may read differently now.
    const sent = replay && last!.op === op && last!.payload ? JSON.parse(String(last!.payload)) as string[] : args;
    // U270: a failed Claude launch's screen becomes a start_failed event; the answer keeps a pointer to it.
    const ident = identified(o.ident, op, sent);
    const env = { ...this.callEnv(store, target), ...(ident ? startIdentity(ident, retry) : {}) };
    const out = keepStartFailed(store, await this.orca.run(op, sent, { from: o.sender, retry, env }), target);
    if (out.code === 0) {
      store.db.run("UPDATE orca_calls SET state = 'completed', result = ?, settled_at = ? WHERE retry_id = ?", [out.out, o.at, retry]);
      if (ident) o.gen?.(retry);
    } else {
      // A non-zero exit may still have landed (a timeout, a killed backend): ask before a retry gets a new id.
      store.db.run("UPDATE orca_calls SET result = ? WHERE retry_id = ?", [errOf(out, op), retry]);
      if (!inDoubt(out)) await this.ask(store, store.db.query("SELECT * FROM orca_calls WHERE retry_id = ?").get(retry) as Row, o.at, errOf(out, op));
    }
    return out;
  }

  // The op and args of the call under `key` a replay would repeat, if there is one.
  openCall(store: Store, key: string): { op: string; args: string[] } | null {
    const last = store.db.query("SELECT op, payload, state FROM orca_calls WHERE key = ? ORDER BY id DESC LIMIT 1").get(key) as Row | null;
    return last?.payload && last.state !== "failed" ? { op: String(last.op), args: JSON.parse(String(last.payload)) as string[] } : null;
  }

  // What a driver acts through for one action: its squad, its sender terminal (made on the first
  // mutating call), and `key` for the write-ahead row. `ident` is the member's DS_MEMBER for a start
  // (fulfil/member.ts): a Claude start then carries its identity, and `gen()` is its generation.
  seat(store: Store, project: string, squad: string | null, key: string, member: string | null, at: number, ident: string | null = null): Seat {
    let gen: string | null = null;
    const row = squad ? store.db.query("SELECT project, topic, run_id, repo, lead_wt FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Squad | null : null;
    const studio_wt = (store.get("projects", { label: project })?.studio_wt as string | null | undefined) ?? null;
    return {
      squad: { ...(row ?? { project, topic: squad ?? "", run_id: null, repo: null, lead_wt: null }), studio_wt },
      call: async (op, args) => {
        const block = this.block(store, { project, squad, member });
        if (block) return { code: 75, out: "", err: `activity: ${block}` };
        const via = (from: string) => this.call(store, op, args, { key, project, squad, member, sender: from, at, ident, gen: (g) => { gen = g; } });
        const out = await via(await this.sender(store, project, squad ?? "", at));
        if (out.code === 0 || !/consumer_fenced|not bound to Run|run_not_bound|terminal_not_found|stable_pane_required/.test(out.err + out.out)) return out;
        if (squad) this.seatFailed.add(`${project}/${squad}`); // U244: seats() asks Orca who holds the Run next tick
        // The sender lost its Run (a restarted Orca, a closed tab): find or make it again, once.
        return via(await this.sender(store, project, squad ?? "", at, true));
      },
      send: (op, args, extra) => {
        // A handle can have rows under two projects (a worktree another project once claimed): the
        // action's own project's row first, else a live row.
        const target = op === "poke-terminal" ? store.db.query("SELECT project, wt FROM observed_terminals WHERE handle = ? ORDER BY (project = ?) DESC, (gone_at IS NULL) DESC, observed_at DESC")
          .get(args[0], project) as Row | null : null;
        const physical = target ? { project: String(target.project), member: String(target.wt) }
          : ["poke", "keys", "ping"].includes(op) ? { project, member: args[0] } : { project, squad, member };
        const block = this.block(store, physical);
        if (block) return Promise.resolve({ code: 75, out: "", err: `activity: ${block}` });
        // U270: a Studio move's studio-start is a Claude launch too: keep a failed one's screen as call() does.
        const who = { project: physical.project, squad: "squad" in physical ? physical.squad ?? null : null, member: physical.member ?? null };
        return this.orca.run(op, args, { env: { ...this.callEnv(store, physical), ...extra } }).then((o) => keepStartFailed(store, o, who));
      },
      window: (role) => compactWindow(store, project, role),
      gen: () => gen,
    };
  }

  private block(store: Store, target: { project: string; squad?: string | null; member?: string | null }): string | null {
    const a = this.activity.getStore();
    if (a && actionStartSent(store, a)) return null;
    if (a?.kind === "pause-control" || (a && resumeAction(store, a))) return actionBlock(store, a);
    return (a && actionBlock(store, a)) || (paused(store, target) ? "paused" : null);
  }

  // Child scripts carry the same generation to the backend, which checks it before each mutation.
  childActivity(store: Store, a: Action): Record<string, string> {
    return { DS_STATE_ROOT: store.root, DS_LOOP_ACTIVITY: JSON.stringify({ targets: actionTargets(store, a), version: a.pauseVersion ?? actionVersion(store, a), mail: deferredMail(a),
      ...(a.kind === "pause-control" ? { control: a } : {}), ...(resumeAction(store, a) ? { resume: a } : {}) }) };
  }

  private callEnv(store: Store, target: { project: string; squad?: string | null; member?: string | null }): Record<string, string> {
    const a = this.activity.getStore();
    if (a) return this.childActivity(store, a);
    const targets = [target];
    return { DS_STATE_ROOT: store.root, DS_LOOP_ACTIVITY: JSON.stringify({ targets, version: JSON.stringify(targets.map((t) => version(store, t))) }) };
  }

  // One lookup per squad at a time, so concurrent starts share one sender terminal.
  private sender(store: Store, project: string, squad: string, at: number, fresh = false): Promise<string> {
    const k = `${project}/${squad}`;
    const p = (this.senders.get(k) ?? Promise.resolve("")).catch(() => "").then(() => sender(store, this.orca, project, squad, at, fresh));
    this.senders.set(k, p);
    return p;
  }

  // The terminal to restart a member from: its squad's sender, or for the Lead (whose worktree that
  // sender lives in) the project's pane outside it. Throws when there is none yet.
  // fresh: the sender was fenced (the Lead adopted the Run again): bind it again first.
  // avoid: a handle that just failed (U93): a find that returns it counts as missing.
  restartFrom(store: Store, project: string, squad: string, wt: string, at: number, fresh = false, avoid = ""): Promise<string> {
    return isLead(store, project, wt) ? this.outside(store, project, at, fresh, avoid) : this.sender(store, project, squad, at, fresh);
  }

  outside(store: Store, project: string, at: number, fresh = false, avoid = ""): Promise<string> {
    return outside(store, this.orca, project, at, fresh, avoid);
  }

  // The squad's sender pane: a plain terminal with no dispatch, so Orca lets it send into any Run (U64).
  senderOf(store: Store, project: string, squad: string, at: number): Promise<string> { return this.sender(store, project, squad, at); }

  // A replay that adopts the Run from outside() (a Lead's restart-role, resume-squad) holds the
  // squad while it runs: seats() leaves its seat alone, or the restart's own start would be fenced.
  hold(project: string, squad: string): () => void {
    const k = `${project}/${squad}`;
    this.moving.set(k, (this.moving.get(k) ?? 0) + 1);
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      const n = (this.moving.get(k) ?? 1) - 1;
      if (n > 0) this.moving.set(k, n); else this.moving.delete(k);
    };
  }

  // A squad whose Run's seat a running replay moved to outside(): its other starts don't take it back.
  held(project: string, squad: string): boolean { return this.moving.has(`${project}/${squad}`); }

  // Each tick, before any start (U59): every Run the loop coordinates is held by its own pane. A
  // Lead's stopgap adopt, a stored handle that no longer exists or a closed pane moved the seat:
  // the loop binds its pane again now, with one coordinator_rebound event, and no start fails on it
  // first. A Run no one holds is bound too; a run-show that fails is no reason to rebind. A rebind
  // that fails is tried again next tick (its error logged once), and a start meanwhile waits on it.
  // Orca's holder is the evidence, not gone(): the terminal observer records only worker terminals,
  // never the loop's plain ds-loop shell, so gone() would rebind every Run each tick. A closed pane
  // Orca still names is caught by the start it fails (a known cause: a fresh pane, then a wait).
  // The asker's terminal holds a new squad's Run only until the Lead has a worktree: then the loop
  // opens the squad's own pane in it and rebinds (U210). A seat that is ours then relays the Run's
  // mail to the Lead (U61, relay.ts).
  async seats(ctx: TickCtx): Promise<void> {
    const { store, project, now: at } = ctx;
    const rows = store.db.query(`SELECT c.squad, c.handle, c.pane_key, c.run_id AS bound, c.bound_at, s.run_id, s.lead_wt FROM coordinators c
      JOIN squads s ON s.project = c.project AND s.topic = c.squad
      WHERE c.project = ? AND c.squad != '' AND COALESCE(s.run_id, '') != '' AND COALESCE(s.status, '') NOT IN ('suspended', 'closed', 'gone')`).all(project) as Row[];
    await Promise.all(rows.map(async (r) => {
      const squad = String(r.squad), run = String(r.run_id), k = `${project}/${squad}`;
      if (this.moving.has(k)) return;
      // A seat with no pane_key is the asker's terminal that created the squad, not a pane of ours: once
      // the Lead has a worktree the loop takes the seat over (U210). Before that it is left alone.
      const borrowed = !r.pane_key && !!r.lead_wt;
      // U244: Orca is asked who holds the Run only when that can have changed: the seat changed here, its
      // handle is not in this tick's terminal list, a start or send on it failed, or DS_LOOP_SEAT_CHECK_S
      // (60 s) passed. Otherwise the stored holder stands.
      const sig = `${r.handle}|${r.bound}|${r.pane_key}`, prev = this.seatSeen.get(k), live = ctx.facts?.terminalHandles ?? null;
      const check = borrowed || !prev || prev.sig !== sig || this.seatFailed.delete(k) || (live !== null && !live.has(String(r.handle)))
        || spreadDue(`seat:${k}`, prev.at, at, knobS("DS_LOOP_SEAT_CHECK_S", 60));
      let holder = String(r.handle), handle = String(r.handle);
      if (check) {
        const o = await this.orca.run("run-coordinator", [run]);
        if (o.code !== 0) return;
        holder = o.out.trim();
        this.seatSeen.set(k, { sig, at });
      }
      if (holder !== handle || r.bound !== run || borrowed) {
        this.seatSeen.delete(k);
        if (paused(store, { project, squad })) return;
        try {
          handle = await this.sender(store, project, squad, at, true);
          this.unseated.delete(k);
          store.event("coordinator_rebound", { project, squad, payload: { run, was: (borrowed ? String(r.handle) : holder) || null, handle } });
        } catch (e) {
          this.once(this.unseated, k, store, project, squad, `seat of ${run}: ${errText(e)}`);
          return;
        }
      }
      // U244: the Run's inbox is peeked when this tick's unread read shows mail for its coordinator or a stored
      // message is due. U252: worker mail and misdelivered rows no longer open it. U264: the unread read is the
      // signal, so a Run with neither is not peeked: not on the loop's first sight of it, and not again after a
      // failed pass (its mail is still unread, its due row still due). Only with no unread read is every Run peeked,
      // plus a safety read every DS_LOOP_RELAY_CHECK_S (900 s, spread per squad) for mail the read does not show.
      const unread = ctx.facts?.unreadRuns ?? null, lastPeek = this.relayPeekAt.get(k) ?? at;
      const gate = unread === null ? "nofacts" : unread.has(run) ? "unread" : relayWork(store, { project, squad, at }) ? "due"
        : spreadDue(`relay:${k}`, lastPeek, at, knobS("DS_LOOP_RELAY_CHECK_S", 900)) ? "safety" : "";
      this.relayPeekAt.set(k, gate ? at : lastPeek);
      if (gate) countLine(process.env, `peek ${gate}`);
      const why = await relay(this, store, { project, squad, run, handle, lead: (r.lead_wt as string | null) ?? null, at, peek: !!gate })
        .catch((e) => `relay of ${run}: ${errText(e)}`);
      if (why) this.once(this.unrelayed, k, store, project, squad, why);
      else this.unrelayed.delete(k);
    }));
  }

  // A plugin_error for a squad's failing step, once per distinct error until it clears.
  private once(seen: Map<string, string>, k: string, store: Store, project: string, squad: string, error: string): void {
    if (seen.get(k) === error) return;
    seen.set(k, error);
    store.event("plugin_error", { project, squad, payload: { plugin: "actuator", error } });
  }

  driver(seat: Seat, agent: string | null): Driver { return driverModule(agent).make(seat); }
}

// A seconds knob that may be 0 (always); unset or not a number: the default.
function knobS(name: string, dflt: number): number {
  const raw = process.env[name], v = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}

export function isLead(store: Store, project: string, wt: string): boolean {
  const m = store.db.query("SELECT role FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(project, wt) as { role: string | null } | null;
  return m?.role === "lead";
}

// The member row of a worktree, or of a members.id, as a driver sees it.
export function memberOf(store: Store, ref: { wt?: string | null; id?: number | null }): Member | null {
  const r = (ref.id != null
    ? store.db.query("SELECT * FROM members WHERE id = ?").get(ref.id)
    : store.db.query("SELECT * FROM members WHERE wt = ? ORDER BY id DESC").get(ref.wt ?? "")) as Row | null;
  if (!r) return null;
  const s = (k: string) => (r[k] == null ? null : String(r[k]));
  return { id: Number(r.id), project: String(r.project), squad: String(r.squad), wt: s("wt"), role: String(r.role), suffix: String(r.suffix ?? ""),
    agent: s("agent"), model: s("model"), effort: s("effort"), account: s("account"), phase: s("phase"), limited_until: r.limited_until == null ? null : Number(r.limited_until) };
}

// memberOf by worktree, else a bare member of the action's squad (a Lead or Thinker poked by wt).
export function memberAt(store: Store, a: Action, wt: string): Member {
  return memberOf(store, { wt }) ?? { id: 0, project: a.project, squad: a.squad ?? "", wt, role: "", suffix: "", agent: null, model: null, effort: null, account: null };
}

// A Studio alert (bin/lib/alerts.sh), id `loop-<subject>-<hash of the episode>` so the same episode
// replaces its own alert.
// Every alert the loop files for one subject starts with alertPrefix(subject).
export const alertPrefix = (subject: string) => `loop-${subject.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(-60)}-`;
export const alertId = (subject: string, episode: string) => `${alertPrefix(subject)}${Bun.hash(episode).toString(36)}`;

// A reconciler's own `sweep-<key>-<n>` id is the stored id, so the checks that look for it (cardPlace, alertGone,
// the prefix clears) find the card; any other id keeps `loop-<subject>-<hash>`.
export const cardId = (subject: string, episode: string, id?: unknown) => typeof id === "string" && id.startsWith("sweep-") ? id : alertId(subject, episode);

// opts.fields lands on the card beside its text, for a reconciler to read (alerts.sh add's extra JSON).
export async function alert(store: Store, project: string, subject: string, episode: string, text: string,
  opts: { id?: string; title?: string; option?: string; why?: string; fields?: Record<string, unknown>; who?: Whose } = {}): Promise<Out> {
  // U232: the one place a card's title is built: `<squad> · <unit or role>: <title>`.
  const title = opts.who ? cardTitle(store, project, opts.who, opts.title ?? "") : opts.title ?? "";
  return spawn([join(ROOT, "bin", "lib", "alerts.sh"), join(store.root, project, "alerts.json"), "add", cardId(subject, episode, opts.id), title, text, opts.option ?? "", opts.why ?? "",
    ...(opts.fields ? [JSON.stringify(opts.fields)] : [])], {}, 30_000);
}

export async function resolveAlert(store: Store, project: string, subject: string, episode: string): Promise<Out> {
  return spawn([join(ROOT, "bin", "lib", "alerts.sh"), join(store.root, project, "alerts.json"), "resolve", alertId(subject, episode)], {}, 30_000);
}

// Open `requests` rows of these kinds as actions, one episode per row (fulfil/poke, keys, answer).
export function requestActions(ctx: TickCtx, kinds: string[]): Action[] {
  const rows = ctx.store.db.query(`SELECT * FROM requests WHERE done_at IS NULL AND kind IN (${kinds.map(() => "?").join(", ")}) ORDER BY id`).all(...kinds) as Row[];
  return rows.map((r) => ({
    project: String(r.project ?? ""), squad: (r.squad as string | null) ?? null, member: (r.member as string | null) ?? null,
    subject: `req:${r.id}`, kind: String(r.kind), episode: `req:${r.id}`,
    payload: { ...(r.payload ? JSON.parse(String(r.payload)) : {}), request: Number(r.id) },
  }));
}

// A request's row done, with what came of it (`ds nudge --wait` returns on done_at).
export function finishRequest(store: Store, a: Action, result: unknown, at: number): void {
  const id = (a.payload as { request?: number } | undefined)?.request;
  if (id == null) return;
  // A finished request keeps no secret shape in its payload (an open one keeps its text for the fulfiller); a clean payload is left as written.
  const old = (store.get("requests", { id }) as { payload?: string | null } | undefined)?.payload ?? null;
  const set: Record<string, unknown> = { done_at: at, result: JSON.stringify(result) };
  if (old != null && redact(old) !== old) set.payload = redactPayload(old);
  store.fact("request_done", [{ table: "requests", key: { id }, set }],
    { project: a.project || null, squad: a.squad, member: a.member, payload: { id, kind: a.kind, result } });
}

// A failed request is done too, with the reason, so nobody waits on it forever. Its requester (the
// board, a script) is told by that, so no refusal card beside it (giveUp's truthy return).
export const failRequest = (a: Action, x: Exec, why: string): true => { finishRequest(x.store, a, { ok: false, error: why }, x.now); return true; };

export const actuator = new LoopActuator();

// The DS_MEMBER a call carries: only a Claude start or resume, whose terminal the adapter opens and so
// can give an environment (claudeTab, resumeTab). A start Orca types itself (Codex, Muse) has none.
function identified(ident: string | null | undefined, op: string, args: string[]): string | null {
  return ident && startedOn(op, args)?.agent === "claude" ? ident : null;
}
