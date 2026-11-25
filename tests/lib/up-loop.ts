// up-loop.ts — the loop tests/up-backend.sh runs beside `ds up` (U53): real ticks on $DS_STATE_ROOT of the state,
// Orca and contract observers, the Studio reconciler and the real actuator and fulfillers, over the fake Orca or
// the fake tmux. It runs until killed, so a second `ds up` meets the Studio the first one started.
//   bun tests/lib/up-loop.ts <project> <orca|tmux> <summary file>
// After each tick it writes the summary file: `starts=<n> live=<n> handle=<h|-> herdr=<n>` (studio-starts on the fake
// Orca, Studio terminals made on the fake tmux; live: the terminals still open; handle: the `_studio` member's; herdr:
// the terminals open on the fake herdr, where a project moved by `ds up --backend herdr` (U54) runs its Studio).
import { writeFileSync } from "node:fs";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { open } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { FakeBackend } from "../../bin/loop/fakes/orca.ts";
import { fakeContract, type FakeContract } from "../../bin/loop/fakes/contract.ts";
import { contractObserver } from "../../bin/loop/observers/contract.ts";
import { orcaObserver, type LiveAccount } from "../../bin/loop/observers/orca.ts";
import { stateObserver } from "../../bin/loop/observers/state.ts";
import studioRec from "../../bin/loop/reconcilers/studio.ts";
import { STUDIO_SQUAD } from "../../bin/loop/squad/studio.ts";

const [project, kind, summary] = process.argv.slice(2);
if (!project || (kind !== "orca" && kind !== "tmux") || !summary) { console.error("usage: up-loop.ts <project> <orca|tmux> <summary file>"); process.exit(2); }

const s = open();
const now = () => Math.floor(Date.now() / 1000);
const orca = new FakeBackend();
// The fake tmux shows Claude's prompt once a launch line is typed, and the host's walk sees claude in it.
function contracted(name: string) {
  const f = fakeContract({}, { name, now });
  const backend = { caps: f.caps, call: (async (op: string, req: { id?: string; text?: string }) => {
    const r = await f.call(op as never, req as never);
    if (op === "terminal.send" && String(req.text ?? "").startsWith("exec bash")) f.terms.get(req.id!)!.lines.push("╭───╮", "│ ❯ │", "╰───╯");
    return r;
  }) as FakeContract["call"] };
  return { fake: f, backend, caps: f.caps };
}
const tm = contracted("tmux"), hd = contracted("herdr"), fake = tm.fake;
const backends = (name: string) => (name === "herdr" ? hd : tm);
const walk = async (): Promise<LiveAccount[]> => [...tm.fake.terms.values(), ...hd.fake.terms.values()].filter((x) => x.lines.some((l) => l.startsWith("exec bash")))
  .map((x, i) => ({ cwd: x.t.cwd, agent: "claude", account: "system", kind: "main", model: "opus", pid: 4000 + i, start: x.t.created_at }));
// The fake Orca lists the Studio's worktree once the project names one.
const studioWts = () => {
  const p = s.get("projects", { label: project });
  const wt = String(p?.studio_wt ?? "");
  return wt && !wt.startsWith("local::") ? [{ worktreeId: wt }] : [];
};
const act = new LoopActuator({ orca, backends });
const loop = new Loop(s, { observers: [stateObserver(), orcaObserver(orca.observer(studioWts, () => [])), contractObserver({ backends, walk })],
  reconcilers: [studioRec] }, act, { projects: () => [project] });
loop.boot(now());

let stop = false;
process.on("SIGTERM", () => { stop = true; });
while (!stop) {
  await loop.tick(now());
  await act.drain();
  const m = s.db.query("SELECT handle FROM members WHERE project = ? AND squad = ? ORDER BY id DESC").get(project, STUDIO_SQUAD) as { handle: string | null } | null;
  const starts = kind === "orca" ? orca.of("studio-start").length : fake.calls.filter((c) => c.op === "terminal.create").length;
  const live = kind === "orca" ? orca.agents.length : fake.terms.size;
  writeFileSync(summary, `starts=${starts} live=${live} handle=${m?.handle ?? "-"} herdr=${hd.fake.terms.size}\n`);
  await Bun.sleep(300);
}
s.close();
