// fulfil/leftover-remove.ts — kind `leftover-remove` (archive-leftovers U4): the board's Remove of a leftover
// worktree (POST /api/leftover-remove files the request with the fingerprint of the check the operator saw).
//
//   the leftover is not on the squad's state, or its folder is gone       failed, nothing touched
//   the check (tidy.ts leftoverCheck) says safe and no ignored file would be lost   removed as worktree.remove does
//   else the request's fingerprint is the fresh one (tidy.ts leftoverFingerprint)  saved, then removed
//   else                                                                   refused: the tree changed since you looked
//
// The save, after the stops, the tidy and the rescue and right before the removal: `git diff --binary HEAD` as
// `changes.patch` and a tar of the untracked files (ignored ones too, the rebuildable dirs and dev-studio's own
// files left out) as `untracked.tar` in `state/<label>/pages/<topic>/leftovers/<worktree>/`, and
// `refs/ds-leftovers/<worktree folder name>` set to HEAD in the repo (a worktree id holds `::` and is no ref
// name), so its commits outlive the branch. A save that fails removes nothing. The removal itself is
// worktree.ts's (removeLeftover): the stops, the tidy, the fingerprint checked again, then `worktree-rm`
// (forced, branch kept) or the contract removal. One `leftover_removed` event; the request's result says what
// came of it. A paused squad holds it (pause.ts actionBlock).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { failRequest, finishRequest, requestActions, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import { payloadOf } from "../core/kinds.ts";
import type { Action } from "../core/plugins.ts";
import { spawn } from "../io/orca.ts";
import { OURS } from "../io/wt-probe.ts";
import { fetchTarget, leftoverCheck, leftoverFingerprint, type LeftoverCheck } from "../io/tidy.ts";
import { ALLOWED, leftText, note, record, removeLeftover, stray, type Checked, type P } from "./worktree.ts";

export const CHANGED = "refused: the tree changed since you looked";
export const saveDir = (root: string, label: string, topic: string, wt: string) =>
  join(root, label, "pages", topic, "leftovers", wt.replace(/[^A-Za-z0-9._-]+/g, "_"));

// The leftover record the request names, from the squad's row (live or closed).
function leftoverOf(x: Exec, a: Action, wt: string): { path: string; branch?: string; unit?: string } | null {
  const row = x.store.get("squads", { project: a.project, topic: a.squad ?? "" });
  try {
    const l = (JSON.parse(String(row?.doc ?? "{}")).leftovers ?? []).find((r: { wt?: string }) => r?.wt === wt);
    return l?.path ? l : null;
  } catch { return null; }
}

// Untracked paths the removal would lose: every untracked file but dev-studio's own (OURS, as leftoverCheck
// counts them), and each ignored one (an ignored folder whole) outside the rebuildable dirs (ALLOWED).
async function untracked(path: string): Promise<string[] | null> {
  const [plain, ignored] = await Promise.all([
    spawn(["git", "-C", path, "ls-files", "--others", "--exclude-standard", "-z"], {}, 60_000),
    spawn(["git", "-C", path, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], {}, 60_000)]);
  if (plain.code !== 0 || ignored.code !== 0) return null;
  const top = (f: string) => f.includes("/") ? f.replace(/\/.*$/, "/") : f;
  return [...plain.out.split("\0").filter((f) => f && !OURS.test(`?? ${f}`)),
    ...ignored.out.split("\0").filter((f) => f && !ALLOWED.has(top(f)))];
}

// The patch, the tar and the ref; why it failed, or null.
export async function save(path: string, dir: string): Promise<string | null> {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { return `cannot make ${dir}: ${(e as Error).message}`; }
  const diff = await spawn(["git", "-C", path, "diff", "--binary", "HEAD"], {}, 120_000);
  if (diff.code !== 0) return `git diff: ${diff.err.trim() || `exit ${diff.code}`}`;
  try { writeFileSync(join(dir, "changes.patch"), diff.out, { mode: 0o600 }); } catch (e) { return `cannot write the patch: ${(e as Error).message}`; }
  const files = await untracked(path);
  if (!files) return "cannot list the untracked files";
  const tar = join(dir, "untracked.tar");
  rmSync(tar, { force: true });
  if (files.length > 0) {
    const list = join(dir, ".untracked.list");
    writeFileSync(list, files.join("\0") + "\0");
    const t = await spawn(["tar", "-C", path, "-cf", tar, "--null", "-T", list], {}, 300_000);
    rmSync(list, { force: true });
    if (t.code !== 0) return `tar: ${t.err.trim() || `exit ${t.code}`}`;
  }
  const ref = await spawn(["git", "-C", path, "update-ref", `refs/ds-leftovers/${basename(path)}`, "HEAD"], {}, 30_000);
  if (ref.code !== 0) return `update-ref: ${ref.err.trim() || `exit ${ref.code}`}`;
  return null;
}

