#!/usr/bin/env bash
# install-ce-accounts.sh — the per-account role-skill check (account-skills U1) in
# bin/host/install-skills.sh --check and bin/host/install.sh --check (accountSkillsCheck in bin/lib/account-skills.ts),
# in a throwaway HOME (never the live one).
#
# A Claude role reads the plugin registry and skills/ under the config dir of the account it was
# launched on, and a registry entry can be "enabled" while its installPath no longer exists. The check
# reads <cfg>/plugins/installed_plugins.json and <cfg>/skills/ directly (no `claude` call at all, so
# the loop can run it) for every Claude account in loop.db's accounts table. Fake account homes cover the fault classes:
#   complete · missing plugins dir · dangling installPath (user scope; project scope with a live
#   and with a gone projectPath) · missing ce-* skill · missing user skill · user-scope path recorded
#   through a profile's symlinked plugins/ (a note only).
# Asserts the verdict names the account, config dir, path and repair; --check exits non-zero only for a
# broken account (warnings exit 0); the --tsv form; accountOwner; nothing is written; install.sh
# --check shares the verdicts; the backend is never asked for accounts; no table -> the system login only; and that every skill
# roles/*.md names is in the check's list (or an explicit not-a-skill list).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
good(){ pass=$((pass + 1)); }
bad(){ fail=$((fail + 1)); echo "  FAIL: $1" >&2; }
# here-strings, not `printf | grep -q`: grep -q exits on its first match and printf then dies of SIGPIPE,
# which pipefail turns into a false "no match" on large outputs.
has(){ if grep -qF -- "$3" <<<"$2"; then good; else bad "$1: want '$3' in: $2"; fi; }
hasnt(){ if grep -qF -- "$3" <<<"$2"; then bad "$1: did not want '$3' in: $2"; else good; fi; }

unset CLAUDE_CONFIG_DIR   # the throwaway HOME's ~/.claude, not the caller's account
export HOME="$TMP/home"; mkdir -p "$HOME/.claude"
PROF="$TMP/profiles"
DS_ROLE_CE_SKILLS="$("$ROOT/bin/ds" account-skills role-skills ce)"
DS_ROLE_USER_SKILLS="$("$ROOT/bin/ds" account-skills role-skills user)"
DS_ROLE_OPTIONAL_USER_SKILLS="$("$ROOT/bin/ds" account-skills role-skills optional)"
acct() { "$ROOT/bin/ds" account-skills "$@"; }   # check | verdict | owner (bin/lib/account-skills.ts)
CE_ID="compound-engineering@compound-engineering-plugin"

# install.sh --check also requires an installed loop. Keep that infrastructure in a
# throwaway checkout so the account verdicts stay isolated from the live host.
export CHECK_ROOT="$TMP/check-root"
mkdir -p "$CHECK_ROOT/bin/host" "$CHECK_ROOT/bin/lib" "$CHECK_ROOT/conventions" "$CHECK_ROOT/state"
cp "$ROOT/bin/host/install.sh" "$ROOT/bin/host/install-skills.sh" "$CHECK_ROOT/bin/host/"
# shellcheck source=tests/lib/install-ts.sh
. "$ROOT/tests/lib/install-ts.sh"; install_ts_copy "$CHECK_ROOT"
cp "$ROOT/conventions/roles.conf" "$ROOT/conventions/models.conf" "$CHECK_ROOT/conventions/"
: > "$CHECK_ROOT/state/.loop-migrated"
: > "$CHECK_ROOT/state/loop.db"

