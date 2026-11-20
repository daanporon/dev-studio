#!/usr/bin/env bash
# lifecycle-wishes.sh — U159: every lifecycle script is a wish writer and makes no backend call
# on any path. The wish scripts (add-role, close-role, restart-role, spawn-squad, suspend-squad,
# close-squad, notify-squads) check their arguments as before, write one plain wish (`ds want`
# or `ds request`, never an argv replay payload) and return — on a marked root, as the loop's
# child (DS_LOOP_CHILD=1), and on an unmarked root alike. The message scripts (finish-unit,
# reassert-roles) write one request (`ds nudge`) whose payload is their replay when the loop owns
# the root; the loop runs it again as its child to do the mechanics. send-peer and send-role write
# one loop.db `messages` row (U45) and no request; the loop only wakes the receiver.
# Asking again is a no-op; --wait <s> waits for the loop and says so when it does not come.
#
# Hermetic: a temp root whose bin/, conventions/ and roles/ link to this checkout and whose state/
# is its own (the scripts find state/ beside bin/), a fake backend that logs every call.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for f in bin conventions roles AGENTS.md; do ln -s "$ROOT/$f" "$TMP/$f"; done
S="$TMP/state"; mkdir -p "$S/fx/squads"
echo '{"home_repo":"fx"}' > "$S/fx/dispatcher.json"
cat > "$S/fx/squads/t1.json" <<'EOF'
{"topic":"t1","repo":"fx","type":"feature","status":"running","run_id":"run1","lead_wt":"wtl","worktrees":["wtl","wtb"],
 "members":[{"role":"lead","wt":"wtl"},{"role":"builder","suffix":"u1","wt":"wtb"}],"units":[{"slug":"u1","status":"done","tier":"hard"},{"slug":"u2","status":"planned","tier":"hard"}]}
