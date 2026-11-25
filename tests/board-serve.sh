#!/usr/bin/env bash
# board-serve.sh — board.sh --serve: the page, the JSON, the write routes and the server start/stop cases (split from tests/board.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
# shellcheck source=tests/lib/board-setup.sh
. "$ROOT/tests/lib/board-setup.sh"
briefs_fixture
st11_fixture

# The event sentences (the page's evSentence run on the each-kind fixture), as tests/board.sh builds them.
sentences="$(bun -e 'const fs = require("fs"), h = fs.readFileSync(process.argv[1], "utf8"), cut = (n) => { const i = h.indexOf(n); return h.slice(i, h.indexOf("\n}\n", i) + 2); };
  const evSentence = new Function("hhmmss", cut("function evSentence(") + "return evSentence;")((d) => d.toTimeString().slice(0, 8));
  for (const e of JSON.parse(fs.readFileSync(process.argv[2], "utf8"))) console.log(e.kind + "\t" + evSentence(e));' "$ROOT/web/board.html" "$ROOT/tests/fixtures/events-each-kind.json" 2>&1)"
# A fake `tailscale` reports ::1 as the tailnet IP so the serve tests need no real tailnet.
mkdir -p "$TMP/tsbin"
# shellcheck disable=SC2016  # $1/$2 belong to the fake script, not this one.
printf '#!/usr/bin/env bash\n[ "$1 $2" = "ip -4" ] && echo ::1\n' > "$TMP/tsbin/tailscale"; chmod +x "$TMP/tsbin/tailscale"
# U11: the feedback the board posts never reaches a real repo. DS_FEEDBACK_ORIGIN names a made-up one and a fake
# `gh` (first on PATH, and DS_GH) logs each call to $GHLOG and answers like the stub in tests/loop/fulfil-feedback-post.test.ts.
GHLOG="$TMP/gh.calls"; GHPOST="$TMP/gh.posted"; mkdir -p "$TMP/ghbin" "$GHPOST"; : > "$GHLOG"
cat > "$TMP/ghbin/gh" <<'GH'
#!/usr/bin/env bash
set -u
echo "$*" >> "$GHLOG"
[ "$1" = api ] || exit 9; shift
if [ "$1" = rate_limit ]; then printf '{"limit":5000,"remaining":4000,"reset":%s}' "$(( $(date +%s) + 3600 ))"; exit 0; fi
if [ "$1" = -X ]; then
  input=""; while [ $# -gt 0 ]; do [ "$1" = --input ] && input="$2"; shift; done
  n=$(( $(ls "$GHPOST" | wc -l) + 1 )); cp "$input" "$GHPOST/$n.json"
  printf '{"number":%s,"html_url":"https://github.com/example-org/dev-studio/issues/%s"}' "$((40+n))" "$((40+n))"; exit 0
fi
exit 0
GH
chmod +x "$TMP/ghbin/gh"
export GHLOG GHPOST DS_GH="$TMP/ghbin/gh" DS_FEEDBACK_ORIGIN="https://github.com/example-org/dev-studio.git" PATH="$TMP/ghbin:$PATH"
# A squad with questions for the answer endpoint: q7 was asked from a card (the Thinker's), q8 has
# no card so it goes to the Lead.
printf '{"run_id":"r9","status":"waiting-on-you","lead_wt":"wLd","members":[{"role":"lead","wt":"wLd","owns":[],"for":""},{"role":"thinker","wt":"wTh"},{"role":"tester","wt":"wTester"},{"role":"reviewer","wt":"wReviewer"},{"role":"researcher","wt":"wResearcher"}],"units":[],"waiting_on_you":[{"id":"q7","asker":"thinker","blocking":true,"question":"which?","since":"2026-10-08T09:00:00Z","card_wt":"wTh"},{"id":"q8","asker":"lead","blocking":true,"question":"go?","since":"2026-10-08T09:00:00Z"},{"id":"q9","asker":"lead","blocking":false,"question":"notes?","since":"2026-10-08T09:00:00Z"},{"id":"qp1","asker":"thinker","blocking":true,"question":"Which color?","title":"Style: Which color?","since":"2026-10-08T09:00:00Z","card_wt":"wTh","suggestion":"Blue","why":"raised from thinker'\''s terminal picker","choices":[{"label":"Blue","does":"calm look"},{"label":"Red (warm)","does":"bold look"}],"source":"picker","tool_use_id":"toolu_1","transcript_path":"/tmp/t.jsonl","picker_answerable":true}]}' > "$SD/ans.json"
# A Studio alert on the project (state/<label>/alerts.json), not on any squad.
printf '{"alerts":[{"id":"sweep-studio.ctx-1","asker":"sweep","blocking":false,"question":"Studio context is 350941 (>= 150000) — type /compact in the Studio","since":"2026-10-08T09:00:00Z","suggestion":"done — I compacted the Studio","options":["done — I compacted the Studio"],"why":"type /compact"}]}' > "$DS_STATE_ROOT/$LBL/alerts.json"
# More of the ans squad's questions: picker mirrors (bin/hooks/picker-hook.sh) — qp2 for free text, qp3
# closed in its transcript, qp4 not answerable by keystroke, qp5 for a failed press, qp6 closed
# mid-answer, qpu with no readable transcript — qc/qr for control characters and overlapping sends,
# qa1/qa2 answered in the terminal. And squad ans-2, whose name has ans as a prefix. The transcript
# (t.jsonl) says whether a picker is still open: toolu_3 has its tool_result.
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"AskUserQuestion"}]}}' \
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_3","is_error":true,"content":"dismissed"}]}}' > "$TMP/t.jsonl"
pk(){ jq -nc --arg id "$1" --arg tu "$2" --arg tp "$3" --argjson ok "$4" '{id:$id,asker:"thinker",blocking:true,question:"Which color?",title:"Style: Which color?",since:"2026-10-08T09:00:00Z",card_wt:"wTh",suggestion:"Blue",choices:[{label:"Blue",does:"calm"},{label:"Red (warm)",does:"bold"}],source:"picker",tool_use_id:$tu,transcript_path:$tp,picker_answerable:$ok}'; }
T="$TMP/t.jsonl"
jq --arg t "$T" --argjson a "$(pk qp2 toolu_1 "$T" true)" --argjson b "$(pk qp3 toolu_3 "$T" true)" --argjson c "$(pk qp4 toolu_1 "$T" false)" \
  --argjson d "$(pk qp5 toolu_1 "$T" true)" --argjson e "$(pk qp6 toolu_6 "$T" true)" --argjson u "$(pk qpu toolu_1 "$TMP/nope.jsonl" true)" \
  '(.waiting_on_you[] | select(.id=="qp1") | .transcript_path) = $t | .waiting_on_you += [$a,$b,$c,$d,$e,$u,
    {"id":"qc","asker":"lead","blocking":false,"question":"c?","since":"2026-10-08T09:00:00Z"},
    {"id":"qr","asker":"lead","blocking":false,"question":"r?","since":"2026-10-08T09:00:00Z"},
    {"id":"qa1","asker":"lead","blocking":false,"title":"Pick a name","question":"name?","since":"2026-10-08T09:00:00Z"},
    {"id":"qa2","asker":"lead","blocking":false,"title":"Ship it","question":"ship?","since":"2026-10-08T09:01:00Z"}]' "$SD/ans.json" > "$TMP/ans2" && mv "$TMP/ans2" "$SD/ans.json"
jq '.waiting_on_you = []' "$SD/ans.json" > "$SD/ans-2.json"
printf '{"run_id":"r-board-builders","status":"running","members":[{"role":"lead","wt":"wLRestart"},{"role":"builder","suffix":"platform","wt":"wtBp"}],"units":[]}' > "$SD/board-builders.json"
jq '.status="suspended"' "$SD/board-builders.json" > "$SD/board-builders-suspended.json"
jq '.status="done"' "$SD/board-builders.json" > "$SD/board-builders-done.json"
jq '.status="closed"' "$SD/board-builders.json" > "$SD/board-builders-closed.json"
# U5: a squad with a held unit, a dependent chain and a finished unit for the /api/unit and board.json checks.
printf '{"run_id":"r-uact","status":"running","members":[{"role":"lead","wt":"wLU"}],"units":[{"slug":"ua-held","status":"planned","hold":true,"deps":[]},{"slug":"ub-dep","status":"planned","deps":["ua-held"]},{"slug":"uc-dep","status":"planned","deps":["ub-dep"]},{"slug":"ud-open","status":"planned","deps":[]},{"slug":"ue-done","status":"done","deps":[]},{"slug":"uf-after-done","status":"planned","deps":["ue-done"]}]}' > "$SD/uact.json"
# hold-cancels-queue-undo-approval U3: uact has two plans, one approved (by its path under the served root), for /api/plan.
printf '# plan x\n' > "$SD/uact-x-plan.md"; printf '# plan y\n' > "$SD/uact-y-plan.md"
jq --arg p "$DBR/$LBL/squads/uact-x-plan.md" '.approved_plans = [$p]' "$SD/uact.json" > "$TMP/uact.tmp" && mv "$TMP/uact.tmp" "$SD/uact.json"
# --serve: the page, the JSON and the api routes. Nothing else (no state files) is reachable.
# The test serves on PORT..PORT+6: a block below Linux's ephemeral range (32768+), so no outgoing connection
# holds one of them, that nothing listens on yet (another worktree's suite on the same host).
busy() { local p; for p in $(seq "$1" $(($1 + 6))); do (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && return 0; done; return 1; }
PORT=$(( 20000 + $$ % 12000 ))
while busy "$PORT"; do PORT=$(( 20000 + (PORT - 20000 + 7) % 12000 )); done
# /lavish/<key> asks the loop to start Lavish when it is down; this fake "Lavish" is a bun server on LP.
LP=$((PORT + 5)); LK=0123456789abcdef; mkdir -p "$TMP/lv2"
printf '{"sessions":{"%s":{"key":"%s","file":"/x/a.html","url":"http://127.0.0.1:%s/session/%s","status":"open"}}}' "$LK" "$LK" "$LP" "$LK" > "$TMP/lv2/state.json"
LVSTART="echo started >> '$TMP/lvstart.log'; '$(command -v bun)' -e \"Bun.serve({hostname:'127.0.0.1',port:$LP,fetch:()=>new Response('ok')}); await Bun.sleep(30000)\" >/dev/null 2>&1 & echo \$! > '$TMP/lvfake.pid'"
# The server reads and writes the fixture db: 120 events for the event log. resync rebuilds it from
# the fixture files (it drops what the server wrote); ff is the loop's next tick after a write: the
# fulfillers alone (tests/board-fulfil.ts), against the fake backend.
jq '.events = 120' "$SEED" > "$TMP/seed-ev.json"
resync(){ SEED="$TMP/seed-ev.json" LAVISH_AXI_STATE_DIR="$TMP/lv2" mkdb "$LBL"; }
ff(){ DS_STATE_ROOT="$DBR" BACKEND="$TMP/fakeb" DS_LAVISH_START="$LVSTART" DS_LOOP_PICKER_TYPE_MS=50 DS_LOOP_SEND_TRIES=1 TMPDIR="$TMP" bun "$ROOT/tests/board-fulfil.ts" "$LBL"; }
# dbq <sql>: the rows as a JSON array (loop.db read-only).
printf '%s\n' 'import { Database } from "bun:sqlite";' \
  'const d = new Database(process.argv[2], { readonly: true });' \
  'console.log(JSON.stringify(d.query(process.argv[3]).all()));' > "$TMP/dbq.ts"
dbq(){ bun "$TMP/dbq.ts" "$DBR/loop.db" "$1"; }
resync
mkdir -p "$DBR/$LBL"; cp "$DS_STATE_ROOT/$LBL/alerts.json" "$DBR/$LBL/alerts.json"   # what alerts.sh resolves
# The skills the /api/skills block knows: a listing cache of its own and an empty Claude config dir, so
# the answer never depends on what the host (or a CI runner, which has none) has installed.
mkdir -p "$TMP/no-claude"
printf '{"at":1,"skills":[{"name":"compound-engineering:ce-work","source":"session listing","description":"work a plan"}]}' > "$DBR/skills-listing.json"
# DS_EVLOG_SEARCH_SLICE: a search reads 6 ids per request, so the event-log-filters U4 block can page one.
PATH="$TMP/tsbin:$PATH" DS_STATE_ROOT="$DBR" DS_BIND=127.0.0.1 BACKEND="$TMP/fakeb" DS_EVLOG_SEARCH_SLICE=6 CLAUDE_CONFIG_DIR="$TMP/no-claude" \
  "$ROOT/bin/board/board.sh" "$LBL" --serve-fg "$PORT" >"$TMP/serve.log" 2>&1 &
SPID=$!
for _ in $(seq 1 300); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.2; done
eq "serve: page is 200"           "$(curl -s -o "$TMP/page.html" -w '%{http_code}' "http://127.0.0.1:$PORT/")" "200"
if grep -q 'id="root"' "$TMP/page.html"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: page has no #root" >&2; fi
eq "serve: json is 200"           "$(curl -s -o "$TMP/served.json" -w '%{http_code}' "http://127.0.0.1:$PORT/board.json")" "200"
jt "serve: json is the board"     "$TMP/served.json" ".project == \"$LBL\""
# U3: a question card chats with the member its answer goes to: q7 the Thinker's card, q8 the Lead.
eq "serve: question cards name the member to chat with" "$(jq -c '[.needs_you[] | select(.squad == "ans" and (.id == "q7" or .id == "q8")) | [.id, .chat_wt, .chat_label]] | sort' "$TMP/served.json")" '[["q7","wTh","thinker"],["q8","wLd","the Lead"]]'
# The page fingerprint (machine-top-ram-clarity U7): the served page and /board.json carry the same hash of web/board.html.
PV="$(sed -n 's/.*<meta name="page-version" content="\([0-9a-f]*\)">.*/\1/p' "$TMP/page.html" | head -1)"
eq "serve: the page carries a page-version" "$([[ "$PV" =~ ^[0-9a-f]{12}$ ]] && echo yes)" "yes"
eq "serve: board.json page_version equals the page's" "$(jq -r .page_version "$TMP/served.json")" "$PV"
# DNS rebinding: a page on evil.example resolving to this host must not read the board.
eq "serve: foreign Host is 403"   "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "http://127.0.0.1:$PORT/board.json")" "403"
eq "serve: localhost Host is ok"  "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: localhost:$PORT" "http://127.0.0.1:$PORT/board.json")" "200"
eq "serve: other paths are 404"   "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/../state/$LBL/squads/")" "404"
eq "serve: DS_BIND without tailnet doesn't advertise it" "$(grep -c 'over the tailnet' "$TMP/serve.log" || true)" "0"
eq "serve: no directory listing"  "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/web/")" "404"

# GET /api/events: the event log, 50 per page newest first, paged by id (before=<id>), never OFFSET.
EV="http://127.0.0.1:$PORT/api/events"
curl -s "$EV?limit=50" > "$TMP/ev1.json"
jt "events: 50 newest first"          "$TMP/ev1.json" '(.events | length) == 50 and ([.events[].id] == ([.events[].id] | sort | reverse)) and .events[0].kind == "fx_120" and .newer == null'
curl -s "$EV?limit=50&before=$(jq '.events[49].id' "$TMP/ev1.json")" > "$TMP/ev2.json"
jt "events: before=<50th id> is the next 50" "$TMP/ev2.json" '(.events | length) == 50 and .events[0].kind == "fx_70" and .newer != null'
eq "events: pages don't overlap"      "$(jq -s '[.[0].events[].id] - ([.[0].events[].id] - [.[1].events[].id]) | length' "$TMP/ev1.json" "$TMP/ev2.json")" "0"
curl -s "$EV?limit=50&before=$(jq '.older' "$TMP/ev2.json")" > "$TMP/ev3.json"
jt "events: last page has 20, no older" "$TMP/ev3.json" '(.events | length) == 20 and .older == null and .events[19].kind == "fx_1"'
curl -s "$EV?limit=50&after=$(jq '.newer' "$TMP/ev3.json")" > "$TMP/ev2b.json"
eq "events: newer goes back a page"   "$(jq -c '[.events[].id]' "$TMP/ev2b.json")" "$(jq -c '[.events[].id]' "$TMP/ev2.json")"
curl -s "$EV?limit=50&squad=odd" > "$TMP/ev4.json"
jt "events: squad filter"             "$TMP/ev4.json" '(.events | length) == 50 and ([.events[].squad] | unique) == ["odd"] and (.squads | index("even") != null)'
curl -s "$EV?limit=50&hide=fx_120,fx_119" > "$TMP/ev5.json"
jt "events: hide leaves those kinds out" "$TMP/ev5.json" '(.events | length) == 50 and .events[0].kind == "fx_118" and ([.events[].kind] | index("fx_120")) == null'
eq "events: bad hide is 400"          "$(curl -s -o /dev/null -w '%{http_code}' "$EV?hide=x;drop")" "400"
eq "events: bad squad is 400"         "$(curl -s -o /dev/null -w '%{http_code}' "$EV?squad=../x")" "400"
# Colours, the type filter and names (U1, event-log-polish), on rows of squad sq newer than the fx ones:
# three bad rows (a failed request, a failed action, an error toast), a dispatch the loop still places
# (observed_workers) and one it does not.
WTX="0a1b2c3d-0000-4000-8000-00000000d3a0::/x/ds-$LBL-builder-u8-x-sq"
printf '%s\n' 'import { Database } from "bun:sqlite";' \
  'const [, , path, project, wt] = process.argv, d = new Database(path), at = Math.floor(Date.now() / 1000);' \
  'const ev = (kind, payload, member = null) => d.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, ?, ?, ?, ?, ?)", [at, project, "sq", member, kind, JSON.stringify(payload)]);' \
  'ev("squad_state", { cmd: "add-member", args: ["builder", "u8-x", wt, "--owns", "U8"] });' \
  'ev("request_done", { id: 90, kind: "send-role", result: { ok: false, error: "send-worker: no answer from dispatch:ctx_aaaaaaaaaaaa" } });' \
  'ev("request_done", { id: 91, kind: "send-role", result: { ok: true, out: "send-worker: delivered to dispatch:ctx_bbbbbbbbbbbb (msg_1)" } });' \
  'ev("unit_done", { pr: 7 });' \
  'ev("unit_dispatched", { builder_wt: "5cd14104-6de3-4233-8cdf-928e9af9cdcb::/x/ds-" + project + "-builder-u110-only-a-thinker-moves-sq" });' \
  'ev("action_failed", { kind: "member", subject: "member:" + wt, error: "boom" }, wt);' \
  'ev("unit_pr_blocked", { pr: 7, reasons: "conflicting" });' \
  'ev("toast", { level: "error", text: "add-role.sh exit 1" });' \
  'd.run("INSERT INTO observed_workers (project, wt, dispatch_id, observed_at) VALUES (?, ?, ?, ?)", [project, wt, "ctx_aaaaaaaaaaaa", at]);' > "$TMP/evseed.ts"
bun "$TMP/evseed.ts" "$DBR/loop.db" "$LBL" "$WTX"
curl -s "$EV?limit=2&sev=bad" > "$TMP/evb1.json"
jt "events: sev=bad keeps the failed rows" "$TMP/evb1.json" '[.events[].kind] == ["toast", "action_failed"] and ([.events[].sev] | unique) == ["bad"] and .older != null'
curl -s "$EV?limit=2&sev=bad&before=$(jq '.older' "$TMP/evb1.json")" > "$TMP/evb2.json"
jt "events: sev=bad pages inside bad rows" "$TMP/evb2.json" '[.events[].kind] == ["request_done"] and .events[0].payload.result.ok == false and .older == null'
jt "events: a row carries its colour"    <(curl -s "$EV?limit=8&squad=sq") '[.events[] | .kind + "=" + (.sev // "-")] == ["toast=bad", "unit_pr_blocked=wait", "action_failed=bad", "unit_dispatched=ok", "unit_done=ok", "request_done=ok", "request_done=bad", "squad_state=-"] and (.events[1].sev == "wait")'
curl -s "$EV?limit=50&kind=unit_done" > "$TMP/evk.json"
jt "events: kind= keeps that kind, kinds lists the picker" "$TMP/evk.json" '([.events[].kind] | unique) == ["unit_done"] and (.events | length) == 1 and .older == null and (.kinds | index("fx_1") != null and index("toast") != null)'
eq "events: bad sev is 400"           "$(curl -s -o /dev/null -w '%{http_code}' "$EV?sev=nope")" "400"
eq "events: bad kind is 400"          "$(curl -s -o /dev/null -w '%{http_code}' "$EV?kind=x;drop")" "400"
curl -s "$EV?limit=8&squad=sq" > "$TMP/evn.json"
jt "events: names name the worktree and the dispatch the loop places, not the other" "$TMP/evn.json" \
  '.names["'"$WTX"'"] == "builder-u8-x" and .names.ctx_aaaaaaaaaaaa == "builder-u8-x" and (.names | has("ctx_bbbbbbbbbbbb") | not)'
jt "events: the raw payload keeps its ids" "$TMP/evn.json" '(.events[] | select(.kind == "squad_state") | .payload.args[2]) == "'"$WTX"'" and .events[0].payload.text == "add-role.sh exit 1"'
named="$(bun -e 'const fs = require("fs"), h = fs.readFileSync(process.argv[1], "utf8"), cut = (n, end) => { const i = h.indexOf(n); return h.slice(i, h.indexOf(end, i) + end.length); };
  const [evSentence, named, evNamed] = new Function("hhmmss", cut("function evSentence(", "\n}\n") + cut("function named(", "\n}\n") + cut("const evNamed =", "\n};\n") + "return [evSentence, named, evNamed];")(() => "");
  const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  for (const e of b.events) console.log(e.kind + "\t" + named(evSentence(evNamed(e, b.names)), b.names));' "$ROOT/web/board.html" "$TMP/evn.json" 2>&1)"
# A name that already starts with its role is kept whole (review): the slug's own "thinker" is not a cut point.
eq "web board: a dispatched builder whose slug holds a role word keeps its name" "$(printf '%s\n' "$named" | grep '^unit_dispatched' | cut -f2)" "dispatched unit ? to builder-u110-only-a-thinker-moves"
eq "web board: a squad_state add-member names the member, not its worktree id" "$(printf '%s\n' "$named" | grep '^squad_state' | cut -f2)" "sq: add-member builder u8-x builder-u8-x --owns U8"
eq "web board: a dispatch the loop places reads as its member" "$(printf '%s\n' "$named" | grep -m1 'request #90' | cut -f2)" "request #90 (send-role) failed: send-worker: no answer from builder-u8-x"
eq "web board: a dispatch it cannot place reads as an earlier dispatch" "$(printf '%s\n' "$named" | grep -m1 'request #91' | cut -f2)" "request #91 (send-role) done: send-worker: delivered to an earlier dispatch (msg_1)"
eq "web board: no row shows a worktree or dispatch id" "$(printf '%s\n' "$named" | grep -cE '::|ctx_' || true)" "0"
# U2: a dispatch the worktree no longer holds still names its member, from the dispatches history.
printf '%s\n' 'import { Database } from "bun:sqlite";' \
  'const [, , path, project, wt] = process.argv, d = new Database(path), at = Math.floor(Date.now() / 1000);' \
  'd.run("INSERT INTO dispatches (dispatch_id, project, wt, first_seen) VALUES (?, ?, ?, ?)", ["ctx_bbbbbbbbbbbb", project, wt, at]);' > "$TMP/evseed2.ts"
bun "$TMP/evseed2.ts" "$DBR/loop.db" "$LBL" "$WTX"
curl -s "$EV?limit=8&squad=sq" > "$TMP/evn2.json"
jt "events: a dispatch in the history names its member after a re-dispatch (U2)" "$TMP/evn2.json" \
  '.names.ctx_bbbbbbbbbbbb == "builder-u8-x" and .names.ctx_aaaaaaaaaaaa == "builder-u8-x"'
