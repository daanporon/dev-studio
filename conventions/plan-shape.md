# Plan shape: a dependency graph of shippable units

How a squad plan is cut. The Thinker follows it (`roles/thinker.md`), and its text
travels with every elevated planning call, so the deep model shapes plans the same way
(`conventions/thinker-routing.md`). Where the finished plan is saved: `conventions/plans.md`.

The plan is **not a flat list** and **not fixed waves** — it's a small **dependency
graph**: units with **no dependency between them run in parallel**, and a unit names exactly
the earlier units it waits on. Build it in five moves:

**a. Cut right-sized, shippable units.** Each unit is **independently shippable** — one
Builder builds *and* ships it end to end as **one PR** (`roles/builder.md`,
`conventions/ship-modes.md`). Size it like a good PR: a coherent, self-contained, mergeable
change that doesn't leave the target broken — **not too small** (don't make a unit per file
or a trivial one-liner that just adds PR/CI overhead) and **not too big** (if it can't be
reviewed or its CI can't go green as one change, it's two units). One logical capability per
unit. A unit that touches more than about 40 files, or moves one flow across many modules, is
two units (example: a unit of about 100 files for one bust flow tied to the old approvals table).

**b. Give each unit its MINIMAL dependencies.** For each unit, name only the units it
genuinely needs merged first (its `deps`). Keep the list minimal — a unit that depends only on
U1 must **not** be made to wait on U2 as well. So if U1 and U2 are independent, they run at
once; and U3 (needs only U1) starts the **moment U1 merges**, even while U2 is still going.
This is the whole point: fine-grained deps, not coarse phases, so nothing waits on work it
doesn't need. Make sure two units with no dep edge between them don't collide on the same
files (if they would, add a dep or merge them).

