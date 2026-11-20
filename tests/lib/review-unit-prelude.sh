# shellcheck shell=bash
# shellcheck disable=SC2034  # the variables are used by the part that sources this
# review-unit-prelude.sh — sourced by the tests/review-unit*.sh parts (U233): the stub claude/muse/jq on PATH, the
# fixture HOME and repo, and the check helpers. The caller sets nothing: ROOT comes from the part's own path.

RU="$ROOT/bin/review/review-unit.sh"
LBL="zzru_$$"; SD="$ROOT/state/$LBL"
# Bun reads every parent directory of its cwd when it starts, so on a host whose /tmp holds a million
# entries each Bun start in a /tmp repo costs a second; the per-user runtime dir is small.
TMP="$(mktemp -d -p "$( [ -d "${XDG_RUNTIME_DIR:-}" ] && [ -w "$XDG_RUNTIME_DIR" ] && echo "$XDG_RUNTIME_DIR" || echo "${TMPDIR:-/tmp}")")"
# U229: the review role's skill list is resolved by `ds skills resolve` on every run; here it is an empty list (no --settings)
# unless a check below sets its own stub, so the ~100 runs do not each start Bun.
printf '#!/bin/sh\necho "{}"\n' > "$TMP/resolve-none"; chmod +x "$TMP/resolve-none"; export DS_SKILLS_RESOLVE="$TMP/resolve-none"
trap 'rm -rf "$SD" "$TMP"' EXIT
# U257: review-unit reads the project's roster and limits as `config` rows of its state root's loop.db, never
# $SD/roles.conf. So $RU is a wrapper: before each run it copies $SD's settings files into the rows of the state
# root the run uses (DS_STATE_ROOT, else the suite's own $RU_STATE, never the checkout's), as the loop's config
# observer would. It does so on every run, because a case's `ds import` drops the rows of a project its root
# lacks. The squads, alerts and receipts stay where the script keeps them.
RU_REAL="$RU"; RU="$TMP/review-unit.sh"; export RU_STATE="$TMP/state"; mkdir -p "$RU_STATE"
cat > "$RU" <<WRAP
#!/usr/bin/env bash
st="\${DS_STATE_ROOT:-$RU_STATE}"
bun "$ROOT/tests/lib/observe-config.ts" "\$st" "$LBL=$SD" || exit 1
DS_STATE_ROOT="\$st" exec "$RU_REAL" "\$@"
WRAP
chmod +x "$RU"
cat > "$TMP/claude" <<'STUB'
#!/usr/bin/env bash
# `claude plugin list --json` (the preflight probe): PLUG_JSON overrides the listing, PLUG_FAIL fails it.
if [ "${1:-}" = plugin ]; then
  printf 'plugin-list\n' >> "$CLAUDE_PLUGIN_LOG"
  [ -n "${PLUG_FAIL:-}" ] && exit 1
  if [ -n "${PLUG_JSON:-}" ]; then printf '%s\n' "$PLUG_JSON"
  else printf '[{"id":"compound-engineering@compound-engineering-plugin","scope":"user","enabled":true,"installPath":"%s"}]\n' "$PLUG_HEALTHY"; fi
  exit 0
fi
export FIXTURE_PROMPT="$*" FIXTURE_HEAD="$(git rev-parse HEAD)"
printf 'args:%s\n' "$*" >> "$CLAUDE_LOG"
printf 'peers:%s\n' "${CROSS_MODEL_PEERS-unset}" >> "$CLAUDE_LOG"
printf 'handle:%s\n' "${ORCA_TERMINAL_HANDLE:-}" >> "$CLAUDE_LOG"
printf 'stdin:%s\n' "$(cat)" >> "$CLAUDE_LOG"
if [ -n "${STUB_ERR:-}" ]; then printf '%s\n' "$STUB_ERR" >&2; fi
if [ "${STUB_BAD_INDEX:-0}" = 1 ]; then printf invalid > "${GIT_INDEX_FILE:?}"; fi
if [ -n "${STUB_RECEIPT:-}" ]; then printf 'reviewer-wrote-this\t1\t-\t0\n' > "$(git rev-parse --git-dir)/ds-review"; fi
# U4: STUB_MARKER_LOG gets the review marker as the engine sees it (and whether its pid is alive), or
# "none"; STUB_SLEEP records this stub's pid in STUB_SLEEP_PID and sleeps (the TERM case kills it).
if [ -n "${STUB_MARKER_LOG:-}" ]; then
  m="$(git rev-parse --git-dir)/ds-review-start"
  if [ -f "$m" ]; then printf '%s\t%s\n' "$(head -1 "$m")" "$(kill -0 "$(cut -f4 "$m")" 2>/dev/null && echo alive || echo dead)" >> "$STUB_MARKER_LOG"
  else echo none >> "$STUB_MARKER_LOG"; fi