# U2: the history is read before the current holder, and a db without the table reads as before.
printf '%s\n' 'import { Database } from "bun:sqlite";' \
  'const [, , path, project] = process.argv, d = new Database(path), at = Math.floor(Date.now() / 1000);' \
  'd.run("INSERT OR REPLACE INTO dispatches (dispatch_id, project, wt, first_seen) VALUES (?, ?, ?, ?)", ["ctx_aaaaaaaaaaaa", project, "0a1b2c3d-0000-4000-8000-00000000d3a0::/x/ds-" + project + "-thinker-u9-y-sq", at]);' > "$TMP/evseed3.ts"
bun "$TMP/evseed3.ts" "$DBR/loop.db" "$LBL"
curl -s "$EV?limit=8&squad=sq" > "$TMP/evn3.json"
jt "events: the dispatches history wins over the current holder (U2)" "$TMP/evn3.json" '.names.ctx_aaaaaaaaaaaa == "thinker-u9-y-sq"'
printf '%s\n' 'import { Database } from "bun:sqlite";' \
  'const [, , path] = process.argv, d = new Database(path);' \
  'd.run("DROP TABLE dispatches");' > "$TMP/evseed4.ts"
bun "$TMP/evseed4.ts" "$DBR/loop.db"
curl -s "$EV?limit=8&squad=sq" > "$TMP/evn4.json"
jt "events: a db without the dispatches table names as before U2" "$TMP/evn4.json" \
  '.names.ctx_aaaaaaaaaaaa == "builder-u8-x" and (.names | has("ctx_bbbbbbbbbbbb") | not)'
eq "web board: rows painted by sev, a type picker, the modal keeps the raw data" "$(grep -cF 'cls = "ev" + (e.sev ? " " + e.sev : "")' "$ROOT/web/board.html")$(grep -cF '<option value="">all types</option>' "$ROOT/web/board.html")$(grep -cF 'q.set("sev", type.slice(4))' "$ROOT/web/board.html")$(grep -cF 'const full = open && JSON.stringify(open.msg ? { message: open.msg, events: open.evs } : open.fold ? { acting: open.fold.acting, done: open.fold.done } : open, null, 2)' "$ROOT/web/board.html")" "1111"
eq "web board: event log at the bottom, older/newer + squad filter" "$(grep -cF 'fetch("api/events?"' "$ROOT/web/board.html")$(grep -cF 'data-ev="older"' "$ROOT/web/board.html")$(grep -cF 'data-ev="newer"' "$ROOT/web/board.html")$(grep -cF '<option value="">all squads</option>' "$ROOT/web/board.html")" "1111"
# event-log-filters U1: the Studio's rows (squad _studio), rows with no squad, one member, a category,
# the noise switch, and GET /api/events/lists (tests/loop/board-events-api.test.ts has the rest).
printf '%s\n' 'import { Database } from "bun:sqlite";' \
  'const [, , path, project, wt] = process.argv, d = new Database(path), at = Math.floor(Date.now() / 1000);' \
  'const ev = (squad, kind, member = null) => d.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, ?, ?, ?, ?, ?)", [at, project, squad, member, kind, "{}"]);' \
  'ev("_studio", "studio_adopted"); ev(null, "service_started"); ev("sq", "tick_slow", wt); ev("sq", "message_sent", wt);' > "$TMP/evseed5.ts"
bun "$TMP/evseed5.ts" "$DBR/loop.db" "$LBL" "$WTX"
jt "events: squad=_studio reads the Studio's rows" <(curl -s "$EV?squad=_studio") '[.events[].kind] == ["studio_adopted"]'
jt "events: nosquad=1 keeps the rows with no squad" <(curl -s "$EV?nosquad=1&limit=1") '[.events[].kind] == ["service_started"] and .events[0].squad == null'
jt "events: member= keeps one worktree" <(curl -s "$EV?squad=sq&member=$(jq -rn --arg w "$WTX" '$w | @uri')") '[.events[].kind] == ["message_sent", "tick_slow", "action_failed"]'
jt "events: cat= keeps one category, each row carries its cat" <(curl -s "$EV?cat=messages&lists=0") '[.events[].kind] == ["message_sent", "toast"] and .events[0].cat == "messages" and (has("squads") | not)'
jt "events: noise=hide leaves tick_slow out" <(curl -s "$EV?squad=sq&noise=hide&limit=2") '[.events[].kind] == ["message_sent", "toast"]'
jt "events: until= starts at that time" <(curl -s "$EV?until=1&limit=5") '.events == [] and .older == null'
jt "events/lists: squads, the studio flag, crew, cats, noise" <(curl -s "http://127.0.0.1:$PORT/api/events/lists?squad=sq") \
  '(.squads | map(.squad) | index("sq") != null and index("_studio") == null) and .studio == true and (.crew | map(.name) | index("builder-u8-x") != null) and (.cats | map(.key) | .[-1] == "other") and (.noise | index("tick_slow") != null)'
for bad in "squad=../x" "squad=sq&nosquad=1" "cat=nope" "member=x" "nosquad=2" "noise=show" "until=x" "until=5&after=1" "lists=1"; do
  eq "events: $bad is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$EV?$bad")" "400"
done
eq "events: another project is 403 on a project board" "$(curl -s -o /dev/null -w '%{http_code}' "$EV?project=zz-other")" "403"
eq "events/lists: bad squad is 400" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/events/lists?squad=../x")" "400"
# event-log-filters U2: the fixture db is migrated (0047's index), and the squad and crew pages the
# board serves through them hold the same rows as a scan of the table that uses no index.
eq "events: the fixture db has migration 0047's index" "$(dbq "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'events_squad%' ORDER BY name" | jq -c '[.[].name]')" '["events_squad"]'
eq "events: the squad page is the unindexed scan's rows" "$(curl -s "$EV?squad=sq&limit=200" | jq -c '[.events[].id]')" \
  "$(dbq "SELECT id FROM events NOT INDEXED WHERE project = '$LBL' AND squad = 'sq' ORDER BY id DESC" | jq -c '[.[].id]')"
eq "events: the crew page is the unindexed scan's rows" "$(curl -s "$EV?squad=sq&member=$(jq -rn --arg w "$WTX" '$w | @uri')&limit=200" | jq -c '[.events[].id]')" \
  "$(dbq "SELECT id FROM events NOT INDEXED WHERE project = '$LBL' AND squad = 'sq' AND member = '$WTX' ORDER BY id DESC" | jq -c '[.[].id]')"
# event-log-filters U4: a bounded search (q=, its `searched` cursor, one slice of 6 ids a request) and the
# message details of a page (tests/loop/board-events-search.test.ts has the rest). Seeded: a row naming
# #584, 7 rows after it, then a message_sent whose message is delivered and unread.
printf '%s\n' 'import { Database } from "bun:sqlite";' \
  'const [, , path, project] = process.argv, d = new Database(path), at = Math.floor(Date.now() / 1000);' \
  'const ev = (kind, payload) => d.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, ?, ?, ?, ?, ?)", [at, project, "sq", null, kind, JSON.stringify(payload)]);' \
  'ev("toast", { text: "look at PR #584" }); for (let i = 0; i < 7; i++) ev("unit_done", { n: i });' \
  'd.run("INSERT INTO messages (key, project, squad, to_role, to_suffix, from_role, subject, body, sent_at, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["u4-k", project, "sq", "builder", "u8-x", "lead", "u4 handoff", "the body", at, at + 1]);' \
  'ev("message_sent", { key: "u4-k", to: "builder-u8-x", from: "lead", kind: "message", subject: "u4 handoff" });' > "$TMP/evseed6.ts"
bun "$TMP/evseed6.ts" "$DBR/loop.db" "$LBL"
curl -s "$EV?q=%23584" > "$TMP/evq1.json"
jt "events: q= reads one slice back and says how far (searched)" "$TMP/evq1.json" \
  '.events == [] and .searched.more == true and (.searched.to_id | type) == "number" and .older == null and .newer == null'
curl -s "$EV?q=%23584&before=$(jq '.searched.to_id' "$TMP/evq1.json")" > "$TMP/evq2.json"
jt "events: before=<searched.to_id> searches on and finds the older row" "$TMP/evq2.json" \
  '[.events[].kind] == ["toast"] and .events[0].payload.text == "look at PR #584" and .searched.more == true'
eq "events: the two slices are next to each other" "$(jq -s '.[0].searched.to_id - .[1].searched.to_id' "$TMP/evq1.json" "$TMP/evq2.json")" "6"
curl -s "$EV?squad=sq&kind=message_sent&limit=1" > "$TMP/evm.json"
jt "events: a message event names its message, the page carries its status and no body" "$TMP/evm.json" \
  '(.events[0].msgs | length) == 1 and (.messages[(.events[0].msgs[0] | tostring)] | .from == "lead" and .to == "builder-u8-x" and .subject == "u4 handoff" and .delivered_at != null and .read_at == null and (has("body") | not))'
jt "events: an unread message's sent row is wait, and sev=wait finds it" <(curl -s "$EV?squad=sq&sev=wait&limit=1") \
  '.events[0].kind == "message_sent" and .events[0].sev == "wait" and .events[0].payload.key == "u4-k"'
for bad in "q=a&after=1" "q=$(printf 'x%.0s' $(seq 1 101))" "q=a%01b"; do
  eq "events: ${bad:0:20} is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$EV?$bad")" "400"
done
eq "events: an empty q is no search" "$(curl -s "$EV?q=&limit=1" | jq -c 'has("searched")')" "false"

# Every write is one row the loop fulfils: 202 {ok, id}, nothing done yet; ff does it.
U="http://127.0.0.1:$PORT/api/answer"; O="Origin: http://127.0.0.1:$PORT"; CT="Content-Type: application/json"
post(){ curl -s -o "$TMP/post.out" -w '%{http_code}' -X POST "$@"; }
rid(){ jq -r '.id' "$TMP/post.out"; }
reqrow(){ dbq "SELECT kind, member, squad, payload, result, done_at FROM requests WHERE id = $1" | jq -c '.[0] | .payload |= fromjson | .result |= (if . then fromjson else . end)'; }
qrow(){ dbq "SELECT status, answer, answered_via FROM questions WHERE project = '$LBL' AND squad = 'ans' AND id = '$1' ORDER BY seq DESC LIMIT 1" | jq -c '.[0]'; }

# POST /api/answer: the questions row is answered via board at once, and an `answer` request types
# it into the asking agent's terminal (the agent replies + resolves as /ds-q does).
: > "$TMP/poke.log"
eq "answer: 202"                     "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"q7\",\"answer\":\"use B\"}" "$U")" "202"
A7="$(rid)"
eq "answer: the question is answered via board" "$(qrow q7)" '{"status":"answered","answer":"use B","answered_via":"board"}'
eq "answer: an answer request for the card's agent" "$(reqrow "$A7" | jq -c '[.kind, .member, .payload.id, .payload.answer, .done_at]')" '["answer","wTh","q7","use B",null]'
eq "answer: nothing typed before the loop runs" "$(grep -c . "$TMP/poke.log" || true)" "0"
eq "answer: twice is 409"            "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"q7\",\"answer\":\"use B\"}" "$U")" "409"
has "answer: twice says answered"    "$(cat "$TMP/post.out")" "already answered"
eq "answer: no card -> the Lead"     "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"q8\",\"answer\":\"line1\nline2\"}" "$U")" "202"
ff
eq "answer: typed into the card's agent" "$(head -n1 "$TMP/poke.log" | cut -f1)" "wTh"
has "answer: text names the id + answer" "$(head -n1 "$TMP/poke.log" | cut -f2)" "question q7: use B"
eq "answer: twice pokes once"        "$(grep -c 'question q7' "$TMP/poke.log")" "1"
eq "answer: Lead's wt"               "$(grep 'question q8' "$TMP/poke.log" | cut -f1)" "wLd"
has "answer: newlines flattened"     "$(grep 'question q8' "$TMP/poke.log")" "line1 line2"
jt "answer: the request is done"     <(reqrow "$A7") '.done_at != null and .result.ok == true'
eq "answer: unknown id is 409"       "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"nope\",\"answer\":\"x\"}" "$U")" "409"
eq "answer: path in topic is 400"    "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"../ans\",\"id\":\"q9\",\"answer\":\"x\"}" "$U")" "400"
eq "answer: empty answer is 400"     "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"q9\",\"answer\":\"  \"}" "$U")" "400"
# reasked-question-shows-answered U1: two askings share an id (q9: the first answered from the board, the second
# open); the answer names the asking it saw by `since` and answers that row only.
bun -e 'import { Database } from "bun:sqlite"; const d = new Database(process.argv[1]);
  d.run("INSERT INTO questions (project, squad, id, asker, blocking, question, asked_at, status, answer, answered_via, answered_at, doc) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)",
    [process.argv[2], "ans", "q9", "lead", "notes?", Date.parse("2026-10-08T08:00:00Z") / 1000, "answered", "first", "board", 1, "{}"]);' "$DBR/loop.db" "$LBL"
eq "answer since: the first asking's since is 409" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"q9\",\"answer\":\"x\",\"since\":\"2026-10-08T08:00:00Z\"}" "$U")" "409"
has "answer since: 409 says asked again" "$(cat "$TMP/post.out")" "answered or asked again"
eq "answer since: nothing answered by the 409" "$(dbq "SELECT COUNT(*) AS n FROM questions WHERE squad = 'ans' AND id = 'q9' AND status = 'open'" | jq '.[0].n')" "1"
eq "answer since: the open asking's since is 202" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"q9\",\"answer\":\"second\",\"since\":\"2026-10-08T09:00:00Z\"}" "$U")" "202"
eq "answer since: only the open row was answered" "$(dbq "SELECT status, answer FROM questions WHERE squad = 'ans' AND id = 'q9' ORDER BY seq" | jq -c '[.[] | [.status, .answer]] | sort')" '[["answered","first"],["answered","second"]]'
eq "answer since: the first asking's answer is untouched" "$(dbq "SELECT COUNT(*) AS n FROM questions WHERE squad = 'ans' AND id = 'q9' AND answer = 'first'" | jq '.[0].n')" "1"
# A terminal-picker mirror is answered by keystroke, never prose + Enter (that selects the
# highlighted option): an option is its digit with no Enter; free text is the "Type
# something." digit, then the text + Enter.
: > "$TMP/keys.log"; : > "$TMP/seq.log"
eq "picker: option answer is 202"     "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qp1\",\"answer\":\"Red (warm)\"}" "$U")" "202"
jt "picker: the request carries the choices" <(reqrow "$(rid)") '.member == "wTh" and (.payload.choices | map(.label)) == ["Blue","Red (warm)"]'
eq "picker: twice is 409"             "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qp1\",\"answer\":\"Blue\"}" "$U")" "409"
: > "$TMP/ping.log"; ff
eq "picker: option is its digit, in the asker's terminal" "$(cat "$TMP/keys.log")" "$(printf 'wTh\t2')"
eq "picker: option types no prose"    "$(grep -c 'Red' "$TMP/poke.log" || true)" "0"
: > "$TMP/seq.log"
eq "picker: free text is 202"         "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qp2\",\"answer\":\"teal, please\"}" "$U")" "202"
ff
eq "picker: free text = Type-something digit, then the text + Enter" "$(cat "$TMP/seq.log")" "$(printf 'keys\t3\nkeys\tteal, please +enter')"
eq "picker: the text goes to the asker" "$(tail -n1 "$TMP/keys.log")" "$(printf 'wTh\tteal, please')"
: > "$TMP/seq.log"
eq "picker: non-answerable is 409"    "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qp4\",\"answer\":\"Blue\"}" "$U")" "409"
has "picker: non-answerable says terminal" "$(cat "$TMP/post.out")" "answer it in the terminal"
eq "picker: a refusal files nothing"  "$(dbq "SELECT COUNT(*) AS n FROM requests WHERE kind = 'answer' AND json_extract(payload, '\$.id') = 'qp4'" | jq '.[0].n')" "0"
# Keys typed after a picker closed would land in the agent's prompt: the board refuses one whose
# mirror says closed or can't tell, and the loop checks the transcript again before each key.
eq "picker: closed picker is 409"     "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qp3\",\"answer\":\"Blue\"}" "$U")" "409"
has "picker: closed says so"          "$(cat "$TMP/post.out")" "that picker is already closed"
eq "picker: unreadable transcript is 409" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qpu\",\"answer\":\"Blue\"}" "$U")" "409"
has "picker: unreadable says terminal" "$(cat "$TMP/post.out")" "answer it in the terminal"
eq "picker: closed mid-answer is still 202" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qp6\",\"answer\":\"teal\"}" "$U")" "202"
A6="$(rid)"
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_6","content":"answered"}]}}' > "$TMP/keys.close"
: > "$TMP/seq.log"; ff; rm -f "$TMP/keys.close"
eq "picker: closed mid-answer types no text" "$(cat "$TMP/seq.log")" "$(printf 'keys\t3')"
jt "picker: closed mid-answer fails with why" <(reqrow "$A6") '.result.ok == false and (.result.error | test("closed before the text"))'
: > "$TMP/seq.log"
# A press that never lands: the request fails with the reason, and the question opens again.
echo 1 > "$TMP/keys.rc"
eq "picker: keys failing is still 202" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qp5\",\"answer\":\"Blue\"}" "$U")" "202"
A5="$(rid)"; ff
jt "picker: the failed request says why" <(reqrow "$A5") '.done_at != null and .result.ok == false and (.result.error | length > 0)'
eq "picker: a failed press types no text" "$(grep -c '^poke' "$TMP/seq.log" || true)" "0"
eq "picker: the question is open again" "$(qrow qp5 | jq -r .status)" "open"
rm -f "$TMP/keys.rc"
eq "picker: a failed press can be retried" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qp5\",\"answer\":\"Blue\"}" "$U")" "202"
ff
eq "picker: retry pressed option 1"   "$(tail -n1 "$TMP/keys.log")" "$(printf 'wTh\t1')"
eq "picker: the board leaves the squad file alone" "$(jq '[.waiting_on_you[] | select(.source=="picker")] | length' "$SD/ans.json")" "7"
jt "board: picker source passes through" "$TMP/served.json" '.squads[] | select(.topic=="ans") | .questions[] | select(.id=="qp1") | .source=="picker" and .picker_answerable==true'
jt "board: inbox carries picker source"  "$TMP/served.json" '.needs_you[] | select(.id=="qp1") | .source=="picker"'
TX="$(tb "$LBL" 2>/dev/null)"
has "text board: picker says terminal"       "$TX" "answer it in thinker's terminal"
eq "text board: picker shows no suggestion"  "$(printf '%s' "$TX" | grep -c 'suggested: Blue' || true)" "0"
resync   # tb rebuilt loop.db from the fixture files: every question is open again
# GET /api/stream: the event log as server-sent events, from now on (started after the rebuild:
# a new loop.db starts its event ids over). It runs through the write tests below, so it carries
# what the loop did with the board's requests.
curl -sN "http://127.0.0.1:$PORT/api/stream" > "$TMP/sse.txt" 2>/dev/null & SSE=$!
sleep 0.5
# CSRF: a page elsewhere (or a form post) can't answer — Origin must be this board, body must be JSON.
eq "answer: no Origin is 403"        "$(post -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"q9\",\"answer\":\"x\"}" "$U")" "403"
eq "answer: foreign Origin is 403"   "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"q9\",\"answer\":\"x\"}" "$U")" "403"
eq "answer: form post is 415"        "$(post -H "$O" -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=b' "$U")" "415"
eq "answer: GET is 405"              "$(curl -s -o /dev/null -w '%{http_code}' -H "$O" "$U")" "405"
# Control characters (Ctrl-C, Esc) would interrupt the agent: they become spaces.
post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qc\",\"answer\":\"a\u0003b\u001bc\"}" "$U" >/dev/null
ff
has "answer: control chars become spaces" "$(grep 'question qc' "$TMP/poke.log")" "qc: a b c"
# Two overlapping sends (two tabs, a double Enter) file the answer once.
post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qr\",\"answer\":\"x\"}" "$U" >/dev/null & p1=$!
post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"qr\",\"answer\":\"x\"}" "$U" >/dev/null; wait "$p1"
eq "answer: overlapping sends file it once" "$(dbq "SELECT COUNT(*) AS n FROM requests WHERE kind = 'answer' AND json_extract(payload, '\$.id') = 'qr'" | jq '.[0].n')" "1"
eq "answer: no actions.log"          "$([ -e "$DS_STATE_ROOT/$LBL/actions.log" ] && echo yes || echo no)" "no"

# Answered in the terminal (/ds-q, the picker hook): the question leaves the board on the loop's
# next event. Two of them (qa1, qa2) are the fixture for the event log and the past answers.
printf '%s\n' 'import { open } from "../bin/loop/core/store.ts";' 'import { answer } from "../bin/loop/messages/questions.ts";' \
  'const s = open(); for (const [id, a] of [["qa1", "Lumen"], ["qa2", "yes, ship"]]) answer(s, process.argv[2], "ans", id, a, "terminal"); s.close();' > "$ROOT/tests/.zz-answer-$$.ts"
DS_STATE_ROOT="$DBR" bun "$ROOT/tests/.zz-answer-$$.ts" "$LBL"; rm -f "$ROOT/tests/.zz-answer-$$.ts"
sleep 2.5
curl -s "http://127.0.0.1:$PORT/board.json" > "$TMP/qa.json"
jt "terminal answer: gone from the inbox" "$TMP/qa.json" '[.needs_you[] | select(.id=="qa1" or .id=="qa2")] | length == 0'
QA="http://127.0.0.1:$PORT/api/questions"
curl -s "$QA?squad=ans&status=answered&limit=50" > "$TMP/qa1.json"
jt "past answers: newest first, with answer and via" "$TMP/qa1.json" '[.questions[] | select(.id=="qa1" or .id=="qa2") | [.title, .answer, .via]] == [["Ship it","yes, ship","terminal"],["Pick a name","Lumen","terminal"]]'
jt "past answers: the board's answers too" "$TMP/qa1.json" '[.questions[] | select(.id=="qc") | .via] == ["board"]'
curl -s "$QA?squad=ans&status=answered&limit=1" > "$TMP/qa2.json"
jt "past answers: a page of 1 has an older cursor" "$TMP/qa2.json" '(.questions | length) == 1 and .older != null'
curl -s "$QA?squad=ans&status=answered&limit=1&before=$(jq '.older' "$TMP/qa2.json")" > "$TMP/qa3.json"
eq "past answers: before=<seq> is the next one" "$(jq -c '[.questions[].seq]' "$TMP/qa3.json")" "$(jq -c '[.questions[1].seq]' "$TMP/qa1.json")"
eq "past answers: bad squad is 400"   "$(curl -s -o /dev/null -w '%{http_code}' "$QA?squad=../x")" "400"
eq "past answers: open status is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$QA?squad=ans&status=open")" "400"
jt "event log: answered questions with title, answer and via" <(curl -s "$EV?limit=200") '[.events[] | select(.kind=="question_answered" and (.payload.id=="qa1" or .payload.id=="qa2")) | [.payload.title, .payload.answer, .payload.via]] == [["Ship it","yes, ship","terminal"],["Pick a name","Lumen","terminal"]]'
eq "web board: the event log shows title: answer (via)" "$(printf '%s\n' "$sentences" | grep '^question_answered' | cut -f2)" "answered Ship it?: yes (board)"
eq "web board: past answers page through api/questions" "$(grep -cF 'fetch("api/questions?"' "$ROOT/web/board.html")$(grep -cF 'data-q="older"' "$ROOT/web/board.html")" "11"

