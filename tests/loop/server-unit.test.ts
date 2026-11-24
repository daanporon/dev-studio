// server-unit.test.ts — bin/backend/server-unit.ts (orca-backend-alternatives U2): a server started
// through the helper outlives the process that started it, detached and (where `systemctl --user`
// works) in its own transient user unit; it gets the env it was given, stops on stopServer, and a unit
// name already taken falls back to a detached start.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../../bin/loop/core/cli.ts";
import { firstLine } from "./backend-conformance.ts";
import { type ServerHandle, exitCodeOf, serverAlive, startServer, stopServer, systemdUp, unitName } from "../../bin/backend/server-unit.ts";

const dir = mkdtempSync(join(tmpdir(), "ds-su-"));
const started: ServerHandle[] = [];
afterAll(async () => { for (const h of started) await stopServer(h); rmSync(dir, { recursive: true, force: true }); });
const HELPER = join(import.meta.dir, "..", "..", "bin", "backend", "server-unit.ts");
let n = 0;
const name = () => `test-su-${process.pid}-${Date.now()}-${++n}`;
const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };

// A caller process: starts `sh -c 'echo $SU_MARK; exec sleep 300'` through the helper, prints the
// handle as JSON and waits to be killed.
async function viaCaller(systemd: boolean, log: string, nm: string): Promise<ServerHandle> {
  const code = `import { startServer } from ${JSON.stringify(HELPER)};
const h = await startServer({ name: ${JSON.stringify(nm)}, log: ${JSON.stringify(log)}, argv: ["sh", "-c", 'echo "mark=$SU_MARK"; exec sleep 300'],
  env: { PATH: process.env.PATH ?? "", SU_MARK: "m-${nm}" } });
console.log(JSON.stringify(h)); setInterval(() => {}, 1 << 30);`;
  const p = Bun.spawn([process.execPath, "-e", code], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, DS_SERVER_SYSTEMD: systemd ? "1" : "0" } });
  const out = await firstLine(p.stdout, 20_000);
  if (!out.trim()) { p.kill("SIGKILL"); throw new Error(`caller printed nothing: ${await new Response(p.stderr).text()}`); }
  const h = JSON.parse(out.trim().split("\n")[0]!) as ServerHandle;
  started.push(h);
  p.kill("SIGKILL");
  await p.exited;
  return h;
}

describe("server-unit", () => {
  test("unitName keeps a unit name safe", () => {
    expect(unitName("tmux my/proj")).toBe("ds-tmux-my-proj");
  });

  test("an empty argv is refused", async () => {
    await expect(startServer({ name: name(), argv: [], log: join(dir, "x.log") })).rejects.toThrow("empty argv");
  });

  test("detached: the server outlives its killed caller, has its env, and stops", async () => {
    const nm = name(), log = join(dir, `${nm}.log`);
    const h = await viaCaller(false, log, nm);
    expect(h.via).toBe("detached");
    expect(h.unit).toBeNull();
    await Bun.sleep(300);
    expect(serverAlive(h.pid)).toBe(true);
    expect(await waitFor(3, () => read(log).includes(`mark=m-${nm}`))).toBe(true);
    await stopServer(h);
    expect(serverAlive(h.pid)).toBe(false);
    expect(exitCodeOf(h)).toBeNull();
  }, 30_000);

  test.skipIf(!systemdUp())("systemd: the server runs in its own unit, outlives its killed caller, and stops with the unit", async () => {
    const nm = name(), log = join(dir, `${nm}.log`);
    const h = await viaCaller(true, log, nm);
    expect(h.via).toBe("systemd");
    expect(h.unit).toBe(unitName(nm));
    await Bun.sleep(300);
    expect(serverAlive(h.pid)).toBe(true);
    expect(read(`/proc/${h.pid}/cgroup`)).toContain(`${unitName(nm)}.service`);
    expect(await waitFor(3, () => read(log).includes(`mark=m-${nm}`))).toBe(true);
    await stopServer(h);
    expect(serverAlive(h.pid)).toBe(false);
    const active = Bun.spawnSync(["systemctl", "--user", "is-active", `${unitName(nm)}.service`]).stdout.toString().trim();
    expect(active).not.toBe("active");
  }, 30_000);

  test.skipIf(!systemdUp())("systemd: the exit code of a server that ends is read from <log>.exit", async () => {
    const nm = name(), log = join(dir, `${nm}.log`);
    const h = await startServer({ name: nm, log, argv: ["sh", "-c", "exit 7"], env: { PATH: process.env.PATH ?? "" } });
    started.push(h);
    expect(h.via).toBe("systemd");
    expect(await waitFor(5, () => exitCodeOf(h) === 7)).toBe(true);
  }, 15_000);

  test.skipIf(!systemdUp())("systemd: a unit name already taken falls back to a detached start", async () => {
    const nm = name(), log1 = join(dir, `${nm}-1.log`), log2 = join(dir, `${nm}-2.log`);
    const env = { PATH: process.env.PATH ?? "" };
    const a = await startServer({ name: nm, log: log1, argv: ["sleep", "300"], env });
    started.push(a);
    const b = await startServer({ name: nm, log: log2, argv: ["sleep", "300"], env });
    started.push(b);
    expect(a.via).toBe("systemd");
    expect(b.via).toBe("detached");
    expect(serverAlive(a.pid) && serverAlive(b.pid)).toBe(true);
  }, 30_000);
});
