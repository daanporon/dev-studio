#!/usr/bin/env bash
# board-page.sh — the web page tables, spend, services, ext_deps and the later fixtures (split from tests/board.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/tests/lib/state-root.sh"  # temp DS_STATE_ROOT: no write to the live state (U253)
# shellcheck source=tests/lib/board-setup.sh
. "$ROOT/tests/lib/board-setup.sh"
GR="$TMP/ghrepo"


# B4: the web page's crew and units are tables with headers; a blocked unit's deps ride in a title.
eq "web board: crew column headers" "$(grep -cF '<span>Role</span><span>Phase</span><span class="num">Context</span><span>State</span><span>Model · Effort @ Account</span>' "$ROOT/web/board.html")" "1"
eq "web board: unit column headers" "$(grep -cF '<span>Unit</span><span>Tier</span><span class="num">Spent</span><span class="num" title="CPU-hours its Builders used, reaped child processes included">CPU-h</span><span>State</span><span>PR</span>' "$ROOT/web/board.html")" "1"
eq "web board: blocked deps (incl. ext) in a title attribute" "$(grep -cF 'title=${u.state === "blocked" ? "waiting on: " + [...u.deps' "$ROOT/web/board.html")" "1"
eq "web board: blocked state is short (N deps)" "$(grep -cF '"blocked · " + (u.deps.length + (u.ext_deps || []).length) + " dep"' "$ROOT/web/board.html")" "1"
# Squad detail order (B4c): Questions, Crew, Documents (B4d), Pipeline graph, Work units; docs per type, newest first; graph open by default. The Archived detail reuses Docs, so it matches last.
# shellcheck disable=SC2016
ord=$(grep -n 'class="box"><h3>Questions\|<${Docs} s=\|"box crew"\|<${GraphBox} s=\|<${UnitsBox} s=' "$ROOT/web/board.html" | sed -E 's/.*(Questions|Docs|box crew|GraphBox|UnitsBox).*/\1/' | tr '\n' ' ')
eq "web board: squad boxes in order" "$ord" "Questions box crew Docs GraphBox UnitsBox Docs "
eq "web board: documents per type" "$(grep -cF 'label: "Plans"' "$ROOT/web/board.html")$(grep -cF 'label: "Review pages"' "$ROOT/web/board.html")" "11"
eq "web board: documents newest first" "$(grep -cF 'byNew = (a, b) => (b.mtime || 0) - (a.mtime || 0)' "$ROOT/web/board.html")" "1"
eq "web board: graph open by default" "$(grep -cF 'useState(saved === null ? true : saved === "1")' "$ROOT/web/board.html")" "1"
eq "web board: squad table has a Spent header" "$(grep -cF '<span class="c-spent num"' "$ROOT/web/board.html" | awk '{print ($1>=2)}')" "1"
eq "web board: spinner stays on working rows" "$(grep -cF '(u.busy ? " spin" : "")' "$ROOT/web/board.html")" "1"

# account-free-resets U3: the Accounts table's Free resets cell (header, grid column, one text per state, tooltip per grant).
W="$ROOT/web/board.html"
eq "web board: Accounts header has the Free resets column" "$(grep -cF '<span>7-day</span><span>Free resets</span><span>In use</span></div>' "$W")" "1"
eq "web board: the row renders the cell after the two usage cells" "$(grep -cF '<${ResetsCell} a=${a} />' "$W")" "1"
eq "web board: the cell's text for each state" "$(grep -cF '>not reported${mark}</div>' "$W")$(grep -cF '>?${mark}</div>' "$W")$(grep -cF 'title="the provider reports no free resets">0${mark}</div>' "$W")$(grep -cF '" · first by " + dayMonthOf(r.first_use_by)' "$W")" "1111"
eq "web board: the tooltip names label, refills, use by and left/total" "$(grep -cF '(r.grants || []).map((g) => g.label + " · refills "' "$W")$(grep -cF '" · use by " + (g.use_by != null' "$W")$(grep -cF '" left"' "$W")" "111"
# The cell's code run as written (extracted from the page) on fixture grants: `2 · first by 10 Dec`, the grant
# line, a Use button only on the grant usable now (U4) and the last press of the hour.
RC="$TMP/resets-cell.mjs"
{ echo 'const part = (v) => v == null || v === false ? "" : Array.isArray(v) ? v.map(part).join("") : typeof v === "function" ? "" : String(v);'
  echo 'const html = (s, ...v) => s.map((x, i) => x + (i < v.length ? part(v[i]) : "")).join("");'
  echo 'const clockOf = () => "10:05";'
  printf '%s\n' 'const show = (t) => console.log(t.replace(/\n\s*/g, " "));   // one line per render'
  echo 'const tokTip = () => "", fmtTok = (n) => String(n);'
  sed -n '/^function groupUsers(/,/^}/p' "$W"
  sed -n '/^const MONTHS/,/^function UsageCell/p' "$W" | sed '$d'
  echo 'const g = [{id:"g1",label:"Sooner",refills:["session","weekly"],use_by:1796940000,left:1,total:1,usable_now:true},{id:"g2",label:"Later",refills:["weekly_model"],use_by:null,left:1,total:1,usable_now:false}];'
  echo 'const acc = (more, grants) => ({agent:"claude",account:"two",resets:{state:"reported",count:(grants||g).length,first_use_by:1796940000,grants:grants||g},...more});'
  echo 'const A = (a) => AccountDetail({a, all:[a], project:"p", toast(){}});'
  echo 'show("ROW " + ResetsCell({a:acc({})}));'
  echo 'show("ROWLAST " + ResetsCell({a:acc({reset_last:{at:1796940300,outcome:"failed",detail:"HTTP 500",grant:"g1"}})}));'
  echo 'show("ROWUSED " + ResetsCell({a:acc({reset_last:{at:1796940300,outcome:"used",grant:"g1"}})}));'
  echo 'show("OPEN " + A(acc({})));'
  echo 'show("BOTH " + A(acc({}, g.map((x) => ({...x, usable_now:true})))));'
  echo 'show("OPENLAST " + A(acc({reset_last:{at:1796940300,outcome:"failed",detail:"HTTP 500",grant:"g1"}})));'
  echo 'show("PEND " + A(acc({reset_pending:{id:7,at:1796940300,project:"p",queued:false}})));'
  echo 'show("PENDROW " + ResetsCell({a:acc({reset_pending:{id:7,at:1796940300,project:"p",queued:false}})}));'
  echo 'show("QUEUED " + A(acc({reset_pending:{id:7,at:1796940300,project:"p",queued:true}})));'
  echo 'const us = [{project:"p",squad:"sq1",role:"builder",label:"Builder",model_label:"Sonnet",state:"working"}];'
  echo 'show("ROLES " + A({...acc({}), users:us, plan:"Ultra"}));'
  echo 'show("OFFROLES " + A({agent:"claude",account:"d",disabled:true,users:[],resets:{state:"reported",count:0,grants:[]}}));'
  echo 'show("OFF " + A({agent:"claude",account:"d",disabled:true,resets:{state:"reported",count:0,grants:[]}}));'
  echo 'show("ZERO " + ResetsCell({a:{resets:{state:"reported",count:0,grants:[]}}}));'
  echo 'show("ZEROOPEN " + A({agent:"claude",account:"z",resets:{state:"reported",count:0,grants:[]}}));'
  echo 'show("NR " + ResetsCell({a:{resets:{state:"not_reported"}}}));'
  echo 'show("NROPEN " + A({agent:"muse",account:"m",resets:{state:"not_reported"}}));'
  echo 'show("UNKOPEN " + A({agent:"codex",account:"c",resets:{state:"unknown"}}));'
  echo 'show("UNK " + ResetsCell({a:{resets:{state:"unknown"}}}));'
  echo 'show("NONE " + ResetsCell({a:{}}));'; } > "$RC"
cell="$(TZ=UTC bun "$RC" 2>&1)"
line() { printf '%s\n' "$cell" | grep "^$1 "; }
has "web board: two grants render 2 · first by <date>" "$(line ROW)" '>2 · first by 10 Dec</span>'
has "web board: the tooltip lists a grant's refills, use-by and left" "$(line ROW)" 'Sooner · refills 5-hour, 7-day · use by 10 Dec · 1/1 left'
has "web board: a grant without a date says so" "$(line ROW)" 'Later · refills 7-day model · use by no date'
eq "web board: the closed row has no button and no grant label text" "$(line ROW | sed 's/title=[^>]*>//' | grep -c '<button\|Sooner')" "0"
has "web board: a failed use marks the row with !" "$(line ROWLAST)" '> · !</span>'
has "web board: a finished use marks the row with its time" "$(line ROWUSED)" '> · used 10:05</span>'
eq "web board: the panel has no Use button on the grant that is not usable; one on the usable one" "$(line OPEN | grep -o '<button[^>]*>[^<]*</button>' | grep -c '>Use</button>')" "1"
eq "web board: two usable grants give two Use buttons in the panel" "$(line BOTH | grep -o '>Use</button>' | wc -l | tr -d ' ')" "2"
has "web board: the panel line shows label, refills, left/total and use by" "$(line OPEN)" 'Sooner</span><span>5-hour, 7-day</span><span>1/1 left</span> <span>10 Dec</span>'
has "web board: ... and a grant without a date" "$(line OPEN)" 'Later</span><span>7-day model</span><span>1/1 left</span> <span>no date</span>'
has "web board: the Use button's title names the grant" "$(line OPEN)" 'title=Use Sooner now (asks first)'
has "web board: the panel shows the last use's outcome" "$(line OPENLAST)" '>last use 10:05 · failed</div>'
eq "web board: a pending use shows no Use button in the panel" "$(line PEND | grep -c '>Use</button>' || true)" "0"
has "web board: ... but use in progress with its time" "$(line PEND)" '>use in progress · since 10:05</div>'
has "web board: ... and the closed row reads using…" "$(line PENDROW)" ' · using…</span>'
has "web board: a pending use while paused says it is queued" "$(line QUEUED)" '>queued: runs when the project resumes · since 10:05</div>'
eq "web board: Use renders without a pending use" "$(line OPEN | grep -c '>Use</button>')" "1"
has "web board: an enabled account shows Disable in the panel" "$(line OPEN)" '>Disable</button>'
has "web board: a disabled account shows Enable in the panel" "$(line OFF)" '>Enable</button>'
eq "web board: no grants (0, not reported, unknown): no Free resets box; the action bar and state line stay" "$(for k in ZEROOPEN NROPEN UNKOPEN OFF; do line $k | grep -c '<h3>Free resets'; line $k | grep -c 'class="dbar"'; line $k | grep -c 'class="explain"'; done | tr '\n' ' ')" "0 1 1 0 1 1 0 1 1 0 1 1 "
# U8: order action bar, state line, Free resets box, Roles box; the Roles box only with roles.
ord="$(line ROLES | grep -bo 'class="dbar"\|class="explain"\|<h3>Free resets\|<h3>Roles' | sed 's/^[0-9]*://; s/^class="//' | tr '\n' ' ')"
eq "web board: the opened account reads dbar, explain, Free resets, Roles" "$ord" 'dbar" explain" <h3>Free resets <h3>Roles '
has "web board: the dbar holds Enable/Disable first, then the meta" "$(line ROLES)" 'class="dbar"><button class="abtn"'
has "web board: the dbar meta names agent, plan" "$(line ROLES)" '<span>claude · Ultra</span></div>'
has "web board: the state line for an enabled account" "$(line OPEN)" '>enabled: picks can use this account</div>'
has "web board: the state line for a disabled account" "$(line OFF)" '>disabled: no pick uses it; running roles keep going until their next restart</div>'
has "web board: the Free resets h3 carries the row summary" "$(line OPEN)" '<h3>Free resets<span>2 · first by 10 Dec</span></h3>'
has "web board: the Roles h3 carries the counts" "$(line ROLES)" '<h3>Roles<span>1 role · 1 squad</span></h3>'
eq "web board: no roles, no Roles box" "$(line OFFROLES | grep -c '<h3>Roles')" "0"
eq "web board: no separate Account line" "$(line ROLES | grep -c '>Account<')" "0"
eq "web board: every opened panel has balanced divs" "$(for k in OPEN BOTH OPENLAST PEND QUEUED ROLES OFFROLES OFF ZEROOPEN NROPEN UNKOPEN; do l="$(line $k)"; [ "$(printf '%s' "$l" | grep -o '<div' | wc -l)" = "$(printf '%s' "$l" | grep -o '</div>' | wc -l)" ] && echo ok || echo BAD; done | sort | uniq -c | tr -s ' ' | tr '\n' ' ')" " 11 ok "
has "web board: count 0 renders 0" "$(line ZERO)" 'no free resets">0</div>'
has "web board: not_reported and unknown render their words" "$(line NR)" '>not reported</div>'
eq "web board: unknown and a missing value both render ?" "$( (line UNK; line NONE) | grep -c '>?</div>')" "2"
eq "web board: every account row opens (no roles gate) and the row has no action button" "$(grep -cF 'can = true, isOpen = open' "$W")$(sed -n '/^function AccountRow(/,/^}/p' "$W" | grep -c 'class="abtn"')" "10"
eq "web board: the roles table only renders with roles, inside the panel" "$(sed -n '/^function AccountDetail(/,/^}/p' "$W" | grep -cF '${g.roles > 0 && html`<div class="box"><h3>Roles')" "1"
eq "web board: a press asks first and says it cannot be undone" "$(sed -n '/^async function useReset(/,/^}/p' "$W" | grep -c 'if (!confirm(\|This cannot be undone.')" "2"

# B4: spent since the squad started (state/<label>/loop/squad-spent.tsv) -> SPENT per squad + the project total.
mkdir -p "$DS_STATE_ROOT/$LBL/loop"
printf 'tk-sq\t1790000000\t3000000\t1000000\t500000\t1500000\t0\t0\nold-sq\t1780000000\t2000000\t2000000\t0\t0\t0\t1\n' > "$DS_STATE_ROOT/$LBL/loop/squad-spent.tsv"
printf '{"run_id":"s1","status":"running","type":"feature","members":[{"role":"lead","wt":"wtLead"}],"units":[]}' > "$SD/tk-sq.json"
board "$LBL" > "$TMP/sp.json"
jt "spent: squad carries spent-since" "$TMP/sp.json" '.squads[] | select(.topic=="tk-sq") | .spent_since == {"since":1790000000,"spent":3000000,"lead":1000000,"thinker":500000,"builders":1500000,"other":0}'
jt "spent: squad without a row is null" "$TMP/sp.json" '[.squads[] | select(.topic!="tk-sq") | .spent_since] | all(. == null)'
jt "spent: project total sums all rows, earliest since" "$TMP/sp.json" '.spent_total == {"spent":5000000,"since":1780000000}'
SPT="$(tb "$LBL" 2>/dev/null)"
has "spent: text board squad line" "$SPT" "spent ≈3M since 2026-"
has "spent: text board project total" "$SPT" "SPENT  ≈5M since 2026-"
rm -rf "$DS_STATE_ROOT/$LBL/loop" "$SD/tk-sq.json"
board "$LBL" > "$TMP/sp0.json"
jt "spent: no file -> no total" "$TMP/sp0.json" '.spent_total == null'

