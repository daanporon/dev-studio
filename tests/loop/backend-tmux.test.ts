// backend-tmux.test.ts — the tmux backend (orca-backend-alternatives U14; bin/backend/tmux.ts) against
// the conformance suite on a real tmux server on a private socket, including a server that outlives the
// process that started it. With no tmux binary on PATH every case is skipped with the reason printed.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopServer, unitName } from "../../bin/backend/server-unit.ts";
import { sessionName, tmuxArg, tmuxBackend } from "../../bin/backend/tmux.ts";
import { conformance } from "./backend-conformance.ts";

const TMUX = Bun.which("tmux");
const ADAPTER = join(import.meta.dir, "..", "..", "bin", "backend", "tmux.ts");

if (!TMUX) {
  console.log("backend-tmux.test.ts: skipped, no tmux binary on PATH");
  test.skip("tmux backend (no tmux binary on PATH)", () => {});
} else {
  const dir = mkdtempSync(join(tmpdir(), "ds-tmux-"));
  const stamp = `${process.pid}-${Date.now()}`;
  const sock = join(dir, "t.sock"), sSock = join(dir, "s.sock");
  const sName = `test-tmux-${stamp}`, sLog = join(dir, "survive.log");
  const main = tmuxBackend({ socket: sock, server: { name: `test-tmux-main-${stamp}`, log: join(dir, "main.log") }, shell: "/bin/sh" });
  afterAll(async () => {
    await main.killServer();
    await tmuxBackend({ socket: sSock }).killServer();
    rmSync(dir, { recursive: true, force: true });
  });

  conformance({
    name: "tmux",
    make: () => main,
    cwd: dir,
    wait: 5000,
    survive: {
      caller: [process.execPath, ADAPTER, "caller", sSock, sName, sLog, "/bin/sh"],
      client: () => tmuxBackend({ socket: sSock }),
      stop: (r) => stopServer({ pid: r.pid, via: r.via as "systemd" | "detached", unit: r.via === "systemd" ? unitName(sName) : null, log: sLog }),
    },
  });

  describe("the tmux backend's own parts", () => {
    test("one session per group: two members of a squad share it, the meta survives a reread", async () => {
      const a = await main.call("terminal.create", { cwd: dir, label: "lead", group: "sq.one", env: { DS_GEN: "g1" } });
      const b = await main.call("terminal.create", { cwd: dir, label: "builder-x", group: "sq.one" });
      if (!a.ok || !b.ok) throw new Error("create failed");
      const p = Bun.spawnSync([TMUX, "-N", "-S", sock, "list-panes", "-a", "-F", "#{pane_id} #{session_name} #{window_name}"]);
      const rows = p.stdout.toString();
      expect(rows).toContain(`${a.terminal.id} sq_one lead`);
      expect(rows).toContain(`${b.terminal.id} sq_one builder-x`);
      const l = await tmuxBackend({ socket: sock }).call("terminal.list", {});
      expect(l.ok && l.terminals.find((t) => t.id === a.terminal.id)).toMatchObject({ group: "sq.one", gen: "g1", label: "lead" });
      for (const id of [a.terminal.id, b.terminal.id]) await main.call("terminal.close", { id });
    });

    test("text is typed as it is: a trailing ';' and tmux words are not parsed", async () => {
      const t = await main.call("terminal.create", { cwd: dir, label: "lit" });
      if (!t.ok) throw new Error("create failed");
      await main.call("terminal.send", { id: t.terminal.id, text: "echo kill-server; echo done-lit;", submit: true });
      let text = "";
      for (let i = 0; i < 100 && !text.includes("done-lit\n"); i++) {
        const r = await main.call("terminal.read", { id: t.terminal.id });
        text = r.ok ? `${r.text}\n` : "";
        await Bun.sleep(50);
      }
      expect(text).toContain("kill-server\ndone-lit");
      await main.call("terminal.close", { id: t.terminal.id });
    });

    test("no server: list is empty, a terminal op is not_found, a create without a server option fails", async () => {
      const none = tmuxBackend({ socket: join(dir, "none.sock") });
      expect(await none.call("terminal.list", {})).toEqual({ ok: true, terminals: [] });
      const r = await none.call("terminal.read", { id: "%1" });
      expect(r.ok ? "ok" : r.error.code).toBe("not_found");
      const s = await none.call("terminal.send", { id: "%1", text: "x".repeat(2_000_000) });
      expect(s.ok ? "ok" : s.error.code).toBe("not_found");
      expect(await none.call("terminal.close", { id: "%1" })).toEqual({ ok: true, closed: false });
      const c = await none.call("terminal.create", { cwd: dir, label: "x" });
      expect(c.ok ? "ok" : c.error.code).toBe("failed");
    });

    test("a fresh server: parallel creates in one new group start one server and one session; the starter's identity is not inherited; '#' stays literal", async () => {
      const keep = { DS_MEMBER: process.env.DS_MEMBER, DS_GEN: process.env.DS_GEN };
      process.env.DS_MEMBER = "p/sq/builder-x";
      process.env.DS_GEN = "starter";
      const fresh = tmuxBackend({ socket: join(dir, "f.sock"), server: { name: `test-tmux-fresh-${stamp}`, log: join(dir, "fresh.log") }, shell: "/bin/sh" });
      try {
        const odd = join(dir, "w##x#S");
        mkdirSync(odd);
        const made = await Promise.all([1, 2, 3].map((i) => fresh.call("terminal.create", { cwd: odd, label: `m#S${i}`, group: "par" })));
        for (const a of made) expect(a.ok ? "ok" : a.error.message).toBe("ok");
        const ids = made.map((a) => (a.ok ? a.terminal.id : ""));
        expect(new Set(ids).size).toBe(3);
        const p = Bun.spawnSync([TMUX, "-N", "-S", join(dir, "f.sock"), "list-panes", "-a", "-F", "#{session_name} #{window_name}"]);
        expect(p.stdout.toString().trim().split("\n").sort()).toEqual(["par m#S1", "par m#S2", "par m#S3"]);
        await fresh.call("terminal.send", { id: ids[0]!, text: 'echo "id=[$DS_MEMBER][$DS_GEN]"; pwd', submit: true });
        let text = "";
        for (let i = 0; i < 100 && !text.includes(odd); i++) {
          const r = await fresh.call("terminal.read", { id: ids[0]! });
          text = r.ok ? r.text : "";
          await Bun.sleep(50);
        }
        expect(text).toContain("id=[][]");
        expect(text).toContain(odd);
      } finally {
        Object.assign(process.env, keep);
        for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k];
        await fresh.killServer();
      }
    });

    test("a faint prompt suggestion is not read as text (U20b)", async () => {
      const t = await main.call("terminal.create", { cwd: dir, label: "faint" });
      if (!t.ok) throw new Error("create failed");
      await main.call("terminal.send", { id: t.terminal.id, text: "printf '\\033[39m> \\033[2msuggest me\\033[22m\\033[0m\\ntyped\\n'", submit: true });
      let text = "";
      for (let i = 0; i < 50 && !/^typed$/m.test(text); i++) { await Bun.sleep(100); const r = await main.call("terminal.read", { id: t.terminal.id, screen: true }); if (r.ok) text = r.text + "\n"; }
      expect(text).toMatch(/^> \ntyped$/m);
      expect(text).not.toMatch(/^> suggest me$/m);
      await main.call("terminal.close", { id: t.terminal.id });
    });

    test("a missing cwd fails the create", async () => {
      const c = await main.call("terminal.create", { cwd: join(dir, "nope"), label: "x" });
      expect(c.ok ? "ok" : c.error.code).toBe("failed");
    });

    test("argument and name helpers", () => {
      expect(tmuxArg("a;")).toBe("a\\;");
      expect(tmuxArg("a;b")).toBe("a;b");
      expect(sessionName("sq.one:x")).toBe("sq_one_x");
      expect(sessionName("")).toBe("_ds");
    });
  });
}
