// fulfil/remove-project.ts — kind `remove-project` (remove-project U3): `ds remove-project <label>` (project NULL,
// the label in the payload) removes a project whose removal nothing blocks (squad/project-removal.ts). Steps, each
// saved in the plan episode (project '', subject remove-project:<label>, kind remove-project) before and after its
// side effect, so a replay after a crash or a restart does each one once (KTD6):
//
//   check             removalBlockers: any blocker fails the request, nothing changed; the Studio's worktree,
//                     branch and repo are recorded
//   stopping-services every exposed entry of the label ends; waits while a stop command is queued or running
//   closing-studio    the check again; the Studio worktree goes the way the board's leftover Remove goes
//                     (worktree.ts removeLeftover: its terminals closed, on Orca or through its contract, its
//                     pages rescued, its changes always saved into state/<label>/pages/_studio/leftovers/<wt>/,
//                     then removed forced) and its branch is renamed <branch>-removed-<YYYY-MM-DD>; a failed
//                     save fails the request before anything moves
//   stopping-board    written first, and the board's stop wishes only on a later tick, so a polling board page
//                     sees this step (KTD10); waits for the board server to go (DS_LOOP_REMOVE_BOARD_S, 60)
//   quiet             waits until no action episode of the label is pending, acted or running
//                     (DS_LOOP_REMOVE_QUIET_S, 120; past it the removal goes on and names them in the plan)
//   moving            the check again; state/<label>/ renamed to state/.removed/<label>-<YYYY-MM-DD>[-<n>]/.
//                     A label with no folder (rows only) reuses the newest unfinished archive of the label, else
//                     makes a new one. Discovery skips dot folders, so from the next tick nothing ticks the label.
//   moved             two ticks later: a folder back at state/<label>/ goes into the archive as after-move/;
//                     then db/project-rows.ts copyRows writes loop-rows.db in the archive
//   copied            the log tables first, in batches (deleteLogBatch, only rows the archive holds): about 2 s
//                     of batches a tick, a short pause between two, and `wait` while rows are left; then
//                     deleteRows: one transaction that counts again, expects no log row, and deletes the rest;
//                     a count that changed copies again (5 tries; once a batch ran, appendRows adds to the same
//                     archive), a delete that already committed (every count 0 now) goes on
//   deleted           removed.json in the archive, one `project_removed` event, the request done
//
// Progress is the open request's `result` ({step, label, archive, text}); `text` comes from STEP_TEXT, never the
// step id. A failure is one `project_remove_failed` event, a card on the first other project and the request
// done with ok:false. Every row this writes is project NULL or '', so the delete never meets one of its own.
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alert, finishRequest, requestActions, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { payloadOf } from "../core/kinds.ts";
import type { Action } from "../core/plugins.ts";
import { dbPath, type Row } from "../core/store.ts";
import { envInt } from "../core/tick.ts";
import { appendRows, archiveMeta, copyRows, deleteLogBatch, deleteRows, KEEP_WITH_PROJECT, KEPT, LOG_TABLES, type Counts, type LogTable } from "../db/project-rows.ts";
import { localPath } from "../drivers/contract.ts";
import { spawn } from "../io/orca.ts";
import { leftoverCheck } from "../io/tidy.ts";
import { wtPath } from "../observers/orca.ts";
import { discoverProjects } from "../settings/projects.ts";
import { limitInt } from "../settings/limits.ts";
import { endSquad, stopsPending } from "../squad/exposed.ts";
import { blockedText } from "../squad/project-removal.ts";
import { STUDIO_SQUAD } from "../squad/studio.ts";
import { isBoard } from "./board.ts";
import { save, saveDir } from "./leftover-remove.ts";
import { removeLeftover } from "./worktree.ts";

export type Step = "check" | "stopping-services" | "closing-studio" | "stopping-board" | "quiet" | "moving" | "moved" | "copied" | "deleted" | "removed";

/** One plain sentence per step: what the command and the board show. */
export const STEP_TEXT: Record<Step, string> = {
  check: "Checking the project",
  "stopping-services": "Stopping the project's services",
  "closing-studio": "Closing the Studio",
  "stopping-board": "Stopping the project's board",
  quiet: "Waiting for the loop's last actions on the project",
  moving: "Archiving the project folder",
  moved: "Moving the database rows",
  copied: "Moving the database rows",
  deleted: "Writing the archive record",
  removed: "Removed",
};

