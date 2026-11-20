#!/usr/bin/env bash
# token-usage.sh — sums Claude token usage per dev-studio role (+ model) from the session logs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export DS_STATE_ROOT="$TMP/state"

pass=0; fail=0
eq(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: $1 — want [$3] got [$2]" >&2; fi; }

now="$(jq -rn 'now | todate')"; old="$(jq -rn 'now - 30*86400 | todate')"
line(){ # id model in cw cr out ts
  jq -cn --arg id "$1" --arg m "$2" --argjson i "$3" --argjson w "$4" --argjson r "$5" --argjson o "$6" --arg ts "$7" \
    '{type:"assistant",timestamp:$ts,message:{id:$id,model:$m,usage:{input_tokens:$i,cache_creation_input_tokens:$w,cache_read_input_tokens:$r,output_tokens:$o}}}'
}
P="$TMP/projects"
lead="$P/-home-me-orca-workspaces-acme-ds-acme-lead-auth"; mkdir -p "$lead"
{ line m1 claude-sonnet-5-5 10 100 1000 5 "$now"
  line m1 claude-sonnet-5-5 10 100 1000 5 "$now"      # same message logged twice -> counted once
  line m2 claude-sonnet-5-5 1 0 2000 7 "$now"
  line m0 claude-sonnet-5-5 99 99 99 99 "$old"        # older than --days -> ignored
  echo '{"type":"user","message":{"content":"hi"}}'
} > "$lead/s1.jsonl"
bld="$P/-home-me-orca-workspaces-acme-ds-acme-builder-u3-auth"; mkdir -p "$bld"
line b1 claude-opus-5-5 3 300 0 9 "$now" > "$bld/s2.jsonl"
mkdir -p "$P/-home-me-src-other"; line x1 claude-opus-5-5 1 1 1 1 "$now" > "$P/-home-me-src-other/s.jsonl"

out="$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$P")"
row(){ printf '%s\n' "$out" | awk -v r="$1" '$1==r'; }
eq "lead row: role model turns in cache_write cache_read out" \
   "$(row lead | awk '{print $2,$3,$4,$5,$6,$7}')" "claude-sonnet-5-5 2 11 100 3000 12"
eq "builder row" "$(row builder | awk '{print $2,$3,$4,$5,$6,$7}')" "claude-opus-5-5 1 3 300 0 9"
eq "non dev-studio sessions are left out" "$(printf '%s\n' "$out" | grep -c other || true)" "0"

# --by-worker: one row per session folder, with the squad topic. The folder gives the role
# (cheap); the boot prompt gives the topic the folder can't (no boot prompt -> "?").
Q="$TMP/projects-bw"
W="$Q/-home-user-orca-workspaces-acme-ds-acme-builder-aa-multisig-closeout"; mkdir -p "$W"
{ line w1 claude-opus-5-5 3 300 0 9 "$now"
  line w1 claude-opus-5-5 3 300 0 9 "$now"   # dup id -> counted once
  printf '%s\n' '{"type":"user","message":{"content":"You are the builder (scope: aa) of squad \"multisig-closeout\". Re-read roles/builder.md."},"timestamp":"2026-10-08T09:00:00Z"}'
} > "$W/s.jsonl"
N="$Q/-home-user-orca-workspaces-acme-ds-acme-lead-auth"; mkdir -p "$N"
line n1 claude-sonnet-5-5 1 2 3000 4 "$now" > "$N/s.jsonl"
# Newest-first boot scan: the old log's stale boot prompt loses to the new log's.
M="$Q/-home-x-orca-ws-ds-test-builder-sc-newtopic"; mkdir -p "$M"
printf '%s\n' '{"type":"user","message":{"content":"You are the builder (scope: sc) of squad \"oldtopic\"."},"timestamp":"2026-09-01T00:00:00Z"}' > "$M/old.jsonl"
{ printf '%s\n' '{"type":"user","message":{"content":"You are the builder (scope: sc) of squad \"newtopic\"."},"timestamp":"2026-09-01T00:00:00Z"}'
  line m9 claude-opus-5-5 1 2 3 4 "$now"
} > "$M/new.jsonl"
touch -t 202001010000 "$M/old.jsonl"

