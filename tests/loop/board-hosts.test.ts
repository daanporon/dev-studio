// board-hosts.test.ts — side-loop-host U17 (issue #127): the board shows hosts. A member off main carries a host
// chip; Settings → Hosts has a row per host (online, seats, load, last seen, behind, brake) and the join command,
// a row opens that host's keys with each value's source, and its edits and Remove file host-wide requests; a
// pending join is a Needs-you card with its fingerprint and Accept and Reject. The board is built from a small
// loop.db and mounted, and the posted requests run through the real route and fulfiller.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importConfig } from "../../bin/loop/db/import-config.ts";
import { open, type Row } from "../../bin/loop/core/store.ts";
import { buildBoard, hostsJson } from "../../bin/board/board-data.ts";
import fulfiller from "../../bin/loop/fulfil/host.ts";
import { accept, requestJoin } from "../../bin/link/host-keys.ts";
import { setHostKey } from "../../bin/loop/settings/host-settings.ts";
import { codeRev, hostEnv } from "../../bin/link/client.ts";
import { LINK_VERSION } from "../../bin/link/protocol.ts";
import { UP_MIGRATION } from "../../bin/link/replica.ts";
import { generateKeyPairSync } from "node:crypto";
import { mount } from "./board-mount.ts";

const REPO = join(import.meta.dir, "..", "..");
const NOW = Math.floor(Date.now() / 1000);
const roots: string[] = [];
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const newKey = () => generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");

function setup() {
  for (const k of Object.keys(process.env)) if (/^(DS_|ORCA_)/.test(k)) delete process.env[k];
  process.env.DS_LINK_BIND = "127.0.0.1 main.example.test";
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "boardhost-")); roots.push(root);
  const conv = mkdtempSync(join(tmpdir(), "boardhost-conv-")); roots.push(conv);
  cpSync(join(REPO, "conventions"), conv, { recursive: true });
  mkdirSync(join(root, "p", "squads"), { recursive: true });
  const s = open(root);
  importConfig(s, root, conv);
  s.upsert("projects", { label: "p" }, { observed_at: NOW });
  const sample = (host: string, load1: number) => s.upsert("observed_machine", { host }, { cores: 8, load1, load5: load1, load15: load1, mem_total_kb: 32_000_000, mem_avail_kb: 24_000_000,
    swap_total_kb: 0, swap_free_kb: 0, psi_cpu_some: 0, psi_mem_some: 0, psi_mem_full: 0, psi_io_some: 0, psi_io_full: 0, disks: "[]", groups: "[]", cpu_busy_pct: 10, observed_at: NOW });
  // A side host that joined, was accepted with `seats` and said hello with `more`.
  const side = (name: string, seats: number, more: Row = {}) => {
    expect(requestJoin(s, { name, public_key: newKey() }, NOW - 600).ok).toBe(true);
    expect(accept(s, name, { seats }, NOW - 500).ok).toBe(true);
    s.upsert("hosts", { name }, { last_seen_at: NOW - 5, link_version: LINK_VERSION, up_migration: UP_MIGRATION, code_rev: codeRev(), ...more });
  };
  const rows = () => hostsJson("p", root) as any;
  const host = (name: string) => rows().hosts.find((h: any) => h.name === name);
  const key = (name: string, k: string) => host(name).keys.find((x: any) => x.key === k);
  return { root, s, sample, side, rows, host, key, board: () => buildBoard("p", "", root) as any };
}

test("with no side host: main's row, and the join command with the link_listen hint", () => {
  const f = setup();
  const d = f.rows();
  expect(d.hosts.map((h: any) => h.name)).toEqual(["local"]);
  expect(d.join.command).toBe("ds join main.example.test:7790");
  expect(d.join.hint).toContain("`ds config set <project> limits.conf link_listen on`");
  expect(d.join.note).toBeNull();
  // Main's seats are its projects' max_builders, so it has no seats key to edit.
  expect(f.key("local", "seats")).toBeUndefined();
  expect(f.key("local", "builder_host_brake")).toMatchObject({ value: "off", source: "default" });
});

