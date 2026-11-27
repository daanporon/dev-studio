// link-transport.test.ts — side-loop-host U2 (issue #127, KTD1/KTD2/KTD4): an accepted client connects from a second
// state root over loopback by signing main's challenge, a request gets its answer (both ways, and from another
// process on main through the unix socket), a pending, unknown or removed host is refused, a join request reaches
// U1's pending list, an open link closes within one ping interval after its host is removed, a second live
// connection for the same host is refused, and a silent link is marked down within DEAD_MS on both ends; main
// records the host's last seen, versions and unreachable time. Plus the link service's wish (link_listen,
// link_port) and the server script's bind rule. U12b: main proves itself with its own key, which the join answer
// names; a side refuses a main that cannot sign its nonce with the pinned key, and never signs for one.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { accept, ensureHostKey, hostKeyPath, remove, requestJoin, signHello, pinMainKey, ensureMainKey, newKeyPair, signMain } from "../../bin/link/host-keys.ts";
import { LINK_VERSION, loadChannels, type Channel } from "../../bin/link/protocol.ts";
import { b64Bytes, newKx, sealer, type Sealer } from "../../bin/link/seal.ts";
import { LinkClient, linkUrl, sendJoin, type LinkState } from "../../bin/link/client.ts";
import { linkRequest, startLinkServer, type LinkServer } from "../../bin/link/server.ts";
import { linkListen, linkWish, syncLinkWish } from "../../bin/loop/fulfil/link.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PING = 150, DEAD = 600;
const saved: Record<string, string | undefined> = {};
const ENV = { DS_LINK_PING_MS: String(PING), DS_LINK_DEAD_MS: String(DEAD), DS_LINK_BIND_ANY: undefined, DS_LIMIT_LINK_LISTEN: undefined, DS_LIMIT_LINK_PORT: undefined, DS_NOW: undefined };
beforeAll(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const temps: string[] = [], stores: Store[] = [], servers: LinkServer[] = [], clients: LinkClient[] = [], others: { stop(): void }[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  for (const o of others.splice(0)) { try { o.stop(); } catch { /* stopped */ } }
  for (const s of servers.splice(0)) await s.stop();
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(): string { const d = mkdtempSync(join(tmpdir(), "zzlink-")); temps.push(d); return d; }
const events = (s: Store, kind: string): Row[] => s.db.query("SELECT * FROM events WHERE kind = ? ORDER BY id").all(kind) as Row[];
const host = (s: Store, name: string): Row => s.get("hosts", { name })!;
async function until(what: string, ok: () => boolean, ms = 3000): Promise<void> {
  for (let t = 0; t < ms; t += 25) { if (ok()) return; await Bun.sleep(25); }
  throw new Error(`timed out waiting for ${what}`);
}

async function mainUp(): Promise<{ root: string; store: Store; srv: LinkServer; url: string }> {
  const root = temp(), store = open(root);
  stores.push(store);
  const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0 });
  servers.push(srv);
  return { root, store, srv, url: `ws://127.0.0.1:${srv.port}` };
}
/** A side state root with its own key, joined and (unless `status` says otherwise) accepted on main. */
function side(store: Store, name: string, status: "accepted" | "pending" | "removed" | "unknown" = "accepted"): string {
  const root = temp();
  const k = ensureHostKey(root);
  pinMainKey(root, ensureMainKey(store.root).publicKey);
  if (status === "unknown") return root;
  expect(requestJoin(store, { name, public_key: k.publicKey }).ok).toBe(true);
  if (status === "accepted" || status === "removed") expect(accept(store, name).ok).toBe(true);
  if (status === "removed") expect(remove(store, name).ok).toBe(true);
  return root;
}
function client(url: string, root: string, name: string, onState?: (s: LinkState, why?: string) => void): LinkClient {
  const c = new LinkClient({ main: url, root, name, onState });
  clients.push(c);
  return c;
}

