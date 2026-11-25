// ds install-ts — the one-command host install (U262): what bin/host/install.sh runs once it found bun.
// Preflight, the ~/.dev-studio and command links, the migration to the loop, its systemd unit and cron
// watchdog, the optional role skills and the hook unwrap; --check reads only. Same flags, output and
// writes as the shell version it replaced (tests/parity-install.sh compares the two).
import { mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ROOT, writeErr, writeOut } from "../lib/shared";
import { accountSkillsCheck } from "../lib/account-skills";
import { run as wrapHooksRun } from "./wrap-hooks-ts";
// A throw inside the port is a failed script (non-zero), as it was when wrap-hooks.sh was a child process.
const wrapHooks = async (a: string[]): Promise<number> => { try { return await wrapHooksRun(a); } catch (e) { writeErr(`wrap-hooks: ${(e as Error).message}\n`); return 1; } };
import {
  MUSE_CE_SKILLS, MUSE_DS_SKILL, agentsInUse, capture, exists, globNames, inherit, isDir, isFile, isLink,
  museSkillOn, restoreBunEnv, roleUses, which,
} from "../lib/install";

export const help = `[--check] [--skills] [--unwrap-hooks] [<commands dir>] — install dev-studio on this host (install.sh)`;

const out = (s = "") => writeOut(s + "\n");
const err = (s: string) => writeErr(s + "\n");
const lines = (s: string) => (s === "" ? [] : s.split("\n"));
const stripNl = (s: string) => s.replace(/\n+$/, "");
const readText = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
const replaceAll = (s: string, from: string, to: string) => s.split(from).join(to);

/** The first unit line `Environment="<key>=<value>"`'s value, systemd's escapes undone. */
function unitValue(unit: string, key: string): string {
  const text = readText(unit);
  if (text === null) return "";
  const re = new RegExp(`^Environment="${key}=(.*)"$`);
  for (const l of text.split("\n")) {
    const m = re.exec(l);
    if (m) return replaceAll(replaceAll(replaceAll(m[1], "%%", "%"), '\\"', '"'), "\\\\", "\\");
  }
  return "";
}
/** `grep -m1 '^<prefix>' <unit>`. */
function unitLine(unit: string, prefix: string): string {
  return (readText(unit) ?? "").split("\n").find((l) => l.startsWith(prefix)) ?? "";
}
/** What systemd reads specially inside a quoted Environment= value. */
const unitEscape = (v: string) => replaceAll(replaceAll(replaceAll(v, "\\", "\\\\"), '"', '\\"'), "%", "%%");
/** The value as one sh word in a crontab command: a backslash always ends a quoted run, % gets a backslash. */
function cronQuote(v: string): string {
  let o = "'";
  for (const c of v) o += c === "'" ? "'\\''" : c === "\\" ? "\\''" : c === "%" ? "\\%" : c;
  return o + "'";
}
/** `${s#*<pat>}` / `${s%%<pat>*}` / `${s% <pat> *}`-style cuts. */
const afterFirst = (s: string, pat: string) => { const i = s.indexOf(pat); return i < 0 ? s : s.slice(i + pat.length); };
const beforeFirst = (s: string, pat: string) => { const i = s.indexOf(pat); return i < 0 ? s : s.slice(0, i); };
const beforeLast = (s: string, pat: string) => { const i = s.lastIndexOf(pat); return i < 0 ? s : s.slice(0, i); };

/** `ln -sfn <src> <dst>` (into <dst> when it is a real directory). */
function lnSfn(src: string, dst: string): void {
  const target = !isLink(dst) && isDir(dst) ? join(dst, basename(src)) : dst;
  if (isLink(target) || exists(target)) unlinkSync(target);
  symlinkSync(src, target);
}