type Studio = { wt: string; path: string; branch: string | null; common: string | null };
// `after`: where each table's batches go on (null: done); starting a table again from 0 is safe.
type LogProgress = { after: Partial<Record<LogTable, number | null>>; deleted: number; batches: number; held_ms: number };
type Plan = {
  request: number; label: string; by: string | null; step: Step; tick: number; since: number;
  studio?: Studio | null; saved?: string | null; branch_to?: string | null; branch_error?: string | null;
  archive?: string; rows_only?: boolean; moved_tick?: number; after_move?: string[]; left_actions?: string[];
  // copy.counts: the archive's rows per table; copy.source: loop.db's at the latest copy (absent: the same).
  copies?: number; copy?: { counts: Counts; source?: Counts; rows: number; set_aside: string[] };
  // Saved before the first batch: from then on the archive is only added to.
  log?: LogProgress;
  deleted?: { rows: number; cleared_pins: number; cleared_links: number; held_ms: number } | null;
};

const boardS = () => envInt("DS_LOOP_REMOVE_BOARD_S", 60);
const quietS = () => envInt("DS_LOOP_REMOVE_QUIET_S", 120);
const COPY_TRIES = 5;
// One batch holds the write lock under 300 ms on a loaded host (the bench in tests/loop/project-rows.test.ts).
export const BATCH_ROWS = 5000;
const batchRows = () => envInt("DS_LOOP_REMOVE_BATCH_ROWS", BATCH_ROWS);
const sliceMs = () => envInt("DS_LOOP_REMOVE_SLICE_MS", 2000);
// Longer than SQLite's longest busy-handler sleep (100 ms), so a waiting writer gets the lock between two batches.
const BATCH_PAUSE_MS = 120;

const logRows = (counts: Counts | undefined) => LOG_TABLES.reduce((n, t) => n + (counts?.[t] ?? 0), 0);
function stepText(p: Plan): string {
  const total = logRows(p.copy?.counts);
  return (p.step === "moved" || p.step === "copied") && p.log?.batches ? `${STEP_TEXT[p.step]} (${p.log.deleted} of ${total})` : STEP_TEXT[p.step];
}

// About a slice of batches; true when every log table has none left that the archive holds.
async function deleteLogs(x: Exec, p: () => Plan, put: (next: Partial<Plan>) => void): Promise<boolean> {
  const archive = join(p().archive!, "loop-rows.db"), limit = batchRows(), t0 = performance.now();
  if (!p().log) put({ log: { after: {}, deleted: 0, batches: 0, held_ms: 0 } });
  for (const t of LOG_TABLES) {
    for (let after = p().log?.after[t]; after !== null; after = p().log!.after[t]) {
      const b = deleteLogBatch(x.store, p().label, archive, t, limit, after ?? 0);
      const log = p().log!;
      put({ log: { after: { ...log.after, [t]: b.next }, deleted: log.deleted + b.deleted,
        batches: log.batches + (b.deleted ? 1 : 0), held_ms: Math.max(log.held_ms, b.held_ms) } });
      if (!b.deleted) continue;
      await Bun.sleep(BATCH_PAUSE_MS);
      if (performance.now() - t0 >= sliceMs()) return false;
    }
  }
  return true;
}

export const planKey = (label: string) => ({ project: "", subject: `remove-project:${label}`, kind: "remove-project" });
const day = (at: number) => new Date(at * 1000).toISOString().slice(0, 10);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function loadPlan(x: Exec, label: string, request: number): Plan | null {
  const row = x.store.get("episodes", planKey(label));
  try {
    const p = JSON.parse(String(row?.result ?? "null")) as Plan | null;
    return p && p.request === request ? p : null;
  } catch { return null; }
}

// The plan saved, and the request's progress beside it.
function savePlan(x: Exec, p: Plan, end = false): void {
  x.store.upsert("episodes", planKey(p.label), { state: p.step, source: "loop", result: JSON.stringify(p), observed_at: x.now, ended_at: end ? x.now : null });
  if (!end) x.store.upsert("requests", { id: p.request }, { result: JSON.stringify({ step: p.step, label: p.label, archive: p.archive ?? null, text: stepText(p) }) });
}