# Layout (B4b): one full-width column, fixed-width tracks, documents chips, collapsible graph.
BH="$ROOT/web/board.html"
eq "web board: units/crew grids have no auto column" "$(grep -E '^\.(units \.u|crew \.m)\{grid-template-columns' "$BH" | grep -cw auto)" "0"
eq "web board: no side column in the squad detail" "$(grep -cF 'class="dgrid"' "$BH")" "0"
eq "web board: units PR column is 150px, then the 32px ⋯ column" "$(grep -cF '.units .u{grid-template-columns:14px minmax(0,1.4fr) 100px 72px 52px minmax(0,1fr) 150px 32px}' "$BH")" "1"
eq "web board: crew has a Machine column between the account and Spent 7d" "$(grep -cF '<span>Model · Effort @ Account</span><span>Machine</span><span class="num">Spent 7d</span>' "$BH")" "1"
eq "web board: the RAM badge and the sessions mark sit in the Machine cell, not the account cell" "$(grep -F 'class="mach"' "$BH" | grep -F 'RAM ${kbText' | grep -cF 'live agent sessions in one worktree')" "1"
eq "web board: the account cell has no RAM badge" "$(grep -F 'class=${"acct"' "$BH" | grep -cF 'RAM ${kbText')" "0"
eq "web board: crew dot comes from crewDot with a reason title" "$(grep -cF 'const d = crewDot(s, m); return html`<span class=${"dot " + d.cls} title=${d.why || undefined}' "$BH")" "1"
eq "web board: documents merge plans and pages" "$(grep -cF 'count[i.name] > 1 && i.dir ? i.dir' "$BH")" "1"
eq "web board: documents show-all past 10" "$(grep -cF 'items.slice(0, 10)' "$BH")" "1"
eq "web board: graph has no auto-collapse rule" "$(grep -cF 'units.length <= 20' "$BH")" "0"
eq "web board: graph sits above the work units" "$(awk '/<\$\{GraphBox\}/{g=NR} /<\$\{UnitsBox\}/{u=NR} END{print (g<u)}' "$BH")" "1"

# B5: --serve only writes the wish (a `services` row in loop.db) and prints the URL; the loop runs the
# server (tests/loop/services.test.ts). --ensure is gone: a notice and exit 0. --stop sets the wish
# to stopped. All against a state root of its own, so no loop.db lands in the repo's state/.
SVR="$TMP/svcroot"; mkdir -p "$SVR/$LBL"
bsh() { DS_STATE_ROOT="$SVR" DS_BIND=127.0.0.1 DS_BOARD_SERVE_WAIT="${WAIT:-0}" "$ROOT/bin/board/board.sh" "$@" 2>&1; }
svc() { DS_STATE_ROOT="$SVR" "$ROOT/bin/ds" services | jq -r --arg p "$1" '.[] | select(.name == "board" and .project == $p) | [.want, .port, (.status // "-"), (.pid // "-")] | @tsv'; }
nboards() { pgrep -fc "board-server.ts 127.0.0.1 8799" 2>/dev/null || true; }
before="$(nboards)"
out="$(bsh "$LBL" --serve 8799)"
has "serve: prints the URL"                 "$out" "http://127.0.0.1:8799/"
has "serve: says the loop runs it"          "$out" "the loop runs it on :8799"
eq  "serve: writes the services row"        "$(svc "$LBL")" "$(printf 'running\t8799\t-\t-')"
eq  "serve: starts no process itself"       "$(nboards)" "$before"
eq  "serve: writes no pidfile"           "$([ -e "$SVR/$LBL/board-serve.pid" ] && echo pidfile || echo none)" "none"
eq  "serve: asked again, the port is kept"  "$(bsh "$LBL" --serve >/dev/null; svc "$LBL" | cut -f2)" "8799"
rc=0; out="$(bsh "$LBL" --ensure)" || rc=$?
eq  "ensure: exits 0"                       "$rc" "0"
has "ensure: says the loop runs the board"  "$out" "the loop runs the board now"
has "stop: says the loop stops it"          "$(bsh "$LBL" --stop)" "the loop stops it on its next tick"
eq  "stop: the wish is stopped"             "$(svc "$LBL" | cut -f1)" "stopped"
has "serve: no project is the all scope"    "$(bsh --serve 8798)" "board (all projects)"
eq  "serve: ... a row with no project"      "$(svc "" | cut -f1,2)" "$(printf 'running\t8798')"
eq  "serve: the asker's DS_BIND rides in the wish" "$(DS_STATE_ROOT="$SVR" "$ROOT/bin/ds" services | jq -r '.[] | select(.project == "") | .want_payload' | jq -r .bind)" "127.0.0.1"
# U76: --serve on a row that says running with a dead pid re-arms the wish and says so; a live pid is a no-op.
sqlr() { DS_STATE_ROOT="$SVR" bun -e 'const {Database}=require("bun:sqlite");const d=new Database(process.env.DS_STATE_ROOT+"/loop.db");const q=process.argv[1];if(/^select/i.test(q))console.log(JSON.stringify(d.query(q).all()));else d.run(q)' "$1"; }
bsh "$LBL" --serve 8795 >/dev/null
sqlr "UPDATE services SET status='running', pid=2147483000, started_at=100, want_at=100 WHERE project='$LBL'"
has "serve: a running row with a dead pid says was down" "$(bsh "$LBL" --serve)" "was down, the loop restarts it on its next tick"
eq  "serve: ... and moves want_at" "$(sqlr "SELECT want_at > 100 AS m FROM services WHERE project='$LBL'" | jq -r '.[0].m')" "1"
bash -c 'exec -a board-server sleep 30' & livepid=$!
sqlr "UPDATE services SET pid=$livepid, want_at=100 WHERE project='$LBL'"
out="$(bsh "$LBL" --serve)"
kill "$livepid" 2>/dev/null || true
has "serve: a live pid says the loop runs it" "$out" "the loop runs it on :8795"
eq  "serve: ... and changes nothing" "$(sqlr "SELECT want_at FROM services WHERE project='$LBL'" | jq -r '.[0].want_at')" "100"
# U2 (board-empty-state-and-port): a board the loop moved (asked 8795, bound 8796) prints the bound port.
bash -c 'exec -a board-server sleep 30' & livepid=$!
sqlr "UPDATE services SET pid=$livepid, port=8796 WHERE project='$LBL'"
out="$(bsh "$LBL" --serve)"
kill "$livepid" 2>/dev/null || true
has "serve: a moved board prints its bound port" "$out" "the loop runs it on :8796 (8795 was taken) — open http://127.0.0.1:8796/"
eq  "serve: ... and asking again changes nothing" "$(sqlr "SELECT want_at, port FROM services WHERE project='$LBL'" | jq -r '.[0] | "\(.want_at) \(.port)"')" "100 8796"
sqlr "UPDATE services SET status=NULL, pid=NULL WHERE project='$LBL'"
rc=0; out="$(WAIT=1 bsh "$LBL" --serve 8797)" || rc=$?
eq  "serve: no loop to start it within the wait exits 1" "$rc" "1"
has "serve: ... and says it is not running"  "$out" "not running"

# U5: every open unit has a ⋯ menu: Cancel for any not done or cancelled, Release only for a held one; the
# Cancel confirm asks for a reason and lists the open dependents. Data from board.json, markup from the page source.
ud="$DS_STATE_ROOT/zzunit_$$/squads"; mkdir -p "$ud"
cat > "$ud/m.json" <<'JSON'
{"status":"running","members":[],"units":[
 {"slug":"held","status":"planned","hold":true},
 {"slug":"mid","status":"planned","deps":["held"]},
 {"slug":"leaf","status":"planned","deps":["mid"]},
 {"slug":"fin","status":"done"},
 {"slug":"gone","status":"cancelled"},
 {"slug":"after-fin","status":"planned","deps":["fin"]}]}
JSON
board "zzunit_$$" > "$TMP/un.json"
UQ='.squads[] | select(.topic=="m") | .units | map({(.slug): .}) | add'
jt "unit menu: held shows Release (held) and its two open dependents" "$TMP/un.json" "$UQ | .held.held == true and .held.dependents == [\"mid\",\"leaf\"]"
jt "unit menu: an unheld open unit has Cancel only, with its dependents" "$TMP/un.json" "$UQ | .mid.held == false and .mid.dependents == [\"leaf\"] and .leaf.dependents == []"
jt "unit menu: a done unit does not count as a dependent, and has no menu state to act on" "$TMP/un.json" "$UQ | .fin.dependents == [\"after-fin\"] and .fin.state == \"done\" and .gone.state == \"cancelled\" and .fin.held == false"
ua_fn=$(sed -n '/^function UnitActions(/,/^}/p' "$ROOT/web/board.html")
eq "unit menu: finished units get no menu, the rest the ⋯ trigger" "$(printf '%s' "$ua_fn" | grep -cF 'u.state === "done" || u.state === "cancelled") return html`<span></span>`')$(printf '%s' "$ua_fn" | grep -cF 'aria-label=${label}')" "12"
eq "unit menu: Release only for a held unit, Cancel always" "$(printf '%s' "$ua_fn" | grep -cF '${u.held && html`<button class="btn sm unit-release"')$(printf '%s' "$ua_fn" | grep -cF 'class="btn sm unit-cancel"')" "11"
cu_fn=$(sed -n '/^function CancelUnit(/,/^}/p' "$ROOT/web/board.html")
eq "unit menu: the cancel confirm asks a reason, lists the dependents and needs the reason" "$(printf '%s' "$cu_fn" | grep -cF 'class="cancel-why"')$(printf '%s' "$cu_fn" | grep -cF 'will be cancelled too')$(printf '%s' "$cu_fn" | grep -cF 'disabled=${!why.trim()}')" "111"
eq "unit menu: both post api/unit" "$(grep -cF 'post("api/unit"' "$ROOT/web/board.html")" "1"
rm -rf "$DS_STATE_ROOT/zzunit_$$"

# unit-detail-cleanup U2: the unit window has a title, one status line, rows only when they hold something, and the buttons in the bottom bar.
ud="$DS_STATE_ROOT/zzdet_$$/squads"; mkdir -p "$ud"
cat > "$ud/m.json" <<'JSON'
{"status":"running","members":[],"units":[
 {"slug":"u1-text","status":"planned","plan":"/p/plan.md","plan_unit":"U1","title":"Show the text","about":"Stores what the unit does.","done":"the overlay opens.","check":"tests/board.sh","links":["https://linear.app/acme/issue/ABC-1/x","javascript:alert(1)","https://example.org/page"],"hold":true,"hold_reason":"waiting for the operator","deps":[]},
 {"slug":"u2-after","status":"planned","deps":["u1-text"]},
 {"slug":"u3-bare","status":"planned"},
 {"slug":"adhoc-fix","status":"done","about":"Fixes the stale lane label on the flow card. It also renames the key.","deps":["u1-text"],"pr":"#24508"}]}
JSON
board "zzdet_$$" > "$TMP/det.json"
dbw "UPDATE units SET done_at = 1700000000 WHERE slug = 'adhoc-fix'"
render "zzdet_$$" --json > "$TMP/det.json"
DQ='.squads[] | select(.topic=="m") | .units | map({(.slug): .}) | add'
jt "unit details: the stored text reaches the board" "$TMP/det.json" "$DQ | .\"u1-text\" | .title == \"Show the text\" and .about == \"Stores what the unit does.\" and .done_text == \"the overlay opens.\" and .check_text == \"tests/board.sh\" and .plan == \"/p/plan.md\" and .plan_unit == \"U1\""
jt "unit links: the doc's http(s) links reach the board with their labels, a javascript: value does not" "$TMP/det.json" "$DQ | .\"u1-text\".links == [{url:\"https://linear.app/acme/issue/ABC-1/x\",label:\"ABC-1\"},{url:\"https://example.org/page\",label:\"example.org\"}] and .\"u3-bare\".links == []"
eq "unit links: at phone width the row chip has a tap area of at least 44px" "$(sed -n '/^@media (max-width:600px){/,/^}/p' "$ROOT/web/board.html" | grep -cF '.units .u .ulink{min-height:44px;min-width:44px;')" "1"
jt "unit details: hold kind and reason, and who waits on it" "$TMP/det.json" "$DQ | .\"u1-text\" | .hold_reason == \"waiting for the operator\" and (.hold_kind | startswith(\"frozen\")) and (.dependents | index(\"u2-after\"))"
jt "unit details: a unit with no stored text carries nulls, for the fallback" "$TMP/det.json" "$DQ | .\"u3-bare\" | .about == null and .done_text == null and .check_text == null and .hold_kind == null"
jt "unit details: done_at is on the done unit's row and null on an open one" "$TMP/det.json" "$DQ | .\"adhoc-fix\".done_at == 1700000000 and .\"u3-bare\".done_at == null"
ud_fn=$(sed -n '/^function UnitDetails(/,/^}/p' "$ROOT/web/board.html")
for f in ud-title ud-slug ud-status ud-about ud-done ud-check ud-links ud-waits ud-dependents ud-hold ud-builder ud-plan ud-release ud-cancel ud-chat ud-show ud-answer ud-bar; do
  eq "unit details: the window has $f" "$(printf '%s' "$ud_fn" | grep -cF "$f" | sed 's/^[1-9][0-9]*$/ok/')" "ok"
done
eq "unit details: no 'not stored' text and no add-unit hint" "$(printf '%s' "$ud_fn" | grep -cF 'not stored')$(printf '%s' "$ud_fn" | grep -cF 'add-unit')" "00"
eq "unit details: Escape and the backdrop close it" "$(printf '%s' "$ud_fn" | grep -cF 'e.key === "Escape"')$(printf '%s' "$ud_fn" | grep -cF 'e.target === e.currentTarget')" "11"
ub_fn=$(sed -n '/^function UnitsBox(/,/^}/p' "$ROOT/web/board.html")
eq "unit details: a row click opens it, a button, link or the menu does not" "$(printf '%s' "$ub_fn" | grep -cF 'e.target.closest("a,button,.acts")')" "1"
eq "unit details: the slug is a keyboard-reachable button, and the menu has Details" "$(printf '%s' "$ub_fn" | grep -cF 'class="unit-open"')$(sed -n '/^function UnitActions(/,/^}/p' "$ROOT/web/board.html" | grep -cF 'unit-details')" "11"
eq "unit details: both callers pass onPlan" "$(grep -cF 'onPlan=${setPlan} onClose=${() => setFlowUnit(null)}' "$ROOT/web/board.html")$(grep -cF 'onShow=${showCrewRow} onPlan=${onPlan}' "$ROOT/web/board.html")" "11"
rm -rf "$DS_STATE_ROOT/zzdet_$$"