fi
if [ -n "${STUB_SLEEP:-}" ]; then echo $$ > "$STUB_SLEEP_PID"; exec sleep "$STUB_SLEEP"; fi
default_report='{"status":"complete","actionable_findings":[]}'
# The script runs claude with --output-format stream-json: one assistant message per turn.
# STUB_FIRST_TURN is first-turn prose from a session whose reviewers report in a later turn.
text_event() { jq -cn --arg t "$1" '{type:"assistant",message:{content:[{type:"text",text:$t}]}}'; }
out="$(review-fixture "${STUB_OUT:-$default_report}")"
[ -z "${STUB_FIRST_TURN:-}" ] || text_event "$STUB_FIRST_TURN"
text_event "$out"
[ -z "${STUB_TRAILING_TURN:-}" ] || text_event "$STUB_TRAILING_TURN"
exit "${STUB_EXIT:-0}"
STUB
chmod +x "$TMP/claude"
cat > "$TMP/muse" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = skills ]; then printf '%s' "${MUSE_SKILLS:-}"; exit 0; fi
export FIXTURE_PROMPT="$*" FIXTURE_HEAD="$(git rev-parse HEAD)"
printf 'args:%s\n' "$*" >> "$MUSE_LOG"
printf 'handle:%s\n' "${ORCA_TERMINAL_HANDLE:-}" >> "$MUSE_LOG"
printf 'stdin:%s\n' "$(cat)" >> "$MUSE_LOG"
if [ -n "${MUSE_DIRTY:-}" ]; then echo dirtied > dirtied-by-muse.txt; fi
if [ -n "${MUSE_COMMIT:-}" ]; then git -c user.email=t@t -c user.name=t commit -q --allow-empty -m "muse mid-review commit"; fi
if [ -n "${MUSE_IGNORED:-}" ]; then mkdir -p node_modules/.cache/tool && echo '{}' > node_modules/.cache/tool/x.json; fi
# MUSE_ERR is a failed run as the real muse 1.4.14 shows one: its banner and the error on
# stderr, nothing on stdout (unless MUSE_OUT is set too), exit 1.
if [ -n "${MUSE_ERR:-}" ]; then
  printf 'muse: workspace trust: trusted source=run-flag\n%s\n' "$MUSE_ERR" >&2
  [ -z "${MUSE_OUT:-}" ] || review-fixture "$MUSE_OUT"
  exit "${MUSE_EXIT:-1}"
fi
default_report='{"status":"complete","actionable_findings":[]}'
review-fixture "${MUSE_OUT:-$default_report}"
exit "${MUSE_EXIT:-0}"
STUB
chmod +x "$TMP/muse"
cat > "$TMP/codex" <<'STUB'
#!/usr/bin/env bash
export FIXTURE_PROMPT="$*" FIXTURE_HEAD="$(git rev-parse HEAD)"
printf 'args:%s\n' "$*" >> "$CODEX_LOG"
printf 'handle:%s\n' "${ORCA_TERMINAL_HANDLE:-}" >> "$CODEX_LOG"
printf 'stdin:%s\n' "$(cat)" >> "$CODEX_LOG"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output-last-message ]; then shift; output="$1"; fi
  shift
done
[ -z "${CODEX_ERR:-}" ] || printf '%s\n' "$CODEX_ERR" >&2
[ -z "${CODEX_LONG:-}" ] || seq 1 "$CODEX_LONG" | sed 's/^/codex log line /'
if [ -n "${CODEX_DIRTY:-}" ]; then echo dirtied > dirtied-by-codex.txt; fi
default_report='{"status":"complete","actionable_findings":[]}'
review-fixture "${CODEX_OUT:-$default_report}" > "$output"
echo 'Codex progress output that is not the review report'
exit "${CODEX_EXIT:-0}"
STUB
chmod +x "$TMP/codex"
# Run-file shape copied from a completed ce-code-review run (scope/select/dispatch/merge/validate/report).
cat > "$TMP/review-fixture" <<'FIXTURE'
#!/usr/bin/env python3
import json, os, re, subprocess, sys, tempfile
raw = sys.argv[1]
try:
    report = json.loads(raw)
except ValueError:
    print(raw)
    sys.exit(0)
if not isinstance(report, dict) or report.get("status") != "complete":
    print(raw)
    sys.exit(0)
def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()
skip_flag = os.environ.get("REVIEW_SKIP_FIRST_CALL")
if skip_flag and not os.path.exists(skip_flag):
    # U194: the engine answers without running the skill on the first call: prose,
    # no run folder. The flag file marks the retry, which runs the skill as usual.
    open(skip_flag, "w").close()
    print("I read the diff directly and found no issues; no formal review needed.")
    sys.exit(0)
head = os.environ["FIXTURE_HEAD"]
match = re.search(r"(?:^| )base:([^ ]+)", os.environ["FIXTURE_PROMPT"])
base = match[1] if match else head
try:
    base = git("merge-base", base, head)
except subprocess.CalledProcessError:
    pass
if os.environ.get("REVIEW_SCOPE_LOG"):
    observed = dict(base=base, files=git("diff", "--name-only", base, head).splitlines(),
                    diff=git("diff", "--no-color", base, head),
                    parents=git("show", "-s", "--format=%P", base),
                    refs=git("for-each-ref", "--format=%(refname)", "--points-at", base).splitlines())
    with open(os.environ["REVIEW_SCOPE_LOG"], "w") as log:
        json.dump(observed, log)
def skill_run_dir(suffix=None):
    # The skill's own folder name (its RUN_ID): <yyyymmdd>-<hhmmss>-<8 hex>; review-unit takes a new
    # folder of any other shape for one the reviewer made by hand (U2).
    import secrets, time
    while True:
        p = os.path.join(os.environ["REVIEW_FIXTURES"], time.strftime("%Y%m%d-%H%M%S") + "-" + (suffix or secrets.token_hex(4)))
        try:
            os.mkdir(p, 0o700)
            return p
        except FileExistsError:
            if suffix: time.sleep(1)
