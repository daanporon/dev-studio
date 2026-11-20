// orca-client.cjs — U254 spike, off by default (DS_ORCA_CLIENT=1 in the loop's environment turns it on).
// Runs under Orca's own node (the runtime its `orca` launcher execs). It loads Orca's own CLI bundle once
// (argv[2], the launcher's `out/cli/index.js`, which exports `main(argv, cwd)` when required) and runs one
// read command at a time on request, so a read costs a call into warm code instead of a node start plus a
// 2.8 MB parse. Orca is not changed: this is the code the `orca` command runs, only kept loaded.
//
// Protocol, one JSON object per line. stdin: {"id":n,"args":[...],"cwd":"..."}. stdout: first
// {"ready":true}, then {"id":n,"code":c,"chunks":[[1|2,"text"],...]} per request (fd 1 = the command's
// stdout, 2 = its stderr, in the order written). stdout carries only the protocol: anything the bundle writes
// outside a call goes to stderr. Calls run one at a time because process.exitCode is a process-wide value
// node does not let a script redefine; the Bun side (orca-client.ts) keeps a small pool for parallel reads.
// Stdin closing (the loop exiting) ends the process.
"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const readline = require("node:readline");

const als = new AsyncLocalStorage();
const rawOut = process.stdout.write.bind(process.stdout);
const rawErr = process.stderr.write.bind(process.stderr);
const text = (chunk, enc) => typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof enc === "string" ? enc : "utf8");
function tap(fd) {
  return function write(chunk, enc, cb) {
    const call = als.getStore();
    if (!call) return rawErr(chunk, enc, cb);
    call.chunks.push([fd, text(chunk, enc)]);
    const done = typeof enc === "function" ? enc : cb;
    if (typeof done === "function") process.nextTick(done);
    return true;
  };
}

let cli;
try { cli = require(process.argv[2]); } catch (e) {
  rawErr(`orca-client: cannot load ${process.argv[2]}: ${e && e.message || e}\n`);
  process.exit(3);
}
if (!cli || typeof cli.main !== "function") { rawErr(`orca-client: ${process.argv[2]} exports no main\n`); process.exit(3); }

process.stdout.write = tap(1);
process.stderr.write = tap(2);
// A command that exits on its own would take the helper down mid-call: end only that call instead.
class Exit extends Error {}
const realExit = process.exit.bind(process);
process.exit = (code) => {
  const call = als.getStore();
  if (!call) return realExit(code);
  call.exited = code ?? process.exitCode ?? 0;
  throw new Exit("exit");
};
process.on("unhandledRejection", (e) => { if (!(e instanceof Exit)) rawErr(`orca-client: unhandled ${e && e.stack || e}\n`); });

const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const req = queue.shift();
    const call = { chunks: [], exited: undefined };
    process.exitCode = undefined;
    try {
      await als.run(call, () => cli.main(req.args, req.cwd || process.cwd()));
    } catch (e) {
      if (!(e instanceof Exit)) { call.chunks.push([2, `orca-client: ${e && e.message || e}\n`]); if (call.exited === undefined) call.exited = 1; }
    }
    const code = call.exited !== undefined ? call.exited : (process.exitCode ?? 0);
    process.exitCode = undefined;
    rawOut(JSON.stringify({ id: req.id, code: Number(code) || 0, chunks: call.chunks }) + "\n");
  }
  busy = false;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || !Array.isArray(req.args)) return;
  queue.push(req);
  pump();
});
rl.on("close", () => realExit(0));
rawOut(JSON.stringify({ ready: true }) + "\n");
