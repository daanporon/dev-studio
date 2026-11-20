#!/usr/bin/env bash
# demo-board.sh — serve today's web board from fully fake data (for the README picture).
#
#   scripts/demo-board.sh [port]   serve the demo board in the foreground (default port 8791)
#   scripts/demo-board.sh --json   print the demo board's JSON once (the check tests/demo-board.sh runs)
#   scripts/demo-board.sh --events print the demo event log's rows once (JSON)
#   scripts/demo-board.sh --shot <dir>  serve on a free port, take <dir>/board.png (top) and <dir>/board-full.png
#                                  (the whole page), stop what it started (needs Node and a headless Chrome;
#                                  scripts/demo-board-shot.sh is the same with <dir> = docs/img)
#
# The board reads only $DS_STATE_ROOT/loop.db, so the demo is a throwaway state root with a
# fake loop.db in it (seed files -> `ds import` -> tests/board-db.ts, as tests/board.sh builds
# its own) and the REAL board run against it. No board code is copied, so it cannot drift.
# DS_STATE_ROOT points at the temp dir before anything runs: the live state/, the live
# loop.db and the live board's pidfile are never touched, and no real Orca, gh or network is called.
#
# Re-taking the pictures: scripts/demo-board-shot.sh (it checks each section has content and no "Loop down"
# banner shows before it writes anything). While it serves, scripts/demo-board-refresh.ts keeps the temp
# loop.db's heartbeat and observed rows fresh, so the board reads live however long it runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8791
JSON=0
EVENTS_ONLY=0
SHOT=""
want_dir=0
for a in "$@"; do
  if [ "$want_dir" = 1 ]; then SHOT="$a"; want_dir=0; continue; fi
  case "$a" in
    --json) JSON=1 ;;
    --events) EVENTS_ONLY=1 ;;
    --shot) want_dir=1 ;;
    *) case "$a" in ""|*[!0-9]*) echo "demo-board: want a port or --json, got '$a'" >&2; exit 2 ;; esac
       if [ "$a" -lt 1 ] || [ "$a" -gt 65535 ]; then echo "demo-board: bad port '$a' (want 1-65535)" >&2; exit 2; fi
       PORT="$a" ;;
  esac
done
if [ "$want_dir" = 1 ]; then echo "demo-board: --shot wants a folder" >&2; exit 2; fi
command -v bun >/dev/null 2>&1 || { echo "demo-board: needs bun (https://bun.sh/install)" >&2; exit 1; }

DEMO="$(mktemp -d "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/ds-demo-board.XXXXXX")"
SPID=""; RPID=""
stop_children() {   # only the processes this run started, by the pids it recorded
  for p in "$RPID" "$SPID"; do
    [ -n "$p" ] || continue
    pkill -TERM -P "$p" 2>/dev/null || true; kill -TERM "$p" 2>/dev/null || true
  done
}
trap 'stop_children; rm -rf "$DEMO"' EXIT
R="$DEMO/stage"      # the staging state root the seed is built in
S="$DEMO/state"      # the state root the board runs on: loop.db only
mkdir -p "$R/acme-shop/squads" "$R/acme-shop/loop" "$R/acme-shop/briefings" "$S" "$DEMO/empty"

