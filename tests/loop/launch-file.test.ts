// orca-backend-alternatives U20a: a long launch line goes to a 0600 file; the typed line is short.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDir, launchPath, removeLaunch, writeLaunch } from "../../bin/loop/squad/launch-file.ts";

const root = mkdtempSync(join(tmpdir(), "zzlaunch-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const long = `exec env PATH=/g claude --settings '${"skill,".repeat(1600)}' build\\ u1`;

test("a line over 4,096 bytes: the typed text is the short line and the file holds all of it, 0600", () => {
  expect(long.length).toBeGreaterThan(9000);
  const typed = writeLaunch(root, "realp", "/w/builder-u1", "gen-1", long);
  expect(Buffer.byteLength(typed)).toBeLessThan(512);
  expect(typed).toBe(`exec sh '${launchPath(root, "realp", "/w/builder-u1", "gen-1")}'`);
  const file = launchPath(root, "realp", "/w/builder-u1", "gen-1");
  expect(readFileSync(file, "utf8")).toBe(`${long}\n`);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(launchDir(root, "realp", "/w/builder-u1")).mode & 0o777).toBe(0o700);
});

test("the next generation removes the old file; a replay of one generation keeps its file; close removes all", () => {
  const m = "/w/builder-u2", a = launchPath(root, "realp", m, "g1"), b = launchPath(root, "realp", m, "g2");
  writeLaunch(root, "realp", m, "g1", long);
  writeLaunch(root, "realp", m, "g1", long);
  expect(existsSync(a)).toBe(true);
  writeLaunch(root, "realp", m, "g2", long);
  expect(existsSync(a)).toBe(false);
  expect(existsSync(b)).toBe(true);
  removeLaunch(root, "realp", m);
  expect(existsSync(b)).toBe(false);
  removeLaunch(root, "realp", m);   // nothing left: no error
});

test("a path with a quote is quoted for sh", () => {
  const typed = writeLaunch(join(root, "it's"), "realp", "m", "g", "echo hi");
  expect(typed).toContain(`it'\\''s`);
});
