// migrate-host.test.ts — U18: a live agent's write under the first migration is not lost. The rest of
// the switch runs for real in tests/install.sh; a write at an exact step needs the hook only this can pass.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportForRollback, render } from "../../bin/loop/db/export-json.ts";
import { migrate, reconcile } from "../../bin/loop/db/migrate-host.ts";
import { open } from "../../bin/loop/core/store.ts";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const LONG_AGO = new Date(1_700_000_000_000);
const doc = (topic: string, slugs: string[]) => ({ topic, status: "running", type: "feature", lead_wt: "wt", members: [],
  units: slugs.map((slug) => ({ slug, status: "dispatched", deps: [], hold: false })) });

function host(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "migrate-host-")), dir = join(root, "alpha", "squads"), file = join(dir, "t.json");
  roots.push(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, render(doc("t", ["u1"])));
  utimesSync(file, LONG_AGO, LONG_AGO);   // so the agent's write below is newer on any clock
  return { root, file };
}

function unitsAfter(root: string): { slugs: unknown[]; reimported: number } {
  const store = open(root);
  try {
    return {
      slugs: (store.db.query("SELECT slug FROM units WHERE project = 'alpha' ORDER BY slug").all() as { slug: unknown }[]).map((r) => r.slug),
      reimported: (store.db.query("SELECT count(*) n FROM events WHERE kind = 'squad_reimported'").get() as { n: number }).n,
    };
  } finally { store.close(); }
}

for (const step of ["json", "boards", "import", "mark-tmp"]) {
  test(`an agent's write after the '${step}' step reaches the rows`, () => {
    const { root, file } = host();
    migrate(root, (s) => { if (s === step) writeFileSync(file, render(doc("t", ["u1", "u2"]))); });
    expect(unitsAfter(root)).toEqual({ slugs: ["u1", "u2"], reimported: 1 });
    expect(JSON.parse(readFileSync(file, "utf8")).units).toHaveLength(2);
  });
}

test("a migration nobody wrote under imports each squad once", () => {
  const { root } = host();
  migrate(root, () => {});
  expect(unitsAfter(root)).toEqual({ slugs: ["u1"], reimported: 0 });
});

test("an installed host carries runtime files to loop without replacing newer data", () => {
  const { root } = host();
  migrate(root, () => {});
  const old = join(root, "alpha", "sweep"), dest = join(root, "alpha", "loop");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "limited.json"), '[{"wt":"limited-worker"}]\n');
  writeFileSync(join(old, "squad-spent.tsv"), "closed\t1\t900\t0\t0\t0\t900\t1\n");
  writeFileSync(join(old, "t.poke"), "historical marker");
  migrate(root, () => {});
  expect(readFileSync(join(dest, "limited.json"), "utf8")).toBe('[{"wt":"limited-worker"}]\n');
  expect(readFileSync(join(dest, "squad-spent.tsv"), "utf8")).toContain("900");
  expect(existsSync(join(dest, "t.poke"))).toBe(false);
  writeFileSync(join(dest, "limited.json"), "[]\n");
  migrate(root, () => {});
  expect(readFileSync(join(dest, "limited.json"), "utf8")).toBe("[]\n");
  expect(readFileSync(join(old, "limited.json"), "utf8")).toContain("limited-worker");
});

// The rollback's way out: main's scripts own the files from the checkout on.
function rolledBack(): { root: string; file: string; store: ReturnType<typeof open> } {
  const { root, file } = host();
  migrate(root, () => {});
  const store = open(root);
  store.db.run("UPDATE units SET status = 'late' WHERE project = 'alpha'");
  return { root, file, store };
}
const unitStatus = (file: string) => JSON.parse(readFileSync(file, "utf8")).units[0].status;

test("the rollback's export writes rows no tick exported", () => {
  const { file, store } = rolledBack();
  expect(exportForRollback(store).written).toEqual([file]);
  store.close();
  expect(unitStatus(file)).toBe("late");
});

test("the rollback's export keeps a file written since the last export, and leaves the stamp", () => {
  const { file, store } = rolledBack();
  const stamp = store.get("squads", { project: "alpha", topic: "t" })?.exported_ms;
  writeFileSync(file, render(doc("t", ["u1", "main"])));
  expect(exportForRollback(store).kept).toEqual([file]);
  expect(store.get("squads", { project: "alpha", topic: "t" })?.exported_ms).toBe(stamp);
  store.close();
  expect(JSON.parse(readFileSync(file, "utf8")).units.map((u: { slug: string }) => u.slug)).toEqual(["u1", "main"]);
});

test("the rollback's export does not bring back a file that went", () => {
  const { file, store } = rolledBack();
  rmSync(file);
  expect(exportForRollback(store).kept).toEqual([file]);
  store.close();
  expect(existsSync(file)).toBe(false);
});

test("the rollback's export writes a squad that never had a file", () => {
  const { file, store } = rolledBack();
  rmSync(file);
  store.db.run("UPDATE squads SET exported_ms = NULL WHERE project = 'alpha'");
  expect(exportForRollback(store).written).toEqual([file]);
  store.close();
  expect(unitStatus(file)).toBe("late");
});

