// backend-conformance.ts — the conformance suite every contract v2 backend must pass
// (orca-backend-alternatives U2; bin/backend/contract.ts, conventions/backend.md "Conformance").
// It is not a test file itself: an adapter's test registers it on its own backend.
//
//   conformance({ name: "tmux", make: () => tmuxBackend(sock), cwd: dir, survive: { … } });
//
// Every call goes through `checked()`, so an answer outside its op's type fails the case that made it.
// The backend reads its own capabilities (`backend.info`) and each case holds it to them: a `groups`
// backend lists the group, `state: none` answers `unknown`, `turn_confirm: none` never says
// `turn_started`, `keys: none` refuses keys as `unsupported`. Terminals are shells: the suite types
// `echo $NAME` and `pwd` and waits (`wait` ms, default 5000) to read the answer on the screen.
//
// `survive` (for a backend with a server): `caller` is a command that starts the server through
// bin/backend/server-unit.ts, creates one terminal (DS_GEN `survivor`) and prints
// `ready <server pid> <via> <terminal id>`; the suite SIGKILLs it, then checks the server pid is alive
// and the terminal is still listed and readable through `client()`, and calls `stop` last.
import { describe, expect, test } from "bun:test";
import { type Backend, type Capabilities, checked, handle } from "../../bin/backend/contract.ts";
import { serverAlive } from "../../bin/backend/server-unit.ts";

export type Survive = {
  caller: string[];
  client(): Backend | Promise<Backend>;
  stop(ready: { pid: number; via: string }): Promise<void>;
};
export type Subject = {
  name: string;
  make(): Backend | Promise<Backend>;
  cwd: string;              // a folder the terminals start in
  wait?: number;            // ms to wait for a screen to show typed output
  timeout?: number;         // per case, ms
  survive?: Survive;
};

let n = 0;
const marker = () => `cf${process.pid}x${++n}`;

async function eventually(ms: number, fn: () => Promise<boolean>): Promise<boolean> {
  for (let t = 0; ; t += 50) {
    if (await fn()) return true;
    if (t >= ms) return false;
    await Bun.sleep(50);
  }
}

// What a child printed up to its first newline, or by `ms` (one read in flight at a time, so no chunk
// is dropped). The stream is left open: the child is killed afterwards.
export async function firstLine(stream: ReadableStream<Uint8Array>, ms: number): Promise<string> {
  const reader = stream.getReader(), dec = new TextDecoder(), end = Date.now() + ms;
  let out = "", pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  while (!out.includes("\n")) {
    const left = end - Date.now();
    if (left <= 0) break;
    pending ??= reader.read();
    const r = await Promise.race([pending, Bun.sleep(left).then(() => null)]);
    if (!r) break;
    pending = null;
    if (r.value) out += dec.decode(r.value, { stream: true });
    if (r.done) break;
  }
  reader.releaseLock();
  return out;
}

