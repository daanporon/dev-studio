#!/usr/bin/env bash
# accounts-refresh.sh [--limited <file>] [--max-age <s>] — rewrite state/accounts.tsv (the picker's and the board's view
# of every account), from the backend's `account-list` + `account-usage` + `limited`.
#   agent  account  session_pct  session_reset  weekly_pct  weekly_reset  limited_until  updated  label  note  skills  plan  resets
#   `note` = why usage is unknown (`expired` = the login's token ran out; it refreshes the next time Claude
#   runs on that account; `refused` = the usage endpoint said 401 on a token that has not expired, and
#   `refused@<epoch>` / `stale@<epoch>` = the same with the last good figures kept, good as of <epoch>).
#   Empty `-` when there is nothing to say.
#   `skills` = can the account load the role skills (account-skills U3): `ok`, `broken: <reason>` or
#   `warn: <reason>`, from accountSkillsCheck (bin/lib/account-skills.ts), tsv (reads each account's config dir, no
#   `claude` call); `-` for a non-claude row or an account the check did not report. The picker reads
#   columns 1-7 and the plan; the loop's alerts reconciler (bin/loop/reconcilers/account-skills.ts) reads this one.
#   `plan` = the account's plan (U123: Max, Ultra, or the raw tier name), from accountPlan (bin/lib/account-skills.ts)
#   (one reader per agent; only Claude has one); `-` when unknown. The board shows it beside the account.
#   `resets` = the account's free limit resets (account-free-resets U3): the compact JSON the backend's
#   `account-resets` prints (state reported|not_reported|unknown, count, grants); `-` when the call failed or the
#   file is from before this column (the board then reads `unknown`).
# tab-separated, `-` = unknown, times as epoch seconds. The sweep runs it in the background.
# --limited <file>: the `limited` rows the caller already has (one backend screen read per sweep).
# --max-age <s>: do nothing while accounts.tsv is younger than <s> seconds (the loop's staleness guard).
# One refresh at a time, whoever starts it (the sweep, the loop): a second one exits 0 while the
# lock dir .accounts-refresh.lock is held; a lock older than 10 min is a dead run's and is taken over.
#
# limited_until is set ONCE per limit episode — keyed on worktree + notice text — on the account
# recorded on the limited worker's member: the backend's reset epoch, else first-seen + 1h. A notice
# that stays on screen never extends it. Kept until it passes. Episodes live in .accounts.episodes
# next to the tsv and are dropped once their notice is gone and their time has passed.
# A notice opens NO account episode when it isn't a real limit on a known account:
#   - the member has no recorded `account` (or isn't found): which account hit it is unknown, and
#     guessing the agent's default login blocked a healthy one. Usage still protects those accounts:
#     `ds pick` blocks at session/weekly >= 95 regardless;
#   - a pool-level 429 (`Request rejected (429)`, `All credentials … cooling down`): not the account's limit;
#   - a reset/continuing notice (`Usage limit reset`, `Continuing automatically`): the limit has ended.
# Those still get a timing-only episode (account `-`) that blocks nothing: the sweep reads its `until`
# to expire a dialog whose notice carries no reset time.
set -euo pipefail
# U274: the work runs in TypeScript (bin/commands/accounts-refresh-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" accounts-refresh-ts "$@"