EOF
cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$1" in current) echo "${FAKE_CURRENT:-wt-elsewhere}" ;; ps) echo '{"result":{"worktrees":[]}}' ;; *) echo '{}' ;; esac
FAKE
chmod +x "$TMP/fakeb"
export FAKE_LOG="$TMP/log" BACKEND="$TMP/fakeb" DS_STATE_ROOT="$S" DS_NOW=1800000000
unset ORCA_TERMINAL_HANDLE DS_LOOP_CHILD DS_WHO
: > "$FAKE_LOG"
bun="$(command -v bun 2>/dev/null || true)"
[ -n "$bun" ] || [ ! -x "$HOME/.bun/bin/bun" ] || bun="$HOME/.bun/bin/bun"
"$TMP/bin/ds" import >/dev/null
: > "$S/.loop-migrated"

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
sql() { "${bun:-bun}" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  for (const r of d.query(process.argv[2]).values()) console.log(r.map((v) => v ?? "").join("\t"))' "$S/loop.db" "$1"; }
run() { (cd "$TMP" && "$@"); }
# One script on the marked root: no backend call, then <what>, its kind, key and replayed args.
wish() { # wish <label> <table> <where> <want> <key> <args json> -- <script args…>
  local label="$1" table="$2" where="$3" want="$4" key="$5" args="$6"; shift 7
  : > "$FAKE_LOG"
  run "$@" >/dev/null 2>"$TMP/err" || { ck "$label: exits 0" "$?: $(cat "$TMP/err")" "0"; return; }
  ck "$label: no backend call" "$(cat "$FAKE_LOG")" ""
  if [ "$table" = requests ]; then
    ck "$label: one request" "$(sql "SELECT COUNT(*) FROM requests WHERE $where")" "1"
    ck "$label: kind/key/args" "$(sql "SELECT kind, key, json_extract(payload, '$.argv') FROM requests WHERE $where" | jq -Rc 'split("\t") | [.[0], .[1], (.[2] | fromjson | .[1:])]')" \
      "$(jq -nc --arg k "${key%%:*}" --arg key "$key" --argjson a "$args" '[$k, $key, $a]')"
  else
    ck "$label: one row wanted $want" "$(sql "SELECT want, json_extract(want_payload, '$.kind'), json_extract(want_payload, '$.key'), json_extract(want_payload, '$.argv') FROM $table WHERE $where" | jq -Rc 'split("\t") | [.[0], .[1], .[2], (.[3] | fromjson | .[1:])]')" \
      "$(jq -nc --arg w "$want" --arg k "${key%%:*}" --arg key "$key" --argjson a "$args" '[$w, $k, $key, $a]')"
  fi
}

# U158: the squad scripts write plain wishes (no replay payload); the loop acts in Bun.
: > "$FAKE_LOG"
run bin/commands/spawn-squad.sh --repo fx --topic t2 --type testing >/dev/null 2>"$TMP/err" || ck "spawn-squad: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "spawn-squad: no backend call" "$(cat "$FAKE_LOG")" ""
ck "spawn-squad: running wish, no replay, fills the row" "$(sql "SELECT want, want_by, json_extract(want_payload, '\$.argv') IS NULL, repo, type FROM squads WHERE topic = 't2'")" "running	spawn-squad	1	fx	testing"
: > "$FAKE_LOG"
run bin/commands/suspend-squad.sh fx t1 >/dev/null 2>"$TMP/err" || ck "suspend-squad: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "suspend-squad: no backend call" "$(cat "$FAKE_LOG")" ""
ck "suspend-squad: suspended wish, no replay" "$(sql "SELECT want, want_by, json_extract(want_payload, '\$.argv') IS NULL FROM squads WHERE topic = 't1'")" "suspended	suspend-squad	1"
jq '.status = "suspended"' "$S/fx/squads/t1.json" > "$S/fx/squads/t1.json.tmp" && mv "$S/fx/squads/t1.json.tmp" "$S/fx/squads/t1.json"
run bin/commands/suspend-squad.sh fx t1 --resume >/dev/null 2>"$TMP/err" || ck "suspend-squad --resume: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "suspend-squad --resume: running wish" "$(sql "SELECT want, want_by FROM squads WHERE topic = 't1'")" "running	resume-squad"
jq '.status = "running"' "$S/fx/squads/t1.json" > "$S/fx/squads/t1.json.tmp" && mv "$S/fx/squads/t1.json.tmp" "$S/fx/squads/t1.json"
# add-role is a wish writer (U157): the same member wish `ds request` writes (running,
# payload request:true, phase build), with no replay and no backend call.
: > "$FAKE_LOG"
run bin/commands/add-role.sh fx t1 builder u2 --spec "build u2" --agent codex >"$TMP/out" 2>"$TMP/err" || { ck "add-role: exits 0" "$? (with $(cat "$TMP/err"))" "0"; }
ck "add-role: no backend call" "$(cat "$FAKE_LOG")" ""
ck "add-role: one wish, requested and unplaced" "$(sql "SELECT want, json_extract(want_payload, '$.request'), json_extract(want_payload, '$.unit'), agent IS NULL, phase, status, wt IS NULL FROM members WHERE suffix = 'u2'")" "running	1	u2	1	build	wanted	1"
ck "add-role: prints the changed wish" "$(jq -r .changed "$TMP/out")" "true"
run bin/commands/add-role.sh fx t1 builder u2 --spec "build u2" >"$TMP/out" 2>/dev/null
ck "add-role again: no-op" "$(jq -r .changed "$TMP/out")" "false"
run bin/commands/add-role.sh fx t1 reviewer r1 --spec "look" >/dev/null 2>"$TMP/err" || { ck "add-role reviewer: exits 0" "$? (with $(cat "$TMP/err"))" "0"; }
ck "add-role reviewer: wish, no unit" "$(sql "SELECT role, json_extract(want_payload, '$.request') FROM members WHERE suffix = 'r1'") $(sql "SELECT COUNT(*) FROM members WHERE suffix = 'r1' AND json_extract(want_payload, '$.unit') IS NULL")" "reviewer	1 1"
# U153: restart-role is a wish writer: restart_at (mode now, by restart-role), no replay, no backend.
: > "$FAKE_LOG"
run bin/commands/restart-role.sh fx t1 builder u1 >/dev/null 2>"$TMP/err" || ck "restart-role: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "restart-role: no backend call" "$(cat "$FAKE_LOG")" ""
ck "restart-role: restart wish" "$(sql "SELECT restart_mode, restart_by, restart_at IS NOT NULL FROM members WHERE suffix = 'u1'")" "now	restart-role	1"
# restart-squads passes --wt and no suffix: the wish is that member's own slot, not a new suffix-less one.
run bin/commands/restart-role.sh fx t1 builder --wt wtb >/dev/null 2>"$TMP/err" || ck "restart-role --wt: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "restart-role --wt: no suffix-less slot" "$(sql "SELECT COUNT(*) FROM members WHERE role = 'builder' AND suffix = ''")" "0"
# U155: close-role is a plain wish writer (archived, by close-role, no replay), no backend call.
: > "$FAKE_LOG"
run bin/commands/close-role.sh fx t1 builder-u1 >/dev/null 2>"$TMP/err" || ck "close-role: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "close-role: no backend call" "$(cat "$FAKE_LOG")" ""
ck "close-role: archived wish, no replay" "$(sql "SELECT want, want_by, json_extract(want_payload, '\$.kind') FROM members WHERE suffix = 'u1'")" "gone	close-role	"
# U158: close-squad writes a plain archived wish (no replay).
: > "$FAKE_LOG"
run bin/commands/close-squad.sh fx t1 >/dev/null 2>"$TMP/err" || ck "close-squad: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "close-squad: no backend call" "$(cat "$FAKE_LOG")" ""
ck "close-squad: archived wish, no replay" "$(sql "SELECT want, want_by, json_extract(want_payload, '\$.argv') IS NULL FROM squads WHERE topic = 't1'")" "gone	close-squad	1"
wish "finish-unit --no-pr" requests "kind = 'finish-unit'" - "finish-unit:fx/t1/u1@none" '["state/fx/squads/t1.json","u1","--no-pr"]' \
  -- env GIT_DIR=/nonexistent bin/role/finish-unit.sh state/fx/squads/t1.json u1 --no-pr
# U45: send-peer and send-role write a message row, no request and no backend call.
msg() { # msg <label> <kind> <from> -- <script args…>
  local label="$1" kind="$2" from="$3"; shift 4
  : > "$FAKE_LOG"
  run "$@" >/dev/null 2>"$TMP/err" || { ck "$label: exits 0" "$?: $(cat "$TMP/err")" "0"; return; }
  ck "$label: no backend call" "$(cat "$FAKE_LOG")" ""
  ck "$label: one message row, no request" "$(sql "SELECT project, squad, to_role, from_squad, from_role, subject, body FROM messages WHERE kind = '$kind'") $(sql "SELECT COUNT(*) FROM requests WHERE kind = '${label}'")" \
    "$(printf 'fx\tt1\tlead\t%s\thi\tthere' "$from") 0"
}
msg "send-peer" peer "other	lead" -- bin/role/send-peer.sh t1 lead hi there --project fx --from other/lead
msg "send-role" message "	unknown" -- bin/role/send-role.sh t1 lead hi there --project fx
k="$(bun "$ROOT/tests/lib/twins.ts" ds_loop_key fx)"
# U156: notify-squads is a plain wish writer (a reload wish on every roster member, by
# notify-squads), no replay, no backend call.
: > "$FAKE_LOG"
run bin/commands/notify-squads.sh fx >"$TMP/out" 2>"$TMP/err" || ck "notify-squads: exits 0" "$? ($(cat "$TMP/err"))" "0"
ck "notify-squads: no backend call" "$(cat "$FAKE_LOG")" ""
ck "notify-squads: no request row" "$(sql "SELECT COUNT(*) FROM requests WHERE kind = 'notify-squads'")" "0"
ck "notify-squads: reload wishes on every roster member" "$(sql "SELECT role, suffix, reload_by, reload_at IS NOT NULL FROM members WHERE squad = 't1' AND ((role = 'lead' AND suffix = '') OR (role = 'builder' AND suffix = 'u1')) ORDER BY role")" "$(printf 'builder\tu1\tnotify-squads\t1\nlead\t\tnotify-squads\t1')"
ck "notify-squads: says what it wrote" "$(cat "$TMP/out")" "$(printf 'reload t1/lead (run=run1)\nreload t1/builder-u1 (run=run1)\nnotify-squads: wrote reload wishes for 2 member(s) in '"'"'fx'"'"'')"
before_notify_ev="$(sql "SELECT COUNT(*) FROM events WHERE kind = 'wish'")"
run bin/commands/notify-squads.sh fx >/dev/null 2>&1
ck "notify-squads again: adds no event" "$(sql "SELECT COUNT(*) FROM events WHERE kind = 'wish'")" "$before_notify_ev"
wish "reassert-roles" requests "kind = 'reassert-roles'" - "reassert-roles:fx:$k" '["fx"]' -- bin/hooks/reassert-roles.sh fx

# U159: every wish script writes its plain wish with no backend call on any path — as the loop's
# child and on an unmarked root too (it never did backend calls anywhere else either).
child() { (cd "$TMP" && DS_LOOP_CHILD=1 "$@"); }
for t in t9 t10; do cat > "$S/fx/squads/$t.json" <<EOF
{"topic":"$t","repo":"fx","type":"testing","status":"running","run_id":"run1","lead_wt":"wtl","worktrees":["wtl"],"members":[],"units":[]}
EOF
done
: > "$FAKE_LOG"; child bin/commands/spawn-squad.sh --repo fx --topic t9 --type testing >/dev/null 2>"$TMP/err" || ck "child spawn-squad: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "child spawn-squad: no backend call" "$(cat "$FAKE_LOG")" ""
ck "child spawn-squad: running wish, no replay" "$(sql "SELECT want, want_by, json_extract(want_payload, '\$.argv') IS NULL FROM squads WHERE topic = 't9'")" "running	spawn-squad	1"
: > "$FAKE_LOG"; child bin/commands/add-role.sh fx t9 researcher q1 --spec "probe" >/dev/null 2>"$TMP/err" || { ck "child add-role: exits 0" "$? (with $(cat "$TMP/err"))" "0"; }
ck "child add-role: no backend call" "$(cat "$FAKE_LOG")" ""
ck "child add-role: one wish" "$(sql "SELECT want, json_extract(want_payload, '\$.argv') IS NULL FROM members WHERE suffix = 'q1'")" "running	1"
: > "$FAKE_LOG"; child bin/commands/restart-role.sh fx t9 researcher q1 >/dev/null 2>"$TMP/err" || ck "child restart-role: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "child restart-role: no backend call" "$(cat "$FAKE_LOG")" ""
ck "child restart-role: restart wish" "$(sql "SELECT restart_mode, restart_by, restart_at IS NOT NULL FROM members WHERE suffix = 'q1'")" "now	restart-role	1"
: > "$FAKE_LOG"; child bin/commands/suspend-squad.sh fx t1 >/dev/null 2>"$TMP/err" || ck "child suspend-squad: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "child suspend-squad: no backend call" "$(cat "$FAKE_LOG")" ""
ck "child suspend-squad: suspended wish" "$(sql "SELECT want, want_by FROM squads WHERE topic = 't1'")" "suspended	suspend-squad"
jq '.status = "suspended"' "$S/fx/squads/t1.json" > "$S/fx/squads/t1.json.tmp" && mv "$S/fx/squads/t1.json.tmp" "$S/fx/squads/t1.json"
: > "$FAKE_LOG"; child bin/commands/suspend-squad.sh fx t1 --resume >/dev/null 2>"$TMP/err" || ck "child suspend-squad --resume: exits 0" "$?: $(cat "$TMP/err")" "0"
jq '.status = "running"' "$S/fx/squads/t1.json" > "$S/fx/squads/t1.json.tmp" && mv "$S/fx/squads/t1.json.tmp" "$S/fx/squads/t1.json"
ck "child suspend-squad --resume: running wish" "$(sql "SELECT want, want_by FROM squads WHERE topic = 't1'")" "running	resume-squad"
rm "$S/.loop-migrated"
: > "$FAKE_LOG"; (cd "$TMP" && bin/commands/spawn-squad.sh --repo fx --topic t10 --type testing >/dev/null 2>"$TMP/err") || ck "unmarked spawn-squad: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "unmarked spawn-squad: no backend call" "$(cat "$FAKE_LOG")" ""
ck "unmarked spawn-squad: running wish, no replay" "$(sql "SELECT want, want_by, json_extract(want_payload, '\$.argv') IS NULL FROM squads WHERE topic = 't10'")" "running	spawn-squad	1"
: > "$FAKE_LOG"; (cd "$TMP" && bin/commands/add-role.sh fx t10 researcher q2 --spec "probe" >/dev/null 2>"$TMP/err") || { ck "unmarked add-role: exits 0" "$? (with $(cat "$TMP/err"))" "0"; }
ck "unmarked add-role: no backend call" "$(cat "$FAKE_LOG")" ""
ck "unmarked add-role: one wish" "$(sql "SELECT want, json_extract(want_payload, '\$.argv') IS NULL FROM members WHERE suffix = 'q2'")" "running	1"
: > "$FAKE_LOG"; (cd "$TMP" && bin/commands/restart-role.sh fx t10 researcher q2 >/dev/null 2>"$TMP/err") || ck "unmarked restart-role: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "unmarked restart-role: no backend call" "$(cat "$FAKE_LOG")" ""
ck "unmarked restart-role: restart wish" "$(sql "SELECT restart_mode, restart_by, restart_at IS NOT NULL FROM members WHERE suffix = 'q2'")" "now	restart-role	1"
: > "$FAKE_LOG"; (cd "$TMP" && bin/commands/suspend-squad.sh fx t1 >/dev/null 2>"$TMP/err") || ck "unmarked suspend-squad: exits 0" "$?: $(cat "$TMP/err")" "0"
ck "unmarked suspend-squad: no backend call" "$(cat "$FAKE_LOG")" ""
ck "unmarked suspend-squad: suspended wish" "$(sql "SELECT want, want_by FROM squads WHERE topic = 't1'")" "suspended	suspend-squad"
jq '.status = "suspended"' "$S/fx/squads/t1.json" > "$S/fx/squads/t1.json.tmp" && mv "$S/fx/squads/t1.json.tmp" "$S/fx/squads/t1.json"
: > "$FAKE_LOG"; (cd "$TMP" && bin/commands/suspend-squad.sh fx t1 --resume >/dev/null 2>"$TMP/err") || ck "unmarked suspend-squad --resume: exits 0" "$?: $(cat "$TMP/err")" "0"
jq '.status = "running"' "$S/fx/squads/t1.json" > "$S/fx/squads/t1.json.tmp" && mv "$S/fx/squads/t1.json.tmp" "$S/fx/squads/t1.json"
ck "unmarked suspend-squad --resume: running wish" "$(sql "SELECT want, want_by FROM squads WHERE topic = 't1'")" "running	resume-squad"
: > "$S/.loop-migrated"
# Back to the archived wish the section above left: the tail re-asks it.
run bin/commands/close-squad.sh fx t1 >/dev/null 2>&1

# Asking again is a no-op: no second row, no second event.
ev() { sql "SELECT COUNT(*) FROM events WHERE kind IN ('want', 'request')"; }
before="$(ev)"
ck "close-squad again: unchanged" "$(run bin/commands/close-squad.sh fx t1 | jq -r .changed)" "false"
ck "send-role again: not created" "$(run bin/role/send-role.sh t1 lead hi there --project fx | jq -r .created)" "false"
ck "asking again adds no event" "$(ev)" "$before"
ck "asking again adds no row" "$(sql "SELECT COUNT(*) FROM squads WHERE topic = 't1'") $(sql "SELECT COUNT(*) FROM messages WHERE kind = 'message'")" "1 1"

# --wait: the loop is not running here, so the wait runs out.
id="$(sql "SELECT id FROM squads WHERE topic = 't1'")"
set +e; run bin/commands/close-squad.sh fx t1 --wait 2 >/dev/null 2>"$TMP/err"; rc=$?; set -e
ck "--wait 2 times out: exit 1" "$rc" "1"
ck "--wait 2 says so" "$(cat "$TMP/err")" "still wanted (row $id); asking again is a no-op"
ck "--wait: still the plain wish" "$(sql "SELECT json_extract(want_payload, '\$.argv') IS NULL FROM squads WHERE id = $id")" "1"

# Bad arguments are refused as today, with nothing written.
n="$(sql "SELECT COUNT(*) FROM requests") $(sql "SELECT COUNT(*) FROM members") $(sql "SELECT COUNT(*) FROM messages")"
set +e
run bin/commands/add-role.sh fx t1 lead x >/dev/null 2>&1; ck "add-role lead: refused" "$?" "2"
run bin/commands/close-squad.sh fx nosuch >/dev/null 2>&1; ck "close-squad unknown: refused" "$?" "1"
run bin/role/send-peer.sh t1 builder-u1 s b --project fx >/dev/null 2>&1; ck "send-peer to a builder: refused" "$?" "2"
set -e
ck "a refusal writes nothing" "$(sql "SELECT COUNT(*) FROM requests") $(sql "SELECT COUNT(*) FROM members") $(sql "SELECT COUNT(*) FROM messages")" "$n"

# As the loop's child, and on an unmarked root, the script writes the same wishes — no
# backend call on any path (U156: close-role's precedent).
: > "$FAKE_LOG"; (cd "$TMP" && DS_LOOP_CHILD=1 bin/commands/notify-squads.sh fx >/dev/null 2>&1)
ck "child: still just the wishes (exit 0)" "$?" "0"
ck "child: no backend call" "$(cat "$FAKE_LOG")" ""
rm "$S/.loop-migrated"
: > "$FAKE_LOG"; (cd "$TMP" && bin/commands/notify-squads.sh fx >/dev/null 2>&1)
ck "unmarked: still just the wishes (exit 0)" "$?" "0"
ck "unmarked: no backend call" "$(cat "$FAKE_LOG")" ""
n="$(sql "SELECT COUNT(*) FROM requests")"
: > "$FAKE_LOG"; (cd "$TMP" && bin/role/send-role.sh t1 lead s b --project fx >/dev/null 2>&1) || true
ck "unmarked: no request written" "$(sql "SELECT COUNT(*) FROM requests")" "$n"
: > "$S/.loop-migrated"
# A refusal asking again won't change exits 2 in the child, so the loop gives up instead of retrying it.
# U155: close-role has no child/backend path left: even as DS_LOOP_CHILD it only writes the wish.
: > "$FAKE_LOG"
set +e; (cd "$TMP" && DS_LOOP_CHILD=1 bin/commands/close-role.sh fx t1 builder-u1 >/dev/null 2>&1); rc=$?; set -e
ck "child close-role: still just the wish (exit 0)" "$rc" "0"
ck "child close-role: no backend call" "$(cat "$FAKE_LOG")" ""
# U158: close-squad has no child/backend path left either: even as DS_LOOP_CHILD it
# only writes the wish (the loop archives in Bun).
: > "$FAKE_LOG"
set +e; (cd "$TMP" && DS_LOOP_CHILD=1 bin/commands/close-squad.sh fx t1 >/dev/null 2>&1); rc=$?; set -e
ck "child close-squad: still just the wish (exit 0)" "$rc" "0"
ck "child close-squad: no backend call" "$(cat "$FAKE_LOG")" ""

echo "lifecycle-wishes: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
