// event-log-filters U8: a member with early short-key rows (`builder/u1-x`, `lead`) and later worktree-id
// rows is one crew entry, and the member filter matches both forms. Temp state root.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventsLists, eventsPage } from "../../bin/board/board-data.ts";
import { open } from "../../bin/loop/core/store.ts";

const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "evcrew-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const T0 = 1_800_000_000, U = "0a1b2c3d-0000-4000-8000-00000000d3a0";
const B = `${U}::/x/ds-p-builder-u1-x-sq`, L = `${U}::/x/ds-p-lead-sq`;
{
  const s = open(root);
  const ev = (at: number, member: string | null, kind: string) =>
    s.db.run("INSERT INTO events (at, project, squad, member, kind, payload) VALUES (?, 'p', 'sq', ?, ?, '{}')", [at, member, kind]);
  const mem = (w: string, role: string, suffix: string, status: string) =>
    s.db.run("INSERT INTO members (project, squad, wt, role, suffix, status, want, observed_at, updated_at) VALUES ('p', 'sq', ?, ?, ?, ?, 'running', ?, ?)", [w, role, suffix, status, T0, T0]);
  s.db.run("INSERT INTO squads (project, topic, status, observed_at, updated_at) VALUES ('p', 'sq', 'running', ?, ?)", [T0, T0]);
  mem(L, "lead", "", "running"); mem(B, "builder", "u1-x", "gone");
  ev(T0 + 1, "builder/u1-x", "member_requested"); ev(T0 + 2, "builder/u1-x", "member_started");
  ev(T0 + 3, "lead", "member_started"); ev(T0 + 4, B, "message_sent"); ev(T0 + 5, L, "tick_slow");
  ev(T0 + 6, "researcher/z", "member_requested");   // no members row: stays alone
  s.close();
}

test("crew: short key and worktree id fold into one entry; a key with no members row stays alone", () => {
  const crew = (eventsLists({ project: "p", squad: "sq" }, root) as any).crew;
  expect(crew).toEqual([
    { wt: L, name: "lead", gone: false },
    { wt: B, name: "builder-u1-x", gone: true },
    { wt: "researcher/z", name: "researcher/z", gone: true },
  ]);
});

test("member filter by worktree id also returns the short-key rows", () => {
  const kinds = (m: string) => (eventsPage({ project: "p", squad: "sq", member: m }, root) as any).events.map((e: any) => e.kind).sort();
  expect(kinds(B)).toEqual(["member_requested", "member_started", "message_sent"]);
  expect(kinds(L)).toEqual(["member_started", "tick_slow"]);
  expect(kinds("researcher/z")).toEqual(["member_requested"]);
});
