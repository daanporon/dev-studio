// exposed-reconcile.test.ts — expose-hosted-services U2: the exposed reconciler ends open entries whose
// squad closed or went, whose member owner or its worktree went (scope member only), or that stayed down
// for expose_down_min minutes (R7, KTD3). Rows are ended with gone_at + gone_why and an `unexposed`
// event, never deleted. A temp state root with real worktree dirs.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reconciler from "../../bin/loop/reconcilers/exposed.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

// Squad p/t (running) with a Builder and a Tester member, each with a worktree dir.
function fixture() {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "exposed-reconcile-")); roots.push(root);
  const s = open(join(root, "state"));
  const wt = (name: string) => { const p = join(root, name); mkdirSync(p); return `r::${p}`; };
  const w = { lead: wt("lead"), builder: wt("builder"), tester: wt("tester") };
  s.upsert("squads", { project: "p", topic: "t" }, { status: "running", lead_wt: w.lead, observed_at: 1, updated_at: 1 });
  for (const [role, id] of [["builder", w.builder], ["tester", w.tester]])
    s.upsert("members", { project: "p", squad: "t", wt: id }, { role, status: "running", observed_at: 1, updated_at: 1 });
  let n = 0;
  const entry = (owner_wt: string, scope: "member" | "squad", probe?: { status: string; down_since: number | null }) => {
    const name = `e${++n}`;
    s.upsert("exposed", { project: "p", squad: "t", owner_wt, name, gone_at: null }, { role: "builder", url: "http://localhost:1", scope, updated_at: 1 });
    const id = Number((s.db.query("SELECT id FROM exposed WHERE name = ?").get(name) as Row).id);
    if (probe) s.upsert("observed_exposed", { exposed_id: id }, { status: probe.status, reach: probe.status === "up" ? "host-only" : "down", probed_at: 1, down_since: probe.down_since });
    return id;
  };
  const row = (id: number) => s.db.query("SELECT * FROM exposed WHERE id = ?").get(id) as Row;
  const run = (now: number) => reconciler.run({ store: s, project: "p", tick: 1, now, fired: [], poked: new Set() } as TickCtx);
  return { root, s, w, entry, row, run };
}
const pathOf = (wt: string) => wt.slice(wt.indexOf("::") + 2);
const unexposed = (s: Store) => s.db.query("SELECT * FROM events WHERE kind = 'unexposed' ORDER BY id").all() as Row[];

test("an entry down for expose_down_min minutes ends (down); just under does not", () => {
  const f = fixture();
  const id = f.entry(f.w.builder, "member", { status: "down", down_since: 10_000 });
  f.run(10_000 + 15 * 60 - 1);
  expect(f.row(id).gone_at).toBeNull();
  f.run(10_000 + 15 * 60);
  expect(f.row(id)).toMatchObject({ gone_why: "down" });
  expect(Number(f.row(id).gone_at)).toBeGreaterThan(0);
  const [ev] = unexposed(f.s);
  expect(JSON.parse(String(ev.payload))).toMatchObject({ id, why: "down", by: "loop" });
  expect(ev).toMatchObject({ project: "p", squad: "t", member: f.w.builder });
});

test("a re-expose restarts the down timer: the old URL's down run does not end the updated entry", () => {
  const f = fixture();
  const id = f.entry(f.w.builder, "member", { status: "down", down_since: 10_000 });
  f.s.db.run("UPDATE exposed SET url = 'http://localhost:2', updated_at = ? WHERE id = ?", [10_000 + 14 * 60, id]);
  f.run(10_000 + 20 * 60);
  expect(f.row(id).gone_at).toBeNull();
  f.run(10_000 + 14 * 60 + 15 * 60);
  expect(f.row(id).gone_why).toBe("down");
});

test("expose_down_min is read per project; an up entry never ends on the timer", () => {
  const f = fixture();
  f.s.upsert("config", { project: "p", file: "limits.conf", key: "expose_down_min" }, { value: "5", observed_at: 1 });
  const down = f.entry(f.w.builder, "member", { status: "down", down_since: 10_000 });
  const up = f.entry(f.w.builder, "member", { status: "up", down_since: null });
  const never = f.entry(f.w.builder, "member");
  f.run(10_000 + 5 * 60);
  expect(f.row(down).gone_why).toBe("down");
  expect(f.row(up).gone_at).toBeNull();
  expect(f.row(never).gone_at).toBeNull();
});

test("a member-scope entry ends when its owner member goes, and when its worktree path is removed", () => {
  const f = fixture();
  const byBuilder = f.entry(f.w.builder, "member"), byTester = f.entry(f.w.tester, "member");
  f.s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [f.w.builder]);
  rmSync(pathOf(f.w.tester), { recursive: true });
  f.run(20_000);
  expect(f.row(byBuilder).gone_why).toBe("owner-gone");
  expect(f.row(byTester).gone_why).toBe("worktree-removed");
});

test("the lead's entry (owner is the squad's lead_wt, no members row) stays open", () => {
  const f = fixture();
  const id = f.entry(f.w.lead, "member");
  f.run(20_000);
  expect(f.row(id).gone_at).toBeNull();
});

test("a squad-scope entry survives its owner and worktree going, and ends when the squad closes", () => {
  const f = fixture();
  const env = f.entry(f.w.tester, "squad"), ops = f.entry("", "squad");
  f.s.db.run("UPDATE members SET status = 'gone' WHERE wt = ?", [f.w.tester]);
  rmSync(pathOf(f.w.tester), { recursive: true });
  f.run(20_000);
  expect(f.row(env).gone_at).toBeNull();
  expect(f.row(ops).gone_at).toBeNull();
  f.s.db.run("UPDATE squads SET status = 'closed' WHERE topic = 't'");
  f.run(20_060);
  expect(f.row(env).gone_why).toBe("squad-closed");
  expect(f.row(ops).gone_why).toBe("squad-closed");
});

test("an entry whose squad row is gone ends (squad-closed); ended rows are kept and not ended twice", () => {
  const f = fixture();
  const id = f.entry("", "squad");
  f.s.db.run("DELETE FROM squads WHERE topic = 't'");
  f.run(20_000);
  f.run(20_060);
  expect(f.row(id).gone_why).toBe("squad-closed");
  expect(unexposed(f.s).length).toBe(1);
  expect((f.s.db.query("SELECT COUNT(*) AS n FROM exposed").get() as Row).n).toBe(1);
});
