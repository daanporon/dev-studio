#!/usr/bin/env bash
# leak-hooks.sh — the repo turns its own leak hooks on, and every commit and push then runs the leak guard
# (public-readiness U8, U11): githooks/setup.sh, githooks/pre-commit, githooks/pre-push, githooks/blocked-roots,
# package.json's "prepare" and the SessionStart hook in .claude/settings.json.
# Everything runs in a temp dir: an origin whose main carries this checkout's githooks/, guard, package.json and
# .claude/settings.json, bare remotes, clones with linked worktrees, and a temp HOME whose ~/.config/dev-studio/
# holds the planted word list, so the guard finds it the way a role worktree does. It never touches this repo.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
command -v python3 > /dev/null || { echo "leak-hooks: python3 missing — skipped"; echo "leak-hooks: 0 passed, 0 failed"; exit 0; }
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_COMMON_DIR GIT_ALTERNATE_OBJECT_DIRECTORIES
unset DS_STATE_ROOT DS_LEAK_WORDS LEAK_GUARD_ROOT XDG_CONFIG_HOME CLAUDE_PROJECT_DIR
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
mkdir -p "$HOME/.config/dev-studio"
printf '# planted\nquuxlistword\n' > "$HOME/.config/dev-studio/leak-words.txt"
at='@'
MAIL="plantedmail${at}gmail.com"

pass=0; fail=0
good() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "  FAIL: $1" >&2; }
eq() { if [ "$2" = "$3" ]; then good; else bad "$1: got [$2], want [$3]"; fi; }
# no_value <case> <output>: a refusal names the kind, never the planted value.
no_value() { if grep -qiE 'quuxlistword|plantedmail' <<< "$2"; then bad "$1: the output holds the planted value"; else good; fi; }
hooks_path() { git -C "$1" config --get core.hooksPath; }

# The shipped blocked-roots: comments and full commit ids only.
if grep -vE '^(#.*)?$' "$ROOT/githooks/blocked-roots" | grep -qvxE '[0-9a-f]{40}'; then bad "githooks/blocked-roots holds a line that is not a commit id"; else good; fi
# Every root of the old origin's refs: the three on main, the old A1 branches' and the pr-assets branch's.
for r in 1da346c90c2efd65fbe4d7b701aad40ad4930efb 42e5cbeb24cd2122d6260978696526e0020a91c7 \
  4356c5e2f84938fb7fae048c0e6049562083d084 5467cc0d9bd065ae634905a6911707eadba843eb 582e49fc64ffe6e70e563bd8d5a32ffcf51a5a81; do
  grep -qxF "$r" "$ROOT/githooks/blocked-roots" && good || bad "githooks/blocked-roots should list the old root ${r:0:12}"
done
# The two triggers name setup.sh the way the plan says: `bun install` and every Claude session in the repo.
eq "package.json runs setup on prepare" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["scripts"]["prepare"])' "$ROOT/package.json")" "sh githooks/setup.sh"
SESSION_CMD="$(python3 -c 'import json,sys
d = json.load(open(sys.argv[1]))
print("\n".join(h["command"] for e in d["hooks"]["SessionStart"] for h in e["hooks"]))' "$ROOT/.claude/settings.json")"
eq "the SessionStart hook runs setup from the project dir" "$SESSION_CMD" 'sh "$CLAUDE_PROJECT_DIR"/githooks/setup.sh'

