#!/usr/bin/env bash
# githooks/gh-text-check (public-readiness U12): the PreToolUse hook on Bash in .claude/settings.json. Fed Claude
# Code's hook input, it refuses (exit 2, the reason on stderr) a gh or gh-axi call aimed at this clone's repo whose
# posted text fails tests/leak-guard.sh --text or tests/pr-title.sh (U10), or cannot be seen (--attach, --web,
# --editor, stdin, $(…), a call through bash -c, eval, xargs or env); it passes (exit 0) every other command and
# every call aimed at another repo. One case starts a real `claude -p` with the settings in a temp repo; it is
# skipped with no claude on PATH or with DS_TEST_CLAUDE=0, and notes (never fails) when claude ran nothing.
# The word list lives under a temp HOME's ~/.config/dev-studio/.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pass=0 fail=0
ok()  { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "  FAIL: $*"; }
eq()  { if [ "$2" = "$3" ]; then ok; else bad "$1: want [$3] got [$2]"; fi; }
has() { case "$2" in *"$3"*) ok ;; *) bad "$1: [$2] missing [$3]" ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1: [$2] has [$3]" ;; *) ok ;; esac; }

unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GH_REPO \
  DS_STATE_ROOT DS_LEAK_WORDS XDG_CONFIG_HOME
TMP="$(mktemp -d -p "${XDG_RUNTIME_DIR:-/tmp}")"; trap 'rm -rf "$TMP"' EXIT
REAL_HOME="$HOME" REAL_PATH="$PATH"
export HOME="$TMP/home"
mkdir -p "$HOME/.config/dev-studio" "$TMP/bin"
WORDS="$HOME/.config/dev-studio/leak-words.txt"
WORD=zorblattquix                                   # a made-up list word
printf '%s\n' "$WORD" > "$WORDS"
MAIL="pat.example""@gmail"".com"                    # a gmail address, built so this file holds none
HOST="plantedhost.tail9999.ts"".net"                # a ts.net host outside the example ones
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

g() { git -c user.name=t -c user.email=t@example.invalid "$@"; }
# A role worktree: a linked worktree of a clone that holds the check, the guard and the title check.
g init -q "$TMP/armed"; g -C "$TMP/armed" remote add origin git@github.com:ExampleOrg/Armed.git
mkdir -p "$TMP/armed/githooks" "$TMP/armed/tests"
cp "$ROOT/githooks/gh-text-check" "$ROOT/githooks/gh-text-check.py" "$TMP/armed/githooks/"
cp "$ROOT/tests/leak-guard.sh" "$ROOT/tests/pr-title.sh" "$TMP/armed/tests/"
g -C "$TMP/armed" add githooks tests; g -C "$TMP/armed" commit -q -m init
g -C "$TMP/armed" worktree add -q "$TMP/role" -b role
mkdir -p "$TMP/role/sub/deeper"
R="$TMP/role" HOOK="$TMP/role/githooks/gh-text-check"
g init -q "$TMP/other"; g -C "$TMP/other" remote add origin https://github.com/example-org/other.git
g init -q "$TMP/twin"; g -C "$TMP/twin" remote add origin https://github.com/exampleorg/armed   # same repo, another clone
mkdir -p "$TMP/plain"
D="$TMP/other"

printf 'Summary\n\nreach me at %s\n' "$MAIL" > "$TMP/mail.md"
printf 'Summary\n\nthe %s host\n' "$WORD" > "$TMP/word.md"
printf 'see http://%s/\n' "$HOST" > "$TMP/host.md"
printf 'Summary\n\nAll clean.\n' > "$TMP/clean.md"

# feed <dir> <command string> [hook]: the hook input Claude Code sends for a Bash call run in <dir>.
feed() {
  local d="$1" c="$2" h="${3:-$HOOK}"
  rc=0
  python3 -c 'import json,sys; print(json.dumps({"session_id": "s", "hook_event_name": "PreToolUse", "tool_name": "Bash",
    "tool_input": {"command": sys.argv[1], "description": "d"}, "cwd": sys.argv[2]}))' "$c" "$d" \
    | "$h" > "$TMP/out" 2> "$TMP/err" || rc=$?
}
# run <dir> <args…>: the command gh <args…>, each argument shell-quoted as a role would write it.
run() { local d="$1"; shift; feed "$d" "$(printf '%q ' gh "$@")"; }
refused() { eq "$1: refused (exit 2)" "$rc" "2"; }
passed()  { eq "$1: passed (exit 0)" "$rc:$(cat "$TMP/err")" "0:"; }
err() { cat "$TMP/err"; }

