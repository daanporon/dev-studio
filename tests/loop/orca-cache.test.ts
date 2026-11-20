// U244: the per-tick shared Orca reads (bin/backend/orca-cache.ts): which calls are shared, one fetch for
// concurrent readers, nothing stored when a write came in between, and a write drops every copy. U252: the
// wider read shapes and spreadDue (bin/loop/core/timers.ts). U264: `limited` keeps a silent worker's screen and `current`
// keeps its answer inside the loop.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cachedRead, canonRead, dropCached, keyOf, runOfCanon } from "../../bin/backend/orca-cache.ts";
import { spreadDue } from "../../bin/loop/core/timers.ts";
import { limited, VERBS } from "../../bin/backend/orca.ts";

const dir = () => mkdtempSync(join(tmpdir(), "orca-cache-"));
const enc = (s: string) => new TextEncoder().encode(s);

describe("canonRead", () => {
  test("terminal list and a Run's worker-list/run-show are shared, in one spelling", () => {
    expect(canonRead(["terminal", "list", "--json"])).toEqual(["terminal", "list", "--limit", "1000", "--json"]);
    expect(canonRead(["terminal", "list", "--json", "--limit", "1000"])).toEqual(canonRead(["terminal", "list", "--json"]));
    expect(canonRead(["orchestration", "worker-list", "--run", "r1", "--json", "--limit", "100"])).toEqual(canonRead(["orchestration", "worker-list", "--json", "--run", "r1"]));
    expect(canonRead(["orchestration", "run-show", "--id", "r1", "--json", "--full"])).toEqual(["orchestration", "run-show", "--id", "r1", "--json", "--full"]);
  });
  test("a call with other flags, no --json or no Run is not shared", () => {
    expect(canonRead(["terminal", "list"])).toBeNull();
    expect(canonRead(["orchestration", "worker-list", "--json"])).toBeNull();
    expect(canonRead(["orchestration", "worker-list", "--run", "r1", "--state", "x", "--json"])).toBeNull();
    expect(canonRead(["orchestration", "check", "--run", "r1", "--peek", "--json"])).toBeNull();
    expect(canonRead(["orchestration", "send", "--json"])).toBeNull();
  });
  // U252: the read shapes the loop also uses are shared, each keyed with the flags that change the answer.
  test("--terminal-state, terminal list --full/--worktree, the inbox listing, worktree ps/current are shared, keyed by their flags", () => {
    const st = canonRead(["orchestration", "worker-list", "--terminal-state", "reclaimable", "--limit", "100", "--json", "--full"]);
    expect(st).toEqual(["orchestration", "worker-list", "--terminal-state", "reclaimable", "--json", "--full", "--limit", "100"]);
    expect(canonRead(["orchestration", "worker-list", "--run", "r1", "--terminal-state", "reclaimable", "--json", "--full"])).not.toEqual(canonRead(["orchestration", "worker-list", "--run", "r1", "--json", "--full"]));
    expect(runOfCanon(canonRead(["orchestration", "worker-list", "--run", "r1", "--terminal-state", "x", "--json"])!)).toBe("");   // tick only, never kept
    expect(canonRead(["terminal", "list", "--json", "--full"])).toEqual(["terminal", "list", "--limit", "1000", "--json", "--full"]);
    expect(canonRead(["terminal", "list", "--worktree", "id:w", "--limit", "1000", "--json"])).toEqual(["terminal", "list", "--worktree", "id:w", "--limit", "1000", "--json"]);
    expect(canonRead(["orchestration", "inbox", "--limit", "1000", "--json", "--full"])).toEqual(["orchestration", "inbox", "--limit", "1000", "--json", "--full"]);
    expect(canonRead(["worktree", "ps", "--json", "--limit", "1000"])).toEqual(["worktree", "ps", "--json", "--limit", "1000"]);
    expect(canonRead(["worktree", "ps", "--json", "--limit", "1000", "--worktree", "id:w"])).toBeNull();
    expect(canonRead(["worktree", "current", "--json"])).toEqual(["worktree", "current", "--json"]);
    expect(keyOf(["worktree", "current", "--json"])).not.toBe(createHash("sha1").update("worktree\0current\0--json\0").digest("hex"));  // keyed by cwd too
  });
});