# --- remotes and clones -------------------------------------------------------------------------------------
# origin: a dev-studio repo. Its root commit is the "old history" (no hooks); main's next commit adds this
# checkout's githooks/ (blocked-roots listing that root), guard, package.json and .claude/settings.json.
S="$T/seed"
git init -q -b main "$S"
echo "readme" > "$S/README.md"
git -C "$S" add -A && git -C "$S" commit -qm "root"
ROOTSHA="$(git -C "$S" rev-parse HEAD)"
mkdir -p "$S/tests" "$S/.claude"
cp -r "$ROOT/githooks" "$S/githooks"
printf '# test\n%s\n' "$ROOTSHA" > "$S/githooks/blocked-roots"
cp "$ROOT/tests/leak-guard.sh" "$S/tests/leak-guard.sh"
cp "$ROOT/package.json" "$S/package.json"
cp "$ROOT/.claude/settings.json" "$S/.claude/settings.json"
git -C "$S" add -A && git -C "$S" commit -qm "the leak hooks"
git init -q --bare -b main "$T/origin.git"
git -C "$S" push -q "$T/origin.git" main
# other: another project, no hooks of its own.
git init -q -b main "$T/seed-other" && echo r > "$T/seed-other/README.md"
git -C "$T/seed-other" add -A && git -C "$T/seed-other" commit -qm root
git init -q --bare -b main "$T/other.git" && git -C "$T/seed-other" push -q "$T/other.git" main
git init -q --bare -b main "$T/fresh.git"
git clone -q "$T/origin.git" "$T/clone"
git clone -q "$T/other.git" "$T/otherproj"
git -C "$T/clone" worktree add -q -b feat "$T/wt" origin/main
W="$T/wt"

# --- setup.sh -----------------------------------------------------------------------------------------------
eq "a fresh clone has no hooks path" "$(hooks_path "$T/clone")" ""
MARK="ds.leak""Guard"   # the old gh gate's mark (U9, U11); split so the U12 Done grep finds no trace of it
git -C "$T/clone" config "$MARK" true
out="$(cd "$W" && sh githooks/setup.sh 2>&1)"; rc=$?
eq "setup exits 0" "$rc" 0
eq "setup in a linked worktree sets the relative hooks path in the clone" "$(hooks_path "$T/clone")" "githooks"
eq "the hooks path is in the shared config, not a worktree's" "$(git config --file "$T/clone/.git/config" --get core.hooksPath)" "githooks"
eq "setup unsets the old gh gate's mark (U12)" "$(git -C "$T/clone" config --get "$MARK")" ""
grep -q 'core.hooksPath set to githooks (was unset)' <<< "$out" && good || bad "setup should say what it set: $out"
out="$(cd "$W" && sh githooks/setup.sh 2>&1)"
eq "a second setup is quiet" "$out" ""
out="$(cd "$W/tests" && sh "$W/githooks/setup.sh" 2>&1)"
eq "setup from a subfolder is quiet too" "$out" ""

# A clone armed the U8 way (absolute path to another checkout's githooks/) moves to the relative path in one run.
git clone -q "$T/origin.git" "$T/u8"
git -C "$T/u8" config core.hooksPath "$T/hostcheckout/githooks"
out="$(cd "$T/u8" && sh githooks/setup.sh 2>&1)"
eq "a U8-armed clone moves to the relative path" "$(hooks_path "$T/u8")" "githooks"
grep -qF "(was $T/hostcheckout/githooks)" <<< "$out" && good || bad "setup should name the path it replaced: $out"

# Nothing outside its own clone: another project run from, a copy outside git, a githooks/ inside another repo.
out="$(cd "$T/otherproj" && sh "$W/githooks/setup.sh" 2>&1)"
eq "setup run from another project leaves that project alone" "$(hooks_path "$T/otherproj")" ""
eq "and says nothing about it" "$out" ""
mkdir -p "$T/copy" && cp -r "$ROOT/githooks" "$T/copy/githooks"
out="$(cd "$T/copy" && sh githooks/setup.sh 2>&1)"; rc=$?
eq "a copy outside git does nothing and exits 0" "$rc:$out" "0:"
mkdir -p "$T/otherproj/vendor" && cp -r "$ROOT/githooks" "$T/otherproj/vendor/githooks"
out="$(cd "$T/otherproj" && sh vendor/githooks/setup.sh 2>&1)"
eq "a githooks/ folder inside another repo does nothing" "$(hooks_path "$T/otherproj"):$out" ":"
rm -rf "$T/otherproj/vendor"

