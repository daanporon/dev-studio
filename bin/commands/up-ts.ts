// ds up-ts — bring up (or reconcile) a project, Studio and board included (U191): what bin/host/up.sh (`ds up`) runs.
// U53 (project-start): one command from a fresh clone, each step skipped when already done:
//   1. install dev-studio when `install --check` fails (`--skills` adds the role skills, only when asked);
//   2. start the loop unless it runs (`loop --ensure`);
//   3. add or reconcile the project: `--label` names it (else the repo's name) and clones into repos/<label>; a label
//      already up with another repo is refused (`--force-new` no longer overrides that); `--backend` is checked with
//      the squads' rule (chooseSquadBackend) and on first bring-up written as the project's `default_backend`
//      (limits.conf) and `studio_backend` (dispatcher.json); a different `--backend` on a reconcile is refused (moving
//      a project is U54's); `--worktree` writes `worktree_provider`. Off Orca the Studio's worktree comes from the
//      project's provider (bin/loop/io/worktrees.ts) as `local::<path>`;
//   4. file the Studio's first start for the loop (squad/studio.ts wantStudioStart; reconcilers/studio.ts startStudio
//      turns it into one studio-move, why "start") and wait for the loop to adopt its terminal. With the loop down, an
//      Orca project's Studio is started directly through studio-start as before (U262); off Orca it stops there;
//   5. file the board's `--serve` wish and print its address, and how to reach the Studio.
// Role brief, roster row and compact window from bin/lib/lib.ts (U274).
// Tests only: DS_UP_INSTALL_CHECK, DS_UP_INSTALL and DS_UP_LOOP name commands run instead of `install --check`,
// install and `loop --ensure`;
// DS_UP_START_WAIT_S (default 180) is how long it waits for the loop to start the Studio.
import { existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, stateRoot, dsLabel, dsPrefix, backend, chomp, readJson, run as sh, settingsAt, writeOut, writeErr } from "../lib/shared";
import { inherit, isUrl } from "../lib/upkeep";
import { compactWindowOf, roleRow, writeRoleFile } from "../lib/lib";
import { MOVE, START_WANTED, STUDIO_SQUAD, studioCandidates, studioMember, studioPrompt, wantStudioStart } from "../loop/squad/studio.ts";
import type { LiveTerminal } from "../loop/observers/orca.ts";
import { whoAmI } from "../loop/core/whoami.ts";
import { chooseSquadBackend, type BackendName } from "../backend/registry.ts";
import { herdrBin } from "../backend/herdr-bin.ts";
import { herdrPlace } from "../backend/herdr.ts";
import { readGet } from "../loop/settings/settings";

export const help = `[<git-url> | <label> | --home <selector>] [--label <name>] [--backend <orca|orca-lite|tmux|herdr>] [--worktree <auto|git|treehouse>] [--account <id>] [--skills] — install if needed, start the loop, add or reconcile a project, have the loop start its Studio, start the board (up.sh)`;

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const DS = () => join(ROOT, "bin", "ds");

/** The handles of the Studio's terminals in <wt>: live ones (connected, writable, not orphaned) the loop
 *  would adopt (studioCandidates: the Studio's agent, no `ds-loop …` pane). null when the list can't be read. */
async function studioTerminals(wt: string, agent: string): Promise<string[] | null> {
  const r = await backend(["loop-terminals"]);
  if (r.rc !== 0) return null;
  let terms: LiveTerminal[] | undefined;
  try { const d = JSON.parse(r.out); terms = d?.ok === false ? undefined : d?.result?.terminals; } catch { return null; }
  if (!Array.isArray(terms)) return null;
  const here = terms.filter((t) => t.worktreeId === wt && t.connected === true && t.writable !== false && t.orphaned !== true)
    .map((t) => ({ handle: t.handle, title: t.title ?? null, identity: t.agentIdentity ?? null }));
  return studioCandidates(here, agent).map((t) => t.handle);
}

/** A git URL in one spelling: https, no `.git`, no trailing slash, lower case (git@host:a/b and https://host/a/b match). */
export function normRepo(u: string): string {
  return u.trim().replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@/, "https://").replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
}

/** Whether `arg` names the repo a project is already up with (`home`): the same selector, the same URL as the
 *  clone's origin, the same folder, or a name:/id: selector (it names the label). A home saved as a name:/id:
 *  selector has no local clone to compare, so any arg that gave the same label counts as the same project. */
