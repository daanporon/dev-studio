#!/usr/bin/env bash
# approve-fix.sh — the operator's one-click: read a testing squad's proposed fix squad and SPAWN
# it (prefilled repo/topic/framing), then mark the proposal spawned + clear its approval question.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
LBL="zzaf_$$"; SD="$DS_STATE_ROOT/$LBL/squads"
TMP="$(mktemp -d)"
state_root_on_exit 'rm -rf "$DS_STATE_ROOT/$LBL" "$TMP"'
mkdir -p "$SD"
SF="$SD/manual-testing.json"

# A testing squad with one proposed fix squad + its approval question queued.
printf '{"run_id":"r1","type":"testing","status":"running","host":"saved:env1","members":[],"units":[],"proposed_squads":[],"waiting_on_you":[]}' > "$SF"
"$ROOT/bin/role/squad-state.sh" "$SF" propose-squad "fix-1" "escrow-vault-bug" "path:/repo/acme" "U2 _msgSender frozen in registry — fix it" >/dev/null
"$ROOT/bin/role/squad-state.sh" "$SF" enqueue-question "fix-1" thinker true "Approve fix squad escrow-vault-bug?" >/dev/null

# Fake spawn-squad: log its args so we can assert the prefill, and succeed.
cat > "$TMP/fakespawn" <<FAKE
#!/usr/bin/env bash
printf '%s\n' "\$*" > "$TMP/spawn.args"
FAKE
chmod +x "$TMP/fakespawn"

pass=0; fail=0
has(){ if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }

DS_SPAWN="$TMP/fakespawn" "$ROOT/bin/commands/approve-fix.sh" "$LBL" manual-testing fix-1 >/dev/null 2>&1
args="$(cat "$TMP/spawn.args" 2>/dev/null || true)"
has "spawns with the proposal's repo"    "$args" "--repo path:/repo/acme"
has "spawns with the proposal's topic"   "$args" "--topic escrow-vault-bug"
has "spawns a feature (fix) squad"        "$args" "--type feature"
has "carries the framing through"         "$args" "U2 _msgSender frozen"
has "inherits the testing squad's host"   "$args" "--host saved:env1"

st="$("$ROOT/bin/role/squad-state.sh" "$SF" get)"
eq "proposal marked spawned"  "$(printf '%s' "$st" | jq -r '.proposed_squads[0].status')" "spawned"
eq "approval question cleared" "$(printf '%s' "$st" | jq '.waiting_on_you | length')" "0"

# Re-approving an already-spawned proposal is a no-op (doesn't spawn twice).
rm -f "$TMP/spawn.args"
DS_SPAWN="$TMP/fakespawn" "$ROOT/bin/commands/approve-fix.sh" "$LBL" manual-testing fix-1 >/dev/null 2>&1 || true
if [ -e "$TMP/spawn.args" ]; then fail=$((fail+1)); echo "  FAIL: re-approve should not spawn again" >&2; else pass=$((pass+1)); fi

# An unknown proposal id errors, doesn't spawn.
rc=0; DS_SPAWN="$TMP/fakespawn" "$ROOT/bin/commands/approve-fix.sh" "$LBL" manual-testing nope >/dev/null 2>&1 || rc=$?
eq "unknown proposal id fails" "$rc" "1"

echo "approve-fix: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