**c. Shape the graph to use CI well.** CI is the slow part and runs **per PR in parallel**, so
the more units that are independent (no dep edge), the more CI runs overlap. Prefer a **wide,
shallow graph**: give units as few deps as the work truly requires, don't invent ordering that
isn't there. A long chain (each unit waits on the last) serializes CI and wastes time — look
for a cut that turns it into many independent units plus a thin merge-up unit at the end. When
a change genuinely can't be one mergeable PR, split it into **stacked units** where the later
one `deps` on the earlier (B rebases onto A's branch, ships after A merges) — don't hand a
Builder a unit it can't ship.

**d. Tag each unit's Builder tier.** Every unit line carries `Tier: standard|hard` — the
model its Builder builds on (the loop maps it through the roster) and the review it gets
(`builder-review`, Opus, for hard; `builder-review-standard`, Sonnet, for standard). A unit is **hard** when any one holds; otherwise **standard**:
- A topic-level hard signal in `conventions/thinker-routing.md` (security, auth, payments, data
  deletion, migrations, new data shape, shared contract) applies only when this unit's own change
  is the risky part: it changes the check, the money movement, the schema or the contract. A unit
  that merely sits in a module of that area (wiring, UI, copy, tests, a refactor next to it) is
  not hard for that reason.
- It changes code with many callers, concurrency, or a state machine.
- The area it touches has little or no test coverage.
- It doesn't follow an existing pattern in the repo.

**Unsure → standard** — the same default-cheap rule as the topic score. The safety net is the
Lead's move-up: `set-unit-tier <slug> hard` after a second wedge or two failed fix rounds
(`roles/lead.md`), which restarts the Builder on the hard tier. Example unit line:
`U2 — retry on lock timeout — deps: U1 — Tier: hard`.

**Unit lines are read by a script** (`register-plan`), so write each one exactly as
`U<n> — <title> — deps: … — Tier: standard|hard`, with an optional trailing `— HELD` to
hold the unit at registration. Dropping HELD from an approved plan's line releases the
hold on the next `register-plan`; adding HELD later does not re-hold:
- **Id** is `U` + digits + an optional lowercase letter (`U1`, `U24b`). A line that
  starts — after an optional `- `/`* ` marker — with a unit id and a dash (`—` or `--`)
  is read as a unit line and must parse exactly (one space after the marker, spaces
  around the dash), or the whole plan is refused; only headings (`### U1. Title`) and
  prose (`U4 gains one item.`) are ignored. So never write a near-miss like `U4—U5 merge`
  as prose — it refuses instead of being skipped.
- **Fields** after the title are `deps:`, `Tier:` and optionally `ext-deps:`, `blocks:` and `Lane:`, in any order, case-insensitive.
  `Tier:` reads its first word (`standard` or `hard`) and ignores the rest, so
  `Tier: standard (HELD)` also holds the unit. `deps:` is `none`/empty, or text naming
  whole-word `U<n>` ids (`deps: U1 (stacked on U1's branch)` works); a dep on another
  plan's unit resolves through the squad state, but never put an `E1`-shaped id or the
  word `external` there — another squad's unit goes in the separate `ext-deps:` field (below). An id this plan also uses
  always means this plan's own unit, and an id two other plans share refuses — so number
  a follow-on plan's units after the earlier plan's (U21 depending on U19), never restart
  at U1. A line missing `Tier:`, or with any other first word, **fails the handoff** —
  `register-plan` refuses the whole plan and the Lead sends it back to the Thinker.
- **`Lane:`** (optional, after the title like the others) is `Lane: light` or `Lane: normal`, with an optional
  `(rule: <id>)` naming the shared lane rule that justifies it: `— Lane: light (rule: contracts-only)`. A missing
  field means normal. Any other first word (`Lane: fast`) refuses the whole plan, naming the line. The lane lands
  on the unit as `lane` / `lane_rule`; re-registering an edited plan updates it (the Lead re-runs `register-plan`),
  and a dispatched unit's new lane counts from the next slot check.
  Lane is what the unit's checks and proof cost in CPU and memory (the project's lane rules, by the files it touches;
  `light_lane_cpu_h`); Tier is how hard it is to plan and build. Neither decides the other: a `Tier: hard` unit can be
  light, a `Tier: standard` unit can be normal.
  **Before tagging a unit light, read the evidence:** run `~/.dev-studio/bin/role/lane-rules.sh <project> print` (the
  project's shared rules, `state/<label>/lanes.md`) and `~/.dev-studio/bin/ds lanes <project>` (each rule's finished
  units, how many were **moved** to normal because they passed `light_lane_cpu_h` — its misses — and the median
  CPU-hours, plus the median CPU-hours per top-level folder for unmarked units). `Lane: light` must name a rule
  (`(rule: <id>)`), or `(rule: new — <why>)` and then add that rule with `lane-rules.sh <project> add <id> light "<when it
  applies>" "<evidence>"`. A rule with misses gets narrowed (`drop`, then `add` the tighter one) or dropped.
  **Re-tagging open units:** edit the unit's plan line, then ask the Lead to re-run `register-plan` (the lane lands
  as `updated`; a dispatched unit counts the new lane from the next slot check). Retagging a dispatched unit helps only while its
  CPU-hours (`ds lanes`, the board's CPU-h column) are under `light_lane_cpu_h`; past it the unit counts as normal anyway.
- **`ext-deps:`** (optional, U46) names another squad's unit **in the same project**:
  `— ext-deps: other-squad/u7-slug[, squad/slug]`. `register-plan` records each ref as the unit's
  `ext_deps`, so no Lead adds it by hand; the unit waits until the peer unit is `done`. A ref to a
  squad or unit that does not exist is reported by `register-plan` (stderr), the rest of the plan
  still registers, and the loop raises one Studio card naming the unit and the ref until it
  resolves or is dropped (`drop-ext-dep`). A ref to another project is not supported. Re-registering
  never removes an ext dep (use `drop-ext-dep`); `add-ext-dep` and `drop-ext-dep` keep working.
- **`blocks:`** (optional, after the title like the others) names the started units that wait on
  this one: `— blocks: U109, U105`. Use it on a fix-first unit; `register-plan` then runs
  `wait-on` for each (the plan is the reason), refusing the whole plan for an unknown, done or
  cancelled unit or a cycle.
- **Slug** is fixed at registration: a backticked `u<n>-…` token in the title wins, else
  `u<n>-` + the title in kebab case (a leading `[ticket]` prefix dropped, first 4 words,
  max 32 chars).

**e. Give each unit a Done and a Check.** Under each unit line, add **Done:** what is true
when the unit works, as the user or system sees it (not "tests pass"), and **Check:** the
exact command or proof that shows it — a test, a benchmark, the project's browser proof.
It must be able to fail. The Builder runs the Check and puts its output in the PR
(`roles/builder.md`); a green CI alone doesn't prove the Done. If you can't name a Check,
the unit isn't scoped yet. Example:
`U2 — retry on lock timeout — deps: U1 — Tier: hard`
`  Done: a write that hits a 30s lock retries once and succeeds`
`  Check: bun test retry.spec.ts`

`register-plan` also reads the flush form (`Done: x`) and the bullet form (`- **Done:** x`, bold or not), a blank line
before a unit's block, and `Goal:` / `What it does:` for the unit's About (the first of What/Goal wins); a label's
continuation lines are kept until a blank line, another label or another bullet. Other labels (`Files:`, `Linear:`)
are not stored. The indented example above is the one to copy.

**Link the unit to its ticket** when it has one: a `Link:` line in the block, one or more URLs separated by spaces or
commas (a tracker issue, a GitHub issue, any page with more context):
`  Link: https://tracker.example/issue/ABC-1, https://github.com/acme/app/issues/7`
`register-plan` stores them as the unit's `links`, and they follow the plan on every re-registration (drop the line,
drop the links). `Link:` is a reserved label: only `http://` and `https://` URLs, at most 5 per unit and 500 characters
each, and anything else refuses the whole plan naming the line. Put notes under another label (e.g. `Files:`).
`Links:` is not read.
A leading `[ID]` in the unit title (or a single one at its end) links by itself when the project sets `ticket_url` (`docs/settings.md`). Keep the `Link:` line anyway: only it reaches the Builder (the board shows the same URL once).

