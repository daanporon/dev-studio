#!/usr/bin/env bash
# account-codex.sh — issue #125 U11, end to end on a temp state root: `ds account add <name> --agent codex` is
# carried out by the real account-add fulfiller, whose "terminal" runs the login line under sh with a fake codex
# (a device URL and code, then an auth.json holding a sentinel token); then the Orca adapter starts a member on
# that account (a fake orca) and reads its usage (the same fake codex's app-server). The sentinel must stay in
# the account's auth.json. Never a real codex, orca or provider.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=tests/lib/state-root.sh
. "$ROOT/tests/lib/state-root.sh"
S="$DS_STATE_ROOT"
# A session inside Orca names its real CLI in ORCA_*: none of it may reach this test.
for v in ${!ORCA_@}; do unset "$v"; done
unset DS_LOOP_CHILD DS_WHO DS_NOW DS_START_MEMBER DS_START_GEN DS_MEMBER DS_GEN DS_BACKEND BACKEND CODEX_HOME OPENAI_API_KEY CODEX_API_KEY
export DS_ACCOUNT_ADD_POLL_MS=50
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "  FAIL: $1 — [$2] missing [$3]" >&2; fi; }
bun="$(command -v bun 2>/dev/null || true)"; [ -n "$bun" ] || bun="$HOME/.bun/bin/bun"

TMP="$(mktemp -d)"
driver=""
trap '[ -z "$driver" ] || kill "$driver" 2>/dev/null || true; rm -rf "$TMP"' EXIT
export HOME="$TMP/home" FAKE_DIR="$TMP" CODEX_LOG="$TMP/codex.log" ORCA_LOG="$TMP/orca.log"
export DS_ORCA_DATA="$TMP/orcadata" DS_CLAUDE_HOME="$TMP/home/.claude" DS_USAGE_CACHE="$TMP/usage"
export DS_PROC="$TMP/proc"
SENTINEL='SENTINEL-made-up-token'
mkdir -p "$HOME/.codex/skills" "$HOME/.codex/sessions" "$TMP/bin" "$DS_PROC" "$DS_CLAUDE_HOME"
printf 'model = "made-up"\n' > "$HOME/.codex/config.toml"
: > "$ORCA_LOG"; : > "$CODEX_LOG"

cat > "$TMP/bin/codex" <<'FAKE'
#!/usr/bin/env bash
# Fake codex: `login --device-auth` and `app-server`.
printf 'argv %s\nhome %s\n' "$*" "${CODEX_HOME:-}" >> "$CODEX_LOG"
case "$*" in
  "login --device-auth")
    printf '1. Open this link in your browser and sign in to your account\n   \033[94mhttps://auth.openai.com/codex/device\033[0m\n\n'
    printf '2. Enter this one-time code \033[90m(expires in 15 minutes)\033[0m\n   \033[94mAB12-CD34E\033[0m\n'
    for _ in $(seq 400); do [ -e "$FAKE_DIR/approve" ] && break; sleep 0.05; done
    [ -e "$FAKE_DIR/approve" ] || exit 1
    t='"SENTINEL-made-up-token"'
    printf '{"OPENAI_API_KEY":null,"tokens":{"id_token":%s,"access_token":%s,"refresh_token":%s,"account_id":"acct-work"}}\n' \
      "$t" "$t" "$t" > "$CODEX_HOME/auth.json" ;;
  app-server)
    while IFS= read -r l; do
      case "$l" in
        *'"id":1'*) printf '{"id":1,"result":{}}\n' ;;
        *'"id":2'*) printf '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":12,"windowDurationMins":300,"resetsAt":1900000000}},"rateLimitResetCredits":null}}\n' ;;
      esac
    done ;;
esac
FAKE
cat > "$TMP/bin/orca" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$ORCA_LOG"
case "$1 ${2:-}" in
  "terminal create") echo '{"result":{"terminal":{"handle":"tab_new"}}}' ;;
  "terminal list") echo '{"result":{"terminals":[]}}' ;;
  "worktree ps") echo '{"result":{"worktrees":[]}}' ;;
  "orchestration worker-start") echo '{"result":{"worker":{"id":"w1"},"ok":true}}' ;;
  *) echo '{"result":{"ok":true}}' ;;
esac
FAKE
chmod +x "$TMP/bin/codex" "$TMP/bin/orca"
export PATH="$TMP/bin:$PATH"
export DS_ORCA_CLI_BIN_DIR="$TMP/bin"     # the adapter's orca is the fake

