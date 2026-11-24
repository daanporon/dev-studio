#!/usr/bin/env bash
# close-role.sh (U155) — a wish writer: a plain retirement writes the member's archived
# wish and makes no backend call; --cancel writes the cancel wish. Refuses the Lead, a
# plain retirement of a still-dispatched unit, and a bad --into, all before any write.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for f in bin conventions roles AGENTS.md; do ln -s "$ROOT/$f" "$TMP/$f"; done
S="$TMP/state"; mkdir -p "$S/fx/squads"
echo '{"home_repo":"fx"}' > "$S/fx/dispatcher.json"
SF="$S/fx/squads/t1.json"
cat > "$SF" <<'EOF'
{"topic":"t1","repo":"fx","type":"feature","status":"running","run_id":"run1","lead_wt":"wtl",
 "members":[{"role":"lead","wt":"wtl"},{"role":"builder","suffix":"u1","wt":"wtb1"},{"role":"builder","suffix":"u2","wt":"wtb2"},{"role":"thinker","suffix":"u2","wt":"wtt"}],
 "units":[{"slug":"u1","status":"done","builder_wt":"wtb1","pr":"7"},{"slug":"u2","status":"dispatched","builder_wt":"wtb2","pr":"41"}]}
EOF
cat > "$TMP/fakeb" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${FAKE_LOG:-/dev/null}"
echo '{}'
FAKE
chmod +x "$TMP/fakeb"
export FAKE_LOG="$TMP/log" BACKEND="$TMP/fakeb" DS_STATE_ROOT="$S" DS_NOW=1800000000
unset DS_LOOP_CHILD DS_WHO ORCA_TERMINAL_HANDLE
bun="$(command -v bun 2>/dev/null || true)"
[ -n "$bun" ] || [ ! -x "$HOME/.bun/bin/bun" ] || bun="$HOME/.bun/bin/bun"
"$TMP/bin/ds" import >/dev/null
: > "$S/.loop-migrated"
: > "$FAKE_LOG"

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
sql() { "${bun:-bun}" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  for (const r of d.query(process.argv[2]).values()) console.log(r.map((v) => v ?? "").join("\t"))' "$S/loop.db" "$1"; }
# close-role finds its root beside bin/: run it through the temp root's symlinked bin.
run() { (cd "$TMP" && "$TMP/bin/commands/close-role.sh" "$@"); }

# Plain retirement: one archived wish, no replay payload, no backend call.
out="$(run fx t1 builder-u1 2>&1)"
ck "plain: no backend call" "$(cat "$FAKE_LOG")" ""
ck "plain: archived wish by close-role" "$(sql "SELECT want, want_by, json_extract(want_payload, '\$.kind') FROM members WHERE suffix = 'u1' AND role = 'builder'")" "gone	close-role	"
ck "plain: squad file roster untouched (the loop prunes)" "$(jq -r '[.members[].wt]|join(",")' "$SF")" "wtl,wtb1,wtb2,wtt"

# Asking again is a no-op (same wish, no new event).
before="$(sql "SELECT COUNT(*) FROM events WHERE kind = 'want'")"
run fx t1 builder-u1 >/dev/null 2>&1
ck "plain again: no new want event" "$(sql "SELECT COUNT(*) FROM events WHERE kind = 'want'")" "$before"

# Refuses to close the Lead, with nothing written.
rc=0; run fx t1 lead >/dev/null 2>&1 || rc=$?
ck "lead: refused" "$rc" "1"
ck "lead: no wish" "$(sql "SELECT want FROM members WHERE role = 'lead'")" ""
ck "lead: no backend call" "$(cat "$FAKE_LOG")" ""

# Plain retirement of a still-dispatched unit is refused; --cancel is the way.
rc=0; out="$(run fx t1 builder-u2 2>&1)" || rc=$?
ck "dispatched: refused" "$rc" "1"
ck "dispatched: says use --cancel" "$(printf '%s' "$out" | grep -c -- '--cancel')" "1"
ck "dispatched: no wish" "$(sql "SELECT want FROM members WHERE suffix = 'u2' AND role = 'builder'")" ""

# U4: the Lead cannot mark u2 done (and so close its Builder) while its PR #41 is not merged. The PR is
# found the way the lifecycle reconciler finds it: by <nwo>#<pr> through the squad repo's github config.
sqlw() { "${bun:-bun}" -e 'const { Database } = require("bun:sqlite"); new Database(process.argv[1]).run(process.argv[2]);' "$S/loop.db" "$1"; }
SS="$TMP/bin/role/squad-state.sh"
sqlw "INSERT INTO config (project, file, key, value, observed_at) VALUES ('fx', 'github', 'repo:fx', 'o/fx', 1)"
rc=0; out="$("$SS" "$SF" set-unit-status u2 "done" 2>&1)" || rc=$?
ck "unobserved PR: done refused" "$rc" "1"
ck "unobserved PR: says not read yet" "$(printf '%s' "$out" | grep -c 'PR #41 has no observed state yet')" "1"
sqlw "INSERT INTO observed_prs (project, ref, pr, state, observed_at) VALUES ('fx', 'o/fx#41', 41, 'OPEN', 1)"
rc=0; out="$("$SS" "$SF" set-unit-status u2 "done" 2>&1)" || rc=$?
ck "open PR: done refused" "$rc" "1"
ck "open PR: names the PR and open" "$(printf '%s' "$out" | grep -c 'PR #41 is open')" "1"
ck "open PR: says the loop marks it on the merge" "$(printf '%s' "$out" | grep -c 'The loop marks the unit done and closes its Builder when the PR merges')" "1"
ck "open PR: unit still dispatched" "$(sql "SELECT status FROM units WHERE slug = 'u2'")" "dispatched"
rc=0; "$SS" "$SF" set-unit-status u2 "done" --no-pr >/dev/null 2>&1 || rc=$?
ck "open PR: --no-pr does not skip it" "$rc" "1"
rc=0; out="$(run fx t1 builder-u2 2>&1)" || rc=$?
ck "open PR: close-role still refuses the Builder" "$rc" "1"
ck "open PR: close-role says still dispatched" "$(printf '%s' "$out" | grep -c 'still dispatched')" "1"
sqlw "UPDATE observed_prs SET state = 'CLOSED' WHERE ref = 'o/fx#41'"
rc=0; out="$("$SS" "$SF" set-unit-status u2 "done" 2>&1)" || rc=$?
ck "closed PR: done refused" "$rc" "1"
ck "closed PR: points at set-unit-pr or cancel-unit" "$(printf '%s' "$out" | grep -c 'is closed.*new PR (set-unit-pr) or cancel-unit')" "1"
ck "closed PR: unit still dispatched" "$(sql "SELECT status FROM units WHERE slug = 'u2'")" "dispatched"
sqlw "DELETE FROM observed_prs WHERE ref = 'o/fx#41'"

# --into/--why without --cancel, and --cancel --force, are refused.
rc=0; run fx t1 builder-u2 --into PR#9 >/dev/null 2>&1 || rc=$?
ck "into without cancel: exit 2" "$rc" "2"
rc=0; run fx t1 builder-u2 --cancel --force >/dev/null 2>&1 || rc=$?
ck "cancel --force: refused" "$rc" "1"

# A bad --into is refused before any write.
rc=0; run fx t1 builder-u2 --cancel --into nope >/dev/null 2>&1 || rc=$?
ck "bad --into: refused" "$rc" "1"
ck "bad --into: unit still dispatched" "$(sql "SELECT status FROM units WHERE slug = 'u2'")" "dispatched"
ck "bad --into: no backend call" "$(cat "$FAKE_LOG")" ""

# --cancel on the Lead is refused.
rc=0; run fx t1 lead --cancel >/dev/null 2>&1 || rc=$?
ck "cancel lead: refused" "$rc" "1"

# --cancel: the unit is cancelled and the Builder's gone wish carries the cancel payload.
out="$(run fx t1 builder-u2 --cancel --into PR#19717 --why folded 2>&1)"
ck "cancel: no backend call" "$(cat "$FAKE_LOG")" ""
ck "cancel: unit cancelled" "$(sql "SELECT status, superseded_by FROM units WHERE slug = 'u2'")" "cancelled	PR#19717"
ck "cancel: builder wish is the cancel wish" "$(sql "SELECT want, json_extract(want_payload, '\$.cancel.unit') FROM members WHERE suffix = 'u2' AND role = 'builder'")" "gone	u2"
ck "cancel: output names the unit" "$(printf '%s' "$out" | grep -c 'cancelled -> PR#19717')" "1"

# A non-Builder whose suffix matches a unit slug: the wish is its own, the unit untouched.
rc=0; run fx t1 thinker-u2 >/dev/null 2>&1 || rc=$?
ck "thinker-u2: exits 0" "$rc" "0"
ck "thinker-u2: archived wish" "$(sql "SELECT want FROM members WHERE role = 'thinker'")" "gone"
ck "thinker-u2: no backend call" "$(cat "$FAKE_LOG")" ""

echo "close-role: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
