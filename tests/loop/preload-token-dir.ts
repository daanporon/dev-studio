// bun test preload: DS_TOKEN_DIR defaults to an empty temp dir, so no test's tokens reconciler scans the
// host's real ~/.claude/projects (KTD4). An explicit DS_TOKEN_DIR is kept.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
if (!process.env.DS_TOKEN_DIR) process.env.DS_TOKEN_DIR = mkdtempSync(join(tmpdir(), "ds-token-dir-"));
// U284: every test file's temp dirs (tests/loop/temp-roots.ts) are removed after each test, whichever file made them.
import { installTempRootsHook } from "./temp-roots.ts";
installTempRootsHook();
