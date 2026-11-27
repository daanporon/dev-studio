#!/usr/bin/env bash
# side-host-trial.sh — the live trial of a real second host (side-loop-host U23), run BY HAND on main, never in
# CI. It does nothing to either host: it says what the operator does next, then waits until main's loop.db
# (read only) shows it happened. It exits non-zero at the first failed step and writes what it saw to
# <state root>/link/trial-<host>.md. How to run it and where the result goes: docs/backends/trial-side-host.md.
#
#   bin/host/side-host-trial.sh <host-name>                 the whole trial, from the join
#   bin/host/side-host-trial.sh <host-name> --from <step>   take up an earlier run at that step
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
STEPS="join machine seats build update lost return remove"
USAGE="usage: bin/host/side-host-trial.sh <host-name> [--from <step>]    (steps: $STEPS)"
POLL="${DS_TRIAL_POLL_S:-10}"
LIMIT="${DS_TRIAL_TIMEOUT_S:-}"   # one wait's limit in seconds, for every step; unset: each step's own

HOST="${1:-}"; FROM=""
case "$HOST" in
  -h|--help) echo "$USAGE"; exit 0 ;;
  local|""|-*|*[!A-Za-z0-9._-]*) echo "$USAGE" >&2; exit 2 ;;
esac
if [ $# -eq 3 ] && [ "$2" = "--from" ]; then FROM="$3"
elif [ $# -ne 1 ]; then echo "$USAGE" >&2; exit 2; fi
if [ -n "$FROM" ]; then
  case " $STEPS " in *" $FROM "*) ;; *) echo "$USAGE" >&2; exit 2 ;; esac
fi

BUN="$(command -v bun || true)"
[ -n "$BUN" ] || BUN="$HOME/.bun/bin/bun"
[ -x "$BUN" ] || { echo "trial: bun is not installed" >&2; exit 1; }
STATE="${DS_STATE_ROOT:-$ROOT/state}"
[ -f "$STATE/loop.db" ] || { echo "trial: no $STATE/loop.db: run this on main, from the checkout main's loop runs" >&2; exit 1; }
mkdir -p "$STATE/link"
REPORT="$STATE/link/trial-$HOST.md"
SAVED="$STATE/link/trial-$HOST.state"

# --- what the trial remembers, so --from takes up where a run stopped ---------------------------------
saved() { [ ! -f "$SAVED" ] || awk -F= -v k="$1" '$1 == k { v = substr($0, length(k) + 2) } END { print v }' "$SAVED"; }
save() { printf '%s=%s\n' "$1" "$2" >> "$SAVED"; }
note() { printf '%s\n' "$*" >> "$REPORT"; }
say() { printf '%s\n' "$*"; }

# --- the probes: each reads main's loop.db and exits 0 (seen: the facts), 1 (not yet: why) or 2 (failed) ---
PROBES="$(cat <<'JS'
const [root, state, host, name, ...args] = process.argv.slice(1);
const mod = (p) => import(`${root}/bin/${p}`);
const { openReadOnly, now } = await mod("loop/core/store.ts");
const seen = (s) => { console.log(s); process.exit(0); };
const wait = (s) => { console.log(s); process.exit(1); };
const fail = (s) => { console.log(s); process.exit(2); };
const s = openReadOnly(state);
const all = (sql, ...p) => s.db.query(sql).all(...p);
const one = (sql, ...p) => s.db.query(sql).get(...p) ?? null;
const hostRow = () => one("SELECT * FROM hosts WHERE name = ?", host);
const parse = (v) => { try { return JSON.parse(String(v ?? "{}")) ?? {}; } catch { return {}; } };
// This host's events of one kind since `since` (the payload's `name` is the host), oldest first.
const hostEvents = (kind, since) => all("SELECT id, at, payload FROM events WHERE kind = ? AND at >= ? ORDER BY id", kind, since)
  .map((e) => ({ ...e, p: parse(e.payload) })).filter((e) => e.p.name === host);
const iso = (t) => new Date(Number(t) * 1000).toISOString().replace(/\.\d+Z$/, "Z");

