// ds update-host-ts — bring the host's dev-studio checkout to the head of its branch, reinstall, and restart a
// running loop when the commit moved (U191): what bin/host/update-host.sh runs. The pull half of /ds-update,
// which branches on the DS-UPDATE: line printed here. All modules are loaded before the reset below replaces
// them on disk, so the run finishes on the code it started with.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, chomp, run as sh, stateRoot, writeOut, writeErr } from "../lib/shared";
import { inherit } from "../lib/upkeep";
import { loopProjects } from "../loop/settings/projects";
import { hostUpdateHold } from "../loop/core/code-watch";

export const help = `— pull the host checkout to its branch head, reinstall, restart the loop if it moved (update-host.sh)`;

type Outcome = "advanced" | "already" | "refused" | "failed";

/** tmp file + rename, so a reader never sees half a file. Best effort: a record must never change the update. */
function writeAtomic(file: string, data: unknown): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data) + "\n");
    renameSync(tmp, file);
  } catch { /* best effort */ }
}

// The loop restarts itself on new loop code (bin/loop/core/code-watch.ts) but not while this run holds the
// checkout: an install that fails resets it back, and the loop must not have booted (and migrated) on the new
// commit in between. The hold names this pid, so one left by a killed run counts for nothing.
export async function run(argv: string[]): Promise<number> {
  const hold = hostUpdateHold(stateRoot());
  writeAtomic(hold, { pid: process.pid });
  try { return await update(argv); } finally {
    try { if (JSON.parse(readFileSync(hold, "utf8")).pid === process.pid) rmSync(hold); } catch { /* gone already */ }
  }
}

async function update(_argv: string[]): Promise<number> {
  const root = ROOT;
  const git = async (...a: string[]) => sh(["git", ...a], { cwd: root });
  let branch: string | null = null, before = "", after = "";
  // Every exit path says its line once and records it in <state root>/loop/host-update.json (the board reads it).
  const say = (s: string) => {
    writeOut(s + "\n");
    const m = s.match(/^DS-UPDATE: (advanced|already current|refused|failed)/);
    if (!m) return;
    const outcome: Outcome = m[1] === "already current" ? "already" : (m[1] as Outcome);
    writeAtomic(join(stateRoot(), "loop", "host-update.json"), { at: Math.floor(Date.now() / 1000), outcome, line: s, branch, before, after: after || before });
  };
  // The squads of every project run `before` until their own update; mark that once, never over a marker.
  const seedMarkers = () => {
    for (const label of loopProjects(stateRoot())) {
      const f = join(stateRoot(), label, "squads-rev.json");
      if (!existsSync(f)) writeAtomic(f, { rev: before });
    }
  };

  before = chomp((await git("rev-parse", "HEAD")).out);
  const sym = await git("symbolic-ref", "--short", "-q", "HEAD");
  if (sym.rc !== 0) { say(`DS-UPDATE: refused — detached HEAD at ${before}, so no branch to follow; git checkout one first`); return 1; }
  branch = chomp(sym.out);
  // A named refspec: a stale origin/<branch> must not count once the branch is gone from origin.
  const fetched = await git("fetch", "origin", "-q", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  if (fetched.rc !== 0) { if (fetched.err) writeErr(fetched.err); say(`DS-UPDATE: refused — could not fetch ${branch} from origin; still on ${before}`); return 1; }
  if ((await git("reset", "-q", "--hard", `refs/remotes/origin/${branch}`)).rc !== 0) {
    say(`DS-UPDATE: failed — could not reset to origin/${branch}; HEAD is ${chomp((await git("rev-parse", "HEAD")).out)}, check the checkout, nothing restarted`);
    return 1;
  }
  after = chomp((await git("rev-parse", "HEAD")).out);
  // Before anything restarts: the old commit is what every project's squads still run.
  if (before !== after) seedMarkers();

  const inRoot = (cmd: string[]) => inherit(cmd, { cwd: root });
  // Nothing moved and the install is healthy: reinstalling would only rewrite the loop's cron line and unit
  // from whatever PATH this shell has. A failing check still reinstalls (an update repairs a broken install).
  let skipInstall = false;
  if (before === after) {
    const chk0 = Bun.spawn(["./bin/host/install.sh", "--check"], { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    skipInstall = (await chk0.exited) === 0;
    if (skipInstall) say("update: install skipped — checkout unchanged and install --check passed");
  }
  let ok = skipInstall || (await inRoot(["./bin/host/install.sh"])) === 0;
  if (ok && Bun.which("codex")) {
    // --muse-only also checks configured Codex roles, so refresh their skills first.
    if ((await inRoot(["./bin/host/install-skills.sh", "--codex-only"])) !== 0) writeErr("update: WARNING — Codex skills could not be refreshed; run bin/host/install-skills.sh --codex-only\n");
  }
  ok = ok && (await inRoot(["./bin/host/install-skills.sh", "--muse-only"])) === 0;
  if (!ok) {
    // Back to the old commit, which the running loop and squads still match, so the next /ds-update sees the move.
    if (before !== after && (await git("reset", "-q", "--hard", before)).rc !== 0) {
      say(`DS-UPDATE: failed — install did not finish and the checkout could not go back to ${before}; HEAD is ${chomp((await git("rev-parse", "HEAD")).out)}, nothing restarted`);
      return 1;
    }
    after = before;
    say(`DS-UPDATE: failed — install did not finish; the checkout is on ${before}, nothing restarted`);
    return 1;
  }

  // account-skills U3: name any Claude account a role would stall on, with its repair; never changes the exit code.
  const chk = Bun.spawn(["./bin/host/install-skills.sh", "--check"], { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const skillsOut = chomp(await new Response(chk.stderr).text());
  if ((await chk.exited) !== 0) {
    say("update: WARNING — an agent cannot load the role skills (install-skills.sh --check):");
    say(skillsOut);
    say(`update: repair: ${root}/bin/host/install-skills.sh (the update carries on)`);
  } else if (skillsOut !== "") say(skillsOut);

  if (before === after) { say(`DS-UPDATE: already current (${after}) — nothing new`); return 0; }
  // Not running: nothing old to replace, and the install's cron line starts the new code by itself.
  if (existsSync(`${root}/bin/loop/loop.sh`)) {
    const status = chomp((await sh(["bin/loop/loop.sh", "--status"], { cwd: root })).out);
    if (status.startsWith("loop: running")) {
      // Without this terminal's ORCA_* and CLAUDE*: the loop must run as it does from cron.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ORCA_|CLAUDE)/.test(k)) env[k] = v;
      const cron = (await sh(["crontab", "-l"])).out.split("\n");
      // A line with a data path (U53) has to do the start itself: this shell does not have the path.
      const withData = cron.some((l) => !l.startsWith("#") && l.includes(`${root}/bin/loop/loop.sh --ensure`) && l.includes(" ORCA_USER_DATA_PATH="));
      let rc = await inherit(["bin/loop/loop.sh", "--stop"], { env, cwd: root });
      if (rc === 0 && !withData) rc = await inherit(["bin/loop/loop.sh", "--ensure"], { env, cwd: root });
      if (rc !== 0) { say(`DS-UPDATE: failed — advanced ${before} -> ${after}, but the loop did not restart; run bin/loop/loop.sh --ensure, then bin/commands/update-squads.sh`); return 1; }
    }
  }
  say(`DS-UPDATE: advanced ${before} -> ${after}`);
  return 0;
}
