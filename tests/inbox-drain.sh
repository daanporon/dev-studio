#!/usr/bin/env bash
# inbox-wait drains Orca keepalive/heartbeat messages: a heartbeat-only batch is ACKed and we
# keep waiting, so keepalives never (a) bury a real message in the Lead's view or (b) block a
# real message behind an unacked delivery. Uses a fake `orca` whose `check` returns a heartbeat
# first, then a real question.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER="$ROOT/bin/backend/orca.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export ORCA_LOG="$TMP/log"; : > "$ORCA_LOG"
SEQ="$TMP/seq"; echo 0 > "$SEQ"

cat > "$TMP/orca" <<FAKE
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ORCA_LOG"
if [ "\$1 \$2" = "orchestration check" ]; then
  n="\$(cat "$SEQ")"; echo \$((n + 1)) > "$SEQ"
  if [ "\$n" = 0 ]; then
    echo '{"result":{"messages":[{"id":"m1","type":"heartbeat","subject":"alive"}],"deliveryId":"del_hb"}}'
  else
    echo '{"result":{"messages":[{"id":"m2","type":"question","subject":"real Q"}],"deliveryId":"del_real"}}'
  fi
fi
FAKE
chmod +x "$TMP/orca"
export DS_ORCA_CLI_BIN_DIR="$TMP"
export PATH="$TMP:$PATH"

out="$("$ADAPTER" inbox-wait run_1 3000)"
log="$(cat "$ORCA_LOG")"

pass=0; fail=0
has()  { if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
hasnt(){ if grep -qF -- "$3" <<<"$2"; then fail=$((fail+1)); echo "  FAIL: $1 — should not contain [$3]" >&2; else pass=$((pass+1)); fi; }

has   "returns the real question past the heartbeat" "$out" "real Q"
hasnt "strips the heartbeat from the batch"          "$out" "alive"
has   "acked the heartbeat-only batch (2nd check carried --ack del_hb)" "$log" "--ack del_hb"

echo "inbox-drain: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
