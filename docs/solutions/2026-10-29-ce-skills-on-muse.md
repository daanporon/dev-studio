# ce-skills on Muse: live probe of ce-simplify-code, ce-babysit-pr, ce-work

Date: 2026-10-29. CE version probed: 3.33.2 (newest in
`~/.claude/plugins/cache/compound-engineering-plugin/compound-engineering/`).
Muse: 1.4.14. Method: scratch HOME only (`HOME=/tmp/musetest-home`, skills in
`/tmp/musetest-home/.config/muse/skills/`, read-only copy of live `auth.json`);
live `~/.muse`, live `~/.config/muse` and live HOME were never given the
skills — after the probes `~/.config/muse/skills` still does not exist.
Fixtures were tiny throwaway repos under `/tmp/u1probe/`; logs there
(`simplify.log`, `work.log`, `babysit.log`). Each probe ran
`HOME=/tmp/musetest-home muse exec --yolo --disable-approval --disable-sandbox
--workspace <fixture>` naming the skill explicitly.

## Verdicts (one line per skill, for U2's pass-list)

works — ce-simplify-code
works — ce-work (mode:return-to-caller, the Builder's mode)
partial — ce-babysit-pr

## ce-simplify-code — works

Live: on a toy branch diff (`calc.py`: hand-rolled `total` loop plus a
duplicated `total2`), the skill resolved scope as branch-vs-`main`, applied
`total -> return sum(xs)` and `total2 -> return total(xs)`, correctly skipped
deleting the exported `total2` (not provably behavior-preserving) in favour of
delegation, and returned its Step 5 pipeline summary. Its own equivalence
probe passed; the fixture assertions passed by direct invocation (system
`python3` has no `pytest` — noted in its summary, not hidden).

Gaps: none blocking.

- Subagent primitive: the skill says dispatch via "`Agent`/`Task` in Claude
  Code, `spawn_agent` in Codex", else run inline/serially. Muse exposes
  `muse.subagent_spawn` (plus `muse.workflow`), which a generic prompt-asset
  dispatch can use; the inline fallback the skill itself authorises also
  works, and the observed run produced reviewer-attributed findings either
  way. No failure if subagents are unavailable.
- Model tier: "Sonnet-class mid-tier" override does not map to a Muse knob
  in the dispatch; the skill says inherit the parent model in that case.
- AskUserQuestion: not needed in `mode:pipeline` (never asks). Standalone
  mode asks in chat; Muse interactive sessions ask in chat / via
  `request_user_input`, `muse exec` has `--user-input-auto-resolve`.
- Binaries: only `git` + the project's own test runner. No `gh`, no bundled
  scripts. `references/reviewer-dispatch.md` (bounded dispatch, release,
  omit `mode`) translates without a Claude-only tool name.

## ce-work — works in mode:return-to-caller

Live: on a one-file plan (`plan.md`: create `greeting.py` + test), the skill
read its bundled references, took the native inline route (single unit, no
subagent dispatch), observed the red failure first
(`ModuleNotFoundError`, pytest exit 2), implemented, went green (1 passed),
made a path-limited canonical commit, and returned the structured
return-to-caller JSON including `standalone_shipping_skipped: true`,
`changed_files`, `verification_results`/`verification_evidence`,
`u_ids_completed: ["U1"]` and empty `blockers`. No review, simplify tail,
PR or babysit ran — exactly the Builder contract in `roles/builder.md`.

Gaps: none blocking for return-to-caller.

- Bundled scripts: `scripts/unit-workspace.py` and siblings run under the
  system `python3` (3.12.3, `--help` verified); the native route did not
  need them. No Claude-only binary is invoked on this route.
- Cross-model execution (`references/cross-model-execution.md`,
  `scripts/cross-model-work.sh`, `peer-job-runner.py`) was not exercised:
  triage selected native. A future route that selects cross-model execution
  is unprobed — treat it as untested, not as working.
- Standalone shipping tail (Phase 3-4) invokes `ce-code-review`,
  `ce-commit-push-pr` etc. by name; those skills are not installed for
  Muse, so standalone `ce-work` would stall at the tail. Builders never
  use standalone mode, so this does not block U2 — do not advertise
  standalone `ce-work` as working.
- Asking: return-to-caller returns `blocked` instead of asking, which
  matches the skill text; no AskUserQuestion equivalent is required.

## ce-babysit-pr — partial

Live: on a scratch repo with no GitHub remote, resolve+report worked
honestly — it refused to invent a PR, performed no mutation, and returned
the pipeline decision `{"status": "needs-human", ...}` naming the missing
remote/auth and the options. That is the resolve/report boundary, and it
is sound. The full tick loop was **not** babysat to green on a real PR
(per the plan: no real PR babysat), and three concrete gaps stop the loop
past resolve:

- Missing named delegates (blocking): Step 2 invokes
  `ce-resolve-pr-feedback mode:pipeline` for review threads and
  `ce-debug mode:pipeline` for CI failures, and the ready-report path can
  invoke `ce-commit-push-pr mode:pipeline`. None of the three is in the
  three-skill install set (verified absent from the scratch skill dir;
  present only in the Claude plugin cache). With only `ce-babysit-pr`
  installed, the first tick with feedback or a CI failure has nothing to
  dispatch to. U2 must either add these delegates (and probe them) or
  keep `ce-babysit-pr` off the pass-list.
- `gh` auth lives outside the skill: `gh` 2.102.0 is on PATH and the
  bundled `scripts/pr-snapshot` (python3) runs, but under a scratch HOME
  `gh` has no credentials, so even resolve cannot reach GitHub. On a real
  Builder HOME this resolves; the skill itself correctly stops instead of
  guessing. No `unavailable-binaries`-style flag was needed or found —
  failures surface as the skill's own stop/report, not a crash.
- Sustained watch loop: `references/watch-loop.md` waits on
  `BABYSIT_WAKE` inside one long session. A headless `muse exec` run has
  no equivalent wake source; `mode:pipeline` bounded synchronous ticks
  (the Builder's posture, re-invoked by `finish-unit.sh --check` cycles)
  are the usable shape on Muse, not the in-session watcher.

## What U2 should install

Install `ce-simplify-code` and `ce-work`. Do **not** install
`ce-babysit-pr` alone as "passing": either probe and add its delegate
chain (`ce-resolve-pr-feedback`, `ce-debug`, `ce-commit-push-pr`) or
leave babysitting to the plain-text fallback (U3) driven by
`gh` + `finish-unit.sh --check`.

## Check output

```
$ ls docs/solutions/*ce-skills-on-muse.md && grep -E "^(works|partial|not)" docs/solutions/*ce-skills-on-muse.md
docs/solutions/2026-10-29-ce-skills-on-muse.md
works — ce-simplify-code
works — ce-work (mode:return-to-caller, the Builder's mode)
partial — ce-babysit-pr
```
