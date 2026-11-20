// U116: a pause holds back only its own target. One paused role must not stop project-wide notices,
// role reassertion, or the Studio's close/suspend; each fan-out recipient is checked on its own.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { actionBlock } from "../../bin/loop/pause/pause.ts";
import type { Action } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";

const T = 1_800_000_000, repo = join(import.meta.dir, "../..");
const roots: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch {} }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "loop-fanout-")); roots.push(root);
  const s = open(root); stores.push(s);
  s.upsert("projects", { label: "p" }, { observed_at: T });
  for (const squad of ["one", "two"]) {
    s.upsert("squads", { project: "p", topic: squad }, { status: "running", run_id: `run_${squad}`, lead_wt: `wt-${squad}-lead`, repo: "path:/fake",
      doc: JSON.stringify({ topic: squad, members: [], units: [], worktrees: [] }), observed_at: T, updated_at: T });
    for (const [r, suffix] of [["lead", ""], ["builder", "task"]])
      s.upsert("members", { project: "p", squad, role: r, suffix }, { wt: `wt-${squad}-${r}`, status: "running", agent: "claude", model: "opus", account: "a", observed_at: T, updated_at: T });
  }
  s.upsert("members", { project: "p", squad: "studio", role: "studio", suffix: "" }, { wt: "wt-studio", status: "running", observed_at: T, updated_at: T });
  return { s, root };
}
const fan = (kind: string, ...words: string[]): Action => ({ project: "p", subject: kind, kind, episode: "1", payload: { argv: [kind, ...words] } });
const studio = (action: string, topic = "one"): Action => ({ project: "p", squad: topic, subject: action, kind: "studio", episode: "1", payload: { action, topic } });
const builder = { scope: "member", project: "p", squad: "one", role: "builder", suffix: "task" } as const;

test("one paused role does not hold back a project-wide notice or reassertion; a pause on the scope still does", () => {
  const { s } = fixture();
  s.pause(builder);
  expect(actionBlock(s, fan("notify-squads", "p"))).toBeNull();
  expect(actionBlock(s, fan("reassert-roles", "p"))).toBeNull();
  expect(actionBlock(s, fan("reassert-roles", "p", "one"))).toBeNull();
  s.pause({ scope: "squad", project: "p", squad: "one" });
  expect(actionBlock(s, fan("reassert-roles", "p", "one"))).toBe("paused");
  expect(actionBlock(s, fan("notify-squads", "p"))).toBeNull();
  s.pause({ scope: "project", project: "p" });
  expect(actionBlock(s, fan("notify-squads", "p"))).toBe("paused");
  expect(actionBlock(s, fan("reassert-roles", "p"))).toBe("paused");
});

test("Studio close and suspend run on a paused squad and project; restart stays blocked", () => {
  const { s } = fixture();
  s.pause({ scope: "squad", project: "p", squad: "one" });
  for (const action of ["close", "suspend", "resume", "reload"]) expect(actionBlock(s, studio(action))).toBeNull();
  expect(actionBlock(s, studio("restart"))).toBe("paused");
  s.pause({ scope: "project", project: "p" });
  for (const action of ["close", "suspend"]) expect(actionBlock(s, studio(action, "two"))).toBeNull();
  expect(actionBlock(s, studio("restart", "two"))).toBe("paused");
});