const probes = {
  async preflight() {
    if (!one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'host_config'"))
      fail("main's loop.db has no side-host tables: update main first (ds update <project>)");
    seen("ok");
  },
  async join() {
    const { hostLink } = await mod("loop/squad/host-reach.ts");
    const h = hostRow();
    if (!h || h.status === "removed") wait("no join request yet");
    if (h.status === "pending") wait(`pending: check the fingerprint ${h.fingerprint} and accept it`);
    if (hostLink(s, host).state !== "online") wait("accepted, its link is not up yet");
    const up = hostEvents("host_link_up", 0).at(-1);
    seen(`online, accepted ${iso(h.accepted_at)} by ${h.accepted_by}, fingerprint ${h.fingerprint}, address ${up?.p.addr ?? "unknown"}, code ${h.code_rev ?? "unknown"}`);
  },
  async machine() {
    const { machineStale } = await mod("loop/capacity/machine-level.ts");
    const m = one("SELECT * FROM observed_machine WHERE host = ?", host);
    if (!m) wait("no machine sample from the host yet");
    if (machineStale(Number(m.observed_at), now())) wait(`its last machine sample is ${now() - Number(m.observed_at)}s old`);
    if (!one("SELECT 1 FROM observed_host_procs WHERE host = ?", host)) wait("no process sample from the host yet");
    seen(`machine and process samples from the host: ${m.cores} cores, load ${m.load1}, ${Math.round(Number(m.mem_total_kb) / 1048576)} GB memory`);
  },
  async seats() {
    const c = one("SELECT old_value, new_value FROM config_history WHERE host = ? AND key = 'seats' AND actor = 'board' AND at >= ? ORDER BY id DESC LIMIT 1", host, Number(args[0]));
    if (!c) wait("no seats change from the board yet (a value equal to today's writes nothing)");
    const seats = Number(hostRow()?.seats ?? 0);
    if (seats < 1) wait("the host has 0 seats: set at least 1, or nothing can be built there");
    seen(`seats set on the board: ${c.old_value ?? "(default)"} -> ${c.new_value ?? "(default)"}, now ${seats}`);
  },
  // A unit whose Builder ran on the host from start to finish: its newest member is still the one there.
  async build() {
    const since = Number(args[0]);
    const rows = all("SELECT * FROM members WHERE host = ? AND role = 'builder' ORDER BY id DESC", host);
    const { unitSlug } = await mod("loop/squad/host-requeue.ts");
    const open = [];
    for (const m of rows) {
      const slug = unitSlug(m), id = `${m.project}/${m.squad}/${slug}`;
      const last = one("SELECT id FROM members WHERE project = ? AND squad = ? AND role = 'builder' AND suffix = ? ORDER BY id DESC LIMIT 1", m.project, m.squad, m.suffix);
      if (last.id !== m.id || m.fenced_at != null) continue;
      const u = one("SELECT * FROM units WHERE project = ? AND squad = ? AND slug = ?", m.project, m.squad, slug);
      if (!u) continue;
      const f = one("SELECT * FROM finishes WHERE project = ? AND squad = ? AND unit = ? AND member = ? AND at >= ? ORDER BY id DESC LIMIT 1",
        m.project, m.squad, slug, `${m.project}/${m.squad}/builder-${m.suffix}`, since);
      if (u.status === "done" && f?.outcome === "ok" && String(m.wt ?? "").startsWith(`${host}::`))
        seen(`unit ${id} was built on the host (${m.wt}): finished ${iso(f.at)}, unit done, PR ${u.pr ?? "none"}`);
      if (u.status !== "done" && u.status !== "cancelled") open.push(`${id} (${f ? `finish ${f.outcome}, ` : ""}unit ${u.status})`);
    }
    wait(open.length ? `on the host, not done yet: ${open.join(", ")}` : "no Builder on the host yet");
  },
  async rev() { seen(String(hostRow()?.code_rev ?? "")); },
  async update() {
    const since = Number(args[0]), before = args[1] ?? "";
    const { latestUpdate, behindTarget } = await mod("loop/squad/side-update.ts");
    const u = latestUpdate(s);
    if (!u || Number(one("SELECT created_at FROM requests WHERE id = ?", u.id).created_at) < since) wait("no finished ds update on main since this step began");
    const step = u.hosts[host];
    if (!step) wait(`update ${u.id}: no job for the host yet`);
    if (step.state === "failed") fail(`update ${u.id}: the host's update failed: ${step.error ?? step.line ?? "no reason given"} (its log: state/link/update.log there)`);
    if (step.stuck_at && step.state !== "done") fail(`update ${u.id}: the host is still behind 10 minutes after its job: ${step.error ?? step.line ?? step.state}`);
    if (step.state !== "done") wait(`update ${u.id}: the host's step is ${step.state}`);
    const rev = String(hostRow()?.code_rev ?? "");
    if (behindTarget(rev, u.target)) wait(`update ${u.id}: the host reports ${rev || "no commit"}, main is on ${u.target.slice(0, 12)}`);
    if (before && u.target.startsWith(before)) wait(`update ${u.id} left main on ${before}, which the host already ran: merge something, then ds update again`);
    seen(`update ${u.id}: the host moved ${before || "(unknown)"} -> ${rev}, main's commit`);
  },
  // A Builder working on the host now, to lose: `<member id> <attempt> <project>/<squad>/<slug>`.
  async victim() {
    const { liveOn, unitSlug } = await mod("loop/squad/host-requeue.ts");
    for (const m of liveOn(s, host)) {
      if (m.role !== "builder" || m.want !== "running" || !String(m.wt ?? "").startsWith(`${host}::`)) continue;
      const u = one("SELECT * FROM units WHERE project = ? AND squad = ? AND slug = ?", m.project, m.squad, unitSlug(m));
      if (u && u.status !== "done" && u.status !== "cancelled") seen(`${m.id} ${u.attempt ?? 1} ${m.project}/${m.squad}/${u.slug}`);
    }
    wait("no Builder at work on the host: give it a second unit");
  },
  async kept() {
    const m = one("SELECT status, fenced_at FROM members WHERE id = ?", Number(args[0]));
    if (m && (m.fenced_at != null || !["gone", "closed"].includes(m.status))) seen("kept");
    wait("that Builder ended on its own");
  },
  // The host is lost: main saw the link drop, waited out the grace, and moved the victim's unit on.
  async fenced() {
    const since = Number(args[0]), victim = Number(args[1]), unit = args[2];
    const [project, squad, slug] = unit.split("/");
    const { graceS } = await mod("loop/reconcilers/side-fence.ts");
    const f = hostEvents("host_fenced", since)[0];
    if (!f) {
      const u = one("SELECT status FROM units WHERE project = ? AND squad = ? AND slug = ?", project, squad, slug);
      if (u?.status === "done") fail(`${unit} finished before the host was lost: run --from lost again with another unit`);
      const h = hostRow();
      wait(h?.unreachable_since != null ? `the host reads unreachable since ${iso(h.unreachable_since)}; main waits ${graceS(s) / 60} min and 60 s` : "the link is still up: unplug the host");
    }
    const down = hostEvents("host_link_down", since).filter((e) => e.id < f.id).at(-1);
    if (!down) fail("main fenced the host without ever seeing its link drop in this step");
    if (f.at - down.at < graceS(s)) fail(`main moved the work ${f.at - down.at}s after the link dropped, inside the ${graceS(s)}s grace`);
    const moved = all("SELECT payload FROM events WHERE kind = 'member_host_fenced' AND id <= ? AND at >= ?", f.id, since).some((e) => Number(parse(e.payload).id) === victim);
    if (!moved) fail(`main fenced the host but did not move ${unit}'s Builder`);
    seen(`${f.id} ${f.at} link down ${iso(down.at)}, work moved ${iso(f.at)} (${Math.round((f.at - down.at) / 60)} min later): ${(f.p.units ?? []).join(", ") || "no units"}`);
  },
  async elsewhere() {
    const victim = Number(args[0]), attempt = Number(args[1]), unit = args[2], since = Number(args[3]);
    const [project, squad, slug] = unit.split("/");
    const u = one("SELECT * FROM units WHERE project = ? AND squad = ? AND slug = ?", project, squad, slug);
    if (!u) fail(`unit ${unit} is gone`);
    if (u.status === "cancelled") fail(`unit ${unit} was cancelled`);
    if (Number(u.attempt ?? 1) <= attempt) fail(`unit ${unit} is still on attempt ${attempt}: it was not queued again`);
    const old = one("SELECT suffix FROM members WHERE id = ?", victim);
    const m = one("SELECT * FROM members WHERE project = ? AND squad = ? AND role = 'builder' AND suffix = ? AND id > ? ORDER BY id DESC LIMIT 1", project, squad, old.suffix, victim);
    if (!m?.wt) wait(`attempt ${u.attempt} waits for a seat`);
    if (m.host === host) fail(`attempt ${u.attempt} was placed on the lost host again`);
    const f = one("SELECT * FROM finishes WHERE project = ? AND squad = ? AND unit = ? AND at >= ? ORDER BY id DESC LIMIT 1", project, squad, slug, since);
    if (u.status !== "done" || f?.outcome !== "ok") wait(`attempt ${u.attempt} is at work on ${m.wt} (unit ${u.status}${f ? `, finish ${f.outcome}` : ""})`);
    seen(`unit ${unit} finished elsewhere: attempt ${u.attempt} on ${m.wt}, from ${u.retry_from ?? "the default branch"}, PR ${u.pr ?? "none"}${u.retry_pr ? `, old PR ${u.retry_pr} (close it if still open)` : ""}`);
  },
  async return() {
    const fenceId = Number(args[0]);
    const { hostLink } = await mod("loop/squad/host-reach.ts");
    const { staleOn } = await mod("loop/reconcilers/host-fence.ts");
    const back = hostEvents("host_returned", 0).find((e) => e.id > fenceId);
    if (hostLink(s, host).state !== "online") wait("the host's link is not up yet");
    if (!back) wait("the link is up; main has not taken the host back yet");
    const stale = staleOn(s, host).length;
    if (stale) wait(`${stale} old terminals on the host are not closed yet`);
    seen(`main took the host back ${iso(back.at)} and closed the old terminals there`);
  },
  async remove() {
    const { liveOn } = await mod("loop/squad/host-requeue.ts");
    const h = hostRow();
    const live = liveOn(s, host);
    if (h?.status !== "removed") wait(`the host is still ${h?.status}${h?.drain ? ", draining" : ""}, ${live.length} members on it`);
    if (live.length) fail(`the host was removed with ${live.length} members still on it: main never moves those (docs/runbooks/side-host.md, "Remove")`);
    seen(`removed ${iso(h.removed_at)} by ${h.removed_by}, no member left on it`);
  },
};
await probes[name]();
JS
)"
probe() { "$BUN" -e "$PROBES" -- "$ROOT" "$STATE" "$HOST" "$@"; }