# --- fake account homes ----------------------------------------------------------------------
mk_plugin() { # <installPath> [skills to omit…] — a compound-engineering install with the role skills
  local ip="$1" s o; shift
  for s in $DS_ROLE_CE_SKILLS; do
    for o in "$@"; do [ "$o" != "$s" ] || continue 2; done
    mkdir -p "$ip/skills/$s"; : > "$ip/skills/$s/SKILL.md"
  done
}
mk_user_skills() { # <cfg> [skills to omit…]
  local cfg="$1" s o; shift
  mkdir -p "$cfg/skills"
  for s in $DS_ROLE_USER_SKILLS $DS_ROLE_OPTIONAL_USER_SKILLS; do
    for o in "$@"; do [ "$o" != "$s" ] || continue 2; done
    mkdir -p "$cfg/skills/$s"; : > "$cfg/skills/$s/SKILL.md"
  done
}
reg() { # <cfg> <entries-json-array-body> [<extra "plugins" members>] — write <cfg>/plugins/installed_plugins.json
  mkdir -p "$1/plugins"
  printf '{"version":2,"plugins":{"%s":[%s]%s}}' "$CE_ID" "$2" "${3:-}" > "$1/plugins/installed_plugins.json"
  # enabled state lives in settings.json; a symlinked profile has its own (or none: see "noenable")
  [ -e "$1/settings.json" ] || printf '{"enabledPlugins":{"%s":true}}' "$CE_ID" > "$1/settings.json"
}
ent() { printf '{"scope":"user","installPath":"%s"}' "$1"; }

# system: ~/.claude, complete.
SYS="$HOME/.claude"; SYS_PATH="$SYS/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
mk_plugin "$SYS_PATH"; mk_user_skills "$SYS"; reg "$SYS" "$(ent "$SYS_PATH")"
# complete: a profile whose own plugins/ is complete.
C="$PROF/complete/home"; C_PATH="$C/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
mk_plugin "$C_PATH"; mk_user_skills "$C"; reg "$C" "$(ent "$C_PATH")"
# bare: no plugins dir at all.
BARE="$PROF/bare/home"; mkdir -p "$BARE"; mk_user_skills "$BARE"
# dangling: user-scope entry points at a profile that is gone; plus two dangling project-scope entries —
# one whose projectPath still exists (broken), one whose projectPath is gone (a note).
D="$PROF/dangling/home"; D_GONE="$PROF/gone-profile/home/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
mkdir -p "$TMP/live-project"
mk_user_skills "$D"
reg "$D" "$(ent "$D_GONE"),{\"scope\":\"project\",\"projectPath\":\"$TMP/live-project\",\"installPath\":\"$D_GONE-old\"},{\"scope\":\"project\",\"projectPath\":\"$TMP/gone-project\",\"installPath\":\"$D_GONE-older\"}" \
  ",\"other@mkt\":[{\"scope\":\"user\",\"installPath\":\"$D_GONE-other\"},{\"scope\":\"project\",\"projectPath\":\"$TMP/live-project\",\"installPath\":\"$D_GONE-other-proj\"}]"
# noenable: the install is complete but settings.json does not enable it (a new profile that shares
# the plugins/ dir but has its own settings.json).
E="$PROF/noenable/home"; E_PATH="$E/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
mk_plugin "$E_PATH"; mk_user_skills "$E"; printf '{"enabledPlugins":{"%s":false}}' "$CE_ID" > "$E/settings.json"; reg "$E" "$(ent "$E_PATH")"
# noskill: the install exists but lacks ce-work.
N="$PROF/noskill/home"; N_PATH="$N/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
mk_plugin "$N_PATH" ce-work; mk_user_skills "$N"; reg "$N" "$(ent "$N_PATH")"
# nouser: the plugin is complete but no-mistakes (and optional lavish) are missing from skills/.
U="$PROF/nouser/home"; U_PATH="$U/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
mk_plugin "$U_PATH"; mk_user_skills "$U" no-mistakes lavish; reg "$U" "$(ent "$U_PATH")"
# nolavish: only the OPTIONAL skill is missing -> a warning, not a failure.
L="$PROF/nolavish/home"; L_PATH="$L/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
mk_plugin "$L_PATH"; mk_user_skills "$L" lavish; reg "$L" "$(ent "$L_PATH")"
# own: the profile that owns the real plugins/ the two symlinked profiles below share (not an account itself).
O="$PROF/own/home"; O_PATH="$O/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
mk_plugin "$O_PATH"; mk_user_skills "$O"; reg "$O" "$(ent "$O_PATH")"
# locals: a local-scope entry for a removed worktree is a harmless note, like a project-scope one.
LC="$PROF/locals/home"; LC_PATH="$LC/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
mk_plugin "$LC_PATH"; mk_user_skills "$LC"
reg "$LC" "$(ent "$LC_PATH"),{\"scope\":\"local\",\"projectPath\":\"$TMP/gone-worktree\",\"installPath\":\"$LC-gone\"}"
# thru: plugins/ is a symlink to the owner's, but the user-scope entry was recorded through
# THIS profile's path (the dd3c trap): exists today, dangles when the profile is re-created -> warning.
T="$PROF/thru/home"; mkdir -p "$T"; ln -s "$O/plugins" "$T/plugins"; mk_user_skills "$T"; printf '{"enabledPlugins":{"%s":true}}' "$CE_ID" > "$T/settings.json"
T_PATH="$T/plugins/cache/compound-engineering-plugin/compound-engineering/3.34.0"
# (the symlink resolves $T_PATH to $C_PATH; the registry file is the shared one, so write it directly)
reg "$O" "$(ent "$T_PATH")"
# thruok: same symlink, but the entry is recorded through the OWNER -> ok, and the owner is resolved.
mkdir -p "$PROF/thruok/home"; ln -s "$O/plugins" "$PROF/thruok/home/plugins"; mk_user_skills "$PROF/thruok/home"; printf '{"enabledPlugins":{"%s":true}}' "$CE_ID" > "$PROF/thruok/home/settings.json"

