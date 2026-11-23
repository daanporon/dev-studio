// ds up-ts — bring up (or reconcile) a per-project Studio instance (U191): what bin/host/up.sh runs.
// Worktree and repo ops, then the Studio tab itself through the backend's studio-start (U262); role brief,
// roster row and compact window from bin/lib/lib.ts (U274).
import { existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, stateRoot, dsLabel, dsPrefix, backend, chomp, readJson, writeOut, writeErr } from "../lib/shared";
import { inherit, isUrl } from "../lib/upkeep";
import { compactWindowOf, roleRow, writeRoleFile } from "../lib/lib";
import { studioCandidates, studioPrompt } from "../loop/squad/studio.ts";
import type { LiveTerminal } from "../loop/observers/orca.ts";
import { whoAmI } from "../loop/core/whoami.ts";

export const help = `[<git-url> | --home <selector>] [--force-new] [--account <id>] — bring up or reconcile a project's Studio (up.sh)`;

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

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

export async function run(argv: string[]): Promise<number> {
  const prefix = dsPrefix();
  let homeArg = "", forceNew = false, account = "";
  for (let i = 0; i < argv.length;) {
    if (argv[i] === "--home") { if (i + 1 >= argv.length) { writeErr("up.sh: $2: unbound variable\n"); return 1; } homeArg = argv[i + 1]; i += 2; }
    else if (argv[i] === "--force-new") { forceNew = true; i++; }
    else if (argv[i] === "--account") { if (i + 1 >= argv.length || argv[i + 1] === "") { writeErr("up: --account needs an account id (ds account list)\n"); return 2; } account = argv[i + 1]; i += 2; }
    else { homeArg = argv[i]; i++; }
  }
  if (whoAmI().via !== null) {
    writeErr("up: NOTE — you're running this inside an Orca agent (a Studio is bound to its own project). /ds-up is a host bootstrap; prefer a plain host shell. Reconciling by label so it won't duplicate.\n");
  }
  const arg = homeArg || process.env.HOME_REPO || `path:${ROOT}`;
  const label = dsLabel(arg);
  const stateDir = join(stateRoot(), label);
  const dispState = join(stateDir, "dispatcher.json");
  mkdirSync(stateDir, { recursive: true });

  const existingHome = readJson(dispState)?.home_repo || "";
  let repo: string, repoPath = "";
  if (existingHome && !forceNew) {
    if (homeArg && existingHome !== arg) writeErr(`up: '${label}' is already up (home_repo=${existingHome}) — reconciling it and ignoring '${arg}'. Use --force-new for a separate instance.\n`);
    repo = String(existingHome);
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

  const fwd = (r: { out: string; err: string }) => { if (r.out) writeOut(r.out); if (r.err) writeErr(r.err); };
  if (repoPath !== "") fwd(await backend(["repo-ensure", repoPath]));

  // The worktree only: the Studio itself starts below through studio-start (U262), never by worktree create.
  const ensure = await backend(["worktree-ensure", repo, `${prefix}${label}-studio`, "", ""]);
  if (ensure.err) writeErr(ensure.err);
  if (ensure.rc !== 0) return ensure.rc;
  const studioWt = chomp(ensure.out);
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
  let prev: any = readJson(dispState);
  if (prev === undefined || prev === null || typeof prev !== "object") prev = {};
  const next: any = { ...prev, home_repo: repo, label, studio_wt: studioWt, studio_agent: studioAgent };
  if (studioModel !== "") next.studio_model = studioModel; else delete next.studio_model;
  const save = () => {
    writeFileSync(`${dispState}.tmp`, JSON.stringify(next, null, 2) + "\n");
    renameSync(`${dispState}.tmp`, dispState);
  };

  // Arm the Studio's rewake Stop hook before its session starts (a cross-squad escalation or a restart
  // request wakes it). The hook is per worktree, so a Studio already running there keeps it.
  const armed = Bun.spawn([join(ROOT, "bin", "hooks", "arm-rewake.sh"), studioWt, "--", "--worktree", "--requests", label], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await armed.exited) !== 0) writeErr("up: WARNING — could not arm the Studio's rewake (a cross-squad escalation won't wake it)\n");

  // A Studio already running in the worktree (a terminal the loop would adopt, bin/loop/squad/studio.ts) is left
  // alone. Otherwise open one through the loop's launch path: the auto-compact window, the Studio's skill
  // overrides and the chosen account, and record its handle for the loop (U261 adopts it).
  const live = await studioTerminals(studioWt, studioAgent);
  if (live === null) {
    save();
    writeErr(`up: could not read Orca's terminal list to see whether the Studio runs in ${studioWt}: no Studio started (re-run /ds-up)\n`);
    return 1;
  }
  let started = "";
  if (live.length > 0) {
    writeOut(`up: the Studio already runs in ${studioWt} (${live.join(", ")}): left alone\n`);
  } else {
    delete next.studio_handle; // the Studio it named no longer runs
    const window = compactWindowOf(label, "studio");
    const s = await backend(["studio-start", studioWt, account || "-", studioModel || "-", studioEffort || "-", window,
      studioPrompt(ROOT, label, repo, stateDir)]);
    if (s.err) writeErr(s.err);
    started = chomp(s.out);
    if (s.rc !== 0 || started === "") {
      save();
      writeErr(`up: could not start the Studio in ${studioWt}${account ? ` on account ${account}` : ""} (see above); re-run /ds-up\n`);
      return 1;
    }
    next.studio_handle = started;
  }
  save();

  // account-skills U3: name any Claude account a role would stall on, with its repair; never fails the bring-up.
  const chk = Bun.spawn([join(ROOT, "bin", "host", "install-skills.sh"), "--check"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const skillsOut = chomp(await new Response(chk.stderr).text());
  if ((await chk.exited) !== 0) {
    writeErr(`up: WARNING — a Claude account cannot load the role skills (install-skills.sh --check):\n${skillsOut}\nup: repair: ${ROOT}/bin/host/install-skills.sh (the bring-up carries on)\n`);
  } else if (skillsOut !== "") writeErr(skillsOut + "\n");

  writeOut(`up: project=${label} home=${repo} ; studio=${studioWt}\n`);
  if (started) writeOut(`up: started the Studio (${started})\n`);
  writeOut(`Open the ${prefix}${label}-studio worktree in the Orca UI and work there. Re-run to reconcile.\n`);
  return 0;
}
