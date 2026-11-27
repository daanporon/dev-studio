// exposed-probe.test.ts — expose-hosted-services U2: the exposed observer probes each open entry with a
// real TCP connect and records status, reach and down_since (R6), bounded per run (KTD4). Real sockets on
// ephemeral ports; the tailnet IP is injected (127.0.0.2 stands in: on Linux it reaches a listener bound to
// 0.0.0.0 but not one bound to 127.0.0.1, as a tailnet IP does).
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exposedObserver, loopbackHosts, probe, connect } from "../../bin/loop/observers/exposed.ts";
import type { TickCtx } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

const roots: string[] = [];
const servers: { stop(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) { try { s.stop(); } catch { /* stopped */ } }
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

function store(): Store {
  const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "exposed-probe-")); roots.push(root);
  return open(join(root, "state"));
}

function listen(hostname: string): { port: number; stop(): void } {
  const l = Bun.listen({ hostname, port: 0, socket: { data() {}, open(s) { s.end(); } } });
  servers.push(l);
  return { port: l.port, stop: () => l.stop(true) };
}

let n = 0;
function entry(s: Store, url: string, extra: Row = {}): number {
  s.upsert("exposed", { project: "p", squad: "t", owner_wt: "", name: `e${++n}`, gone_at: null }, { role: "operator", url, scope: "squad", updated_at: 1, ...extra });
  return Number((s.db.query("SELECT id FROM exposed WHERE name = ?").get(`e${n}`) as Row).id);
}
const obs = (s: Store, id: number) => s.db.query("SELECT * FROM observed_exposed WHERE exposed_id = ?").get(id) as Row | null;
const ctx = (s: Store, now: number): TickCtx => ({ store: s, project: "", tick: 1, now, fired: [], poked: new Set() });

test("a listening loopback port is up/host-only without a tailnet IP", async () => {
  const s = store(), l = listen("127.0.0.1");
  const id = entry(s, `http://localhost:${l.port}/x`);
  await exposedObserver({ tailnet: () => "" }).run(ctx(s, 1000));
  expect(obs(s, id)).toMatchObject({ status: "up", reach: "host-only", probed_at: 1000, down_since: null });
});

test("a loopback URL that answers on the tailnet IP is up/remote; bound to 127.0.0.1 only it stays host-only", async () => {
  const s = store(), all = listen("0.0.0.0"), lo = listen("127.0.0.1");
  const a = entry(s, `http://0.0.0.0:${all.port}`), b = entry(s, `http://127.0.0.1:${lo.port}`);
  await exposedObserver({ tailnet: () => "127.0.0.2" }).run(ctx(s, 1000));
  expect(obs(s, a)).toMatchObject({ status: "up", reach: "remote" });
  expect(obs(s, b)).toMatchObject({ status: "up", reach: "host-only" });
});

test("a non-loopback host that answers is remote, and the tailnet is not asked", async () => {
  const s = store(), l = listen("127.0.0.1");
  let asked = 0;
  // 127.0.0.1 is loopback, so stand in for a remote host through an injected connect.
  const id = entry(s, `http://dev-host.example.ts.net:${l.port}`);
  await exposedObserver({ tailnet: () => { asked++; return "100.64.0.1"; }, connect: (_h, _p, ms) => connect("127.0.0.1", l.port, ms) }).run(ctx(s, 1000));
  expect(obs(s, id)).toMatchObject({ status: "up", reach: "remote" });
  expect(asked).toBe(0);
});

test("a closed port is down and sets down_since once; up again clears it", async () => {
  const s = store(), l = listen("127.0.0.1");
  const port = l.port;
  l.stop();
  const id = entry(s, `http://127.0.0.1:${port}`);
  const o = exposedObserver({ tailnet: () => "" });
  await o.run(ctx(s, 1000));
  expect(obs(s, id)).toMatchObject({ status: "down", reach: "down", probed_at: 1000, down_since: 1000 });
  await o.run(ctx(s, 1060));
  expect(obs(s, id)).toMatchObject({ status: "down", probed_at: 1060, down_since: 1000 });
  const again = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {}, open(x) { x.end(); } } });
  servers.push(again);
  await o.run(ctx(s, 1120));
  expect(obs(s, id)).toMatchObject({ status: "up", reach: "host-only", probed_at: 1120, down_since: null });
});

