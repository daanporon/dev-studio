#!/usr/bin/env bash
# update-squads.sh — `update-squads --auto` on a temp dev-studio repo with a stub `ds` that logs its wishes and a stub
# reassert-roles: squads already on HEAD get nothing; code only gets no wish; instructions get reload wishes; skills get
# restart wishes (the strongest class wins); a missing or unknown marker is today's full restart; the marker is written;
# without --auto it is the old behaviour (restart wishes) and also writes the marker.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TMP="$(cd "$(mktemp -d -p "${XDG_RUNTIME_DIR:-/tmp}")" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e.com GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
pass=0; fail=0
good(){ pass=$((pass + 1)); }
bad(){ fail=$((fail + 1)); echo "  FAIL: $1" >&2; }
check(){ if [ "$2" = "$3" ]; then good; else bad "$1: want [$2], got [$3]"; fi; }
has(){ if grep -qF -- "$2" <<<"$3"; then good; else bad "$1: no [$2] in [$3]"; fi; }

FX="$TMP/ds"; mkdir -p "$FX"
cp -r "$ROOT/bin" "$FX/bin"
export CALLS="$TMP/calls"
printf '#!/usr/bin/env bash\necho "ds $*" >> "$CALLS"\n' > "$FX/bin/ds"
printf '#!/usr/bin/env bash\necho "reassert $*" >> "$CALLS"\n' > "$FX/bin/hooks/reassert-roles.sh"
chmod +x "$FX/bin/ds" "$FX/bin/hooks/reassert-roles.sh"
git -C "$FX" init -q -b main; git -C "$FX" add -A; git -C "$FX" commit -qm base
BASE="$(git -C "$FX" rev-parse HEAD)"
commit(){ mkdir -p "$(dirname "$FX/$1")"; echo "$RANDOM" >> "$FX/$1"; git -C "$FX" add -A; git -C "$FX" commit -qm "change $1"; }

export DS_STATE_ROOT="$TMP/state"
mkdir -p "$DS_STATE_ROOT/proj/squads"
echo '{"run_id":"r","members":[{"role":"lead"},{"role":"builder","suffix":"x"}]}' > "$DS_STATE_ROOT/proj/squads/a.json"
MARK="$DS_STATE_ROOT/proj/squads-rev.json"
upd(){ : > "$CALLS"; RC=0; OUT="$(DS_ROOT="$FX" bun "$FX/bin/ds.ts" update-squads-ts "$@" 2>&1)" || RC=$?; }
wishes(){ grep -c '^ds want member' "$CALLS" || true; }
rev(){ bun -e "console.log(JSON.parse(require('fs').readFileSync('$MARK','utf8')).$1)"; }

echo "1. on HEAD already: nothing, no brief rewrite, marker untouched"
echo "{\"rev\":\"$BASE\"}" > "$MARK"
upd proj --auto
check rc 0 "$RC"; has line "update-squads: [proj] squads already on ${BASE:0:8}" "$OUT"; check "no calls" "" "$(cat "$CALLS")"

echo "2. code only: briefs rewritten, no wish"
commit bin/something.ts
upd proj --auto
check rc 0 "$RC"; check wishes 0 "$(wishes)"; has summary "update-squads: [proj] none — code — 0 wish(es)" "$OUT"
check "marker moved" "$(git -C "$FX" rev-parse HEAD)" "$(rev rev)"; check "marker need" none "$(rev need)"
has "briefs rewritten" "reassert proj" "$(cat "$CALLS")"

echo "3. instructions: a reload wish per member"
commit roles/builder.md; commit bin/other.ts
echo "{\"rev\":\"$(git -C "$FX" rev-parse HEAD~2)\"}" > "$MARK"
upd proj --auto
check wishes 2 "$(wishes)"; has summary "reload — code, instructions — 2 wish(es)" "$OUT"
has "reload flag" "ds want member proj/a/lead --reload" "$(cat "$CALLS")"
has "suffix member" "proj/a/builder/x --reload" "$(cat "$CALLS")"
if grep -q -- '--restart' "$CALLS"; then bad "restart wish on reload"; else good; fi

echo "4. skills win: restart-once-idle wishes"
commit skills/x/SKILL.md
echo "{\"rev\":\"$(git -C "$FX" rev-parse HEAD~3)\"}" > "$MARK"
upd proj --auto
check wishes 2 "$(wishes)"; has summary "restart — code, instructions, skills — 2 wish(es)" "$OUT"
has "restart flag" "ds want member proj/a/lead --restart idle" "$(cat "$CALLS")"
check "marker need" restart "$(rev need)"; check "marker wishes" 2 "$(rev wishes)"
commit .claude/commands/ds-x.md
echo "{\"rev\":\"$(git -C "$FX" rev-parse HEAD~1)\"}" > "$MARK"
upd proj --auto
has "a command file is a skill change" "restart — skills — 2 wish(es)" "$OUT"

