# ce-babysit delegates + code review on Muse: live probe of ce-resolve-pr-feedback, ce-debug, ce-commit-push-pr, ce-code-review

Date: 2026-10-29. CE version probed: 3.33.2 (newest in
`~/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/`).
Muse: 1.4.14. Method: scratch HOME only (`HOME=/tmp/musetest-home`, skills in
`/tmp/musetest-home/.config/muse/skills/`, read-only copy of live `auth.json`);
live `~/.muse`, live `~/.config/muse` and live HOME were never given the
skills — after the probes `~/.config/muse/skills` still does not exist.
Fixtures were tiny throwaway repos under `/tmp/u5probe/`; logs there
(`debug.log`, `resolve.log`, `commitpush-desc.log`, `commitpush-full.log`,
`commitpush-full2.log`, `review.log`). Each probe ran
`HOME=/tmp/musetest-home muse exec --yolo --disable-approval --disable-sandbox
--workspace <fixture>` naming the skill explicitly. No real PR was babysat,
resolved, or created (per the plan).

Install note: all four install cleanly with
`muse skills install <CE-cache-folder> --scope user --force`.
`ce-resolve-pr-feedback` emits one warning: its `allowed-tools` frontmatter is
recorded as advisory metadata, not enforced — it grants no tool permissions on
Muse. The other three install with no diagnostics.

## Verdicts (one line per skill, for U2's pass-list)

partial — ce-resolve-pr-feedback
works — ce-debug (mode:pipeline, the babysit delegate route)
partial — ce-commit-push-pr
works — ce-code-review (mode:agent, lite path; explicit verdict for U6 below)

## ce-resolve-pr-feedback — partial

Live: on a scratch repo with no GitHub remote, `mode:pipeline` for the current
branch's PR worked honestly — it ran `gh repo view` / `gh pr view` /
`gh auth status`, saw exit 4 (no `gh` auth under the scratch HOME) and an empty
`git remote -v`, stopped before any fetch per the skill's Platform gate,
performed no mutation, and named exactly what is needed to proceed (GitHub
remote + `gh` auth + an open PR). That is the resolve/report boundary, and it
is sound. The full fetch → judge → fix → reply → resolve loop was **not**
exercised on a real PR (per the plan: no real PR), so it is unproven, not
working.

Gaps:

- `gh` auth lives outside the skill (blocking for the loop, not a Muse tool
  gap): `gh` 2.102.0 is on PATH, but under a scratch HOME `gh` has no
  credentials, so even the fetch cannot reach GitHub. On a real Builder HOME
  this resolves; the skill correctly stops instead of guessing. Bundled
  scripts run fine locally: `scripts/pending-feedback.py --help` (python3)
  and `scripts/get-pr-comments` (bash) both execute; the `gh`-backed scripts
  (`get-pr-comments`, `reply-to-pr-thread`, `resolve-pr-thread`) were not run
  against a live PR.
- Fixer subagent dispatch (unprobed): full mode dispatches generic subagents
  seeded with `references/agents/pr-comment-resolver.md`. Muse exposes
  `muse.subagent_spawn`, which fits the "generic subagent whose whole brief is
  the prompt" shape; the skill also authorises a no-subagent inline fallback
  ("apply the fixes yourself, sequentially … a supported path"), so absence
  of dispatch costs parallelism, not correctness. Neither path was reached —
  there was no feedback to fix.
- Named cross-skill delegate: judgment-bound items invoke `ce-pov` by name
  (evaluation rubric, "Adjudicate before escalating") before becoming
  `needs-human`. `ce-pov` is not installed for Muse (absent from the scratch
  skill dir, present only in the Claude plugin cache). The rubric's own
  fallback covers this: `ce-pov` unavailable → `needs-human`. A U2 install of
  this skill alone therefore escalates judgment-bound items sooner, it does
  not stall.