leave = os.environ.get("REVIEW_LEAVE_SKILL")
leave_flag = os.environ.get("REVIEW_LEAVE_SKILL_FLAG")
if leave and not (leave_flag and os.path.exists(leave_flag)):
    # U2: the reviewer leaves the skill part-way and writes its own result. With a flag file only
    # the first call does (the flag then marks the retry, which runs the skill); without one, every call.
    if leave_flag: open(leave_flag, "w").close()
    import time
    ts = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
    own = dict(report, run_id="hand-made", scope=dict(report.get("scope", {}), head_sha=head, base=base))
    if leave == "scope":
        stalled = skill_run_dir()
        with open(os.path.join(stalled, "stages.jsonl"), "w") as f:
            f.write(json.dumps(dict(phase="start", stage="scope", ts=ts)) + "\n")
    elif leave in ("delta", "delta-branch"):
        # delta-branch: the hand-made metadata also records the branch, so only its name tells it apart.
        d = skill_run_dir("delta")
        meta = dict(run_id=os.path.basename(d), head_sha=head, verdict="Ready to merge")
        if leave == "delta-branch": meta["branch"] = git("branch", "--show-current")
        with open(os.path.join(d, "metadata.json"), "w") as f:
            json.dump(meta, f)
        with open(os.path.join(d, "review.json"), "w") as f:
            json.dump(dict(own, run_id=os.path.basename(d), artifact_path=d), f)
    elif leave == "rewrite":
        old = os.environ["REVIEW_LEAVE_REWRITE"]
        with open(os.path.join(old, "review.json"), "w") as f:
            json.dump(dict(own, run_id=os.path.basename(old), artifact_path=old, intent="rewritten by hand"), f)
    print("I reviewed the diff myself and wrote the result; no issues found.")
    sys.exit(0)
run = skill_run_dir()
report.setdefault("scope", {}).setdefault("head_sha", head)
report["scope"].setdefault("base", base)
report.setdefault("reviewers", ["correctness", "adversarial"])
report.setdefault("coverage", {}).setdefault("depth", "full")
report.update(run_id=os.path.basename(run), artifact_path=run)
try:
    fixture_branch = git("branch", "--show-current")
except subprocess.CalledProcessError:
    fixture_branch = ""
metadata = dict(run_id=report["run_id"], head_sha=head, branch=fixture_branch, cost=dict(status="complete"))
case = os.environ.get("PROOF_CASE", "")
focused_cases = ("focused", "focused-contract", "focused-no-name", "focused-no-file",
                 "focused-wrong-reviewer", "focused-no-findings", "focused-pending-depth",
                 "focused-last-depth-mismatch", "focused-scope-full", "focused-scope-lite",
                 "focused-mid-downgrade")
lite_cases = ("lite", "lite-review-orphan")
if case in lite_cases or case in focused_cases:
    report["coverage"]["depth"] = "lite" if case in lite_cases else "focused"
if case in lite_cases:
    report["reviewers"] = []
depth = report["coverage"]["depth"]
names = ["scope", "select", "dispatch", "merge", "validate", "report"] if depth == "full" else ["scope", "review", "receipt"]
events = []
for stage in names:
    events.append(dict(stage=stage, phase="start", ts="2026-11-05T09:14:31+00:00"))
    end = dict(stage=stage, phase="end", ts="2026-11-05T09:15:32+00:00")
    if stage == "scope": end["facts"] = dict(depth=depth)
    if stage in ("select", "review") and depth != "lite": end["reviewers"] = 2
    events.append(end)
if case in focused_cases:
    # Installed depth-paths.md logs peer/review completion but no reviewers counter.
    report["reviewers"] = ["correctness", "adversarial" if case == "focused" else "adversarial-codex"]
    if case == "focused-no-name": report["reviewers"] = ["correctness"]
    for e in events: e.pop("reviewers", None)
    peer_end = dict(stage="peer", phase="end", candidates=0)
    if case in ("focused-pending-depth", "focused-last-depth-mismatch", "focused-scope-full", "focused-scope-lite", "focused-mid-downgrade"):
        events[1]["facts"]["depth"] = "full" if case == "focused-scope-full" else "lite" if case == "focused-scope-lite" else "pending"
        peer_end["facts"] = dict(depth="full" if case in ("focused-last-depth-mismatch", "focused-mid-downgrade") else "focused")
    events[3:3] = [dict(stage="peer", phase="start"), peer_end]
    if case == "focused-mid-downgrade": events[5]["facts"] = dict(depth="focused")
if case == "full-mid-escalate":
    events[1]["facts"]["depth"] = "pending"
    events[3]["facts"] = dict(depth="focused")
    events[5]["facts"] = dict(depth="full")
if case == "missing-head": report["scope"].pop("head_sha")
if case == "missing-base": report["scope"].pop("base")
if case == "wrong-base": report["scope"]["base"] = git("rev-parse", "HEAD")
if case in ("abbrev-full-finish-head", "abbrev-wrong-finish-head"):
    report["scope"]["head_sha"] = head[:7]
if case == "base-ref": report["scope"]["base"] = os.environ["PROOF_BASE_REF"] + os.environ.get("PROOF_BASE_NOTE", "")
if case == "pr-marker": report["scope"]["base"] = "pr:17"
if case == "unknown-base": report["scope"]["base"] = "unknown-but-present"
if case == "no-reviewers":
    for e in events: e.pop("reviewers", None)
if case == "empty-roster": report["reviewers"] = []
if case == "dangling": events.append(dict(stage="peer", phase="start"))
peer_orphans = ("orphan-end", "orphan-claude-peer", "orphan-unverified-peer", "orphan-peer-mismatch", "orphan-peer-no-artifact")
orphan_stages = dict.fromkeys(peer_orphans, "peer")
orphan_stages.update({"orphan-dispatch": "dispatch", "orphan-dispatch-no-returns": "dispatch",
                      "orphan-review": "review", "orphan-review-zero": "review",
                      "orphan-review-empty-ts": "review", "orphan-review-no-artifact": "review",
                      "orphan-select": "select", "orphan-merge": "merge", "orphan-report": "report"})
if case in orphan_stages:
    events = [e for e in events if not (e["stage"] == orphan_stages[case] and e["phase"] == "start")]
if case in peer_orphans:
    report["reviewers"].append("adversarial-claude" if case in ("orphan-claude-peer", "orphan-peer-mismatch") else "adversarial-codex")
    events.append(dict(stage="peer", phase="end"))
if case in ("empty-no-validate", "empty-no-input", "empty-no-count", "empty-selected", "empty-list-labeled", "verdicts-no-validate"):
    events = [e for e in events if e["stage"] != "validate"]