test("a side host's row: seats, load, brake line, behind, and each key's source", () => {
  const f = setup();
  f.sample("box-a", 40);
  f.sample("box-b", 1);
  f.side("box-a", 3, { env: JSON.stringify({ seats: "5" }) });
  f.side("box-b", 2, { code_rev: "000000000000", unreachable_since: NOW - 60 });
  setHostKey(f.s, "box-a", "machine_load_warn_pct", "70", "test", NOW);
  f.s.upsert("members", { id: 1 }, { project: "p", squad: "one", role: "builder", suffix: "u1", host: "box-a", want: "running", status: "running", observed_at: NOW, updated_at: NOW });
  f.s.upsert("squads", { project: "p", topic: "one" }, { status: "running", doc: { topic: "one", members: [], units: [], waiting_on_you: [] }, observed_at: NOW, updated_at: NOW });

  const a = f.host("box-a");
  expect(a).toMatchObject({ online: true, behind: null, seats: { used: 1, total: 3, free: 2 }, load: { load1: 40, cores: 8, pct: 500, state: "fresh" } });
  expect(a.brake.on).toBe(true);
  expect(a.brake.hit).toMatch(/^load 500% ≥ crit \d+%$/);
  expect(f.rows().join.hint).toBeNull();   // link_listen auto with a host: the server runs
  expect(f.key("box-a", "seats")).toMatchObject({ value: "5", source: "env", env: "DS_LIMIT_SEATS", override: "3", main_reads: "3" });
  expect(f.key("box-a", "machine_load_warn_pct")).toMatchObject({ value: "70", source: "override", main_reads: null });
  expect(f.key("box-a", "machine_mem_warn_pct").source).toBe("default");
  // Main's own env is not a side's.
  process.env.DS_LIMIT_MACHINE_MEM_WARN_PCT = "11";
  expect(f.key("box-a", "machine_mem_warn_pct").source).toBe("default");
  expect(f.key("local", "machine_mem_warn_pct")).toMatchObject({ value: "11", source: "env" });

  const b = f.host("box-b");
  expect(b.online).toBe(false);
  expect(b.brake).toEqual({ on: true, hit: null });
  if (codeRev()) expect(b.behind).toContain("it runs 000000000000");
  f.s.upsert("hosts", { name: "box-b" }, { up_migration: "0001-old" });
  expect(f.host("box-b").behind).toContain("takes no new starts");
});

test("a side's hello carries only the host keys its environment sets", () => {
  setup();
  process.env.DS_LIMIT_SEATS = "4";
  process.env.DS_LIMIT_MAX_BUILDERS = "9";   // a project key: not a host's
  expect(hostEnv()).toEqual({ seats: "4" });
});

test("a member off main carries a host chip; one on main none", async () => {
  const f = setup();
  f.side("box-a", 2);
  const doc = { topic: "one", status: "running", worktrees: [], units: [], waiting_on_you: [], members: [{ role: "builder", suffix: "u1" }, { role: "builder", suffix: "u2" }] };
  f.s.upsert("squads", { project: "p", topic: "one" }, { status: "running", doc, observed_at: NOW, updated_at: NOW });
  f.s.upsert("members", { id: 1 }, { project: "p", squad: "one", role: "builder", suffix: "u1", wt: "wt_u1", host: "box-a", observed_at: NOW, updated_at: NOW });
  f.s.upsert("members", { id: 2 }, { project: "p", squad: "one", role: "builder", suffix: "u2", wt: "wt_u2", host: "local", observed_at: NOW, updated_at: NOW });
  const board = f.board();
  expect(board.squads[0].members.map((m: any) => m.host)).toEqual(["box-a", undefined]);
  const r = await mount(board);
  expect(r.errors).toEqual([]);
  r.root.querySelector(".row.squad")!.dispatchEvent(new r.window.MouseEvent("click", { bubbles: true }));
  await new Promise((res) => setTimeout(res, 40));
  expect([...r.root.querySelectorAll(".host-chip")].map((e) => e.textContent)).toEqual(["box-a"]);
});