bout="$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$Q" --by-worker)"
brow(){ printf '%s\n' "$bout" | awk -v w="$1" '$1==w'; }
eq "by-worker header" "$(printf '%s\n' "$bout" | head -n1)" "worker	topic	role	model	turns	input	cache_write	cache_read	output	ctx	cw_1h	cw_5m"
eq "by-worker builder row" "$(brow "-home-user-orca-workspaces-acme-ds-acme-builder-aa-multisig-closeout" | awk '{print $2,$3,$4,$5,$6,$7,$8,$9}')" "multisig-closeout builder claude-opus-5-5 1 3 300 0 9"
eq "by-worker lead without boot prompt" "$(brow "-home-user-orca-workspaces-acme-ds-acme-lead-auth" | awk '{print $2,$3,$4,$5,$6,$7,$8,$9}')" "auth lead claude-sonnet-5-5 1 1 2 3000 4"
eq "newest boot prompt wins" "$(brow "-home-x-orca-ws-ds-test-builder-sc-newtopic" | awk '{print $2}')" "newtopic"
eq "no --top prints all workers" "$(printf '%s\n' "$bout" | grep -c .)" "4"
eq "aggregate output unchanged" "$(printf '%s\n' "$out" | head -n1)" "role	model	turns	input	cache_write	cache_read	output"

# --top N caps data rows; the header always prints. --top 0 (or omitted) = all.
tout="$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$Q" --by-worker --top 1)"
eq "top 1 prints header + 1 row" "$(printf '%s\n' "$tout" | grep -c .)" "2"
eq "top keeps the header" "$(printf '%s\n' "$tout" | head -n1)" "worker	topic	role	model	turns	input	cache_write	cache_read	output	ctx	cw_1h	cw_5m"
eq "top 0 means all" "$(printf '%s\n' "$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$Q" --by-worker --top 0)" | grep -c .)" "4"
"$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$Q" --top x >/dev/null 2>&1 && r=0 || r=$?
eq "bad --top exits 2" "$r" "2"

# ctx (last column): the newest real turn's input + cache_read + cache_write, across models; the
# same on each of the worker's rows; a newer <synthetic> record doesn't count.
C="$TMP/projects-ctx"; CW="$C/-home-x-ws-ds-lbl-builder-u1-t"; mkdir -p "$CW"
t1="$(jq -rn 'now - 3600 | todate')"; t2="$(jq -rn 'now - 60 | todate')"
{ line c1 claude-opus-5-5 5 50000 9000 1 "$t1"
  line c2 claude-sonnet-5-5 2 1000 60000 1 "$t2"
  line c3 '<synthetic>' 0 0 0 0 "$now"
} > "$CW/s.jsonl"
cout="$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$C" --by-worker)"
eq "ctx: newest real turn, on every row of the worker" "$(printf '%s\n' "$cout" | awk -F'\t' 'NR>1{print $4, $10}' | LC_ALL=C sort | tr '\n' ' ')" "<synthetic> 61002 claude-opus-5-5 61002 claude-sonnet-5-5 61002 "
eq "ctx: not in the per-role table" "$(printf '%s\n' "$out" | awk -F'\t' 'NR>1{print NF}' | sort -u)" "7"

# A project whose name contains a role word (dev-studio): role/topic come after the `<project>-` prefix.
D="$TMP/projects-ds"
for f in lead-acct thinker-acct builder-A1-acct; do mkdir -p "$D/-home-x-orca-workspaces-dev-studio-ds-dev-studio-$f"; line "d-$f" claude-opus-5-5 1 1 1 1 "$now" > "$D/-home-x-orca-workspaces-dev-studio-ds-dev-studio-$f/s.jsonl"; done
dout="$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$D" --by-worker)"
eq "dev-studio project: roles" "$(printf '%s\n' "$dout" | awk -F'\t' 'NR>1{print $3}' | LC_ALL=C sort | tr '\n' ' ')" "builder lead thinker "
eq "dev-studio project: topic from the folder when no boot prompt" "$(printf '%s\n' "$dout" | awk -F'\t' '$3=="lead"{print $2}')" "acct"

