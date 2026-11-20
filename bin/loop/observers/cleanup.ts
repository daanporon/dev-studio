// observers/cleanup.ts — host-disk-cleanup U2: what is left on the host, as raw facts in
// `observed_cleanup` (KTD3). It records and never judges: reconcilers/cleanup.ts writes the verdicts.
//   a  processes of this uid whose raw cwd is deleted or inside a ds-* worktree (not the loop's own
//      family, not under a live agent), attributed through observed_worktrees, then the name (KTD13)
//   b  the Claude temp root: a dir whose slug starts with a project's mangled worktree prefix and
//      cannot be a live tree's (KTD14), and the older session dirs of a live tree's slug; loose
//      files only count into the scan row (report only)
//   c  helper checkouts (`git worktree list` of each project clone, under .claude/worktrees/)
//   d  ds-<label>-* Orca entities, ds-<label>-* folders git lists but Orca does not, and ds-* folders
//      git does not list; skipped (rows kept as they were) when the backend list fails or is empty
//   e  each valid cleanup_tmp_globs entry, its parent streamed, matches folded into one row
// Host scope, every tick, with its own DS_LOOP_CLEANUP_S (3600 s) timer (KTD4): a due tick starts the
// scan off the tick (async fs, yielding every 1,000 entries or second, one scan at a time); the next
// tick that finds it finished writes it in one transaction. Rows not seen again get gone_at; a row
// that comes back starts over. Gone rows are pruned after a day. The tick that writes a scan starts its
// measuring pass (investigate-disk-cleanup U1, `measureCleanup`): every `partial` row (a walk past its
// entry budget, a class e glob that matched a folder) gets one `du -sk` per path off the tick, largest
// first, DS_LOOP_CLEANUP_DU_S (120 s) each and DS_LOOP_CLEANUP_DU_TOTAL_S (600 s) per pass; a later
// tick writes `size_kb` with facts `size_from: "du"` and `size_at`. No scan starts while it runs.
import { lstat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { cleanupGlobs, limitInt } from "../settings/limits.ts";
import type { Observer, TickCtx } from "../core/plugins.ts";
import { discoverProjects } from "../settings/projects.ts";
import { CLK_TCK, readCwdRaw, readText, readUid } from "../io/proc.ts";
import { keepSet } from "../reconcilers/cleanup.ts";
import type { Store } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { du as duSk, type Du, type DuResult } from "../io/du.ts";
import { claudeTmpRoot, gitWorktrees, globMatcher, inUse, liveAgents, procIndex, probeTree, streamDir, targetRef, treeSize, yielder,
  type DirReader, type GitTree, type InUse } from "../io/tidy.ts";
import { mangle, prefix, shellAdapter, wtPath, type PsWorktree } from "./orca.ts";

export type CleanupRow = { project: string; class: "a" | "b" | "c" | "d" | "e"; key: string; path?: string | null; pid?: number | null;
  size_kb?: number | null; mtime?: number | null; facts: Record<string, unknown> };
export type CleanupScan = { at: number; ms: number; entries: number; psError: string | null; looseCount: number; looseKb: number; rows: CleanupRow[] };
export type CleanupOpts = {
  proc?: string;                          // the /proc root
  tmpRoot?: string;                       // the Claude temp root (claudeTmpRoot())
  ps?: () => Promise<unknown>;            // the backend's worktree list (orca.sh ps)
  dirs?: DirReader;                       // streamed directory listing (KTD5)
  inUse?: (proc: string) => InUse;
  projects?: (store: Store) => string[];  // labels (discoverProjects)
  self?: number; uid?: number; host?: string;
  sizeEntries?: number;                   // lstat budget for classes c and d sizes per scan (best effort)
  tmpSizeEntries?: number;                // lstat budget for class b (Claude temp dirs) sizes per scan
  du?: Du;                                // the measuring pass's sizer (io/du.ts)
  duS?: number;                           // its per-path timeout (DS_LOOP_CLEANUP_DU_S)
  duTotalS?: number;                      // its time cap per pass (DS_LOOP_CLEANUP_DU_TOTAL_S)
};
type Wt = { project: string; wt: string; path: string; gone_at: number | null };

const ITEM_ENTRIES = 50_000;
const PRUNE_S = 86_400;

export async function scanCleanup(store: Store, at: number, o: CleanupOpts = {}): Promise<CleanupScan> {
  const t0 = performance.now(), tick = yielder(), dirs = o.dirs ?? streamDir;
  const proc = o.proc ?? "/proc", uid = o.uid ?? process.getuid?.() ?? -1, pre = prefix();
  // Two pools, so class b (its newest mtime sets the age floor) never depends on how big the helper checkouts are.
  const budget = { left: o.sizeEntries ?? envInt("DS_LOOP_CLEANUP_SIZE_ENTRIES", 500_000) };
  const tmpBudget = { left: o.tmpSizeEntries ?? envInt("DS_LOOP_CLEANUP_TMP_ENTRIES", 500_000) };
  const sizeIn = (pool: { left: number }) => (p: string) => { const b = { left: Math.min(pool.left, ITEM_ENTRIES) }, start = b.left;
    return treeSize(p, b, tick).then((s) => { pool.left -= start - b.left; return s; }); };
  const size = sizeIn(budget), tmpSize = sizeIn(tmpBudget);
  let entries = 0;
  const rows: CleanupRow[] = [];

  // Everything read from loop.db is read now, before the first await.
  const labels = (o.projects ?? ((s: Store) => discoverProjects(s.root)))(store);
  const byLen = [...labels].sort((a, b) => b.length - a.length);
  const labelOf = (name: string) => byLen.find((l) => name.startsWith(`${pre}${l}-`)) ?? null;
  const repos = new Map<string, string>(); // clone path -> label
  for (const l of labels) {
    const r = store.db.query("SELECT home_repo FROM projects WHERE label = ?").get(l) as { home_repo: string | null } | null;
    const p = r?.home_repo?.replace(/^path:/, "");
    if (p && p.startsWith("/") && !repos.has(p)) repos.set(p, l);
  }
  const wts = store.db.query("SELECT project, wt, path, gone_at FROM observed_worktrees WHERE path IS NOT NULL").all() as Wt[];
  const byPath = new Map(wts.map((w) => [w.path, w])), byId = new Map(wts.map((w) => [w.wt, w]));
  const agents = liveAgents(store), keep = keepSet(store);
  const sessions = new Map<string, string>(); // wt -> the session id of its newest transcript
  for (const r of store.db.query("SELECT wt, path FROM observed_transcripts t WHERE wt IS NOT NULL AND mtime = (SELECT MAX(mtime) FROM observed_transcripts u WHERE u.wt = t.wt)").all() as { wt: string; path: string }[])
    sessions.set(r.wt, basename(r.path).replace(/\.jsonl$/, ""));
  const globs = labels.map((l) => ({ label: l, ageS: limitInt(store, l, "cleanup_tmp_age_h", 48) * 3600, globs: cleanupGlobs(store, l).valid }));

  const exists = async (p: string | null | undefined) => { if (!p) return false; try { await lstat(p); return true; } catch { return false; } };
  const parents = new Set(wts.filter((w) => basename(w.path).startsWith(pre)).map((w) => dirname(w.path)));

  // The backend's list (KTD8: failed, unparseable or empty refuses c and d).
  let ps: PsWorktree[] = [], psError: string | null = null;
  try {
    const r = await (o.ps ?? (() => shellAdapter().ps()))();
    if (!Array.isArray(r) || r.some((w) => !w || typeof (w as PsWorktree).worktreeId !== "string")) psError = "could not be parsed";
    else if (!r.length) psError = "was empty";
    else ps = r as PsWorktree[];
  } catch (e) { psError = `failed (${(e as Error)?.message ?? e})`.slice(0, 200); }
  const psPath = (w: PsWorktree) => w.path ?? wtPath(w.worktreeId);
  const psPaths = new Set(ps.map(psPath).filter((p): p is string => !!p));

  // Each clone's worktree list: helper checkouts (c) and ds-* folders (d).
  const listed = new Set<string>(), listedOk = new Set<string>();
  const helpers: { label: string; t: GitTree; target: string | null }[] = [], gitDs: { t: GitTree; target: string | null }[] = [];
  const gitByPath = new Map<string, GitTree>();
  for (const [repo, label] of repos) {
    const trees = await gitWorktrees(repo);
    if (!trees) continue;
    listedOk.add(label);
    const target = await targetRef(repo), helperRoot = join(repo, ".claude", "worktrees") + "/";
    for (const t of trees) {
      listed.add(t.path); gitByPath.set(t.path, t);
      if (t.path.startsWith(helperRoot)) helpers.push({ label, t, target });
      else if (basename(t.path).startsWith(pre)) { gitDs.push({ t, target }); parents.add(dirname(t.path)); }
    }
  }
  const use = (o.inUse ?? inUse)(proc);
  const holder = (p: string) => use.holder(p);

  // a: processes.
  const idx = procIndex(proc, o.self ?? process.pid, agents);
  const wtRoot = (path: string) => {
    const segs = path.split("/");
    for (let i = 2; i <= segs.length; i++) {
      const c = segs.slice(0, i).join("/");
      if (segs[i - 1].startsWith(pre) && (parents.has(dirname(c)) || byPath.has(c))) return c;
    }
    return null;
  };
  for (const p of idx.all) {
    await tick();
    if (idx.family.has(p.pid) || readUid(proc, p.pid) !== uid) continue;
    const cwd = readCwdRaw(proc, p.pid);
    const root = cwd ? wtRoot(cwd.path) : null;
    if (!cwd || !root || idx.underAgent(p.pid) !== null) continue;
    const w = byPath.get(root), project = w?.project ?? labelOf(basename(root)) ?? "";
    rows.push({ project, class: "a", key: `${p.pid}:${p.start}`, path: root, pid: p.pid, size_kb: p.rss_kb,
      mtime: idx.boot === null ? null : idx.boot + Math.floor(p.start / CLK_TCK),
      facts: { cwd: cwd.path, deleted: cwd.deleted, wt: root, wt_id: w?.wt ?? null, wt_gone_at: w?.gone_at ?? null,
        comm: readText(join(proc, String(p.pid), "comm"))?.trim() ?? null, state: p.state, ppid: p.ppid } });
  }

  // c: helper checkouts.
  for (const { label, t, target } of helpers) {
    const ok = await exists(t.path), s = ok ? await size(t.path) : null;
    rows.push({ project: label, class: "c", key: t.path, path: t.path, size_kb: s?.kb ?? null, mtime: s?.newest ?? null,
      facts: { branch: t.branch, locked: t.locked, detached: t.detached, exists: ok, partial: s?.partial ?? false,
        probe: ok ? await probeTree(t.path, target) : null, holder: ok ? holder(t.path) : null } });
  }

  // The folders beside the project worktrees: d's unlisted ones, and b's "exists, so maybe alive" set.
  const beside: string[] = [];
  for (const parent of parents) for await (const name of dirs(parent)) { await tick(); entries++; beside.push(join(parent, name)); }

  // d: Orca entities and git worktrees no one tracks.
  const tree = async (path: string, kept: boolean, target: string | null) => {
    const ok = await exists(path);
    if (kept || !ok) return { exists: ok, probe: null, holder: null, s: null };
    return { exists: ok, probe: await probeTree(path, target ?? await targetRef(path)), holder: holder(path), s: await size(path) };
  };
  if (!psError) {
    for (const w of ps) {
      const path = psPath(w), base = basename(path ?? w.displayName ?? "");
      const known = byId.get(w.worktreeId) ?? (path ? byPath.get(path) : undefined);
      const project = known?.project ?? labelOf(base);
      if (!base.startsWith(pre) || !project) continue;
      const t = await tree(path ?? "", keep.has(w.worktreeId) || keep.has(path), null), g = path ? gitByPath.get(path) : undefined;
      rows.push({ project, class: "d", key: `entity:${w.worktreeId}`, path, size_kb: t.s?.kb ?? null, mtime: t.s?.newest ?? null,
        facts: { entity: w.worktreeId, wt_id: w.worktreeId, wt: path, name: w.displayName ?? null, archived: w.isArchived ?? null,
          locked: g?.locked ?? false, detached: g?.detached ?? false, exists: t.exists, probe: t.probe, holder: t.holder, partial: t.s?.partial ?? false } });
    }
    for (const { t, target } of gitDs) {
      const label = byPath.get(t.path)?.project ?? labelOf(basename(t.path));
      if (psPaths.has(t.path) || !label) continue;
      const x = await tree(t.path, keep.has(t.path), target);
      rows.push({ project: label, class: "d", key: t.path, path: t.path, size_kb: x.s?.kb ?? null, mtime: x.s?.newest ?? null,
        facts: { git: true, wt: t.path, wt_id: byPath.get(t.path)?.wt ?? null, branch: t.branch, locked: t.locked, detached: t.detached,
          exists: x.exists, probe: x.probe, holder: x.holder, partial: x.s?.partial ?? false } });
    }
    for (const path of beside) {
      const name = basename(path), label = labelOf(name);
      if (!label || !listedOk.has(label) || listed.has(path) || psPaths.has(path)) continue;
      const st = await lstat(path).catch(() => null);
      if (!st?.isDirectory()) continue;
      rows.push({ project: label, class: "d", key: path, path, size_kb: null, mtime: Math.floor(st.mtimeMs / 1000),
        facts: { git: false, wt: path, wt_id: byPath.get(path)?.wt ?? null, exists: true } });
    }
  }

  // b: the Claude temp root (KTD14).
  const tmp = o.tmpRoot ?? claudeTmpRoot();
  const live = new Map<string, { project: string; wt: string | null; path: string }>();
  for (const w of wts) if (w.gone_at === null) live.set(mangle(w.path), { project: w.project, wt: w.wt, path: w.path });
  for (const p of [...psPaths, ...helpers.map((h) => h.t.path), ...beside]) if (!live.has(mangle(p))) live.set(mangle(p), { project: labelOf(basename(p)) ?? "", wt: null, path: p });
  const gone = new Map(wts.filter((w) => w.gone_at !== null).map((w) => [mangle(w.path), w]));
  const liveKeys = [...live.keys()];
  const prefixes = [...parents].flatMap((d) => labels.map((l) => ({ m: mangle(join(d, `${pre}${l}-`)), label: l }))).sort((a, b) => b.m.length - a.m.length);
  let looseCount = 0, looseKb = 0;
  for await (const name of dirs(tmp)) {
    await tick(); entries++;
    const p = join(tmp, name), st = await lstat(p).catch(() => null);
    if (!st) continue;
    if (!st.isDirectory()) { looseCount++; looseKb += Math.ceil(Number(st.blocks) / 2); continue; }
    const alive = live.get(name);
    if (alive) {
      const newest = alive.wt ? sessions.get(alive.wt) : undefined;
      if (!newest || !alive.project) continue;
      for await (const s of dirs(p)) {
        const sp = join(p, s), sst = s === newest ? null : await lstat(sp).catch(() => null);
        if (!sst?.isDirectory()) continue;
        const z = await tmpSize(sp);
        rows.push({ project: alive.project, class: "b", key: sp, path: sp, size_kb: z.kb, mtime: z.newest,
          facts: { slug: name, session: s, live_session: newest, wt: alive.path, uid: sst.uid, holder: holder(sp), partial: z.partial } });
      }
      continue;
    }
    const pf = prefixes.find((x) => name.startsWith(x.m));
    if (!pf || liveKeys.some((k) => name.startsWith(`${k}-`))) continue; // maybe a subdir of a live tree
    const g = gone.get(name), z = await tmpSize(p);
    rows.push({ project: g?.project ?? pf.label, class: "b", key: p, path: p, size_kb: z.kb, mtime: z.newest,
      facts: { slug: name, slug_wt: g?.wt ?? null, wt: g?.path ?? null, uid: st.uid, holder: holder(p), partial: z.partial } });
  }

  // e: one row per valid glob, its parent streamed (KTD5); a glob two projects list belongs to the first.
  const seen = new Set<string>();
  for (const { label, ageS, globs: gs } of globs) for (const glob of gs) {
    if (seen.has(glob)) continue;
    seen.add(glob);
    const { parent, match } = globMatcher(glob);
    const f = { count: 0, kb: 0, oldest: null as number | null, newest: null as number | null, too_new: 0, not_ours: 0, in_use: 0,
      in_use_pid: null as number | null, removable: 0, dirs: 0, partial: false, sample: [] as string[] };
    for await (const name of dirs(parent)) {
      await tick(); entries++;
      if (!match(name)) continue;
      const p = join(parent, name), st = await lstat(p).catch(() => null);
      if (!st) continue;
      const m = Math.floor(st.mtimeMs / 1000);
      f.count++; f.kb += Math.ceil(Number(st.blocks) / 2);
      if (st.isDirectory()) { f.dirs++; f.partial = true; } // a matched folder counts its own inode until the measuring pass
      f.oldest = f.oldest === null ? m : Math.min(f.oldest, m); f.newest = f.newest === null ? m : Math.max(f.newest, m);
      const h = !st.isDirectory() && use.exact ? use.exact(p) : holder(p);
      if (st.uid !== uid) f.not_ours++;
      else if (m > at - ageS) f.too_new++;
      else if (h) { f.in_use++; f.in_use_pid ??= h; }
      else f.removable++;
      if (f.sample.length < 20) f.sample.push(p);
    }
    if (f.count) rows.push({ project: label, class: "e", key: glob, path: parent, size_kb: f.kb, mtime: f.newest, facts: f });
  }
  return { at, ms: Math.round(performance.now() - t0), entries: entries + idx.all.length, psError, looseCount, looseKb, rows };
}

// One transaction: upsert every row (first_seen kept while the row stays; a row back from gone starts
// over), gone_at on the rows not seen (class d left alone when the backend list failed), the scan row.
// A partial row keeps the measuring pass's last size (and its size_from/size_at) while that is still
// at least the new walk's, so the card does not fall back to `≥` every hour until the pass runs again.
export function writeCleanup(store: Store, s: CleanupScan, host = hostname()): void {
  const prev = store.db.query("SELECT size_kb, facts FROM observed_cleanup WHERE project = ? AND class = ? AND key = ? AND gone_at IS NULL");
  const carry = (r: CleanupRow): CleanupRow => {
    if (r.class === "a" || !r.facts.partial) return r;
    const p = prev.get(r.project, r.class, r.key) as { size_kb: number | null; facts: string | null } | null;
    const f = parse(p?.facts);
    if (f.size_from !== "du" || p?.size_kb == null || p.size_kb < Number(r.size_kb ?? 0)) return r;
    return { ...r, size_kb: p.size_kb, facts: { ...r.facts, size_from: "du", size_at: f.size_at } };
  };
  const up = store.db.query(`INSERT INTO observed_cleanup (project, class, key, path, pid, size_kb, mtime, first_seen, facts, observed_at, gone_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (project, class, key) DO UPDATE SET path = excluded.path, pid = excluded.pid, size_kb = excluded.size_kb, mtime = excluded.mtime,
      facts = excluded.facts, observed_at = excluded.observed_at,
      first_seen = CASE WHEN gone_at IS NULL THEN first_seen ELSE excluded.first_seen END,
      orphaned_since = CASE WHEN gone_at IS NULL THEN orphaned_since ELSE NULL END,
      verdict = CASE WHEN gone_at IS NULL THEN verdict ELSE NULL END,
      gone_at = NULL`);
  const seen = new Set(s.rows.map((r) => JSON.stringify([r.project, r.class, r.key])));
  store.tx(() => {
    for (const r of s.rows.map(carry)) up.run(r.project, r.class, r.key, r.path ?? null, r.pid ?? null, r.size_kb ?? null, r.mtime ?? null, s.at, JSON.stringify(r.facts), s.at);
    const live = store.db.query("SELECT project, class, key FROM observed_cleanup WHERE gone_at IS NULL").all() as { project: string; class: string; key: string }[];
    const gone = store.db.query("UPDATE observed_cleanup SET gone_at = ? WHERE project = ? AND class = ? AND key = ?");
    for (const r of live) if (!seen.has(JSON.stringify([r.project, r.class, r.key])) && !(s.psError && r.class === "d")) gone.run(s.at, r.project, r.class, r.key);
    store.db.query("DELETE FROM observed_cleanup WHERE gone_at IS NOT NULL AND gone_at < ?").run(s.at - PRUNE_S);
    store.db.query(`INSERT INTO observed_cleanup_scan (host, started_at, ms, entries, ps_error, loose_count, loose_kb, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (host) DO UPDATE SET started_at = excluded.started_at, ms = excluded.ms, entries = excluded.entries, ps_error = excluded.ps_error,
        loose_count = excluded.loose_count, loose_kb = excluded.loose_kb, observed_at = excluded.observed_at`)
      .run(host, s.at, s.ms, s.entries, s.psError, s.looseCount, s.looseKb, s.at);
  });
}

const parse = (t: string | null | undefined): Record<string, unknown> => { try { return JSON.parse(t ?? "{}") ?? {}; } catch { return {}; } };

// The measuring pass (investigate-disk-cleanup U1). The walk stops at its entry budgets and a class e
// row counts a matched folder as its own inode, so after each written scan every live row whose facts
// say `partial` gets its real size from `du -sk`, unmeasured rows first, then largest first, off the tick: one path at a time,
// each killed after DS_LOOP_CLEANUP_DU_S (120 s), the pass stopped after DS_LOOP_CLEANUP_DU_TOTAL_S
// (600 s). A class e row is the sum over its glob's matches (a folder's du, a file's own blocks). A
// path gone before or during its du is skipped; a failed du keeps the walk's size and says why in
// `size_error`. Everything read from loop.db is read before the first await. Sizes decide no verdict (KTD4).
export type Sized = { project: string; class: string; key: string } & ({ kb: number } | { error: string });

type ToSize = { project: string; class: string; key: string; path: string | null };
export const toSize = (store: Store): ToSize[] => store.db.query(`SELECT project, class, key, path FROM observed_cleanup
  WHERE gone_at IS NULL AND class <> 'a' AND json_extract(facts, '$.partial') = 1
  ORDER BY json_extract(facts, '$.size_from') IS 'du', size_kb DESC, class, key`).all() as ToSize[];

export async function measureCleanup(store: Store, o: CleanupOpts = {}, rows = toSize(store)): Promise<Sized[]> {
  const perS = o.duS ?? envInt("DS_LOOP_CLEANUP_DU_S", 120), totalS = o.duTotalS ?? envInt("DS_LOOP_CLEANUP_DU_TOTAL_S", 600);
  const run = o.du ?? duSk, dirs = o.dirs ?? streamDir, tick = yielder(), t0 = performance.now();
  const left = () => totalS - (performance.now() - t0) / 1000;
  const there = (p: string) => lstat(p).then((st) => st, () => null);
  const one = async (p: string): Promise<DuResult | "gone"> => {
    if (!(await there(p))) return "gone";
    const r = await run(p, Math.max(1, Math.min(perS, Math.ceil(left()))));
    return "error" in r && !(await there(p)) ? "gone" : r;
  };
  const out: Sized[] = [];
  for (const r of rows) {
    if (left() <= 0) break;
    const id = { project: r.project, class: r.class, key: r.key };
    if (r.class !== "e") {
      const d = r.path ? await one(r.path) : "gone";
      if (d !== "gone") out.push({ ...id, ...d });
      continue;
    }
    const { parent, match } = globMatcher(r.key);
    let kb = 0, error: string | null = null, seen = false;
    for await (const name of dirs(parent)) {
      await tick();
      if (!match(name)) continue;
      const p = join(parent, name), st = await there(p);
      if (!st) continue;
      seen = true;
      if (!st.isDirectory()) { kb += Math.ceil(Number(st.blocks) / 2); continue; }
      const d = await one(p);
      if (d === "gone") continue;
      if ("error" in d) { error = d.error; break; }
      kb += d.kb;
    }
    if (seen) out.push(error ? { ...id, error } : { ...id, kb });
  }
  return out;
}

// The pass's sizes, on a later tick: a row gone (or back from gone) since is skipped.
export function writeSizes(store: Store, sized: Sized[], at: number): void {
  const get = store.db.query("SELECT facts FROM observed_cleanup WHERE project = ? AND class = ? AND key = ? AND gone_at IS NULL");
  const set = store.db.query("UPDATE observed_cleanup SET size_kb = COALESCE(?, size_kb), facts = ? WHERE project = ? AND class = ? AND key = ?");
  store.tx(() => {
    for (const m of sized) {
      const row = get.get(m.project, m.class, m.key) as { facts: string | null } | null;
      if (!row) continue;
      const f = parse(row.facts);
      // A failed du leaves the size it had but not as a measured one: the card reads `≥` again.
      if ("kb" in m) { delete f.size_error; f.size_from = "du"; f.size_at = at; } else { f.size_error = m.error; delete f.size_from; }
      set.run("kb" in m ? m.kb : null, JSON.stringify(f), m.project, m.class, m.key);
    }
  });
}

export type CleanupObserver = Observer & { idle(): Promise<void> };

// One background job at a time: the scan, then (after the tick that writes it) its measuring pass.
export function cleanupObserver(o: CleanupOpts = {}): CleanupObserver {
  let inflight: Promise<void> | null = null, done: CleanupScan | null = null, sized: Sized[] | null = null;
  let failed: string | null = null, nextAt: number | null = null;
  const start = (what: string, job: Promise<void>) => {
    inflight = job.catch((e) => { failed = `${what}: ${(e as Error)?.message ?? e}`; }).finally(() => { inflight = null; });
  };
  return {
    name: "cleanup",
    scope: "host",
    idle: async () => { while (inflight) await inflight; },
    run(ctx: TickCtx) {
      const { store, now } = ctx;
      if (sized) { const m = sized; sized = null; writeSizes(store, m, now); }
      if (done) {
        const s = done; done = null; writeCleanup(store, s, o.host);
        const rows = toSize(store);
        if (rows.length) start("cleanup sizes", measureCleanup(store, o, rows).then((m) => { sized = m.length ? m : null; }));
      }
      if (failed) { const e = failed; failed = null; throw new Error(e); }
      if (inflight) return;
      const every = envInt("DS_LOOP_CLEANUP_S", 3600);
      nextAt ??= Number((store.db.query("SELECT MAX(started_at) AS at FROM observed_cleanup_scan").get() as { at: number | null }).at ?? -Infinity) + every;
      if (now < nextAt) return;
      nextAt = now + every;
      start("cleanup scan", scanCleanup(store, now, o).then((s) => { done = s; }));
    },
  };
}

export default cleanupObserver();
