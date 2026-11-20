#!/usr/bin/env bash
# install-skills-accounts.sh — bin/host/install-skills.sh installs the role skills into EVERY Claude
# account (account-skills U2), in a throwaway HOME (never the live one).
#
# A stub `claude` records each call's argv + CLAUDE_CONFIG_DIR and, like the real CLI, writes the
# registry under the config dir it ran with, recording installPath through that dir without resolving
# symlinks — so an install run through a symlinked profile leaves exactly the trap U1's check flags.
# Fake account homes: complete · missing plugins dir · dangling user entry (plus a project-scope entry
# that must survive) · missing ce-* skill · a profile recorded through its symlinked plugins/ (owner is
# another profile) · the dd3c trap (~/.claude's entry recorded through a profile) · a profile sharing
# ~/.claude's plugins/ + skills/ · a profile whose settings.json doesn't enable the plugin.
# Asserts: installs run only under each owner's env (never a symlinked profile's), once per owner;
# user skills are symlinked into accounts whose skills/ is elsewhere; one line per account; --check
# exits 0 after; a second run makes no claude plugin call and changes no file; a non-link skill entry
# is never replaced; backend unreachable -> the current env only.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
good(){ pass=$((pass + 1)); }
bad(){ fail=$((fail + 1)); echo "  FAIL: $1" >&2; }
has(){ if grep -qF -- "$3" <<<"$2"; then good; else bad "$1: want '$3' in: $2"; fi; }
hasnt(){ if grep -qF -- "$3" <<<"$2"; then bad "$1: did not want '$3' in: $2"; else good; fi; }

unset CLAUDE_CONFIG_DIR   # the throwaway HOME's ~/.claude, not the caller's account
export HOME="$TMP/home"; mkdir -p "$HOME/.claude"
PROF="$TMP/profiles"
# The role skills every account must carry (bin/lib/account-skills.ts, U274).
DS_ROLE_CE_SKILLS="$("$ROOT/bin/ds" account-skills role-skills ce)"
DS_ROLE_USER_SKILLS="$("$ROOT/bin/ds" account-skills role-skills user)"
DS_ROLE_OPTIONAL_USER_SKILLS="$("$ROOT/bin/ds" account-skills role-skills optional)"
CE_ID="compound-engineering@compound-engineering-plugin"
CE_REL="plugins/cache/compound-engineering-plugin/compound-engineering"

# --- fake account homes ----------------------------------------------------------------------
mk_plugin() { # <installPath> [skills to omit…]
  local ip="$1" s o; shift
  for s in $DS_ROLE_CE_SKILLS; do
    for o in "$@"; do [ "$o" != "$s" ] || continue 2; done
    mkdir -p "$ip/skills/$s"; : > "$ip/skills/$s/SKILL.md"
  done
}
mk_user_skills() { # <cfg> — real skill dirs (what the installers leave in ~/.claude/skills)
  local s
  for s in $DS_ROLE_USER_SKILLS $DS_ROLE_OPTIONAL_USER_SKILLS; do mkdir -p "$1/skills/$s"; : > "$1/skills/$s/SKILL.md"; done
}
reg() { # <cfg> <entries json body> — <cfg>/plugins/installed_plugins.json + enabled in settings.json
  mkdir -p "$1/plugins"
  printf '{"version":2,"plugins":{"%s":[%s]}}' "$CE_ID" "$2" > "$1/plugins/installed_plugins.json"
  [ -e "$1/settings.json" ] || printf '{"enabledPlugins":{"%s":true}}' "$CE_ID" > "$1/settings.json"
}
ent() { printf '{"scope":"user","installPath":"%s"}' "$1"; }
enable_in() { printf '{"enabledPlugins":{"%s":true}}' "$CE_ID" > "$1/settings.json"; }