# --- fake backend ----------------------------------------------------------------------------
export FAKE_BACKEND_LOG="$TMP/backend.log" FAKE_PROF="$PROF"
BACKEND_STUB="$TMP/backend.sh"
cat > "$BACKEND_STUB" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_BACKEND_LOG"
case "${1:-}" in
  preflight)
    [ "${FAKE_DOWN:-0}" = 1 ] && exit 1
    printf 'muse\tdefault\tdefault\n' ;;
  *) exit 2 ;;
esac
FAKE
chmod +x "$BACKEND_STUB"

# --- the accounts table ----------------------------------------------------------------------
# shellcheck source=tests/lib/seed-accounts.sh
. "$ROOT/tests/lib/seed-accounts.sh"
export DS_STATE_ROOT="$TMP/state"
accts() { # <account,account…> — each at $PROF/<account>/home; `system` is ~/.claude
  local a list specs=()
  IFS=, read -ra list <<<"$1"
  for a in "${list[@]}"; do if [ "$a" = system ]; then specs+=(system); else specs+=("$a:$PROF/$a/home"); fi; done
  seed_claude_accounts "$DS_STATE_ROOT" "${specs[@]}"
}

# --- stub PATH: real coreutils + jq, and NO claude (the check must never call it) ------------
STUB="$TMP/stub"; mkdir -p "$STUB"
for t in bash dirname mkdir ln grep sed basename readlink rm head cat awk jq tr find sort env; do
  ln -s "$(command -v "$t")" "$STUB/$t"
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/git"; chmod +x "$STUB/git"
ln -s "$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")" "$STUB/bun"   # real: both installs run on it
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/orca"; chmod +x "$STUB/orca"
export DS_ORCA_CLI_BIN_DIR="$STUB"
# shellcheck disable=SC2016 # a literal, not an expansion
printf '#!/usr/bin/env bash\n[ "${1:-}" = -l ] && printf "* * * * * %%s/bin/loop/loop.sh --ensure\\n" "$CHECK_ROOT"; exit 0\n' > "$STUB/crontab"; chmod +x "$STUB/crontab"
printf '#!/usr/bin/env bash\necho "claude called: $*" >> "%s/claude-called"; exit 0\n' "$TMP" > "$STUB/claude"; chmod +x "$STUB/claude"

snapshot(){ find "$HOME" "$PROF" "$CHECK_ROOT" -printf '%p %y %s %T@\n' 2>/dev/null | sort; }
run_check() { # <script> [args…]; sets rc, out
  local script="$1"; shift
  rc=0; out="$(PATH="$STUB" BACKEND="$BACKEND_STUB" "$CHECK_ROOT/bin/host/$script" "$@" 2>&1)" || rc=$?
}

