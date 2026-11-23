// fulfil/cleanup-act.ts — kind `cleanup.act` (host-disk-cleanup U3): with host_tidy exactly `apply`,
// the loop removes one row the Host tidy card calls removable (reconcilers/cleanup.ts asks for one
// at a time per project). Before it touches anything it reads reality again (R11): the row's live
// facts, a fresh keep-set, in-use check and backend list, and judge() over them; anything short of
// `removable` keeps the row (its fresh facts are written back, so the card says why).
//   a  the pid must still carry the start time it was found with; TERM, wait, KILL (tidy.stopProcs)
//   b  removeGuarded under the Claude temp root (a session dir: under its slug dir); KTD14 again
//   c  `git worktree remove` (no force) from the clone; the branch ref stays
//   d  a git folder: as c, once the backend list shows it is no Orca worktree; an entity:
//      terminal-close-worktree, the probe again, worktree-rm (as fulfil/worktree.ts); a worktree a
//      provider made for a squad on a contract backend (U11c): no backend list is read, its terminals
//      close through the contract, the probe again, its provider removes it (no force), by path
//   e  one capped pass over the glob (tidy.removeGlobBatch, KTD9); a capped pass asks for the next
//   f  one capped pass inside each folder the trim glob matches (tidy.trimGlobBatch, investigate-disk-
//      cleanup U2); the folders themselves stay; a capped pass asks for the next, as e
// Each outcome is one event (R13): cleanup_stopped, cleanup_removed or cleanup_failed. A failure
// settles done with facts.act_error on the row, never a retry storm; the next scan tries again.
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Action } from "../core/plugins.ts";
import type { Exec, Fulfiller, Result } from "../core/actuator.ts";
import { cleanupGlobs, limit, limitInt, trimGlobs } from "../settings/limits.ts";
import { errOf, spawn } from "../io/orca.ts";
import { mangle, shellAdapter, wtPath, type PsWorktree } from "../observers/orca.ts";
import { actionBlock } from "../pause/pause.ts";
import { readCwdRaw, readUid } from "../io/proc.ts";
import { judge, keepSet, lastScan, parseFacts, refusal, type CleanupRow, type Facts } from "../reconcilers/cleanup.ts";
import type { Row, Store } from "../core/store.ts";
import { contractCloseTerminals, contractRemoveTree, contractTree, contractWt } from "../squad/removal.ts";
import { claudeTmpRoot, gitWorktrees, inUse, liveAgents, probeTree, procIndex, removeGlobBatch, removeGuarded, stopProcs, targetRef, trimGlobBatch,
  type DirReader, type InUse, type TProc } from "../io/tidy.ts";

export const CLEANUP_ACT = "cleanup.act";
export type ActPayload = { class: string; key: string; path: string | null };
export type ActOpts = {
  proc?: string; tmpRoot?: string; uid?: number; self?: number;
  ps?: () => Promise<unknown>;               // the backend's worktree list (orca.sh ps)
  inUse?: (proc: string) => InUse;
  kill?: (pid: number, sig: NodeJS.Signals) => void; waitMs?: number;
  dirs?: DirReader; batch?: number; batchMs?: number;
};

const rowOf = (store: Store, a: Action): CleanupRow | null => {
  const p = a.payload as ActPayload;
  return store.db.query("SELECT * FROM observed_cleanup WHERE project = ? AND class = ? AND key = ? AND gone_at IS NULL").get(a.project, p.class, p.key) as CleanupRow | null;
};
const exists = async (p: string | null | undefined) => { if (!p) return false; try { await lstat(p); return true; } catch { return false; } };
const git = (repo: string, ...args: string[]) => spawn(["git", "-C", repo, ...args], {}, 120_000);

async function psList(o: ActOpts): Promise<{ ps: PsWorktree[]; error: string | null }> {
  try {
    const r = await (o.ps ?? (() => shellAdapter().ps()))();
    if (!Array.isArray(r) || r.some((w) => !w || typeof (w as PsWorktree).worktreeId !== "string")) return { ps: [], error: "could not be parsed" };
    return r.length ? { ps: r as PsWorktree[], error: null } : { ps: [], error: "was empty" };
  } catch (e) { return { ps: [], error: `failed (${(e as Error)?.message ?? e})`.slice(0, 200) }; }
}

