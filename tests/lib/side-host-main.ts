// side-host-main.ts — main's half of tests/side-host.sh (side-loop-host U22), under the main state root
// (DS_STATE_ROOT). It is the real loop, actuator, picker, link server, host jobs and remote adapter, with two
// differences from a host install: no observers, so a row about the side host can only have come up the link,
// and a fake backend for main's own members, so nothing starts on this host outside the side's tmux.
//
//   setup <repo-url-path>            the fixture state plus a squad on tmux (repo: main's clone of a bare origin)
//   serve <link-port> <proxy-port>   the link server, a TCP proxy before it (the side dials the proxy; while the
//                                    file $DS_SIDE_HOST_CUT exists it refuses and drops every connection), the loop
//   builder <unit>                   a unit and its Builder, wished running
//   gone <unit>                      that Builder wished gone
//   busy <unit>                      the one observation main's missing observers would make of a Builder on main
//   q <sql>                          one query's rows, tab-separated
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { syncAccountFolders } from "../../bin/loop/capacity/accounts.ts";
import { LoopActuator, type Fulfiller } from "../../bin/loop/core/actuator.ts";
import decider from "../../bin/loop/core/decide.ts";
import { DIRS, load, type Reconciler } from "../../bin/loop/core/plugins.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { importJson } from "../../bin/loop/db/import-json.ts";
import { fakeContract } from "../../bin/loop/fakes/contract.ts";
import { FakeBackend as FakeOrca } from "../../bin/loop/fakes/orca.ts";
import { startLinkServer } from "../../bin/link/server.ts";
import { studioOn } from "../loop/studio-on.ts";

const PROJECT = "fx", SQUAD = "ontmux";
const [verb, ...args] = process.argv.slice(2);
const root = process.env.DS_STATE_ROOT;
if (!root) throw new Error("side-host-main: DS_STATE_ROOT is not set");
const sec = () => Math.floor(Date.now() / 1000);

const memberOf = (s: Store, unit: string): Row | null =>
  s.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = 'builder' AND suffix = ? ORDER BY id DESC").get(PROJECT, SQUAD, unit) as Row | null;

function setup(s: Store, repo: string): void {
  const at = sec();
  importJson(s);
  // The fixture's own squad would take the side seats with its waiting Builders; only the project and accounts are used.
  for (const table of ["members", "units", "squads"]) s.db.run(`DELETE FROM ${table} WHERE ${table === "squads" ? "topic" : "squad"} = 'demo'`);
  const config = (file: string, key: string, value: string) => s.upsert("config", { project: PROJECT, file, key }, { value, observed_at: at });
  config("roles.conf", "lead", "claude sonnet always");
  config("roles.conf", "builder", "claude opus ondemand");
  // One Builder seat on main: while it is taken, the next Builder is placed on a side host (KTD10).
  config("limits.conf", "max_builders", "1");
  // The one login both hosts hold: the side's scan reports `uuid-a` up the link; main's own copy is a temp folder.
  s.db.run("UPDATE accounts SET config_dir = ?, login_id = 'uuid-a' WHERE agent = 'claude' AND account = 'acct-a'", [join(process.env.DS_CLAUDE_SYSTEM_JSON_DIR!, "..", "acct-a")]);
  s.upsert("projects", { label: PROJECT }, { doc: JSON.stringify({ ...JSON.parse(String(s.get("projects", { label: PROJECT })?.doc ?? "{}")), studio_backend: "tmux" }), observed_at: at });
  studioOn(s, PROJECT, "tmux", at);
  s.want("squad", `${PROJECT}/${SQUAD}`, "running", { payload: { repo: `path:${repo}`, type: "feature" },
    fill: { repo: `path:${repo}`, type: "feature", backend: "tmux", worktree_provider: "git" }, by: "test" });
}

