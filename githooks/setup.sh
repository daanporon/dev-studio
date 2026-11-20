#!/bin/sh
# githooks/setup.sh — turn on this repo's leak hooks in the clone that holds this script (public-readiness U11).
# It sets core.hooksPath to the relative `githooks`, which git reads from the top of each worktree, so every
# worktree runs its own branch's pre-commit and pre-push and its own tests/leak-guard.sh. It replaces any other
# value (an absolute path to another checkout's githooks/ included). It lives in the clone's shared config, which
# every worktree of the clone reads. core.hooksPath turns off .git/hooks: any later hook goes in githooks/.
# It unsets ds.leakGuard, the mark the Studio's old gh gate read (U12 moved that check into the repo:
# githooks/gh-text-check, a PreToolUse hook in .claude/settings.json).
# It warns when the worktree it is run from (else its own) has no githooks/pre-commit: a branch from before the
# leak hooks, whose commits and pushes no hook checks.
# Two things run it: `bun install` (package.json "prepare") and every Claude session in a worktree of this repo
# (the SessionStart hook in .claude/settings.json). It prints nothing when nothing changes, and does nothing
# when this folder is not the top of a git work tree (a copy, or a folder inside another repo).
here="$(cd "$(dirname "$0")" && pwd -P)" || exit 0
top="$(cd "$here/.." && pwd -P)" || exit 0
own="$(git -C "$top" rev-parse --show-toplevel 2> /dev/null)" || exit 0
[ -n "$own" ] && [ "$(cd "$own" && pwd -P)" = "$top" ] || exit 0
common="$(git -C "$top" rev-parse --path-format=absolute --git-common-dir 2> /dev/null)" || exit 0

# The worktree to check: the one it is run from when that is a worktree of this clone, else its own.
wt="$top"
cwd_top="$(git rev-parse --show-toplevel 2> /dev/null)"
if [ -n "$cwd_top" ] && [ "$(git rev-parse --path-format=absolute --git-common-dir 2> /dev/null)" = "$common" ]; then
  wt="$cwd_top"
fi

have="$(git -C "$top" config --local --get core.hooksPath 2> /dev/null)"
if [ "$have" != githooks ]; then
  if git -C "$top" config --local core.hooksPath githooks; then
    echo "githooks/setup.sh: core.hooksPath set to githooks (was ${have:-unset}) — this repo's leak hooks are on"
  else
    echo "githooks/setup.sh: could not set core.hooksPath in $common/config — the leak hooks are off" >&2
  fi
fi
# A per-worktree config (extensions.worktreeConfig) wins over the shared one: say so, never change it.
eff="$(git -C "$wt" config --get core.hooksPath 2> /dev/null)"
if [ "$eff" != githooks ]; then
  echo "githooks/setup.sh: warning — core.hooksPath reads '${eff:-unset}' in $wt (a worktree config?), so its leak hooks do not run"
fi
if git -C "$top" config --local --get ds.leakGuard > /dev/null 2>&1; then
  git -C "$top" config --local --unset-all ds.leakGuard || echo "githooks/setup.sh: could not unset ds.leakGuard" >&2
fi
if [ ! -f "$wt/githooks/pre-commit" ]; then
  echo "githooks/setup.sh: warning — this branch predates the leak hooks; take in main before committing ($wt has no githooks/pre-commit, so no hook checks its commits or pushes)"
fi
exit 0
