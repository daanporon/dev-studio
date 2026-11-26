// reviews.ts — each dispatched unit's review state (PR overview board U4), from its Builder's git dir,
// into observed_reviews; the board splits Building by it. Host scope, every DS_LOOP_REVIEWS_S (30 s).
// It only reads: never writes, moves or deletes a file in a Builder's git dir.
//
// Per units row with status dispatched and a builder_wt (the path after `::`), the files
// bin/review/review-unit.sh keeps in that worktree's git dir:
//   ds-review-start  <epoch>\t<head sha>\t<kind>\t<pid>     only while a review's engine runs
//   ds-review-log    <epoch>\t<head sha>\t<kind>\t<reason>\t<lenses>\t<engine>   one line per run
//   ds-review        <sha>\t<epoch>\t<base>\t<actionable count>\t<engine>\tproof=1   the receipt
//   ds-review-stop   <count>\t<epoch>\t…                    proof failures in a row
// State, first match wins:
//   stopped    an open review_stopped alert for the worktree (or its squad/slug), or a stop count of 2
//   reviewing  the marker's pid is alive, started no later than the marker, and the marker is under 6h old
//   fixing     the receipt's actionable count is above 0 (since = the receipt's epoch)
//   coding     anything else
// round = the logged runs that reviewed (full, delta or delta-wide, with an engine, not a re-check
// of a saved run), plus 1 while one runs. A unit no longer dispatched, or whose worktree or git dir
// is missing, has no row. A marker left by a kill -9 is ignored through its pid, never removed.
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Observer } from "../core/plugins.ts";
import type { Row, Store } from "../core/store.ts";
import { bootTime, CLK_TCK, parseStat, readText } from "../io/proc.ts";
import { gitDir } from "../io/git-dir.ts";
import { wtPath } from "./orca.ts";
import { envInt } from "../core/tick.ts";

export const MARKER_MAX_AGE_S = 6 * 3600;
// review-unit.sh's exit-6 thresholds per failure class (ds-review-stop's 5th field; none is tooling)
export const STOP_AT: Record<string, number> = { tooling: 2, "off-script": 3 };
const START_SLACK_S = 2;           // btime and the marker's clock can read a second or two apart
const REVIEW_KINDS = new Set(["full", "delta", "delta-wide"]);

export type ReviewState = "stopped" | "reviewing" | "fixing" | "coding";
export type Review = { state: ReviewState; since: number | null; kind: string | null; round: number; findings: number | null; head: string | null };

const canon = (p: string) => { try { return realpathSync(p); } catch { return p; } };
const fields = (text: string | null) => (text ?? "").split("\n")[0].split("\t");
const int = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

// The pid is a live process that started no later than the marker was written (a reused pid started after).
export function reviewerAlive(pid: number, epoch: number, proc = "/proc"): boolean {
  const st = parseStat(readText(join(proc, String(pid), "stat")) ?? "");
  const btime = bootTime(proc);
  if (!st || btime === null) return false;
  return btime + Math.floor(st.start / CLK_TCK) <= epoch + START_SLACK_S;
}

// One worktree's review state from its git dir; `stoppedAlert` is whether an open alert names it.
export function reviewOf(gdir: string, now: number, stoppedAlert: boolean, proc = "/proc"): Review {
  const log = (readText(join(gdir, "ds-review-log")) ?? "").split("\n").map((l) => l.split("\t"));
  const rounds = log.filter((f) => REVIEW_KINDS.has(f[2]) && !/^reused /.test(f[3] ?? "") && (f[5] ?? "-") !== "-").length;
  const stop = fields(readText(join(gdir, "ds-review-stop")));
  const stopN = int(stop[0]) ?? 0;
  if (stoppedAlert || stopN >= (STOP_AT[stop[4]?.trim() ?? ""] ?? STOP_AT.tooling)) return { state: "stopped", since: int(stop[1]), kind: null, round: rounds, findings: null, head: null };
  const [mAt, mSha, mKind, mPid] = fields(readText(join(gdir, "ds-review-start")));
  const at = int(mAt), pid = int(mPid);
  if (at !== null && pid !== null && pid > 0 && now - at < MARKER_MAX_AGE_S && reviewerAlive(pid, at, proc))
    return { state: "reviewing", since: at, kind: REVIEW_KINDS.has(mKind) ? mKind : null, round: rounds + 1, findings: null, head: mSha || null };
  const [rSha, rAt, , rCount] = fields(readText(join(gdir, "ds-review")));
  const n = int(rCount);
  if (n !== null && n > 0) return { state: "fixing", since: int(rAt), kind: null, round: rounds, findings: n, head: rSha || null };
  return { state: "coding", since: null, kind: null, round: rounds, findings: null, head: null };
}

type Unit = { project: string; squad: string; slug: string; builder_wt: string };

// The worktrees an open review_stopped alert names, and the squad/slug pairs, per project.
function stoppedAlerts(store: Store): { wts: Set<string>; units: Set<string> } {
  const wts = new Set<string>(), units = new Set<string>();
  for (const r of store.db.query("SELECT project, doc FROM observed_alerts").all() as Row[]) {
    let d: Row;
    try { d = JSON.parse(String(r.doc ?? "")); } catch { continue; }
    if (!d || d.kind !== "review_stopped") continue;
    if (typeof d.wt === "string" && d.wt) wts.add(`${r.project}\0${canon(d.wt)}`);
    if (typeof d.squad === "string" && typeof d.slug === "string") units.add(`${r.project}\0${d.squad}\0${d.slug}`);
  }
  return { wts, units };
}

export function reviewsObserver(proc = "/proc"): Observer {
  return {
    name: "reviews",
    scope: "host",
    every: envInt("DS_LOOP_REVIEWS_S", 30),
    run({ store, now }) {
      const units = store.db.query(`SELECT project, squad, slug, builder_wt FROM units WHERE status = 'dispatched' AND COALESCE(builder_wt, '') != ''
        AND builder_wt NOT IN (SELECT wt FROM members WHERE wt IS NOT NULL AND host IN (SELECT name FROM hosts))`).all() as Unit[];
      const alerts = stoppedAlerts(store);
      const seen = new Map<string, Review & { wt: string }>();
      for (const u of units) {
        const path = wtPath(u.builder_wt) ?? (u.builder_wt.startsWith("/") ? u.builder_wt : null);
        if (!path || !existsSync(path)) continue;
        const gdir = gitDir(path);
        if (gdir === null) continue;
        const stopped = alerts.wts.has(`${u.project}\0${canon(path)}`) || alerts.units.has(`${u.project}\0${u.squad}\0${u.slug}`);
        seen.set(`${u.project}\0${u.squad}\0${u.slug}`, { ...reviewOf(gdir, now, stopped, proc), wt: path });
      }
      store.tx(() => {
        for (const [k, r] of seen) {
          const [project, squad, slug] = k.split("\0");
          store.upsert("observed_reviews", { project, squad, slug }, { wt: r.wt, state: r.state, since: r.since, kind: r.kind, round: r.round,
            findings: r.findings, head: r.head, observed_at: now });
        }
        for (const r of store.db.query("SELECT project, squad, slug FROM observed_reviews WHERE host = 'local'").all() as Row[]) {
          if (!seen.has(`${r.project}\0${r.squad}\0${r.slug}`))
            store.db.run("DELETE FROM observed_reviews WHERE project = ? AND squad = ? AND slug = ? AND host = 'local'", [r.project, r.squad, r.slug]);
        }
      });
    },
  };
}

export default reviewsObserver();