describe("connect and request", () => {
  test("an accepted host connects from a second state root and requests get answers both ways", async () => {
    const m = await mainUp();
    const sroot = side(m.store, "side-a");
    const c = client(m.url, sroot, "side-a");
    await c.start();
    expect(c.state).toBe("up");
    expect(m.srv.links()).toEqual(["side-a"]);
    // side → main
    const up = await c.request("info", { n: 1 }) as Row;
    expect(up).toMatchObject({ end: "main", peer: "side-a", link_version: LINK_VERSION, echo: { n: 1 } });
    // main → side, in the server process and from another process on main through the unix socket
    expect(await m.srv.request("side-a", "info", "x")).toMatchObject({ end: "side", peer: "main", echo: "x" });
    expect(await linkRequest(m.root, "side-a", "info", 7)).toMatchObject({ end: "side", echo: 7 });
    expect(statSync(m.srv.socket).mode & 0o777).toBe(0o600);
    await expect(linkRequest(m.root, "nobody", "info", null)).rejects.toThrow(/not linked/);
    await expect(c.request("no-such-channel", null)).rejects.toThrow(/no channel/);
    // main records the host's last seen and versions, and the link coming up
    const h = host(m.store, "side-a");
    expect(Number(h.last_seen_at)).toBeGreaterThan(0);
    expect(h.link_version).toBe(LINK_VERSION);
    expect(String(h.up_migration)).toMatch(/^\d{4}-/);
    expect(h.unreachable_since).toBeNull();
    expect(events(m.store, "host_link_up").length).toBe(1);
  });

  // U2b: Bun.serve's default idle timeout is 10 s and a host job answers much later. Bun 1.4.4 cuts a slow GET at that
  // default but not a POST with a body, so the slow request alone passes without the setting: the options pin it.
  test("the unix socket has no idle timeout, and a request slower than 10 s gets its answer", async () => {
    const slow: Channel = { name: "slow", answers: "both", handle: async () => { await Bun.sleep(13_000); return "done"; } };
    const chans = new Map([...(await loadChannels("side")), ["slow", slow]]);
    const serve = spyOn(Bun, "serve");
    let m: Awaited<ReturnType<typeof mainUp>>, served: Row[];
    try { m = await mainUp(); served = serve.mock.calls.map((c) => c[0] as Row); }
    finally { serve.mockRestore(); }
    expect(served.find((o) => o.unix === m.srv.socket)?.idleTimeout).toBe(0);
    expect(served.find((o) => o.hostname === "127.0.0.1")?.idleTimeout).toBe(30);
    const c = new LinkClient({ main: m.url, root: side(m.store, "side-s"), name: "side-s", channels: chans });
    clients.push(c);
    await c.start();
    expect(await linkRequest(m.root, "side-s", "slow", null, 25_000)).toBe("done");
  }, 30_000);

  test("a channel handler's error comes back as the request's error", async () => {
    const boom: Channel = { name: "boom", answers: "both", handle: () => { throw new Error("it broke"); } };
    const chans = new Map([...(await loadChannels("main")), ["boom", boom]]);
    const root = temp(), store = open(root);
    stores.push(store);
    const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0, channels: chans });
    servers.push(srv);
    const c = client(`127.0.0.1:${srv.port}`, side(store, "side-e"), "side-e");
    await c.start();
    await expect(c.request("boom", null)).rejects.toThrow("it broke");
  });

  test("linkUrl takes http, ws and bare host:port", () => {
    expect(linkUrl("http://m:7790")).toBe("ws://m:7790/link");
    expect(linkUrl("m:7790")).toBe("ws://m:7790/link");
    expect(linkUrl("ws://m:7790/link")).toBe("ws://m:7790/link");
  });
});

