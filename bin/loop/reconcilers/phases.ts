// phases.ts — the build and babysit phases (U22). A Builder whose unit's PR is open is done building:
// the loop restarts it fresh, on the ladder's babysit row, to take the PR to merge-ready.
//
// Per project each tick, a Builder member gets ONE phase change to `babysit` when
//   - its unit (units.builder_wt = its worktree) is dispatched and the unit's PR reads OPEN
//     (observed_prs, by <owner/name>#<n> else <topic>/<slug>),
//   - its phase is `build` or NULL, it is not gone, and no start of it is pending,
//   - it is idle at its prompt (observed_workers `idle` or `done`) for DS_LOOP_PHASE_IDLE_S (120 s),
//   - it has nothing undelivered: no unread message, no unverified poke or brief (deliveries
//     `accepted`), no poke action pending, no open poke request, not poked this tick,
//   - it is not limited (the limits reconciler owns it) and has no active override (the loop never
//     moves an overridden member),
//   - the ship mode is not local-only (no PR there).
// The change is one setIf of members.phase (build|NULL -> babysit) and one `member_phase` event
// naming the unit, PR and the babysit row's model. The decider (switches.ts: the phase row) stops
// it when idle; the start's pick (actuator.ts ladderPick) reads `builder-<tier>-babysit`
// (roles.conf), else `builder-<tier>`, else `builder`, and briefs it fresh (phasePrompt). The
// member's tier is set from its unit's when it has none (untagged = hard), so the ladder finds
// the tiered row whatever the member's suffix.
// A member in `babysit` is never phased again; a new unit for its worktree starts in `build`
// (`ds request` writes phase build, bin/commands/request.ts). U154: this only sets the phase
// fact and its event; the decider (switches.ts) stops the member when idle, and the start picks
// the babysit row and briefs it fresh. Monotonic: babysit never goes back to build on the same
// member row, so a closed and reopened PR causes no second restart.
import { lock } from "../squad/member-state.ts";
import { paused, intents } from "../pause/pause.ts";
import { join } from "node:path";
import { NO_HEARTBEAT_NOTE, notesNote, PR_NOTE } from "../squad/handoff.ts";
import { ladder, overrideOf, shipMode } from "../capacity/pick.ts";
import { baseUpdate, num } from "./lifecycle.ts";
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { ROOT, type Row, type Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";

export const BABYSIT = "babysit";
export const BUILD = "build";
const idleS = () => envInt("DS_LOOP_PHASE_IDLE_S", 120);

// Monotonic (U154): babysit never goes back to build on the same member row. Guards every phase
// write (syncPhase, picks.ts), so a closed and reopened PR causes no second restart; a new unit
// is a new member row, which starts in build.
export function phaseMayWrite(m: Row, phase: string): boolean {
  return !(String(m.phase ?? "") === BABYSIT && phase === BUILD);
}

// U92: the one phase-from-reality function every restart path uses. A Builder whose unit
// has an open PR is in babysit, else build. A recorded PR with no observed row yet counts
// as open (it was just opened); a merged/closed/gone observed row does not.
export function phaseFor(store: Store, project: string, m: { role?: unknown; squad?: unknown; suffix?: unknown; wt?: unknown }): string {
  if (String(m.role ?? "") !== "builder") return BUILD;
  const wt = String(m.wt ?? ""), suffix = String(m.suffix ?? "");
  const u = (wt ? store.db.query("SELECT * FROM units WHERE project = ? AND squad = ? AND builder_wt = ? ORDER BY id DESC").get(project, String(m.squad ?? ""), wt)
    : null) ?? (suffix ? store.db.query("SELECT * FROM units WHERE project = ? AND squad = ? AND slug = ? ORDER BY id DESC").get(project, String(m.squad ?? ""), suffix) : null) as Row | null;
  if (!u || u.pr == null || String(u.pr) === "") return BUILD;
  const n = num(u.pr);
  if (n === null) return BUILD;
  const squad = store.get("squads", { project, topic: String(m.squad ?? "") });
  if (!squad) return BABYSIT;
  const pr = prRow(store, project, squad, String(u.slug), n);
  if (!pr) return BABYSIT;
  return pr.state === "OPEN" && pr.gone_at == null ? BABYSIT : BUILD;
}

// Write the reality phase to members.phase first (U92 (1)); returns the phase.
export function syncPhase(store: Store, project: string, m: Row): string {
  if (intents(store, m as { project: string }).length) return String(m.phase ?? BUILD);
  const phase = phaseFor(store, project, m);
  if (String(m.role ?? "") !== "builder" || (m.phase ?? null) === phase) return phase;
  if (!phaseMayWrite(m, phase)) return String(m.phase);   // monotonic: babysit never goes back
  if (store.setIf("members", Number(m.id), "phase", phase, (m.phase as string | null) ?? null)) {
    store.event("member_phase", { project, squad: String(m.squad), unit: (m.suffix as string | null) ?? null, member: (m.wt as string | null) ?? null,
      payload: { phase, was: m.phase ?? null, unit: m.suffix ?? null, via: "restart" } });
  }
  return phase;
}

// The unit's open PR head, base and url for a fresh babysit brief (nulls when unknown).
export function unitPrHead(store: Store, project: string, m: Row): { head: string | null; base: string | null; url: string | null } {
  const none = { head: null, base: null, url: null };
  const wt = String(m.wt ?? ""), suffix = String(m.suffix ?? "");
  const u = (wt ? store.db.query("SELECT * FROM units WHERE project = ? AND squad = ? AND builder_wt = ? ORDER BY id DESC").get(project, String(m.squad ?? ""), wt)
    : null) ?? (suffix ? store.db.query("SELECT * FROM units WHERE project = ? AND squad = ? AND slug = ? ORDER BY id DESC").get(project, String(m.squad ?? ""), suffix) : null) as Row | null;
  if (!u || u.pr == null || String(u.pr) === "") return none;
  const n = num(u.pr);
  if (n === null) return none;
  const squad = store.get("squads", { project, topic: String(m.squad ?? "") });
  if (!squad) return none;
  const pr = prRow(store, project, squad, suffix, n);
  if (!pr || pr.state === "MERGED" || pr.state === "CLOSED" || pr.gone_at != null) return none;
  const tree = store.get("observed_worktrees", { project, wt });
  return {
    head: (pr.head as string | null) ?? ((tree?.branch as string | null) ?? null),
    base: (pr.base as string | null) ?? null,
    url: (pr.url as string | null) ?? null,
  };
}

// The unit's PR row: by <owner/name>#<n> (the squad's repo in config), else the unit-keyed ref.
export function prRow(store: Store, project: string, squad: Row, slug: string, n: number): Row | null {
  const nwo = (store.get("config", { project, file: "github", key: `repo:${squad.repo}` })?.value as string) || null;
  return (nwo && store.get("observed_prs", { project, ref: `${nwo}#${n}` }))
    || (store.db.query("SELECT * FROM observed_prs WHERE project = ? AND ref = ? AND pr = ?").get(project, `${squad.topic}/${slug}`, n) as Row | null);
}

// Anything the member was sent that it has not taken in yet.
function undelivered(ctx: TickCtx, wt: string, w: Row): boolean {
  const { store, project } = ctx;
  if (ctx.poked.has(wt) || Number(w.unread ?? 0) > 0) return true;
  const q = (sql: string) => (store.db.query(sql).get(project, wt) as { n: number }).n > 0;
  return q("SELECT COUNT(*) AS n FROM deliveries WHERE project = ? AND member = ? AND state = 'accepted'")
    || q("SELECT COUNT(*) AS n FROM episodes WHERE project = ? AND subject = ? AND kind = 'action:poke' AND state IN ('pending', 'running')")
    || q("SELECT COUNT(*) AS n FROM requests WHERE project = ? AND member = ? AND kind = 'poke' AND done_at IS NULL");
}

// The babysitter's brief: self-contained, since the conversation that built the unit does not come along.
export function babysitPrompt(store: Store, p: { project: string; squad: string; slug: string; pr: number; url: string | null; branch: string | null;
  base: string | null; wt: string; run: string | null }): string {
  const { project, squad, slug, pr } = p, bin = `${ROOT}/bin`;
  const journal = join(store.root, project, "journals", `${squad}-builder-${slug}.md`);
  const state = join(store.root, project, "squads", `${squad}.json`);
  const ask = p.run ? `\`${bin}/role/orch.sh ask ${p.run} "<question>"\`` : `\`${bin}/role/orch.sh ask <squad-run> "<question>"\``;
  const base = p.base ? `origin/${p.base}` : "origin/<the PR's base branch>";
  return [
    `You are the babysitter Builder of unit ${slug} in squad "${squad}" (project ${project}).`,
    `The unit is built and its PR is open; you take it to merge-ready on a fresh session — the conversation that built it did not come along.`,
    `Unit: ${slug}. Branch: ${p.branch ?? "(this worktree's branch)"}. PR: #${pr}${p.url ? ` (${p.url})` : ""}. Worktree: ${p.wt}.`,
    `Journal: ${journal} — read it first (\`${bin}/role/journal.sh ${project} ${squad} builder-${slug} briefing\`) and add a keep at each checkpoint (\`… add keep "<what>" "<why>"\`).`,
    `Re-read ${ROOT}/AGENTS.md for messages and the journal. Your job is PR #${pr} and nothing more:`,
    `make its checks green (read a failure with \`gh run view --job <id> --log-failed\`);`,
    `answer its review threads (resolve one only after you pushed a change that addresses it; a finding you think wrong or out of scope gets a reply, stays open, and goes to the Lead);`,
    baseUpdate(store, project) === "rebase"
      ? `rebase onto its base on a conflict;`
      : `merge ${base} in (not a rebase) on a conflict, with the command the repo's AGENTS.md names if it names one, resolve, push;`,
    `after each fix, commit, push, and run \`${bin}/review/review-unit.sh ${project} ${base}\` in the background (setsid nohup, log in your scratchpad), then fix only the findings in blocking-findings.json (path on its stderr) and copy each finding in noted-findings.json into the PR body under "Review notes (not fixed)", keeping earlier rounds' notes without another fix round;`,
    `when the loop pokes you that the PR is merge-ready, run \`${bin}/role/finish-unit.sh ${state} ${slug}\` — never merge, never send worker_done by hand.`,
    `Do not poll GitHub: the loop reads the PR and pokes you on each change; stop at your prompt between pokes.`,
    `Anything beyond a fix — a design question, a disputed finding, changes requested, a check broken on the base — ask the Lead with ${ask} instead of changing code.`,
    PR_NOTE, NO_HEARTBEAT_NOTE, notesNote({ project, role: "builder" }),
    p.run ? `Squad run=${p.run}.` : "",
  ].filter(Boolean).join(" ");
}

export function run(ctx: TickCtx): Action[] {
  const { store, project, now: at } = ctx;
  // A member with no wish, or a running one the loop has acted on (not pending, not failed, not
  // stopped) and no lifecycle act on it under way (member-state.ts lock, U152).
  const units = store.db.query(`SELECT u.slug AS unit_slug, u.pr AS unit_pr, u.tier AS unit_tier, m.* FROM units u JOIN members m
      ON m.project = u.project AND m.squad = u.squad AND m.wt = u.builder_wt
    WHERE u.project = ? AND u.status = 'dispatched' AND COALESCE(u.pr, '') != '' AND m.role = 'builder'
      AND COALESCE(m.phase, 'build') = 'build' AND COALESCE(m.status, '') NOT IN ('gone', 'closed')
      AND (m.want IS NULL OR (m.want = 'running' AND m.want_result IS NOT NULL AND m.want_result NOT LIKE 'failed%'))
    ORDER BY u.squad, u.ord IS NULL, u.ord, u.id`).all(project) as Row[];
  for (const r of units) {
    if (paused(store, r as { project: string }) || lock(store, r)) continue;
    const wt = String(r.wt), slug = String(r.unit_slug), n = num(r.unit_pr);
    if (n === null) continue;
    const squad = store.get("squads", { project, topic: String(r.squad) });
    if (!squad || String(squad.status ?? "") === "closed") continue;
    if (shipMode(store, project, (squad.repo as string | null) ?? null) === "local-only") continue;
    const pr = prRow(store, project, squad, slug, n);
    if (pr?.state !== "OPEN" || pr.gone_at != null) continue;
    const w = store.db.query("SELECT * FROM observed_workers WHERE project = ? AND wt = ? AND gone_at IS NULL").get(project, wt) as Row | null;
    if (!w || (w.state !== "idle" && w.state !== "done") || typeof w.since !== "number" || at - w.since < idleS()) continue;
    if (undelivered(ctx, wt, w)) continue;
    if (Number(r.limited_until ?? 0) > at) continue;
    const lim = store.get("episodes", { project, subject: wt, kind: "limited" });
    if (lim && (lim.ended_at == null || Number(lim.ended_at) > at)) continue;
    if (overrideOf(store, r)) continue;

    const id = Number(r.id), tier = (r.tier as string | null) ?? null, useTier = tier ?? (r.unit_tier as string | null) ?? "hard";
    const lad = ladder(store, { project, role: "builder", tier: useTier, phase: BABYSIT }, (squad.repo as string | null) ?? null);
    store.tx(() => {
      if (!store.setIf("members", id, "phase", BABYSIT, r.phase ?? null)) return;
      if (tier === null) store.setIf("members", id, "tier", useTier, null);
      store.event("member_phase", { project, squad: String(r.squad), unit: slug, member: wt,
        payload: { phase: BABYSIT, was: r.phase ?? null, unit: slug, pr: n, model: lad?.rungs[0]?.model ?? null, agent: lad?.rungs[0]?.agent ?? null, row: lad?.row ?? null } });
    });
  }
  // The phase fact is the action: the decider (decide.ts, switches.ts) stops the member when idle,
  // and the start picks the babysit row and briefs it fresh (phasePrompt).
  return [];
}

export default { name: "phases", run } satisfies Reconciler;