"$ROOT/bin/lib/token-usage.sh" --days x --dir "$P" >/dev/null 2>&1 && r=0 || r=$?
eq "bad --days exits 2" "$r" "2"

# --since EPOCH: counts from that moment instead of the last N days.
SP="$TMP/projects-since"; SW="$SP/-home-x-ws-ds-lbl-builder-u1-t"; mkdir -p "$SW"
mid="$(jq -rn 'now - 10*86400 | todate')"; early="$(jq -rn 'now - 20*86400 | todate')"
{ line s1 claude-opus-5-5 1 100 0 1 "$early"; line s2 claude-opus-5-5 1 200 0 1 "$mid"; line s3 claude-opus-5-5 1 400 0 1 "$now"; } > "$SW/s.jsonl"
since15="$(jq -rn 'now - 15*86400 | floor')"
eq "--since: only turns after the epoch (10d + now)" "$("$ROOT/bin/lib/token-usage.sh" --since "$since15" --dir "$SP" --by-worker | awk -F'\t' 'NR>1{print $5, $7}')" "2 600"
eq "--since: reaches past the 7-day default" "$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$SP" --by-worker | awk -F'\t' 'NR>1{print $5, $7}')" "1 400"
"$ROOT/bin/lib/token-usage.sh" --since abc --dir "$SP" >/dev/null 2>&1 && r=0 || r=$?
eq "bad --since exits 2" "$r" "2"

# squad-spent.sh: per-squad spend since start into state/<label>/loop/squad-spent.tsv; a closed squad is frozen.
SS="$TMP/ss-state"; mkdir -p "$SS/lbl/squads" "$SS/lbl/archive"
SL="$TMP/ss-logs"; mkdir -p "$SL/-h-w-ds-lbl-lead-live-sq" "$SL/-h-w-ds-lbl-builder-u1-live-sq" "$SL/-h-w-ds-lbl-lead-gone-sq"
since0="$(jq -rn 'now - 12*86400 | floor')"; sinceiso="$(jq -rn 'now - 12*86400 | todate')"
printf '{"members":[{"role":"lead","wt":"a","since":"%s"}]}' "$sinceiso" > "$SS/lbl/squads/live-sq.json"
printf '{"topic":"gone-sq","members":[{"role":"lead","wt":"b","since":"%s"}]}' "$sinceiso" > "$SS/lbl/archive/gone-sq-1.json"
printf '%s\n' '{"type":"user","message":{"content":"You are the lead of squad \"live-sq\"."},"timestamp":"2026-10-01T00:00:00Z"}' > "$SL/-h-w-ds-lbl-lead-live-sq/s.jsonl"
line l1 claude-opus-5-5 0 1000 0 0 "$mid" >> "$SL/-h-w-ds-lbl-lead-live-sq/s.jsonl"
printf '%s\n' '{"type":"user","message":{"content":"You are the builder (scope: u1) of squad \"live-sq\"."},"timestamp":"2026-10-01T00:00:00Z"}' > "$SL/-h-w-ds-lbl-builder-u1-live-sq/s.jsonl"
line b1 claude-opus-5-5 0 0 10000 100 "$now" >> "$SL/-h-w-ds-lbl-builder-u1-live-sq/s.jsonl"
printf '%s\n' '{"type":"user","message":{"content":"You are the lead of squad \"gone-sq\"."},"timestamp":"2026-10-01T00:00:00Z"}' > "$SL/-h-w-ds-lbl-lead-gone-sq/s.jsonl"
line g1 claude-opus-5-5 0 400 0 0 "$mid" >> "$SL/-h-w-ds-lbl-lead-gone-sq/s.jsonl"
DS_STATE_ROOT="$SS" "$ROOT/bin/lib/squad-spent.sh" lbl --dir "$SL"
F="$SS/lbl/loop/squad-spent.tsv"
eq "squad-spent: live squad total + role split" "$(awk -F'\t' '$1=="live-sq"{print $3,$4,$5,$6,$7,$8}' "$F")" "2250 1250 0 1000 0 0"
eq "squad-spent: closed squad is frozen" "$(awk -F'\t' '$1=="gone-sq"{print $3,$8}' "$F")" "500 1"
eq "squad-spent: since = first member start" "$(awk -F'\t' '$1=="live-sq"{print ($2>='"$since0"'-2 && $2<='"$since0"'+2)}' "$F")" "1"
# More spend lands in the closed squad's logs; a rerun keeps its frozen row and updates the live one.
line g2 claude-opus-5-5 0 4000 0 0 "$now" >> "$SL/-h-w-ds-lbl-lead-gone-sq/s.jsonl"
line l2 claude-opus-5-5 0 1000 0 0 "$now" >> "$SL/-h-w-ds-lbl-lead-live-sq/s.jsonl"
DS_STATE_ROOT="$SS" "$ROOT/bin/lib/squad-spent.sh" lbl --dir "$SL"
eq "squad-spent: frozen row unchanged" "$(awk -F'\t' '$1=="gone-sq"{print $3,$8}' "$F")" "500 1"
eq "squad-spent: live row grows" "$(awk -F'\t' '$1=="live-sq"{print $3}' "$F")" "3500"

