// orca-backend-alternatives U20a: on a real tmux pane whose shell sleeps 2 s before its prompt, the short
// typed line (`exec bash <file>`) still runs the full ~9,000-byte launch line. Typed whole into a shell still
// in line mode, such a line is cut at 4,095 bytes. Skipped with the reason printed when no tmux is on PATH.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tmuxBackend } from "../../bin/backend/tmux.ts";
import { writeLaunch } from "../../bin/loop/squad/launch-file.ts";

if (!Bun.which("tmux")) {
  console.log("launch-slow-shell.test.ts: skipped, no tmux binary on PATH");
  test.skip("slow shell (no tmux binary on PATH)", () => {});
} else {
  const dir = mkdtempSync(join(tmpdir(), "zzslow-"));
  const slow = join(dir, "slow-sh");
  writeFileSync(slow, "#!/bin/sh\nsleep 2\nexec /bin/sh\n");
  chmodSync(slow, 0o755);
  const b = tmuxBackend({ socket: join(dir, "t.sock"), server: { name: `test-slow-${process.pid}-${Date.now()}`, log: join(dir, "s.log") }, shell: slow });
  afterAll(async () => { await b.killServer(); rmSync(dir, { recursive: true, force: true }); });

  test("a shell that is slow to start still runs the whole launch line", async () => {
    const marker = join(dir, "ran");
    const line = `: '${"x".repeat(9000)}'; echo "$DS_GEN $(printf %s "$DS_MEMBER")" > ${marker}`;
    expect(line.length).toBeGreaterThan(4096);
    const gen = "gen-slow";
    const made = await b.call("terminal.create", { cwd: dir, label: "builder-u1", env: { DS_GEN: gen, DS_MEMBER: "realp/sq/builder-u1" } });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const typed = writeLaunch(dir, "realp", dir, gen, line);
    expect(Buffer.byteLength(typed)).toBeLessThan(512);
    const sent = await b.call("terminal.send", { id: made.terminal.id, text: typed, submit: true });
    expect(sent.ok).toBe(true);
    const until = Date.now() + 15_000;
    while (!existsSync(marker) && Date.now() < until) await Bun.sleep(100);
    expect(readFileSync(marker, "utf8").trim()).toBe(`${gen} realp/sq/builder-u1`);
  }, 30_000);
}
