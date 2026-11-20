// U248: run-keep.ts with missing, corrupt and fingerprint-less kept files. U264: a write drops only the Run it is about.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { harvest, mailFps, seedKept, terminalFps } from "../../bin/loop/io/run-keep.ts";
import { dropCached, runsOfWrite } from "../../bin/backend/orca-cache.ts";

const K = "a".repeat(40);
const mk = () => { const r = mkdtempSync(join(tmpdir(), "zzkeep-")); const tick = join(r, "tick"), keep = join(r, "keep"); mkdirSync(tick); mkdirSync(keep); return { r, tick, keep }; };
const runs = new Map([["run_1", ["wt_1"]]]);
const sig = { terminals: JSON.stringify({ result: { terminals: [{ handle: "t1", worktreeId: "wt_1", connected: true }] } }), unread: "" };
const put = (dir: string, at = 1000) => { writeFileSync(join(dir, K), "{}"); writeFileSync(join(dir, `${K}.meta`), `run_1\t${at}`); };

describe("run-keep", () => {
  test("a kept copy is seeded only while the signals match; a failed signals read reads every Run again", () => {
    const { r, tick, keep } = mk();
    put(tick); harvest(tick, keep);
    expect(seedKept({ tickDir: tick, keep, runs, signals: sig, nowMs: 2000, ttlS: 60 }).reread).toEqual([{ run: "run_1", why: "new" }]); // no earlier fingerprint
    put(tick); harvest(tick, keep);
    expect(seedKept({ tickDir: mkdtempSync(join(r, "t2")), keep, runs, signals: sig, nowMs: 2000, ttlS: 60 }).kept).toEqual(["run_1"]);
    const t3 = mkdtempSync(join(r, "t3"));
    expect(seedKept({ tickDir: t3, keep, runs, signals: null, nowMs: 2000, ttlS: 60 }).reread).toEqual([{ run: "run_1", why: "age" }]);
    expect(readdirSync(t3)).toEqual([]);
    rmSync(r, { recursive: true, force: true });
  });
  test("a copy with a corrupt or missing .meta is removed, not seeded", () => {
    const { r, tick, keep } = mk();
    writeFileSync(join(keep, K), "{}"); writeFileSync(join(keep, `${K}.meta`), "garbage");
    const o = seedKept({ tickDir: tick, keep, runs, signals: sig, nowMs: 2000, ttlS: 60 });
    expect(o.kept).toEqual([]); expect(existsSync(join(keep, K))).toBe(false);
    rmSync(r, { recursive: true, force: true });
  });
  test("a copy older than the ttl, or any copy with ttl 0, is read again", () => {
    const { r, tick, keep } = mk();
    for (const ttl of [60, 0]) {
      put(keep, 1000);
      seedKept({ tickDir: tick, keep, runs, signals: sig, nowMs: 1000, ttlS: ttl }); put(keep, 1000);
      expect(seedKept({ tickDir: tick, keep, runs, signals: sig, nowMs: ttl ? 62_000 : 1000, ttlS: ttl }).reread[0]?.why).toBe("age");
    }
    rmSync(r, { recursive: true, force: true });
  });
  test("fingerprints: terminals by worktree, mail by run; unparsable lists give no terminals", () => {
    expect(terminalFps(sig.terminals, runs).get("run_1")).toContain("t1");
    expect(terminalFps("not json", runs).get("run_1")).toBe("");
    expect(mailFps("lead\trun_1\t5\tm1\nlead\trun_2\t5\tm2\n", ["run_1", "run_3"])).toEqual(new Map([["run_1", "lead\trun_1\t5\tm1"], ["run_3", ""]]));
  });
});