BROKEN_ACCTS="system,complete,locals,bare,dangling,noenable,noskill,nouser,nolavish,thru,thruok,gone"

check_verdicts() { # <label> <output>
  local what="$1" out="$2"
  has "$what: complete system account -> ok" "$out" "claude[system]: skills ok ($SYS_PATH)"
  has "$what: complete profile -> ok" "$out" "claude[complete]: skills ok"
  hasnt "$what: complete is never a warning" "$out" "⚠ claude[complete]"
  # missing plugins dir
  has "$what: bare named" "$out" "⚠ claude[bare]: compound-engineering is not installed (user scope) for this config dir"
  has "$what: bare -> its config dir" "$out" "config dir:  $BARE"
  has "$what: bare -> install under its own config dir" "$out" "env CLAUDE_CONFIG_DIR=$BARE claude plugin install $CE_ID --scope user"
  # dangling
  has "$what: dangling user entry named" "$out" "⚠ claude[dangling]: $CE_ID (user scope) is registered at a path that does not exist"
  has "$what: dangling -> the broken path" "$out" "path:        $D_GONE"
  has "$what: dangling -> repair from the owner" "$out" "env CLAUDE_CONFIG_DIR=$D claude plugin uninstall $CE_ID --scope user && env CLAUDE_CONFIG_DIR=$D claude plugin install $CE_ID --scope user"
  has "$what: dangling project scope with a live project is broken" "$out" "$CE_ID (project scope) is registered at a path that does not exist"
  has "$what: ... and its repair runs in the project" "$out" "cd $TMP/live-project && env CLAUDE_CONFIG_DIR=$D claude plugin uninstall $CE_ID --scope project"
  has "$what: dangling project scope with a gone project is only a note" "$out" "note claude[dangling]: $CE_ID (project scope) points at a path that does not exist, but its project $TMP/gone-project is gone too"
  hasnt "$what: ... no ⚠ for the gone project" "$out" "path:        $D_GONE-older"
  has "$what: a local-scope entry for a removed worktree is only a note" "$out" "note claude[locals]: $CE_ID (local scope) points at a path that does not exist, but its project $TMP/gone-worktree is gone too"
  has "$what: ... and the account stays ok" "$out" "claude[locals]: skills ok"
  # another plugin's dangling entry (any plugin, any scope)
  has "$what: other plugin dangling (user)" "$out" "⚠ claude[dangling]: other@mkt (user scope) is registered at a path that does not exist"
  has "$what: other plugin repair (user)" "$out" "env CLAUDE_CONFIG_DIR=$D claude plugin uninstall other@mkt --scope user"
  has "$what: other plugin repair (project)" "$out" "cd $TMP/live-project && env CLAUDE_CONFIG_DIR=$D claude plugin uninstall other@mkt --scope project"
  # installed but not enabled
  has "$what: noenable named" "$out" "⚠ claude[noenable]: compound-engineering is installed but not enabled in this config dir"
  has "$what: noenable -> repair is claude plugin enable" "$out" "env CLAUDE_CONFIG_DIR=$E claude plugin enable $CE_ID --scope user"
  # missing ce-* skill
  has "$what: noskill named with the skill" "$out" "⚠ claude[noskill]: compound-engineering is installed but lacks role skill(s): ce-work"
  has "$what: noskill -> the install path" "$out" "path:        $N_PATH"
  has "$what: noskill -> reinstall repair" "$out" "env CLAUDE_CONFIG_DIR=$N claude plugin uninstall $CE_ID --scope user"
  # missing user skill
  has "$what: nouser named" "$out" "⚠ claude[nouser]: user skill(s) missing from $U/skills: no-mistakes"
  has "$what: nouser -> repair is the installer" "$out" "repair (the operator runs it; --check changes nothing): install the skill(s) no-mistakes into"
  # optional skill: warning only
  has "$what: nolavish warns" "$out" "⚠ claude[nolavish]: optional user skill(s) missing from $L/skills: lavish (warning)"
  hasnt "$what: nolavish is not broken" "$out" "claude[nolavish]: user skill(s)"
  # recorded through a profile: a one-line note naming the profile, no warning block, no repair
  has "$what: thru is a note" "$out" "  note claude[thru]: compound-engineering is recorded through $(basename "$(dirname "$T")")'s symlinked plugins/"
  hasnt "$what: thru is not a warning" "$out" "⚠ claude[thru]"
  hasnt "$what: thru has no repair" "$out" "env CLAUDE_CONFIG_DIR=$O claude plugin uninstall $CE_ID --scope user"
  # a missing login folder is flagged, not checked
  has "$what: an account whose login folder is missing is flagged, not checked" "$out" "⚠ claude[gone]: its login folder $PROF/gone/home is missing"
  hasnt "$what: muse is not a Claude account" "$out" "claude[default]"
}

