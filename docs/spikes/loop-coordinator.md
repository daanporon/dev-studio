# Spike: the loop as a Run's coordinator (S1(b)) and one GraphQL query for PR state (S3)

Unit U1 of the sweep-run-loop plan (KTD5, R21). It answers two questions before
the actuator and the GitHub observer are built:

- **S1(b).** Can the loop, a systemd process with no Orca terminal of its own,
  coordinate a squad's Run itself?
- **S3.** Can one GraphQL query return everything the observer needs for every
  open PR of both projects?

**Result.**

- All four S1(b) answers are **yes**, so the actuator talks to Orca directly.
  The S1(a) fallback (actuate through the Lead) is not needed.
- S3 is **yes**, with one shape constraint: mergeability for ~100 PRs does not
  fit in one GitHub request.
- Two constraints the actuator must design around, and one for the role specs,
  are listed under [Design constraints](#design-constraints).

**Evidence.**

- Orca source: <https://github.com/stablyai/orca> at `1cefa152` (2026-10-30).
  Paths below are relative to that repo.
- Live Orca 1.4.241 on the dev-host host, with managed Claude accounts
  registered. Without one, `worker-start` fails: see
  `docs/solutions/2026-10-06-worker-start-needs-managed-account.md`.
- The spike scripts (s1b, s3) were one-off and are not kept. Transcripts are at the end.

## How s1b.sh plays the loop

Every `orca` call goes through `o() { env -i HOME="$HOME" PATH="$PATH" orca "$@"; }`.
This gives the same empty environment the loop has under systemd: no
`ORCA_TERMINAL_HANDLE`, no agent-session evidence, and nothing but `--from <handle>`
to say who is calling.

The script works in a throwaway worktree of this repo (`--no-parent --setup skip`),
so no rewake or picker hook can confound the push test. It then:

1. Creates a plain shell terminal with `orca terminal create`. This is the
   loop's *sender terminal*.
2. Stores the terminal's handle in a file, standing in for the loop's SQLite
   row.
3. Runs `run-create --from` with that handle.
4. Starts a Claude worker with `worker-start --from <handle>` as the Lead
   stand-in. Its spec says: answer `ready`, never send `worker_done`, and do
   what an orchestration message says.

A trap stops every worker of the Run, closes the terminals, and removes the
worktree and its branch.

## Q1: the sender terminal handle survives a loop restart — **yes**

**Proof.** The `S1b-Q1` block:

- `q1a="$(o orchestration run-current --from "$h_stored" ...)"` is the stored
  handle after a process restart.
- After `terminal close` on that handle, these run from a new terminal:
  `o orchestration run-use --id "$run" --from "$h2"`,
  `run-current --from "$h2"` and `check --run "$run" --terminal "$h2"`.
- `worker-show` on the Lead still says `dispatched`.

**Orca behaviour.**

- A Run stores `coordinator_handle` **and** `coordinator_pane_key`
  (`src/main/runtime/rpc/methods/orchestration/runs/runs.ts` L30-56).
- The coordinator is matched by pane key (`tabId:leafId`), not by handle
  (`src/main/runtime/orchestration/orchestration-caller-identity.ts` L51-63,
  `src/main/runtime/orchestration/db/pane-key-match.ts`).
- A plain shell qualifies. `run-create`/`run-use` need only a pane that
  resolves. An agent is needed only for `--takeover-legacy`
  (`run-scope.ts` L83-118, `run-binding.ts` L118-141).

What this means for the two kinds of restart:

- **The loop restarts and its terminal lives.** The stored handle still
  resolves and stays bound, so nothing needs to be done.
- **Orca restarts.** From source only: s1b.sh does not restart Orca. Handles are runtime-scoped (`term_<uuid>` in memory,
  `src/main/runtime/terminal/query/pty-terminal-summary.ts` L287-330). Pane
  keys survive while the layout leaf exists (`src/shared/stable-pane-id.ts`).
  So the same pane under a new handle still matches. On boot, the loop
  re-resolves its handle from the pane and runs `run-use` to refresh the stored
  handle.
- **The terminal is gone.** A new terminal is a new pane, and `run-use --id R --from <new>`
  rebinds it.
  - `bindRun` bumps `consumer_generation` and fences only the Run mailbox's
    **unacked** delivery batch (`run-binding.ts` L142-184).
  - The old handle is remembered as an alias. A DB trigger reroutes mail sent
    to it into `run:<id>`
    (`src/main/runtime/orchestration/db/runs/run-coordinator-mail-routing.ts`).
  - Dispatches keep their own `consumer_generation`, so running workers are
    untouched.
  - The rerouting matters because every worker brief names the coordinator
    handle it was started under.

**For the actuator.**

- Store the pane key next to the handle.
- On boot, if the handle is stale, find the pane's current handle. If the pane
  is gone, run `terminal create` and `run-use`.
- Before rebinding, ack or re-read the Run mailbox, because a rebind fences an
  unacked batch.

## Q2: a Lead started as a Dispatch-owned worker still gets push-on-idle — **yes**

**Proof.** The `S1b-Q2` block:

- The loop terminal sends
  `o orchestration send --from "$h2" --to "dispatch:$lead" ...` to the
  **idle** Lead. Nothing else is typed into the Lead's pane.
- `poll 300 got_q` finds the Lead's `ask` in `run:<id>`.
- ``poll 60 transcript_has "$lead" 'Run `orca orchestration check'`` finds Orca's pointer
  notice in the Lead's transcript as a user turn:
  ``You have 1 orchestration message. Run `orca orchestration check`.``

**Orca behaviour.**

- Push-on-idle (`src/main/runtime/orchestration/mailbox-pointer-delivery.ts`)
  serves `run:` and `dispatch:` mailboxes.
- `dispatch:<id>` resolves to the pane of the Dispatch's assignee
  (`mailbox-delivery-target.ts` L173-207).
- When that pane's agent is live-idle, Orca types the pointer notice, waits
  500 ms, then presses Enter. It does this when a message arrives with no
  waiter, and again on the agent's idle edge
  (`mailbox-notification-coordinator.ts`, `terminal-title-observation.ts`).
- Who started the worker plays no part: a worker started by a plain-shell
  coordinator is woken like any other.
- A plain shell is never typed into, because it never reports agent-idle. That
  is why the loop **polls** its own mailbox (`check`) instead of being pushed.
- If a Lead binds a child Run of its own, mail to its `dispatch:` is redirected
  to the child Run's inbox and still wakes it
  (`mailbox-owner.ts` L41-93, warning `recipient_run_bound_redirect`).

## Q3: a worker's `ask` reaches the loop and a `reply` lands back — **yes**

**Proof.** The `S1b-Q3` block:

- `question_id` finds the question in
  `check --run "$run" --terminal "$h2" --peek`, which is the loop's inbox.
- `o orchestration reply --id "$qid" --run "$run" --from "$h2" --body "$answer"`
  sends the answer.
- `poll 180 transcript_has "$lead" "$answer"` sees the answer nonce in the
  Lead's transcript, returned by its blocking `ask`.

**Orca behaviour.** Ask goes through
`src/main/runtime/rpc/methods/orchestration/messaging/ask-methods.ts`:

- It needs an active Dispatch.
- It goes to `reportTo`. That is `dispatch:<creator>` when the worker's
  creator is itself an active worker in the Run, otherwise `run:<id>`
  (`dispatch-report-mailbox.ts` L31-37).
- `reply` must come from the creator worker or from the Run's **current** bound
  coordinator, matched by pane
  (`message-methods.ts` L27-140, `requireCurrentConsumer: true`).
- The answer is stored as `run:<id> → dispatch:<id>`, "Re: Question", and
  returned to the parked `ask` (`question-threads.ts` L75-180).
- A repeat of the same answer returns `duplicate: true`.

**For the actuator.**

- A Builder the **loop** starts asks the loop. A Builder the **Lead** starts as
  a helper asks the Lead by default. To route a Builder's questions to the
  loop, start Builders from the loop's sender terminal, or have the role spec
  pass `ask --to run:<id>`.
- The loop must reply from the bound sender terminal. From source only (s1b.sh
  rebinds before the ask): if the loop rebinds while an ask is parked, the ask
  should still get the answer, because the reply keys on the question id and
  the Run, not on the handle.
- Each parked `ask` holds one of Orca's 8 ask slots. See
  [Design constraints](#design-constraints).

## Q4: a crashed call is settled with `--retry-request` and `request-show` — **yes**

**Proof.** The `S1b-Q4` block:

1. The script backgrounds the orca client itself
   (`env -i ... orca "${ws[@]}" --retry-request "$rq" --json &`, so `$!` is
   orca and not a bash subshell). After 2 s it checks that the client is still
   running, kills it, and checks that it is dead.
2. `poll 180 settled` polls `request-show --request "$rq"`. It goes from
   `pending` to `completed`.
3. The identical replay returns `mutation.replayed=true` with the same
   `dispatchId`.
4. `worker-list` shows two workers, the Lead and this one, not three.
5. The same request id from **another** terminal returns `request_mismatch`.

**Orca behaviour.** The mutation receipts:

- **Keying.**
  - A receipt is keyed by `(caller_fingerprint, request_id)`. Locally there is
    one fingerprint per DB
    (`src/main/runtime/orchestration/db/mutation-receipts/mutation-receipt-store.ts`).
  - The payload hash replaces `from` and terminal handles with the pane leaf id
    (`src/main/runtime/rpc/orchestration-mutation-receipt.ts` L19-48).
  - So the same pane under a new handle matches, and another pane is refused.
- **The pending row.** `worker-start` writes its pending receipt in the same
  transaction that creates the Dispatch
  (`worker-dispatch-start.ts` L47-72).
- **Abort is ignored.** `worker-start` never reads the abort signal, so killing
  the client does not stop the start. The receipt completes anyway: here the
  orca client was killed 2 s in, still `pending`, and the receipt reached
  `completed` a few seconds later.
- **After an Orca restart.** A receipt left `pending` across a restart returns
  `operation_unknown`, naming the Dispatch to inspect
  (`orchestration-mutation-executor.ts` L45-248).
- **Retention.** Receipts are pruned after 30 days or past 10 000 rows
  (`mutation-receipt-capacity.ts`).

**For the actuator.**

- Mint the request id **before** the call and write it to SQLite.
- After a crash, run `request-show`:
  - `completed`: read `dispatchId` from the receipt;
  - `pending`: wait and poll again;
  - `absent`: the call has not landed yet. Replay with the **same** request id
    from the same pane. A killed client's `worker-start` can still be queued
    behind other long-polls. A fresh id could then start a second Lead, while
    the same id is deduplicated by the receipt store.
- Replay from the **same pane** only. After a terminal loss, read the receipt;
  do not replay.

## S3: one GraphQL query for every open PR of both projects — **yes**

**Proof.** `s3.sh`, with the query shape in `s3.graphql`:

- Repos are resolved from the squad JSONs (`repo` = `path:<dir>`). That gives `acme-org/dev-studio` and
  `acme-org/acme`.
- `gh api graphql -f query="$(build_query "${pages[@]}")"` sends one aliased
  `repository { pullRequests(states: OPEN) { ... } }` per repo.
- Repo resolution uses `repo_slug` from `bin/lib/lib.sh`, which reads any GitHub
  remote, not only `origin`.
- `s3.sh` then checks every node for the fields and compares the open count per
  repo with `gh pr list --state open`. It exits 1 on any mismatch.

**GitHub behaviour** (measured on `acme-org/acme`, 98 open PRs):

| page | fields | time |
|---|---|---|
| 100 PRs | no mergeability | ~0.6-4 s |
| 100 PRs | `mergeable` added | ~7.6 s |
| 100 PRs | all fields | **10.8 s → 502/504** |
| 50 PRs | all fields | ~5.5 s |

- `mergeable` and `mergeStateStatus` make GitHub compute mergeability per PR.
  With them, a 100-PR page runs past GitHub's 10 s GraphQL timeout.
- `S3_MODE=full` therefore pages 50 at a time: one query **shape**, two POSTs
  for acme.
- `S3_MODE=observer` is the shape U5 should use:
  - every open PR without mergeability (`fragment PRLight`), 100 per page;
  - every field for each PR a unit records, as `pr<N>: pullRequest(number: N)`
    aliases;
  - one POST per tick while every repo has at most 100 open PRs (acme has
    ~95), and one more per further 100. Cost is 1-4 points.
- The tracked aliases also catch a merge: once merged, a PR leaves the OPEN
  page.
- A `pr<N>: pullRequest(number: N)` alias that GitHub cannot resolve (deleted
  or transferred PR, or a number from another repo) comes back as a
  `NOT_FOUND` entry in `errors`, next to partial `data`. `s3.sh` fails on any
  error, which is right for the spike. U5 must instead read per-alias errors as
  "PR gone" and keep the rest of the response, or one bad unit PR blanks the
  observer for every repo. U5 should also take owner/repo from the unit's PR
  URL; `s3.sh` keeps only the trailing number and assumes the squad's repo.
- `mergeable: UNKNOWN` is a normal answer: GitHub computes mergeability lazily
  and starts the computation when asked. Across full runs, 57 of 96, then 84 of 95,
  then 10 of 95 acme PRs were `UNKNOWN`. U5 must treat `UNKNOWN` as "not yet known, ask again next
  tick", never as conflicting or clean.
- Nested lists can overflow. `s3.sh` prints `truncated(threads/reviews)`. On
  acme, 1 PR had more than 50 review threads and 8 had more than 20 reviews.
  - `reviews(last: 20)` keeps the newest, which is enough for the latest
    verdict per reviewer.
  - A PR whose `reviewThreads.totalCount` exceeds its nodes undercounts
    unresolved threads. U5 must fetch that PR's threads on their own (one
    `pullRequest(number:)` alias with `reviewThreads(first: 100, after:)`)
    before it reads "no unresolved threads".
- The count check can race. One observer run read 95 open acme PRs from GraphQL
  and 94 from `gh pr list` seconds later, because a PR closed in between.
  `s3.sh` failed closed (exit 1), and the rerun matched. U5 has no second source
  to compare against, so this only affects the spike's check.
- Pages are ordered `CREATED_AT ASC`. `UPDATED_AT` reorders while paging and
  dropped a PR in testing. New PRs land after the last cursor, and the merge
  dedupes by number.

## Design constraints

1. **One pane coordinates one Run.**
   - `bindRun` calls `unbindOtherRunsForCoordinator` first (`run-binding.ts`
     L142, `run-lookup.ts` L163).
   - Live check: `run-create` from the sender terminal of Run R left R with
     coordinator `none`, and `check --run R` then gave `consumer_fenced`.
   - So the loop needs **one sender terminal per squad Run**, created and owned
     by the loop (for example a titled shell in the squad's worktree), and its
     store keys handles per Run.
   - Orca has no `run-end`, so finished spike Runs stay in `run-list` with no
     coordinator.
2. **Strip `ORCA_*` from the loop's environment.**
   - `ORCA_AGENT_SESSION_ID`, `ORCA_TERMINAL_HANDLE`, `ORCA_PANE_KEY` and
     `ORCA_AGENT_LAUNCH_TOKEN` are read as caller evidence
     (`src/shared/orchestration-compatibility-evidence.ts`,
     `src/cli/session-caller-flags.ts`).
   - If inherited from an agent terminal, they conflict with `--from` and the
     CLI refuses before sending.
   - The systemd unit must not inherit them. `env -i` in s1b.sh shows that a
     clean environment plus `--from` is enough.
3. **Long-poll slots.**
   - Orca admits 16 long-polls (`runtime-rpc-long-poll.ts` L7), and asks get at
     most 8 of them.
   - These hold a slot: `worker-start`, which keeps it for the whole start, even
     when the client is killed; `check --wait`;
     `terminal wait`; and `ask`.
   - These don't: `send`, `reply`, `run-use`, `request-show` and plain `check`.
   - The loop should use plain `check` on its tick, not `check --wait`, and cap
     concurrent `worker-start`s. Over the cap, Orca returns `runtime_busy`; the
     CLI does not retry, so the loop backs off itself.
4. **Workers must keep their Dispatch open to be woken or to ask.**
   - Ask and push both need an active Dispatch.
   - A worker that sends `worker_done` settles it, which closes its questions
     and stops pushes to it. In the probe, a Haiku worker did this unprompted.
   - Role specs must keep that rule.

## Transcripts

Final runs on 2026-10-30 against Orca 1.4.241 and GitHub. Run ids, handles
and counts change on every run.

### s1b.sh

```text
$ s1b.sh
s1b: worktree ds-spike-s1b-1793377736-3027266, sender term_e3677e1d-49b3-4c43-9ff8-43dd93636f63, run run_3f7699a9d83b
s1b: lead worker ctx_4f22991011d9 (terminal term_c31b8672-b5de-4903-a785-4abcd66288c6) started by the loop: state ready
s1b: VERDICT S1b-Q1 sender survives loop restart: yes — stored term_e3677e1d-49b3-4c43-9ff8-43dd93636f63 still bound to run_3f7699a9d83b; after closing it, new term_0127bda9-278c-4a1e-84a1-06bf64e4d96b run-use -> generation 2, coordinator check ok, lead ctx_4f22991011d9 still dispatched
s1b: sent to idle lead at 17:29:06; waiting for its ask
s1b: VERDICT S1b-Q2 push-on-idle wakes a Dispatch-owned Lead: yes — Orca typed the pointer notice into the idle lead; it ran check and asked (msg_2b0aea06648c) with no other input
s1b: VERDICT S1b-Q3 ask reaches the loop, reply lands back: yes — question msg_2b0aea06648c arrived on run:run_3f7699a9d83b (the loop's inbox); reply S1B-ANSWER-1793377736-3027266 is in the lead's transcript
s1b: VERDICT S1b-Q4 crashed worker-start settles: yes — client pid 3064255 killed mid-call after 2s; request-show went pending,completed; replay with the same id -> replayed=true, dispatch ctx_0d92183dc19d; run has 2 workers (lead + this one); replay from another pane -> request_mismatch
s1b: CONSTRAINT one pane, one Run: binding term_0127bda9-278c-4a1e-84a1-06bf64e4d96b to run_41c2b28660f9 left run_3f7699a9d83b with coordinator none — the loop needs one sender terminal per Run
VERDICT S1b-Q1 sender survives loop restart: yes — stored term_e3677e1d-49b3-4c43-9ff8-43dd93636f63 still bound to run_3f7699a9d83b; after closing it, new term_0127bda9-278c-4a1e-84a1-06bf64e4d96b run-use -> generation 2, coordinator check ok, lead ctx_4f22991011d9 still dispatched
VERDICT S1b-Q2 push-on-idle wakes a Dispatch-owned Lead: yes — Orca typed the pointer notice into the idle lead; it ran check and asked (msg_2b0aea06648c) with no other input
VERDICT S1b-Q3 ask reaches the loop, reply lands back: yes — question msg_2b0aea06648c arrived on run:run_3f7699a9d83b (the loop's inbox); reply S1B-ANSWER-1793377736-3027266 is in the lead's transcript
VERDICT S1b-Q4 crashed worker-start settles: yes — client pid 3064255 killed mid-call after 2s; request-show went pending,completed; replay with the same id -> replayed=true, dispatch ctx_0d92183dc19d; run has 2 workers (lead + this one); replay from another pane -> request_mismatch
s1b: cleanup done (run run_3f7699a9d83b, worktree ds-spike-s1b-1793377736-3027266 removed)
exit=0
```

### s3.sh (full)

```text
$ s1b.sh
s3: mode full, 2 GraphQL POST(s) for 2 repo(s), 12111 ms, rate-limit cost 3 (remaining 4918)
s3: acme-org/dev-studio: open=2 (gh pr list: 2, totalCount: 2) ci={NONE:2} mergeable={MERGEABLE:2} reviewDecision={NONE:2} unresolvedThreads=0 truncated(threads/reviews)=0/0 tracked=1 (open 1, merged 0, mergeable MERGEABLE:1)
s3: acme-org/acme: open=95 (gh pr list: 95, totalCount: 95) ci={FAILURE:25,NONE:1,PENDING:15,SUCCESS:54} mergeable={CONFLICTING:33,MERGEABLE:52,UNKNOWN:10} reviewDecision={NONE:95} unresolvedThreads=65 truncated(threads/reviews)=1/8 tracked=10 (open 9, merged 1, mergeable CONFLICTING:3,MERGEABLE:6,UNKNOWN:1)
VERDICT S3: yes — one query shape returns state, mergeable, CI rollup, reviews and review threads for every open PR of every repo, in 2 POST(s) at 50 PRs per page
exit=0
```

### s3.sh (observer)

```text
$ S3_MODE=observer s3.sh
s3: mode observer, 1 GraphQL POST(s) for 2 repo(s), 4901 ms, rate-limit cost 4 (remaining 4870)
s3: acme-org/dev-studio: open=2 (gh pr list: 2, totalCount: 2) ci={NONE:2} mergeable={NOT_ASKED:2} reviewDecision={NONE:2} unresolvedThreads=0 truncated(threads/reviews)=0/0 tracked=2 (open 2, merged 0, mergeable MERGEABLE:2)
s3: acme-org/acme: open=94 (gh pr list: 94, totalCount: 94) ci={FAILURE:26,NONE:1,PENDING:16,SUCCESS:51} mergeable={NOT_ASKED:94} reviewDecision={NONE:94} unresolvedThreads=65 truncated(threads/reviews)=1/8 tracked=10 (open 9, merged 1, mergeable CONFLICTING:2,MERGEABLE:7,UNKNOWN:1)
VERDICT S3: yes — one POST returns state, CI rollup, reviews and review threads for every open PR and mergeability for every unit's PR (1 POST(s), 12 unit PRs)
exit=0
```
