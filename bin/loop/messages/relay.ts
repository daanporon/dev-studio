// relay.ts — a worker's Run mail reaches the Lead while the loop holds the Run (U61). Every message
// a worker sends to run:<id> with Orca's own commands (an ask, a status, a worker_done) goes to the Run's
// coordinator, and that is the loop's pane, which no agent reads. Each tick, once the seat is confirmed ours
// (actuator.seats()), the loop:
//   1. peeks the Run's unread mail from its pane and copies each new message into `relayed`;
//   2. writes every message not yet forwarded as a message row to the squad's Lead (U276, messages.ts
//      relayMessage: key `relay:<msg_id>`, kind `run`, a question needs a reply), keeping its sender, type,
//      subject, body and id; the messages reconciler wakes the Lead, who reads it with `ds msg` / watch.sh
//      and answers a question with `ds msg reply <row id> "<answer>"` (which also files the Orca reply that
//      fulfil/reply.ts sends from this pane, so the worker's parked ask returns);
//   3. marks the Run's mail read only once every message the peek saw is forwarded. A consuming
//      check takes the whole unread batch, so what it took that the peek didn't see is copied in
//      and forwarded on the next tick, from the table.
// No Run mail is held in an Orca inbox of the Lead's any more (U276): before, a forward went to the Lead's
// agent terminal with send-run-worker and could be misdelivered, refused or stuck behind a rebind. Mail
// still unforwarded STUCK_AFTER after the loop first saw it (a paused squad, a failed terminal read) raises
// one card for the squad (how many, the oldest subject), resolved once a forward goes through or nothing is
// left. Orca's "Worker stopped without reporting" escalation (`msg_stop_…`) sent by the Lead's own terminal
// is marked `self`, not sent back: forwarding it wakes the Lead, whose next turn-end makes another; one from
// any other worker is marked `stop` (one worker_stopped event per episode). A reload still queued is dropped
// (`superseded`) once a newer reload for the squad is queued or forwarded. The relay-stuck card re-raises
// once an hour while mail is still stuck, also after the operator dismissed it.
import { alert, resolveAlert, type LoopActuator } from "../core/actuator.ts";
import { errOf } from "../io/orca.ts";
import { agentsOf, loopPanes, parseAgents, type Agent } from "../reconcilers/members.ts";
import { memberAt, relayMessage, type Sender } from "./messages.ts";
import type { Row, Store } from "../core/store.ts";
import { redact, redactPayload } from "../core/redact.ts";
import { freezeRelay, paused, thawRelay } from "../pause/pause.ts";

export const STUCK_AFTER = 600;
// U99: the relay-stuck card re-raises this often while mail is still stuck, also after dismissal.
const STUCK_RERAISE = 3600;
export type Mail = { id: string; from_handle?: string | null; type?: string | null; subject?: string | null; body?: string | null; payload?: unknown };

// The messages a run-inbox-peek or run-inbox-take printed (a JSON array); throws on anything else.
export function parseMail(out: string): Mail[] {
  const v = JSON.parse(out.trim() || "[]") as unknown;
  if (!Array.isArray(v)) throw new Error("not a message list");
  return (v as Mail[]).filter((m) => m && typeof m.id === "string");
}

// U99: a reload is news for a moment — an older one still queued is dropped (`superseded`) once a
// newer reload for the same squad is queued, backing off, or really forwarded (not when the newer
// one was itself given up or superseded).
function supersede(store: Store, o: { project: string; squad: string; at: number }): void {
  const rows = store.db.query(`SELECT msg_id, forwarded_at, error FROM relayed
    WHERE project = ? AND squad = ? AND subject = 'reload' ORDER BY seen_at DESC, rowid DESC`).all(o.project, o.squad) as Row[];
  let fresh = false;
  for (const r of rows) {
    const id = String(r.msg_id);
    if (!fresh) {
      if (r.forwarded_at == null || r.error == null) fresh = true;
      continue;
    }
    if (r.forwarded_at == null) {
      store.db.run("UPDATE relayed SET forwarded_at = ?, error = 'superseded' WHERE msg_id = ?", [o.at, id]);
      store.event("run_mail_superseded", { project: o.project, squad: o.squad, payload: { id } });
    }
  }
}

// U244: whether the Run's inbox needs a peek this pass: a stored message is not yet forwarded (its take after
// the forward needs this pass's peek), or `peek` says Orca has something (an unread message this tick).
export function relayWork(store: Store, o: { project: string; squad: string; at: number }): boolean {
  return !!store.db.query("SELECT 1 FROM relayed WHERE project = ? AND squad = ? AND forwarded_at IS NULL LIMIT 1").get(o.project, o.squad);
}