SYS="$HOME/.claude"; mk_user_skills "$SYS"
# linked: the dd3c shape — plugins/ and skills/ symlinked to ~/.claude's; ~/.claude's entry was
# recorded through THIS profile's path (exists today, dangles once it is re-created).
LK="$PROF/linked/home"; mkdir -p "$LK"; mkdir -p "$SYS/plugins"
ln -s "$SYS/plugins" "$LK/plugins"; ln -s "$SYS/skills" "$LK/skills"; enable_in "$LK"
mk_plugin "$SYS/$CE_REL/3.34.0"; reg "$SYS" "$(ent "$LK/$CE_REL/3.34.0")"
# complete: its own plugins/ and skills/, all present.
C="$PROF/complete/home"; mk_plugin "$C/$CE_REL/3.34.0"; mk_user_skills "$C"; reg "$C" "$(ent "$C/$CE_REL/3.34.0")"
# bare: no plugins dir and no skills dir.
BARE="$PROF/bare/home"; mkdir -p "$BARE"
# dangling: user entry points at a gone profile; a dangling project-scope entry for a gone project
# (a note, never touched by the installer); skills/ has no-mistakes as a real dir, lavish missing.
D="$PROF/dangling/home"; mkdir -p "$D/skills/no-mistakes"; : > "$D/skills/no-mistakes/SKILL.md"
reg "$D" "$(ent "$PROF/gone/home/$CE_REL/3.34.0"),{\"scope\":\"project\",\"projectPath\":\"$TMP/gone-project\",\"installPath\":\"$PROF/gone/home/$CE_REL/3.30.0\"}"
# noskill: install exists but lacks ce-work; skills/lavish is a broken symlink (replaced).
N="$PROF/noskill/home"; mk_plugin "$N/$CE_REL/3.34.0" ce-work; mk_user_skills "$N"; reg "$N" "$(ent "$N/$CE_REL/3.34.0")"
rm -rf "$N/skills/lavish"; ln -s "$TMP/nowhere/lavish" "$N/skills/lavish"
# own + thru: thru's plugins/ symlinks to own's; the entry was recorded through thru. `own` is not an
# account itself: the reinstall must still run under own, never thru.
O="$PROF/own/home"; mk_plugin "$O/$CE_REL/3.34.0"; mk_user_skills "$O"
T="$PROF/thru/home"; mkdir -p "$T"; ln -s "$O/plugins" "$T/plugins"; enable_in "$T"
reg "$O" "$(ent "$T/$CE_REL/3.34.0")"
# noenable: complete, but its own settings.json doesn't enable the plugin.
E="$PROF/noenable/home"; mk_plugin "$E/$CE_REL/3.34.0"; mk_user_skills "$E"
printf '{"enabledPlugins":{"%s":false},"theme":"dark"}' "$CE_ID" > "$E/settings.json"; reg "$E" "$(ent "$E/$CE_REL/3.34.0")"

# --- fake backend ----------------------------------------------------------------------------
export FAKE_PROF="$PROF"
BACKEND_STUB="$TMP/backend.sh"
cat > "$BACKEND_STUB" <<'FAKE'
#!/usr/bin/env bash
case "${1:-}" in
  status) [ "${FAKE_DOWN:-0}" = 1 ] && exit 1; echo reachable ;;
  account-list)
    { echo "$FAKE_ACCTS" | tr ',' '\n' | while read -r a; do [ -n "$a" ] && printf 'claude\t%s\tx@e.com\n' "$a"; done
      printf 'muse\tdefault\tdefault\n'; } ;;
  claude-config-dir)
    case "${2:-}" in
      system) ;;
      gone) exit 1 ;;
      *) echo "$FAKE_PROF/$2/home" ;;
    esac ;;
  *) exit 2 ;;
esac
FAKE
chmod +x "$BACKEND_STUB"

# --- stub claude: logs `<CLAUDE_CONFIG_DIR or -unset->|<argv>` and writes the registry like the CLI ---
STUB="$TMP/stub"; mkdir -p "$STUB"
for t in bash sh dirname mkdir ln grep sed basename readlink rm head tail cat awk jq tr find sort env mv bun; do
  ln -s "$(command -v "$t")" "$STUB/$t"