if case in ("orphan-review", "orphan-review-zero", "orphan-review-empty-ts", "orphan-review-no-artifact"):
    report["coverage"]["depth"] = "focused"
    events = [e for e in events if e["stage"] not in ("select", "dispatch", "merge", "validate", "report")]
    events[1]["facts"]["depth"] = "focused"
    candidates = 0 if case == "orphan-review-zero" else 2
    events.extend([dict(stage="review", phase="end", reviewers=2, candidates=candidates),
                   dict(stage="receipt", phase="start"), dict(stage="receipt", phase="end")])
    metadata["cost"]["stages"] = [dict(stage="review", ended_at="" if case == "orphan-review-empty-ts" else "2026-11-05T09:15:32+00:00", candidates=candidates)]
    if case == "orphan-review-no-artifact": metadata["cost"].pop("stages")
if case == "depth-mismatch": events[1]["facts"]["depth"] = "lite"
if case == "metadata-head": metadata["head_sha"] = "0" * 40
if case == "wrong-branch": metadata["branch"] = "elsewhere"
if case == "rewritten-print":
    # The session retypes the report: different intent, shortened evidence, dropped notes.
    report["intent"] = "verify the unit handles base merges correctly"
    report["coverage"]["notes"] = "checked scope, dispatch and merge stages in full"
    report["evidence"] = [{"file": "bin/review/review-unit.sh", "lines": "1-50"}, {"file": "tests/review-unit.sh", "lines": "1-20"}]
if case == "partial-cost": metadata["cost"]["status"] = "partial"
if case.startswith("swap-"):
    # U219: the skill's run-log.py calls a run partial when the model logged a stage's end
    # before its start. swap-merge is ACME U47's real log shape (merge end, then start).
    metadata["cost"].update(status="partial", dangling_stages=["merge"])
    events[6], events[7] = events[7], events[6]
    if case == "swap-last":
        events[6], events[7] = events[7], events[6]
        events[10], events[11] = events[11], events[10]
        metadata["cost"]["dangling_stages"] = ["report"]
    if case == "swap-start-only": del events[7]
    if case == "swap-end-start-end": events.insert(8, dict(stage="merge", phase="end"))
    if case == "swap-double-start": events[6]["phase"] = "start"
    if case == "swap-other-dangling": metadata["cost"]["dangling_stages"] = ["validate"]
    if case == "swap-one-ok-one-not": metadata["cost"]["dangling_stages"] = ["merge", "validate"]
    if case == "swap-empty-dangling": metadata["cost"]["dangling_stages"] = []
    if case == "swap-no-dangling": metadata["cost"].pop("dangling_stages")
    if case == "swap-no-log": events = []
if case == "missing-run-id": report.pop("run_id")
if case == "incomplete-file": report["status"] = "incomplete"
if case == "missing-artifact": report.pop("artifact_path")
# U250: what review-unit knows from the folder it found is not demanded from the report.
if case == "artifact-null": report["artifact_path"] = None
if case == "artifact-gone": report["artifact_path"] = os.path.join(run, "no-such-folder")
if case == "artifact-other-run":
    other = os.path.join(os.path.dirname(run), "other-run-folder"); os.makedirs(other, exist_ok=True)
    report["artifact_path"] = other
if case == "wrong-scope-head": report["scope"]["head_sha"] = "1" * 40
if case == "missing-head-no-meta": report["scope"].pop("head_sha"); metadata["head_sha"] = "2" * 40
if case == "lite-review-orphan":
    events = [e for e in events if not (e["stage"] == "review" and e["phase"] == "start")]
from pathlib import Path
r = Path(run)
returns = [dict(reviewer=name, findings=[]) for name in ("correctness", "adversarial")]
finish = dict(run_id=metadata["run_id"], scope=report["scope"].copy(),
              roster=dict(selected=[dict(reviewer=name) for name in ("correctness", "adversarial")]),
              collection=dict(returns=str(r / "raw-returns.json"), failed_reviewers=[], bound_exceeded=[]))
finish["scope"]["head_sha"] = head  # finish-input uses the full git HEAD even when the report abbreviates it.
if case == "abbrev-wrong-finish-head": finish["scope"]["head_sha"] = "0" * 40
if case in ("short-run-sha", "wrong-short-run-sha"):
    # U198: the skill wrote short shas in the run files (metadata and finish-input) while the
    # report carries the full HEAD, like U184's 20261110-120613 run.
    other = "0" * 7 if base == head else base[:7]
    short = head[:7] if case == "short-run-sha" else other
    metadata["head_sha"] = short
    finish["scope"]["head_sha"] = short
if case == "roster-truncated":
    names = ["correctness", "testing", "reliability", "project-standards", "adversarial"]
    report["reviewers"] = names
    finish["roster"]["selected"] = [dict(reviewer=name) for name in names]
    returns = [dict(reviewer=name, findings=[]) for name in names]
    next(e for e in events if e["stage"] == "select" and e["phase"] == "end")["reviewers"] = 6
if os.environ.get("FIXTURE_REVIEWERS"):  # a report whose roster is exactly these reviewers
    names = os.environ["FIXTURE_REVIEWERS"].split(",")
    report["reviewers"] = names
    finish["roster"]["selected"] = [dict(reviewer=name) for name in names]
    returns = [dict(reviewer=name, findings=[]) for name in names]
    next(e for e in events if e["stage"] == "select" and e["phase"] == "end")["reviewers"] = len(names)
if case == "roster-duplicate":
    finish["roster"]["selected"].append(dict(reviewer="adversarial"))
    next(e for e in events if e["stage"] == "select" and e["phase"] == "end")["reviewers"] = 3