# A branch from before the hooks: setup warns, from the worktree it is run in.
git -C "$T/clone" worktree add -q --detach "$T/old" "$ROOTSHA"
out="$(cd "$T/old" && sh "$W/githooks/setup.sh" 2>&1)"
grep -q 'this branch predates the leak hooks; take in main before committing' <<< "$out" && good || bad "setup should warn in a worktree of an old branch: $out"
git -C "$T/clone" worktree add -q -b nopc "$T/nopc" origin/main
git -C "$T/nopc" rm -q githooks/pre-commit && git -C "$T/nopc" commit -qm "drop the hook"
out="$(cd "$T/nopc" && sh githooks/setup.sh 2>&1)"
grep -q 'this branch predates the leak hooks' <<< "$out" && good || bad "setup should warn on a branch without githooks/pre-commit: $out"

# The triggers: the SessionStart command as Claude Code runs it, and `bun install` (its prepare script).
git clone -q "$T/origin.git" "$T/cc"
out="$(cd "$T/cc/tests" && CLAUDE_PROJECT_DIR="$T/cc" sh -c "$SESSION_CMD" 2>&1)"; rc=$?
eq "the SessionStart command arms the clone" "$rc:$(hooks_path "$T/cc")" "0:githooks"
if command -v bun > /dev/null; then
  git clone -q "$T/origin.git" "$T/bunclone"
  # No dependencies, so the install needs no network; the prepare script is the real one.
  python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.pop("devDependencies",None); open(p,"w").write(json.dumps(d))' "$T/bunclone/package.json"
  out="$(cd "$T/bunclone" && bun install 2>&1)"; rc=$?
  eq "bun install arms the clone (rc $rc: $out)" "$(hooks_path "$T/bunclone")" "githooks"
else
  echo "  (bun missing: the bun install case is skipped)"
fi

# --- pre-commit (in a linked worktree, running its own hooks and guard) -------------------------------------
echo "a quuxlistword here" > "$W/words.txt"
git -C "$W" add words.txt
before="$(git -C "$W" rev-parse HEAD)"
out="$(git -C "$W" commit -qm "add words" 2>&1)"; rc=$?
[ "$rc" != 0 ] && good || bad "a commit of a file holding a list word was not refused"
eq "the refused commit made no commit" "$(git -C "$W" rev-parse HEAD)" "$before"
grep -q 'words.txt' <<< "$out" && grep -qi 'host-local list' <<< "$out" && good || bad "the refusal should name the file and the kind: $out"
grep -q 'never --no-verify' <<< "$out" && good || bad "the refusal should say not to use --no-verify: $out"
no_value "pre-commit list word" "$out"
git -C "$W" rm -q --cached words.txt && rm "$W/words.txt"

# A clean commit keeps exactly the staged files; an unstaged one stays out.
mkdir -p "$W/b"; echo one > "$W/a.txt"; echo two > "$W/b/c.txt"; echo three > "$W/unstaged.txt"
git -C "$W" add a.txt b/c.txt
out="$(git -C "$W" commit -qm "clean files" 2>&1)"; rc=$?
[ "$rc" = 0 ] && good || bad "a clean commit was refused: $out"
eq "the clean commit holds exactly the staged files" "$(git -C "$W" diff-tree --no-commit-id --name-only -r HEAD | tr '\n' ' ')" "a.txt b/c.txt "
rm "$W/unstaged.txt"

# commit -a stages through index.lock: the hook sees the tracked change.
echo "mail $MAIL" >> "$W/a.txt"
before="$(git -C "$W" rev-parse HEAD)"
out="$(git -C "$W" commit -qam "commit -a" 2>&1)"; rc=$?
[ "$rc" != 0 ] && eq "commit -a made no commit" "$(git -C "$W" rev-parse HEAD)" "$before" || bad "commit -a of a gmail address was not refused"
no_value "pre-commit commit -a" "$out"
git -C "$W" checkout -q -- a.txt