# U5: GET /api/briefing reads one brief from the documents rows.
resync
BU="http://127.0.0.1:$PORT/api/briefing"
bun -e 'import { Database } from "bun:sqlite"; const d = new Database(process.argv[1]); d.run("INSERT OR REPLACE INTO documents (project, path, mtime, body, observed_at) VALUES (?, ?, 1, ?, 1)", process.argv[2], process.argv[2] + "/briefings/2026-11-12.md", "# Brief 2026-11-12\n\nShipped #409.\n");' "$DBR/loop.db" "$LBL"
eq "U5: briefing for a date is 200" "$(curl -s -o "$TMP/br.json" -w '%{http_code}' "$BU?project=$LBL&date=2026-11-05")" "200"
jt "U5: ... with that brief's markdown" "$TMP/br.json" '.markdown | startswith("# Brief 2026-11-05")'
eq "U5: an unknown date is 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BU?project=$LBL&date=2026-01-01")" "404"
eq "U5: a path-like date is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$BU?project=$LBL&date=../x")" "400"
eq "U5: no project is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$BU?date=2026-11-05")" "400"
rm -rf "$BD"; resync

SQSUM="$(cat "$DS_STATE_ROOT/$LBL/squads"/*.json | cksum)"
# /api/limits (B6): GET lists every key; POST files a `limits` request, and the loop sets/drops it
# through limits.sh (only <state root>/<label>/limits.conf changes, never squad state).
LU="http://127.0.0.1:$PORT/api/limits"
lim(){ DS_STATE_ROOT="$DBR" "$ROOT/bin/commands/limits.sh" show "$LBL" | awk -v k="$1" '$1==k{print $2,$3}'; }
eq "limits: GET is 200"              "$(curl -s -o "$TMP/lim.json" -w '%{http_code}' "$LU?project=$LBL")" "200"
eq "limits: GET returns every key"   "$(jq '.limits | length' "$TMP/lim.json")" "$(grep -cvE '^[[:space:]]*(#|$)' "$ROOT/conventions/limits.conf")"
jt "limits: rows carry source+comment" "$TMP/lim.json" '.limits[0] | has("key") and has("value") and .source=="default" and (.comment|length>0)'
jt "limits: every row has a group"   "$TMP/lim.json" '[.limits[] | select((.group // "") == "")] | length == 0'
jt "limits: groups start with Context & compaction" "$TMP/lim.json" '.groups[0] == "Context & compaction" and (.groups | index("Other") == null)'
jt "limits: env-set compact_idle_min still says env" "$TMP/lim.json" '.limits[] | select(.key=="compact_idle_min") | .source=="env"'
jt "limits: review severities are enums" "$TMP/lim.json" '[.limits[] | select(.key=="review_block_severity" or .key=="review_block_severity_risky") | .allowed] == [["P0","P1","P2","P3"],["P0","P1","P2","P3"]]'
jt "limits: review risk paths use text input" "$TMP/lim.json" '.limits[] | select(.key=="review_risk_paths") | .list==true and .value=="-"'
eq "limits: GET without project is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$LU")" "400"
eq "limits: set is 202"              "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"context_compact\",\"value\":\"120000\"}" "$LU")" "202"
L1="$(rid)"
eq "limits: a limits request row"    "$(reqrow "$L1" | jq -c '[.kind, .payload]')" '["limits",{"key":"context_compact","value":"120000"}]'
eq "limits: nothing changed yet"     "$(lim context_compact)" "150000 default"
# squad-priority U2: the squad menu's Make focus / Clear focus bodies (value is the squad, or null to drop the override)
eq "limits: Make focus is 202"       "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"focus_squad\",\"value\":\"alpha\"}" "$LU")" "202"
LF1="$(rid)"
eq "limits: Make focus row"          "$(reqrow "$LF1" | jq -c '[.kind, .payload]')" '["limits",{"key":"focus_squad","value":"alpha"}]'
eq "limits: a focus override is 202" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"focus_squad\",\"value\":\"-\"}" "$LU")" "202"
ff
eq "limits: Clear focus is 202"      "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"focus_squad\",\"value\":null}" "$LU")" "202"
LF2="$(rid)"
eq "limits: Clear focus row"         "$(reqrow "$LF2" | jq -c '[.kind, .payload.key, .payload.value]')" '["limits","focus_squad",null]'
# ds-feedback-github-issues U8: `feedback` is an off|on select; feedback_repo is an override the board shows but never writes
eq "limits: feedback on is 202" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"feedback\",\"value\":\"on\"}" "$LU")" "202"
LFR="$(rid)"
eq "limits: feedback row"       "$(reqrow "$LFR" | jq -c '[.kind, .payload]')" '["limits",{"key":"feedback","value":"on"}]'
eq "limits: feedback_repo is read-only (400)"  "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"feedback_repo\",\"value\":\"acme/tools\"}" "$LU")" "400"
eq "limits: feedback bad is 400" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"feedback\",\"value\":\"maybe\"}" "$LU")" "400"
eq "limits: enum set is 202"         "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"compact_mode_lead\",\"value\":\"off\"}" "$LU")" "202"
ff
eq "limits: the loop set it"         "$(lim context_compact)" "120000 override"
eq "limits: ... and the enum"        "$(lim compact_mode_lead)" "off override"
jt "limits: the request is done"     <(reqrow "$L1") '.done_at != null and .result.ok == true'
jt "limits: GET shows the override at once" <(curl -s "$LU?project=$LBL") '.limits[] | select(.key=="context_compact") | .value=="120000" and .source=="override"'
eq "limits: the edit wrote no limits.conf (U256)" "$(ls "$DBR/$LBL"/limits.conf "$DS_STATE_ROOT/$LBL"/limits.conf 2>/dev/null)" ""
# U258: the row shows its last change; a second change, then Undo, puts the first value back (3 history rows).
jt "limits: the override shows who changed it" <(curl -s "$LU?project=$LBL") '.limits[] | select(.key=="context_compact") | .changed.by=="board" and .changed.undo==true and .changed.imported==false'
eq "limits: a second change is 202"  "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"context_compact\",\"value\":\"130000\"}" "$LU")" "202"
ff
H2="$(curl -s "$LU?project=$LBL" | jq '.limits[] | select(.key=="context_compact") | .changed.id')"
eq "limits: undo of a stale history id is 409" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"context_compact\",\"undo\":1}" "$LU")" "409"
eq "limits: undo is 202"             "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"context_compact\",\"undo\":$H2}" "$LU")" "202"
ff
eq "limits: undo put the first value back" "$(lim context_compact)" "120000 override"
eq "limits: the key has three history rows" "$(dbq "SELECT COUNT(*) AS n FROM config_history WHERE project = '$LBL' AND key = 'context_compact'" | jq '.[0].n')" "3"
eq "limits: enum bad value is 400"   "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"compact_mode_lead\",\"value\":\"maybe\"}" "$LU")" "400"
eq "limits: bad number is 400"       "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"context_compact\",\"value\":\"-5\"}" "$LU")" "400"
has "limits: bad value says why"     "$(cat "$TMP/post.out")" "whole number"
eq "limits: a list of names is 202"  "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"expected_checks\",\"value\":\"tests,lint\"}" "$LU")" "202"
ff
eq "limits: ... the loop set it"     "$(lim expected_checks)" "tests,lint override"
eq "limits: a name with a space is 400" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"expected_checks\",\"value\":\"a b\"}" "$LU")" "400"
has "limits: ... says why"           "$(cat "$TMP/post.out")" "check names"
eq "limits: risk globs accepted" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"review_risk_paths\",\"value\":\"contracts/*.sol,src/auth/*\"}" "$LU")" "202"
ff
eq "limits: loop writes risk globs" "$(lim review_risk_paths)" 'contracts/*.sol,src/auth/* override'
eq "limits: risk empty element refused" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"review_risk_paths\",\"value\":\"a,,b\"}" "$LU")" "400"
jt "limits: skipped lenses use text input" "$TMP/lim.json" '.limits[] | select(.key=="review_skip_lenses") | .list==true and .value=="-"'
eq "limits: skipped lenses accepted" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"review_skip_lenses\",\"value\":\"security,learnings\"}" "$LU")" "202"
ff
eq "limits: loop writes skipped lenses" "$(lim review_skip_lenses)" 'security,learnings override'
for bad in correctness 'security,correctness-reviewer' 'Security' 'a,,b'; do
  eq "limits: skipped lenses '$bad' refused" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"review_skip_lenses\",\"value\":\"$bad\"}" "$LU")" "400"
done
has "limits: a malformed lens list says why" "$(cat "$TMP/post.out")" "lens names"
post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"review_skip_lenses\",\"value\":\"correctness-reviewer\"}" "$LU" >/dev/null
has "limits: dropping correctness says why" "$(cat "$TMP/post.out")" "cannot drop correctness"
# U9: file-only limits (glob list, close command) show whole as text and are not set from the board.
dbw "INSERT OR REPLACE INTO config (project, file, key, value, observed_at) VALUES ('$LBL', 'limits.conf', 'cleanup_tmp_globs', '/tmp/u9-a-* /tmp/u9-b-*', 1)"  # hand-edited: limits.sh refuses a space list
jt "U9: a file-only limit is flagged, with its whole value" <(curl -s "$LU?project=$LBL") '[.limits[] | select(.key=="cleanup_tmp_globs" or .key=="cleanup_on_close") | .fileOnly] == [true,true] and (.limits[] | select(.key=="cleanup_tmp_globs") | .value=="/tmp/u9-a-* /tmp/u9-b-*" and .source=="override")'
jt "U9: other limits are not file-only" <(curl -s "$LU?project=$LBL") '[.limits[] | select(.key=="context_compact" or .key=="host_tidy") | .fileOnly] == [false,false]'
eq "U9: setting a file-only limit is 400" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"cleanup_tmp_globs\",\"value\":\"/tmp/x-*\"}" "$LU")" "400"
has "U9: ... says where to edit" "$(cat "$TMP/post.out")" "is set with \`ds config export --project $LBL\`"
eq "U9: the close command too" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"cleanup_on_close\",\"value\":\"rm -rf x\"}" "$LU")" "400"
eq "U9: reset of a file-only override is 202" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"cleanup_tmp_globs\",\"value\":null}" "$LU")" "202"
ff
eq "U9: ... and the loop dropped it" "$(lim cleanup_tmp_globs)" "- default"
eq "limits: severity accepted" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"review_block_severity\",\"value\":\"P2\"}" "$LU")" "202"
ff
eq "limits: loop writes severity" "$(lim review_block_severity)" 'P2 override'
eq "limits: invalid severity refused" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"review_block_severity\",\"value\":\"P4\"}" "$LU")" "400"
jt "U5: briefing keys are text with a shape hint" "$TMP/lim.json" '[.limits[] | select(.key=="briefing_time" or .key=="briefing_days") | .allowed==null and .list==false and (.hint|length>0)] == [true,true]'
eq "U5: briefing_time 08:30 is 202" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"briefing_time\",\"value\":\"08:30\"}" "$LU")" "202"
eq "U5: briefing_time 8:30 is 400" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"briefing_time\",\"value\":\"8:30\"}" "$LU")" "400"
eq "U5: briefing_days mon-wed,fri is 202" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"briefing_days\",\"value\":\"mon-wed,fri\"}" "$LU")" "202"
eq "U5: briefing_days funday is 400" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"briefing_days\",\"value\":\"funday\"}" "$LU")" "400"
eq "limits: unknown key is 400"      "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"nope\",\"value\":\"1\"}" "$LU")" "400"
eq "limits: foreign Origin is 403"   "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"context_compact\",\"value\":\"1\"}" "$LU")" "403"
eq "limits: form post is 415"        "$(post -H "$O" -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=b' "$LU")" "415"
eq "limits: reset is 202"            "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"context_compact\",\"value\":null}" "$LU")" "202"
ff
eq "limits: back to default"         "$(lim context_compact)" "150000 default"
eq "limits: reset without override is 409" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"context_compact\",\"value\":null}" "$LU")" "409"
eq "limits: env-set key is 409"      "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"key\":\"compact_idle_min\",\"value\":\"5\"}" "$LU")" "409"
has "limits: env refusal names the var" "$(cat "$TMP/post.out")" "DS_LIMIT_COMPACT_IDLE_MIN"
jt "limits: env row is source env"   <(curl -s "$LU?project=$LBL") '.limits[] | select(.key=="compact_idle_min") | .source=="env" and .value=="7"'
eq "limits: squad state untouched"   "$(cat "$DS_STATE_ROOT/$LBL/squads"/*.json | cksum)" "$SQSUM"

# /api/roles (B8): GET lists the roster with source; POST files a `roles` request, and the loop sets
# or resets it through settings.ts (only the project's roles.conf rows change; no file, U256).
RU="http://127.0.0.1:$PORT/api/roles"
rp(){ post -H "$O" -H "$CT" -d "$1" "$RU"; }
rl(){ DS_STATE_ROOT="$DBR" "$ROOT/bin/commands/roles.sh" list "$LBL" | awk -v r="$1" '$1==r{print $2,$3,$5,$6}'; }
ownroles(){ "$ROOT/bin/ds" --state "$DBR" config export --project "$LBL" | awk '/^#== /{s=($2=="roles.conf");next} s&&NF'; }
eq "roles: GET is 200"               "$(curl -s -o "$TMP/rl.json" -w '%{http_code}' "$RU?project=$LBL")" "200"
eq "roles: GET returns every role"   "$(jq '.roles | length' "$TMP/rl.json")" "$(grep -cvE '^[[:space:]]*(#|$)' "$ROOT/conventions/roles.conf")"
jt "roles: all default at first, with the catalog" "$TMP/rl.json" '([.roles[].source]|all(.=="default")) and ((.catalog[]|select(.model=="muse-spark")|.label)=="Muse · Spark") and (.agents==null)'
eq "roles: GET without project is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$RU")" "400"
eq "roles: set is 202"               "$(rp "{\"project\":\"$LBL\",\"role\":\"builder-standard\",\"agent\":\"claude\",\"model\":\"sonnet\",\"effort\":\"high\",\"spawn\":\"ondemand\",\"fallbacks\":\"claude:opus, muse:muse-spark-1.3\"}")" "202"
eq "roles: a roles request row"      "$(reqrow "$(rid)" | jq -c '[.kind, .payload.role, .payload.fallbacks]')" '["roles","builder-standard","claude:opus,muse:muse-spark-1.3"]'
ff
jt "roles: GET shows the override"   <(curl -s "$RU?project=$LBL") '.roles[] | select(.role=="builder-standard") | .source=="project" and .effort=="high" and .fallbacks=="claude:opus,muse:muse-spark-1.3" and .default.fallbacks=="claude:opus"'
# U267: the project's roles.conf holds only the rows it set; every other role runs the default's.
# U268: the Roles tab lists each role once; a role the file lacks reads "default".
jt "roles: other roles stay default" <(curl -s "$RU?project=$LBL") '[.roles[]|select(.role!="builder-standard")|.source]|all(.=="default")'
eq "roles: roles.sh list shows it"   "$(rl builder-standard)" "claude sonnet high claude:opus,muse:muse-spark-1.3"
eq "roles: unknown role is 400"      "$(rp "{\"project\":\"$LBL\",\"role\":\"nope\",\"agent\":\"claude\",\"model\":\"x\",\"spawn\":\"always\"}")" "400"
eq "roles: bad fallback is 400"      "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"agent\":\"claude\",\"model\":\"opus\",\"spawn\":\"ondemand\",\"fallbacks\":\"opus\"}")" "400"
has "roles: bad fallback says why"   "$(cat "$TMP/post.out")" "agent:model"
eq "roles: set muse + 3-field fallback is 202" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"agent\":\"muse\",\"model\":\"muse-spark-1.3\",\"spawn\":\"ondemand\",\"effort\":\"high\",\"fallbacks\":\"claude:sonnet:low\"}")" "202"
ff
eq "roles: roles.sh list shows muse + fallback effort" "$(rl builder)" "muse muse-spark-1.3 high claude:sonnet:low"
eq "roles: set muse minimal effort is 202" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"agent\":\"muse\",\"model\":\"muse-spark-1.3\",\"spawn\":\"ondemand\",\"effort\":\"minimal\"}")" "202"
ff
eq "roles: roles.sh list shows minimal" "$(rl builder | cut -d' ' -f1-3)" "muse muse-spark-1.3 minimal"
eq "roles: put builder back"         "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"reset\":true}")" "202"
ff
jt "roles: GET carries return and back_up (thinker up, lead stay, builder-review stay)" <(curl -s "$RU?project=$LBL") '([.roles[]|select(.role=="thinker")|.back_up]==[true]) and ([.roles[]|select(.role=="lead")|.back_up]==[false]) and ([.roles[]|select(.role=="builder-review")|.back_up]==[false]) and (.roles[]|select(.role=="thinker")|.default.back_up)==true'
eq "roles: return up is 202"         "$(rp "{\"project\":\"$LBL\",\"role\":\"lead\",\"agent\":\"claude\",\"model\":\"opus\",\"spawn\":\"always\",\"return\":\"up\"}")" "202"
eq "roles: the request carries return" "$(reqrow "$(rid)" | jq -c '[.kind, .payload.role, .payload.return]')" '["roles","lead","up"]'
ff
eq "roles: roles.sh list shows lead up" "$(DS_STATE_ROOT="$DBR" "$ROOT/bin/commands/roles.sh" list "$LBL" | awk '$1=="lead"{print ($0 ~ /up/)}')" "1"
eq "roles: return stay is 202"       "$(rp "{\"project\":\"$LBL\",\"role\":\"lead\",\"agent\":\"claude\",\"model\":\"opus\",\"spawn\":\"always\",\"return\":\"stay\"}")" "202"
ff
eq "roles: bad return is 400"        "$(rp "{\"project\":\"$LBL\",\"role\":\"lead\",\"agent\":\"claude\",\"model\":\"opus\",\"spawn\":\"always\",\"return\":\"maybe\"}")" "400"
eq "roles: return up on an elevate row is 400" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder-review\",\"agent\":\"claude\",\"model\":\"opus\",\"spawn\":\"elevate\",\"return\":\"up\"}")" "400"
has "roles: the elevate refusal names the row" "$(cat "$TMP/post.out")" "builder-review"
eq "roles: return up on studio is 202 (configurable-role-elevation U3)" "$(rp "{\"project\":\"$LBL\",\"role\":\"studio\",\"agent\":\"claude\",\"model\":\"sonnet\",\"spawn\":\"ondemand\",\"return\":\"up\"}")" "202"
ff
eq "roles: roles.sh list shows studio up" "$(DS_STATE_ROOT="$DBR" "$ROOT/bin/commands/roles.sh" list "$LBL" | awk '$1=="studio"{print $8}')" "up"
eq "roles: put studio back"          "$(rp "{\"project\":\"$LBL\",\"role\":\"studio\",\"reset\":true}")" "202"
ff
eq "roles: put lead back"            "$(rp "{\"project\":\"$LBL\",\"role\":\"lead\",\"reset\":true}")" "202"
ff
eq "roles: bad effort is 400"        "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"agent\":\"claude\",\"model\":\"opus\",\"spawn\":\"ondemand\",\"effort\":\"turbo\"}")" "400"
eq "roles: bad spawn is 400"         "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"agent\":\"claude\",\"model\":\"opus\",\"spawn\":\"never\"}")" "400"
eq "roles: bad model is 400"         "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"agent\":\"claude\",\"model\":\"a b;rm\",\"spawn\":\"ondemand\"}")" "400"
eq "roles: foreign Origin is 403"    "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"role\":\"builder\",\"reset\":true}" "$RU")" "403"
# /api/briefing (U1): {markdown, prs} for an older day; an unknown day is 404.
BU="http://127.0.0.1:$PORT/api/briefing"
bun -e 'import { Database } from "bun:sqlite"; const d = new Database(process.argv[1]); d.run("INSERT OR REPLACE INTO documents (project, path, mtime, body, observed_at) VALUES (?, ?, 1, ?, 1)", [process.argv[2], process.argv[2] + "/briefings/2026-11-12.md", "# Brief 2026-11-12\n\nShipped #409.\n"]);' "$DBR/loop.db" "$LBL"
eq "briefing: GET is 200" "$(curl -s -o "$TMP/bg.json" -w '%{http_code}' "$BU?project=$LBL&date=2026-11-12")" "200"
jt "briefing: returns markdown and a prs object" "$TMP/bg.json" '(.markdown | startswith("# Brief 2026-11-12")) and (.prs | type == "object")'
eq "briefing: unknown day is 404" "$(curl -s -o /dev/null -w '%{http_code}' "$BU?project=$LBL&date=2020-01-01")" "404"

