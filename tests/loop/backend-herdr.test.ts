// backend-herdr.test.ts — the herdr backend (orca-backend-alternatives U15; bin/backend/herdr.ts):
// the contract v2 conformance suite, the server outliving its caller included, and layout B (one
// workspace per group, one tab per terminal) against the pinned herdr release in a temp HOME. The
// binary is fetched to a temp dir (sha256 checked); when it can't be (no network, another platform,
// DS_HERDR_FETCH=0) those cases are skipped with the reason printed. DS_HERDR_BIN uses a local binary.
// The mappings and the protocol pin need no binary and always run.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEYS, checked } from "../../bin/backend/contract.ts";
import {
  HERDR_CAPS, HERDR_PROTOCOL, agentState, fetchHerdr, groupKey, herdrBackend, herdrConfig, herdrKey, metaTokens,
  rpc, startHerdr, tail, tokensMeta,
} from "../../bin/backend/herdr.ts";
import { stopServer, unitName } from "../../bin/backend/server-unit.ts";
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

const got = await fetchHerdr(join(dir, "bin"));
if ("skip" in got) {
  console.log(`backend-herdr: the herdr server cases are skipped: ${got.skip}`);
  describe("herdr server", () => { test.skip(`conformance and layout B (skipped: ${got.skip})`, () => {}); });
} else {
  const bin = got.bin, home = join(dir, "home");
  const srv = await startHerdr({ bin, dir: join(dir, "srv"), name: `test-herdr-${process.pid}-${Date.now()}`, home, shell: "/bin/bash" });
  afterAll(() => stopServer(srv.handle));
  const svDir = join(dir, "sv"), svName = `test-herdr-sv-${process.pid}-${Date.now()}`, svLog = join(svDir, "server.log");

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

    test("the server runs on the loop's config, in its own session", () => {
      expect(readFileSync(srv.config, "utf8")).toContain("resume_agents_on_restore = false");
      expect(srv.session).toStartWith("ds-test-herdr-");
    });
  });
}