# No word list: every commit is refused, on purpose.
echo clean > "$W/clean.txt"; git -C "$W" add clean.txt
out="$(HOME="$T/nolist" git -C "$W" commit -qm "no list" 2>&1)" && bad "a commit with no word list was not refused" || { grep -q 'no host-local word list' <<< "$out" && good || bad "the no-list refusal should say so: $out"; }
# The old place still works until the list moves, with one line asking for the move.
mkdir -p "$T/oldhome/.dev-studio/state" && cp "$HOME/.config/dev-studio/leak-words.txt" "$T/oldhome/.dev-studio/state/leak-words.txt"
echo "quuxlistword" > "$W/w2.txt"; git -C "$W" add w2.txt
out="$(HOME="$T/oldhome" git -C "$W" commit -qm "old list" 2>&1)" && bad "a commit of a list word with the list in the old place was not refused" \
  || { grep -q 'host-local list' <<< "$out" && grep -q 'using the old word list' <<< "$out" && good || bad "the old-place refusal should name the kind and ask for the move: $out"; }
git -C "$W" rm -q --cached w2.txt && rm "$W/w2.txt"

# A missing guard refuses, saying why.
mv "$W/tests/leak-guard.sh" "$T/guard.bak"
out="$(git -C "$W" commit -qm "no guard" 2>&1)" && bad "a commit with no guard was not refused" || { grep -q 'leak guard is missing' <<< "$out" && good || bad "the no-guard refusal should say so: $out"; }
mv "$T/guard.bak" "$W/tests/leak-guard.sh"
git -C "$W" commit -qm "clean.txt" > /dev/null 2>&1 && good || bad "the clean commit after restoring the guard was refused"

# --- pre-push -----------------------------------------------------------------------------------------------
remote_has() { git --git-dir="$1" rev-parse -q --verify "refs/heads/$2" > /dev/null 2>&1; }
out="$(git -C "$W" push -q origin feat 2>&1)"; rc=$?
[ "$rc" = 0 ] && remote_has "$T/origin.git" feat && good || bad "a clean push to origin was refused (rc $rc): $out"

# A commit message with a gmail address (the files are clean, so the commit itself goes through).
echo more >> "$W/a.txt"; git -C "$W" add a.txt
git -C "$W" commit -qm "thanks $MAIL" > /dev/null 2>&1 || bad "a commit with clean files was refused"
out="$(git -C "$W" push -q origin feat 2>&1)"; rc=$?
[ "$rc" != 0 ] && good || bad "a push of a commit whose message holds a gmail address was not refused"
grep -qi 'message' <<< "$out" && good || bad "the push refusal should name the message: $out"
eq "the refused push left origin's feat where it was" "$(git --git-dir="$T/origin.git" rev-parse feat)" "$(git -C "$W" rev-parse HEAD~1)"
no_value "pre-push message" "$out"
git -C "$W" reset -q --hard HEAD~1

# A file added then deleted inside the pushed range (committed past the hook, as a commit made elsewhere).
git -C "$W" checkout -q -b gone
echo "quuxlistword" > "$W/gone.txt"; git -C "$W" add gone.txt
git -C "$W" -c core.hooksPath=/dev/null commit -qm "add" && git -C "$W" rm -q gone.txt && git -C "$W" commit -qm "delete" > /dev/null 2>&1
out="$(git -C "$W" push -q origin gone 2>&1)"; rc=$?
[ "$rc" != 0 ] && ! remote_has "$T/origin.git" gone && good || bad "a push of an add-then-delete range was not refused (rc $rc)"
grep -q 'gone.txt' <<< "$out" && good || bad "the add-then-delete refusal should name the file: $out"
no_value "pre-push add-then-delete" "$out"