# /api/skills (U230): GET lists every role's skills; POST files a `skills` request (required names refused).
SU="http://127.0.0.1:$PORT/api/skills"
sp(){ post -H "$O" -H "$CT" -d "$1" "$SU"; }
eq "skills: GET is 200"              "$(curl -s -o "$TMP/sk.json" -w '%{http_code}' "$SU?project=$LBL")" "200"
jt "skills: every role is listed"    "$TMP/sk.json" '([.roles[].role] | index("builder") != null) and ([.roles[].role] | index("studio") != null) and (.roles[0].summary.saved_tokens != null)'
eq "skills: GET without project is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$SU")" "400"
eq "skills: unknown role is 400"     "$(sp "{\"project\":\"$LBL\",\"role\":\"nope\",\"set\":{\"run\":\"off\"}}")" "400"
eq "skills: unknown skill is 400"    "$(sp "{\"project\":\"$LBL\",\"role\":\"builder\",\"set\":{\"no-such-skill-xyz\":\"off\"}}")" "400"
eq "skills: a lower level for a required skill is 400" "$(sp "{\"project\":\"$LBL\",\"role\":\"builder\",\"set\":{\"compound-engineering:ce-work\":\"off\"}}")" "400"
has "skills: the refusal says required" "$(cat "$TMP/post.out")" "required"
jt "skills: the MCP group lists the servers per role (U283)" "$TMP/sk.json" '(.roles[] | select(.role=="builder") | .mcp | map({(.name): .level}) | add) as $m | $m["mcp:linear-server"]=="off" and $m["mcp:claude-docs"]=="off" and $m["mcp:easel"]=="off" and $m["mcp:context-mode"]=="on" and ((.roles[] | select(.role=="thinker") | .mcp[] | select(.name=="mcp:linear-server") | .level)=="on")'
eq "skills: mcp:linear-server with level name-only is 400" "$(sp "{\"project\":\"$LBL\",\"role\":\"builder\",\"set\":{\"mcp:linear-server\":\"name-only\"}}")" "400"
has "skills: the refusal says on or off" "$(cat "$TMP/post.out")" "on or off"
eq "skills: a required MCP server can't be turned off" "$(sp "{\"project\":\"$LBL\",\"role\":\"builder\",\"set\":{\"mcp:context-mode\":\"off\"}}")" "400"
eq "skills: reset with no edits is 409" "$(sp "{\"project\":\"$LBL\",\"role\":\"builder\",\"reset\":true}")" "409"
eq "skills: foreign Origin is 403"   "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"role\":\"builder\",\"reset\":true}" "$SU")" "403"
# Import / Export in Settings (settings-export-import U3): the export text, the plan, the apply.
bun -e 'import { Database } from "bun:sqlite"; const d = new Database(process.argv[1]); for (const [f, k, v] of [["limits.conf", "hooks_ts", "1"], ["limits.conf", "auto_merge", "merge"], ["limits.conf", "limit_pct", "80"], ["limits.conf", "cleanup_on_close", "rm -rf x"]]) d.run("INSERT OR REPLACE INTO config (project, file, key, value, comment, observed_at) VALUES (?, ?, ?, ?, NULL, 1)", ["importsrc", f, k, v])' "$DBR/loop.db"
IU="http://127.0.0.1:$PORT/api/settings-import"
EU="http://127.0.0.1:$PORT/api/settings-export"
ip(){ post -H "$O" -H "$CT" -d "$2" "$1"; }
eq "import: export is 200" "$(curl -s -D "$TMP/ex.hdr" -o "$TMP/ex.txt" -w '%{http_code}' "$EU?project=importsrc")" "200"
has "import: export starts with the transfer header" "$(head -1 "$TMP/ex.txt")" "#! ds-settings 1 from=importsrc"
has "import: export names the download" "$(cat "$TMP/ex.hdr")" "importsrc-settings.txt"
has "import: export carries the rows" "$(cat "$TMP/ex.txt")" "limit_pct 80"
eq "import: export without project is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$EU")" "400"
eq "import: list is 200" "$(curl -s -o "$TMP/il.json" -w '%{http_code}' "$IU?project=$LBL")" "200"
jt "import: list names the other project, not this one" "$TMP/il.json" '(.projects | index("importsrc") != null) and (.projects | index("'"$LBL"'") == null)'
eq "import: preview is 200" "$(ip "$IU/preview" "{\"project\":\"$LBL\",\"from\":\"importsrc\"}")" "200"
cp "$TMP/post.out" "$TMP/ip.json"
jt "import: hooks_ts reads skipped (unknown key)" "$TMP/ip.json" '.rows[] | select(.key=="hooks_ts") | .action=="skip" and .why=="unknown key" and .can_pick==false'
jt "import: auto_merge is unticked but tickable" "$TMP/ip.json" '.rows[] | select(.key=="auto_merge") | .pick==false and .can_pick==true and .why=="project-specific"'
jt "import: cleanup_on_close is shell only" "$TMP/ip.json" '.rows[] | select(.key=="cleanup_on_close") | .why=="shell only" and .can_pick==false'
eq "import: preview from a text that is no export is 400" "$(ip "$IU/preview" "{\"project\":\"$LBL\",\"text\":\"hello\"}")" "400"
has "import: the 400 names why" "$(cat "$TMP/post.out")" "not a settings export"
eq "import: preview with an unknown section is 400" "$(ip "$IU/preview" "{\"project\":\"$LBL\",\"text\":\"#! ds-settings 1 from=x\\n#== nosuch.conf\\nfoo 1\\n\"}")" "400"
has "import: the 400 names the section" "$(cat "$TMP/post.out")" "nosuch.conf"
eq "import: apply with an unknown section is 400" "$(ip "$IU" "{\"project\":\"$LBL\",\"text\":\"#! ds-settings 1 from=x\\n#== nosuch.conf\\nfoo 1\\n\",\"picks\":[{\"file\":\"limits.conf\",\"key\":\"a\"}]}")" "400"
jt "import: auto_merge's skip row carries the incoming value" "$TMP/ip.json" '.rows[] | select(.key=="auto_merge") | .value=="merge"'
jt "import: hooks_ts carries its raw source text" "$TMP/ip.json" '.rows[] | select(.key=="hooks_ts") | .raw=="1"'
eq "import: preview with both sources is 400" "$(ip "$IU/preview" "{\"project\":\"$LBL\",\"from\":\"importsrc\",\"text\":\"x\"}")" "400"
eq "import: foreign Origin is 403" "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"from\":\"importsrc\",\"picks\":[{\"file\":\"limits.conf\",\"key\":\"limit_pct\"}]}" "$IU")" "403"
eq "import: apply without picks is 400" "$(ip "$IU" "{\"project\":\"$LBL\",\"from\":\"importsrc\",\"picks\":[]}")" "400"
eq "import: apply with a bad file is 400" "$(ip "$IU" "{\"project\":\"$LBL\",\"from\":\"importsrc\",\"picks\":[{\"file\":\"../x\",\"key\":\"a\"}]}")" "400"
eq "import: apply is 202" "$(ip "$IU" "{\"project\":\"$LBL\",\"from\":\"importsrc\",\"picks\":[{\"file\":\"limits.conf\",\"key\":\"limit_pct\",\"expect\":null}]}")" "202"
eq "import: one settings-import request row" "$(bun -e 'import { Database } from "bun:sqlite"; const d = new Database(process.argv[1], { readonly: true }); const r = d.query("SELECT count(*) n, json_extract(payload, \"$.from\") f, project FROM requests WHERE kind = ?").get("settings-import") as any; console.log(r.n, r.f, r.project)' "$DBR/loop.db")" "1 importsrc $LBL"
eq "roles: form post is 415"         "$(post -H "$O" -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=b' "$RU")" "415"
eq "roles: refusals changed nothing" "$(DS_STATE_ROOT="$DBR" "$ROOT/bin/commands/roles.sh" list "$LBL" | awk '$1=="builder"{print $3}')" "opus"
eq "roles: reset without override is 409" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"reset\":true}")" "409"
eq "roles: reset is 202"             "$(rp "{\"project\":\"$LBL\",\"role\":\"builder-standard\",\"reset\":true}")" "202"
ff
eq "roles: reset drops the project's row (U267)" "$(ownroles | awk '$1=="builder-standard"')" ""
eq "roles: back to the default line" "$(rl builder-standard)" "claude sonnet (default) claude:opus"   # the default row (conventions/roles.conf)
jt "roles: reset row is default again" <(curl -s "$RU?project=$LBL") '.roles[] | select(.role=="builder-standard") | .source=="default"'
eq "roles: roster still complete"    "$(DS_STATE_ROOT="$DBR" "$ROOT/bin/commands/roles.sh" list --json "$LBL" | jq '.roles | length')" "$(grep -cvE '^[[:space:]]*(#|$)' "$ROOT/conventions/roles.conf")"
eq "roles: squad state untouched"    "$(cat "$DS_STATE_ROOT/$LBL/squads"/*.json | cksum)" "$SQSUM"

# U124: step plans travel through API request -> roles.sh -> config -> GET.
eq "roles: plan set is 202" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"agent\":\"claude\",\"model\":\"opus\",\"spawn\":\"ondemand\",\"plan\":\"Max\",\"fallbacks\":\"claude:opus:-:Ultra\"}")" "202"
ff
jt "roles: plan and fallback plan persist" <(curl -s "$RU?project=$LBL") '.roles[] | select(.role=="builder") | .plan=="Max" and .fallbacks=="claude:opus:-:Ultra"'
eq "roles: malformed plan refused" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"agent\":\"claude\",\"model\":\"opus\",\"spawn\":\"ondemand\",\"plan\":\"bad plan\"}")" "400"
eq "roles: clear plan is 202" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"agent\":\"claude\",\"model\":\"opus\",\"spawn\":\"ondemand\",\"plan\":\"\"}")" "202"
ff
jt "roles: Any persists" <(curl -s "$RU?project=$LBL") '.roles[] | select(.role=="builder") | .plan==""'
eq "roles: restore after plan checks" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder\",\"reset\":true}")" "202"
ff

# U268: a role the project has no row for lists once, as default (no "missing" rows). Editing it
# files a row (project); reset drops the row (default again). A project with no rows is all default.
# U256: the rows are the only copy; no roles.conf file is written or read.
jt "roles: no own roster is all default" <(curl -s "$RU?project=$LBL") '[.roles[].source]|all(.=="default")'
eq "roles: the board's edits wrote no roles.conf" "$(test -e "$DBR/$LBL/roles.conf" && echo file || echo none)" "none"
jt "roles: a role the roster lacks is listed once, as default" <(curl -s "$RU?project=$LBL") '([.roles[]|select(.role=="builder-hard-babysit")]|length)==1 and (.roles[] | select(.role=="builder-hard-babysit") | .source=="default" and .agent=="claude" and .model=="sonnet" and .spawn=="ondemand" and .default.agent=="claude")'
jt "roles: studio is listed once, as default" <(curl -s "$RU?project=$LBL") '([.roles[]|select(.role=="studio")]|length)==1 and (.roles[]|select(.role=="studio")|.source=="default")'
eq "roles: no row is missing" "$(curl -s "$RU?project=$LBL" | jq -r '[.roles[]|select(.source!="default" and .source!="project")|.role] | join(" ")')" ""
eq "roles: reset of a default row is 409" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder-hard-babysit\",\"reset\":true}")" "409"
eq "roles: editing a default row is 202" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder-hard-babysit\",\"agent\":\"claude\",\"model\":\"sonnet\",\"spawn\":\"ondemand\",\"effort\":\"high\",\"fallbacks\":\"claude:opus\"}")" "202"
eq "roles: an edit files a roles request row" "$(reqrow "$(rid)" | jq -c '[.kind, .payload.role]')" '["roles","builder-hard-babysit"]'
ff
eq "roles: the loop upserted the row" "$(ownroles | awk '$1=="builder-hard-babysit"{print $2,$3,$4,$5}')" "claude sonnet ondemand high"
jt "roles: the edited row is the project's own" <(curl -s "$RU?project=$LBL") '.roles[] | select(.role=="builder-hard-babysit") | .source=="project"'
eq "roles: reset of the project row is 202" "$(rp "{\"project\":\"$LBL\",\"role\":\"builder-hard-babysit\",\"reset\":true}")" "202"
ff
eq "roles: reset dropped the project row" "$(ownroles | grep -c '^builder-hard-babysit')" "0"
jt "roles: the row reads default again" <(curl -s "$RU?project=$LBL") '.roles[] | select(.role=="builder-hard-babysit") | .source=="default"'
eq "roles: a role in no roster is still 400" "$(rp "{\"project\":\"$LBL\",\"role\":\"nope\",\"agent\":\"claude\",\"model\":\"x\",\"spawn\":\"always\"}")" "400"

# POST /api/override: one member's model/account "until done" (an `override` request; the loop
# writes the overrides row pick.ts honours), or back to auto.
OU="http://127.0.0.1:$PORT/api/override"
op(){ post -H "$O" -H "$CT" -d "$1" "$OU"; }
ovr(){ dbq "SELECT model, account, set_by, cleared_at FROM overrides WHERE member = 'wLd' ORDER BY id" | jq -c .; }
eq "override: set is 202"            "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"model\":\"sonnet\"}")" "202"
eq "override: nothing written yet"   "$(ovr)" "[]"
ff
eq "override: the loop wrote the row" "$(ovr | jq -c '[.[] | [.model, .account, .set_by, .cleared_at]]')" '[["sonnet",null,"board",null]]'
sleep 2.1
jt "override: the crew row shows it" <(curl -s "http://127.0.0.1:$PORT/board.json") '.squads[] | select(.topic=="ans") | .members[] | select(.wt=="wLd") | .override.model == "sonnet" and .override.set_by == "board"'
eq "override: account only is 202"   "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"account\":\"work\"}")" "202"
ff
eq "override: a new one replaces it" "$(ovr | jq -c '[.[] | [.model, .account, (.cleared_at != null)]]')" '[["sonnet",null,true],[null,"work",false]]'
eq "override: back to auto is 202"   "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"clear\":true}")" "202"
ff
eq "override: back to auto clears it" "$(ovr | jq '[.[] | select(.cleared_at == null)] | length')" "0"
eq "override: auto again is 409"     "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"clear\":true}")" "409"
eq "override: unknown member is 409" "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wNope\",\"model\":\"sonnet\"}")" "409"
eq "override: nothing to set is 400" "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\"}")" "400"
# U205: the pin carries effort and plan (never with an account); the loop refuses a model nobody lists.
eq "override: plan and account together is 400" "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"model\":\"sonnet\",\"plan\":\"Max\",\"account\":\"work\"}")" "400"
eq "override: model, effort and plan is 202" "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"model\":\"sonnet\",\"effort\":\"low\",\"plan\":\"Max\"}")" "202"
ff
eq "override: the row carries effort and plan" "$(dbq "SELECT model, effort, plan FROM overrides WHERE member = 'wLd' AND cleared_at IS NULL" | jq -c '[.[] | [.model, .effort, .plan]]')" '[["sonnet","low","Max"]]'
eq "override: an unknown model is 202 but the loop fails it" "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"model\":\"sonnet-5.5\"}")" "202"
ff
eq "override: ... and keeps the old pin" "$(dbq "SELECT model FROM overrides WHERE member = 'wLd' AND cleared_at IS NULL" | jq -c '[.[] | .model]')" '["sonnet"]'
eq "override: ... with the message on the request" "$(dbq "SELECT result FROM requests WHERE kind = 'override' ORDER BY id DESC LIMIT 1" | jq -r '.[0].result' | grep -cF "unknown model 'sonnet-5.5': pick one from the list")" "1"
eq "override: clear after the U205 checks" "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"clear\":true}")" "202"
ff
# POST /api/unit (U5): a unit's ⋯ menu. Cancel needs a reason, Release only a held unit, a finished unit
# has neither; each accepted call is one `unit-action` request row, and only one may wait per unit.
UU="http://127.0.0.1:$PORT/api/unit"
up(){ post -H "$O" -H "$CT" -d "$1" "$UU"; }
ur(){ dbq "SELECT payload FROM requests WHERE kind = 'unit-action' ORDER BY id" | jq -c '[.[] | .payload | fromjson | [.action, .slug, (.why // null)]]'; }
eq "unit: cancel without a reason is 400"   "$(up "{\"project\":\"$LBL\",\"topic\":\"uact\",\"slug\":\"ud-open\",\"action\":\"cancel\"}")" "400"
eq "unit: an unknown action is 400"         "$(up "{\"project\":\"$LBL\",\"topic\":\"uact\",\"slug\":\"ud-open\",\"action\":\"burn\"}")" "400"
eq "unit: release of an unheld unit is 409" "$(up "{\"project\":\"$LBL\",\"topic\":\"uact\",\"slug\":\"ud-open\",\"action\":\"release\"}")" "409"
eq "unit: cancel of a done unit is 409"     "$(up "{\"project\":\"$LBL\",\"topic\":\"uact\",\"slug\":\"ue-done\",\"action\":\"cancel\",\"why\":\"x\"}")" "409"
eq "unit: an unknown unit is 409"           "$(up "{\"project\":\"$LBL\",\"topic\":\"uact\",\"slug\":\"nope\",\"action\":\"cancel\",\"why\":\"x\"}")" "409"
eq "unit: the refused calls wrote no request" "$(ur)" "[]"
eq "unit: release of a held unit is 202"    "$(up "{\"project\":\"$LBL\",\"topic\":\"uact\",\"slug\":\"ua-held\",\"action\":\"release\"}")" "202"
eq "unit: cancel with a reason is 202"      "$(up "{\"project\":\"$LBL\",\"topic\":\"uact\",\"slug\":\"ud-open\",\"action\":\"cancel\",\"why\":\"not needed\"}")" "202"
eq "unit: a second one for the same unit is 409" "$(up "{\"project\":\"$LBL\",\"topic\":\"uact\",\"slug\":\"ud-open\",\"action\":\"cancel\",\"why\":\"again\"}")" "409"
eq "unit: one request row each"             "$(ur)" '[["release","ua-held",null],["cancel","ud-open","not needed"]]'
curl -s "http://127.0.0.1:$PORT/board.json" > "$TMP/uact.json"
jt "unit: board.json says which unit is held and who depends on it" "$TMP/uact.json" '.squads[] | select(.topic=="uact") | (.units | map({(.slug): [.held, .dependents]}) | add) as $u | $u["ua-held"] == [true, ["ub-dep","uc-dep"]] and $u["ud-open"] == [false, []] and $u["ue-done"][0] == false and $u["ub-dep"] == [false, ["uc-dep"]]'
resync
# POST /api/plan (hold-cancels-queue-undo-approval U3): "Take back approval". One `plan-revoke` request per approved plan of the squad.
PU="http://127.0.0.1:$PORT/api/plan"
pp(){ post -H "$O" -H "$CT" -d "$1" "$PU"; }
pr_rows(){ dbq "SELECT payload FROM requests WHERE kind = 'plan-revoke' ORDER BY id" | jq -c '[.[] | .payload | fromjson | [.plan, .why, (.keep_started // null)]]'; }
eq "plan: no reason is 400"               "$(pp "{\"project\":\"$LBL\",\"topic\":\"uact\",\"plan\":\"uact-x-plan.md\"}")" "400"
eq "plan: a path is 400"                  "$(pp "{\"project\":\"$LBL\",\"topic\":\"uact\",\"plan\":\"../uact-x-plan.md\",\"why\":\"x\"}")" "400"
eq "plan: another squad's plan is 409"    "$(pp "{\"project\":\"$LBL\",\"topic\":\"uact\",\"plan\":\"ans-x-plan.md\",\"why\":\"x\"}")" "409"
eq "plan: a plan that is not approved is 409" "$(pp "{\"project\":\"$LBL\",\"topic\":\"uact\",\"plan\":\"uact-y-plan.md\",\"why\":\"x\"}")" "409"
eq "plan: the refused calls wrote no request" "$(pr_rows)" "[]"
eq "plan: an approved plan is 202"        "$(pp "{\"project\":\"$LBL\",\"topic\":\"uact\",\"plan\":\"uact-x-plan.md\",\"why\":\"misread ok\",\"keep_started\":true}")" "202"
eq "plan: a second one for the plan is 409" "$(pp "{\"project\":\"$LBL\",\"topic\":\"uact\",\"plan\":\"uact-x-plan.md\",\"why\":\"again\"}")" "409"
eq "plan: one request row"                "$(pr_rows)" '[["uact-x-plan.md","misread ok",true]]'
resync
sleep 2.5   # board.json is cached ~2s
curl -s "http://127.0.0.1:$PORT/board.json" > "$TMP/pact.json"
jt "plan: board.json says which plan is approved" "$TMP/pact.json" '.squads[] | select(.topic=="uact") | (.plans | map({(.name): .approved}) | add) == {"uact-x-plan.md": true, "uact-y-plan.md": false}'
jt "plan: and what taking it back would touch" "$TMP/pact.json" '.squads[] | select(.topic=="uact") | .plans[] | select(.name=="uact-x-plan.md") | .queued == 0 and .started == 0'


# U24: scopes. A squad pin needs no member; an unknown scope is 400; a clear with nothing open is 409; the loop writes the target.
eq "override: unknown scope is 400" "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"scope\":\"galaxy\",\"model\":\"sonnet\"}")" "400"
eq "override: squad clear with none open is 409" "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"scope\":\"squad\",\"clear\":true}")" "409"
eq "override: a squad pin without a member is 202" "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"scope\":\"squad\",\"model\":\"sonnet\"}")" "202"
ff
eq "override: the loop wrote the squad row on its target" "$(dbq "SELECT member, scope, model FROM overrides WHERE scope = 'squad' AND cleared_at IS NULL" | jq -c '[.[] | [.member, .scope, .model]]')" "[[\"$LBL/ans\",\"squad\",\"sonnet\"]]"
eq "override: a project pin needs no topic" "$(op "{\"project\":\"$LBL\",\"scope\":\"project\",\"model\":\"sonnet\"}")" "202"
ff
sleep 2.5   # board.json is cached ~2s
curl -s "http://127.0.0.1:$PORT/board.json" > "$TMP/ovb.json"
jt "override: board.json lists both for Settings and the card" "$TMP/ovb.json" '[.overrides[] | .scope] | sort == ["project","squad"]'
eq "override: project clear is 202" "$(op "{\"project\":\"$LBL\",\"scope\":\"project\",\"clear\":true}")" "202"
eq "override: squad clear is 202" "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"scope\":\"squad\",\"clear\":true}")" "202"
ff
eq "override: both cleared" "$(dbq "SELECT COUNT(*) AS n FROM overrides WHERE scope IN ('squad','project') AND cleared_at IS NULL" | jq '.[0].n')" "0"
# The pin form (web/board.html PinForm): lists, not prompt(); change pin beside auto; the badge shows effort and plan.
pin_fn=$(sed -n '/^function PinForm(/,/^}/p' "$ROOT/web/board.html")
eq "web board: pin form uses ModelPick, an account list, Pin and Cancel" "$(printf '%s' "$pin_fn" | grep -cF '<${ModelPick} catalog=${catalog}')$(printf '%s' "$pin_fn" | grep -cF 'any account')$(printf '%s' "$pin_fn" | grep -cF '>Pin</button>')$(printf '%s' "$pin_fn" | grep -cF '>Cancel</button>')" "1111"
eq "web board: pin form lists roster rows first, accounts of the agent, disabled ones not selectable" "$(printf '%s' "$pin_fn" | grep -cF '...data.catalog]')$(printf '%s' "$pin_fn" | grep -cF 'a.agent === agent')$(printf '%s' "$pin_fn" | grep -cF 'disabled=${a.disabled || a.limited}')" "111"
eq "web board: no prompt() pin, a pinned member shows change pin and auto" "$(grep -cF 'prompt("Model for' "$ROOT/web/board.html")$(grep -cF '>change pin</button>' "$ROOT/web/board.html")$(grep -cF '>auto</button>' "$ROOT/web/board.html")" "011"
# POST /api/account: one `account` request (the loop's fulfiller calls accounts.ts), 202; same-origin JSON only.
AU="http://127.0.0.1:$PORT/api/account"
ap(){ post -H "$O" -H "$CT" -d "$1" "$AU"; }
acr(){ dbq "SELECT kind, project, payload FROM requests WHERE kind = 'account' ORDER BY id" | jq -c '[.[] | [.kind, .project, (.payload | fromjson)]]'; }
HOSTST="$TMP/st11" resync   # the served db knows accounts (st11's accounts.tsv) for these
AC1="$(dbq "SELECT agent, account FROM observed_accounts ORDER BY rowid LIMIT 1" | jq -r '.[0] | .agent + " " + .account')"
AG="${AC1% *}"; AN="${AC1#* }"
eq "account: an account is known"     "$([ -n "$AG" ] && [ "$AG" != "null" ] && echo yes)" "yes"
eq "account: disable is 202"          "$(ap "{\"project\":\"$LBL\",\"agent\":\"$AG\",\"account\":\"$AN\",\"enabled\":false}")" "202"
eq "account: exactly one request row" "$(acr)" "[[\"account\",\"$LBL\",{\"agent\":\"$AG\",\"account\":\"$AN\",\"enabled\":false}]]"
eq "account: foreign Origin is 403"   "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"agent\":\"$AG\",\"account\":\"$AN\",\"enabled\":true}" "$AU")" "403"
eq "account: ... and filed nothing"   "$(acr | jq length)" "1"
eq "account: not JSON is 415"         "$(post -H "$O" -H 'Content-Type: text/plain' -d '{}' "$AU")" "415"
eq "account: enabled must be boolean" "$(ap "{\"project\":\"$LBL\",\"agent\":\"$AG\",\"account\":\"$AN\",\"enabled\":\"no\"}")" "400"
eq "account: unknown account is 409"  "$(ap "{\"project\":\"$LBL\",\"agent\":\"$AG\",\"account\":\"nope-zz\",\"enabled\":false}")" "409"
eq "account: the loop switched it off" "$(ff; dbq "SELECT state FROM accounts WHERE agent = '$AG' AND account = '$AN'" | jq -r '.[0].state')" "disabled"
eq "account: ... and logged the event" "$(dbq "SELECT payload FROM events WHERE kind = 'account_disabled'" | jq -r '.[0].payload | fromjson | .by')" "board"
eq "account: enable is 202"           "$(ap "{\"project\":\"$LBL\",\"agent\":\"$AG\",\"account\":\"$AN\",\"enabled\":true}")" "202"
eq "account: the loop switched it on" "$(ff; dbq "SELECT COALESCE(state, 'on') AS s FROM accounts WHERE agent = '$AG' AND account = '$AN'" | jq -r '.[0].s')" "on"
# POST /api/account-reset (account-free-resets U4): the Use button on one grant. Only a grant the stored
# resets list as usable now, only one open press per account; the server adds the idempotency key. No ff
# here: the fulfiller's runs are tests/loop/fulfil-account-reset.test.ts (and no test reaches a provider).
mkdir -p "$TMP/st13"
RS_A='{"state":"reported","count":2,"grants":[{"id":"g-ok","label":"One full reset","left":1,"total":1,"use_by":1796940000,"refills":["session","weekly"],"usable_now":true},{"id":"g-paused","label":"Paused","left":1,"total":1,"use_by":null,"refills":["weekly_model"],"usable_now":false}]}'
{ printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\tnote\tskills\tplan\tresets\n'
  printf 'claude\tsystem\t72\t-\t41\t-\t-\t%s\tme@example.com\t-\tok\tmax\t%s\n' "$NOW" "$RS_A"
  printf 'claude\tb\t-\t-\t-\t-\t-\t%s\tb@example.com\t-\tok\t-\t-\n' "$NOW"; } > "$TMP/st13/accounts.tsv"
