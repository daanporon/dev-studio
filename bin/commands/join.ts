// ds join — make this host a side host of a main loop (side-loop-host U12, issue #127): one command on a
// fresh clone, run in a plain shell on the new host.
//   1. check what the host needs and name everything missing (exit 1, nothing written): git, jq, claude,
//      crontab, tmux or herdr, and git push rights (`gh auth status`, the login Builders push and open PRs
//      with; each `--repo <git-url>` also takes a `git push --dry-run`). bin/ds itself names a missing bun.
//      It checks these; it does not set them up.
//   2. write <root>/link/host.json (from here on the state root is a side root, bin/lib/loop-unit.ts) and
//      install as `ds up` does, minus Studio and project (`install-ts`, the side unit ds-side-loop.service);
//   3. make the host's key pair (the private key stays in <root>/link/host.key, 0600), send the join
//      request, print the fingerprint and wait until the operator accepts it (`ds host accept` on main);
//   4. install the role skills for this host's own logins (bin/host/install-skills.sh; a failure is said and
//      the join goes on: the side loop tries again, and main shows a card while a login lacks them);
//   5. start a probe tmux (or herdr) server as a unit of its own, to see this host can run one (each
//      project's server starts with its first agent, bin/backend/tmux.ts), then the side loop
//      (`loop-ts --ensure`) and wait until it says its link is up.
// Running it again is safe: an accepted host goes on to step 4.
// Tests only: DS_JOIN_POLL_MS (default 3000), DS_JOIN_WAIT_S (default: the request's lifetime),
// DS_JOIN_CONNECT_S (default 60) and DS_JOIN_SKILLS (a command run instead of install-skills.sh).
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, run as sh, stateRoot, writeErr, writeOut } from "../lib/shared";
import { ensureLoop, installHost, installRoleSkills } from "../lib/host-setup.ts";
import { DialRefused, dialUrl, LinkClient, linkUrl, sendJoin } from "../link/client.ts";
import { ensureHostKey, linkListenHint, nameProblem, PENDING_TTL_S } from "../link/host-keys.ts";
import { readSideConfig, writeSideConfig } from "../lib/loop-unit.ts";
import { readSideStatus } from "../link/side.ts";
import { herdrBin } from "../backend/herdr-bin.ts";
import { startHerdr } from "../backend/herdr.ts";
import { tmuxBackend } from "../backend/tmux.ts";
import { type ServerHandle, serverAlive, stopServer } from "../backend/server-unit.ts";
import { DEFAULT_LINK_PORT } from "../loop/fulfil/link.ts";
import { dbPath, openReadOnly } from "../loop/core/store.ts";
import { whoAmI } from "../loop/core/whoami.ts";

export const help = "<main-url> [--name <host-name>] [--repo <git-url>]... — make this host a side host of a main loop: check, install, ask main to accept it, start the side loop";

const say = (line: string) => writeOut(`join: ${line}\n`);
const complain = (line: string) => writeErr(`join: ${line}\n`);
const num = (name: string, dflt: number) => Number(process.env[name]) || dflt;

type Args = { main: string; name: string; repos: string[] };

/** This machine's short name as a host name (nameProblem's rule). */
function defaultName(): string {
  const n = hostname().split(".")[0].toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 32).replace(/^-+|-+$/g, "");
  return n || "side";
}

function parseArgs(argv: string[]): Args | number {
  const usage = (why: string) => { complain(why); writeErr(`usage: ds join ${help}\n`); return 2; };
  let main = "", name = "";
  const repos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { writeOut(`usage: ds join ${help}\n`); return 0; }
    if (a === "--name" || a === "--repo") {
      const v = argv[++i];
      if (!v) return usage(`${a} needs a value`);
      if (a === "--name") name = v; else repos.push(v);
    } else if (a.startsWith("-")) return usage(`unknown flag ${a}`);
    else if (main) return usage("one main url");
    else main = a;
  }
  if (!main) return usage("which main? give its url");
  // A bare host name means main's link port.
  if (!main.includes("://") && !/:\d+(\/|$)/.test(main)) main = `${main}:${DEFAULT_LINK_PORT}`;
  try { linkUrl(main); } catch { return usage(`'${main}' is not a url`); }
  const chosen = name || readSideConfig(stateRoot())?.name || defaultName(), bad = nameProblem(chosen);
  if (bad) return usage(`${bad}${name ? "" : ` (this machine is '${hostname()}': give --name)`}`);
  return { main, name: chosen, repos };
}