describe("refusals", () => {
  for (const status of ["pending", "unknown", "removed"] as const) {
    test(`a ${status} host is refused`, async () => {
      const m = await mainUp();
      const c = client(m.url, side(m.store, `side-${status}`, status), `side-${status}`);
      await expect(c.start()).rejects.toThrow(/not accepted/);
      expect(c.state).toBe("refused");
      expect(m.srv.links()).toEqual([]);
    });
  }

  test("a signature by another key is refused", async () => {
    const m = await mainUp();
    side(m.store, "side-k");
    const other = temp();
    pinMainKey(other, m.srv.mainKey.publicKey);
    const c = client(m.url, other, "side-k");   // a fresh key in another root, same name
    await expect(c.start()).rejects.toThrow(/bad signature/);
  });

  test("a wrong link version is refused with the fix", async () => {
    const m = await mainUp();
    const sroot = side(m.store, "side-v");
    const ws = new WebSocket(`${m.url}/link`);
    others.push({ stop: () => ws.close() });
    const got: Row[] = [];
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as Row;
      got.push(f);
      if (f.t === "challenge") {
        const nonce = Buffer.from(String(f.nonce), "base64");
        ws.send(JSON.stringify({ t: "auth", link_version: "0", signature: signHello(readFileSync(hostKeyPath(sroot), "utf8"), nonce, "0", "side-v") }));
      }
    };
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name: "side-v" }));
    await until("refusal", () => got.some((f) => f.t === "refused"));
    expect(String(got.find((f) => f.t === "refused")!.why)).toMatch(/link version 0 .* update dev-studio/);
    // A hello with no nonce (a side older than U12b) still gets its challenge, unsigned.
    expect(got.find((f) => f.t === "challenge")!.main_signature).toBeUndefined();
  });

  test("an oversized frame before the hello is refused", async () => {
    const m = await mainUp();
    const ws = new WebSocket(`${m.url}/link`);
    others.push({ stop: () => ws.close() });
    let why = "";
    ws.onmessage = (ev) => { why = String((JSON.parse(String(ev.data)) as Row).why ?? ""); };
    ws.onopen = () => ws.send(JSON.stringify({ t: "join", name: "x".repeat(10_000) }));
    await until("refusal", () => why !== "");
    expect(why).toMatch(/at most 4096 bytes/);
  });
});

