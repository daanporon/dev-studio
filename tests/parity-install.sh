#!/usr/bin/env bash
# parity-install.sh — the TypeScript install (U262: bin/host/install.sh and install-skills.sh as bash
# bootstraps for `ds install-ts` / `ds install-skills-ts`) does what the shell versions did. Each side
# runs the same steps on its own empty HOME with the same stub PATH: a first install, a repeat, --check,
# --unwrap-hooks, a bad flag, install-skills --check and a full install-skills. Compared per step:
# output and exit code, then the written tree (`find | sort` of HOME and the checkout's state with
# link targets, plus a hash of every regular file), the crontab and the systemctl calls. Paths are
# normalized to <T>. The shell side is the tree at PARITY_BASE (default 8b0818e, the last commit with
# the shell versions), unpacked with git archive.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BASE="${PARITY_BASE:-8b0818e}"
if ! git -C "$ROOT" cat-file -e "$BASE^{commit}" 2>/dev/null; then
  echo "parity-install: $BASE is not in this clone — skipped"; echo "parity-install: 0 passed, 0 failed"; exit 0
fi
TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
good(){ pass=$((pass + 1)); }
bad(){ fail=$((fail + 1)); echo "  FAIL: $1" >&2; }

# The host's Orca/Claude settings must not reach either install (tests/lib/install-setup.sh does the same).
unset XDG_CONFIG_HOME ORCA_USER_DATA_PATH ORCA_CLI_BIN_DIR DS_ORCA_CLI_BIN_DIR CLAUDE_CONFIG_DIR BACKEND DS_STATE_ROOT

for t in old new; do
  mkdir -p "$TMP/$t/dev-studio" "$TMP/$t/home"
  # Only bin/ is under test: the old side's bin/ is the tree at BASE, everything else is today's.
  if [ "$t" = old ]; then git -C "$ROOT" archive "$BASE" bin | tar -x -C "$TMP/old/dev-studio"
  else cp -r "$ROOT/bin" "$TMP/new/dev-studio/"; fi
  cp -r "$ROOT/conventions" "$ROOT/systemd" "$ROOT/skills" "$TMP/$t/dev-studio/"
  mkdir -p "$TMP/$t/dev-studio/.claude"; cp -r "$ROOT/.claude/commands" "$TMP/$t/dev-studio/.claude/"
done

# --- one stub PATH for both: real coreutils, jq and bun; fakes that log for claude, git, orca, systemctl,
# crontab, curl and npx. The log and the crontab file are per side (CALLS, CRONTAB).
STUB="$TMP/stub"; mkdir -p "$STUB"
for c in bash sh dirname mkdir ln grep sed basename readlink rm head tail cat awk sleep ps jq tr find sort mv; do
  ln -s "$(command -v "$c")" "$STUB/$c"
done
ln -s "$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")" "$STUB/bun"
for c in claude git systemctl curl npx; do
  # shellcheck disable=SC2016 # literals for the stub
  printf '#!/usr/bin/env bash\necho "%s $*" | sed "s|$PARITY_TMP/[a-z]*/|<T>/|g" >> "$CALLS"\nexit 0\n' "$c" > "$STUB/$c"; chmod +x "$STUB/$c"
done
cat > "$STUB/orca" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = status ]; then echo '{"ok":true,"result":{"runtime":{"reachable":true,"state":"ready"}}}'
elif [ "${1:-}" = account ]; then echo '{"ok":true,"result":{"claude":{"accounts":[{"id":"a1","email":"t@e.com","managedAuthRuntime":"host"}],"systemDefaultEmail":"s@e.com"}}}'
else echo "fake orca: unexpected: $*" >&2; exit 2; fi
FAKE
chmod +x "$STUB/orca"
cat > "$STUB/crontab" <<'FAKE'
#!/usr/bin/env bash
if [ "$1" = "-l" ]; then cat "$CRONTAB" 2>/dev/null || { echo "no crontab for you" >&2; exit 1; }
else cat > "$CRONTAB"; fi
FAKE
chmod +x "$STUB/crontab"
export PARITY_TMP="$TMP"

