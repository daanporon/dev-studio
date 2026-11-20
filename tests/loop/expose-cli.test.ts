// expose-cli.test.ts — expose-hosted-services U1: `ds expose`, `ds unexpose` and `ds exposed` record, end
// and list entries owned by the member whose worktree runs them (R1–R5), and migration 0038 applies on an
// empty and on an existing db. Real `bin/ds` runs in temp git worktrees against a temp state root.
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, open, type Row } from "../../bin/loop/core/store.ts";

const DS = join(import.meta.dir, "../../bin/ds");
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

// A state root with squad p/t: its Lead, a Builder (suffix u1) and a Tester, each a git worktree dir;
// plus a plain git repo no member owns and the Studio's worktree (named like ds-p-studio).
function fixture() {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "expose-cli-")); roots.push(root);
  const state = join(root, "state");
  const dir = (name: string) => { const p = join(root, name); mkdirSync(p); Bun.spawnSync(["git", "init", "-q", p]); return p; };
  const wt = { lead: dir("ds-p-lead-t"), builder: dir("ds-p-builder-u1-t"), tester: dir("ds-p-tester-t"), other: dir("elsewhere"), studio: dir("ds-p-studio") };
  const s = open(state);
  s.upsert("squads", { project: "p", topic: "t" }, { status: "running", lead_wt: `r::${wt.lead}`, observed_at: 1, updated_at: 1 });
  s.upsert("squads", { project: "p", topic: "other" }, { status: "running", observed_at: 1, updated_at: 1 });
  for (const [role, suffix, path] of [["lead", "", wt.lead], ["builder", "u1", wt.builder], ["tester", "", wt.tester]])
    s.upsert("members", { project: "p", squad: "t", wt: `r::${path}` }, { role, suffix, status: "running", observed_at: 1, updated_at: 1 });
  s.close();
  const ds = (cwd: string, args: string[], env: Record<string, string> = {}) => {
    const o = Bun.spawnSync([DS, ...args], { cwd, env: { ...process.env, DS_STATE_ROOT: state, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: o.exitCode, out: o.stdout.toString(), err: o.stderr.toString() };
  };
  const rows = (): Row[] => { const s = open(state); try { return s.db.query("SELECT * FROM exposed ORDER BY id").all() as Row[]; } finally { s.close(); } };
  const events = (kind: string): Row[] => { const s = open(state); try { return s.db.query("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[]; } finally { s.close(); } };
  return { root, state, wt, ds, rows, events };
}

test("expose from a member worktree records its project, squad, role and suffix", () => {
  const f = fixture();
  const r = f.ds(f.wt.builder, ["expose", "preview", "http://localhost:5173", "--note", "vite"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ project: "p", squad: "t", role: "builder", suffix: "u1", name: "preview", url: "http://localhost:5173", note: "vite", scope: "member", gone_at: null });
  const [row] = f.rows();
  expect(row).toMatchObject({ owner_wt: `r::${f.wt.builder}`, scope: "member" });
  expect(Number(row.created_at)).toBeGreaterThan(0);
  const [ev] = f.events("exposed");
  expect(ev).toMatchObject({ project: "p", squad: "t", member: `r::${f.wt.builder}` });
  expect(JSON.parse(String(ev.payload))).toMatchObject({ name: "preview", scope: "member", role: "builder" });
});

test("the same name again updates the open entry; --squad sets the scope", () => {
  const f = fixture();
  expect(f.ds(f.wt.tester, ["expose", "console", "http://localhost:21300"], { DS_NOW: "1000" }).code).toBe(0);
  expect(f.ds(f.wt.tester, ["expose", "console", "http://localhost:21301", "--squad", "--note", "slot 2"], { DS_NOW: "2000" }).code).toBe(0);
  const rows = f.rows();
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ url: "http://localhost:21301", scope: "squad", note: "slot 2", updated_at: 2000, role: "tester" });
  // A second owner with the same name is a second entry.
  expect(f.ds(f.wt.builder, ["expose", "console", "http://localhost:4000"]).code).toBe(0);
  expect(f.rows().length).toBe(2);
});

test("outside a role worktree it needs --project/--topic, and the squad owns the entry", () => {
  const f = fixture();
  const r = f.ds(f.wt.other, ["expose", "web", "http://localhost:8080"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("--project <label> --topic <slug>");
  expect(f.ds(f.root, ["expose", "web", "http://localhost:8080"]).code).toBe(2);
  expect(f.rows()).toEqual([]);
  const ok = f.ds(f.wt.other, ["expose", "web", "http://localhost:8080", "--project", "p", "--topic", "t"]);
  expect(ok.code).toBe(0);
  expect(f.rows()[0]).toMatchObject({ role: "operator", scope: "squad", owner_wt: "", project: "p", squad: "t" });
  expect(f.ds(f.wt.other, ["expose", "web", "http://localhost:8080", "--project", "p", "--topic", "nope"]).code).toBe(1);
  // The Studio's worktree names the project; the owner is the studio.
  expect(f.ds(f.wt.studio, ["expose", "notes", "http://localhost:9000", "--topic", "t"]).code).toBe(0);
  expect(f.rows()[1]).toMatchObject({ role: "studio", scope: "squad", owner_wt: "" });
  // A member cannot write into another squad.
  const cross = f.ds(f.wt.builder, ["expose", "x", "http://localhost:1", "--project", "p", "--topic", "other"]);
  expect(cross.code).toBe(2);
  expect(cross.err).toContain("name another squad");
});

test("bad urls, names and notes are refused with exit 2 and write nothing", () => {
  const f = fixture();
  for (const [name, url, note] of [
    ["x", "ftp://x"], ["x", "javascript:alert(1)"], ["x", "http://"], ["x", "http:///path"], ["x", "http://u:p@host:1"],
    ["x", "http://u@host:1"], ["x", "localhost:8080"], ["x", "http://a b"], ["-x", "http://localhost:1"], ["", "http://localhost:1"],
    ["a".repeat(41), "http://localhost:1"], ["x", "http://localhost:1", "n".repeat(201)],
  ] as [string, string, string?][]) {
    const r = f.ds(f.wt.builder, ["expose", name, url, ...(note ? ["--note", note] : [])]);
    expect([name, url, r.code]).toEqual([name, url, 2]);
  }
  expect(f.ds(f.wt.builder, ["expose", "x", "http://localhost:1", "--port", "3"]).code).toBe(2);
  expect(f.rows()).toEqual([]);
  expect(f.events("exposed")).toEqual([]);
  // The edges that pass: a 40-character name, a 200-character note, https with a path.
  expect(f.ds(f.wt.builder, ["expose", `A${"b".repeat(39)}`, "https://example.com/x?y=1", "--note", "n".repeat(200)]).code).toBe(0);
});

test("unexpose ends the caller's entry; exposing again makes a new row", () => {
  const f = fixture();
  f.ds(f.wt.builder, ["expose", "preview", "http://localhost:5173"]);
  f.ds(f.wt.tester, ["expose", "preview", "http://localhost:6000"]);
  const r = f.ds(f.wt.builder, ["unexpose", "preview"], { DS_NOW: "3000" });
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ role: "builder", gone_at: 3000, gone_why: "unexposed" });
  expect(f.rows().map((x) => [x.role, x.gone_why])).toEqual([["builder", "unexposed"], ["tester", null]]);
  expect(JSON.parse(String(f.events("unexposed")[0].payload))).toMatchObject({ name: "preview", why: "unexposed", by: "builder" });
  expect(f.ds(f.wt.builder, ["unexpose", "preview"]).code).toBe(1);
  expect(f.ds(f.wt.builder, ["expose", "preview", "http://localhost:5174"]).code).toBe(0);
  const rows = f.rows();
  expect(rows.length).toBe(3);
  expect(rows.filter((x) => x.gone_at === null).map((x) => [x.role, x.url])).toEqual([["tester", "http://localhost:6000"], ["builder", "http://localhost:5174"]]);
});

test("the Lead (or --project/--topic) ends any owner's entry; two owners refuse and are named", () => {
  const f = fixture();
  f.ds(f.wt.builder, ["expose", "web", "http://localhost:1"]);
  f.ds(f.wt.tester, ["expose", "web", "http://localhost:2"]);
  f.ds(f.wt.tester, ["expose", "db", "http://localhost:3"]);
  const two = f.ds(f.wt.lead, ["unexpose", "web"]);
  expect(two.code).toBe(2);
  expect(two.err).toContain("builder/u1");
  expect(two.err).toContain("tester");
  expect(f.rows().every((x) => x.gone_at === null)).toBe(true);
  expect(f.ds(f.wt.lead, ["unexpose", "web", "--owner", "tester"]).code).toBe(0);
  expect(f.ds(f.wt.lead, ["unexpose", "db"]).code).toBe(0);
  expect(f.ds(f.wt.other, ["unexpose", "web", "--project", "p", "--topic", "t"]).code).toBe(0);
  expect(f.rows().map((x) => x.gone_why)).toEqual(["unexposed", "unexposed", "unexposed"]);
  // A member cannot end another member's entry.
  f.ds(f.wt.tester, ["expose", "web", "http://localhost:2"]);
  expect(f.ds(f.wt.builder, ["unexpose", "web"]).code).toBe(1);
});

test("exposed lists open entries newest first, with probe columns; --all adds ended ones", () => {
  const f = fixture();
  f.ds(f.wt.builder, ["expose", "a", "http://localhost:1"], { DS_NOW: "100" });
  f.ds(f.wt.tester, ["expose", "b", "http://localhost:2"], { DS_NOW: "200" });
  f.ds(f.wt.builder, ["unexpose", "a"]);
  const s = open(f.state);
  const b = s.get("exposed", { name: "b" })!;
  s.upsert("observed_exposed", { exposed_id: b.id }, { status: "up", reach: "host-only", probed_at: 300, down_since: null });
  s.close();
  const open1 = JSON.parse(f.ds(f.wt.other, ["exposed"]).out);
  expect(open1.map((x: Row) => [x.name, x.status, x.reach])).toEqual([["b", "up", "host-only"]]);
  const all = JSON.parse(f.ds(f.wt.other, ["exposed", "--all", "--project", "p", "--topic", "t"]).out);
  expect(all.map((x: Row) => x.name).sort()).toEqual(["a", "b"]);
  expect(JSON.parse(f.ds(f.wt.other, ["exposed", "--topic", "other"]).out)).toEqual([]);
});

test("the open-entry index allows one open row per owner and name, any number of ended ones", () => {
  const f = fixture();
  const s = open(f.state);
  try {
    const ins = (gone: number | null) => s.db.run("INSERT INTO exposed (project, squad, owner_wt, role, name, url, updated_at, gone_at) VALUES ('p','t','w','builder','n','http://x',1,?)", [gone]);
    ins(5); ins(6); ins(null);
    expect(() => ins(null)).toThrow();
    expect(() => s.db.run("INSERT INTO exposed (project, squad, role, name, url, updated_at, scope) VALUES ('p','t','x','m','http://x',1,'team')")).toThrow();
  } finally { s.close(); }
});

test("migration 0038 applies on an empty db and on an existing one", () => {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "expose-mig-")); roots.push(root);
  const fresh = open(join(root, "fresh"));
  expect(fresh.migrated.applied).toContain("0038-exposed.sql");
  expect([...fresh.columns("observed_exposed")]).toEqual(["exposed_id", "status", "reach", "probed_at", "down_since"]);
  fresh.close();
  const older = join(root, "migs"); mkdirSync(older);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "0038")) copyFileSync(join(MIGRATIONS, f), join(older, f));
  const before = open(join(root, "old"), { migrations: older });
  expect(before.migrated.all).not.toContain("0038-exposed.sql");
  before.upsert("squads", { project: "p", topic: "t" }, { status: "running", observed_at: 1, updated_at: 1 });
  before.close();
  const after = open(join(root, "old"));
  expect(after.migrated.applied).toEqual(readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f >= "0038").sort());
  expect(after.get("squads", { project: "p", topic: "t" })).not.toBeNull();
  expect(after.columns("exposed").has("gone_why")).toBe(true);
  after.close();
});