done
for t in curl npx; do printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB/$t"; chmod +x "$STUB/$t"; done
export CLAUDE_LOG="$TMP/claude.log" FAKE_CE_SKILLS="$DS_ROLE_CE_SKILLS"
cat > "$STUB/claude" <<'FAKE'
#!/usr/bin/env bash
set -eu
cfg="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
echo "${CLAUDE_CONFIG_DIR--unset-}|$*" >> "$CLAUDE_LOG"
reg="$cfg/plugins/installed_plugins.json"; set_="$cfg/settings.json"
upd() { local f="$1"; shift; mkdir -p "$(dirname "$f")"; [ -s "$f" ] || echo '{}' > "$f"; jq "$@" "$f" > "$f.tmp"; mv "$f.tmp" "$f"; }
case "$1 $2" in
  "plugin marketplace") ;;
  "plugin install")
    # like the real CLI: an existing user entry means "already installed", nothing re-recorded
    if jq -e --arg id "$3" '.plugins[$id] // [] | any(.scope == "user")' "$reg" >/dev/null 2>&1; then exit 0; fi
    ip="$cfg/plugins/cache/compound-engineering-plugin/compound-engineering/3.35.0"   # through $cfg, unresolved
    for s in $FAKE_CE_SKILLS; do mkdir -p "$ip/skills/$s"; : > "$ip/skills/$s/SKILL.md"; done
    upd "$reg" --arg id "$3" --arg ip "$ip" '.version = 2 | .plugins[$id] = ((.plugins[$id] // []) | map(select(.scope != "user")) + [{scope: "user", installPath: $ip}])'
    upd "$set_" --arg id "$3" '.enabledPlugins[$id] = true' ;;
  "plugin uninstall")
    [ "${FAKE_UNINSTALL_FAIL:-0}" = 0 ] || exit 1
    upd "$reg" --arg id "$3" '.plugins[$id] = ((.plugins[$id] // []) | map(select(.scope != "user")))' ;;
  "plugin enable") [ "${FAKE_ENABLE_FAIL:-0}" = 0 ] || exit 1; upd "$set_" --arg id "$3" '.enabledPlugins[$id] = true' ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$STUB/claude"

snapshot(){ find "$HOME" "$PROF" -printf '%p %y %l %s %T@\n' 2>/dev/null | sort; }
run() { # <args…>; sets rc, out
  rc=0; out="$(PATH="$STUB" BACKEND="$BACKEND_STUB" "$ROOT/bin/host/install-skills.sh" "$@" 2>&1)" || rc=$?
}
calls() { grep -E "\|plugin $1( |$)" "$CLAUDE_LOG" 2>/dev/null || true; }

export FAKE_ACCTS="system,linked,complete,bare,dangling,noskill,thru,noenable,gone"

# --- 0. before: --check fails (the fixture is broken) -----------------------------------------
run --check
if [ "$rc" -eq 1 ]; then good; else bad "before install: --check exits $rc, want 1: $out"; fi

