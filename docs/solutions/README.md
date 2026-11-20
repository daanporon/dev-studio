# System learnings

This folder holds **dev-studio's own** learnings — durable lessons about
how the orchestration should behave (how the Studio surfaces things, how
escalations route, spawn patterns that work, responses that should change).

- **Capture** one with `ce-compound` when the operator or a standing agent hits an
  orchestration lesson the diff/instructions don't already explain.
- The **Studio** reads this folder on start, so the system applies what it has learned.
- When a learning is settled, **promote** it into the relevant `conventions/*.md`
  or role file; the entry here keeps the reasoning.

This is distinct from a *worked project's* `docs/solutions/`, which holds learnings
about that project's code. See `conventions/learnings.md`.
