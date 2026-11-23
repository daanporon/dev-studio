// fulfil/member.ts — kind `member`: the decider's start (decide.ts, U152) of a member wished running
// with no agent, the decider's stop (switches.ts, U154: limit, fallback, phase, pin) of a live one
// (U200: its calls are keyed `stop:<member id>:<episode>:<op>`, so each member runs its own, and it is
// done only once the worker reads gone, else it waits a tick),
// or the switch a live one is owed by an unacted model wish (pinsOther). A pre-U159 wish still
// carrying a script replay is a plain wish too: no script runs it anymore (U159). A wish not yet
// acted on (want_result empty) may say why (start|phase|model|limit,
// default start), carry a prompt, and fix agent, model, effort or account; a standing wish restarting
// its member is a plain start. The rest is the pick (U9's ladder, actuator.ts ladderPick). Then
// handoff() (§5b) says how: tell (poke) or fresh (the driver's start). A start or resume holds one of
// the actuator's start slots while it runs in the background; no free slot leaves the action pending;
// no account leaves it idle, and so does a Builder over the project's max_builders (the pick's WAIT
// slot, U145): no orca call. Started, the member row says running with what it runs on, placed_at
// moves (a new start key), and the brief is a delivery the next tick verifies (fulfil/poke.ts). A
// role request (U12, payload `request`) starts on add-role.sh's prompt and keeps its unit's row:
// dispatched to the new worktree once started. A pause resume starts on its resume prompt and sets
// the member's pause row back to active. A wish a lifecycle script wrote (it carries the script's
import { alert, memberOf, resolveAlert, type Exec, type Fulfiller, type Pick, type Result } from "../core/actuator.ts";
import { handoff, type Why } from "../squad/handoff.ts";
import { DUPLICATE_CARD_AFTER } from "../reconcilers/members.ts";
import { rolePrompt } from "../reconcilers/requests.ts";
import { startedOn, type Member } from "../drivers/types.ts";
import { onContract, stopOp } from "../squad/backend.ts";
import type { Action } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { deliver } from "./poke.ts";
import { actionBlock, ensureTransition, memberKey, startBlock, type Target } from "../pause/pause.ts";
import { lastStart, lock, startEpisode, stopCallKey, view, walkedGone } from "../squad/member-state.ts";
import { queuedWhy, withdraw } from "../squad/queued-builder.ts";
import { limitStuck, switchFacts, SWITCH_WHYS } from "../capacity/switches.ts";
import { limitNum, RESERVE, reservationOf, sameModel } from "../capacity/pick.ts";
import { phasePrompt, resumePrompt, revalidateNote } from "../reconcilers/pause-resume.ts";
import { memberLabel } from "../core/whoami.ts";

type Wish = { why?: Why; prompt?: string; agent?: string; model?: string; effort?: string; account?: string; ctx?: number; request?: boolean; unit?: string; spec?: string; pauseResume?: string };
const placements = new WeakMap<Action, Pick>();

// The wish's payload holds while it is not yet acted on; a standing wish starting again is a plain start.
function payloadOf(r: Row): Wish { try { return r.want_payload && r.want_result == null ? JSON.parse(String(r.want_payload)) : {}; } catch { return {}; } }

// Is this action still the member's start (or owed switch)? Its wish reads running, and the
// episode is its current start key. A pre-U159 wish still carrying a script replay counts as a
// plain wish (U159): its payload's extra keys are ignored.
// `sent`: this start's call already went out; it finishes whatever the view reads now (U118: the
// pause winds the agent down after).
function current(store: Store, a: Action, sent = false): Row | null {
  const r = store.get("members", { id: (a.payload as { id: number }).id });
  // A wish withdrawn to stopped or archived (U155) drops even a sent start: the close acts on it instead.
  if (!r || view(store, r) === "stopped" || view(store, r) === "archived" || view(store, r) === "suspended") return null;
  if (!sent && view(store, r) !== "running") return null;
  return a.episode === startEpisode(store, r) || (a.episode === `switch:${r.want_at}` && r.want_result == null) ? r : null;
}

const startKey = (a: Action) => `start:${(a.payload as { id: number }).id}:${a.episode}`;
// U200: a stop's calls are keyed by the member too: an episode (one limit notice, one squad restart)
// is shared by many members, and a call row under a key another member ran must never answer this one.
const stopKey = (a: Action, op: string) => stopCallKey((a.payload as { id: number }).id, a.episode, op);
// What this start's call asked for, once it went out under its retry id.
function sentStart(x: Exec, a: Action) {
  const open = x.act.openCall(x.store, startKey(a));
  return open ? startedOn(open.op, open.args) : null;
}