/** Why this state root cannot become a side root: it holds a main's projects or side hosts. */
function mainHostProblem(root: string): string | null {
  let dirs: string[] = [];
  try { dirs = readdirSync(root); } catch { return null; }
  const project = dirs.find((d) => existsSync(join(root, d, "dispatcher.json")));
  if (project) return `this host runs the main loop of project '${project}'`;
  if (!readSideConfig(root) && existsSync(dbPath(root))) {
    const ro = openReadOnly(root);
    try {
      if (ro.db.query("SELECT 1 FROM hosts WHERE status != 'removed' LIMIT 1").get()) return "this host is a main with side hosts of its own";
    } finally { ro.close(); }
  }
  return null;
}

/** A push this host's git may not do, asked from an empty repo of its own so no checkout's hooks run. */
async function pushProblem(repo: string): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "ds-join-push-"));
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -oBatchMode=yes" };
  const git = (...a: string[]) => sh(["git", "-C", dir, "-c", "user.name=ds-join", "-c", "user.email=ds-join@localhost", "-c", "commit.gpgsign=false", ...a], { env });
  try {
    for (const a of [["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "ds join: push check"]]) {
      const r = await git(...a);
      if (r.rc !== 0) return `git ${a[0]} failed: ${r.err.trim()}`;
    }
    const r = await git("push", "--dry-run", "--", repo, "HEAD:refs/heads/ds-join-push-check");
    return r.rc === 0 ? null : r.err.trim().split("\n").filter(Boolean).slice(0, 2).join("; ") || `exit ${r.rc}`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Everything this host lacks, one line each with its fix. */
async function missing(repos: string[]): Promise<string[]> {
  const has = (t: string) => Bun.which(t, { PATH: process.env.PATH ?? "" }) !== null;
  const fixes: Record<string, string> = {
    git: "install git",
    jq: "install jq",
    claude: "install Claude Code and run `claude login`",
    crontab: "install cron: its line keeps the side loop running",
  };
  const out = Object.entries(fixes).filter(([t]) => !has(t)).map(([t, fix]) => `${t} — ${fix}`);
  if (!has("tmux") && !herdrBin()) out.push("tmux — install tmux (or herdr): a side host's agents run in it");
  if (!has("gh")) out.push("git push rights — gh is not installed: install it (https://cli.github.com/) and run `gh auth login`");
  else if ((await sh(["gh", "auth", "status"])).rc !== 0) out.push("git push rights — gh is not logged in: run `gh auth login` (and `gh auth setup-git` for https remotes)");
  if (has("git")) {
    for (const repo of repos) {
      const why = await pushProblem(repo);
      if (why) out.push(`git push rights — this host cannot push to ${repo}: ${why}`);
    }
  }
  return out;
}

/** Whether main lets this host in now: true, or why not. */
async function admitted(root: string, a: Args): Promise<true | string> {
  const client = new LinkClient({ main: a.main, root, name: a.name, channels: new Map() });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([client.start(), new Promise((_, no) => { timer = setTimeout(() => no(new Error(`no answer from ${a.main}`)), 10_000); })]);
    return true;
  } catch (e) {
    const why = (e as Error).message;
    // The side loop is already linked (cron started it during the wait): main only says so to a good signature.
    return /already has a live link/.test(why) ? true : why;
  } finally {
    clearTimeout(timer);
    client.stop();
  }
}

async function waitAccepted(root: string, a: Args): Promise<boolean> {
  const wait = num("DS_JOIN_WAIT_S", PENDING_TTL_S + 5), until = Date.now() + wait * 1000;
  let said = "";
  for (;;) {
    const r = await admitted(root, a);
    if (r === true) return true;
    // "not accepted" is the wait itself; anything else (a version mismatch, main gone) is said once.
    if (!/is not accepted/.test(r) && r !== said) complain(`still waiting; main says: ${(said = r)}`);
    if (Date.now() >= until) {
      complain(`not accepted within ${Math.ceil(wait / 60)} min (rejected on main, or the request expired${said ? `; last: ${said}` : ""}). Run ds join again to ask anew.`);
      return false;
    }
    await Bun.sleep(num("DS_JOIN_POLL_MS", 3000));
  }
}

/** Start a throwaway backend server the way the side loop starts a project's, see it answer, stop it. */
async function probeBackend(root: string): Promise<string> {
  const probe = `join-probe-${process.pid}`;
  const how = (h: ServerHandle) => (h.via === "systemd" ? "its own systemd user unit" : "a detached process (no systemd user session)");
  if (Bun.which("tmux", { PATH: process.env.PATH ?? "" })) {
    const b = tmuxBackend({ socket: `ds-${probe}`, server: { name: `tmux-${probe}`, log: join(root, "loop", "join-probe.log") } });
    const h = await b.ensureServer();
    if (!h) throw new Error(`a tmux server already answers on ds-${probe}`);
    await b.killServer();
    await stopServer(h);
    return `tmux server starts as ${how(h)}`;
  }
  const dir = mkdtempSync(join(tmpdir(), "ds-join-herdr-"));
  try {
    const s = await startHerdr({ bin: herdrBin()!, dir, name: `herdr-${probe}`, maxRuntimeS: 60 });
    await stopServer(s.handle);
    return `herdr server starts as ${how(s.handle)}`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Wait until the running side loop says its link to this main is up. */
async function waitLinked(root: string, a: Args): Promise<true | string> {
  const until = Date.now() + num("DS_JOIN_CONNECT_S", 60) * 1000;
  for (;;) {
    const s = readSideStatus(root);
    let loopPid = 0;
    try { loopPid = Number(readFileSync(join(root, "loop.pid"), "utf8").trim()); } catch { /* not up yet */ }
    const live = !!s && s.main === a.main && s.pid === loopPid && serverAlive(s.pid);
    if (live && s.state === "up") return true;
    if (Date.now() >= until) return live ? s.why || s.state : "the side loop said nothing about its link";
    await Bun.sleep(200);
  }
}

export async function run(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  if (typeof a === "number") return a;
  const member = whoAmI().member;
  if (member) { complain(`refused — ${member} is a dev-studio agent, and joining is a host bootstrap: run it from a plain shell on the new host`); return 2; }
  const root = stateRoot();
  // The install's unit and cron line run this checkout's own state root.
  if (root !== join(ROOT, "state")) { complain(`refused — DS_STATE_ROOT is ${root}; a side host's state root is ${join(ROOT, "state")} (unset DS_STATE_ROOT)`); return 2; }
  const isMain = mainHostProblem(root);
  if (isMain) { complain(`refused — ${isMain}. A side host is another machine with a fresh clone.`); return 2; }

  const lacks = await missing(a.repos);
  if (lacks.length) {
    for (const l of lacks) complain(`missing ${l}`);
    complain("fix what is missing and run ds join again; nothing changed");
    return 1;
  }

  // An address the link will not dial is said before anything changes; a name that does not resolve yet is not.
  try { await dialUrl(a.main); } catch (e) {
    if (e instanceof DialRefused) { complain((e as Error).message); return 2; }
  }

  // A loop already running here (an earlier join, or an install without a project) is stopped: it starts
  // again below with this main.
  if (existsSync(join(root, "loop.pid"))) {
    const rc = (await sh([join(ROOT, "bin", "ds"), "loop-ts", "--stop"])).rc;
    if (rc !== 0) { complain(`could not stop the loop running here (loop --stop exit ${rc})`); return 1; }
  }
  // Before the install: its cron line must find a side root, never start a main loop.
  writeSideConfig(root, { main: a.main, name: a.name });
  const installRc = await installHost("join", { force: true });
  if (installRc !== 0) return installRc;

  const key = ensureHostKey(root);
  say(`host key ${key.file} (the private key stays on this host)`);
  let asked: Awaited<ReturnType<typeof sendJoin>>;
  try { asked = await sendJoin(a.main, a.name, key.publicKey); }
  catch (e) {
    const port = Number(new URL(linkUrl(a.main)).port) || DEFAULT_LINK_PORT;
    complain((e as Error).message);
    complain(`on main: ${linkListenHint(port)}; then run ds join again`);
    return 1;
  }
  if (!asked.ok && !/is already accepted/.test(asked.why)) { complain(`main refused the join request: ${asked.why}`); return 1; }
  if (asked.ok) {
    say(`asked ${a.main} to accept this host as '${a.name}'`);
    say(`fingerprint ${key.fingerprint}`);
    say(`on main, check that fingerprint and run: ds host accept ${a.name}`);
    say(`waiting (the request expires in ${PENDING_TTL_S / 60} minutes)…`);
    if (!(await waitAccepted(root, a))) return 1;
  } else {
    say(`main already accepted a host named '${a.name}'; fingerprint of this host's key ${key.fingerprint}`);
    // The accepted key may be another one: that never gets in, so there is nothing to wait for.
    const r = await admitted(root, a);
    if (r !== true) { complain(`main does not take this host's key for '${a.name}' (${r}): on main run \`ds host remove ${a.name}\`, or join under another --name`); return 1; }
  }
  say("main accepted this host");
  await installRoleSkills("join");

  try { say(await probeBackend(root)); }
  catch (e) { complain(`this host cannot start a backend server: ${(e as Error).message}`); return 1; }
  const loopRc = await ensureLoop();
  if (loopRc !== 0) { complain(`the side loop did not start (loop --ensure exit ${loopRc}, see above)`); return loopRc; }
  const linked = await waitLinked(root, a);
  if (linked !== true) { complain(`the side loop runs but is not connected to ${a.main}: ${linked}. It keeps trying; see \`ds loop-ts --status\` and its log`); return 1; }
  say(`connected: '${a.name}' is a side host of ${a.main}`);
  return 0;
}