// The mounted page with its POSTs kept, and the helpers to press what it shows.
async function page(board: any, hosts: () => any) {
  const fixtures: Record<string, any> = { "api/limits": { limits: [], groups: [] }, "api/hosts": hosts() };
  const r = await mount(board, false, fixtures);
  const w = r.window, doc = w.document, posts: { url: string; body: any }[] = [], get = w.fetch;
  w.fetch = async (url: string, o: any) => {
    if (o?.method !== "POST") return get(url, o);
    posts.push({ url: String(url), body: JSON.parse(o.body) });
    return { ok: true, status: 200, json: async () => ({}) };   // no id: the page waits for no request to finish
  };
  const tick = () => new Promise((res) => setTimeout(res, 40));
  const click = async (el: any) => { expect(el).toBeTruthy(); el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await tick(); };
  const button = (text: string, within: any = doc) => [...within.querySelectorAll("button")].find((b: any) => b.textContent.trim() === text);
  return { r, w, doc, posts, click, button, tick };
}

test("Settings → Hosts: rows, a row's keys with their source, an edit, a reset and Remove file requests", async () => {
  const f = setup();
  f.sample("box-a", 1);
  f.side("box-a", 3, { env: JSON.stringify({ host_tidy: "apply" }), code_rev: "000000000000" });
  const p = await page(f.board(), f.rows);
  await p.click([...p.doc.querySelectorAll("button")].find((b: any) => b.textContent.includes("Settings")));
  await p.click(p.button("Hosts"));
  const row = p.doc.querySelector('[data-host="box-a"]') as any;
  expect([...p.doc.querySelectorAll("[data-host]")].map((e: any) => e.getAttribute("data-host"))).toEqual(["local", "box-a"]);
  for (const t of ["online", "seats 0 used, 3 free of 3", "load 1 (13% of 8 cores)", "last seen", "brake on"]) expect(row.textContent).toContain(t);
  if (codeRev()) expect(row.textContent).toContain("behind");
  expect(p.doc.querySelector(".join-cmd")!.textContent).toBe("ds join main.example.test:7790");
  expect(p.doc.querySelector('[data-host="local"] .host-remove')).toBeNull();

  await p.click(row.querySelector(".host-open"));
  const line = (k: string) => [...row.querySelectorAll(".host-key")].find((e: any) => e.querySelector(".t").textContent === k) as any;
  expect(line("seats").textContent).toContain("override");
  expect(line("machine_mem_warn_pct").textContent).toContain("default");
  expect(line("host_tidy").textContent).toContain("env on that host (DS_LIMIT_HOST_TIDY)");
  expect(line("cleanup_tmp_globs").querySelector("input")).toBeNull();

  const input = line("seats").querySelector("input") as any;
  expect(input.value).toBe("3");
  // React reads a typed value only through the input's own setter.
  Object.getOwnPropertyDescriptor(p.w.HTMLInputElement.prototype, "value")!.set!.call(input, "6");
  input.dispatchEvent(new p.w.Event("input", { bubbles: true }));
  await p.tick();
  await p.click(line("seats").querySelector(".host-save"));
  await p.click(line("seats").querySelector(".host-reset"));
  p.w.confirm = () => true;
  await p.click(row.querySelector(".host-remove"));
  expect(p.r.errors).toEqual([]);
  expect(p.posts.map((x) => x.url)).toEqual(["api/host", "api/host", "api/host"]);
  expect(p.posts[0].body).toEqual({ host: "box-a", key: "seats", action: "set", value: "6" });
  expect(p.posts[1].body).toEqual({ host: "box-a", action: "reset", key: "seats" });
  expect(p.posts[2].body).toEqual({ host: "box-a", action: "remove" });

  // The loop's side of the same three: the rows the CLI would write, as actor board.
  const run = async (kind: string, payload: any) => {
    const req = f.s.requestAny(kind, payload, { project: null, by: "board" }).row;
    return (fulfiller as any).exec({ kind, project: null, payload: { ...payload, request: req.id }, id: 1, subject: "x" }, { store: f.s, now: NOW, done: () => {} });
  };
  expect(await run("host-key", { host: "box-a", key: "seats", value: "6" })).toEqual({ done: true });
  expect(f.host("box-a").seats.total).toBe(6);
  expect(f.s.db.query("SELECT actor FROM config_history WHERE host = 'box-a' ORDER BY id DESC LIMIT 1").get()).toEqual({ actor: "board" });
  expect(await run("host-key", { host: "box-a", key: "seats" })).toEqual({ done: true });
  expect(f.key("box-a", "seats")).toMatchObject({ source: "default", override: null });
  expect(await run("host-key", { host: "box-a", key: "seats", value: "many" })).toEqual({ failed: expect.stringContaining("whole number") });
  expect(await run("host-member", { host: "box-a", action: "remove" })).toEqual({ done: true });
  expect(f.rows().hosts.map((h: any) => h.name)).toEqual(["local"]);
});

