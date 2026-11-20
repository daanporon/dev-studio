// board-db.ts — tests/board.sh's fixture loop.db, after `bin/ds import` (Bun): what the loop's
// observers would add on a tick, without Orca, GitHub or a running loop.
//
//   DS_STATE_ROOT=<root> bun tests/board-db.ts <seed.json|- (stdin)> <label>...
//
// It runs the state-file observer once over <root> (Lavish sessions from LAVISH_AXI_STATE_DIR, the
// Leads' beats, usage limits, accounts, tokens), then writes the seed's rows for each label:
//   workers    [[wt, state|null, displayName?, account?, outputAge?, subs?, dispatch?, seenAge?, dispId?]]  observed_workers (null state = gone_at set;
//              outputAge = seconds since the worktree's last output, null = unknown;
//              subs = [[agent, model, account]] live sub-agents beside its own agent (U90);
//              dispatch = the worktree's newest dispatch status (U96, read through the U100 verdict);
//              seenAge = seconds since that Run's dispatches were last read (default 0: just read,
//              null = never: the verdict reads unknown and the display keeps the agent state);
//              dispId = the worktree's newest dispatch id (a rebound check needs it))
//   unread     [[wt, count, episodeAge?]]          the worktree's unread Run mail count; with episodeAge, the loop's open `unread`
//              episode first saw it that many seconds ago (liveness.leadVerdict's "not responding" clock)
//   gone_members [wt]                              members.status = gone (a retired member)
//   phases     {wt: phase|null}                   members.phase (U105)
//   transcripts [[wt, model, entrypoint?, effort?]]        observed_transcripts (a later one is newer;
//                                                entrypoint e.g. "sdk-cli" for a reviewer's `claude -p` (U98))
//   terminals  [[handle, wt, squad, agent?]]              observed_terminals (live)
//   worktrees  [[wt, branch|null, gone?]]         observed_worktrees (gone = gone_at set)
//   prs        [{repo, pr, url?, state, draft?, ci?, review?, head?, unit?, verdict?, reasons?, stale?, gone?}]  observed_prs (GitHub rows)
//   repos      {selector: "owner/name"}           config rows file github, key repo:<selector>
//   docs       {topic: "raw doc"}                 a squads row whose doc won't parse (a broken squad)
//   events     n | [{at?, ago?, squad?, unit?, member?, kind?, payload?}]  n fixture events, or these (ago: seconds before now)
//   picks      [{squad, suffix, reason?, wait_in?, wait_known?, slot?, account?}]  the picks row of that squad's Builder
//              member (suffix = its unit slug); wait_in: wait_until is that many seconds from now
//   relayed    [{squad, error?, seenAge?, forwardedAge?}]  relayed Run mail rows (an unforwarded
//              one with an error reads as a stuck relay; ages are seconds ago)
//   orca_age   s   the Orca rows' observed_at is that old (default 0: just seen)
//   machine    {cores?, load1?, mem_total_kb?, mem_avail_kb?, swap_total_kb?, swap_free_kb?, psi_*?, disks?, groups?, age?}  one observed_machine row (U4); machine: false drops the table
//   procs      [[wt, rss_kb, cpu_pct|null, procs?, project?, mem_kb?, psi_cpu?, psi_mem?, cpu_cg_pct?]]  observed_procs rows (U5, U9; project defaults to the first label; the last three null when omitted); procs: false drops the table
//   host_procs [{comm, label?, procs, rss_kb, mem_kb?, cpu_pct}]    the observed_host_procs row's groups (U5); host_procs: false drops the table
//   host_loop  {cpu_pct?, mem_kb?, cache_kb?, source?}  the loop's own load on that row (machine-top-ram-clarity U5); host_loop:
//              false drops the loop columns (an older loop.db)
//   unit_cpu   [[squad, slug, cpu_s, peak_cpu_pct?, peak_rss_kb?, project?]]  unit_cpu rows (light-lane U2; project defaults to the first label); unit_cpu: false drops the table
//   reviews    [{squad, slug, state, since_ago?, kind?, round?, findings?, project?}]  observed_reviews rows (U4; since_ago:
//              seconds before now; project defaults to the first label); reviews: false drops the table
//   exposed    [{squad, name, url, note?, role?, suffix?, scope?, audience?, ago?, gone?, status?, reach?, down_since?, project?}]  exposed rows
//              (gone = gone_at set; ago = seconds since created_at); status/reach/down_since add an observed_exposed row
//   health_age s   the health row's tick/start is that old; null = no health row (default 0)
//   progress_age s   the last completed step is that old (default absent)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, now } from "../bin/loop/core/store.ts";
import { stateObserver } from "../bin/loop/observers/state.ts";
import type { TickCtx } from "../bin/loop/core/plugins.ts";

const [seedArg = "-", ...labels] = process.argv.slice(2);
const seed = JSON.parse(readFileSync(seedArg === "-" ? 0 : seedArg, "utf8") || "{}");
const s = open();
const at = now(), empty = mkdtempSync(join(tmpdir(), "zzboard-db-"));

