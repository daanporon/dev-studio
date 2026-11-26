// permission-screen.test.ts — permission-prompt-needs-you U3: a member whose screen shows a permission menu with
// no open picker entry for two minutes gets one card and one `permission_asked` event; the card goes with the menu.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { dropAlerts, permissionScreens } from "../../bin/loop/reconcilers/alerts.ts";
import { permissionMenu } from "../../bin/loop/chat/menu.ts";
import { cardPlace } from "../../bin/board/card-place.ts";

const T = 1_800_000_000, WT = "r1::/tmp/zz-builder";
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

const CLAUDE = ` Bash command
   git push origin work
   Push the branch
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again
   3. No, and tell Claude what to do differently (esc)`;
const EDIT = ` Edit file
   notes.md
 Do you want to make this edit to notes.md?
 ❯ 1. Yes
   2. No`;
const CODEX = `  Would you like to run the following command?

  Reason: needs the network

  $ git fetch origin
    --prune
    --tags
    --quiet

› 1. Yes, proceed (y)
  2. Yes, and don't ask again (p)
  3. No, and tell Codex what to do differently (esc)`;

function rig(tail: string): Store {
  const d = mkdtempSync(join(tmpdir(), "zzloop-"));
  temps.push(d);
  const s = open(d);
  stores.push(s);
  s.upsert("squads", { project: "p", topic: "demo" }, { status: "running", updated_at: T, observed_at: T });
  s.upsert("members", { project: "p", squad: "demo", role: "builder", suffix: "u1" }, { wt: WT, status: "running", updated_at: T, observed_at: T });
  screen(s, tail);
  return s;
}
const screen = (s: Store, tail: string) => s.upsert("observed_workers", { project: "p", wt: WT }, { state: "working", tail, tail_at: T, observed_at: T });
const run = (s: Store, now: number) => permissionScreens({ store: s, project: "p", now } as never);
const events = (s: Store) => (s.db.query("SELECT payload FROM events WHERE kind = 'permission_asked'").all() as { payload: string }[]).map((r) => JSON.parse(r.payload) as Row);
const entry = (s: Store, q: Row) => s.upsert("observed_pickers", { project: "p", squad: "demo", id: "q1" }, { doc: JSON.stringify({ id: "q1", source: "picker", ...q }), observed_at: T });
// The card as alerts.json holds it, then what dropAlerts says about it at `now`.
function cleared(s: Store, card: Row, now: number): unknown[] {
  s.upsert("observed_alerts", { project: "p", id: String(card.id) }, { doc: JSON.stringify({ id: card.id, asker: "sweep", kind: card.card, ...(card.fields as Row), since: new Date(T * 1000).toISOString() }), observed_at: now });
  return dropAlerts({ store: s, project: "p", now } as never).map((a) => (a.payload as Row).why);
}

describe("a permission menu on a member's screen", () => {
  test("raises one card after the delay, not before, with one event", () => {
    const s = rig(CLAUDE);
    expect(run(s, T)).toEqual([]);
    expect(run(s, T + 119)).toEqual([]);
    const [a] = run(s, T + 120), p = a.payload as Row;
    expect(a).toMatchObject({ squad: "demo", subject: "demo.builder-u1", kind: "alert" });
    expect(p).toMatchObject({ title: "builder-u1 is waiting on a permission prompt", card: "permission_prompt", fields: { member: WT, chat_wt: WT, chat_label: "builder-u1" } });
    expect(String(p.text)).toContain("git push origin work");
    expect(String(p.text)).toContain("3. No, and tell Claude");
    expect(cardPlace({ id: p.id, kind: p.card }, T)).toBe("needs");
    // The same prompt a tick later is the same claim, and no second event.
    expect(run(s, T + 180)[0].episode).toBe(a.episode);
    expect(events(s)).toEqual([{ role: "builder-u1", via: "screen", text: expect.stringContaining("Do you want to proceed?") }]);
  });

  test("the card stays while the menu is up and goes when it leaves the screen", () => {
    const s = rig(CLAUDE);
    run(s, T);
    const card = run(s, T + 120)[0].payload as Row;
    expect(cleared(s, card, T + 2 * 86400)).toEqual([]);
    screen(s, "● Pushed.\n❯ ");
    expect(run(s, T + 200)).toEqual([]);
    expect(cleared(s, card, T + 200)).toEqual(["the screen no longer shows the prompt"]);
    // The same prompt again waits again, as a new episode.
    screen(s, CLAUDE);
    expect(run(s, T + 300)).toEqual([]);
    expect(run(s, T + 420)[0].episode).not.toBe(String(card.episode));
    expect(events(s)).toHaveLength(2);
  });

  test("an open picker entry on the worktree means no card, and clears one", () => {
    for (const q of [{ card_wt: WT }, { asker: "builder-u1" }]) {
      const s = rig(CLAUDE);
      run(s, T);
      const card = run(s, T + 120)[0].payload as Row;
      entry(s, q);
      expect(run(s, T + 500)).toEqual([]);
      expect(cleared(s, card, T + 500)).toEqual(["the prompt reached the operator as a question"]);
      entry(s, { ...q, closed: true });
      run(s, T + 600);
      expect(run(s, T + 720)).toHaveLength(1);
    }
  });

  test("the file edit form and Codex's wording raise one too", () => {
    for (const [tail, shown] of [[EDIT, "make this edit to notes.md?"], [CODEX, "Would you like to run the following command?"]]) {
      const s = rig(tail);
      run(s, T);
      expect(String((run(s, T + 120)[0].payload as Row).text)).toContain(shown);
    }
  });

  test("a gone member or a closed squad raises none", () => {
    for (const table of ["members", "squads"] as const) {
      const s = rig(CLAUDE);
      run(s, T);
      s.db.run(`UPDATE ${table} SET status = ?`, [table === "members" ? "gone" : "closed"]);
      expect(run(s, T + 120)).toEqual([]);
    }
  });

  test("a numbered list with no marker, and a menu that asks something else, raise none", () => {
    expect(permissionMenu("Do you want to proceed?\n  1. Yes\n  2. No")).toBeNull();
    expect(permissionMenu("Do you trust this folder?\n ❯ 1. Yes\n   2. No")).toBeNull();
    const s = rig("Do you want to proceed?\n  1. Yes\n  2. No");
    run(s, T);
    expect(run(s, T + 600)).toEqual([]);
  });
});