// A checkout's clone: the repo whose `git worktree list` names it (its common dir first, then the project's home clone).
async function cloneOf(store: Store, project: string, path: string): Promise<{ repo: string; t: { locked: boolean; detached: boolean } } | null> {
  const cands: string[] = [];
  const helper = path.indexOf("/.claude/worktrees/");
  if (helper > 0) cands.push(path.slice(0, helper));
  if (await exists(path)) {
    const c = await git(path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    if (c.code === 0 && c.out.trim()) cands.push(dirname(c.out.trim()));
  }
  const home = (store.db.query("SELECT home_repo FROM projects WHERE label = ?").get(project) as { home_repo: string | null } | null)?.home_repo?.replace(/^path:/, "");
  if (home) cands.push(home);
  for (const repo of new Set(cands)) {
    const t = (await gitWorktrees(repo))?.find((w) => w.path === path);
    if (t) return { repo, t };
  }
  return null;
}

// gone: nothing left to act on; kept: a live owner the scan's facts cannot show (judge() is skipped);
// proc: class a's process as just read (stopProcs checks its start time again before each signal).
type Fresh = { facts: Facts; kept?: string; proc?: TProc } | { gone: string };

// The row's facts as they are now, read the way the scan reads them.
async function refresh(store: Store, r: CleanupRow, f: Facts, o: ActOpts, use: InUse, uid: number, ps: { ps: PsWorktree[]; error: string | null }): Promise<Fresh> {
  const proc = o.proc ?? "/proc";
  switch (r.class) {
    case "a": {
      const [pid, start] = r.key.split(":").map(Number);
      const idx = procIndex(proc, o.self ?? process.pid, liveAgents(store)), p = idx.byPid.get(pid);
      if (!p || p.start !== start || p.state === "Z") return { gone: "the process is gone" };
      const cwd = readCwdRaw(proc, pid);
      if (!cwd || !r.path || !(cwd.path === r.path || cwd.path.startsWith(`${r.path}/`))) return { gone: "the process left the worktree" };
      const facts = { ...f, cwd: cwd.path, deleted: cwd.deleted, uid: readUid(proc, pid) ?? -1 };
      return idx.family.has(pid) || idx.underAgent(pid) !== null ? { facts, kept: "live member" } : { facts, proc: p };
    }
    case "b": {
      const path = r.path ?? r.key;
      const st = await lstat(path).catch(() => null);
      if (!st) return { gone: "already gone" };
      const live = (store.db.query("SELECT path FROM observed_worktrees WHERE gone_at IS NULL AND path IS NOT NULL").all() as { path: string }[]).map((w) => mangle(w.path));
      const slug = String(f.slug ?? "");
      let session: Facts = {};
      if (f.session) {
        const wt = (store.db.query("SELECT wt FROM observed_worktrees WHERE path = ?").get(f.wt ?? "") as { wt: string } | null)?.wt;
        const newest = wt ? (store.db.query("SELECT path FROM observed_transcripts WHERE wt = ? ORDER BY mtime DESC LIMIT 1").get(wt) as { path: string } | null)?.path : null;
        session = { live_session: newest ? newest.replace(/^.*\//, "").replace(/\.jsonl$/, "") : f.live_session };
      }
      // KTD14: a slug dir that a live tree's slug now names (or prefixes), or whose tree is back, is that tree's.
      // A session dir that is its tree's newest session is that session's.
      const claimed = f.session ? f.session === session.live_session : live.some((m) => slug === m || slug.startsWith(`${m}-`)) || await exists(f.wt);
      const facts = { ...f, ...session, uid: st.uid, holder: use.holder(path) };
      return claimed ? { facts, kept: "live member" } : { facts };
    }
    case "c": case "d": {
      if (r.class === "d" && f.git === false) return { facts: f };
      if (typeof f.entity === "string") {
        if (ps.error) return { facts: f };
        const w = ps.ps.find((x) => x.worktreeId === f.entity);
        if (!w) return { gone: "the backend no longer lists it" };
        const path = w.path ?? wtPath(w.worktreeId);
        const ok = await exists(path);
        return { facts: { ...f, wt: path, exists: ok, probe: ok && path ? await probeTree(path, await targetRef(path)) : null, holder: ok && path ? use.holder(path) : null } };
      }
      const path = r.path ?? r.key;
      if (r.class === "d" && ps.ps.some((w) => (w.path ?? wtPath(w.worktreeId)) === path)) return { facts: f, kept: "live member" }; // an Orca worktree now: its entity row's
      const c = await cloneOf(store, r.project, path);
      if (!c) return { gone: "git no longer lists it" };
      const ok = await exists(path);
      return { facts: { ...f, repo: c.repo, locked: c.t.locked, detached: c.t.detached, exists: ok,
        probe: ok ? await probeTree(path, await targetRef(c.repo)) : null, holder: ok ? use.holder(path) : null } };
    }
    case "e": {
      if (!cleanupGlobs(store, r.project).valid.includes(r.key)) return { gone: "the glob is no longer configured" };
      return { facts: f };
    }
    case "f": {
      if (!trimGlobs(store, r.project).valid.includes(r.key)) return { gone: "the trim glob is no longer configured" };
      return { facts: f };
    }
  }
  return { facts: f };
}

const failed = (x: Exec, a: Action, r: CleanupRow, error: string): Result => {
  x.store.tx(() => {
    x.store.event("cleanup_failed", { project: a.project, payload: { class: r.class, key: r.key, path: r.path, error } });
    x.store.db.query("UPDATE observed_cleanup SET facts = json_set(COALESCE(facts, '{}'), '$.act_error', ?) WHERE project = ? AND class = ? AND key = ?").run(error.slice(0, 300), r.project, r.class, r.key);
  });
  return { done: true, result: `failed: ${error}` };
};
// Why a row read removable, for its event (R13): the judge's rule for its class.
const why = (r: CleanupRow, f: Facts, ageH: number): string => ({
  a: f.deleted ? "runs in a deleted directory of a removed worktree" : "orphaned: no live member owns it",
  b: `untouched ${ageH}h, no live member, no open file`,
  c: "helper checkout of no live member: clean, nothing unpushed",
  d: "worktree of no live member: clean, nothing unpushed",
  e: `untouched ${ageH}h, ours, no open file`,
  f: `inside a kept cache folder: untouched ${ageH}h, ours, no open file`,
} as Record<string, string>)[r.class] ?? "removable";
const removed = (x: Exec, a: Action, r: CleanupRow, kind: "cleanup_removed" | "cleanup_stopped", payload: Record<string, unknown>): Result => {
  x.store.tx(() => {
    x.store.event(kind, { project: a.project, payload: { class: r.class, key: r.key, path: r.path, ...payload } });
    x.store.db.query("UPDATE observed_cleanup SET gone_at = ? WHERE project = ? AND class = ? AND key = ?").run(x.now, r.project, r.class, r.key);
  });
  return { done: true, result: kind === "cleanup_stopped" ? "stopped" : "removed" };
};

async function act(a: Action, x: Exec, o: ActOpts): Promise<Result> {
  const { store } = x, block = actionBlock(store, a);
  if (block) return block === "paused" ? { wait: "paused" } : { dropped: block };
  const r = rowOf(store, a);
  if (!r) return { done: true, result: "kept: the row is gone" };
  if (limit(store, a.project, "host_tidy") !== "apply") return { done: true, result: "kept: host_tidy is not apply" };
  const uid = o.uid ?? process.getuid?.() ?? -1, proc = o.proc ?? "/proc";
  const keep = keepSet(store), use = (o.inUse ?? inUse)(proc);
  // U11c: a contract squad's worktree is no Orca worktree, whatever Orca lists: no list is read for it.
  const own = r.class === "d" && typeof parseFacts(r.facts).entity !== "string" ? contractTree(store, r.path ?? r.key) : null;
  const ps = r.class === "d" && !own ? await psList(o) : { ps: [], error: null };
  const fresh = await refresh(store, r, parseFacts(r.facts), o, use, uid, ps);
  if ("gone" in fresh) {
    store.db.query("UPDATE observed_cleanup SET gone_at = ? WHERE project = ? AND class = ? AND key = ?").run(x.now, r.project, r.class, r.key);
    return { done: true, result: `kept: ${fresh.gone}` };
  }
  const tmpAgeS = limitInt(store, a.project, "cleanup_tmp_age_h", 48) * 3600;
  const j = { keep, now: x.now, refused: refusal(store, a.project, keep), psError: r.class === "d" ? ps.error : lastScan(store)?.ps_error ?? null, tmpAgeS, uid };
  const v = fresh.kept ? { verdict: fresh.kept, orphaned_since: r.orphaned_since } : judge(r, fresh.facts, j);
  if (v.verdict !== "removable") {
    store.db.query("UPDATE observed_cleanup SET facts = ?, verdict = ?, orphaned_since = ? WHERE project = ? AND class = ? AND key = ?")
      .run(JSON.stringify(fresh.facts), v.verdict, v.orphaned_since, r.project, r.class, r.key);
    return { done: true, result: `kept: ${v.verdict}` };
  }
  const f = fresh.facts, path = r.path ?? r.key, reason = why(r, f, tmpAgeS / 3600);
  switch (r.class) {
    case "a": {
      const p = fresh.proc!;
      const s = await stopProcs([p], { proc, kill: o.kill, waitMs: o.waitMs });
      if (!s.stopped.length) return failed(x, a, r, `pid ${p.pid} could not be signalled`);
      return removed(x, a, r, "cleanup_stopped", { pids: [p.pid], killed: s.killed, reason });
    }
    case "b": {
      const tmp = o.tmpRoot ?? claudeTmpRoot();
      const g = await removeGuarded(path, { root: f.session ? join(tmp, String(f.slug)) : tmp, uid, ageFloorS: tmpAgeS, now: x.now, inUse: use });
      if (!g.removed) return g.reason.startsWith("rm failed") ? failed(x, a, r, g.reason) : { done: true, result: `kept: ${g.reason}` };
      return removed(x, a, r, "cleanup_removed", { kb: g.kb, reason });
    }
    case "c": case "d": {
      if (typeof f.entity === "string") return removeEntity(a, x, r, f, reason);
      if (own) return removeContract(a, x, r, own, path, reason);
      const repo = String(f.repo);
      const rm = await git(repo, "worktree", "remove", path);
      if (rm.code !== 0) return failed(x, a, r, errOf(rm, "git worktree remove"));
      return removed(x, a, r, "cleanup_removed", { kb: r.size_kb, repo, branch: f.branch ?? null, reason });
    }
    case "e": case "f": {
      const batch = r.class === "e" ? removeGlobBatch : trimGlobBatch;
      const b = await batch(r.key, { ageS: tmpAgeS, now: x.now, inUse: use, uid, max: o.batch, maxMs: o.batchMs, dirs: o.dirs });
      store.tx(() => {
        store.event("cleanup_removed", { project: a.project, payload: { class: r.class, glob: r.key, count: b.count, kb: b.kb, sample: b.sample, capped: b.capped, reason } });
        // A capped pass leaves the row removable under a new pass number (the next episode); a full one leaves what was kept.
        const next = b.capped ? { removable: Math.max(1, Number(f.removable ?? 0) - b.count), act_pass: Number(f.act_pass ?? 0) + 1 }
          : { removable: 0, count: Math.max(0, Number(f.count ?? 0) - b.count) };
        store.db.query("UPDATE observed_cleanup SET facts = ?, size_kb = MAX(0, COALESCE(size_kb, 0) - ?) WHERE project = ? AND class = ? AND key = ?")
          .run(JSON.stringify({ ...f, ...next }), b.kb, r.project, r.class, r.key);
      });
      return { done: true, result: `removed ${b.count}${b.capped ? " (capped)" : ""}` };
    }
  }
  return { done: true, result: "kept: report only" };
}

// An Orca entity: the same steps as fulfil/worktree.ts, each one only while the project is not paused.
async function removeEntity(a: Action, x: Exec, r: CleanupRow, f: Facts, reason: string): Promise<Result> {
  const id = String(f.entity), env = x.act.childActivity(x.store, a);
  if (actionBlock(x.store, a)) return { wait: "paused" };
  await x.act.orca.run("terminal-close-worktree", [`id:${id}`], { env });
  if (actionBlock(x.store, a)) return { wait: "paused" };
  if (f.wt && await exists(f.wt)) {
    const p = await probeTree(f.wt, await targetRef(f.wt));
    if (!p || p.dirty > 0 || p.unique > 0) return failed(x, a, r, p ? `changed after its terminals closed (dirty ${p.dirty}, unpushed ${p.unique})` : "probe failed after its terminals closed");
  }
  const rm = await x.act.orca.run("worktree-rm", [`id:${id}`], { env });
  if (rm.code !== 0) return failed(x, a, r, errOf(rm, "worktree-rm"));
  return removed(x, a, r, "cleanup_removed", { kb: r.size_kb, entity: id, reason });
}

// U11c: a contract squad's worktree, as removeEntity: its terminals through the contract, then its provider.
async function removeContract(a: Action, x: Exec, r: CleanupRow, own: Row, path: string, reason: string): Promise<Result> {
  const w = { project: String(own.project), squad: String(own.squad), wt: contractWt(own), path };
  if (actionBlock(x.store, a)) return { wait: "paused" };
  const c = await contractCloseTerminals(a, x, w);
  if (c.code !== 0) return failed(x, a, r, errOf(c, "terminal.close"));
  if (actionBlock(x.store, a)) return { wait: "paused" };
  if (await exists(path)) {
    const p = await probeTree(path, await targetRef(path));
    if (!p || p.dirty > 0 || p.unique > 0) return failed(x, a, r, p ? `changed after its terminals closed (dirty ${p.dirty}, unpushed ${p.unique})` : "probe failed after its terminals closed");
  }
  const rm = await contractRemoveTree(x, w);
  if (rm.code !== 0) return failed(x, a, r, errOf(rm, "worktree remove"));
  return removed(x, a, r, "cleanup_removed", { kb: r.size_kb, provider: own.provider, branch: own.branch ?? null, reason });
}

export function cleanupAct(o: ActOpts = {}): Fulfiller {
  return {
    name: "cleanup-act",
    kinds: [CLEANUP_ACT],
    run: () => [],
    // The row went or is no longer removable since the action was asked for.
    stale: (a, x) => rowOf(x.store, a)?.verdict !== "removable",
    // Off the tick: the removal awaits the fs, git and the backend.
    exec: (a, x) => ({ background: act(a, x, o) }),
  };
}
export default cleanupAct();