describe("main proves itself (U12b)", () => {
  test("main signs the side's nonce with its own key, and the side pins it", async () => {
    const m = await mainUp();
    expect(m.srv.mainKey).toEqual({ publicKey: ensureMainKey(m.root).publicKey, fingerprint: ensureMainKey(m.root).fingerprint });
    expect(statSync(join(m.root, "link", "main.key")).mode & 0o777).toBe(0o600);
    const c = client(m.url, side(m.store, "side-p"), "side-p");
    await c.start();
    expect(c.state).toBe("up");
  });

  for (const [what, pin, why] of [
    ["a main that cannot sign with the pinned key", "other", /cannot sign with the main key pinned at join \(fingerprint [0-9a-f:]+\)/],
    ["any main while no key is pinned", "none", /no main key is pinned on this host: run `ds join/],
  ] as const) {
    test(`the side refuses ${what}, and never signs main's challenge`, async () => {
      const m = await mainUp();
      const sroot = side(m.store, "side-i");
      if (pin === "none") rmSync(join(sroot, "link", "main.pub"));
      else pinMainKey(sroot, ensureHostKey(temp()).publicKey);
      const c = client(m.url, sroot, "side-i");
      await expect(c.start()).rejects.toThrow(why);
      expect(c.state).toBe("refused");
      expect(m.srv.links()).toEqual([]);
      expect(events(m.store, "host_link_up").length).toBe(0);
      // Main logs why the side closed on it (a side joined before U12b has no pin: only its own log said so).
      await until("main's host_link_refused", () => events(m.store, "host_link_refused").length > 0);
      expect(JSON.parse(String(events(m.store, "host_link_refused")[0].payload)).why).toMatch(/^the side refused main: /);
    });
  }

  // An impostor on main's address: it skips the challenge, or challenges without main's signature, or replays a
  // signature main made for another nonce and key share. The side signs nothing for it and stays off.
  for (const [what, reply, why] of [
    ["welcomes at once", "welcome", /welcomed this host without proving it is main/],
    ["challenges unsigned", "unsigned", /did not sign this host's hello/],
    ["replays main's signature for another nonce", "replay", /cannot sign with the main key pinned/],
  ] as const) {
    test(`an impostor that ${what} is refused`, async () => {
      const m = await mainUp();
      const sroot = side(m.store, "side-x");
      const real = new WebSocket(`${m.url}/link`), stale: Row[] = [];
      others.push({ stop: () => real.close() });
      real.onmessage = (ev) => stale.push(JSON.parse(String(ev.data)) as Row);
      real.onopen = () => real.send(JSON.stringify({ t: "hello", name: "side-x", nonce: Buffer.alloc(32, 7).toString("base64"), kx: newKx().share }));
      await until("main's signed challenge", () => stale.length > 0);
      expect(typeof stale[0].main_signature).toBe("string");
      const heard: Row[] = [];
      const fake = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
        websocket: {
          message(ws, raw) {
            const f = JSON.parse(String(raw)) as Row;
            heard.push(f);
            if (f.t !== "hello") return;
            if (reply === "welcome") ws.send(JSON.stringify({ t: "welcome", host: "side-x", link_version: LINK_VERSION }));
            else if (reply === "unsigned") ws.send(JSON.stringify({ t: "challenge", nonce: Buffer.alloc(32, 1).toString("base64"), link_version: LINK_VERSION }));
            else ws.send(JSON.stringify({ t: "challenge", nonce: stale[0].nonce, link_version: stale[0].link_version, kx: stale[0].kx, main_signature: stale[0].main_signature }));
          },
        },
      });
      others.push({ stop: () => fake.stop(true) });
      const c = client(`ws://127.0.0.1:${fake.port}`, sroot, "side-x");
      await expect(c.start()).rejects.toThrow(why);
      expect(c.state).toBe("refused");
      expect(heard.map((f) => f.t)).toEqual(["hello"]);
      expect(String(heard[0].nonce).length).toBeGreaterThan(40);
    });
  }

  // A relay on main's address that passes the handshake through to the real main: the side comes up (main signed
  // the side's own share), but a frame the relay adds, either way, does not open with the link's keys.
  for (const toward of ["side", "main"] as const) {
    test(`a relay cannot inject a frame toward the ${toward}`, async () => {
      const m = await mainUp();
      const sroot = side(m.store, "side-y");
      const pipes: { toSide: (t: string) => void; toMain: (t: string) => void }[] = [];
      const relay = Bun.serve<{ up: WebSocket | null; held: string[] }, never>({
        hostname: "127.0.0.1", port: 0,
        fetch(req, srv) { return srv.upgrade(req, { data: { up: null, held: [] } }) ? undefined : new Response("no", { status: 400 }); },
        websocket: {
          open(ws) {
            const up = new WebSocket(`${m.url}/link`);
            ws.data.up = up;
            up.onopen = () => { for (const t of ws.data.held.splice(0)) up.send(t); };
            up.onmessage = (ev) => ws.send(String(ev.data));
            up.onclose = () => ws.close();
            pipes.push({ toSide: (t) => ws.send(t), toMain: (t) => up.send(t) });
          },
          message(ws, raw) { const up = ws.data.up!; if (up.readyState === WebSocket.OPEN) up.send(String(raw)); else ws.data.held.push(String(raw)); },
          close(ws) { ws.data.up?.close(); },
        },
      });
      others.push({ stop: () => relay.stop(true) });
      const states: [string, string | undefined][] = [];
      const c = client(`ws://127.0.0.1:${relay.port}`, sroot, "side-y", (st, why) => states.push([st, why]));
      await c.start();
      expect(c.state).toBe("up");
      await until("main to list the link", () => m.srv.links().includes("side-y"));
      const forged = JSON.stringify({ t: "ping", at: Date.now() });
      if (toward === "side") pipes[0].toSide(forged); else pipes[0].toMain(`0.${"A".repeat(43)}.${forged}`);
      await until("the link to drop", () => c.state !== "up" && !m.srv.links().includes("side-y"));
      // Toward the side, the side closes; toward main, main refuses (its refusal sealed, so the side reads why).
      expect(states.find(([st]) => st === "down")?.[1]).toMatch(/not sealed with this link's keys/);
    });
  }
});

describe("pre-auth", () => {
  test("a socket that never says hello is closed within DEAD_MS", async () => {
    const m = await mainUp();
    const ws = new WebSocket(`${m.url}/link`);
    others.push({ stop: () => ws.close() });
    let why = "", closed = false;
    ws.onmessage = (ev) => { why = String((JSON.parse(String(ev.data)) as Row).why ?? ""); };
    ws.onclose = () => { closed = true; };
    await until("the close", () => closed, DEAD + 1000);
    expect(why).toMatch(/no hello and auth/);
  });
});