# U102: sub-agents count for the worker that ran them; a headless review session and its sub-agents
# are a separate `<worker>:review` row (role review); a message id repeated across files counts once;
# cw_1h / cw_5m split cache_write by TTL.
lineT(){ # id model in cw1h cw5m cr out ts
  jq -cn --arg id "$1" --arg m "$2" --argjson i "$3" --argjson h "$4" --argjson f "$5" --argjson r "$6" --argjson o "$7" --arg ts "$8" \
    '{type:"assistant",timestamp:$ts,message:{id:$id,model:$m,usage:{input_tokens:$i,cache_creation_input_tokens:($h+$f),cache_read_input_tokens:$r,output_tokens:$o,cache_creation:{ephemeral_1h_input_tokens:$h,ephemeral_5m_input_tokens:$f}}}}'
}
SA="$TMP/projects-sub"; SB="$SA/-home-x-ws-ds-lbl-builder-u1-t"; mkdir -p "$SB/main1/subagents" "$SB/rev1/subagents"
{ echo '{"type":"user","message":{"content":"You are the builder of squad \"t\"."}}'; lineT m1 claude-opus-5-5 1 100 10 1000 5 "$now"; } > "$SB/main1.jsonl"
SA2="$TMP/projects-sub2"; SBO="$SA2/-home-x-ws-ds-lbl-builder-u9-t"; mkdir -p "$SBO"   # the older prompt form
{ echo '{"type":"user","entrypoint":"sdk-cli","message":{"content":"/compound-engineering:ce-code-review base:origin/main"}}'; lineT o1 claude-opus-5-5 1 0 10 0 1 "$now"; } > "$SBO/o.jsonl"
lineT s1 claude-opus-5-5 1 200 20 500 5 "2099-01-01T00:00:00Z" | jq -c '. + {isSidechain:true}' > "$SB/main1/subagents/agent-a.jsonl"
lineT m1 claude-opus-5-5 1 100 10 1000 5 "$now" > "$SB/main1/subagents/agent-dup.jsonl"   # same id as main -> once
{ echo '{"type":"attachment","entrypoint":"sdk-cli","pad":"'"$(head -c 90000 /dev/zero | tr '\0' x)"'"}'; printf '%s\n' '{"type":"user","entrypoint":"sdk-cli","message":{"content":"<command-message>compound-engineering:ce-code-review</command-message>\\n<command-name>/compound-engineering:ce-code-review</command-name>"}}'
  lineT r1 claude-opus-5-5 2 400 40 2000 7 "$now"; } > "$SB/rev1.jsonl"