// One relay pass for a squad whose Run `handle` holds. Returns an error to log, or null.
// `peek` false: nothing new can be in the Run's inbox (the caller knows from this tick's unread read), so
// only what is already stored is worked: freeze and thaw, superseded reloads, rows still to write.
export async function relay(act: LoopActuator, store: Store, o: { project: string; squad: string; run: string; handle: string; lead: string | null; at: number; peek?: boolean }): Promise<string | null> {
  const { project, squad, run, handle, at } = o;
  if (!o.lead) return null;
  let seen: Mail[] = [];
  if (o.peek !== false) {
    const peek = await act.orca.run("run-inbox-peek", [run], { from: handle });
    if (peek.code !== 0) return `relay peek of ${run}: ${errOf(peek, "run-inbox-peek")}`;
    try { seen = parseMail(peek.out); } catch (e) { return `relay peek of ${run}: ${(e as Error).message}`; }
    keep(store, o, seen);
  }

  if (paused(store, { project, squad, member: o.lead })) { freezeRelay(store, project, squad, at); return null; }
  thawRelay(store, project, squad, at);

  const lead = o.lead, panes = loopPanes(store, project);
  const unforwarded = () => store.db.query("SELECT * FROM relayed WHERE project = ? AND squad = ? AND forwarded_at IS NULL ORDER BY seen_at, rowid").all(project, squad) as Row[];
  let agents: Agent[] = [], failed: string | null = null, sent = false;
  // The live agent terminals, read only when there is mail: a stop notice from the Lead's own terminal, and
  // the member a handle belongs to. Without them no mail is written this pass.
  if (unforwarded().length) {
    const ah = await act.orca.run("agent-handles", []);
    if (ah.code !== 0) failed = errOf(ah, "agent-handles");
    else agents = parseAgents(ah.out);
  }
  // U99: an older reload still queued is dropped once a newer reload is queued or really forwarded.
  supersede(store, { project, squad, at });
  for (const r of failed ? [] : unforwarded()) {
    const mark = (why: string) => store.db.run("UPDATE relayed SET forwarded_at = ?, error = ? WHERE msg_id = ?", [at, why, String(r.msg_id)]);
    // The loop's own pane never writes to the Run, but a message it did write must not come back.
    if (r.from_handle === handle) { mark("own"); continue; }
    const isStop = String(r.msg_id).startsWith("msg_stop_") && !!r.from_handle;
    if (isStop) {
      const sender = String(r.from_handle);
      if (agentsOf(agents, lead, panes).some((a) => a.handle === sender)) { mark("self"); continue; }
      // Any other Run worker ending a turn is normal and never reaches the Lead; liveness (U69) tells
      // the Lead about a Builder that really stopped. One event per sender and episode, which lasts
      // until the sender sends the Run something else.
      mark("stop");
      stopped(store, { project, squad, at }, sender, agents.find((a) => a.handle === sender)?.wt ?? null);
      continue;
    }
    if (r.from_handle) store.db.run("UPDATE episodes SET ended_at = ?, state = 'closed', observed_at = ? WHERE project = ? AND subject = ? AND kind = 'worker-stopped' AND ended_at IS NULL", [at, at, project, String(r.from_handle)]);
    // U276: the Lead's message row; the messages reconciler wakes the Lead and the Lead reads it with ds msg.
    const m = relayMessage(store, { project, squad, from: senderOf(store, project, agents, r.from_handle), mail: r }, at);
    sent = true;
    store.db.run("UPDATE relayed SET forwarded_at = ?, error = NULL, tries = tries + 1 WHERE msg_id = ?", [at, String(r.msg_id)]);
    store.event("run_mail_relayed", { project, squad, payload: { run, id: r.msg_id, type: r.type, from: r.from_handle, message: m.message.id } });
  }
  await stuck(store, o, sent);
  if (failed) return `relay to the Lead of ${squad}: ${failed}`;
  if (!seen.length) return null;
  // U99: the Run's mail is marked read only once every message the peek saw is written or set aside;
  // the Run keeps what is still waiting.
  const left = store.db.query(`SELECT COUNT(*) AS n FROM relayed WHERE project = ? AND squad = ? AND forwarded_at IS NULL AND msg_id IN (${seen.map(() => "?").join(", ")})`).get(project, squad, ...seen.map((m) => m.id)) as { n: number };
  if (left.n) return null;

  const take = await act.orca.run("run-inbox-take", [run], { from: handle });
  if (take.code !== 0) return `relay take of ${run}: ${errOf(take, "run-inbox-take")}`;
  let took: Mail[];
  try { took = parseMail(take.out); } catch (e) { return `relay take of ${run}: ${(e as Error).message}`; }
  keep(store, o, took);
  const ids = took.map((m) => m.id);
  if (ids.length) store.db.run(`UPDATE relayed SET taken_at = ? WHERE taken_at IS NULL AND msg_id IN (${ids.map(() => "?").join(", ")})`, [at, ...ids]);
  return null;
}