describe("join", () => {
  test("a join request over the link lands in the pending list", async () => {
    const m = await mainUp();
    const k = ensureHostKey(temp());
    const r = await sendJoin(m.url, "side-j", k.publicKey);
    expect(r).toEqual({ ok: true, fingerprint: k.fingerprint, created: true, mainKey: m.srv.mainKey.publicKey });
    expect(host(m.store, "side-j")).toMatchObject({ status: "pending", fingerprint: k.fingerprint });
    expect(events(m.store, "host_join_requested").length).toBe(1);
    const bad = await sendJoin(m.url, "Bad Name", k.publicKey);
    expect(bad.ok).toBe(false);
    expect(bad.mainKey).toBe(m.srv.mainKey.publicKey);   // a refusal names main's key too (ds join's rejoin path)
  });

  test("a join to a main with no link server rejects", async () => {
    await expect(sendJoin("127.0.0.1:1", "side-x", ensureHostKey(temp()).publicKey, 2000)).rejects.toThrow(/cannot reach|closed/);
  });
});

describe("liveness", () => {
  test("an open link closes within one ping interval after its host is removed", async () => {
    const m = await mainUp();
    const states: string[] = [];
    const c = client(m.url, side(m.store, "side-r"), "side-r", (s) => states.push(s));
    await c.start();
    const t0 = Date.now();
    remove(m.store, "side-r");
    await until("the link to close", () => c.state !== "up", PING * 3);
    expect(Date.now() - t0).toBeLessThanOrEqual(PING * 2 + 100);
    expect(c.refusal).toMatch(/removed/);
    expect(m.srv.links()).toEqual([]);
    expect(events(m.store, "host_link_closed").length).toBe(1);
  });

  test("a second live connection for the same host is refused and never replaces the first", async () => {
    const m = await mainUp();
    const sroot = side(m.store, "side-2");
    const first = client(m.url, sroot, "side-2");
    await first.start();
    const second = client(m.url, sroot, "side-2");
    await expect(second.start()).rejects.toThrow(/already has a live link/);
    expect(first.state).toBe("up");
    expect(await m.srv.request("side-2", "info", "still")).toMatchObject({ echo: "still" });
    expect(events(m.store, "host_link_refused").length).toBe(1);
  });

  test("main marks a silent side down within DEAD_MS and records when it was last heard", async () => {
    const m = await mainUp();
    const sroot = side(m.store, "side-s");
    // A raw side that authenticates, then never answers a ping.
    const ws = new WebSocket(`${m.url}/link`);
    others.push({ stop: () => ws.close() });
    let up = false;
    ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as Row;
      if (f.t === "challenge") {
        const key = readFileSync(hostKeyPath(sroot), "utf8");
        ws.send(JSON.stringify({ t: "auth", link_version: LINK_VERSION, signature: signHello(key, Buffer.from(String(f.nonce), "base64"), LINK_VERSION, "side-s") }));
      }
      if (f.t === "welcome") up = true;
    };
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name: "side-s" }));
    await until("welcome", () => up);
    const t0 = Date.now();
    await until("main to mark it down", () => events(m.store, "host_link_down").length > 0, DEAD + PING * 4);
    expect(Date.now() - t0).toBeLessThanOrEqual(DEAD + PING * 2 + 150);
    expect(m.srv.links()).toEqual([]);
    const h = host(m.store, "side-s");
    expect(Number(h.unreachable_since)).toBe(Number(h.last_seen_at));
  });

  test("the side marks a silent main down within DEAD_MS", async () => {
    // A fake main (with a key of its own, pinned on the side) that welcomes, then never answers.
    const mk = newKeyPair(), sroot = temp();
    pinMainKey(sroot, mk.publicKey);
    let seal: Sealer | null = null;
    const fake = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
      websocket: {
        message(ws, raw) {
          if (seal) {
            if ((JSON.parse(seal.open(String(raw)) ?? "{}") as Row).t === "auth") ws.send(seal.seal({ t: "welcome", host: "side-m" }));
            return;
          }
          const f = JSON.parse(String(raw)) as Row;
          if (f.t !== "hello") return;
          const challenge = Buffer.alloc(32), kx = newKx(), nonce = b64Bytes(f.nonce, 32)!, sideKx = b64Bytes(f.kx, 32)!;
          ws.send(JSON.stringify({ t: "challenge", nonce: challenge.toString("base64"), link_version: LINK_VERSION, kx: kx.share,
            main_signature: signMain(mk.privateKey, Buffer.concat([nonce, sideKx, Buffer.from(kx.share, "base64")]), challenge, LINK_VERSION, "side-m") }));
          seal = sealer(kx.privateKey, sideKx, nonce, challenge, "main");
        },
      },
    });
    others.push({ stop: () => fake.stop(true) });
    const c = client(`127.0.0.1:${fake.port}`, sroot, "side-m");
    await c.start();
    const t0 = Date.now();
    await until("the side to mark it down", () => c.state === "down", DEAD + PING * 4);
    expect(Date.now() - t0).toBeLessThanOrEqual(DEAD + PING * 2 + 150);
    await expect(c.request("info", null)).rejects.toThrow(/main unreachable/);
  });

  test("a client with reconnect comes back after main restarts", async () => {
    const m = await mainUp();
    const sroot = side(m.store, "side-b");
    const c = new LinkClient({ main: m.url, root: sroot, name: "side-b", reconnect: true });
    clients.push(c);
    await c.start();
    const port = m.srv.port;
    await m.srv.stop();
    servers.splice(servers.indexOf(m.srv), 1);
    await until("down", () => c.state !== "up");
    const again = await startLinkServer({ root: m.root, store: m.store, binds: "127.0.0.1", port });
    servers.push(again);
    await until("up again", () => c.state === "up", 5000);
    expect(again.links()).toEqual(["side-b"]);
  });
});

