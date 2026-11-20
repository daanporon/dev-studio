// rewake-hook-ts.ts — bin/hooks/rewake-hook.sh, ported (U190): the asyncRewake Stop hook's body.
// bin/hooks/rewake-hook.sh runs it (U193: the only body). Same stdin, stderr banners,
// exit codes, rewake-hook.log lines, pid/shown/seen files and watch.sh calls as the shell body.
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ROOT, stateRoot, dsPrefix, chomp, run as runCmd, writeErr } from "../lib/shared";

export const help = "rewake-hook-ts <watch-args…> [--done-check <state> <builder_wt>] — the rewake Stop hook (bin/hooks/rewake-hook.sh)";

const pad = (n: number) => String(n).padStart(2, "0");

/** POSIX `cksum` of a string or bytes (CRC-32, polynomial 0x04C11DB7, the length appended), as the decimal it prints. */
export function cksum(s: string | Uint8Array): string {
  let crc = 0;
  const step = (b: number) => {
    crc = (crc ^ (b << 24)) >>> 0;
    for (let i = 0; i < 8; i++) crc = (crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
  };
  const buf = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  for (const b of buf) step(b);
  for (let n = buf.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
  return String(~crc >>> 0);
}

/** `jq -r '.stop_hook_active // false'` over the hook input: "" for no input, "?" when jq would fail. */
export function stopHookActive(input: string): string {
  if (input.trim() === "") return "";
  let j: any;
  try { j = JSON.parse(input); } catch { return "?"; }
  if (j !== null && (typeof j !== "object" || Array.isArray(j))) return "?";
  const v = j?.stop_hook_active;
  if (v === null || v === undefined || v === false) return "false";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

const lines = (s: string): string[] => s.split("\n");

/** quiet: the peek worked and shows nothing to handle (no message, no `↻ request`). */
export const quiet = (out: string): boolean => out !== "" && out.includes("do a check-in and re-arm") && !out.includes("↻ request");

/** shown_items: the `↻ request` lines plus the `(id=…)` of each `•` summary line, sorted, once each. */
export function shownItems(out: string): string[] {
  const items: string[] = [];
  for (const l of lines(out)) if (l.includes("↻ request")) items.push(l);
  for (const l of lines(out)) if (/^ {2}• .* \(id=/.test(l)) items.push(...(l.match(/\(id=[^)]*\)/g) ?? []));
  return [...new Set(items)].sort();
}

/** The Lead's once-per-key wake items (the shell's awk over `-F'\t'`). */
export function leadKeys(out: string): string[] {
  const keys: string[] = [];
  for (const l of lines(out)) {
    const f = l.split("\t"), f1 = f[0] ?? "", at = (i: number) => f[i - 1] ?? "", last = f.length ? f[f.length - 1] : "";
    if (/⏸ sitting|❓ unasked/.test(f1)) keys.push(`${f1}|${at(3)}|${at(5)}|${last}`);
    if (/‼ merged/.test(f1)) keys.push(`${f1.replace(/^ +/, "")}|${at(2)}|${at(4).replace(/^PR #/, "").replace(/ .*/, "")}`);
    if (/★ finished/.test(f1)) keys.push(`${f1.replace(/^ +/, "")}|${at(2)}|${at(3)}`);
  }
  return keys;
}

/** The --done-check: the state has a unit with builder_wt == wt and status done (jq's `index("done") != null`). */
export function unitDone(state: string, wt: string): boolean {
  let j: any;
  try { j = JSON.parse(readFileSync(state, "utf8")); } catch { return false; }
  const u = j?.units;
  const units: any[] = Array.isArray(u) ? u : u && typeof u === "object" ? Object.values(u) : [];
  if (units.some((x) => x !== null && typeof x !== "object")) return false; // jq errors -> "false"
  return units.some((x) => x !== null && x.builder_wt === wt && x.status === "done");
}

/** `sleep <v>` seconds (GNU sleep's number + s/m/h/d), null when sleep would refuse it. */
function sleepSec(v: string): number | null {
  const m = v.match(/^(\d+\.?\d*|\.\d+)([smhd]?)$/);
  if (!m) return null;
  return Number(m[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]];
}

/** `ps -p <pid> -o args=`: /proc/<pid>/cmdline (no process to start, which a loaded host makes slow), else ps. */
async function procArgs(pid: string): Promise<string> {
  if (!/^\d+$/.test(pid)) return (await runCmd(["ps", "-p", pid, "-o", "args="])).out;
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0$/, "").replace(/\0/g, " "); }
  catch (e: any) { return e?.code === "ENOENT" && existsSync("/proc/self") ? "" : (await runCmd(["ps", "-p", pid, "-o", "args="])).out; }
}

const fileLines = (f: string): string[] | null => { try { return readFileSync(f, "utf8").split("\n"); } catch { return null; } };

/** loop_squad: "<project>/<squad>" when the loop db has a coordinators row with a run for this agent's squad. */
function loopSquad(args: string[]): string | null {
  const db = join(stateRoot(), "loop.db");
  try { if (statSync(db).size === 0) return null; } catch { return null; }
  let p = args[0] ?? "", s = args[1] ?? "", w = "";
  if (p === "" || p.startsWith("--")) { w = basename(process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd()); p = ""; s = ""; }
  try {
    const d = new Database(db, { readonly: true });
    try {
      const rows = d.query("SELECT project, squad, run_id FROM coordinators WHERE squad != \"\"").all() as { project: string; squad: string; run_id: string }[];
      const roles = ["lead", "thinker", "builder", "reviewer", "tester", "researcher"];
      // Worktree names: <p>-<role>-<squad>, <p>-<role>-<suffix>-<squad>, <p>-<role>-<squad>-<suffix>; the longest squad wins.
      const fits = (r: { project: string; squad: string }) => roles.some((ro) => {
        const h = `${dsPrefix()}${r.project}-${ro}-`;
        return w.startsWith(h) && (w.endsWith(`-${r.squad}`) || w.startsWith(`${h}${r.squad}-`) || w === `${h}${r.squad}`);
      });
      const hit = p ? rows.find((r) => r.project === p && r.squad === s)
        : rows.filter(fits).sort((x, y) => y.squad.length - x.squad.length)[0];
      return hit && hit.run_id !== "" ? `${hit.project}/${hit.squad}` : null;
    } finally { d.close(); }
  } catch { return null; }
}

export async function run(argv: string[]): Promise<number> {
  const LOG = process.env.DS_REWAKE_LOG || join(ROOT, "state", "rewake-hook.log");
  const SEEN = process.env.DS_REWAKE_SEEN || join(ROOT, "state", "rewake-sitting.seen");
  const log = (msg: string) => {
    if (LOG === "none") return;
    const d = new Date();
    try { appendFileSync(LOG, `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${msg}\n`); } catch { /* as the shell */ }
  };

  // Our own --done-check <state_file> <builder_wt>; everything else goes to watch.sh.
  let doneState = "", doneWt = "";
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--done-check") {
      if (i + 3 > argv.length) return 1; // the shell's `shift 3` fails under set -e
      doneState = argv[i + 1]; doneWt = argv[i + 2]; i += 2;
    } else args.push(argv[i]);
  }
  const all = args.join(" ");

  let input = "";
  try { input = chomp(await Bun.stdin.text()); } catch { /* no stdin */ }
  const sha = stopHookActive(input);
  log(`FIRE args=[${all}] handle=${process.env.ORCA_TERMINAL_HANDLE ? "set" : "UNSET"} stop_hook_active=${sha}`);

  // ONE hook per worktree: the newest replaces the previous one (a shell or a port hook).
  const piddir = process.env.DS_REWAKE_PIDDIR || join(ROOT, "state", "rewake");
  try { mkdirSync(piddir, { recursive: true }); } catch { /* as the shell */ }
  const pidfile = join(piddir, `${cksum(process.env.CLAUDE_PROJECT_DIR || process.env.PWD || process.cwd())}.pid`);
  const shownfile = pidfile.replace(/\.pid$/, ".shown");
  let old = "";
  try { old = chomp(readFileSync(pidfile, "utf8")); } catch { /* none */ }
  if (old && old !== String(process.pid) && /rewake-hook(\.sh|-ts)/.test(await procArgs(old))) {
    try { process.kill(Number(old)); } catch { /* gone */ }
    log(`-> replaced previous hook pid ${old}`);
  }
  try { writeFileSync(pidfile, `${process.pid}\n`); } catch { /* as the shell */ }

  const lsq = loopSquad(args);
  if (lsq) { log(`loop runs ${lsq}: off`); return 0; }

  const watch = async (): Promise<string> => chomp((await runCmd([join(ROOT, "bin", "lib", "watch.sh"), ...args, "--poll"])).out);
  const recordShown = (out: string) => {
    const items = shownItems(out);
    try { writeFileSync(shownfile, items.length ? items.join("\n") + "\n" : ""); } catch { /* as the shell */ }
  };
  const newSinceShown = (out: string): boolean => {
    const shown = fileLines(shownfile);
    return shownItems(out).some((l) => l !== "" && (shown === null || !shown.includes(l)));
  };

  // Woken by our own exit 2: re-arm at once when the agent handled what we showed, else back off.
  if (sha === "true") {
    const peek = await watch();
    if (quiet(peek)) log("-> stop_hook_active, inbox clear (handled): re-arm");
    else if (newSinceShown(peek)) log("-> stop_hook_active, NEW item since last wake: re-wake now");
    else {
      log("-> stop_hook_active, message still present/peek failed: backoff then re-arm");
      const s = sleepSec(process.env.DS_REWAKE_BACKOFF_SEC || "900");
      if (s === null) return 1;
      await Bun.sleep(s * 1000);
    }
  }

  // Poll with gaps, never park in a long-poll (Orca push-wakes an idle agent between peeks).
  const win = process.env.DS_REWAKE_WINDOW_SEC || "21600";
  if (!/^-?\d+$/.test(win.trim())) return 1;
  const deadline = Math.floor(Date.now() / 1000) + Number(win.trim());
  const g = process.env.DS_REWAKE_POLL_GAP_SEC || "20";
  const gap = /^\d+$/.test(g) ? Number(g) : 20;
  const lead = !(args[0] ?? "").startsWith("--");
  let out = "", first = true;
  for (;;) {
    out = await watch();
    if (first) {
      if (out === "") log("peek[1]: EMPTY (watch failed?)");
      else if (quiet(out)) log("peek[1]: inbox empty, idling (Orca push-wakes on mail)");
      else log("peek[1]: MESSAGE present -> waking");
      first = false;
    }
    if (out !== "" && !quiet(out)) {
      log("-> WAKE (exit 2)");
      recordShown(out);
      const ack = lines(out).find((l) => l.startsWith("ACK-ID: "))?.slice(8).replace(/ .*/s, "") ?? "";
      const wcmd = `${ROOT}/bin/lib/watch.sh ${all} 4000`;
      const ackhow = ack === "" ? `the read prints an ACK-ID — pass it as: ${wcmd} --ack <ACK-ID>` : `${wcmd} --ack ${ack}`;
      writeErr(`dev-studio rewake — a message or restart request is waiting; handle it (ack a message; delete a handled request file), then stop:\n${out}\nREAD: ${wcmd}\nACK: ${ackhow}\nThe full message is printed above; if the READ comes back empty, Orca already pushed it — handle what is above and ack.\n`);
      return 2;
    }
    // Outside loop-owned squads a Lead also wakes once per key: a sitting Builder, a merged PR the
    // loop has not marked done, an unasked question, the squad finished.
    if (lead) {
      const fresh: string[] = [];
      for (const k of leadKeys(out)) {
        if ((fileLines(SEEN) ?? []).includes(k)) continue;
        try { appendFileSync(SEEN, `${k}\n`); } catch { /* as the shell */ }
        fresh.push(k);
      }
      if (fresh.length) {
        log("-> WAKE (exit 2): Builder sitting / merged PR / unasked question / squad finished");
        recordShown(out);
        writeErr(`dev-studio rewake — a Builder is sitting, a PR has merged, a role has an unasked question, or the squad finished (no message): act on its ⏸ sitting line (nudge, or look then restart) / ‼ merged line (mark the unit done and retire the Builder) / ❓ unasked line (raise it with ask-operator.sh if it is for the operator) / ★ finished line (all units merged: testability handoff, set-debrief, set-status done, tell the operator /ds-close-squad), then stop:\n${out}\n`);
        return 2;
      }
    }
    if (Math.floor(Date.now() / 1000) >= deadline) break;
    await Bun.sleep(gap * 1000);
  }

  // Window elapsed with no message: a Builder whose unit is done goes dark; everyone else re-arms.
  if (doneState && doneWt && unitDone(doneState, doneWt)) {
    log("-> window elapsed: unit done -> go dark (exit 0)");
    return 0;
  }
  if (!lead) {
    log("-> window elapsed: stay wakeable, re-arm (exit 2)");
    recordShown(out);
    writeErr("dev-studio rewake — periodic keepalive: if nothing is in your inbox, just stop (you stay wakeable for the next message).\n");
    return 2;
  }
  log("-> window elapsed: periodic reconcile (exit 2)");
  recordShown(out);
  writeErr("dev-studio rewake — periodic reconcile: compare worker-states to the squad state (GONE workers, planned-undispatched units), fix, then stop.\n");
  return 2;
}
