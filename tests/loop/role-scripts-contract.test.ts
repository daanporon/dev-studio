// role-scripts-contract.test.ts — orca-backend-alternatives U11b: the role scripts on a squad that runs off
// Orca (squads.backend = tmux, members on `local::<path>` worktrees, no Run). A role asks the operator, the
// Lead's tick lists its team, and the phone book and team listing show who is alive, all without one Orca
// call: an `orca` stub on PATH (and as the Orca CLI dir) logs every call, and the log must stay empty.
// The contract reads run on the in-memory fake through the `make` seam; the end-to-end case starts one
// real tmux terminal on the project's server (a private TMUX_TMPDIR) and is skipped without tmux.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { open } from "../../bin/loop/core/store.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { fakeContract } from "../../bin/loop/fakes/contract.ts";
import { contractHere, contractLive, contractStates } from "../../bin/lib/contract-roles.ts";
import { runWith } from "../../bin/commands/directory-ts.ts";
import { projectTmux } from "../../bin/backend/tmux.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "loop", "state");
const OLD = "0a1b2c3d-0000-4000-8000-00000000d3a0::/home/user/orca/workspaces/demo/";
const BUILDER = "builder-u1-spike-loop-as-coordinator";
const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true }); });

// The fixture squad fx/demo moved off Orca: no Run, every member on a `local::` worktree, backend tmux.
function setup() {
  const base = realpathSync(mkdtempSync(join(process.env.XDG_RUNTIME_DIR || "/tmp", "zzrolecontract-")));
  temps.push(base);
  const state = join(base, "state"), wts = join(base, "wt"), bin = join(base, "bin"), log = join(base, "orca.log");
  cpSync(FIXTURE, state, { recursive: true });
  writeFileSync(join(state, ".loop-migrated"), "");
  const file = join(state, "fx", "squads", "demo.json");
  const doc = JSON.parse(readFileSync(file, "utf8").replaceAll(OLD, `local::${wts}/`));
  doc.run_id = ""; doc.task_id = "";
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const wt = (name: string) => `${wts}/${name}`;
  for (const m of doc.members) mkdirSync(String(m.wt).slice("local::".length), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, "orca"), `#!/usr/bin/env bash\necho "$*" >> '${log}'\necho "orca stub: no Orca here" >&2\nexit 1\n`);
  chmodSync(join(bin, "orca"), 0o755);
  writeFileSync(log, "");
  const s = open(state);
  importJson(s);
  // The backend is written once at spawn; this fixture squad is moved after the fact, so lift that guard here.
  s.db.run("DROP TRIGGER IF EXISTS squads_backend_once");
  s.db.run("UPDATE squads SET backend = 'tmux', worktree_provider = 'git' WHERE project = 'fx' AND topic = 'demo'");
  s.close();
  const tmuxDir = join(base, "tmux");
  mkdirSync(tmuxDir, { mode: 0o700 });
  const env: Record<string, string | undefined> = { ...process.env, DS_STATE_ROOT: state, PATH: `${bin}:${process.env.PATH}`,
    DS_ORCA_CLI_BIN_DIR: bin, ORCA_CLI_BIN_DIR: bin, TMUX_TMPDIR: tmuxDir, DS_INSTR_SEEN: join(base, "seen") };
  for (const k of ["BACKEND", "DS_BACKEND", "DS_MEMBER", "DS_WT", "DS_GEN", "DS_LOOP_CHILD", "ORCA_TERMINAL_HANDLE", "TMUX", "TMUX_PANE"]) delete env[k];
  return { base, state, file, wt, log, env, tmuxDir, lead: `local::${wt("ds-dev-studio-lead-demo")}`, builder: `local::${wt(`ds-dev-studio-${BUILDER}-demo`)}` };
}