describe("cachedRead", () => {
  const canon = ["orchestration", "run-show", "--id", "r1", "--json"];
  test("concurrent readers make one fetch; a later reader reads the copy", async () => {
    const d = dir(); let n = 0;
    const fetch = async () => { n++; await Bun.sleep(30); return { code: 0, out: enc("x"), value: n }; };
    const rs = await Promise.all([1, 2, 3].map(() => cachedRead(d, canon, fetch)));
    await cachedRead(d, canon, fetch);
    expect(n).toBe(1);
    expect(rs.every((r) => r !== undefined)).toBe(true);
    rmSync(d, { recursive: true });
  });
  test("a failed fetch is not stored", async () => {
    const d = dir(); let n = 0;
    const fetch = async () => ({ code: 1, out: enc(""), value: ++n });
    await cachedRead(d, canon, fetch); await cachedRead(d, canon, fetch);
    expect(n).toBe(2);
    rmSync(d, { recursive: true });
  });
  test("a write drops the copies, and a read begun before it stores nothing", async () => {
    const d = dir(); let n = 0;
    const fetch = async () => ({ code: 0, out: enc("x"), value: ++n });
    await cachedRead(d, canon, fetch);
    expect(readdirSync(d).includes(keyOf(canon))).toBe(true);
    dropCached(d);
    expect(readdirSync(d).includes(keyOf(canon))).toBe(false);
    await cachedRead(d, canon, async () => { dropCached(d); return { code: 0, out: enc("stale"), value: 0 }; });
    expect(readdirSync(d).includes(keyOf(canon))).toBe(false);
    await cachedRead(d, canon, fetch);
    expect(n).toBe(2);
    rmSync(d, { recursive: true });
  });
});

describe("spreadDue", () => {
  test("never before half the interval, always by the whole of it, and keys made due together spread out", () => {
    const keys = Array.from({ length: 16 }, (_, i) => `relay:p/t${i}`);
    for (const k of keys) { expect(spreadDue(k, 0, 29, 60)).toBe(false); expect(spreadDue(k, 0, 60, 60)).toBe(true); }
    const firstDue = keys.map((k) => { let t = 30; while (!spreadDue(k, 0, t, 60)) t++; return t; });
    expect(new Set(firstDue).size).toBeGreaterThan(8);
    expect(spreadDue("x", 0, 0, 0)).toBe(true);
  });
});

