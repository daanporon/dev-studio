# Dependencies and ordering

Work order within a squad is explicit and owned by the Lead, so nothing with an unmet
prerequisite starts (R21).

## Within a squad — the Lead

The Lead owns intra-squad order, from the Thinker's plan (`roles/lead.md`):

- **Independent units run in parallel.** The Lead fans out one Builder per independent
  unit (`bin/commands/add-role.sh <project> <topic> builder u<N> --spec …`), so work that *can*
  happen at once does — no single-Builder bottleneck.
- **Dependent units wait.** The Lead starts a unit's Builder only once the units it
  depends on have finished, by holding the spawn.
- **The Lead follows up** on every Builder it started until the plan is done.

Cross-squad merge-gating is out of scope: dev-studio has no Dispatcher and no cross-squad
dependency gate. If one topic genuinely must land before another, spawn the second squad
after the first has merged — the operator sequences that from the Studio.
