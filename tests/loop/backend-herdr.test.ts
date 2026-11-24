// backend-herdr.test.ts — the herdr backend (orca-backend-alternatives U15; bin/backend/herdr.ts):
// the contract v2 conformance suite, the server outliving its caller included, and layout B (one
// workspace per group, one tab per terminal) against the pinned herdr release in a temp HOME. The
// binary is fetched to a temp dir (sha256 checked); when it can't be (no network, another platform,
// DS_HERDR_FETCH=0) those cases are skipped with the reason printed. DS_HERDR_BIN uses a local binary.
// The mappings and the protocol pin need no binary and always run.
// U16c: the loop's per-project backend (projectHerdr: the server started on the first create only, the
// binary from herdrBin) and the resolvers that make it (contracts.ts, contract-roles.ts).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYS, checked } from "../../bin/backend/contract.ts";
import {
  HERDR_CAPS, HERDR_PROTOCOL, agentState, fetchHerdr, groupKey, herdrBackend, herdrConfig, herdrKey, metaTokens,
  herdrBin, herdrPinnedDir, projectHerdr, rpc, startHerdr, tail, tokensMeta,
} from "../../bin/backend/herdr.ts";
import { contracts } from "../../bin/loop/squad/contracts.ts";
import { makeBackend } from "../../bin/lib/contract-roles.ts";
import type { Store } from "../../bin/loop/core/store.ts";
import { stopServer, stopServerSync, unitName } from "../../bin/backend/server-unit.ts";
import { conformance } from "./backend-conformance.ts";