if case in ("select-missing-count", "select-string-count"):
    selected = next(e for e in events if e["stage"] == "select" and e["phase"] == "end")
    if case == "select-missing-count": selected.pop("reviewers")
    else: selected["reviewers"] = "2"
    next(e for e in events if e["stage"] == "dispatch" and e["phase"] == "end")["reviewers"] = 2
if case in ("security-timeout", "security-bound", "security-silent", "security-fast-pass",
            "security-unrelated-peer", "security-prose-spoof", "learnings-omission", "learnings-unlisted",
            "learnings-missing-file", "learnings-empty-file", "learnings-wrong-file", "learnings-unreported",
            "agent-native-prose", "agent-native-reviewer-prose", "agent-native-unlisted",
            "agent-native-missing-file", "agent-native-empty-file", "agent-native-alias-file",
            "agent-native-outside-file", "agent-native-unreported", "deployment-prose",
            "agent-native-alias-return", "agent-native-alias-all", "learnings-catalog",
            "learnings-alias-return", "learnings-alias-all", "learnings-cross-pair",
            "agent-native-alias-outside", "learnings-alias-empty", "learnings-alias-unreported"):
    other = ("learnings-researcher" if case.startswith("learnings-")
             else "agent-native-reviewer" if case == "agent-native-reviewer-prose"
             else "agent-native" if case.startswith("agent-native-")
             else "deployment-verification-agent" if case == "deployment-prose" else "security")
    alias_shapes = {
        "agent-native-alias-return": ("agent-native", "agent-native-reviewer", "agent-native", "agent-native"),
        "agent-native-alias-all": ("agent-native", "agent-native-reviewer", "agent-native-reviewer", "agent-native-reviewer"),
        "agent-native-alias-outside": ("agent-native", "agent-native-reviewer", "agent-native-reviewer", "agent-native-reviewer"),
        "learnings-catalog": ("learnings", "learnings", "learnings", "learnings"),
        "learnings-alias-return": ("learnings", "learnings-researcher", "learnings", "learnings"),
        "learnings-alias-all": ("learnings", "learnings-researcher", "learnings-researcher", "learnings-researcher"),
        "learnings-alias-empty": ("learnings", "learnings-researcher", "learnings-researcher", "learnings-researcher"),
        "learnings-alias-unreported": ("learnings", "learnings-researcher", "learnings-researcher", "learnings-researcher"),
        "learnings-cross-pair": ("learnings", "agent-native", "agent-native", "learnings"),
    }
    selected_name, returned_name, prose_name, reported_name = alias_shapes.get(case, (other, other, other, other))
    if case == "agent-native-alias-file": prose_name = "agent-native-reviewer"
    report["reviewers"] = ["correctness", reported_name]
    finish["roster"]["selected"] = [dict(reviewer="correctness"), dict(reviewer=selected_name)]
    returns = [dict(reviewer="correctness", findings=[])]
    if case == "security-timeout": finish["collection"]["failed_reviewers"] = [dict(reviewer="security", reason="timeout")]
    if case == "security-bound": finish["collection"]["bound_exceeded"] = ["security"]
    if case == "security-fast-pass": finish["collection"]["fast_pass"] = dict(candidates=[dict(reviewer="security")])
    if case == "security-unrelated-peer": finish["peer"] = dict(outcome="folded", artifact=str(r / "adversarial-codex.json"))
    if case not in ("learnings-unlisted", "agent-native-unlisted", "security-timeout", "security-bound", "security-silent", "security-fast-pass", "security-unrelated-peer"):
        prose_path = r.parent / "outside-prose" / f"{prose_name}.md" if case in ("agent-native-outside-file", "agent-native-alias-outside") else r / ("raw-returns.json" if case == "learnings-wrong-file" else f"{prose_name}.md")
        finish["collection"]["unstructured_returns"] = [dict(reviewer=returned_name, path=str(prose_path))]
        if case not in ("learnings-missing-file", "learnings-wrong-file", "agent-native-missing-file"):
            prose_path.parent.mkdir(parents=True, exist_ok=True)
            prose_path.write_text("" if case in ("learnings-empty-file", "learnings-alias-empty", "agent-native-empty-file") else "Completed prose review.\n")
    if case in ("learnings-unreported", "learnings-alias-unreported", "agent-native-unreported"):
        report["reviewers"] = ["correctness"]
    if case == "agent-native-unlisted":
        (r / "agent-native.md").write_text("Completed prose review.\n")
if case in ("folded-adversarial-bare", "folded-adversarial-alias", "folded-adversarial-provider",
            "folded-peer-unfolded", "folded-peer-wrong-provider", "folded-peer-missing-artifact",
            "folded-peer-unreported", "folded-peer-outside", "folded-peer-internal-link",
            "folded-peer-external-link", "roster-peer-above", "folded-peer-lens-reported",
            "folded-peer-lens-alias", "folded-peer-lens-offroster",
            "folded-peer-lens-crossname", "folded-peer-lens-invalid-artifact"):
    other = "adversarial-reviewer" if case in ("folded-adversarial-alias", "folded-peer-lens-alias") else "adversarial-codex" if case in ("folded-adversarial-provider", "folded-peer-wrong-provider") else "adversarial"
    report["reviewers"] = ["correctness", "adversarial-codex"]
    finish["roster"]["selected"] = [dict(reviewer="correctness"), dict(reviewer=other)]
    returns = [dict(reviewer="correctness", findings=[])]
    peer_path = r.parent / "outside-peer" / "adversarial-codex.json" if case in ("folded-peer-outside", "folded-peer-lens-invalid-artifact") else r / ("linked-peer.json" if case == "folded-peer-internal-link" else "adversarial-claude.json" if case == "folded-peer-wrong-provider" else "missing-peer.json" if case == "folded-peer-missing-artifact" else "adversarial-codex.json")
    finish["peer"] = dict(outcome="not-run" if case == "folded-peer-unfolded" else "folded", artifact=str(peer_path))
    if case.startswith("folded-peer-lens-"):
        finish["peer"]["selected"] = True
        report["peer"] = dict(outcome="folded")
        report["reviewers"] = ["correctness", "adversarial-reviewer" if case == "folded-peer-lens-crossname" else other]
    if case == "folded-peer-lens-offroster":
        finish["roster"]["selected"] = [dict(reviewer="correctness")]
        next(e for e in events if e["stage"] == "select" and e["phase"] == "end")["reviewers"] = 1
    if case == "folded-peer-wrong-provider": (r / "adversarial-claude.json").write_text(json.dumps(dict(reviewer="adversarial-claude", findings=[])))
    if case == "folded-peer-unreported": report["reviewers"] = ["correctness"]
    if case == "roster-peer-above":
        next(e for e in events if e["stage"] == "select" and e["phase"] == "end")["reviewers"] = 1
    if case in ("folded-peer-outside", "folded-peer-lens-invalid-artifact"):
        peer_path.parent.mkdir(parents=True, exist_ok=True)
        peer_path.write_text(json.dumps(dict(reviewer="adversarial-codex", findings=[])))