NOW="$(date +%s)"
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
Q_SINCE="$(iso $((NOW - 1500)))"   # the demo question was asked 25 minutes ago
R_="$R"; R="$R/acme-shop"          # the squad heredocs below write under $R/state/acme-shop
# --- the fake project: acme-shop, three squads -------------------------------------------
cat > "$R/squads/checkout-flow.json" <<JSON
{"run_id":"run_demo_checkout","task_id":"task_demo_checkout","lead_wt":"demo-co-lead",
 "type":"feature","autonomy":"checkpoints","status":"running","repo":"acme/shop",
 "worktrees":["demo-co-lead","demo-co-thinker","demo-co-b3"],
 "members":[
  {"role":"lead","wt":"demo-co-lead","owns":[],"for":""},
  {"role":"thinker","wt":"demo-co-thinker","owns":[],"for":""},
  {"role":"builder","suffix":"order-confirm","wt":"demo-co-b3","owns":["order-confirm"],"for":"order-confirm","model":"sonnet","account":"work"}],
 "units":[
  {"slug":"cart-total","status":"done","tier":"hard","builder_wt":"demo-co-b1","pr":"101"},
  {"slug":"payment-form","status":"done","tier":"hard","builder_wt":"demo-co-b2","pr":"102"},
  {"slug":"tax-rates","status":"done","tier":"hard","builder_wt":"demo-co-b4","pr":"107"},
  {"slug":"discount-codes","status":"done","tier":"hard","builder_wt":"demo-co-b5","pr":"108"},
  {"slug":"guest-checkout","status":"done","tier":"hard","builder_wt":"demo-co-b6","pr":"109"},
  {"slug":"address-book","status":"done","tier":"hard","builder_wt":"demo-co-b7","pr":"110"},
  {"slug":"order-confirm","status":"dispatched","tier":"standard","builder_wt":"demo-co-b3","pr":"103","deps":["cart-total","guest-checkout"]},
  {"slug":"email-receipt","status":"planned","deps":["order-confirm"]},
  {"slug":"refund-flow","status":"planned","deps":["address-book"]},
  {"slug":"fraud-check","status":"planned","deps":["payment-form"]},
  {"slug":"invoice-pdf","status":"planned","deps":["email-receipt","refund-flow","tax-rates"]},
  {"slug":"gift-wrapping","status":"planned","deps":["discount-codes","order-confirm"]}],
 "waiting_on_you":[]}
JSON
cat > "$R/squads/product-search.json" <<JSON
{"run_id":"run_demo_search","task_id":"task_demo_search","lead_wt":"demo-ps-lead",
 "type":"feature","autonomy":"checkpoints","status":"waiting-on-you","repo":"acme/shop",
 "worktrees":["demo-ps-lead","demo-ps-thinker"],
 "members":[
  {"role":"lead","wt":"demo-ps-lead","owns":[],"for":"","account":"personal"},
  {"role":"thinker","wt":"demo-ps-thinker","owns":[],"for":""}],
 "units":[
  {"slug":"index-rebuild","status":"done","tier":"hard","builder_wt":"demo-ps-b0","pr":"104"},
  {"slug":"results-ui","status":"planned","deps":[]}],
 "waiting_on_you":[
  {"id":"q1","asker":"thinker","blocking":true,
   "title":"Show out-of-stock items in search results?",
   "question":"Half the test shoppers typed a product name, got no results, and assumed we don't sell it — the item was just out of stock. Show those items greyed out, or keep hiding them?",
   "suggestion":"Show them, greyed out","why":"shoppers stop thinking we don't carry the item",
   "options":["Show them, greyed out","Keep hiding them"],
   "choices":[{"label":"Show them, greyed out","does":"results include out-of-stock rows, greyed, with a restock note"},
              {"label":"Keep hiding them","does":"results stay as they are; add a 'nothing found' hint instead"}],
   "since":"$Q_SINCE"}]}
JSON
cat > "$R/squads/homepage-hero.json" <<JSON
{"run_id":"run_demo_hero","task_id":"task_demo_hero","lead_wt":"demo-hh-lead",
 "type":"feature","autonomy":"checkpoints","status":"done","repo":"acme/shop",
 "worktrees":["demo-hh-lead"],
 "members":[{"role":"lead","wt":"demo-hh-lead","owns":[],"for":""}],
 "units":[
  {"slug":"hero-copy","status":"done","builder_wt":"demo-hh-b1","pr":"105"},
  {"slug":"hero-image","status":"done","builder_wt":"demo-hh-b2","pr":"106"}],
 "waiting_on_you":[]}
JSON
touch "$R/squads/checkout-flow.beat" "$R/squads/product-search.beat"
cat > "$R/squads/checkout-flow-demo-plan.md" <<'MD'
# Checkout flow plan

How the acme-shop checkout squad breaks the work down:

