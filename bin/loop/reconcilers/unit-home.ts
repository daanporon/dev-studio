// unit-home.ts — a unit follows its Builder's live worktree (U213). A resume (or any start into a new
// worktree the member had no record of) leaves `units.builder_wt` naming a worktree that no member
// holds any more, and liveness, lifecycle, alerts, pause and cancel all look the Builder up by it.
// For a unit of a live squad whose `builder_wt` belongs to no live member: when exactly one live
// Builder member of the squad has the unit's slug as its `suffix`, the unit is pointed at that
// member's worktree (event `unit_builder_moved` {old, new}). No match, or more than one: nothing.
// A start into a new worktree that replaces a known one moves its units in fulfil/member.ts.
import type { Reconciler } from "../core/plugins.ts";
import type { Row } from "../core/store.ts";
import { liveSquads } from "./liveness.ts";

const unitHome: Reconciler = {
  name: "unit-home",
  run({ store, project }) {
    for (const sq of liveSquads(store, project)) {
      const topic = String(sq.topic);
      const live = store.db.query("SELECT role, suffix, wt FROM members WHERE project = ? AND squad = ? AND wt IS NOT NULL AND COALESCE(status, '') NOT IN ('gone', 'suspended')")
        .all(project, topic) as Row[];
      const held = new Set(live.map((m) => String(m.wt)));
      const units = store.db.query("SELECT id, slug, builder_wt FROM units WHERE project = ? AND squad = ? AND builder_wt IS NOT NULL AND builder_wt != '' AND COALESCE(status, '') NOT IN ('done', 'cancelled')")
        .all(project, topic) as Row[];
      const moved = new Map<string, string>();   // old worktree -> the Builder's, for units that shared it
      const move = (u: Row, old: string, wt: string) => store.tx(() => {
        if (!store.setIf("units", Number(u.id), "builder_wt", wt, old)) return;
        store.event("unit_builder_moved", { project, squad: topic, unit: String(u.slug), payload: { old, new: wt } });
      });
      for (const u of units) {
        const old = String(u.builder_wt);
        if (held.has(old)) continue;
        const mine = live.filter((m) => m.role === "builder" && m.suffix === u.slug);
        if (mine.length !== 1) continue;
        moved.set(old, String(mine[0].wt));
        move(u, old, String(mine[0].wt));
      }
      // A shared Builder (two units, one worktree): the units its slug does not name follow too.
      for (const u of units) {
        const old = String(u.builder_wt), wt = moved.get(old);
        if (wt && !held.has(old)) move(u, old, wt);
      }
    }
    return [];
  },
};
export default unitHome;