/** The crontab without this checkout's legacy sweep line: the script name with an edge on both sides. */
function dropSweep(cur: string): string {
  const script = `${ROOT}/bin/` + "sweep" + "." + "sh";
  const edge = (c: string) => c === "" || /^[ \t\n\v\f\r;|&()<>"']$/.test(c);
  const owned = (line: string) => {
    for (let at = line.indexOf(script); at >= 0; at = line.indexOf(script, at + script.length)) {
      if (edge(at === 0 ? "" : line[at - 1]) && edge(line.charAt(at + script.length))) return true;
    }
    return false;
  };
  return stripNl(cur.split("\n").filter((l) => !owned(l)).join("\n"));
}

export async function run(argv: string[]): Promise<number> {
  const bunBin = process.env.DS_INSTALL_BUN || process.execPath;
  delete process.env.DS_INSTALL_BUN;
  restoreBunEnv();
  const env = process.env;
  const HOME = env.HOME ?? "";
  const xdg = env.XDG_CONFIG_HOME || join(HOME, ".config");
  const BACKEND = env.BACKEND || join(ROOT, "bin", "backend", "orca.sh");
  const LOOP_UNIT = join(xdg, "systemd", "user", "ds-loop.service");
  let check = false, skills = false, dest = "";
  for (const a of argv) {
    if (a === "--check") check = true;
    else if (a === "--skills") skills = true;
    else if (a === "--unwrap-hooks") return wrapHooks(["--unwrap"]);
    else if (a.startsWith("--")) { err(`install: unsupported option ${a} — the loop is required`); return 2; }
    else dest = a;
  }
  if (dest === "") dest = join(HOME, ".claude", "commands");
  const LOOP_MARK = join(ROOT, "state", ".loop-migrated");
  const LOOP_RECONCILE = join(ROOT, "state", ".loop-reconcile");
  const hasCrontab = which("crontab") !== null;
  const crontabL = async () => (hasCrontab ? stripNl((await capture(["crontab", "-l"])).out) : "");

  // Orca's own CLI dir (U54) leads the loop's PATH: $DS_ORCA_CLI_BIN_DIR / $ORCA_CLI_BIN_DIR, else the
  // pin the unit or the cron line carries, else <Orca data path>/cli/bin when it exists.
  let cliPin = env.DS_ORCA_CLI_BIN_DIR || env.ORCA_CLI_BIN_DIR || "";
  if (cliPin === "" && isFile(LOOP_UNIT)) cliPin = unitValue(LOOP_UNIT, "DS_ORCA_CLI_BIN_DIR");
  if (cliPin === "" && hasCrontab) {
    const saved = lines(await crontabL()).find((l) =>
      (l.includes(` ${ROOT}/bin/loop/loop.sh --ensure `) || l.includes(` ${ROOT}/bin/loop.sh --ensure `)) && l.includes(" DS_ORCA_CLI_BIN_DIR=")) ?? "";
    if (saved !== "") cliPin = beforeFirst(beforeFirst(afterFirst(saved, " PATH='"), "' "), ":");
  }
  cliPin = cliPin.replace(/\/$/, "");
  let orcaCliDir = cliPin;
  let orcaData = env.ORCA_USER_DATA_PATH || "";
  if (orcaData === "" && isFile(LOOP_UNIT)) orcaData = unitValue(LOOP_UNIT, "ORCA_USER_DATA_PATH");
  const orcaDataCli = `${orcaData || join(xdg, "orca")}/cli/bin`;
  if (orcaCliDir === "" && isDir(orcaDataCli)) orcaCliDir = orcaDataCli;
  orcaCliDir = orcaCliDir.replace(/\/$/, "");
  let loopPath = env.PATH ?? "";
  if (orcaCliDir !== "") {
    const pat = `:${orcaCliDir}:`;
    let rest = `:${loopPath}:`;
    while (rest.includes(pat)) { const i = rest.indexOf(pat); rest = `${rest.slice(0, i)}:${rest.slice(i + pat.length)}`; }
    rest = rest.replace(/^:/, "").replace(/:$/, "");
    loopPath = orcaCliDir + (rest !== "" ? `:${rest}` : "");
  }
  // U164: cron rejects a line over about 1000 bytes: first copy of each folder wins, empty and missing ones go.
  const kept: string[] = [];
  // /nix/store folders come from the nix/devenv shell the install ran in: they belong to that project's
  // toolchain and vanish on garbage collection. The stable profile folders (~/.nix-profile/bin, ...) stay.
  let nixDropped = 0;
  for (const p of loopPath.split(":")) {
    if (p.startsWith("/nix/store/")) { nixDropped++; continue; }
    if (p !== "" && !kept.includes(p) && isDir(p)) kept.push(p);
  }
  loopPath = kept.join(":");

  // --- preflight, BEFORE any link: hard misses exit 1 with a one-line fix, soft ones warn ---
  const fixes: Record<string, string> = {
    git: "install git (https://git-scm.com/downloads) and re-run",
    jq: "install jq (https://jqlang.github.io/jq/download/) and re-run",
    claude: "install Claude Code on this host first, then re-run",
    orca: "install Orca on this host first, then re-run (the loop needs it too)",
  };
  // The loop runs on loopPath, so a tool only found in a dropped /nix/store folder is missing for it.
  const found = (t: string) => (nixDropped > 0 ? Bun.which(t, { PATH: loopPath }) : which(t)) ?? null;
  for (const t of Object.keys(fixes)) if (found(t) === null) { err(`install: '${t}' not found — ${fixes[t]}`); return 1; }
  out(`bun: ${Bun.version} (ok)`);

  // One backend start reads the runtime and the accounts; wrap-hooks.sh gets the rows through DS_WRAP_ACCOUNTS (U246).
  const pre = await capture([BACKEND, "preflight"]);
  if (pre.rc !== 0) { err("install: Orca runtime not reachable — start Orca on this host, then re-run"); return 1; }
  const claudeRows = lines(stripNl(pre.out)).filter((l) => l.startsWith("claude")).map((l) => l.split("\t"));
  // A bare `claude system system login` row alone means no login.
  const accts = claudeRows.map((f) => [f[0], f[1] ?? "", f[2] ?? ""].join("\t"));
  if (accts.length === 0 || !accts.some((a) => a !== "claude\tsystem\tsystem login")) {
    out(); out("⚠ no Claude login found — run 'claude login' so squads have an account to run on; continuing anyway.");
  }
  env.DS_WRAP_ACCOUNTS = claudeRows.filter((f) => (f[1] ?? "") !== "" && (f[3] ?? "") !== "").map((f) => `${f[1]}\t${f[3]}`).join("\n");

  // Soft, read-only: Orca's nested-worker depth must be >= 2 (a Lead-dispatched Builder is depth 2). Never
  // edit orca-data.json: it is mirrored to SQLite, the set-orca-depth.sh script goes through Orca's store.
  let orcaCfg = env.DS_ORCA_DATA || "";
  if (orcaCfg === "") {
    const profiles = (base: string) => globNames(base).map((p) => join(base, p, "orca-data.json"));
    orcaCfg = [...profiles(join(HOME, ".config", "orca", "profiles")), ...profiles(join(HOME, "Library", "Application Support", "orca", "profiles")),
      join(HOME, ".config", "orca", "orca-data.json")].find(isFile) ?? "";
  }
  if (orcaCfg !== "" && isFile(orcaCfg)) {
    const text = readText(orcaCfg) ?? "";
    let depth = "";
    for (const m of text.match(/"nestedWorkerMaxDepth"[: ]*[0-9]*/g) ?? []) { const d = m.match(/[0-9]+/); if (d) { depth = d[0]; break; } }
    if (!/^[0-9]+$/.test(depth)) depth = "1";
    if (Number(depth) < 2) {
      out();
      out(`⚠ Orca 'Nested worker depth' is ${depth} on this host — dev-studio needs >= 2 (a Lead-dispatched`);
      out("  Builder is depth 2). Until you raise it, Builders fail with 'nested_worker_depth_exceeded'.");
      out("  Set it once (it's enforced per Orca instance; a remote desktop's UI setting won't reach this host):");
      out(`    ${ROOT}/bin/host/set-orca-depth.sh 5 --auto        # stops/sets/restarts Orca (systemd host); or`);
      out(`    stop Orca, ${ROOT}/bin/host/set-orca-depth.sh 5, start Orca   # if it can't auto-detect`);
      out(`  Do NOT hand-edit ${orcaCfg} — it's a SQLite-mirrored store; the scripts use the safe`);
      out("  profile-state export->edit->import path instead.");
    } else {
      out(`Orca nested-worker-depth on this host: ${depth} (ok).`);
    }
  }

  if (check) return checkHost({ BACKEND, LOOP_UNIT, LOOP_MARK, orcaCliDir, crontabL });

  mkdirSync(dest, { recursive: true });
  // 1. The stable home pointer the command files resolve scripts through. A checkout already at
  // ~/.dev-studio is left alone: linking it to itself breaks every path.
  const homeLink = join(HOME, ".dev-studio");
  if (ROOT === homeLink) out(`checkout is already at ${homeLink} — leaving it as-is`);
  else { lnSfn(ROOT, homeLink); out(`linked ${homeLink} -> ${ROOT}`); }

  // 2. Live symlinks of each command (pull-to-update), then prune a ds-*.md link into this checkout
  // whose target is gone. Foreign files and links are never touched.
  let n = 0;
  const cmds = join(ROOT, ".claude", "commands");
  for (const b of globNames(cmds).filter((b) => b.startsWith("ds-") && b.endsWith(".md"))) {
    lnSfn(join(cmds, b), join(dest, b)); out(`linked ${join(dest, b)}`); n++;
  }
  for (const b of globNames(dest).filter((b) => b.startsWith("ds-") && b.endsWith(".md"))) {
    const l = join(dest, b);
    if (!isLink(l)) continue;
    let tgt = readlinkSync(l);
    if (!tgt.startsWith("/")) tgt = `${dest}/${tgt}`;
    if (!tgt.startsWith(`${ROOT}/`)) continue;
    if (!exists(l)) { rmSync(l, { force: true }); out(`pruned stale ${b}`); }
  }

  const systemd = which("systemctl") !== null && (await inherit(["systemctl", "--user", "show-environment"], { out: "ignore", err: "ignore" })) === 0;
  if (!hasCrontab) { err("install: crontab not found — the required loop watchdog cannot be installed; install cron, then re-run."); return 1; }
  const crash = (at: string) => {
    if (env.DS_SWITCH_CRASH !== at) return false;
    err(`install: crash injected after ${at}`); return true;
  };
  const migrate = () => inherit([bunBin, join(ROOT, "bin", "loop", "db", "migrate-host.ts")], { env: { DS_STATE_ROOT: join(ROOT, "state") } });

  mkdirSync(join(ROOT, "state"), { recursive: true });
  if ((await migrate()) !== 0 || !exists(LOOP_MARK)) {
    err("install: the migration to the loop did not finish; the loop installation is incomplete. Re-run bin/host/install.sh.");
    return 1;
  }
  if (crash("migrated")) return 9;
  const orcaUserData = env.ORCA_USER_DATA_PATH || "";
  const orcaCustom = orcaUserData !== "" && orcaUserData.replace(/\/$/, "") !== join(xdg, "orca");
  let unitWorks = false;
  let orcaEnv = "", orcaEnvWas = "", cliEnv = "", cliEnvWas = "", pathEnvWas = "";
  if (systemd) {
    // The unit does not inherit this terminal's environment: a custom data path goes in it, the default
    // needs no line, and a shell without the variable keeps what the unit has.
    orcaEnvWas = unitLine(LOOP_UNIT, 'Environment="ORCA_USER_DATA_PATH=');
    cliEnvWas = unitLine(LOOP_UNIT, 'Environment="DS_ORCA_CLI_BIN_DIR=');
    pathEnvWas = unitLine(LOOP_UNIT, 'Environment="PATH=');
    if (cliPin !== "") cliEnv = `Environment="DS_ORCA_CLI_BIN_DIR=${unitEscape(cliPin)}"`;
    if (orcaUserData === "") orcaEnv = orcaEnvWas;
    else if (orcaCustom) orcaEnv = `Environment="ORCA_USER_DATA_PATH=${unitEscape(orcaUserData)}"`;
    let unit = stripNl(readFileSync(join(ROOT, "systemd", "ds-loop.service"), "utf8"));
    unit = replaceAll(replaceAll(unit, "@BUN@", bunBin), "@ROOT@", ROOT);
    unit = replaceAll(replaceAll(unit, "@STATE_ROOT@", join(ROOT, "state")), "@PATH@", loopPath);
    const at = unit.indexOf("@ORCA_DATA_ENV@");
    const before = at < 0 ? unit : unit.slice(0, at), after = at < 0 ? unit : unit.slice(at + "@ORCA_DATA_ENV@".length);
    const extra = [orcaEnv, cliEnv].filter((x) => x !== "").join("\n");
    unit = extra !== "" ? before + extra + after : before + after.replace(/^\n/, "");
    mkdirSync(dirname(LOOP_UNIT), { recursive: true });
    writeFileSync(LOOP_UNIT, unit + "\n");
    if ((await inherit(["systemctl", "--user", "daemon-reload"])) === 0
      && (await inherit(["systemctl", "--user", "enable", "ds-loop.service"], { out: "ignore", err: "ignore" })) === 0) {
      unitWorks = true;
      out(`loop: systemd unit installed and enabled (${LOOP_UNIT})`);
    } else {
      out(`⚠ loop: wrote ${LOOP_UNIT} but systemctl --user could not enable it; the cron line runs the loop directly.`);
    }
  } else {
    out("loop: no systemd user session — it runs as a process of its own.");
  }
  if (crash("unit")) return 9;
  writeFileSync(LOOP_RECONCILE, "");

  // The watchdog line. A pre-U185 line ran bin/loop.sh: read it as the new path so its data path and CLI
  // pin carry over and the write replaces it. It carries a custom data path by the unit's rules.
  let cur = dropSweep(await crontabL());
  cur = replaceAll(cur, `${ROOT}/bin/loop.sh`, `${ROOT}/bin/loop/loop.sh`);
  const ensure = `${ROOT}/bin/loop/loop.sh --ensure`;
  const lineWas = lines(cur).find((l) => l.includes(` ${ensure} `) && !l.startsWith("#")) ?? "";
  const carried = (key: string) => lineWas.includes(` ${key}=`) && afterFirst(lineWas, ` ${key}=`).includes(` ${ensure} `);
  let lineEnvWas = "";
  if (carried("ORCA_USER_DATA_PATH")) lineEnvWas = `ORCA_USER_DATA_PATH=${beforeFirst(beforeLast(afterFirst(lineWas, " ORCA_USER_DATA_PATH="), ` ${ensure} `), " DS_ORCA_CLI_BIN_DIR=")}`;
  let lineCliWas = "";
  if (carried("DS_ORCA_CLI_BIN_DIR")) lineCliWas = `DS_ORCA_CLI_BIN_DIR=${beforeLast(afterFirst(lineWas, " DS_ORCA_CLI_BIN_DIR="), ` ${ensure} `)}`;
  const lineCli = cliPin !== "" ? `DS_ORCA_CLI_BIN_DIR=${cronQuote(cliPin)}` : "";
  let lineEnv = "";
  if (orcaUserData === "") lineEnv = lineEnvWas;
  else if (orcaCustom) lineEnv = `ORCA_USER_DATA_PATH=${cronQuote(orcaUserData)}`;
  const line = `* * * * * [ -x ${ROOT}/bin/loop/loop.sh ] && PATH='${loopPath}' ${lineEnv && lineEnv + " "}${lineCli && lineCli + " "}${ensure} >> ${ROOT}/state/loop-cron.log 2>&1`;
  const size = which("wc") !== null ? Buffer.byteLength(line) : [...line].length;
  if (size > 900) {
    const byParent = new Map<string, number>();
    for (const p of loopPath.split(":")) { const k = dirname(p); byParent.set(k, (byParent.get(k) ?? 0) + 1); }
    const top = [...byParent].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} folders under ${k}`).join(", ");
    err(`install: the loop's cron line is ${size} bytes; cron accepts about 1000. Run the install from a shell with a shorter PATH. Biggest PATH contributors: ${top}.`);
    return 1;
  }
  const others = cur === "" ? "" : lines(cur).filter((l) => !l.includes(`${ROOT}/bin/loop/loop.sh`)).map((l) => l + "\n").join("");
  const wrote = await capture(["crontab", "-"], { stdin: `${others}${line}\n` });
  writeOut(wrote.out); writeErr(wrote.err);
  if (wrote.rc !== 0) return wrote.rc;
  out(`loop: crontab runs ${ROOT}/bin/loop/loop.sh --ensure every minute (log: ${ROOT}/state/loop-cron.log)`);
  // --ensure leaves a running loop alone, and it would keep the old data path or PATH (its orca): stop it
  // right after the write, since a rerun reads the new line as unchanged.
  const linePathWas = beforeFirst(afterFirst(lineWas, " PATH='"), "' ");
  let loopStopped = false;
  if (!unitWorks && (lineEnv !== lineEnvWas || lineCli !== lineCliWas || (lineWas !== "" && linePathWas !== loopPath))) {
    loopStopped = true;
    if ((await inherit([join(ROOT, "bin", "loop", "loop.sh"), "--stop"], { env: { DS_STATE_ROOT: join(ROOT, "state") }, out: "ignore" })) !== 0) {
      out(`⚠ loop: the data path or PATH changed but stopping the loop failed; run ${ROOT}/bin/loop/loop.sh --stop.`);
    }
  }
  if (crash("watchdog")) return 9;
  // A loop stopped in between may have written state until it stopped: import once more.
  if (loopStopped) { const rc = await migrate(); if (rc !== 0) return rc; }
  // A failed start is not the install's failure: the watchdog line tries again every minute.
  if (systemd) {
    if (orcaEnv !== orcaEnvWas || cliEnv !== cliEnvWas || `Environment="PATH=${loopPath}"` !== pathEnvWas) {
      if ((await inherit(["systemctl", "--user", "try-restart", "ds-loop.service"])) !== 0) {
        out("⚠ loop: the data path or PATH changed but the restart failed; run systemctl --user restart ds-loop.service.");
      }
    }
    if ((await inherit(["systemctl", "--user", "start", "ds-loop.service"])) !== 0) {
      out("⚠ loop: systemctl --user start ds-loop.service failed; the cron line tries again every minute.");
    }
  } else {
    out("loop: the cron line starts it within a minute.");
  }

  // --skills: the role skills live in the host's Claude Code, not in this checkout.
  if (skills) { const rc = await inherit([join(ROOT, "bin", "host", "install-skills.sh")]); if (rc !== 0) return rc; }
  // U235: put back any settings.json an older install gated, then take the first skill listing.
  if ((await wrapHooks([])) !== 0) {
    out("⚠ hooks: unwrapping the old start-hook gate failed; check it with: bin/host/wrap-hooks.sh --check");
  }
  await inherit([join(ROOT, "bin", "ds"), "skills", "list", "--refresh"], { env: { DS_STATE_ROOT: join(ROOT, "state") }, out: "ignore", err: "ignore" });

  out(`Done: ${n} command(s). /ds-board, /ds-start-squad, /ds-update now work in any worktree; git pull keeps them current.`);
  out("Muse: /ds-* also work in Muse via the 'ds' skill (bin/host/install-skills.sh --muse-only installs/refreshes it).");
  out("Next: ~/.dev-studio/bin/host/up.sh <git-url>  (in this shell)");
  return 0;
}