# ext_deps: a unit waiting on another squad's unit (resolved from sibling states + archive).
EL="zzext_$$"; ED="$DS_STATE_ROOT/$EL"; mkdir -p "$ED/squads" "$ED/archive"
cat > "$ED/squads/one.json" <<'JSON'
{"status":"running","members":[],"units":[
 {"slug":"ready1","status":"planned","ext_deps":["two/y"]},
 {"slug":"blk","status":"planned","ext_deps":["three/z"]},
 {"slug":"miss","status":"planned","ext_deps":["nope/q"]},
 {"slug":"arch","status":"planned","ext_deps":["old/w"]}]}
JSON
echo '{"status":"running","members":[],"units":[{"slug":"y","status":"done"}]}' > "$ED/squads/two.json"
echo '{"status":"running","members":[],"units":[{"slug":"z","status":"planned"}]}' > "$ED/squads/three.json"
echo '{"status":"closed","topic":"old","units":[{"slug":"w","status":"done"}]}' > "$ED/archive/old-2026.json"
board "$EL" > "$TMP/ext.json"
EU='.squads[] | select(.topic=="one") | .units[] | select(.slug=='
jt "ext dep done -> ready"      "$TMP/ext.json" "$EU\"ready1\") | .state==\"ready\" and .ext_deps[0].status==\"done\""
jt "ext dep planned -> blocked" "$TMP/ext.json" "$EU\"blk\") | .state==\"blocked\" and .ext_deps[0]=={ref:\"three/z\",status:\"planned\"}"
jt "ext dep missing -> blocked" "$TMP/ext.json" "$EU\"miss\") | .state==\"blocked\" and .ext_deps[0].status==\"missing\""
jt "archived done dep -> ready" "$TMP/ext.json" "$EU\"arch\") | .state==\"ready\" and .ext_deps[0].status==\"closed-done\""
BLACK="$(tb "$EL" 2>/dev/null || true)"
case "$BLACK" in *"waits on three/z (planned)"*) pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: text output lacks 'waits on three/z (planned)'" >&2;; esac
if grep -q 'ext_deps' "$ROOT/web/board.html"; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: board.html lacks ext_deps" >&2; fi
rm -rf "$ED"

# PR health: the sweep's pr-health.json refines dispatched phases — ready is merge-ready, a
# blocked PR the sweep poked is stale (with reasons); blocked-but-unpoked stays babysitting,
# and a gone Builder still overrides. Rows observed more than 10 min ago are ignored.
GRH="$TMP/ghrepo2"
jq --arg r "path:$GRH" '.repos = {($r): "acme/app2"} | .prs = [501,502,503,504 | {"repo":"acme/app2","pr":.,"state":"OPEN","ci":"green","head":"x"}]' "$SEED" > "$TMP/seed-hl.json"
printf '{"run_id":"h1","status":"running","repo":"path:%s","members":[{"role":"builder","suffix":"s","wt":"wtBp"}],"units":[{"slug":"s","status":"dispatched","builder_wt":"wtBp","pr":"501"},{"slug":"r","status":"dispatched","builder_wt":"wtBp","pr":"502"},{"slug":"u","status":"dispatched","builder_wt":"wtBp","pr":"503"},{"slug":"g","status":"dispatched","builder_wt":"wtGone","pr":"504"}]}' "$GRH" > "$SD/health.json"
NOWH="$(date +%s)"
mkdir -p "$DS_STATE_ROOT/$LBL/sweep"
printf '{"at":%s,"units":{"health/s":{"pr":501,"verdict":"blocked","reasons":"conflicting,threads:2","since":%s,"poked":%s,"pokes":1},"health/r":{"pr":502,"verdict":"ready","reasons":""},"health/u":{"pr":503,"verdict":"blocked","reasons":"conflicting"},"health/g":{"pr":504,"verdict":"blocked","reasons":"checks-failing","since":%s,"poked":%s,"pokes":1}}}' \
  "$NOWH" "$((NOWH-600))" "$((NOWH-120))" "$((NOWH-600))" "$((NOWH-120))" > "$DS_STATE_ROOT/$LBL/sweep/pr-health.json"
SEED="$TMP/seed-hl.json" board "$LBL" > "$TMP/hl.json"
H='.squads[] | select(.topic=="health")'
jt "health: poked blocked unit is stale, with reasons" "$TMP/hl.json" "$H"' | .units[] | select(.slug=="s") | .state=="stale" and .reasons=="conflicting,threads:2"'
jt "health: ready unit is merge-ready" "$TMP/hl.json" "$H"' | .units[] | select(.slug=="r") | .state=="merge-ready"'
jt "health: unpoked blocked unit stays babysitting" "$TMP/hl.json" "$H"' | .units[] | select(.slug=="u") | .state=="babysitting"'
jt "health: a gone Builder still overrides stale" "$TMP/hl.json" "$H"' | .units[] | select(.slug=="g") | .state=="gone"'
HT="$(SEED="$TMP/seed-hl.json" tb "$LBL" 2>/dev/null)"
has "health: text board shows stale with reasons" "$HT" "(stale: conflicting,threads:2)"
has "health: text board shows merge-ready" "$HT" "(merge-ready)"
eq "web board: stale dot is amber" "$(grep -cF '.dot.stale{background:var(--amber)}' "$ROOT/web/board.html")" "1"
eq "web board: merge-ready dot is green" "$(grep -cF '.dot.merge-ready{background:var(--green)}' "$ROOT/web/board.html")" "1"
eq "web board: stale state is amber" "$(grep -cF '.ust.stale{color:var(--amber)}' "$ROOT/web/board.html")" "1"
eq "web board: merge-ready state is green" "$(grep -cF '.ust.merge-ready{color:var(--green)}' "$ROOT/web/board.html")" "1"
eq "web board: stale row shows reasons" "$(grep -cF 'u.state + ": " + u.reasons' "$ROOT/web/board.html")" "1"
jq --argjson at "$((NOWH-900))" '.at = $at' "$DS_STATE_ROOT/$LBL/sweep/pr-health.json" > "$TMP/ph" && mv "$TMP/ph" "$DS_STATE_ROOT/$LBL/sweep/pr-health.json"
SEED="$TMP/seed-hl.json" board "$LBL" > "$TMP/hl2.json"
jt "health: rows older than 10 min are ignored" "$TMP/hl2.json" "$H"' | .units[] | select(.slug=="s") | .state=="babysitting" and .reasons==null'
printf '{not json' > "$DS_STATE_ROOT/$LBL/sweep/pr-health.json"
SEED="$TMP/seed-hl.json" board "$LBL" > "$TMP/hl3.json"
jt "health: malformed JSON is ignored, not fatal" "$TMP/hl3.json" "$H"' | .units[] | select(.slug=="s") | .state=="babysitting" and .reasons==null'
printf '{"at":%s,"units":{"health/s":{"pr":501,"verdict":"blocked","reasons":"","poked":%s,"pokes":1}}}' "$NOWH" "$((NOWH-120))" > "$DS_STATE_ROOT/$LBL/sweep/pr-health.json"
SEED="$TMP/seed-hl.json" board "$LBL" > "$TMP/hl4.json"
jt "health: stale with empty reasons keeps null reasons" "$TMP/hl4.json" "$H"' | .units[] | select(.slug=="s") | .state=="stale" and .reasons==null'
HT4="$(SEED="$TMP/seed-hl.json" tb "$LBL" 2>/dev/null)"
has "health: text board shows bare stale without reasons" "$HT4" "(stale)"
rm -f "$SD/health.json"; rm -rf "$DS_STATE_ROOT/$LBL/sweep"

eq "the board never calls the backend (only the write routes poke and press keys)" "$(grep -cvE '^(poke|keys) ' "$BOARD_LOG" || true)" "0"

# U3 (retire-builder): a cancelled unit renders outside the ✓/⟳/○ totals, a planned unit
# depending on it follows U1's into rule, and leftovers show in both views.
cat > "$SD/cx-sq.json" <<'JSON'
{"run_id":"cx","status":"running","type":"feature","members":[],"units":[
 {"slug":"u1","status":"cancelled","superseded_by":"PR#19717","into_merged":true,"cancel_reason":"folded"},
 {"slug":"u2","status":"planned","deps":["u1"]},
 {"slug":"u3","status":"cancelled"},
 {"slug":"u4","status":"planned","deps":["u3"]},
 {"slug":"u5","status":"cancelled","superseded_by":"u6"},
 {"slug":"u6","status":"planned","deps":["u5"]}],
 "leftovers":[{"wt":"w1::/tmp/wt-keep","path":"/tmp/wt-keep","branch":"br-keep","reason":"uncommitted changes","waits_on":"PR#19717","unit":"u1","files":["a.ts","b.ts"],"n_files":2,"unpushed":1,"recorded_at":"2026-10-08T09:00:00Z"}]}
JSON
board "$LBL" > "$TMP/cx.json"
CX='.squads[] | select(.topic=="cx-sq")'
jt "cancelled unit state + into fields" "$TMP/cx.json" "$CX | .units[] | select(.slug==\"u1\") | .state==\"cancelled\" and .superseded_by==\"PR#19717\" and .into_merged==true and .cancel_reason==\"folded\""
jt "dep on merged-into PR is ready"     "$TMP/cx.json" "$CX | .units[] | select(.slug==\"u2\") | .state==\"ready\" and .blocked_by==[]"
jt "dep on dropped work is blocked"     "$TMP/cx.json" "$CX | .units[] | select(.slug==\"u4\") | .state==\"blocked\" and .blocked_by==[\"u3 (work dropped)\"]"
jt "folded into its dependent counts"   "$TMP/cx.json" "$CX | .units[] | select(.slug==\"u6\") | .state==\"ready\""
jt "cancelled outside the totals"       "$TMP/cx.json" "$CX | .progress=={\"done\":0,\"dispatched\":0,\"planned\":3,\"cancelled\":3,\"total\":3}"
jt "cancelled nodes get mcancel"         "$TMP/cx.json" "$CX | .mermaid | contains(\"classDef mcancel \") and contains(\"class nu1,nu3,nu5 mcancel\")"
jt "leftover record in JSON"            "$TMP/cx.json" "$CX | .leftovers[0] | .path==\"/tmp/wt-keep\" and .branch==\"br-keep\" and .n_files==2 and .unpushed==1 and .waits_on==\"PR#19717\" and .unit==\"u1\" and (.age_min > 0)"
CXT="$(tb "$LBL" 2>/dev/null)"
has "text: units line counts ✗"          "$CXT" "units ✓0 ⟳0 ○3 ✗3"
has "text: cancelled row folds into PR"  "$CXT" "folded into PR#19717"
hasre "text: ✗ marks the cancelled row"  "$CXT" '✗ u1 '
has "text: blocked names work dropped"   "$CXT" "blocked by u3 (work dropped)"
has "text: LEFTOVERS block"              "$CXT" "LEFTOVERS"
has "text: leftover names path+branch"   "$CXT" "⚑ /tmp/wt-keep  (br-keep) — not checked yet"
case "$CXT" in *"waits on PR#19717"*) fail=$((fail+1)); echo "  FAIL: text still shows waits on" >&2;; *) pass=$((pass+1));; esac
# Same dep without into_merged -> blocked; dropped-cancelled dep -> blocked.
jq '(.units[] | select(.slug=="u1") | .into_merged) = false' "$SD/cx-sq.json" > "$TMP/cx2" && mv "$TMP/cx2" "$SD/cx-sq.json"
board "$LBL" > "$TMP/cx2.json"
jt "dep on unmerged-into PR is blocked" "$TMP/cx2.json" "$CX | .units[] | select(.slug==\"u2\") | .state==\"blocked\""
rm -f "$SD/cx-sq.json"
eq "web board: cancelled counts as finished" "$(grep -cF 'u.state === "cancelled" || (u.state === "done"' "$ROOT/web/board.html")" "1"
eq "board-data: open units exclude cancelled" "$(grep -cF 'u.state !== "done" && u.state !== "cancelled"' "$ROOT/bin/board/board-data.ts")" "2"
eq "web board: units total excludes cancelled" "$(grep -cF 'total: n((x) => x.state !== "cancelled")' "$ROOT/web/board.html")" "1"
eq "web board: LeftoversBox under UnitsBox" "$(grep -cF "<\${LeftoversBox} s=" "$ROOT/web/board.html")" "1"
eq "web board: leftover files in a title tooltip" "$(grep -cF '(c.differ || []).join("\n")' "$ROOT/web/board.html")" "1"
eq "web board: cancelled dot + state styles" "$(grep -cF '.dot.cancelled' "$ROOT/web/board.html")$(grep -cF '.ust.cancelled' "$ROOT/web/board.html")" "11"