- Blocking questions: pipeline mode never asks (verified by the unattended
  stop above). Ordinary mode also states "Escalations never block" and
  returns `needs-human`; no AskUserQuestion equivalent is required.

## ce-debug — works in mode:pipeline

Live: on a toy failing fixture (`calc.py`: `add` returned `a - b`;
`test_calc.py` asserts `add(2, 3) == 5`, run as `python3 test_calc.py` —
system `python3` has no `pytest` on this host), `mode:pipeline` reproduced
the failure (AssertionError, exit 1), traced the causal chain to
`calc.py:2`, applied the convergent fix (`a - b` → `a + b`), re-ran the test
green (`ok`, exit 0), committed it locally (`fix: make add return a + b
instead of a - b`), attempted the push, and returned the skill's structured
pipeline return with the exact status spelling `fixed-not-pushed` and a
`needs-human` residual naming the missing remote — it did not falsely report
`fixed-and-pushed`. This is exactly the route `ce-babysit-pr` dispatches on
CI failures.

Gaps: none blocking for pipeline mode.

- Push: `fixed-not-pushed` was caused only by the fixture having no remote,
  which the skill's own status vocabulary defines. On a real Builder branch
  with `origin`, the same run is `fixed-and-pushed`; nothing Muse-specific
  blocked the commit or the test loop (only `git` + `python3` used, no
  bundled scripts, no `gh`).
- Interactive mode unprobed: the Phase 2 fix-choice gate uses "the host's
  blocking question tool … match by capability". Muse interactive sessions
  have `request_user_input`; `muse exec` has `--user-input-auto-resolve`.
  The gate was not exercised — pipeline and return-to-caller modes never ask,
  and those are the delegate routes.
- Post-fix handoff (interactive only) invokes `ce-simplify-code`,
  `ce-code-review`, and `ce-compound` by name. Of those, only
  `ce-simplify-code` is installed for Muse (U1); `ce-code-review` /
  `ce-compound` are not. Pipeline mode explicitly skips these steps, so this
  does not affect the babysit route; do not advertise interactive `ce-debug`
  as fully working.

## ce-commit-push-pr — partial

Live, two probes on a scratch repo (branch `feature`, no remote):