"$ROOT/bin/ds" account list >/dev/null      # makes loop.db
# The loop, with only the account-add fulfiller; its terminal is the login line under sh, its screen a file.
cat > "$TMP/driver.ts" <<TS
import { readFileSync, writeFileSync } from "node:fs";
import { LoopActuator } from "$ROOT/bin/loop/core/actuator.ts";
import { FakeBackend } from "$ROOT/bin/loop/fakes/orca.ts";
import { accountAdd } from "$ROOT/bin/loop/fulfil/account-add.ts";
import { open } from "$ROOT/bin/loop/core/store.ts";
import { Loop } from "$ROOT/bin/loop/core/tick.ts";
const s = open(process.env.DS_STATE_ROOT!), screen = "$TMP/screen";
const now = () => Math.floor(Date.now() / 1000);
const f = accountAdd({ refresh: () => {}, terminals: {
  async open(_x, project, { line }) { writeFileSync(screen, ""); Bun.spawn(["sh", "-c", line + " > " + screen + " 2>&1"]); return { via: "orca", handle: "t1", project }; },
  async read() { return readFileSync(screen, "utf8"); },
  async close() {},
} });
const act = new LoopActuator({ orca: new FakeBackend(), fulfillers: [f] });
const loop = new Loop(s, { observers: [], reconcilers: [f] }, act, { projects: () => ["fx"] });
loop.boot(now());
for (let i = 0; i < 600; i++) {
  s.db.run("INSERT INTO health (id, pid, started_at, tick_at, progress_at) VALUES (1, 1, ?1, ?1, ?1) ON CONFLICT(id) DO UPDATE SET tick_at = ?1, progress_at = ?1", [now()]);
  s.db.run("INSERT OR IGNORE INTO projects (label, studio_wt, observed_at) VALUES ('fx', 'wt-fx', ?1)", [now()]);
  s.db.run("INSERT OR IGNORE INTO members (project, squad, role, suffix, handle, observed_at, updated_at) VALUES ('fx', '_studio', 'studio', '', 'term-fx', ?1, ?1)", [now()]);
  await loop.tick(now()); await act.drain();
  await Bun.sleep(100);
}
TS
"$bun" "$TMP/driver.ts" > "$TMP/driver.log" 2>&1 & driver=$!
sql() { "$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  const r = d.query(process.argv[2]).all(); if (r.length) console.log(r.map((x) => Object.values(x).join("|")).join("\n"))' "$S/loop.db" "$1"; }
for _ in $(seq 100); do [ "$(sql "SELECT COUNT(*) FROM members" 2>/dev/null || echo 0)" = 1 ] && break; sleep 0.1; done

FOLDER="$S/accounts/codex/work"
( rc=0; OPENAI_API_KEY=made-up-key "$ROOT/bin/ds" account add work --agent codex > "$TMP/add.out" 2>&1 || rc=$?; echo "$rc" > "$TMP/add.rc" ) & adding=$!
seen=""
for _ in $(seq 200); do
  seen="$(sql "SELECT json_extract(result, '\$.url') || ' ' || json_extract(result, '\$.device_code') FROM requests WHERE kind = 'account-add' AND json_extract(result, '\$.device_code') IS NOT NULL")"
  [ -z "$seen" ] || break; sleep 0.1
done
ck "the request's result has the URL and the device code" "$seen" "https://auth.openai.com/codex/device AB12-CD34E"
sleep 0.2; touch "$TMP/approve"
wait "$adding"
out="$(cat "$TMP/add.out")"
ck "the add ends done" "$(cat "$TMP/add.rc")" "0"
has "the CLI showed the URL and the code" "$out" "open https://auth.openai.com/codex/device and enter AB12-CD34E"
has "the CLI warns about a set API key" "$out" "warning: OPENAI_API_KEY is set"
has "the CLI says it was added" "$out" "added codex:work"
ck "the row" "$(sql "SELECT config_dir || '|' || source || '|' || login_id FROM accounts WHERE agent = 'codex' AND account = 'work'")" "$FOLDER|ds|acct-work"
ck "the login ran under the new folder" "$(grep -A1 -xF 'argv login --device-auth' "$CODEX_LOG" | tail -n1)" "home $FOLDER"
ck "the folder links the system config.toml" "$(readlink "$FOLDER/config.toml" 2>/dev/null || echo missing)" "$HOME/.codex/config.toml"
kill "$driver" 2>/dev/null || true; wait "$driver" 2>/dev/null || true; driver=""

# A member on the account starts on Orca in a tab with the folder env.
rc=0; "$ROOT/bin/backend/orca.sh" worker-start run_1 "repo1::/w/cx" spec codex gpt-x - - work > "$TMP/start.out" 2>&1 || rc=$?
ck "worker start on the account" "$rc" "0"
has "the launch line carries CODEX_HOME=<folder>" "$(cat "$ORCA_LOG")" "--command env CODEX_HOME=$FOLDER codex -c disable_paste_burst=true"

# Its usage row is read from that folder.
: > "$CODEX_LOG"; mkdir -p "$TMP/nocli"
usage="$(DS_ORCA_CLI_BIN_DIR="$TMP/nocli" "$ROOT/bin/backend/orca.sh" account-usage 2> "$TMP/usage.err" || true)"
ck "a usage row for the account" "$(awk -F'\t' '$1=="codex" && $2=="work"{print $3}' <<<"$usage")" "12"
has "the usage read runs with the folder env" "$(cat "$CODEX_LOG")" "home $FOLDER"

# The token stays in the account's auth.json: not in the db, the state root, the logs or any output.
ck "the fake wrote the sentinel" "$(grep -c "$SENTINEL" "$FOLDER/auth.json")" "1"
dump="$("$bun" -e 'const { Database } = require("bun:sqlite"); const d = new Database(process.argv[1], { readonly: true });
  for (const t of d.query("SELECT name FROM sqlite_master WHERE type = ?").all("table")) console.log(JSON.stringify(d.query(`SELECT * FROM "${t.name}"`).all()));' "$S/loop.db")"
has "the dump holds the login id" "$dump" "acct-work"
ck "no sentinel in a dump of loop.db" "$(grep -c "$SENTINEL" <<<"$dump" || true)" "0"
ck "the sentinel is only in the account's auth.json" "$(grep -rlaF "$SENTINEL" "$S" "$TMP" --exclude=codex --exclude=driver.log 2>/dev/null | sort -u)" "$FOLDER/auth.json"
ck "no sentinel in the captured output" "$(printf '%s\n%s\n' "$out" "$usage" | cat - "$TMP/start.out" "$TMP/usage.err" "$TMP/driver.log" | grep -c "$SENTINEL" || true)" "0"

echo "account-codex: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
