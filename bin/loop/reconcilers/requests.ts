// reconcilers/requests.ts — role requests (U12, KTD1): the Lead names a role, the loop does the rest.
//
// `ds request <role> --unit <slug>` (bin/commands/request.ts) writes a member wish: want=running
// on <project>/<topic>/<role>/<suffix> with payload { why: "start", request: true, unit, spec? },
// members.phase = build, and members.tier when --tier overrides the unit's. The pieces already there
// run it: the pick reconciler (U9) keeps the member's picks row, the member fulfiller (U11) starts it
// on that pick (actuator.ts ladderPick) by role-start under add-role.sh's worktree name with
// add-role.sh's prompt (rolePrompt below), and writes the members and units facts. This reconciler
// adds, per project each tick:
//   reject   a requested role add-role.sh would refuse: want_result `rejected: …`, one
//            `request_rejected` event, and the Lead told
//   tell     the Lead is poked once when its requested member started, failed to start or was
//            rejected; the attempt goes through wake() and is retried while the Lead is busy. Sent is
//            remembered in an episodes row (subject member:<id>, kind request:tell, `<what>:<want_at>`).
//   settle   (U56) an open `switch`/`restart` request file (requests/<target>/<topic>.<who>-<n>.txt)
//            whose member no longer exists, runs again (a restart), or (a limit switch) is no longer
//            limited is removed and its row closed with a short result; of several open for one member
//            only the newest stays. Obsolete early-switch requests are always settled.
import { paused } from "../pause/pause.ts";
import { NO_HEARTBEAT_NOTE, PR_NOTE, notesNote, withRoleNotes } from "../squad/handoff.ts";
import { standingNote } from "../drivers/types.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import { wake } from "../pause/wake.ts";
import { isLimited, memberByLabel, recovered } from "./alerts.ts";

// The roles a Lead can add (add-role.sh's list); a squad's one Lead comes with the squad.
const ROLES = ["builder", "thinker", "reviewer", "tester", "researcher"];

export function unknownRole(role: string): string | null {
  if (ROLES.includes(role)) return null;
  return role === "lead" ? "a squad has exactly one Lead; it comes with the squad, it is not requested"
    : `unknown role '${role}' (one of ${ROLES.join(", ")})`;
}

export function rolePrompt(store: Store, m: { project: string; squad: string; role: string }, spec?: string | null, extra?: string | null): string {
  const run = String(store.get("squads", { project: m.project, topic: m.squad })?.run_id ?? "");
  const state = join(store.root, m.project, "squads", `${m.squad}.json`);
  return roleSpec(m.project, m.role, m.squad, run, state, spec ?? "", extra ?? "");
}

/** ds_role_spec: a role worker's start brief — the spec (default: work the assigned unit), the extra, the
 *  no-heartbeat and notes notes, a standing role's note and a Builder's PR note. */
export function roleSpec(project: string, role: string, topic: string, run: string, state: string, spec = "", extra = ""): string {
  let s = spec || `Work the assigned unit of squad ${topic} as the ${role}. Read ${ROOT}/AGENTS.md and ${ROOT}/roles/${role}.md. Squad run=${run} state=${state}.`;
  s = withRoleNotes(role, s);
  if (extra) s += ` ${extra}`;
  s += ` ${NO_HEARTBEAT_NOTE} ${notesNote({ project, role })}${standingNote(role)}`;
  if (role === "builder") s += ` ${PR_NOTE}`;
  return s;
}

const label = (m: Row) => `${m.role}${m.suffix ? ` ${m.suffix}` : ""}`;

function tellText(what: string, m: Row): string {
  const who = label(m);
  if (what === "started") {
    const on = [m.agent, m.model].filter(Boolean).join(" ") + (m.account ? ` on account ${m.account}` : "");
    return `dev-studio loop: the ${who} you requested has started${on ? ` (${on})` : ""} — wt ${m.wt}.`;
  }
  if (what === "rejected") return `dev-studio loop: your request for a ${who} was not started — ${String(m.want_result).replace(/^rejected: /, "")}.`;
  return `dev-studio loop: the ${who} you requested could not be started (${String(m.want_result).replace(/^failed: /, "")}); the Studio has an alert. Request it again once that is fixed.`;
}

