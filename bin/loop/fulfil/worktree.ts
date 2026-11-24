// fulfil/worktree.ts — kind `worktree.remove`: the removed sweep step 1d, a leftover worktree is removed
// only when that is provably safe, never by force. Ported from the removed sweep and the old shell lib at
// origin/main 898381d; archive-leftovers U1 replaced its rule.
//
//   the default branch fetched (tidy.ts fetchTarget: once per repo per DS_LOOP_LIFECYCLE_RETRY_S, never fatal)
//   the check (tidy.ts leftoverCheck) fails                                   left, with a note
//   a path the tree changes (commits on no remote, tracked changes, untracked
//   files) differs from the same path on the default branch                   left: N commits, M files not on main
//   an ignored file outside the sweep's allowed top-level dirs (.env)         left
//   (whether its PR merged plays no part: a squash merge leaves commits on the branch that main may not hold)
//   the worktree's exposed entries end and their stop commands run (squad/exposed.ts removalHold: waits)
//   (a failed fetch is one `leftover_fetch_failed` event; the stale local ref only keeps more trees)
//   then terminal-close-worktree, the close-time tidy (tidy.ts closeTidy.before: cleanup_on_close and
//   leftover processes), the same check again, the close's rescue of its pages and notes (io/rescue.ts;
//   a failed or capped copy leaves it), worktree-rm, forced since the check
//   proved everything it drops is on main or rebuildable                    refused: left, with a note
//   and on success the Claude temp dir (closeTidy.after) and drop-leftover
//   (U11c: a squad on a contract backend: the contract's terminal.close and its provider's removal, by path)
//
// Leaving it is a done action, not a failure: the reconciler's next episode tries again. The note
// (event `leftover_note`) is once per cause, as the sweep's leftover_note: the episodes row
// (kind `leftover-note`) holds the last cause noted and goes when the worktree does.
// It runs in the background: a removal deletes a whole tree and must not hold up the tick.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Action } from "../core/plugins.ts";
import type { Exec, Fulfiller, Result } from "../core/actuator.ts";
import { spawn } from "../io/orca.ts";
import { ROOT } from "../core/store.ts";
import { actionBlock } from "../pause/pause.ts";
import { closeTidy, fetchTarget, leftoverCheck, rescuedNote, type LeftoverCheck } from "../io/tidy.ts";
import { NOTE_DIRS, rescuePages } from "../io/rescue.ts";
import { removalHold } from "../squad/exposed.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";
import { byContract, contractCloseTerminals, contractRemoveTree } from "../squad/removal.ts";

type P = ActionPayload<"worktree.remove">;

// Rebuildable top-level dirs, and dev-studio's own per-worktree files (OURS in bin/loop/io/wt-probe.ts).
const ALLOWED = new Set(["node_modules/", ".devenv/", ".direnv/", "dist/", "build/", "target/", ".turbo/", ".next/", "CLAUDE.local.md", ".claude/"]);
const noteKey = (a: Action, wt: string) => ({ project: a.project, subject: wt, kind: "leftover-note" });

function note(a: Action, x: Exec, p: P, cause: string, text: string): Result {
  const key = noteKey(a, p.wt!);
  if (x.store.get("episodes", key)?.state !== cause) {
    x.store.upsert("episodes", key, { squad: a.squad ?? null, state: cause, source: "loop", observed_at: x.now });
    x.store.event("leftover_note", { project: a.project, squad: a.squad, unit: p.unit ?? null, payload: { wt: p.wt, path: p.path, cause, text } });
  }
  return { done: true, result: `left: ${cause}` };
}

// The `git status --porcelain --ignored=matching` lines for ignored files the removal would lose: outside
// the allowed dirs, and not a note the rescue copies out first (a folder of notes is listed file by file).
async function stray(path: string, status: string): Promise<boolean | null> {
  const lines = status.split("\n").filter((l) => l.startsWith("!! ") && !ALLOWED.has(l.slice(3).replace(/\/.*$/, "/")));
  for (const l of lines) {
    const p = l.slice(3);
    if (!NOTE_DIRS.some((d) => p === `${d}/` || p.startsWith(`${d}/`))) return true;
    if (!p.endsWith("/")) { if (!rescuedNote(p)) return true; continue; }
    const r = await spawn(["git", "-C", path, "ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", p], {}, 60_000);
    if (r.code !== 0) return null;
    if (r.out.split("\0").filter(Boolean).some((f) => !rescuedNote(f))) return true;
  }
  return false;
}

const leftText = (c: LeftoverCheck) => `left: ${c.commits.length} commit${c.commits.length === 1 ? "" : "s"}, ${c.n_differ} file${c.n_differ === 1 ? "" : "s"} not on main`;

// The check: a reason to leave the tree, or the check itself when it is safe to remove.
async function safe(a: Action, x: Exec, p: P, path: string): Promise<Result | { check: LeftoverCheck }> {
  const check = await leftoverCheck(path);
  if (!check) return note(a, x, p, "probe-failed", `leftover ${path} (${p.unit ?? ""}): worktree probe failed — left as is`);
  if (!check.safe) return { done: true, result: leftText(check) };
  const ignored = await spawn(["git", "-C", path, "status", "--porcelain", "--ignored=matching"], {}, 60_000);
  if (ignored.code !== 0) return { done: true, result: "left: ignored files unknown" };
  const lost = await stray(path, ignored.out);
  if (lost == null) return { done: true, result: "left: ignored files unknown" };
  if (lost) return { done: true, result: "left: ignored files" };
  return { check };
}