function builder(s: Store, unit: string): void {
  const at = sec();
  s.db.run("INSERT INTO units (project, squad, slug, status, tier, observed_at, updated_at) VALUES (?, ?, ?, 'dispatched', 'standard', ?, ?)", [PROJECT, SQUAD, unit, at, at]);
  s.db.run("INSERT INTO members (project, squad, role, suffix, agent, observed_at, updated_at) VALUES (?, ?, 'builder', ?, 'claude', ?, ?)", [PROJECT, SQUAD, unit, at, at]);
  s.want("member", String(memberOf(s, unit)!.id), "running", { payload: { prompt: `build ${unit}`, unit }, by: "test" });
}

async function serve(s: Store, linkPort: number, proxyPort: number): Promise<void> {
  const cut = process.env.DS_SIDE_HOST_CUT!;
  await startLinkServer({ root: root!, binds: "127.0.0.1", port: linkPort });

  type Pipe = { other: Bun.Socket<Pipe> | null; early: Uint8Array[] };
  const open_ = new Set<Bun.Socket<Pipe>>();
  const drop = (c: Bun.Socket<Pipe>) => { open_.delete(c); c.data.other?.end(); };
  // Loopback with small frames: a short write is not expected, and a lost one only makes the link reconnect.
  const send = (to: Bun.Socket<Pipe>, b: Uint8Array) => { if (to.write(b) < b.length) to.end(); };
  Bun.listen<Pipe>({ hostname: "127.0.0.1", port: proxyPort, socket: {
    open(c) {
      c.data = { other: null, early: [] };
      if (existsSync(cut)) { c.end(); return; }
      open_.add(c);
      void Bun.connect<Pipe>({ hostname: "127.0.0.1", port: linkPort, socket: {
        data: (_u, b) => send(c, b), close: () => { c.end(); }, error: () => { c.end(); },
      } }).then((u) => { c.data.other = u; for (const b of c.data.early.splice(0)) send(u, b); }, () => c.end());
    },
    data(c, b) { if (c.data.other) send(c.data.other, b); else c.data.early.push(Uint8Array.from(b)); },
    close: drop, error: drop,
  } });
  setInterval(() => { if (existsSync(cut)) for (const c of [...open_]) { c.end(); drop(c); } }, 200);

  const fulfillers = await load<Fulfiller & Reconciler>(DIRS.fulfil);
  const reconcilers = await load<Reconciler>(DIRS.reconcilers);
  const local = fakeContract({}, { name: "tmux", now: sec });
  const act = new LoopActuator({ orca: new FakeOrca(), fulfillers: fulfillers.filter((f) => f.kinds), backends: () => ({ backend: local, caps: local.caps }) });
  const loop = new Loop(s, { observers: [], reconcilers: [decider, ...reconcilers, ...fulfillers] }, act, { projects: () => [PROJECT] });
  loop.boot();
  console.log("main: ready");
  for (;;) {
    try {
      syncAccountFolders(s);   // derived from the side's uploaded folder scan; main's state observer does this on a host
      await loop.tick();
    } catch (e) { console.error(`tick: ${(e as Error).stack}`); }
    await Bun.sleep(1000);
  }
}

if (verb === "setup") cpSync(join(import.meta.dir, "..", "fixtures", "loop", "state"), root, { recursive: true });
const s = open(root);
if (verb === "serve") await serve(s, Number(args[0]), Number(args[1]));
else {
  if (verb === "setup") setup(s, args[0]);
  else if (verb === "builder") builder(s, args[0]);
  else if (verb === "gone") s.want("member", String(memberOf(s, args[0])!.id), "gone", { by: "test", why: "frees main's seat" });
  else if (verb === "busy") {
    const m = memberOf(s, args[0])!;
    s.upsert("observed_workers", { project: PROJECT, wt: String(m.wt) }, { state: "busy", walk: "running", presence: "running", observed_at: sec() });
  } else if (verb === "q") {
    for (const r of s.db.query(args[0]).all() as Row[]) console.log(Object.values(r).map((v) => v ?? "-").join("\t"));
  } else throw new Error(`side-host-main: unknown verb ${verb}`);
  s.close();
}