// A fake `orca`: one idle worker silent 15 min whose agent terminal shows a usage-limit notice; `worktree current`
// answers selector_not_found (the loop's checkout), or a transient failure with FAKE_CUR=flaky. Every call is logged.
const NOW = 1_800_000_000;
function fakeOrca() {
  const d = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "u264-")), bin = join(d, "bin"), log = join(d, "cli.log");
  mkdirSync(bin); mkdirSync(join(d, "proc")); mkdirSync(join(d, "loop"));
  writeFileSync(join(bin, "orca"), `#!/usr/bin/env bash
echo "$1 $2" >> "$CLI_LOG"
case "$1 $2" in
  "worktree ps") printf '{"ok":true,"result":{"worktrees":[{"worktreeId":"wt_1","displayName":"b","agents":[{"state":"%s","stateStartedAt":%s}]}]}}' "$FAKE_STATE" "$FAKE_SINCE" ;;
  "terminal list") echo '{"ok":true,"result":{"terminals":[{"handle":"term_1","worktreeId":"wt_1","connected":true,"writable":true,"agentIdentity":"claude","lastOutputAt":5}]}}' ;;
  "terminal read") echo '{"ok":true,"result":{"terminal":{"tail":["⏺ done","  ⎿  5-hour limit reached ∙ resets 3pm","❯"]}}}' ;;
  "worktree current") if [ "$FAKE_CUR" = flaky ]; then echo "orca: timeout" >&2; exit 1; fi
    echo '{"id":"local","ok":false,"error":{"code":"selector_not_found","message":"No Orca-managed worktree"}}'; exit 1 ;;
  *) echo '{"ok":true}' ;;
esac
`);
  chmodSync(join(bin, "orca"), 0o755);
  const env = (o: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "", HOME: d, DS_ORCA_CLI_BIN_DIR: bin, CLI_LOG: log, DS_PROC: join(d, "proc"),
    DS_NOW: String(NOW), FAKE_STATE: "idle", FAKE_SINCE: String((NOW - 900) * 1000), ...o }) as Record<string, string>;
  // A loop tick's directory: made again at the same path each tick, as tick.ts does.
  const tick = () => { const t = join(d, "loop", "orca-tick"); rmSync(t, { recursive: true, force: true }); mkdirSync(t); return t; };
  const calls = (verb: string) => readFileSync(log, "utf8").split("\n").filter((l) => l === verb).length;
  const ctx = (env: Record<string, string>, out: string[] = []) => ({ env, out: (b: string | Uint8Array) => out.push(String(b)), err() {}, stdin: "ignore" }) as any;
  return { d, env, tick, calls, ctx };
}

describe("U264: limited keeps a silent worker's screen", () => {
  test("an unchanged silent terminal is read once in 3 ticks; again when its state changes, and after DS_LIMITED_REREAD_S", async () => {
    const f = fakeOrca();
    const run = async (o: Record<string, string> = {}) => new TextDecoder().decode(await limited(f.ctx(f.env({ DS_ORCA_TICK_DIR: f.tick(), ...o }))));
    for (let i = 0; i < 3; i++) expect(await run()).toContain("wt_1\t");
    expect(f.calls("terminal read")).toBe(1);
    expect(await run({ FAKE_STATE: "done" })).toContain("5-hour limit reached");
    expect(f.calls("terminal read")).toBe(2);
    await run({ FAKE_STATE: "done", DS_NOW: String(NOW + 299) });
    expect(f.calls("terminal read")).toBe(2);
    await run({ FAKE_STATE: "done", DS_NOW: String(NOW + 300) });
    expect(f.calls("terminal read")).toBe(3);
    rmSync(f.d, { recursive: true, force: true });
  });
  test("outside the loop (no DS_ORCA_TICK_DIR) every run reads the screen", async () => {
    const f = fakeOrca();
    for (let i = 0; i < 2; i++) expect(new TextDecoder().decode(await limited(f.ctx(f.env())))).toContain("wt_1\t");
    expect(f.calls("terminal read")).toBe(2);
    rmSync(f.d, { recursive: true, force: true });
  });
});

describe("U264: current is asked once inside the loop", () => {
  test("selector_not_found is kept for the process by cwd and CLI; a transient failure and a call outside the loop are not", async () => {
    const f = fakeOrca(), out: string[] = [];
    for (let i = 0; i < 3; i++) expect(await VERBS.current(f.ctx(f.env({ DS_ORCA_TICK_DIR: f.tick() }), out), [])).toBe(0);
    expect(f.calls("worktree current")).toBe(1);
    expect(out.join("")).toBe("");                                   // the same (empty) answer every time
    for (let i = 0; i < 2; i++) await VERBS.current(f.ctx(f.env()), []);
    expect(f.calls("worktree current")).toBe(3);
    const g = fakeOrca();
    for (let i = 0; i < 2; i++) await VERBS.current(g.ctx(g.env({ DS_ORCA_TICK_DIR: g.tick(), FAKE_CUR: "flaky" })), []);
    expect(g.calls("worktree current")).toBe(2);
    for (const x of [f, g]) rmSync(x.d, { recursive: true, force: true });
  });
});
