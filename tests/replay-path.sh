#!/usr/bin/env bash
# replay-path.sh — U208: the loop front door (loopFront in bin/lib/lib.ts, U193: the shell twin is gone) records the
# calling script's real path under the host root (bin/<folder>/<name>), for send-role, send-peer,
# finish-unit and reassert-roles. A fixture host holds a bin/ds that prints the request json; the
# TypeScript front door runs under each name with DS_ROOT at that host.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1" >&2; fi; }

H="$TMP/host"; mkdir -p "$H/bin" "$H/state"
printf '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do [ "$1" = --json ] && { printf "%%s" "$2"; exit 0; }; shift; done\n' > "$H/bin/ds"
chmod +x "$H/bin/ds"
touch "$H/state/.loop-migrated"
for pair in role/send-role role/send-peer role/finish-unit hooks/reassert-roles; do
  out="$(DS_ROOT="$H" DS_STATE_ROOT="$H/state" bun -e "
    import { loopArgs, loopFront } from '$ROOT/bin/lib/lib.ts';
    const a = loopArgs(['a', 'b'], 'probe')!;
    process.exit((await loopFront('fx', 'probe', '', '', 'probe:k', a, '$pair.sh')) ?? 1);")"
  ok "$pair names its folder path" "[ \"\$(jq -r '.argv[0]' <<< '$out')\" = '$H/bin/$pair.sh' ]"
  ok "$pair keeps its args" "[ \"\$(jq -c '.argv[1:]' <<< '$out')\" = '[\"a\",\"b\"]' ]"
done
echo "replay-path: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
