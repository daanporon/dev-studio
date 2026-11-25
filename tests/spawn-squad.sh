#!/usr/bin/env bash
# spawn-squad.sh — U158: a wish writer. It checks its arguments, writes the squad's
# running wish (repo/type/autonomy/host/framing on the row, no replay) and returns;
# the loop creates the Run, task, Lead and always roles. No backend call on any path.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for f in bin conventions roles AGENTS.md; do ln -s "$ROOT/$f" "$TMP/$f"; done
S="$TMP/state"; mkdir -p "$S/fx/squads"
echo '{"home_repo":"fx"}' > "$S/fx/dispatcher.json"
cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
echo '{}'
FAKE
chmod +x "$TMP/fakeb"
export FAKE_LOG="$TMP/log" BACKEND="$TMP/fakeb" DS_STATE_ROOT="$S" DS_NOW=1800000000
unset ORCA_TERMINAL_HANDLE DS_LOOP_CHILD DS_WHO
: > "$FAKE_LOG"
bun="$(command -v bun 2>/dev/null || true)"; [ -n "$bun" ] || bun="$HOME/.bun/bin/bun"
"$TMP/bin/ds" import >/dev/null 2>&1 || true

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
sql() { "$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  for (const r of d.query(process.argv[2]).values()) console.log(r.map((v) => v ?? "").join("\t"))' "$S/loop.db" "$1"; }
run() { (cd "$TMP" && "$@"); }

out="$(run bin/commands/spawn-squad.sh --repo fx --topic t2 --type testing 2>"$TMP/err")" || ck "spawn: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "spawn: no backend call" "$(cat "$FAKE_LOG")" ""
ck "spawn: one running wish, no replay" "$(sql "SELECT want, want_by, json_extract(want_payload, '\$.argv') IS NULL, repo, type FROM squads WHERE topic = 't2'")" "running	spawn-squad	1	fx	testing"
ck "spawn: prints the wish" "$(printf '%s' "$out" | jq -r .changed)" "true"
ck "spawn again: no-op" "$(run bin/commands/spawn-squad.sh --repo fx --topic t2 --type testing | jq -r .changed)" "false"
set +e; run bin/commands/spawn-squad.sh --repo fx --topic t3 --type bogus >/dev/null 2>&1; rc=$?; set -e
ck "spawn bad type: exit 2" "$rc" "2"
ck "spawn bad type: nothing written" "$(sql "SELECT COUNT(*) FROM squads WHERE topic = 't3'")" "0"

run bin/commands/spawn-squad.sh --repo fx --topic t4 --start brainstorm >/dev/null
ck "spawn --start: on the wish payload" "$(sql "SELECT json_extract(want_payload, '\$.start') FROM squads WHERE topic = 't4'")" "brainstorm"
run bin/commands/spawn-squad.sh --repo fx --topic t4f --start fix >/dev/null
ck "spawn --start fix: on the wish payload" "$(sql "SELECT json_extract(want_payload, '\$.start') FROM squads WHERE topic = 't4f'")" "fix"
run bin/commands/spawn-squad.sh --repo fx --topic t5 >/dev/null
ck "spawn: no --start, none on the payload" "$(sql "SELECT json_extract(want_payload, '\$.start') IS NULL FROM squads WHERE topic = 't5'")" "1"
set +e; run bin/commands/spawn-squad.sh --repo fx --topic t6 --start bogus >/dev/null 2>&1; rc=$?; set -e
ck "spawn bad --start: exit 2" "$rc" "2"
ck "spawn bad --start: nothing written" "$(sql "SELECT COUNT(*) FROM squads WHERE topic = 't6'")" "0"

# --framing-file: the file's bytes are the framing; missing, empty and both-flags refuse and write nothing.
printf 'a\n\n\t"q" $x `b` \\ é\n' > "$TMP/f.md"
run bin/commands/spawn-squad.sh --repo fx --topic t7 --framing-file "$TMP/f.md" >/dev/null
ck "spawn --framing-file: framing is the file's bytes" "$(sql "SELECT hex(json_extract(want_payload, '\$.framing')) FROM squads WHERE topic = 't7'")" "$(od -An -tx1 -v "$TMP/f.md" | tr -d ' \n' | tr a-f A-F)"
: > "$TMP/empty.md"
for c in "t8 --framing-file $TMP/nope.md" "t9 --framing-file $TMP/empty.md" "t10 --framing-file $TMP/f.md --framing x"; do
  read -ra ca <<< "$c"
  set +e; run bin/commands/spawn-squad.sh --repo fx --topic "${ca[@]}" >/dev/null 2>"$TMP/err"; rc=$?; set -e
  ck "spawn framing-file refusal ($c): exit 2" "$rc" "2"
  ck "spawn framing-file refusal ($c): nothing written" "$(sql "SELECT COUNT(*) FROM squads WHERE topic = '${c%% *}'")" "0"
done
ck "spawn framing-file: missing names the path" "$(run bin/commands/spawn-squad.sh --repo fx --topic t8 --framing-file "$TMP/nope.md" 2>&1 >/dev/null | grep -c "$TMP/nope.md")" "1"

# U30, U57: one rule for which backend a project's squads use: its Studio's, nothing else. The flag may only
# name it; any other backend (orca and herdr included) is refused naming ds up --backend.
mkdir -p "$S/tx/squads"; echo '{"home_repo":"tx","studio_backend":"tmux"}' > "$S/tx/dispatcher.json"
"$TMP/bin/ds" import >/dev/null 2>&1 || true
for r in builder builder-review builder-review-standard; do "$TMP/bin/ds" config set tx roles.conf "$r" "claude opus ondemand - claude:sonnet" >/dev/null; done
mkdir -p "$TMP/fakebin"; printf '#!/bin/sh\n' >"$TMP/fakebin/tmux"; chmod +x "$TMP/fakebin/tmux"
if command -v tmux >/dev/null 2>&1; then
  run bin/commands/spawn-squad.sh --repo tx --topic b1 >/dev/null 2>"$TMP/err" || cat "$TMP/err" >&2
  ck "tmux project, no flag: starts on tmux" "$(sql "SELECT backend FROM squads WHERE topic = 'b1'")" "tmux"
  run bin/commands/spawn-squad.sh --repo tx --topic b2 --backend tmux >/dev/null 2>"$TMP/err" || cat "$TMP/err" >&2
  ck "tmux project, --backend tmux: starts on tmux" "$(sql "SELECT backend FROM squads WHERE topic = 'b2'")" "tmux"
fi
for b in orca herdr; do
  set +e; run bin/commands/spawn-squad.sh --repo tx --topic "b-$b" --backend "$b" >/dev/null 2>"$TMP/err"; rc=$?; set -e
  ck "tmux project, --backend $b: refused" "$rc" "1"
  ck "tmux project, --backend $b: names the Studio's backend and ds up --backend" "$(grep -c "backend $b is refused: this project's Studio runs on tmux.*ds up tx --backend $b" "$TMP/err")" "1"
  ck "tmux project, --backend $b: nothing written" "$(sql "SELECT COUNT(*) FROM squads WHERE topic = 'b-$b'")" "0"
done
ck "orca project, --backend orca: starts on orca" "$(run bin/commands/spawn-squad.sh --repo fx --topic o1 --backend orca >/dev/null 2>&1; sql "SELECT backend FROM squads WHERE topic = 'o1'")" "orca"

echo "spawn-squad: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
