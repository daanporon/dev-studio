// backend-contract.test.ts — the contract v2 (orca-backend-alternatives U2): the conformance suite
// against the in-memory fake in every capability mix, once over a unix socket (the wire), once with a
// server that must outlive the process that started it; and the checker itself — an answer outside its
// op's type fails, a request outside its type never reaches the backend.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Backend, ContractError, OP_NAMES, capabilityMixes, checkAnswer, checkRequest, checked, handle,
} from "../../bin/backend/contract.ts";
import { stopServer, unitName } from "../../bin/backend/server-unit.ts";
import { fakeContract, serveFake, socketBackend } from "../../bin/loop/fakes/contract.ts";
import { conformance } from "./backend-conformance.ts";

const dir = mkdtempSync(join(tmpdir(), "ds-bc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const FAKE = join(import.meta.dir, "..", "..", "bin", "loop", "fakes", "contract.ts");

for (const caps of capabilityMixes()) {
  const label = `parents ${caps.parents}, state ${caps.state}, turn_confirm ${caps.turn_confirm}, keys ${caps.keys}`;
  conformance({ name: `fake (${label})`, make: () => fakeContract(caps), cwd: dir, wait: 200 });
}

// The same fake behind a socket: every request and answer crosses as JSON.
const wireSock = join(dir, "wire.sock");
const wire = serveFake(wireSock, fakeContract({ parents: "none", state: "none", turn_confirm: "none", keys: "none" }));
afterAll(() => wire.stop());
conformance({ name: "fake over a unix socket", make: () => socketBackend(wireSock), cwd: dir, wait: 500 });

// A served fake started through server-unit by a caller the suite kills.
const sSock = join(dir, "survive.sock"), sName = `test-contract-${process.pid}-${Date.now()}`, sLog = join(dir, "survive.log");
conformance({
  name: "fake server outliving its caller",
  make: () => fakeContract(),
  cwd: dir,
  wait: 200,
  survive: {
    caller: [process.execPath, FAKE, "caller", sSock, sName, sLog, JSON.stringify({ parents: "groups" })],
    client: () => socketBackend(sSock),
    stop: (r) => stopServer({ pid: r.pid, via: r.via as "systemd" | "detached", unit: r.via === "systemd" ? unitName(sName) : null, log: sLog }),
  },
});

describe("the contract's own checks", () => {
  test("an answer outside its op's type throws through checked()", async () => {
    for (const op of OP_NAMES) {
      const f = fakeContract();
      const t = await f.call("terminal.create", { cwd: dir, label: "x" });
      f.lie = op;
      const req = op === "backend.info" || op === "terminal.list" ? {} : op === "terminal.create" ? { cwd: dir, label: "y" }
        : op === "terminal.send" ? { id: t.ok ? t.terminal.id : "", text: "a" } : { id: t.ok ? t.terminal.id : "" };
      await expect(checked(f).call(op, req as never)).rejects.toThrow(ContractError);
    }
  });

  test("checkAnswer names the wrong field", () => {
    expect(checkAnswer("agent.state", { ok: true, state: "busy" })).toContain("answer.state must be one of working|waiting|idle|unknown");
    expect(checkAnswer("terminal.send", { ok: true, delivery: "sent" })).toContain("answer.delivery");
    expect(checkAnswer("terminal.list", { ok: true, terminals: [{ id: "a" }] })).toContain("answer.terminals[0].cwd is required");
    expect(checkAnswer("terminal.last_output", { ok: true, at: "now" })).toContain("answer.at");
    expect(checkAnswer("terminal.read", { ok: false, error: { code: "oops", message: "" } })).toContain("answer.error.code");
    expect(checkAnswer("terminal.read", { text: "" })).toContain("answer.ok");
    expect(checkAnswer("terminal.last_output", { ok: true, at: null })).toBeNull();
    expect(checkAnswer("terminal.close", { ok: false, error: { code: "failed", message: "no server" } })).toBeNull();
  });

  test("checkRequest refuses a send with both, neither, empty keys or submit with keys", () => {
    expect(checkRequest("terminal.send", { id: "a", text: "x" })).toBeNull();
    expect(checkRequest("terminal.send", { id: "a", keys: ["Escape", "3"] })).toBeNull();
    expect(checkRequest("terminal.send", { id: "a", keys: [] })).toContain("must not be empty");
    expect(checkRequest("terminal.send", { id: "a", keys: ["Enter"], submit: true })).toContain("submit goes with text");
    expect(checkRequest("terminal.create", { cwd: "", label: "x" })).toContain("req.cwd must not be empty");
  });

  test("a request outside its type never reaches the backend; a backend that throws answers failed", async () => {
    const f = fakeContract();
    await expect(checked(f).call("terminal.create", { label: "x" } as never)).rejects.toThrow("req.cwd is required");
    const a = await handle(f, { op: "terminal.read", req: { id: 3 } });
    expect(a.ok ? "" : a.error.code).toBe("bad_request");
    expect(f.calls).toHaveLength(0);
    const broken: Backend = { call: async () => { throw new Error("socket closed"); } };
    expect(await handle(broken, { op: "terminal.list", req: {} })).toEqual({ ok: false, error: { code: "failed", message: "socket closed" } });
  });

  test("the fake reads its capabilities on every call", async () => {
    const f = fakeContract({ keys: "native" });
    const t = await f.call("terminal.create", { cwd: dir, label: "x" });
    const id = t.ok ? t.terminal.id : "";
    expect((await f.call("terminal.send", { id, keys: ["a"] })).ok).toBe(true);
    f.caps.keys = "none";
    const a = await f.call("terminal.send", { id, keys: ["a"] });
    expect(a.ok ? "" : a.error.code).toBe("unsupported");
    f.setState(id, "waiting");
    expect(await f.call("agent.state", { id })).toEqual({ ok: true, state: "waiting" });
    f.exit(id);
    const gone = await f.call("agent.state", { id });
    expect(gone.ok ? "" : gone.error.code).toBe("not_found");
  });
});
