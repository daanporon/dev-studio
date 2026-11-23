// shadow-report.ts — what `ds shadow report` and `ds shadow explain` read and write (U10). The exit
// for switching to the new signals (U12): no unexplained disagreement over at least 20 finishes (at
// least 3 of them no-PR or failed) and at least 5 crashes, across at least 7 days.
import { POINTS } from "./shadow.ts";
import { now as clock, type Row, type Store } from "../core/store.ts";

export const EXIT = { finishes: 20, hard: 3, crashes: 5, days: 7 } as const;

export type Report = {
  project: string | null; since: number | null; days: number;
  points: Record<string, { counted: number; transient: number; explained: number }>;
  unexplained: { id: number; at: number; point: string; member: string; old: string; new: string }[];
  finishes: number; hard: number; crashes: number; met: boolean; short: string[];
};

const scope = (project: string | null) => (project ? " AND project = ?" : "");
// The binds after `at >= ?`: the time, then the project when there is one.
const binds = (project: string | null, ...first: number[]) => (project ? [...first, project] : first) as (string | number)[];

/** Where the shadow started (the first `shadow_started`), or null when it never ran. */
export function startedAt(store: Store, project: string | null): number | null {
  const r = store.db.query(`SELECT MIN(at) AS at FROM events WHERE kind = 'shadow_started'${scope(project)}`).get(...binds(project)) as { at: number | null };
  return r.at ?? null;
}

const explained = (store: Store) => new Set((store.db.query("SELECT json_extract(payload, '$.event') AS e FROM events WHERE kind = 'shadow_explained'").all() as { e: number }[]).map((r) => Number(r.e)));

export function report(store: Store, o: { project?: string | null; since?: number | null; now?: number } = {}): Report {
  // Nothing before the shadow's start counts (finish rows are written whether it ran or not): an
  // earlier --since starts at the shadow's start.
  const project = o.project ?? null, start = startedAt(store, project), at = o.now ?? clock();
  const since = start == null ? (o.since ?? null) : Math.max(o.since ?? start, start);
  const from = since ?? 0, ex = explained(store);
  const points: Report["points"] = Object.fromEntries(POINTS.map((p) => [p, { counted: 0, transient: 0, explained: 0 }]));
  const unexplained: Report["unexplained"] = [];
  const rows = store.db.query(`SELECT id, at, payload FROM events WHERE kind = 'shadow_disagree' AND at >= ?${scope(project)} ORDER BY id`)
    .all(...binds(project, from)) as Row[];
  for (const r of rows) {
    const p = JSON.parse(String(r.payload));
    const c = (points[p.point] ??= { counted: 0, transient: 0, explained: 0 });
    if (p.transient) { c.transient++; continue; }
    if (ex.has(Number(r.id))) { c.explained++; continue; }
    c.counted++;
    unexplained.push({ id: Number(r.id), at: Number(r.at), point: p.point, member: p.member, old: p.old, new: p.new });
  }
  const f = store.db.query(`SELECT COUNT(*) AS n, SUM(outcome IN ('no-pr', 'failed')) AS hard FROM finishes WHERE gen IS NOT NULL AND at >= ?${scope(project)}`)
    .get(...binds(project, from)) as { n: number; hard: number | null };
  const crashes = (store.db.query(`SELECT COUNT(*) AS n FROM events WHERE kind = 'shadow_crash' AND at >= ?${scope(project)}`).get(...binds(project, from)) as { n: number }).n;
  const days = since == null || start == null ? 0 : Math.max(0, (at - since) / 86400);
  const hard = Number(f.hard ?? 0), short: string[] = [];
  if (start == null) short.push("the shadow has not run");
  if (unexplained.length) short.push(`${unexplained.length} unexplained`);
  if (f.n < EXIT.finishes) short.push(`${f.n} of ${EXIT.finishes} finishes`);
  if (hard < EXIT.hard) short.push(`${hard} of ${EXIT.hard} no-PR or failed finishes`);
  if (crashes < EXIT.crashes) short.push(`${crashes} of ${EXIT.crashes} crashes`);
  if (days < EXIT.days) short.push(`${days.toFixed(1)} of ${EXIT.days} days`);
  return { project, since, days, points, unexplained, finishes: f.n, hard, crashes, met: !short.length, short };
}

export function reportText(r: Report): string[] {
  const out = [`shadow${r.project ? ` ${r.project}` : ""} since ${r.since == null ? "-" : new Date(r.since * 1000).toISOString()} (${r.days.toFixed(1)} days)`];
  for (const [p, c] of Object.entries(r.points)) out.push(`  ${p.padEnd(9)} ${c.counted} unexplained, ${c.explained} explained, ${c.transient} transient`);
  for (const u of r.unexplained) out.push(`  #${u.id} ${new Date(u.at * 1000).toISOString()} ${u.point} ${u.member}: old ${u.old}, new ${u.new}`);
  out.push(`  finishes ${r.finishes} (${r.hard} no-PR or failed), crashes ${r.crashes}`);
  out.push(r.met ? "exit: met" : `exit: not met — ${r.short.join(", ")}`);
  return out;
}

/** Record why a disagreement is not a fault of the new signals. Refuses an event that is not a counted one, or one already explained. */
export function explain(store: Store, event: number, why: string, by?: string): { ok: true; id: number } | { ok: false; error: string } {
  if (!why.trim()) return { ok: false, error: "say why" };
  const e = store.db.query("SELECT * FROM events WHERE id = ?").get(event) as Row | null;
  if (!e || e.kind !== "shadow_disagree") return { ok: false, error: `#${event} is not a shadow_disagree event` };
  const p = JSON.parse(String(e.payload));
  if (p.transient) return { ok: false, error: `#${event} is transient: it is not counted` };
  if (explained(store).has(event)) return { ok: false, error: `#${event} is already explained` };
  const id = store.fact("shadow_explained", [], { project: e.project as string | undefined, squad: e.squad as string | undefined, member: e.member as string | undefined,
    payload: { event, why: why.trim(), ...(by ? { by } : {}) } });
  return { ok: true, id };
}
