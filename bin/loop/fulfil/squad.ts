// fulfil/squad.ts — kind `squad` (U158): a squad wish in Bun, no script replay. The wish is the
// squads row's want (running | suspended | gone); scripts (spawn-squad.sh, suspend-squad.sh,
// close-squad.sh) only write it. This fulfiller does the squad-level work:
//   create   running with no Run: run-create + task-create (write-ahead calls under stable
//            keys, so a crash mid-create replays the same ids and gives one Run), the squads
//            row and doc, then the Lead's and the roster's always roles' member wishes —
//            the decider's starts make their worktrees, the Lead's first.
//   suspend  suspended: a squad-scope pause intent (the pause flow checkpoints each live
//            agent, closes it after 5 minutes without one, then the decider removes the
//            worktree and clears the member's wt, so resume starts it fresh).
//   resume   running on a suspended squad: back to running, manual pause intents cleared;
//            the members' standing wishes start them fresh from their journals.
//   archive  gone, once every member is closed and worktree-free (the decider/close.ts):
//            reclaim the Run's workers, drop the squad's open questions (status dropped, kept in
//            the archived JSON's dropped_questions; one card if any was blocking), move the squad
//            JSON and its plans to the archive, and take the row off the live board (status
//            closed). Branches and PRs are kept.
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alert, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { squadDoc, render } from "../db/export-json.ts";
import { rolePrompt } from "../reconcilers/requests.ts";
import { approvedPlans, REVALIDATE_WHY } from "../reconcilers/ready.ts";
import { ensureTransition, intents, type Target } from "../pause/pause.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import { spawn } from "../io/orca.ts";
import { effectiveRoster } from "../settings/roster.ts";
import { limitInt } from "../settings/limits.ts";
import { endSquad, stopsPending } from "../squad/exposed.ts";
import { debriefOn, finalDebrief, stepOf, unitsOf } from "../squad/archive-debrief.ts";
import * as questions from "../messages/questions.ts";
import type { Action } from "../core/plugins.ts";
import { payloadOf as actionPayload, type ActionPayload } from "../core/kinds.ts";