async function remove(a: Action, x: Exec): Promise<Result> {
  const r = payloadOf<"leftover-remove">(a);
  const by = r.request == null ? "board"
    : (x.store.db.query("SELECT requested_by FROM requests WHERE id = ?").get(r.request) as { requested_by: string | null } | null)?.requested_by ?? "board";
  const end = (result: Record<string, unknown>, text: string): Result => { finishRequest(x.store, a, result, x.now); return { done: true, result: text }; };
  const l = leftoverOf(x, a, r.wt);
  if (!l) return end({ ok: false, error: "no such leftover" }, "failed: no such leftover");
  if (!existsSync(l.path)) return end({ ok: false, error: "its folder is gone" }, "failed: folder gone");
  const p: P = { label: a.project, topic: a.squad!, wt: r.wt, path: l.path, unit: l.unit };
  const fetched = await fetchTarget(l.path, x.now);
  if (fetched.error) x.store.event("leftover_fetch_failed", { project: a.project, squad: a.squad, unit: p.unit ?? null, payload: { wt: r.wt, path: l.path, error: fetched.error } });

  // Safe as U1 reads it, or the very tree the operator looked at (then it is saved first).
  let keep = false;
  const gate = async (path: string): Promise<Checked> => {
    const check = await leftoverCheck(path);
    if (!check) return note(a, x, p, "probe-failed", `leftover ${path} (${p.unit ?? ""}): worktree probe failed — left as is`);
    await record(a, x, p, path, check);
    if (check.safe) {
      const ignored = await spawn(["git", "-C", path, "status", "--porcelain", "--ignored=matching"], {}, 60_000);
      const lost = ignored.code === 0 ? await stray(path, ignored.out) : null;
      if (lost === false) { keep = false; return { check }; }
    }
    if (!r.fingerprint) return { done: true, result: check.safe ? "refused: ignored files not on main" : `refused: ${leftText(check).slice(6)}` };
    if (await leftoverFingerprint(path, check) !== r.fingerprint) return { done: true, result: CHANGED };
    keep = true;
    return { check };
  };
  const dir = saveDir(x.store.root, a.project, a.squad!, r.wt);
  let saved: string | null = null;
  const out = await removeLeftover(a, x, p, gate, async (path) => {
    if (!keep) return null;
    const why = await save(path, dir);
    if (!why) saved = dir;
    return why;
  });
  if (!("removed" in out)) {
    if ("wait" in out) return out;
    const text = "done" in out ? String(out.result) : "dropped" in out ? `dropped: ${out.dropped}` : "failed" in out ? String(out.failed) : "left";
    finishRequest(x.store, a, { ok: false, state: text.startsWith("refused") ? "refused" : "left", error: text }, x.now);
    return "done" in out ? out : { done: true, result: text };
  }
  const check: LeftoverCheck = out.removed, ref = saved ? `refs/ds-leftovers/${basename(l.path)}` : null;
  x.store.event("leftover_removed", { project: a.project, squad: a.squad, unit: p.unit ?? null,
    payload: { wt: r.wt, path: l.path, branch: l.branch ?? null, by, safe: !keep, commits: check.commits.length, n_differ: check.n_differ,
      differ: check.differ.slice(0, 20), saved, ref } });
  return end({ ok: true, state: "removed", saved, ref },
    saved ? `removed: saved to ${saved}` : "removed: all on main");
}

const leftoverRemove: Fulfiller = {
  name: "leftover-remove",
  kinds: ["leftover-remove"],
  run: (ctx) => requestActions(ctx, ["leftover-remove"]),
  exec(a, x) {
    if (!a.project || !a.squad) return { failed: "a leftover removal needs a project and a squad" };
    return { background: remove(a, x) };
  },
  giveUp: (a, x, why) => failRequest(a, x, why),
};
export default leftoverRemove;
