#!/usr/bin/env bash
# wrap-hooks.sh — U235: the start-hook gate is not in settings.json any more. wrap-hooks.sh unwraps any
# still-wrapped settings.json on every account, leaves a plain one byte for byte, and --check names each account.
# Also covers the PATH shims in bin/hooks/path-gates (the gate itself).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); echo "  FAIL: $1 — $2" >&2; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
W="$ROOT/bin/host/wrap-hooks.sh"
export HOME="$TMP/home"; mkdir -p "$HOME/.claude"
unset CLAUDE_CONFIG_DIR
export CLAUDE_SYSTEM_DIR="$HOME/.claude"
# fake backend with two accounts
cat > "$TMP/backend.sh" <<B
#!/usr/bin/env bash
case "\$1" in
  preflight) echo preflight >> "$TMP/backend.log"
    printf 'claude\tacctA\tA\t$TMP/acctA\nclaude\tacctB\tB\t$TMP/acctB\nclaude\tsystem\tsystem login\t\ncodex\tx\tx\n' ;;
  *) echo "\$1" >> "$TMP/backend.log"; exit 2 ;;
esac
B
chmod +x "$TMP/backend.sh"; export BACKEND="$TMP/backend.sh"
mkdir -p "$TMP/acctA" "$TMP/acctB"
wrapped() { cat <<'J'
{ "model":"x",
  "hooks": {"SessionStart": [
   {"matcher":"","hooks":[{"type":"command","command":"/opt/ds/bin/ds hook-gate gh-axi -- gh-axi","timeout":10}]},
   {"hooks":[{"type":"command","command":"/x/ds hook-gate lavish-axi -- lavish-axi","timeout":10},{"type":"command","command":"other-hook"}]}
  ]}}
J
}
plain() { printf '{"model":"y","hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"lavish-axi"}]}]}}\n'; }
wrapped > "$TMP/acctA/settings.json"; wrapped > "$HOME/.claude/settings.json"
plain > "$TMP/acctB/settings.json"; cp "$TMP/acctB/settings.json" "$TMP/b.orig"
out="$("$W" --check 2>&1)" && rc=0 || rc=$?
# Alone it reads the runtime and every config dir with ONE backend start; handed the rows, none (U246).
[ "$(cat "$TMP/backend.log")" = preflight ] && ok || bad "alone: one preflight start" "$(cat "$TMP/backend.log")"
: > "$TMP/backend.log"
DS_WRAP_ACCOUNTS="$(printf 'acctA\t%s/acctA' "$TMP")" "$W" --check >/dev/null 2>&1 || true
[ ! -s "$TMP/backend.log" ] && ok || bad "handed the rows: no backend start" "$(cat "$TMP/backend.log")"
[ "$rc" = 1 ] && ok || bad "--check exits 1 on a stale file" "$rc"
for w in "acctA: wrapped (stale)" "system: wrapped (stale)" "acctB: plain"; do
  grep -q "$w" <<<"$out" && ok || bad "--check names $w" "$out"
done
"$W" >/dev/null 2>&1 && ok || bad "unwrap succeeds" "failed"
for f in "$TMP/acctA/settings.json" "$HOME/.claude/settings.json"; do
  grep -q hook-gate "$f" && bad "$f unwrapped" "$(cat "$f")" || ok
  [ "$(jq -r '.hooks.SessionStart[1].hooks[1].command' "$f")" = other-hook ] && [ "$(jq -r .model "$f")" = x ] && ok || bad "$f keeps the rest" "$(cat "$f")"
done
[ "$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$TMP/acctA/settings.json")" = gh-axi ] && ok || bad "command back to bare gh-axi" "?"
cmp -s "$TMP/b.orig" "$TMP/acctB/settings.json" && ok || bad "a plain settings.json is left byte for byte" "changed"
"$W" --check >/dev/null 2>&1 && ok || bad "--check passes once all are plain" "failed"
# a backup that matches the wrapped file byte-restores it
wrapped > "$TMP/acctA/settings.json"; plain > "$TMP/acctA/settings.json.ds-hooks-backup"
jq '.hooks.SessionStart[0].hooks[0].command="gh-axi"' "$TMP/acctA/settings.json" >/dev/null
"$W" >/dev/null 2>&1; [ ! -e "$TMP/acctA/settings.json.ds-hooks-backup" ] && ok || bad "backup removed" "left"

# ---- the shims
SH="$ROOT/bin/hooks/path-gates"; REAL="$TMP/real"; mkdir -p "$REAL" "$TMP/rolewt"
for n in lavish-axi gh-axi chrome-devtools-axi; do
  printf '#!/usr/bin/env bash\necho "real %s args=[$*] stdin=[$(timeout 1 cat 2>/dev/null || true)]"\n' "$n" > "$REAL/$n"; chmod +x "$REAL/$n"
done
# fake ds that gates by FAKE_GATE=off|on
cat > "$TMP/ds" <<'D'
#!/usr/bin/env bash
[ "$1" = hook-gate ] || exit 9
[ "${FAKE_GATE:-on}" = off ] && exit 0
shift 3; exec bash -c "$1"
D
chmod +x "$TMP/ds"
export DS_HOOK_GATE_BIN="$TMP/ds"
HOOK='{"hook_event_name":"SessionStart","source":"startup"}'
run() { PATH="$SH:$REAL:$PATH" "$@"; }
o="$(printf '%s' "$HOOK" | FAKE_GATE=off run lavish-axi)"; [ -z "$o" ] && ok || bad "hook call, rule off: nothing printed" "$o"
o="$(printf '%s' "$HOOK" | FAKE_GATE=on run lavish-axi)"; grep -q "^real lavish-axi" <<<"$o" && ok || bad "hook call, rule on: real output" "$o"
o="$(printf '%s' "$HOOK" | FAKE_GATE=off run lavish-axi open f.html)"; grep -q "args=\[open f.html\]" <<<"$o" && ok || bad "own call with args always runs" "$o"
o="$(printf 'hello' | FAKE_GATE=off run gh-axi)"; grep -q "stdin=\[hello\]" <<<"$o" && ok || bad "other stdin passed on, never gated" "$o"
o="$(FAKE_GATE=off PATH="$SH:$TMP/none:/usr/bin:/bin" lavish-axi < /dev/null; echo rc=$?)"; [ "$o" = "rc=0" ] && ok || bad "missing real tool: quiet exit 0" "$o"
echo "wrap-hooks: $pass passed, $fail failed"
[ "$fail" = 0 ]