if case == "selected-blank": finish["roster"]["selected"].append(dict(reviewer=""))
if case == "selected-empty": finish["roster"]["selected"] = []
if case == "missing-failed-list": finish["collection"].pop("failed_reviewers")
if case == "null-failed-list": finish["collection"]["failed_reviewers"] = None
if case == "string-failed-list": finish["collection"]["failed_reviewers"] = ""
if case == "missing-bound-list": finish["collection"].pop("bound_exceeded")
if case == "null-bound-list": finish["collection"]["bound_exceeded"] = None
if case == "string-bound-list": finish["collection"]["bound_exceeded"] = ""
if case in ("no-returns", "orphan-dispatch-no-returns"): returns = []
if case == "unselected-return": returns = [dict(reviewer="fast-pass", findings=[])]
if case == "unreported-return": report["reviewers"] = ["another-reviewer"]
if case == "structured-second-unreported": report["reviewers"] = ["correctness"]
if case.startswith("peer-offroster-"):
    next(e for e in events if e["stage"] == "select" and e["phase"] == "end")["reviewers"] = 2 if case == "peer-offroster-local" else 1
    finish["peer"] = dict(selected=True, outcome="folded" if "folded" in case else "not-run",
                          artifact=str(r / ("missing-peer.json" if case == "peer-offroster-folded-missing" else "adversarial-codex.json")))
    finish["roster"]["selected"] = [dict(reviewer="correctness")]
    returns = [dict(reviewer="correctness", findings=[])]
    report["reviewers"] = ["correctness", "adversarial-codex"]
    if case == "peer-offroster-folded-unreported": report["reviewers"] = ["correctness"]
    if case == "peer-offroster-local":
        finish["roster"]["selected"].append(dict(reviewer="adversarial"))
        returns.append(dict(reviewer="adversarial", findings=[]))
        report["reviewers"] = ["correctness", "adversarial"]
    if case == "peer-offroster-unselected": finish["peer"]["selected"] = False
    if case == "peer-offroster-failed": finish["peer"]["outcome"] = "failed"
    if case == "peer-offroster-no-output":
        finish["peer"]["outcome"] = "no-usable-output"
        finish["peer"].update(route="codex", target="codex",
            coverage="cross-model pass: peer ran, no usable output (codex route; the account does not offer the model). The adversarial lens is not covered.")
if case == "failed-returns": finish["collection"]["failed_reviewers"] = [dict(reviewer=name, reason="failed") for name in ("correctness", "adversarial")]
if case == "bounded-returns": finish["collection"]["bound_exceeded"] = ["correctness", "adversarial"]
if case == "missing-collection": finish.pop("collection")
if case == "wrong-finish-run": finish["run_id"] = "another-run"
if case == "wrong-finish-head": finish["scope"]["head_sha"] = "0" * 40
(r / "metadata.json").write_text(json.dumps(metadata))
(r / "stages.jsonl").write_text("".join(json.dumps(e) + "\n" for e in events))
(r / "finish-input.json").write_text(json.dumps(finish))
(r / "raw-returns.json").write_text(json.dumps(returns))
(r / "adversarial-codex.json").write_text(json.dumps(dict(reviewer="adversarial-codex", independence_verified=case != "orphan-unverified-peer", findings=[])))
if case == "folded-peer-internal-link":
    (r / "linked-peer.json").symlink_to(r / "adversarial-codex.json")
if case == "folded-peer-external-link":
    external = r.parent / "outside-peer" / "external-adversarial-codex.json"
    external.parent.mkdir(parents=True, exist_ok=True)
    external.write_text((r / "adversarial-codex.json").read_text())
    (r / "adversarial-codex.json").unlink()
    (r / "adversarial-codex.json").symlink_to(external)
if case in ("focused", "orphan-review", "orphan-review-zero", "orphan-review-empty-ts", "orphan-review-no-artifact"):
    (r / "adversarial.json").write_text(json.dumps(dict(reviewer="adversarial", independence_verified=False, findings=[])))
if case == "focused-no-file": (r / "adversarial-codex.json").unlink()
if case == "focused-wrong-reviewer":
    (r / "adversarial-codex.json").write_text(json.dumps(dict(reviewer="another-reviewer", findings=[])))
if case == "focused-no-findings":
    (r / "adversarial-codex.json").write_text(json.dumps(dict(reviewer="adversarial-codex")))
if case in ("orphan-claude-peer", "orphan-peer-mismatch"):
    (r / "adversarial-claude.json").write_text(json.dumps(dict(reviewer="adversarial-codex" if case == "orphan-peer-mismatch" else "adversarial-claude", independence_verified=False, findings=[])))