# The loop's health row: a fresh tick -> no banner; older than board_stale_ticks (12) ticks of
# DS_LOOP_TICK_S (5 s) -> "loop down / data as of <time>", and the board still renders the last data.
printf '{"run_id":"lp","status":"running","type":"feature","members":[{"role":"lead","wt":"wtLead"}],"units":[{"slug":"u1","status":"done"}]}' > "$SD/loop-sq.json"
board "$LBL" > "$TMP/lp1.json"
jt "loop: fresh tick -> not down"     "$TMP/lp1.json" '.loop.down == false and .loop.age_s <= 5 and .loop.stale_after_s == 60'
jt "loop: data as of per section"     "$TMP/lp1.json" '.as_of.squads > 0 and .as_of.workers > 0 and .as_of.documents > 0 and (.as_of | has("prs") and has("tokens") and has("accounts") and has("spend"))'
eq "loop: no LOOP line when up"       "$(tb "$LBL" 2>/dev/null | grep -c '^LOOP' || true)" "0"
# U3: restarts from loop_restart events: counted over 24 h; the keeps-stalling flag needs 3 within 60 min.
jq '.events = [{"ago":7200,"kind":"loop_restart"},{"ago":600,"kind":"loop_restart"}]' "$SEED" > "$TMP/seed-rs2.json"
SEED="$TMP/seed-rs2.json" board "$LBL" > "$TMP/rs2.json"
jt "loop: 2 restarts, 1 in the hour -> counted, not stalling" "$TMP/rs2.json" '.loop.restarts_24h == 2 and .loop.last_restart_at > 0 and .loop.stalling == false'
jq '.events = [{"ago":3000,"kind":"loop_restart"},{"ago":1000,"kind":"loop_restart"},{"ago":100,"kind":"loop_restart"},{"ago":90000,"kind":"loop_restart"}]' "$SEED" > "$TMP/seed-rs3.json"
SEED="$TMP/seed-rs3.json" board "$LBL" > "$TMP/rs3.json"
jt "loop: 3 restarts in 60 min -> stalling (the 25 h old one not counted)" "$TMP/rs3.json" '.loop.restarts_24h == 3 and .loop.stalling == true and .loop.restarts_recent == 3'
has "loop: text says the loop keeps stalling" "$(SEED="$TMP/seed-rs3.json" tb "$LBL" 2>/dev/null)" "the loop keeps stalling"
jt "loop: no restarts -> zero, not stalling" "$TMP/lp1.json" '.loop.restarts_24h == 0 and .loop.last_restart_at == null and .loop.stalling == false'
jq '.health_age = 61' "$SEED" > "$TMP/seed-old.json"
SEED="$TMP/seed-old.json" board "$LBL" > "$TMP/lp2.json"
jt "loop: aged health row -> down"    "$TMP/lp2.json" '.loop.down == true and .loop.age_s >= 61 and .loop.tick_at > 0'
jq '.progress_age = 0' "$TMP/seed-old.json" > "$TMP/seed-progress.json"
SEED="$TMP/seed-progress.json" board "$LBL" > "$TMP/lp-progress.json"
jt "loop: completed work during a long tick -> not down" "$TMP/lp-progress.json" '.loop.down == false and .loop.age_s <= 5 and .loop.tick_no == 1'
jq '.progress_age = 61' "$TMP/seed-old.json" > "$TMP/seed-blocked.json"
SEED="$TMP/seed-blocked.json" board "$LBL" > "$TMP/lp-blocked.json"
jt "loop: no completed work for the stale interval -> down" "$TMP/lp-blocked.json" '.loop.down == true and .loop.age_s >= 61'
# U234: the header carries how long a tick takes; amber (tick_slow) above 4x DS_LOOP_TICK_S (20 s), with the step the latest tick_slow named.
mkdb "$LBL"
bun -e 'const {Database} = await import("bun:sqlite"); const db = new Database("'"$DBR"'/loop.db"); db.run("UPDATE health SET tick_ms = 3200"); db.close();'
render "$LBL" --json > "$TMP/tk-fast.json"
jt "loop: a fast tick shows its time, not amber" "$TMP/tk-fast.json" '.header.tick_ms == 3200 and .header.tick_slow == false'
bun -e 'const {Database} = await import("bun:sqlite"); const db = new Database("'"$DBR"'/loop.db"); db.run("UPDATE health SET tick_ms = 45000"); db.run("INSERT INTO events (at, kind, payload) VALUES (1, '"'"'tick_slow'"'"', '"'"'{\"slowest\":{\"step\":\"members:acme\",\"avg_ms\":24000}}'"'"')"); db.close();'
render "$LBL" --json > "$TMP/tk-slow.json"
jt "loop: a 45 s tick is amber and names the slowest step" "$TMP/tk-slow.json" '.header.tick_ms == 45000 and .header.tick_slow == true and .header.tick_slowest == "members:acme"'
eq "web board: the Updated tile shows ticks take and turns amber" "$(grep -c 'H.tick_slow ? "warn"' "$ROOT/web/board.html"; grep -c 'ticks take' "$ROOT/web/board.html")" "$(printf '1\n1')"
SEED="$TMP/seed-old.json" mkdb "$LBL"
bun -e 'const {Database} = await import("bun:sqlite"); const db = new Database("'"$DBR"'/loop.db"); db.run("ALTER TABLE health DROP COLUMN progress_at"); db.close();'
render "$LBL" --json > "$TMP/lp-legacy.json"
jt "loop: pre-progress database still renders stale health" "$TMP/lp-legacy.json" '.loop.down == true and .loop.tick_at > 0'
jt "loop: down, the last data still renders" "$TMP/lp2.json" '.squads[] | select(.topic=="loop-sq") | .display_status == "wrapping up" and (.members[0].state == "working")'
LT="$(SEED="$TMP/seed-old.json" tb "$LBL" 2>/dev/null)"
hasre "loop: text board banner"       "$LT" '^LOOP  ⚠ loop down — data as of [0-9:]{5} \([0-9]+ min ago\)'
has "loop: text names the fix"        "$LT" "bin/loop/loop.sh --ensure"
jq '.health_age = null' "$SEED" > "$TMP/seed-none.json"
SEED="$TMP/seed-none.json" board "$LBL" > "$TMP/lp3.json"
jt "loop: no health row -> down, never ticked" "$TMP/lp3.json" '.loop.down == true and .loop.tick_at == null'
has "loop: text says never ticked"    "$(SEED="$TMP/seed-none.json" tb "$LBL" 2>/dev/null)" "it has never ticked"
DS_STATE_ROOT="$DBR" "$ROOT/bin/commands/limits.sh" set "$LBL" board_stale_ticks 20 >/dev/null
SEED="$TMP/seed-old.json" board "$LBL" > "$TMP/lp4.json"
jt "loop: board_stale_ticks from the project's limits" "$TMP/lp4.json" '.loop.down == false and .loop.stale_after_s == 100'
DS_STATE_ROOT="$DBR" "$ROOT/bin/commands/limits.sh" rm "$LBL" board_stale_ticks >/dev/null
DS_STATE_ROOT="$TMP/nodb" PATH="$NP" "$ROOT/bin/board/board.sh" "$LBL" --json > "$TMP/lp5.json" 2>/dev/null
jt "loop: no loop.db -> empty board behind the banner" "$TMP/lp5.json" '.loop.down == true and .squads == [] and .backend_ok == false'
rm -f "$SD/loop-sq.json"
BH="$ROOT/web/board.html"
eq "web board: loop-down banner says data as of" "$(grep -cF 'Loop down${data.loop.tick_at ? " / data as of "' "$BH")" "1"
eq "web board: loop banner is its own line, the Leads' stall banner kept" "$(grep -cF 'id="loop-down"' "$BH")$(grep -cF 'data.stall && html' "$BH")" "11"
eq "web board: keeps-stalling banner and restart count line" "$(grep -cF 'id="loop-stalling"' "$BH")$(grep -cF 'Loop restarted ${data.loop.restarts_24h}× in 24 h' "$BH")" "11"

# board-update-button U3: the update banner sits in the status block after loop-down, loop-stalling and
# the backend banner, has its own calm .info style, and its press confirms the cost before filing `update`.
eq "web board: update banner is one component with its id" "$(grep -cF 'id="ds-update"' "$BH")$(grep -cF 'function UpdateBanner' "$BH")" "11"
eq "web board: update banner after loop-down, stalling and backend banners" "$(awk '/id="loop-down"/{d=NR} /id="loop-stalling"/{s=NR} /isn.t answering/{b=NR} /<\$\{UpdateBanner\}/{u=NR} END{print (d<s && s<b && b<u)}' "$BH")" "1"
eq "web board: .banner.info style exists" "$(grep -cF '.banner.info{' "$BH")" "1"
eq "web board: failed or stale check uses the amber style" "$(grep -cF 'cls = "err"; body = html`<b>Can' "$BH" | awk '{print ($1>=3)}')$(grep -cF 'The dev-studio update check is stale' "$BH")" "11"
eq "web board: Show commits expands titles with class tags" "$(grep -cF 'Show commits' "$BH")$(grep -cF 'class="utag"' "$BH")$(grep -cF 'u.commits || []).map' "$BH")" "111"
eq "web board: Update files the update action after a confirm naming cost and other projects" "$(grep -cF 'action: "update" }, toast, ask' "$BH")$(grep -cF 'and restarts the loop for every project. In "' "$BH")$(grep -cF 'their squads refresh when each project updates' "$BH")" "111"
# U6: a refused/failed result has a Retry that files the same update action after a confirm naming the line; behind + failed says last try.
eq "web board: Retry files the update action after a confirm naming the line" "$(grep -cF '>Retry</button>' "$BH")$(grep -cF 'again. Fix the reason first: ' "$BH")$(grep -cF 'last try ${badTry.outcome}' "$BH")" "111"
eq "web board: Refresh squads button for this project's squads behind" "$(grep -cF '>Refresh squads</button>' "$BH")" "1"
eq "web board: /reload-skills hint only when skills changed" "$(grep -cF 'includes("skills") ? " Afterwards type /reload-skills' "$BH")" "1"
eq "web board: pending says waiting for the Studio, then names the manual command" "$(grep -cF 'waiting for the Studio.' "$BH")$(grep -cF 'is the Studio running?' "$BH")" "11"
eq "web board: the sweep banner is gone" "$(grep -cF 'data.sweep' "$BH")" "0"
eq "web board: data as of on the squads and accounts" "$(grep -cF 'asOf(data.as_of && data.as_of.squads)' "$BH")$(grep -cF 'asOf(data.as_of && data.as_of.accounts)' "$BH")" "11"

# A Tester with open work: a feature squad whose units are all done, with its units and members
# rows in unsorted order, is testing — no wrapping up row, no ★ — until the Tester retires.
printf '{"run_id":"ow","status":"running","type":"feature","members":[{"role":"tester","wt":"wtTe"},{"role":"builder","suffix":"u2","wt":"wtB2"},{"role":"lead","wt":"wtLead"}],"units":[{"slug":"u3","status":"done"},{"slug":"u1","status":"done"},{"slug":"u2","status":"done","builder_wt":"wtB2"}]}' > "$SD/open-work.json"
board "$LBL" > "$TMP/ow.json"
jt "open work: tester -> testing, not wrapping up" "$TMP/ow.json" '.squads[] | select(.topic=="open-work") | .display_status == "testing" and ([.units[].slug] == ["u1","u2","u3"])'
OW="$(tb "$LBL" 2>/dev/null)"
eq "open work: no wrapping up row" "$(printf '%s\n' "$OW" | grep -cF 'open-work  [wrapping up]' || true)" "0"
eq "open work: no ★"                  "$(printf '%s\n' "$OW" | grep -c '★' || true)" "0"
jq '.members |= map(select(.role != "tester"))' "$SD/open-work.json" > "$TMP/ow2" && mv "$TMP/ow2" "$SD/open-work.json"
board "$LBL" > "$TMP/ow2.json"
jt "open work: Tester retired -> wrapping up" "$TMP/ow2.json" '.squads[] | select(.topic=="open-work") | .display_status == "wrapping up"'
rm -f "$SD/open-work.json"

# Two projects (dev-studio- and acme-shaped labels) render the same way from one db; a worktree
# whose row has gone_at is not counted live.
P1="zzdev_$$"; P2="zzacme_$$"; mkdir -p "$DS_STATE_ROOT/$P1/squads" "$DS_STATE_ROOT/$P2/squads"
printf '{"run_id":"a","status":"running","type":"feature","repo":"path:/r/dev-studio","members":[{"role":"lead","wt":"wtLead"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"wtBp","pr":"7"}]}' > "$DS_STATE_ROOT/$P1/squads/loop.json"
printf '{"run_id":"b","status":"running","type":"feature","repo":"path:/r/acme","members":[{"role":"lead","wt":"wtLead"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"wtBp","pr":"8"}]}' > "$DS_STATE_ROOT/$P2/squads/rail.json"
jq '.worktrees += [["wtOld", null, true]] | .repos = {"path:/r/dev-studio": "acme/dev-studio", "path:/r/acme": "acme/acme"}
  | .prs = [{"repo":"acme/dev-studio","pr":7,"state":"OPEN","ci":"pending"},{"repo":"acme/acme","pr":8,"state":"OPEN","ci":"pending"}]' "$SEED" > "$TMP/seed-2p.json"
SEED="$TMP/seed-2p.json" mkdb "$P1" "$P2"
mv "$DS_STATE_ROOT/$P1" "$DS_STATE_ROOT/$P2" "$TMP/"
DS_STATE_ROOT="$DBR" PATH="$NP" "$ROOT/bin/board/board.sh" --json > "$TMP/2p.json"
mv "$TMP/$P1" "$TMP/$P2" "$DS_STATE_ROOT/"
jt "two projects: both render"        "$TMP/2p.json" "[.squads[] | .label] | (index(\"$P1\") != null) and (index(\"$P2\") != null)"
jt "two projects: same shape, each its own PR" "$TMP/2p.json" '[.squads[] | select(.topic=="loop" or .topic=="rail") | [.display_status, .units[0].state, .prs[0].status]] == [["implementing","testing","running"],["implementing","testing","running"]]'
jt "two projects: PR links per repo"  "$TMP/2p.json" '[.squads[] | select(.topic=="loop" or .topic=="rail") | .prs[0].url] | sort == ["https://github.com/acme/acme/pull/8","https://github.com/acme/dev-studio/pull/7"]'
jt "a gone worktree is not live"      "$TMP/2p.json" '.live_worktrees == 3'
rm -rf "${DS_STATE_ROOT:?}/$P1" "${DS_STATE_ROOT:?}/$P2"

# U96/U100: an idle standing role is not read as settled — the board shows the same
# word as watch.sh's TEAM rows: a Thinker reading `done` with an open dispatch shows
# `waiting`, with a settled dispatch `⚠ settled`; a rebound-settled one (the loop settled
# it after its own rebind) shows `waiting`; a Thinker whose dispatch read is stale and one
# with no dispatch on record keep `done`; a done Builder keeps `done`.
printf '{"run_id":"rb96","status":"running","members":[{"role":"lead","wt":"wL"},{"role":"thinker","wt":"wT"},{"role":"thinker","suffix":"s","wt":"wTs"},{"role":"thinker","suffix":"r","wt":"wTr"},{"role":"thinker","suffix":"st","wt":"wTst"},{"role":"builder","suffix":"b","wt":"wB"},{"role":"thinker","suffix":"u","wt":"wTu"}],"units":[]}' > "$SD/u96.json"
cat > "$TMP/seed96.json" <<'JSON'
{"workers":[["wL","working","ds-lead"],["wT","done","ds-thinker",null,null,null,"dispatched"],["wTs","done","ds-thinker",null,null,null,"succeeded"],["wTr","done","ds-thinker",null,null,null,"failed",0,"ctx_r"],["wTst","done","ds-thinker",null,null,null,"succeeded",3600],["wB","done","ds-builder",null,null,null,"dispatched"],["wTu","done","ds-thinker"]],
 "terminals":[],"worktrees":[["wL",null],["wT",null],["wTs",null],["wTr",null],["wTst",null],["wB",null],["wTu",null]],
 "events":[{"squad":"u96","member":"wTr","kind":"member_rebound_settled","payload":{"dispatch":"ctx_r"}}]}
JSON
SEED="$TMP/seed96.json" board "$LBL" > "$TMP/u96.json"
U96='.squads[] | select(.topic=="u96")'
jt "idle thinker (open dispatch) shows waiting" "$TMP/u96.json" "$U96 | (.members[] | select(.label==\"thinker\") | .state==\"waiting\")"
jt "settled thinker shows settled"              "$TMP/u96.json" "$U96 | (.members[] | select(.label==\"thinker-s\") | .state==\"⚠ settled\")"
jt "rebound-settled thinker shows waiting"     "$TMP/u96.json" "$U96 | (.members[] | select(.label==\"thinker-r\") | .state==\"waiting\")"
jt "stale dispatch read keeps done"            "$TMP/u96.json" "$U96 | (.members[] | select(.label==\"thinker-st\") | .state==\"done\")"
jt "done Builder still shows done"              "$TMP/u96.json" "$U96 | (.members[] | select(.label==\"builder-b\") | .state==\"done\")"
jt "no dispatch on record keeps done"           "$TMP/u96.json" "$U96 | (.members[] | select(.label==\"thinker-u\") | .state==\"done\")"
rm -f "$SD/u96.json"