# --- planted texts are refused in a role worktree
run "$R" pr create --title "fix: t" --body-file "$TMP/mail.md";  refused "pr create --body-file with a gmail address"
has "the refusal names the text and the kind" "$(err)" "body-file:3: a gmail address"
hasnt "the refusal never prints the value" "$(err)" "$MAIL"
has "the refusal says never to post it another way" "$(err)" "never post it another way"
run "$R" pr create --title "fix: t" --body-file "$TMP/word.md";  refused "pr create --body-file with a list word"
hasnt "a list word is not printed" "$(err)" "$WORD"
feed "$R" "gh pr create --body \"$MAIL\"";                       refused "pr create --body with a gmail address"
has "a text value is named by its flag" "$(err)" "body:1: a gmail address"
feed "$R" "gh-axi pr create --title 'fix: t' --body-file $TMP/word.md"; refused "gh-axi pr create --body-file with a list word"
feed "$R" "gh api repos/exampleorg/armed/issues/1/comments -F body=@$TMP/host.md"; refused "gh api -F body=@file with a planted host"
has "a field file is named by its field" "$(err)" "field body:1: a ts.net host"
run "$R" pr review 12 --comment --body "see $MAIL";     refused "pr review --body"
run "$R" pr review 12 -c -b "the $WORD box";              refused "pr review -b"
run "$R" api repos/ExampleOrg/Armed/issues/1/comments -f body="hi $MAIL"; refused "gh api -f body="
run "$R" api graphql -F query='mutation{x}' -f body="the $WORD"; refused "gh api graphql -f body="
run "$R" api -X PATCH repos/exampleorg/armed/pulls/1 --raw-field "body=$MAIL"; refused "gh api --raw-field"
run "$R" api repos/exampleorg/armed/issues --input "$TMP/mail.md";     refused "gh api --input"
run "$R" api repos/exampleorg/armed/issues -fbody="$MAIL";             refused "gh api -fbody= (attached)"
run "$R" pr create -t "fix: the $WORD" -b ok;              refused "pr create -t"
run "$R" pr create --title="fix: ok" "--body=$MAIL";       refused "pr create --body="
run "$R" pr create -t"fix: ok" "-b$MAIL";                  refused "pr create -b attached"
run "$R" pr edit 3 --title "fix: the $WORD";               refused "pr edit --title"
run "$R" pr comment 3 -F "$TMP/mail.md";                   refused "pr comment -F"
run "$R" pr merge 3 --squash -t "fix: the $WORD";          refused "pr merge -t (the subject)"
run "$R" pr merge 3 --squash --body "$MAIL";               refused "pr merge --body"
run "$R" issue create --title "fix: ok" --body "$MAIL";    refused "issue create --body"
run "$R" issue comment 4 --body-file "$TMP/word.md";       refused "issue comment --body-file"
run "$R" release create v1 -n "$MAIL";                     refused "release create -n (notes)"
run "$R" release edit v1 --notes-file "$TMP/word.md";      refused "release edit --notes-file"
run "$R" pr new --title "fix: ok" --body "$MAIL";          refused "pr new (gh's alias of create)"
run "$R" issue new -b "the $WORD";                         refused "issue new"
run "$R" release new v2 --notes "$MAIL";                   refused "release new"
run "$R" pr close 3 --comment "the $WORD";                 refused "pr close --comment"
run "$R" pr close 3 -d -c "$MAIL";                         refused "pr close -c"
run "$R" issue close 4 -r "not planned" --comment="$MAIL"; refused "issue close --comment="
run "$R" pr reopen 3 -c "the $WORD";                       refused "pr reopen -c"
run "$R" issue reopen 4 --comment "$MAIL";                 refused "issue reopen --comment"
run "$R" pr comment "$WORD" --body fine;                  refused "a planted value in another word of the call"
feed "$R" "gh pr comment 3 --body-file $TMP/clean.md <<'EOF'
$MAIL
EOF";                                                      refused "a heredoc fed to the call"
run "$R" pr close 3 --delete-branch;                      passed "pr close with no comment"
run "$R" pr review 3 --comment -b fine;                   passed "pr review --comment is a switch"
run "$R" pr create --title "fix: ok" --body-file "$TMP/none.md"; refused "an unreadable body file"
has "an unreadable body file is named" "$(err)" "cannot read the body-file file"
feed "$R" "cd $R/sub && gh pr comment 3 --body-file b.md"; refused "a file written later in the same command cannot be read"
# --- texts that cannot be checked are refused
run "$R" pr create --title "fix: ok" --body ok --attach shot.png; refused "--attach"
has "--attach says why" "$(err)" "--attach"
run "$R" pr comment 3 --body ok --attach=a.png;           refused "--attach="
run "$R" pr create --web;                                 refused "--web"
run "$R" pr create -dw;                                   refused "-dw (a cluster with -w)"
run "$R" issue comment 4 --editor;                        refused "--editor"
run "$R" issue create -e;                                 refused "-e"
run "$R" pr create --title "fix: ok" --body-file -;       refused "--body-file - (stdin)"
feed "$R" "gh api repos/exampleorg/armed/issues --input - < $TMP/clean.md"; refused "--input - (stdin)"
run "$R" api repos/exampleorg/armed/issues -F body=@-;    refused "-F body=@- (stdin)"
feed "$R" 'gh pr comment 3 --body "$(cat n.md)"';          refused "--body \$(…)"
has "a filled-in text says to use a file" "$(err)" "--body-file <file>"
feed "$R" 'gh pr comment 3 --body "`cat n.md`"';           refused "--body with a backtick"
feed "$R" 'gh pr comment 3 --body "${BODY}"';              refused "--body \${…}"
feed "$R" 'gh pr comment 3 --body "$BODY"';                refused "--body \$NAME"
feed "$R" 'gh pr comment 3 --body-file <(cat n.md)';       refused "--body-file <(…)"
feed "$R" 'gh api repos/exampleorg/armed/issues -f "body=$X"'; refused "gh api -f body=\$NAME"
feed "$R" "gh pr comment 3 --body \$'a\\x40b'";            refused "--body \$'…'"
feed "$R" "bash -c 'gh pr comment 3 --body x'";            refused "a call through bash -c"
has "a wrapped call says to run gh directly" "$(err)" "reached through bash -c"
feed "$R" "sh -c 'cd sub && gh pr comment 3 --body x'";    refused "a call through sh -c"
feed "$R" "eval gh pr comment 3 --body x";                 refused "a call through eval"
feed "$R" "echo 3 | xargs gh pr comment --body x";         refused "a call through xargs"
feed "$R" "env GH_REPO=exampleorg/armed gh pr comment 3 --body x"; refused "a call through env"
feed "$R" 'bash -c "$CMD gh pr comment 3"';                refused "bash -c with a command built at run time"
feed "$R" "x=\$(gh pr comment 3 --body \"$MAIL\")";         refused "a call inside \$(…)"
feed "$R" "gh pr comment 3 --body \"open quote";           refused "an unreadable command that names gh"
has "an unreadable command says why" "$(err)" "cannot be read"
# --- review of U12: a text file the same command writes first, a shell's stdin, interpreter code, a built command word
cp "$TMP/clean.md" "$TMP/stale.md"   # a clean copy left at the path: the check must not read it and pass
feed "$R" "cat > $TMP/stale.md <<'EOF'
$MAIL
EOF
gh pr create --title 'feat(x): y' --body-file $TMP/stale.md";  refused "a body file a heredoc writes earlier in the command"
has "a stale body file says to run gh in its own command" "$(err)" "run the gh call in its own command"
feed "$R" "printf '%s' '$MAIL' > $TMP/stale.md && gh pr comment 3 --body-file $TMP/stale.md"; refused "a body file printf writes first"
feed "$R" "python3 gen.py && gh api repos/exampleorg/armed/issues -F body=@$TMP/stale.md"; refused "a field file after another command"
feed "$R" "bash <<'EOF'
gh pr comment 3 --body x
EOF";                                                      refused "a call fed to bash on a heredoc"
has "a shell's stdin says so" "$(err)" "bash on its standard input"
feed "$R" "sh -s <<EOF
cd sub && gh issue comment 4 --body x
EOF";                                                      refused "a call fed to sh -s on a heredoc"
feed "$R" "bash <<< 'gh pr comment 3 --body x'";           refused "a call fed to bash on a here-string"
feed "$R" "printf 'gh pr comment 3 --body x\\n' | bash";   refused "a call piped into bash"
printf 'gh pr comment 3 --body x\n' > "$TMP/post.sh"
feed "$R" "bash $TMP/post.sh";                             passed "a script file is a program: not read (the hook sees the command line)"
feed "$R" "python3 - <<'EOF'
import subprocess; subprocess.run(['gh', 'pr', 'comment', '3', '--body', 'x'])
EOF";                                                      refused "python on a heredoc calling gh"
feed "$R" "python3 -c \"import subprocess; subprocess.run(['gh','issue','comment','4'])\""; refused "python -c calling gh"
feed "$R" "node -e \"require('child_process').execSync('gh pr comment 3 --body x')\""; refused "node -e calling gh"
feed "$R" '"$(command -v gh)" pr comment 3 --body x';      refused "gh through a command word built at run time"
feed "$R" 'GH=gh; $GH pr comment 3 --body x';              refused "gh through \$GH"
feed "$R" '$RUN gh pr comment 3 --body x';                 refused "gh behind a runner the shell names"
feed "$R" "bash -o pipefail -c 'gh pr comment 3 --body x'"; refused "bash -o <value> -c"
feed "$R" "bash -O extglob +o posix -ec 'gh issue comment 4 --body x'"; refused "bash -O/+o values before -ec"
# --- clean calls and calls that post nothing pass, even with a planted value in them
run "$R" pr create --title "feat: add the thing" --body-file "$TMP/clean.md"; passed "pr create --body-file, clean"
run "$R" pr review 12 --approve --body "Looks good";      passed "pr review --body, clean"
run "$R" api repos/exampleorg/armed/issues/1/comments -f body="fine" -F n=1; passed "gh api -f body=, clean"
run "$R" pr list --search "$MAIL";                        passed "pr list"
run "$R" pr view 3 --comments;                            passed "pr view"
run "$R" api repos/exampleorg/armed/pulls -q ".[] | select(.body | contains(\"$WORD\"))"; passed "a plain GET"
run "$R" api -X GET search/issues -f q="$WORD";           passed "-X GET with fields (a query)"
run "$R" pr checkout 3 --branch "$WORD";                  passed "pr checkout"
feed "$R" "git status";                                   passed "a command with no gh"
feed "$R" "echo \"gh pr create --body $MAIL\"";           passed "an echo that names gh in a string"
feed "$R" "grep -rn gh $TMP/mail.md";                     passed "a gh word that runs no gh call"
feed "$R" "bash -c 'gh pr view 1'";                       passed "bash -c with a gh call that posts nothing"
feed "$R" "printf 'fine\\n' > $TMP/n.md && gh pr comment 3 --body fine"; passed "a clean text after another command"
feed "$R" "cd $R/sub && export X=1 && gh pr comment 3 --body-file $TMP/clean.md"; passed "a body file after cd and export"
feed "$R" "bash <<'EOF'
gh pr view 1
EOF";                                                      passed "bash on a heredoc with a gh call that posts nothing"
feed "$R" "python3 -c 'print(\"gh\")'";                     passed "python code that names gh but posts nothing"
feed "$R" "python3 - <<'EOF'
print('a \`gh\` call, a release and an issue')
EOF";                                                      passed "python code naming gh and a subcommand apart (a doc edit)"
feed "$R" '"$(command -v gh)" pr view 1';                  passed "a built command word that posts nothing"
feed "$R" '$RUN gh pr view 1';                             passed "a runner the shell names, with a gh call that posts nothing"
feed "$R" "bash -o pipefail $TMP/post.sh";                 passed "a script run with a shell option is a program"
eq "a non-Bash tool passes" "$(printf '{"tool_name":"Read","tool_input":{"file_path":"gh"}}' | "$HOOK"; echo $?)" "0"
eq "hook input that is not JSON and names gh is refused" "$(printf 'gh pr create' | "$HOOK" 2>/dev/null; echo $?)" "2"
# --- PR titles follow conventional commits (public-readiness U10, tests/pr-title.sh)
run "$R" pr create --title "board: x" --body-file "$TMP/clean.md";   refused "pr create --title, not conventional"
has "the refusal names the format" "$(err)" "<type>(<scope>)!: <summary>"
hasnt "the refusal never repeats the title" "$(err)" "board: x"
run "$R" pr create -t "board: x" --body-file "$TMP/clean.md";        refused "pr create -t, not conventional"
run "$R" pr create --title="Feat: x" --body-file "$TMP/clean.md";    refused "pr create --title=, not conventional"
run "$R" pr create --fill;                                           refused "pr create --fill, no title"
run "$R" pr create -f;                                               refused "pr create -f, no title"
run "$R" pr create --fill-first;                                     refused "pr create --fill-first, no title"
run "$R" pr create --fill-verbose;                                   refused "pr create --fill-verbose, no title"
run "$R" pr create -fd;                                              refused "pr create -fd (a cluster with -f), no title"
run "$R" pr edit 3 --title "board: x";                               refused "pr edit --title, not conventional"
run "$R" pr edit 3 --title="Feat: x";                                refused "pr edit --title=, not conventional"
run "$R" pr merge 3 --squash --subject "board: x";                   refused "pr merge --subject, not conventional"
run "$R" pr merge 3 --squash -t "Merge pull request #3";            refused "pr merge -t, not conventional"
run "$R" pr merge 3 --squash --subject="Feat: x";                    refused "pr merge --subject=, not conventional"
run "$R" pr create --title "feat(board): x" --body-file "$TMP/clean.md"; passed "pr create, a conventional title"
run "$R" pr create --fill --title "fix: x";                          passed "pr create --fill with a conventional title"
run "$R" pr edit 3 --title "refactor(loop)!: y";                     passed "pr edit, a conventional title"
run "$R" pr merge 3 --squash --subject "fix: x";                     passed "pr merge, a conventional subject"
run "$R" pr merge 3 --squash;                                        passed "pr merge, no subject"
run "$R" issue create --title "board: x" --body ok;                  passed "an issue title is not checked"
run "$R" release create v1 --title "Release one" --notes ok;         passed "a release title is not checked"
run "$R" release create v1 --target main --notes ok;                 passed "release create --target: its value is no asset"
run "$R" release create v1 ./notes.md --notes ok;                    refused "a release asset"
has "a release asset says why" "$(err)" "release asset"
run "$R" release upload v1 dump.zip;                                 refused "release upload"
# --- which repo is guarded
run "$R/sub/deeper" pr create --title "fix: t" --body "$MAIL";       refused "from a subfolder of the worktree"
run "$TMP/armed" pr comment 3 --body "$MAIL";                         refused "the clone itself"
run "$TMP/twin" pr comment 3 --body "$MAIL";                          refused "another clone of the same repo"
run "$D" pr create --title "board: x" --body "$MAIL" --attach a.png; passed "another repo's clone: everything passes"
run "$D" pr create --fill;                                           passed "another repo's clone: --fill passes"
run "$D" api repos/o/n/issues -f body="$WORD";                       passed "another repo's clone: gh api passes"
run "$TMP/plain" pr comment 3 --body "$MAIL";                        passed "outside any repo, no target"
feed "$TMP/plain" "cd $R && gh pr comment 3 --body \"$MAIL\"";       refused "cd into the worktree first"
feed "$R" "cd $D && gh pr comment 3 --body \"$MAIL\"";               passed "cd into another repo first"
run "$D" pr comment 3 -R ExampleOrg/Armed --body "$MAIL";            refused "-R this repo, from another clone"
run "$D" pr comment 3 --repo=https://github.com/exampleorg/armed.git --body "$MAIL"; refused "--repo= this repo's URL"
run "$D" api repos/exampleorg/armed/issues -f body="$MAIL";          refused "gh api on this repo's path"
feed "$TMP/plain" "GH_REPO=exampleorg/armed gh pr comment 3 --body \"$MAIL\""; refused "GH_REPO this repo"
feed "$TMP/plain" "GH_REPO=exampleorg/armed gh api 'repos/{owner}/{repo}/issues/1/comments' -f body=\"$MAIL\""
refused "gh api {owner}/{repo} with GH_REPO this repo"
run "$R" pr comment 3 -R exampleorg/armed --body "$MAIL";            refused "-R this repo, from the worktree"
run "$R" pr comment 3 -R other-org/elsewhere --body "$MAIL";         passed "-R another repo, from the worktree"
feed "$R" "GH_REPO=other-org/elsewhere gh pr comment 3 --body \"$MAIL\""; passed "GH_REPO another repo, from the worktree"
run "$D" pr -R exampleorg/armed comment 3 --body "$MAIL";            refused "-R before the subcommand"
run "$D" pr --repo exampleorg/armed new --body "$MAIL";              refused "--repo before the new alias"
run "$D" pr comment https://github.com/exampleorg/armed/pull/5 --body "$MAIL"; refused "this repo's PR URL"
run "$TMP/plain" issue comment https://github.com/ExampleOrg/Armed/issues/7 -b "$MAIL"; refused "this repo's issue URL, outside any clone"
run "$R" pr comment https://github.com/other-org/elsewhere/pull/5 --body "$MAIL"; passed "another repo's PR URL, from the worktree"
run "$R" api repos/other-org/elsewhere/issues -f body="$MAIL";       passed "gh api on another repo's path"
feed "$D" "gh pr comment 3 -R \"\$REPO\" --body \"$MAIL\"";        refused "a target filled in later is checked"
feed "$R" "(cd $D) && gh pr comment 3 --body \"$MAIL\"";           refused "a cd in a ( ) subshell does not last"
feed "$R" "x=\$(cd $D); gh pr comment 3 --body \"$MAIL\"";          refused "a cd in \$(…) does not last"
feed "$R" "cd $D | cat; gh pr comment 3 --body \"$MAIL\"";         refused "a cd in a pipeline does not last"
feed "$R" "cd $D & gh pr comment 3 --body \"$MAIL\"";              refused "a cd before & does not last"
feed "$R" "(cd $D && gh pr comment 3 --body \"$MAIL\")";           refused "a call after a cd in a subshell: the folder is unknown"
feed "$D" "export GH_REPO=exampleorg/armed; gh pr comment 3 --body \"$MAIL\""; refused "export GH_REPO this repo"
feed "$D" "GH_REPO=exampleorg/armed; export GH_REPO; gh pr comment 3 --body \"$MAIL\""; refused "GH_REPO=…; export GH_REPO"
feed "$R" "export GH_REPO=other-org/elsewhere; gh pr comment 3 --body \"$MAIL\""; passed "export GH_REPO another repo"
feed "$R" "(export GH_REPO=other-org/elsewhere); gh pr comment 3 --body \"$MAIL\""; refused "an export in a subshell does not last"
feed "$R" "GH_REPO=other-org/elsewhere; gh pr comment 3 --body \"$MAIL\""; refused "GH_REPO set but not exported"
GH_REPO=other-org/elsewhere feed "$R" "unset GH_REPO; gh pr comment 3 --body \"$MAIL\""; refused "unset GH_REPO"
# --- no way to check is a refusal, never a pass
mv "$WORDS" "$TMP/words.off"
run "$R" pr create --title "fix: ok" --body-file "$TMP/clean.md"; refused "no word list"
mv "$TMP/words.off" "$WORDS"
mkdir -p "$TMP/xdg/dev-studio"; printf 'other\n' > "$TMP/xdg/dev-studio/leak-words.txt"
XDG_CONFIG_HOME="$TMP/xdg" run "$R" pr comment 3 --body "the other one"; refused "XDG_CONFIG_HOME: its word list"
printf 'elsewise\n' > "$TMP/own-words.txt"
DS_LEAK_WORDS="$TMP/own-words.txt" run "$R" pr comment 3 --body "elsewise"; refused "DS_LEAK_WORDS: its word list"
mkdir -p "$TMP/lone/githooks"; cp "$ROOT/githooks/gh-text-check" "$ROOT/githooks/gh-text-check.py" "$TMP/lone/githooks/"
feed "$R" "gh pr comment 3 --body fine" "$TMP/lone/githooks/gh-text-check"
refused "a copy of the check with no tests/leak-guard.sh beside it"
has "a missing guard says it cannot check" "$(err)" "cannot check the text"
mkdir -p "$TMP/lone/tests"; cp "$ROOT/tests/leak-guard.sh" "$TMP/lone/tests/"
feed "$R" "gh pr create --title 'fix: x' --body fine" "$TMP/lone/githooks/gh-text-check"
refused "a copy with no tests/pr-title.sh: no way to check the title"
mkdir -p "$TMP/nopy"; for t in cat dirname; do ln -s "$(command -v "$t")" "$TMP/nopy/$t"; done
rc=0; printf '{"tool_name":"Bash","tool_input":{"command":"gh pr view 1"}}' | PATH="$TMP/nopy" "$HOOK" 2> "$TMP/err" || rc=$?
refused "no python3"
has "no python3 says so" "$(err)" "no python3"
# --- the old PATH gate is gone; the repo wires the hook
OLD="bin/hooks/path-gates/""gh"   # split, like the patterns below, so the grep finds no trace in this file
[ ! -e "$ROOT/$OLD" ] && ok || bad "bin/hooks/path-gates/ should hold no gh"
printf '#!/bin/sh\necho fake\n' > "$TMP/bin/gh"; chmod +x "$TMP/bin/gh"
eq "a role's gh (path gates first on PATH) is the real gh" "$(PATH="$ROOT/bin/hooks/path-gates:$TMP/bin" command -v gh)" "$TMP/bin/gh"
eq "settings.json runs the check before every Bash call" \
  "$(python3 -c 'import json,sys; h=json.load(open(sys.argv[1]))["hooks"]["PreToolUse"]; print([(e["matcher"], x["command"]) for e in h for x in e["hooks"]])' "$ROOT/.claude/settings.json")" \
  "[('Bash', '\"\$CLAUDE_PROJECT_DIR\"/githooks/gh-text-check')]"