// The Studio's worktree, its branch and its repo's common dir, read before anything closes.
async function studioOf(x: Exec, label: string): Promise<Studio | null> {
  const p = x.store.get("projects", { label });
  const wt = typeof p?.studio_wt === "string" && p.studio_wt ? p.studio_wt : null;
  if (!wt) return null;
  const path = localPath(wt) ?? wtPath(wt) ?? (typeof p?.studio_path === "string" ? p.studio_path : null);
  if (!path || !existsSync(path)) return { wt, path: path ?? "", branch: null, common: null };
  const [b, c] = await Promise.all([spawn(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"], {}, 30_000),
    spawn(["git", "-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], {}, 30_000)]);
  const branch = b.code === 0 && b.out.trim() && b.out.trim() !== "HEAD" ? b.out.trim() : null;
  return { wt, path, branch, common: c.code === 0 ? c.out.trim() || null : null };
}

// `ds up` always names the Studio branch the same, and a provider refuses one that exists: the old one moves aside.
async function renameBranch(common: string, branch: string, at: number): Promise<{ to: string | null; error: string | null }> {
  const has = async (b: string) => (await spawn(["git", `--git-dir=${common}`, "show-ref", "--verify", "-q", `refs/heads/${b}`], {}, 30_000)).code === 0;
  if (!(await has(branch))) return { to: null, error: null };
  let to = `${branch}-removed-${day(at)}`;
  for (let n = 2; await has(to); n++) to = `${branch}-removed-${day(at)}-${n}`;
  const r = await spawn(["git", `--git-dir=${common}`, "branch", "-m", branch, to], {}, 30_000);
  return r.code === 0 ? { to, error: null } : { to: null, error: r.err.trim() || `exit ${r.code}` };
}

// The Studio worktree saved and removed through the leftover path, under the label (not the empty host project).
async function closeStudio(a: Action, x: Exec, label: string, st: Studio): Promise<Result | { saved: string }> {
  const as: Action = { ...a, project: label, squad: STUDIO_SQUAD, member: st.wt };
  const dir = saveDir(x.store.root, label, STUDIO_SQUAD, st.wt);
  const out = await removeLeftover(as, x, { label, topic: STUDIO_SQUAD, wt: st.wt, path: st.path },
    async (path) => { const check = await leftoverCheck(path); return check ? { check } : { failed: `the Studio worktree ${path} could not be read` }; },
    (path) => save(path, dir));
  if ("removed" in out) return { saved: dir };
  if ("wait" in out) return out;
  const why = "done" in out ? String(out.result ?? "") : "dropped" in out ? out.dropped : "failed" in out ? out.failed : "retry" in out ? out.retry : "not removed";
  const failed = why.match(/^left: save failed: (.*)$/s);
  return { failed: failed ? `the Studio's changes could not be saved (${failed[1]}); nothing was moved` : `the Studio worktree ${st.path} was not removed (${why.replace(/^left: /, "")})` };
}

// The rows-only re-run's archive: the newest of the label's that has no record and no finished row copy.
function unfinishedArchive(root: string, label: string): string | null {
  const dir = join(root, ".removed"), re = new RegExp(`^${esc(label)}-\\d{4}-\\d{2}-\\d{2}(-\\d+)?$`);
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => re.test(n)); } catch { return null; }
  const open = names.map((n) => join(dir, n))
    .filter((p) => !existsSync(join(p, "removed.json")) && archiveMeta(join(p, "loop-rows.db")) === null)
    .sort((p, q) => statSync(q).mtimeMs - statSync(p).mtimeMs);
  return open[0] ?? null;
}
function freeArchive(root: string, label: string, at: number): string {
  const base = join(root, ".removed", `${label}-${day(at)}`);
  let p = base;
  for (let n = 2; existsSync(p); n++) p = `${base}-${n}`;
  return p;
}

const actionsOf = (x: Exec, label: string): string[] =>
  (x.store.db.query("SELECT kind, subject FROM episodes WHERE project = ? AND kind LIKE 'action:%' AND state IN ('pending', 'acted', 'running') AND ended_at IS NULL ORDER BY id")
    .all(label) as Row[]).map((r) => `${String(r.kind).slice(7)} ${r.subject}`);

// A removal that cannot go on: one event (project NULL), a card on the first other project, the request done.
async function fail(a: Action, x: Exec, p: Plan, why: string, card = true): Promise<Result> {
  x.store.event("project_remove_failed", { project: null, payload: { label: p.label, request: p.request, step: p.step, archive: p.archive ?? null, error: why } });
  const other = card ? discoverProjects(x.store.root).find((l) => l !== p.label) : undefined;
  if (other) {
    const o = await alert(x.store, other, `remove-project.${p.label}`, `req:${p.request}`,
      `Removing project '${p.label}' stopped at "${STEP_TEXT[p.step]}": ${why}. Run ds remove-project ${p.label} again once that is fixed.`, { title: "Project removal stopped" });
    if (o.code !== 0) x.store.event("plugin_error", { project: null, payload: { plugin: "remove-project", error: o.err.trim() || `alerts.sh exit ${o.code}` } });
  }
  finishRequest(x.store, a, { ok: false, error: why, step: p.step, label: p.label, archive: p.archive ?? null, text: STEP_TEXT[p.step] }, x.now);
  savePlan(x, p, true);
  return { done: true, result: `failed: ${why}` };
}

async function run(a: Action, x: Exec): Promise<Result> {
  const r = payloadOf<"remove-project">(a), label = r.label, root = x.store.root, home = join(root, label);
  let p: Plan = loadPlan(x, label, r.request!)
    ?? { request: r.request!, label, by: r.by ?? null, step: "check", tick: x.tick, since: x.now };
  const put = (next: Partial<Plan>) => { p = { ...p, ...next }; savePlan(x, p); };
  if (p.step === "removed") return { done: true, result: "removed" };

  for (;;) switch (p.step) {
    case "check": {
      const bad = blockedText(x.store, label);
      if (bad) return fail(a, x, p, bad);
      put({ step: "stopping-services", studio: await studioOf(x, label), since: x.now });
      break;
    }
    case "stopping-services": {
      const squads = (x.store.db.query("SELECT DISTINCT squad FROM exposed WHERE project = ? ORDER BY squad").all(label) as Row[]).map((s) => String(s.squad));
      for (const s of squads) endSquad(x.store, label, s, x.now);
      const stopS = limitInt(x.store, label, "expose_stop_s", 90);
      const names = squads.flatMap((s) => stopsPending(x.store, { project: label, squad: s }, x.now, stopS));
      if (names.length) return { wait: `stop commands: ${names.join(", ")}` };
      put({ step: "closing-studio", since: x.now });
      break;
    }
    case "closing-studio": {
      const st = p.studio;
      if (st?.path && existsSync(st.path)) {
        const bad = blockedText(x.store, label);
        if (bad) return fail(a, x, p, bad);
        const out = await closeStudio(a, x, label, st);
        if ("failed" in out) return fail(a, x, p, out.failed);
        if (!("saved" in out)) return out;
        put({ saved: out.saved });
      }
      if (st?.branch && st.common && p.branch_to === undefined) {
        const b = await renameBranch(st.common, st.branch, x.now);
        put({ branch_to: b.to, branch_error: b.error });
      }
      put({ step: "stopping-board", tick: x.tick, since: x.now });
      break;
    }
    case "stopping-board": {
      // KTD10: the step is written a tick before the wish, so a polling board page sees it.
      if (x.tick <= p.tick) return { wait: "the board sees this step first" };
      const rows = x.store.db.query("SELECT * FROM services WHERE project = ? ORDER BY id").all(label) as Row[];
      for (const s of rows) if (s.want !== "stopped") x.store.want("service", String(s.id), "stopped", { by: "remove-project", why: `removing ${label}` });
      const live = rows.filter((s) => isBoard(s.pid));
      if (live.length && x.now - p.since < boardS()) return { wait: `the board is stopping (pid ${live.map((s) => s.pid).join(", ")})` };
      put({ step: "quiet", since: x.now });
      break;
    }
    case "quiet": {
      const left = actionsOf(x, label);
      if (left.length && x.now - p.since < quietS()) return { wait: `the loop's last actions on ${label}: ${left.slice(0, 3).join(", ")}` };
      put({ step: "moving", since: x.now, ...(left.length ? { left_actions: left.slice(0, 20) } : {}) });
      break;
    }
    case "moving": {
      if (!p.archive || !existsSync(p.archive)) {
        const bad = blockedText(x.store, label);
        if (bad) return fail(a, x, p, bad);
        if (!p.archive) {
          const rowsOnly = !existsSync(home);
          put({ archive: (rowsOnly ? unfinishedArchive(root, label) : null) ?? freeArchive(root, label, x.now), rows_only: rowsOnly });
        }
        const to = p.archive!;
        if (!existsSync(to)) {
          mkdirSync(join(root, ".removed"), { recursive: true });
          if (existsSync(home)) renameSync(home, to); else mkdirSync(to);
        }
      }
      put({ step: "moved", moved_tick: x.tick, since: x.now });
      break;
    }
    case "moved": {
      // KTD6: the rows go only after a full tick without the project.
      if (x.tick < (p.moved_tick ?? 0) + 2) return { wait: "a full tick without the project first" };
      if (existsSync(home)) {
        let to = join(p.archive!, "after-move");
        for (let n = 2; existsSync(to); n++) to = join(p.archive!, `after-move-${n}`);
        renameSync(home, to);
        put({ after_move: [...(p.after_move ?? []), to] });
      }
      const file = join(p.archive!, "loop-rows.db");
      let copy: NonNullable<Plan["copy"]>;
      if (p.log) {
        const c = appendRows(dbPath(root), label, file);
        copy = { counts: c.counts, source: c.source, rows: c.rows, set_aside: p.copy?.set_aside ?? [] };
      } else {
        const c = copyRows(dbPath(root), label, file);
        copy = { counts: c.counts, rows: c.rows, set_aside: c.set_aside };
      }
      put({ step: "copied", copy, copies: (p.copies ?? 0) + 1, ...(p.log ? { log: { ...p.log, after: {} } } : {}) });
      break;
    }
    case "copied": {
      // The same wait text every time, so a long delete writes one event.
      if (!(await deleteLogs(x, () => p, put))) return { wait: "deleting the log rows in batches" };
      // The batches took the log rows, so one left now is a row the archive does not hold.
      const counts: Counts = { ...(p.copy!.source ?? p.copy!.counts) };
      for (const t of LOG_TABLES) if (t in counts) counts[t] = 0;
      const d = deleteRows(x.store, label, counts);
      if (d.ok) { put({ step: "deleted", deleted: { rows: d.rows + (p.log?.deleted ?? 0), cleared_pins: d.cleared_pins, cleared_links: d.cleared_links, held_ms: d.held_ms } }); break; }
      // A replay after the delete committed: every table that had rows to delete here is empty now.
      const expected = Object.entries(counts).filter(([, n]) => n > 0);
      if (expected.length && expected.every(([t]) => d.mismatch[t]?.now === 0)) { put({ step: "deleted", deleted: p.deleted ?? null }); break; }
      const changed = Object.keys(d.mismatch).join(", ");
      if ((p.copies ?? 0) >= COPY_TRIES) return fail(a, x, p, `the project's rows kept changing while they were copied (${changed}); the archive is at ${p.archive}`);
      put({ step: "moved", moved_tick: x.tick - 2 });
      return { wait: `the rows of ${changed} changed since the copy: copying again` };
    }
    case "deleted": {
      const record = {
        label, removed_at: x.now, by: p.by, request: p.request, archive: p.archive, rows_only: !!p.rows_only,
        rows: p.copy?.rows ?? null, counts: p.copy?.counts ?? null, set_aside: p.copy?.set_aside ?? [],
        held_ms: p.deleted || p.log ? Math.max(p.deleted?.held_ms ?? 0, p.log?.held_ms ?? 0) : null,
        batches: p.log?.batches ?? 0, cleared_pins: p.deleted?.cleared_pins ?? null, cleared_links: p.deleted?.cleared_links ?? null,
        studio: p.studio ? { worktree: p.studio.wt, path: p.studio.path, branch: p.studio.branch, branch_now: p.branch_to ?? null,
          branch_error: p.branch_error ?? null, saved: p.saved ?? null } : null,
        after_move: p.after_move ?? [], left_actions: p.left_actions ?? [],
        kept: { tables: KEPT, with_project: KEEP_WITH_PROJECT },
      };
      writeFileSync(join(p.archive!, "removed.json"), JSON.stringify(record, null, 2) + "\n");
      x.store.event("project_removed", { project: null, payload: { label, request: p.request, archive: p.archive, rows: record.rows, held_ms: record.held_ms, batches: record.batches } });
      p = { ...p, step: "removed" };
      finishRequest(x.store, a, { ok: true, step: "removed", label, archive: p.archive, rows: record.rows, counts: record.counts, held_ms: record.held_ms, batches: record.batches,
        branch: p.branch_to ?? null, text: `Removed '${label}': archived at ${p.archive}` }, x.now);
      savePlan(x, p, true);
      return { done: true, result: `removed: ${p.archive}` };
    }
    default: return { done: true, result: String(p.step) };
  }
}

const removeProject: Fulfiller = {
  name: "remove-project",
  scope: "host",
  kinds: ["remove-project"],
  run: (ctx) => requestActions(ctx, ["remove-project"]),
  exec(a, x) {
    const r = payloadOf<"remove-project">(a);
    if (r.request == null || !r.label) return { failed: "a removal needs its request and a label" };
    return { background: run(a, x) };
  },
  async giveUp(a, x, why) {
    const r = payloadOf<"remove-project">(a);
    const p = loadPlan(x, r.label, r.request!) ?? { request: r.request!, label: r.label, by: r.by ?? null, step: "check" as Step, tick: x.tick, since: x.now };
    await fail(a, x, p, why);
    return true;
  },
};
export default removeProject;