describe("the link service's wish", () => {
  test("auto runs while a host is pending or accepted; on always; off never; the port follows link_port", () => {
    const root = temp(), s = open(root);
    stores.push(s);
    expect(linkListen(s)).toBe("auto");
    expect(syncLinkWish(s, 100)).toBeNull();                  // no hosts, auto: nothing to run, no row
    requestJoin(s, { name: "side-w", public_key: ensureHostKey(temp()).publicKey }, 100);
    expect(syncLinkWish(s, 101)).toMatchObject({ name: "link", want: "running", port: 7790, want_at: 101 });
    expect(syncLinkWish(s, 102)!.want_at).toBe(101);          // unchanged: no new wish
    s.db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES ('p1', 'limits.conf', 'link_listen', 'off', 1)");
    expect(syncLinkWish(s, 103)).toMatchObject({ want: "stopped", want_at: 103 });
    s.db.run("INSERT INTO config (project, file, key, value, observed_at) VALUES ('p2', 'limits.conf', 'link_listen', 'on', 1)");
    expect(linkListen(s)).toBe("on");                         // any project's on wins
    remove(s, "side-w");
    expect(syncLinkWish(s, 104)).toMatchObject({ want: "running" });
    process.env.DS_LIMIT_LINK_PORT = "7800";
    try { expect(syncLinkWish(s, 105)).toMatchObject({ want: "running", port: 7800, want_at: 105 }); }
    finally { delete process.env.DS_LIMIT_LINK_PORT; }
    expect(linkWish(s, 106).port).toBe(7790);
  });
});

describe("the server script", () => {
  const run = (args: string[], root: string) => Bun.spawn([process.execPath, join(ROOT, "bin", "link", "server.ts"), ...args], {
    env: { ...process.env, DS_STATE_ROOT: root }, stdout: "pipe", stderr: "pipe",
  });

  test("refuses a bind address that is neither loopback nor the tailnet address", async () => {
    const p = run(["0.0.0.0", "17791"], temp());
    expect(await p.exited).toBe(1);
    expect(await new Response(p.stderr).text()).toMatch(/refusing to bind 0\.0\.0\.0/);
  });

  test("answers /healthz with its pid", async () => {
    const root = temp();
    const port = 20000 + Math.floor(Math.random() * 20000);
    const p = run(["127.0.0.1", String(port)], root);
    others.push({ stop: () => p.kill() });
    let body: Row | null = null;
    for (let t = 0; t < 5000 && !body; t += 100) {
      body = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json() as Promise<Row>, () => null);
      if (!body) await Bun.sleep(100);
    }
    expect(body).toMatchObject({ ok: true, pid: p.pid, link_version: LINK_VERSION });
    p.kill();
    await p.exited;
  });
});