const run = (argv: string[], env: Record<string, string | undefined>, cwd: string) => {
  const p = Bun.spawnSync(argv, { env: env as Record<string, string>, cwd });
  return { rc: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

test("contractHere: DS_BACKEND names the backend, else DS_MEMBER's squad row; orca and an Orca squad are null", () => {
  const { state } = setup();
  expect(contractHere(state, { DS_BACKEND: "tmux" })).toBe("tmux");
  expect(contractHere(state, { DS_BACKEND: "orca", DS_MEMBER: "fx/demo/lead" })).toBeNull();
  expect(contractHere(state, { DS_MEMBER: "fx/demo/lead" })).toBe("tmux");
  expect(contractHere(state, { DS_MEMBER: "fx/nosuch/lead" })).toBeNull();
  expect(contractHere(state, {})).toBeNull();
});

test("contractLive and contractStates read the contract: the newest terminal of a worktree speaks, a backend with no adapter is blind", async () => {
  const { state, lead } = setup();
  const fake = fakeContract({ state: "native" }, { name: "tmux" });
  const cwd = lead.slice("local::".length);
  const a = await fake.call("terminal.create", { cwd, label: "lead", group: "fx.demo" });
  const b = await fake.call("terminal.create", { cwd, label: "lead", group: "fx.demo" });
  if (!a.ok || !b.ok) throw new Error("create failed");
  const make = (name: string) => (name === "tmux" ? fake : null);
  const live = await contractLive(state, "fx", { make });
  expect(live.blind).toEqual([]);
  expect(live.terms.map((t) => t.wt)).toEqual([lead, lead]);
  const st = await contractStates(state, "fx", { make });
  expect(st.lines).toHaveLength(1);
  const [wt, s, name] = st.lines[0].split("\t");
  expect([wt, name]).toEqual([lead, "ds-dev-studio-lead-demo"]);
  expect(["working", "waiting", "idle", "unknown"]).toContain(s);
  expect((await contractLive(state, "fx", { make: () => null })).blind).toEqual(["tmux: no adapter"]);
});

test("contract.sh: current is the member's local:: worktree, ping writes nothing and answers 0, an Orca-only verb exits 2; no Orca call", () => {
  const { env, lead, log } = setup();
  const cwd = lead.slice("local::".length);
  const me = { ...env, DS_BACKEND: "tmux", DS_MEMBER: "fx/demo/lead", DS_WT: cwd };
  const sh = join(ROOT, "bin", "backend", "contract.sh");
  expect(run([sh, "current"], me, cwd)).toMatchObject({ rc: 0, out: `${lead}\n` });
  expect(run([sh, "ping", lead, "NEEDS YOU: x"], me, cwd)).toMatchObject({ rc: 0, out: "" });
  expect(run([sh, "worker-states"], me, cwd)).toMatchObject({ rc: 0, out: "" });   // no server yet: nobody is up
  const no = run([sh, "run-show", "run_x"], me, cwd);
  expect(no.rc).toBe(2);
  expect(no.err).toContain("no 'run-show' off Orca");
  expect(readFileSync(log, "utf8")).toBe("");
});

test("a Builder off Orca asks the operator: the question is on the board with its local:: worktree, rc 0, resolving it pings nothing; no Orca call", () => {
  const { env, file, builder, log } = setup();
  const cwd = builder.slice("local::".length);
  const me = { ...env, DS_MEMBER: `fx/demo/${BUILDER}`, DS_WT: cwd, DS_BACKEND: "tmux" };
  const ask = run([join(ROOT, "bin", "role", "ask-operator.sh"), file, "q-off-orca", "builder", "true",
    "--title", "Which base?", "--question", "Which base branch?", "--option", "main", "base on main", "--option", "dev", "base on dev",
    "--recommend", "main", "--why", "main is the default"], me, cwd);
  expect(ask.err).toBe("");
  expect(ask.rc).toBe(0);
  expect(ask.out).toContain("ON BOARD: q-off-orca (blocking)");
  const q = JSON.parse(readFileSync(file, "utf8")).waiting_on_you.find((x: { id: string }) => x.id === "q-off-orca");
  expect(q).toMatchObject({ asker: "builder", blocking: true, card_wt: builder });
  const res = run([join(ROOT, "bin", "role", "squad-state.sh"), file, "resolve-question", "q-off-orca", "--answer", "main"], me, cwd);
  expect(res.rc).toBe(0);
  expect(readFileSync(log, "utf8")).toBe("");
}, 60_000);

test("the phone book reads a local:: member's liveness from the contract and gives a send-worker address; no Orca read", async () => {
  const { state, lead } = setup();
  const fake = fakeContract({}, { name: "tmux" });
  await fake.call("terminal.create", { cwd: lead.slice("local::".length), label: "lead", group: "fx.demo" });
  const orca: string[][] = [], out: string[] = [], err: string[] = [];
  const io = {
    stateRoot: state, out: (s: string) => out.push(s), err: (s: string) => err.push(s),
    backend: async (args: string[]) => { orca.push(args); return { rc: 1, out: "", err: "no Orca here" }; },
    contract: (label: string) => contractLive(state, label, { make: (n) => (n === "tmux" ? fake : null) }),
  };
  expect(await runWith(io, ["list", "--project", "fx", "--json"])).toBe(0);
  const rows = JSON.parse(out.join("")) as { role: string; wt: string; live: boolean | null }[];
  const byRole = (r: string) => rows.find((m) => m.role === r)!;
  expect(byRole("lead")).toMatchObject({ wt: lead });
  expect(byRole("lead").live).toBe(true);
  expect(byRole("thinker").live).toBe(false);
  out.length = 0;
  expect(await runWith(io, ["reach", "demo", "lead", "--project", "fx"])).toBe(0);
  expect(out.join("")).toContain(lead);
  expect(orca.filter((a) => a[0] !== "current")).toEqual([]);
});

const TMUX = Bun.which("tmux");
(TMUX ? test : test.skip)("end to end on tmux: the Lead's tick lists its team, team.sh and directory.sh see the live Lead; no Orca call", async () => {
  const { state, env, lead, log, tmuxDir } = setup();
  const prev = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = tmuxDir;
  const b = projectTmux("fx", { stateRoot: state, shell: "/bin/sh" });
  try {
    const cwd = lead.slice("local::".length);
    const t = await b.call("terminal.create", { cwd, label: "lead", group: "fx.demo", env: { DS_BACKEND: "tmux", DS_MEMBER: "fx/demo/lead", DS_WT: cwd } });
    expect(t.ok).toBe(true);
    const me = { ...env, DS_BACKEND: "tmux", DS_MEMBER: "fx/demo/lead", DS_WT: cwd };
    const tick = run([join(ROOT, "bin", "lib", "watch.sh"), "fx", "demo", "500"], me, cwd);
    expect(tick.err).not.toContain("no run_id");
    expect(tick.rc).toBe(0);
    expect(tick.out).toContain("no Run: the squad runs on tmux");
    expect(tick.out).toContain("TEAM:");
    expect(tick.out).not.toContain("worker state unavailable");
    const team = run([join(ROOT, "bin", "commands", "team.sh"), "fx", "--topic", "demo"], me, cwd);
    expect(team.rc).toBe(0);
    expect(team.out).toContain("lead");
    const dir = run([join(ROOT, "bin", "lib", "directory.sh"), "list", "--project", "fx", "--json"], me, cwd);
    expect(dir.rc).toBe(0);
    const rows = JSON.parse(dir.out) as { role: string; live: boolean | null }[];
    expect(rows.find((m) => m.role === "lead")!.live).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("");
  } finally {
    await b.killServer();
    if (prev === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = prev;
  }
}, 60_000);
