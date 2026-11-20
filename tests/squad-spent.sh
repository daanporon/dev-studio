#!/usr/bin/env bash
# squad-spent.sh — each squad's spend since it started: weights, role buckets, since, frozen archive rows.
# U222: written against the shell version first; SQUAD_SPENT_SH points the suite at another build
# (a checkout's bin/lib/squad-spent.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
S="${SQUAD_SPENT_SH:-$ROOT/bin/lib/squad-spent.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export DS_STATE_ROOT="$TMP/state"
unset DS_PREFIX DS_TOKEN_DIR

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }
rc(){ set +e; "$@" >/dev/null 2>&1; local r=$?; set -e; echo "$r"; }

now="$(jq -rn 'now | todate')"
line(){ # id model in cw cr out ts [1h-part-of-cw]
  if [ -n "${8:-}" ]; then
    jq -cn --arg id "$1" --arg m "$2" --argjson i "$3" --argjson w "$4" --argjson r "$5" --argjson o "$6" --arg ts "$7" --argjson h "$8" \
      '{type:"assistant",timestamp:$ts,message:{id:$id,model:$m,usage:{input_tokens:$i,cache_creation_input_tokens:$w,cache_read_input_tokens:$r,output_tokens:$o,cache_creation:{ephemeral_1h_input_tokens:$h,ephemeral_5m_input_tokens:($w-$h)}}}}'
  else
    jq -cn --arg id "$1" --arg m "$2" --argjson i "$3" --argjson w "$4" --argjson r "$5" --argjson o "$6" --arg ts "$7" \
      '{type:"assistant",timestamp:$ts,message:{id:$id,model:$m,usage:{input_tokens:$i,cache_creation_input_tokens:$w,cache_read_input_tokens:$r,output_tokens:$o}}}'
  fi
}
boot(){ printf '%s\n' "{\"type\":\"user\",\"message\":{\"content\":\"You are the $1 of squad \\\"$2\\\".\"},\"timestamp\":\"2026-10-08T09:00:00Z\"}"; }

P="$TMP/projects"
mk(){ mkdir -p "$P/$1"; }  # <folder>
# topic "alpha": a lead (opus), a builder (sonnet, 1h-split cache write), a tester ("other"); topic "beta": a thinker
mk -h-ws-ds-proj-lead-alpha;     { boot lead alpha;   line a1 claude-opus-5-5 100 1000 10000 20 "$now"; } > "$P/-h-ws-ds-proj-lead-alpha/s.jsonl"
mk -h-ws-ds-proj-builder-u1-alpha; { boot builder alpha; line a2 claude-sonnet-5-5 10 400 1000 30 "$now" 100; } > "$P/-h-ws-ds-proj-builder-u1-alpha/s.jsonl"
mk -h-ws-ds-proj-tester-alpha;   { boot tester alpha; line a3 claude-sonnet-5-5 1 0 0 1 "$now"; } > "$P/-h-ws-ds-proj-tester-alpha/s.jsonl"
mk -h-ws-ds-proj-thinker-beta;   { boot thinker beta; line b1 claude-opus-5-5 5 0 2000 10 "$now"; } > "$P/-h-ws-ds-proj-thinker-beta/s.jsonl"
mk -h-ws-ds-other-lead-alpha;    { boot lead alpha;   line o1 claude-opus-5-5 99999 0 0 0 "$now"; } > "$P/-h-ws-ds-other-lead-alpha/s.jsonl"   # another label: not counted

L="$DS_STATE_ROOT/proj"; mkdir -p "$L/squads" "$L/archive"
# alpha started 100 s ago (member since); beta has no member since -> the file's age
since_a="$(date -u -d "@$(( $(date +%s) - 100 ))" +%Y-%m-%dT%H:%M:%SZ)"
printf '%s' "{\"members\":[{\"role\":\"lead\",\"since\":\"$since_a\"},{\"role\":\"builder\",\"since\":\"2099-01-01T00:00:00Z\"}]}" > "$L/squads/alpha.json"
printf '%s' '{"members":[]}' > "$L/squads/beta.json"