# U100: the board degrades on a loop.db from before migration 0017 (no dispatch_seen_at):
# a done Thinker keeps `done` instead of rendering the squad broken. Such a loop.db has none of 0056's
# triggers either, so they go first.
printf '{"run_id":"r17","status":"running","members":[{"role":"thinker","wt":"wT"}],"units":[]}' > "$SD/u17.json"
cat > "$TMP/seed17.json" <<'JSON'
{"workers":[["wT","done","ds-thinker"]],"terminals":[],"worktrees":[["wT",null]]}
JSON
SEED="$TMP/seed17.json" mkdb "$LBL"
bun -e 'const {Database} = await import("bun:sqlite"); const db = new Database("'"$DBR"'/loop.db"); for (const t of ["observed_workers_orca_ins", "observed_workers_orca_upd"]) db.run(`DROP TRIGGER IF EXISTS ${t}`); db.run("ALTER TABLE observed_workers DROP COLUMN dispatch_seen_at"); db.close();'
render "$LBL" --json > "$TMP/u17.json"
jt "pre-0017 loop.db keeps the agent state" "$TMP/u17.json" '.squads[] | select(.topic=="u17") | (.members[] | select(.label=="thinker") | .state=="done")'
rm -f "$SD/u17.json"

# The board reads and writes loop.db alone: no command, no file read and no config script or Lavish
# start in the whole of bin/board/board-data.ts and bin/board/board-server.ts (import lines aside) — the
# exceptions are the page itself, web/board.html, read by its line in the server, and the chat images
# (chat-image-upload U1): chatPrune lists `<label>/chat-files/*/` and chatFileGet serves one image.
PAT='Bun\.spawn|run\(\[|readFileSync|readdirSync|Bun\.file\(|roles\.sh|limits\.sh|lavish-axi|DS_LAVISH_START'
eq "board-data.ts: no spawn, no file read, no script" "$(grep -nE "$PAT" "$ROOT/bin/board/board-data.ts" | grep -vcE '^[0-9]+:import ' || true)" "0"
# Each hit outside the page line must sit inside chatPrune or chatFileGet (from its `function` line to the
# next line that is a lone `}`).
HITS="$(PAT="$PAT" awk '
  /^(async )?function (chatPrune|chatFileGet)\(/ { inside = 1 }
  $0 ~ ENVIRON["PAT"] && $0 !~ /^import / && !inside { print NR ": " $0 }
  inside && /^}$/ { inside = 0 }' "$ROOT/bin/board/board-server.ts")"
eq "board-server.ts: only the page is read outside the chat-image block" "$(printf '%s\n' "$HITS" | grep -c . || true)" "1"
has "board-server.ts: the exception is readFileSync(page)" "$HITS" "readFileSync(page)"
echo "  (the page, web/board.html: bin/board/board-server.ts:${HITS%%:*})"
eq "board-server.ts: the chat-image block reads files" "$(awk '/^(async )?function (chatPrune|chatFileGet)\(/ { i = 1 } i && /readdirSync|readFileSync/ { n++ } i && /^}$/ { i = 0 } END { print n + 0 }' "$ROOT/bin/board/board-server.ts")" "3"
eq "board-server.ts: every GET goes through the read block" "$(grep -cE '^  return get\(req, url\);' "$ROOT/bin/board/board-server.ts")" "1"

# Header tiles (plan U3, KTD8): /board.json `accounts_summary` and `header` are computed in board-data;
# the page only lays them out. Fixture: three accounts (one limited until later today+, one above
# pick_session_max, one free), open units in two squads, a failing PR, a running one and a draft.
HL="zzhdr_$$"; HSD="$DS_STATE_ROOT/$HL/squads"; mkdir -p "$HSD"
printf '{"run_id":"h1","status":"running","repo":"path:%s","members":[{"role":"lead","wt":"hL1"},{"role":"builder","suffix":"a","wt":"hB1"},{"role":"builder","suffix":"b","wt":"hB2"}],"units":[{"slug":"u1","status":"dispatched","builder_wt":"hB1","pr":"601"},{"slug":"u2","status":"dispatched","builder_wt":"hB2","pr":"602"},{"slug":"u3","status":"planned"},{"slug":"u4","status":"done","pr":"600"}]}' "$GR" > "$HSD/sqa.json"
printf '{"run_id":"h2","status":"running","repo":"path:%s","members":[{"role":"lead","wt":"hL2"}],"units":[{"slug":"v1","status":"planned"},{"slug":"v2","status":"dispatched","pr":"603"}]}' "$GR" > "$HSD/sqb.json"
jq --arg r "path:$GR" '.workers = [["hL1","working","ds-lead"],["hB1","working","ds-b1"],["hB2","idle","ds-b2"],["hL2","working","ds-lead2"]] | .terminals = [] | .worktrees = [] | .repos = {($r): "acme/app"}
  | .prs = [{"repo":"acme/app","pr":601,"state":"OPEN","ci":"red","head":"x"},{"repo":"acme/app","pr":602,"state":"OPEN","ci":"pending","head":"y"},{"repo":"acme/app","pr":603,"state":"OPEN","draft":true,"ci":"green","head":"z"},{"repo":"acme/app","pr":600,"state":"MERGED"}]' "$SEED" > "$TMP/seed-h.json"
mkdir -p "$TMP/sth"
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\nclaude\ta\t10\t-\t5\t-\t%s\t%s\tA\nclaude\tb\t97\t-\t20\t-\t-\t%s\tB\nclaude\tc\t10\t-\t5\t-\t-\t%s\tC\n' "$((NOW+7200))" "$NOW" "$NOW" "$NOW" > "$TMP/sth/accounts.tsv"
SEED="$TMP/seed-h.json" HOSTST="$TMP/sth" board "$HL" > "$TMP/h.json"
jt "accounts_summary: free 1 of 3, limited with reset, near, warn" "$TMP/h.json" '.accounts_summary | .total==3 and .free==2 and (.limited | length==1 and .[0].label=="A" and (.[0].reset | test("^[0-9]{2}:[0-9]{2}$|^[A-Z][a-z]{2}$"))) and (.near | length==1 and .[0].label=="B") and .level=="warn"'
jt "header: units, builders, PRs" "$TMP/h.json" '.header | .units_left==5 and .ready_units==2 and .squads_active==2 and .builders_working==1 and .builders_of==2 and .builders_of_kind=="ready" and .prs_open==3 and .ci_running==1 and .ci_failing==1 and .drafts==1' '.header'
SEED="$TMP/seed-h.json" HOSTST="$TMP/sth" DS_LIMIT_MAX_BUILDERS=8 board "$HL" > "$TMP/h2.json"
jt "header: max_builders 8 is the denominator" "$TMP/h2.json" '.header | .builders_of==8 and .builders_of_kind=="max"'
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\nclaude\ta\t10\t-\t5\t-\t%s\t%s\tA\nclaude\tb\t10\t-\t5\t-\t%s\t%s\tB\nclaude\tc\t10\t-\t5\t-\t%s\t%s\tC\n' "$((NOW+7200))" "$NOW" "$((NOW+90000))" "$NOW" "$((NOW+3600))" "$NOW" > "$TMP/sth/accounts.tsv"
SEED="$TMP/seed-h.json" HOSTST="$TMP/sth" board "$HL" > "$TMP/h3.json"
jt "accounts_summary: every account limited is crit" "$TMP/h3.json" '.accounts_summary | .free==0 and .level=="crit" and (.limited | length==3)'
printf 'agent\taccount\tsession_pct\tsession_reset\tweekly_pct\tweekly_reset\tlimited_until\tupdated\tlabel\nclaude\ta\t10\t-\t5\t-\t%s\t%s\tA\nclaude\tb\t10\t-\t5\t-\t-\t%s\tB\n' "$((NOW-60))" "$NOW" "$NOW" > "$TMP/sth/accounts.tsv"
SEED="$TMP/seed-h.json" HOSTST="$TMP/sth" board "$HL" > "$TMP/h4.json"
jt "accounts_summary: a past limited_until counts as free" "$TMP/h4.json" '.accounts_summary | .free==2 and .level=="ok" and (.limited | length==0)'
printf '{"run_id":"h3","status":"running","repo":"/no/repo","members":[{"role":"lead","wt":"hL3"}],"units":[{"slug":"w1","status":"done"}]}' > "$HSD/sqc.json"
rm -f "$HSD/sqa.json" "$HSD/sqb.json"
jq '.prs = []' "$TMP/seed-h.json" > "$TMP/seed-h0.json"
SEED="$TMP/seed-h0.json" board "$HL" > "$TMP/h5.json"
jt "header: no PRs is 0 and no failing" "$TMP/h5.json" '.header | .prs_open==0 and .ci_failing==0 and .units_left==0' '.header'
for t in "Needs you" "Builders" "Units left" "PRs" "Accounts" "Updated"; do
  eq "web page: header tile $t" "$(grep -c "<\${Tile} label=\"$t\"" "$ROOT/web/board.html")" "1"
done
eq "web page: no Active (N archived) counter" "$(grep -c 'archived)"' "$ROOT/web/board.html")" "0"

# Machine tile and section (plan U4): /board.json `machine` from the observed_machine row, levels computed
# in board-data, the MACHINE text line, the section's place in the page, and absence without a row or table.
printf '{"run_id":"m1","status":"running","repo":"/no/repo","members":[{"role":"lead","wt":"mL1"}],"units":[{"slug":"m1","status":"planned"}]}' > "$HSD/sqc.json"
btext(){ mkdb "$1"; render "$@"; }
mseed() { jq --argjson m "$1" '.machine = $m' "$TMP/seed-h0.json" > "$TMP/seed-m.json"; SEED="$TMP/seed-m.json" board "$HL"; }
mseed '{"load1":30}' > "$TMP/m1.json"
jt "machine: load 30 on 24 cores is warn" "$TMP/m1.json" '.machine | .load.level=="warn" and .load.x==1.3 and .level=="warn" and .cores==24' '.machine'
mseed '{"load1":40}' > "$TMP/m2.json"
jt "machine: load 40 on 24 cores is crit" "$TMP/m2.json" '.machine.load.level=="crit"'
mseed '{"swap_free_kb":0,"mem_avail_kb":260000,"psi_mem_some":30}' > "$TMP/m3.json"
jt "machine: swap fully used under memory pressure is crit, the worse of mem and swap" "$TMP/m3.json" '.machine | .swap.level=="crit" and .swap.pct==100 and .mem.pct==74 and .worse=="swap" and .level=="crit"'
mseed '{"swap_free_kb":0}' >/dev/null
SEED="$TMP/seed-m.json" DS_LIMIT_MACHINE_SWAP_CRIT_PCT=101 board "$HL" > "$TMP/m4.json"
jt "machine: machine_swap_crit_pct 101 stops swap reading crit" "$TMP/m4.json" '.machine.swap.level=="warn"'
mseed '{"swap_free_kb":0,"psi_mem_some":0,"psi_mem_full":0}' > "$TMP/m4a.json"
jt "machine: swap 100% with psi mem 0 is warn (idle swap, no stall)" "$TMP/m4a.json" '.machine.swap.level=="warn" and .machine.level=="warn"'
mseed '{"swap_free_kb":0,"psi_mem_some":30}' > "$TMP/m4b.json"
jt "machine: swap 100% with psi mem 30 is crit" "$TMP/m4b.json" '.machine.swap.level=="crit"'
mseed '{"swap_free_kb":0,"psi_mem_some":null,"psi_mem_full":null}' > "$TMP/m4c.json"
jt "machine: swap 100% with no psi values keeps crit" "$TMP/m4c.json" '.machine.swap.level=="crit"'
mseed '{"swap_free_kb":800000}' > "$TMP/m4d.json"
jt "machine: swap 20% is ok" "$TMP/m4d.json" '.machine.swap.level=="ok"'
mseed '{"swap_free_kb":0,"psi_mem_some":0}' >/dev/null
SEED="$TMP/seed-m.json" btext "$HL" > "$TMP/mt0.txt"
has "text: idle full swap reads warn" "$(grep '^MACHINE' "$TMP/mt0.txt")" "swap 100% ⚠"
mseed '{"swap_total_kb":0,"swap_free_kb":0}' > "$TMP/m5.json"
jt "machine: no swap is ok, never a division" "$TMP/m5.json" '.machine.swap | .level=="ok" and .pct==null'
mseed '{"psi_mem_some":12}' > "$TMP/m6.json"
jt "machine: psi mem 12 is a warn note" "$TMP/m6.json" '.machine.psi.note | .kind=="mem" and .level=="warn"'
mseed '{"psi_mem_some":9,"psi_cpu_some":9.9,"psi_io_some":3}' > "$TMP/m7.json"
jt "machine: psi under 10 gives no note" "$TMP/m7.json" '.machine.psi.note==null'
mseed '{"disks":[{"path":"/a","total_kb":1000,"free_kb":520},{"path":"/b","total_kb":1000,"free_kb":100}]}' > "$TMP/m8.json"
jt "machine: the fullest disk is shown" "$TMP/m8.json" '.machine.disk | .path=="/b" and .used_pct==90 and .level=="warn"'
mseed '{"groups":[{"comm":"a","procs":1,"rss_kb":10,"cpu_pct":null},{"comm":"b","procs":2,"rss_kb":50,"cpu_pct":3.2}]}' > "$TMP/m9.json"
jt "machine: top groups by RSS, orca counts, as_of" "$TMP/m9.json" '.machine.groups[0].comm=="b" and (.machine | has("worktrees") and has("terminals")) and (.as_of.machine | type=="number") and .machine.stale==false'
mseed '{"age":200}' > "$TMP/m10.json"
jt "machine: a sample older than 3 x the cadence is stale" "$TMP/m10.json" '.machine.stale==true'
mseed '{"load1":40,"swap_free_kb":0,"psi_mem_some":12,"mem_total_kb":131072000}' >/dev/null
SEED="$TMP/seed-m.json" btext "$HL" > "$TMP/mt.txt"
has "text: MACHINE line with markers" "$(grep '^MACHINE' "$TMP/mt.txt")" "swap 100% ✖"
has "text: MACHINE line has the psi note" "$(grep '^MACHINE' "$TMP/mt.txt")" "psi mem 12 ⚠"
has "text: MACHINE line load crit" "$(grep '^MACHINE' "$TMP/mt.txt")" "on 24 ✖"
SEED="$TMP/seed-h0.json" board "$HL" > "$TMP/m11.json"
jt "machine: no row, no machine field" "$TMP/m11.json" 'has("machine")|not'
jq '.machine = false' "$TMP/seed-h0.json" > "$TMP/seed-m0.json"
SEED="$TMP/seed-m0.json" board "$HL" > "$TMP/m12.json"
jt "machine: no table renders the board without a machine field" "$TMP/m12.json" '(has("machine")|not) and (.header | type=="object")'

