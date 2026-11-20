# Project ship modes

Each registered project declares how a Squad's finished work reaches its target
(R18, KTD8).

The **Builder owns build→review→ship for its own unit** (one unit = one PR) — there is no
separate reviewer in the normal path. A separate Reviewer is optional, for an extra pass on a
high-risk PR only (`roles/reviewer.md`).

| Mode | What the Builder does (end to end, for its unit) |
|---|---|
| `ce-pipeline` (default) | dev-studio's own, self-contained delivery — no external gate, every question routed to the Lead/Thinker. `ce-work mode:return-to-caller` (implement + TDD, no review/PR of its own) → `ce-simplify-code` → `bin/review/review-unit.sh` (`ce-code-review` in a separate headless claude on the `builder-review` model (Opus by default) for a hard or untiered unit, and on the cheaper `builder-review-standard` row (Sonnet, medium) for a `standard` unit; if Claude is limited and the row has a `muse:` fallback, it runs on that Muse model instead, and the receipt records the engine and model, which `finish-unit.sh` prints) → open the PR; the loop then reads the PR and pokes the Builder about anything not merge-ready, and the babysit phase takes it to merge-ready. `ce-code-review` dispatches **independent reviewer agents + a cross-model pass**, so the review is independent even though the Builder runs it. The Tester supplies the **project's own e2e / browser proof** when it has one. The gate is `ce-code-review` + the repo's CI + the e2e proof; the loop won't call the PR merge-ready until every **required** check is green. |
| `no-mistakes` | Run the environment-provided `no-mistakes` skill as the pre-target gate: review, tests, lint, docs, push, PR, CI-to-green. Nothing reaches the target until it passes. |
| `direct-PR` | Push the branch and open a PR directly, **skipping** the review/simplify/e2e steps (fast path); the loop then reads the PR and the babysit phase takes it to merge-ready. |
| `local-only` | Commit locally; no push, no PR. |

**Ship modes are additive: `ce-pipeline` is the minimum, the repo's own steps go on top.**
`ce-pipeline` uses dev-studio's roles and is the baseline for every project. A repo may also
carry its own delivery steps that gate a merge (a verify or sign-off step, a proof it wants
posted on the PR). Those live in the repo's `AGENTS.md` / `CLAUDE.md` and the delivery or verify
skills they name, and dev-studio does not list them: before `finish-unit.sh`, the Builder reads
those files and **satisfies each step that gates the merge**, in addition to the mode's own
steps. This applies in every PR-opening mode (`ce-pipeline`, `no-mistakes`, `direct-PR`) because
the repo needs those steps to merge; `local-only` opens no PR, so they don't apply. A repo whose
files name no merge-gating step gets the mode's steps only.

**The normal review receipt is one full review plus deltas.** `review-unit.sh` runs full once per
PR, then deltas after fix commits (a delta turns full by itself on size or a risk path); a Lead or
Thinker asks for `--full "<reason>"` only for a named risk, and the reason lands in `ds-review-log`.

dev-studio's rules still win where they conflict: Builders never merge or arm auto-merge, route
questions through the Lead (`orch.sh ask`; the Lead escalates with `ask-operator`), and keep the review receipt `ce-pipeline` requires.
With the project's `auto_merge` limit set (`squash`/`merge`/`rebase`), the loop arms GitHub
auto-merge on a merge-ready unit PR itself instead of asking the Lead to merge (U166).
Under `ce-pipeline` the Builder does not hand the whole unit to the repo's end-to-end
orchestrator (e.g. an `/lfg` skill or `no-mistakes`); it runs the individual required steps
itself. The `no-mistakes` mode still runs `no-mistakes` as its gate. The repo's **CI, branch
protection and required checks** run on the PR no matter the mode, and the loop waits
for them to go green before the PR counts as merge-ready.

**It's generic.** `ce-pipeline` itself only uses project-agnostic skills (`ce-work`,
`ce-code-review`, `ce-simplify-code`) plus "run the project's own e2e if it
has one"; whatever else a project needs, the Builder learns from that repo each time.

## After the PR is open: keep it moving

For the PR-opening modes (`ce-pipeline`, `no-mistakes`, `direct-PR`), opening the PR is not
the end — CI can fail later, reviewers leave comments, the branch falls behind. The **loop**
reads the open PR and pokes the **Builder** about anything not merge-ready, and the babysit
phase takes it to merge-ready (as `roles/builder.md` says: the loop reads your PR and pokes
you when it changes) — the Builder never runs `ce-babysit-pr`. With `auto_merge` off the
Lead merges a merge-ready PR when the loop asks (KTD17); with the project's `auto_merge` limit
set, the loop arms GitHub auto-merge on it instead (U166), or merges it directly when the repo
does not allow auto-merge (U240, `bin/loop/fulfil/merge.ts`); either way the
operator owns the merge at the "PR ready" checkpoint (`conventions/autonomy.md`).

## Declaring a project's mode

Resolution order (the Builder reads this before shipping; `shipMode` in `bin/lib/operator.ts`
implements it, and `/ds-board` shows the result per squad):
1. **Operator override** — the project's `ship-mode` row in `state/loop.db` (U256; `docs/settings.md`).
   Set it with **`/ds-mode <project> <mode>`**; it lives in the loop's database, so it **survives
   `git reset --hard` / `/ds-update`**. This is the normal way an operator changes a project's mode.
2. **Committed default** — a line in `conventions/projects.conf`: `<repo-selector>  <mode>`
   (first field = the project label, or a string that appears in its repo selector). For a
   dev-studio maintainer setting a repo's baseline.
3. **Fallback** — `ce-pipeline`.

View the current mode with `/ds-mode <project>`; clear an override with `/ds-mode <project>
default`.

## How it wires in

The "PR ready" checkpoint (`conventions/autonomy.md`) fires **after** the ship mode's gate is
green — so a squad only reaches that gate once the PR is merge-ready (all
required checks green). The **Builder** owns invoking the mode for its unit; see `roles/builder.md`.