// The state file a squad's leftover record lives in: the live `squads/<topic>.json`, else (a closed squad) the newest
// `archive/<topic>-<stamp>.json` that still names the tree.
function recordFile(root: string, project: string, topic: string, wt: string): string | null {
  const live = join(root, project, "squads", `${topic}.json`);
  if (existsSync(live)) return live;
  const dir = join(root, project, "archive"), re = new RegExp(`^${topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}-\\d{6}\\.json$`);
  let names: string[] = [];
  try { names = readdirSync(dir).filter((f) => re.test(f)).sort().reverse(); } catch { /* no archive folder */ }
  for (const f of names) {
    try { if ((JSON.parse(readFileSync(join(dir, f), "utf8")).leftovers ?? []).some((l: { wt?: string }) => l?.wt === wt)) return join(dir, f); } catch { /* unreadable */ }
  }
  return null;
}

async function dropRecord(x: Exec, project: string, topic: string, wt: string): Promise<void> {
  const state = recordFile(x.store.root, project, topic, wt);
  if (state) await spawn([join(ROOT, "bin", "role", "squad-state.sh"), state, "drop-leftover", wt], { DS_STATE_ROOT: x.store.root }, 30_000);
}

async function remove(a: Action, x: Exec, p: P): Promise<Result> {
  const { wt, path } = p as { wt: string; path: string };
  // The reconciler saw the folder gone: only the state file still names it.
  if (p.gone && !existsSync(path)) {
    x.store.db.run("DELETE FROM episodes WHERE project = ? AND subject = ? AND kind = ?", [a.project, wt, "leftover-note"]);
    await dropRecord(x, a.project, p.topic!, wt);
    return { done: true, result: "dropped: folder gone" };
  }
  const fetched = await fetchTarget(path, x.now);
  if (fetched.error) x.store.event("leftover_fetch_failed", { project: a.project, squad: a.squad, unit: p.unit ?? null, payload: { wt, path, error: fetched.error } });
  const first = await safe(a, x, p, path);
  if (!("check" in first)) return first;

  const block = actionBlock(x.store, a);
  if (block) return block === "paused" ? { wait: block } : { dropped: block };
  // exposed-cleanup U2: end what this worktree exposed and run its stop commands before the tree goes.
  const stops = removalHold(x.store, a.project, wt, "worktree-removed", x.now);
  if (stops) return { wait: stops };
  // U11c: a squad on a contract backend closes and removes through its contract and its provider, by path.
  const w = { project: a.project, squad: p.topic, wt, path }, contract = byContract(x.store, w);
  if (contract) {
    // No backend drops a contract terminal with its tree (Orca's worktree-rm does): one left open keeps it.
    if ((await contractCloseTerminals(a, x, w)).code !== 0) return { done: true, result: "left: terminals not closed" };
  } else await x.act.orca.run("terminal-close-worktree", [`id:${wt}`], { env: x.act.childActivity(x.store, a) });
  if (actionBlock(x.store, a)) return { wait: "activity changed before removal" };
  // U1 (KTD10): the project's cleanup_on_close, then stop what is still running in the tree, then probe again.
  const tidy = await closeTidy.before(a, x, path);
  const again = await safe(a, x, p, path);
  if (!("check" in again)) return again;
  // As a close does (lavish-docs-not-stored U3): its pages and notes are copied out before the tree goes.
  const m = x.store.db.query("SELECT role, suffix FROM members WHERE project = ? AND wt = ? ORDER BY id DESC").get(a.project, wt) as { role: string; suffix: string | null } | null;
  const label = m ? (m.suffix ? `${m.role}-${m.suffix}` : m.role) : `builder-${p.unit ?? "leftover"}`;
  const saved = await rescuePages(x.store, a.project, p.topic!, label, path);
  if (saved.count > 0) x.store.event("pages_rescued", { project: a.project, squad: p.topic!, member: wt,
    payload: { wt, path, dest: saved.dest, count: saved.count, bytes: saved.bytes, same: saved.same, capped: saved.capped, listed: saved.listed, files: saved.files.slice(0, 20) } });
  if (!saved.ok) return note(a, x, p, "rescue-failed", `leftover ${path}: its pages could not be copied out (${saved.why}) — left as is`);
  if (!saved.listed || saved.capped > 0) return note(a, x, p, "rescue-incomplete", `leftover ${path}: not every page could be copied out — left as is`);
  if (actionBlock(x.store, a)) return { wait: "activity changed before removal" };
  // Forced: the check just proved every change it would drop is on main (index, mode and untracked files
  // included) and every ignored file rebuildable; a non-forced removal refuses any dirty tree.
  const rm = contract ? await contractRemoveTree(a, x, w, true) : await x.act.orca.run("worktree-rm", [`id:${wt}`, "force"], { env: x.act.childActivity(x.store, a) });
  if (rm.code !== 0) return note(a, x, p, "rm-refused", `leftover ${path} still refused by worktree-rm — left as is`);
  await closeTidy.after(a, x, path, tidy);
  x.store.db.run("DELETE FROM episodes WHERE project = ? AND subject = ? AND kind = ?", [a.project, wt, "leftover-note"]);
  // The tree is gone either way: a record this could not drop, the reconciler drops as gone.
  await dropRecord(x, a.project, p.topic!, wt);
  return { done: true, result: "removed: all on main" };
}

const worktree: Fulfiller = {
  name: "worktree",
  kinds: ["worktree.remove"],
  run: () => [],
  // The directory went meanwhile: the reconciler drops that record itself.
  stale: (a) => !(a.payload as P | null)?.gone && !existsSync(String((a.payload as P | null)?.path ?? "")),
  exec(a, x) {
    const p = payloadOf<"worktree.remove">(a);
    if (!a.project || !p.topic || !p.wt || !p.path) return { failed: "a leftover removal needs a project, a topic, a worktree and a path" };
    return { background: remove(a, x, p) };
  },
};
export default worktree;
