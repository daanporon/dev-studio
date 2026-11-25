// board-contract-db.ts <label> — U12 of orca-backend-alternatives, for tests/board.sh: a squad `ontmux` on
// the tmux backend (squads.backend, written before its squad file is imported, as the spawn writes it)
// and one contract observer tick (observers/contract.ts) over the fake contract with `state: none`, the
// way the loop reads a tmux squad: the Lead's agent sits at an empty prompt (idle), the Builder's terminal
// printed just now (working), the Thinker has no terminal (gone). U12b: unit u1's Builder ended with no PR.
// The squad file is
// <root>/<label>/squads/ontmux.json, members at /tmp/zz-<label>-{lead,builder-u1,thinker}.
// U58 `--side`: the project's Studio is on tmux too (no part on Orca), and beside it project `<label>o` runs an
// Orca squad `onorca` whose Orca observer row is an hour old (Orca stopped answering).
import { open } from "../bin/loop/core/store.ts";
import { Loop } from "../bin/loop/core/tick.ts";
import { importJson } from "../bin/loop/db/import-json.ts";
import { fakeContract } from "../bin/loop/fakes/contract.ts";
import { contractObserver } from "../bin/loop/observers/contract.ts";

const label = process.argv[2]!, s = open(), now = Math.floor(Date.now() / 1000);
const at = (who: string) => `/tmp/zz-${label}-${who}`;
s.db.run("INSERT INTO squads (project, topic, observed_at, updated_at, backend, worktree_provider) VALUES (?, 'ontmux', ?, ?, 'tmux', 'git')", [label, now, now]);
importJson(s);
const fake = fakeContract({ state: "none" }, { name: "tmux", now: () => now });
const lead = await fake.call("terminal.create", { cwd: at("lead"), env: {}, label: "lead", group: "ontmux" });
const builder = await fake.call("terminal.create", { cwd: at("builder-u1"), env: {}, label: "builder-u1", group: "ontmux" });
if (!lead.ok || !builder.ok) throw new Error("fake contract refused a create");
const l = fake.terms.get(lead.terminal.id)!, b = fake.terms.get(builder.terminal.id)!;
l.lines.push("claude --model opus", "╭────╮", "│ > │", "╰────╯"); l.last = now - 600;
b.lines.push("claude --model opus", "editing bin/x.ts"); b.last = now - 2;
process.env.DS_LOOP_LIVE_ACCOUNT_S = "1";
const walk = async () => [at("lead"), at("builder-u1")].map((cwd, i) => ({ cwd, agent: "claude", account: "system", kind: "main", model: "opus", pid: 9100 + i, start: now - 900 }));
const loop = new Loop(s, { observers: [contractObserver({ backends: () => ({ backend: fake, caps: fake.caps }), walk })], reconcilers: [] }, { act() {} }, { projects: () => [label] });
loop.boot(now);
await loop.tick(now);
// U12b: the Builder of unit u1 (generation g1) ended with no PR; liveness filed the Lead's report under its
// generation, as off Orca there is no dispatch to name (liveness.ts idleBuilder).
s.db.run("UPDATE members SET gen = 'g1' WHERE project = ? AND wt = ?", [label, `local::${at("builder-u1")}`]);
s.db.run(`INSERT INTO episodes (project, subject, kind, squad, started_at, episode_key, state, source, observed_at)
  VALUES (?, 'frep.builder.idle', 'idle', 'ontmux', ?, 'failed|u1|gen:g1', 'failed_report', 'test', ?)`, [label, now, now]);
if (process.argv[3] === "--side") {
  s.db.run("INSERT OR REPLACE INTO projects (label, doc, observed_at) VALUES (?, ?, ?)", [label, JSON.stringify({ studio_backend: "tmux" }), now]);
  s.db.run("INSERT OR REPLACE INTO projects (label, doc, observed_at) VALUES (?, ?, ?)", [`${label}o`, JSON.stringify({ studio_backend: "orca" }), now]);
  s.db.run("INSERT INTO observed_workers (project, wt, state, doc, observed_at) VALUES (?, 'wt_orca_lead', 'idle', '{}', ?)", [`${label}o`, now - 3600]);
}
s.close();