# Machine ranking, total, breakdown and outside block (plan U2): consumers are this project's rows only (members, the
# Studio, leftovers); other projects and host groups are summed in `breakdown` and named in `outside` past a threshold.
printf '{"run_id":"m1","status":"running","repo":"/no/repo","members":[{"role":"lead","wt":"mL1"},{"role":"builder","suffix":"u1","wt":"mB1"},{"role":"thinker","wt":"mT1"}],"units":[{"slug":"m1","status":"planned"}]}' > "$HSD/sqc.json"
cseed() { jq --argjson x "$1" '.machine = {mem_total_kb:100000000,mem_avail_kb:50000000} | . + $x' "$TMP/seed-h0.json" > "$TMP/seed-c.json"; SEED="$TMP/seed-c.json" board "$HL"; }
CPROCS='[["mB1",2202009,300,5],["mL1",1468006,280,3],["mT1",1000,2,1],["oW9",9000000,20,9,"zzother"],["oW8",1000000,5,2,"zzother"],["oW7",30000000,1,4,"zzother"],["gone1",500,1,1]]'
cseed '{"machine":{"mem_total_kb":100000000,"mem_avail_kb":50000000,"cpu_busy_pct":1210},"procs":'"$CPROCS"',"host_procs":[{"comm":"java","label":"dev-stack db","procs":4,"rss_kb":3145728,"cpu_pct":600},{"comm":"docker","procs":2,"rss_kb":100,"cpu_pct":1.5}],"worktrees":[["oW7",null],["gone1",null,true]]}' > "$TMP/c1.json"
jt "consumers: only this project's rows, ranked by RAM; a removed worktree's row is left over" "$TMP/c1.json" '[.machine.consumers[] | .label] == ["sqc / builder-u1","sqc / lead","sqc / thinker","left over · gone1"]'
jt "consumers: no row has kind other or host" "$TMP/c1.json" '[.machine.consumers[] | .kind] == ["squad","squad","squad","leftover"]'
jt "breakdown: the other project is named with its worktree count, not ranked" "$TMP/c1.json" '(.machine.breakdown.others == [{"project":"zzother","worktrees":3,"ram_kb":40000000,"rss_kb":40000000,"cpu_pct":26}]) and ([.machine.consumers[] | .label | test("zzother|oW")] | any | not)'
jt "outside: a big other-project worktree and a hot host group are named, small ones are not" "$TMP/c1.json" '[.machine.outside[] | .label] == ["zzother · left over · oW7","dev-stack db"] and (.machine.outside[0].ram_hit and (.machine.outside[0].cpu_hit|not)) and (.machine.outside[1].cpu_hit and (.machine.outside[1].ram_hit|not))'
jt "total: project cores, machine cores, busy cores and % (the machine's /proc/stat CPU, not the process sum), share of used RAM" "$TMP/c1.json" '.machine.total | .cpu_cores==5.83 and .cores==24 and .busy_cores==12.1 and .busy_pct==50 and .ram_pct==7.3'
jt "breakdown: this project, others, host and kernel & cache add up to used memory" "$TMP/c1.json" '.machine.breakdown | (.this.worktrees==4) and ((.this.rss_kb + ([.others[].rss_kb]|add) + .host.rss_kb + .kernel_kb) == .used_kb)'
jt "card: segments plus everything else equal in use, in use is within capacity (RAM kB and CPU cores)" "$TMP/c1.json" '.machine.card | (.ram | (([.segments[].value]|add) + .other == .used) and .used <= .cap and (.used + .free == .cap) and (.segments | length == 1)) and (.cpu | (.used==12.1) and .cap==24 and (([.segments[].value]|add) + .other - .used | fabs < 0.011) and .used <= .cap)'
jt "card: everything else splits into other projects, host and kernel & cache" "$TMP/c1.json" '.machine.card.ram | ([.parts[].label] == ["zzother","host","kernel & cache"]) and (([.parts[].value]|add) - .other | fabs < 1)'
jt "card: no host-group list rides with the card" "$TMP/c1.json" '.machine.card | has("host_groups") | not'
jq '.machine = {mem_total_kb:100000000,mem_avail_kb:50000000,cpu_busy_pct:600} | . + {"procs":[["mB1",1000000,100,1],["oW9",2000000,200,1,"zzother"]],"host_procs":false}' "$TMP/seed-h0.json" > "$TMP/seed-cardall.json"
SEED="$TMP/seed-cardall.json" mkdb "$HL"; render --json > "$TMP/cardall.json"
jt "card: the all-projects view has one project segment per project, adding up to in use" "$TMP/cardall.json" '.machine.card | (.ram.segments | length == 2) and (([.ram.segments[].value]|add) + .ram.other == .ram.used) and (.cpu.segments | length == 2)'
jt "consumers: per-member resources, NULL cpu stays null" "$TMP/c1.json" '(.squads[] | select(.topic=="sqc") | .members | map({(.label):.resources}) | add) | (.["builder-u1"].rss_kb==2202009 and .["builder-u1"].cpu_pct==300 and .lead.cpu_pct==280)'
cseed '{"procs":[["mB1",2202009,null,5],["mL1",1468006,null,3]],"host_procs":false}' > "$TMP/c2.json"
cseed '{"machine":{"mem_total_kb":100000000,"mem_avail_kb":50000000,"cpu_busy_pct":1200},"procs":[["mB1",1000,300,1],["mL1",1000,280,1]],"host_procs":[{"comm":"x","procs":1,"rss_kb":1,"cpu_pct":620}]}' > "$TMP/c5.json"
cseed '{"machine":{"mem_total_kb":100000000,"mem_avail_kb":50000000,"cpu_busy_pct":null},"procs":[["mB1",1000,300,1]],"host_procs":[{"comm":"x","procs":1,"rss_kb":1,"cpu_pct":620}]}' > "$TMP/c6.json"
jt "total: no busy figure from the machine stays null even with process CPU measured (renders \"—\")" "$TMP/c6.json" '.machine.total | .busy_cores==null and .busy_pct==null and .cpu_cores==3'
jt "card: no busy figure gives a null CPU in use and an empty split, RAM still fills" "$TMP/c6.json" '.machine.card | (.cpu | .used==null and .segments==[] and .other==null and .free==null) and (.ram.used != null)'
jt "total: 580% project CPU, machine busy 1200 on 24 cores reads 5.8 cores, 12 of 24 busy (50%)" "$TMP/c5.json" '.machine.total | .cpu_cores==5.8 and .cores==24 and .busy_cores==12 and .busy_pct==50'
jt "consumers: a NULL cpu stays null, the total has no CPU and missing host data shows no host part" "$TMP/c2.json" '(.machine.total.cpu_cores==null) and (.machine.breakdown.host==null) and ((.squads[] | select(.topic=="sqc") | .members[] | select(.role=="thinker") | .resources) == null)'
cseed '{"procs":[["mB1",2202009,12.4,5]],"host_procs":[{"comm":"docker","procs":4,"rss_kb":3145728,"cpu_pct":1.5}]}' > "$TMP/c3.json"
jt "outside: nothing past a threshold leaves the block empty" "$TMP/c3.json" '.machine.outside == []'
cseed '{"procs":[["mB1",90000000,12.4,5]],"host_procs":[{"comm":"docker","procs":4,"rss_kb":3145728,"cpu_pct":1.5}]}' > "$TMP/c3b.json"
jt "breakdown: an RSS sum past used memory hides kernel & cache" "$TMP/c3b.json" '.machine.breakdown.kernel_kb==null'
cseed '{"procs":'"$CPROCS"',"host_procs":[{"comm":"java","procs":4,"rss_kb":3145728,"cpu_pct":600}]}' > "$TMP/c4.json"
jt "outside: a host group without a label is named by its comm" "$TMP/c4.json" '[.machine.outside[].label] | index("java") != null'
jq '.machine = {mem_total_kb:100000000,mem_avail_kb:50000000} | . + {"procs":[["mB1",1,10,1],["oW9",2,20,1,"zzother"]],"host_procs":false}' "$TMP/seed-h0.json" > "$TMP/seed-call.json"
SEED="$TMP/seed-call.json" mkdb "$HL"; render --json > "$TMP/call.json"
jt "all-projects view: every project's rows with a project tag, no project worktree in the outside block, a total per project" "$TMP/call.json" '([.machine.consumers[] | .project] | unique) == ["'"$HL"'","zzother"] and ([.machine.total.projects[].project] | length == 2) and ((.machine.breakdown.this) == null) and (.machine.outside | all(.label | test("zzother") | not))' 
jt "all-projects view: the breakdown names every project, so projects + host + kernel & cache add up to used memory" "$TMP/call.json" '.machine.breakdown | ([.others[].project] | sort) == ["'"$HL"'","zzother"] and (([.others[].ram_kb] | add) + (.host.ram_kb // 0) + .kernel_kb) == .used_kb' 
jt "all-projects view: a member row reads <project> · <squad> / <role>, a leftover <project> · left over · <worktree>, kind leftover (U8)" "$TMP/call.json" '[.machine.consumers[] | [.label, .kind]] | sort == ([["'"$HL"' · sqc / builder-u1","squad"],["zzother · left over · oW9","leftover"]] | sort)'
cseed '{"procs":false,"host_procs":false,"machine":{"groups":[{"comm":"u1grp","procs":1,"rss_kb":777,"cpu_pct":null}]}}' > "$TMP/c5.json"
mp="$(sed -n '/id="machine"/,/<${EventLog}/p' "$ROOT/web/board.html")"
for l in Load Memory Swap Disk Orca; do has "web page: Machine section renders $l with the Tile component" "$mp" "<\${Tile} label=\"$l\""; done
for l in Load Memory Swap Disk; do has "web page: Machine $l tile passes a bar" "$(grep -F "<\${Tile} label=\"$l\"" "$ROOT/web/board.html")" ' bar=${'; done
eq "web page: Pressure, Orca and header tiles pass no bar" "$(grep -F '<${Tile} label=' "$ROOT/web/board.html" | grep -F ' bar=${' | grep -cvE 'label="(Load|Memory|Swap|Disk)"')" "0"
eq "web page: Tile caps the bar fill at 100" "$(grep -cF 'Math.min(100, bar)' "$ROOT/web/board.html")" "1"
has "web page: Machine section stats sit in a .tiles grid" "$mp" 'class="tiles mach-tiles"'
mt="$(sed -n '/^function MachineTop/,/^}/p' "$ROOT/web/board.html")"
has "web page: the table switch is a two-button control with aria-pressed" "$mt" 'aria-pressed=${sort === "cpu"}'
has "web page: the switch choice is stored under b:machine-sort" "$mt" 'lstore.set("b:machine-sort", s)'
has "web page: the heading follows the switch" "$mt" 'Top by ${sort === "cpu" ? "CPU" : "RAM"}'
has "web page: the heading tooltip says RAM is RSS" "$mt" 'RAM here is RSS'
has "web page: the outside block is under the table" "$mt" 'Outside this project'
# U5: the page has no Studio moved line.
if grep -qF 'studio-moved' "$ROOT/web/board.html"; then fail=$((fail+1)); echo "  FAIL: web page: no Studio moved line" >&2; else pass=$((pass+1)); fi
rc="$(sed -n '/^function ResourceCard/,/^}/p;/^function UtilBar/,/^}/p' "$ROOT/web/board.html")"
has "web page: the card is titled Resource utilization with the project" "$rc" 'Resource utilization${project ? " · " + project : ""}'
has "web page: the card sits under the tiles, before the table" "$mp" '<${ResourceCard} M=${M} project=${data.project} />'
has "web page: the card figures read project / in use / of" "$rc" '>in use <b>'
has "web page: the project's stall figure sits under the bars" "$rc" 'class="ustall mut"'
has "web page: the loop's line sits in the card's corner, outside any share" "$rc" 'not in any project'"'"'s share'
eq "web page: the host-group list, its button and the everything-else line are gone" "$(printf '%s' "$rc" | grep -cE 'aria-expanded|mhostlist|class="ubparts|everything else:' || true)" "0"
has "web page: the stall figure reads worst worktree stall" "$rc" 'worst worktree stall cpu'
has "web page: hovering everything else lists its parts" "$rc" 'title=${"everything else in use: " + (hover || "—")}'
has "web page: a missing figure renders a dash and an empty bar" "$rc" 'r.used == null ? [] : r.segments'
has "web page: a changed page fingerprint shows a reload banner" "$(cat "$ROOT/web/board.html")" 'body.page_version !== mv.content'
has "web page: the banner offers a reload" "$(cat "$ROOT/web/board.html")" 'location.reload()'
bp="$(cat "$ROOT/web/board.html")"
rb_pos="$(printf '%s' "$bp" | grep -bo 'class="banner err reloadbar"' | head -1 | cut -d: -f1)"
tile_pos="$(printf '%s' "$bp" | grep -bo 'label="Needs you"' | head -1 | cut -d: -f1)"
acc_pos="$(printf '%s' "$bp" | grep -bo 'id="accounts"' | head -1 | cut -d: -f1)"
eq "web page: the reload bar comes before the header tiles and not after the accounts section" "$([ -n "$rb_pos" ] && [ -n "$tile_pos" ] && [ "$rb_pos" -lt "$tile_pos" ] && { [ -z "$acc_pos" ] || [ "$rb_pos" -lt "$acc_pos" ]; } && echo ok || echo bad)" "ok"
eq "web page: the breakdown line and the old text lines are gone" "$(grep -cE 'class="mbreak"|Project consumes |Overall machine utilization|class="mtotal"' "$ROOT/web/board.html")" "0"
eq "web page: the old '% of machine' / '% of measured CPU' figures are gone" "$(printf '%s' "$mt" | grep -cE 'of measured CPU|% of machine' || true)" "0"
eq "web page: the table is sorted by the chosen metric" "$(grep -c 'sort === "cpu" ? (b.cpu_pct ?? -1) - (a.cpu_pct ?? -1) : b.ram_kb - a.ram_kb' "$ROOT/web/board.html")" "1"
eq "web page: the old stats table is gone" "$(grep -c 'mach-tbl' "$ROOT/web/board.html")" "0"
jt "consumers: no observed_procs table and no host data renders an empty ranking, no double count from machine.groups" "$TMP/c5.json" '([.machine.consumers[].label] == []) and ([.squads[].members[] | .resources] | all(. == null))'
# RAM counted once (plan U4): with mem_kb on every row and host group the RAM figures are charged memory (ram_basis
# "charged"), ranked by it, and the breakdown adds up to used memory; any NULL mem_kb shows RSS for every item.
jt "ram: without mem_kb every RAM figure is RSS" "$TMP/c1.json" '.machine.ram_basis=="rss" and ([.machine.consumers[] | .ram_kb==.rss_kb] | all) and (.machine.total.ram_kb==.machine.total.rss_kb) and (.machine.total.psi==null)'
UPROCS='[["mB1",2202009,300,5,null,1000000,12,3],["mL1",1468006,280,3,null,2000000,40],["mT1",1000,2,1,null,500],["oW9",9000000,20,9,"zzother",4000000],["oW8",1000000,5,2,"zzother",500000],["oW7",30000000,1,4,"zzother",3000000],["gone1",500,1,1,null,100]]'
UHOST='[{"comm":"java","label":"dev-stack db","procs":4,"rss_kb":3145728,"mem_kb":2000000,"cpu_pct":600},{"comm":"docker","procs":2,"rss_kb":100,"mem_kb":50,"cpu_pct":1.5}]'
cseed '{"procs":'"$UPROCS"',"host_procs":'"$UHOST"',"worktrees":[["oW7",null],["gone1",null,true]]}' > "$TMP/u1.json"
jt "ram: with mem_kb everywhere the ranking follows mem_kb, not rss_kb, and keeps rss_kb" "$TMP/u1.json" '.machine.ram_basis=="charged" and ([.machine.consumers[] | .label] == ["sqc / lead","sqc / builder-u1","sqc / thinker","left over · gone1"]) and (.machine.consumers[0] | .ram_kb==2000000 and .rss_kb==1468006)'
jt "ram: the breakdown parts plus kernel & cache equal used memory" "$TMP/u1.json" '.machine.breakdown | (.this.ram_kb==3000600) and (.others[0].ram_kb==7500000) and (.host.ram_kb==2000050) and (.kernel_kb==37499350) and ((.this.ram_kb + ([.others[].ram_kb]|add) + .host.ram_kb + .kernel_kb) == .used_kb)'
jt "ram: the outside block and the total use charged memory" "$TMP/u1.json" '([.machine.outside[] | .label] == ["dev-stack db"]) and (.machine.total | .ram_kb==3000600 and .ram_pct==6)'
jt "pressure: the total line names the project's worst worktree per resource" "$TMP/u1.json" '.machine.total.psi == {"cpu":40,"cpu_wt":"sqc / lead","mem":3,"mem_wt":"sqc / builder-u1"}'
cseed '{"procs":[["mB1",2202009,300,5,null,1000000],["mL1",1468006,280,3]],"host_procs":'"$UHOST"'}' > "$TMP/u2.json"
jt "ram: one row without mem_kb shows RSS for every item, never a mix" "$TMP/u2.json" '.machine.ram_basis=="rss" and ([.machine.consumers[] | .ram_kb==.rss_kb] | all) and (.machine.breakdown.host.ram_kb==3145828)'
cseed '{"procs":'"$UPROCS"',"host_procs":[{"comm":"docker","procs":2,"rss_kb":100,"cpu_pct":1.5}]}' > "$TMP/u3.json"
jt "ram: a host group without mem_kb shows RSS for every item" "$TMP/u3.json" '.machine.ram_basis=="rss" and (.machine.consumers[0].label=="sqc / builder-u1")'
cseed '{"procs":[["mB1",2202009,300,5,null,1000000,0,0],["mL1",1468006,280,3,null,2000000,0,0]],"host_procs":'"$UHOST"'}' > "$TMP/u4.json"
jt "pressure: a stall of 0 names no worktree" "$TMP/u4.json" '.machine.total.psi == {"cpu":0,"cpu_wt":null,"mem":0,"mem_wt":null}'
has "web page: the heading tooltip says RAM is charged memory counted once" "$mt" "memory charged to each worktree's cgroups, counted once"
has "web page: a RAM figure shows its RSS in a tooltip" "$mt" '"RSS " + kbText(x.rss_kb)'
# CPU from cgroups (machine-top-ram-clarity U9): a row's and a host group's cpu_cg_pct replace the sampled cpu_pct in the
# project total, the other projects' and host shares and the ranking; NULL falls back to cpu_pct per row.
GPROCS='[["mB1",2202009,300,5,null,1000000,null,null,520],["mL1",1468006,280,3,null,2000000,null,null,null],["mT1",1000,2,1],["oW9",9000000,20,9,"zzother",4000000,null,null,250],["oW7",30000000,1,4,"zzother",3000000,null,null,300]]'
GHOST='[{"comm":"java","label":"dev-stack db","procs":4,"rss_kb":3145728,"mem_kb":2000000,"cpu_pct":600,"cpu_cg_pct":640}]'
cseed '{"machine":{"mem_total_kb":100000000,"mem_avail_kb":50000000,"cpu_busy_pct":2200},"procs":'"$GPROCS"',"host_procs":'"$GHOST"',"worktrees":[["oW7",null]]}' > "$TMP/g1.json"
jt "cgroup cpu: the project total sums cpu_cg_pct, a NULL row falls back to its sampled cpu_pct" "$TMP/g1.json" '.machine.total.cpu_cores == 8.02'
jt "cgroup cpu: the ranking carries the cgroup figure, the fallback and the host share use it too" "$TMP/g1.json" '(.machine.consumers | map({(.label):.cpu_pct}) | add | .["sqc / builder-u1"]==520 and .["sqc / lead"]==280) and (.machine.breakdown.others[0].cpu_pct==550) and (.machine.breakdown.host.cpu_pct==640)'
jt "cgroup cpu: the card's other-projects and host parts use the cgroup figure" "$TMP/g1.json" '.machine.card.cpu.parts | (map(select(.label=="zzother")|.value)==[5.5]) and (map(select(.label=="host")|.value)==[6.4])'
jt "card: the CPU rest is called not attributed" "$TMP/g1.json" '.machine.card.cpu.parts | (map(.label) | index("not attributed") != null) and (map(.label) | index("kernel & cache") == null)'
jt "outside: another project's worktree is named like the all-projects view, never a raw folder" "$TMP/g1.json" '[.machine.outside[].label] | all(test("^(zzother · left over · |dev-stack db)") )'
# The loop's own load (machine-top-ram-clarity U5): the host row's loop columns, the same on a project board and the
# all-projects view, never in a project's share; no columns or all NULL = no loop line.
ULOOP='{"cpu_pct":372.4,"mem_kb":104857,"cache_kb":14994636,"source":"cgroup"}'
cseed '{"procs":'"$UPROCS"',"host_procs":'"$UHOST"',"host_loop":'"$ULOOP"',"worktrees":[["oW7",null],["gone1",null,true]]}' > "$TMP/lp1.json"
jt "loop: cores, own memory, cached files and source from the host row" "$TMP/lp1.json" '.machine.loop == {"cpu_cores":3.72,"mem_kb":104857,"cache_kb":14994636,"source":"cgroup"}'
eq "loop: the project's total and breakdown are unchanged by the loop's figures" "$(jq -c '.machine | [.total, .breakdown]' "$TMP/lp1.json")" "$(jq -c '.machine | [.total, .breakdown]' "$TMP/u1.json")"
jq '.machine = {mem_total_kb:100000000,mem_avail_kb:50000000} | . + {"procs":[["mB1",1,10,1],["oW9",2,20,1,"zzother"]],"host_procs":[{"comm":"x","procs":1,"rss_kb":1,"cpu_pct":1}],"host_loop":'"$ULOOP"'}' "$TMP/seed-h0.json" > "$TMP/seed-lpall.json"
SEED="$TMP/seed-lpall.json" mkdb "$HL"; render --json > "$TMP/lpall.json"
eq "loop: the all-projects view shows the same loop figures" "$(jq -c '.machine.loop' "$TMP/lpall.json")" "$(jq -c '.machine.loop' "$TMP/lp1.json")"
cseed '{"procs":'"$UPROCS"',"host_procs":'"$UHOST"',"host_loop":{"mem_kb":12000,"source":"tree"}}' > "$TMP/lp2.json"
jt "loop: a first scan has no cores, a tree has no cache, memory still shows" "$TMP/lp2.json" '.machine.loop == {"cpu_cores":null,"mem_kb":12000,"cache_kb":null,"source":"tree"}'
jt "loop: all columns NULL gives no loop" "$TMP/u1.json" '.machine.loop == null'
cseed '{"procs":'"$UPROCS"',"host_procs":'"$UHOST"',"host_loop":false}' > "$TMP/lp3.json"
jt "loop: an older loop.db without the columns gives no loop and still a board" "$TMP/lp3.json" '.machine.loop == null and (.machine.consumers | length) == 4'
# CPU-hours per unit (light-lane plan U2): the unit_cpu row lands on the unit row, JSON, text and page.
cseed '{"unit_cpu":[["sqc","m1",5400,180.5,2097152]]}' > "$TMP/uc1.json"
jt "unit cpu: a measured unit carries cpu_h and its peaks" "$TMP/uc1.json" '.squads[] | select(.topic=="sqc") | .units[0].cpu == {"cpu_h":1.5,"peak_cpu_pct":180.5,"peak_rss_kb":2097152}'
cseed '{}' > "$TMP/uc2.json"
jt "unit cpu: an unmeasured unit has cpu null" "$TMP/uc2.json" '.squads[] | select(.topic=="sqc") | .units[0].cpu == null'
cseed '{"unit_cpu":false}' > "$TMP/uc3.json"
jt "unit cpu: no unit_cpu table renders with cpu null" "$TMP/uc3.json" '.squads[] | select(.topic=="sqc") | .units[0].cpu == null'
jq '.machine = {} | .unit_cpu = [["sqc","m1",5400,180.5,2097152]]' "$TMP/seed-h0.json" > "$TMP/seed-uc.json"
SEED="$TMP/seed-uc.json" btext "$HL" > "$TMP/uc.txt"
has "unit cpu: text board has a CPU-H column" "$(cat "$TMP/uc.txt")" "CPU-H"
eq "unit cpu: text board shows the unit's CPU-h on its row" "$(grep -cE '^ +○ m1 .* 1\.5  ' "$TMP/uc.txt" || true)" "1"
has "unit cpu: web page has a CPU-h column header" "$(cat "$ROOT/web/board.html")" '<span class="num" title="CPU-hours its Builders used, reaped child processes included">CPU-h</span>'
has "unit cpu: web page renders the cell" "$(cat "$ROOT/web/board.html")" '>${cpuH(u.cpu)}</span>'
SEED="$TMP/seed-h0.json" btext "$HL" > "$TMP/mt0.txt"
eq "text: no MACHINE line without a row" "$(grep -c '^MACHINE' "$TMP/mt0.txt" || true)" "0"
P="$ROOT/web/board.html"
eq "web page: Machine tile" "$(grep -c '<${Tile} label="Machine"' "$P")" "1"
ma="$(grep -n 'id="accounts"' "$P" | head -1 | cut -d: -f1)"; mm="$(grep -n 'id="machine"' "$P" | head -1 | cut -d: -f1)"; me="$(grep -n '<${EventLog}' "$P" | head -1 | cut -d: -f1)"
eq "web page: Machine section sits between Accounts and the Event log" "$([ "$ma" -lt "$mm" ] && [ "$mm" -lt "$me" ] && echo yes)" "yes"
eq "web page: worktrees stay in the meta line only without a machine row" "$(grep -c '!M && data.live_worktrees' "$P")" "1"
eq "U8: Squads section is a details with id squads, state under b:squads" "$(grep -cF '<details class="sq-sec" id="squads" open=${sqOpen}' "$P")$(grep -cF 'lstore.get("b:squads", true)' "$P")$(grep -cF 'lstore.set("b:squads", o)' "$P")" "111"
eq "U8: jump to a squad row opens the section before scrolling" "$(grep -cF 'setSqOpen(true); lstore.set("b:squads", true);' "$P")" "1"
sa="$(grep -n 'id="squads"' "$P" | head -1 | cut -d: -f1)"; sb="$(grep -n '<div class="sqctl">' "$P" | head -1 | cut -d: -f1)"; sc="$(grep -n '</summary>' "$P" | awk -F: -v s="$sa" '$1>s{print $1; exit}')"
eq "U8: Start squad, Reload all and chips sit in the body, not the summary" "$([ "$sc" -lt "$sb" ] && echo yes)" "yes"