if case == "orphan-peer-no-artifact":
    (r / "adversarial-codex.json").unlink()
    # A completed local fallback cannot attest that the end-only provider peer ran.
    (r / "adversarial.json").write_text(json.dumps(dict(reviewer="adversarial", findings=[])))
validator_input = dict(selected_count=1 if case == "empty-selected" else 0)
if case != "empty-no-list": validator_input["selected_findings"] = [dict(status="selected")] if case == "empty-list-labeled" else []
if case == "empty-selected-labeled": validator_input["selected"] = [dict(status="selected")]
if case == "empty-selected-empty": validator_input["selected"] = []
if case == "empty-selected-labeled": validator_input.pop("selected_findings")
(r / "validator-input.json").write_text(json.dumps(validator_input))
if case == "empty-no-input": (r / "validator-input.json").unlink()
if case == "empty-no-count": (r / "validator-input.json").write_text(json.dumps(dict(selected_findings=[])))
if case == "empty-skill-shape": (r / "validator-input.json").write_text(json.dumps(dict(scope="full", selected=[], skip_basis="none", skip_count=0)))
if case == "empty-findings-only": (r / "validator-input.json").write_text(json.dumps(dict(findings=[])))
if case == "empty-count-null-zero": (r / "validator-input.json").write_text(json.dumps(dict(selected_count=0, selected=[], findings=[], selected_numbers=[])))
if case == "empty-count-two": (r / "validator-input.json").write_text(json.dumps(dict(selected_count=2, selected=[])))
if case == "empty-findings-filled": (r / "validator-input.json").write_text(json.dumps(dict(findings=[dict(title="x")])))
if case == "empty-numbers-filled": (r / "validator-input.json").write_text(json.dumps(dict(selected_numbers=[1])))
if case == "empty-selected-string": (r / "validator-input.json").write_text(json.dumps(dict(selected="none")))
if case == "empty-input-array": (r / "validator-input.json").write_text("[]")
if case == "empty-input-unreadable": (r / "validator-input.json").write_text("{broken")
verdict_path = r.parent / "outside-verdicts.json" if case == "verdicts-outside" else r / "validator-verdicts.json"
outcome = "infrastructure-failure" if case == "validator-infra-failure" else "verdicts" if case.startswith("verdicts-") else "empty-batch"
(r / "validator-outcome.json").write_text(json.dumps(dict(
    outcome=outcome, reason="validator launch failed" if case == "validator-infra-failure" else None,
    verdicts=None if case == "verdicts-null-path" else str(verdict_path) if outcome == "verdicts" else None)))
if outcome == "verdicts" and case not in ("verdicts-missing-file", "verdicts-null-path"):
    verdict_path.write_text("{broken" if case == "verdicts-unparseable" else json.dumps(dict(
        verdicts=[] if case == "verdicts-empty" else "bad" if case == "verdicts-wrong-type" else [dict(status="confirmed")])))
if case == "missing-finish": (r / "finish-input.json").unlink()
if case == "missing-returns": (r / "raw-returns.json").unlink()
if case == "malformed-returns": (r / "raw-returns.json").write_text("{broken\n")
if case == "missing-validator": (r / "validator-outcome.json").unlink()
if case == "malformed-log": (r / "stages.jsonl").write_text("{broken\n")
(r / "review.json").write_text(json.dumps(report))
if case == "artifact-mismatch": (r / "review.json").write_text(json.dumps(dict(report, run_id="another-run")))
if case == "printed-count-mismatch":
    (r / "review.json").write_text(json.dumps(dict(
        report, actionable_findings=[*report.get("actionable_findings", []),
                                     dict(title="extra finding", severity="P2", file="src/plain.ts", line=1)])))
if case == "printed-title-mismatch":
    renamed = [dict(f, title="renamed finding") if isinstance(f, dict) else f
               for f in report.get("actionable_findings", [])]
    (r / "review.json").write_text(json.dumps(dict(report, actionable_findings=renamed)))
if os.environ.get("REVIEW_FIXTURE_TWO_RUNS"):
    # Two complete runs in one call: the finder must stage the newer one. The printed
    # copy is the older run's report, so a print-matching implementation would pick wrong.
    run2 = skill_run_dir()
    r2 = Path(run2)
    second = json.loads(json.dumps(report))
    second.update(run_id=os.path.basename(run2), artifact_path=run2)
    second["actionable_findings"] = [dict(title="second-run-marker", severity="P2", file="src/plain.ts", line=1)]
    (r2 / "review.json").write_text(json.dumps(second))
    (r2 / "metadata.json").write_text(json.dumps(dict(metadata, run_id=second["run_id"])))
    (r2 / "stages.jsonl").write_text((r / "stages.jsonl").read_text())
    fin2 = json.loads((r / "finish-input.json").read_text())
    fin2["run_id"] = second["run_id"]
    fin2["collection"]["returns"] = str(r2 / "raw-returns.json")
    (r2 / "finish-input.json").write_text(json.dumps(fin2))
    (r2 / "raw-returns.json").write_text((r / "raw-returns.json").read_text())
    (r2 / "adversarial-codex.json").write_text((r / "adversarial-codex.json").read_text())
    (r2 / "validator-input.json").write_text((r / "validator-input.json").read_text())
    (r2 / "validator-outcome.json").write_text((r / "validator-outcome.json").read_text())
    if (r / "validator-verdicts.json").exists():
        (r2 / "validator-verdicts.json").write_text((r / "validator-verdicts.json").read_text())
    first = json.loads(json.dumps(report))
    first["actionable_findings"] = [dict(title="first-run-marker", severity="P2", file="src/plain.ts", line=1)]
    (r / "review.json").write_text(json.dumps(first))
    # Set both folders' times explicitly, so "newer" never depends on how long this fixture or the
    # call took (U218: a time taken "now minus 4 s" at the end can pass the second folder's last
    # write under a stalled host, and the finder then stages the older run). The first run is
    # 10 s behind; the second is stamped now, after the call's start marker, so the finder (-nt)
    # always sees it as this call's and as the newest.
    import time
    now = time.time()
    for p in [r, *r.rglob("*")]:
        os.utime(p, (now - 10, now - 10))
    for p in [r2, *r2.rglob("*")]:
        os.utime(p, (now, now))
    print(json.dumps(first))
