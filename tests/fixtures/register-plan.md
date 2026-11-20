# Fixture plan for tests/squad-state.sh (register-plan)

Prose that names U4 is not a unit line. U4 gains one item.

### U1. A heading is not a unit line

## Units

- U1 — `work-units "hide finished"` toggle — deps: none — Tier: standard
  Scope: an indented scope line, not a unit line.
- U2 — [ABC-12] Board shows untagged tier — deps: U1 (stacked on U1's branch) — Tier: hard
U3 -- dep-less docs work -- deps: -- Tier: standard (HELD)
* U24b — parser edge case — DEPS: U2, U3 — tier: Hard because it parses