echo "5. a change to the brief's source raises code-only to reload"
commit bin/lib/lib.ts
echo "{\"rev\":\"$(git -C "$FX" rev-parse HEAD~1)\"}" > "$MARK"
upd proj --auto
has "reload" "reload — code — 2 wish(es)" "$OUT"

echo "6. missing marker or unknown base: today's full restart"
rm "$MARK"
upd proj --auto
check wishes 2 "$(wishes)"; has summary "restart —" "$OUT"; check "marker written" "$(git -C "$FX" rev-parse HEAD)" "$(rev rev)"
echo '{"rev":"0000000000000000000000000000000000000000"}' > "$MARK"
upd proj --auto
check "unknown base wishes" 2 "$(wishes)"

echo "7. without --auto: the old behaviour, and the marker is written"
rm "$MARK"
upd proj
check rc 0 "$RC"; check wishes 2 "$(wishes)"; has line "wrote 2 restart wish(es)" "$OUT"; has "reload-skills hint" "/reload-skills" "$OUT"
check "marker" "$(git -C "$FX" rev-parse HEAD)" "$(rev rev)"

echo "7b. a failed wish: rc 1, marker unchanged, the rerun retries"
OLD="$(git -C "$FX" rev-parse HEAD~1)"; echo "{\"rev\":\"$OLD\"}" > "$MARK"
printf '#!/usr/bin/env bash\necho "ds $*" >> "$CALLS"\ncase "$*" in *builder/x*) exit 1 ;; esac\n' > "$FX/bin/ds"
upd proj --auto
check rc 1 "$RC"; has "says so" "squads-rev.json not advanced" "$OUT"; check "marker kept" "$OLD" "$(rev rev)"
printf '#!/usr/bin/env bash\necho "ds $*" >> "$CALLS"\n' > "$FX/bin/ds"
upd proj --auto
check "rerun rc" 0 "$RC"; check "marker advanced" "$(git -C "$FX" rev-parse HEAD)" "$(rev rev)"

echo "7c. a file moved out of skills/ still counts as a skills change"
git -C "$FX" mv skills/x/SKILL.md docs-moved.md; git -C "$FX" commit -qm move
echo "{\"rev\":\"$(git -C "$FX" rev-parse HEAD~1)\"}" > "$MARK"
upd proj --auto
has "restart" "restart — code, skills" "$OUT"

echo "7d. a recorded Studio gets a reload wish on reload and on restart (never a restart), none on code only"
DS_STATE_ROOT="$DS_STATE_ROOT" bun -e "
  const { open } = await import('$ROOT/bin/loop/core/store.ts');
  const s = open(process.env.DS_STATE_ROOT);
  s.upsert('members', { project: 'proj', squad: '_studio', wt: 'id::/w/studio' }, { role: 'studio', suffix: '', status: 'running', handle: 'term_s', observed_at: 1, updated_at: 1 });
  s.close();"
commit roles/lead.md
echo "{\"rev\":\"$(git -C "$FX" rev-parse HEAD~1)\"}" > "$MARK"
upd proj --auto
check wishes 3 "$(wishes)"; has summary "reload — instructions — 3 wish(es) (one a reload of the Studio)" "$OUT"
has "studio reload" "ds want member proj/_studio/studio --reload --by update-squads" "$(cat "$CALLS")"
commit skills/y/SKILL.md
echo "{\"rev\":\"$(git -C "$FX" rev-parse HEAD~1)\"}" > "$MARK"
upd proj --auto
check wishes 3 "$(wishes)"; has summary "restart — skills — 3 wish(es) (one a reload of the Studio)" "$OUT"
has "studio reload on restart" "ds want member proj/_studio/studio --reload" "$(cat "$CALLS")"
if grep -q -- '_studio/studio --restart' "$CALLS"; then bad "restart wish on the Studio"; else good; fi
check "marker counts the Studio" 3 "$(rev wishes)"
commit bin/third.ts
echo "{\"rev\":\"$(git -C "$FX" rev-parse HEAD~1)\"}" > "$MARK"
upd proj --auto
check "code only: no wish" 0 "$(wishes)"
rm "$MARK"
upd proj
has "plain form" "wrote 2 restart wish(es) and a reload wish on the Studio" "$OUT"
DS_STATE_ROOT="$DS_STATE_ROOT" bun -e "
  const { open } = await import('$ROOT/bin/loop/core/store.ts');
  const s = open(process.env.DS_STATE_ROOT); s.db.run(\"UPDATE members SET status = 'gone' WHERE squad = '_studio'\"); s.close();"
rm "$MARK"
upd proj --auto
check "a gone Studio gets no wish" 2 "$(wishes)"

echo "8. usage and unknown project"
upd; check rc 2 "$RC"
upd nope --auto; check rc 1 "$RC"

echo "update-squads: $pass passed, $fail failed"
[ "$fail" = 0 ]
