# ce delegates re-probe on Muse (with teeth): ce-resolve-pr-feedback, ce-commit-push-pr, ce-pov

Date: 2026-10-29. CE version probed: 3.33.2 (newest in
`~/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/`).
Muse: 1.4.14. Method: scratch HOME only (`HOME=/tmp/u7home`, skills in
`/tmp/u7home/.config/muse/skills/`, read-only copy of live muse `auth.json`;
`gh` credentials written only into `/tmp/u7home/.config/gh/hosts.yml`, never
into live `~/.config/gh` or live muse config — verified after the probes:
`~/.config/muse/skills` still does not exist). Scratch HOME and fixtures
were deleted after the probes. Probes ran against a throwaway **private**
repo (`acme-org/u7-reprobe-1793273679`, created for this unit) with real
`gh` auth, via `HOME=/tmp/u7home muse exec --yolo --disable-approval
--disable-sandbox --workspace <fixture>` naming each skill explicitly.

Deletion caveat: `gh repo delete` was attempted and returned HTTP 403 —
the operator token lacks the `delete_repo` scope, and refreshing it would
have meant writing live `gh` config (forbidden by this unit). The private
throwaway repo therefore still exists and needs a one-click operator
delete; it contains only the toy `calc.py`/`greeting.py` fixtures below.
No other repo was touched.

## Verdicts (one line per skill, for U2's pass-list)

works — ce-resolve-pr-feedback
works — ce-commit-push-pr
works — ce-pov

## ce-resolve-pr-feedback — works (full loop, was partial in U5)

Live: on PR #1 of the throwaway repo (branch `feature-avg`), a real review
thread was seeded (`calc.py:5`: "average([]) raises ZeroDivisionError —
please guard empty input"). `mode:pipeline` fetched it (1 review thread,
`pending_review: null`), judged it valid, applied the fix
(`average()` now raises `ValueError("average() requires at least one
value")`), committed (`58973eb`), pushed, replied on the thread
(reply comment `4411836390`), and resolved the conversation. Its
structured return reported `fixed: 1`, `review_threads_remaining: 0`,
`needs-human: []`. Independently verified outside the skill: the GraphQL
`reviewThreads` query showed `isResolved: true`, and the reply comment
exists on the PR. The U5 gap (no `gh` auth under scratch HOME, loop never
reached past the Platform gate) is closed by real auth — no Muse tool gap
remained: fixer dispatch, bundled `gh` scripts, reply and resolve all ran.

Residual: the judgment-bound delegate path was not separately forced —
the seeded feedback was a clear-cut valid fix, so no judgment-bound item
arose to route through `ce-pov`. That delegate is probed directly below.

## ce-commit-push-pr — works in mode:pipeline (babysit:off, was partial in U5)

Live: in a fresh clone on branch `feature-cpp` with one uncommitted file
(`greeting.py`), `mode:pipeline` with `babysit:off` committed exactly that
file (`feat: add greeting helper`), pushed the branch, and opened PR #2
against `main`. Structured return (verbatim):
`{"pr_url":"https://github.com/acme-org/u7-reprobe-1793273679/pull/2","pr_number":2,"branch":"feature-cpp","base":"main","title":"feat: add greeting helper","mode":"pipeline","babysit":"off","status":"created"}`.
Independently verified: `gh pr list` showed PR #2 OPEN. The U5 publish
boundary (no remote / no auth) is closed — push and PR-create work on Muse.

Caveat (unchanged from U1/U5, not a regression): the run used
`babysit:off`. A full run's completion gate hands off to `ce-babysit-pr`,
which remains partial on Muse (no headless-wake equivalent for its watch
loop; bounded `mode:pipeline` ticks are the usable shape). U2 may install
`ce-commit-push-pr` as passing for the commit→push→PR leg; the babysit
handoff stays covered by U3's tick-loop prescription.

## ce-pov — works (the delegate U5 surfaced)

Live: invoked directly in the fixture repo on a supplied approach set for
`calc.average` empty-input handling — (A) return 0, (B) raise ValueError,
(C) return None — it returned a graded position, **(B) raise ValueError**,
grounded in the project's own evidence: it cited the already-merged guard
in `calc.py` and commit `58973eb`, rejected (A) as indistinguishable from
`average([0])`, rejected (C) as a return-type change pushing null checks
onto callers that do not exist yet, and named what would change the
verdict. It stayed read-only. So `ce-resolve-pr-feedback`'s judgment-bound
route now has its delegate installed and functional on Muse; the U5
fallback (`ce-pov` unavailable → `needs-human`) is no longer the only
path. Oracle/cross-model panel mode was not exercised — the supplied
approach-set route above is the delegate shape the babysit chain uses.

## What U2 should install

Upgrade all three to the pass-list: `ce-resolve-pr-feedback`,
`ce-commit-push-pr`, `ce-pov`. Per the operator-approved cap, nothing is
left partial for U3 to inline from this chain: U3's babysit coverage
reduces to the `ce-babysit-pr` watch-loop shape (bounded pipeline ticks),
which U1 already prescribed. No U8.

## Check output

```
$ ls docs/solutions/*ce-delegates-reprobe-muse.md && grep -E "^(works|partial|not)" docs/solutions/*ce-delegates-reprobe-muse.md
docs/solutions/2026-10-29-ce-delegates-reprobe-muse.md
works — ce-resolve-pr-feedback
works — ce-commit-push-pr
works — ce-pov
```
