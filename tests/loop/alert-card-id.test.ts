// alert-card-id.test.ts — loop-cards-are-stored U1: the `alert` fulfiller stores a card under the `sweep-` id its
// reconciler gave it (so cardPlace, alertGone and the prefix clears find it); any other id keeps `loop-…`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { alertAction, dropAlerts } from "../../bin/loop/reconcilers/alerts.ts";
import fulfiller from "../../bin/loop/fulfil/alert.ts";
import { cardPlace } from "../../bin/board/card-place.ts";
import type { Action } from "../../bin/loop/core/plugins.ts";
import type { Exec } from "../../bin/loop/core/actuator.ts";

const T = 1_800_000_000, DAY = 86400;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function root(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzloop-"));
  temps.push(d);
  mkdirSync(join(d, "p", "squads"), { recursive: true });
  const s = open(d);
  stores.push(s);
  return s;
}
const stored = (s: Store): Row[] => { try { return JSON.parse(readFileSync(join(s.root, "p", "alerts.json"), "utf8")).alerts; } catch { return []; } };
async function file(s: Store, a: Action) {
  const r = await fulfiller.exec({ ...a, member: null } as never, { store: s } as unknown as Exec);
  expect(r).toMatchObject({ done: true });
  const card = stored(s).at(-1)!;
  s.upsert("observed_alerts", { project: "p", id: String(card.id) }, { doc: JSON.stringify({ ...card, asker: "sweep", since: new Date(T * 1000).toISOString() }), observed_at: T });
  return card;
}
const act = (key: string, episode: string, o: Record<string, unknown> = {}) =>
  alertAction(s0!, { project: "p", squad: null, key, episode, text: "t", option: "Seen", why: "w", title: key, ...o })[0];
let s0: Store | null = null;
const make = () => (s0 = root());

describe("a card is stored under the id its reconciler gave it", () => {
  for (const [key, place] of [["disk-pressure./", "needs"], ["account-skills.acct", "needs"], ["debrief-wrap", "needs"], ["studio.adopt", "needs"], ["studio.ctx", "needs"]] as const) {
    test(`${key}: stored id = payload id, place ${place}`, async () => {
      const s = make();
      const a = act(key, "e1");
      const card = await file(s, a);
      expect(card.id).toBe((a.payload as Row).id);
      expect(String(card.id)).toMatch(/^sweep-/);
      expect(cardPlace({ ...card, subject: key }, T + 3600)).toBe(place);
    });
  }

  test("debrief card: kept at 3 days, board gets its topic; other sweep cards still drop at a day", async () => {
    const s = make();
    await file(s, act("debrief-wrap", "e1"));
    await file(s, act("nest-drift", "e1"));
    const ctx = { store: s, project: "p", now: T + 3 * DAY } as never;
    expect(dropAlerts(ctx).map((a) => (a.payload as Row).id)).toEqual([expect.stringMatching(/^sweep-nest-drift-/)]);
  });

  test("a disk card with an open spell is kept at 3 days, cleared once the spell ends", async () => {
    const s = make();
    const card = await file(s, act("disk-pressure./", "e1"));
    s.upsert("episodes", { project: "p", subject: "disk-pressure./", kind: "disk-pressure" }, { episode_key: "k", state: "low", started_at: T, source: "loop", observed_at: T });
    const ctx = () => ({ store: s, project: "p", now: T + 3 * DAY }) as never;
    expect(dropAlerts(ctx())).toEqual([]);
    s.upsert("episodes", { project: "p", subject: "disk-pressure./", kind: "disk-pressure" }, { ended_at: T + DAY });
    expect(dropAlerts(ctx()).map((a) => (a.payload as Row).id)).toEqual([card.id]);
  });

  test("studio.ctx: a second rise after a clear still shows a card", async () => {
    const s = make();
    const first = await file(s, act("studio.ctx", "ctx|wt|1", { idEpisode: "ctx|wt" }));
    const second = await file(s, act("studio.ctx", "ctx|wt|2", { idEpisode: "ctx|wt" }));
    expect(second.id).toBe(first.id);
    expect(stored(s).filter((c) => c.id === first.id).length).toBe(1);
  });

  test("a non-sweep id keeps the loop- id", async () => {
    const s = make();
    const card = await file(s, { project: "p", squad: null, subject: "x.y", kind: "alert", episode: "e", payload: { id: "other-1", title: "t", text: "t" } } as Action);
    expect(String(card.id)).toMatch(/^loop-x\.y-/);
  });
});
