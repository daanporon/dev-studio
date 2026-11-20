// ds set-orca-depth-ts — set Orca's "Nested worker depth" to >= n safely (U272): what bin/host/set-orca-depth.sh runs.
// The plain form goes through the backend adapter (Orca must be stopped); --auto stops and starts Orca's systemd --user
// service around it, and confirms first unless --yes is given.
import { existsSync, readFileSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { ROOT, backendPath, run as runCmd, writeErr, writeOut } from "../lib/shared";
import { inherit } from "../lib/install";

export const help = `[<n>=5] [--auto [--yes]] — set Orca's "Nested worker depth" to >= n (set-orca-depth.sh)`;

/** The first `"nestedWorkerMaxDepth": N` found in the files, in order, or "" (grep -o | grep -oE [0-9]+ | head -1). */
function depthIn(files: string[]): string {
  for (const f of files) {
    if (!existsSync(f)) continue;
    let text = "";
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    const m = text.match(/"nestedWorkerMaxDepth"[: ]*[0-9]*/);
    const n = m ? m[0].match(/[0-9]+/) : null;
    if (n) return n[0];
  }
  return "";
}

function readLine(): string {
  const b = Buffer.alloc(1); let s = "";
  for (;;) {
    let n = 0;
    try { n = readSync(0, b, 0, 1, null); } catch { break; }
    if (n <= 0 || b[0] === 10) break;
    s += String.fromCharCode(b[0]);
  }
  return s;
}

export async function run(argv: string[]): Promise<number> {
  const script = join(ROOT, "bin", "host", "set-orca-depth.sh");
  let want = "5", auto = false, yes = false;
  for (const a of argv) {
    if (a === "--auto") auto = true;
    else if (a === "--yes") yes = true;
    else if (a === "" || /[^0-9]/.test(a)) { writeErr("usage: set-orca-depth.sh [<n>=5] [--auto [--yes]]\n"); return 2; }
    else want = a;
  }
  if (!auto) return inherit([backendPath(), "set-nested-depth", want]);

  const cfg = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME ?? "", ".config"), "orca");
  const profiles = (): string[] => { try { return readdirSync(join(cfg, "profiles")).sort().map((d) => join(cfg, "profiles", d, "orca-data.json")); } catch { return []; } };
  let cur = depthIn([...profiles(), join(cfg, "orca-data.json")]);
  if (cur === "" || /[^0-9]/.test(cur)) cur = "1";
  if (Number(cur) >= Number(want)) { writeOut(`set-orca-depth: already ${cur} (>= ${want}) — nothing to do.\n`); return 0; }

  const units = await runCmd(["systemctl", "--user", "list-units", "--type=service", "--all"]);
  const unit = (units.out.match(/[a-z0-9_.@-]*orca[a-z0-9_.@-]*\.service/i) ?? [""])[0];
  if (!unit) {
    writeErr("set-orca-depth: can't auto-detect how Orca runs (no systemd --user Orca service found).\nDo it by hand:\n  1. stop Orca\n"
      + `  2. ${script} ${want}\n  3. start Orca\n`);
    return 1;
  }

  writeErr(`set-orca-depth: will STOP ${unit} (killing any running sessions), set depth=${want}, then restart it.\n`);
  if (!yes) {
    writeErr("Continue? [y/N] ");
    if (!["y", "Y", "yes", "YES"].includes(readLine())) { writeErr("aborted.\n"); return 1; }
  }

  const stopped = await inherit(["systemctl", "--user", "stop", unit]);
  if (stopped !== 0) return stopped;
  let needStart = true;
  const restart = async (): Promise<void> => {
    if (!needStart) return;
    needStart = false;
    if ((await inherit(["systemctl", "--user", "start", unit])) !== 0) writeErr(`set-orca-depth: starting ${unit} FAILED — start Orca by hand: systemctl --user start ${unit}\n`);
  };
  const setRc = await inherit([script, want]);
  if (setRc !== 0) {
    writeErr(`set-orca-depth: setting the depth failed (${setRc}); Orca was started again with its old depth\n`);
    await restart();
    return setRc;
  }
  needStart = false;
  const started = await inherit(["systemctl", "--user", "start", unit]);
  if (started !== 0) return started;
  await Bun.sleep(2000);

  const got = depthIn(profiles());
  writeOut(`set-orca-depth: ${unit} restarted; depth now ${got || "?"}. (Check the runtime with: orch.sh / the board.)\n`);
  return 0;
}