norm() { sed "s|$TMP/old|<T>|g; s|$TMP/new|<T>|g"; }
# The written tree of one side: every path under HOME and the checkout's state with its type and link
# target, then each regular file's hash after path and time normalization (the unit file names the
# checkout, .loop-migrated holds the migration time; loop.db is compared by presence only, without
# SQLite's -wal/-shm sidecars: the TS install reads the roster rows from it, U257; and without U256's
# settings cut-over mark .settings-migrated, which the TS migration writes on every fresh root). ~/.bun is
# bun's own transpiler cache (file names hash the source path), not something install writes.
tree_of() { # <side>
  local d="$TMP/$1" f
  ( cd "$d" && find home dev-studio/state -path home/.bun -prune -o ! -name 'loop.db-wal' ! -name 'loop.db-shm' ! -name .settings-migrated -printf '%p %y %l\n' 2>/dev/null | norm | sort )
  ( cd "$d" && find home dev-studio/state -path home/.bun -prune -o -type f ! -name 'loop.db*' ! -name .settings-migrated -print 2>/dev/null | sort ) | while IFS= read -r f; do
    printf '%s %s\n' "$f" "$(norm < "$d/$f" | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/<time>/g' | sha256sum | cut -d' ' -f1)"
  done
  printf 'crontab:\n'; norm < "$d/crontab" 2>/dev/null || true
  printf 'calls:\n'; { skip_u8 < "$d/calls"; } 2>/dev/null || true
}
# The leak hooks (public-readiness U8) came after the shell versions: their lines and the clone probe they make
# through the fake git are left out of both sides.
skip_u8() { awk '/^(⚠ )?leak hooks: /{next} /^-> leak hooks /{blank=0; next} blank{print ""; blank=0} /^$/{blank=1; next} {print} END{if(blank)print ""}' | grep -vE '^git -C .* rev-parse --path-format=absolute --git-common-dir$' || true; }
run_side() { # <side> <script> [args…] — prints rc then the normalized output
  local side="$1" script="$2"; shift 2
  local d="$TMP/$side" rc=0 out
  out="$(cd "$d/dev-studio" && HOME="$d/home" PATH="$STUB" CALLS="$d/calls" CRONTAB="$d/crontab" \
    BACKEND="$d/backend.sh" ./bin/host/"$script" "$@" 2>&1)" || rc=$?
  printf 'rc=%s\n%s\n' "$rc" "$out" | norm | skip_u8
}
for t in old new; do
  printf '#!/usr/bin/env bash\nDS_ORCA_CLI_BIN_DIR="%s" exec "%s/bin/backend/orca.sh" "$@"\n' "$STUB" "$TMP/$t/dev-studio" > "$TMP/$t/backend.sh"
  chmod +x "$TMP/$t/backend.sh"
done

step() { # <label> <script> [args…]
  local label="$1" o n; shift
  o="$(run_side old "$@")"; n="$(run_side new "$@")"
  if [ "$o" = "$n" ]; then good; else bad "$label: output differs:$(diff <(echo "$o") <(echo "$n") | head -20)"; fi
  o="$(tree_of old)"; n="$(tree_of new)"
  if [ "$o" = "$n" ]; then good; else bad "$label: written tree differs:$(diff <(echo "$o") <(echo "$n") | head -20)"; fi
}

step "first install on an empty HOME" install.sh
# Not two empty runs: the new side wrote the pointer, the command links, the unit and the watchdog line.
if [ -L "$TMP/new/home/.dev-studio" ] && [ -L "$TMP/new/home/.claude/commands/ds-up.md" ] \
  && [ -f "$TMP/new/home/.config/systemd/user/ds-loop.service" ] && grep -qF 'loop.sh --ensure' "$TMP/new/crontab"; then good
else bad "the first install wrote too little to compare: $(cd "$TMP/new" && find home | head -20)"; fi
step "repeat install" install.sh
step "--check" install.sh --check
step "--unwrap-hooks" install.sh --unwrap-hooks
step "unknown flag" install.sh --bogus
step "install into a named dir" install.sh ../home/cmds-dir
step "install-skills --check" install-skills.sh --check
step "install-skills full install" install-skills.sh
step "install-skills --muse-only" install-skills.sh --muse-only
step "install-skills bad flag" install-skills.sh --nope
step "install --skills" install.sh --skills

echo "parity-install: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