lineT r2 claude-opus-5-5 1 300 0 100 3 "$now" > "$SB/rev1/subagents/agent-r.jsonl"
sout="$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$SA" --by-worker)"
eq "subagents: builder row adds the sub-agent (turns in cw cr out 1h 5m)" "$(printf '%s\n' "$sout" | awk -F'\t' '$1!~/:review/&&NR>1{print $5,$6,$7,$8,$9,$11,$12}')" "2 2 330 1500 10 300 30"
eq "review: own row, role review, sub-agent included" "$(printf '%s\n' "$sout" | awk -F'\t' '$1~/:review$/{print $3,$5,$6,$7,$8,$9,$11,$12}')" "review 2 3 740 2100 10 700 40"
eq "ctx: a sub-agent turn never replaces the worker's own" "$(printf '%s\n' "$sout" | awk -F'\t' '$1!~/:review/&&NR>1{print $10}')" "1111"
eq "review: the older prompt form counts too" "$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$SA2" --by-worker | awk -F'\t' '$1~/u9-t:review$/{print $3}')" "review"
eq "review: same topic as its builder" "$(printf '%s\n' "$sout" | awk -F'\t' 'NR>1{print $2}' | sort -u | wc -l | tr -d ' ')" "1"
eq "per-role table lists review beside builder" "$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$SA" | awk 'NR>1{print $1}' | sort | tr '\n' ' ')" "builder review "
# no sub-agents, no review: the totals are what they were.
eq "no subagents: unchanged totals" "$("$ROOT/bin/lib/token-usage.sh" --days 7 --dir "$P" | awk '$1=="builder"{print $3,$4,$5,$6,$7}')" "1 3 300 0 9"
printf '{"topic":"t","members":[{"since":"%s"}]}' "$(jq -rn --argjson s "$since0" '$s|todate')" > "$SS/lbl/squads/t.json"
DS_STATE_ROOT="$SS" "$ROOT/bin/lib/squad-spent.sh" lbl --dir "$SA"
eq "squad-spent: TTL weights and Opus reads include review and subagents" "$(awk -F'\t' '$1=="t"{print $3,$6,$7}' "$F")" "2372 764 1608"

# A Codex Builder can leave only Claude review logs. Its arbitrary unit suffix does not identify
# the squad: resolve the exact worktree through member metadata, or the unit after the member closes.
SM="$TMP/metadata"; SP="$TMP/projects-review-only"
MW="/home/x/ws/ds-lbl-builder-u77-never-guess-topic"; UW="/home/x/ws/ds-lbl-builder-u88-closed"
mkdir -p "$SM/lbl/squads" "$SP/${MW//\//-}" "$SP/${UW//\//-}"
for w in "$MW" "$UW"; do
  { echo '{"type":"user","entrypoint":"sdk-cli","message":{"content":"/compound-engineering:ce-code-review base:origin/main"}}'
    line "review-$w" claude-opus-5-5 5 0 0 0 "$now"; } > "$SP/${w//\//-}/review.jsonl"
done
jq -cn --arg m "id::$MW" --arg u "id::$UW" '{members:[{role:"builder",wt:$m}],units:[{slug:"unrelated-unit",builder_wt:$u}]}' > "$SM/lbl/squads/real-squad.json"
metaout="$(DS_STATE_ROOT="$SM" "$ROOT/bin/lib/token-usage.sh" --by-worker --dir "$SP")"
eq "review-only: member and closed-unit metadata attribute the squad without a main transcript" "$(printf '%s\n' "$metaout" | awk -F'\t' 'NR>1{print $2,$3}' | sort -u)" "real-squad review"
eq "review-only: both workers count" "$(printf '%s\n' "$metaout" | awk 'END{print NR-1}')" "2"
# On a migrated host loop.db is authoritative, even while the exported file carries an older topic.
DS_STATE_ROOT="$SM" bun -e 'import { open } from "'"$ROOT"'/bin/loop/core/store.ts";
  const s = open();
  s.upsert("members", { project: "lbl", squad: "current-squad", wt: process.argv[1] }, { role: "builder", observed_at: 1, updated_at: 1 });
  s.upsert("units", { project: "lbl", squad: "current-squad", slug: "unrelated-unit" }, { builder_wt: process.argv[2], observed_at: 1, updated_at: 1 });
  s.close();' "id::$MW" "id::$UW"