type P = ActionPayload<"squad">;
const rowOf = (x: Exec, a: Action): Row | null => {
  const id = actionPayload<"squad">(a)?.id;
  return id == null ? null : x.store.get("squads", { id });
};
const payloadOf = (r: Row): Row => { try { return JSON.parse(String(r.want_payload ?? "{}")) ?? {}; } catch { return {}; } };
const DROP_WHY = "squad archived";
const isoAt = (at: number) => new Date(at * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

// The Lead's task spec: the loop holds the Run seat, so the Lead never adopts (U159).
function leadPrompt(store: Store, r: Row): string {
  const project = String(r.project), topic = String(r.topic);
  const state = join(store.root, project, "squads", `${topic}.json`);
  const type = String(r.type ?? "feature");
  let spec = type === "testing"
    ? `testing squad for ${topic}: run the dev env, intake manual-testing observations sent to this run, triage issues, and fix them`
    : `work the topic: ${topic}`;
  if (r.framing) spec += `. Framing: ${String(r.framing)}`;
  return `You are the LEAD (coordinator) of the "${topic}" squad (${type}). The loop holds this run's seat from its own pane and starts every worker from there — never adopt it (U159). First read ${ROOT}/AGENTS.md and ${ROOT}/roles/lead.md and operate strictly as the Lead: coordinate the squad, route questions, fan out Builders from the Thinker's plan — do NOT do the implementation or run the dev env yourself (those are your roles' jobs). Squad state file: ${state}. Squad objective (context only): ${spec} Do not send heartbeats: the loop tracks liveness — message the Run only on transitions that need the Lead. Before you start work, read the notes earlier lead roles left on this project (tips, not orders): \`${ROOT}/bin/role/notes.sh ${project} lead print\`. You are a standing role: never call worker_done and never end your session, whatever the Orca brief says — stay running between turns and report through \`ds\` and send-role.sh.`;
}

// The roster's always-spawn roles (the effective roster, as pick.ts reads it: a project row
// overrides its role, the default fills the rest), Lead first.
function alwaysRoles(store: Store, project: string, type: string): string[] | null {
  const conf = effectiveRoster(store, project);
  if (!conf.has("lead")) return null;
  const out = ["lead"];
  for (const [role, value] of conf) {
    if (role === "lead") continue;
    const spawn = value.split(/\s+/)[2];
    if (spawn === "always" || (type === "testing" && role === "tester")) out.push(role);
  }
  return out;
}

export const STARTS = ["plan", "brainstorm", "ask", "investigate", "fix"];

// A feature squad's Thinker first start prompt adds the framing and, when the Studio named one, the start (U2).
export function thinkerExtra(r: Row): string {
  if (String(r.type ?? "feature") === "testing") return "";
  const start = String(payloadOf(r).start ?? "");
  const parts: string[] = [];
  if (r.framing) parts.push(`Framing: ${String(r.framing)}.`);
  if (STARTS.includes(start)) parts.push(`Studio start: ${start} — run the Start triage in roles/thinker.md from it; overrule it only with a reason.`);
  return parts.join(" ");
}

const DEFAULT_DOC = { task_id: null, run_id: null, lead_wt: null, members: [], worktrees: [], units: [], leftovers: [], devenv: null, cleanup: [], assignments: [], repo: null, host: null, framing: null, start: null, type: "feature", autonomy: "checkpoints", status: "running", waiting_on_you: [], lfg_assumptions: [], approved_plans: [], proposed_squads: [] };

// Wish the Lead and always roles running (their prompts as at create). A member that
// already carries a wish keeps it; only a wish-less one is derived.
function wishAlways(store: Store, r: Row, roles: string[], why: string): void {
  const project = String(r.project), topic = String(r.topic);
  for (const role of roles) {
    // A member that carries its own wish (stopped, archived) keeps it: resume only
    // derives a wish for one that has none.
    const live = store.resolve("member", `${project}/${topic}/${role}`, false);
    if (live?.want != null && live.want !== "running") continue;
    const prompt = role === "lead" ? leadPrompt(store, r) : rolePrompt(store, { project, squad: topic, role }, null, role === "thinker" ? thinkerExtra(r) : "");
    store.want("member", `${project}/${topic}/${role}`, "running", { payload: { why: "start", prompt }, by: "squad", why });
  }
}

// U3 (thinker-start-triage): a suspended squad's plan may be stale by the time it resumes, so each
// planned, unheld unit of an approved plan is held (the hold `set-unit-hold … on --why` writes) until
// the Thinker has checked the plan. Started units are left alone: their Builders merge main and go on.
function holdForRevalidation(store: Store, r: Row, at: number): void {
  const project = String(r.project), topic = String(r.topic);
  let approved: unknown = [];
  try { approved = (JSON.parse(String(r.doc ?? "{}")) as Row).approved_plans; } catch { /* torn doc: nothing approved */ }
  const units = store.db.query("SELECT id, slug, plan, hold, doc FROM units WHERE project = ? AND squad = ? AND status = 'planned' ORDER BY ord IS NULL, ord, id").all(project, topic) as Row[];
  // Free units, and ones still held from an earlier resume (a stale `revalidated` mark is dropped).
  const reason = (u: Row) => { try { return (JSON.parse(String(u.doc ?? "{}")) as Row).hold_reason; } catch { return undefined; } };
  const held = units.filter((u) => (!u.hold || reason(u) === REVALIDATE_WHY) && u.plan && approvedPlans(store.root, approved, String(u.plan)));
  if (!held.length) return;
  store.fact("units_held_for_revalidation", held.map((u) => {
    let doc: Row = {};
    try { doc = JSON.parse(String(u.doc ?? "{}")) ?? {}; } catch { /* rebuilt from the row */ }
    return { table: "units", key: { id: u.id }, set: { hold: 1, doc: JSON.stringify({ ...doc, hold: true, hold_reason: REVALIDATE_WHY, revalidated: undefined }), updated_at: at } };
  }), { project, squad: topic, payload: { units: held.map((u) => String(u.slug)), why: REVALIDATE_WHY } });
}

async function create(a: Action, x: Exec, r: Row): Promise<Result> {
  const { store, now: at } = x, project = String(r.project), topic = String(r.topic), id = Number(r.id);
  // U11: a squad on a contract backend (not `orca`) has no Run, task or coordinator pane: create writes its
  // doc and wishes its always-on roles, which start through the contract (core/actuator.ts contractSeat).
  const contract = String(r.backend ?? "orca") !== "orca";
  // Re-spawning an archived topic: the closed row starts over — a new Run, task, doc and
  // coordinator, and create keys scoped to this wish so no old call replays.
  if (["closed", "gone"].includes(String(r.status ?? ""))) {
    store.tx(() => {
      store.upsert("squads", { id }, { run_id: null, task_id: null, lead_wt: null, doc: null, status: null, updated_at: at });
      store.db.run("DELETE FROM coordinators WHERE project = ? AND squad = ?", [project, topic]);
    });
    r = { ...r, run_id: null, task_id: null, lead_wt: null, doc: null, status: null };
  }
  // The asker's terminal when the wish carries one (spawn-squad.sh): run-create makes it
  // the Run's first coordinator, as the Studio's did. It holds the Run only until the Lead has a
  // worktree: then seats() opens the squad's own pane and takes the Run over (U210) — a project with no Studio worktree
  // (a loop-proof root) creates its squad this way. Else the project's outside pane.
  const from = contract ? "" : String(payloadOf(r).from ?? "");
  let sender = "";
  if (from) sender = from;
  else if (!contract) try { sender = await x.act.outside(store, project, at); } catch (e) { return { retry: (e as Error).message }; }
  if (!r.run_id && !contract) {
    const o = await x.act.call(store, "run-create", [`squad: ${topic}`], { key: `squad:${id}:${r.want_at}:run-create`, project, squad: topic, member: null, sender, at });
    const run = o.out.trim().split("\n").pop() ?? "";
    if (o.code !== 0) return { retry: (o.err || o.out).trim() || "run-create failed" };
    if (!/^run_/.test(run)) return { retry: `run-create printed no run id: ${run}` };
    store.fact("squad_run", [{ table: "squads", key: { id }, set: { run_id: run, updated_at: at } }], { project, squad: topic, payload: { id, run_id: run } });
    r = { ...r, run_id: run };
  }
  if (!r.task_id && !contract) {
    const o = await x.act.call(store, "task-create", [String(r.run_id), leadPrompt(store, r), topic, ""], { key: `squad:${id}:${r.want_at}:task-create`, project, squad: topic, member: null, sender, at });
    const task = o.out.trim().split("\n").pop() ?? "";
    if (o.code !== 0) return { retry: (o.err || o.out).trim() || "task-create failed" };
    if (!/^task_/.test(task)) return { retry: `task-create printed no task id: ${task}` };
    store.fact("squad_task", [{ table: "squads", key: { id }, set: { task_id: task, updated_at: at } }], { project, squad: topic, payload: { id, task_id: task } });
    r = { ...r, task_id: task };
  }
  const roles = alwaysRoles(store, project, String(r.type ?? "feature"));
  if (!roles) return { failed: `no lead in the roles.conf roster for ${project}` };
  // The asker held the Run at creation: record it as the squad's sender, so the first
  // member starts (which have no Lead worktree to open a pane in yet) send from it.
  if (from && !store.get("coordinators", { project, squad: topic })?.handle)
    store.upsert("coordinators", { project, squad: topic }, { run_id: String(r.run_id), handle: from, created_at: at, bound_at: at });
  store.tx(() => {
    if (!r.doc) store.upsert("squads", { id }, { doc: JSON.stringify({ ...DEFAULT_DOC, type: String(r.type ?? "feature"), autonomy: String(r.autonomy ?? "checkpoints"), repo: (r.repo as string) ?? null, host: (r.host as string) ?? null, framing: (r.framing as string) ?? null, start: STARTS.includes(String(payloadOf(r).start)) ? String(payloadOf(r).start) : null }), status: "running", updated_at: at });
    else if (r.status !== "running") store.upsert("squads", { id }, { status: "running", updated_at: at });
  });
  r = store.get("squads", { id })!;
  wishAlways(store, r, roles, "squad create");
  const made = contract ? `on ${String(r.backend)}` : `run ${String(r.run_id)}`;
  store.fact("wish_done", [{ table: "squads", key: { id }, set: { status: "running", want_result: `done: ${made} created; ${roles.join(", ")} wished running`, updated_at: at } }],
    { project, squad: topic, payload: { subject: "squad", id, want: "running", result: made } });
  return { done: true, result: { run: r.run_id, task: r.task_id, roles } };
}

function membersOf(store: Store, r: Row): Row[] {
  return store.db.query(`SELECT * FROM members WHERE project = ? AND squad = ? AND COALESCE(status, '') != 'gone'
    AND id = (SELECT MAX(id) FROM members m2 WHERE m2.project = members.project AND m2.squad = members.squad AND m2.role = members.role AND m2.suffix = members.suffix)
    ORDER BY id`).all(String(r.project), String(r.topic)) as Row[];
}

async function archive(a: Action, x: Exec, r: Row): Promise<Result> {
  const { store, now: at } = x, project = String(r.project), topic = String(r.topic), id = Number(r.id);
  if (membersOf(store, r).some((m) => m.wt != null)) return { wait: "members still have worktrees" };
  // exposed-cleanup U2: every entry of the squad ends and its stop commands run before it archives.
  endSquad(store, project, topic, at);
  const stops = stopsPending(store, { project, squad: topic }, at, limitInt(store, project, "expose_stop_s", 90));
  if (stops.length) return { wait: `stop commands: ${stops.join(", ")}` };
  if (r.run_id) await x.act.orca.run("worker-reclaim", [String(r.run_id)], { env: x.act.childActivity(x.store, a) });
  store.db.run("UPDATE pause_intents SET cleared_at = ? WHERE project = ? AND squad = ? AND scope = 'squad' AND cleared_at IS NULL", [at, project, topic]);
  // Registered cleanup commands (squad-state add-cleanup) stop detached stacks the squad
  // started, as close-squad.sh ran them. They run before the state moves to the archive.
  // A command that already ran as an entry's stop command (stop_state done) is not run again.
  const cleanup = (squadDoc(store, project, topic)?.cleanup ?? []) as unknown[];
  const stopped = new Set((store.db.query("SELECT DISTINCT stop_cmd FROM exposed WHERE project = ? AND squad = ? AND stop_state = 'done'").all(project, topic) as { stop_cmd: string }[]).map((x) => x.stop_cmd));
  for (const cmd of cleanup) if (typeof cmd === "string" && cmd && !stopped.has(cmd))
    await spawn(["sh", "-c", cmd], { ...x.act.childActivity(x.store, a) }, 120_000);
  // morning-brief-stale-items U2: the squad's open questions are dropped, never left open on a closed squad
  // (no board shows them, and the brief would carry them for ever). A blocking one gets one Needs-you card,
  // raised before the drop so a failed card retries the archive; the same id on a replay replaces it.
  const open = questions.pending(store, project, topic), blocking = open.filter((q) => q.blocking === 1);
  if (blocking.length) {
    const lines = blocking.map((q) => `- ${String(q.title ?? q.question ?? q.id)} (asked by ${String(q.asker ?? "?")})`);
    const o = await alert(store, project, `archive-questions-${topic}`, String(r.want_at),
      `The squad was archived with ${blocking.length === 1 ? "a blocking question" : `${blocking.length} blocking questions`} still open; ${blocking.length === 1 ? "it was" : "they were"} dropped:\n${lines.join("\n")}`,
      { title: `Archived with a blocking question open: ${topic}`, option: "Seen", why: "archiving drops a squad's open questions", fields: { kind: "questions_dropped" } });
    if (o.code !== 0) return { retry: `blocking-question card: ${(o.err || o.out).trim().slice(0, 200)}` };
  }
  const dropped = open.map((q) => ({ ...(questions.entryOf(q) as Row), dropped: DROP_WHY, dropped_at: isoAt(at) }));
  const dir = join(store.root, project, "squads"), live = join(dir, `${topic}.json`);
  if (r.doc != null) {
    const doc = squadDoc(store, project, topic) ?? JSON.parse(String(r.doc));
    doc.status = "closed"; doc.closed_at = isoAt(at); doc.topic = topic;
    doc.waiting_on_you = [];
    if (dropped.length) doc.dropped_questions = [...(Array.isArray(doc.dropped_questions) ? doc.dropped_questions : []), ...dropped];
    // debrief-on-archive U1: the Lead's final debrief, else the done-time one under a line naming what it misses.
    if (debriefOn(store, project)) {
      const final = finalDebrief(doc, unitsOf(store, project, topic), stepOf(store, r));
      doc.debrief = final.debrief; doc.debrief_source = final.source;
    } else if (typeof doc.debrief === "string" && doc.debrief.trim()) doc.debrief_source = "done"; // hand-written: kept as written
    else { delete doc.debrief; delete doc.debrief_source; }
    const arch = join(store.root, project, "archive");
    mkdirSync(arch, { recursive: true });
    const stamp = isoAt(at).replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    writeFileSync(join(arch, `${topic}-${stamp}.json`), render(doc));
    try { for (const f of readdirSync(dir)) if (f.startsWith(`${topic}-`) && (f.endsWith("-plan.md") || f.endsWith("-plan.approved.md") || f === `${topic}-try-it.md`)) renameSync(join(dir, f), join(arch, f)); } catch { /* no plans */ }
  }
  try { rmSync(live, { force: true }); } catch { /* already gone */ }
  // The row's doc loses its queue in the same write, so a later questions.sync (an import, squad-state)
  // never brings the dropped questions back as new open rows.
  const rowDoc = r.doc == null ? null : (() => { try { return JSON.parse(String(r.doc)) as Row; } catch { return null; } })();
  const set: Row = { status: "closed", want_result: "done: archived", updated_at: at };
  if (rowDoc && Array.isArray(rowDoc.waiting_on_you) && rowDoc.waiting_on_you.length) set.doc = JSON.stringify({ ...rowDoc, waiting_on_you: [] });
  store.tx(() => {
    questions.drop(store, project, topic, DROP_WHY);
    store.fact("wish_done", [{ table: "squads", key: { id }, set }],
      { project, squad: topic, payload: { subject: "squad", id, want: "gone", result: "archived", ...(dropped.length ? { dropped_questions: dropped.length } : {}) } });
  });
  return { done: true, result: "archived" };
}

const squad: Fulfiller & { scope: "host" } = {
  name: "squad",
  scope: "host",
  kinds: ["squad"],
  run(ctx) {
    const { store } = ctx, out: Action[] = [];
    // Keep squads.lead_wt in step with the Lead member's worktree (starts set the member's wt).
    store.db.run(`UPDATE squads SET lead_wt = (SELECT wt FROM members WHERE members.project = squads.project AND members.squad = squads.topic AND role = 'lead' AND wt IS NOT NULL ORDER BY id DESC LIMIT 1), updated_at = updated_at
      WHERE EXISTS (SELECT 1 FROM members WHERE members.project = squads.project AND members.squad = squads.topic AND role = 'lead' AND wt IS NOT NULL)
        AND COALESCE(lead_wt, '') != COALESCE((SELECT wt FROM members WHERE members.project = squads.project AND members.squad = squads.topic AND role = 'lead' AND wt IS NOT NULL ORDER BY id DESC LIMIT 1), '')`);
    // A squad suspended before U158 (status already suspended, no pause intent) with a live
    // agent still gets its pause flow: emit suspend for it too, once.
    const live = store.db.query(`SELECT s.* FROM squads s WHERE s.want = 'suspended' AND s.status = 'suspended'
      AND EXISTS (SELECT 1 FROM members m JOIN observed_workers w ON w.project = m.project AND w.wt = m.wt
        WHERE m.project = s.project AND m.squad = s.topic AND COALESCE(m.status, '') != 'gone' AND w.presence = 'running')
      AND NOT EXISTS (SELECT 1 FROM pause_intents p WHERE p.scope = 'squad' AND p.project = s.project AND p.squad = s.topic AND p.cleared_at IS NULL)`).all() as Row[];
    for (const r of live) out.push({ project: String(r.project), squad: String(r.topic), subject: `squad:${r.id}`, kind: "squad", episode: `suspend-live:${r.want_at}`, payload: { id: Number(r.id), op: "suspend" } });
    const rows = store.db.query("SELECT * FROM squads WHERE want IS NOT NULL AND want_result IS NULL ORDER BY id").all() as Row[];
    for (const r of rows) {
      const base = { project: String(r.project), squad: String(r.topic), subject: `squad:${r.id}`, kind: "squad" };
      if (r.want === "running" && r.status === "suspended")
        out.push({ ...base, episode: `resume:${r.want_at}`, payload: { id: Number(r.id), op: "resume" } });
      else if (r.want === "running" && (["closed", "gone"].includes(String(r.status ?? "")) || !r.run_id || !r.task_id))
        out.push({ ...base, episode: `create:${r.want_at}`, payload: { id: Number(r.id), op: "create" } });
      else if (r.want === "suspended" && r.status !== "suspended")
        out.push({ ...base, episode: `suspend:${r.want_at}`, payload: { id: Number(r.id), op: "suspend" } });
      else if (r.want === "gone" && r.status !== "closed" && !membersOf(store, r).some((m) => m.wt != null))
        out.push({ ...base, episode: `archive:${r.want_at}`, payload: { id: Number(r.id), op: "archive" } });
    }
    return out;
  },

  stale(a, x) {
    const r = rowOf(x, a);
    if (!r || r.want == null) return true;
    // Op-aware: a pre-U158 suspended squad already carries `done: …` yet still needs its
    // suspend acted on, so the result text alone cannot mark these stale.
    const op = (a.payload as { op?: string }).op;
    if (op === "suspend") return r.want !== "suspended";
    if (op === "resume") return !(r.want === "running" && r.status === "suspended");
    if (op === "create") return r.want !== "running";
    if (op === "archive") return r.want !== "gone" || r.status === "closed";
    return /^(done|dropped)/.test(String(r.want_result ?? ""));
  },

  async exec(a, x): Promise<Result> {
    const r = rowOf(x, a);
    if (!r) return { dropped: "squad gone" };
    const op = (a.payload as { op?: string }).op;
    // A wish that still carries a script replay (written before U158) is not run again.
    if (payloadOf(r).argv) return { failed: "this squad wish carries a pre-U158 script replay; ask again" };
    if (op === "create") return create(a, x, r);
    if (op === "archive") return archive(a, x, r);
    if (op === "suspend") {
      const { store, now: at } = x;
      try { store.pause({ scope: "squad", project: String(r.project), squad: String(r.topic) }, { source: "manual", by: "suspend-squad" }); }
      catch {
        // Already suspended (a pre-U158 squad): store.pause refuses it, so write the intent
        // directly and start each member's pause transition.
        if (!intents(store, { project: String(r.project), squad: String(r.topic) }).length) {
          store.upsert("pause_intents", { scope: "squad", project: String(r.project), squad: String(r.topic), role: "", suffix: "", source: "manual" },
            { generation: crypto.randomUUID(), requested_by: "suspend-squad", requested_at: at, cleared_at: null, prerequisites: null });
          for (const m of membersOf(store, r)) if (m.want !== "gone" && m.wt) ensureTransition(store, m as Target, at);
        }
      }
      store.fact("squad_suspended", [{ table: "squads", key: { id: r.id }, set: { status: "suspended", want_result: "done: suspended; the loop checkpoints, closes and removes its worktrees", updated_at: at } }],
        { project: String(r.project), squad: String(r.topic), payload: { subject: "squad", id: r.id, want: "suspended" } });
      return { done: true, result: "suspended" };
    }
    if (op === "resume") {
      const { store, now: at } = x;
      if (String(r.type ?? "feature") === "feature") holdForRevalidation(store, r, at);
      store.upsert("squads", { id: r.id }, { status: "running", updated_at: at });
      try { store.resume({ scope: "squad", project: String(r.project), squad: String(r.topic) }); } catch { /* no pause to clear */ }
      const roles = alwaysRoles(store, String(r.project), String(r.type ?? "feature"));
      if (roles) wishAlways(store, store.get("squads", { id: r.id })!, roles, "squad resume");
      store.fact("wish_done", [{ table: "squads", key: { id: r.id }, set: { status: "running", want_result: "done: resumed; members start fresh", updated_at: at } }],
        { project: String(r.project), squad: String(r.topic), payload: { subject: "squad", id: r.id, want: "running", result: "resumed" } });
      return { done: true, result: "resumed" };
    }
    return { dropped: `unknown squad op ${op}` };
  },

  async giveUp(a, x, why) {
    const r = rowOf(x, a);
    if (r) x.store.fact("wish_given_up", [{ table: "squads", key: { id: r.id }, set: { want_result: `failed: ${why}`, updated_at: x.now } }],
      { project: String(r.project), squad: String(r.topic), payload: { subject: "squad", id: r.id, want: r.want, error: why } });
    await alert(x.store, a.project, a.subject, a.episode, `The loop could not make the ${String(r?.want ?? "?")} squad ${a.squad}: ${why}`, { title: "Lifecycle failed" });
  },
};
export default squad;
