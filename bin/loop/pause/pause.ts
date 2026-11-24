import { CANCEL_KINDS, stopping } from "../squad/cancel.ts";
import { debriefHold } from "../squad/archive-debrief.ts";
// Shared activity overlay and guard. Public checkpoint/close/start controls live in the lifecycle fulfiller.
import type { Action } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { dependencyReasons, memberUnit, mergedUnit } from "./pause-conditions.ts";

export type PauseTarget = { scope: "project" | "squad" | "member"; project: string; squad?: string; role?: string; suffix?: string };
export type Target = { project: string; squad?: string | null; role?: string | null; suffix?: string | null; member?: string | null };
// A `plan` prerequisite (hold-cancels-queue-undo-approval U2) is placed only by squad-state's revoke-plan:
// unresolved while the plan is not in its squad's approved_plans, so approving it again releases the wait.
export type Prerequisite = { kind: "unit"; project: string; squad: string; slug: string } | { kind: "pr"; project: string; ref: string }
  | { kind: "plan"; project: string; squad: string; plan: string };
export type PauseOptions = { source?: "manual" | "dependency"; prerequisites?: Prerequisite[]; by?: string };
const keys = ["scope", "project", "squad", "role", "suffix"] as const;
export const memberKey = (t: Target | Row) => ({ project: t.project, squad: t.squad ?? "", role: t.role ?? "", suffix: t.suffix ?? "" });
const scopeKey = (t: PauseTarget): Row => ({ scope: t.scope, project: t.project, squad: t.scope === "project" ? "" : t.squad ?? "",
  role: t.scope === "member" ? t.role ?? "" : "", suffix: t.scope === "member" ? t.suffix ?? "" : "" });

