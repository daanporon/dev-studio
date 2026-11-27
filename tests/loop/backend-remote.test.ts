// backend-remote.test.ts — side-loop-host U4 (issue #127): the remote backend adapter (bin/backend/remote.ts). A
// contract op for a member on a named host goes down that host's real link (a link server on one state root, a
// side client on a second), is answered there by the side's own backend through `handle()` on the `contract`
// channel (bin/link/channels/contract.ts), and comes back checked on main. It works from the loop's resolver
// (squad/contracts.ts, host given) and from a role-side CLI call in another process (bin/lib/contract-roles.ts
// makeBackend), both through main's link server socket. The whole conformance suite passes against it, in every
// capability mix of the side's fake. Terminal ids carry the host on main and lose it going down.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityMixes, checked, ContractError, type Backend, type Capabilities } from "../../bin/backend/contract.ts";
import { remoteBackend, CONTRACT_CHANNEL } from "../../bin/backend/remote.ts";
import { TMUX_CAPS } from "../../bin/backend/tmux.ts";
import { fakeContract, type FakeContract } from "../../bin/loop/fakes/contract.ts";
import { open, type Store } from "../../bin/loop/core/store.ts";
import { contracts } from "../../bin/loop/squad/contracts.ts";
import { makeBackend } from "../../bin/lib/contract-roles.ts";
import { accept, ensureHostKey, requestJoin, pinMainKey } from "../../bin/link/host-keys.ts";
import { LinkClient } from "../../bin/link/client.ts";
import { startLinkServer, type LinkServer } from "../../bin/link/server.ts";
import { contractChannel } from "../../bin/link/channels/contract.ts";
import { conformance } from "./backend-conformance.ts";

const saved: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries({ DS_LINK_PING_MS: "150", DS_LINK_DEAD_MS: "3000" })) { saved[k] = process.env[k]; process.env[k] = v; }

const temps: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "zzremote-")); temps.push(d); return d; };
const cwd = temp();
const MIXES = capabilityMixes();
// The side's fakes by backend name: `mix-<n>` runs capability mix n, `tmux` runs tmux's capabilities.
const fakes = new Map<string, FakeContract>();
function sideFake(_root: string, name: string, project: string): Backend | null {
  const k = `${name}\t${project}`;
  let f = fakes.get(k);
  if (!f) {
    let caps: Capabilities | null = null;
    if (name === "tmux") caps = TMUX_CAPS;
    else if (/^mix-\d+$/.test(name)) caps = MIXES[Number(name.slice(4))] ?? null;
    if (!caps) return null;
    f = fakeContract(caps);
    fakes.set(k, f);
  }
  return f;
}

type Rig = { root: string; store: Store; srv: LinkServer; client: LinkClient };
let rigP: Promise<Rig> | null = null;
/** Main (link server) and side host `side-a` (link client answering `contract` with the fakes), linked once. */
function rig(): Promise<Rig> {
  rigP ??= (async () => {
    const root = temp(), store = open(root);
    const srv = await startLinkServer({ root, store, binds: "127.0.0.1", port: 0 });
    const sroot = temp(), k = ensureHostKey(sroot);
    if (!requestJoin(store, { name: "side-a", public_key: k.publicKey }).ok || !accept(store, "side-a").ok) throw new Error("side-a not accepted");
    pinMainKey(sroot, srv.mainKey.publicKey);
    const client = new LinkClient({ main: `ws://127.0.0.1:${srv.port}`, root: sroot, name: "side-a", channels: new Map([[CONTRACT_CHANNEL, contractChannel(sideFake)]]) });
    await client.start();
    if (client.state !== "up") throw new Error(`link not up: ${client.state}`);
    return { root, store, srv, client };
  })();
  return rigP;
}