pat='arm-leak''-hooks|leak-armed''-origins|DS_LEAK''_STATE|ds\.leak''Guard|path-gates/''gh\b'
gone="$(git -C "$ROOT" grep -n -E "$pat" -- bin tests AGENTS.md .github || true)"
eq "no trace of the old gate in bin, tests, AGENTS.md or .github" "$gone" ""
# --- a real claude -p is refused the planted call (skipped without claude)
if [ "${DS_TEST_CLAUDE:-1}" = 0 ] || ! command -v claude > /dev/null 2>&1; then
  echo "  note: no claude on PATH (or DS_TEST_CLAUDE=0): the claude -p wiring case is skipped"
else
  C="$TMP/claude-repo"; mkdir -p "$C/.claude" "$TMP/claude-bin"
  cp -r "$TMP/armed/githooks" "$TMP/armed/tests" "$C/"; cp "$ROOT/.claude/settings.json" "$C/.claude/"
  rm -f "$C/githooks/setup.sh"
  g init -q "$C"; g -C "$C" remote add origin git@github.com:ExampleOrg/Armed.git
  cp "$TMP/word.md" "$C/word.md"
  printf '#!/bin/sh\necho "$*" >> %s/claude-calls\n' "$TMP" > "$TMP/claude-bin/gh"; chmod +x "$TMP/claude-bin/gh"
  : > "$TMP/claude-calls"
  mkdir -p "$TMP/claude-tmp"   # claude keeps temp folders in TMPDIR (claude-<uid>) and XDG_RUNTIME_DIR (cc-socks): inside $TMP, removed
  (cd "$C" && HOME="$REAL_HOME" TMPDIR="$TMP/claude-tmp" XDG_RUNTIME_DIR="$TMP/claude-tmp" DS_LEAK_WORDS="$WORDS" PATH="$TMP/claude-bin:$REAL_PATH" timeout 180 claude -p \
    --model haiku --allowedTools Bash --no-session-persistence --setting-sources project --output-format stream-json --verbose \
    "Run these two Bash commands, one tool call each, exactly as written, and nothing else: first \`gh pr view 1\`, then \`gh pr create --title 'fix: t' --body-file word.md\`. Do not change or retry them." \
    < /dev/null > "$TMP/claude.out" 2>&1) || true
  if ! grep -q '^pr view 1' "$TMP/claude-calls"; then
    echo "  note: claude -p ran no gh call (no login?): the wiring case is skipped"
  else
    eq "claude -p: the planted pr create never reached gh" "$(grep -c '^pr create' "$TMP/claude-calls" || true)" "0"
    if grep -q 'gh-text-check' "$TMP/claude.out"; then ok; else
      echo "  note: claude -p did not try the planted call; the refusal is unproven this run"; fi
    hasnt "claude -p: the refusal never prints the word" "$(grep -o 'gh-text-check[^"]*' "$TMP/claude.out")" "$WORD"
  fi
fi
echo "leak-pr-gate: $pass passed, $fail failed"
[ "$fail" = 0 ]