# --- 1. one installer run ----------------------------------------------------------------------
rm -f "$CLAUDE_LOG"
run
if [ "$rc" -eq 0 ]; then good; else bad "install exits $rc, want 0: $out"; fi
inst="$(calls install)"; unin="$(calls uninstall)"
# installs run under each OWNER's env, once per owner
has "bare: install-only under its own dir" "$inst" "$BARE|plugin install $CE_ID --scope user"
hasnt "bare: nothing to uninstall" "$unin" "$BARE|"
has "dangling: reinstalled under its own dir" "$unin" "$D|plugin uninstall $CE_ID --scope user"
has "dangling: ... then installed" "$inst" "$D|plugin install"
has "noskill: reinstalled" "$unin" "$N|plugin uninstall"
has "thru: reinstalled under the OWNER (own)" "$unin" "$O|plugin uninstall"
has "thru: ... installed under own" "$inst" "$O|plugin install"
has "dd3c trap: ~/.claude reinstalled with CLAUDE_CONFIG_DIR unset" "$unin" "-unset-|plugin uninstall"
has "dd3c trap: ... and installed with it unset" "$inst" "-unset-|plugin install"
hasnt "a symlinked profile (thru) is never installed through" "$(cat "$CLAUDE_LOG")" "$T|plugin install"
hasnt "a symlinked profile (thru) is never uninstalled through" "$(cat "$CLAUDE_LOG")" "$T|plugin uninstall"
hasnt "a symlinked profile (linked) is never installed through" "$(cat "$CLAUDE_LOG")" "$LK|plugin"
hasnt "complete: no install call" "$(cat "$CLAUDE_LOG")" "$C|"
hasnt "noenable: no install call (only enable)" "$inst$unin" "$E|"
has "noenable: enabled under its own dir" "$(calls enable)" "$E|plugin enable $CE_ID --scope user"
n_inst="$(grep -c . <<<"$inst")"
if [ "$n_inst" -eq 5 ]; then good; else bad "want 5 installs (system, bare, dangling, noskill, own), got $n_inst: $inst"; fi
has "marketplace added under the owner before its install" "$(calls marketplace)" "$BARE|plugin marketplace add EveryInc/compound-engineering-plugin"
hasnt "never a project-scope call" "$(cat "$CLAUDE_LOG")" "--scope project"
# the project-scope entry survives
if jq -e --arg id "$CE_ID" '.plugins[$id] | any(.scope == "project" and .projectPath == "'"$TMP/gone-project"'")' "$D/plugins/installed_plugins.json" >/dev/null; then good
else bad "dangling: the project-scope entry must stay: $(cat "$D/plugins/installed_plugins.json")"; fi
if jq -e '.theme == "dark"' "$E/settings.json" >/dev/null; then good; else bad "enable must keep the rest of settings.json"; fi
# recorded paths go through the owner
for pair in "$SYS:$SYS" "$O:$O" "$D:$D"; do
  got="$(jq -r --arg id "$CE_ID" '.plugins[$id][] | select(.scope == "user") | .installPath' "${pair%%:*}/plugins/installed_plugins.json")"
  if [ "$got" = "${pair#*:}/$CE_REL/3.35.0" ]; then good; else bad "${pair%%:*}: installPath $got, want under ${pair#*:}"; fi
done
# user skills: linked where skills/ is elsewhere; real dirs and ~/.claude-shared skills/ untouched
for pair in "$BARE:no-mistakes" "$BARE:lavish" "$D:lavish" "$T:no-mistakes" "$T:lavish" "$N:lavish"; do
  l="${pair%%:*}/skills/${pair#*:}"
  if [ "$(readlink "$l" 2>/dev/null)" = "$SYS/skills/${pair#*:}" ]; then good; else bad "$l should link to $SYS/skills/${pair#*:} (is: $(readlink "$l" 2>/dev/null || echo none))"; fi
done
if [ -d "$D/skills/no-mistakes" ] && [ ! -L "$D/skills/no-mistakes" ]; then good; else bad "dangling: its own no-mistakes dir must stay a dir"; fi
if [ "$(readlink "$LK/skills")" = "$SYS/skills" ] && [ ! -e "$SYS/skills/skills" ]; then good; else bad "linked: shared skills/ must be left alone"; fi
# one line per account
has "line: system reinstalled" "$out" "claude[system]: installed"
has "line: linked shares ~/.claude" "$out" "claude[linked]: shares $SYS (installed)"
has "line: complete" "$out" "claude[complete]: already ok"
has "line: bare installed + linked" "$out" "claude[bare]: installed (linked no-mistakes lavish)"
has "line: dangling" "$out" "claude[dangling]: installed (linked lavish)"
has "line: noskill" "$out" "claude[noskill]: installed (linked lavish)"
has "line: thru shares own" "$out" "claude[thru]: shares $O (installed; linked no-mistakes lavish)"
has "line: noenable enabled" "$out" "claude[noenable]: installed (enabled)"
has "line: an account with no config dir is skipped" "$out" "⚠ claude[gone]: the backend has no Claude config dir"
# the verdict that follows is green
for a in system linked complete bare dangling noskill thru noenable; do has "verdict after: $a ok" "$out" "claude[$a]: skills ok"; done

