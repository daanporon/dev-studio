# Per-role model mapping

Each squad role runs on a fitting managed Orca account/model (KTD7), with an
optional per-role reasoning **effort** (`low|medium|high|xhigh|max`; blank = the
model's default). List the accounts available on this host with
`~/.dev-studio/bin/role/orch.sh account-list` (`<agent>\t<account_id>\t<label>`, the first line per agent is its default login).

| Role | Agent | Model | Fallbacks | Why |
|---|---|---|---|---|
| Lead | claude | sonnet | — | Coordinates: reads the plan, fans out/parallelizes Builders, follows up. A cheaper *supervision* tier than the work (cf. firstmate's supervision branch) — enough judgment to orchestrate reliably, not opus |
| Thinker | claude | opus | — | Standing desk: scores each topic, plans easy ones, inbox and test triage (`conventions/thinker-routing.md`) |
| Thinker-deep | claude | fable | — | **Never a terminal** (`elevate`): the model the Thinker passes to `ce-plan` for one hard planning step. Its effort column is ignored |
| Builder | claude | opus | claude:sonnet, muse:muse-spark-1.3 | Implementation (`ce-work`). **On-demand** — the Lead spawns one per unit from the Thinker's plan, never at squad creation |
| Builder-standard | claude | sonnet | claude:opus | **Never started by name**: the model a Builder gets when the Thinker tiered its unit `standard` (`conventions/plan-shape.md` step d), in the `ce-pipeline` ship mode only. Hard, untagged and other-mode units use the Builder row |
| Builder-review | claude | opus | muse:muse-spark-1.3 | **Never a terminal** (`elevate`): `bin/review/review-unit.sh` runs a hard unit's full `ce-code-review` on it (every delta review and every other unit uses the `builder-review-standard` row, Sonnet medium; a unit with no tier counts as `standard`), whatever model built the unit — the safety net that makes a Sonnet build safe. If Claude is limited and the `roles.conf` row has a `muse:` fallback, the review runs on that Muse model instead, and the `ds-review` receipt records the engine (`claude:opus` / `muse:<model>`) |
| Reviewer | claude | fable | claude:opus | Diff review (`ce-code-review`) |
| Tester | claude | opus | — | Drives the devenv, files fix PRs |
| Researcher | claude | fable | — | Investigation, returns a report, no code |

This table is the human-readable rationale. The **machine-read source** is
`conventions/roles.conf` (one `name agent model spawn [effort] [fallbacks]` line per
role), which the loop's picker `bin/ds pick` reads for every start (`bin/commands/spawn-squad.sh`
and `bin/commands/add-role.sh` only write the wish) — nothing is hardcoded in the scripts (R22, U12).

**Accounts and fallbacks.** Every start picks its account: the role's own model on each
account of its agent with room, soonest reset first (fill-first, KTD2; usage from `state/accounts.tsv`,
which the loop writes); an account whose session % plus the load just placed on it reaches
`pick_room_pct` (95), at weekly ≥ `pick_weekly_max` (95) on a Claude or Muse account, disabled,
or with a `limited_until` still ahead is skipped. Unknown usage is eligible unless a known account limit
has not reset. The loop keeps such limits across worker switches, including Muse’s terminal
notice when its usage API returns no data. The picker tries each fallback in the 6th column in
the written order, without grouping by agent. Pick floors count rungs in that same order.
Only an idle Thinker automatically returns to a higher rung when it has room, at most once
per `fallback_return_min` minutes (0 disables returns). A Builder, Lead, Tester or Reviewer
stays on its model until a restart, a long stall or a phase change; this includes a member
whose model is no longer on its row's ladder. With no eligible account on any allowed model, the loop waits for the earliest
account to become usable after all of that account’s blocking windows reset. The member records the `account` it got and `fallback`
when it is not on its row's own model. Nothing free: the wish stays and the loop keeps
the start pending (`no account free`, or `no room until HH:MM`) and tries it again; the board shows
the unit as waiting for an account. A
per-project override without the 6th column has no model fallbacks (`roles.sh list` shows it).
The `builder` row falls back last to Spark (`muse:muse-spark-1.3`, Orca's native `--agent muse`):
launching it is proven, resuming it is not — a restarted Muse worker starts fresh from the squad state.
Claude accounts are every Claude profile Orca manages on the host plus the host's own login
(`system`); a member on a non-default managed account runs with that account's config dir, while `system` runs with
no config dir (`env -u CLAUDE_CONFIG_DIR`; its login lives in `~/.claude.json`), and a restart
keeps its account (and its model, when it was on a fallback) unless it is pinned with
`bin/ds want member <id> --model <m> --account <a>` (`restart-role.sh` no longer takes those flags, U153).

To change models per project, use `bin/commands/roles.sh` / `/ds-roles` — it writes a
**per-project override**: the project's `roles.conf` rows in `state/loop.db` (beat this
default, survive `git reset --hard`; `docs/settings.md`). Edit `conventions/roles.conf` directly only
to change the shared default for every project; keep this table in step.

## Codex roles

Codex is supported by the loop for every terminal role, including standing Leads
and Thinkers, and as the headless `builder-review` engine. Select an entry labelled
**Codex** in Roles, or configure it with `bin/commands/roles.sh`. The picker includes visible
models and their supported efforts from `codex debug models --bundled`, with
`conventions/models.conf` as the fallback for older or missing CLIs. The loop snapshots
that catalog every five minutes for the board; a project `models.conf` replaces the
static choices, and the CLI's Codex choices merge into it. Hidden models are excluded;
an exact custom deployment id remains usable through the custom picker.

The catalog is a set of choices, not an access check. Codex uses the host's own
configuration and credentials, including an Azure provider in `~/.codex/config.toml`.
Selecting a model does not change the provider or make an unavailable deployment
accessible. Today, an Azure account with only `gpt-6.1-sol` should select that model.
Codex has one host login, recorded as `codex/default`; Muse's `default` is a separate
login. Codex usage percentages remain unknown until the backend can report them.
The loop recognises Codex's terminal usage-limit and HTTP 429 messages and follows
the role's account/model fallback ladder. Other launch or provider-access errors
surface as failures, rather than automatically trying every fallback.

For example (replace `my-project` with the project label):

```sh
bin/commands/roles.sh set my-project builder codex gpt-6.1-sol ondemand high muse:muse-spark:max
bin/commands/roles.sh set my-project builder-review codex gpt-6.1-sol elevate high muse:muse-spark:max
bin/host/install-skills.sh --codex-only
bin/host/install-skills.sh --codex-only --check
```

The Codex installer links the installed Compound Engineering plugin's skills and
the live `ds` wrapper into `~/.agents/skills`, preserving operator-owned skill
folders. It prefers the Codex plugin cache and can reuse the Claude plugin cache;
install one of those plugins first. `CODEX_SKILLS_DIR` and `CODEX_CE_SKILLS_DIR`
override those paths. `/ds-update` refreshes the links when Codex is installed.

Every loop restart starts a fresh session from the role brief and journal. Operator
answers and inbox wakes use the same backend terminal delivery as other agents.
Codex relies on Orca's native idle wake; the `.claude/settings.local.json` Stop-hook
fallback is specific to Claude. Confirm idle message delivery on your Orca host
before assigning Codex a standing Lead, Thinker, or Studio role.
Headless Codex reviews use the same automation permissions as the existing Claude
and Muse reviewers and their final-message file for the report. The existing receipt checks still require a completed report
for the reviewed HEAD, with no changes to the worktree.
