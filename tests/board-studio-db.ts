// board-studio-db.ts <label> — U261, for tests/board.sh: one Orca observer tick (FakeOrca) over the
// loop.db in $DS_STATE_ROOT, whose project <label> has its Studio worktree at <root>/<label>-studio
// holding the AE1 layout: the Studio's claude tab, a `ds-loop` pane running codex and a plain shell,
// with a claude and a codex main process in that worktree. `--moved` adds U264's `studio_moved`
// event (the loop moved the Studio from claude:acct-a to claude:B).
import { open } from "../bin/loop/core/store.ts";
import { Loop } from "../bin/loop/core/tick.ts";
import { FakeOrca } from "../bin/loop/fakes/orca.ts";
import { orcaObserver } from "../bin/loop/observers/orca.ts";

const label = process.argv[2]!, s = open(), now = Math.floor(Date.now() / 1000);
const path = `/tmp/zz-${label}-studio`, wt = `repo::${path}`;
const o = new FakeOrca();
o.worktrees = [{ worktreeId: wt, path, agents: [{ state: "idle" }] }];
const tab = (handle: string, title: string, agentIdentity?: string) =>
  ({ handle, worktreeId: wt, title, agentIdentity, connected: true, writable: true, lastOutputAt: (now - 600) * 1000 });
o.tabs = [tab("term_studio", "claude", "claude"), tab("term_loop", "ds-loop briefing", "codex"), tab("term_sh", "bash")];
o.procs = [
  { cwd: path, agent: "codex", account: "codex-acct", kind: "main", pid: 11, start: now - 300 },
  { cwd: path, agent: "claude", account: "acct-studio", kind: "main", model: "claude-opus-5-5", pid: 12, start: now - 3600 },
];
const l = new Loop(s, { observers: [orcaObserver(o)], reconcilers: [] }, { act() {} }, { projects: () => [label] });
l.boot(now);
await l.tick(now);
if (process.argv.includes("--moved"))
  s.event("studio_moved", { project: label, squad: "_studio", member: wt, payload: { handle: "term_studio", previous: "term_old", from: "claude:acct-a", to: "claude:B", model: "sonnet" } });
s.close();