fail_step() {
  say "trial: FAILED at $STEP: $1" >&2
  note "- **$STEP: FAILED** ($(date -u +%FT%TZ)): $1"
  say "trial: report in $REPORT" >&2
  say "trial: once it is fixed: bin/host/side-host-trial.sh $HOST --from $STEP" >&2
  exit 1
}

# await <seconds> <probe> [args…]: until the probe has seen it; leaves its line in SEEN. A new "not yet" reason is printed.
await() {
  local limit="${LIMIT:-$1}" out rc last="" end; shift
  end=$((SECONDS + limit))
  while :; do
    rc=0; out="$(probe "$@" 2>&1)" || rc=$?
    case "$rc" in
      0) SEEN="$out"; return 0 ;;
      1) if [ "$out" != "$last" ]; then say "  waiting: $out"; last="$out"; fi ;;
      *) fail_step "$out" ;;
    esac
    [ "$SECONDS" -lt "$end" ] || fail_step "gave up after ${limit}s: $last"
    sleep "$POLL"
  done
}
passed() { say "  ok: $1"; note "- **$STEP: ok** ($(date -u +%FT%TZ)): $1"; }
# Only the operator can see a screen: anything but y fails the step.
confirm() {
  local answer=""
  printf '  %s [y/N] ' "$1"
  read -r answer || true
  case "$answer" in y|Y|yes) ;; *) fail_step "the operator did not confirm: $1" ;; esac
}
# When this step first began, kept across --from: what it looks for may have happened since.
began() {
  local at; at="$(saved "began_$STEP")"
  if [ -z "$at" ]; then at="$(date +%s)"; save "began_$STEP" "$at"; fi
  echo "$at"
}