# A new branch of clean commits pushes; deleting a branch sends nothing and passes.
git -C "$W" checkout -q -b newbranch feat
echo new > "$W/new.txt"; git -C "$W" add new.txt; git -C "$W" commit -qm "new" > /dev/null 2>&1
out="$(git -C "$W" push -q origin newbranch 2>&1)"; rc=$?
[ "$rc" = 0 ] && remote_has "$T/origin.git" newbranch && good || bad "a clean new branch push was refused (rc $rc): $out"
out="$(git -C "$W" push -q origin --delete newbranch 2>&1)"; rc=$?
[ "$rc" = 0 ] && ! remote_has "$T/origin.git" newbranch && good || bad "a branch delete was refused (rc $rc): $out"

# The old history to a fresh remote: its root is listed in blocked-roots.
out="$(git -C "$W" push -q "$T/fresh.git" feat 2>&1)"; rc=$?
[ "$rc" != 0 ] && ! remote_has "$T/fresh.git" feat && good || bad "a push of the old history to an empty remote was not refused (rc $rc)"
grep -q "old-history root commit ${ROOTSHA:0:12}" <<< "$out" && good || bad "the refusal should name the blocked root: $out"
# The same push by name: a remote the clone knows but which has nothing yet.
git -C "$T/clone" remote add fresh "$T/fresh.git"
git -C "$W" push -q fresh feat > /dev/null 2>&1 && bad "a push of the old history to a named empty remote was not refused" || good
# Stale remote-tracking refs never hide the old history: refs/remotes/origin/* still describe the old repo
# after a set-url or with a pushurl, so only what the push target itself advertises counts as already there.
git init -q --bare -b main "$T/fresh2.git"; git init -q --bare -b main "$T/fresh3.git"
git -C "$T/clone" config remote.origin.pushurl "$T/fresh2.git"
out="$(git -C "$W" push -q origin feat 2>&1)"; rc=$?
[ "$rc" != 0 ] && ! remote_has "$T/fresh2.git" feat && grep -q "old-history root commit ${ROOTSHA:0:12}" <<< "$out" && good \
  || bad "a push through a pushurl to an empty repo was not refused for the blocked root (rc $rc): $out"
git -C "$T/clone" config --unset remote.origin.pushurl
git -C "$T/clone" remote set-url origin "$T/fresh3.git"
out="$(git -C "$W" push -q origin feat 2>&1)"; rc=$?
[ "$rc" != 0 ] && ! remote_has "$T/fresh3.git" feat && grep -q "old-history root commit ${ROOTSHA:0:12}" <<< "$out" && good \
  || bad "a push after set-url to an empty repo was not refused for the blocked root (rc $rc): $out"
git -C "$T/clone" remote set-url origin "$T/origin.git"
# A target that stops answering after git's own handshake refuses (fail closed); git checks the remote before any
# hook runs, so the hook is called the way git calls it.
zero=0000000000000000000000000000000000000000
out="$(cd "$W" && echo "refs/heads/feat $(git rev-parse feat) refs/heads/feat $zero" | githooks/pre-push origin "$T/no-such.git" 2>&1)" \
  && bad "a push to a target that does not answer was not refused" \
  || { grep -q 'could not list what' <<< "$out" && good || bad "the unanswered refusal should say so: $out"; }
# With no blocked roots, the same clean history goes through (only the roots refused it).
: > "$W/githooks/blocked-roots"
out="$(git -C "$W" push -q fresh feat 2>&1)"; rc=$?
[ "$rc" = 0 ] && good || bad "a clean push to a fresh remote with no blocked roots was refused (rc $rc): $out"

# --- the other project behaves as before ---------------------------------------------------------------------
echo "quuxlistword" > "$T/otherproj/w.txt"; git -C "$T/otherproj" add w.txt
git -C "$T/otherproj" commit -qm "other" > /dev/null 2>&1 && good || bad "a commit there was refused: no hook should run there"
git -C "$T/otherproj" push -q origin main > /dev/null 2>&1 && good || bad "a push there was refused: no hook should run there"

echo "leak-hooks: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