- cart-total — totals with tax and shipping (done, #101)
- payment-form — card form with validation (done, #102)
- tax-rates — per-region tax table (done, #107)
- discount-codes — coupon codes at checkout (done, #108)
- guest-checkout — buy without an account (done, #109)
- address-book — saved delivery addresses (done, #110)
- order-confirm — confirmation page (building, #103, waits on cart-total and guest-checkout)
- email-receipt — receipt email once the order exists (waits on order-confirm)
- refund-flow — self-serve refunds (ready, waits on address-book)
- fraud-check — risk score on the paid order (ready, waits on payment-form)
- invoice-pdf — downloadable invoice (waits on email-receipt, refund-flow and tax-rates)
- gift-wrapping — wrap option at checkout (waits on discount-codes and order-confirm)
MD
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\nclaude\twork\t62\t%s\t35\t%s\t-\t%s\twork@example.com\t-\nclaude\tpersonal\t18\t-\t9\t-\t-\t%s\tpersonal@example.com\t-\n' \
  "$((NOW + 7200))" "$((NOW + 172800))" "$NOW" "$NOW" > "$R_/accounts.tsv"
printf 'worker\ttopic\trole\tmodel\tturns\tinput\tcache_write\tcache_read\toutput\tctx\n%s\n' \
  "demo-co-lead	checkout-flow	lead	opus	12	300	9000	1200	400	45000
demo-co-thinker	checkout-flow	thinker	opus	8	200	6000	800	300	38000
demo-co-b3	checkout-flow	builder	sonnet	22	500	14000	2000	900	82000
demo-co-b1	checkout-flow	builder	sonnet	15	400	10000	1500	700	-
demo-co-b2	checkout-flow	builder	sonnet	14	350	9000	1200	600	-
demo-co-b4	checkout-flow	builder	sonnet	11	300	8000	1100	500	-
demo-co-b5	checkout-flow	builder	sonnet	9	250	6500	900	400	-
demo-co-b6	checkout-flow	builder	sonnet	13	350	9500	1400	600	-
demo-co-b7	checkout-flow	builder	sonnet	8	200	5500	800	350	-
demo-ps-lead	product-search	lead	opus	9	250	7000	900	350	41000
demo-ps-thinker	product-search	thinker	opus	6	150	4500	600	200	30000
demo-ps-b0	product-search	builder	sonnet	18	450	12000	1800	800	-
demo-hh-lead	homepage-hero	lead	opus	11	280	8000	1000	380	-
demo-hh-b1	homepage-hero	builder	sonnet	10	300	7500	1100	500	-
demo-hh-b2	homepage-hero	builder	sonnet	7	200	5000	700	300	-" > "$R_/tokens.tsv"
printf '%s\n' \
  "checkout-flow	$((NOW - 259200))	3200000	400000	300000	2400000	100000	0" \
  "product-search	$((NOW - 172800))	1500000	300000	200000	900000	100000	0" \
  "homepage-hero	$((NOW - 777600))	2200000	500000	100000	1500000	100000	1" > "$R/loop/squad-spent.tsv"

cat > "$R/briefings/$(date -u -d '@'$((NOW - 86400)) +%F).md" <<'MD'
# Morning brief

Needs you: one question in product-search (show out-of-stock items in results?).

- checkout-flow: 6 of 12 units merged, order-confirm is building.
- homepage-hero: finished; both PRs merged.
MD
R="$R_"

# The event log, and what Flow's stage times and merges-per-day are read from: each done unit
# was dispatched, got its PR, was armed and merged on its own day (the 5-sample floor for medians).
# Each event carries the fields the board words its line from, and `"n":null` drops the seeder's
# default `n: <kind>` field, which would otherwise read back as "n squad_done" in the line. The rows go
# into loop.db oldest first (ids in time order), as the loop writes them: the log reads by id.
EVENTS="["
ev() { EVENTS="$EVENTS{\"ago\":$1,\"squad\":\"$2\",\"unit\":\"$3\",\"kind\":\"$4\",\"payload\":{\"n\":null$5}},"; }
d=0
for u in checkout-flow:cart-total:101:b1 checkout-flow:payment-form:102:b2 checkout-flow:tax-rates:107:b4 checkout-flow:discount-codes:108:b5 \
         checkout-flow:guest-checkout:109:b6 checkout-flow:address-book:110:b7 product-search:index-rebuild:104:b0 \
         homepage-hero:hero-copy:105:b1 homepage-hero:hero-image:106:b2; do
  IFS=: read -r sq un pr w <<<"$u"; d=$((d + 1)); base=$((d * 18000 + 3600))   # one merge every five hours
  pre="demo-$(printf %s "$sq" | sed -E 's/(.)[^-]*-(.).*/\1\2/')-$w"
  ev $((base + 1800)) "$sq" "$un" unit_dispatched ",\"builder_wt\":\"$pre\""; ev $((base + 600)) "$sq" "$un" unit_pr ",\"pr\":$pr"
  ev $((base + 100)) "$sq" "$un" auto_merge_armed ",\"pr\":$pr,\"method\":\"squash\""; ev "$base" "$sq" "$un" unit_done ",\"pr\":$pr"
done
ev 1400 checkout-flow order-confirm unit_dispatched ',"builder_wt":"demo-co-b3"'; ev 900 checkout-flow order-confirm unit_pr ',"pr":103'
EVENTS="$EVENTS{\"ago\":43200,\"squad\":\"checkout-flow\",\"kind\":\"squad_started\",\"payload\":{\"n\":null,\"type\":\"feature\"}},{\"ago\":1500,\"squad\":\"product-search\",\"kind\":\"question_asked\",\"payload\":{\"n\":null,\"title\":\"Show out-of-stock items in search results?\"}},{\"ago\":600,\"squad\":\"homepage-hero\",\"kind\":\"squad_all_done\",\"payload\":{\"n\":null}}]"
EVENTS="$(printf '%s' "$EVENTS" | bun -e 'const a=JSON.parse(await Bun.stdin.text());a.sort((x,y)=>y.ago-x.ago);console.log(JSON.stringify(a))')"

# --- the seed: what the loop's observers would have recorded --------------------------------
cat > "$DEMO/seed.json" <<JSON
{"workers":[["demo-co-lead","working","ds-lead","work",20],["demo-co-thinker","working","ds-thinker","work",90],
            ["demo-co-b3","working","ds-order-confirm","work",5],["demo-ps-lead","waiting","ds-lead","personal",1200],
            ["demo-ps-thinker","waiting","ds-thinker","personal",1300]],
 "terminals":[["term_demo_c1","demo-co-lead","checkout-flow"],["term_demo_c2","demo-co-thinker","checkout-flow"],
              ["term_demo_c3","demo-co-b3","checkout-flow"],["term_demo_p1","demo-ps-lead","product-search"],
              ["term_demo_p2","demo-ps-thinker","product-search"]],
 "worktrees":[["demo-co-lead","checkout-flow"],["demo-co-thinker","checkout-flow-thinker"],["demo-co-b3","order-confirm"],
              ["demo-ps-lead","product-search"],["demo-ps-thinker","product-search-thinker"]],
 "repos":{"acme/shop":"acme/shop"},
 "prs":[{"repo":"acme/shop","pr":101,"state":"MERGED","review":"approved","unit":"cart-total"},
        {"repo":"acme/shop","pr":102,"state":"MERGED","review":"approved","unit":"payment-form"},
        {"repo":"acme/shop","pr":107,"state":"MERGED","review":"approved","unit":"tax-rates"},
        {"repo":"acme/shop","pr":108,"state":"MERGED","review":"approved","unit":"discount-codes"},
        {"repo":"acme/shop","pr":109,"state":"MERGED","review":"approved","unit":"guest-checkout"},
        {"repo":"acme/shop","pr":110,"state":"MERGED","review":"approved","unit":"address-book"},
        {"repo":"acme/shop","pr":103,"state":"OPEN","draft":true,"ci":"pending","unit":"order-confirm"},
        {"repo":"acme/shop","pr":104,"state":"MERGED","review":"approved","unit":"index-rebuild"},
        {"repo":"acme/shop","pr":105,"state":"MERGED","review":"approved","unit":"hero-copy"},
        {"repo":"acme/shop","pr":106,"state":"MERGED","review":"approved","unit":"hero-image"}],
 "events":$EVENTS,
 "machine":{"cores":16,"load1":5.2,"load5":4.6,"load15":3.9,"mem_total_kb":33554432,"mem_avail_kb":16777216,
            "swap_total_kb":8388608,"swap_free_kb":8000000,"disks":[{"path":"/","total_kb":500000000,"free_kb":280000000}]},
 "procs":[["demo-co-lead",900000,12],["demo-co-thinker",700000,6],["demo-co-b3",1400000,48],["demo-ps-lead",600000,1]],
 "host_procs":[{"comm":"bun","procs":4,"rss_kb":1200000,"cpu_pct":15},{"comm":"node","procs":6,"rss_kb":2400000,"cpu_pct":30}]}
JSON

printf 'briefing_time 09:00\n' > "$R/acme-shop/limits.conf"   # Briefs shows only with a schedule on
# DEMO_DROP=<seed key> leaves that key out of the seed (tests/demo-board.sh shows its check failing).
[ -z "${DEMO_DROP:-}" ] || bun -e 'const f=process.argv[1],s=JSON.parse(require("fs").readFileSync(f,"utf8"));delete s[process.argv[2]];require("fs").writeFileSync(f,JSON.stringify(s))' "$DEMO/seed.json" "$DEMO_DROP"
DS_STATE_ROOT="$R" "$ROOT/bin/ds" import >/dev/null
DS_STATE_ROOT="$R" LAVISH_AXI_STATE_DIR="$DEMO/empty" MUSE_MODEL_CATALOG_DIR="$DEMO/empty" \
  bun "$ROOT/tests/board-db.ts" "$DEMO/seed.json" acme-shop
mv "$R"/loop.db* "$S"/

export DS_STATE_ROOT="$S" DS_BIND=127.0.0.1 MUSE_MODEL_CATALOG_DIR="$DEMO/empty" LAVISH_AXI_STATE_DIR="$DEMO/empty"
if [ "$EVENTS_ONLY" = 1 ]; then
  "$ROOT/bin/ds" events --project acme-shop   # the event log's rows, once
  exit 0
fi
if [ "$JSON" = 1 ]; then
  # DEMO_WAIT_S=<s> lets the refresher run that long first (the check that the loop never reads as down);
  # DEMO_NO_REFRESH=1 leaves it off (shows that check failing).
  if [ -n "${DEMO_WAIT_S:-}" ]; then
    [ -n "${DEMO_NO_REFRESH:-}" ] || { bun "$ROOT/scripts/demo-board-refresh.ts" "$S/loop.db" & RPID=$!; }
    sleep "$DEMO_WAIT_S"
  fi
  "$ROOT/bin/board/board.sh" acme-shop --json   # no exec: the EXIT trap must remove $DEMO
  exit 0
fi
if [ -n "$SHOT" ]; then
  command -v node >/dev/null 2>&1 || { echo "demo-board: --shot needs node" >&2; exit 1; }
  PORT="$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  bun "$ROOT/scripts/demo-board-refresh.ts" "$S/loop.db" & RPID=$!
  "$ROOT/bin/board/board.sh" acme-shop --serve-fg "$PORT" >"$DEMO/serve.log" 2>&1 & SPID=$!
  for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/board.json" >/dev/null 2>&1 && break; sleep 0.5; done
  rc=0
  node "$ROOT/scripts/demo-board-shot.mjs" "http://127.0.0.1:$PORT/" "$SHOT" || rc=$?
  exit "$rc"
fi
echo "demo board: serving the fake acme-shop project on http://127.0.0.1:$PORT/"
echo "  expand the checkout-flow squad, wait for the pipeline graph, then screenshot."
echo "  everything is under $DEMO — Ctrl-C stops the server and removes it."
bun "$ROOT/scripts/demo-board-refresh.ts" "$S/loop.db" & RPID=$!
"$ROOT/bin/board/board.sh" acme-shop --serve-fg "$PORT"