// Close the open switch/restart requests whose situation is gone; returns how many.
export function settleRequests(ctx: TickCtx): number {
  const { store, project, now } = ctx;
  const rows = store.db.query(`SELECT id, kind, payload, created_at FROM requests WHERE project = ? AND done_at IS NULL
    AND key LIKE 'file:%' AND kind IN ('switch', 'restart') ORDER BY created_at DESC, id DESC`).all(project) as Row[];
  const kept = new Set<string>();
  let n = 0;
  for (const r of rows) {
    let p: { file?: string; text?: string };
    try { p = JSON.parse(String(r.payload)); } catch { continue; }
    const f = p.file?.split("/").pop()?.match(/^([^.]+)\.(.+)-[0-9]+\.txt$/);
    if (!p.file || !f) continue;
    const [, squad, who] = f, m = memberByLabel(store, project, squad, who), wt = (m?.wt as string | null) ?? null;
    if (paused(store, { project, squad, member: wt })) continue;
    const created = Number(r.created_at), cause = String(p.text ?? "").match(/^restart .*? \((.*?) since /)?.[1];
    const why = r.kind === "switch" && String(p.text ?? "").includes("(early, while idle") ? "early switching removed"
      : !m ? "member no longer exists"
      : r.kind === "restart" && cause && recovered(store, project, wt, cause, created) ? "member runs again"
      : r.kind === "switch" && !isLimited(store, project, m, now) ? "member no longer limited"
      : kept.has(`${squad}.${who}`) ? "superseded by a newer request" : null;
    if (!why) { kept.add(`${squad}.${who}`); continue; }
    try { rmSync(join(store.root, p.file), { force: true }); } catch { /* gone or unwritable: the row still closes */ }
    store.tx(() => {
      if (store.db.run("UPDATE requests SET done_at = ?, result = ? WHERE id = ? AND done_at IS NULL", [now, why, Number(r.id)]).changes) {
        store.event("request_settled", { project, squad, member: wt ?? who, payload: { id: r.id, kind: r.kind, file: p.file, why } });
        n++;
      }
    });
  }
  return n;
}

export function run(ctx: TickCtx): Action[] {
  const { store, project, now: t } = ctx, out: Action[] = [];
  settleRequests(ctx);

  const rows = store.db.query(`SELECT * FROM members WHERE project = ? AND want = 'running' AND COALESCE(status, '') != 'gone' AND json_valid(want_payload)
    AND json_extract(want_payload, '$.request') = 1 ORDER BY id`).all(project) as Row[];
  for (const m of rows) {
    if (paused(store, m as { project: string })) continue;
    const id = Number(m.id), squad = String(m.squad), who = (m.wt as string | null) ?? `${m.role}${m.suffix ? `/${m.suffix}` : ""}`;
    const bad = m.want_result == null ? unknownRole(String(m.role)) : null;
    if (bad) {
      store.tx(() => {
        if (store.setIf("members", id, "want_result", `rejected: ${bad}`, null))
          store.event("request_rejected", { project, squad, member: who, payload: { id, role: m.role, suffix: m.suffix, reason: bad } });
      });
      m.want_result = `rejected: ${bad}`;
    }
    const res = m.want_result == null ? "" : String(m.want_result);
    const what = res.startsWith("rejected") ? "rejected" : res.startsWith("failed") ? "failed" : res && m.status === "running" ? "started" : null;
    if (!what) continue;
    const key = { project, subject: `member:${id}`, kind: "request:tell" }, ep = `${what}:${m.want_at}`;
    const seen = store.get("episodes", key);
    if (seen?.episode_key === ep && seen.state === "sent") continue;
    const lead = store.get("squads", { project, topic: squad })?.lead_wt as string | null;
    if (!lead) continue;
    const w = wake(ctx, lead, tellText(what, m), `request-${what}`, `${id}:${m.want_at}`);
    out.push(...w.actions);
    if (w.status === "sent") store.upsert("episodes", key, { squad, episode_key: ep, state: "sent", count: 1, started_at: t, ended_at: t, source: "loop", observed_at: t });
  }
  return out;
}

const reconciler: Reconciler = { name: "requests", run };
export default reconciler;