- Description-only worked: asked only to draft a PR description for
  `main..HEAD`, it printed title + body (`feat: change x to 2` / "`x` is now
  `2` instead of `1`.") and made no commit, push, or PR.
- Full `mode:pipeline` (babysit:off) worked up to the publish boundary: with
  an uncommitted change it committed exactly that file locally
  (`3b1fa4e feat: change x to 3`, tree clean afterwards), then push failed
  (`fatal: 'origin' does not appear to be a git repository`), PR state was
  correctly treated as **unknown, not "none"** (`gh pr list` exit 4, no
  `gh` auth under the scratch HOME), `gh pr create` was not attempted, and
  no remote or PR was invented.

So commit mechanics and description composition work on Muse; push and PR
creation are unproven, blocked only by the fixture's missing remote/`gh`
auth — the same external boundary U1 hit, which resolves on a real Builder
HOME. Per the plan (no real PR created), the loop past publish was not
exercised, hence partial rather than works.

Gaps:

- Babysit handoff is the completion gate (blocking past publish): a full or
  pipeline run is "not done until `ce-babysit-pr` owns follow-on", unless
  `babysit:off` / `auto_babysit: false`. `ce-babysit-pr` itself is partial on
  Muse (U1: no headless-wake equivalent for its watch loop; bounded
  `mode:pipeline` ticks are the usable shape). Installing
  `ce-commit-push-pr` without that understanding would let it report success
  at the PR URL, which its own Step 5 forbids.
- `gh` (blocking for publish, external): every probe is argv-form `gh`/`git`
  with exit status as control flow; that translated without a Claude-only
  tool name, but unauthenticated `gh` under a scratch HOME stops publish.
  On a real Builder HOME this resolves.
- Blocking questions: interactive mode asks via the host's blocking question
  tool (Muse: chat / `request_user_input`); `mode:pipeline` suppresses every
  ask with conservative defaults (verified: both pipeline runs above asked
  nothing). No `unavailable-binaries`-style flag was needed or found.
- Stack mode unprobed: it needs the `gh stack` CLI (`references/gh-stack-cli.md`);
  not checked on this host and not part of the babysit delegate route — treat
  as untested, not as working.

## ce-code-review — works in mode:agent (lite path)

**Explicit verdict for U6: `ce-code-review` passed its probe.** U6 may route
review through `muse exec` with this installed skill when its fallback
conditions hold; this report does not ask U6 to keep claude-only behaviour
on the grounds that the Muse probe failed — it did not fail.

Live: on a toy branch diff (`calc.py`: new `average(xs)` returning
`total(xs) / len(xs)`, no empty guard), `mode:agent` reviewed current branch
vs `main` without mutating the tree and returned the structured report the
skill defines: `"status": "complete"`, `"verdict": "Ready with fixes"`, and
one `actionable_findings` entry — `average()` crashes on empty sequence
(P2, `calc.py:5`, confidence 100) with reproduction evidence
(`average([])` raises `ZeroDivisionError`; `average([1, 2, 3])` returns
`2.0`), a suggested fix, and a `testing_gaps` note that no tests cover
`average()`. That is exactly the `actionable_findings` shape `review-unit.sh`
consumes. Bundled scripts run under system `python3`
(`scripts/review-scope.py --help` OK; `findings-mechanics.py` runs).

Gaps: none blocking for the `mode:agent` review route.

- Depth gate took the lite path (unprobed full depth): the skill's own
  Stage 1 gate classified this 1-file, 3-line diff as lite and ran it in
  this context — no persona subagents were dispatched and no cross-model
  peer job was started. That is the skill working as designed on a tiny
  diff, not a Muse failure. The full-depth path (concurrent persona
  dispatch via `muse.subagent_spawn` / `muse.workflow`, the cross-model
  adversarial peer in `references/cross-model-review.md` with its external
  peer route and allowlist, and the merge/validator leaf subagents) was
  **not exercised** — treat full-depth review as untested, not as working,
  and not as failed. U6's `muse exec` route will hit the same depth gate,
  so larger diffs reaching full depth carry that residual risk.
- Blocking questions: none needed — the skill forbids blocking question
  tools outright ("Never use `AskUserQuestion`, `request_user_input`, …")
  and infers intent from git state; the run asked nothing.
- Binaries: only `git` + `python3` on the lite path; no `gh` required for a
  local branch review (a PR-number target would need `gh` PR metadata).
  No `unavailable-binaries`-style flag was needed or found.

## What U2 should install

Install `ce-debug` and `ce-code-review` (the latter also enables U6's
`muse exec` review route; note its full-depth path above is untested).
Install `ce-resolve-pr-feedback` and
`ce-commit-push-pr` only as partial: their local halves (honest stop/report,
judgment scaffolding and bundled scripts; commit + description) work on
Muse, but their GitHub halves (fetch/fix/reply/resolve; push/PR-create) are
unproven until a Builder HOME with a real remote and `gh` auth exercises
them, and `ce-commit-push-pr`'s completion still depends on the partial
`ce-babysit-pr` handoff (U1). U3's plain-text fallback must therefore keep
covering: resolving PR feedback past the fetch boundary, and push/PR-create
plus babysit handoff, for a Muse Builder — U2 must not advertise either
skill as fully passing.

## Check output

```
$ ls docs/solutions/*ce-delegates-on-muse.md && grep -E "^(works|partial|not)" docs/solutions/*ce-delegates-on-muse.md
docs/solutions/2026-10-29-ce-delegates-on-muse.md
partial — ce-resolve-pr-feedback
works — ce-debug (mode:pipeline, the babysit delegate route)
partial — ce-commit-push-pr
works — ce-code-review (mode:agent, lite path; explicit verdict for U6 below)
```
