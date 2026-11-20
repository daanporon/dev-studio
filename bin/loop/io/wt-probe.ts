// wt-probe.ts — is a worktree safe to remove (U274: the twin of the old shell lib's wt_probe, the rule close,
// the leftover-worktree fulfiller and tidy share). Prints what wt_probe printed: `<dirty>\t<unpushed>`, then up
// to 20 dirty paths; dirty = `git status --porcelain --untracked-files=all` minus dev-studio's own per-worktree
// files, unpushed = commits on HEAD not on any remote. code 1 when git fails or the count is not a number.
import { spawn, type Out } from "./orca.ts";

/** Porcelain lines that are dev-studio's own per-worktree files (the role brief, the role settings). */
export const OURS = /^\?\? (CLAUDE\.local\.md|\.claude\/(settings\.local\.json)?)$/;

export async function wtProbe(path: string, timeoutMs: number): Promise<Out> {
  const failed: Out = { code: 1, out: "", err: "" };
  // Both reads at once; a failed status still wins, as when they ran one after the other.
  const [st, up] = await Promise.all([
    spawn(["git", "-C", path, "status", "--porcelain", "--untracked-files=all"], {}, timeoutMs),
    spawn(["git", "-C", path, "rev-list", "--count", "HEAD", "--not", "--remotes"], {}, timeoutMs),
  ]);
  if (st.code !== 0) return failed;
  const unpushed = up.out.replace(/\n+$/, "");
  if (up.code !== 0 || !/^[0-9]+$/.test(unpushed)) return failed;
  const names = st.out.replace(/\n+$/, "").split("\n").filter((l) => !OURS.test(l)).map((l) => l.slice(3)).join("\n").replace(/\n+$/, "");
  if (names === "") return { code: 0, out: `0\t${unpushed}\n`, err: "" };
  const lines = names.split("\n");
  return { code: 0, out: `${lines.length}\t${unpushed}\n${lines.slice(0, 20).join("\n")}\n`, err: "" };
}