test("a gone row is never probed", async () => {
  const s = store(), l = listen("127.0.0.1");
  const id = entry(s, `http://127.0.0.1:${l.port}`, { gone_at: 5, gone_why: "unexposed" });
  await exposedObserver({ tailnet: () => "" }).run(ctx(s, 1000));
  expect(obs(s, id)).toBeNull();
});

test("30 entries against a black-hole address: one run stays under 1.5 s and probes 16, oldest first; the next run takes the other 14", async () => {
  const s = store();
  const ids = Array.from({ length: 30 }, (_, i) => entry(s, `http://10.255.255.1:${8000 + i}`));
  const o = exposedObserver({ tailnet: () => "" });
  const t0 = performance.now();
  await o.run(ctx(s, 1000));
  expect(performance.now() - t0).toBeLessThan(1500);
  const probed = () => (s.db.query("SELECT exposed_id FROM observed_exposed ORDER BY exposed_id").all() as Row[]).map((r) => Number(r.exposed_id));
  expect(probed()).toEqual(ids.slice(0, 16));
  await o.run(ctx(s, 1060));
  expect(probed()).toEqual(ids);
  const second = (s.db.query("SELECT exposed_id FROM observed_exposed WHERE probed_at = 1060 ORDER BY exposed_id").all() as Row[]).map((r) => Number(r.exposed_id));
  // the 14 never probed, then the two oldest probed ones to fill the batch
  expect(second).toEqual([...ids.slice(0, 2), ...ids.slice(16)]);
});

// side-loop-host u9b: a side owner's entry is on another host. Main must not connect for it, whatever URL it names.
test("a side owner's entry is never connected to, loses an old probe row, and takes no batch slot", async () => {
  const s = store();
  const member = (wt: string, host: string) => s.upsert("members", { project: "p", squad: "t", role: "builder", suffix: wt }, { wt, host, observed_at: 1, updated_at: 1 });
  member("box::/w/a", "box");
  member("repo::/w/b", "local");
  s.upsert("hosts", { name: "other" }, { status: "accepted", public_key: "k", requested_at: 1 });
  const side = entry(s, "http://localhost:3000", { owner_wt: "box::/w/a" });
  const noMember = entry(s, "http://10.0.0.5:22", { owner_wt: "other::/w/c" });   // known by its host-prefixed id alone
  const local = entry(s, "http://dev-local.example.test:80", { owner_wt: "repo::/w/b" });
  s.upsert("observed_exposed", { exposed_id: side }, { status: "down", reach: "down", probed_at: 1, down_since: 1 });
  const seen: string[] = [];
  await exposedObserver({ tailnet: () => "", batch: 1, connect: async (h, p) => { seen.push(`${h}:${p}`); return true; } }).run(ctx(s, 1000));
  expect(seen).toEqual(["dev-local.example.test:80"]);
  expect(obs(s, side)).toBeNull();
  expect(obs(s, noMember)).toBeNull();
  expect(obs(s, local)).toMatchObject({ status: "up", probed_at: 1000 });
});

test("loopback hosts and URL parsing", async () => {
  expect(loopbackHosts("localhost")).toEqual(["127.0.0.1", "::1"]);
  expect(loopbackHosts("0.0.0.0")).toEqual(["127.0.0.1"]);
  expect(loopbackHosts("127.1.2.3")).toEqual(["127.1.2.3"]);
  expect(loopbackHosts("::1")).toEqual(["::1"]);
  expect(loopbackHosts("dev-host")).toBeNull();
  const seen: string[] = [];
  const c = async (h: string, p: number) => { seen.push(`${h}:${p}`); return false; };
  expect(await probe("https://[::1]/", { tailnet: () => "", connect: c, ms: 10 })).toEqual({ status: "down", reach: "down" });
  expect(await probe("http://example.test/", { tailnet: () => "", connect: c, ms: 10 })).toEqual({ status: "down", reach: "down" });
  expect(await probe("javascript:alert(1)", { tailnet: () => "", connect: c, ms: 10 })).toEqual({ status: "down", reach: "down" });
  expect(seen).toEqual(["::1:443", "example.test:80"]);
});
