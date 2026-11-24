// tmux-drill.test.ts — `ds tmux-drill` (orca-backend-alternatives U16b, docs/backends/trial-tmux.md): the
// version drill's mechanics with one tmux build as both old and new, the real version change when
// DS_TMUX_NEW names a second build, and the snapshot of a project's server. Skipped with the reason printed
// when no tmux binary exists.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot, versionDrill } from "../../bin/commands/tmux-drill.ts";
import { projectTmux } from "../../bin/backend/tmux.ts";

const tmux = Bun.which("tmux");
const newer = process.env.DS_TMUX_NEW;
if (!tmux) console.log("skip: no tmux on PATH, the tmux drill is not run");
if (tmux && !newer) console.log("skip: DS_TMUX_NEW names no second tmux build, the real version change is not run (nix build --no-link --print-out-paths nixpkgs#tmux)");

const root = mkdtempSync(join(tmpdir(), "ds-tmux-drill-test-"));
const project = `zz-drill-${process.pid}-${Date.now() % 100000}`;
const back = projectTmux(project, { stateRoot: root, shell: "/bin/sh" });
afterAll(async () => { await back.killServer(); rmSync(root, { recursive: true, force: true }); });

test.skipIf(!tmux)("the drill on one build: every op passes, the agent outlives the client, the server is stopped after", async () => {
  const r = await versionDrill({ oldBin: tmux!, newBin: tmux! });
  expect(r.steps.map((s) => s.op)).toEqual(["list-sessions (new client)", "terminal.list", "terminal.read", "terminal.last_output",
    "terminal.create", "terminal.send", "terminal.close"]);
  expect(r.failed).toBe(0);
  expect(r.refused).toBe(false);
  expect(r.agent_alive).toBe(true);
  expect(r.old_client_after).toBe("ok (1 terminal(s))");
  expect(r.steps[1].detail).toBe("1 terminal(s), gen drill-old");
  // The drill's server is gone and took its stand-in agent with it.
  await Bun.sleep(200);
  expect(() => process.kill(r.server.pid, 0)).toThrow();
});

test.skipIf(!tmux || !newer)("the real version change: a client of the new build on a server of the old one", async () => {
  const r = await versionDrill({ oldBin: tmux!, newBin: newer! });
  console.log(`tmux drill: ${r.old.version} server, ${r.new.version} client: ${r.refused ? "refused" : r.failed ? `${r.failed} failed` : "accepted"}`);
  expect(r.old.version).not.toBe(r.new.version);
  expect(r.agent_alive).toBe(true);
  expect(r.old_client_after.startsWith("ok")).toBe(true);
});

test.skipIf(!tmux)("snapshot: a project with no server says it is down; with one it lists each window's label, gen and processes", async () => {
  const down = snapshot(project, { root });
  expect(down.socket).toBe(`ds-${project}`);
  expect("down" in down.server).toBe(true);
  expect(down.windows).toEqual([]);
  const made = await back.call("terminal.create", { cwd: root, env: { DS_GEN: "snap-gen" }, label: "builder-x", group: "sq" });
  expect(made.ok).toBe(true);
  if (!made.ok) return;
  await back.call("terminal.send", { id: made.terminal.id, text: "sleep 300", submit: true });
  let up = snapshot(project, { root });
  for (let t = 0; t < 30 && !up.windows[0]?.processes.some((p) => p.includes("sleep 300")); t++) { await Bun.sleep(100); up = snapshot(project, { root }); }
  expect("pid" in up.server && up.server.pid > 0).toBe(true);
  expect(up.windows).toHaveLength(1);
  expect(up.windows[0]).toMatchObject({ session: expect.stringContaining("sq"), pane: made.terminal.id, label: "builder-x", gen: "snap-gen" });
  expect(up.windows[0].processes.some((p) => p.includes("sleep 300"))).toBe(true);
  expect(up.members).toEqual([]);
});