export function targetOf(store: Store, t: Target): Target {
  if (!t.member) return t;
  const m = store.db.query("SELECT * FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(t.project, t.member) as Row | null;
  return m ? { ...t, squad: String(m.squad), role: String(m.role), suffix: String(m.suffix ?? "") } : t;
}
function ancestors(store: Store, raw: Target): Row[] {
  const t = targetOf(store, raw);
  if (t.role === "studio" || (t.member != null && t.member === store.get("projects", { label: t.project })?.studio_wt)) return [];
  return [scopeKey({ scope: "project", project: t.project }),
    ...(t.squad ? [scopeKey({ scope: "squad", project: t.project, squad: t.squad })] : []),
    ...(t.role ? [scopeKey({ scope: "member", project: t.project, squad: t.squad ?? "", role: t.role, suffix: t.suffix ?? "" })] : [])];
}
export function intents(store: Store, t: Target): Row[] {
  return ancestors(store, t).flatMap((key) => store.db.query(`SELECT * FROM pause_intents WHERE ${keys.map((k) => `${k} = ?`).join(" AND ")} AND cleared_at IS NULL`)
    .all(...keys.map((k) => String(key[k]))) as Row[]);
}
export function paused(store: Store, t: Target): boolean {
  t = targetOf(store, t);
  return intents(store, t).length > 0 || (!!t.role && store.get("pause_members", memberKey(t))?.state === "resuming");
}
export function version(store: Store, t: Target): number {
  return ancestors(store, t).reduce((n, key) => n + Number(store.get("pause_scopes", key)?.version ?? 0), 0);
}
function bump(store: Store, key: Row): void { store.upsert("pause_scopes", key, { version: Number(store.get("pause_scopes", key)?.version ?? 0) + 1 }); }
function currentMember(store: Store, t: Target): Row | null {
  return store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = ? AND suffix = ? ORDER BY id DESC LIMIT 1")
    .get(t.project, t.squad ?? "", t.role ?? "", t.suffix ?? "") as Row | null;
}
// A resume whose start the loop gave up on: it waits on `ds resume` again, which retries it.
export function failedResume(m: Row, row: Row | null): boolean {
  return row?.state === "resuming" && String(m.want_result ?? "").startsWith("failed");
}

function validate(store: Store, t: PauseTarget): void {
  if (!["project", "squad", "member"].includes(t.scope)) throw new Error("pause: invalid scope");
  if (!store.get("projects", { label: t.project }) && !store.db.query("SELECT 1 FROM squads WHERE project = ?").get(t.project)) throw new Error(`pause: no project '${t.project}'`);
  if (t.scope === "project") return;
  const squad = store.get("squads", { project: t.project, topic: t.squad ?? "" });
  if (!squad) throw new Error(`pause: no squad '${t.squad ?? ""}'`);
  if (["suspended", "closed", "gone", "archived"].includes(String(squad.status)) || squad.want === "suspended" || squad.want === "gone")
    throw new Error(`pause: squad is ${squad.want === "suspended" ? "suspended" : squad.status}; use its lifecycle control`);
  if (t.scope === "member") {
    const m = currentMember(store, t);
    if (!m || m.want === "gone" || t.role === "studio") throw new Error("pause: no registered squad member at that identity");
  }
}
function scopeMembers(store: Store, t: PauseTarget): Row[] {
  return (store.db.query(`SELECT m.* FROM members m JOIN squads s ON s.project = m.project AND s.topic = m.squad
    WHERE m.project = ? AND m.role != 'studio'
    AND m.id = (SELECT MAX(id) FROM members WHERE project = m.project AND squad = m.squad AND role = m.role AND suffix = m.suffix)
    AND COALESCE(s.status, '') NOT IN ('suspended', 'closed', 'gone', 'archived', 'cancelled')
    AND COALESCE(s.want, '') NOT IN ('suspended', 'gone')`).all(t.project) as Row[])
    .filter((m) => t.scope === "project" || (m.squad === t.squad && (t.scope === "squad" || (m.role === t.role && String(m.suffix ?? "") === (t.suffix ?? "")))));
}
function members(store: Store, t: PauseTarget): Row[] { return scopeMembers(store, t).filter((m) => m.want !== "gone"); }
export function ensureTransition(store: Store, t: Target, at: number): Row | null {
  t = targetOf(store, t);
  if (!t.role || currentMember(store, t)?.want === "gone" || !intents(store, t).length) return null;
  const key = memberKey(t), old = store.get("pause_members", key);
  if (old && (old.state === "pausing" || old.state === "paused")) return old;
  store.upsert("pause_members", key, { generation: crypto.randomUUID(), state: "pausing", reason: "awaiting journal checkpoint", requested_at: at,
    resumed_at: null, acknowledged_at: null, delivered_at: null, closed_at: null, dispatch: null, session: null, terminals: null, checkpoint: null, checkpoint_hash: null, task_completed: 0 });
  return store.get("pause_members", key);
}
export function projection(store: Store, t: Target): Row {
  t = targetOf(store, t);
  const member = t.role ? currentMember(store, t) : null, retired = member?.want === "gone";
  const sources = retired ? [] : intents(store, t), row = t.role && !retired ? store.get("pause_members", memberKey(t)) : null;
  const children = !t.role ? members(store, { scope: t.squad ? "squad" : "project", project: t.project, squad: t.squad ?? undefined })
    .map((m) => ({ member: m, pause: store.get("pause_members", memberKey(m)) })) : [];
  const closed = row?.state === "paused" || (!t.role && children.every((m) => m.pause?.state === "paused"));
  const state = sources.length ? (closed ? "paused" : "pausing") : row?.state === "resuming" || children.some((m) => m.pause?.state === "resuming") ? "resuming" : "active";
  return { state, retryable: t.role ? !!member && !retired && failedResume(member, row) : children.some((m) => failedResume(m.member, m.pause)),
    generation: row?.generation ?? sources[0]?.generation ?? null, reason: row?.reason ?? (sources.length && !closed ? "awaiting journal checkpoint" : null),
    checkpoint: row?.checkpoint ?? null, session: row?.session ?? null, dispatch: row?.dispatch ?? null, delivered_at: row?.delivered_at ?? null,
    sources: sources.map((r) => ({ scope: r.scope, source: r.source, project: r.project, squad: r.squad, role: r.role,
      suffix: r.suffix, generation: r.generation, requested_at: r.requested_at ?? null, prerequisites: r.prerequisites ? JSON.parse(String(r.prerequisites)) : [],
      ...(r.source === "dependency" ? { remaining: dependencyReasons(store, r as Target, JSON.parse(String(r.prerequisites ?? "[]"))) } : {}) })) };
}
export function pause(store: Store, t: PauseTarget, opts: PauseOptions, at: number): Row {
  return store.tx(() => {
    validate(store, t);
    const source = opts.source ?? "manual";
    if (!["manual", "dependency"].includes(source)) throw new Error("pause: invalid source");
    if (source === "dependency") {
      if (t.scope !== "member" || !opts.prerequisites?.length) throw new Error("pause: dependency wait needs a member and tracked prerequisites");
      for (const p of opts.prerequisites) {
        const hit = p.kind === "unit" ? store.get("units", { project: p.project, squad: p.squad, slug: p.slug })
          : p.kind === "pr" ? store.get("observed_prs", { project: p.project, ref: p.ref })
          : p.kind === "plan" ? store.get("squads", { project: p.project, topic: p.squad }) : null;
        if (!hit) throw new Error("pause: prerequisite is not tracked");
      }
      if (!dependencyReasons(store, t, opts.prerequisites).length) throw new Error("pause: prerequisites already satisfied; no wait needed");
    }
    const key = scopeKey(t), prev = store.get("pause_intents", { ...key, source });
    if (prev && prev.cleared_at == null) return { ...projection(store, t), changed: false };
    store.upsert("pause_intents", { ...key, source }, { generation: crypto.randomUUID(), prerequisites: opts.prerequisites ?? null,
      requested_by: opts.by ?? null, requested_at: at, cleared_at: null });
    bump(store, key);
    for (const m of members(store, t)) {
      ensureTransition(store, m as Target, at);
      if (m.role === "lead") freezeRelay(store, String(m.project), String(m.squad), at);
    }
    store.event("pause_requested", { project: t.project, squad: t.squad, payload: { ...t, source } });
    return { ...projection(store, t), changed: true };
  });
}

export function journalPath(store: Store, t: Target): string {
  for (const part of [t.project, t.squad, t.role, t.suffix ?? ""]) {
    if (part == null || part.includes("/") || part.includes("..")) throw new Error("pause: invalid journal identity");
  }
  return join(store.root, t.project, "journals", `${t.squad}-${t.role}${t.suffix ? `-${t.suffix}` : ""}.md`);
}
// How long after a checkpoint instruction (a pause, or U266's stop checkpoint) the loop waits for
// the journal line before it goes on without it.
export const CHECKPOINT_S = 300;
export const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
// The line the loop writes when no checkpoint came by the deadline. It never matches checkpointHash's
// `checkpoint <generation>: ` (it says `checkpoint failed <generation>: `). Throws on a write error.
export function checkpointFailed(store: Store, t: Target, generation: string, at: number, what: string): void {
  const file = journalPath(store, t);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `- ${new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")} [keep] checkpoint failed ${generation}: no checkpoint within ${CHECKPOINT_S / 60} minutes of the ${what} — read the work tree and the PR before you go on; this journal's last entries may be behind\n`);
}
export function checkpointHash(file: string, generation: string): string {
  const line = readFileSync(file, "utf8").split("\n").findLast((l) => l.includes(`checkpoint ${generation}: `));
  if (!line || !line.split(`checkpoint ${generation}: `)[1]?.trim()) throw new Error("pause: missing generation-bound journal checkpoint");
  return createHash("sha256").update(line).digest("hex");
}
// The terminal this process runs in, as a pause row names it: the Orca handle, else (a squad off Orca,
// U12b: no handle) the live terminal of the contract observer whose generation is DS_GEN, in DS_WT's folder.
export function sessionOf(store: Store, me: { handle: string | null; gen: string | null; wt: string | null }): string | null {
  if (me.handle) return me.handle;
  if (!me.gen || !me.wt) return null;
  const rows = store.db.query("SELECT handle, doc FROM observed_terminals WHERE wt = ? AND gone_at IS NULL").all(`local::${me.wt.replace(/\/+$/, "")}`) as Row[];
  const hit = rows.filter((r) => { try { return JSON.parse(String(r.doc ?? "{}")).gen === me.gen; } catch { return false; } });
  return hit.length === 1 ? String(hit[0].handle) : null;
}
export function acknowledge(store: Store, t: Target, generation: string, session: string, dispatch: string, file: string, at: number): Row {
  return store.tx(() => {
    const row = store.get("pause_members", memberKey(t));
    if (!row || !paused(store, t) || row.state !== "pausing" || row.generation !== generation) throw new Error("pause: stale checkpoint generation");
    if (row.delivered_at == null || row.session !== session || String(row.dispatch ?? "-") !== dispatch) throw new Error("pause: foreign session or dispatch acknowledgment");
    if (file !== journalPath(store, t)) throw new Error("pause: wrong role journal");
    const hash = checkpointHash(file, generation);
    store.upsert("pause_members", memberKey(t), { checkpoint: file, checkpoint_hash: hash, acknowledged_at: at, reason: "checkpoint recorded; awaiting idle terminal closure" });
    store.event("pause_checkpoint", { project: t.project, squad: t.squad, payload: { ...t, generation, session, dispatch, checkpoint: file } });
    return projection(store, t);
  });
}
export function clearRetiredTransition(store: Store, t: Target, at: number): boolean {
  return store.tx(() => {
    const row = store.get("pause_members", memberKey(t));
    if (!row || currentMember(store, t)?.want !== "gone" || intents(store, t).length) return false;
    const cleared = { state: "active", closed_at: null, acknowledged_at: null, reason: null, checkpoint: null,
      checkpoint_hash: null, session: null, dispatch: null, terminals: null, delivered_at: null, task_completed: 0 };
    if (Object.entries(cleared).every(([key, value]) => row[key] === value)) return false;
    store.upsert("pause_members", memberKey(t), { ...cleared, generation: crypto.randomUUID(), resumed_at: at });
    return true;
  });
}
// A member that only died (status gone, want running) keeps its pause: it is resumed.
// Repair: an open member-scope intent whose member is gone, or whose unit is cancelled or done, ends
// with it (a cancel removes the Builder but never cleared a manual pause). Squad and project scope
// are never touched. One `pause_cleared` event per row.
export function clearOrphanIntents(store: Store, project: string, at: number): number {
  const rows = store.db.query("SELECT * FROM pause_intents WHERE project = ? AND scope = 'member' AND cleared_at IS NULL").all(project) as Row[];
  let n = 0;
  for (const r of rows) {
    const t = { project, squad: String(r.squad), role: String(r.role), suffix: String(r.suffix) } as Target;
    const m = currentMember(store, t), unit = memberUnit(store, t);
    const why = !m ? null : m.want === "gone" ? "member gone" : unit && ["cancelled", "done"].includes(String(unit.status)) ? "unit cancelled" : null;
    if (!why) continue;
    store.tx(() => {
      const key = Object.fromEntries(keys.map((k) => [k, r[k]]));
      store.upsert("pause_intents", { ...key, source: r.source }, { cleared_at: at }); bump(store, key);
      clearRetiredTransition(store, t, at);
      store.event("pause_cleared", { project, squad: t.squad, payload: { ...t, why } });
    });
    n++;
  }
  return n;
}
export function clearDependency(store: Store, row: Row, at: number): void {
  store.tx(() => {
    const key = Object.fromEntries(keys.map((k) => [k, row[k]]));
    store.upsert("pause_intents", { ...key, source: "dependency" }, { cleared_at: at }); bump(store, key);
    const t = row as Target, old = store.get("pause_members", memberKey(t));
    if (currentMember(store, t)?.want === "gone") clearRetiredTransition(store, t, at);
    else if (old && ["pausing", "paused"].includes(String(old.state)) && !intents(store, t).length) {
      const closed = old.closed_at != null;
      store.upsert("pause_members", memberKey(t), { generation: crypto.randomUUID(), state: closed ? "resuming" : "active", resumed_at: at,
        closed_at: closed ? old.closed_at : null, acknowledged_at: null, reason: closed ? "prerequisites satisfied; awaiting fresh placement" : null });
    }
    if (t.role === "lead" && !paused(store, t)) thawRelay(store, t.project, t.squad ?? "", at);
    store.event("dependency_wait_released", { project: t.project, squad: t.squad, payload: t });
  });
}
export function latestMember(store: Store, m: Row): boolean {
  return currentMember(store, m as Target)?.id === m.id;
}
export function pauseControlBlock(store: Store, a: Action): string | null {
  const p = a.payload as Row | undefined;
  const m = p?.id != null ? store.get("members", { id: p.id }) : null;
  const row = m ? store.get("pause_members", memberKey(m as Target)) : null;
  return row && m!.want !== "gone" && latestMember(store, m!) && row.generation === a.episode && row.state === "pausing" && intents(store, m as Target).length ? null : "pause generation changed";
}
// A start already sent under its retry id: its agent may be up, so it is finished, not fenced.
// The pause decision belongs before the launch; the backend's fence still refuses a launch that has
// not happened. actionBlock stays strict, so a paused start that lands gets no brief and stays paused.
export function startSent(store: Store, id: unknown, episode: unknown): boolean {
  const last = store.db.query("SELECT op, state FROM orca_calls WHERE key = ? ORDER BY id DESC LIMIT 1").get(`start:${id}:${episode}`) as Row | null;
  return !!last && last.state !== "failed" && ["worker-start", "worker-resume", "role-start"].includes(String(last.op));
}
export function actionStartSent(store: Store, a: Action): boolean { return a.kind === "member" && startSent(store, (a.payload as Row | undefined)?.id, a.episode); }
export function startBlock(store: Store, a: Action): ReturnType<typeof actionBlock> { return actionStartSent(store, a) ? null : actionBlock(store, a); }
export function resumeAction(store: Store, a: Action): boolean {
  if (a.kind !== "member") return false;
  const m = store.get("members", { id: (a.payload as Row | undefined)?.id });
  if (!m || m.want === "gone" || !latestMember(store, m) || intents(store, m as Target).length) return false;
  const unit = memberUnit(store, m as Target);
  if (dependencyReasons(store, m as Target, []).length || (unit && (["done", "cancelled"].includes(String(unit.status)) || mergedUnit(store, unit)))) return false;
  return store.get("pause_members", memberKey(m as Target))?.state === "resuming";
}
export function resume(store: Store, t: PauseTarget, at: number): Row {
  return store.tx(() => {
    validate(store, t);
    const parent: Target = { project: t.project, ...(t.scope === "member" ? { squad: t.squad } : {}) };
    if (t.scope !== "project" && paused(store, parent)) throw new Error(`pause: resume the paused ${t.scope === "member" && intents(store, parent).some((r) => r.scope === "squad") ? "squad" : "project"} first`);
    // A squad or project resume clears manual pauses only: a member's dependency wait stays until its
    // prerequisites are met (or that member is resumed by name). U151.
    const rows = (store.db.query("SELECT * FROM pause_intents WHERE project = ? AND cleared_at IS NULL").all(t.project) as Row[])
      .filter((r) => t.scope === "project" || (r.squad === t.squad && (t.scope === "squad" || (r.scope === "member" && r.role === t.role && r.suffix === (t.suffix ?? "")))))
      .filter((r) => t.scope === "member" || r.source !== "dependency");
    const affected = scopeMembers(store, t);
    const retries = new Set(affected.filter((m) => failedResume(m, store.get("pause_members", memberKey(m))) && !intents(store, m as Target).length).map((m) => m.id));
    const retired = affected.some((m) => {
      const row = store.get("pause_members", memberKey(m));
      return m.want === "gone" && row && row.state !== "active" && !intents(store, m as Target).length;
    });
    if (!rows.length && !retries.size && !retired) return { ...projection(store, t), changed: false };
    for (const r of rows) { const key = Object.fromEntries(keys.map((k) => [k, r[k]])); store.upsert("pause_intents", { ...key, source: r.source }, { cleared_at: at }); bump(store, key); }
    for (const m of affected) {
      const key = memberKey(m as Target), old = store.get("pause_members", key);
      if (m.want === "gone") { clearRetiredTransition(store, m as Target, at); continue; }
      if (!old || old.state === "active" || (!["pausing", "paused"].includes(String(old.state)) && !retries.has(m.id)) || intents(store, m as Target).length) continue;
      const closed = old.closed_at != null;
      // A retried resume asks again: the given-up start's result goes, so the standing wish starts it.
      if (retries.has(m.id)) store.upsert("members", { id: m.id }, { want_result: null });
      store.upsert("pause_members", key, { generation: crypto.randomUUID(), state: closed ? "resuming" : "active", resumed_at: at,
        closed_at: closed ? old.closed_at : null, reason: closed ? "awaiting fresh placement" : null, acknowledged_at: null });
    }
    // Relay delivery clocks count active time, never time the recipient was intentionally absent.
    for (const m of affected.filter((m) => m.role === "lead" && !paused(store, m as Target))) thawRelay(store, String(m.project), String(m.squad), at);
    store.event("pause_resumed", { project: t.project, squad: t.squad, payload: t });
    return { ...projection(store, t), changed: true };
  });
}

