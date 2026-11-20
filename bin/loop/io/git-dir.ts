// git-dir.ts — a worktree's git dir, where review-unit.sh keeps its per-worktree files (ds-review,
// ds-review-log, ds-review-stop, ds-review-start). Read by reconcilers/alerts.ts (a stopped review)
// and observers/reviews.ts (the board's review state). null when the path is not a git worktree.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function gitDir(wt: string): string | null {
  const g = spawnSync("git", ["-C", wt, "rev-parse", "--git-dir"], { encoding: "utf8" });
  if (g.status !== 0) return null;
  return resolve(wt, g.stdout.trim());
}
