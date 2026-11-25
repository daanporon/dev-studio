// orca-lite.ts — the orca-lite backend for contract v2 (orca-backend-alternatives U13; conventions/backend.md,
// "The orca-lite backend"): Orca's terminals with no Run, no task, no dispatch and no coordinator, in worktrees
// the `orca` worktree provider makes (bin/loop/io/providers/orca.ts, its only provider). Every Orca call is an
// adapter verb (bin/backend/orca.ts) through the loop's Orca runner (bin/loop/io/orca.ts), so the tick's shared
// reads, the in-process verbs and a test's fake (bin/loop/fakes/orca.ts) all apply:
//
//   terminal.create   `wt-show path:<cwd>` gives the worktree's Orca id (a folder Orca does not know is
//                     `failed`); a `parent` other than the cwd is applied with `wt-set-parent` when `wt-show`
//                     reads another one; then `terminal-create <id> <label> <command>`, where the command
//                     exports the request's env into the new shell (`export K='v' …`), so a launch line typed
//                     later runs with it
//   terminal.list     `terminal-panes`: Orca's live tabs, of which only the ones this backend made are listed
//   terminal.close    `terminal-close <handle>`; an id this backend never made, or one already gone, is closed:false
//   terminal.send     `terminal-type <handle> <text> [enter]`: the text as is (keys as their bytes), and with
//                     submit Orca's receipt says whether the agent started a turn (`turn_started`)
//   terminal.read     `terminal-read <handle> screen|stream [lines]`
//   terminal.last_output   the tab's `lastOutputAt` from `terminal-panes`
//   agent.state       `pane-state <worktree id> <pane key>`: `worktree ps` reports the agent of a plain tab in an
//                     Orca-made worktree (docs/backends/orca-probe.md Q5)
//
// Capabilities: parents native, state native, turn_confirm native, keys native.
//
// Orca keeps no env and no facts of ours on a tab, and Claude rewrites a tab's title, so what the contract
// echoes (cwd, label, group, parent, gen, created_at) is kept by this backend in one JSON file (`keep`,
// default `<state root>/loop/orca-lite-terminals.json`), one entry per terminal it made. A terminal's id is
// the handle Orca gave at create. A restarted Orca hands out new handles for the same tabs: the entry keeps
// the tab's pane key (tabId:leafId) and follows it to the new handle. An entry whose tab Orca no longer lists
// is dropped on the next list.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type AgentState, type Answer, type Backend, type Capabilities, type Op, type Request, type Terminal, fail, keyBytes, okAnswer } from "./contract.ts";
import { shell, type Orca, type Out } from "../loop/io/orca.ts";

export const ORCA_LITE_CAPS: Capabilities = { parents: "native", state: "native", turn_confirm: "native", keys: "native" };
export const ORCA_LITE_VERSION = "1";

export type OrcaLiteOptions = {
  orca?: Orca;                 // the Orca runner (default: the adapter, bin/backend/orca.sh, in process)
  keep?: string;               // the facts file
  readOnly?: boolean;          // never write the facts file (role scripts: only the loop writes it; create and close refuse)
  now?: () => number;          // epoch seconds
};

/** One terminal this backend made. `handle` is the one Orca answers to now (it changes when Orca restarts). */
export type Kept = Terminal & { handle: string; pane: string; wt: string };
type Row = { handle: string; wt: string; pane: string; out: number | null };

/** The bytes a named key types into a terminal (`keys native`), shared with the Orca adapter's keys. */
export { KEY_BYTES, keyBytes } from "./contract.ts";

/** Orca's agent state of a tab as the contract's: working, waiting (blocked on the operator), idle (done), else unknown. */
export function stateOf(s: string): AgentState {
  if (s === "working") return "working";
  if (s === "waiting" || s === "blocked" || s === "permission") return "waiting";
  if (s === "done" || s === "idle") return "idle";
  return "unknown";
}

/** The line typed into a new tab that gives its shell the request's env: `export K='v' …` (single quotes, a
 *  quote inside closed and escaped). Empty with no env. A value holding a control character could break
 *  the line into two commands, so it is refused (null). */