step_join() {
  say "  On main:  bin/ds config set <project> limits.conf link_listen on"
  say "  On the second machine, in a plain shell in a dev-studio clone:"
  say "            bin/ds join <main-address>:<link_port> --name $HOST"
  say "  Then accept it on the board (or: bin/ds host accept $HOST), after comparing the fingerprint."
  await 3600 join; passed "$SEEN"
}
step_machine() {
  await 600 machine; passed "$SEEN"
  confirm "Does the board's Machine panel show its own section for $HOST, with its load, memory and top processes?"
  passed "the operator sees the host's own Machine section"
}
step_seats() {
  local at; at="$(began)"
  say "  On the board: Settings → Hosts → $HOST, change its seats (to a new number, 1 or more; 2 leaves room for the lost-host step)."
  await 3600 seats "$at"; passed "$SEEN"
}
step_build() {
  say "  Give $HOST a real unit and see it through: its Builder finishes and the PR merges."
  say "  Main fills itself first. To force the host:  bin/commands/add-role.sh <project> <topic> builder <unit-slug> --host $HOST"
  await 28800 build "$STARTED"; passed "$SEEN"
}
step_update() {
  local at before; at="$(began)"
  before="$(saved rev_before)"
  if [ -z "$before" ]; then before="$(probe rev)"; save rev_before "$before"; fi
  say "  $HOST runs ${before:-an unknown commit}. With something new merged to main's branch, on main:  bin/ds update <project>"
  await 3600 update "$at" "$before"; passed "$SEEN"
}
step_lost() {
  local at victim fence rest attempt unit id fence_id fence_at
  victim="$(saved victim)"
  # A saved Builder is kept while it is at work, and after main has moved it; else pick the one at work now.
  if [ -z "$victim" ] || ! probe kept "${victim%% *}" >/dev/null; then
    say "  Give $HOST another real unit that takes a while:  bin/commands/add-role.sh <project> <topic> builder <unit-slug> --host $HOST"
    await 3600 victim
    victim="$SEEN"
    save began_lost "$(date +%s)"; save victim "$victim"; save fence ""
  fi
  at="$(saved began_lost)"
  read -r id attempt unit <<<"$victim"
  fence="$(saved fence)"
  if [ -z "$fence" ]; then
    say "  $unit is being built on $HOST. Now UNPLUG it: cut its network or its power. Do not stop its loop first."
    say "  Leave it unplugged until this script says to plug it back in."
    await 3600 fenced "$at" "$id" "$unit"
    fence="$SEEN"; save fence "$fence"
  fi
  read -r fence_id fence_at rest <<<"$fence"
  passed "$rest"
  say "  Keep $HOST unplugged. See $unit through on its new seat: the Builder finishes and the PR merges."
  await 28800 elsewhere "$id" "$attempt" "$unit" "$fence_at"; passed "$SEEN"
}
step_return() {
  local fence fence_id rest
  fence="$(saved fence)"
  [ -n "$fence" ] || fail_step "no lost host in this trial yet: run --from lost"
  read -r fence_id rest <<<"$fence"
  say "  Plug $HOST back in."
  await 3600 return "$fence_id"; passed "$SEEN"
}
step_remove() {
  say "  On main:  bin/ds host drain $HOST   then, once no member is on it:  bin/ds host remove $HOST  (or Remove on its Hosts row)"
  say "  Then on $HOST stop the side loop for good (docs/runbooks/side-host.md, \"Remove\")."
  await 3600 remove; passed "$SEEN"
}

STEP=preflight
rc=0; out="$(probe preflight 2>&1)" || rc=$?
[ "$rc" -eq 0 ] || { say "trial: $out" >&2; exit 1; }

if [ -z "$FROM" ]; then
  rm -f "$SAVED"
  : > "$REPORT"
  note "# Side host trial: $HOST"
  note ""
  note "Started $(date -u +%FT%TZ), main on commit $(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)."
  note ""
fi
STARTED="$(saved started)"
if [ -z "$STARTED" ]; then STARTED="$(date +%s)"; save started "$STARTED"; fi

n=0; total="$(wc -w <<<"$STEPS")"
for STEP in $STEPS; do
  n=$((n + 1))
  if [ -n "$FROM" ]; then
    [ "$STEP" = "$FROM" ] || continue
    FROM=""
    note "- resumed at $STEP ($(date -u +%FT%TZ))"
  fi
  say "[$n/$total] $STEP"
  "step_$STEP"
done
note ""
note "**All steps passed** ($(date -u +%FT%TZ))."
say "trial: every step passed. Write the result into docs/backends/trial-side-host.md from $REPORT."