# --- 2. --check is green after one run ---------------------------------------------------------
run --check
if [ "$rc" -eq 0 ]; then good; else bad "after install: --check exits $rc, want 0: $out"; fi
hasnt "after install: no broken/warn block" "$out" "⚠ claude[system]"
for a in linked complete bare dangling noskill thru noenable; do hasnt "after install: $a clean" "$out" "⚠ claude[$a]"; done

# --- 3. idempotent: a second run makes no claude plugin call and changes no file --------------
before="$(snapshot)"; rm -f "$CLAUDE_LOG"
run
if [ "$rc" -eq 0 ]; then good; else bad "re-run exits $rc, want 0: $out"; fi
if [ ! -s "$CLAUDE_LOG" ]; then good; else bad "re-run must make no claude plugin call: $(cat "$CLAUDE_LOG")"; fi
if [ "$before" = "$(snapshot)" ]; then good; else bad "re-run changed files: $(diff <(echo "$before") <(snapshot) | head -20)"; fi
for a in system complete bare dangling noskill noenable; do has "re-run: $a already ok" "$out" "claude[$a]: already ok"; done
has "re-run: thru shares, already ok" "$out" "claude[thru]: shares $O (already ok)"

# --- 4. a non-link entry is never replaced (warned instead) -----------------------------------
B2="$PROF/blocked/home"; mk_plugin "$B2/$CE_REL/3.35.0"; reg "$B2" "$(ent "$B2/$CE_REL/3.35.0")"
mkdir -p "$B2/skills/no-mistakes"; : > "$B2/skills/no-mistakes/README"
export FAKE_ACCTS="blocked"; rm -f "$CLAUDE_LOG"
run
has "blocked: warned, not replaced" "$out" "$B2/skills/no-mistakes exists, is not a link and has no SKILL.md — not replaced"
if [ -d "$B2/skills/no-mistakes" ] && [ ! -L "$B2/skills/no-mistakes" ] && [ -f "$B2/skills/no-mistakes/README" ]; then good; else bad "blocked: the non-link entry was replaced"; fi
has "blocked: lavish still linked" "$out" "claude[blocked]: installed (linked lavish)"
has "blocked: the verdict names the missing skill" "$out" "⚠ claude[blocked]: user skill(s) missing"

# --- 5. backend unreachable -> the current env only, labelled `claude` ------------------------
H2="$TMP/home2"; mkdir -p "$H2/.claude"; mk_user_skills "$H2/.claude"; rm -f "$CLAUDE_LOG"
rc=0; out="$(FAKE_DOWN=1 HOME="$H2" PATH="$STUB" BACKEND="$BACKEND_STUB" "$ROOT/bin/host/install-skills.sh" 2>&1)" || rc=$?
if [ "$rc" -eq 0 ]; then good; else bad "unreachable backend: install exits $rc, want 0: $out"; fi
has "unreachable: installed into the default home, CLAUDE_CONFIG_DIR unset" "$(calls install)" "-unset-|plugin install $CE_ID --scope user"
has "unreachable: one line, labelled claude" "$out" "claude: installed"
hasnt "unreachable: no per-account lines" "$out" "claude[system]"
if [ "$(grep -c '|plugin install' "$CLAUDE_LOG")" -eq 1 ]; then good; else bad "unreachable: want exactly one install: $(cat "$CLAUDE_LOG")"; fi