# U1: the Flow — a card per stage and per Queued/PR-open group on the fixture board
# (tests/fixtures/flow/, at its pinned clock), and one FLOW line on the text board with flow.counts.
FR="$TMP/flowroot"; mkdir -p "$FR"
FXNOW="$(DS_STATE_ROOT="$FR" bun "$ROOT/tests/loop/flow-fixture.ts" "$FR" zzflow)"
DS_STATE_ROOT="$FR" DS_NOW="$FXNOW" TZ=UTC PATH="$TMP/nopath" "$ROOT/bin/board/board.sh" zzflow --json > "$TMP/flow.json"
jt "U1: flow has a card in every stage" "$TMP/flow.json" '[.flow.cards[].stage] | unique == ["building","merging","needs_you","pr_open","queued"]' '.flow.cards'
jt "U1: flow has a card in every Queued and PR open group" "$TMP/flow.json" '[.flow.cards[].group | select(. != null)] | unique == ["blocked","checks running","coding","draft","fixing","fixing findings","held","in review","review stopped","reviewing","waiting for a slot","waiting for an account","waiting on another unit"]' '[.flow.cards[].group]'
jt "U4: the fixture squad's Building units show the four review groups with their notes" "$TMP/flow.json" '[.flow.cards[] | select(.squad == "flow" and .stage == "building") | {slug, group, note}] | sort_by(.slug) == [{"slug":"u19-slow","group":"reviewing","note":"2nd review · delta 4m"},{"slug":"u2-building","group":"coding","note":null},{"slug":"u20-starting","group":"coding","note":null},{"slug":"u8-gone","group":"review stopped","note":"reviews stopped · needs --retry"},{"slug":"u9-closed","group":"fixing findings","note":"6 findings 12m"}]' '[.flow.cards[] | select(.stage == "building")]'
jt "U1: flow counts add up to the header's units left" "$TMP/flow.json" '.flow.counts as $c | ($c.queued + $c.building + $c.pr_open + $c.needs_you + $c.merging + ($c.paused // 0)) == .header.units_left'
jt "U1: flow keeps 30 days of merges" "$TMP/flow.json" '(.flow.per_day | length) == 30'
DS_STATE_ROOT="$FR" DS_NOW="$FXNOW" TZ=UTC PATH="$TMP/nopath" "$ROOT/bin/board/board.sh" zzflow > "$TMP/flow.txt"
eq "U1: one FLOW line on the text board" "$(grep -c '^FLOW ' "$TMP/flow.txt" || true)" "1"
eq "U1: the FLOW line has flow.counts' numbers" "$(grep '^FLOW ' "$TMP/flow.txt")" "$(jq -r '.flow.counts | "FLOW \(.queued) queued · \(.building) building · \(.pr_open) PR open · \(.merging) merging · \(.stuck) stuck\(if .slow > 0 then " · \(.slow) slow" else "" end) · \(.needs_you) needs you\(if .paused > 0 then " · \(.paused) paused" else "" end) · \(.merged_today) merged today"' "$TMP/flow.json")"


