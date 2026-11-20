// Explicit opt-in: real Orca Builder and disposable PR; never runs in the fake suite.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { shell } from "../bin/loop/io/orca.ts";
import { open, type Row } from "../bin/loop/core/store.ts";
import { importJson } from "../bin/loop/db/import-json.ts";
import { orcaObserver } from "../bin/loop/observers/orca.ts";
import { githubObserver } from "../bin/loop/observers/github.ts";
import { cancellationActions } from "../bin/loop/squad/cancel.ts";
import member from "../bin/loop/fulfil/member.ts";
import cancel from "../bin/loop/fulfil/cancel.ts";
import pending from "../bin/loop/fulfil/pending.ts";
import { LoopActuator } from "../bin/loop/core/actuator.ts";
import { Loop } from "../bin/loop/core/tick.ts";

if (!process.argv.includes("--run")) throw new Error("usage: bun tests/loop-cancel-proof.ts --run (real Orca and GitHub)");
if (process.env.ORCA_CLI_COMMAND) process.env.PATH = `${dirname(process.env.ORCA_CLI_COMMAND)}:${process.env.PATH}`;
const here = process.env.ORCA_WORKTREE_ID;
if (!here) throw new Error("run inside Orca");
const id = `${Date.now()}`, topic = `cancel-proof-${id}`, project = "cancelproof";
const root = mkdtempSync(join(tmpdir(), "loop-cancel-proof-")), state = join(root, "state"), proof = join(root, "proof.md");
mkdirSync(join(state, project, "squads"), { recursive: true });
const repo = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.toString().trim().replace(/\/.git$/, "");
const b = shell();
let wt = "", sender = "", pr = "", branch = "", s: ReturnType<typeof open> | null = null;
const lines: string[] = [];
function log(text: string) { lines.push(text); writeFileSync(proof, lines.join("\n") + "\n"); console.log(text); }
async function command(argv: string[], cwd?: string) {
  const p = Bun.spawn(argv, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code) throw new Error(`${argv[0]}: ${err || out}`); return out.trim();
}
async function op(name: string, args: string[], from?: string) { const o = await b.run(name, args, { from, env: { DS_STATE_ROOT: state } }); if (o.code) throw new Error(`${name}: ${o.err} ${o.out}`); return o.out.trim(); }
function assert(ok: unknown, text: string) { if (!ok) throw new Error(text); log(`PASS ${text}`); }
try {
  log(`# Busy Builder cancellation proof\n\nRoot: ${root}\nHost state is excluded; only ${topic} is targeted.`);
  const tab = (await op("terminal-create", [here, `ds-cancel-proof ${id}`])).split("\t"); sender = tab[0];
  const run = await op("run-create", [`Isolated cancellation proof ${id}`], sender);
  wt = await op("wt-create", [`path:${repo}`, `dsproof-${project}-builder-${topic}`], sender);
  const path = wt.split("::").at(-1)!;
  branch = await command(["git", "branch", "--show-current"], path);
  await command(["git", "reset", "--hard", "origin/main"], path);
  await command(["git", "-c", "user.name=Cancel proof", "-c", "user.email=proof@example.com", "commit", "--allow-empty", "-m", `chore: disposable cancellation proof ${id}`], path);
  const sha = await command(["git", "rev-parse", "HEAD"], path);
  await command(["git", "push", "origin", branch], path);
  const body = join(root, "pr-body.md"); writeFileSync(body, `Disposable busy-Builder cancellation proof. Isolated root ${root}; the loop closes this PR unmerged and preserves its branch.`);
  const created = await command(["gh-axi", "pr", "create", "--title", `chore: disposable cancellation proof ${id}`, "--base", "main", "--head", branch, "--body-file", body]);
  pr = created.match(/\/pull\/(\d+)/)?.[1] ?? created.match(/number:\s*(\d+)/)?.[1] ?? "";
  if (!pr) throw new Error(`cannot read proof PR number: ${created}`);
  log(`Worktree: ${wt}\nBranch: ${branch}\nCommit: ${sha}\nPR: https://github.com/acme-org/dev-studio/pull/${pr}`);
  const file = join(state, project, "squads", `${topic}.json`);
  writeFileSync(join(state, project, "dispatcher.json"), JSON.stringify({ home_repo: `path:${repo}` }));
  writeFileSync(file, JSON.stringify({ topic, repo: `path:${repo}`, run_id: run, lead_wt: here, status: "running", members: [{ role: "builder", suffix: "work", wt }], units: [{ slug: "work", status: "dispatched", builder_wt: wt, tier: "hard", pr }] }));
  s = open(state); importJson(s); writeFileSync(join(state, ".loop-migrated"), "");
  s.upsert("coordinators", { project, squad: topic }, { run_id: run, handle: sender, pane_key: tab[1], wt: here, created_at: Math.floor(Date.now()/1000), bound_at: Math.floor(Date.now()/1000) });
  const picked = (await command([join(homedir(), ".dev-studio/bin/ds"), "pick", "dev-studio", "builder"])).split("\t");
  const [agent, model, effort, account] = picked;
  log(`Builder: ${agent}/${model}, account ${account}`);
  const builder = s.db.query("SELECT id FROM members WHERE wt = ?").get(wt) as Row;
  const spec = `You are a disposable Builder for an isolated cancellation proof. Do only this command in the shell, then remain busy while it runs: printf 'uncommitted proof work\\n' > cancel-proof-dirty; sleep 300. Do not read role docs, commit, send worker_done or spawn any worker. The proof will cancel you while this command runs.`;
  s.want("member", String(builder.id), "running", { by: "proof", payload: { prompt: spec, agent, model, effort: effort === "-" ? null : effort, account: account === "-" ? null : account } });
  process.env.DS_STATE_ROOT = state; process.env.DS_PREFIX = "dsproof-"; process.env.DS_LOOP_GITHUB_S = "1";
  const act = new LoopActuator({ orca: b, fulfillers: [member, cancel], pick: async () => ({ agent, model, effort: effort === "-" ? null : effort, account: account === "-" ? null : account }) });
  const loop = new Loop(s, { observers: [orcaObserver(), githubObserver()], reconcilers: [{ name: "cancel", run: cancellationActions }, member, pending] }, act, { projects: () => [project] }); loop.boot(); await act.boot(s, Math.floor(Date.now()/1000));
  const tick = async () => { await loop.tick(); await act.drain(); };
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await tick();
    if (existsSync(join(path, "cancel-proof-dirty")) && s.get("observed_workers", { project, wt })?.state === "working") break;
    await Bun.sleep(1000);
  }
  assert(existsSync(join(path, "cancel-proof-dirty")), "real Builder created uncommitted work");
  assert(s.get("observed_workers", { project, wt })?.state === "working", "real Builder observed working before cancel");
  assert((await command(["gh", "pr", "view", pr, "--json", "state", "-q", ".state"])) === "OPEN", "exact target PR is open before cancel");
  await command(["bun", join(import.meta.dir, "../bin/loop/squad/squad-state.ts"), file, "cancel-unit", "work", "--why", "isolated busy Builder proof"]);
  assert(s.get("members", { id: builder.id })?.want === "gone", "cancel is a gone wish while member remains recorded");
  await tick();
  assert(!(await op("agent-handles", [])).split("\n").some(l => l.startsWith(`${wt}\t`)), "next tick closes the busy real Builder");
  const finish = Date.now() + 90_000;
  while (Date.now() < finish) {
    await Bun.sleep(1000); await tick();
    if (!existsSync(path) && s.get("members", { id: builder.id })?.status === "gone" && s.get("observed_prs", { project, ref: `acme-org/dev-studio#${pr}` })?.state === "CLOSED") break;
  }
  assert(!existsSync(path), "dirty worktree removed");
  assert(!(await op("ps", [])).includes(wt), "Orca worktree deregistered");
  assert(!(await op("wt-terminals", [])).includes(wt), "no terminal remains for cancelled worktree");
  assert(await command(["git", "rev-parse", `refs/heads/${branch}`], repo) === sha, "local branch and commit preserved");
  assert((await command(["git", "ls-remote", "origin", `refs/heads/${branch}`], repo)).startsWith(sha), "remote branch preserved");
  assert((await command(["gh", "pr", "view", pr, "--json", "state,mergedAt", "-q", '.state + " " + (.mergedAt // "unmerged")'])) === "CLOSED unmerged", "target PR closed unmerged");
  assert(s.get("members", { id: builder.id })?.status === "gone", "member reality is gone and wish remains gone");
  const actions = (s.db.query("SELECT kind,payload FROM events WHERE kind = 'action' ORDER BY id").all() as Row[]).filter(r => String(r.payload).includes("cancel."));
  log(`\nCancellation actions:\n\n\`\`\`json\n${JSON.stringify(actions, null, 2)}\n\`\`\`\n\nEvidence: ${proof}\nProof passed; no live squad or host update was used.`);
} finally {
  s?.close();
  // Scoped recovery/teardown only; the proof never removes any other worktree.
  if (wt) { await b.run("terminal-close-worktree", [`id:${wt}`]); if (existsSync(wt.split("::").at(-1)!)) { await command(["git", "switch", "--detach"], wt.split("::").at(-1)!).catch(() => {}); await b.run("worktree-rm", [`id:${wt}`, "force"]); } }
  if (sender) await b.run("terminal-close", [sender]);
  if (pr) await command(["gh-axi", "pr", "close", pr]).catch(() => {});
  log(`Proof artifacts retained at ${root}; disposable branch ${branch} retained for inspection.`);
}