afterAll(async () => {
  if (rigP) { const r = await rigP; r.client.stop(); await r.srv.stop(); r.store.close(); }
  for (const t of temps) rmSync(t, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const remote = async (backend: string, host = "side-a") => remoteBackend({ root: (await rig()).root, host, backend, project: "realp" });

MIXES.forEach((caps, i) => {
  conformance({ name: `remote over the link (${JSON.stringify(caps)})`, make: () => remote(`mix-${i}`), cwd, wait: 1000 });
});

describe("the remote adapter", () => {
  test("ids carry the host on main and go down without it; the side's backend did the work", async () => {
    const b = checked(await remote("mix-0"));
    const c = await b.call("terminal.create", { cwd, label: "builder", env: { DS_GEN: "g1" } });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.terminal.id).toMatch(/^side-a:/);
    const side = fakes.get("mix-0\trealp")!;
    const sideId = c.terminal.id.slice("side-a:".length);
    expect(side.terms.has(sideId)).toBe(true);
    const l = await b.call("terminal.list", {});
    expect(l.ok && l.terminals.every((t) => t.id.startsWith("side-a:"))).toBe(true);
    await b.call("terminal.send", { id: c.terminal.id, text: "echo hi", submit: true });
    expect(side.calls.at(-1)).toEqual({ op: "terminal.send", req: { id: sideId, text: "echo hi", submit: true } });
    expect(await b.call("terminal.close", { id: c.terminal.id })).toEqual({ ok: true, closed: true });
  });

  test("an id without this host's prefix is not_found (a close closed:false) without a round trip", async () => {
    let sent = 0;
    const b = checked(remoteBackend({ root: "/nonexistent", host: "side-a", backend: "tmux", project: "realp", send: async () => { sent++; return { ok: true, closed: true }; } }));
    for (const id of ["%3", "side-b:%3", "side-a"]) {
      const r = await b.call("terminal.read", { id });
      expect(r.ok ? "ok" : r.error.code).toBe("not_found");
      expect(await b.call("terminal.close", { id })).toEqual({ ok: true, closed: false });
    }
    expect(sent).toBe(0);
  });

  test("an answer outside its op's type from the side throws a ContractError on main", async () => {
    const b = checked(await remote("mix-1"));
    const side = (sideFake("", "mix-1", "realp") as FakeContract);
    side.lie = "terminal.list";
    try { await expect(b.call("terminal.list", {})).rejects.toBeInstanceOf(ContractError); } finally { side.lie = null; }
  });

  test("a host not linked, no link server, a backend the side has not, a bad project: failed, naming the host", async () => {
    const r = await rig();
    const notLinked = await remoteBackend({ root: r.root, host: "side-z", backend: "tmux", project: "realp" }).call("terminal.list", {});
    expect(notLinked.ok ? "ok" : `${notLinked.error.code}: ${notLinked.error.message}`).toMatch(/^failed: host side-z: .*not linked/);
    const noServer = await remoteBackend({ root: temp(), host: "side-a", backend: "tmux", project: "realp" }).call("terminal.list", {});
    expect(noServer.ok ? "ok" : noServer.error.message).toContain("link server is not running");
    const noAdapter = await (await remote("orca")).call("terminal.list", {});
    expect(noAdapter.ok ? "ok" : noAdapter.error.message).toContain("no adapter");
    const badProject = await remoteBackend({ root: r.root, host: "side-a", backend: "tmux", project: "../etc" }).call("terminal.list", {});
    expect(badProject.ok ? "ok" : badProject.error.message).toContain("project is a name");
  });

  test("from the loop: the resolver gives a member on side-a the remote adapter, and local stays local", async () => {
    const r = await rig();
    const localFake = fakeContract(TMUX_CAPS);
    const resolve = contracts(() => ({ backend: checked(localFake), caps: TMUX_CAPS }));
    const onSide = resolve(r.store, "tmux", "realp", "side-a");
    expect(onSide.caps).toEqual(TMUX_CAPS);
    expect(resolve(r.store, "tmux", "realp", "side-a")).toBe(onSide);
    const c = await onSide.backend.call("terminal.create", { cwd, label: "builder" });
    expect(c.ok && c.terminal.id).toMatch(/^side-a:/);
    expect(localFake.terms.size).toBe(0);
    const local = resolve(r.store, "tmux", "realp");
    const lc = await local.backend.call("terminal.create", { cwd, label: "builder" });
    expect(lc.ok && lc.terminal.id).not.toMatch(/^side-a:/);
    expect(localFake.terms.size).toBe(1);
    if (c.ok) await onSide.backend.call("terminal.close", { id: c.terminal.id });
  });

  test("from a role-side CLI call in another process: makeBackend with a host reaches the side", async () => {
    const r = await rig();
    const before = await (await remote("tmux")).call("terminal.create", { cwd, label: "seen-from-cli" });
    expect(before.ok).toBe(true);
    const script = join(temp(), "cli.ts");
    const lib = join(import.meta.dir, "..", "..", "bin", "lib", "contract-roles.ts");
    writeFileSync(script, `import { makeBackend } from ${JSON.stringify(lib)};
const b = makeBackend(process.argv[2])("tmux", "realp", "side-a");
const l = await b.call("terminal.list", {});
console.log(JSON.stringify(l.ok ? l.terminals.map((t) => [t.id, t.label]) : l.error));
`);
    const p = Bun.spawn(["bun", script, r.root], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
    expect(`${code} ${err}`).toBe("0 ");
    const listed = JSON.parse(out) as [string, string][];
    expect(listed).toContainEqual([before.ok ? before.terminal.id : "", "seen-from-cli"]);
    expect(makeBackend(r.root)("orca", "realp", "side-a")).toBeNull();
    if (before.ok) await (await remote("tmux")).call("terminal.close", { id: before.terminal.id });
  }, 20_000);
});