const resuming = (store: Store, r: Row) => store.get("pause_members", memberKey(r as Target))?.state === "resuming";

// A requested member's squad-doc entry, written once it has a worktree (a wt-less one would not
// round-trip): its role and suffix, and the unit it owns.
function requestDoc(row: Row, w: Wish): string {
  const doc = row.doc ? JSON.parse(String(row.doc)) : {};
  return JSON.stringify({ ...doc, role: row.role, suffix: row.suffix, owns: w.unit ? [w.unit] : doc.owns ?? [] });
}

function ctxOf(store: Store, m: Member, w: Wish): number | null {
  if (w.ctx != null) return Number(w.ctx);
  if (!m.wt) return null;
  const r = store.db.query("SELECT ctx FROM observed_tokens WHERE worker = ? ORDER BY observed_at DESC LIMIT 1").get(m.wt) as { ctx: number | null } | null;
  return r?.ctx ?? null;
}

const isoAt = (at: number) => new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

function setUnit(store: Store, m: Member, slug: string, set: Row, kind: string, at: number) {
  store.fact(kind, [{ table: "units", key: { project: m.project, squad: m.squad, slug }, set: { ...set, observed_at: at, updated_at: at } }], { project: m.project, squad: m.squad, unit: slug, payload: set });
}

function setMember(store: Store, m: Member, set: Row, kind: string, at: number) {
  store.fact(kind, [{ table: "members", key: { id: m.id }, set: { ...set, updated_at: at } }], { project: m.project, squad: m.squad, member: m.wt ?? `${m.role}${m.suffix ? `/${m.suffix}` : ""}`, payload: set });
}

async function pick(x: Exec, m: Member, w: Wish, why: Why): Promise<Pick> {
  return x.act.pick(x.store, m, {
    agent: w.agent ?? null, model: w.model ?? null, effort: w.effort ?? null, account: w.account ?? null,
    limited: limitExclusion(x.store, m, x.now), at: x.now,
  });
}

// While a limit holds this member's worktree, no start lands back on the limited account: the
// open `limited` episode (every kind, including pool and gone, which stamp no members row) is the
// exclusion. A short known wait (limit-wait) is waited out on the same account instead.
function limitExclusion(store: Store, m: Member, now: number): string | null {
  const wt = m.wt;
  if (!wt) return null;
  if (store.get("episodes", { project: m.project, subject: wt, kind: "limit-wait" })?.state === "waiting") return null;
  const ep = store.get("episodes", { project: m.project, subject: wt, kind: "limited" });
  if (!ep || ep.state === "closed" || ep.state === "expired" || Number(ep.ended_at ?? 0) <= now) return null;
  const [agent, account] = String(ep.episode_key).split("|")[0].split("/");
  if (!agent || !account) return null;
  return `${agent}:${account}=${Number(ep.ended_at)}`;
}

function noAccount(x: Exec, m: Member, p: { slot?: string }): void {
  const key = { project: m.project, squad: m.squad, role: m.role, suffix: m.suffix };
  if (x.store.get("pause_members", key)?.state !== "resuming") return;
  const reason = p.slot ? `${p.slot}; waiting for a Builder ${p.slot.startsWith("WAIT host:") ? "start" : "slot"}` : "no account free; awaiting fresh placement";
  if (x.store.get("pause_members", key)?.reason !== reason) x.store.upsert("pause_members", key, { reason });
}

// U180: a start ends its fallback reservation. Landing on another agent or model (another account for
// the same model still counts as placed) is said once, with the pick's reason:
// the fallback-return window (switches.ts) keeps the switch off this member until it passes.
function settleReservation(store: Store, m: Member, on: { agent: string; model: string | null; account: string | null }, at: number): void {
  const r = reservationOf(store, m.id, at);
  if (!r) return;
  const landed = on.agent === r.agent && !!on.model && sameModel(r.model, on.model);
  store.upsert("episodes", { project: m.project, subject: `member:${m.id}`, kind: RESERVE }, { state: landed ? "placed" : "missed", ended_at: at, observed_at: at });
  if (landed) return;
  const why = String(store.get("picks", { member: m.id })?.reason ?? "the start's pick chose another place");
  store.event("fallback_missed", { project: m.project, squad: m.squad, member: m.wt ?? null, payload: {
    id: m.id, aimed: `${r.agent}:${r.model}${r.account ? `@${r.account}` : ""}`, landed: `${on.agent}:${on.model ?? "-"}${on.account ? `@${on.account}` : ""}`,
    why: `${why}; no fallback move for this member until fallback_return_min passes` } });
}

