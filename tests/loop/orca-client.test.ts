// U254 spike: Orca reads through one long-lived helper that keeps the CLI bundle loaded (bin/backend/orca-client.ts),
// off by default. A fake Orca install (a launcher of Orca's shape + a bundle exporting main) stands in for Orca.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orca, type Ctx } from "../../bin/backend/orca.ts";
import { clientRead, enableOrcaClient, orcaClientStats, readLauncher, servable, stopOrcaClient, streams } from "../../bin/backend/orca-client.ts";

const root = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "orca-client-"));
const node = Bun.which("node") ?? process.execPath;

// The bundle: prints its version, argv and pid; flags make it warn, fail, exit, hang or die. `--die` kills only a
// helper (a bundle that is required, not run), so the CLI fallback still answers.
function bundle(version: string): string {
  const f = join(root, `index-${version}.js`);
  writeFileSync(f, `
async function main(argv) {
  if (argv.includes("--die") && require.main !== module) process.kill(process.pid, "SIGKILL");
  if (argv.includes("--slow")) await new Promise((r) => setTimeout(r, 40));
  if (argv.includes("--hang") && require.main !== module) await new Promise(() => {});
  if (argv.includes("--exit")) { process.stdout.write("bye\\n"); process.exit(4); }
  process.stdout.write(JSON.stringify({ v: ${JSON.stringify(version)}, argv, pid: process.pid, main: require.main === module }) + "\\n");
  if (argv.includes("--warn")) process.stderr.write("warn\\n");
  if (argv.includes("--fail")) { process.stderr.write("error: nope\\n"); process.exitCode = 3; }
}
module.exports = { main };
if (require.main === module) main(process.argv.slice(2));
`);
  return f;
}
const launcher = join(root, "orca");
function install(version: string): void {
  writeFileSync(launcher, `#!/usr/bin/env sh\nset -eu\nexport ORCA_USER_DATA_PATH='${root}'\nexec '${node}' '${bundle(version)}' "$@"\n`, { mode: 0o755 });
}
const env = (): Record<string, string> => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });
const parse = (s: string) => JSON.parse(s.trim().split("\n")[0]);

install("1");
afterEach(() => enableOrcaClient(false));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("servable", () => {
  test("the loop's hot reads, and a check only with --peek", () => {
    expect(servable(["terminal", "list", "--json"])).toBe(true);
    expect(servable(["orchestration", "worker-list", "--run", "r", "--json", "--full"])).toBe(true);
    expect(servable(["orchestration", "check", "--run", "r", "--peek", "--json"])).toBe(true);
    expect(servable(["orchestration", "check", "--run", "r", "--json"])).toBe(false);
    expect(servable(["orchestration", "check", "--peek", "--wait", "--timeout-ms", "9000", "--json"])).toBe(false);
    expect(servable(["terminal", "send", "--terminal", "t", "--text", "x"])).toBe(false);
    expect(servable(["terminal", "wait", "--terminal", "t"])).toBe(false);
  });
});

describe("readLauncher", () => {
  test("reads the node and bundle from Orca's launcher shape; another shape is null", () => {
    const l = readLauncher(launcher)!;
    expect(l.node).toBe(node);
    expect(l.script).toBe(join(root, "index-1.js"));
    expect(l.userData).toBe(root);
    const other = join(root, "other");
    writeFileSync(other, "#!/bin/sh\nexec orca-real \"$@\"\n", { mode: 0o755 });
    expect(readLauncher(other)).toBeNull();
  });
});