async function sameRepo(home: string, arg: string): Promise<boolean> {
  if (home === arg || !home.startsWith("path:")) return true;
  const path = home.slice(5);
  if (isUrl(arg)) {
    const o = await sh(["git", "-C", path, "remote", "get-url", "origin"]);
    return o.rc === 0 && normRepo(chomp(o.out)) === normRepo(arg);
  }
  if (arg.startsWith("path:")) {
    try { return realpathSync(arg.slice(5)) === realpathSync(path); } catch { return false; }
  }
  return true; // a name:/id: selector names the project by its label, not a repo
}

/** Run a step's command with its output shown; a test names a stand-in with `envName`. */
async function step(envName: string, cmd: string[]): Promise<number> {
  const given = process.env[envName];
  return inherit(given ? ["bash", "-c", given] : cmd, { env: process.env });
}

/** How to reach the Studio once it runs, by its backend. */
export function reachLine(b: BackendName, label: string, root: string, wtName: string): string {
  if (b === "tmux") return `Attach to the Studio: tmux -L ds-${label.replace(/[^A-Za-z0-9_.-]/g, "-")} attach -t _studio`;
  if (b === "herdr") { const h = herdrPlace(root, label); return `Attach to the Studio: HERDR_SOCKET_PATH=${h.socket} HERDR_SESSION=${h.session} ${herdrBin() ?? "herdr"}`; }
  return `Open the ${wtName} worktree in the Orca UI and work there.`;
}

type Opts = { homeArg: string; label: string; backendFlag: string; worktree: string; account: string; skills: boolean; forceNew: boolean };

