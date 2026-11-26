// rescue.ts — lavish-docs-not-stored U3: before the loop removes a member's worktree (close.ts's remove
// phase, archive and suspend), copy the review pages and working notes still inside it into
// `<state root>/<label>/pages/<topic>/rescued/<role[-suffix]>/<path inside the worktree>`:
//   - each file an `observed_sessions` row (a Lavish session) names under the worktree, with the other
//     untracked or ignored files in its folder and below (pages use relative paths), at most
//     `DS_RESCUE_FOLDER_MB` (20) per folder; a page at the worktree's top takes only its top-level siblings;
//   - each untracked or ignored `*.html` / `*.md` under `.lavish/`, `.scratch/`, `docs/plans/` and
//     `docs/brainstorms/` (`git ls-files --others`, which lists ignored files too; `node_modules`, `.env*` and
//     `CLAUDE.local.md` skipped). A file gone between the listing and its copy is skipped;
//   - (orca-worktree-cleanup U1) every other untracked or ignored file under `.scratch/` and `.lavish/`, whatever
//     its extension, with the same skips (and symlinks, and anything not a regular file), sharing one budget per
//     worktree, `DS_RESCUE_SCRATCH_MB` (64); a file that does not fit is counted in `capped`, not copied.
// `secured` lists the paths under `.scratch/` and `.lavish/` whose bytes are now at the destination (copied this
// time or already there, under the name or a numbered twin): wt-probe.ts counts those as ours, so close.ts can
// remove a tree whose only extra files were these copies.
// Copy only: nothing in the worktree is deleted or edited, and nothing at the destination is overwritten:
// the same content already there (under its name or a numbered one) is skipped, different content is
// written as `<name>.<n>.<ext>` (through a temp file and a hard link, so a replay never sees half a file).
// A failed copy (no space, permission) is `ok: false` with the why; a failed git listing is not: the
// session files are still copied and the probe that follows decides the worktree's fate.
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { spawn } from "./orca.ts";
import type { Store } from "../core/store.ts";

export const NOTE_DIRS = [".lavish", ".scratch", "docs/plans", "docs/brainstorms"];
const NOTE_EXT = /\.(html|md)$/i;
/** The agent folders copied whole (orca-worktree-cleanup U1). */
export const SCRATCH_DIRS = [".lavish", ".scratch"];
// Never copied: dependencies, env files (secrets) and the role brief.
const SKIP = ["node_modules/**", "**/node_modules/**", ".env", ".env.*", "**/.env", "**/.env.*", "CLAUDE.local.md", "**/CLAUDE.local.md"]
  .map((g) => `:(exclude,glob)${g}`);

export type Rescued = {
  ok: boolean; why?: string; dest: string;
  count: number; bytes: number; same: number; capped: number; listed: boolean; files: string[];
  secured: string[];
  /** side-loop-host U5: a rescue on a side host leaves the files over the upload cap there, in this folder. */
  host_dest?: string; host_files?: string[];
};

export const rescueDest = (root: string, project: string, squad: string, label: string): string =>
  join(root, project, "pages", squad, "rescued", label);

/** Paths (inside the worktree) of the files a Lavish session names under it; the start log is no page. */
export function sessionFiles(store: Store, path: string): string[] {
  const pre = path.endsWith("/") ? path : `${path}/`;
  const rows = store.db.query("SELECT file FROM observed_sessions WHERE COALESCE(status, '') != 'log' AND substr(file, 1, ?) = ?")
    .all(pre.length, pre) as { file: string }[];
  return [...new Set(rows.map((r) => r.file.slice(pre.length)).filter((f) => f && !f.split("/").includes("..")))].sort();
}

const folderOf = (rel: string): string => rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
const under = (rel: string, dir: string): boolean => dir === "" ? !rel.includes("/") : rel.startsWith(`${dir}/`);
const mb = (env: string | undefined, dflt: number): number => {
  const v = Number(env);
  return (Number.isFinite(v) && v > 0 ? v : dflt) * 1024 * 1024;
};
const capBytes = (): number => mb(process.env.DS_RESCUE_FOLDER_MB, 20);
const scratchBytes = (): number => mb(process.env.DS_RESCUE_SCRATCH_MB, 64);

/** The size of a regular file (no symlink, no folder), or null. */
async function sizeOf(p: string): Promise<number | null> {
  try { const s = await lstat(p); return s.isFile() ? s.size : null; } catch { return null; }
}

/** Untracked and ignored files under the given folders, or null when git cannot list them. */
async function others(path: string, dirs: string[]): Promise<string[] | null> {
  const specs = dirs.map((d) => d === "" ? ":(glob)*" : `:(glob)${d}/**`);
  const r = await spawn(["git", "-C", path, "ls-files", "--others", "-z", "--", ...specs, ...SKIP], {}, 60_000);
  if (r.code !== 0) return null;
  return r.out.split("\0").filter((f) => f && !f.endsWith("/"));
}