test("a pending join is a Needs-you card with its fingerprint; Accept sends it, another key is refused", async () => {
  const f = setup();
  const join_ = requestJoin(f.s, { name: "box-c", public_key: newKey() }, NOW - 120) as any;
  const board = f.board();
  const card = board.needs_you.find((n: any) => n.card === "host-join");
  expect(card).toMatchObject({ host: "box-c", fingerprint: join_.fingerprint, kind: "studio" });
  expect(card.text).toContain(join_.fingerprint);
  expect(board.needs_count).toBe(1);
  expect(f.rows().pending).toEqual(["box-c"]);

  const p = await page(board, f.rows);
  const title = [...p.doc.querySelectorAll("#root *")].find((e: any) => !e.children.length && e.textContent.includes("box-c asks to join")) as any;
  await p.click(title);
  expect(p.button("Reject")).toBeTruthy();
  expect(p.button("Dismiss")).toBeFalsy();
  await p.click(p.button("Accept"));
  expect(p.r.errors).toEqual([]);
  expect(p.posts).toEqual([{ url: "api/host", body: { host: "box-c", action: "accept", fingerprint: join_.fingerprint } }]);

  const run = async (payload: any) => {
    const req = f.s.requestAny("host-member", payload, { project: null, by: "board" }).row;
    return (fulfiller as any).exec({ kind: "host-member", project: null, payload: { ...payload, request: req.id }, id: 1, subject: "x" }, { store: f.s, now: NOW, done: () => {} });
  };
  for (const action of ["accept", "reject"]) {
    expect(await run({ host: "box-c", action, fingerprint: "SHA256:another" })).toEqual({ failed: expect.stringContaining("another key") });
    expect(await run({ host: "box-c", action })).toEqual({ failed: expect.stringContaining("needs the fingerprint") });
  }
  expect(await run({ host: "box-c", action: "accept", fingerprint: join_.fingerprint })).toEqual({ done: true });
  expect(f.s.get("hosts", { name: "box-c" })).toMatchObject({ status: "accepted", accepted_by: "board" });
  expect(f.board().needs_you.filter((n: any) => n.card === "host-join")).toEqual([]);
});

test("the server: GET api/hosts reads; POST api/host files one host-wide request and refuses the rest", async () => {
  const f = setup();
  f.side("box-a", 2);
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port; probe.stop(true);
  const url = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([process.execPath, join(REPO, "bin/board/board-server.ts"), "127.0.0.1", String(port),
    join(REPO, "web/board.html"), join(REPO, "bin/board/board-data.ts"), "p"], { env: { ...process.env, DS_STATE_ROOT: f.root }, stdout: "ignore", stderr: "pipe" });
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch(url + "/healthz")).ok) break; } catch {} await Bun.sleep(20); }
    const got = await (await fetch(url + "/api/hosts?project=p")).json() as any;
    expect(got.hosts.map((h: any) => h.name)).toEqual(["local", "box-a"]);
    const post = async (body: unknown) => (await fetch(url + "/api/host", { method: "POST", headers: { Origin: url, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status;
    expect(await post({ host: "box-a", action: "accept" })).toBe(400);                    // no fingerprint
    expect(await post({ host: "box-a", action: "set", key: "max_builders", value: "3" })).toBe(400);   // not a host key
    expect(await post({ host: "box-a", action: "set", key: "cleanup_tmp_globs", value: "/tmp/x*" })).toBe(409);
    expect(await post({ host: "nope", action: "remove" })).toBe(409);
    expect(await post({ host: "box-a", action: "set", key: "seats", value: "4" })).toBeLessThan(300);
    expect(await post({ host: "box-a", action: "set", key: "seats", value: "4" })).toBe(409);   // still open
    expect(f.s.db.query("SELECT kind, project, requested_by AS by_, json_extract(payload, '$.value') AS value FROM requests").all())
      .toEqual([{ kind: "host-key", project: null, by_: "board", value: "4" }]);
  } finally { server.kill(); await server.exited; }
});