export function conformance(s: Subject): void {
  const wait = s.wait ?? 5000, timeout = s.timeout ?? 20_000;

  // A checked backend, its capabilities, and a create that closes what it made after the case.
  async function rig() {
    const b = checked(await s.make());
    const info = await b.call("backend.info", {});
    if (!info.ok) throw new Error(`backend.info failed: ${info.error.message}`);
    const made: string[] = [];
    const create = async (req: { env?: Record<string, string>; label?: string; group?: string; parent?: string } = {}) => {
      const a = await b.call("terminal.create", { cwd: s.cwd, label: req.label ?? "conformance", ...req });
      if (!a.ok) throw new Error(`terminal.create failed: ${a.error.message}`);
      made.push(a.terminal.id);
      return a.terminal;
    };
    const done = async () => { for (const id of made) await b.call("terminal.close", { id }); };
    const screenHas = (id: string, text: string) => eventually(wait, async () => {
      const r = await b.call("terminal.read", { id });
      return r.ok && r.text.includes(text);
    });
    return { b, caps: info.capabilities as Capabilities, create, done, screenHas };
  }
  const it = (name: string, fn: (r: Awaited<ReturnType<typeof rig>>) => Promise<void>) =>
    test(name, async () => { const r = await rig(); try { await fn(r); } finally { await r.done(); } }, timeout);

  describe(`backend conformance: ${s.name}`, () => {
    it("backend.info names the backend and its capabilities", async ({ b }) => {
      const a = await b.call("backend.info", {});
      expect(a.ok).toBe(true);
    });

    it("terminal.create answers the terminal it made, and terminal.list lists it", async ({ b, caps, create }) => {
      const t = await create({ env: { DS_GEN: "g-create" }, label: "lead", group: "sq-create", parent: s.cwd });
      expect(t.cwd).toBe(s.cwd);
      expect(t.label).toBe("lead");
      expect(t.gen).toBe("g-create");
      expect(t.group).toBe(caps.parents === "groups" ? "sq-create" : null);
      expect(t.parent).toBe(caps.parents === "native" ? s.cwd : null);
      const l = await b.call("terminal.list", {});
      expect(l.ok && l.terminals.find((x) => x.id === t.id)).toMatchObject({ id: t.id, gen: "g-create", cwd: s.cwd, label: "lead" });
    });

    it("a terminal made without DS_GEN lists gen null; two creates make two terminals", async ({ b, create }) => {
      const t1 = await create(), t2 = await create();
      expect(t1.gen).toBeNull();
      expect(t1.id).not.toBe(t2.id);
      const l = await b.call("terminal.list", {});
      expect(l.ok && l.terminals.filter((x) => x.id === t1.id || x.id === t2.id).length).toBe(2);
    });

    it("terminal.close closes once, a second close answers closed:false, and the id is gone", async ({ b, create }) => {
      const t = await create();
      expect(await b.call("terminal.close", { id: t.id })).toEqual({ ok: true, closed: true });
      expect(await b.call("terminal.close", { id: t.id })).toEqual({ ok: true, closed: false });
      const l = await b.call("terminal.list", {});
      expect(l.ok && l.terminals.some((x) => x.id === t.id)).toBe(false);
      for (const op of ["terminal.read", "terminal.last_output", "agent.state"] as const) {
        const a = await b.call(op, { id: t.id });
        expect(a.ok ? "ok" : a.error.code).toBe("not_found");
      }
      const sent = await b.call("terminal.send", { id: t.id, text: "x" });
      expect(sent.ok ? "ok" : sent.error.code).toBe("not_found");
    });

    it("typed text shows on the screen, and terminal.last_output has a time after it", async ({ b, create, screenHas }) => {
      const t = await create(), m = marker();
      const a = await b.call("terminal.send", { id: t.id, text: m });
      expect(a).toEqual({ ok: true, delivery: "accepted" });
      expect(await screenHas(t.id, m)).toBe(true);
      const at = await b.call("terminal.last_output", { id: t.id });
      expect(at.ok && typeof at.at).toBe("number");
    });

    it("a submitted line runs in the terminal's env and cwd; turn_started only with turn_confirm native", async ({ b, caps, create, screenHas }) => {
      const m = marker();
      const t = await create({ env: { DS_GEN: "g-env", DS_CONFORMANCE: m } });
      const a = await b.call("terminal.send", { id: t.id, text: "echo $DS_CONFORMANCE", submit: true });
      expect(a.ok).toBe(true);
      if (a.ok && caps.turn_confirm === "none") expect(a.delivery).toBe("accepted");
      expect(await screenHas(t.id, m)).toBe(true);
      await b.call("terminal.send", { id: t.id, text: "pwd", submit: true });
      expect(await screenHas(t.id, s.cwd)).toBe(true);
    });

    it("terminal.read with screen gives at most the visible screen", async ({ b, create, screenHas }) => {
      const t = await create(), m = marker();
      await b.call("terminal.send", { id: t.id, text: `echo ${m}`, submit: true });
      expect(await screenHas(t.id, m)).toBe(true);
      const r = await b.call("terminal.read", { id: t.id, screen: true });
      expect(r.ok && r.text.includes(m)).toBe(true);
      const one = await b.call("terminal.read", { id: t.id, lines: 1 });
      expect(one.ok && one.text.split("\n").length).toBeLessThanOrEqual(1);
    });

    it("named keys type with keys native and are refused as unsupported without", async ({ b, caps, create, screenHas }) => {
      const m = marker(), up = marker();
      const t = await create({ env: { DS_CONFORMANCE: up } });
      // Wait for the shell itself: a real shell that starts after the keys can drop the input typed before it.
      await b.call("terminal.send", { id: t.id, text: "echo $DS_CONFORMANCE", submit: true });
      expect(await screenHas(t.id, up)).toBe(true);
      await b.call("terminal.send", { id: t.id, text: `${m}k` });
      expect(await screenHas(t.id, `${m}k`)).toBe(true);
      const a = await b.call("terminal.send", { id: t.id, keys: ["Backspace", "z"] });
      if (caps.keys === "native") {
        expect(a).toEqual({ ok: true, delivery: "accepted" });
        expect(await screenHas(t.id, `${m}z`)).toBe(true);
      } else expect(a.ok ? "ok" : a.error.code).toBe("unsupported");
    });

    it("agent.state answers unknown with state none, one of the four states with state native", async ({ b, caps, create }) => {
      const t = await create();
      const a = await b.call("agent.state", { id: t.id });
      expect(a.ok).toBe(true);
      if (a.ok && caps.state === "none") expect(a.state).toBe("unknown");
    });

    it("an op on an id that never existed is not_found; its close is closed:false", async ({ b }) => {
      const id = `never-${marker()}`;
      for (const op of ["terminal.read", "terminal.last_output", "agent.state"] as const) {
        const a = await b.call(op, { id });
        expect(a.ok ? "ok" : a.error.code).toBe("not_found");
      }
      expect(await b.call("terminal.close", { id })).toEqual({ ok: true, closed: false });
    });

    it("the wire entry answers a request outside its type bad_request", async ({ b }) => {
      const bad: [unknown, string][] = [
        [{ op: "terminal.nope", req: {} }, "unknown op"],
        [{ op: "terminal.create", req: { label: "x" } }, "req.cwd is required"],
        [{ op: "terminal.send", req: { id: "x" } }, "exactly one of text and keys"],
        [{ op: "terminal.send", req: { id: "x", text: "a", keys: ["Enter"] } }, "exactly one of text and keys"],
        [{ op: "terminal.send", req: { id: "x", keys: ["F13"] } }, "req.keys[0]"],
        [{ op: "terminal.create", req: { cwd: "/", label: "x", env: { "A-B": "1" } } }, "bad name"],
      ];
      for (const [env, why] of bad) {
        const a = await handle(b, env);
        expect(a.ok ? "ok" : `${a.error.code}: ${a.error.message}`).toContain(`bad_request: `);
        expect(a.ok ? "" : a.error.message).toContain(why);
      }
      const ok = await handle(b, { op: "terminal.list", req: {} });
      expect(ok.ok).toBe(true);
    });

    if (s.survive) {
      const sv = s.survive;
      test("a server started through server-unit outlives its caller, with its terminals", async () => {
        const p = Bun.spawn(sv.caller, { stdout: "pipe", stderr: "pipe" });
        const out = await firstLine(p.stdout, 20_000);
        const m = /^ready (\d+) (\S+) (\S+)$/m.exec(out);
        if (!m) { p.kill("SIGKILL"); throw new Error(`caller never got ready: ${out} ${await new Response(p.stderr).text()}`); }
        const ready = { pid: Number(m[1]), via: m[2]!, id: m[3]! };
        try {
          p.kill("SIGKILL");
          await p.exited;
          await Bun.sleep(300);
          expect(serverAlive(ready.pid)).toBe(true);
          const c = checked(await sv.client());
          const l = await c.call("terminal.list", {});
          expect(l.ok && l.terminals.find((x) => x.id === ready.id)).toMatchObject({ id: ready.id, gen: "survivor" });
          const r = await c.call("terminal.read", { id: ready.id });
          expect(r.ok).toBe(true);
        } finally {
          await sv.stop(ready);
        }
        expect(serverAlive(ready.pid)).toBe(false);
      }, 40_000);
    }
  });
}
