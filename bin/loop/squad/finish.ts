// finish.ts — the finish record (orca-backend-alternatives U3, migration 0052): one `finishes` row each
// time a worker ends its work. `ds finish` (a Tester's or Researcher's verdict) and finish-unit.sh (a
// Builder's PR, --no-pr or --failed end) write it before worker_done; it is the backend-neutral signal
// that will replace worker_done. The loop reads nothing here yet. A row is keyed by its writer's
// idempotency key, so a replayed or re-run finish writes no second row.
import { createHash } from "node:crypto";
import { now, type Row, type Store } from "../core/store.ts";
import { redact } from "../core/redact.ts";
import { roleName, splitRole } from "../messages/messages.ts";

export const OUTCOMES = ["ok", "failed", "no-pr", "verdict"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const isOutcome = (v: string): v is Outcome => (OUTCOMES as readonly string[]).includes(v);

export type Member = { project: string; squad: string; role: string; suffix: string };
export type Finish = { member: Member; unit: string | null; outcome: Outcome; body: string; gen?: string | null; wt?: string | null; key?: string };

/** `<project>/<squad>/<role[-suffix]>` (the DS_MEMBER shape) → its parts; null when it is not one. */
export function parseMember(m: string): Member | null {
  const parts = m.split("/");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
  const r = splitRole(parts[2]);
  return r ? { project: parts[0], squad: parts[1], ...r } : null;
}
export const memberName = (m: Member): string => `${m.project}/${m.squad}/${roleName(m.role, m.suffix)}`;

/** The default key: the same member, unit, generation, outcome and text is the same finish. */
export function finishKey(f: Finish): string {
  const h = createHash("sha1");
  for (const p of [f.unit ?? "-", f.gen ?? "", f.outcome, f.body]) h.update(p + "\0");
  return `finish:${memberName(f.member)}:${h.digest("hex").slice(0, 12)}`;
}

/** side-loop-host U7 (KTD12): the member's current generation when a finish carrying `gen` is not it, else null.
 *  A member with no generation on its row (a start Orca typed itself) and a finish with none are not checked. */
export function staleGen(s: Store, f: Finish): string | null {
  if (!f.gen) return null;
  const m = s.db.query("SELECT gen FROM members WHERE project = ? AND squad = ? AND role = ? AND COALESCE(suffix, '') = ? AND COALESCE(status, '') != 'gone' ORDER BY id DESC")
    .get(f.member.project, f.member.squad, f.member.role, f.member.suffix) as Row | null;
  return m?.gen && String(m.gen) !== f.gen ? String(m.gen) : null;
}

/** Write one finish row (and a `finish_recorded` event); the same key again returns the row it wrote, created false.
 *  A finish from a replaced generation throws ("you were replaced") and writes nothing. */
export function recordFinish(s: Store, f: Finish, at = now()): { created: boolean; row: Row } {
  if (!isOutcome(f.outcome)) throw new Error(`finish: outcome is one of ${OUTCOMES.join(", ")}, not '${f.outcome}'`);
  if (!f.body.trim()) throw new Error("finish: the body is empty");
  if (staleGen(s, f)) throw new Error(`finish: you were replaced (generation ${f.gen} is not ${memberName(f.member)}'s current one); no finish recorded`);
  const key = f.key ?? finishKey(f);
  const had = s.get("finishes", { key });
  if (had) return { created: false, row: had };
  const member = memberName(f.member), unit = f.unit || null, gen = f.gen || null;
  s.fact("finish_recorded", [{ table: "finishes", key: { key }, set: {
    project: f.member.project, squad: f.member.squad, member, wt: f.wt ?? null, unit, gen, outcome: f.outcome, body: redact(f.body), at,
  } }], { project: f.member.project, squad: f.member.squad, unit: unit ?? undefined, member: f.wt ?? undefined,
    payload: { key, member, outcome: f.outcome, ...(unit ? { unit } : {}), ...(gen ? { gen } : {}) } });
  return { created: true, row: s.get("finishes", { key }) as Row };
}

/** The finish rows, newest first, narrowed by project, squad or member. */
export function listFinishes(s: Store, o: { project?: string; squad?: string; member?: string; limit?: number } = {}): Row[] {
  const where: string[] = [], args: (string | number)[] = [];
  if (o.project) { where.push("project = ?"); args.push(o.project); }
  if (o.squad) { where.push("squad = ?"); args.push(o.squad); }
  if (o.member) { where.push("member = ?"); args.push(o.member); }
  args.push(o.limit ?? 50);
  return s.db.query(`SELECT * FROM finishes${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args) as Row[];
}

/** One line per row for `ds finish list`. */
export function finishLine(r: Row): string {
  const when = new Date(Number(r.at) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const body = String(r.body).split("\n")[0].slice(0, 100);
  return `#${r.id}  ${when}  ${r.member}  ${r.unit ?? "-"}  ${r.outcome}  gen=${r.gen ?? "-"}  ${body}`;
}