HOSTST="$TMP/st13" resync
RU="http://127.0.0.1:$PORT/api/account-reset"
rp(){ post -H "$O" -H "$CT" -d "$1" "$RU"; }
rr(){ dbq "SELECT project, requested_by, payload FROM requests WHERE kind = 'account-reset' ORDER BY id" | jq -c '[.[] | [.project, .requested_by, (.payload | fromjson)]]'; }
eq "account-reset: the stored resets are read"   "$(dbq "SELECT resets FROM observed_accounts WHERE agent = 'claude' AND account = 'system'" | jq -r '.[0].resets | fromjson | .grants[0].id')" "g-ok"
eq "account-reset: a paused grant is 400"         "$(rp "{\"project\":\"$LBL\",\"agent\":\"claude\",\"account\":\"system\",\"grant\":\"g-paused\"}")" "400"
has "account-reset: ... saying it is not usable"  "$(cat "$TMP/post.out")" "not usable now"
eq "account-reset: an unknown grant is 400"       "$(rp "{\"project\":\"$LBL\",\"agent\":\"claude\",\"account\":\"system\",\"grant\":\"g-zz\"}")" "400"
eq "account-reset: an unknown account is 400"     "$(rp "{\"project\":\"$LBL\",\"agent\":\"claude\",\"account\":\"nope-zz\",\"grant\":\"g-ok\"}")" "400"
eq "account-reset: no resets read is 400"         "$(rp "{\"project\":\"$LBL\",\"agent\":\"claude\",\"account\":\"b\",\"grant\":\"g-ok\"}")" "400"
eq "account-reset: no grant is 400"               "$(rp "{\"project\":\"$LBL\",\"agent\":\"claude\",\"account\":\"system\"}")" "400"
eq "account-reset: foreign Origin is 403"         "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"agent\":\"claude\",\"account\":\"system\",\"grant\":\"g-ok\"}" "$RU")" "403"
eq "account-reset: not JSON is 415"               "$(post -H "$O" -H 'Content-Type: text/plain' -d '{}' "$RU")" "415"
eq "account-reset: none of those filed a request" "$(rr | jq length)" "0"
eq "account-reset: a usable grant is 202"         "$(rp "{\"project\":\"$LBL\",\"agent\":\"claude\",\"account\":\"system\",\"grant\":\"g-ok\"}")" "202"
eq "account-reset: one request, by the board"     "$(rr | jq -c '[.[] | [.[0], .[1], .[2].agent, .[2].account, .[2].grant]]')" "[[\"$LBL\",\"board\",\"claude\",\"system\",\"g-ok\"]]"
eq "account-reset: the server made the key"       "$(rr | jq -r '.[0][2].key' | grep -cE '^[0-9a-f-]{36}$')" "1"
eq "account-reset: a second press while open is 409" "$(rp "{\"project\":\"$LBL\",\"agent\":\"claude\",\"account\":\"system\",\"grant\":\"g-ok\"}")" "409"
has "account-reset: ... saying one is in progress" "$(cat "$TMP/post.out")" "already in progress"
eq "account-reset: ... and filed nothing"         "$(rr | jq length)" "1"
# U7: a paused project still files the press but the answer says `queued`; a running one does not.
eq "account-reset: a running project's answer has no queued" "$(grep -c queued "$TMP/post.out" || true)" "0"
DS_STATE_ROOT="$DBR" bun -e 'import {open} from "'"$ROOT"'/bin/loop/core/store.ts"; const s=open(); s.db.run("UPDATE requests SET done_at = 1 WHERE kind = ?", ["account-reset"]); s.upsert("pause_intents",{scope:"project",project:process.argv[1],squad:"",role:"",suffix:"",source:"manual"},{generation:"g",requested_at:1}); s.close();' "$LBL"
eq "account-reset: a paused project's press is 202"  "$(rp "{\"project\":\"$LBL\",\"agent\":\"claude\",\"account\":\"system\",\"grant\":\"g-ok\"}")" "202"
has "account-reset: ... saying it is queued"          "$(cat "$TMP/post.out")" '"queued":true'
eq "account-reset: ... and filed one more request"    "$(rr | jq length)" "2"
eq "account-reset: a second press while paused is 409" "$(rp "{\"project\":\"$LBL\",\"agent\":\"claude\",\"account\":\"system\",\"grant\":\"g-ok\"}")" "409"
DS_STATE_ROOT="$DBR" bun -e 'import {open} from "'"$ROOT"'/bin/loop/core/store.ts"; const s=open(); s.db.run("DELETE FROM pause_intents WHERE scope = ?", ["project"]); s.close();'
eq "web board: the Use button posts api/account-reset after a confirm" "$(grep -cF 'post("api/account-reset"' "$ROOT/web/board.html")$(sed -n '/^async function useReset(/,/^}/p' "$ROOT/web/board.html" | grep -cF 'This cannot be undone.')" "11"

# POST /api/leftover-remove (archive-leftovers U4): a Leftovers box's Remove files one `leftover-remove` request
# for a leftover the squad names; 404 for none, 409 with one open, 400 for a body that is no JSON or bad fields.
# The fulfiller's runs are tests/loop/leftover-remove-button.test.ts.
LT="$(dbq "SELECT topic FROM squads WHERE project = '$LBL' ORDER BY topic LIMIT 1" | jq -r '.[0].topic')"
dbw "UPDATE squads SET doc = json_set(doc, '\$.leftovers', json('[{\"wt\":\"wt-left::/x/lf\",\"path\":\"/x/lf\",\"branch\":\"work\"}]')) WHERE project = '$LBL' AND topic = '$LT'"
LU2="http://127.0.0.1:$PORT/api/leftover-remove"
lp(){ post -H "$O" -H "$CT" -d "$1" "$LU2"; }
lr(){ dbq "SELECT project, squad, requested_by, payload FROM requests WHERE kind = 'leftover-remove' ORDER BY id" | jq -c '[.[] | [.project, .squad, .requested_by, (.payload | fromjson)]]'; }
eq "leftover-remove: not JSON is 400"              "$(post -H "$O" -H "$CT" -d 'not json' "$LU2")" "400"
eq "leftover-remove: a bad fingerprint is 400"     "$(lp "{\"project\":\"$LBL\",\"topic\":\"$LT\",\"wt\":\"wt-left::/x/lf\",\"fingerprint\":\"; rm\"}")" "400"
eq "leftover-remove: no such leftover is 404"      "$(lp "{\"project\":\"$LBL\",\"topic\":\"$LT\",\"wt\":\"wt-nope\"}")" "404"
eq "leftover-remove: no such squad is 404"         "$(lp "{\"project\":\"$LBL\",\"topic\":\"zz-none\",\"wt\":\"wt-left::/x/lf\"}")" "404"
eq "leftover-remove: none of those filed a request" "$(lr | jq length)" "0"
eq "leftover-remove: a leftover is 202"            "$(lp "{\"project\":\"$LBL\",\"topic\":\"$LT\",\"wt\":\"wt-left::/x/lf\",\"fingerprint\":\"0123456789abcdef01234567\"}")" "202"
eq "leftover-remove: one request, by the board"    "$(lr)" "[[\"$LBL\",\"$LT\",\"board\",{\"wt\":\"wt-left::/x/lf\",\"fingerprint\":\"0123456789abcdef01234567\"}]]"
eq "leftover-remove: a second press while open is 409" "$(lp "{\"project\":\"$LBL\",\"topic\":\"$LT\",\"wt\":\"wt-left::/x/lf\"}")" "409"
eq "leftover-remove: ... and filed nothing"        "$(lr | jq length)" "1"
resync
eq "override: bad model is 400"      "$(op "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"model\":\"a b;rm\"}")" "400"
eq "override: foreign Origin is 403" "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"clear\":true}" "$OU")" "403"
eq "web board: crew rows pin and unpin (+ the Pins tab clear)" "$(grep -cF 'post("api/override"' "$ROOT/web/board.html")$(grep -cF '{ clear: true }' "$ROOT/web/board.html")" "21"
# Crew row cleanup: the row keeps its state (the ⚑ override badge) and reaches every action
# (pin/auto, Restart, Pause/Resume role, Wait for dependencies) only through one ⋯ menu.
ovr_line=$(grep -F '<span class="ovr">' "$ROOT/web/board.html")
menu_fn=$(sed -n '/^function MemberActions(/,/^}/p' "$ROOT/web/board.html")
eq "web board: crew row renders one actions-menu trigger" "$(grep -cF '<span class="ovr">' "$ROOT/web/board.html")$(printf '%s' "$ovr_line" | grep -cF '<${MemberActions} s=${s} m=${m}')$(printf '%s' "$menu_fn" | grep -cF 'aria-haspopup="menu"')" "111"
eq "web board: the actions menu has its ARIA" "$(printf '%s' "$menu_fn" | grep -cF 'aria-expanded=${open ? "true" : "false"} aria-label=${"Actions for " + m.label}')$(printf '%s' "$menu_fn" | grep -cF 'role="menu"')" "11"
eq "web board: crew row has no action buttons of its own" "$(printf '%s' "$ovr_line" | grep -cE 'RestartMember|PauseControls|PinForm|clear: true|class="btn')" "0"
eq "web board: pin, auto, Restart, Pause/Resume and Wait live in the menu" "$(for s in '<${PinForm} s=${s} m=${m}' '{ clear: true }' '<${RestartMember} s=${s} m=${m}' '<${PauseControls} target=${{ scope: "member"' 'wait=${onWait}'; do printf '%s' "$menu_fn" | grep -cF "$s"; done | tr -d '\n')" "11111"
eq "web board: the override badge stays in the row" "$(printf '%s' "$ovr_line" | grep -cF 'class="badge pin"')" "1"
eq "web board: the menu closes on a choice, outside click, Escape and focus leaving" "$(printf '%s' "$menu_fn" | grep -cE 'e.target.closest\("button,a"\)) close|addEventListener\("pointerdown", away\)|e.key === "Escape"\) close|onBlur=.*e.relatedTarget && !wrap.current.contains\(e.relatedTarget\)\) close')" "4"
eq "web board: a closed menu is hidden, and a row with no actions gets no menu" "$(grep -cF '.amenu[hidden]{display:none}' "$ROOT/web/board.html")$(printf '%s' "$menu_fn" | grep -cF 'if (!m.override && !m.wt && !pausable && !links.length) return null')" "11"
eq "web board: the wide action column is only for a crew with a pinned member" "$(grep -cF '"box crew" + (s.members.some((m) => m.override) ? " pinned" : "")' "$ROOT/web/board.html")$(grep -cF '.crew.pinned .m{grid-template-columns:14px minmax(0,1.2fr) 64px 72px 80px minmax(0,1.6fr) minmax(0,1fr) 72px minmax(0,220px)}' "$ROOT/web/board.html")" "11"
eq "web board: crew plan badge is its own chip, not the .plan link style" "$(grep -cF 'class="badge plan"' "$ROOT/web/board.html")$(grep -cF 'class="badge acct-plan"' "$ROOT/web/board.html")" "01"
eq "web board: crew action column fits the ⋯ button" "$(grep -cF 'minmax(0,380px)' "$ROOT/web/board.html")$(grep -cF 'minmax(0,1fr) 72px 32px}' "$ROOT/web/board.html")" "01"

# A project alert: first in the Needs-you list, on no squad, and dismissed by answering it (a
# `dismiss` request: the loop runs alerts.sh resolve on <state root>/<label>/alerts.json).
curl -s "http://127.0.0.1:$PORT/board.json" > "$TMP/alerts.json"
jt "alert: first in needs_you, kind studio"   "$TMP/alerts.json" '.needs_you[0] | .kind=="studio" and .squad=="_studio" and .id=="sweep-studio.ctx-1"'
jt "alert: a lone ack option is when, no choice"  "$TMP/alerts.json" '.needs_you[0] | .choices == [] and .when == "done — I compacted the Studio"'
jt "alert: counted, and on no squad"          "$TMP/alerts.json" '.studio_alerts | length == 1 and ([.. | objects | select(.id? == "sweep-studio.ctx-1")] | length) >= 1'
eq "alert: dismiss unknown id is 409"         "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"_studio\",\"id\":\"nope\",\"answer\":\"x\"}" "$U")" "409"
eq "alert: dismiss is 202"                    "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"_studio\",\"id\":\"sweep-studio.ctx-1\",\"answer\":\"done\"}" "$U")" "202"
eq "alert: a dismiss request row"             "$(reqrow "$(rid)" | jq -c '[.kind, .payload.id]')" '["dismiss","sweep-studio.ctx-1"]'
eq "alert: the dismiss carries the answer (U264: only \"move it\" approves a Studio move)" "$(reqrow "$(rid)" | jq -r '.payload.answer')" "done"
eq "alert: dismissing twice is 409"           "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"_studio\",\"id\":\"sweep-studio.ctx-1\",\"answer\":\"done\"}" "$U")" "409"
ff
eq "alert: gone from alerts.json"             "$(jq '.alerts | length' "$DBR/$LBL/alerts.json")" "0"
sleep 2.1
jt "alert: gone from the board"               <(curl -s "http://127.0.0.1:$PORT/board.json") '[.needs_you[] | select(.squad=="_studio")] | length == 0'
eq "alert: dismissed is 409"                  "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"_studio\",\"id\":\"sweep-studio.ctx-1\",\"answer\":\"done\"}" "$U")" "409"
# U165: a Studio alert dismisses with one click — an empty answer is accepted for _studio only.
printf '{"alerts":[{"id":"sweep-studio.ctx-2","asker":"sweep","blocking":false,"question":"second alert","since":"2026-10-08T09:00:00Z"}]}' > "$DBR/$LBL/alerts.json"
DS_STATE_ROOT="$DBR" bun -e 'import { open } from "'"$ROOT"'/bin/loop/core/store.ts"; const s = open(); const a = {id:"sweep-studio.ctx-2",asker:"sweep",blocking:false,question:"second alert",since:"2026-10-08T09:00:00Z"}; s.upsert("observed_alerts", {project: process.argv[1], id: a.id}, {doc: JSON.stringify(a), observed_at: Math.floor(Date.now() / 1000)}); s.close();' "$LBL"
eq "alert: empty dismiss is 202"            "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"_studio\",\"id\":\"sweep-studio.ctx-2\",\"answer\":\"\"}" "$U")" "202"
eq "alert: an empty dismiss request row"    "$(reqrow "$(rid)" | jq -c '[.kind, .payload.id]')" '["dismiss","sweep-studio.ctx-2"]'
eq "alert: empty answer to an agent question is still 400" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"q9\",\"answer\":\"\"}" "$U")" "400"
ff
eq "alert: empty-dismissed gone from alerts.json" "$(jq '.alerts | length' "$DBR/$LBL/alerts.json")" "0"
sleep 2.1
jt "alert: empty-dismissed gone from the board" <(curl -s "http://127.0.0.1:$PORT/board.json") '[.needs_you[] | select(.squad=="_studio")] | length == 0'

# U1: a Red-PR card (a loop note) lands in loop_notes and on its squad, not in needs_you or the count;
# a self-healing card inside its grace period is in neither; the page shows the closed toggle row.
DS_STATE_ROOT="$DBR" bun -e 'import { open } from "'"$ROOT"'/bin/loop/core/store.ts"; const s = open(); const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
for (const a of [{id:"loop-rca_wt-1",asker:"loop",title:"ans · lead: Red PR still blocked",question:"PR 5 is red",squad:"ans",since:"2026-10-08T09:00:00Z"},
  {id:"loop-member_x-1",asker:"loop",title:"ans · lead: Agent broken",kind:"agent_broken",question:"it broke",squad:"ans",since:now}])
  s.upsert("observed_alerts", {project: process.argv[1], id: a.id}, {doc: JSON.stringify(a), observed_at: Math.floor(Date.now() / 1000)}); s.close();' "$LBL"
sleep 2.1
curl -s "http://127.0.0.1:$PORT/board.json" > "$TMP/notes.json"
jt "U1: the Red-PR card is a loop note" "$TMP/notes.json" '[.loop_notes[] | select(.id=="loop-rca_wt-1")] | length == 1'
jt "U1: the loop note is not in needs_you" "$TMP/notes.json" '[.needs_you[] | select(.squad=="_studio")] | length == 0'
jt "U1: a card in its grace period is in neither" "$TMP/notes.json" '[.loop_notes[], .needs_you[]] | all(.id != "loop-member_x-1")'
jt "U1: the loop note is on its squad" "$TMP/notes.json" '.squads[] | select(.topic=="ans") | [.notes[].id] == ["loop-rca_wt-1"]'
jt "U1: needs_count counts asks only" "$TMP/notes.json" '.needs_count == ([.needs_you[] | select(.kind != "approval")] | length) and (.studio_alerts | length) == 0'
eq "web board: Loop notes (N) is a closed toggle row after the Needs-you asks, hidden at 0" "$(grep -cF 'loop note${notes.length === 1 ? "" : "s"}' "$ROOT/web/board.html")$(grep -cF 'if (notes.length === 0) return null' "$ROOT/web/board.html")$(grep -cF 'useState(() => lstore.get("b:notes", false) === true)' "$ROOT/web/board.html")" "111"
eq "web board: Dismiss all stops its click and dismisses every note shown" "$(grep -cF 'e.stopPropagation(); dismiss(shown)' "$ROOT/web/board.html")$(grep -cF 'send(n.project, "_studio", n.id, "")' "$ROOT/web/board.html")" "11"
# U6: Dismiss all handles each note on its own: a 409 counts as dismissed, another error is counted, the rest still go.
sed -n '/^async function dismissEach/,/^}/p' "$ROOT/web/board.html" > "$TMP/dismiss-each.js"
cat > "$TMP/dismiss-each.test.js" <<'JS'
const sentQ = new Map(); const hhmmss = () => "00:00:00"; const sendAnswer = async () => {};
JS
cat "$TMP/dismiss-each.js" >> "$TMP/dismiss-each.test.js"
cat >> "$TMP/dismiss-each.test.js" <<'JS'
const notes = [1, 2, 3].map((i) => ({ project: "p", id: "n" + i }));
const err = (status, m) => Object.assign(new Error(m), { status });
const run = async (fail) => { sentQ.clear(); const posted = [];
  const r = await dismissEach(notes, async (_p, _t, id) => { posted.push(id); if (fail[id]) throw fail[id]; sentQ.set("p/_studio/" + id, "x"); });
  return JSON.stringify({ posted, hidden: [...sentQ.keys()].sort(), failed: r.failed, last: r.last }); };
console.log(await run({ n2: err(409, "not open") }));
console.log(await run({ n2: err(500, "boom") }));
JS
out="$(bun "$TMP/dismiss-each.test.js" 2>&1)"
eq "U6: Dismiss all posts all three and hides all three when the second answers 409" "$(sed -n 1p <<<"$out")" '{"posted":["n1","n2","n3"],"hidden":["p/_studio/n1","p/_studio/n2","p/_studio/n3"],"failed":0,"last":""}'
eq "U6: Dismiss all with a 500 hides the other two and counts 1 not dismissed" "$(sed -n 2p <<<"$out")" '{"posted":["n1","n2","n3"],"hidden":["p/_studio/n1","p/_studio/n3"],"failed":1,"last":"boom"}'
eq "U6: post() carries the HTTP status on its error" "$(grep -cF '{ status: r.status }' "$ROOT/web/board.html")" "1"

# U2: a Studio card (ask or note) carries its squad, its PR from `ref` and one allowed action; an unknown action is dropped.
DS_STATE_ROOT="$DBR" bun -e 'import { open } from "'"$ROOT"'/bin/loop/core/store.ts"; const s = open();
for (const a of [{id:"loop-u2-note",asker:"loop",title:"ans · lead: Red PR still blocked",question:"PR #7 is red",squad:"ans",ref:"acme/widgets#7",act:{action:"close",topic:"ans",label:"Close squad"},since:"2026-10-08T09:00:00Z"},
  {id:"loop-u2-bad",asker:"loop",title:"ans · lead: Poke unanswered",question:"no answer",squad:"ans",act:{action:"rm-rf",topic:"ans",label:"Boom"},since:"2026-10-08T09:00:00Z"},
  {id:"loop-u2-ask",asker:"loop",title:"ans · lead: Agent broken",kind:"agent_broken",question:"it broke",squad:"ans",since:"2026-10-08T09:00:00Z"}])
  s.upsert("observed_alerts", {project: process.argv[1], id: a.id}, {doc: JSON.stringify(a), observed_at: Math.floor(Date.now() / 1000)}); s.close();' "$LBL"
sleep 2.1
curl -s "http://127.0.0.1:$PORT/board.json" > "$TMP/u2.json"
jt "U2: a note carries its PR from ref" "$TMP/u2.json" '[.loop_notes[] | select(.id=="loop-u2-note")][0].pr.num == "7"'
jt "U2: a note carries its allowed action" "$TMP/u2.json" '[.loop_notes[] | select(.id=="loop-u2-note")][0].act == {action:"close",topic:"ans",label:"Close squad"}'
jt "U2: an unknown action is dropped" "$TMP/u2.json" '[.loop_notes[] | select(.id=="loop-u2-bad")][0].act == null'
jt "U2: a Studio ask carries its squad for Show squad" "$TMP/u2.json" '[.needs_you[] | select(.id=="loop-u2-ask")][0] | .card_squad == "ans" and has("repo_slug") and has("pr") and has("act")'
eq "web board: a loop note shows its text and why under a title without the squad prefix" "$(grep -cF 'class="lndet">${linkedQ(n.text, n.repo_slug)}' "$ROOT/web/board.html")$(grep -cF 'const noteTitle' "$ROOT/web/board.html")$(grep -cF 'squads.length > 1' "$ROOT/web/board.html")" "211"
eq "web board: Show squad on a Studio card, the PR chip and the action button" "$(grep -cF 'n.card_squad' "$ROOT/web/board.html")$(grep -cF 'function ActBtn' "$ROOT/web/board.html")$(grep -cF 'onShow(n.project, n.squad)' "$ROOT/web/board.html")" "311"

