#!/usr/bin/env bash
# review-unit.sh — run a Builder's code review on the review model, not the Builder's own.
#
#   review-unit.sh <project> [<base-ref>] [--full "<reason>"] [--retry "<reason>"]
#
# ce-code-review runs its correctness/security/adversarial reviewers on the session model, so
# a Sonnet Builder reviewing inline would get a Sonnet review. This starts a separate headless
# Claude or Codex on the review roster row in the current directory — the Builder's
# worktree — running ce-code-review report-only (`mode:agent`), and prints its JSON
# verdict; the Builder applies `actionable_findings` itself. Only a full review of a
# hard unit runs on `builder-review` (opus when the row is missing); every delta review
# and every other unit runs on the cheaper `builder-review-standard` row (standard when
# that row is missing, `builder-review` for all when it has none).
#
# It runs in the Builder's worktree, so it is isolated from the Builder's own wiring:
# `--setting-sources user,project` skips .claude/settings.local.json (the rewake Stop hook),
# ORCA_TERMINAL_HANDLE is unset (it can't post as the Builder), and a preamble overrides the
# squad role brief in CLAUDE.local.md. stdin is closed so neither headless call waits on it.
#
# On a clean worktree a successful run leaves a receipt at `$(git rev-parse --git-dir)/ds-review`
# (per worktree, never committed):
# `<reviewed-head-sha>\t<epoch>\t<base-ref or ->\t<actionable count>\t<engine:model>\tproof=1`.
# Engine is `claude:<model>`, `codex:<model>` or `muse:<model>` for the engine that completed the review.
# A re-review is always a `delta` (only what changed since the previous receipt, with only
# the reviewers that change needs) when that receipt is usable — whatever its size — a
# `delta-wide` (the same scope, but the reviewers a full review would select) when it is
# over review_delta_wide_lines, `carried` (no review runs, the receipt is re-stamped for
# the new HEAD) when a rebase moved only the base, else `full`;
# stderr says which ran (`full`, `delta (<reviewers>)`, `delta-wide` or `carried`), the
# receipt format is the same either way. finish-unit.sh refuses in ce-pipeline mode unless that sha is an
# ancestor of HEAD and the receipt carries proof=1. Legacy receipts cannot finish, delta or carry.
# Beside it, `$(git rev-parse --git-dir)/ds-review-base` adds a clean-tree flag before proof=1
# and keeps the last sha whose review passed artifact proof, whether or not a receipt followed
# (dirty tree, moved HEAD). A failed proof never advances it.
# `ds-review` keeps its meaning (a clean, reported HEAD) for finish-unit.sh.
# A delta still turns full when it touches review_risk_paths.
# When the base moved since the last review, a delta after any number of main merges —
# clean or hand-resolved — reviews only the unit's own change and its conflict
# resolutions (the diff from the expected merge of the reviewed commit with the new
# fork point to HEAD), except when the base absorbed unit content (cherry-picked or
# squashed in) or the expected merge cannot be built: then the review reads the
# plain delta, and that plain delta's lines and files — not only the unit's own —
# decide wide vs narrow and risk paths, while the prompt names the unit's own files
# as the scope to review;
# `--full "<reason>"` forces a depth:full review. `--retry "<reason>"` allows one more run
# after reviews stopped (below) and logs the reason. review_skip_lenses drops lenses (never
# correctness). Every run whose kind was decided appends one line to `ds-review-log`:
# `<epoch>\t<head sha>\t<full|delta|delta-wide|carried>\t<reason>\t<lenses or ->\t<engine:model>`.
# Every exit-4 run (reviewed but no receipt) appends one line to
# `state/<project>/review-proof-errors.log`: `<epoch>\t<project>\t<engine>\t<proof error>`.
# An exit-4 run with a finished review (a complete report in its run folder) also
# records `<git-dir>/ds-review-last-run` (`head-sha<TAB>base<TAB>kind<TAB>run-dir<TAB>engine<TAB>delta-base`):
# (plus the hash of the script that ran the check) the next call on the same clean HEAD
# re-runs only the proof check on that folder, with no new skill run, when the script's
# hash changed since; with the same script a new review runs at its normal depth. A passing re-check stamps the receipt and logs `reused <run_id>`.
# A reviewer that answers without running the skill leaves no run folder at all
# since the call started (a broken skill run still leaves one). That gets one
# stricter retry on the same engine before anything counts; only when the rerun
# still leaves no folder does it count, as `reviewer answered without running
# ce-code-review (no run folder for HEAD <sha> since <time>, after one stricter
# retry)`. A reviewer that leaves the skill part-way and writes its own result (a
# new skill folder `<date>-<time>-<8 hex>` whose stages.jsonl never ended, a new
# folder outside that name shape such as `…-delta`, or an older folder's review.json
# changed during the call) gets the same one retry, in a fresh session one model step
# up (builder-review for a run that started on builder-review-standard); when the
# rerun leaves the skill too it counts as `reviewer left ce-code-review at stage
# <stage> and wrote its own result (<folder>), after one retry`. A folder that
# existed before the call is never taken as its run. Any other incomplete run folder
# or one for another HEAD keeps today's error and handling, with no retry.
# `<git-dir>/ds-review-stop` counts proof failures in a row — an exit 4 after the review
# skill ran, other than the Builder's own causes (moved HEAD, uncommitted changes):
# `<count>\t<epoch>\t<script hash>|<skill copy>|<SKILL.md hash>\t<errors>\t<class>`. The
# class is `tooling` (a complete run that fails a proof field; a file without a class) or
# `off-script` (the reviewer left the skill or answered without it, after its retry); a
# failure of the other class starts a fresh count. At 2 `tooling` or 3 `off-script` in a row
# with the same fingerprint (the script plus the skill copy that ran) the
# next call runs nothing and exits 6, and adds one project alert
# (`state/<project>/alerts.json`, id `review-stopped:<branch>`, naming the class). A receipt clears the file
# and resolves the alert; a changed fingerprint (an update-host.sh that changes the script,
# or a new skill copy) lifts the stop by itself, as does `--retry "<reason>"` for one run.
# `<git-dir>/ds-review-start` exists only while a full, delta or delta-wide review's engine runs:
# `<epoch>\t<head sha>\t<kind>\t<pid>`, written just before the engine starts (a carried run, a
# re-check of a saved run and an exit-6 stop write none) and removed on every exit. Only the loop's
# reviews observer reads it, for the board's "reviewing"; no gate does, and a failed write is ignored.
#
# Exit codes — 0 ⇔ a receipt was written; anything else means NO receipt, so read stderr:
#   0  review done, receipt written        2  usage / unsupported review agent
#   3  the ce-code-review skill is missing for this CLAUDE_CONFIG_DIR (broken or absent
#      installPath): no review was started; stderr names the path and the repair command
#   4  the review ran but left no receipt (failed artifact proof, a run folder that
#      is incomplete or for another HEAD, dirty tree, HEAD moved, receipt write failed;
#      a reviewer that answered without running the skill, or left it part-way, gets
#      one retry first, and only counts when the rerun does the same) — fix the
#      cause and run again (stderr says how many failures are left before reviews stop):
#      a finished review is saved and the next call on the same HEAD only re-checks it;
#      a failed proof is never stamped without passing
#   5  no usable review agent on the row (the first agent and every fallback disabled
#      or limited): no review started, nothing ran — fix the accounts and re-run
#   6  reviews stopped after 2 `tooling` proof failures in a row with the same tooling, or
#      3 `off-script` ones (the reviewer left the skill each time): nothing ran —
#      stop and tell the Lead, never retry it yourself (the Lead passes --retry "<reason>"
#      once the cause is fixed or the operator says so)
#   other  the review engine's own failure code
set -euo pipefail

# U228: the work runs in TypeScript (bin/commands/review-unit-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" review-unit-ts "$@"
