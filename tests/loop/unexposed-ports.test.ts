// unexposed-ports.test.ts — exposed-cleanup U3: a port a member listens on that no `ds expose` entry of its
// squad covers, for expose_warn_min minutes, is named to that member once in a message row; covered ports
// (an entry's URL port or its --ports), young ports, a done squad and expose_warn_min 0 give nothing.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import reconciler from "../../bin/loop/reconcilers/unexposed.ts";
import { suggestName, unexposedPorts } from "../../bin/loop/squad/unexposed.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { open, type Row } from "../../bin/loop/core/store.ts";

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

const T0 = 100_000;
function fixture() {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "unexposed-ports-")); roots.push(root);
  const s = open(join(root, "state"));
  s.upsert("squads", { project: "p", topic: "t" }, { status: "running", lead_wt: "r::/w/lead", observed_at: 1, updated_at: 1 });
  const member = (wt: string, role: string, suffix = "") => {
    s.upsert("members", { project: "p", squad: "t", wt }, { role, suffix, status: "running", observed_at: 1, updated_at: 1 });
    return Number((s.db.query("SELECT id FROM members WHERE wt = ? ORDER BY id DESC").get(wt) as Row).id);
  };
  const listen = (wt: string, ports: { port: number; since: number; comm?: string; src?: string; pid?: number | null; addr?: string }[]) =>
    s.upsert("observed_procs", { project: "p", wt }, { procs: 1, observed_at: 1, listen: JSON.stringify(ports.map((p) =>
      ({ addr: "loopback", pid: 4242, comm: "vite", src: "proc", ...p }))) });
  const expose = (url: string, ports: number[] | null = null, gone_at: number | null = null) =>
    s.upsert("exposed", { project: "p", squad: "t", owner_wt: "r::/w/b", name: url, gone_at }, { role: "builder", url, scope: "member",
      ports: ports ? JSON.stringify(ports) : null, updated_at: 1 });
  const run = (now: number) => reconciler.run({ store: s, project: "p", tick: 1, now, fired: [], poked: new Set() } as TickCtx);
  const msgs = () => s.db.query("SELECT * FROM messages ORDER BY id").all() as Row[];
  return { s, member, listen, expose, run, msgs };
}

test("covered by an entry's URL port or --ports, or younger than expose_warn_min: not kept", () => {
  const f = fixture();
  f.member("r::/w/b", "builder", "u3");
  f.listen("r::/w/b", [{ port: 5173, since: T0 }, { port: 5432, since: T0 }, { port: 8080, since: T0 }, { port: 9000, since: T0 + 60 }, { port: 7000, since: T0 }]);
  f.expose("http://localhost:5173/app");
  f.expose("http://127.0.0.1:8080", [5432]);
  f.expose("http://127.0.0.1:7000", null, T0);   // ended: covers nothing
  const got = unexposedPorts(f.s.db, "p", "t", T0 + 5 * 60, 5);
  expect(got.map((u) => u.port)).toEqual([7000]);
  expect(got[0]).toMatchObject({ wt: "r::/w/b", role: "builder", suffix: "u3", comm: "vite", since: T0 });
});

test("one message per member with the exact command; a port is never named twice; a new port is", () => {
  const f = fixture();
  f.member("r::/w/b", "builder", "u3");
  f.member("r::/w/t", "tester");
  f.listen("r::/w/b", [{ port: 3000, since: T0 }, { port: 5432, since: T0, comm: "stack-db", src: "docker", pid: null, addr: "any" }]);
  f.listen("r::/w/t", [{ port: 4000, since: T0, comm: "node" }]);
  f.run(T0 + 5 * 60 - 1);
  expect(f.msgs()).toEqual([]);
  f.run(T0 + 5 * 60);
  const [b, t] = f.msgs();
  expect(b).toMatchObject({ to_role: "builder", to_suffix: "u3", from_role: "loop", needs_reply: 0, subject: "Not exposed: ports 3000, 5432" });
  expect(String(b.body)).toContain('ds expose vite-3000 http://127.0.0.1:3000 --stop "<command that stops it>"');
  expect(String(b.body)).toContain('ds expose stack-db-5432 http://127.0.0.1:5432 --stop "docker stop stack-db"');
  expect(String(b.body)).toContain("--ports");
  expect(String(b.body)).toContain("--self");
  expect(t).toMatchObject({ to_role: "tester", subject: "Not exposed: port 4000" });
  expect(String(t.body)).toContain("ds expose node-4000 http://127.0.0.1:4000 --squad --stop");
  f.run(T0 + 15 * 60);
  expect(f.msgs()).toHaveLength(2);
  f.listen("r::/w/b", [{ port: 3000, since: T0 }, { port: 6000, since: T0 + 60 }]);
  f.run(T0 + 15 * 60);
  expect(f.msgs()).toHaveLength(3);
  expect(f.msgs()[2]).toMatchObject({ to_role: "builder", subject: "Not exposed: port 6000" });
});

test("a new member on another worktree is told about the same port again; a restart on the same worktree is not", () => {
  const f = fixture();
  f.member("r::/w/b", "builder", "u3");
  f.listen("r::/w/b", [{ port: 3000, since: T0 }]);
  f.run(T0 + 600);
  f.s.db.run("UPDATE members SET status = 'running', updated_at = 5 WHERE wt = 'r::/w/b'");   // restarted in place: same row
  f.run(T0 + 700);
  expect(f.msgs()).toHaveLength(1);
  f.s.db.run("UPDATE members SET status = 'gone' WHERE wt = 'r::/w/b'");
  f.member("r::/w/b2", "builder", "u3");
  f.listen("r::/w/b2", [{ port: 3000, since: T0 }]);
  f.run(T0 + 800); f.run(T0 + 900);
  expect(f.msgs()).toHaveLength(2);
});

test("the Lead (by the squad's lead_wt) is told too", () => {
  const f = fixture();
  f.listen("r::/w/lead", [{ port: 8000, since: T0 }]);
  f.run(T0 + 600); f.run(T0 + 900);
  expect(f.msgs()).toHaveLength(1);
  expect(f.msgs()[0]).toMatchObject({ to_role: "lead", to_suffix: "" });
});

test("expose_warn_min 0 turns it off; a done squad gets nothing", () => {
  const f = fixture();
  f.member("r::/w/b", "builder", "u3");
  f.listen("r::/w/b", [{ port: 3000, since: T0 }]);
  f.s.db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES ('p', 'limits.conf', 'expose_warn_min', '0', 1)");
  f.run(T0 + 3600);
  expect(f.msgs()).toEqual([]);
  f.s.db.run("DELETE FROM config WHERE key = 'expose_warn_min'");
  f.s.db.run("UPDATE squads SET status = 'done'");
  f.run(T0 + 3600);
  expect(f.msgs()).toEqual([]);
  expect(unexposedPorts(f.s.db, "p", "t", T0 + 3600, 5)).toEqual([]);
});

test("suggested names are names ds expose accepts", () => {
  expect(suggestName("node", 3000)).toBe("node-3000");
  expect(suggestName("(sd-pam)", 1)).toBe("sd-pam--1");
  expect(suggestName("", 9)).toBe("port-9");
});
