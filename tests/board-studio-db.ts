// board-studio-db.ts <label> — U261, for tests/board.sh: one Orca observer tick (FakeOrca) over the
// loop.db in $DS_STATE_ROOT, whose project <label> has its Studio worktree at <root>/<label>-studio
// holding the AE1 layout: the Studio's claude tab, a `ds-loop` pane running codex and a plain shell,
// with a claude and a codex main process in that worktree. `--moved` adds U264's `studio_moved`
// event (the loop moved the Studio from claude:acct-a to claude:B).
import { open } from "../bin/loop/core/store.ts";
import { Loop } from "../bin/loop/core/tick.ts";
import { FakeOrca } from "../bin/loop/fakes/orca.ts";
import { sendMessage } from "../bin/loop/messages/messages.ts";
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
// chat-with-studio U1: `--chatty` adds one role message to the Studio (squad _studio, role studio), a Studio reply in
// observed_chat (a tool turn and a user turn after it, which never count) and a working Studio.
if (process.argv.includes("--chatty")) {
  sendMessage(s, { to: { project: label, squad: "_studio", role: "studio", suffix: "" }, from: { project: label, squad: "sq", role: "lead", suffix: "", member: null },
    subject: "need a call", body: "which way?" }, now);
  const turns = JSON.stringify([{ role: "assistant", text: "older", at: now - 90 }, { role: "assistant", text: "latest reply", at: now - 60 },
    { role: "assistant", tool: "2 tools", text: "2 tools", at: now - 30 }, { role: "user", text: "q", at: now - 10 }]);
  s.db.run("INSERT INTO observed_chat (project, wt, agent, source, path, read_to, size, turns, updated_at) VALUES (?, ?, 'claude', 'transcript', '/x.jsonl', 1, 1, ?, ?)", [label, wt, turns, now]);
  s.db.run("UPDATE observed_workers SET state = 'working' WHERE project = ? AND wt = ?", [label, wt]);
}
s.close();
