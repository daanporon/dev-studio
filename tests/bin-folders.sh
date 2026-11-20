#!/usr/bin/env bash
# bin-folders.sh — U185/U186: bin/ has a folder per purpose behind ds and no old top-level shims.
# Asserts: no name collision across folders, ds help lists every script, bin/README.md is the
# generated help, the top level holds nothing else, and paths-check finds old paths.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok() { if eval "$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1" >&2; fi; }

# No two files with one name in different folders (commands/*.ts count too).
dups="$( { find "$ROOT/bin" -mindepth 2 -maxdepth 2 -name '*.sh' -printf '%f\n'; find "$ROOT/bin/commands" -maxdepth 1 -name '*.ts' -printf '%f\n'; } | sed 's/\.[^.]*$//' | sort | uniq -d )"
ok "no name collision across bin folders" "[ -z '$dups' ]"

# A fixture with commands/x.sh and role/x.sh: ds refuses the colliding name (exit 2).
cx="$TMP/collide"; mkdir -p "$cx/bin/commands" "$cx/bin/role"
cp "$ROOT/bin/ds" "$ROOT/bin/ds.ts" "$cx/bin/"
for d in commands role; do printf '#!/usr/bin/env bash\n# x — fixture\necho ran\n' > "$cx/bin/$d/x.sh"; chmod +x "$cx/bin/$d/x.sh"; done
cout="$("$cx/bin/ds" x 2>&1)" && crc=0 || crc=$?
ok "ds refuses a name in two folders" "[ $crc -eq 2 ] && grep -q 'more than one folder' <<< '$cout'"

# ds help lists every script in bin/ (folder scripts + commands/*.ts).
"$ROOT/bin/ds" help >"$TMP/help.txt" 2>&1 || true
missing=""
while IFS= read -r f; do
  n="$(basename "$f")"; n="${n%.*}"
  grep -q "^  $n —" "$TMP/help.txt" || missing="$missing $n"
done < <(find "$ROOT/bin" -mindepth 2 -maxdepth 2 \( -name '*.sh' -o -path '*/commands/*.ts' -o -path '*/board/*.ts' \) | sort)
ok "ds help lists every script" "[ -z '$missing' ]"

# README is ds help --markdown, byte for byte.
"$ROOT/bin/ds" help --markdown > "$TMP/README.md"
ok "bin/README.md is generated and up to date" "cmp -s '$TMP/README.md' '$ROOT/bin/README.md'"

# ds runs a shell command from a folder, passing args and exit code through.
if "$ROOT/bin/ds" ship-mode dev-studio 2>&1 | grep -q 'ship mode'; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: ds ship-mode runs commands/ship-mode.sh" >&2; fi

# U186: the shims are gone — the top of bin/ is ds, ds.ts, README.md and the folders.
top="$(ls "$ROOT/bin" | LC_ALL=C sort | tr '\n' ' ')"
ok "bin/ top level is ds, ds.ts, README.md and the folders" "[ '$top' = 'README.md backend board commands ds ds.ts hooks host lib loop review role ' ]"

# The README has no < or > outside a code span (a bare <s> strikes the rest through on GitHub).
bare="$(python3 -c 'import re,sys; t=open(sys.argv[1]).read(); t=re.sub(r"(`+).*?\1","",t); print(len(re.findall(r"[<>]",t)))' "$ROOT/bin/README.md")"
ok "bin/README.md has no < or > outside a code span" "[ '$bare' = 0 ]"
ok "bin/README.md does not mention shims" "! grep -qi 'shim' '$ROOT/bin/README.md'"

# ds paths-check: a fixture with one old hook path, one old skill path and one old loose loop path lists all three; a clean one none.
pc="$TMP/pc"; mkdir -p "$pc/ws/proj/wt1/.claude" "$pc/home/.claude/skills/x" "$pc/home/.config/systemd/user"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"%s/.dev-studio/bin/rewake-hook.sh mt"}]}]}}' "$pc/home" > "$pc/ws/proj/wt1/.claude/settings.local.json"
printf 'run ~/.dev-studio/bin/orch.sh send\n' > "$pc/home/.claude/skills/x/SKILL.md"
printf '[Service]\nExecStart=bun %s/.dev-studio/bin/loop/watchdog.ts\n' "$pc/home" > "$pc/home/.config/systemd/user/ds-watchdog.service"
out="$(DS_STATE_ROOT="$TMP/nostate" "$ROOT/bin/ds" paths-check --workspaces "$pc/ws" --home "$pc/home" 2>/dev/null)" && rc=0 || rc=$?
ok "paths-check exits 1 on old paths" "[ $rc -eq 1 ]"
ok "paths-check lists the old hook path" "grep -q 'settings.local.json: .*/bin/rewake-hook.sh' <<< '$out'"
ok "paths-check lists the old skill path" "grep -q 'SKILL.md: .*/bin/orch.sh' <<< '$out'"
ok "paths-check lists the old loose loop path" "grep -q 'ds-watchdog.service: .*/bin/loop/watchdog.ts' <<< '$out'"
cl="$TMP/pc-clean"; mkdir -p "$cl/ws/proj/wt1/.claude" "$cl/home"
printf '{"command":"%s/.dev-studio/bin/hooks/rewake-hook.sh mt","other":"/x/bin/install.sh","loop":"%s/.dev-studio/bin/loop/main.ts","core":"%s/.dev-studio/bin/loop/core/watchdog.ts"}' "$cl/home" "$cl/home" "$cl/home" > "$cl/ws/proj/wt1/.claude/settings.local.json"
out="$(DS_STATE_ROOT="$TMP/nostate" "$ROOT/bin/ds" paths-check --workspaces "$cl/ws" --home "$cl/home" 2>&1)" && rc=0 || rc=$?
ok "paths-check lists nothing on a clean fixture" "[ $rc -eq 0 ] && [ -z '$out' ]"

echo "bin-folders: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