function parseArgs(argv: string[]): Opts | number {
  const o: Opts = { homeArg: "", label: "", backendFlag: "", worktree: "", account: "", skills: false, forceNew: false };
  const val = (i: number, flag: string, what: string): string | number => {
    if (i + 1 >= argv.length || argv[i + 1] === "") { writeErr(`up: ${flag} needs ${what}\n`); return 2; }
    return argv[i + 1]!;
  };
  for (let i = 0; i < argv.length;) {
    const a = argv[i]!;
    const take = (k: "homeArg" | "label" | "backendFlag" | "worktree" | "account", what: string): number | null => {
      const v = val(i, a, what);
      if (typeof v === "number") return v;
      o[k] = v; i += 2; return null;
    };
    let bad: number | null = null;
    if (a === "--home") bad = take("homeArg", "a repo selector");
    else if (a === "--label") bad = take("label", "a project name");
    else if (a === "--backend") bad = take("backendFlag", "a backend (orca, orca-lite, tmux, herdr)");
    else if (a === "--worktree") bad = take("worktree", "a worktree tool (auto, git, treehouse)");
    else if (a === "--account") bad = take("account", "an account id (ds account list)");
    else if (a === "--force-new") { o.forceNew = true; i++; }
    else if (a === "--skills") { o.skills = true; i++; }
    else if (a.startsWith("--")) { writeErr(`up: unknown flag ${a}\n`); return 2; }
    else { o.homeArg = a; i++; }
    if (bad !== null) return bad;
  }
  if (o.label && !/^[A-Za-z0-9._-]+$/.test(o.label)) { writeErr(`up: --label '${o.label}' may hold only letters, digits, '.', '_' and '-'\n`); return 2; }
  return o;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (typeof parsed === "number") return parsed;
  const { homeArg, backendFlag, worktree, account, skills, forceNew } = parsed;
  const prefix = dsPrefix();
  if (whoAmI().via !== null) {
    writeErr("up: NOTE — you're running this inside an Orca agent (a Studio is bound to its own project). `ds up` is a host bootstrap; prefer a plain host shell. Reconciling by label so it won't duplicate.\n");
  }

  // 1. Install dev-studio on this host when its check fails (a fresh clone); the role skills only when asked.
  const checkCmd = process.env.DS_UP_INSTALL_CHECK;
  const checked = (await sh(checkCmd ? ["bash", "-c", checkCmd] : [DS(), "install-ts", "--check"])).rc;
  if (checked !== 0 || skills) {
    writeOut(checked !== 0 ? "up: dev-studio is not installed on this host — installing it\n" : "up: installing the role skills\n");
    const rc = await step("DS_UP_INSTALL", [DS(), "install-ts", ...(skills ? ["--skills"] : [])]);
    if (rc !== 0) { writeErr(`up: the install failed (exit ${rc}); fix what it says and re-run\n`); return rc; }
  }
  // 2. The loop: started unless it runs. A loop that does not come up is not fatal yet (step 4 decides).
  const loopRc = await step("DS_UP_LOOP", [DS(), "loop-ts", "--ensure"]);
  const loopUp = loopRc === 0;
  if (!loopUp) writeErr(`up: the loop did not start (loop --ensure exit ${loopRc}, see above)\n`);

  // 3. The project.
  const arg = homeArg || process.env.HOME_REPO || `path:${ROOT}`;
  const label = parsed.label || dsLabel(arg);
  const root = stateRoot(), stateDir = join(root, label);
  const dispState = join(stateDir, "dispatcher.json");
  const prevDoc: any = readJson(dispState);
  const existingHome = String(prevDoc?.home_repo || "");
  const reconcile = existingHome !== "";
  if (reconcile && homeArg && homeArg !== label && !(await sameRepo(existingHome, arg))) {
    writeErr(`up: '${label}' is already up with ${existingHome}, not '${arg}': refused. Give the new project its own name with --label <name>.\n`);
    return 2;
  }
  // The backend: the project's own on a reconcile (dispatcher.json studio_backend, empty meaning orca); on first
  // bring-up `--backend` (default orca), checked with the squads' rule against the worktree tool asked for.
  const current = String(prevDoc?.studio_backend ?? "").trim() || "orca";
  if (reconcile && backendFlag && backendFlag !== current) {
    writeErr(`up: '${label}' runs on ${current}; moving a project to ${backendFlag} is not built yet (orca-backend-alternatives U54: \`ds up ${label} --backend ${backendFlag}\` will move it). Nothing changed.\n`);
    return 2;
  }
  // The worktree tool: `--worktree`, else on a reconcile the project's stored `worktree_provider` (so a project first
  // brought up with treehouse keeps it), else the backend's default.
  const provider = worktree || (reconcile ? String(readGet(label, "limits.conf", "worktree_provider", settingsAt()).value ?? "").trim().split(/\s+/)[0] : "");
  const chosen = chooseSquadBackend({ flag: reconcile ? current : backendFlag || "orca", projectBackend: reconcile ? current : backendFlag || "orca", providerSetting: provider });
  if (!chosen.ok) { writeErr(`up: ${chosen.error}\n`); return 2; }
  const b = chosen.backend, offOrca = b !== "orca";
  if (offOrca && !(reconcile ? existingHome.startsWith("path:") : isUrl(arg) || arg.startsWith("path:"))) {
    writeErr(`up: a project on ${b} needs a local repo (a git URL or path:<dir>), not '${reconcile ? existingHome : arg}'\n`);
    return 2;
  }
  // The project's backend and worktree tool, before anything is made: settings.ts refuses a pair that does not fit
  // the host or the roster (a role whose agent the backend cannot start), and a refusal writes nothing.
  const writes: [string, string][] = [];
  if (!reconcile && offOrca) writes.push(["default_backend", b]);
  if (worktree) writes.push(["worktree_provider", worktree]);
  if (writes.length) {
    const { changeSettings } = await import("../loop/settings/settings-migrate.ts");
    const { set } = await import("../loop/settings/settings.ts");
    if (changeSettings("up", (st) => { for (const [k, v] of writes) set(st, label, "limits.conf", k, v, "ds up"); return true; }) === null) return 2;
  }
  let repo: string, repoPath = "";
  if (reconcile) {
    if (forceNew) writeErr(`up: --force-new no longer makes a separate project: '${label}' is reconciled (a separate one takes --label <name>)\n`);
    repo = existingHome;
    if (repo.startsWith("path:")) repoPath = repo.slice(5);
  } else if (isUrl(arg)) {
    repoPath = join(ROOT, "repos", label);
    if (!existsSync(join(repoPath, ".git"))) {
      mkdirSync(join(ROOT, "repos"), { recursive: true });
      const rc = await inherit(["git", "clone", arg, repoPath]);
      if (rc !== 0) return rc;
    }
    repo = `path:${repoPath}`;
  } else {
    repo = arg;
    if (arg.startsWith("path:")) repoPath = arg.slice(5);
  }
  // Orca registers repos by their real path; via the ~/.dev-studio symlink a path: selector would not match.
  if (repoPath !== "" && isDir(repoPath)) { repoPath = realpathSync(repoPath); repo = `path:${repoPath}`; }

  mkdirSync(stateDir, { recursive: true });


  const fwd = (r: { out: string; err: string }) => { if (r.out) writeOut(r.out); if (r.err) writeErr(r.err); };
  const wtName = `${prefix}${label}-studio`;
  let studioWt = "";
  if (!offOrca) {
    if (repoPath !== "") fwd(await backend(["repo-ensure", repoPath]));
    // The worktree only: the Studio itself starts below, never by worktree create.
    const ensure = await backend(["worktree-ensure", repo, wtName, "", ""]);
    if (ensure.err) writeErr(ensure.err);
    if (ensure.rc !== 0) return ensure.rc;
    studioWt = chomp(ensure.out);
  } else {
    // Off Orca the project's provider makes it (git, treehouse; orca-lite's is Orca's own), a `local::` folder.
    const { open } = await import("../loop/core/store.ts");
    const { createWorktree } = await import("../loop/io/worktrees.ts");
    const s = open();
    try {
      const { row } = await createWorktree(s, chosen.provider, { repo: repoPath, name: wtName, branch: wtName, base: "HEAD", parent: null, project: label, squad: STUDIO_SQUAD, role: "studio" });
      studioWt = `local::${row.path}`;
    } catch (e) {
      writeErr(`up: could not make the Studio worktree through ${chosen.provider}: ${(e as Error).message}\n`);
      return 1;
    } finally { s.close(); }
  }
  if (studioWt === "") { writeErr(`up: could not create the Studio worktree for '${label}' (repo=${repo})\n`); return 1; }

  // Pin the dev-studio role in the worktree (CLAUDE.local.md), so a turned-over session still knows it is the Studio.
  await writeRoleFile(studioWt, "studio", label, "", "");

  // The Studio's model and effort: the effective `studio` roster row (the project's override, else the
  // default's; an override seeded before U260 has none). The Studio always runs claude, so a row naming
  // another agent gives no model.
  const studioAgent = "claude"; let studioModel = "", studioEffort = "";
  const row = roleRow(label, "studio");
  if (row !== "") {
    const [, agent, model, , effort] = row.split(/\s+/);
    if ((agent ?? "") === studioAgent) { studioModel = model ?? ""; studioEffort = effort ?? ""; }
  }
  const prev: any = prevDoc && typeof prevDoc === "object" ? prevDoc : {};
  const next: any = { ...prev, home_repo: repo, label, studio_wt: studioWt, studio_agent: studioAgent };
  if (!reconcile && b !== "orca") next.studio_backend = b;
  if (studioModel !== "") next.studio_model = studioModel; else delete next.studio_model;
  const save = () => {
    writeFileSync(`${dispState}.tmp`, JSON.stringify(next, null, 2) + "\n");
    renameSync(`${dispState}.tmp`, dispState);
  };

  // Arm the Studio's rewake Stop hook before its session starts (a cross-squad escalation or a restart
  // request wakes it). The hook is per worktree, so a Studio already running there keeps it.
  const armed = Bun.spawn([join(ROOT, "bin", "hooks", "arm-rewake.sh"), studioWt, "--", "--worktree", "--requests", label], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await armed.exited) !== 0) writeErr("up: WARNING — could not arm the Studio's rewake (a cross-squad escalation won't wake it)\n");

  // 4. The Studio. On Orca a Studio already running in the worktree (a terminal the loop would adopt) is left alone.
  let started = "", already: string[] = [];
  if (!offOrca) {
    const live = await studioTerminals(studioWt, studioAgent);
    if (live === null) {
      save();
      writeErr(`up: could not read Orca's terminal list to see whether the Studio runs in ${studioWt}: no Studio started (re-run ds up)\n`);
      return 1;
    }
    already = live;
  }
  if (already.length > 0) {
    save();
    writeOut(`up: the Studio already runs in ${studioWt} (${already.join(", ")}): left alone\n`);
  } else if (loopUp) {
    delete next.studio_handle; // the loop records the terminal it starts
    save();
    const r = await loopStart(label, studioWt, { account, model: studioModel, effort: studioEffort });
    if (r.rc !== 0) return r.rc;
    started = r.handle;
    if (r.running) writeOut(`up: the Studio already runs in ${studioWt} (${r.handle || "seen by the loop"}): left alone\n`);
  } else if (offOrca) {
    save();
    writeErr(`up: only the loop can start a Studio on ${b}, and it is not running (see above): start it with \`${DS()} loop-ts --ensure\` and re-run ds up\n`);
    return 1;
  } else {
    // Orca with the loop down: today's direct start through the loop's launch path, recorded for the loop to adopt.
    writeErr("up: NOTE — the loop is not running, so the Studio is started directly (the loop adopts it once it runs)\n");
    delete next.studio_handle;
    const window = compactWindowOf(label, "studio");
    const s = await backend(["studio-start", studioWt, account || "-", studioModel || "-", studioEffort || "-", window,
      studioPrompt(ROOT, label, repo, stateDir)]);
    if (s.err) writeErr(s.err);
    started = chomp(s.out);
    if (s.rc !== 0 || started === "") {
      save();
      writeErr(`up: could not start the Studio in ${studioWt}${account ? ` on account ${account}` : ""} (see above); re-run ds up\n`);
      return 1;
    }
    next.studio_handle = started;
    save();
  }

  // account-skills U3: name any Claude account a role would stall on, with its repair; never fails the bring-up.
  {
    const chk = Bun.spawn([join(ROOT, "bin", "host", "install-skills.sh"), "--check"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
    const skillsOut = chomp(await new Response(chk.stderr).text());
    if ((await chk.exited) !== 0) {
      writeErr(`up: WARNING — a Claude account cannot load the role skills (install-skills.sh --check):\n${skillsOut}\nup: repair: ${ROOT}/bin/host/install-skills.sh (the bring-up carries on)\n`);
    } else if (skillsOut !== "") writeErr(skillsOut + "\n");
  }

  writeOut(`up: project=${label} home=${repo} backend=${b} ; studio=${studioWt}\n`);
  if (started) writeOut(`up: started the Studio (${started})\n`);
  // 5. The board, through the loop's --serve wish (it prints the address); needs the loop.
  if (loopUp) {
    const rc = await inherit([DS(), "board-ts", label, "--serve"], { env: process.env });
    if (rc !== 0) writeErr("up: WARNING — the board's wish was not taken (see above); `ds board " + label + " --serve` retries it\n");
  } else writeErr(`up: the board needs the loop: once it runs, \`${DS()} board-ts ${label} --serve\`\n`);
  writeOut(`${reachLine(b, label, root, wtName)} Re-run to reconcile.\n`);
  return 0;
}

/** File the Studio's start for the loop and wait until it holds the Studio's terminal (or says why not). */
async function loopStart(label: string, wt: string, pick: { account: string; model: string; effort: string }): Promise<{ rc: number; handle: string; running: boolean }> {
  const { open } = await import("../loop/core/store.ts");
  const s = open();
  try {
    const at = Math.floor(Date.now() / 1000);
    const episode = wantStudioStart(s, label, { account: pick.account || undefined, model: pick.model || undefined, effort: pick.effort || undefined }, at);
    writeOut(`up: asked the loop to start the Studio (${episode}); waiting for it\n`);
    const waitS = Number(process.env.DS_UP_START_WAIT_S ?? "") || 180, until = Date.now() + waitS * 1000;
    for (;;) {
      const w = s.get("episodes", { project: label, subject: MOVE, kind: START_WANTED });
      const mv = s.get("episodes", { project: label, subject: MOVE, kind: "studio:move" });
      const m = studioMember(s, label, wt);
      const ours = w?.episode_key === episode;
      if (ours && w?.state === "running") return { rc: 0, handle: String(m?.handle ?? ""), running: true };
      if (mv?.episode_key === episode && (mv.state === "failed" || mv.state === "not moved")) {
        writeErr(`up: the loop could not start the Studio (${mv.state}): the board's "Studio start failed" card has the manual command\n`);
        return { rc: 1, handle: "", running: false };
      }
      if (m?.handle && (!ours || w?.ended_at != null)) return { rc: 0, handle: String(m.handle), running: false };
      if (Date.now() >= until) {
        writeErr(`up: the loop has not started the Studio within ${waitS}s; its wish stays filed — watch the board, or re-run ds up\n`);
        return { rc: 1, handle: "", running: false };
      }
      await Bun.sleep(1000);
    }
  } finally { s.close(); }
}