// U264: three Runs kept (a worker-list page and a run-show each, plus the Run-less terminal list); a write drops only
// the Run whose reads name its subject. The first three cases dropped every Run before U264.
describe("U264: a write drops the Run it is about", () => {
  const RUNS = ["run_1", "run_2", "run_3"];
  const key = (run: string, kind: string) => createHash("sha1").update(`${run}/${kind}`).digest("hex");
  const TL = "b".repeat(40);
  function kept() {
    const { r, tick, keep } = mk();
    for (const d of [tick, keep]) {
      for (const run of RUNS) {
        const n = run.slice(4);
        writeFileSync(join(d, key(run, "wl")), JSON.stringify({ result: { workers: [{ dispatchId: `ctx_${n}`, taskId: `task_${n}`,
          resource: { worktreeId: `wt_${n}`, terminalHandle: `term_w${n}` } }] } }));
        writeFileSync(join(d, `${key(run, "wl")}.meta`), `${run}\t1000`);
        writeFileSync(join(d, key(run, "show")), JSON.stringify({ result: { run: { id: run, coordinator_handle: `term_lead${n}` } } }));
        writeFileSync(join(d, `${key(run, "show")}.meta`), `${run}\t1000`);
      }
      writeFileSync(join(d, TL), "{}");                              // terminal list: no Run
    }
    const left = (d: string) => RUNS.filter((run) => existsSync(join(d, key(run, "wl"))) && existsSync(join(d, key(run, "show"))));
    const write = (args: string[]) => { const runs = runsOfWrite(args, [tick, keep]); dropCached(tick, keep, runs ?? undefined); return runs; };
    return { r, tick, keep, left, write };
  }

  test("worker-stop and worker-release by dispatch, and a send to the worker, drop only the Run whose worker-list names it", () => {
    for (const args of [["orchestration", "worker-stop", "--dispatch", "ctx_2", "--json"], ["orchestration", "worker-release", "--dispatch", "ctx_2", "--json"],
      ["orchestration", "send", "--to", "dispatch:ctx_2", "--subject", "s", "--body", "b", "--json"], ["orchestration", "worker-stop", "--worker", "ctx_2"]]) {
      const k = kept();
      expect(k.write(args)).toEqual(["run_2"]);
      expect(k.left(k.tick)).toEqual(["run_1", "run_3"]);
      expect(k.left(k.keep)).toEqual(["run_1", "run_3"]);
      expect(existsSync(join(k.tick, TL))).toBe(false);              // the Run-less copies go with any write
      rmSync(k.r, { recursive: true, force: true });
    }
  });
  test("a consuming check from the Lead's handle drops only the Run whose run-show names it", () => {
    const k = kept();
    expect(k.write(["orchestration", "check", "--terminal", "term_lead3", "--json"])).toEqual(["run_3"]);
    expect(k.left(k.keep)).toEqual(["run_1", "run_2"]);
    rmSync(k.r, { recursive: true, force: true });
  });
  test("a stray terminal close keeps every Run's kept copies and drops only the Run-less ones", () => {
    const k = kept();
    expect(k.write(["terminal", "close", "--terminal", "term_stray", "--json"])).toEqual([]);
    expect(k.left(k.tick)).toEqual(RUNS);
    expect(k.left(k.keep)).toEqual(RUNS);
    expect(existsSync(join(k.tick, TL))).toBe(false);
    rmSync(k.r, { recursive: true, force: true });
  });
  test("a write that names no subject cannot be placed: every copy goes (and orca.ts counts `drop unplaced`)", () => {
    const k = kept();
    expect(k.write(["orchestration", "gate-resolve", "--id", "gate_1", "--json"])).toBeNull();
    expect(k.left(k.tick)).toEqual([]);
    expect(k.left(k.keep)).toEqual([]);
    rmSync(k.r, { recursive: true, force: true });
  });
  test("--run, run-use --id and --to run:<id> name the Run; worktree and task ids are found like handles", () => {
    const k = kept();
    expect(runsOfWrite(["orchestration", "task-create", "--run", "run_9", "--json"], [k.tick])).toEqual(["run_9"]);
    expect(runsOfWrite(["orchestration", "run-use", "--id", "run_9", "--json"], [k.tick])).toEqual(["run_9"]);
    expect(runsOfWrite(["orchestration", "ask", "--question", "q", "--to", "run:run_9"], [k.tick])).toEqual(["run_9"]);
    expect(runsOfWrite(["terminal", "close", "--worktree", "id:wt_1", "--all", "--json"], [k.tick])).toEqual(["run_1"]);
    expect(runsOfWrite(["orchestration", "gate-create", "--task", "task_3", "--json"], [k.tick])).toEqual(["run_3"]);
    expect(runsOfWrite(["orchestration", "send", "--to", "@worktree:wt_2", "--from", "term_lead1", "--json"], [k.tick]).sort()).toEqual(["run_1", "run_2"]);
    rmSync(k.r, { recursive: true, force: true });
  });
  test("after a worker write the next tick reads that Run from Orca and keeps the others", () => {
    const k = kept();
    const runs = new Map(RUNS.map((run) => [run, [`wt_${run.slice(4)}`]]));
    const sig = { terminals: JSON.stringify({ result: { terminals: [] } }), unread: "" };
    seedKept({ tickDir: mkdtempSync(join(k.r, "t0")), keep: k.keep, runs, signals: sig, nowMs: 2000, ttlS: 60 }); // first sight: fingerprints
    harvest(k.tick, k.keep);                                         // that tick's reads are kept again
    expect(k.left(k.keep)).toEqual(RUNS);
    k.write(["orchestration", "worker-stop", "--dispatch", "ctx_1", "--json"]);
    const o = seedKept({ tickDir: mkdtempSync(join(k.r, "t1")), keep: k.keep, runs, signals: sig, nowMs: 3000, ttlS: 60 });
    expect(o.reread).toEqual([{ run: "run_1", why: "new" }]);
    expect(o.kept).toEqual(["run_2", "run_3"]);
    rmSync(k.r, { recursive: true, force: true });
  });
});