export function envCommand(env: Record<string, string> | undefined): string | null {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(v)) return null;
    parts.push(`${k}='${v.replace(/'/g, `'\\''`)}'`);
  }
  return parts.length ? `export ${parts.join(" ")}` : "";
}

const lastLine = (o: Out): string => (o.err || o.out).trim().split("\n").pop() || `exit ${o.code}`;
const defaultKeep = (): string => join(process.env.DS_STATE_ROOT || join(import.meta.dir, "..", "..", "state"), "loop", "orca-lite-terminals.json");

export function orcaLite(o: OrcaLiteOptions = {}): Backend {
  const keep = o.keep ?? defaultKeep(), now = o.now ?? (() => Math.floor(Date.now() / 1000)), ro = o.readOnly === true;
  let runner = o.orca ?? null;
  const run = (op: string, args: string[]): Promise<Out> => (runner ??= shell()).run(op, args);

  // The facts file: read whole, written whole through a rename. Writes in this process go one at a time.
  const read = (): Kept[] => {
    try {
      const d = JSON.parse(readFileSync(keep, "utf8")) as { terminals?: unknown };
      return Array.isArray(d.terminals) ? (d.terminals as Kept[]) : [];
    } catch { return []; }
  };
  let chain: Promise<unknown> = Promise.resolve();
  const edit = <T>(fn: (ks: Kept[]) => T): Promise<T> => {
    const p = chain.then(() => {
      const ks = read(), r = fn(ks);
      mkdirSync(dirname(keep), { recursive: true });
      const tmp = `${keep}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ v: 1, terminals: ks }, null, 1)}\n`);
      renameSync(tmp, keep);
      return r;
    });
    chain = p.catch(() => {});
    return p;
  };

  async function show(sel: string): Promise<{ id: string; path?: string; parentWorktreeId: string | null } | null> {
    const r = await run("wt-show", [sel]);
    if (r.code === 3) return null;
    if (r.code !== 0) throw new Error(`orca-lite: worktree show ${sel} failed: ${lastLine(r)}`);
    const line = r.out.split("\n").find((l) => l.trim());
    return line ? (JSON.parse(line) as { id: string; path?: string; parentWorktreeId: string | null }) : null;
  }

  async function panes(): Promise<Row[]> {
    const r = await run("terminal-panes", []);
    if (r.code !== 0) throw new Error(`orca-lite: the terminal list could not be read: ${lastLine(r)}`);
    return r.out.split("\n").filter(Boolean).map((l) => {
      const [handle = "", wt = "", pane = "", out = "-"] = l.split("\t");
      return { handle, wt, pane, out: /^\d+$/.test(out) ? Number(out) : null };
    });
  }

  // The live tab of a kept terminal: by its handle, else by its pane (Orca restarted), the handle then updated.
  const rowOf = (k: Kept, rows: Row[]): Row | undefined =>
    rows.find((r) => r.handle === k.handle) ?? (k.pane ? rows.find((r) => r.pane === k.pane) : undefined);
  async function resolveId(id: string): Promise<{ k: Kept; row: Row } | null> {
    const k = read().find((x) => x.id === id);
    if (!k) return null;
    const row = rowOf(k, await panes());
    if (!row) return null;
    if (!ro && (row.handle !== k.handle || (!k.pane && row.pane))) {
      await edit((ks) => { const e = ks.find((x) => x.id === id); if (e) { e.handle = row.handle; e.pane = row.pane || e.pane; } });
    }
    return { k: { ...k, handle: row.handle, pane: row.pane || k.pane }, row };
  }
  const terminalOf = (k: Kept): Terminal =>
    ({ id: k.id, cwd: k.cwd, label: k.label, group: null, parent: k.parent, gen: k.gen, created_at: k.created_at });

  const readOnly = () => fail("failed", "orca-lite: this backend is read-only here (only the loop writes the facts file)");

  async function create(req: Request<"terminal.create">): Promise<Answer<"terminal.create">> {
    if (ro) return readOnly();
    const cmd = envCommand(req.env);
    if (cmd === null) return fail("bad_request", "orca-lite: an env value holds a control character");
    const cwd = resolve(req.cwd);
    const w = await show(`path:${cwd}`);
    if (!w) return fail("failed", `orca-lite: Orca has no worktree at ${req.cwd} (the orca worktree provider makes them)`);
    const parent = req.parent ?? null;
    if (parent !== null && resolve(parent) !== cwd) {
      const p = await show(`path:${resolve(parent)}`);
      // A parent Orca does not know (a Studio's folder that is gone) is not a reason to leave the role unstarted:
      // it starts top-level and the nesting reconciler (U21f) moves it once the parent is seen.
      if (p && w.parentWorktreeId !== p.id) {
        const s = await run("wt-set-parent", [w.id, p.id]);
        if (s.code !== 0) return fail("failed", `orca-lite: nesting ${req.cwd} under ${parent} failed: ${lastLine(s)}`);
      }
    }
    const c = await run("terminal-create", [w.id, req.label || "orca-lite", cmd]);
    const [handle = "", pane = ""] = (c.out.split("\n").find((l) => l.trim()) ?? "").split("\t");
    if (c.code !== 0 || !handle) return fail("failed", `orca-lite: terminal create in ${req.cwd} failed: ${lastLine(c)}`);
    const k: Kept = { id: handle, cwd: req.cwd, label: req.label, group: null, parent, gen: req.env?.DS_GEN ?? null, created_at: now(), handle, pane, wt: w.id };
    await edit((ks) => { ks.push(k); });
    return okAnswer("terminal.create", { terminal: terminalOf(k) });
  }

  // The tree, by folder: Orca keeps it (`parentWorktreeId`), so both ways resolve a folder or an id through `wt-show`.
  async function parentOf(req: Request<"worktree.parent">): Promise<Answer<"worktree.parent">> {
    const w = await show(`path:${resolve(req.cwd)}`);
    if (!w) return fail("not_found", `orca-lite: Orca has no worktree at ${req.cwd}`);
    if (!w.parentWorktreeId) return okAnswer("worktree.parent", { parent: null });
    const p = await show(`id:${w.parentWorktreeId}`);
    return okAnswer("worktree.parent", { parent: p?.path ?? null });
  }
  async function setParent(req: Request<"worktree.set_parent">): Promise<Answer<"worktree.set_parent">> {
    if (ro) return readOnly();
    const w = await show(`path:${resolve(req.cwd)}`);
    if (!w) return fail("not_found", `orca-lite: Orca has no worktree at ${req.cwd}`);
    const p = await show(`path:${resolve(req.parent)}`);
    if (!p) return fail("not_found", `orca-lite: Orca has no worktree at the parent ${req.parent}`);
    if (w.parentWorktreeId !== p.id) {
      const s = await run("wt-set-parent", [w.id, p.id]);
      if (s.code !== 0) return fail("failed", `orca-lite: nesting ${req.cwd} under ${req.parent} failed: ${lastLine(s)}`);
    }
    return okAnswer("worktree.set_parent", {});
  }

  async function list(): Promise<Answer<"terminal.list">> {
    // An entry made at or after the panes read may be a tab the read missed: never dropped by this list.
    const asOf = now(), rows = await panes(), kept = read(), live: Kept[] = [];
    for (const k of kept) {
      const row = rowOf(k, rows);
      if (row) live.push({ ...k, handle: row.handle, pane: row.pane || k.pane });
    }
    const changed = live.length !== kept.length || live.some((k, i) => k.handle !== kept[i]?.handle || k.pane !== kept[i]?.pane);
    if (changed && !ro) {
      // Only what this list saw: an entry another call added meanwhile is kept.
      const gone = new Set(kept.filter((k) => k.created_at < asOf && !live.some((x) => x.id === k.id)).map((k) => k.id));
      await edit((ks) => {
        for (let i = ks.length - 1; i >= 0; i--) {
          const e = ks[i]!, l = live.find((x) => x.id === e.id);
          if (gone.has(e.id)) ks.splice(i, 1);
          else if (l) { e.handle = l.handle; e.pane = l.pane; }
        }
      });
    }
    return okAnswer("terminal.list", { terminals: live.map(terminalOf) });
  }

  async function close(id: string): Promise<Answer<"terminal.close">> {
    if (ro) return readOnly();
    if (!read().some((x) => x.id === id)) return okAnswer("terminal.close", { closed: false });
    const got = await resolveId(id);
    if (got) {
      const r = await run("terminal-close", [got.k.handle]);
      if (r.code !== 0) return fail("failed", `orca-lite: closing ${id} failed: ${lastLine(r)}`);
    }
    await edit((ks) => { const i = ks.findIndex((x) => x.id === id); if (i >= 0) ks.splice(i, 1); });
    return okAnswer("terminal.close", { closed: !!got });
  }

  async function send(req: Request<"terminal.send">): Promise<Answer<"terminal.send">> {
    const got = await resolveId(req.id);
    if (!got) return fail("not_found", `orca-lite: no terminal ${req.id}`);
    const text = req.keys ? req.keys.map(keyBytes).join("") : req.text ?? "";
    const r = await run("terminal-type", [got.k.handle, text, ...(req.keys || !req.submit ? [] : ["enter"])]);
    if (r.code !== 0) return fail("failed", `orca-lite: send to ${req.id} failed: ${lastLine(r)}`);
    return okAnswer("terminal.send", { delivery: r.out.trim() === "turn_started" ? "turn_started" : "accepted" });
  }

  async function readOp(req: Request<"terminal.read">): Promise<Answer<"terminal.read">> {
    const got = await resolveId(req.id);
    if (!got) return fail("not_found", `orca-lite: no terminal ${req.id}`);
    const n = req.lines === undefined ? null : Math.max(0, Math.floor(req.lines));
    if (n === 0) return okAnswer("terminal.read", { text: "" });
    const r = await run("terminal-read", [got.k.handle, req.screen ? "screen" : "stream", n === null ? "" : String(n)]);
    if (r.code === 3) return fail("not_found", `orca-lite: no terminal ${req.id}`);
    if (r.code !== 0) return fail("failed", `orca-lite: reading ${req.id} failed: ${lastLine(r)}`);
    let lines = r.out.replace(/\n$/, "").split("\n");
    if (n !== null) lines = lines.slice(-n);
    return okAnswer("terminal.read", { text: lines.join("\n") });
  }

  async function state(id: string): Promise<Answer<"agent.state">> {
    const got = await resolveId(id);
    if (!got) return fail("not_found", `orca-lite: no terminal ${id}`);
    if (!got.k.pane) return okAnswer("agent.state", { state: "unknown" });
    const r = await run("pane-state", [got.k.wt, got.k.pane]);
    if (r.code !== 0) return fail("failed", `orca-lite: reading the state of ${id} failed: ${lastLine(r)}`);
    return okAnswer("agent.state", { state: stateOf(r.out.trim()) });
  }

  return {
    async call<O extends Op>(op: O, req: Request<O>): Promise<Answer<O>> {
      try {
        switch (op) {
          case "backend.info": return okAnswer("backend.info", { name: "orca-lite", version: ORCA_LITE_VERSION, capabilities: { ...ORCA_LITE_CAPS } }) as Answer<O>;
          case "terminal.create": return await create(req as Request<"terminal.create">) as Answer<O>;
          case "worktree.parent": return await parentOf(req as Request<"worktree.parent">) as Answer<O>;
          case "worktree.set_parent": return await setParent(req as Request<"worktree.set_parent">) as Answer<O>;
          case "terminal.list": return await list() as Answer<O>;
          case "terminal.close": return await close((req as Request<"terminal.close">).id) as Answer<O>;
          case "terminal.send": return await send(req as Request<"terminal.send">) as Answer<O>;
          case "terminal.read": return await readOp(req as Request<"terminal.read">) as Answer<O>;
          case "terminal.last_output": {
            const got = await resolveId((req as Request<"terminal.last_output">).id);
            if (!got) return fail("not_found", `orca-lite: no terminal ${(req as Request<"terminal.last_output">).id}`);
            return okAnswer("terminal.last_output", { at: got.row.out }) as Answer<O>;
          }
          case "agent.state": return await state((req as Request<"agent.state">).id) as Answer<O>;
          default: return fail("bad_request", `unknown op ${JSON.stringify(op)}`);
        }
      } catch (e) {
        return fail("failed", (e as Error)?.message ?? String(e));
      }
    },
  };
}