// A member's effective state (U151), the one read `ds members`, the board and the decider share. In
// order: its squad archived (gone or closed) -> archived; its squad suspended -> suspended; an open
// pause intent on the member, its squad or its project -> paused; else its own wish (running, stopped,
// archived; null when it has none). `own` is that wish, `why` names the row that decided.
// why "archive-debrief": the squad is archiving and its Lead stays on its own wish while the final-debrief
// step is open (debriefHold, squad/archive-debrief.ts); the decider never starts or restarts it then.
export type Effective = { state: string | null; own: string | null; why: "squad" | "pause" | "own" | "archive-debrief" };
export function effective(store: Store, m: Row): Effective {
  const own = m.want == null ? null : m.want === "gone" ? "archived" : String(m.want);
  if (own === "archived") return { state: own, own, why: "own" };
  const squad = m.role === "studio" ? null : store.get("squads", { project: m.project, topic: m.squad });
  const ended = (v: unknown) => ["gone", "closed", "archived"].includes(String(v ?? ""));
  if (ended(squad?.want) || ended(squad?.status)) {
    return debriefHold(store, m, squad) ? { state: own, own, why: "archive-debrief" } : { state: "archived", own, why: "squad" };
  }
  // The squad's wish wins over its status: a resume in flight (want running, status suspended) is not suspended.
  if ((squad?.want ?? squad?.status) === "suspended") return { state: "suspended", own, why: "squad" };
  if (intents(store, { project: String(m.project), squad: String(m.squad), role: String(m.role), suffix: String(m.suffix ?? "") }).length) return { state: "paused", own, why: "pause" };
  return { state: own, own, why: "own" };
}