describe("clientRead", () => {
  test("off by default: nothing is served", async () => {
    expect(await clientRead(launcher, ["terminal", "list", "--json"], env())).toBeNull();
  });

  test("a served read answers what the CLI answers: stdout, stderr in order, exit code", async () => {
    enableOrcaClient(true);
    const r = (await clientRead(launcher, ["terminal", "list", "--json", "--warn", "--fail"], env()))!;
    expect(r.code).toBe(3);
    const s = streams(r);
    expect(parse(s.out)).toMatchObject({ v: "1", argv: ["terminal", "list", "--json", "--warn", "--fail"], main: false });
    expect(s.err).toBe("warn\nerror: nope\n");
    expect(s.merged.endsWith("warn\nerror: nope\n")).toBe(true);
    // exitCode does not leak into the next call
    const ok = (await clientRead(launcher, ["terminal", "list", "--json"], env()))!;
    expect(ok.code).toBe(0);
    expect(parse(streams(ok).out).pid).toBe(parse(s.out).pid);   // the same warm helper
  });

  test("a command that exits ends only that call", async () => {
    enableOrcaClient(true);
    const before = orcaClientStats().starts;
    const r = (await clientRead(launcher, ["terminal", "list", "--json", "--exit"], env()))!;
    expect(r.code).toBe(4);
    expect(streams(r).out).toBe("bye\n");
    expect((await clientRead(launcher, ["terminal", "list", "--json"], env()))!.code).toBe(0);
    expect(orcaClientStats().starts - before).toBe(1);
  });

  test("side-by-side reads spread over the pool and each gets its own answer", async () => {
    enableOrcaClient(true);
    const e = { ...env(), DS_ORCA_CLIENT_POOL: "3" };
    const rs = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => clientRead(launcher, ["orchestration", "worker-list", "--run", `r${i}`, "--json", "--slow"], e)));
    rs.forEach((r, i) => expect(parse(streams(r!).out).argv[3]).toBe(`r${i}`));
    expect(new Set(rs.map((r) => parse(streams(r!).out).pid)).size).toBe(3);
  });

  test("an Orca update (the launcher names a new bundle) starts a fresh helper without a restart", async () => {
    enableOrcaClient(true);
    const a = parse(streams((await clientRead(launcher, ["terminal", "list", "--json"], env()))!).out);
    install("2");
    const b = parse(streams((await clientRead(launcher, ["terminal", "list", "--json"], env()))!).out);
    expect([a.v, b.v]).toEqual(["1", "2"]);
    expect(b.pid).not.toBe(a.pid);
    install("1");
  });

  test("a call from another Orca environment is the CLI's", async () => {
    enableOrcaClient(true);
    expect(await clientRead(launcher, ["terminal", "list", "--json"], env())).not.toBeNull();
    expect(await clientRead(launcher, ["terminal", "list", "--json"], { ...env(), ORCA_TERMINAL_HANDLE: "term_x" })).toBeNull();
  });

  test("a helper that overruns is killed and answers null; the next call starts another", async () => {
    enableOrcaClient(true);
    const e = { ...env(), DS_ORCA_CLIENT_TIMEOUT_MS: "300" };
    const before = orcaClientStats().starts;
    expect(await clientRead(launcher, ["terminal", "list", "--json", "--hang"], e)).toBeNull();
    expect((await clientRead(launcher, ["terminal", "list", "--json"], e))!.code).toBe(0);
    expect(orcaClientStats().starts - before).toBe(2);
  });

  test("a helper that cannot load the bundle answers null, and that Orca is left to the CLI for a while", async () => {
    enableOrcaClient(true);
    const bad = join(root, "orca-bad"), broken = join(root, "broken.js");
    writeFileSync(broken, "throw new Error('not a bundle');\n");
    writeFileSync(bad, `#!/bin/sh\nexec '${node}' '${broken}' "$@"\n`, { mode: 0o755 });
    const before = orcaClientStats().starts;
    expect(await clientRead(bad, ["terminal", "list", "--json"], env())).toBeNull();
    expect(await clientRead(bad, ["terminal", "list", "--json"], env())).toBeNull();
    expect(orcaClientStats().starts - before).toBe(1);
    expect((await clientRead(launcher, ["terminal", "list", "--json"], env()))!.code).toBe(0);
  });

  test("a helper that dies answers null; the next call starts another", async () => {
    enableOrcaClient(true);
    expect(await clientRead(launcher, ["terminal", "list", "--json", "--die"], env())).toBeNull();
    expect((await clientRead(launcher, ["terminal", "list", "--json"], env()))!.code).toBe(0);
  });
});

describe("orca() with the helper on", () => {
  const ctx = (e: Record<string, string>): Ctx => ({ env: e, out: () => {}, err: () => {}, stdin: "ignore", cli: launcher });
  test("a read is served and logged as `client`; a write and a dead helper still spawn the CLI", async () => {
    enableOrcaClient(true);
    const log = join(root, "spawns.log");
    writeFileSync(log, "");
    const e = { ...env(), DS_ORCA_SPAWN_LOG: log };
    const read = await orca(ctx(e), ["orchestration", "worker-list", "--run", "r1", "--json"], "keep");
    expect(parse(read.out).main).toBe(false);
    const write = await orca(ctx(e), ["terminal", "send", "--terminal", "t", "--text", "x"], "keep");
    expect(parse(write.out).main).toBe(true);
    const died = await orca(ctx(e), ["terminal", "list", "--json", "--die", "--warn"], "merge");
    expect(died.out).toContain('"main":true');
    expect(died.out.endsWith("warn\n")).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("client orchestration\t\tpast\nterminal send\t\twrite\nterminal list\t\tpast\n");
  });
  test("off, every call spawns the CLI", async () => {
    stopOrcaClient();
    const r = await orca(ctx(env()), ["terminal", "list", "--json"], "keep");
    expect(parse(r.out).main).toBe(true);
  });
});