// What the loop held when it left for a rollback does not run at the re-switch; what came later does.
function queuedHost() {
  const { root, file, store } = rolledBack();
  const replay = (kind: string) => JSON.stringify({ kind, key: kind, argv: [`/x/${kind}.sh`] });
  const wish = (want_at: number, kind: string, result: string | null = null, payload: string | null = replay(kind)) => {
    const id = Number(store.db.run("INSERT INTO members (project, squad, role, suffix, want, want_payload, want_at, want_result, observed_at, updated_at) VALUES ('alpha', 't', ?, '', 'running', ?, ?, ?, 1, 1)",
      [kind, payload, want_at, result]).lastInsertRowid);
    return id;
  };
  const exit = 1_000_000;
  store.db.run("INSERT INTO events (at, kind, payload) VALUES (?, 'loop_exit', '{}')", [exit]);
  const ids = {
    waiting: wish(exit - 10, "add-role"), retrying: wish(exit - 9, "set-role", "retrying: exit 1"), finished: wish(exit - 8, "old-role", "done: ok"),
    afterwards: wish(exit + 1, "new-role"), plain: wish(exit - 7, "builder", null, null),
  };
  store.db.run("INSERT INTO episodes (project, subject, kind, state, episode_key, source, observed_at, next_at, action) VALUES ('alpha', 'role:add-role', 'action:role', 'pending', ?, 'loop', 1, 2, '{}')", [`want:${exit - 10}`]);
  store.db.run("INSERT INTO episodes (project, subject, kind, state, episode_key, source, observed_at, next_at, action) VALUES ('alpha', 'board:alpha', 'action:board', 'pending', ?, 'loop', 1, 2, '{}')", [`want:${exit - 10}`]);
  const req = (at: number) => Number(store.db.run("INSERT INTO requests (project, squad, kind, created_at) VALUES ('alpha', 't', 'message', ?)", [at]).lastInsertRowid);
  const before = req(exit - 5), after = req(exit + 5);
  const fromFile = Number(store.db.run("INSERT INTO requests (project, squad, kind, key, payload, created_at) VALUES ('alpha', 't', 'switch', 'file:r1', '{\"file\":\"alpha/squads/t.json\"}', ?)", [exit - 5]).lastInsertRowid);
  store.db.run("INSERT INTO episodes (project, subject, kind, state, episode_key, source, observed_at, next_at, action) VALUES ('alpha', ?, 'action:message', 'pending', ?, 'loop', 1, 2, '{}')", [`req:${before}`, `req:${before}`]);
  return { root, file, store, ids, before, after, fromFile };
}

test("the re-switch gives up what the loop held at the rollback, and only that", () => {
  const { root, store, ids, before, after, fromFile } = queuedHost();
  store.close();
  migrate(root, () => {});
  const db = open(root), result = (id: number) => (db.db.query("SELECT want_result r FROM members WHERE id = ?").get(id) as { r: string | null }).r;
  expect(result(ids.waiting)).toStartWith("failed: queued before a rollback");
  expect(result(ids.retrying)).toStartWith("failed: queued before a rollback");
  expect(result(ids.finished)).toBe("done: ok");
  expect(result(ids.afterwards)).toBeNull();
  expect(result(ids.plain)).toBeNull();
  const episodes = db.db.query("SELECT kind, state, ended_at IS NOT NULL ended, action IS NULL gone FROM episodes WHERE kind LIKE 'action:%' ORDER BY id").all();
  expect(episodes).toEqual([{ kind: "action:role", state: "failed", ended: 1, gone: 1 }, { kind: "action:board", state: "pending", ended: 0, gone: 0 },
    { kind: "action:message", state: "failed", ended: 1, gone: 1 }]);   // the board's action only shares the second
  const req = (id: number) => db.db.query("SELECT done_at IS NOT NULL done FROM requests WHERE id = ?").get(id) as { done: number };
  expect(req(before).done).toBe(1);
  expect(req(after).done).toBe(0);
  expect(req(fromFile).done).toBe(0);
  const event = db.db.query("SELECT payload FROM events WHERE kind = 'queued_given_up'").all() as { payload: string }[];
  expect(event).toHaveLength(1);
  expect(JSON.parse(event[0].payload).queued.map((q: { what: string }) => q.what)).toEqual(["add-role", "set-role", "message"]);
  db.close();
});

test("a host with no rollback gives nothing up", () => {
  const { root, store, ids } = queuedHost();
  store.db.run("DELETE FROM events WHERE kind = 'loop_exit'");
  store.close();
  migrate(root, () => {});
  const db = open(root);
  expect((db.db.query("SELECT want_result r FROM members WHERE id = ?").get(ids.waiting) as { r: string | null }).r).toBeNull();
  db.close();
});

function switchedHost(): { root: string; file: string; marker: string; lock: string } {
  const { root, file } = host();
  migrate(root, () => {});
  writeFileSync(file, render(doc("t", ["u1", "u2"])));
  const marker = join(root, ".loop-reconcile");
  writeFileSync(marker, "");
  return { root, file, marker, lock: join(root, ".sweep.lock") };
}

test("the loop starts from the files when the rows may be behind", () => {
  const { root, marker, lock } = switchedHost();
  expect(reconcile(root)).toBe(true);
  expect(unitsAfter(root).slugs).toEqual(["u1", "u2"]);
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(lock)).toBe(false);
});

test("without the file a loop trusts its rows: a hand edit is not imported", () => {
  const { root, marker } = switchedHost();
  rmSync(marker);
  expect(reconcile(root)).toBe(true);
  expect(unitsAfter(root).slugs).toEqual(["u1"]);
});