export function freezeRelay(store: Store, project: string, squad: string, at: number): void {
  store.db.run("UPDATE relayed SET paused_at = ? WHERE project = ? AND squad = ? AND forwarded_at IS NULL AND paused_at IS NULL", [at, project, squad]);
}
export function thawRelay(store: Store, project: string, squad: string, at: number): void {
  store.db.run("UPDATE relayed SET seen_at = seen_at + MAX(0, ? - paused_at), next_at = CASE WHEN next_at IS NULL THEN NULL ELSE next_at + MAX(0, ? - paused_at) END, paused_at = NULL WHERE project = ? AND squad = ? AND paused_at IS NOT NULL", [at, at, project, squad]);
}

// Resolve the recipient, including row-less starts and script fan-outs. The sender's scope is not the destination.
export function actionTargets(store: Store, a: Action): Target[] {
  if (CANCEL_KINDS.has(a.kind)) return [];
  const p = (a.payload ?? {}) as Row;
  let raw: Row = p;
  if (p.payload) { try { raw = JSON.parse(String(p.payload)) as Row; } catch {} }
  const argv = Array.isArray(raw.argv) ? raw.argv.map(String) : [];
  const words: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (["--project", "--from"].includes(argv[i])) i++;
    else if (argv[i] !== "--ruling") words.push(argv[i]);
  }
  const projectFlag = argv.indexOf("--project"), project = a.project || (projectFlag >= 0 ? argv[projectFlag + 1] : "");
  if (a.kind === "reply" && p.id) {
    const q = store.get("relayed", { msg_id: String(p.id) });
    const from = String(q?.from_handle ?? "");
    const recipient = from.startsWith("dispatch:")
      ? store.db.query("SELECT project, wt FROM observed_workers WHERE dispatch_id = ?").get(from.slice(9)) as Row | null
      : store.db.query("SELECT project, wt FROM observed_terminals WHERE handle = ? ORDER BY (project = ?) DESC, (gone_at IS NULL) DESC, observed_at DESC").get(from, project) as Row | null;
    if (recipient) return [targetOf(store, { project: String(recipient.project), member: String(recipient.wt) })];
  }
  if (a.kind === "answer" && a.squad && p.id) {
    const q = store.db.query("SELECT doc FROM questions WHERE project = ? AND squad = ? AND id = ? ORDER BY seq DESC LIMIT 1").get(project, a.squad, String(p.id)) as Row | null;
    let entry: Row = {}; try { entry = JSON.parse(String(q?.doc ?? "{}")); } catch {}
    if (entry.asker === "loop" && entry.unit) {
      const unit = store.get("units", { project, squad: a.squad, slug: String(entry.unit) });
      const lead = store.get("squads", { project, topic: a.squad })?.lead_wt;
      return [unit?.builder_wt, lead].filter(Boolean).map((wt) => targetOf(store, { project, squad: a.squad, member: String(wt) }));
    }
  }
  // A Studio request is carried out by the Studio, which pause leaves running; only a restart acts on the paused squad.
  if (a.kind === "studio") return p.action === "restart" ? [{ project, squad: (p.topic as string | null) ?? a.squad }] : [];
  if (a.kind === "alert" && !a.member && a.squad && a.subject.startsWith(`${a.squad}.`)) {
    const name = a.subject.slice(a.squad.length + 1), role = name.split("-")[0];
    return [{ project, squad: a.squad, role, suffix: name === role ? "" : name.slice(role.length + 1) }];
  }
  if (["send-role", "send-peer"].includes(a.kind)) {
    const [squad, name = ""] = words, found = store.db.query("SELECT project FROM squads WHERE topic = ? AND (? = '' OR project = ?) ORDER BY id DESC").get(squad ?? "", project, project) as Row | null;
    const role = name === "lead" || name === "thinker" ? name : name.split("-")[0];
    return [{ project: String(found?.project ?? project), squad, role, suffix: name === role ? "" : name.slice(role.length + 1) }];
  }
  if (["notify-squads", "reassert-roles", "squad"].includes(a.kind)) {
    const scope = a.kind === "squad" ? a.squad : a.kind === "reassert-roles" ? words[1] : null;
    // A fan-out is held back only by a pause on its own scope; the script checks each recipient (is-paused.ts).
    if (a.kind !== "squad") return [{ project: project || words[0] || "", squad: scope }];
    return [{ project: project || words[0] || "", squad: scope }, ...(store.db.query("SELECT * FROM members WHERE project = ? AND (? IS NULL OR squad = ?) AND role != 'studio'").all(project || words[0] || "", scope ?? null, scope ?? null) as Row[]).map((m) => m as Target)];
  }
  if (["member", "role"].includes(a.kind) && p.id != null) {
    const m = store.get("members", { id: Number(p.id) }); if (m) return [m as Target];
  }
  return [targetOf(store, { project, squad: a.squad, member: a.member ?? (p.wt as string) ?? null })];
}
const controls = new Set(["board_start", "board_restart", "board_stop", "board_giveup", "config", "limits", "roles", "skills", "override", "account", "unit-action", "plan-revoke", "chat-cancel", "chat-now", "alert", "alert-clear", "lavish", "dismiss"]);
const mail = new Set(["poke", "answer", "reply", "send-role", "send-peer", "notify-squads"]);
export function deferredMail(a: Action): boolean { return mail.has(a.kind); }
export function actionVersion(store: Store, a: Action): string { return JSON.stringify(actionTargets(store, a).map((t) => version(store, t))); }
// The fence a child script checks before each mutation (check-activity.ts, exit 75), on the gate
// `childActivity` hands it: a paused target, or a version moved since the gate was made. U11c: a provider's
// removal for a squad off Orca runs in process and checks the same gate.
export type ActivityGate = { targets: Target[]; version: string; mail?: boolean; control?: Action; resume?: Action };
export function gateBlock(store: Store, gate: ActivityGate): string | null {
  if (gate.control?.kind === "pause-control") return pauseControlBlock(store, gate.control);
  if (gate.targets.some((t) => paused(store, t)) && !(gate.resume && resumeAction(store, gate.resume))) return "paused";
  return !gate.mail && JSON.stringify(gate.targets.map((t) => version(store, t))) !== gate.version ? "generation changed" : null;
}
// Every member row on the worktree has retired for good: status gone, want gone and no cancel payload.
export function retiredTree(store: Store, project: string, wt: string): boolean {
  const ms = wt ? store.db.query("SELECT status, want, want_payload FROM members WHERE project = ? AND wt = ?").all(project, wt) as Row[] : [];
  return ms.length > 0 && ms.every((m) => {
    let cancel; try { cancel = JSON.parse(String(m.want_payload ?? "{}"))?.cancel; } catch {}
    return m.status === "gone" && m.want === "gone" && !cancel;
  });
}
export function actionBlock(store: Store, a: Action): "paused" | "generation changed" | null {
  if (a.kind === "pause-control") return pauseControlBlock(store, a) ? "generation changed" : null;
  // U232: matched on the payload's stable `card`, never on the display title.
  const card = (a.payload as Row | null)?.card;
  const activityAlert = a.kind === "alert" && ["agent_broken", "poke_unanswered", "poke_not_taken"].includes(String(card));
  if (controls.has(a.kind) && !activityAlert) return null;
  const targets = actionTargets(store, a);
  const retiring = (a.kind === "role" && store.get("members", { id: (a.payload as Row | undefined)?.id })?.want === "gone")
    || a.kind === "member.close"    // U155: the close is the retirement itself, not a rival of it
    // archive-leftovers U1: a leftover's removal comes after its member retired, so a retired member (gone,
    // want gone, no cancel) is no rival of it; a live or restarting member on the tree still is.
    || (a.kind === "worktree.remove" && retiredTree(store, a.project, String((a.payload as Row | null)?.wt ?? "")));
  // U158: a suspended member's close-remove is the pause flow's own last step, so the
  // squad's pause intent must not block it (its stop phase stays the pause flow's).
  if (a.kind === "member.close" && (a.payload as Row | undefined)?.phase === "remove") return null;
  // U158: the squad lifecycle itself (create/suspend/resume/archive) is what clears its
  // own pause intent; gating it on that intent would stall resume and archive forever.
  if (a.kind === "squad") return null;
  // exposed-cleanup U2: a stop command is part of the close or archive above (they wait for it), so the
  // pause that lets them run must not hold it, or the close would wait out its bound with the stack up.
  if (a.kind === "expose.stop") return null;
  if (!retiring && targets.some(t => t.member && stopping(store, t.project, t.member))) return "generation changed";
  if (targets.some((t) => paused(store, t)) && !resumeAction(store, a)) return "paused";
  if (!mail.has(a.kind) && a.pauseVersion != null && a.pauseVersion !== JSON.stringify(targets.map((t) => version(store, t)))) return "generation changed";
  return null;
}