/** --check: the loop, its watchdog and every agent in use, read-only. */
async function checkHost(o: { BACKEND: string; LOOP_UNIT: string; LOOP_MARK: string; orcaCliDir: string; crontabL: () => Promise<string> }): Promise<number> {
  const ensure = `${ROOT}/bin/loop/loop.sh --ensure`;
  const loopCron = lines(await o.crontabL()).filter((l) => !/^[ \t\n\v\f\r]*#/.test(l) && l.includes(ensure));
  // The unit's `orca` should be Orca's own CLI (U54): an older one fails every run-switch.
  if (isFile(o.LOOP_UNIT) && o.orcaCliDir !== "") {
    const unitPath = (readText(o.LOOP_UNIT) ?? "").split("\n").map((l) => /^Environment="PATH=(.*)"$/.exec(l)).find((m) => m)?.[1] ?? "";
    const unitOrca = Bun.which("orca", { PATH: unitPath }) ?? "";
    if (unitOrca !== `${o.orcaCliDir}/orca`) {
      out(); out(`⚠ the loop's unit resolves 'orca' to ${unitOrca || "nothing"}, not Orca's CLI in ${o.orcaCliDir} — an older CLI fails run-switches; re-run install.sh.`);
    }
  }
  let loopRc = 0;
  if (!isFile(o.LOOP_MARK) || !isFile(join(ROOT, "state", "loop.db"))) { err("install: loop is not installed — re-run bin/host/install.sh."); loopRc = 1; }
  if (loopCron.length === 0) {
    out(); loopRc = 1;
    out(`⚠ no watchdog line runs ${ensure} — nothing starts the loop after a clean exit; re-run install.sh.`);
  }
  if (which("gh") === null) {
    out(); out("⚠ gh not found — the loop needs it to read PR state; install gh (https://cli.github.com/) so done-on-merge and PR health work.");
  }
  // Per-agent verification (U4, the read-only mirror of install-skills.sh's): agents in use come from the
  // roles.conf rows including fallbacks; a missing optional agent warns naming its roles.
  out(); out("-> per-agent verification (conventions/roles.conf + conventions/models.conf)");
  const uses = roleUses();
  const agents = agentsInUse(uses);
  const museRoles = uses.filter((u) => u.agent === "muse").map((u) => `${u.role} (${u.kind})`).join(", ") || "no role (roles.conf)";
  out("claude: CLI ok");
  let rc = (await accountSkillsCheck(o.BACKEND)) === 0 ? 0 : 1;
  if (which("muse") === null) {
    out(); out(`⚠ muse: 'muse' CLI not found — roles using it (${museRoles}) stay on Claude; skipping Muse skill check`);
  } else {
    const listing = stripNl((await capture(["muse", "skills", "list"])).out);
    const missing = MUSE_CE_SKILLS.split(" ").filter((s) => !museSkillOn(listing, s)).map((s) => ` ${s}`).join("");
    if (missing === "") out(`muse: CLI ok, ce-* skills ok (${museRoles})`);
    else { out(); out(`⚠ muse skills missing from 'muse skills list':${missing} — re-run 'bin/host/install-skills.sh --muse-only' to refresh`); }
    if (museSkillOn(listing, MUSE_DS_SKILL)) out("muse: ds skill ok");
    else { out(); out(`⚠ muse ds skill '${MUSE_DS_SKILL}' missing from 'muse skills list' — re-run 'bin/host/install-skills.sh --muse-only' to refresh`); }
  }
  if (agents.includes("codex")) {
    if (which("codex") !== null) { if ((await inherit([join(ROOT, "bin", "host", "codex-skills.sh"), "--check"])) !== 0) rc = 1; }
    else { err("⚠ codex: configured in roles.conf but CLI missing — install Codex on this host"); rc = 1; }
  } else if (which("codex") !== null) out("codex: installed but not used by any role — no check");
  else out("codex: not installed, not used by any role — no check");
  // U235: a settings.json still carrying the old start-hook gate only warns.
  if ((await wrapHooks(["--check"])) !== 0) {
    out("⚠ hooks: a stale settings.json gate is above; re-run install.sh to unwrap it.");
  }
  out("preflight: ok");
  return loopRc !== 0 ? 1 : rc;
}