// exposed-cleanup U2: --stop, --self, --ports, --remove and the refusal of a done or closing squad.
test("--stop, --self and --ports are stored; omitted they are kept, empty clears them; the audience is set each call", () => {
  const f = fixture();
  const r = f.ds(f.wt.tester, ["expose", "stack", "http://localhost:26500", "--squad", "--stop", "docker compose -p acme down", "--ports", "26507, 6379", "--self"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ stop_cmd: "docker compose -p acme down", audience: "self", ports: [26507, 6379], stop_state: null });
  const [ev] = f.events("exposed");
  expect(JSON.parse(String(ev.payload))).toMatchObject({ audience: "self", stop: true, ports: [26507, 6379] });
  expect(f.ds(f.wt.tester, ["expose", "stack", "http://localhost:26501", "--squad"]).code).toBe(0);
  expect(f.rows()[0]).toMatchObject({ url: "http://localhost:26501", stop_cmd: "docker compose -p acme down", ports: "[26507,6379]", audience: "operator" });
  expect(f.ds(f.wt.tester, ["expose", "stack", "http://localhost:26501", "--squad", "--stop", "", "--ports", ""]).code).toBe(0);
  expect(f.rows()[0]).toMatchObject({ stop_cmd: null, ports: null });
  const listed = JSON.parse(f.ds(f.wt.tester, ["exposed"]).out) as Row[];
  expect(listed[0]).toMatchObject({ name: "stack", audience: "operator", ports: null, stop_state: null });
});