# POST /api/request files a `studio` request; the loop writes it out for the Studio as
# <state root>/<label>/requests/_studio/board-<action>[-<topic>]-<id>.txt, which the Studio's watch
# tick shows and runs. The server itself runs nothing.
R="http://127.0.0.1:$PORT/api/request"; RD="$DBR/$LBL/requests/_studio"
req(){ post -H "$O" -H "$CT" -d "$1" "$R"; }
eq "request: close is 202"           "$(req "{\"project\":\"$LBL\",\"action\":\"close\",\"topic\":\"ans\"}")" "202"
C1="$(rid)"
eq "request: a studio request row"   "$(reqrow "$C1" | jq -c '[.kind, .squad, .payload.action, .payload.line]')" '["studio","ans","close","board: the operator asks you to run: /ds-close-squad ans"]'
eq "request: same one queued is 409" "$(req "{\"project\":\"$LBL\",\"action\":\"close\",\"topic\":\"ans\"}")" "409"
sleep 2.1
jt "board: a queued request is listed" <(curl -s "http://127.0.0.1:$PORT/board.json") '[.requests[] | select(.file=="(queued)") | .text] | index("board: the operator asks you to run: /ds-close-squad ans") != null'
ff
eq "request: the loop wrote the file" "$(cat "$RD/board-close-ans-$C1.txt" 2>/dev/null)" "board: the operator asks you to run: /ds-close-squad ans"
eq "request: same one filed is 409"  "$(req "{\"project\":\"$LBL\",\"action\":\"close\",\"topic\":\"ans\"}")" "409"
sleep 2.1
jt "board: the filed request is listed" <(curl -s "http://127.0.0.1:$PORT/board.json") "[.requests[] | select(.file==\"board-close-ans-$C1.txt\") | .text] == [\"board: the operator asks you to run: /ds-close-squad ans\"]"
eq "request: restart a role"         "$(req "{\"project\":\"$LBL\",\"action\":\"restart\",\"topic\":\"ans\",\"role\":\"lead\"}")" "202"
eq "request: suspend"                "$(req "{\"project\":\"$LBL\",\"action\":\"suspend\",\"topic\":\"ans\"}")" "202"
eq "request: resume"                 "$(req "{\"project\":\"$LBL\",\"action\":\"resume\",\"topic\":\"ans\"}")" "202"
eq "request: reload (no topic)"      "$(req "{\"project\":\"$LBL\",\"action\":\"reload\"}")" "202"
eq "request: update (no topic)"      "$(req "{\"project\":\"$LBL\",\"action\":\"update\"}")" "202"
eq "request: a second update is 409" "$(req "{\"project\":\"$LBL\",\"action\":\"update\"}")" "409"
eq "request: update with a topic is 400" "$(req "{\"project\":\"$LBL\",\"action\":\"update\",\"topic\":\"ans\"}")" "400"
eq "request: start with a brief"     "$(req "{\"project\":\"$LBL\",\"action\":\"start\",\"text\":\"fix the\nlogin bug\"}")" "202"
eq "request: start twice is fine"    "$(req "{\"project\":\"$LBL\",\"action\":\"start\",\"text\":\"another\"}")" "202"
# A pending request for squad "ans-2" must not block the same action on squad "ans" (and back).
eq "request: other squad pending"    "$(req "{\"project\":\"$LBL\",\"action\":\"close\",\"topic\":\"ans-2\"}")" "202"
ff
has "request: restart command"       "$(cat "$RD"/board-restart-ans-*.txt 2>/dev/null)" "/ds-restart $LBL --topic ans --role lead"
has "request: restore suspended command" "$(cat "$RD"/board-resume-ans-*.txt 2>/dev/null)" "/ds-resume --suspended $LBL ans"
has "request: suspend command"       "$(cat "$RD"/board-suspend-ans-*.txt 2>/dev/null)" "/ds-suspend ans"
has "request: reload command"        "$(cat "$RD"/board-reload-*.txt 2>/dev/null)" "/ds-reload $LBL"
has "request: update command"        "$(cat "$RD"/board-update-*.txt 2>/dev/null)" "/ds-update $LBL"
has "request: start command"         "$(cat "$RD"/board-start-*.txt 2>/dev/null)" "/ds-start-squad --repo $LBL --framing-file $DBR/$LBL/framings/board-start-"
eq "request: the brief is in its file, newlines kept" "$(for f in "$DBR/$LBL"/framings/board-start-*.md; do cat "$f"; echo '#'; done | tr '\n' '|' | sed 's/#|/#\n/g' | sort | tr -d '\n')" "another#fix the|login bug#"
eq "request: two starts, two files"  "$(find "$RD" -name 'board-start-*.txt' | wc -l | tr -d ' ')" "2"
has "request: other squad's file"    "$(cat "$RD"/board-close-ans-2-*.txt 2>/dev/null)" "/ds-close-squad ans-2"
rm -f "$RD"/board-close-ans-2-*.txt "$RD/board-close-ans-$C1.txt"
# U9: the Start dialog's backend reaches /ds-start-squad as --backend; an unknown one is 400.
rm -f "$RD"/board-start-*.txt
eq "request: start on a backend"     "$(req "{\"project\":\"$LBL\",\"action\":\"start\",\"text\":\"on tmux\",\"backend\":\"tmux\"}")" "202"
eq "request: unknown backend is 400" "$(req "{\"project\":\"$LBL\",\"action\":\"start\",\"text\":\"x\",\"backend\":\"screen\"}")" "400"
ff
has "request: start passes backend"  "$(cat "$RD"/board-start-*.txt 2>/dev/null)" "/ds-start-squad --repo $LBL --backend tmux --framing-file $DBR/$LBL/framings/board-start-"
rm -f "$RD"/board-start-*.txt
DS_STATE_ROOT="$DBR" bun -e 'import { open } from "'"$ROOT"'/bin/loop/core/store.ts"; import { doneRequests } from "'"$ROOT"'/bin/loop/db/import-json.ts"; const s = open(); doneRequests(s, s.root, process.argv[1]); s.close();' "$LBL"
eq "request: done once the Studio removed the file" "$(req "{\"project\":\"$LBL\",\"action\":\"close\",\"topic\":\"ans\"}")" "202"
eq "request: start without brief"    "$(req "{\"project\":\"$LBL\",\"action\":\"start\"}")" "400"
eq "request: unknown action"         "$(req "{\"project\":\"$LBL\",\"action\":\"rm-rf\",\"topic\":\"ans\"}")" "400"
eq "request: close needs a topic"    "$(req "{\"project\":\"$LBL\",\"action\":\"close\"}")" "400"
eq "request: unknown squad is 409"   "$(req "{\"project\":\"$LBL\",\"action\":\"close\",\"topic\":\"nope\"}")" "409"
eq "request: bad role is 400"        "$(req "{\"project\":\"$LBL\",\"action\":\"restart\",\"topic\":\"ans\",\"role\":\"x;y\"}")" "400"
eq "request: built-in name is 400"   "$(req "{\"project\":\"$LBL\",\"action\":\"constructor\",\"topic\":\"ans\"}")" "400"
eq "request: foreign Origin is 403"  "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"action\":\"reload\"}" "$R")" "403"
tmpn=0; for t in "$RD"/*.tmp; do [ -e "$t" ] && tmpn=$((tmpn+1)); done
eq "request: atomic write leaves no .tmp behind" "$tmpn" "0"

# One Builder restart is queued for the loop, with a double click refused while it is open.
BR="http://127.0.0.1:$PORT/api/restart"
br(){ post -H "$O" -H "$CT" -d "$1" "$BR"; }
# The dedicated fixture has one Builder and one Lead.
eq "restart: Builder is accepted" "$(br "{\"project\":\"$LBL\",\"topic\":\"board-builders\",\"wt\":\"wtBp\"}")" "202"
eq "restart: writes restart_at (U153)" "$(dbq "SELECT restart_mode || '/' || restart_by AS v FROM members WHERE wt='wtBp' AND squad='board-builders' ORDER BY id DESC LIMIT 1" | jq -r '.[0].v')" "now/board"
eq "restart: double click is refused" "$(br "{\"project\":\"$LBL\",\"topic\":\"board-builders\",\"wt\":\"wtBp\"}")" "409"
eq "restart: double click files none" "$(dbq "SELECT COUNT(*) AS n FROM requests WHERE kind='run-switch' AND member='wtBp'" | jq '.[0].n')" "0"
for spec in 'lead wLd' 'thinker wTh' 'tester wTester' 'reviewer wReviewer' 'researcher wResearcher'; do
  read -r role wt <<< "$spec"
  eq "restart: $role is accepted" "$(br "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"$wt\",\"role\":\"$role\"}")" "202"
  eq "restart: $role writes its restart wish" "$(dbq "SELECT restart_by AS v FROM members WHERE wt='$wt' ORDER BY id DESC LIMIT 1" | jq -r '.[0].v')" "board"
  eq "restart: $role double click is refused" "$(br "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"$wt\",\"role\":\"$role\"}")" "409"
done
eq "restart: role mismatch is refused" "$(br "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"role\":\"builder\"}")" "409"
eq "restart: unknown role is 400" "$(br "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\",\"role\":\"unknown\"}")" "400"
eq "restart: foreign Origin is 403" "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wLd\"}" "$BR")" "403"
for role in lead thinker builder tester reviewer researcher; do
  case "$role" in lead) wt=wLd; topic=ans ;; thinker) wt=wTh; topic=ans ;; builder) wt=wtBp; topic=board-builders ;; tester) wt=wTester; topic=ans ;; reviewer) wt=wReviewer; topic=ans ;; researcher) wt=wResearcher; topic=ans ;; esac
  eq "restart: pause $role is accepted" "$(post -H "$O" -H "$CT" -d "{\"scope\":\"member\",\"project\":\"$LBL\",\"topic\":\"$topic\",\"wt\":\"$wt\"}" "http://127.0.0.1:$PORT/api/pause")" "200"
  eq "restart: paused $role is refused" "$(br "{\"project\":\"$LBL\",\"topic\":\"$topic\",\"wt\":\"$wt\",\"role\":\"$role\"}")" "409"
  has "restart: paused $role explains Resume" "$(cat "$TMP/post.out")" "use Resume"
  eq "restart: resume $role is accepted" "$(post -H "$O" -H "$CT" -d "{\"scope\":\"member\",\"project\":\"$LBL\",\"topic\":\"$topic\",\"wt\":\"$wt\"}" "http://127.0.0.1:$PORT/api/resume")" "200"
done
DS_STATE_ROOT="$DBR" bun -e 'import {open} from "'"$ROOT"'/bin/loop/core/store.ts"; const s=open(); s.db.run("UPDATE members SET restart_at=NULL"); s.db.run("DELETE FROM pause_members"); s.close();'
# U6: a paused member that is gone (cancelled unit) no longer blocks a squad restart; a live paused one does.
DS_STATE_ROOT="$DBR" bun -e 'import {open} from "'"$ROOT"'/bin/loop/core/store.ts"; const s=open(); const k={project:process.argv[1],squad:"board-builders",role:"builder",suffix:"cancelled"};
  s.upsert("members",k,{wt:"wtGone",status:"gone",want:"gone",observed_at:1,updated_at:1});
  s.upsert("pause_intents",{scope:"member",...k,source:"manual"},{generation:"g",requested_at:1}); s.close();' "$LBL"
eq "restart: a squad with only a gone paused member is accepted" "$(req "{\"project\":\"$LBL\",\"action\":\"restart\",\"topic\":\"board-builders\"}")" "202"
eq "restart: a live paused member still blocks the squad restart" "$(post -H "$O" -H "$CT" -d "{\"scope\":\"member\",\"project\":\"$LBL\",\"topic\":\"board-builders\",\"wt\":\"wtBp\"}" "http://127.0.0.1:$PORT/api/pause")" "200"
eq "restart: squad restart with a live paused member is 409" "$(req "{\"project\":\"$LBL\",\"action\":\"restart\",\"topic\":\"board-builders\"}")" "409"
DS_STATE_ROOT="$DBR" bun -e 'import {open} from "'"$ROOT"'/bin/loop/core/store.ts"; const s=open(); s.db.run("DELETE FROM pause_members"); s.db.run("UPDATE pause_intents SET cleared_at=1"); s.close();'
eq "restart: a suspended squad is refused" "$(br "{\"project\":\"$LBL\",\"topic\":\"board-builders-suspended\",\"wt\":\"wtBp\"}")" "409"
has "restart: a suspended squad says why" "$(cat "$TMP/post.out")" "this squad is suspended"
eq "restart: a closed squad is refused" "$(br "{\"project\":\"$LBL\",\"topic\":\"board-builders-closed\",\"wt\":\"wtBp\"}")" "409"
has "restart: a closed squad says why" "$(cat "$TMP/post.out")" "this squad is closed"
eq "restart: a done squad's member is accepted" "$(br "{\"project\":\"$LBL\",\"topic\":\"board-builders-done\",\"wt\":\"wtBp\"}")" "202"
eq "restart: a done squad writes the restart wish" "$(dbq "SELECT restart_by AS v FROM members WHERE wt='wtBp' AND squad='board-builders-done' ORDER BY id DESC LIMIT 1" | jq -r '.[0].v')" "board"
# This route test leaves the actual restart to the fulfiller tests.

# POST /api/focus is gone (no jumps from the board).
eq "focus: route is gone (POST -> 405)"       "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\",\"id\":\"q7\"}" "http://127.0.0.1:$PORT/api/focus")" "405"

# POST /api/poke files a `poke` request: the loop types a wake-up line into the squad's Lead (what
# the stall banner's button does).
P="http://127.0.0.1:$PORT/api/poke"; : > "$TMP/poke.log"
eq "poke: 202"                        "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\"}" "$P")" "202"
eq "poke: a poke request for the Lead" "$(reqrow "$(rid)" | jq -c '[.kind, .member]')" '["poke","wLd"]'
ff
eq "poke: typed into the Lead"        "$(cut -f1 "$TMP/poke.log")" "wLd"
has "poke: says it's the board"       "$(cut -f2 "$TMP/poke.log")" "dev-studio board: the operator pinged you"
eq "poke: unknown squad is 409"       "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"nope\"}" "$P")" "409"
eq "poke: foreign Origin is 403"      "$(post -H 'Origin: http://evil.example' -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\"}" "$P")" "403"
echo 1 > "$TMP/poke.rc"
eq "poke: Lead unreachable is still 202" "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"topic\":\"ans\"}" "$P")" "202"
PK="$(rid)"; ff
jt "poke: the failed request says why" <(reqrow "$PK") '.done_at != null and .result.ok == false and (.result.error | length > 0)'
rm -f "$TMP/poke.rc"

# U278: each crew member carries its unread count (from the message rows), GET /api/messages lists a member's
# messages newest first, and neither the board nor the View marks anything read.
dbw "INSERT INTO messages (key, project, squad, to_role, to_suffix, from_role, subject, body, needs_reply, sent_at, read_at) VALUES
  ('m1', '$LBL', 'ans', 'thinker', '', 'lead', 'first', 'one', 0, 100, NULL),
  ('m2', '$LBL', 'ans', 'thinker', '', 'lead', 'second', 'two', 1, 200, NULL),
  ('m3', '$LBL', 'ans', 'thinker', '', 'lead', 'old', 'three', 0, 50, 60),
  ('m4', '$LBL', 'ans', 'lead', '', 'thinker', 'answered?', 'four', 1, 300, 310)"
MS="http://127.0.0.1:$PORT/api/messages"; mq(){ curl -s -o "$TMP/msg.out" -w '%{http_code}' "$MS?project=$LBL&topic=$1${2:+&wt=$2}"; }
curl -s "http://127.0.0.1:$PORT/board.json" > "$TMP/mb1.json"
eq "messages: a member with 2 unread is badged 2" "$(jq -c '[.squads[] | select(.topic == "ans") | .members[] | select(.role == "thinker") | .unread]' "$TMP/mb1.json")" "[2]"
eq "messages: a member with none has 0 (no badge)" "$(jq -c '[.squads[] | select(.topic == "ans") | .members[] | select(.role == "tester") | .unread]' "$TMP/mb1.json")" "[0]"
eq "messages: an unanswered needs-reply message is counted" "$(jq -c '[.squads[] | select(.topic == "ans") | .members[] | select(.role == "thinker") | .reply_due]' "$TMP/mb1.json")" "[1]"
eq "messages: the squad totals" "$(jq -c '[.squads[] | select(.topic == "ans") | .messages]' "$TMP/mb1.json")" '[{"unread":2,"reply_due":2,"ended":0}]'
eq "messages: View a member is 200" "$(mq ans wTh)" "200"
jt "messages: newest first with sender, subject, body, times and the reply flag" "$TMP/msg.out" '.unread == 2 and ([.messages[].subject] == ["second","first","old"]) and .messages[0].from == "lead" and .messages[0].body == "two" and .messages[0].sent_at == 200 and .messages[0].read_at == null and .messages[0].reply_due == true and .messages[2].read_at == 60'
eq "messages: View the squad lists all four" "$(mq ans)$(jq -c '.messages | length' "$TMP/msg.out")" "2004"
eq "messages: View an unknown member is 404" "$(mq ans nope)" "404"
# unread-counts-mismatch U1: open=1 returns exactly the unread and waiting rows, each with its state and how long it waited.
curl -s -o "$TMP/msg.out" "$MS?project=$LBL&topic=ans&open=1"
eq "messages: open=1 rows are the rows the header counts" "$(jq -c '[(.messages | length), (.messages | map(select(.state == "unread" or .state == "waiting")) | length), (.messages | map(select(.waited_s == null)) | length)]' "$TMP/msg.out")" "[$(jq -c '(.messages | length)' "$TMP/msg.out"),$(jq -c '(.messages | length)' "$TMP/msg.out"),0]"
eq "messages: View without a topic is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$MS?project=$LBL")" "400"
curl -s "http://127.0.0.1:$PORT/board.json" > "$TMP/mb2.json"
eq "messages: viewing changed no count" "$(jq -c '[.squads[] | select(.topic == "ans") | .members[] | [.role, .unread, .reply_due]] | sort' "$TMP/mb2.json")" "$(jq -c '[.squads[] | select(.topic == "ans") | .members[] | [.role, .unread, .reply_due]] | sort' "$TMP/mb1.json")"
eq "messages: viewing marked nothing read" "$(dbq "SELECT COUNT(*) AS n FROM messages WHERE read_at IS NOT NULL" | jq '.[0].n')" "2"

# crew-terminal-access U3: GET /api/chat reads one live member's turns (observed_chat) and its last chats;
# POST /api/chat files one `chat` request with the member and squad on the row. board.json carries no turns.
C="http://127.0.0.1:$PORT/api/chat"; cq(){ curl -s -o "$TMP/chat.out" -w '%{http_code}' "$C?project=$LBL&topic=$1&wt=$2"; }
dbw "INSERT INTO observed_chat (project, wt, agent, source, path, read_to, size, turns, updated_at) VALUES
  ('$LBL', 'wTh', 'claude', 'transcript', '/x.jsonl', 10, 10, '[{\"role\":\"user\",\"text\":\"hi\",\"at\":1},{\"role\":\"assistant\",\"text\":\"<script>x</script> reading\",\"at\":2},{\"role\":\"assistant\",\"tool\":\"Read\",\"text\":\"Read plan.md\",\"at\":3}]', 5),
  ('$LBL', 'wTester', 'muse', 'screen', NULL, NULL, NULL, '[{\"role\":\"screen\",\"text\":\"$ make test\",\"at\":null}]', 6)"
dbw "INSERT INTO members (project, squad, role, wt, status, observed_at, updated_at) VALUES ('$LBL', '_studio', 'studio', 'wStudio', 'running', 1, 1)"
eq "chat: GET a known member is 200"   "$(cq ans wTh)" "200"
jt "chat: its turns, agent and source" "$TMP/chat.out" '.agent == "claude" and .source == "transcript" and (.turns | length) == 3 and .turns[2].tool == "Read" and .sends == []'
eq "chat: a muse member's screen tail" "$(cq ans wTester)$(jq -c '[.source, .turns[0].role]' "$TMP/chat.out")" '200["screen","screen"]'
# crew-terminal-access U5: `working` is the member's observed state, for the panel's "Working…" line.
dbw "INSERT INTO observed_workers (project, wt, state, observed_at) VALUES ('$LBL', 'wTh', 'idle', 1) ON CONFLICT(project, wt) DO UPDATE SET state = 'idle', gone_at = NULL"
eq "chat: an idle member is not working" "$(cq ans wTh)$(jq -c '.working' "$TMP/chat.out")" "200false"
dbw "UPDATE observed_workers SET state = 'working' WHERE project = '$LBL' AND wt = 'wTh'"
eq "chat: a member mid-turn is working" "$(cq ans wTh)$(jq -c '.working' "$TMP/chat.out")" "200true"
dbw "UPDATE observed_workers SET state = 'idle' WHERE project = '$LBL' AND wt = 'wTh'"
# chat-role-switcher U1: `crew` is the squad's live members in the Crew box's order, each with its mail counts and the
# time of its newest assistant text turn (null without one or on a screen tail); `[]` for the Studio.
jt "chat: crew lists the live members with counts" <(cq ans wTh >/dev/null; cat "$TMP/chat.out") '(.crew | length) >= 1 and ([.crew[] | has("wt","label","role","unread","reply_due","reply_at")] | all) and ((.crew[] | select(.wt == "wTh") | .reply_at) == 2)'
jt "chat: a screen-tail member's reply_at is null" <(cq ans wTh >/dev/null; cat "$TMP/chat.out") '([.crew[] | select(.wt == "wTester") | .reply_at] | all(. == null))'
jt "chat: the Studio has no crew" <(cq _studio wStudio >/dev/null; cat "$TMP/chat.out") '.crew == []'
dbw "UPDATE members SET status = 'gone' WHERE project = '$LBL' AND squad = 'ans' AND wt = 'wTester'"
jt "chat: a gone member is left out of crew" <(cq ans wTh >/dev/null; cat "$TMP/chat.out") '([.crew[] | select(.wt == "wTester")] | length) == 0'
dbw "UPDATE members SET status = 'running' WHERE project = '$LBL' AND squad = 'ans' AND wt = 'wTester'"
eq "chat: GET an unknown member is 404" "$(cq ans nope)" "404"
eq "chat: GET a member of another squad is 404" "$(cq board-builders wTh)" "404"
eq "chat: GET without wt is 400"       "$(curl -s -o /dev/null -w '%{http_code}' "$C?project=$LBL&topic=ans")" "400"
eq "chat: GET the Studio is 200"       "$(cq _studio wStudio)" "200"
eq "chat: GET a Studio that is not this one is 404" "$(cq _studio wTh)" "404"
eq "chat: board.json has no turns"     "$(curl -s "http://127.0.0.1:$PORT/board.json" | jq -c '[.. | objects | has("turns")] | any')" "false"
cbody(){ jq -nc --arg p "$LBL" --arg t "${3:-ans}" --arg w "$1" --arg x "$2" '{project: $p, topic: $t, wt: $w, text: $x}'; }
crows(){ dbq "SELECT COUNT(*) AS n FROM requests WHERE kind = 'chat'" | jq '.[0].n'; }
N0=$(crows)
eq "chat: POST one line is 202"        "$(post -H "$O" -H "$CT" -d "$(cbody wTh '  look at the flaky test  ')" "$C")" "202"
CH=$(rid)
eq "chat: one chat row with member and squad" "$(reqrow "$CH" | jq -c '[.kind, .member, .squad, .payload.text, .payload.via]')" '["chat","wTh","ans","look at the flaky test","board"]'
eq "chat: requested by the board"      "$(dbq "SELECT requested_by FROM requests WHERE id = $CH" | jq -r '.[0].requested_by')" "board"
eq "chat: the GET lists it queued"     "$(cq ans wTh)$(jq -c '.sends | map([.id, .state, .text])' "$TMP/chat.out")" "200[[$CH,\"queued\",\"look at the flaky test\"]]"
dbw "UPDATE requests SET result = '{\"state\":\"queued\",\"why\":\"working\"}' WHERE id = $CH"
eq "chat: queued shows the loop's why"  "$(cq ans wTh)$(jq -r '.sends[0].why' "$TMP/chat.out")" "200working"
dbw "INSERT INTO deliveries (id, project, squad, member, kind, text, request, tries, state, at) VALUES (9001, '$LBL', 'ans', 'wTh', 'chat', 'x', $CH, 1, 'accepted', 1)"
dbw "UPDATE requests SET done_at = 2, result = '{\"ok\":true,\"state\":\"sent\",\"delivered\":\"accepted\",\"delivery\":9001}' WHERE id = $CH"
eq "chat: then sent"                   "$(cq ans wTh)$(jq -r '.sends[0].state' "$TMP/chat.out")" "200sent"
dbw "UPDATE deliveries SET state = 'verified' WHERE id = 9001"
eq "chat: then turn started once the delivery is verified" "$(cq ans wTh)$(jq -r '.sends[0].state' "$TMP/chat.out")" "200turn started"
# crew-terminal-access U5: a send's text is redacted as its transcript turn is (built here, never committed).
tok="ghp_$(printf 'Ab1%.0s' {1..12})"
eq "chat: POST with a token is 202"   "$(post -H "$O" -H "$CT" -d "$(cbody wTh "the token is $tok")" "$C")" "202"
eq "chat: the GET shows the send redacted" "$(cq ans wTh)$(jq -r '.sends[-1].text' "$TMP/chat.out")$(grep -c "$tok" "$TMP/chat.out")" "200the token is [redacted]0"
eq "chat: POST to the Studio is 202"   "$(post -H "$O" -H "$CT" -d "$(cbody wStudio 'hello studio' _studio)" "$C")" "202"
eq "chat: a Studio chat row"           "$(reqrow "$(rid)" | jq -c '[.member, .squad]')" '["wStudio","_studio"]'
N1=$(crows)
eq "chat: foreign Origin is 403"       "$(post -H 'Origin: http://evil.example' -H "$CT" -d "$(cbody wTh hi)" "$C")" "403"
eq "chat: not JSON is 415"             "$(post -H "$O" -H 'Content-Type: text/plain' -d "$(cbody wTh hi)" "$C")" "415"
eq "chat: a control character is 400"  "$(post -H "$O" -H "$CT" -d "$(cbody wTh "$(printf 'a\ab')")" "$C")" "400"
eq "chat: an escape character is 400"  "$(post -H "$O" -H "$CT" -d "$(cbody wTh "$(printf 'a\033[2Jb')")" "$C")" "400"
eq "chat: blank is 400"                "$(post -H "$O" -H "$CT" -d "$(cbody wTh '   ')" "$C")" "400"
eq "chat: 2001 characters are 400"     "$(post -H "$O" -H "$CT" -d "$(cbody wTh "$(head -c 2001 /dev/zero | tr '\0' x)")" "$C")" "400"
eq "chat: 2000 characters are fine"    "$(post -H "$O" -H "$CT" -d "$(cbody wTh "$(printf 'é%.0s' $(seq 2000))")" "$C")" "202"
N1=$((N1 + 1))
# board chat U19: a message may span lines (CR LF and CR read as LF) and hold tabs; the loop pastes it whole.
eq "chat: two lines with a tab are 202" "$(post -H "$O" -H "$CT" -d "$(cbody wTh "$(printf 'one\r\n\ttwo\rthree')")" "$C")" "202"
eq "chat: kept with its line breaks"   "$(reqrow "$(rid)" | jq -c '.payload.text')" '"one\n\ttwo\nthree"'
N1=$((N1 + 1))
eq "chat: an unknown member is 404"    "$(post -H "$O" -H "$CT" -d "$(cbody nope hi)" "$C")" "404"
eq "chat: a bad squad name is 400"     "$(post -H "$O" -H "$CT" -d "$(cbody wTh hi '../x')" "$C")" "400"
dbw "UPDATE members SET want = 'gone' WHERE project = '$LBL' AND wt = 'wReviewer'"
eq "chat: a gone member is 404"        "$(post -H "$O" -H "$CT" -d "$(cbody wReviewer hi)" "$C")" "404"
eq "chat: pause the researcher"        "$(post -H "$O" -H "$CT" -d "{\"scope\":\"member\",\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wResearcher\"}" "http://127.0.0.1:$PORT/api/pause")" "200"
eq "chat: a paused member is 409"      "$(post -H "$O" -H "$CT" -d "$(cbody wResearcher hi)" "$C")" "409"
eq "chat: no refused POST wrote a row" "$(crows)" "$N1"
eq "chat: rows written: three, the 2000-char one and the multi-line one" "$((N1 - N0))" "5"
# studio-chat-queued-busy U4: /api/chat-cancel and /api/chat-now name an open chat request; a send carries its age and clock.
CX="http://127.0.0.1:$PORT/api/chat-cancel"; CN="http://127.0.0.1:$PORT/api/chat-now"
cid(){ jq -nc --arg p "$LBL" --argjson i "$1" '{project: $p, id: $i}'; }
TK=$(dbq "SELECT id FROM requests WHERE kind = 'chat' AND member = 'wTh' AND done_at IS NULL ORDER BY id LIMIT 1" | jq '.[0].id')
dbw "UPDATE requests SET created_at = CAST(strftime('%s','now') AS INTEGER) - 420, result = '{\"state\":\"queued\",\"why\":\"busy: working\",\"since\":'||(CAST(strftime('%s','now') AS INTEGER) - 400)||'}' WHERE id = $TK"
jt "chat: a queued send has age, clock and first" <(cq ans wTh >/dev/null; cat "$TMP/chat.out") "(.sends[] | select(.id == $TK)) | .state == \"queued\" and .age_s >= 420 and .failing == false and .now == false and .first == true and (.gives_up_at > 0)"
jt "chat: a queued send behind another has no clock and is not first" <(cq ans wTh >/dev/null; cat "$TMP/chat.out") "([.sends[] | select(.state == \"queued\" and .id != $TK)] | all(.first == false))"
NQ=$(dbq "SELECT COUNT(*) AS n FROM requests WHERE kind IN ('chat-cancel','chat-now')" | jq '.[0].n')
eq "chat-now: an open chat is 202"      "$(post -H "$O" -H "$CT" -d "$(cid "$TK")" "$CN")" "202"
eq "chat-now: its row names the chat"   "$(reqrow "$(rid)" | jq -c '[.kind, .member, .squad, .payload.chat]')" "[\"chat-now\",\"wTh\",\"ans\",$TK]"
eq "chat-cancel: an open chat is 202"   "$(post -H "$O" -H "$CT" -d "$(cid "$TK")" "$CX")" "202"
eq "chat-cancel: its row names the chat" "$(reqrow "$(rid)" | jq -c '[.kind, .payload.chat]')" "[\"chat-cancel\",$TK]"
eq "chat-cancel: a typed chat is 409"   "$(post -H "$O" -H "$CT" -d "$(cid "$CH")" "$CX")" "409"
eq "chat-now: a typed chat is 409"      "$(post -H "$O" -H "$CT" -d "$(cid "$CH")" "$CN")" "409"
eq "chat-now: no such request is 404"   "$(post -H "$O" -H "$CT" -d "$(cid 99999)" "$CN")" "404"
eq "chat-now: a bad id is 400"          "$(post -H "$O" -H "$CT" -d "{\"project\":\"$LBL\",\"id\":\"x\"}" "$CN")" "400"
# chat-multiline-send-fails U2: the limit's error text names the rule, a failed send is dismissed (the loop marks it), a queued one is not.
CDM="http://127.0.0.1:$PORT/api/chat-dismiss"
eq "chat: 2001 names its length"       "$(curl -s -H "$O" -H "$CT" -d "$(cbody wTh "$(head -c 2001 /dev/zero | tr '\0' x)")" "$C" | jq -r .error)" "a chat is at most 2000 characters; this one has 2001"
eq "chat: a bell names its line"       "$(curl -s -H "$O" -H "$CT" -d "$(cbody wTh "$(printf 'a\nb\ac')")" "$C" | jq -r .error)" "a chat may hold line breaks and tabs, but no other control character (line 2)"
ML=$(printf 'para one\n\npara two\r\n\r\n\tpara three')
eq "chat: blank lines kept byte for byte" "$(post -H "$O" -H "$CT" -d "$(cbody wTh "$ML")" "$C")" "202"
eq "chat: its text is the multi-line one" "$(reqrow "$(rid)" | jq -r '.payload.text')" "$(printf 'para one\n\npara two\n\n\tpara three')"
N1=$((N1 + 1))
FD=$(dbq "SELECT id FROM requests WHERE kind = 'chat' AND member = 'wTh' ORDER BY id DESC LIMIT 1" | jq '.[0].id')
eq "chat-dismiss: a queued send is 409" "$(post -H "$O" -H "$CT" -d "$(cid "$FD")" "$CDM")" "409"
dbw "UPDATE requests SET done_at = CAST(strftime('%s','now') AS INTEGER), result = '{\"ok\":false,\"error\":\"never ready\"}' WHERE id = $FD"
jt "chat-dismiss: a failed send shows first" <(cq ans wTh >/dev/null; cat "$TMP/chat.out") "[.sends[] | select(.id == $FD)] | length == 1"
eq "chat-dismiss: a failed send is 202" "$(post -H "$O" -H "$CT" -d "$(cid "$FD")" "$CDM")" "202"
eq "chat-dismiss: its row names the chat" "$(reqrow "$(rid)" | jq -c '[.kind, .payload.chat]')" "[\"chat-dismiss\",$FD]"
dbw "UPDATE requests SET result = json_set(result, '$.dismissed_at', 1) WHERE id = $FD"
jt "chat-dismiss: the loop's mark drops it from the chat" <(cq ans wTh >/dev/null; cat "$TMP/chat.out") "[.sends[] | select(.id == $FD)] | length == 0"
eq "chat-dismiss: no such request is 404" "$(post -H "$O" -H "$CT" -d "$(cid 99999)" "$CDM")" "404"
# board chat U19: POST /api/keys files one `keys` request {keys, via: "board"} for a live member, one open per member;
# GET /api/chat carries the member's newest screen read as `screen`.
K="http://127.0.0.1:$PORT/api/keys"
kbody(){ jq -nc --arg p "$LBL" --arg t "${3:-ans}" --arg w "$1" --argjson k "$2" '{project: $p, topic: $t, wt: $w, keys: $k}'; }
krows(){ dbq "SELECT COUNT(*) AS n FROM requests WHERE kind = 'keys'" | jq '.[0].n'; }
K0=$(krows)
eq "keys: Escape to a live member is 202" "$(post -H "$O" -H "$CT" -d "$(kbody wTh '["Escape"]')" "$K")" "202"
KR=$(rid)
eq "keys: one keys row with member and squad" "$(reqrow "$KR" | jq -c '[.kind, .member, .squad, .payload.keys, .payload.via]')" '["keys","wTh","ans",["Escape"],"board"]'
eq "keys: a second press while one is open is 409" "$(post -H "$O" -H "$CT" -d "$(kbody wTh '["Down"]')" "$K")" "409"
dbw "UPDATE requests SET done_at = 1 WHERE id = $KR"
eq "keys: arrows, Enter and a digit are 202" "$(post -H "$O" -H "$CT" -d "$(kbody wTh '["Down","Down","Enter"]')" "$K")$(post -H "$O" -H "$CT" -d "$(kbody wStudio '["2"]' _studio)" "$K")" "202202"
dbw "UPDATE requests SET done_at = 1 WHERE kind = 'keys' AND done_at IS NULL"
K1=$(krows)
eq "keys: an unknown key is 400"       "$(post -H "$O" -H "$CT" -d "$(kbody wTh '["Delete"]')" "$K")" "400"
eq "keys: two characters are 400"      "$(post -H "$O" -H "$CT" -d "$(kbody wTh '["12"]')" "$K")" "400"
eq "keys: none is 400"                 "$(post -H "$O" -H "$CT" -d "$(kbody wTh '[]')" "$K")" "400"
eq "keys: nine are 400"                "$(post -H "$O" -H "$CT" -d "$(kbody wTh '["Up","Up","Up","Up","Up","Up","Up","Up","Up"]')" "$K")" "400"
eq "keys: a string is 400"             "$(post -H "$O" -H "$CT" -d "$(kbody wTh '"Escape"')" "$K")" "400"
eq "keys: an unknown member is 404"    "$(post -H "$O" -H "$CT" -d "$(kbody nope '["Escape"]')" "$K")" "404"
eq "keys: a paused member is 409"      "$(post -H "$O" -H "$CT" -d "$(kbody wResearcher '["Escape"]')" "$K")" "409"
eq "keys: foreign Origin is 403"       "$(post -H 'Origin: http://evil.example' -H "$CT" -d "$(kbody wTh '["Escape"]')" "$K")" "403"
eq "keys: no refused POST wrote a row" "$(krows)$((K0 + 3))" "$K1$K1"
eq "chat: no screen read yet is null"  "$(cq ans wTh)$(jq -c '.screen' "$TMP/chat.out")" "200null"
dbw "UPDATE observed_workers SET tail = 'Pick one:' || char(10) || '❯ 1. Yes', tail_at = CAST(strftime('%s','now') AS INTEGER) - 3 WHERE project = '$LBL' AND wt = 'wTh'"
jt "chat: the screen read with its age" <(cq ans wTh >/dev/null; cat "$TMP/chat.out") '.screen.tail == "Pick one:\n❯ 1. Yes" and .screen.age_s >= 3 and .screen.age_s < 60 and .screen.at > 0'
# ds-feedback-github-issues U4: GET /api/feedback lists drafts and notes; POST /api/feedback files one request per action.
FBU="http://127.0.0.1:$PORT/api/feedback"
dbw "INSERT INTO feedback_drafts (id, key, kind, title, body, leak, state, created_at, updated_at) VALUES (901, 'fd:s1', 'issue', 'Serve one', 'Body', 'ok', 'review', 1, 1), (902, 'fd:s2', 'issue', 'Serve two', 'Body', 'ok', 'filed', 1, 1)"
dbw "INSERT INTO feedback_notes (id, key, project, text, source, state, draft_id, at, updated_at) VALUES (801, 'sn1', 'p', 'a new note', 'cli', 'new', NULL, 1, 1), (802, 'sn2', 'p', 'drafted note', 'cli', 'drafted', 901, 1, 1), (803, 'sn3', 'p', 'gone note', 'cli', 'dismissed', NULL, 1, 1), (804, 'sn4', 'p', 'filed note', 'cli', 'filed', 902, 1, 1)"
eq "feedback: GET is 200" "$(curl -s -o "$TMP/fb.out" -w '%{http_code}' "$FBU")" "200"
jt "feedback: GET lists the review draft with its notes, and the notes" "$TMP/fb.out" '([.review[] | select(.id == 901)] | length) == 1 and (.review[0].notes[0].id == 802) and ([.notes[].id] | contains([801, 802, 803, 804])) and ([.filed[].id] | contains([902]))'
fbp(){ post -H "$O" -H "$CT" -d "$1" "$FBU"; }
fbj(){ jq -nc --arg p "$LBL" "$1"; }
eq "feedback: Post a draft in review is 202" "$(fbp "$(fbj '{project: $p, action: "post", draft: 901}')")" "202"
eq "feedback: its row is a feedback-post of the draft" "$(reqrow "$(rid)" | jq -c '[.kind, .payload.draft]')" '["feedback-post",901]'
eq "feedback: a second action on that draft while one is open is 409" "$(fbp "$(fbj '{project: $p, action: "dismiss", draft: 901}')")" "409"
eq "feedback: Post a draft already posted is 409" "$(fbp "$(fbj '{project: $p, action: "post", draft: 902}')")" "409"
eq "feedback: Post an unknown draft is 404" "$(fbp "$(fbj '{project: $p, action: "post", draft: 99999}')")" "404"
eq "feedback: Dismiss a note is 202" "$(fbp "$(fbj '{project: $p, action: "dismiss", note: 801, why: "stale"}')")" "202"
eq "feedback: its row carries the note and reason" "$(reqrow "$(rid)" | jq -c '[.kind, .payload.note, .payload.why]')" '["feedback-dismiss",801,"stale"]'
eq "feedback: Dismiss a filed note is 409" "$(fbp "$(fbj '{project: $p, action: "dismiss", note: 804}')")" "409"
eq "feedback: Restore a dismissed note is 202" "$(fbp "$(fbj '{project: $p, action: "restore", note: 803}')")" "202"
eq "feedback: Restore a note that is not dismissed is 409" "$(fbp "$(fbj '{project: $p, action: "restore", note: 804}')")" "409"
eq "feedback: an unknown action is 400" "$(fbp "$(fbj '{project: $p, action: "nuke", draft: 901}')")" "400"
eq "feedback: a cross-origin POST is refused" "$(post -H "Origin: http://evil.example" -H "$CT" -d "$(fbj '{project: $p, action: "restore", note: 803}')" "$FBU")" "403"
eq "chat-now: foreign Origin is 403"    "$(post -H 'Origin: http://evil.example' -H "$CT" -d "$(cid "$TK")" "$CN")" "403"
eq "chat-cancel: only the two accepted rows" "$(dbq "SELECT COUNT(*) AS n FROM requests WHERE kind IN ('chat-cancel','chat-now')" | jq '.[0].n')" "$((NQ + 2))"
eq "chat: resume the researcher"       "$(post -H "$O" -H "$CT" -d "{\"scope\":\"member\",\"project\":\"$LBL\",\"topic\":\"ans\",\"wt\":\"wResearcher\"}" "http://127.0.0.1:$PORT/api/resume")" "200"

# chat-image-upload U1: POST /api/chat-file stores one image per content hash under the state root
# (`<label>/chat-files/<topic>/<sha256[:16]>.<ext>`, 0600), GET serves it back, each upload prunes
# old ones, and a chat send may name stored images. Fixtures are magic bytes plus padding (no binary
# is checked in).
F="http://127.0.0.1:$PORT/api/chat-file"; CF="$DBR/$LBL/chat-files"
img(){ printf '%b%s' "$1" "$2" > "$TMP/$3"; }   # img <magic, backslash escapes> <padding> <file>
img '\x89PNG\r\n\x1a\n' 'one' a.png; img '\x89PNG\r\n\x1a\n' 'two' b.png; img '\x89PNG\r\n\x1a\n' 'three' c.png
img '\xff\xd8\xff\xe0' 'jpeg' d.jpg; img 'RIFF\x04\x00\x00\x00WEBPVP8 ' 'webp' e.webp; img 'GIF89a' 'gif' f.gif
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>' > "$TMP/s.svg"
up(){ # up <file> <content-type> [topic] [wt] [project] [origin header] -> status; the answer in $TMP/up.out
  curl -s -o "$TMP/up.out" -w '%{http_code}' -X POST -H "${6:-$O}" -H "Content-Type: $2" --data-binary "@$TMP/$1" \
    "$F?project=${5:-$LBL}&topic=${3:-ans}&wt=${4:-wTh}"; }
nfiles(){ find "$CF" -type f 2>/dev/null | wc -l | tr -d ' '; }
eq "chat-file: a PNG for a live member is 200" "$(up a.png image/png)" "200"
AID=$(jq -r '.id' "$TMP/up.out")
eq "chat-file: named by its sha256's first 16 hex" "$AID" "$(sha256sum "$TMP/a.png" | cut -c1-16).png"
eq "chat-file: the answer's url and bytes" "$(jq -c '[.url, .bytes]' "$TMP/up.out")" "[\"api/chat-file?project=$LBL&topic=ans&name=$AID\",$(wc -c < "$TMP/a.png" | tr -d ' ')]"
eq "chat-file: stored 0600 in 0700 folders" "$(stat -c %a "$CF/ans/$AID") $(stat -c %a "$CF/ans") $(stat -c %a "$CF")" "600 700 700"
eq "chat-file: the same bytes again, the same name" "$(up a.png image/png)$(jq -r '.id' "$TMP/up.out")" "200$AID"
eq "chat-file: and one file" "$(nfiles)" "1"
touch -d '10 days ago' "$CF/ans/$AID"; up a.png image/png >/dev/null
eq "chat-file: a repeat upload resets the image's age" "$(( $(date +%s) - $(stat -c %Y "$CF/ans/$AID") < 60 ))" "1"
for t in d.jpg:image/jpeg e.webp:image/webp f.gif:image/gif; do
  f=${t%%:*}; ty=${t#*:}
  eq "chat-file: a ${ty#image/} is 200 as .${f#*.}" "$(up "$f" "$ty")$(jq -r '.id | split(".")[1]' "$TMP/up.out")" "200${f#*.}"
done
N2=$(nfiles)
eq "chat-file: a cross-origin upload is 403" "$(up b.png image/png ans wTh "$LBL" 'Origin: http://evil.example')" "403"
eq "chat-file: no Origin is 403"        "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: image/png' --data-binary "@$TMP/b.png" "$F?project=$LBL&topic=ans&wt=wTh")" "403"
eq "chat-file: text/plain is 415"       "$(up b.png text/plain)" "415"
eq "chat-file: an SVG is 415"           "$(up s.svg image/svg+xml)" "415"
eq "chat-file: an SVG labelled png is 415" "$(up s.svg image/png)" "415"
eq "chat-file: a PNG labelled jpeg is 415" "$(up b.png image/jpeg)$(jq -r '.error' "$TMP/up.out")" "415not a png/jpeg/webp/gif"
head -c $((6 * 1024 * 1024)) /dev/zero | cat "$TMP/b.png" - > "$TMP/big.png"
eq "chat-file: a 6 MiB body is 413"     "$(up big.png image/png)" "413"
head -c $((5 * 1024 * 1024 + 1 - $(wc -c < "$TMP/b.png"))) /dev/zero | cat "$TMP/b.png" - > "$TMP/over.png"
eq "chat-file: 5 MiB + 1 byte is the handler's own 413" "$(up over.png image/png)$(jq -r '.error' "$TMP/up.out")" "413an image is at most 5 MiB"
: > "$TMP/empty.png"
eq "chat-file: an empty body is 400"    "$(up empty.png image/png)" "400"
eq "chat-file: another project is 403"  "$(up b.png image/png ans wTh zzother)" "403"
eq "chat-file: a bad topic is 400"      "$(up b.png image/png '../x')" "400"
eq "chat-file: an ended member is 404"  "$(up b.png image/png ans wReviewer)" "404"
eq "chat-file: an unknown member is 404" "$(up b.png image/png ans nope)" "404"
eq "chat-file: GET is not an upload"    "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "$O" -H 'Content-Type: image/png' --data-binary "@$TMP/b.png" "$F?project=$LBL&topic=ans&wt=wTh")" "405"
mkdir -p "$TMP/elsewhere"; ln -s "$TMP/elsewhere" "$CF/_studio"
eq "chat-file: a symlinked folder is 500" "$(up b.png image/png _studio wStudio)$(jq -r '.error' "$TMP/up.out")" "500chat-files is not a plain folder"
eq "chat-file: nothing written through it" "$(find "$TMP/elsewhere" -type f | wc -l | tr -d ' ')" "0"
rm "$CF/_studio"
eq "chat-file: no refused upload wrote a file" "$(nfiles)" "$N2"
eq "chat-file: the Studio's folder is _studio" "$(up b.png image/png _studio wStudio)" "200"
[ -f "$CF/_studio/$(jq -r '.id' "$TMP/up.out")" ]; eq "chat-file: stored under _studio" "$?" "0"
# Serving: the bytes, with headers that keep a browser from running or sniffing it.
eq "chat-file: GET is 200"              "$(curl -s -D "$TMP/fh.txt" -o "$TMP/served.png" -w '%{http_code}' "$F?project=$LBL&topic=ans&name=$AID")" "200"
cmp -s "$TMP/a.png" "$TMP/served.png"; eq "chat-file: the same bytes" "$?" "0"
fh(){ grep -i "^$1:" "$TMP/fh.txt" | cut -d' ' -f2- | tr -d '\r'; }
eq "chat-file: served headers" "$(fh content-type)|$(fh x-content-type-options)|$(fh content-disposition)|$(fh content-security-policy)|$(fh cache-control)" \
  "image/png|nosniff|inline|default-src 'none'; img-src 'self'|private, max-age=86400"
eq "chat-file: HEAD is 200"             "$(curl -s -I -o /dev/null -w '%{http_code}' "$F?project=$LBL&topic=ans&name=$AID")" "200"
eq "chat-file: ../x.png is 400"         "$(curl -s -o /dev/null -w '%{http_code}' "$F?project=$LBL&topic=ans&name=../x.png")" "400"
eq "chat-file: an uppercase name is 400" "$(curl -s -o /dev/null -w '%{http_code}' "$F?project=$LBL&topic=ans&name=${AID^^}")" "400"
eq "chat-file: a .svg name is 400"      "$(curl -s -o /dev/null -w '%{http_code}' "$F?project=$LBL&topic=ans&name=0123456789abcdef.svg")" "400"
eq "chat-file: an unknown name is 404"  "$(curl -s -o /dev/null -w '%{http_code}' "$F?project=$LBL&topic=ans&name=0123456789abcdef.png")" "404"
eq "chat-file: another squad's folder is 404" "$(curl -s -o /dev/null -w '%{http_code}' "$F?project=$LBL&topic=board-builders&name=$AID")" "404"
eq "chat-file: another project is 403"  "$(curl -s -o /dev/null -w '%{http_code}' "$F?project=zzother&topic=ans&name=$AID")" "403"
ln -s "$CF/ans/$AID" "$CF/ans/fedcba9876543210.png"
eq "chat-file: a symlinked file is 404" "$(curl -s -o /dev/null -w '%{http_code}' "$F?project=$LBL&topic=ans&name=fedcba9876543210.png")" "404"
rm "$CF/ans/fedcba9876543210.png"
eq "chat-file: an ended member's image still shows" "$(cp "$TMP/a.png" "$CF/ans/aaaaaaaaaaaaaaaa.png"; curl -s -o /dev/null -w '%{http_code}' "$F?project=$LBL&topic=ans&name=aaaaaaaaaaaaaaaa.png")" "200"
# A chat send may name stored images; text may then be empty.
fbody(){ jq -nc --arg p "$LBL" --arg x "$1" --argjson f "$2" '{project: $p, topic: "ans", wt: "wTh", text: $x, files: $f}'; }
eq "chat-file: a send with an image and no text is 202" "$(post -H "$O" -H "$CT" -d "$(fbody '' "[\"$AID\"]")" "$C")" "202"
eq "chat-file: the chat row holds files" "$(reqrow "$(rid)" | jq -c '[.payload.text, .payload.files, .payload.via]')" "[\"\",[\"$AID\"],\"board\"]"
eq "chat-file: text without files has no files key" "$(post -H "$O" -H "$CT" -d "$(fbody hi '[]')" "$C")$(reqrow "$(rid)" | jq -c '.payload | has("files")')" "202false"
N3=$(crows)
eq "chat-file: a send naming a missing image is 409" "$(post -H "$O" -H "$CT" -d "$(fbody hi '["0123456789abcdef.png"]')" "$C")$(jq -r '.error' "$TMP/post.out")" "409image 0123456789abcdef.png is gone — attach it again"
eq "chat-file: a bad name in files is 400" "$(post -H "$O" -H "$CT" -d "$(fbody hi '["../../x.png"]')" "$C")" "400"
eq "chat-file: five files are 400"      "$(post -H "$O" -H "$CT" -d "$(fbody hi '["a","b","c","d","e"]')" "$C")" "400"
eq "chat-file: a name twice is 400"     "$(post -H "$O" -H "$CT" -d "$(fbody hi "[\"$AID\",\"$AID\"]")" "$C")" "400"
eq "chat-file: files not a list is 400" "$(post -H "$O" -H "$CT" -d "$(fbody hi '"x"')" "$C")" "400"
eq "chat-file: no text and no files is still 400" "$(post -H "$O" -H "$CT" -d "$(fbody '' '[]')" "$C")" "400"
eq "chat-file: no refused send wrote a row" "$(crows)" "$N3"
# Only the upload may send a big body: a 200 KiB JSON post is still 413.
head -c $((200 * 1024)) /dev/zero | tr '\0' x | jq -Rc --arg p "$LBL" '{project: $p, topic: "ans", wt: "wTh", text: .}' > "$TMP/big.json"
eq "chat-file: a 200 KiB JSON chat is 413" "$(post -H "$O" -H "$CT" --data-binary "@$TMP/big.json" "$C")" "413"
eq "chat-file: a 200 KiB answer is 413" "$(post -H "$O" -H "$CT" --data-binary "@$TMP/big.json" "http://127.0.0.1:$PORT/api/answer")" "413"
# The prune each upload runs first: an image past chat_files_keep_d (14) days goes, a younger one and a
# file outside the name rule stay, a temp file over an hour old goes.
B=$(up b.png image/png >/dev/null; jq -r '.id' "$TMP/up.out")
touch -d '15 days ago' "$CF/ans/$AID"; touch -d '13 days ago' "$CF/ans/$B"
printf x > "$CF/ans/notes.txt"; touch -d '100 days ago' "$CF/ans/notes.txt"
printf x > "$CF/ans/.$AID.1.tmp"; touch -d '2 hours ago' "$CF/ans/.$AID.1.tmp"
printf x > "$CF/ans/.$B.2.tmp"
eq "chat-file: the next upload is 200"  "$(up c.png image/png)" "200"
ex(){ [ -e "$CF/ans/$1" ] && echo y || echo n; }
eq "chat-file: 15 days old gone, 13 kept, other file kept, old tmp gone, new tmp kept" "$(ex "$AID")$(ex "$B")$(ex notes.txt)$(ex ".$AID.1.tmp")$(ex ".$B.2.tmp")" "nyyny"
eq "chat-file: a pruned image is 404"   "$(curl -s -o /dev/null -w '%{http_code}' "$F?project=$LBL&topic=ans&name=$AID")" "404"
rm -f "$CF/ans/notes.txt" "$CF/ans/.$B.2.tmp"
# chat-image-upload U4: the Start squad dialog's images go to topic _start with no member (no squad yet),
# and a start may name up to 8 of them.
ups(){ # ups <file> [project] [extra query] -> status; the answer in $TMP/up.out
  curl -s -o "$TMP/up.out" -w '%{http_code}' -X POST -H "$O" -H "Content-Type: image/png" --data-binary "@$TMP/$1" "$F?project=${2:-$LBL}&topic=_start${3:-}"; }
eq "start-file: an upload to _start with no wt is 200" "$(ups a.png)" "200"
SID=$(jq -r '.id' "$TMP/up.out")
eq "start-file: stored under _start, 0600" "$(stat -c %a "$CF/_start/$SID" 2>&1)" "600"
eq "start-file: with a wt is 400"       "$(ups b.png "$LBL" '&wt=wTh')" "400"
eq "start-file: another project is 403" "$(ups b.png zzother)" "403"
eq "start-file: over 5 MiB is 413"      "$(ups big.png)" "413"
eq "start-file: a cross-origin upload is 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Origin: http://evil.example' -H 'Content-Type: image/png' --data-binary "@$TMP/b.png" "$F?project=$LBL&topic=_start")" "403"
eq "start-file: an SVG is 415"          "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$O" -H 'Content-Type: image/png' --data-binary "@$TMP/s.svg" "$F?project=$LBL&topic=_start")" "415"
eq "start-file: GET serves it"          "$(curl -s -o "$TMP/served.png" -w '%{http_code}' "$F?project=$LBL&topic=_start&name=$SID"; cmp -s "$TMP/a.png" "$TMP/served.png" && echo same)" "200same"
eq "start-file: a second image"         "$(ups b.png)" "200"
SID2=$(jq -r '.id' "$TMP/up.out")
sbody(){ jq -nc --arg p "$LBL" --argjson f "$1" '{project: $p, action: "start", text: "look", files: $f}'; }
eq "start-file: a start with 2 files is 202" "$(req "$(sbody "[\"$SID\",\"$SID2\"]")")" "202"
eq "start-file: the studio row holds the names" "$(reqrow "$(rid)" | jq -c '[.kind, .payload.action, .payload.files]')" "[\"studio\",\"start\",[\"$SID\",\"$SID2\"]]"
srows(){ dbq "SELECT COUNT(*) AS n FROM requests WHERE kind = 'studio'" | jq '.[0].n'; }
N4=$(srows)
eq "start-file: 9 files are 400"        "$(req "$(sbody "$(jq -nc '[range(9) | tostring * 16 + ".png"]')")")" "400"
eq "start-file: a bad name is 400"      "$(req "$(sbody '["../x.png"]')")" "400"
eq "start-file: a missing one is 409"   "$(req "$(sbody '["0123456789abcdef.png"]')")$(jq -r '.error' "$TMP/post.out")" "409image 0123456789abcdef.png is gone — attach it again"
CID="$(sha256sum "$TMP/c.png" | cut -c1-16).png"
eq "start-file: c.png is stored for a chat only" "$([ -f "$CF/ans/$CID" ] && [ ! -e "$CF/_start/$CID" ] && echo y)" "y"
eq "start-file: a chat image is not a start's" "$(req "$(sbody "[\"$CID\"]")")" "409"
eq "start-file: no refused start wrote a row" "$(srows)" "$N4"

# GET /lavish/<key>: Lavish stops itself when idle; when it is down the board files one `lavish`
# request and answers a page that reloads until the loop has started it, then redirects.
L="http://127.0.0.1:$PORT/lavish"
eq "lavish: bad key is 404"           "$(curl -s -o /dev/null -w '%{http_code}' "$L/../state")" "404"
eq "lavish: unknown key is 404"       "$(curl -s -o /dev/null -w '%{http_code}' "$L/fedcba9876543210")" "404"
eq "text replies are utf-8 (— reads right)" "$(curl -s -o /dev/null -w '%{content_type}' "$L/fedcba9876543210")" "text/plain; charset=utf-8"
eq "lavish: down -> 202 and a page that reloads" "$(curl -s -o "$TMP/lv.html" -w '%{http_code}' "$L/$LK")" "202"
has "lavish: the page reloads"        "$(cat "$TMP/lv.html")" 'http-equiv="refresh"'
eq "lavish: a second click while it starts" "$(curl -s -o /dev/null -w '%{http_code}' "$L/$LK")" "202"
eq "lavish: one lavish request"       "$(dbq "SELECT COUNT(*) AS n FROM requests WHERE kind = 'lavish'" | jq '.[0].n')" "1"
eq "lavish: nothing started yet"      "$([ -e "$TMP/lvstart.log" ] && echo yes || echo no)" "no"
ff
eq "lavish: the loop started it once" "$(wc -l < "$TMP/lvstart.log" | tr -d ' ')" "1"
eq "lavish: up -> redirect"           "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$L/$LK")" "302 http://127.0.0.1:$LP/session/$LK"
if [ -s "$TMP/lvfake.pid" ]; then kill "$(cat "$TMP/lvfake.pid")" 2>/dev/null || true; fi

# GET /page/<label>/pages/<topic>/<path> (debrief-in-needs-you pages U2): a review page saved when its worktree
# closed, read-only from `<label>/pages/<topic>/` only, sandboxed so its scripts cannot call the board's API.
PG="http://127.0.0.1:$PORT/page"; PD="$DBR/$LBL/pages/pgt"
mkdir -p "$PD/rescued/b/.lavish" "$DBR/$LBL/pages/pgother"
printf '<html><link rel="stylesheet" href="s.css"><body>saved</body></html>' > "$PD/rescued/b/.lavish/plan.html"
printf 'body{color:red}' > "$PD/rescued/b/.lavish/s.css"; printf 'x' > "$PD/rescued/b/.lavish/notes.txt"
printf 'other' > "$DBR/$LBL/pages/pgother/o.html"; printf 'secret' > "$TMP/outside.html"
ln -sf "$TMP/outside.html" "$PD/link.html"; ln -sfn "$DBR/$LBL/pages/pgother" "$PD/dir"
pg(){ curl -s -o "$TMP/pg.out" -w '%{http_code}' "$@"; }
eq "page: a saved page is 200"          "$(pg "$PG/$LBL/pages/pgt/rescued/b/.lavish/plan.html")" "200"
has "page: its body"                    "$(cat "$TMP/pg.out")" "saved"
eq "page: its relative css is 200"      "$(pg "$PG/$LBL/pages/pgt/rescued/b/.lavish/s.css")" "200"
H="$(curl -s -D - -o /dev/null "$PG/$LBL/pages/pgt/rescued/b/.lavish/plan.html" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
has "page: sandboxed, scripts only"     "$H" "content-security-policy: sandbox allow-scripts"
has "page: nosniff"                     "$H" "x-content-type-options: nosniff"
has "page: html content type"           "$H" "content-type: text/html"
eq "page: a .txt is 404"                "$(pg "$PG/$LBL/pages/pgt/rescued/b/.lavish/notes.txt")" "404"
eq "page: .. is resolved by the URL, never out of the folder" "$(pg --path-as-is "$PG/$LBL/pages/pgt/../../../../../../$TMP/outside.html")" "404"
eq "page: an encoded slash in a name is 404" "$(pg "$PG/$LBL/pages/pgt/..%2fpgother%2fo.html")" "404"
eq "page: a symlink out is 404"         "$(pg "$PG/$LBL/pages/pgt/link.html")" "404"
eq "page: through a symlinked folder is 404" "$(pg "$PG/$LBL/pages/pgt/dir/o.html")" "404"
eq "page: a folder is 404"              "$(pg "$PG/$LBL/pages/pgt/rescued")" "404"
eq "page: not under pages/ is 404"      "$(pg "$PG/$LBL/chat-files/pgt/plan.html")" "404"
eq "page: a bad label is 404"           "$(pg "$PG/../pages/pgt/rescued/b/.lavish/plan.html")" "404"

# The stream carried what the loop did: each request_done, a failed one with its reason. The page
# toasts those, and refetches the board on every event.
sleep 1.5; kill "$SSE" 2>/dev/null || true; wait "$SSE" 2>/dev/null || true
sse(){ sed -n 's/^data: //p' "$TMP/sse.txt"; }
jt "stream: the board's requests done" <(sse | jq -s .) "[.[] | select(.kind==\"request_done\") | .payload.id] | index($L1) != null and index($C1) != null"
# The poke was filed after resync rebuilt loop.db under the running stream, whose cursor can be past the
# rebuilt db's event ids (more events before the rebuild push it higher): read it from a stream from 0.
curl -sN --max-time 3 "http://127.0.0.1:$PORT/api/stream?after=0" > "$TMP/sse0.txt" 2>/dev/null || true
jt "stream: a failed request with its reason" <(sed -n 's/^data: //p' "$TMP/sse0.txt" | jq -s .) "[.[] | select(.kind==\"request_done\" and .payload.id==$PK) | .payload.result] | .[0].ok == false and (.[0].error | length > 0)"
jt "stream: answered in the terminal"  <(sse | jq -s .) '[.[] | select(.kind=="question_answered") | .payload.id] | index("qa1") != null'
eq "stream: ids rise, one per event"   "$(grep -c '^id: ' "$TMP/sse.txt")" "$(grep -c '^data: ' "$TMP/sse.txt")"
eq "web board: toasts from the stream" "$(grep -cF 'new EventSource("api/stream")' "$ROOT/web/board.html")$(grep -cF ' failed: ' "$ROOT/web/board.html" | awk '{print ($1>=1)}')" "11"
stop_own "$SPID"; SPID=""

# Bun off PATH (a shell that didn't load the profile): --serve finds it in ~/.bun/bin; with no bun
# anywhere it says how to install it.
mkdir -p "$TMP/nobun" "$TMP/bhome/.bun/bin"; ln -sf "$(command -v jq)" "$TMP/nobun/jq"
NP="$TMP/tsbin:$TMP/nobun:/usr/bin:/bin:/usr/sbin:/sbin"
out="$(HOME="$TMP/bhome" PATH="$NP" DS_BIND=127.0.0.1 BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "$LBL" --serve-fg "$((PORT + 2))" 2>&1)" || true
has "serve: no bun says how to install" "$out" "https://bun.sh/install"
ln -sf "$(command -v bun)" "$TMP/bhome/.bun/bin/bun"
HOME="$TMP/bhome" PATH="$NP" DS_BIND=127.0.0.1 BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "$LBL" --serve-fg "$((PORT + 2))" >"$TMP/serve3.log" 2>&1 &
SPID=$!
for _ in $(seq 1 300); do curl -s -o /dev/null "http://127.0.0.1:$((PORT + 2))/" && break; sleep 0.2; done
eq "serve: bun from ~/.bun/bin works" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$((PORT + 2))/")" "200"
stop_own "$SPID"; SPID=""

# A project selector (path:...) scopes the event log by its label, as the board does.
DS_STATE_ROOT="$DBR" DS_BIND=127.0.0.1 BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "path:$TMP/x/$LBL" --serve-fg "$((PORT + 5))" >"$TMP/serve5.log" 2>&1 &
SPID=$!
for _ in $(seq 1 300); do curl -s -o /dev/null "http://127.0.0.1:$((PORT + 5))/" && break; sleep 0.2; done
jt "serve: a path: selector's event log has the project's events" <(curl -s "http://127.0.0.1:$((PORT + 5))/api/events?limit=5") '(.events | length) == 5 and (.events[0].project == "'"$LBL"'")'
stop_own "$SPID"; SPID=""

# Upgrade: a board from the old version (pidfile board-www.pid, static board-www/) is replaced too,
# not left holding the port.
mkdir -p "$TMP/old" "$DS_STATE_ROOT/$LBL/board-www"; echo old > "$DS_STATE_ROOT/$LBL/board-www/index.html"
printf '#!/usr/bin/env bash\nsleep 60\n' > "$TMP/old/board.sh"; chmod +x "$TMP/old/board.sh"
"$TMP/old/board.sh" & OLDPID=$!
printf '%s' "$OLDPID" > "$DS_STATE_ROOT/$LBL/board-www.pid"
PATH="$TMP/tsbin:$PATH" DS_BIND=127.0.0.1 BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "$LBL" --serve-fg "$((PORT + 3))" >"$TMP/serve4.log" 2>&1 &
SPID=$!
for _ in $(seq 1 300); do curl -s -o /dev/null "http://127.0.0.1:$((PORT + 3))/" && break; sleep 0.2; done
eq "upgrade: old-version board stopped" "$(kill -0 "$OLDPID" 2>/dev/null && echo alive || echo gone)" "gone"
eq "upgrade: its pidfile + files removed" "$(find "$DS_STATE_ROOT/$LBL" -maxdepth 1 -name 'board-www*' | wc -l | tr -d ' ')" "0"
eq "upgrade: new board serves"          "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$((PORT + 3))/")" "200"
stop_own "$SPID"; SPID=""

# Port taken by something else (U2 of board-empty-state-and-port): the next free port, said so.
"$(command -v bun)" -e "Bun.serve({hostname:'127.0.0.1',port:$((PORT + 4)),fetch:()=>new Response('other')}); await Bun.sleep(30000)" & HOG=$!
sleep 0.5
PATH="$TMP/tsbin:$PATH" DS_BIND=127.0.0.1 BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "$LBL" --serve-fg "$((PORT + 4))" >"$TMP/serve6.log" 2>&1 &
SPID=$!
for _ in $(seq 1 150); do grep -q 'listening on' "$TMP/serve6.log" && break; sleep 0.2; done
P6="$(sed -n 's/.*listening on 127\.0\.0\.1:\([0-9]*\).*/\1/p' "$TMP/serve6.log" | head -1)"
eq "busy port: moves past the held one" "$([ -n "$P6" ] && [ "$P6" -gt "$((PORT + 4))" ] && echo yes || echo no)" "yes"
has "busy port: says the asked was taken" "$(cat "$TMP/serve6.log")" "($((PORT + 4)) was taken)"
eq "busy port: the board serves there"  "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${P6:-0}/healthz")" "200"
stop_own "$SPID"; SPID=""
# Nothing free within DS_BOARD_PORT_TRIES: say so and exit non-zero — never claim "listening".
rc=0; out="$(DS_BOARD_PORT_TRIES=0 PATH="$TMP/tsbin:$PATH" DS_BIND=127.0.0.1 BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "$LBL" --serve-fg "$((PORT + 4))" 2>&1)" || rc=$?
kill "$HOG" 2>/dev/null || true
eq "busy port: exits non-zero"         "$([ "$rc" -ne 0 ] && echo yes || echo no)" "yes"
has "busy port: says all are taken"    "$out" "are all taken"
eq "busy port: never says listening"   "$(printf '%s' "$out" | grep -c 'listening on' || true)" "0"