metaout="$(DS_STATE_ROOT="$SM" "$ROOT/bin/lib/token-usage.sh" --by-worker --dir "$SP")"
eq "review-only: loop member and unit metadata override stale file attribution" "$(printf '%s\n' "$metaout" | awk -F'\t' 'NR>1{print $2,$3}' | sort -u)" "current-squad review"

# U265: the scan keeps what it read (state/loop/token-cache.db) and parses only new bytes. Every case: a cached run
# and a DS_TOKEN_CACHE=0 run of the same logs print the same bytes; kstat reads the cached run's stderr line.
K="$TMP/k-state"; KL="$TMP/k-logs"; KW="$KL/-home-x-ws-ds-lbl-builder-u1-kt"; mkdir -p "$KW"
kcmp(){ # <name> <token-usage args...>
  local n="$1"; shift
  DS_STATE_ROOT="$K" "$ROOT/bin/lib/token-usage.sh" --dir "$KL" "$@" > "$TMP/k.cached" 2> "$TMP/k.err" || echo "cached run failed: $(cat "$TMP/k.err")" >&2
  DS_STATE_ROOT="$K" DS_TOKEN_CACHE=0 "$ROOT/bin/lib/token-usage.sh" --dir "$KL" "$@" > "$TMP/k.full" 2> /dev/null
  if cmp -s "$TMP/k.cached" "$TMP/k.full"; then eq "cache: $n" same same; else eq "cache: $n" "$(diff "$TMP/k.full" "$TMP/k.cached" | tr '\n' ' ')" same; fi
}
kstat(){ sed -n 's/.*files \([0-9]*\) parsed in full, \([0-9]*\) read incrementally, \([0-9]*\) unchanged, \([0-9]*\) skipped; \([0-9]*\) bytes parsed.*cache \(.*\)$/full=\1 incr=\2 kept=\3 skip=\4 bytes=\5 cache=\6/p' "$TMP/k.err"; }
kfield(){ kstat | tr ' ' '\n' | sed -n "s/^$1=//p"; }
bw(){ awk -F'\t' -v w="$1" 'NR>1 && $1==w {print $5, $9}' "$TMP/k.cached"; }

