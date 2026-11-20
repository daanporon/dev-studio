#!/usr/bin/env bash
# doc-paths.sh — a living doc may only name `bin/` and `docs/` paths that exist, and its relative markdown
# links must resolve. The scanner is tests/lib/doc-paths.ts; this file holds its lists and a self-test.
#
# Scanned: README.md, AGENTS.md, bin/README.md, studio/studio.md, every docs/**/*.md not excluded below,
# conventions/*.md, roles/*.md, .claude/commands/*.md and skills/**/*.md (a new doc is scanned by default).
# Rules: a token starting `bin/` or `docs/` (optionally after `~/.dev-studio/`, `../` or `./`) is checked
# from the repo root; one after another path segment (`/usr/bin/env`, `state/<label>/bin`) is skipped.
# Trailing `.,:;)?!` and a `:<line>` suffix are cut; a trailing `/` needs a folder. `{a,b}` is expanded and
# every result must exist. `*`, `?`, `**` must match something. For a placeholder segment (`<…>`, `…`,
# `$VAR`) the folder before it must exist. A relative `](target)` is resolved against the doc's folder
# (`#anchor` cut; `http:`, `https:`, `mailto:` and links inside code blocks skipped).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d -p "${XDG_RUNTIME_DIR:-/tmp}")"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0

# Not scanned, one `<file or folder/> — <reason>` per line. An entry that no longer exists fails.
# (conventions/*.conf are settings files, not prose; only .md files are scanned, so they need no entry.)
EXCLUDE='
docs/spikes/ — records of past work that name the paths of their day
docs/solutions/ — records of past work that name the paths of their day
docs/orca-notes.md — a dated note
docs/runbooks/ — the sweep-to-loop switch, which names the removed sweep
docs/img/ — not text
docs/screenshots/ — not text
'
# Paths a doc names on purpose although they are gone, one `<file>: <path> — <reason>` per line.
# An entry fails when its path exists again or <file> no longer names it.
REMOVED='
'

# Self-test: one good and one bad example of each rule; the scan must exit 1 and list exactly the bad ones.
fx="$TMP/fx"
mkdir -p "$fx/bin/role" "$fx/bin/commands" "$fx/docs/sub" "$fx/docs/plans"
touch "$fx/bin/role/good.sh" "$fx/bin/role/back.sh" "$fx/bin/commands/watch-ts.ts" "$fx/bin/commands/ask-operator-ts.ts" "$fx/docs/sub/.keep"
cat > "$fx/README.md" <<'EOF'
# Fixture
plain `bin/role/good.sh` and `bin/role/nope.sh`, and in prose bin/role/good.sh.
home `~/.dev-studio/bin/role/good.sh:12` and `~/.dev-studio/bin/role/missing.sh`
brace `bin/commands/{watch,ask-operator}-ts.ts` and `bin/commands/{watch,gone}-ts.ts`
glob `bin/*/*.sh` and `bin/*.sh`
placeholder `bin/role/<x>.sh` and `bin/nofolder/<x>.sh`
link [g](docs/guide.md#top) and [b](docs/gone.md)
folder `docs/sub/` and `docs/nosub/`
not repo paths: /usr/bin/env, ~/.local/bin/ds, state/<label>/bin/x, $ROOT/bin/nope.sh
removed: `bin/old.sh` and `bin/role/back.sh`
EOF
cat > "$fx/docs/guide.md" <<'EOF'
up [r](../README.md) and [x](docs/guide.md)
```
[in a code block](nowhere.md)
```
syntax `[text](nowhere.md)` in a code span, and a bare percent [p](100%.md)
EOF
printf 'an old record names `bin/role/excluded-miss.sh`\n' > "$fx/docs/plans/old.md"
out="$(DOC_PATHS_ROOT="$fx" DOC_PATHS_EXCLUDE="docs/plans/ — fixture
docs/gone/ — fixture" DOC_PATHS_REMOVED="README.md: bin/old.sh — fixture
README.md: bin/role/back.sh — fixture
README.md: bin/unnamed.sh — fixture" bun "$ROOT/tests/lib/doc-paths.ts")" && rc=0 || rc=$?
want='FAIL README.md:2: bin/role/nope.sh — no such file
FAIL README.md:3: bin/role/missing.sh — no such file
FAIL README.md:4: bin/commands/{watch,gone}-ts.ts — bin/commands/gone-ts.ts: no such file
FAIL README.md:5: bin/*.sh — no file matches
FAIL README.md:6: bin/nofolder/<x>.sh — folder bin/nofolder/ does not exist
FAIL README.md:7: ](docs/gone.md) — link target docs/gone.md does not exist
FAIL README.md:8: docs/nosub/ — no such folder
FAIL docs/guide.md:1: ](docs/guide.md) — link target docs/docs/guide.md does not exist
FAIL docs/guide.md:5: ](100%.md) — link target docs/100%.md does not exist
FAIL exclude list: docs/gone/ does not exist; drop the entry
FAIL removed list: bin/role/back.sh exists again (README.md)
FAIL removed list: README.md no longer names bin/unnamed.sh; drop the entry'
got="$(grep '^FAIL' <<< "$out" || true)"
if [ "$rc" -eq 1 ]; then pass=$((pass+1)); echo "ok   self-test: the scan exits 1 on the fixture"; else fail=$((fail+1)); echo "FAIL self-test: exit $rc, want 1"; fi
if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "ok   self-test: it lists each bad path and no good one"
else fail=$((fail+1)); echo "FAIL self-test: listed lines differ (- want, + got):"; diff <(echo "$want") <(echo "$got") | sed 's/^/     /' || true; fi
if grep -q '^doc-paths-scan: 10 ok, 12 bad (2 files)$' <<< "$out"; then pass=$((pass+1)); echo "ok   self-test: it counts the good ones and scans 2 files"
else fail=$((fail+1)); echo "FAIL self-test: summary line: $(tail -1 <<< "$out")"; fi

# The real scan.
out="$(DOC_PATHS_EXCLUDE="$EXCLUDE" DOC_PATHS_REMOVED="$REMOVED" bun "$ROOT/tests/lib/doc-paths.ts")" && rc=0 || rc=$?
grep '^FAIL' <<< "$out" || true
read -r ok bad < <(sed -nE 's/^doc-paths-scan: ([0-9]+) ok, ([0-9]+) bad.*/\1 \2/p' <<< "$out")
pass=$((pass + ${ok:-0})); fail=$((fail + ${bad:-0}))
if [ "$rc" -ne 0 ] && [ "${bad:-0}" -eq 0 ]; then fail=$((fail+1)); echo "FAIL scan exited $rc: $out"; fi
echo "doc-paths: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