accts "$BROKEN_ACCTS"

# --- 1. install-skills.sh --check: broken accounts -> named + exit 1 ---------------------------
before="$(snapshot)"; rm -f "$FAKE_BACKEND_LOG" "$TMP/claude-called"
run_check install-skills.sh --check
if [ "$rc" -eq 1 ]; then good; else bad "install-skills --check exits $rc, want 1 (broken accounts): $out"; fi
check_verdicts "install-skills --check" "$out"
if [ -e "$FAKE_BACKEND_LOG" ]; then bad "install-skills --check asked the backend: $(cat "$FAKE_BACKEND_LOG")"; else good; fi
if [ -e "$TMP/claude-called" ]; then bad "the account check must not call claude: $(cat "$TMP/claude-called")"; else good; fi
if [ "$before" = "$(snapshot)" ]; then good; else bad "install-skills --check wrote to HOME or a profile"; fi

# --- 2. install.sh --check: the same verdicts (one shared copy), exit 1 -------------------------
before="$(snapshot)"; rm -f "$FAKE_BACKEND_LOG"
run_check install.sh --check
if [ "$rc" -eq 1 ]; then good; else bad "install.sh --check exits $rc, want 1 (broken accounts): $out"; fi
has "install.sh --check: preflight still printed" "$out" "preflight: ok"
check_verdicts "install.sh --check" "$out"
if grep -qE '^(status|account-list|claude-config-dir)' "$FAKE_BACKEND_LOG"; then bad "install.sh --check asked the backend for accounts: $(cat "$FAKE_BACKEND_LOG")"; else good; fi
if [ "$before" = "$(snapshot)" ]; then good; else bad "install.sh --check wrote to HOME or a profile"; fi
# Both run as TypeScript behind their .sh bootstraps (U262), calling the one check (U274: accountSkillsCheck).
for f in bin/commands/install-ts.ts bin/commands/install-skills-ts.ts; do
  if grep -q 'accountSkillsCheck(' "$ROOT/$f"; then good; else bad "$f should call accountSkillsCheck"; fi
  if grep -q 'ds_ce_accounts_check' "$ROOT/$f" "$ROOT/bin/lib/account-skills.ts"; then bad "$f still has the old warn-only check"; else good; fi
done

# --- 3. only complete + warning accounts -> exit 0, warnings still printed ----------------------
accts "system,complete,nolavish,thru,thruok"
run_check install-skills.sh --check
if [ "$rc" -eq 0 ]; then good; else bad "warnings only: --check exits $rc, want 0: $out"; fi
has "warn-only: thru noted" "$out" "  note claude[thru]: compound-engineering is recorded through"
has "warn-only: thruok shares the same recorded-through-thru entry" "$out" "  note claude[thruok]: compound-engineering is recorded through"
run_check install.sh --check
if [ "$rc" -eq 0 ]; then good; else bad "warnings only: install.sh --check exits $rc, want 0: $out"; fi

# --- 4. all complete -> exit 0, one ok per account, no ⚠ --------------------------------------
reg "$O" "$(ent "$O_PATH")"
accts "system,complete,thruok"
run_check install-skills.sh --check
if [ "$rc" -eq 0 ]; then good; else bad "all complete: --check exits $rc, want 0: $out"; fi
for a in system complete thruok; do has "all complete: $a ok" "$out" "claude[$a]: skills ok"; done
hasnt "all complete: no warning" "$out" "⚠ claude["
run_check install.sh --check
if [ "$rc" -eq 0 ]; then good; else bad "all complete: install.sh --check exits $rc, want 0: $out"; fi