{ printf '%s\n' '{"type":"user","message":{"content":"You are the builder (scope: u1) of squad \"kt\"."}}'; line k1 claude-opus-5-5 1 10 100 1 "$now"; } > "$KW/s.jsonl"
kcmp "first run, no cache yet" --by-worker
eq "cache: the first run parses the file in full" "$(kfield full) $(kfield cache)" "1 new"
eq "cache: first run row" "$(bw "${KW##*/}")" "1 1"
add="$(line k2 claude-opus-5-5 1 10 100 2 "$now")"; printf '%s\n' "$add" >> "$KW/s.jsonl"
kcmp "lines appended" --by-worker
eq "cache: the second run reads only the appended bytes" "$(kfield full) $(kfield incr) $(kfield bytes)" "0 1 $(( ${#add} + 1 ))"
eq "cache: appended record counted" "$(bw "${KW##*/}")" "2 3"
kcmp "per-role table from the same cache"
kcmp "nothing changed" --by-worker
eq "cache: an unchanged file is not read" "$(kfield kept) $(kfield bytes)" "1 0"

# A half-written last line: not consumed; once complete it counts. A last line that already parses counts at once.
half="$(line k3 claude-opus-5-5 1 10 100 4 "$now")"
printf '%s' "${half:0:40}" >> "$KW/s.jsonl"
kcmp "half-written last line" --by-worker
printf '%s\n' "${half:40}" >> "$KW/s.jsonl"
kcmp "last line completed" --by-worker
eq "cache: the completed line counts" "$(bw "${KW##*/}")" "3 7"
printf '%s' "$(line k4 claude-opus-5-5 1 10 100 8 "$now")" >> "$KW/s.jsonl"
kcmp "last line parses before its newline" --by-worker
eq "cache: an unfinished line that parses counts" "$(bw "${KW##*/}")" "4 15"
printf '\n%s\n' "$(line k5 claude-opus-5-5 1 10 100 16 "$now")" >> "$KW/s.jsonl"
kcmp "newline after a parsed last line" --by-worker
eq "cache: no record counted twice" "$(bw "${KW##*/}")" "5 31"

# One message id in a session and its resumed copy: counted once, the first seen in scan order wins.
{ line k1 claude-opus-5-5 9 90 900 99 "$now"; line k6 claude-opus-5-5 1 10 100 32 "$now"; } > "$KW/t-resumed.jsonl"
kcmp "resumed copy of a message id" --by-worker
eq "cache: a resumed message id counts once" "$(bw "${KW##*/}")" "6 63"
line k6 claude-opus-5-5 1 10 100 32 "$now" >> "$KW/s.jsonl"
kcmp "the id lands later in the earlier file" --by-worker

# A file truncated and rewritten under the same name (same inode, larger): read again from 0.
ino0="$(stat -c %i "$KW/t-resumed.jsonl")"
{ line r1 claude-sonnet-5-5 7 70 700 64 "$now"; line r2 claude-sonnet-5-5 7 70 700 128 "$now"; line r3 claude-sonnet-5-5 7 70 700 256 "$now"; } > "$KW/t-resumed.jsonl"
eq "cache: rewrite kept the inode" "$(stat -c %i "$KW/t-resumed.jsonl")" "$ino0"
kcmp "truncated and rewritten" --by-worker
eq "cache: the rewritten file is parsed in full" "$(kfield full)" "1"
: > "$KW/t-resumed.jsonl"; line r4 claude-sonnet-5-5 1 1 1 1 "$now" > "$KW/t-resumed.jsonl"
kcmp "shrunk and rewritten" --by-worker
mv "$KW/t-resumed.jsonl" "$KW/t.tmp"; cp "$KW/t.tmp" "$KW/t-resumed.jsonl"; rm "$KW/t.tmp"
line r5 claude-sonnet-5-5 1 1 1 1 "$now" >> "$KW/t-resumed.jsonl"
kcmp "new inode" --by-worker
rm "$KW/t-resumed.jsonl"
kcmp "file deleted" --by-worker
eq "cache: a deleted file's records are gone" "$(awk -F'\t' 'NR>1 && $4=="claude-sonnet-5-5"' "$TMP/k.cached" | wc -l | tr -d ' ')" "0"
eq "cache: a deleted file loses its entry" "$(bun -e 'import { Database } from "bun:sqlite"; const d = new Database(process.argv[1], { readonly: true }); console.log((d.query("SELECT count(*) AS n FROM files WHERE path LIKE ?").get("%t-resumed%") as any).n)' "$K/loop/token-cache.db")" "0"

# Ageing out of --since: a later cutoff drops the record; an earlier cutoff than the cache holds rebuilds it once
# (review P2: an operator's narrow scan must not leave the loop's wider one uncached until the floor catches up).
KA="$KL/-home-x-ws-ds-lbl-lead-age"; mkdir -p "$KA"
a1="$(jq -rn 'now - 3*86400 | todate')"; a2="$(jq -rn 'now - 2*86400 | todate')"
{ line a1 claude-opus-5-5 1 1 1 1 "$a1"; line a2 claude-opus-5-5 1 1 1 2 "$a2"; line a3 claude-opus-5-5 1 1 1 4 "$now"; } > "$KA/s.jsonl"
s4="$(jq -rn 'now - 4*86400 | floor')"; s25="$(jq -rn 'now - 2.5*86400 | floor')"
kcmp "since 4 days" --since "$s4" --by-worker
kcmp "since 2.5 days: a record ages out" --since "$s25" --by-worker
eq "cache: the aged record is left out" "$(bw "${KA##*/}")" "2 6"
eq "cache: a later cutoff uses the cache" "$(kfield cache)" "on"
kcmp "since 4 days again (older than the cache)" --since "$s4" --by-worker
eq "cache: an older cutoff rebuilds the cache in one full scan" "$(kfield cache) $(bw "${KA##*/}")" "rebuild 3 7"
kcmp "since 4 days a third time" --since "$s4" --by-worker
eq "cache: after the rebuild the older cutoff is cached again" "$(kfield cache) $(kfield bytes)" "on 0"

# A review session and its sub-agents, appended to.
KR="$KL/-home-x-ws-ds-lbl-builder-u2-kt"; mkdir -p "$KR/rev/subagents"
{ echo '{"type":"user","entrypoint":"sdk-cli","message":{"content":"/compound-engineering:ce-code-review base:origin/main"}}'; line v1 claude-opus-5-5 2 2 2 2 "$now"; } > "$KR/rev.jsonl"
line v2 claude-opus-5-5 3 3 3 3 "$now" > "$KR/rev/subagents/agent-a.jsonl"
kcmp "review session" --by-worker
line v3 claude-opus-5-5 4 4 4 4 "$now" >> "$KR/rev.jsonl"; line v4 claude-opus-5-5 5 5 5 5 "$now" >> "$KR/rev/subagents/agent-a.jsonl"
kcmp "review session appended" --by-worker
eq "cache: review row" "$(awk -F'\t' -v w="${KR##*/}:review" 'NR>1 && $1==w {print $3, $5}' "$TMP/k.cached")" "review 4"
kcmp "review per-role table"

# A file older than the window still names the folder's topic (its head is read, its records are not).
KO="$KL/-home-x-ws-ds-lbl-builder-u3-x"; mkdir -p "$KO"
{ printf '%s\n' '{"type":"user","message":{"content":"You are the builder (scope: u3) of squad \"oldboot\"."}}'; line o0 claude-opus-5-5 50 50 50 50 "$now"; } > "$KO/old.jsonl"
touch -t 202001010000 "$KO/old.jsonl"
line o1 claude-opus-5-5 1 1 1 1 "$now" > "$KO/new.jsonl"
kcmp "old file carries the boot topic" --by-worker
eq "cache: topic from the old file, its records skipped" "$(awk -F'\t' -v w="${KO##*/}" 'NR>1 && $1==w {print $2, $5}' "$TMP/k.cached")" "oldboot 1"
eq "cache: the old file is skipped" "$(( $(kfield skip) >= 1 ))" "1"
kcmp "old file, warm cache" --by-worker

# A corrupt cache (or another schema) is deleted and the scan runs in full.
printf 'not a database' > "$K/loop/token-cache.db"
kcmp "corrupt cache file" --by-worker
eq "cache: a corrupt cache is replaced" "$(kfield cache) $(kfield incr)" "reset 0"
kcmp "after the reset" --by-worker
eq "cache: the replaced cache is used" "$(kfield cache) $(kfield bytes)" "on 0"
bun -e 'import { Database } from "bun:sqlite"; const d = new Database(process.argv[1]); d.run("UPDATE meta SET v = ? WHERE k = ?", ["0", "schema"]); d.close();' "$K/loop/token-cache.db"
kcmp "schema mismatch" --by-worker
eq "cache: another schema is replaced" "$(kfield cache)" "reset"
DS_STATE_ROOT="$K" DS_TOKEN_CACHE=0 "$ROOT/bin/lib/token-usage.sh" --dir "$KL" > /dev/null 2> "$TMP/k.err"
eq "cache: DS_TOKEN_CACHE=0 runs without it" "$(kfield cache)" "off"
echo "token-usage: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