**A unit that touches the board needs a board Check.** If a unit changes what the board
shows (`bin/board/board-data.ts`, `web/board.html`, a board row or status), its Check must render
the board on real squad state and look at the affected rows — unit tests alone don't count.
Example: `Check: tests/board.sh renders the board on a fixture squad and asserts the
\`wrapping up\` row`.

The dep graph is what lets the Lead dispatch every currently-unblocked unit at once and
unblock each dependent the instant its own prerequisites finish (`roles/lead.md`,
`conventions/sequencing.md`).

## The plain section

A plan carries `## In plain words` near the top, for the operator who approves it. Five list lines, each
`- **<Label>:** <plain sentences>`, in this order:

- **What you get:** what will exist when it is done, in words a non-author reads.
- **Steps:** how many changes, and how they are ordered, no unit ids.
- **Risky or can't be undone:** what could go wrong or not be reverted; "nothing" is a valid answer.
- **Cost and time:** rough builder runs and elapsed time.
- **You are approving:** the one thing the operator agrees to by answering yes.

Write it as simply as possible: short sentences and everyday words, so the operator understands it on the first
read. No unit ids and no route, tier, deps or lane words. `ask-operator.sh` refuses a `plan-*` question whose plan lacks the
heading or any label (`bin/lib/plan-plain.ts` is the parser); the board shows these lines first on the question
(`facts` counted from the unit lines beside them) and folds the technical text underneath.

## The revisions section

When you change a plan the operator already approved and ask again, the plan carries `## Revisions` right under
`## In plain words`. Each approval round is one entry, newest first:

```
### Rev <N> — <YYYY-MM-DD> — <short reason>
- **What changed:** …
- **Why:** …
- **Steps touched:** …
- **Stays as approved:** …
```

- Write it for the operator, as simply as possible: short sentences, everyday words, no unit ids, no tier, deps,
  lane or route words, no file paths. Name steps by their plain titles.
- The first approval needs no entry. The first change after an approval is `Rev 2` (the plan as first approved counts as Rev 1).
- One entry per approval round. While a revision is not yet approved (the operator answered "changes: …"),
  update the newest entry instead of adding another one. Never edit an older entry after its approval.
- `squad-state.sh approve-plan` saves a copy of the approved plan beside it as `<plan>.approved.md`.
  `ask-operator.sh` refuses a `plan-*` ask for an already approved plan unless its newest entry has all four lines and
  its number is greater than the newest one in that copy (no copy: `Rev 2` or higher), and prints the note on a pass.
  `bin/lib/plan-plain.ts` (`planRevisions`, `approvedCopyPath`) is the parser; the board reads the same entry.
