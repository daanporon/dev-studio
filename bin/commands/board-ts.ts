// ds board-ts — the board's front door (U222): what bin/board/board.sh runs. Arguments, the --watch
// loop, the --serve wish and the --serve-fg process (pidfile, ready file, restart on exit 75).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, dsLabel, chomp, run as runCmd, writeOut, writeErr } from "../lib/shared";

export const help = `[<project>] [--topic <slug>] [--watch [s]] [--json] [--serve [port]] [--stop] [--serve-fg [port]] — the overview board: text, JSON, or the live web board (board.sh)`;

const err = (s: string) => writeErr(s + "\n");
const out = (s: string) => writeOut(s);
const isNum = (s: string | undefined) => s !== undefined && /^[0-9]+$/.test(s);

function findBun(): string {
  let bun = Bun.which("bun") ?? "";
  const home = process.env.HOME ?? "";
  if (!bun && home && existsSync(join(home, ".bun", "bin", "bun"))) bun = join(home, ".bun", "bin", "bun");
  return bun;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

// True only if that live pid is actually a board process — not a reused pid number.
async function isBoardProc(pid: number): Promise<boolean> {
  const r = await runCmd(["ps", "-p", String(pid), "-o", "args="]);
  return /board(\.sh|-ts)/.test(r.out);
}

class Exit extends Error { constructor(public code: number) { super("exit"); } }

// Restart semantics: a live board already holding this scope is killed and replaced.
async function claimPidfile(pf: string, lbl: string): Promise<void> {
  if (existsSync(pf)) {
    let old = "";
    try { old = readFileSync(pf, "utf8"); } catch { /* gone */ }
    const op = Number(old);
    if (old !== "" && /^[0-9]+$/.test(old.trim()) && op !== process.pid && alive(op) && await isBoardProc(op)) {
      err(`board (${lbl}): replacing the running one (pid ${op})`);
      try { process.kill(op, "SIGTERM"); } catch { /* gone */ }
      for (let i = 0; alive(op) && i < 25; i++) await Bun.sleep(200);
      if (alive(op)) {
        try { process.kill(op, "SIGKILL"); } catch { /* gone */ }
        await Bun.sleep(300);
        if (alive(op)) { err(`board (${lbl}): previous process ${op} won't die — refusing to start a second one`); throw new Exit(1); }
      }
    }
  }
  rmSync(pf, { force: true });
  try { const fd = openSync(pf, "wx"); writeFileSync(fd, String(process.pid)); closeSync(fd); }
  catch { err(`board (${lbl}): pidfile ${pf} was just claimed by another start — aborting`); throw new Exit(1); }
}

export async function run(argv: string[]): Promise<number> {
  try { return await main(argv); } catch (e) { if (e instanceof Exit) return e.code; throw e; }
}

async function main(argv: string[]): Promise<number> {
  let WATCH = false, INTERVAL = 5, PROJECT = "", TOPIC = "", JSON_OUT = false, SERVE = false, SERVEFG = false, ENSURE = false, STOP = false, PORT = 8787, PORT_GIVEN = false;
  for (let i = 0; i < argv.length;) {
    const a = argv[i];
    if (a === "--watch") { WATCH = true; i++; if (isNum(argv[i])) { INTERVAL = Number(argv[i]); i++; } }
    else if (a === "--serve" || a === "--serve-fg") {
      if (a === "--serve") SERVE = true; else SERVEFG = true; i++;
      if (isNum(argv[i])) { PORT = Number(argv[i]); PORT_GIVEN = true; i++; }
    }
    else if (a === "--ensure") { ENSURE = true; i++; }
    else if (a === "--stop") { STOP = true; i++; }
    else if (a === "--topic") { TOPIC = argv[i + 1] ?? ""; i += 2; }
    else if (a === "--json") { JSON_OUT = true; i++; }
    else if (a === "--html" || a === "--out") { err(`board: ${a} is gone — the web board is now 'board.sh <project> --serve' (open http://127.0.0.1:8787/)`); return 2; }
    else if (a.startsWith("-")) { err(`board: unknown option ${a}`); return 2; }
    else { PROJECT = a; i++; }
  }
  const SROOT = process.env.DS_STATE_ROOT || join(ROOT, "state");

  if (ENSURE) { out("board: the loop runs the board now (`board.sh <project> --serve` writes the wish) — nothing to ensure\n"); return 0; }
  if (SERVE || STOP) {
    const wargs = ["want", "board"];
    if (PROJECT) wargs.push("--project", dsLabel(PROJECT));
    if (TOPIC) wargs.push("--topic", TOPIC);
    if (STOP) wargs.push("--stop");
    else {
      if (PORT_GIVEN) wargs.push("--port", String(PORT));
      if (process.env.DS_BIND) wargs.push("--bind", process.env.DS_BIND);
      if (process.env.DS_BOARD_HOSTS) wargs.push("--hosts", process.env.DS_BOARD_HOSTS);
      const wait = process.env.DS_BOARD_SERVE_WAIT || "15";
      if (wait !== "0") wargs.push("--wait", wait);
    }
    let scope = (PROJECT ? dsLabel(PROJECT) : "") + (TOPIC ? `/${TOPIC}` : "");
    scope = scope || "all projects";
    const w = Bun.spawnSync([join(ROOT, "bin", "ds"), ...wargs], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
    if (w.exitCode !== 0) {
      err(`board (${scope}): not running — \`bin/ds services\` shows the row, its log is board-serve${TOPIC ? `-${TOPIC}` : ""}.log in the state dir`);
      return w.exitCode ?? 1;
    }
    if (STOP) { out(`board (${scope}): the loop stops it on its next tick\n`); return 0; }
    let row: any = {};
    try { row = JSON.parse(w.stdout.toString()); } catch { /* jq would have failed; treat as empty */ }
    if (row?.was_down === true) { out(`board (${scope}): was down, the loop restarts it on its next tick\n`); return 0; }
    const has = (v: unknown) => v !== null && v !== undefined && v !== false && v !== "";
    const wport = has(row?.port) ? String(row.port) : String(PORT);
    let tnet = "";
    if (!process.env.DS_BIND) tnet = chomp((await runCmd(["tailscale", "ip", "-4"])).out).split("\n")[0] ?? "";
    out(`board (${scope}): the loop runs it on :${wport} — open http://127.0.0.1:${wport}/ on this host${tnet ? ` or http://${tnet}:${wport}/ over the tailnet` : ""} (status: ${has(row?.status) ? row.status : "starting on the next tick"})\n`);
    return 0;
  }

  const bun = findBun();
  if (!bun) { err("board needs bun — install it once: curl -fsSL https://bun.sh/install | bash"); return 1; }
  const data = [bun, join(ROOT, "bin", "board", "board-data.ts"), ...(PROJECT ? [PROJECT] : []), ...(TOPIC ? ["--topic", TOPIC] : [])];

  if (SERVEFG) return await serveFg(argv, { bun, data, PROJECT, TOPIC, PORT, SROOT });
  if (JSON_OUT) return (Bun.spawnSync([...data, "--json"], { stdio: ["inherit", "inherit", "inherit"] }).exitCode) ?? 1;
  if (WATCH) {
    process.on("SIGINT", () => process.exit(0));
    for (;;) {
      const o = Bun.spawnSync(["sh", "-c", 'exec "$@" 2>&1', "sh", ...data], { stdout: "pipe", stdin: "ignore" }).stdout.toString();
      const c = Bun.spawnSync(["clear"], { stdout: "inherit", stderr: "ignore" });
      if (c.exitCode !== 0) out("\x1b[2J\x1b[H");
      out(chomp(o) + "\n");
      out(`\n(watching every ${INTERVAL}s — Ctrl-C to stop)\n`);
      await Bun.sleep(INTERVAL * 1000);
    }
  }
  return (Bun.spawnSync(data, { stdio: ["inherit", "inherit", "inherit"] }).exitCode) ?? 1;
}

async function serveFg(_argv: string[], c: { bun: string; data: string[]; PROJECT: string; TOPIC: string; PORT: number; SROOT: string }): Promise<number> {
  const { bun, data, PROJECT, TOPIC, PORT, SROOT } = c;
  // Scope-keyed pidfile (all / project / project+topic) so distinct scopes run side by side.
  const scope = PROJECT ? join(SROOT, dsLabel(PROJECT), `board-serve${TOPIC ? `-${TOPIC}` : ""}`) : join(SROOT, `board-serve${TOPIC ? `-${TOPIC}` : ""}`);
  mkdirSync(dirname(scope), { recursive: true });
  const pidfile = scope + ".pid", ready = scope + ".ready";
  await claimPidfile(pidfile, "serve");
  // The old version kept its pidfile as board-www.pid: replace that one too.
  const legacy = join(dirname(scope), `board-www${TOPIC ? `-${TOPIC}` : ""}`);
  if (existsSync(legacy + ".pid")) { await claimPidfile(legacy + ".pid", "serve"); rmSync(legacy + ".pid", { force: true }); }
  rmSync(legacy, { recursive: true, force: true });

  const tnet = chomp((await runCmd(["tailscale", "ip", "-4"])).out).split("\n")[0] ?? "";
  const bind = process.env.DS_BIND || `127.0.0.1${tnet ? ` ${tnet}` : ""}`;
  if (!process.env.DS_BIND && !tnet) err("board (serve): no tailnet IP found (is tailscale up?) — serving on this host only");
  let tdns = "";
  try {
    const ts = await runCmd(["tailscale", "status", "--json"]);
    const j = JSON.parse(ts.out);
    tdns = String(j?.Self?.DNSName ?? "").replace(/\.$/, "");
  } catch { /* no tailscale */ }
  const hn = chomp((await runCmd(["hostname"])).out), hns = chomp((await runCmd(["hostname", "-s"])).out);

  let srv: ReturnType<typeof Bun.spawn> | null = null;
  const cleanup = () => { rmSync(pidfile, { force: true }); rmSync(ready, { force: true }); try { srv?.kill(); } catch { /* gone */ } };
  const stop = () => { cleanup(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);

  for (;;) {
    rmSync(ready, { force: true });
    srv = Bun.spawn([bun, process.env.DS_BOARD_SERVER || join(ROOT, "bin", "board", "board-server.ts"), bind, String(PORT), join(ROOT, "web", "board.html"), ...data, "--json"], {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, DS_READY_FILE: ready, DS_BOARD_HOSTS: `localhost 127.0.0.1 ::1 ${hn} ${hns} ${tnet} ${tdns} ${tdns.split(".")[0]} ${bind} ${process.env.DS_BOARD_HOSTS ?? ""}` } as Record<string, string>,
    });
    let exited = false;
    srv.exited.then(() => { exited = true; });
    // Say "listening" only once the server has bound every address; if it died (port taken), fail.
    for (let i = 0; i < 100; i++) { if (existsSync(ready) || exited) break; await Bun.sleep(100); }
    if (!existsSync(ready)) {
      await srv.exited;
      err(`board (serve): the server didn't start (see above) — is something else on port ${PORT}? (lsof -nP -iTCP:${PORT} -sTCP:LISTEN)`);
      cleanup();
      return 1;
    }
    const turl = ` ${bind} `.includes(` ${tnet} `) && tnet ? ` or http://${tnet}:${PORT}/ over the tailnet` : "";
    out(`board (serve): listening on ${bind}:${PORT} — open http://127.0.0.1:${PORT}/ on this host${turl}  (Ctrl-C to stop)\n`);
    const rc = await srv.exited;
    // 75: board-server.ts changed on disk (a pull) — run again on the new code, keeping pid and pidfile.
    if (rc === 75) continue;
    cleanup();
    return rc;
  }
}
