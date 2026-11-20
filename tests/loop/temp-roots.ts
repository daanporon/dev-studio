// temp-roots.ts — the one place a loop test fixture makes temp dirs and registers their cleanup (U284).
// `bun test` runs every file in one process and loads a module once, so an `afterEach` written at the top
// of a fixture module only reaches the first test file that imports it: later files leaked their dirs.
// tests/loop/preload-token-dir.ts (loaded for every file by bunfig.toml) calls `installTempRootsHook()`,
// whose global afterEach runs every registered closer and removes every registered dir after each test.
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [], closers: (() => void)[] = [];
let installed = false;

// Under XDG_RUNTIME_DIR when there is one: Bun is slow with a cwd under a huge /tmp (builder note).
export function tempBase(): string {
  return process.env.XDG_RUNTIME_DIR || tmpdir();
}

// A new temp dir removed after the current test, in whichever test file asks.
export function tempRoot(prefix: string): string {
  const d = mkdtempSync(join(tempBase(), prefix));
  roots.push(d);
  return d;
}

// Something to close (a store) before the dirs are removed, after the current test.
export function onTestEnd(close: () => void): void {
  closers.push(close);
}

export function cleanTempRoots(): void {
  for (const c of closers.splice(0)) { try { c(); } catch { /* already closed */ } }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export function installTempRootsHook(): void {
  if (installed) return;
  installed = true;
  afterEach(cleanTempRoots);
}
