#!/usr/bin/env bash
# account-move.sh — issue #125 U8: `ds account move` on a temp state root with a made-up Orca profile. The CLI's
# refusals file nothing (a busy account, an Orca-listed one without --force, the system login, the loop down); a good
# move is filed; then the loop's fulfiller runs once (bun, no live agents) and the account's launch
# folder — the Orca adapter's claude-config-dir, which a managed Claude start runs with — is the copy, under the same
# id, while Orca's folder is byte for byte as it was. Never a real claude or Orca.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=tests/lib/state-root.sh
. "$ROOT/tests/lib/state-root.sh"
S="$DS_STATE_ROOT"
unset ORCA_TERMINAL_HANDLE DS_LOOP_CHILD DS_WHO DS_NOW DS_BACKEND
export DS_ACCOUNT_ADD_POLL_MS=50
export HOME="$S/home" DS_ORCA_DATA="$S/orca" DS_CLAUDE_SYSTEM_JSON_DIR="$S/home"
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
bun="$(command -v bun 2>/dev/null || true)"; [ -n "$bun" ] || bun="$HOME/.bun/bin/bun"
[ -x "$bun" ] || bun="$(dirname "$ROOT")/.bun/bin/bun"
sql() { "$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1]);
  const r = d.query(process.argv[2]).all(); if (r.length) console.log(r.map((x) => Object.values(x).join("|")).join("\n"))' "$S/loop.db" "$1"; }
move() { rc=0; out="$("$ROOT/bin/ds" account move "$@" 2>&1)" || rc=$?; }
requests() { sql "SELECT COUNT(*) FROM requests WHERE kind = 'account-move'"; }
# Every entry of a folder with its mode, size, time and checksum (links as their targets).
snap() { (cd "$1" && find . -printf '%p %y %m %s %T@ %l\n' | sort && find . -type f -exec sha256sum {} + | sort); }

ID="6b9a19e7-made-up-profile"
PROF="$DS_ORCA_DATA/claude-profiles/$ID/home"
mkdir -p "$HOME/.claude/projects" "$PROF/sessions"
echo '{}' > "$HOME/.claude/.credentials.json"
ln -s "$HOME/.claude/projects" "$PROF/projects"
echo '{"claudeAiOauth":{"accessToken":"made-up-token"}}' > "$PROF/.credentials.json"
echo '{}' > "$PROF/sessions/s1.json"
chmod 600 "$PROF/.credentials.json"
before="$(snap "$PROF")"

"$ROOT/bin/ds" account list >/dev/null      # makes loop.db
now="$(date +%s)"
sql "INSERT INTO accounts (agent, account, label, config_dir, source, login_id, orca_listed, observed_at) VALUES ('claude', '$ID', 'moved@example.com', '$PROF', 'orca', 'uuid-moved', 1, $now)"
ck "before: the launch folder is Orca's profile" "$("$ROOT/bin/backend/orca.sh" claude-config-dir "$ID")" "$PROF"

# Refusals: nothing filed, nothing copied.
move system;                         ck "system login: exit 2" "$rc" "2"; has "system login" "$out" "the agent's own login"
move nobody;                         ck "unknown account: exit 2" "$rc" "2"
move "$ID";                          ck "Orca-listed, no force: exit 2" "$rc" "2"
has "Orca-listed: the rotation risk" "$out" "the first copy to refresh logs the other out"
has "Orca-listed: names --force" "$out" "--force"
has "Orca-listed: nothing moved" "$out" "Nothing moved."
sql "INSERT INTO members (project, squad, role, suffix, wt, handle, account, observed_at, updated_at) VALUES ('fx', 'sq', 'builder', 'u1', 'wt-1', 'term-1', '$ID', $now, $now)"
sql "INSERT INTO observed_workers (project, wt, observed_at) VALUES ('fx', 'wt-1', $now)"
move "$ID" --force;                  ck "busy: exit 2" "$rc" "2"; has "busy" "$out" "in use by fx/sq/builder-u1"
sql "UPDATE observed_workers SET gone_at = $now"
move "$ID" --force;                  ck "loop never ran: exit 2" "$rc" "2"; has "loop never ran" "$out" "the loop has never run here"
ck "refusals filed nothing" "$(requests)" "0"
ck "refusals copied nothing" "$(test -e "$S/accounts" && echo made || echo none)" "none"

# Filed: with a (faked) live loop the CLI files the request and, with --no-wait, exits 0 at once.
sql "INSERT INTO health (id, pid, started_at, tick_at, progress_at) VALUES (1, 1, $now, $now, $now)"
move "$ID" --force --no-wait;        ck "filed: exit 0" "$rc" "0"; has "filed" "$out" "Filed the move of claude:$ID"
ck "filed: the payload" "$(sql "SELECT json_extract(payload, '\$.account') || '|' || json_extract(payload, '\$.force') FROM requests WHERE kind = 'account-move'")" "$ID|1"
ck "the CLI copied nothing (the loop does)" "$(test -e "$S/accounts" && echo made || echo none)" "none"

# The loop's fulfiller on that request, once, with no live agent processes.
"$bun" -e '
  const root = process.argv[1];
  const { open } = await import(root + "/bin/loop/core/store.ts");
  const { LoopActuator } = await import(root + "/bin/loop/core/actuator.ts");
  const { Loop } = await import(root + "/bin/loop/core/tick.ts");
  const { FakeBackend } = await import(root + "/bin/loop/fakes/orca.ts");
  const { accountMove } = await import(root + "/bin/loop/fulfil/account-move.ts");
  const s = open(process.env.DS_STATE_ROOT);
  const f = accountMove({ live: async () => [], refresh: () => {} });
  const act = new LoopActuator({ orca: new FakeBackend(), fulfillers: [f] });
  const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => [] });
  const at = Math.floor(Date.now() / 1000);
  loop.boot(at); await loop.tick(at + 1); await act.drain(); s.close();' "$ROOT"

NEW="$S/accounts/claude/$ID"
ck "moved: the request ok" "$(sql "SELECT json_extract(result, '\$.ok') FROM requests WHERE kind = 'account-move'")" "1"
ck "moved: the same id, source ds, on the copy" "$(sql "SELECT account || '|' || source || '|' || config_dir FROM accounts WHERE agent = 'claude'")" "$ID|ds|$NEW"
ck "moved: the next launch line's folder is the copy" "$("$ROOT/bin/backend/orca.sh" claude-config-dir "$ID")" "$NEW"
ck "moved: the link stays a link" "$(readlink "$NEW/projects")" "$HOME/.claude/projects"
ck "moved: the credentials arrived" "$(cat "$NEW/.credentials.json")" '{"claudeAiOauth":{"accessToken":"made-up-token"}}'
ck "moved: mode 0700" "$(stat -c %a "$NEW")" "700"
ck "moved: Orca's folder unchanged" "$(snap "$PROF")" "$before"
ck "moved: one account_moved event" "$(sql "SELECT COUNT(*) FROM events WHERE kind = 'account_moved'")" "1"

# A moved account is refused as already moved.
move "$ID";                          ck "already moved: exit 2" "$rc" "2"; has "already moved" "$out" "already in dev-studio's folder"

echo "account-move: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