elif case == "escaped-entities":
    # The session retypes the report and escapes < > &: the printed copy differs
    # from review.json only by HTML entities, so the receipt still follows.
    print(json.dumps(report).replace("&", "&amp;").replace(">", "&gt;").replace("<", "&lt;"))
elif case == "rewritten-print":
    # The printed copy rewords intent, shortens evidence and drops notes: the receipt
    # still follows because the proof reads review.json, not the printed text.
    print(json.dumps(dict(report, intent="check the thing",
                           coverage={"depth": report["coverage"]["depth"]},
                           evidence=[{"file": "bin/review/review-unit.sh", "lines": "1-10"}])))
elif case == "print-garbage":
    # No parseable print at all, but the run folder is complete: the receipt follows.
    print("still reviewing, nothing yet")
else:
    print(json.dumps(report))
FIXTURE
chmod +x "$TMP/review-fixture"
export REVIEW_FIXTURES="$TMP/scratch/ce-code-review" REVIEW_UNIT_SCRATCH_ROOT="$TMP/scratch"
mkdir -p "$REVIEW_FIXTURES"
export CODEX_LOG="$TMP/codex-log"
# No muse model catalog by default (exact ids pass through); the alias case below sets one.
# A healthy plugin install on disk (what the probe checks), and the log of probe calls.
PLUG_HEALTHY="$TMP/plug/ok"; mkdir -p "$PLUG_HEALTHY/skills/ce-code-review"; : > "$PLUG_HEALTHY/skills/ce-code-review/SKILL.md"
export PLUG_HEALTHY CLAUDE_PLUGIN_LOG="$TMP/plugin-log"
unset CLAUDE_CONFIG_DIR   # the HOME-based assertions below must not depend on the caller's profile
export PATH="$TMP:$PATH" CLAUDE_LOG="$TMP/log" MUSE_LOG="$TMP/muse-log" ORCA_TERMINAL_HANDLE="term_builder" MUSE_MODEL_CATALOG_DIR="$TMP/no-catalog"

# U198: every account read below goes through the dev-studio home, so point HOME at a fixture
# home whose bin/ds delegates to the real one under a state root and otherwise prints the
# canned FAKE_ACCOUNTS list (both agents enabled: the old empty-list-means-usable behavior).
# This keeps the suite hermetic whatever the host's live accounts are.
FH="$TMP/fakehome"; mkdir -p "$FH/.dev-studio/bin"
printf '[user]\n\temail = t@t\n\tname = t\n' > "$FH/.gitconfig"
REAL_DS="$ROOT/bin/ds"; export REAL_DS
cat > "$FH/.dev-studio/bin/ds" <<'DSTUB'
#!/usr/bin/env bash
# Test double for the dev-studio home's bin/ds: under a state root it behaves like the real
# one (so account mutations show); otherwise (no state root, or the review wrapper's own) it prints
# the canned FAKE_ACCOUNTS list.
if [ -n "${DS_STATE_ROOT:-}" ] && [ "$DS_STATE_ROOT" != "$RU_STATE" ]; then exec "$REAL_DS" "$@"; fi
if [ "${1:-} ${2:-}" = "account list" ]; then printf '%s\n' "${FAKE_ACCOUNTS-[]}"; exit 0; fi
echo "fake ds: unsupported $*" >&2; exit 1
DSTUB
chmod +x "$FH/.dev-studio/bin/ds"
export HOME="$FH" FAKE_ACCOUNTS='[{"agent":"codex","account":"cx1","state":"enabled"},{"agent":"claude","account":"cl1","state":"enabled"}]'

# Every run happens in a fixture repo, so the receipt lands in its .git, never the real one.
git init -q -b main "$TMP/repo"
git -C "$TMP/repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$TMP/repo" update-ref refs/remotes/origin/main HEAD
RFILE="$TMP/repo/.git/ds-review"
# U171: each helper clears ds-review-last-run so sequential same-HEAD cases stay
# isolated (a saved proof-failure run is only reused by the U171 cases below, which
# call the script directly without this clearing). U175: they also clear
# ds-review-stop, so one case's proof failures never stop the next case's review
# (the U175 cases below call the script directly and keep the count between calls).
clear_last_run() { rm -f "$(git rev-parse --git-dir 2>/dev/null)/ds-review-last-run" "$(git rev-parse --git-dir 2>/dev/null)/ds-review-stop" 2>/dev/null || true; }
run_ru() { (cd "$TMP/repo" && clear_last_run && "$RU" "$@"); }
head_sha() { git -C "$TMP/repo" rev-parse HEAD; }

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3" >&2; fi; }
has() { if grep -qF -- "$3" <<<"$2"; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 — missing [$3] in [$2]" >&2; fi; }
lacks() { if grep -qF -- "$3" <<<"$2"; then fail=$((fail+1)); echo "FAIL: $1 — unexpected [$3] in [$2]" >&2; else pass=$((pass+1)); fi; }
args() { grep '^args:' "$CLAUDE_LOG" | tail -1; }

# Rows the Muse limit and preflight cases share.
CE_ROW="$(printf 'ce-code-review\tuser\ton\tdesc\tpath')"
OTHER_ROW="$(printf 'composio-cli\tuser\ton\tdesc\tpath')"
LIMIT_MSG="You've hit your weekly limit · resets Oct 31, 8pm (Europe/Berlin)"
