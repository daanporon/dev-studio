# Squad types

A squad has a type, chosen at spawn: `bin/commands/spawn-squad.sh --type feature|testing`
(default `feature`). Both types use the same machinery — Run, task, state,
escalation, autonomy, board, ship mode — and differ only in the work stream
(KTD10, R20).

## Feature squad (default)

Builds a topic. The Thinker plans it in shippable units, and each Builder
builds *and* ships its unit through the project's mode (one unit = one PR).

A feature squad **may** gain a Tester — on-demand, added by the Lead when the Thinker
asks for a post-build test pass (`roles/thinker.md`); it is not auto-started the way a
testing squad's is. That Tester runs the env and files `blocking`/`minor` bugs, but
**still never fixes** (`roles/tester.md`): the Thinker plans each blocking bug as a fix
unit a Builder builds **here**, and records minor bugs as held follow-up units (KD1).
That in-place fixing is the one difference from a testing squad's Tester — a testing
squad never builds and spins its fixes out instead (below, unchanged).

## Testing squad — a triage hub, not a builder

Finds issues in a project as you test it, triages them, and **spins out independent fix
squads** — it does **not** build the fixes itself. That separation is the point: the fix
work runs in its own squad with its own run, so this squad stays free to keep testing
instead of growing Builders and plans per bug. Two issue streams feed it:

1. **The Tester** runs the project's dev environment and exercises it — it reports what it
   finds, it never fixes (see `roles/tester.md`).
2. **You, testing by hand.** Mention everything you see — send each observation
   to the squad's Run: `~/.dev-studio/bin/role/orch.sh send <squad-run> "<what you saw>" "<details>"`.
   It reaches the Lead, who coordinates the Run (on a loop root as a loop.db message row, `ds msg`).

The **Lead** routes each incoming issue (from either stream) to the **Thinker**, who
triages and root-causes it. For a confirmed bug the Thinker **proposes a fix squad**
(`squad-state propose-squad` + an approval gate), which shows on the board under this
squad; you approve it with **`/ds-approve-fix`** and the Studio spawns it independently
(`roles/thinker.md`). So a testing squad has **no Builders** — its output is triaged
proposals, and it keeps watching. It stays on the board like any other, tagged `testing`.

**A testing squad is long-lived and operator-closed.** It exists to keep running while
you test — so it **never self-closes**. The Lead does not mark it `done` or delegate a
close on its own judgment; "no open issues right now" just means it's idle-waiting for
your next observation. It stays `running` until **you** close it from the Studio
(`/ds-close-squad`). This is the key difference from a feature squad, which closes when
its topic is finished (`roles/lead.md`).

Spawn one with `bin/commands/spawn-squad.sh --repo <project> --topic <slug> --type testing`.
A testing squad always starts the Tester even if the roster marks it `ondemand`.
