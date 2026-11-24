// wt-probe.ts — is a worktree safe to remove (U274: the twin of the old shell lib's wt_probe, the rule close,
// the leftover-worktree fulfiller and tidy share). Prints what wt_probe printed: `<dirty>\t<unpushed>`, then up
// to 20 dirty paths; dirty = `git status --porcelain --untracked-files=all` minus dev-studio's own per-worktree
// files, unpushed = commits on HEAD not on any remote. code 1 when git fails or the count is not a number.
// orca-worktree-cleanup U1: with `opts.secured` (the paths rescue.ts holds a byte-for-byte copy of) an untracked
// file under `.scratch/` or `.lavish/` named there counts as ours too, and the first line gains a third field,
// `<dirty>\t<unpushed>\t<secured>`, the number of lines it dropped that way. With no `opts` the output is unchanged.
import { spawn, type Out } from "./orca.ts";

/** Porcelain lines that are dev-studio's own per-worktree files (the role brief, the role settings). */
export const OURS = /^\?\? (CLAUDE\.local\.md|\.claude\/(settings\.local\.json)?)$/;
/** The agent folders whose untracked files may be secured (copied out by rescue.ts) before a removal. */
export const SECURED_DIRS = [".scratch/", ".lavish/"];

/** Is this porcelain line ours: dev-studio's own file, or an untracked file under a secured folder that `secured`
 *  names. A quoted porcelain name (git quotes odd characters) never matches a secured path, so it stays dirty. */
export function oursLine(line: string, secured?: ReadonlySet<string>): boolean {
  if (OURS.test(line)) return true;
  if (!secured || !line.startsWith("?? ")) return false;
  const rel = line.slice(3);
  return !rel.startsWith('"') && SECURED_DIRS.some((d) => rel.startsWith(d)) && secured.has(rel);
}

export async function wtProbe(path: string, timeoutMs: number, opts?: { secured?: Iterable<string> }): Promise<Out> {
  const failed: Out = { code: 1, out: "", err: "" };
  // Both reads at once; a failed status still wins, as when they ran one after the other.
  const [st, up] = await Promise.all([
    spawn(["git", "-C", path, "status", "--porcelain", "--untracked-files=all"], {}, timeoutMs),
    spawn(["git", "-C", path, "rev-list", "--count", "HEAD", "--not", "--remotes"], {}, timeoutMs),
  ]);
  if (st.code !== 0) return failed;
  const unpushed = up.out.replace(/\n+$/, "");
  if (up.code !== 0 || !/^[0-9]+$/.test(unpushed)) return failed;
  const secured = opts ? new Set(opts.secured ?? []) : undefined;
  const all = st.out.replace(/\n+$/, "").split("\n").filter((l) => l !== "" && !OURS.test(l));
  const kept = all.filter((l) => !oursLine(l, secured));
  const tail = opts ? `\t${all.length - kept.length}` : "";
  const names = kept.map((l) => l.slice(3)).join("\n").replace(/\n+$/, "");
  if (names === "") return { code: 0, out: `0\t${unpushed}${tail}\n`, err: "" };
  const lines = names.split("\n");
  return { code: 0, out: `${lines.length}\t${unpushed}${tail}\n${lines.slice(0, 20).join("\n")}\n`, err: "" };
}