await stateObserver({ tokenDir: empty, lavishDir: process.env.LAVISH_AXI_STATE_DIR || empty, lavishLog: join(empty, "none.log"),
  refreshAccounts: () => {} }).run({ store: s, project: "", tick: 1, now: at, fired: [], poked: new Set() } as TickCtx);

const orcaAt = at - (seed.orca_age ?? 0);
s.tx(() => {
  for (const project of labels) {
    for (const [wt, state, name, account, outputAge, subs, dispatch, seenAge, dispId] of seed.workers ?? []) {
      s.upsert("observed_workers", { project, wt }, { state: state ?? "idle", name: name ?? null, account: account ?? null, unread: 0, observed_at: orcaAt, gone_at: state == null ? orcaAt : null,
        dispatch: dispatch ?? null, dispatch_id: dispId ?? null,
        dispatch_seen_at: seenAge === undefined ? (dispatch != null ? orcaAt : null) : (seenAge == null ? null : at - seenAge),
        last_output_at: outputAge == null ? null : at - outputAge,
        sub_agents: subs ? JSON.stringify(subs.map(([agent, model, subAccount, effort]: [string, string, string, string?]) => ({ agent, model, account: subAccount, ...(effort ? { effort } : {}) }))) : null });
    }
    for (const [wt, count, epAge] of seed.unread ?? []) {
      s.db.run("UPDATE observed_workers SET unread = ? WHERE project = ? AND wt = ?", [count, project, wt]);
      if (epAge != null) s.upsert("episodes", { project, subject: wt, kind: "unread" }, { started_at: at - epAge, ended_at: null, count, state: "unread", source: "loop", observed_at: at });
    }
    for (const wt of seed.gone_members ?? []) s.db.run("UPDATE members SET status = 'gone' WHERE project = ? AND wt = ?", [project, wt]);
    (seed.transcripts ?? []).forEach(([wt, model, entrypoint, effort]: [string, string | null, string?, string?], i: number) =>
      s.upsert("observed_transcripts", { path: `/fx/${project}/${wt}/${i}.jsonl` }, { project, wt, mtime: at - 1000 + i, size: 1, last_model: model, last_effort: effort ?? null, entrypoint: entrypoint ?? null, observed_at: at }));
    for (const [wt, phase] of Object.entries(seed.phases ?? {})) s.db.run("UPDATE members SET phase = ? WHERE project = ? AND wt = ?", [phase as string | null, project, wt]);
    for (const [handle, wt, squad, agent] of seed.terminals ?? []) {
      s.upsert("observed_terminals", { project, handle }, { wt, title: `${squad}/x`, doc: JSON.stringify({ squad, agent: agent ?? true }), observed_at: orcaAt, gone_at: null });
    }
    for (const [wt, branch, gone] of seed.worktrees ?? []) s.upsert("observed_worktrees", { project, wt }, { path: wt, branch: branch ?? null, observed_at: orcaAt, gone_at: gone ? orcaAt : null });
    for (const p of seed.prs ?? []) {
      s.upsert("observed_prs", { project, ref: `${p.repo}#${p.pr}` }, { repo: p.repo, pr: p.pr, url: p.url ?? null, state: p.state ?? "OPEN", draft: p.draft ? 1 : 0, ci: p.ci ?? "green",
        review: p.review ?? "none", head: p.head ?? null, unit: p.unit ?? null, verdict: p.verdict ?? null, reasons: p.reasons == null ? null : JSON.stringify(p.reasons), stale: p.stale ?? 0, detail: "full", observed_at: at, gone_at: p.gone ? at : null });
    }
    for (const [sel, nwo] of Object.entries(seed.repos ?? {})) s.upsert("config", { project, file: "github", key: `repo:${sel}` }, { value: nwo, observed_at: at });
    for (const [topic, doc] of Object.entries(seed.docs ?? {})) s.upsert("squads", { project, topic }, { status: "running", doc, updated_at: at, observed_at: at });
    const evs = typeof seed.events === "number" ? Array.from({ length: seed.events }, (_, i) => ({ squad: i % 2 ? "even" : "odd", kind: `fx_${i + 1}` })) : seed.events ?? [];
    for (const e of evs) s.db.run("INSERT INTO events (at, project, squad, member, unit, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [e.at ?? at - (e.ago ?? 0), project, e.squad ?? null, e.member ?? null, e.unit ?? null, e.kind ?? "fx", JSON.stringify({ n: e.kind ?? "fx", ...(e.payload ?? {}) })]);
    for (const p of seed.picks ?? []) {
      const m = s.db.query("SELECT id FROM members WHERE project = ? AND squad = ? AND role = 'builder' AND suffix = ?").get(project, p.squad, p.suffix) as { id: number } | null;
      if (!m) throw new Error(`picks: no builder member ${p.squad}/${p.suffix}`);
      s.upsert("picks", { member: m.id }, { project, squad: p.squad, role: "builder", phase: "build", account: p.account ?? null, reason: p.reason ?? null,
        wait_until: p.wait_in == null ? null : at + p.wait_in, wait_known: p.wait_known ?? null, slot: p.slot ?? 0, picked_at: at });
    }
    (seed.relayed ?? []).forEach((r: { squad?: string; error?: string; seenAge?: number; forwardedAge?: number }, i: number) =>
      s.db.run("INSERT INTO relayed (msg_id, project, squad, run_id, seen_at, forwarded_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [`fx-${r.squad ?? "?"}-${i}`, project, r.squad ?? null, "run_fx", at - (r.seenAge ?? 3600), r.forwardedAge == null ? null : at - r.forwardedAge, r.error ?? null]));
  }
  if (seed.machine === false) s.db.run("DROP TABLE IF EXISTS observed_machine");
  else if (seed.machine) {
    const { age, ...m } = seed.machine;
    s.upsert("observed_machine", { host: "fx-host" }, { cores: 24, load1: 1, load5: 1, load15: 1, mem_total_kb: 1000000, mem_avail_kb: 800000, swap_total_kb: 1000000, swap_free_kb: 1000000,
      psi_cpu_some: 0, psi_mem_some: 0, psi_mem_full: 0, psi_io_some: 0, psi_io_full: 0, scan_ms: 1, ...m,
      disks: JSON.stringify(m.disks ?? [{ path: "/", total_kb: 1000, free_kb: 500 }]), groups: JSON.stringify(m.groups ?? []), observed_at: at - (age ?? 0) });
  }
  if (seed.procs === false) s.db.run("DROP TABLE IF EXISTS observed_procs");
  else for (const [wt, rss, cpu, n, project, mem, pc, pm, cg] of seed.procs ?? []) s.upsert("observed_procs", { project: project ?? labels[0], wt }, { procs: n ?? 3, rss_kb: rss, cpu_pct: cpu, mem_kb: mem ?? null, psi_cpu: pc ?? null, psi_mem: pm ?? null, cpu_cg_pct: cg ?? null, root_pid: null, observed_at: at });
  if (seed.reviews === false) s.db.run("DROP TABLE IF EXISTS observed_reviews");
  else for (const r of seed.reviews ?? []) s.upsert("observed_reviews", { project: r.project ?? labels[0], squad: r.squad, slug: r.slug },
    { wt: null, state: r.state, since: r.since_ago == null ? null : at - r.since_ago, kind: r.kind ?? null, round: r.round ?? null,
      findings: r.findings ?? null, head: null, observed_at: at });
  if (seed.host_procs === false) s.db.run("DROP TABLE IF EXISTS observed_host_procs");
  else if (seed.host_procs) {
    const lp = seed.host_loop || {};
    s.upsert("observed_host_procs", { host: "fx-host" }, { groups: JSON.stringify(seed.host_procs), procs: 1, rss_kb: 1, scan_ms: 1, observed_at: at,
      loop_cpu_pct: lp.cpu_pct ?? null, loop_mem_kb: lp.mem_kb ?? null, loop_cache_kb: lp.cache_kb ?? null, loop_source: lp.source ?? null });
    if (seed.host_loop === false) for (const c of ["loop_cpu_pct", "loop_mem_kb", "loop_cache_kb", "loop_source"]) s.db.run(`ALTER TABLE observed_host_procs DROP COLUMN ${c}`);
  }
  if (seed.unit_cpu === false) s.db.run("DROP TABLE IF EXISTS unit_cpu");
  else for (const [squad, slug, cpu, peak, rss, project] of seed.unit_cpu ?? []) s.upsert("unit_cpu", { project: project ?? labels[0], squad, slug },
    { cpu_s: cpu, peak_cpu_pct: peak ?? null, peak_rss_kb: rss ?? null, wt: null, first_at: at, updated_at: at });
  for (const x of seed.exposed ?? []) {
    const project = x.project ?? labels[0], made = at - (x.ago ?? 0);
    s.db.run("INSERT INTO exposed (project, squad, owner_wt, role, suffix, name, url, note, scope, audience, created_at, updated_at, gone_at, gone_why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [project, x.squad, x.owner_wt ?? "", x.role ?? "tester", x.suffix ?? "", x.name, x.url, x.note ?? null, x.scope ?? "squad", x.audience ?? "operator", made, made, x.gone ? at : null, x.gone ? "unexposed" : null]);
    if (x.status || x.reach) {
      const id = Number(s.db.query("SELECT last_insert_rowid() AS id").get()?.id);
      s.db.run("INSERT INTO observed_exposed (exposed_id, status, reach, probed_at, down_since) VALUES (?, ?, ?, ?, ?)", [id, x.status ?? null, x.reach ?? null, at, x.down_since ?? null]);
    }
  }
  if (seed.health_age !== null) s.upsert("health", { id: 1 }, { pid: 0, started_at: at - (seed.health_age ?? 0), tick_at: at - (seed.health_age ?? 0), tick_no: 1,
    progress_at: seed.progress_age == null ? null : at - seed.progress_age });
});
s.close();
rmSync(empty, { recursive: true, force: true });