# --- 5. --tsv and the per-account verdict (what U2/U3 and the sweep call) -----------------------
accts "$BROKEN_ACCTS"; reg "$O" "$(ent "$T_PATH")"
tsv="$(acct check --tsv 2>/dev/null || true)"
has "tsv: system ok" "$tsv" "system	ok	$SYS_PATH"
has "tsv: complete ok" "$tsv" "complete	ok	$C_PATH"
has "tsv: bare broken" "$tsv" "bare	broken	compound-engineering is not installed"
has "tsv: dangling broken" "$tsv" "dangling	broken	$CE_ID (user scope) is registered at a path that does not exist"
has "tsv: noenable broken" "$tsv" "noenable	broken	compound-engineering is installed but not enabled"
has "tsv: noskill broken" "$tsv" "noskill	broken	compound-engineering is installed but lacks role skill(s): ce-work"
has "tsv: nouser broken" "$tsv" "nouser	broken	user skill(s) missing"
has "tsv: nolavish warn" "$tsv" "nolavish	warn	optional user skill(s) missing"
has "tsv: thru ok (a note never changes the verdict)" "$tsv" "thru	ok	"
has "tsv: a missing login folder is a warn, not checked" "$tsv" "gone	warn	its login folder is missing"
if (acct check --tsv >/dev/null 2>&1); then bad "tsv: a broken account must return non-zero"; else good; fi
reg "$O" "$(ent "$O_PATH")"
v="$(acct verdict "$N")"; has "verdict: broken" "$v" "broken	compound-engineering is installed but lacks role skill(s): ce-work"
v="$(acct verdict "$C")"; has "verdict: ok" "$v" "ok	$C_PATH"
# accountOwner (bin/lib/install.ts)
for pair in "$C:$C" "$PROF/thruok/home:$O" "$BARE:$BARE" "$T:$O"; do
  got="$(acct owner "${pair%%:*}")"
  if [ "$got" = "${pair#*:}" ]; then good; else bad "accountOwner ${pair%%:*} = $got, want ${pair#*:}"; fi
done

# --- 6. no accounts table -> the system login only, whatever CLAUDE_CONFIG_DIR the caller runs with -----
rc=0; out="$(DS_STATE_ROOT="$TMP/no-table" CLAUDE_CONFIG_DIR="$D" PATH="$STUB" BACKEND="$BACKEND_STUB" "$CHECK_ROOT/bin/host/install-skills.sh" --check 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "no table: --check exits $rc, want 0 (the system login is complete): $out"; fi
has "no table: the system login checked" "$out" "claude[system]: skills ok ($SYS_PATH)"
hasnt "no table: no other account" "$out" "claude[dangling]"

# --- 7. every skill roles/*.md names is in the check's list (or explicitly not a skill) ---------
# ce-pipeline is a ship mode; ce-skills-on-muse / ce-delegates-* are docs/solutions names.
NOT_SKILLS=" ce-pipeline ce-skills-on-muse ce-delegates-on-muse ce-delegates-reprobe-muse "
named="$(grep -ohE '\b(ce-[a-z]+(-[a-z]+)*|lfg)\b' "$ROOT"/roles/*.md | sort -u)"
for tok in $named; do
  if [[ " $DS_ROLE_CE_SKILLS " == *" $tok "* || "$NOT_SKILLS" == *" $tok "* ]]; then good
  else bad "roles/*.md names '$tok' but it is not in ROLE_CE_SKILLS (bin/lib/account-skills.ts) — add it, or list it as not-a-skill in this test"; fi
done
if grep -q "no-mistakes" "$ROOT"/roles/*.md && [[ " $DS_ROLE_USER_SKILLS " == *" no-mistakes "* ]]; then good; else bad "no-mistakes should be named in roles/*.md and in DS_ROLE_USER_SKILLS"; fi

echo "install-ce-accounts: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