const dir = mkdtempSync(join(tmpdir(), "ds-hd-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const HERDR = join(import.meta.dir, "..", "..", "bin", "backend", "herdr.ts");

describe("herdr mappings", () => {
  test("every contract key has a herdr key name", () => {
    expect(KEYS.map(herdrKey)).toEqual(["enter", "esc", "tab", "backspace", "up", "down", "left", "right", "ctrl+c", "ctrl+d"]);
    expect(herdrKey("z" as never)).toBe("z");
  });

  test("herdr's agent status maps onto the contract's states", () => {
    expect(["working", "blocked", "idle", "done", "unknown", undefined, "new"].map(agentState))
      .toEqual(["working", "waiting", "idle", "idle", "unknown", "unknown", "unknown"]);
  });

  test("a terminal's facts survive the round trip through 80-character tokens", () => {
    const m = { id: "h-1", cwd: `/tmp/${"x".repeat(300)} with spaces`, label: "builder-u15", group: "squad ä", gen: "g-1", at: 1_700_000_000 };
    const t = metaTokens(m)!;
    expect(Object.keys(t).length).toBeLessThanOrEqual(15);
    for (const v of Object.values(t)) expect(v.length).toBeLessThanOrEqual(80);
    expect(Object.values(t).every((v) => v === v.trim())).toBe(true);
    expect(tokensMeta(t)).toEqual(m);
    expect(metaTokens({ ...m, cwd: "/".repeat(1200) })).toBeNull();
    expect(tokensMeta({ ...t, ds_id: "h-2" })).toBeNull();
    expect(tokensMeta({ ds_id: "h-1" })).toBeNull();
  });

  test("groups get distinct workspace keys that fit a token", () => {
    expect(groupKey(null)).toBe("none");
    expect(groupKey("a")).not.toBe(groupKey("b"));
    expect(groupKey("x".repeat(500)).length).toBeLessThanOrEqual(80);
  });

  test("a read keeps its last lines without the blank rows below", () => {
    expect(tail("a\nb\nc\n\n  \n")).toBe("a\nb\nc");
    expect(tail("a\nb\nc\n\n", 2)).toBe("b\nc");
    expect(tail("a\nb", 0)).toBe("");
  });

  test("the server's config resumes no agents and checks for no updates", () => {
    const c = herdrConfig("/bin/bash");
    expect(c).toContain("[session]\nresume_agents_on_restore = false");
    expect(c).toContain("version_check = false\nmanifest_check = false");
    expect(c).toContain('default_shell = "/bin/bash"');
  });
});

describe("herdr protocol pin", () => {
  // A socket that answers like herdr, with the given ping result.
  function fakeHerdr(sock: string, pong: Record<string, unknown>) {
    const s = createServer((c) => {
      let buf = "";
      c.setEncoding("utf8");
      c.on("data", (d: string) => {
        buf += d;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
          c.write(`${JSON.stringify(m.method === "ping" ? { id: m.id, result: { type: "pong", ...pong } } : { id: m.id, error: { code: "pane_not_found", message: "no" } })}\n`);
        }
      });
    });
    s.listen(sock);
    return s;
  }

  test("a server on another protocol is refused on every op", async () => {
    const sock = join(dir, "old.sock"), s = fakeHerdr(sock, { version: "0.9.0", protocol: HERDR_PROTOCOL - 1 });
    try {
      for (const op of ["backend.info", "terminal.list"] as const) {
        const a = await herdrBackend(sock).call(op, {});
        expect(a.ok ? "ok" : `${a.error.code}: ${a.error.message}`).toContain(`failed: herdr server 0.9.0 speaks protocol ${HERDR_PROTOCOL - 1}`);
      }
    } finally { s.close(); }
  });

  test("the pinned protocol answers backend.info, and herdr's not_found codes map to not_found", async () => {
    const sock = join(dir, "pin.sock"), s = fakeHerdr(sock, { version: "0.9.5", protocol: HERDR_PROTOCOL });
    try {
      const b = checked(herdrBackend(sock));
      expect(await b.call("backend.info", {})).toEqual({ ok: true, name: "herdr", version: "0.9.5", capabilities: HERDR_CAPS });
      expect((await rpc(sock, "pane.get", { pane_id: "w1:p1" })).error?.code).toBe("pane_not_found");
    } finally { s.close(); }
  });

  test("no server answers failed, not a throw", async () => {
    const a = await herdrBackend(join(dir, "none.sock")).call("terminal.list", {});
    expect(a.ok ? "ok" : a.error.code).toBe("failed");
  });
});

describe("herdr for a project, no server", () => {
  test("herdrBin: DS_HERDR_BIN, else the pinned install, else PATH", () => {
    const data = join(dir, "data"), pinned = join(herdrPinnedDir(undefined, { XDG_DATA_HOME: data }), "herdr");
    const given = join(dir, "given-herdr");
    writeFileSync(given, "");
    const onPath = () => "/usr/bin/herdr";
    expect(herdrBin({ env: { DS_HERDR_BIN: given, XDG_DATA_HOME: data }, which: onPath })).toBe(given);
    expect(herdrBin({ env: { DS_HERDR_BIN: join(dir, "gone"), XDG_DATA_HOME: data }, which: onPath })).toBeNull();
    expect(herdrBin({ env: { XDG_DATA_HOME: data }, which: onPath })).toBe("/usr/bin/herdr");
    mkdirSync(join(pinned, ".."), { recursive: true });
    writeFileSync(pinned, "");
    expect(pinned).toBe(join(data, "dev-studio", "herdr", "0.9.5", "herdr"));
    expect(herdrBin({ env: { XDG_DATA_HOME: data }, which: onPath })).toBe(pinned);
    expect(herdrBin({ env: { HOME: join(dir, "nohome") }, which: () => null })).toBeNull();
  });

  test("a read starts no server: an empty list, nothing closed, a terminal not found", async () => {
    const raw = projectHerdr("realp", { stateRoot: join(dir, "state") }), b = checked(raw);
    expect(raw.dir).toBe(join(dir, "state", "realp", "loop", "herdr"));
    expect(await b.call("terminal.list", {})).toEqual({ ok: true, terminals: [] });
    expect(await b.call("terminal.close", { id: "h-1" })).toEqual({ ok: true, closed: false });
    for (const a of [await b.call("agent.state", { id: "h-1" }), await b.call("terminal.read", { id: "h-1" })])
      expect(a.ok ? "ok" : a.error.code).toBe("not_found");
    expect(existsSync(raw.dir)).toBe(false);
  });

  test("a create with no binary fails naming how to install it, and starts nothing", async () => {
    const was = process.env.DS_HERDR_BIN;
    process.env.DS_HERDR_BIN = join(dir, "no-such-herdr");
    try {
      const a = await projectHerdr("realp", { stateRoot: join(dir, "state") }).call("terminal.create", { cwd: dir, label: "lead", group: "sq" });
      expect(a.ok ? "ok" : a.error.message).toContain("install it with: bun bin/backend/herdr.ts install");
    } finally { if (was === undefined) delete process.env.DS_HERDR_BIN; else process.env.DS_HERDR_BIN = was; }
  });

  test("a state root too deep for a unix socket puts the server's files in a short folder", () => {
    const deep = join(dir, "x".repeat(90));
    const b = projectHerdr("realp", { stateRoot: deep });
    expect(b.dir.startsWith(deep)).toBe(false);
    expect(Buffer.byteLength(b.socket)).toBeLessThanOrEqual(100);
    expect(projectHerdr("realp", { stateRoot: deep }).socket).toBe(b.socket);
  });

  test("the loop and the role scripts make herdr for a squad on it", () => {
    const store = { root: join(dir, "state") } as Store;
    const c = contracts()(store, "herdr", "realp");
    expect(c.caps).toEqual(HERDR_CAPS);
    expect(makeBackend(join(dir, "state"))("herdr", "realp")).not.toBeNull();
  });
});

const got = await fetchHerdr(join(dir, "bin"));
if ("skip" in got) {
  console.log(`backend-herdr: the herdr server cases are skipped: ${got.skip}`);
  describe("herdr server", () => { test.skip(`conformance and layout B (skipped: ${got.skip})`, () => {}); });
} else {
  const bin = got.bin, home = join(dir, "home");
  // A killed or timed-out run skips afterAll: an exit guard stops the units synchronously, and
  // RuntimeMaxSec ends them even when the guard never ran (SIGKILL of the test process).
  const MAX_RUNTIME_S = 1800;
  process.env.DS_HERDR_MAX_RUNTIME_S = String(MAX_RUNTIME_S);
  const srv = await startHerdr({ bin, dir: join(dir, "srv"), name: `test-herdr-${process.pid}-${Date.now()}`, home, shell: "/bin/bash", maxRuntimeS: MAX_RUNTIME_S });
  afterAll(() => stopServer(srv.handle));
  const svDir = join(dir, "sv"), svName = `test-herdr-sv-${process.pid}-${Date.now()}`, svLog = join(svDir, "server.log");
  const guard = () => {
    stopServerSync(srv.handle);
    stopServerSync({ pid: 0, via: "systemd", unit: unitName(svName), log: svLog });
  };
  process.on("exit", guard);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { guard(); process.exit(1); });

  conformance({
    name: "herdr",
    make: () => herdrBackend(srv.socket),
    cwd: dir,
    timeout: 30_000,
    survive: {
      caller: [process.execPath, HERDR, "caller", bin, svDir, svName, home],
      client: () => herdrBackend(join(svDir, "herdr.sock")),
      stop: (r) => stopServer({ pid: r.pid, via: r.via as "systemd" | "detached", unit: r.via === "systemd" ? unitName(svName) : null, log: svLog }),
    },
  });

  describe("herdr layout B", () => {
    type P = { pane_id: string; tab_id: string; workspace_id: string; tokens?: Record<string, string> };
    const panes = async () => ((await rpc(srv.socket, "pane.list")).result?.panes ?? []) as P[];
    const spaces = async () => ((await rpc(srv.socket, "workspace.list")).result?.workspaces ?? []) as { workspace_id: string; label: string; tokens?: Record<string, string> }[];

    test("one workspace per group, one tab per terminal, the group's workspace closes with its last tab", async () => {
      const b = checked(herdrBackend(srv.socket));
      const mk = async (label: string, group: string) => {
        const a = await b.call("terminal.create", { cwd: dir, label, group });
        if (!a.ok) throw new Error(a.error.message);
        return a.terminal.id;
      };
      const g1 = `sq-${process.pid}-1`, g2 = `sq-${process.pid}-2`;
      const [lead, thinker, other] = [await mk("lead", g1), await mk("thinker", g1), await mk("lead", g2)];
      const by = new Map((await panes()).map((p) => [p.tokens?.ds_id, p]));
      const [pl, pt, po] = [by.get(lead)!, by.get(thinker)!, by.get(other)!];
      expect(pl.workspace_id).toBe(pt.workspace_id);
      expect(pl.tab_id).not.toBe(pt.tab_id);
      expect(po.workspace_id).not.toBe(pl.workspace_id);
      const ws = (await spaces()).find((w) => w.workspace_id === pl.workspace_id)!;
      expect(ws).toMatchObject({ label: g1, tokens: { ds_g: groupKey(g1) } });
      const tabs = ((await rpc(srv.socket, "tab.list", { workspace_id: pl.workspace_id })).result?.tabs ?? []) as { tab_id: string; label: string }[];
      expect(tabs.map((t) => t.label).sort()).toEqual(["lead", "thinker"]);

      expect(await b.call("terminal.close", { id: lead })).toEqual({ ok: true, closed: true });
      expect((await spaces()).some((w) => w.workspace_id === pl.workspace_id)).toBe(true);
      expect(await b.call("terminal.close", { id: thinker })).toEqual({ ok: true, closed: true });
      expect((await spaces()).some((w) => w.tokens?.ds_g === groupKey(g1))).toBe(false);
      const again = await mk("lead", g1);
      expect((await panes()).find((p) => p.tokens?.ds_id === again)!.workspace_id).not.toBe(po.workspace_id);
      for (const id of [again, other]) await b.call("terminal.close", { id });
    }, 30_000);

    test("a project's backend starts its server on the first create; a new client finds it; a gone server reads empty and starts again", async () => {
      const project = `realp-${process.pid}`, stateRoot = join(dir, "pstate");
      const opts = { stateRoot, bin, home, shell: "/bin/bash", maxRuntimeS: MAX_RUNTIME_S };
      const b = projectHerdr(project, opts);
      const stop = async () => { const s = b.server(); if (s) await stopServer(s.handle); };
      process.on("exit", () => { const s = b.server(); if (s) stopServerSync(s.handle); });
      try {
        expect(await b.call("terminal.list", {})).toEqual({ ok: true, terminals: [] });
        const a = await b.call("terminal.create", { cwd: dir, label: "lead", group: "sq", env: { DS_GEN: "g1" } });
        if (!a.ok) throw new Error(a.error.message);
        expect(b.server()?.session).toBe(`ds-herdr-${project}`);
        expect(readFileSync(join(b.dir, "config.toml"), "utf8")).toContain("resume_agents_on_restore = false");
        // A new loop process: another client of the same project lists the terminal and starts nothing.
        const again = projectHerdr(project, opts);
        expect((await again.call("terminal.list", {})).ok && (await again.call("terminal.list", {}) as { terminals: { id: string; gen: string | null }[] }).terminals.map((t) => [t.id, t.gen])).toEqual([[a.terminal.id, "g1"]]);
        expect(await again.ensureServer()).toBeNull();
        // The trial's sampler reads the same server and prints one line per terminal.
        const sampled = Bun.spawnSync(["bun", join(import.meta.dir, "../../bin/backend/herdr.ts"), "states", stateRoot, project]);
        expect(sampled.exitCode).toBe(0);
        expect(sampled.stdout.toString().trim().split("\t").slice(1, 4)).toEqual([a.terminal.id, "sq/lead", "g1"]);
        // The server gone (a crash, an upgrade): reads are empty, the next create starts a new one.
        await stop();
        expect(await again.call("terminal.list", {})).toEqual({ ok: true, terminals: [] });
        const c = await again.call("terminal.create", { cwd: dir, label: "lead", group: "sq" });
        if (!c.ok) throw new Error(c.error.message);
        expect(again.server()).not.toBeNull();
        await stopServer(again.server()!.handle);
      } finally { await stop().catch(() => {}); }
    }, 60_000);

    test("the server runs on the loop's config, in its own session", () => {
      expect(readFileSync(srv.config, "utf8")).toContain("resume_agents_on_restore = false");
      expect(srv.session).toStartWith("ds-test-herdr-");
    });
  });
}