# --- 6. a failed claude plugin install: the run finishes, exits 1, names it ------------------
H3="$TMP/home3"; mkdir -p "$H3/.claude"
# shellcheck disable=SC2016 # a literal script body, not an expansion
printf '#!/usr/bin/env bash\necho "${CLAUDE_CONFIG_DIR--unset-}|$*" >> "$CLAUDE_LOG"\ncase "$2" in install) exit 1 ;; esac\nexit 0\n' > "$TMP/fail-claude"
FSTUB="$TMP/fstub"; cp -a "$STUB" "$FSTUB"; rm "$FSTUB/claude"; cp "$TMP/fail-claude" "$FSTUB/claude"; chmod +x "$FSTUB/claude"
rc=0; out="$(FAKE_DOWN=1 HOME="$H3" PATH="$FSTUB" BACKEND="$BACKEND_STUB" "$ROOT/bin/host/install-skills.sh" 2>&1)" || rc=$?
if [ "$rc" -eq 1 ]; then good; else bad "failed install: exits $rc, want 1: $out"; fi
has "failed install: named" "$out" "claude: install FAILED"
has "failed install: the rest still ran" "$out" "== done =="

# --- 7. a reinstall that exits 0 but leaves the fault (uninstall failed): not "installed", exit 1 ---
D2="$PROF/stuck/home"; mk_user_skills "$D2"; reg "$D2" "$(ent "$PROF/gone2/home/$CE_REL/3.34.0")"
export FAKE_ACCTS="stuck"; rm -f "$CLAUDE_LOG"
rc=0; out="$(FAKE_UNINSTALL_FAIL=1 PATH="$STUB" BACKEND="$BACKEND_STUB" "$ROOT/bin/host/install-skills.sh" 2>&1)" || rc=$?
if [ "$rc" -eq 1 ]; then good; else bad "stuck reinstall: exits $rc, want 1: $out"; fi
has "stuck reinstall: the line says it is still broken" "$out" "claude[stuck]: install FAILED (still broken after it"
hasnt "stuck reinstall: never reported installed" "$out" "claude[stuck]: installed"
has "stuck reinstall: the check names the dangling entry" "$out" "⚠ claude[stuck]: $CE_ID (user scope) is registered at a path that does not exist"

# --- 8. only an enable that fails, on a healthy owner: "FAILED", not "installed", exit 1 -----
E2="$PROF/noenable2/home"; mk_plugin "$E2/$CE_REL/3.34.0"; mk_user_skills "$E2"
printf '{"enabledPlugins":{}}' > "$E2/settings.json"; reg "$E2" "$(ent "$E2/$CE_REL/3.34.0")"
export FAKE_ACCTS="noenable2"; rm -f "$CLAUDE_LOG"
rc=0; out="$(FAKE_ENABLE_FAIL=1 PATH="$STUB" BACKEND="$BACKEND_STUB" "$ROOT/bin/host/install-skills.sh" 2>&1)" || rc=$?
if [ "$rc" -eq 1 ]; then good; else bad "failed enable: exits $rc, want 1: $out"; fi
has "failed enable: the line says FAILED" "$out" "claude[noenable2]: FAILED (enable FAILED)"
hasnt "failed enable: never reported installed" "$out" "claude[noenable2]: installed"

mkdir -p "$TMP/codex-state/project"
printf 'builder codex gpt-6.1-sol ondemand high\n' > "$TMP/codex-state/project/roles.conf"
bun "$ROOT/tests/lib/observe-config.ts" "$TMP/codex-state"   # the loop's config observer: the roster is rows (U257)
rc=0; out="$(DS_STATE_ROOT="$TMP/codex-state" PATH="$STUB" BACKEND="$BACKEND_STUB" "$ROOT/bin/host/install-skills.sh" --check 2>&1)" || rc=$?
if [ "$rc" -eq 1 ]; then good; else bad "project Codex primary without CLI must fail: $out"; fi
has "project override must be checked" "$out" "codex: CLI missing"

echo "install-skills-accounts: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