function runScript(script: string, s: Store, root: string, a: Action, args: string[]) {
  const copy = join(root, "copy"), bin = join(copy, "bin"), dir = join(root, "p/squads"); // the scripts read DS_STATE_ROOT (U253), which is root
  mkdirSync(bin, { recursive: true }); mkdirSync(dir, { recursive: true });
  const folder: Record<string, string> = { "notify-squads.sh": "commands", "reassert-roles.sh": "hooks" };
  for (const [name, dir] of Object.entries(folder)) { mkdirSync(join(bin, dir), { recursive: true }); cpSync(join(repo, "bin", dir, name), join(bin, dir, name)); }
  cpSync(join(repo, "bin/hooks/arm-picker.sh"), join(bin, "hooks/arm-picker.sh"));
  cpSync(join(repo, "bin/ds"), join(bin, "ds")); cpSync(join(repo, "bin/ds.ts"), join(bin, "ds.ts"));
  symlinkSync(join(repo, "bin/loop"), join(bin, "loop"));
  for (const f of readdirSync(join(repo, "bin/commands")).filter((x) => x.endsWith(".ts"))) symlinkSync(join(repo, "bin/commands", f), join(bin, "commands", f));
  for (const squad of ["one", "two"]) writeFileSync(join(dir, `${squad}.json`), JSON.stringify({ run_id: `run_${squad}`, lead_wt: `wt-${squad}-lead`,
    members: [{ role: "lead", suffix: "", wt: `wt-${squad}-lead` }, { role: "builder", suffix: "task", wt: `wt-${squad}-builder` }] }));
  const backend = join(root, "backend.sh"), log = join(root, "backend.log");
  writeFileSync(backend, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$1" in ps) echo '{"result":{"worktrees":[]}}';; *) echo '{}';; esac\n`); chmodSync(backend, 0o755);
  const act = new LoopActuator({ fulfillers: [] });
  // U156: notify-squads.sh writes its reload wishes with bin/ds, so the fixture's state root
  // (which holds the members) rides along as DS_STATE_ROOT.
  const r = Bun.spawnSync([join(bin, folder[script] ?? "", script), ...args], { env: { ...process.env, ...act.childActivity(s, a), DS_LOOP_CHILD: "1", BACKEND: backend, DS_STATE_ROOT: root }, stdout: "pipe", stderr: "pipe" });
  let calls = ""; try { calls = readFileSync(log, "utf8"); } catch {}
  return { r, out: r.stdout.toString(), calls };
}

// U156: notify-squads.sh writes a reload wish on every roster member — paused or not, since
// the wish waits for a resume and never expires — and makes no backend call on any path.
function wished(s: Store) {
  return (s.db.query("SELECT squad, role, suffix, reload_by FROM members WHERE role != 'studio' AND reload_at IS NOT NULL ORDER BY squad, role").all() as Row[])
    .map((m) => [m.squad, m.role, m.suffix, m.reload_by].join("/"));
}

// U218: notify-squads.sh runs a cold `bun` (bin/ds) once per roster member, about 1 s each alone
// but over bun test's 5 s default in the full parallel CI run. These two get an explicit 30 s;
// the global timeout stays.
const COLD_BUN_FANOUT_MS = 30_000;

test("notify-squads writes every roster member a reload wish, even the paused Lead; no backend call", () => {
  const { s, root } = fixture();
  s.pause({ scope: "member", project: "p", squad: "one", role: "lead", suffix: "" });
  const { r, out, calls } = runScript("notify-squads.sh", s, root, fan("notify-squads", "p"), ["p"]);
  expect(r.exitCode).toBe(0);
  expect(out).not.toContain("skipped");
  expect(calls).toBe("");
  expect(wished(s)).toEqual(["one/builder/task/notify-squads", "one/lead//notify-squads", "two/builder/task/notify-squads", "two/lead//notify-squads"]);
}, COLD_BUN_FANOUT_MS);

test("notify-squads still reaches every member when a Builder is the paused role", () => {
  const { s, root } = fixture();
  s.pause(builder);
  const { out, calls } = runScript("notify-squads.sh", s, root, fan("notify-squads", "p"), ["p"]);
  expect(out).not.toContain("skipped");
  expect(calls).toBe("");
  expect(wished(s)).toEqual(["one/builder/task/notify-squads", "one/lead//notify-squads", "two/builder/task/notify-squads", "two/lead//notify-squads"]);
}, COLD_BUN_FANOUT_MS);

test("reassert-roles leaves only the paused role out", () => {
  const { s, root } = fixture();
  s.pause(builder);
  const { r, out } = runScript("reassert-roles.sh", s, root, fan("reassert-roles", "p"), ["p"]);
  expect(r.exitCode).toBe(0);
  expect(out).toContain("builder (one) is paused — skipped");
  expect(out).not.toContain("lead (one) is paused");
  expect(out).not.toContain("builder (two) is paused");
});
