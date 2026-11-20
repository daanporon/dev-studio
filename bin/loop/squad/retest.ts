// retest.ts — two facts about a feature squad, read from loop.db alone (U238); the loop (lifecycle,
// wake) and the board (displayStatus) call the same functions, so they cannot disagree. The units
// rule itself is squad-finish.ts' settle(), shared with the board label and the Lead's tick.
//
//   allDone    settle() says `wrapping-up`: a feature squad with units, every unit done or cancelled (a
//              held unit is open work), no Tester member up, and no done unit whose PR the loop sees as
//              open right now. A done unit counts by its status: no PR, a PR merged into another or a
//              closed one don't block it, and neither does an OPEN row the loop stopped refreshing when
//              the unit went done (its observed_at is older than PR_FRESH_S).
//   retestDue  a Tester pass ended in the squad (event `tester_pass_done`, written when the loop closes a
//              finished Tester), a unit reached `done` after it, and settle() says `wrapping-up` or
//              `held-only` (held units don't hold a retest back; a Tester up does).
import type { Database } from "bun:sqlite";
import { settle, type Finish } from "./squad-finish.ts";

type Row = Record<string, unknown>;
const PR_FRESH_S = () => Number(process.env.DS_ALLDONE_PR_FRESH_S) || 600;

function repoOf(db: Database, project: string, squad: string): string | null {
  const s = db.query("SELECT repo FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Row | null;
  const c = s?.repo ? db.query("SELECT value FROM config WHERE project = ? AND file = 'github' AND key = ?").get(project, `repo:${s.repo}`) as Row | null : null;
  if (!c?.value) return null;
  try { const v = JSON.parse(String(c.value)); return typeof v === "string" ? v : null; } catch { return String(c.value); }
}

// Is this PR open as far as the loop can tell right now: an OPEN row, still in the query, read recently.
function openNow(db: Database, project: string, squad: string, slug: string, pr: number, nwo: string | null, at: number): boolean {
  const row = ((nwo && db.query("SELECT * FROM observed_prs WHERE project = ? AND ref = ?").get(project, `${nwo}#${pr}`))
    || db.query("SELECT * FROM observed_prs WHERE project = ? AND ref = ? AND pr = ?").get(project, `${squad}/${slug}`, pr)) as Row | null;
  return !!row && row.state === "OPEN" && row.gone_at == null && at - Number(row.observed_at ?? 0) <= PR_FRESH_S();
}

// The done units whose PR is open as far as the loop can tell right now (the board marks them too).
export function openPrUnits(db: Database, project: string, squad: string, at = Math.floor(Date.now() / 1000)): Set<string> {
  const nwo = repoOf(db, project, squad), out = new Set<string>();
  for (const u of db.query("SELECT slug, pr FROM units WHERE project = ? AND squad = ? AND status = 'done' AND pr IS NOT NULL").all(project, squad) as Row[])
    if (openNow(db, project, squad, String(u.slug), Number(u.pr), nwo, at)) out.add(String(u.slug));
  return out;
}

// settle() over loop.db: the squad's units (with their open PRs) and its members that are up.
export function settleIn(db: Database, project: string, squad: string, at = Math.floor(Date.now() / 1000)): Finish | null {
  const s = db.query("SELECT type FROM squads WHERE project = ? AND topic = ?").get(project, squad) as Row | null;
  if (!s) return null;
  const open = openPrUnits(db, project, squad, at);
  const units = (db.query("SELECT slug, status, hold, deps FROM units WHERE project = ? AND squad = ?").all(project, squad) as Row[])
    .map((u) => ({ ...u, pr_open: open.has(String(u.slug)) }));
  const members = db.query("SELECT role FROM members WHERE project = ? AND squad = ? AND COALESCE(status, '') != 'gone' AND COALESCE(want, '') != 'gone'").all(project, squad) as Row[];
  return settle({ type: s.type, units, members });
}

export function allDone(db: Database, project: string, squad: string, at = Math.floor(Date.now() / 1000)): boolean {
  return settleIn(db, project, squad, at)?.state === "wrapping-up";
}

export type Retest = { passAt: number; units: { slug: string; pr: number | null; at: number }[]; lastAt: number; key: string };

export function retestDue(db: Database, project: string, squad: string, at = Math.floor(Date.now() / 1000)): Retest | null {
  const fin = settleIn(db, project, squad, at);
  if (fin?.state !== "wrapping-up" && fin?.state !== "held-only") return null;
  const done = db.query("SELECT slug, pr FROM units WHERE project = ? AND squad = ? AND status = 'done'").all(project, squad) as Row[];
  const pass = db.query("SELECT MAX(at) AS at FROM events WHERE project = ? AND squad = ? AND kind = 'tester_pass_done'").get(project, squad) as { at: number | null } | null;
  if (pass?.at == null) return null;
  const since = [];
  for (const u of done) {
    const e = db.query("SELECT MAX(at) AS at FROM events WHERE project = ? AND squad = ? AND unit = ? AND kind = 'unit_done'").get(project, squad, String(u.slug)) as { at: number | null } | null;
    if (e?.at != null && e.at > pass.at) since.push({ slug: String(u.slug), pr: u.pr == null ? null : Number(u.pr), at: e.at });
  }
  if (!since.length) return null;
  since.sort((a, b) => a.slug.localeCompare(b.slug));
  return { passAt: pass.at, units: since, lastAt: Math.max(...since.map((x) => x.at)), key: `retest|${squad}|${since.map((x) => `${x.slug}#${x.pr}`).join(",")}` };
}