eq "usage without a label" "$(rc "$S")" "2"
eq "unknown argument" "$(rc "$S" proj --nope)" "2"
"$S" proj --dir "$P" > "$TMP/out"
eq "prints nothing" "$(wc -c < "$TMP/out" | tr -d ' ')" "0"
T="$L/loop/squad-spent.tsv"
eq "one row per squad, sorted by topic" "$(cut -f1 "$T" | tr '\n' ,)" "alpha,beta,"
# alpha lead: cw 1000*1.25 + cr 10000*.05 + out 20*5 + in 100 = 1950
# alpha builder: cw 100*2 + 300*1.25 = 575, cr*.1 = 100, out*5 = 150, in 10 = 835; tester: in 1 + out 5 = 6
eq "alpha total/lead/thinker/builders/other" "$(awk -F'\t' '$1=="alpha"{print $3,$4,$5,$6,$7}' "$T")" "2791 1950 0 835 6"
eq "beta total/thinker" "$(awk -F'\t' '$1=="beta"{print $3,$4,$5,$6,$7}' "$T")" "155 0 155 0 0"
eq "frozen column is 0 for live squads" "$(cut -f8 "$T" | tr '\n' ,)" "0,0,"
since_got="$(awk -F'\t' '$1=="alpha"{print $2}' "$T")"
eq "alpha since = its earliest member start" "$(( since_got - $(date -u -d "$since_a" +%s) ))" "0"
case "$(awk -F'\t' '$1=="beta"{print $2}' "$T")" in ''|*[!0-9]*) r=no ;; *) r=ok ;; esac; eq "beta since falls back to the file mtime (epoch)" "$r" "ok"

# A closed squad (archive) is computed once, then frozen: its row survives a changed log.
printf '%s' '{"topic":"gamma","members":[{"role":"lead","since":"2020-01-01T00:00:00Z"}]}' > "$L/archive/gamma-20260101-000000.json"
mk -h-ws-ds-proj-lead-gamma; { boot lead gamma; line g1 claude-opus-5-5 10 0 0 0 "$now"; } > "$P/-h-ws-ds-proj-lead-gamma/s.jsonl"
"$S" proj --dir "$P"
eq "closed squad row is frozen=1" "$(awk -F'\t' '$1=="gamma"{print $3,$8}' "$T")" "10 1"
line g2 claude-opus-5-5 5000 0 0 0 "$now" >> "$P/-h-ws-ds-proj-lead-gamma/s.jsonl"
"$S" proj --dir "$P"
eq "frozen row is kept as is" "$(awk -F'\t' '$1=="gamma"{print $3,$8}' "$T")" "10 1"
eq "live rows keep updating" "$(awk -F'\t' '$1=="alpha"{print $3}' "$T")" "2791"
# A topic both archived and live: the live one wins.
printf '%s' '{"topic":"beta","members":[]}' > "$L/archive/beta-20260101-000000.json"
"$S" proj --dir "$P"
eq "live beats archived for the same topic" "$(awk -F'\t' '$1=="beta"{print $8}' "$T")" "0"
# Nothing to scan: only frozen squads -> exits 0 and leaves the file alone.
rm -f "$L/squads/"*.json "$L/archive/beta-"*.json; cp "$T" "$TMP/before"
"$S" proj --dir "$P"
eq "only frozen squads: file untouched" "$(cmp -s "$T" "$TMP/before" && echo same || echo diff)" "same"
# DS_TOKEN_DIR is the default --dir
printf '%s' '{"members":[]}' > "$L/squads/delta.json"
DS_TOKEN_DIR="$P" "$S" proj
eq "DS_TOKEN_DIR default" "$(awk -F'\t' '$1=="delta"{print $8}' "$T")" "0"

echo "squad-spent: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
