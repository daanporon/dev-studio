#!/usr/bin/env bash
# roles.sh — view and configure the squad role roster (agent + model per role).
#
#   roles.sh list [--json] [<project>]             show the effective roster (--json: with source per row)
#   roles.sh set  <project> <role> <agent> <model> [always|ondemand|elevate] [effort] [fallbacks] [plan] [up|stay]  upsert a role's row
#   roles.sh rm   <project> <role>                 drop the project's row of a role (it runs the default row, if any)
#   roles.sh reset <project> <role>                drop the project's row of a default role (it follows the default again)
#
# Columns: name agent model spawn [effort] [fallbacks] [plan] [return]. effort (5th, optional) is the model's
# reasoning effort (e.g. low|medium|high|xhigh|max); blank or `-` = the model's default.
# fallbacks (6th, optional) is an ordered `agent:model[:effort[:plan]],...` list `ds pick` tries
# when the role's own model has no free account (a missing effort = the old rule: the role's effort
# on the same agent, else the agent's default); omitted on `set` = keep the role's current list,
# `-` = none. return (8th, optional; configurable-role-elevation U1) is `up` (an idle member on a
# fallback moves back up once its row's model has room), `stay`, or `-` = inherit (the default row,
# then the base role's row, else stay); omitted on `set` = keep the row's own; `list` shows the
# resolved value as `back up`. `list --json` also returns "catalog": conventions/models.conf (the project's models.conf
# rows override it), plus one entry per muse family (MUSE_MODEL_CATALOG_DIR, default
# ~/.local/share/muse/model-catalog, *.json `.rows[]` with visibility=="visible", never hidden or
# *-contributor; the live catalog wins over models.conf on a clash, so efforts come from the
# resolved row), Codex's bundled catalog (bin/lib/codex-models.sh), plus any pair a roster already uses, as custom.
#
# The repo default is conventions/roles.conf. A per-project override is the
# project's roles.conf rows in state/loop.db (U256; it survives `git reset --hard` and
# can differ per project) and overrides per role (U267): a role it names runs the
# project's row, every other role the default's. `set` writes one role's row (no copy
# of the default); `rm`/`reset` drop it; the default is never touched.
set -euo pipefail
# U263: the work runs in TypeScript (bin/commands/roles-ts.ts); this path stays for its callers.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec env DS_ROOT="$ROOT" "$ROOT/bin/ds" roles-ts "$@"