test("a bad --stop or --ports exits 2 and writes nothing", () => {
  const f = fixture();
  for (const bad of [["--stop", "a\nb"], ["--stop", "x".repeat(501)], ["--stop", "tab\there"], ["--ports", "0"], ["--ports", "65536"], ["--ports", "80,http"],
    ["--ports", Array.from({ length: 17 }, (_, i) => String(1000 + i)).join(",")]]) {
    const r = f.ds(f.wt.tester, ["expose", "stack", "http://localhost:1", ...bad]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage: ds expose");
  }
  expect(f.rows()).toEqual([]);
  expect(f.ds(f.wt.tester, ["expose", "stack", "http://localhost:1", "--stop", "x".repeat(500), "--ports", Array.from({ length: 16 }, (_, i) => String(1000 + i)).join(",")]).code).toBe(0);
});

test("ds expose refuses a squad that is done or closing, from a member worktree and with --project/--topic", () => {
  const f = fixture();
  for (const set of ["status = 'done'", "want = 'gone'"]) {
    const s = open(f.state); s.db.run(`UPDATE squads SET status = 'running', want = NULL WHERE topic = 't'`); s.db.run(`UPDATE squads SET ${set} WHERE topic = 't'`); s.close();
    for (const [cwd, extra] of [[f.wt.tester, []], [f.wt.other, ["--project", "p", "--topic", "t"]]] as [string, string[]][]) {
      const r = f.ds(cwd, ["expose", "stack", "http://localhost:1", ...extra]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("squad 't' is done or closing; set it back to running to expose");
    }
  }
  expect(f.rows()).toEqual([]);
});

test("ds expose --remove <name> is ds unexpose <name>, and never runs or queues the stop", () => {
  const f = fixture();
  expect(f.ds(f.wt.builder, ["expose", "preview", "http://localhost:5173", "--stop", "echo stop"]).code).toBe(0);
  const r = f.ds(f.wt.builder, ["expose", "--remove", "preview"]);
  expect(r.code).toBe(0);
  expect(f.rows()[0]).toMatchObject({ gone_why: "unexposed", stop_state: null });
  const miss = f.ds(f.wt.builder, ["expose", "--remove", "preview"]);
  expect(miss.code).toBe(1);
  expect(miss.err).toContain("ds expose --remove: no open entry 'preview'");
  for (const cmd of ["expose", "unexpose"]) {
    const h = f.ds(f.wt.builder, [cmd, "--help"]).out;
    expect(h).toContain("--remove <name>");
    expect(h).toContain("unexpose <name>");
  }
});

test("migration 0048 adds the stop columns; old rows read as audience operator with no stop", () => {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "expose-mig47-")); roots.push(root);
  const older = join(root, "migs"); mkdirSync(older);
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "0048")) copyFileSync(join(MIGRATIONS, f), join(older, f));
  const before = open(join(root, "old"), { migrations: older });
  before.db.run("INSERT INTO exposed (project, squad, owner_wt, role, name, url, updated_at) VALUES ('p','t','w','builder','n','http://x',1)");
  before.close();
  const after = open(join(root, "old"));
  expect(after.migrated.applied).toContain("0048-exposed-stop.sql");
  for (const c of ["stop_cmd", "audience", "ports", "stop_state", "stop_at", "stop_result"]) expect(after.columns("exposed").has(c)).toBe(true);
  expect(after.db.query("SELECT audience, stop_cmd, stop_state FROM exposed").get()).toEqual({ audience: "operator", stop_cmd: null, stop_state: null });
  after.close();
});
