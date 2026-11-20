#!/usr/bin/env bash
# lifecycle-seam.sh — U159: only the loop talks to Orca for lifecycle, in Bun through
# bin/backend/orca.sh. No top-level bin/*.sh invokes a lifecycle backend op except the named
# upkeep remainder (which the install plan can only shrink): reclaim.sh, up.sh, team.sh,
# restart-squads.sh (its worker-reclaim only), set-orca-depth.sh.
# bin/role/orch.sh names these ops in its refusal guard, and comments/probe labels name them too —
# so this greps invocation shapes (`"$BACKEND" <op>`, `$BACKEND <op>`), not bare words.
# Hermetic: grep plus orch.sh refusals on a stub backend in a temp dir, no state.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

OPS="run-create wt-create role-start worker-start worker-resume worker-stop worktree-rm terminal-close-worktree worker-release worker-reclaim studio-start"
UPKEEP="bin/commands/reclaim.sh bin/host/up.sh bin/commands/team.sh bin/commands/restart-squads.sh bin/host/set-orca-depth.sh"

pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }

# Every upkeep file on the list exists (a renamed remainder must update this test, not slip past it).
for f in $UPKEEP; do ck "upkeep file present: $f" "$([ -f "$f" ] && echo yes || echo no)" "yes"; done

# No top-level script outside the upkeep remainder invokes a lifecycle op.
for op in $OPS; do
  hit="$(grep -lE "\"\\\$BACKEND\" +$op([ \"'\$]|$)|\\\$BACKEND +$op([ \"'\$]|$)" bin/*.sh 2>/dev/null || true)"
  outside=""
  for f in $hit; do
    case " $UPKEEP " in *" $f "*) ;; *) outside="$outside $f" ;; esac
  done
  ck "only upkeep invokes $op" "${outside:-none}" "none"
done

# restart-squads.sh keeps only its worker-reclaim remainder: no other lifecycle op.
other=""
for op in $OPS; do
  [ "$op" = worker-reclaim ] && continue
  if grep -qE "\"\\\$BACKEND\" +$op([ \"'\$]|$)|\\\$BACKEND +$op([ \"'\$]|$)" bin/commands/restart-squads.sh 2>/dev/null; then
    other="$other $op"
  fi
done
ck "restart-squads.sh: worker-reclaim only" "${other:-none}" "none"

# orch.sh (bin/commands/orch-ts.ts) refuses every lifecycle op instead of passing it through.
missing=""
for op in $OPS adopt; do
  grep -q "$op" bin/commands/orch-ts.ts || missing="$missing $op"
done
ck "orch.sh names every refused lifecycle op" "${missing:-none}" "none"
missing=""
for op in $OPS adopt; do
  out="$(bin/role/orch.sh "$op" 2>&1 || true)"
  case "$out" in *"is lifecycle"*) ;; *) missing="$missing $op" ;; esac
done
ck "orch.sh refuses every lifecycle op" "${missing:-none}" "none"
# account-free-resets U4: using a free reset grant is refused too, before the backend is reached (only the
# loop's account-reset fulfiller runs it, for an operator's press).
TMP="$(mktemp -d -p "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}")"; trap 'rm -rf "$TMP"' EXIT
printf '#!/bin/sh\necho called >> "%s"\n' "$TMP/reset-called" > "$TMP/reset-backend"; chmod +x "$TMP/reset-backend"
rc=0; out="$(BACKEND="$TMP/reset-backend" bin/role/orch.sh account-reset-use claude system g1 k1 2>&1)" || rc=$?
ck "orch.sh refuses account-reset-use" "$rc $(printf '%s' "$out" | grep -c 'only the loop does that, for an operator')" "2 1"
ck "orch.sh: ... without calling the backend" "$(test -e "$TMP/reset-called" && echo called || echo none)" "none"
# ... while the worker protocol still passes through (exit comes from the backend, not the guard).
out="$(BACKEND=/bin/false bin/role/orch.sh send r1 s b 2>&1 || true)"
ck "orch.sh passes send through" "$out" ""

echo "lifecycle-seam: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