# U7: Needs-you holds the cards only the operator can clear: the morning brief (Read) and a finished squad (Show squad, Close squad, Dismiss).
eq "U7 page: brief and finished rows are non-blocking qnote rows" "$(grep -cF 'class="qnote" onClick=' "$ROOT/web/board.html")" "1"
eq "U7 page: Read opens Briefs and answers Mark read" "$(grep -cF 'k === "read" ? "Mark read" : a.answer' "$ROOT/web/board.html")" "1"
eq "U7 page: Read keeps the b:briefs store open" "$(grep -cF 'lstore.set("b:briefs", true)' "$ROOT/web/board.html")" "1"
eq "U7 page: a Studio card has its act button and Dismiss" "$(grep -cF 'if (n.act) out.push({ key: "act", label: n.act.label' "$ROOT/web/board.html")$(grep -cF 'out.push({ key: "dismiss", label: "Dismiss"' "$ROOT/web/board.html")" "31"
# U10: one row shape for every Needs-you item; no "from sweep".
eq "U10 page: the Needs-you list has no qrow grid branch" "$(sed -n '/U10: every Needs-you item/,/<${LoopNotes}/p' "$ROOT/web/board.html" | grep -c qrow)" "0"
eq "U10 page: asks get an Answer button" "$(grep -cF 'out.push({ key: "answer", label: "Answer"' "$ROOT/web/board.html")" "1"
# squad-done-definition U4: the done row, the explanation and the close confirm are in the page.
eq "U4 page: a done row has Close squad and Open" "$(grep -cF 'out.push({ key: "show", label: "Open"' "$ROOT/web/board.html")" "1"
eq "U4 page: the pill hover and the squad panel carry the explanation" "$(grep -cF 'explainText(s)' "$ROOT/web/board.html" | awk '{print ($1>=2)}')" "1"
eq "U4 page: the close confirm names open units" "$(grep -cF 'are still held or planned and will be archived with them' "$ROOT/web/board.html")$(grep -cF '1 unit is still held and will be archived with it' "$ROOT/web/board.html")" "11"
eq "U4 page: the legend and wrapping-up pill colour" "$(grep -cF '.pill.wrapping-up{' "$ROOT/web/board.html")$(grep -cF 'STATE_LEGEND.join' "$ROOT/web/board.html")" "11"
eq "U10 page: Studio card has Show squad" "$(grep -cF 'if (n.card_squad) out.push({ key: "show", label: "Show squad"' "$ROOT/web/board.html")" "1"
eq "U10 page: from shown only for an asker not already in the who line" "$(grep -cF 'n.from && !who.includes(n.from)' "$ROOT/web/board.html")" "1"
eq "U10 page: the overlay shows from only when set" "$(grep -cF '${n.from && html`<span>· from ${n.from}</span>`}' "$ROOT/web/board.html")" "1"
eq "U10 page: no from-sweep text on the page" "$(grep -ci 'from sweep' "$ROOT/web/board.html")" "0"
eq "U7 data: needs_you carries the card kind and reason" "$(grep -cF 'card: a.card, reason: a.reason' "$ROOT/bin/board/board-data.ts")" "1"
# U7: an alert doc stores the card as `kind` (fulfil/alert.ts); the board hands it to the page as `card`.
printf '{"alerts":[{"id":"fin-1","asker":"sweep","blocking":false,"question":"Wrap-up stalled: Lead did not answer","kind":"poke_unanswered","reason":"all-done","since":"2026-11-16T09:00:00Z"}]}' > "$DS_STATE_ROOT/$LBL/alerts.json"
board "$LBL" > "$TMP/u7.json"
jt "U7 data: a finished-squad alert reaches needs_you with card and reason" "$TMP/u7.json" '[.needs_you[] | select(.id=="fin-1")] | length==1 and .[0].card=="poke_unanswered" and .[0].reason=="all-done"'
jt "U10 data: a studio alert from the sweep carries no asker" "$TMP/u7.json" '[.needs_you[] | select(.id=="fin-1")] | .[0].from == null'
rm -f "$DS_STATE_ROOT/$LBL/alerts.json"
# U24: the pin dialog's "for" choice (this member, this squad, every <role> in the project, the whole project) posts the scope.
pin_fn=$(sed -n '/^function PinForm(/,/^}/p' "$ROOT/web/board.html")
eq "U24 page: the pin dialog has a For choice with the four scopes" "$(for s in 'class="pin-for"' 'value="member"' 'value="squad"' 'value="role">every ${m.role} in the project' 'value="project"'; do printf '%s' "$pin_fn" | grep -cF "$s"; done | tr -d '\n')" "11111"
eq "U24 page: the pin posts the chosen scope (and the role)" "$(printf '%s' "$pin_fn" | grep -cF 'scope: forWho, ...(forWho === "role" ? { role: m.role } : {})')" "1"
eq "U24 page: a broader pin has no change/auto of its own in the menu" "$(grep -cF 'm.override && (m.override.scope || "member") === "member"' "$ROOT/web/board.html")" "1"

# plan-approval-view U2: Open plan / Open doc, the plain summary, the fold and the planOpen key guard.
BP="$ROOT/web/board.html"; ask_fn=$(sed -n '/^function AskOverlay(/,/^}/p' "$BP")
eq "U2 page: the overlay has Open plan / Open doc, facts chips, the plain lines" "$(for s in 'docLabel(n)' 'class="qfacts"' 'class="qplain"' 'onClick=${() => onPlan(n.doc)}'; do printf '%s' "$ask_fn" | grep -cF "$s"; done | tr -d '\n')" "2231"
# plan-revisions U2: the revision card (note, steps changed, not-covered line, buttons), the folded plain lines, the diff view, soft breaks.
eq "rev U2 page: a revision shows the note, steps changed, not-in-the-note and the no-copy line" "$(for s in 'class="qrev"' 'Steps changed' 'Also changed, not in the note' 'No approved copy to compare (approved before copies were kept).'; do printf '%s' "$ask_fn" | grep -cF "$s"; done | tr -d '\n')" "1111"
eq "rev U2 page: What changed and Open plan buttons, plain lines folded under Whole plan in plain words" "$(for s in 'data-ev="what-changed"' 'view: "changes"' 'Whole plan in plain words'; do printf '%s' "$ask_fn" | grep -cF "$s"; done | tr -d '\n')" "111"
eq "rev U2 page: the modal has the changes view with a switch to the full plan" "$(for s in 'data-ev="plan-diff"' 'Show full plan' 'mdToHtml(plan.markdown, true)'; do grep -cF "$s" "$BP"; done | tr -d '\n')" "111"
eq "polish U1 page: the changes view names the unit and the plan view keeps indentation" "$(for s in 'data-ev="plan-diff-unit"' '"&nbsp;".repeat('; do grep -cF "$s" "$BP"; done | tr -d '\n')" "11"
eq "U2 page: the question text and Why fold under Details for the record" "$(printf '%s' "$ask_fn" | grep -cF '<details class="qdetails"><summary>Details for the record</summary>')" "1"
eq "U2 page: no plain summary keeps today's question text" "$(printf '%s' "$ask_fn" | grep -cF '${!n.plain && n.text !== n.title')" "1"
eq "U2 page: the button reads Open plan on plan-* and Open doc otherwise" "$(grep -cF '/^plan-/.test(n.id || "") ? "Open plan" : "Open doc"' "$BP")" "1"
eq "U2 page: the Needs-you row gets the doc button and the What you get detail line" "$(grep -cF 'if (n.doc) out.push({ key: "open-doc"' "$BP")$(grep -cF 'l.label === "What you get"' "$BP")" "11"
eq "U2 page: while a plan is open the overlay ignores every key" "$(printf '%s' "$ask_fn" | grep -c 'if (planOpen || chat) return;')$(grep -cF 'planOpen=${!!plan}' "$BP")" "11"
eq "U2 page: the plan modal is rendered after the overlay so it paints on top" "$(awk '/<\$\{AskOverlay\}/{a=NR} /\$\{plan && html`<div class="modal"/{p=NR} END{print (a && p > a) ? "after" : "before"}' "$BP")" "after"

# crew-terminal-access U3: the chat panel opens from a crew row and from a question card.
chat_fn=$(sed -n '/^function ChatPanel(/,/^}/p' "$BP")
eq "U3 page: a crew member with a worktree has chat in its actions menu" "$(sed -n '/^function MemberActions(/,/^}/p' "$BP" | grep -cF '${m.wt && onChat && html`<button class="btn sm chat-btn"')$(grep -cF 'onChat=${() => setChatWith(m)}' "$BP")$(grep -cF '<${ChatPanel} project=${s.label} topic=${s.topic} wt=${chatWith.wt}' "$BP")" "111"
eq "U3 page: a squad question card chats with the member its answer goes to" "$(printf '%s' "$ask_fn" | grep -c 'n.squad !== "_studio" && n.chat_wt')$(printf '%s' "$ask_fn" | grep -c 'wt: n.chat_wt, label: n.chat_label')$(printf '%s' "$ask_fn" | grep -cF '<${ChatPanel} ...${chat}')" "111"
eq "U3 page: the panel reads api/chat every 3 s and stops on close" "$(printf '%s' "$chat_fn" | grep -c 'setInterval(load, 3000)')$(printf '%s' "$chat_fn" | grep -c 'clearInterval(t)')" "11"
eq "U3/U5/U19 page: a wrapping input counted to 2000 by code points, sent with its line breaks to api/chat" "$(printf '%s' "$chat_fn" | grep -c '<textarea class="chat-in" rows="1" ref=${input} enterkeyhint')$(grep -c '^const CHAT_MAX = 2000;' "$BP")$(printf '%s' "$chat_fn" | grep -c 'post("api/chat", ids.length ? { project, topic, wt, text: t, files: ids } : { project, topic, wt, text: t })')$(printf '%s' "$chat_fn" | grep -c 'const t = chatText(text);')" "1111"
eq "U19 page: the key strip posts api/keys, Esc first; a screen toggle reads data.screen" "$(grep -c '^const CHAT_KEYS = \[\["Escape", "Esc"' "$BP")$(printf '%s' "$chat_fn" | grep -cF 'await post("api/keys", { project, topic, wt: to, keys })')$(printf '%s' "$chat_fn" | grep -cF 'class="chat-keys" role="toolbar"')$(printf '%s' "$chat_fn" | grep -cF 'data.screen && typeof data.screen.tail === "string"')" "1111"
# crew-terminal-access U5: the panel reads as a conversation.
chat_row_fn=$(sed -n '/^function chatTurn(/,/^}/p' "$BP")
eq "U5 page: only a reply is HTML, and only through mdToHtml (it escapes first)" "$(printf '%s%s' "$chat_fn" "$chat_row_fn" | grep -ci 'innerHTML')$(printf '%s' "$chat_row_fn" | grep -cF 'dangerouslySetInnerHTML=${{ __html: mdToHtml(text) }}')" "11"
eq "U5 page: at phone width the panel fills the screen" "$(grep -cF '@media (max-width:600px){.chat-modal{padding:0} .mbox.chat{width:100%;height:100%;max-height:none' "$BP")" "1"
eq "U5 page: a counter, Working…, the ↓ button, no send strip (the second data.working line is the card's ■ Stop)" "$(printf '%s' "$chat_fn" | grep -c '} left`}</span>')$(printf '%s' "$chat_fn" | grep -c 'data.working && html')$(printf '%s' "$chat_fn" | grep -c 'class="btn chat-down"')$(grep -c 'chat-sends\|chat-send ' "$BP")" "1210"
# crew-terminal-access U4: the Flow card opens the unit details window, which names the Builder and offers Chat / Show in squad / Answer.
ud_fn=$(sed -n '/^function UnitDetails(/,/^}/p' "$BP")
eq "U4 page: the window's Builder row names the member and its state, or says why it is gone" "$(printf '%s' "$ud_fn" | grep -cF '<b>${bm.label}</b> <span class="mut">· ${bm.state')$(printf '%s' "$ud_fn" | grep -cF 'gone — its worktree')" "11"
eq "U4 page: Chat opens that Builder's panel; Show in squad marks its crew row; Answer opens the question" "$(printf '%s' "$ud_fn" | grep -cF '<${ChatPanel} project=${s.label} topic=${s.topic} wt=${chat.wt}')$(printf '%s' "$ud_fn" | grep -cF 'class="btn sm ud-chat"')$(printf '%s' "$ud_fn" | grep -cF 'onShow(s, bm)')$(printf '%s' "$ud_fn" | grep -cF 'onAsk(ask)')" "1111"
eq "U4 page: a crew row has an id the squad view scrolls to and highlights for 4 s" "$(grep -cF 'id=${m.wt ? crewRowId(s, m) : null}' "$BP")$(grep -cF 'el.classList.add("hl"); setTimeout(() => el.classList.remove("hl"), 4000)' "$BP")$(grep -c '^\.crew \.m\.hl{' "$BP")" "111"
eq "U4/U6 page: the Flow opens the window for every card, the Work units row shares it" "$(grep -cF 'onOpen=${openFlowUnit}' "$BP")$(grep -cF 'onShow=${showCrewRow}' "$BP")$(grep -cF '<${UnitDetails} s=${sq} u=${un}' "$BP")" "111"
# crew-terminal-access U6: every Flow card, Merged included, opens the window; a card of a gone squad opens FlowCardDetails.
fc_fn=$(sed -n '/^function FlowCard(/,/^}/p' "$BP")
eq "U6 page: FlowCard is always a button that opens the window, and keeps no PR or question fallback" "$(printf '%s' "$fc_fn" | grep -c 'role="button" tabIndex=${0}')$(printf '%s' "$fc_fn" | grep -c 'onAsk\|openPr\|link')" "10"
eq "U6 page: the PR number stops the click, so it opens the PR and not the window" "$(printf '%s' "$fc_fn" | grep -c 'onClick=${(e) => e.stopPropagation()}')" "1"
eq "U6 page: the Merged column renders FlowCard, not its own div" "$(grep -cF 'FlowCard({ card: { ...m, stage: "merged", merged: true }' "$BP")$(grep -c 'class="fcard merged"' "$BP")" "10"
eq "U6 page: a card whose unit is not on the board opens FlowCardDetails (squad, stage, PR, merged ago, took, gone line, Answer)" "$(grep -cF ': html`<${FlowCardDetails} card=${flowUnit.card}' "$BP")$(sed -n '/^function FlowCardDetails(/,/^}/p' "$BP" | grep -c 'fcd-squad\|fcd-stage\|fcd-pr\|fcd-merged\|fcd-took\|fcd-gone\|fcd-answer')" "16"

echo "board-page: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