const member: Fulfiller = {
  name: "member",
  kinds: ["member"],
  run() { return []; },   // the decider emits the starts

  stale(a, x) {
    if ((a.payload as { stop?: boolean }).stop) {
      const r = x.store.get("members", { id: (a.payload as { id: number }).id });
      if (!r || view(x.store, r) !== "running") return true;
      // U200: a stop whose calls went out finishes once the agent reads gone; the presence and
      // reason checks below would drop it the moment the stop worked.
      if (x.act?.openCall(x.store, stopKey(a, stopOp(x.store, String(r.project), String(r.squad))))) return false;
      // A retried stop re-reads reality: the decider re-emits it if it is still owed, so a
      // stale one drops instead of stopping an agent that no longer matches the reason.
      const w = r.wt ? x.store.get("observed_workers", { project: r.project, wt: r.wt }) : null;
      if (!w || w.presence !== "running") return true;
      const why = (a.payload as { why?: string }).why;
      if (why === "restart" && r.restart_mode !== "now" && w.state !== "idle" && w.state !== "done") return true;
      if (why === "hung" && w.state !== "working") return true;
      if (why && SWITCH_WHYS.includes(why)) {
        // A limit stop fires for a working member stuck on its limit too (decide.ts switchStuck);
        // every other switch still needs the member idle or done.
        if (w.state !== "idle" && w.state !== "done" && (why !== "limit" || !limitStuck(x.store, r, x.now))) return true;
        const sw = switchFacts(x.store, r, x.now);
        if (!sw.stop || sw.stop.why !== why || sw.stop.episode !== a.episode) return true;
      }
      return false;
    }
    return !current(x.store, a, !!sentStart(x, a));
  },

  async ready(a, x) {
    // A stop first proves the pick (no room -> nothing stopped) and the coordinator pane.
    if ((a.payload as { stop?: boolean }).stop) {
      const id = (a.payload as { id: number }).id, row = x.store.get("members", { id }), m = memberOf(x.store, { id });
      if (!row || !m) return true;
      if (lock(x.store, row, ["action:member"])) return false;
      if (x.act.openCall(x.store, stopKey(a, stopOp(x.store, m.project, m.squad)))) return true;   // U200: its calls went out; only the gone-check is left
      // U11: a squad on a contract backend has no coordinator pane: its stop closes the member's terminals.
      if (!onContract(x.store, m.project, m.squad) && !x.store.get("coordinators", { project: m.project, squad: m.squad })?.handle) return false;
      // A switch stop re-proves its row (the pick still lands elsewhere, the pin still differs):
      // the decider re-emits it while it holds, so a stale one waits instead of stopping for nothing.
      const why = (a.payload as { why?: string }).why;
      if (why && SWITCH_WHYS.includes(why)) {
        const sw = switchFacts(x.store, row, x.now);
        if (!sw.stop || sw.stop.why !== why || sw.stop.episode !== a.episode) return false;
      }
      const p = await pick(x, m, payloadOf(row), "start");
      return !("wait" in p || "error" in p);
    }
    const id = (a.payload as { id: number }).id, row = current(x.store, a), m = memberOf(x.store, { id });
    if (sentStart(x, a)) return true; // already sent: keep its placement and retry id
    if (!row || !m) return true;
    if (lock(x.store, row, ["action:member"])) return false; // another lifecycle act on it first
    // U1: a queued Builder whose unit was held, cancelled or unapproved since its wish is withdrawn, not
    // started (exec() then finds no start to make).
    const refused = queuedWhy(x.store, row, false, x.now);
    if (refused) { withdraw(x.store, row, refused, "loop", undefined, x.now); return true; }
    const w = payloadOf(row);
    const p = await pick(x, m, w, w.why ?? "start");
    if ("wait" in p) { noAccount(x, m, p); return false; }
    placements.set(a, p);
    return true;
  },

  async exec(a, x): Promise<Result> {
    // U153 stop: close the agent, keep the worktree/branch/PR; the start row restarts it fresh.
    if ((a.payload as { stop?: boolean }).stop) {
      const blocked = startBlock(x.store, a);
      if (blocked) return blocked === "paused" ? { wait: blocked } : { dropped: blocked };
      const { store, now: at } = x, id = (a.payload as { id: number }).id;
      const row = store.get("members", { id }), m = memberOf(store, { id });
      if (!row || !m || view(store, row) !== "running") return { dropped: "no longer wished running" };
      const contract = onContract(store, m.project, m.squad), op = stopOp(store, m.project, m.squad);
      const keep = String(store.get("coordinators", { project: m.project, squad: m.squad })?.handle ?? "");
      if (!keep && !contract) return { wait: "no coordinator pane" };
      const run = String(store.get("squads", { project: m.project, topic: m.squad })?.run_id ?? "");
      const makeSeat = (op: string) => x.act.seat(store, m.project, m.squad, stopKey(a, op), m.wt, at);
      const r = await x.act.driver(makeSeat(op), m.agent).stop(makeSeat, m, run, keep);
      if (!r.ok) return { retry: r.error ?? "stop failed" };  // presence stays as observed
      const sentAt = Number((store.db.query("SELECT at FROM orca_calls WHERE key = ? ORDER BY id DESC LIMIT 1").get(stopKey(a, op)) as Row | null)?.at ?? 0);
      const why = (a.payload as { why?: string }).why;
      // U180: the stop reserves the place its tick's pick aimed for, until the member is placed or
      // pick_ttl_s passes: later picks count it as load, and its own start keeps it while it fits.
      // Written once, when the stop's calls go out, so the start that follows the stop finds it (U200:
      // the wait below can span ticks, and a placed or missed one of an earlier stop is not reopened).
      if (why === "fallback") {
        const aim = store.get("picks", { member: m.id }), held = store.get("episodes", { project: m.project, subject: `member:${m.id}`, kind: RESERVE });
        if (aim?.slot === 1 && aim.agent && aim.model && !(held && Number(held.started_at) >= sentAt)) {
          store.upsert("episodes", { project: m.project, subject: `member:${m.id}`, kind: RESERVE },
            { squad: m.squad, episode_key: JSON.stringify({ agent: aim.agent, model: aim.model, account: aim.account ?? null }),
              started_at: at, ended_at: at + limitNum(store, m.project, "pick_ttl_s"), state: "reserved", source: "loop", observed_at: at });
        }
      }
      // U200: done only when the agent is gone. The calls returning ok is not that: the normal start
      // places a member that is not running, so a still-running one must not read stopped. The wait
      // (not a retry, whose gap is 15 minutes) looks again next tick, once the observer has read the
      // agent gone. A new process start since the stop's call (the start landed already) counts as gone too,
      // and so does a process walk read after the call that found no agent (account-move-slow U2): Orca's
      // dispatch for the old agent can stay open long after it exited, and only a walk that read after
      // the stop went out proves that (walkedGone; decide.ts reality() reads the same walk to start it).
      const ow = store.get("observed_workers", { project: m.project, wt: m.wt });
      if (ow?.presence === "running" && !walkedGone(ow, sentAt) && !(lastStart(row) > sentAt)) return { wait: "agent still running after stop", at: at + 1 };
      if (why === "fallback")
        store.upsert("episodes", { project: m.project, subject: `member:${m.id}`, kind: "fallback-return" },
          { squad: m.squad, episode_key: `fallback|${m.wt}|${at}`, started_at: at, state: "open", source: "loop", observed_at: at });
      if ((a.payload as { why?: string }).why === "rss")
        store.upsert("episodes", { project: m.project, subject: `member:${m.id}`, kind: "rss_restart" }, { squad: m.squad, started_at: at, state: "open", source: "loop", observed_at: at });
      store.event("member_stopped", { project: m.project, squad: m.squad, member: m.wt, payload: { id: m.id, why: (a.payload as { why?: string }).why ?? "restart", sent_at: sentAt } });
      return { done: true, result: { stopped: m.wt } };
    }
    const blocked = startBlock(x.store, a);
    if (blocked) return blocked === "paused" ? { wait: blocked } : { dropped: blocked };
    const { store, now: at } = x, id = (a.payload as { id: number }).id;
    // A start still open under its retry id keeps what it first asked for: that is what will run.
    const key = startKey(a), sent = sentStart(x, a);
    const row = current(store, a, !!sent), m = memberOf(store, { id });
    if (!row || !m) return { dropped: "no longer this member's start" };
    const w = payloadOf(row), why: Why = w.why ?? "start";
    const p = sent ?? placements.get(a) ?? await pick(x, m, w, why);
    placements.delete(a);
    const afterPick = startBlock(store, a);
    if (afterPick) return afterPick === "paused" ? { wait: afterPick } : { dropped: afterPick };
    // U1: the same rule once more right before the spawn, on the row as it is now: a hold or cancel
    // may have landed (or withdrawn the wish) during the pick.
    if (!sent) {
      const fresh = current(store, a);
      if (!fresh) return { dropped: "no longer this member's start" };
      const refused = queuedWhy(store, fresh, false, at);
      if (refused) { withdraw(store, fresh, refused, "loop", undefined, at); return { dropped: `queued Builder withdrawn: ${refused}` }; }
    }
    if ("error" in p) return { retry: p.error };
    if ("wait" in p) {
      noAccount(x, m, p);
      return { idle: true };
    }
    let prompt = w.prompt ?? (w.request ? rolePrompt(store, m, w.spec) : resuming(store, row)
      ? resumePrompt(store, row, store.get("pause_members", memberKey(row as Target))!) : phasePrompt(store, row));
    // U3: a Thinker started while its squad's units wait on its post-resume plan check is told so.
    if (prompt !== undefined) prompt += revalidateNote(store, row);
    const placementWhy = why === "limit" && (p.agent !== m.agent || p.model !== m.model) ? "model" : why;
    const fromHandoff = handoff(m, { why: placementWhy, model: p.model, account: p.account ?? null, ctx: why === "limit" ? ctxOf(store, m, w) : null, run: (store.get("squads", { project: m.project, topic: m.squad })?.run_id as string) ?? null, prompt });
    const h = { ...fromHandoff, model: p.model, account: p.account, ...(sent ? { launch: sent.launch, context: sent.prompt } : {}) };
    const agent = p.agent ?? m.agent ?? "claude", effort = p.effort ?? m.effort;
    const seat = x.act.seat(store, m.project, m.squad, key, m.wt, at, memberLabel(m)), driver = x.act.driver(seat, agent);

    if (h.launch === "tell") {
      const r = await driver.poke(m, h.context);
      if (r === "failed") return { retry: `tell ${m.wt}: not sent` };
      setMember(store, m, { want_result: "tell" }, "member_told", at);
      return { done: true, result: { launch: "tell", poked: r } };
    }
    const release = x.act.slot();
    if (!release) {
      if (resuming(store, row)) store.upsert("pause_members", memberKey(row as Target), { reason: "no free start slot; awaiting fresh placement" });
      return { wait: "no free start slot" };
    }
    return {
      background: (async (): Promise<Result> => {
        try {
          const moved = { ...m, agent, model: h.model, effort, account: h.account };
          const r = h.launch === "continue" ? await driver.resume(moved) : await driver.start(moved, h.model, h.account, h.context);
          if (!r.ok && actionBlock(store, a)) return { wait: "activity changed during start" };
          if (!r.ok) {
            // U97: the backend guard's `agent_busy` refusal waits and retries, never force-closes.
            // Still refused after 30 min, one card names the worktree; the wait continues.
            if (r.busy && /agent_busy/.test(r.error)) {
              const key = { project: m.project, subject: `member:${m.id}`, kind: "agent_busy" };
              const row = store.get("episodes", key), first = row && row.ended_at == null ? Number(row.started_at) : at;
              if (!row || row.ended_at != null) store.upsert("episodes", key, { squad: m.squad, started_at: at, ended_at: null, state: "waiting", source: "loop", observed_at: at });
              else if (at - first >= DUPLICATE_CARD_AFTER && row.state !== "alerted") {
                const o = await alert(store, m.project, key.subject, "agent_busy",
                  `The ${m.role}${m.suffix ? ` ${m.suffix}` : ""} of ${m.squad} has waited 30 minutes to start: the old agent in ${m.wt} is still mid-turn, so the loop starts no second session. It retries each tick; close the old session if it is hung.`,
                  { title: "Start blocked: old agent busy", fields: { kind: "agent_busy", wt: m.wt } });
                if (o.code === 0) store.upsert("episodes", key, { state: "alerted", observed_at: at });
              }
              return { wait: r.error, at: Math.min(first + DUPLICATE_CARD_AFTER, at + 60) };
            }
            return r.busy ? { wait: r.error } : { retry: r.error };
          }
          const busyRow = store.get("episodes", { project: m.project, subject: `member:${m.id}`, kind: "agent_busy" });
          if (busyRow && busyRow.ended_at == null) {
            if (busyRow.state === "alerted") await resolveAlert(store, m.project, `member:${m.id}`, "agent_busy");
            store.upsert("episodes", { project: m.project, subject: `member:${m.id}`, kind: "agent_busy" }, { state: "closed", ended_at: at, observed_at: at });
          }
          store.tx(() => {
            // A wish edited while the call was out that asks for the same agent, model and reason (a
            // prompt edit) is what this start ran; one naming another is owed (decide.ts pinsOther).
            const now = store.get("members", { id }), nw = now ? payloadOf(now) : {};
            const sameWish = now?.want === "running" && (now.want_at === row.want_at
              || ((nw.why ?? "start") === (w.why ?? "start") && (nw.model ?? null) === (w.model ?? null) && (nw.agent ?? null) === (w.agent ?? null)));
            // No earlier than the last walk of its worktree: a walk taken while the call was out (no
            // agent yet) reads as before this start, so the decider waits out the spawn grace.
            const seen = Number(store.get("observed_workers", { project: m.project, wt: r.wt })?.account_at ?? 0);
            settleReservation(store, m, { agent, model: h.model, account: h.account }, at);   // before placed_at moves
            // U4: the generation this start's terminal carries as DS_GEN (none for a start Orca types itself).
            setMember(store, m, { status: "running", wt: r.wt, agent, model: h.model, effort, account: h.account, gen: seat.gen?.() ?? null,
              ...(sameWish ? { want_result: h.launch } : {}), placed_at: Math.max(at, seen), ...(w.request ? { since: isoAt(at), doc: requestDoc(row, w) } : {}) }, "member_started", at);
            // A start that is not the member's first: the decider's REBREAK_MIN reads it.
            if (Number(row.placed_at ?? 0) || row.started) store.upsert("episodes", { project: m.project, subject: `member:${m.id}`, kind: "restarted" },
              { squad: m.squad, started_at: at, state: "open", source: "loop", observed_at: at });
            // U213: a start into another worktree than the member's last: its squad's units follow it.
            if (m.wt && m.wt !== r.wt) {
              for (const u of store.db.query("SELECT slug FROM units WHERE project = ? AND squad = ? AND builder_wt = ?").all(m.project, m.squad, m.wt) as Row[])
                store.fact("unit_builder_moved", [{ table: "units", key: { project: m.project, squad: m.squad, slug: String(u.slug) }, set: { builder_wt: r.wt, observed_at: at, updated_at: at } }],
                  { project: m.project, squad: m.squad, unit: String(u.slug), payload: { old: m.wt, new: r.wt } });
            }
            if (w.unit) {
              const cancelled = store.get("units", { project: m.project, squad: m.squad, slug: w.unit })?.status === "cancelled";
              setUnit(store, m, w.unit, { ...(cancelled ? {} : { status: "dispatched" }), builder_wt: r.wt, wait_until: null },
                cancelled ? "unit_cancelled_builder_started" : "unit_dispatched", at);
            }
            ensureTransition(store, { ...m, member: r.wt }, at);
            if (resuming(store, row) && !actionBlock(store, a)) store.upsert("pause_members", memberKey(row as Target), { state: "active", closed_at: null, reason: null });
            if (h.context && !actionBlock(store, a)) deliver(store, { project: m.project, squad: m.squad, member: r.wt, kind: "brief", text: h.context }, at);
          });
          return { done: true, result: { launch: h.launch, wt: r.wt, model: h.model, account: h.account } };
        } finally { release(); }
      })(),
    };
  },

  async giveUp(a, x, why) {
    const id = (a.payload as { id: number }).id, m = memberOf(x.store, { id });
    if (!m) return;
    setMember(x.store, m, { want_result: `failed: ${why}` }, "member_start_failed", x.now);
    const o = await alert(x.store, m.project, a.subject, a.episode, `The loop could not start the ${m.role}${m.suffix ? ` ${m.suffix}` : ""} of ${m.squad}: ${why}`, { title: "Start failed" });
    return o.code === 0;   // its own card written: no refusal card beside it (else the actuator's, retried by ready())
  },
};
export default member;
