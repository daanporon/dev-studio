// bun test preload: DS_TOKEN_DIR defaults to an empty temp dir, so no test's tokens reconciler scans the
// host's real ~/.claude/projects (KTD4). An explicit DS_TOKEN_DIR is kept.
import { setDefaultTimeout } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// U233: every test gets 30 s unless it sets its own limit (an explicit one still wins). Set here because
// bun 1.4.4 ignores `[test] timeout` in bunfig.toml, while it does apply `preload`.
setDefaultTimeout(30_000);
// The dir is ours when we made it: each file makes it in beforeAll and removes it in afterAll (bun test never
// fires process exit handlers), so a run leaves no temp dir behind.
const ownToken = !process.env.DS_TOKEN_DIR;
if (ownToken) process.env.DS_TOKEN_DIR = join(tmpdir(), `ds-token-dir-${process.pid}`);
const tokenDir = process.env.DS_TOKEN_DIR as string;
// U284: every test file's temp dirs (tests/loop/temp-roots.ts) are removed after each test, whichever file made them.
import { installTempRootsHook } from "./temp-roots.ts";
installTempRootsHook();

// A file that sets DS_NOW or TZ and leaks it must not reach the next file (bun runs every file in one process):
// put both back to what they were when the process started, after each file.
import { afterAll, beforeAll } from "bun:test";
const ENV0 = { DS_NOW: process.env.DS_NOW, TZ: process.env.TZ };
beforeAll(() => { if (ownToken) mkdirSync(tokenDir, { recursive: true }); });
afterAll(() => {
  if (ownToken) rmSync(tokenDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(ENV0)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