/** Copy one file without overwriting: "same" when its content is already at `dst` or a numbered twin. */
async function place(src: string, dst: string): Promise<"copied" | "same"> {
  return placeBody(await readFile(src), dst);
}

/** Write `body` at `dst` without overwriting (side-loop-host U5: also the bytes a side host uploaded). */
export async function placeBody(body: Buffer, dst: string): Promise<"copied" | "same"> {
  const ext = extname(dst), base = dst.slice(0, dst.length - ext.length);
  await mkdir(dirname(dst), { recursive: true });
  for (let n = 0; ; n++) {
    const at = n === 0 ? dst : `${base}.${n}${ext}`;
    let have: Buffer | null = null;
    try { have = await readFile(at); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (have?.equals(body)) return "same";
    if (have) continue;
    const tmp = `${at}.rescue-${process.pid}.tmp`;
    await writeFile(tmp, body);
    try { await link(tmp, at); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; continue; } finally { await unlink(tmp).catch(() => {}); }
    return "copied";
  }
}

/** What a rescue of the tree at `path` copies: the files in order with their sizes, the paths left out by a cap, and
 *  whether git could list the untracked files (side-loop-host U5: a side host plans its own trees the same way). */
export type RescuePlan = { plan: { rel: string; size: number }[]; capped: number; listed: boolean };

export async function planRescue(path: string, pages: string[]): Promise<RescuePlan> {
  const folders = [...new Set(pages.map(folderOf))];
  const listed = await others(path, [...NOTE_DIRS, ...folders]);
  const loose = listed ?? [];
  // The plan: per page folder the page itself always, then its untracked neighbours while under the cap.
  const plan: { rel: string; size: number }[] = [], seen = new Set<string>(), capped = new Set<string>(), cap = capBytes();
  for (const dir of folders) {
    let used = 0;
    for (const rel of pages.filter((p) => folderOf(p) === dir)) {
      const size = await sizeOf(join(path, rel));
      if (size == null || seen.has(rel)) continue;
      seen.add(rel); plan.push({ rel, size }); used += size;
    }
    for (const rel of loose.filter((f) => under(f, dir)).sort()) {
      if (seen.has(rel)) continue;
      const size = await sizeOf(join(path, rel));
      if (size == null) continue;
      if (used + size > cap) { capped.add(rel); continue; }
      seen.add(rel); plan.push({ rel, size }); used += size;
    }
  }
  for (const rel of loose.filter((f) => NOTE_EXT.test(f) && NOTE_DIRS.some((d) => under(f, d))).sort()) {
    if (seen.has(rel)) continue;
    const size = await sizeOf(join(path, rel));
    if (size == null) continue;
    if (size > cap) { capped.add(rel); continue; }
    capped.delete(rel); seen.add(rel); plan.push({ rel, size });
  }
  // The rest of the agent folders, any extension, under one budget for the worktree.
  let left = scratchBytes();
  for (const rel of loose.filter((f) => SCRATCH_DIRS.some((d) => under(f, d))).sort()) {
    if (seen.has(rel)) continue;
    const size = await sizeOf(join(path, rel));
    if (size == null) continue;
    if (size > left) { capped.add(rel); continue; }
    capped.delete(rel); seen.add(rel); plan.push({ rel, size }); left -= size;
  }
  return { plan, capped: capped.size, listed: listed != null };
}

/** A path under `.scratch/` or `.lavish/`: once its bytes are copied out, wt-probe.ts counts it as ours. */
export const securable = (rel: string): boolean => SCRATCH_DIRS.some((d) => under(rel, d));

export async function rescuePages(store: Store, project: string, squad: string, label: string, path: string): Promise<Rescued> {
  const dest = rescueDest(store.root, project, squad, label);
  const out: Rescued = { ok: true, dest, count: 0, bytes: 0, same: 0, capped: 0, listed: true, files: [], secured: [] };
  const { plan, capped, listed } = await planRescue(path, sessionFiles(store, path));
  out.capped = capped;
  out.listed = listed;
  for (const { rel, size } of plan) {
    try {
      if (await place(join(path, rel), join(dest, rel)) === "same") { out.same++; if (securable(rel)) out.secured.push(rel); continue; }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT" && !existsSync(join(path, rel))) continue;   // gone since the listing: nothing to keep
      return { ...out, ok: false, why: `${err.code ?? "error"} on ${rel}: ${String(err.message ?? e).split("\n")[0]}`.slice(0, 200) };
    }
    out.count++; out.bytes += size; out.files.push(rel);
    if (securable(rel)) out.secured.push(rel);
  }
  return out;
}