# Default bind (no DS_BIND): localhost + the tailnet IP only — never every interface (0.0.0.0).
PORT=$((PORT + 1))
PATH="$TMP/tsbin:$PATH" BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "$LBL" --serve-fg "$PORT" >"$TMP/serve2.log" 2>&1 &
SPID=$!
for _ in $(seq 1 300); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.2; done
# "listening" is printed just after the server binds — a beat after the first answer.
for _ in $(seq 1 600); do grep -q 'listening on' "$TMP/serve2.log" && break; sleep 0.1; done
eq "default bind: advertises the tailnet URL" "$(grep -c 'over the tailnet' "$TMP/serve2.log" || true)" "1"
eq "default bind: localhost answers"   "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/board.json")" "200"
if command -v lsof >/dev/null 2>&1; then
  ls="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}' | sort -u | tr '\n' ' ')"
  eq "default bind: not every interface" "$(printf '%s' "$ls" | grep -c '\*:' || true)" "0"
  eq "default bind: tailnet IP listens"  "$(printf '%s' "$ls" | grep -c "\[::1\]:$PORT" || true)" "1"
fi
stop_own "$SPID"; SPID=""

# A pull that changes board-server.ts reaches a running board: the server exits 75 and board.sh
# re-runs itself on the new code — same pid, same pidfile, still answering.
P5=$((PORT + 5))
# Runs against a COPY of the server (never touch $ROOT/bin/board/board-server.ts: live boards watch it).
mkdir -p "$TMP/srvcopy/bin/board"; cp "$ROOT"/bin/board/*.ts "$TMP/srvcopy/bin/board/"; cp -r "$ROOT/bin/loop" "$TMP/srvcopy/bin/loop"; cp -r "$ROOT/bin/lib" "$TMP/srvcopy/bin/lib"; cp -r "$ROOT/bin/backend" "$TMP/srvcopy/bin/backend"; mkdir -p "$TMP/srvcopy/web"; cp "$ROOT/web/board.html" "$TMP/srvcopy/web/"
DS_BOARD_SERVER="$TMP/srvcopy/bin/board/board-server.ts" PATH="$TMP/tsbin:$PATH" DS_BIND=127.0.0.1 BACKEND="$TMP/fakeb" "$ROOT/bin/board/board.sh" "$LBL" --serve-fg "$P5" >"$TMP/serve5.log" 2>&1 &
SPID=$!
# A loaded host starts Bun (cold-loading bin/loop) slowly: wait up to 60 s, stopping as soon as the line is there.
for _ in $(seq 1 600); do grep -q 'listening on' "$TMP/serve5.log" && break; sleep 0.1; done
touch "$TMP/srvcopy/bin/board/board-server.ts"
for _ in $(seq 1 600); do [ "$(grep -c 'listening on' "$TMP/serve5.log")" -ge 2 ] && break; sleep 0.1; done
has "code change: server restarts"      "$(cat "$TMP/serve5.log")" "server code changed"
eq  "code change: listening again"      "$(grep -c 'listening on' "$TMP/serve5.log")" "2"
eq  "code change: same process"         "$(kill -0 "$SPID" 2>/dev/null && echo alive)" "alive"
eq  "code change: pidfile kept"         "$(cat "$DS_STATE_ROOT/$LBL/board-serve.pid" 2>/dev/null)" "$SPID"
eq  "code change: still answers"        "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$P5/board.json")" "200"
# Any imported code file restarts it too (not only board-server.ts); the page and an idle server do not.
n0="$(grep -c 'listening on' "$TMP/serve5.log")"
touch "$TMP/srvcopy/web/board.html"; sleep 3.5
eq  "code change: board.html does not restart" "$(grep -c 'listening on' "$TMP/serve5.log")" "$n0"
touch "$TMP/srvcopy/bin/board/board-data.ts"
for _ in $(seq 1 600); do [ "$(grep -c 'listening on' "$TMP/serve5.log")" -gt "$n0" ] && break; sleep 0.1; done
eq  "code change: board-data.ts restarts"      "$(grep -c 'listening on' "$TMP/serve5.log")" "$((n0 + 1))"
has "code change: names the file"              "$(cat "$TMP/serve5.log")" "board-data.ts) — restarting"
sleep 3.5
eq  "code change: one restart per change"      "$(grep -c 'listening on' "$TMP/serve5.log")" "$((n0 + 1))"
touch "$TMP/srvcopy/bin/loop/core/store.ts"
for _ in $(seq 1 600); do [ "$(grep -c 'listening on' "$TMP/serve5.log")" -gt "$((n0 + 1))" ] && break; sleep 0.1; done
eq  "code change: a loop module restarts"      "$(grep -c 'listening on' "$TMP/serve5.log")" "$((n0 + 2))"
stop_own "$SPID"; SPID=""

# U11: the gh log never names the real repo (the guard test in fulfil-feedback-post.test.ts covers a post with no origin).
eq "gh log: no call names the real repo" "$(grep -c "daanporon/dev-studio" "$GHLOG" || true)" "0"

echo "board-serve: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
