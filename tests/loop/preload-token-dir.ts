// bun test preload: DS_TOKEN_DIR defaults to an empty temp dir, so no test's tokens reconciler scans the
// host's real ~/.claude/projects (KTD4). An explicit DS_TOKEN_DIR is kept (and never removed).
import { afterAll, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// U233: every test gets 30 s unless it sets its own limit (an explicit one still wins). It is set here because
// bun 1.4.4 ignores `[test] timeout` in bunfig.toml, while it does apply `preload`.
setDefaultTimeout(30_000);
if (!process.env.DS_TOKEN_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "ds-token-dir-"));
  process.env.DS_TOKEN_DIR = dir;
  // bun test fires no process exit handlers, so the made dir goes in an afterAll of the run.
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
}
// U284: every test file's temp dirs (tests/loop/temp-roots.ts) are removed after each test, whichever file made them.
import { installTempRootsHook } from "./temp-roots.ts";
installTempRootsHook();
