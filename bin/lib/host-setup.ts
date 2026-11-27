// host-setup.ts — the host steps `ds up` and `ds join` share (side-loop-host U12): install dev-studio, then
// start the loop unless it runs. Tests only: DS_UP_INSTALL_CHECK, DS_UP_INSTALL, DS_JOIN_SKILLS and
// DS_UP_LOOP name commands run instead of `install --check`, install, install-skills.sh and `loop --ensure`.
import { join } from "node:path";
import { ROOT, run as sh, writeErr, writeOut } from "./shared";
import { inherit } from "./upkeep";

const DS = () => join(ROOT, "bin", "ds");

async function step(envName: string, cmd: string[]): Promise<number> {
  const over = process.env[envName];
  return inherit(over ? ["bash", "-c", over] : cmd);
}

/** Install when `install --check` fails (a fresh clone), or always with `force`; the role skills only with
 *  `skills`. 0, or the failed install's exit code (said on stderr). */
export async function installHost(who: string, opts: { skills?: boolean; force?: boolean } = {}): Promise<number> {
  const checkCmd = process.env.DS_UP_INSTALL_CHECK;
  const checked = opts.force ? 1 : (await sh(checkCmd ? ["bash", "-c", checkCmd] : [DS(), "install-ts", "--check"])).rc;
  if (checked === 0 && !opts.skills) return 0;
  const why = opts.force ? "installing dev-studio on this host" : checked !== 0 ? "dev-studio is not installed on this host — installing it" : "installing the role skills";
  writeOut(`${who}: ${why}\n`);
  const rc = await step("DS_UP_INSTALL", [DS(), "install-ts", ...(opts.skills ? ["--skills"] : [])]);
  if (rc !== 0) writeErr(`${who}: the install failed (exit ${rc}); fix what it says and re-run\n`);
  return rc;
}

/** side-loop-host U21: the role skills for this host's own logins. A failure is said and nothing stops. */
export async function installRoleSkills(who: string): Promise<void> {
  writeOut(`${who}: installing the role skills for this host's logins\n`);
  const rc = await step("DS_JOIN_SKILLS", [join(ROOT, "bin", "host", "install-skills.sh")]);
  if (rc !== 0) writeErr(`${who}: the role skills did not install (exit ${rc}); run bin/host/install-skills.sh here. The side loop also tries again, and main shows a card while a login lacks them\n`);
}

/** `loop --ensure`: the loop is started unless it runs. Its exit code. */
export const ensureLoop = (): Promise<number> => step("DS_UP_LOOP", [DS(), "loop-ts", "--ensure"]);
