// disk-pressure.ts — a disk running low gets a Studio alert (disk-pressure U3).
//
// observed_machine.disks (bin/loop/observers/machine.ts) lists each filesystem's total and free space. Per
// project, per disk, ONE alert per low spell:
//   - free share below the project limit disk_card_free_pct (default 20; 0 = off) opens a spell (a
//     `disk-pressure` episode on subject disk-pressure.<path>) and raises one alert through alertAction. Its
//     id is sweep-disk-pressure.<path>-<cksum of the spell>; the title is `Disk <path> low: <free> free (<pct>%)`.
//   - the card names at most 8 consumers, biggest first (squad/disk-pressure.ts: Docker, the live Host tidy
//     rows, disk_watch_paths), and what to do. It deletes nothing and offers one option.
//   - the spell stays open until free space is back above the limit plus 5 points (no flapping), or the limit
//     is 0, or the disk is no longer listed. The alert clears through the alerts reconciler's alertGone.
//   - a later low spell opens a new spell with a new alert id (the idEpisode pattern).
import type { Action, Reconciler, TickCtx } from "../core/plugins.ts";
import { alertAction } from "./alerts.ts";
import { KIND, MARGIN_PCT, consumerLine, consumers, disksOf, keyOf, limitOf, pctText, titleOf } from "../squad/disk-pressure.ts";

const WHAT_TO_DO = "What to do: `docker builder prune` for the build cache, the Host tidy card for old worktrees and caches, and cleanup_tmp_globs / cleanup_trim_globs to let the loop clear a cache folder.";

export function diskPressure(ctx: TickCtx): Action[] {
  const { store, project, now } = ctx, out: Action[] = [];
  const limit = limitOf(store, project), disks = disksOf(store), seen = new Set<string>();
  for (const d of disks) {
    seen.add(d.path);
    const key = keyOf(d.path), spell = { project, subject: key, kind: KIND };
    const ep = store.get("episodes", spell), open = !!ep && ep.ended_at == null;
    const low = limit > 0 && d.free_pct < limit;
    if (!open && !low) continue;
    if (open && (limit === 0 || d.free_pct > limit + MARGIN_PCT)) {
      store.upsert("episodes", spell, { state: "closed", ended_at: now, observed_at: now });
      continue;
    }
    let started = Number(ep?.started_at ?? now);
    if (!open) {
      started = now;
      store.upsert("episodes", spell, { squad: null, started_at: now, ended_at: null, state: "low", episode_key: String(now), source: "loop", observed_at: now });
    }
    const list = consumers(store).map((c, i) => `${i + 1}. ${consumerLine(c)}`);
    const episode = `disk|${d.path}|${started}`;
    out.push(...alertAction(store, { project, squad: null, key, episode, idEpisode: episode, title: titleOf(d),
      text: `${titleOf(d)}. ${list.length ? `Biggest consumers: ${list.join("; ")}.` : "No consumer sizes read yet."} ${WHAT_TO_DO} Nothing is deleted for you; the card clears once free space is back above ${limit + MARGIN_PCT}%.`,
      option: "ok — I'm freeing space", why: `free ${pctText(d)} < ${limit}% (disk_card_free_pct); the card clears above ${limit + MARGIN_PCT}%` }));
  }
  // A disk no longer listed ends its spell.
  for (const s of store.db.query("SELECT subject FROM episodes WHERE project = ? AND kind = ? AND ended_at IS NULL").all(project, KIND) as { subject: string }[]) {
    if (seen.has(s.subject.slice(keyOf("").length))) continue;
    store.upsert("episodes", { project, subject: s.subject, kind: KIND }, { state: "closed", ended_at: now, observed_at: now });
  }
  return out;
}

export default {
  name: "disk-pressure",
  run(ctx: TickCtx) { return diskPressure(ctx); },
} satisfies Reconciler;