// The member whose terminal `handle` sent the mail: by the live agent list, else the terminal the Orca
// observer saw; null for a handle no member owns (a `dispatch:` sender, a gone terminal).
function senderOf(store: Store, project: string, agents: Agent[], handle: unknown): Sender | null {
  if (!handle) return null;
  const h = String(handle);
  const wt = agents.find((a) => a.handle === h)?.wt
    ?? (store.db.query("SELECT wt FROM observed_terminals WHERE project = ? AND handle = ? AND wt IS NOT NULL").get(project, h) as Row | null)?.wt;
  return wt ? memberAt(store, String(wt)) : null;
}

// One `worker_stopped` event the first time a sender's stop mail is seen in an episode.
function stopped(store: Store, o: { project: string; squad: string; at: number }, handle: string, wt: string | null): void {
  const key = { project: o.project, subject: handle, kind: "worker-stopped" }, row = store.get("episodes", key);
  if (row && row.ended_at == null) return;
  store.upsert("episodes", key, { squad: o.squad, episode_key: String(o.at), started_at: o.at, ended_at: null, state: "stopped", source: "loop", observed_at: o.at });
  store.event("worker_stopped", { project: o.project, squad: o.squad, payload: { handle, worktree: wt } });
}

// One card per squad while its mail waits STUCK_AFTER or more; resolved by a forward or an empty queue.
async function stuck(store: Store, o: { project: string; squad: string; at: number }, sent: boolean): Promise<void> {
  const { project, squad, at } = o, key = { project, subject: `relay.${squad}`, kind: "relay-stuck" }, row = store.get("episodes", key);
  const q = store.db.query("SELECT COUNT(*) AS n, MIN(seen_at) AS t FROM relayed WHERE project = ? AND squad = ? AND forwarded_at IS NULL").get(project, squad) as { n: number; t: number | null };
  const up = row?.state === "alerted" && row.ended_at == null;
  if (up && (sent || !q.n)) {
    const r = await resolveAlert(store, project, key.subject, String(row!.episode_key));
    if (r.code !== 0) { store.event("plugin_error", { project, squad, payload: { plugin: "relay", error: errOf(r, "alerts.sh") } }); return; }
    store.upsert("episodes", key, { state: "closed", ended_at: at, observed_at: at });
    return;
  }
  if (!q.n || q.t == null || at - q.t < STUCK_AFTER) return;
  // U99: still stuck — re-raise once an hour, also after the operator dismissed it (a dismissal
  // leaves the episode row alone; observed_at remembers the last raise).
  if (up && at - Number(row!.observed_at ?? 0) < STUCK_RERAISE) return;
  const oldest = store.db.query("SELECT subject, type FROM relayed WHERE project = ? AND squad = ? AND forwarded_at IS NULL ORDER BY seen_at, rowid LIMIT 1").get(project, squad) as Row;
  const qq = (store.db.query("SELECT COUNT(*) AS n FROM relayed WHERE project = ? AND squad = ? AND forwarded_at IS NULL AND type = 'question'").get(project, squad) as { n: number }).n;
  const episode = `stuck:${q.t}`, min = Math.floor((at - q.t) / 60);
  const a = await alert(store, project, key.subject, episode,
    `${q.n} Run message${q.n === 1 ? "" : "s"} for the Lead of ${squad} not delivered for ${min} minutes; the oldest: "${String(oldest.subject || oldest.type || "message")}". ${qq} of them ${qq === 1 ? "is a question" : "are questions"} waiting for an answer. The loop keeps trying each tick.`,
    { title: `Run mail stuck: ${squad}` });
  if (a.code !== 0) { store.event("plugin_error", { project, squad, payload: { plugin: "relay", error: errOf(a, "alerts.sh") } }); return; }
  store.upsert("episodes", key, { squad, episode_key: episode, started_at: up ? row!.started_at : at, ended_at: null, state: "alerted", source: "loop", observed_at: at });
}

function keep(store: Store, o: { project: string; squad: string; run: string; at: number }, mail: Mail[]): void {
  const put = store.db.prepare(`INSERT OR IGNORE INTO relayed (msg_id, project, squad, run_id, from_handle, type, subject, body, payload, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const m of mail) {
    const payload = m.payload == null ? null : typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload);
    put.run(m.id, o.project, o.squad, o.run, m.from_handle ?? null, m.type ?? null, m.subject == null ? null : redact(m.subject), m.body == null ? null : redact(m.body), redactPayload(payload), o.at);
  }
}
