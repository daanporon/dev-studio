// replay-path.test.ts — U208: a request whose script path is gone (a bin move) runs the one script of that
// name under <root>/bin/*/; a name found nowhere fails once, not retried. paths-check counts such requests.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";

const ROOT = join(import.meta.dir, "..", "..");
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
let tries: string | undefined;
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
  if (tries === undefined) delete process.env.DS_LOOP_SEND_TRIES; else process.env.DS_LOOP_SEND_TRIES = tries;
});
function imported(): Store {
  const d = mkdtempSync(join(tmpdir(), "zzmsg-"));
  temps.push(d);
  cpSync(join(ROOT, "tests", "fixtures", "loop", "state"), d, { recursive: true });
  const s = open(d);
  stores.push(s);
  importJson(s);
  return s;
}

// The child: logs how it ran, then does what the `mode` file in the state root says (default ok).
//   refuse   "no squad 'x' in 'fx'" on stderr, exit 2
//   crossrun refused with Orca's cross-run text (exit 1) unless it runs --from a pane (DS_ORCA_FROM is set); then ok
//   ok       prints "did <args>"
const mode = (s: Store, m: string) => writeFileSync(join(s.root, "mode"), m);
function child(s: Store): string {
  const f = join(s.root, "child.sh");
  writeFileSync(f, `#!/usr/bin/env bash
printf 'from=%s orcafrom=%s args=%s\\n' "\${ORCA_TERMINAL_HANDLE:-}" "\${DS_ORCA_FROM:-}" "$*" >> "$DS_STATE_ROOT/child.log"
case "$(cat "$DS_STATE_ROOT/mode" 2>/dev/null)" in
  refuse) echo "directory: no squad 'x' in 'fx'" >&2; exit 2 ;;
  crossrun) [ -n "\${DS_ORCA_FROM:-}" ] || { echo "orca adapter: send-run-worker NOT delivered — cross-run delivery needs a sender with no dispatch" >&2; exit 1; }; echo "did $*" ;;
  *) echo "did $*" ;;
esac
`);
  chmodSync(f, 0o755);
  return f;
}
const runs = (s: Store) => (existsSync(join(s.root, "child.log")) ? readFileSync(join(s.root, "child.log"), "utf8").trim().split("\n") : []);
const replay = (s: Store, kind: string, key: string, args: string[], over: Record<string, unknown> = {}) =>
  ({ kind, key, argv: [child(s), ...args], cwd: s.root, from: "term_asker", ...over });
const req = (s: Store, kind: string, key: string, args: string[], over: Record<string, unknown> = {}, row: Record<string, unknown> = {}) =>
  Number(s.request(kind, replay(s, kind, key, args, over), { key, ...row }).row.id);
const observe = (s: Store, handle = "term_asker") => s.db.run("INSERT INTO observed_terminals (project, handle, observed_at) VALUES ('fx', ?, 100)", [handle]);
const get = (s: Store, id: number) => s.db.query("SELECT * FROM requests WHERE id = ?").get(id) as Row;

const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
function rig(s: Store) {
  const orca = new FakeOrca();
  const act = new LoopActuator({ orca, fulfillers: fulfillers.filter((f) => f.kinds) });
  const loop = new Loop(s, { observers: [], reconcilers: fulfillers }, act, { projects: () => ["fx"] });
  loop.boot(T);
  const tick = async (at: number) => { await loop.tick(at); await act.drain(); };
  return { orca, tick };
}
const pokes = (o: FakeOrca) => o.of("poke-terminal").map((c) => c.args);
const cards = (s: Store, project = "fx") => {
  const f = join(s.root, project, "alerts.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).alerts as Row[]).filter((a) => a.title === "Message not delivered") : [];
};

import { openRequestsOnOldPaths } from "../../bin/commands/paths-check.ts";

// A host root with bin/<folder>/<name> scripts that log how they ran.
function hostRoot(s: Store, folders: string[], name = "send-role.sh"): string {
  const root = join(s.root, "host");
  for (const f of folders) {
    mkdirSync(join(root, "bin", f), { recursive: true });
    writeFileSync(join(root, "bin", f, name), `#!/usr/bin/env bash\necho "ran ${f} $*" >> "$DS_STATE_ROOT/child.log"\necho "did $*"\n`);
    chmodSync(join(root, "bin", f, name), 0o755);
  }
  return root;
}
const old = (root: string, name = "send-role.sh") => ({ kind: "send-role", key: "send-role:fx:k", argv: [join(root, "bin", name), "x", "lead", "s", "b"], cwd: tmpdir(), from: "term_asker" });

describe("a moved script is found in its folder", () => {
  test("argv[0] at the old top-level path runs the file in bin/role and logs replay_path_moved once", async () => {
    const s = imported(), a = rig(s); observe(s);
    const root = hostRoot(s, ["role"]);
    const id = Number(s.request("send-role", old(root), { key: "send-role:fx:k", project: "fx", squad: "x" }).row.id);
    await a.tick(T);
    expect(get(s, id).done_at).toBe(T);
    expect(JSON.parse(String(get(s, id).result)).ok).toBe(true);
    expect(runs(s)).toEqual(["ran role x lead s b"]);
    const ev = s.db.query("SELECT payload FROM events WHERE kind = 'replay_path_moved'").all() as Row[];
    expect(ev).toHaveLength(1);
    expect(JSON.parse(String(ev[0].payload))).toMatchObject({ old: join(root, "bin", "send-role.sh"), new: join(root, "bin", "role", "send-role.sh") });
  });

  test("a name found in no folder fails once with the message and is not retried", async () => {
    const s = imported(), a = rig(s); observe(s);
    const root = hostRoot(s, ["role"], "other.sh");
    const id = Number(s.request("send-role", old(root), { key: "send-role:fx:k", project: "fx", squad: "x" }).row.id);
    await a.tick(T); await a.tick(T + 1); await a.tick(T + 60);
    const r = get(s, id);
    expect(r.done_at).not.toBeNull();
    expect(JSON.parse(String(r.result))).toMatchObject({ ok: false, error: "script send-role.sh not found under bin/" });
    expect(runs(s)).toEqual([]);
  });

  test("a name in two folders fails and is not guessed", async () => {
    const s = imported(), a = rig(s); observe(s);
    const root = hostRoot(s, ["role", "commands"]);
    const id = Number(s.request("send-role", old(root), { key: "send-role:fx:k", project: "fx", squad: "x" }).row.id);
    await a.tick(T);
    expect(JSON.parse(String(get(s, id).result)).ok).toBe(false);
    expect(runs(s)).toEqual([]);
  });
});

describe("paths-check counts open requests on an old path", () => {
  test("only an open request whose argv[0] is an old top-level path", () => {
    const s = imported(), root = hostRoot(s, ["role"]);
    s.request("send-role", old(root), { key: "a", project: "fx" });
    s.request("send-role", { ...old(root), argv: [join(root, "bin", "role", "send-role.sh")] }, { key: "b", project: "fx" });
    s.close();
    expect(openRequestsOnOldPaths([root], s.root)).toBe(1);
  });
});
