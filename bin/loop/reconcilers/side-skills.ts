// side-skills.ts — side-loop-host U21 (issue #127): a side host installs the role skills its own logins lack.
// Side only (core/side-plugins.ts SIDE_ONLY: a main loop never loads it). Once a tick (host scope): while a Claude
// login folder of this host reads `broken:` (observers/state.ts), one `side.skills` action, episode = when that
// spell began and which folders are broken, so the install runs once for each such set. The side actuator runs
// bin/host/install-skills.sh in the background; a failed run is tried again after SIDE_SKILLS_RETRY_S. A folder
// still broken after a run that succeeded is not installed again: main's card (reconcilers/account-skills.ts) asks
// the operator.
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";

export const KIND = "side.skills";
const SPELL = { project: "", subject: "side-skills", kind: "side-skills" };

export function sideSkills(ctx: TickCtx): Action[] {
  if (ctx.role !== "side") return [];
  const { store, now } = ctx;
  const dirs = (store.db.query("SELECT dir FROM observed_account_folders WHERE agent = 'claude' AND skills LIKE 'broken:%' ORDER BY dir")
    .all() as { dir: string }[]).map((r) => r.dir);
  const ep = store.get("episodes", SPELL), open = !!ep && ep.ended_at == null;
  if (!dirs.length) {
    if (open) store.upsert("episodes", SPELL, { state: "closed", ended_at: now, observed_at: now });
    return [];
  }
  const started = open ? Number(ep.started_at) : now;
  if (!open) store.upsert("episodes", SPELL, { squad: null, started_at: now, ended_at: null, state: "broken", episode_key: String(now), source: "loop", observed_at: now });
  return [{ project: "", subject: "side-skills", kind: KIND, episode: `${started}|${dirs.join("|")}`, payload: { dirs } }];
}

export default { name: "side-skills", scope: "host", run: sideSkills } satisfies Reconciler;
