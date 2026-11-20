import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { clearOrphanIntents, intents, paused } from "../../bin/loop/pause/pause.ts";
import pauseResume from "../../bin/loop/reconcilers/pause-resume.ts";

const roots: string[] = [], stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) try { s.close(); } catch {} for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// The acme shape: u2 paused then cancelled (Builder gone), a live paused u3, and a squad-scope pause elsewhere.
function acme() {
  const root = mkdtempSync(join(tmpdir(), "pause-orphan-")); roots.push(root);
  const s = open(root); stores.push(s);
  s.upsert("projects", { label: "p" }, { observed_at: 1 });
  for (const q of ["one", "two"]) s.upsert("squads", { project: "p", topic: q }, { status: "running", run_id: `run_${q}`, observed_at: 1, updated_at: 1 });
  for (const [slug, want, status, ust] of [["u2", "gone", "gone", "cancelled"], ["u3", "running", "running", "dispatched"]]) {
    s.upsert("members", { project: "p", squad: "one", role: "builder", suffix: slug }, { wt: `wt_${slug}`, status, want, observed_at: 1, updated_at: 1 });
    s.upsert("units", { project: "p", squad: "one", slug }, { status: ust, builder_wt: `wt_${slug}`, observed_at: 1, updated_at: 1 });
    s.upsert("pause_intents", { scope: "member", project: "p", squad: "one", role: "builder", suffix: slug, source: "manual" }, { generation: "g", requested_at: 1 });
  }
  s.upsert("pause_intents", { scope: "squad", project: "p", squad: "two", role: "", suffix: "", source: "manual" }, { generation: "g", requested_at: 1 });
  return s;
}
const t = (suffix: string) => ({ project: "p", squad: "one", role: "builder", suffix });

test("a gone member's or cancelled unit's member intent is cleared with one event; live and squad scope are left", () => {
  const s = acme();
  expect(clearOrphanIntents(s, "p", 100)).toBe(1);
  expect(intents(s, t("u2"))).toHaveLength(0);
  expect(paused(s, t("u3"))).toBe(true);
  expect(s.db.query("SELECT 1 FROM pause_intents WHERE scope='squad' AND cleared_at IS NULL").all()).toHaveLength(1);
  const ev = s.db.query("SELECT payload FROM events WHERE kind = 'pause_cleared'").all() as { payload: string }[];
  expect(ev).toHaveLength(1);
  expect(JSON.parse(ev[0].payload).why).toBe("member gone");
  expect(clearOrphanIntents(s, "p", 101)).toBe(0);
});

test("a cancelled unit whose member is still listed clears as unit cancelled; the next tick does it via the reconciler", () => {
  const s = acme();
  s.upsert("members", { project: "p", squad: "one", role: "builder", suffix: "u2" }, { want: "running", status: "running" });
  pauseResume.run({ store: s, project: "p", now: 100 } as never);
  expect(intents(s, t("u2"))).toHaveLength(0);
  const ev = s.db.query("SELECT payload FROM events WHERE kind = 'pause_cleared'").all() as { payload: string }[];
  expect(JSON.parse(ev[0].payload).why).toBe("unit cancelled");
});
