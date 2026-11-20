// U227: the loop calls bin/backend/orca.ts in process instead of spawning orca.sh. Each in-process
// answer must be what spawning orca.sh answered: the same {code, out, err} for the same environment,
// including what orca.sh exported (DS_ROOT, no transpiler cache) and what the loop adds (DS_LOOP_CHILD,
// the sender and retry id, no ORCA_*). Any other $BACKEND is still a program the loop spawns.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../../bin/backend/orca.ts";
import { backendOp, childEnv, inProcess, ORCA_SH, shell, type Out } from "../../bin/loop/io/orca.ts";
import { ROOT } from "../../bin/loop/core/store.ts";

const T = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "u227-"));
const KEYS = ["DS_GH", "DS_ORCA_CLI_BIN_DIR", "ORCA_TERMINAL_HANDLE", "FAKE_PS", "BACKEND"] as const;
const saved: Record<string, string | undefined> = {};

function script(name: string, body: string): string {
  const f = join(T, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

async function spawned(op: string, args: string[], env: Record<string, string>): Promise<Out> {
  const p = Bun.spawn([ORCA_SH, op, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  delete process.env.BACKEND;
  // pr-close needs no orca: it runs $DS_GH, so this one shows the environment a verb sees.
  process.env.DS_GH = script("gh", 'echo "args=$* root=$DS_ROOT child=$DS_LOOP_CHILD from=$DS_ORCA_FROM retry=$DS_ORCA_RETRY_REQUEST' +
    ' cache=$BUN_RUNTIME_TRANSPILER_CACHE_PATH tries=$DS_WORKER_START_RETRIES handle=${ORCA_TERMINAL_HANDLE:-none}"; echo "gh said no" >&2; exit 7');
  mkdirSync(join(T, "cli"));
  script("cli/orca", '[ "$FAKE_PS" = hang ] && exec sleep 30\n[ "$FAKE_PS" = bad ] && { echo "{not json"; exit 0; }\necho \'{"ok":true,"result":{"worktrees":[{"id":"wt-1","displayName":"ds-x","path":"/w/1"}],"terminals":[]}}\'');
  process.env.DS_ORCA_CLI_BIN_DIR = join(T, "cli");
  process.env.ORCA_TERMINAL_HANDLE = "term_agent";   // an agent's handle: never reaches the backend
});

afterAll(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  rmSync(T, { recursive: true, force: true });
});

describe("which backend runs in process", () => {
  test("this checkout's orca.sh, by any path to it; anything else is spawned", () => {
    expect(inProcess(ORCA_SH)).toBe(true);
    const link = join(T, "orca-link.sh");
    symlinkSync(ORCA_SH, link);
    expect(inProcess(link)).toBe(true);
    expect(inProcess(process.env.DS_GH!)).toBe(false);
    expect(inProcess(join(T, "missing.sh"))).toBe(false);
  });

  test("a swapped $BACKEND is a program: the loop spawns it", async () => {
    const be = script("other-backend.sh", 'echo "other $*"; echo "to stderr" >&2; exit 4');
    expect(await backendOp(be, "ps", ["x"], childEnv(), 30_000)).toEqual({ code: 4, out: "other ps x\n", err: "to stderr\n" });
    expect(await shell(be).run("poke", ["wt", "hi"])).toEqual({ code: 4, out: "other poke wt hi\n", err: "to stderr\n" });
  });
});

describe("in process answers what spawning orca.sh answered", () => {
  test("the actuator's call: same code, stdout, stderr and environment", async () => {
    const via = { from: "term_loop", retry: "retry-1", env: { DS_LOOP_ACTIVITY: "act-1" } };
    const got = await shell().run("pr-close", ["o/r", "12"], via);
    const want = await spawned("pr-close", ["o/r", "12"],
      childEnv({ ...via.env, DS_ORCA_FROM: via.from, DS_ORCA_RETRY_REQUEST: via.retry, DS_WORKER_START_RETRIES: "1" }));
    expect(got).toEqual(want);
    expect(got).toEqual({
      code: 7,
      out: `args=pr close 12 --repo o/r root=${ROOT} child=1 from=term_loop retry=retry-1 cache=0 tries=1 handle=none\n`,
      err: "gh said no\n",
    });
  }, 60_000);

  test("a verb through the orca CLI, a malformed answer and an unknown op", async () => {
    const env = childEnv();
    for (const ps of ["good", "bad"]) {
      const e = { ...env, FAKE_PS: ps };
      const got = await backendOp(ORCA_SH, "ps", [], e, 30_000);
      expect(got).toEqual(await spawned("ps", [], e));
      expect(got.code === 0).toBe(ps === "good");
    }
    const nope = await backendOp(ORCA_SH, "no-such-op", ["a"], env, 30_000);
    expect(nope).toEqual(await spawned("no-such-op", ["a"], env));
    expect(nope).toEqual({ code: 2, out: "", err: "orca adapter: unknown op 'no-such-op'\n" });
  }, 60_000);

  test("a stream of large pages scans in one pass: what the loop's thread reads, it reads fast", () => {
    const page = (n: number) => JSON.stringify({ ok: true, result: { workers: Array.from({ length: 400 }, (_, k) =>
      ({ dispatchId: `ctx_${n}_${k}`, worktreeId: `repo::/w/${k}`, note: "x".repeat(400) })), page: { hasMore: n < 4 } } });
    const text = [0, 1, 2, 3, 4].map(page).join("\n") + "\n";
    expect(text.length).toBeGreaterThan(800_000);
    const t = Date.now();
    const r = scan(text);
    expect(Date.now() - t).toBeLessThan(2_000);   // every length of the rest, tried per value, took minutes
    expect(r.bad).toBe(false);
    expect(r.vals.map((v) => v.result.workers.length)).toEqual([400, 400, 400, 400, 400]);
    // A page cut off mid-way never closes: that is the parse error, read in one pass too.
    const cut = text + page(5).slice(0, 150_000);
    const t2 = Date.now();
    const c = scan(cut);
    expect(Date.now() - t2).toBeLessThan(2_000);
    expect([c.vals.length, c.bad]).toEqual([5, true]);
  });

  test("scan reads what trying every length read: the values before the first parse error", () => {
    // The old reader: the longest prefix that parses, for each value in turn.
    const before = (text: string) => {
      const t = text.trim(), vals: unknown[] = [];
      if (t === "") return { vals, bad: false };
      try { return { vals: [JSON.parse(t)], bad: false }; } catch { /* a stream */ }
      for (let i = 0; i < t.length;) {
        while (i < t.length && /\s/.test(t[i])) i++;
        if (i >= t.length) break;
        let end = -1;
        for (let j = t.length; j > i; j--) { try { vals.push(JSON.parse(t.slice(i, j))); end = j; break; } catch { /* shorter */ } }
        if (end < 0) return { vals, bad: true };
        i = end;
      }
      return { vals, bad: false };
    };
    const parts = ['{"a":[1,{"b":"]}"}]}', '[1,"x\\"]",[]]', '"s\\\\"', '"q\\"}"', "12", "-1.5e3", "true", "null", "false",
      "{}", "[]", '{"k":"v"}', "}", "]", "{", "[", '"', "1{", "tru", "nul l", "12abc", "{]", '{"a":]}', "x", "1easy", "true1", "nulll", "1e+5", "-", "\t", " ", "\n"];
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const cases: string[] = [...parts];
    for (let k = 0; k < 3000; k++) {
      let s = "";
      for (let m = 1 + rnd(5); m > 0; m--) s += parts[rnd(parts.length)] + (rnd(3) ? " " : "");
      cases.push(rnd(4) ? s : s.slice(0, rnd(s.length + 1)));
    }
    for (const c of cases) expect([c, scan(c)]).toEqual([c, before(c)]);
  });

  test("a call stopped at its timeout kills its child and frees its name lock (the loop's pid never dies)", async () => {
    const state = join(T, "state"), lock = join(state, ".wt-locks", "ds-hang.lock");
    const call = backendOp(ORCA_SH, "wt-create", ["repo", "ds-hang"], { ...childEnv(), FAKE_PS: "hang", DS_STATE_ROOT: state }, 1_500);
    for (let k = 0; k < 40 && !existsSync(lock); k++) await Bun.sleep(25);
    expect(existsSync(lock)).toBe(true);           // held while the worktree list hangs
    const t = Date.now();
    expect((await call).code).toBe(143);
    for (let k = 0; k < 80 && existsSync(lock); k++) await Bun.sleep(25);
    expect(existsSync(lock)).toBe(false);          // the verb unwound: its finally released the lock
    expect(Date.now() - t).toBeLessThan(2_000);    // not after the 30 s the hung list would take
  });

  test("a call still running at the timeout answers 143, as the killed process did", async () => {
    const slow = script("slow-gh", "sleep 3");
    const t = Date.now();
    const got = await backendOp(ORCA_SH, "pr-close", ["o/r", "1"], { ...childEnv(), DS_GH: slow }, 200);
    expect(got.code).toBe(143);
    expect(got.err).toContain("pr-close timed out");
    expect(Date.now() - t).toBeLessThan(2_500);
  });
});
