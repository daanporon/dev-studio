// squad-state.ts — read/write a single squad's state (Bun port of bin/role/squad-state.sh, U13a).
//
//   bun bin/loop/squad/squad-state.ts <file> <command> [args]     (bin/role/squad-state.sh execs this)
//
// Every subcommand, argument, output, error text and exit code of the shell script it replaces (see
// usage below and conventions/state.md). Two backends, chosen per call by a fact of the state root,
// not a setting:
//   json   the squad file read and rewritten through a temp file and a rename, as before (no mark, or
//          a file outside <state root>/<project>/squads/: hermetic tests, a host not switched yet)
//   store  once <state root>/.loop-migrated exists: a write is a fact (store.fact: the squad's rows
//          and an events row in one transaction), then the squad JSON is exported; a read comes from
//          SQLite, so a write is visible to the next call at once
// Questions live in the `questions` table under the store (questions.ts): resolve-question keeps the
// answer; answered-questions lists them.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { derive } from "./derive.ts";
import { settle } from "./squad-finish.ts";
import { exportJson, reimportSquad, render, squadDoc, writtenElsewhere } from "../db/export-json.ts";
import { docRows, pruneSquad } from "../db/import-json.ts";
import * as questions from "../messages/questions.ts";
import { clearCancellationWish, sharedBuilder } from "./cancel.ts";
import { now, open, stateRoot, type Row, type Store } from "../core/store.ts";
import { REVALIDATE_WHY, slotted } from "../reconcilers/ready.ts";
import { unitWishes, withdraw } from "./queued-builder.ts";
import { intents, pause, type Prerequisite } from "../pause/pause.ts";
import { senderAt, sendMessage } from "../messages/messages.ts";
import { rowsMayBeBehind } from "../db/reconcile-mark.ts";
import { approvedCopyPath } from "../../lib/plan-plain.ts";
import { PlanLineError, UNIT_LINE, parsePlanLine, type PlanUnit, type UnitText } from "./plan-lines.ts";

const DEFAULT = '{"task_id":null,"run_id":null,"lead_wt":null,"members":[],"worktrees":[],"units":[],"leftovers":[],"devenv":null,"cleanup":[],"assignments":[],"repo":null,"host":null,"framing":null,"start":null,"type":"feature","autonomy":"checkpoints","status":"running","waiting_on_you":[],"lfg_assumptions":[],"approved_plans":[],"proposed_squads":[]}';

const USAGE = `usage: squad-state.sh <file> <command> [args]
  get              <file>
  set-task         <file> <task_id>
  set-run          <file> <run_id>
  set-lead         <file> <lead_worktree_id>
  add-member       <file> <role> <suffix> <wt> [--owns <item>]... [--for <thinker>] [--agent <a>] [--model <m>] [--effort <e>] [--host <h>] [--account <id>] [--fallback]
  remove-member    <file> <wt>
  rekey-member     <file> <old-wt> <new-wt>   (Orca rotated a worktree id; repoint in place)
  add-member-owns  <file> <wt> <item>
  set-member-for   <file> <wt> <thinker-scope>   (fix a Builder's routing in place)
  set-member-model <file> <wt> <model> [effort] [--agent <a>] [--account <id>] [--fallback 0|1]  (record what a member was restarted on; --account "" = the default login)
  mark-member-restarting <file> <wt>   (restart-role.sh, before it stops the member: its stop is no crash)
  set-member-wait <file> <wt> <epoch>   (a stopped member waiting for a restart pick)
  add-worktree     <file> <worktree_id>    (legacy; prefer add-member)
  add-unit         <file> <slug> [builder_worktree_id] [plan] [deps] [--hold] [--tier standard|hard] [--about <text>] [--ext-dep <squad>/<slug>]...   (--about = what the unit does, shown in the board overlay; deps = comma-separated unit slugs it waits on; --hold = minor follow-up, never auto-dispatched; --tier = the Thinker's Builder tier; --ext-dep = another squad's unit it waits on)
  register-plan    <file> <plan>    (a relative <plan> that exists from the current directory is read there; register every unit line of an approved plan — \`U<n> — <title> — deps: U<m>… | none — Tier: standard|hard [— ext-deps: <squad>/<slug>[, …]] [— Lane: light|normal [(rule: <id>)]] [— HELD]\` —
                   with plan, deps as slugs, tier; all-or-nothing (exit 1 names the bad line, writes nothing); idempotent.
                   A unit keeps its slug across re-runs (matched by plan + U<n>); a new one's slug is a backticked \`u<n>-…\` in the
                   title, else u<n>- + the title in kebab case, first 4 words, max 32 chars (-2, -3 on a clash).
                   Prints <slug>\\t<added|updated|unchanged|adopted>\\t<tier>\\t<deps>)
  wait-on          <file> <slug> [<dep-slug>] [--ext-dep <squad>/<slug>]... --why <text>   (a started unit now waits on another unit: adds the dep and the reason; the loop pauses its Builder until the dep merges; refused for a done/cancelled/unknown unit, itself or a cycle; idempotent)
  wait-off         <file> <slug> [<dep-slug>] [--ext-dep <squad>/<slug>]...   (remove the wait; the loop clears the pause it made)
  drop-ext-dep     <file> <slug> <squad>/<slug>    (stop waiting on it, e.g. a missing peer unit)
  ext-deps-status  <file> <slug>    (per ext dep: <squad>/<slug>\\t<done|dispatched|planned|closed-done|missing>)
  unit-tier        <file> <slug>    (prints the unit's Builder tier; untagged or unknown = hard)
  set-unit-tier    <file> <slug> <standard|hard>    (standard -> hard also marks it escalated)
  ready-units      <file>    (planned, non-held units whose deps and ext deps are all satisfied and not waiting — dispatchable now; a dep on a cancelled unit counts when its work landed elsewhere, see cancel-unit)
  set-unit-hold    <file> <slug> on|off [--why <text>]    (on requires a reason and a planned unit; off releases only a reasoned hold)
  set-unit-urgent  <file> <slug> on|off [--why <text>]    (on marks a planned or dispatched unit urgent — its Builder starts next, even at max_builders; refused on done or cancelled; off releases it)
  set-unit-wait    <file> <slug> <epoch>    (no account/model free: hold the unit until then; "" clears)
  set-unit-status  <file> <slug> <planned|dispatched|done> [builder_worktree_id] [--no-pr]   (refuses done/dispatched on a cancelled unit — set it planned to revive it, which clears the cancel fields; refuses done without a recorded PR unless --no-pr, and on the loop's store refuses done while the recorded PR is not observed MERGED — the loop marks it done on the merge)
  set-unit-pr      <file> <slug> <pr-number>    (record the unit's PR; "" clears it)
  cancel-unit      <file> <slug> [--into <unit-slug|U<n>|#N|PR#N>] [--why <text>] [--check]   (writes a cancellation wish; the loop closes the Builder, removes its dirty worktree and closes its open PR while preserving branches)
  add-leftover     <file> <wt> <path> <branch> <reason> <waits_on> [--unit <slug>] [--file <f>]... [--n-files <n>] [--unpushed <n>]   (record a worktree that couldn't be removed without losing work; upsert by wt)
  drop-leftover    <file> <wt>
  leftovers        <file>    (one line per leftover: wt\\tpath\\tbranch\\tn_files\\tunpushed\\twaits_on)
  set-into-merged  <file> <slug>    (the cancelled unit's into-PR merged — its dependents unblock)
  approve-plan     <file> <plan>    (record operator approval of a plan; durable)
  revoke-plan      <file> <plan> --why <text> [--keep-started]   (take a plan approval back: out of approved_plans, its approved copy moved to <plan>.revoked-<stamp>.md, kept in revoked_plans; queued Builders of its units dropped, started ones paused until approve-plan again — --keep-started leaves them; one line per unit; not approved = a no-op)
  plan-approved    <file> <plan>    (prints yes/no; empty plan = ad-hoc = yes)
  propose-squad    <file> <id> <topic> <repo> <framing>   (testing squad: propose a fix squad)
  set-proposal-status <file> <id> <proposed|approved|spawned>
  set-devenv       <file> <where-the-dev-env-is-reachable>
  add-cleanup      <file> <shell-command>    (run on close; e.g. stop a stack)
  add-assignment   <file> <builder> <unit> <thinker>    (legacy; derived from members)
  set-repo         <file> <repo-selector>
  set-host         <file> <saved-env-or-empty>
  set-framing      <file> <framing-text>
  set-debrief      <file> <text> | --file <path>   (the squad's short debrief — six parts, the sixth a feature squad's "Try it" — written before set-status done; empty is refused; also records debrief_at and debrief_units)
  set-spawn        <file> <repo> <host> <framing>   (all three at once)
  set-type         <file> <feature|testing>
  set-autonomy     <file> <checkpoints|lfg>
  set-status       <file> <running|blocked|waiting-on-you|suspended|done|failed>   (done refuses while a feature squad has a unit dispatched, planned or held — a unit is done when its PR merges — without a debrief, and, for a feature squad, a debrief without its "Try it" part)
  enqueue-question <file> <id> <asker> <blocking:true|false> <question> [card_wt] [suggestion] [why] [options A|B|C] [title] [choices JSON [{label,does}]] [picker JSON {source,tool_use_id,transcript_path,picker_answerable}] [pr number] [doc_path]
  resolve-question <file> <id> [--answer <text>] [--via terminal|picker|board|reality]   (clears card_wt's NEEDS YOU note once no open question uses it; the loop's store keeps the answer)
  answered-questions <file> [--limit N] [--before <seq>]   (answered questions, newest first: seq\\tid\\tanswered_at\\tvia\\ttitle\\tanswer; none before the loop's switch)
  log-assumption   <file> <decision> <rationale>`;

// --- exits and output ------------------------------------------------------------------------------
class Exit extends Error { constructor(readonly code: number, msg = "") { super(msg); } }
function die(code: number, msg = ""): never { throw new Exit(code, msg); }
const usage = (): never => die(2, USAGE);
function write(fd: number, s: string): void {
  try { writeSync(fd, s); } catch (e) { if ((e as { code?: string }).code !== "EPIPE") throw e; }
}
const say = (s: string) => write(1, s + "\n");
const warn = (s: string) => write(2, s + "\n");

// --- jq semantics ----------------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
type Doc = Record<string, J>;
const truthy = (v: J) => v !== undefined && v !== null && v !== false;
const alt = (v: J, d: J) => (truthy(v) ? v : d);                       // `v // d`
const arr = (v: J): J[] => (Array.isArray(v) ? v : []);                 // `(v // [])` over a list
function rank(v: J): number {
  if (v === undefined || v === null) return 0;
  if (v === false) return 1;
  if (v === true) return 2;
  return typeof v === "number" ? 3 : typeof v === "string" ? 4 : Array.isArray(v) ? 5 : 6;
}
// jq's total order: null < false < true < numbers < strings < arrays < objects.
function cmp(a: J, b: J): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) return a - b;
  if (ra === 4) return a < b ? -1 : a > b ? 1 : 0;
  if (ra === 5) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  if (ra === 6) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(), c = cmp(ka, kb);
    if (c) return c;
    for (const k of ka) { const d = cmp(a[k], b[k]); if (d) return d; }
  }
  return 0;
}
const eq = (a: J, b: J) => cmp(a, b) === 0;
function unique(xs: J[]): J[] {
  return [...xs].sort(cmp).filter((x, i, s) => i === 0 || !eq(s[i - 1], x));
}
const has = (xs: J[], x: J) => xs.some((y) => eq(y, x));
const lower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());   // ascii_downcase
const interp = (v: J) => (typeof v === "string" ? v : JSON.stringify(v ?? null));   // "\(v)"
const raw = (v: J) => (typeof v === "string" ? v : JSON.stringify(v ?? null, null, 2));   // jq -r
function tsv(vs: J[]): string {   // @tsv
  return vs.map((v) => (v === undefined || v === null ? "" : typeof v === "string"
    ? v.replace(/[\\\t\n\r]/g, (c) => ({ "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r" })[c] as string) : String(v))).join("\t");
}
const todate = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
// Doc timestamps and ready-units read the wall clock, as jq's `now` did (DS_NOW pins only db times).
const nowDate = () => todate(Math.floor(Date.now() / 1000));

// --- paths -----------------------------------------------------------------------------------------
// Plan paths are stored and compared canonical: a relative one is anchored at the dev-studio root
// (the state root's parent, where state/ lives — the same anchor the loop's ready.ts uses, so the
// two agree whatever the caller's cwd), `~/x.md` expands against $HOME, then realpath -m resolves
// symlinks as far as the path exists. So `state/dev-studio/squads/x-plan.md`, its absolute form and
// `~/.dev-studio/state/.../x-plan.md` all compare equal. (Kept in sync with
// bin/loop/squad/plan-approved.ts canonPath by hand; this one anchors at stateRoot().)
const canonCache = new Map<string, string>();
function canonPath(p: string): string {
  const root = stateRoot();
  if (p.startsWith("~/")) p = `${process.env.HOME ?? ""}/${p.slice(2)}`;
  else if (!p.startsWith("/")) {
    let dev = dirname(resolve(root));
    try { dev = realpathSync(dev); } catch { /* not there yet */ }
    p = join(dev, p);
  }
  const key = `${root}\0${p}`;
  let c = canonCache.get(key);
  if (c === undefined) {
    // realpath -m: symlinks resolved as far as the path exists, the rest kept as written.
    let head = resolve(p);
    const tail: string[] = [];
    for (;;) {
      try { c = join(realpathSync(head), ...tail); break; } catch { /* not there yet */ }
      if (head === "/") { c = resolve(p); break; }
      tail.unshift(basename(head));
      head = dirname(head);
    }
    canonCache.set(key, c);
  }
  return c;
}
// R4: approving a plan saves a byte-for-byte copy beside it (temp file, then rename); a plan that is not a file saves none.
function saveApprovedCopy(plan: string): void {
  try {
    if (!statSync(plan).isFile()) return;
    const to = approvedCopyPath(plan);
    const tmp = `${to}.tmp-${process.pid}`;
    writeFileSync(tmp, readFileSync(plan));
    renameSync(tmp, to);
  } catch { /* not a file or not writable: the approval stands */ }
}
const canon = (v: J) => (alt(v, "") === "" ? "" : canonPath(String(v)));
// A plan path typed on the command line: a relative path that exists from the current directory is
// that file; otherwise today's dev-studio-root rule (canonPath) applies. Stored paths use canon().
function cliPlanPath(p: string): string {
  if (!p.startsWith("/") && !p.startsWith("~/") && existsSync(resolve(p))) return canonPath(resolve(p));
  return canonPath(p);
}

// ext_deps are "<squad>/<slug>" refs to another squad's unit in the same label dir.
function needExtRef(r: string): void {
  const ok = r.includes("/") && !/\/.*\//.test(r) && !r.startsWith("/") && !r.endsWith("/") && !r.startsWith(".") && !r.includes("/.");
  if (!ok) die(2, `squad-state: invalid ext dep '${r}' (want <squad>/<slug>)`);
}

// --- backends --------------------------------------------------------------------------------------
type Answer = { id: string; text: string; via: questions.Via };
interface Backend {
  raw(): string;                                        // `get`
  load(): Doc;
  update<T>(fn: (doc: Doc) => T, answer?: Answer): T;   // load, change, save — all or nothing
  sibling(squad: string): Doc | null;                   // another squad of the same label dir
  answered(opts: { limit?: number; before?: number }): Doc[];
}

function fileText(file: string): string | null {   // null: missing or empty -> a first write
  let size: number;
  try { size = statSync(file).size; } catch { return null; }
  if (size === 0) return null;
  let doc: J;
  try { const t = readFileSync(file, "utf8"); doc = JSON.parse(t); if (truthy(doc)) return t; } catch { /* corrupt */ }
  // A file that EXISTS but doesn't parse is corruption: never reset it to DEFAULT (that drops
  // units/assignments/queue and makes the loss invisible). Fail loud so the operator fixes it.
  return die(1, `squad-state: ${file} exists but is not valid JSON — refusing to reset it (would lose units/assignments). Inspect or restore it, then retry.`);
}
const fileDoc = (file: string): Doc => JSON.parse(fileText(file) ?? DEFAULT);
function siblingDoc(file: string, squad: string): Doc | null {
  try { const d = JSON.parse(readFileSync(join(dirname(file), `${squad}.json`), "utf8")); return truthy(d) ? d : null; } catch { return null; }
}

class JsonBackend implements Backend {
  constructor(readonly file: string) {}
  raw() { return fileText(this.file) ?? DEFAULT; }
  load() { return fileDoc(this.file); }
  // Atomic write: a temp file in the same directory, renamed over the target, so a crash leaves
  // either the old file or the new one, never a partial.
  update<T>(fn: (doc: Doc) => T): T {
    const doc = this.load(), r = fn(doc), dir = dirname(this.file);
    let tmp = "";
    for (let i = 0; !tmp; i++) {
      const t = join(dir, `.squad-state.${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`);
      try { writeFileSync(t, render(doc), { flag: "wx", mode: 0o600 }); tmp = t; } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST" || i > 100) {
          die(1, `mktemp: failed to create file via template '${dir}/.squad-state.XXXXXX': ${(e as { code?: string }).code === "ENOENT" ? "No such file or directory" : (e as Error).message}`);
        }
      }
    }
    renameSync(tmp, this.file);
    return r;
  }
  sibling(squad: string) { return siblingDoc(this.file, squad); }
  answered() { return []; }
}

class StoreBackend implements Backend {
  private s: Store | null = null;
  constructor(readonly file: string, readonly project: string, readonly topic: string, readonly cmd: string, readonly args: string[]) {}
  get store(): Store { return (this.s ??= open()); }
  // The squad's rows, unless it has none yet or was closed: then the file it starts from. close-squad.sh
  // archives a squad by removing its file (until U13b makes it a wish), so no file is no live squad:
  // a re-spawn of the topic starts from the default, as it did before the store.
  private row(topic = this.topic): Doc | null {
    if (!existsSync(join(dirname(this.file), `${topic}.json`))) return null;
    const r = this.store.db.query("SELECT 1 FROM squads WHERE project = ? AND topic = ? AND doc IS NOT NULL AND COALESCE(status, '') != 'closed'").get(this.project, topic);
    return r ? squadDoc(this.store, this.project, topic) : null;
  }
  raw() { const d = this.row(); return d ? render(d) : fileText(this.file) ?? DEFAULT; }
  load() { return this.row() ?? fileDoc(this.file); }
  update<T>(fn: (doc: Doc) => T, answer?: Answer): T {
    const { store, project, topic } = this, db = store.db;
    const r = store.tx(() => {
      // The mark survives a rollback, so after the checkout back and before the install, this write
      // would overwrite what the sweep wrote with the rows from before the rollback (U18). Once the
      // host is on the loop the rows are the truth, and a hand edit of the file changes nothing.
      if (this.row() && writtenElsewhere(store, project, topic, this.file) && rowsMayBeBehind(store.root)) reimportSquad(store, store.root, project, topic, warn);
      const doc = this.load(), out = fn(doc);
      store.fact("squad_state", docRows(project, topic, doc, now()), { project, squad: topic, payload: { cmd: this.cmd, args: this.args } });
      db.run("UPDATE members SET status = 'running' WHERE project = ? AND squad = ? AND doc IS NOT NULL AND (status IS NULL OR status = 'gone')", [project, topic]);
      pruneSquad(store, project, topic, doc);
      if (answer) questions.answer(store, project, topic, answer.id, answer.text, answer.via);
      questions.sync(store, project, topic, arr(doc.waiting_on_you));
      return out;
    });
    try { exportJson(store, store.root, { project, topic }); } catch (e) { warn(`squad-state: warning: could not export ${this.file}: ${(e as Error).message}`); }
    return r;
  }
  sibling(squad: string) {
    return this.row(squad) ?? siblingDoc(this.file, squad);
  }
  answered(opts: { limit?: number; before?: number }) { return questions.list(this.store, this.project, this.topic, opts); }
}

// The store serves <state root>/<project>/squads/<topic>.json once the root carries the migrated mark.
function backend(file: string, cmd: string, args: string[]): Backend {
  const root = stateRoot();
  if (!file.endsWith(".json") || !existsSync(join(root, ".loop-migrated"))) return new JsonBackend(file);
  const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const dir = real(dirname(resolve(file))), topic = basename(file, ".json");
  if (!topic || basename(dir) !== "squads" || dirname(dirname(dir)) !== real(root)) return new JsonBackend(file);
  return new StoreBackend(file, basename(dirname(dir)), topic, cmd, args);
}

// --- shared rules ----------------------------------------------------------------------------------
// worktrees[]/assignments[] are DERIVED from members (bin/loop/squad/derive.ts, the one shared rule),
// so every existing reader keeps working.
const unitsOf = (doc: Doc): J[] => arr(doc.units);
const firstUnit = (units: J[], slug: J) => units.find((u) => u?.slug === slug) ?? null;

// The state (OPEN, CLOSED, MERGED) the loop last observed for a unit's PR, or null when it has no row:
// found the way the lifecycle reconciler's prRow finds it (by `<nwo>#<pr>`, else by `<topic>/<slug>`).
function observedPrState(b: StoreBackend, doc: Doc, slug: string, pr: string): string | null {
  const { store, project, topic } = b, m = pr.match(/(\d+)\/?$/);  // lifecycle.ts num(): '#12', a URL
  if (!m) return null;
  const n = Number(m[1]);
  const repo = (store.get("squads", { project, topic })?.repo as string | undefined) || (typeof doc.repo === "string" ? doc.repo : "");
  const nwo = repo ? (store.get("config", { project, file: "github", key: `repo:${repo}` })?.value as string) || "" : "";
  const row = (nwo && store.get("observed_prs", { project, ref: `${nwo}#${n}` }))
    || (store.db.query("SELECT * FROM observed_prs WHERE project = ? AND ref = ? AND pr = ?").get(project, `${topic}/${slug}`, n) as Row | null);
  return row?.state ? String(row.state) : null;
}

// satisfied(s, self): dep slug s counts for dependent self. A dep on a CANCELLED unit counts when its
// work landed elsewhere: folded into this unit itself, into a unit that is done (cancelled->cancelled
// chains followed, 10 hops), or into a PR that merged (into_merged). The board (U3) mirrors this.
function satisfied(units: J[], s: J, self: J): boolean {
  const chase = (t: J, n: number): boolean => {
    const hit = firstUnit(units, t);
    if (n > 10 || hit === null) return false;
    if (hit.status === "done") return true;
    if (hit.status !== "cancelled") return false;
    const into = alt(hit.superseded_by, "");
    if (into === "") return false;
    if (into === self) return true;
    if (String(into).startsWith("PR#")) return hit.into_merged === true;
    return chase(into, n + 1);
  };
  return chase(s, 0);
}
const dropped = (t: J) => t?.status === "cancelled" && alt(t.superseded_by, "") === "";
const DROPPED = "(cancelled, work dropped — drop the dep or replan)";

// --- wait-on ---------------------------------------------------------------------------------------
// A started unit that must wait for another unit (a fix-first ruling): the dep joins `deps` (or `ext_deps`)
// and the reason is kept in `wait_on` (dep -> why), so a register-plan re-run keeps the wait. The loop's
// dependency-waits reconciler pauses the Builder from it. Returns the new units, or null when nothing changes.
function waitOn(us: J[], slug: string, dep: string, why: string, fail: (msg: string) => never): J[] | null {
  const u = firstUnit(us, slug);
  if (!u) return fail(`no unit '${interp(slug)}'`);
  if (u.status === "done" || u.status === "cancelled") return fail(`unit '${interp(slug)}' is ${u.status}; nothing to wait for`);
  if (arr(u.deps).includes(dep) || arr(u.ext_deps).includes(dep)) return null;
  if (dep === slug) return fail(`unit '${interp(slug)}' cannot wait on itself`);
  if (!dep.includes("/") ) {
    if (!firstUnit(us, dep)) return fail(`no unit '${dep}' to wait on`);
    const seen = new Set<string>(), walk = (s: string): boolean => {
      if (s === slug) return true;
      if (seen.has(s)) return false;
      seen.add(s);
      return arr(firstUnit(us, s)?.deps).some((x) => walk(raw(x)));
    };
    if (walk(dep)) return fail(`'${interp(slug)}' waiting on '${dep}' would make a dependency cycle`);
  }
  const key = dep.includes("/") ? "ext_deps" : "deps";
  return us.map((x) => (x?.slug === slug ? { ...x, [key]: [...arr(x[key]), dep], wait_on: { ...(x.wait_on ?? {}), [dep]: why } } : x));
}
const waitOff = (us: J[], slug: string, dep: string): J[] => us.map((x) => {
  if (x?.slug !== slug) return x;
  const n = { ...x, deps: arr(x.deps).filter((d) => d !== dep) }, wo = { ...(x.wait_on ?? {}) };
  delete wo[dep];
  if (arr(x.ext_deps).length) { const e = arr(x.ext_deps).filter((d) => d !== dep); if (e.length) n.ext_deps = e; else delete n.ext_deps; }
  if (Object.keys(wo).length) n.wait_on = wo; else delete n.wait_on;
  return n;
});

// --- register-plan ---------------------------------------------------------------------------------
const squash = (t: string, cap: number) => { const x = t.replace(/\s+/g, " ").trim(); return x.length > cap ? x.slice(0, cap - 1) + "…" : x; };
// A unit's text is its block: the lines after the unit line up to the next unit line, a heading or `---`.
// A label may be indented, flush or a bullet, bold or plain (`  Done: x`, `Done: x`, `- **Done:** x`, `**Done:** x`).
// What/Goal/What it does fill about (the first wins), Done and Check fill theirs; any other label ends the
// current one and is not stored. A label's continuation lines run until a blank line, another label or bullet.
const LABEL = /^\s*(?:[-*]\s+)?(?:\*\*)?([A-Z][A-Za-z0-9\/-]*(?: [A-Za-z0-9\/-]+){0,5}?)(?::\*\*|\*\*:|:)\s?(.*)$/;
function unitText(lines: string[], at: number): UnitText {
  const parts: Record<string, string[]> = {};
  let cur: string | null = null;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (UNIT_LINE.test(l) || /^#{1,6}\s/.test(l) || /^\s*---+\s*$/.test(l)) break;
    if (l.trim() === "") { cur = null; continue; }
    const m = l.match(LABEL);
    if (m) {
      const k = m[1].toLowerCase();
      const key = k === "what" || k === "goal" || k === "what it does" ? "what" : k === "done" || k === "check" ? k : null;
      if (key === null || (key === "what" && parts.what)) { cur = null; continue; }
      cur = key;
      (parts[cur] ??= []).push(m[2].replace(/^\*\*\s*/, ""));
    } else if (/^\s*[-*]\s+/.test(l)) cur = null;
    else if (cur) parts[cur].push(l);
  }
  const t: UnitText = {};
  if (parts.what) t.about = squash(parts.what.join(" "), 1200);
  if (parts.done) t.done = squash(parts.done.join(" "), 400);
  if (parts.check) t.check = squash(parts.check.join(" "), 400);
  return t;
}
const pfx = (id: string) => lower(id) + "-";
function planError(msg: string): never { return die(1, `squad-state: register-plan: ${msg}`); }
// parseLine lives in the pure plan-lines.ts (KTD3); a bad line there is a PlanLineError, here a register-plan exit 1.
function parseLine(n: number, line: string): PlanUnit {
  try { return parsePlanLine(n, line); } catch (e) { if (e instanceof PlanLineError) planError(e.message); throw e; }
}

function autoslug(id: string, title: string): string {
  const bt = [...title.matchAll(/`(u[0-9]+[a-z]?-[a-z0-9._-]+)`/gi)].map((m) => m[1]).filter((s) => lower(s).startsWith(pfx(id)));
  if (bt.length) return bt[0];
  const k = lower(title.replace(/^\s*\[[^\]]*\]\s*/, "")).replace(/[^a-z0-9]+/g, "-").split("-").filter((x) => x !== "").slice(0, 4).join("-");
  return (lower(id) + (k === "" ? "" : "-" + k)).slice(0, 32).replace(/-+$/, "");
}

const laneFields = (p: PlanUnit) => (p.lane === null ? {} : { lane: p.lane, ...(p.laneRule === null ? {} : { lane_rule: p.laneRule }) });
function withoutLane(u: J): J { const { lane: _l, lane_rule: _r, ...rest } = u; return rest; }
// title/about/done/check follow the plan line on every re-registration; a field the plan no longer carries is dropped.
const textFields = (p: PlanUnit) => ({ title: p.title, ...p.text });
function withoutText(u: J): J { const { title: _t, about: _a, done: _d, check: _c, ...rest } = u; return rest; }

// Upsert one unit per unit line of the plan; returns the printed rows and the notes for stderr.
function registerPlan(st: Doc, planText: string, P: string): { rows: string[]; notes: string[]; ext: { slug: string; ref: string }[] } {
  const U = unitsOf(st);
  const L = planText.split("\n").flatMap((line, i) => (UNIT_LINE.test(line) ? [{ ...parseLine(i + 1, line), text: unitText(planText.split("\n"), i) }] : []));
  if (!L.length) planError(`no unit lines in ${P} (want \`U<n> — <title> — deps: … — Tier: …\`, conventions/plan-shape.md step d)`);
  const dup = unique(L.map((p) => p.id).filter((id, i, all) => all.indexOf(id) !== i));
  if (dup.length) planError(`unit id ${dup.join(", ")} appears more than once in ${P}`);
  // Match each plan unit to an existing one: (plan, plan_unit) first, else adopt a legacy unit.
  type M = PlanUnit & { idx: number | null; how: string; slug: J };
  const M: M[] = [];
  const taken: J[] = U.map((u) => u?.slug ?? null);
  for (const p of L) {
    const m1 = U.flatMap((u, i) => (canon(u.plan) === P && u.plan_unit === p.id ? [i] : []));
    const m2 = U.flatMap((u, i) => (u.status !== "done" && alt(u.plan_unit, "") === "" && ["", P].includes(canon(u.plan))
      && lower(String(u.slug)).startsWith(pfx(p.id)) ? [i] : []));
    if (m1.length) M.push({ ...p, idx: m1[0], how: "match", slug: U[m1[0]].slug });
    else if (m2.length > 1) planError(`line ${p.n}: ${p.id} could adopt more than one unit (${m2.map((i) => interp(U[i].slug)).join(", ")}) — fix the state by hand`);
    else if (m2.length === 1) M.push({ ...p, idx: m2[0], how: "adopted", slug: U[m2[0]].slug });
    else {
      const base = autoslug(p.id, p.title);
      let slug = base;
      for (let i = 2; has(taken, slug); i++) slug = `${base}-${i}`;
      // Same plan file name under another directory: the same plan, typed with a different path.
      const dupe = U.find((u) => u.plan_unit === p.id && alt(u.plan, "") !== "" && canon(u.plan) !== P && basename(canon(u.plan)) === basename(P));
      if (dupe) planError(`line ${p.n}: ${p.id} is already registered from ${canon(dupe.plan)} — same plan under another path? pass that path`);
      M.push({ ...p, idx: null, how: "added", slug });
      taken.push(slug);
    }
  }
  // Deps: an id in this plan -> its slug; else a unit in state with that plan_unit; else a unique u<n>- slug.
  const R = M.map((p) => ({ ...p, deps: p.deps.map((d) => {
    const inPlan = M.filter((x) => x.id === d).map((x) => x.slug);
    const byId = U.filter((u) => u.plan_unit === d).map((u) => u.slug);
    const byPfx = U.filter((u) => lower(String(u.slug)).startsWith(pfx(d))).map((u) => u.slug);
    if (inPlan.length === 1) return inPlan[0];
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) planError(`line ${p.n}: ${p.id} dep ${d} matches more than one unit (${byId.map(interp).join(", ")})`);
    if (byPfx.length === 1) return byPfx[0];
    if (byPfx.length > 1) planError(`line ${p.n}: ${p.id} dep ${d} matches more than one unit (${byPfx.map(interp).join(", ")})`);
    return planError(`line ${p.n}: ${p.id} dep ${d} is not in this plan or the squad state`);
  }) }));
  // A re-run never touches status/builder_wt/pr/wait_until/ext_deps/escalated; an escalated unit stays hard.
  // hold: only a PLAN hold is released, when its line no longer says HELD (hold_by "plan", or no marker and
  // matched by (plan, plan_unit)). A hold with a hold_reason, another hold_by, or one that comes from
  // add-unit --hold (adopted: marked hold_by "parked") stays. A line that adds HELD later never re-holds.
  // U3: a "revalidate after resume" hold that approve-plan marked revalidated (the plan approved
  // again) is freed here; an unmarked one waits for the Thinker, a unit the plan dropped stays held.
  const approved = arr(st.approved_plans).some((a) => canon(a) === P);
  const released: string[] = [];
  const out = R.map((p) => {
    const old = p.idx === null ? null : U[p.idx];
    let nu: J;
    if (old === null) nu = { slug: p.slug, status: "planned", builder_wt: "", plan: P, plan_unit: p.id, deps: p.deps, ...(p.ext.length ? { ext_deps: p.ext } : {}), hold: p.held, ...(p.held ? { hold_by: "plan" } : {}), tier: p.tier, ...laneFields(p), ...textFields(p) };
    else {
      nu = { ...withoutText(withoutLane(old)), plan: P, plan_unit: p.id, deps: unique([...p.deps, ...Object.keys(old.wait_on ?? {}).filter((k) => !k.includes("/"))]), ...(p.ext.length || arr(old.ext_deps).length ? { ext_deps: unique([...arr(old.ext_deps), ...p.ext]) } : {}), tier: old.escalated === true ? "hard" : p.tier, ...laneFields(p), ...textFields(p), ...(p.text.about === undefined && p.how === "adopted" && old.about ? { about: old.about } : {}) };
      const bare = truthy(alt(old.hold, false)) && alt(old.hold_reason, "") === "";
      if (bare && alt(old.hold_by, "") === "" && p.how === "adopted") nu.hold_by = "parked";
      else if (bare && !p.held && !["done", "cancelled"].includes(String(old.status)) && (old.hold_by === "plan" || (alt(old.hold_by, "") === "" && p.how === "match"))) {
        nu.hold = false; delete nu.hold_by; released.push(`note: released plan hold on ${interp(p.slug)} (HELD dropped from ${P})`);
      } else if (approved && truthy(alt(old.hold, false)) && old.hold_reason === REVALIDATE_WHY && old.revalidated === true && old.status === "planned") {
        nu.hold = false; delete nu.hold_reason; delete nu.revalidated; released.push(`note: released the "${REVALIDATE_WHY}" hold on ${interp(p.slug)} (${P} approved again)`);
      }
    }
    return { p, old, nu, status: old === null ? "added" : p.how === "adopted" ? "adopted" : eq(old, nu) ? "unchanged" : "updated" };
  });
  const repl = new Map(out.filter((o) => o.p.idx !== null).map((o) => [o.p.idx as number, o.nu]));
  const used = new Set(R.flatMap((p) => (p.idx === null ? [] : [p.idx])));
  let all: J[] = [...U.map((u, i) => repl.get(i) ?? u), ...out.filter((o) => o.old === null).map((o) => o.nu)];
  // `— blocks: U109`: each named unit waits on this one (wait-on), the plan being the reason. All-or-nothing.
  const waits: string[] = [];
  for (const p of R) for (const b of p.blocks) {
    const inPlan = M.filter((x) => x.id === b).map((x) => x.slug), byId = all.filter((u) => u.plan_unit === b).map((u) => u.slug);
    const byPfx = all.filter((u) => lower(String(u.slug)).startsWith(pfx(b))).map((u) => u.slug);
    const hit = [inPlan, byId, byPfx].find((c) => c.length > 0) ?? [];
    if (hit.length !== 1) planError(`line ${p.n}: ${p.id} blocks: ${b} ${hit.length ? "matches more than one unit" : "is not in this plan or the squad state"}`);
    const next = waitOn(all, String(hit[0]), String(p.slug), `blocked by ${p.id} (${P})`, (msg) => planError(`line ${p.n}: ${p.id} blocks: ${b}: ${msg}`));
    if (next) { all = next; waits.push(`${interp(hit[0])} now waits on ${interp(p.slug)}`); }
  }
  st.units = all;
  return {
    ext: R.flatMap((p) => p.ext.map((ref) => ({ slug: String(p.slug), ref }))),
    rows: out.map((o) => { const d = arr(firstUnit(all, o.nu.slug)?.deps); return `${interp(o.nu.slug)}\t${o.status}\t${interp(o.nu.tier)}\t${d.length ? d.map(interp).join(",") : "-"}`; }),
    notes: [...released, ...waits.map((w) => `note: ${w}`), ...out.filter((o) => o.status === "adopted").map((o) => `adopted ${interp(o.nu.slug)} as ${o.p.id}`),
      ...U.flatMap((u, i) => (canon(u.plan) === P && !used.has(i) ? [`note: '${interp(u.slug)}' has no unit line in ${P} — left as is`] : [])),
      ...(approved ? [] : [`note: ${P} is not approved yet — plan-approved says no until approve-plan records it`])],
  };
}

// Status of another squad's unit, from the sibling squad and that squad's archives (close-squad
// writes archive/<squad>-<ts>.json with .topic). Fail-closed: absent = missing. done in the live
// squad -> done; else done in an archive -> closed-done; else the live status.
function extStatus(file: string, b: Backend, ref: string): string {
  const squad = ref.slice(0, ref.indexOf("/")), slug = ref.slice(ref.indexOf("/") + 1);
  const sdir = dirname(file), ldir = basename(sdir) === "squads" ? dirname(sdir) : sdir;
  const live = b.sibling(squad);
  const st = live ? alt(arr(live.units).filter((u) => u?.slug === slug).map((u) => u.status)[0], "") : "";
  if (st === "done") return "done";
  let names: string[] = [];
  try { names = [...new Bun.Glob(`${squad}-*.json`).scanSync({ cwd: join(ldir, "archive"), onlyFiles: false })].sort(); } catch { /* no archive */ }
  for (const f of names) {
    let d: J;
    try { d = JSON.parse(readFileSync(join(ldir, "archive", f), "utf8")); } catch { continue; }
    const topic = alt(d?.topic, "");
    const mine = topic === squad || (topic === "" && /^[0-9]{8}-[0-9]{6}\.json$/.test(f.slice(squad.length + 1)));
    if (mine && arr(d?.units).some((u) => u?.slug === slug && u.status === "done")) return "closed-done";
  }
  return st === "" ? "missing" : raw(st);
}
const extDone = (file: string, b: Backend, doc: Doc): string[] => unique(unitsOf(doc).filter((u) => u?.status === "planned").flatMap((u) => arr(u.ext_deps)))
  .filter((r) => ["done", "closed-done"].includes(extStatus(file, b, r)));

// --- the command table -----------------------------------------------------------------------------
function main(argv: string[]): void {
  if (argv.length < 2) usage();
  const [file, cmd, ...a] = argv;
  const need = (n: number) => { if (a.length < n) usage(); };
  const b = backend(file, cmd, a);
  const set = <T,>(fn: (doc: Doc) => T): T => b.update(fn);
  // A done squad that gets open work is running again in the same write, so the loop seats its Builders
  // (slot.ts leaves out every done squad). Only status `done` moves; a close in flight (squads.want = 'gone')
  // keeps it done. A held unit alone does not reopen it (settle()'s planned/dispatched lists).
  type Reopen = { kind: "none" } | { kind: "closing" } | { kind: "reopened"; n: number };
  const reopenDone = (d: Doc): Reopen => {
    if (raw(alt(d.status, "")) !== "done") return { kind: "none" };
    const f = settle({ type: d.type, units: arr(d.units), members: [] });
    const n = f.planned.length + f.dispatched.length;
    if (!n) return { kind: "none" };
    if (b instanceof StoreBackend) {
      const w = b.store.db.query("SELECT want FROM squads WHERE project = ? AND topic = ?").get(b.project, b.topic) as { want?: string | null } | null;
      if (w?.want === "gone") return { kind: "closing" };
    }
    d.status = "running";
    return { kind: "reopened", n };
  };
  const reopenNote = (r: Reopen): void => {
    if (r.kind === "closing") return warn("squad-state: note: squad is closing; left done");
    if (r.kind !== "reopened") return;
    warn(`squad-state: note: squad was done; set back to running for ${r.n} open unit(s)`);
    const sd = dirname(file);
    if (basename(sd) !== "squads") return;
    const j = spawnSync(join(dirname(dirname(import.meta.dir)), "role", "journal.sh"), [basename(dirname(sd)), basename(file, ".json"), "lead", "add", "decision",
      "squad set back to running", "register-plan/add-unit added open work to a done squad"], { stdio: "ignore" });
    if (j.status !== 0) warn("squad-state: warning: journal note failed (continuing)");
  };
  const units = (doc: Doc, fn: (u: J) => J) => { doc.units = unitsOf(doc).map((u) => (u?.slug === a[0] ? fn(u) : u)); };
  const value = (i: number, msg: string) => { if (i + 1 >= a.length) die(2, msg); return a[i + 1]; };

  switch (cmd) {
    case "get": return void write(1, b.raw());
    case "set-task": need(1); return set((d) => { d.task_id = a[0]; });
    case "set-run": need(1); return set((d) => { d.run_id = a[0]; });
    case "set-lead": need(1); return set((d) => { d.lead_wt = a[0]; });
    case "add-worktree": need(1); return set((d) => { d.worktrees = unique([...arr(d.worktrees), a[0]]); });
    case "add-member": {
      // The squad's full roster: one entry per member (Lead + roles + fanned workers), recording role,
      // suffix, worktree, what it owns (plans for a Thinker, unit(s) for a Builder, env for a Tester —
      // a LIST), the Thinker it reports to, and spawn params so the squad is replicable.
      need(3);
      const [role, suffix, wt] = a;
      const o = { for: "", agent: "", model: "", effort: "", host: "", account: "" } as Record<string, string>;
      const owns: string[] = [];
      let fallback = false;
      for (let i = 3; i < a.length; i++) {
        const f = a[i], key = f.slice(2);
        if (f === "--fallback") { fallback = true; continue; }
        if (f !== "--owns" && !(key in o && f.startsWith("--"))) die(2, `squad-state: add-member: unexpected arg '${f}'`);
        if (i + 1 >= a.length) die(1, `squad-state: add-member: ${f} needs a value`);
        if (f === "--owns") owns.push(a[++i]); else o[key] = a[++i];
      }
      return set((d) => {
        // Identity is the LABEL (role[-suffix]), not the worktree id: a restarted member keeps its label
        // but gets a NEW wt. Upsert by label, carrying owns/since forward when not re-supplied.
        const lbl = (m: J) => `${m?.role ?? ""}\u0001${alt(m?.suffix, "")}`, me = `${role}\u0001${suffix}`;
        const ms = arr(d.members), same = ms.filter((m) => lbl(m) === me);
        d.members = [...ms.filter((m) => lbl(m) !== me), {
          role, suffix, wt, owns: owns.length ? owns : alt(same[0]?.owns, []), for: o.for, agent: o.agent, model: o.model,
          effort: o.effort, host: o.host, since: alt(same[0]?.since, nowDate()),
          ...(o.account === "" ? {} : { account: o.account }), ...(fallback ? { fallback: true } : {}) }];
        derive(d);
        // A revived unit reusing a leftover worktree owns it again — the record goes.
        d.leftovers = arr(d.leftovers).filter((l) => l?.wt !== wt);
      });
    }
    case "remove-member":
      need(1);
      return set((d) => { d.members = arr(d.members).filter((m) => m?.wt !== a[0]); derive(d); });
    case "rekey-member":
      // Orca rotated a worktree's id: point the member, lead_wt, units[].builder_wt and leftovers at the
      // live id IN PLACE (nothing else about the member changed), then re-derive.
      need(2);
      return set((d) => {
        const [old, nu] = a;
        d.members = arr(d.members).map((m) => (m?.wt === old ? { ...m, wt: nu } : m));
        d.lead_wt = alt(d.lead_wt, "") === old ? nu : d.lead_wt ?? null;
        if (Array.isArray(d.units)) d.units = d.units.map((u: J) => (alt(u?.builder_wt, "") === old ? { ...u, builder_wt: nu } : u));
        d.leftovers = arr(d.leftovers).map((l) => (l?.wt === old ? { ...l, wt: nu } : l));
        derive(d);
      });
    case "add-member-owns":
      need(2);
      return set((d) => { d.members = arr(d.members).map((m) => (m?.wt === a[0] ? { ...m, owns: unique([...arr(m.owns), a[1]]) } : m)); });
    case "set-member-for":
      // Fix a member's `for` in place (add-member would wipe agent/model/effort); re-derives assignments.
      need(2);
      return set((d) => { d.members = arr(d.members).map((m) => (m?.wt === a[0] ? { ...m, for: a[1] } : m)); derive(d, false); });
    case "set-member-model":
      // Record the model a member runs on after a restart, and when (started: the crash window and spawn
      // grace date a start from it; since stays the first spawn, the squad's spend start). Unknown wt is an error.
      need(2);
      return set((d) => {
        if (!arr(d.members).some((m) => m?.wt === a[0])) die(1, `squad-state: set-member-model: no member with wt '${a[0]}'`);
        let i = 2, effort = "";
        if (i < a.length && !a[i].startsWith("--")) effort = a[i++];
        // Each flag given is set; one not given is left as it was. --account "" drops the field (default login).
        const flags: Record<string, string> = {};
        for (; i < a.length; i += 2) {
          if (!["--agent", "--account", "--fallback"].includes(a[i])) die(2, `squad-state: set-member-model: unknown option '${a[i]}'`);
          if (i + 1 >= a.length) die(1, `squad-state: set-member-model: ${a[i]} needs a value`);
          flags[a[i].slice(2)] = a[i + 1];
        }
        d.members = arr(d.members).map((m) => {
          if (m?.wt !== a[0]) return m;
          const n = { ...m, model: a[1], started: nowDate(), placed_at: now(), status: "running" };
          if (b instanceof StoreBackend) b.store.fact("member_placed", [
            { table: "members", key: { project: b.project, squad: b.topic, wt: a[0] }, set: { placed_at: now(), status: "running" } },
          ], { project: b.project, squad: b.topic, member: a[0] });
          if (effort !== "") n.effort = effort;
          if ("agent" in flags) n.agent = flags.agent;
          if ("account" in flags) { if (flags.account === "") delete n.account; else n.account = flags.account; }
          if ("fallback" in flags) { if (flags.fallback === "1" || flags.fallback === "true") n.fallback = true; else delete n.fallback; }
          return n;
        });
        d.units = arr(d.units).map((u) => {
          if (u.builder_wt !== a[0] && !arr(d.members).some((m) => m.wt === a[0] && m.suffix === u.slug)) return u;
          const n = { ...u }; delete n.wait_until; return n;
        });
      });
    case "set-member-wait":
      need(2);
      if (!/^[0-9]+$/.test(a[1])) die(2, "squad-state: set-member-wait: epoch must be digits");
      return set((d) => {
        const m = arr(d.members).find((m) => m.wt === a[0]);
        if (!m) die(1, `squad-state: set-member-wait: no member with wt '${a[0]}'`);
        m.status = "waiting";
        if (b instanceof StoreBackend) b.store.fact("member_waiting", [
          { table: "members", key: { project: b.project, squad: b.topic, wt: a[0] }, set: { status: "waiting" } },
        ], { project: b.project, squad: b.topic, member: a[0] });
        d.units = arr(d.units).map((u) => u.builder_wt === a[0] || u.slug === m.suffix ? { ...u, wait_until: Number(a[1]) } : u);
      });
    case "mark-member-restarting":
      // A restart is under way (U64): until set-member-model stamps the new start, the old dispatch's
      // stop and the gap with no agent are restart-role's own doing, not a standing role's crash.
      need(1);
      return set((d) => { d.members = arr(d.members).map((m) => (m?.wt === a[0] ? { ...m, restarting: nowDate() } : m)); });
    case "set-repo": need(1); return set((d) => { d.repo = a[0]; });
    case "set-host": need(1); return set((d) => { d.host = a[0] === "" ? null : a[0]; });
    case "set-framing": need(1); return set((d) => { d.framing = a[0]; });
    case "set-debrief": {
      // The squad's debrief (set out to do / shipped / learned / still open / cost): set-status done
      // needs one. It rides in the doc, so the archive keeps it with the squad.
      need(1);
      let text = a[0];
      if (a[0] === "--file") {
        need(2);
        try { text = readFileSync(a[1], "utf8"); } catch { die(1, `squad-state: set-debrief: cannot read '${a[1]}'`); }
      }
      text = text.trim();
      if (text === "") die(1, "squad-state: set-debrief: refusing an empty debrief");
      // debrief_at and debrief_units say when and over which units: the archive names the units added after it.
      return set((d) => { d.debrief = text; d.debrief_at = nowDate(); d.debrief_units = unitsOf(d).map((u) => u?.slug).filter((x) => typeof x === "string"); });
    }
    case "set-spawn": need(3); return set((d) => { d.repo = a[0]; d.host = a[1] === "" ? null : a[1]; d.framing = a[2]; });
    case "add-unit": {
      // Upsert a plan unit by slug (idempotent). deps = comma-separated slugs it waits on (a DAG: it is
      // dispatchable once every dep is done). --hold marks a minor follow-up ready-units never surfaces;
      // --tier is the Thinker's Builder tier (omitted = read as hard); --ext-dep another squad's unit.
      need(1);
      let hold = false, tier = "", slug = "", about = "";
      const pos: string[] = [];
      let ext: string[] = [];
      for (let i = 0; i < a.length; i++) {
        if (a[i] === "--hold") hold = true;
        else if (a[i] === "--tier") tier = value(i++, "squad-state: --tier needs a value (standard|hard)");
        else if (a[i] === "--about") about = squash(value(i++, "squad-state: --about needs a value (what the unit does)"), 1200);
        else if (a[i] === "--ext-dep") { const x = value(i++, "squad-state: --ext-dep needs a value (<squad>/<slug>)"); needExtRef(x); ext = unique([...ext, x]); }
        else if (slug === "") slug = a[i];
        else pos.push(a[i]);
      }
      if (slug === "") usage();
      if (!["", "standard", "hard"].includes(tier)) die(2, `squad-state: invalid tier '${tier}' (standard|hard)`);
      // A plan's units go through register-plan; these nudge an ad-hoc add-unit that drops a field.
      if (tier === "") warn(`squad-state: warning: no --tier, unit '${slug}' reads as hard`);
      if (!pos[1] && !hold) warn(`squad-state: warning: no plan for '${slug}' — plan-approved will read it as ad-hoc`);
      // A unit's plan is stored canonical absolute (like register-plan and approve-plan), so a
      // relative plan still matches the approval whatever the caller typed.
      const planArg = pos[1] ?? "";
      const reopened = set((d) => {
        const us = unitsOf(d);
        d.units = us.some((u) => u?.slug === slug) ? us : [...us, { slug, status: "planned", builder_wt: pos[0] ?? "", plan: planArg === "" ? "" : cliPlanPath(planArg),
          deps: (pos[2] ?? "").split(",").filter((x) => x !== ""), hold, ...(tier === "" ? {} : { tier }), ...(about === "" ? {} : { about }), ...(ext.length ? { ext_deps: ext } : {}) }];
        return reopenDone(d);
      });
      return reopenNote(reopened);
    }
    case "register-plan": {
      // Register every unit line of an approved plan (conventions/plan-shape.md step d) in one go,
      // all-or-nothing: a refusal (exit 1) writes nothing.
      need(1);
      let planText: string;
      const planPath = cliPlanPath(a[0]);
      try { if (!statSync(planPath).isFile()) throw new Error(); planText = readFileSync(planPath, "utf8"); } catch { return die(1, `squad-state: register-plan: cannot read plan '${a[0]}'`); }
      let reopened: Reopen = { kind: "none" };
      const res = set((d) => { const r = registerPlan(d, planText, planPath); reopened = reopenDone(d); return r; });
      for (const n of res.notes) warn(`squad-state: ${n}`);
      reopenNote(reopened);
      // U46: a ref to a squad or unit that does not exist is reported, not refused; the unit waits and the loop raises one card.
      for (const x of res.ext) if (extStatus(file, b, x.ref) === "missing") warn(`squad-state: note: ${interp(x.slug)} waits on ${interp(x.ref)}, which is not a known squad unit — fix it with drop-ext-dep / add-ext-dep`);
      for (const r of res.rows) say(r);
      return;
    }
    case "wait-on":
    case "wait-off": {
      need(2);
      const refs: string[] = [], pos: string[] = [];
      let why = "";
      for (let i = 1; i < a.length; i++) {
        if (a[i] === "--ext-dep") { const x = value(i++, "squad-state: --ext-dep needs a value (<squad>/<slug>)"); needExtRef(x); refs.push(x); }
        else if (a[i] === "--why" && cmd === "wait-on") why = value(i++, `squad-state: ${cmd}: --why needs text`);
        else pos.push(a[i]);
      }
      if (pos.length > 1) usage();
      const deps = unique([...pos, ...refs]);
      if (!deps.length) usage();
      if (cmd === "wait-on" && !why.trim()) die(2, "squad-state: wait-on requires --why <text>");
      for (const x of refs) if (extStatus(file, b, x) === "missing") die(1, `squad-state: wait-on: no unit '${x}' in another squad`);
      return set((d) => {
        let us = unitsOf(d), changed = false;
        if (!firstUnit(us, a[0])) die(1, `squad-state: ${cmd}: no unit '${a[0]}'`);
        for (const dep of deps) {
          if (cmd === "wait-on") {
            const next = waitOn(us, a[0], dep, why, (m) => die(1, `squad-state: wait-on: ${m}`));
            if (next) { us = next; changed = true; }
          } else if (arr(firstUnit(us, a[0])?.deps).includes(dep) || arr(firstUnit(us, a[0])?.ext_deps).includes(dep)) { us = waitOff(us, a[0], dep); changed = true; }
        }
        if (!changed) die(0);
        d.units = us;
      });
    }
    case "add-ext-dep":
    case "drop-ext-dep":
      // Edit a unit's ext_deps after add-unit; drop-ext-dep is how the Lead unblocks a unit whose peer is missing.
      need(2);
      needExtRef(a[1]);
      return set((d) => {
        if (!unitsOf(d).some((u) => u?.slug === a[0])) die(1, `squad-state: ${cmd}: no unit '${a[0]}'`);
        units(d, (u) => {
          const cur = arr(u.ext_deps), e = cmd === "add-ext-dep" ? unique([...cur, a[1]]) : cur.filter((x) => !eq(x, a[1]));
          const n = { ...u };
          if (e.length) n.ext_deps = e; else delete n.ext_deps;
          return n;
        });
      });
    case "ext-deps-status": {
      need(1);
      const doc = b.load();
      for (const r of unique(unitsOf(doc).filter((u) => u?.slug === a[0]).flatMap((u) => arr(u.ext_deps)))) say(`${raw(r)}\t${extStatus(file, b, raw(r))}`);
      return;
    }
    case "unit-tier":
      need(1);
      return say(raw(unitsOf(b.load()).filter((u) => u?.slug === a[0] && truthy(u.tier)).map((u) => u.tier)[0] ?? "hard"));
    case "set-unit-tier":
      need(2);
      if (a[1] !== "standard" && a[1] !== "hard") die(2, `squad-state: invalid tier '${a[1]}' (standard|hard)`);
      return set((d) => units(d, (u) => {
        const n = { ...u };
        if (u.tier === "standard" && a[1] === "hard") n.escalated = true; else if (a[1] === "standard") delete n.escalated;
        n.tier = a[1];
        return n;
      }));
    case "ready-units": {
      // Planned units whose EVERY dep is satisfied -> dispatchable now (the Lead fans them out each tick).
      // An ext dep counts only when the peer unit is done (live or archived); missing blocks.
      const doc = b.load(), us = unitsOf(doc), xd = extDone(file, b, doc), t = Date.now() / 1000;
      const waits = b instanceof StoreBackend ? questions.waiting(b.store, b.project, b.topic).map(questions.entryOf) : arr(doc.waiting_on_you);
      const given = b instanceof StoreBackend ? slotted(b.store, b.project, t) : null;
      for (const u of us.filter((x) => x?.status === "planned")) {
        if (truthy(alt(u.hold, false)) || questions.blockingForUnit(waits, raw(u.slug))) continue;
        if (!arr(u.deps).every((s) => satisfied(us, s, u.slug))) continue;
        if (arr(u.ext_deps).some((x) => !has(xd, x))) continue;
        if (cmp(alt(u.wait_until, 0), t) > 0) continue;
        // max_builders (U146): only the unit a free Builder slot would go to is ready.
        if (given && !given.has(`${b.topic}\0${raw(u.slug)}`)) continue;
        say(raw(u.slug));
      }
      // A dep whose work was dropped blocks forever — say so on stderr (stdout stays slugs).
      for (const dep of unique(us.filter((x) => x?.status === "planned").flatMap((x) => arr(x.deps)))) {
        if (dropped(firstUnit(us, dep))) warn(`blocked by ${interp(dep)} ${DROPPED}`);
      }
      return;
    }
    case "set-unit-hold": {
      need(2);
      const mode = a[1];
      if (!["on", "off"].includes(mode)) die(2, "squad-state: set-unit-hold: want on|off");
      let why = "";
      for (let i = 2; i < a.length; i++) {
        if (a[i] !== "--why") usage();
        why = value(i++, "squad-state: set-unit-hold: --why needs text");
      }
      if (mode === "on" && !why.trim()) die(2, "squad-state: set-unit-hold on requires --why <text>");
      return set((d) => {
        const u = firstUnit(unitsOf(d), a[0]);
        if (!u) die(1, `squad-state: unit '${a[0]}' not found`);
        if (mode === "on" && u.status !== "planned") die(1, `squad-state: set-unit-hold on requires a planned unit (slug '${a[0]}')`);
        if (u.hold && !u.hold_reason) {
          if (mode === "off" && (u.hold_by === "plan" || (alt(u.hold_by, "") === "" && alt(u.plan_unit, "") !== ""))) die(1, `squad-state: '${a[0]}' is a plan hold — drop HELD from its line in ${alt(u.plan, "its plan")} and re-run register-plan after approval (approve-handoff.sh)`);
          die(1, "squad-state: hold has no reason — promote with set-unit-status … dispatched / add-role … builder at triage (conventions/state.md)");
        }
        if (mode === "on" && u.hold && u.hold_reason !== why) die(1, `squad-state: unit '${a[0]}' is already held for a different reason`);
        if ((mode === "on" && u.hold) || (mode === "off" && !u.hold)) die(0);
        units(d, (u) => {
          const n = { ...u, hold: mode === "on" };
          if (mode === "on") n.hold_reason = why; else { delete n.hold_reason; delete n.revalidated; }
          return n;
        });
        // U1: a Builder queued for it and not started yet goes with the hold, in the same write.
        if (mode === "on" && b instanceof StoreBackend)
          for (const m of unitWishes(b.store, b.project, b.topic, String(u.slug))) withdraw(b.store, m, "held", "set-unit-hold", why);
      });
    }
    case "set-unit-urgent": {
      // A unit the operator needs first (U168): its Builder ranks ahead of every non-urgent
      // candidate and starts even at max_builders. Lives on the unit like hold, doc-only (no
      // migration); register-plan re-runs keep it (the re-run only touches plan/plan_unit/deps/tier).
      need(2);
      const mode = a[1];
      if (!["on", "off"].includes(mode)) die(2, "squad-state: set-unit-urgent: want on|off");
      let why = "";
      for (let i = 2; i < a.length; i++) {
        if (a[i] !== "--why") usage();
        why = value(i++, "squad-state: set-unit-urgent: --why needs text");
      }
      return set((d) => {
        const u = firstUnit(unitsOf(d), a[0]);
        if (!u) die(1, `squad-state: unit '${a[0]}' not found`);
        if (u.status !== "planned" && u.status !== "dispatched") die(1, `squad-state: set-unit-urgent ${mode} requires a planned or dispatched unit (slug '${a[0]}')`);
        if (mode === "off" && !u.urgent) die(0);
        units(d, (u) => {
          const n = { ...u };
          if (mode === "on") {
            n.urgent = true;
            if (why !== "") n.urgent_why = why; else delete n.urgent_why;
          } else {
            delete n.urgent;
            delete n.urgent_why;
          }
          return n;
        });
      });
    }
    case "set-unit-wait":
      // No account/model is free for this unit's Builder: hold it until <epoch> (ready-units skips it).
      need(2);
      if (a[1] !== "" && !/^[0-9]+$/.test(a[1])) die(2, "squad-state: set-unit-wait: epoch must be digits");
      return set((d) => units(d, (u) => { const n = { ...u }; if (a[1] === "") delete n.wait_until; else n.wait_until = Number(a[1]); return n; }));
    case "set-unit-status": {
      need(2);
      const st = a[1];
      if (!["planned", "dispatched", "done"].includes(st)) die(2, `squad-state: invalid unit status '${st}'`);
      // A unit whose Builder stopped without a PR is not done: done without a recorded PR is refused;
      // --no-pr states it truly has none (local-only, no-code).
      let bwt = a[2] ?? "", noPr = a[3] === "--no-pr";
      if (bwt === "--no-pr") { noPr = true; bwt = ""; }
      return set((d) => {
        // A cancelled unit only goes back to planned (which revives it) — so a Builder that finished
        // before the cancel can't silently resurrect it.
        if (st !== "planned" && unitsOf(d).some((u) => u?.slug === a[0] && u.status === "cancelled")) {
          die(1, `squad-state: unit is cancelled — set it planned to revive it (slug '${a[0]}')`);
        }
        if (st === "done" && !noPr && arr(d.units).some((u) => u?.slug === a[0] && alt(u.pr, "") === "")) {
          die(1, `squad-state: unit '${a[0]}' has no PR — record it with set-unit-pr, or pass --no-pr if it truly has none`);
        }
        // A unit with a recorded PR is done only once that PR merged: until then its Builder stays to
        // fix checks, conflicts and review threads, and the loop marks the unit done and retires the
        // Builder on the merge (lifecycle.ts 1b/1c). --no-pr does not skip this: it claims there is no
        // PR, and there is one. The file backend has no loop to mark it done, so it keeps the old rule.
        const prUnit = st === "done" && b instanceof StoreBackend ? firstUnit(unitsOf(d), a[0]) : null;
        if (prUnit && alt(prUnit.pr, "") !== "") {
          const pr = String(prUnit.pr), state = observedPrState(b as StoreBackend, d, a[0], pr);
          if (state !== "MERGED") {
            const said = state === null ? "has no observed state yet (the loop has not read it)" : `is ${state.toLowerCase()}`;
            const closed = state === "CLOSED" ? "; a closed PR needs a new PR (set-unit-pr) or cancel-unit" : "";
            die(1, `squad-state: unit '${a[0]}' is not done — its PR #${pr} ${said}. The loop marks the unit done and closes its Builder when the PR merges${closed}`);
          }
        }
        units(d, (u) => {
          const n = { ...u, status: st };
          if (st === "planned" && u.status === "cancelled" && b instanceof StoreBackend) {
            const m = b.store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND wt = ? ORDER BY id DESC").get(b.project, b.topic, u.builder_wt ?? "") as Row | null;
            if (m) clearCancellationWish(b.store, m, a[0]);
          }
          if (st === "dispatched") delete n.wait_until;
          if (st === "planned") for (const k of ["superseded_by", "cancel_reason", "cancelled_at", "into_merged"]) delete n[k];
          if (bwt !== "") n.builder_wt = bwt;
          return n;
        });
      });
    }
    case "set-unit-pr": {
      // <pr> is '#123', '123' or a GitHub PR URL ending in /pull/<n>; the bare number is stored. "" clears it.
      need(1);
      const given = a[1] ?? "";
      let pr = given.startsWith("#") ? given.slice(1) : given;
      pr = pr.match(/^https?:\/\/\S+\/pull\/([0-9]+)\/?$/)?.[1] ?? pr;
      if (pr !== "" && !/^[0-9]+$/.test(pr)) die(1, `squad-state: set-unit-pr: '${given}' is not a PR — pass #123, 123, or a GitHub .../pull/<n> URL`);
      return set((d) => units(d, (u) => { const n = { ...u }; if (pr === "") delete n.pr; else n.pr = pr; return n; }));
    }
    case "cancel-unit": return cancelUnit(file, a, b);
    case "add-leftover": {
      // A worktree that couldn't be removed without losing work (close-role keeps it; the sweep drops it
      // once provably safe). Upsert by wt; files keeps the first 20 names (n_files carries the total).
      need(5);
      const [wt, path, branch, reason, waits] = a;
      let unit = "", n = "", up = "";
      const files: string[] = [];
      for (let i = 5; i < a.length; i++) {
        const f = a[i];
        if (!["--unit", "--file", "--n-files", "--unpushed"].includes(f)) die(2, `squad-state: add-leftover: unexpected arg '${f}'`);
        const v = value(i++, `squad-state: add-leftover: ${f} needs a value`);
        if ((f === "--n-files" || f === "--unpushed") && !/^[0-9]+$/.test(v)) die(2, `squad-state: add-leftover: ${f} must be digits`);
        if (f === "--unit") unit = v; else if (f === "--file") files.push(v); else if (f === "--n-files") n = v; else up = v;
      }
      return set((d) => {
        d.leftovers = [...arr(d.leftovers).filter((l) => l?.wt !== wt), { wt, path, branch, reason, waits_on: waits, files: files.slice(0, 20),
          n_files: n === "" ? files.length : Number(n), unpushed: up === "" ? 0 : Number(up), recorded_at: nowDate(), ...(unit === "" ? {} : { unit }) }];
      });
    }
    case "drop-leftover": need(1); return set((d) => { d.leftovers = arr(d.leftovers).filter((l) => l?.wt !== a[0]); });
    case "leftovers":
      for (const l of arr(b.load().leftovers)) {
        say(tsv([l.wt, l.path, l.branch, interp(alt(l.n_files, 0)), interp(alt(l.unpushed, 0)), l.waits_on]));
      }
      return;
    case "set-into-merged":
      // The sweep calls this when a cancelled unit's into-PR merges — its dependents unblock.
      need(1);
      return set((d) => {
        if (!unitsOf(d).some((u) => u?.slug === a[0] && u.status === "cancelled")) die(1, `squad-state: set-into-merged: unit '${a[0]}' is not cancelled`);
        units(d, (u) => ({ ...u, into_merged: true }));
      });
    case "approve-plan":
      // The operator's approval of a plan (the `plan drafted` checkpoint): durable, so a restarted Lead
      // never re-builds an unapproved plan or re-asks for a nod already given.
      need(1);
      return set((d) => {
        const p = cliPlanPath(a[0]);
        d.approved_plans = unique([...arr(d.approved_plans), p]);
        saveApprovedCopy(p);
        // U3: approving the plan again after a resume is its revalidation: its held units are marked,
        // and the Lead's register-plan of it frees them with the revised deps.
        d.units = unitsOf(d).map((u) => (u?.status === "planned" && truthy(alt(u.hold, false)) && u.hold_reason === REVALIDATE_WHY && canon(u.plan) === p ? { ...u, revalidated: true } : u));
      });
    case "revoke-plan": return revokePlan(a, b);
    case "plan-approved": {
      // An EMPTY plan id is ad-hoc / operator-directed work (no gated plan) -> yes.
      if (!a[0]) return say("yes");
      const p = cliPlanPath(a[0]);
      return say(arr(b.load().approved_plans).some((x) => canon(x) === p) ? "yes" : "no");
    }
    case "propose-squad":
      // A testing squad's Thinker triages a confirmed bug into a proposed FIX squad for operator
      // approval (/ds-approve-fix spawns it). Upsert by id.
      need(4);
      return set((d) => {
        d.proposed_squads = [...arr(d.proposed_squads).filter((p) => p?.id !== a[0]),
          { id: a[0], topic: a[1], repo: a[2], framing: a[3], status: "proposed", since: nowDate() }];
      });
    case "set-proposal-status":
      need(2);
      if (!["proposed", "approved", "spawned"].includes(a[1])) die(2, `squad-state: invalid proposal status '${a[1]}'`);
      return set((d) => { d.proposed_squads = arr(d.proposed_squads).map((p) => (p?.id === a[0] ? { ...p, status: a[1] } : p)); });
    case "set-devenv": need(1); return set((d) => { d.devenv = a[0]; });
    case "add-cleanup":
      // A teardown command close-squad runs (a dev server, a docker stack started detached). No dup.
      need(1);
      return set((d) => { d.cleanup = unique([...arr(d.cleanup), a[0]]); });
    case "add-assignment":
      need(3);
      return set((d) => { d.assignments = [...arr(d.assignments), { builder: a[0], unit: a[1], thinker: a[2] }]; });
    case "set-autonomy":
      need(1);
      if (a[0] !== "checkpoints" && a[0] !== "lfg") die(2, `squad-state: invalid autonomy '${a[0]}'`);
      return set((d) => { d.autonomy = a[0]; });
    case "set-type":
      need(1);
      if (a[0] !== "feature" && a[0] !== "testing") die(2, `squad-state: invalid type '${a[0]}'`);
      return set((d) => { d.type = a[0]; });
    case "set-status": {
      need(1);
      if (!["running", "blocked", "waiting-on-you", "suspended", "done", "failed"].includes(a[0])) die(2, `squad-state: invalid status '${a[0]}'`);
      const prev = set((d) => {
        // A squad is done only once every unit landed (a unit is done when its PR merges — the sweep marks
        // it): a feature squad refuses while any unit is dispatched, planned or held (settle()'s lists,
        // squad-done-definition U2); a testing squad keeps the dispatched-only rule. A Tester member or no
        // units does not refuse.
        if (a[0] === "done") {
          const us = arr(d.units);
          const f = settle({ type: d.type, units: us, members: [] });
          const feature = String(alt(d.type, "feature")) === "feature";
          const lines: string[] = [];
          if (f.dispatched.length) {
            const disp = us.filter((u) => u?.status === "dispatched")
              .map((u) => `${interp(u.slug)} (${alt(u.pr, "") !== "" ? `PR #${interp(u.pr)}` : "no PR"})`).join(", ");
            lines.push(`unit(s) still dispatched — ${disp} — a unit is done when its PR merges (the sweep marks it) — merge its PR, or cancel-unit <slug> --why "<why>"`);
          }
          if (feature) {
            const by = (slug: string) => us.find((u) => String(u?.slug ?? "?") === slug);
            for (const slug of f.planned) {
              const hd = f.waiting.includes(slug) ? arr(by(slug)?.deps).map(String).filter((x) => f.held.includes(x)) : [];
              lines.push(hd.length ? `unit ${slug} is planned and not started — waits on held ${hd.join(", ")}; cancelling ${hd.join(", ")} cancels it too — cancel-unit ${slug} --why "<why>", or leave it for its Builder`
                : `unit ${slug} is planned and not started — cancel-unit ${slug} --why "<why>", or leave it for its Builder`);
            }
            for (const slug of f.held) {
              const u = by(slug);
              if (alt(u?.hold_reason, "") !== "") lines.push(`unit ${slug} is held (${interp(u.hold_reason)}) — set-unit-hold ${slug} off, or cancel-unit ${slug} --why "<why>"`);
              else if (u?.hold_by === "plan" || (alt(u?.hold_by, "") === "" && alt(u?.plan_unit, "") !== "")) lines.push(`unit ${slug} is held by its plan — drop HELD from the plan line and register-plan again, or cancel-unit ${slug} --why "<why>"`);
              else lines.push(`unit ${slug} is a held follow-up — promote it with add-role.sh <project> <topic> builder ${slug}, or cancel-unit ${slug} --why "<why>"`);
            }
          }
          if (lines.length) die(1, `squad-state: refusing done: ${lines.join("\n  ")}\n  or leave the squad parked; it is not done`);
          if (typeof d.debrief !== "string" || d.debrief.trim() === "") die(1, `squad-state: refusing done: no debrief — write one first: squad-state.sh ${file} set-debrief "<6 parts: set out to do / shipped (PR #s) / learned / still open / cost / Try it>"`);
          // A feature squad's debrief carries a "Try it" part (brief-other-prs U3): a line that starts, after an optional list marker or **, with "Try it".
          if (feature && !/^[ \t]*(?:\*\*|__)?(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:\*\*|__)?[ \t]*try it/im.test(d.debrief)) die(1, `squad-state: refusing done: the debrief has no "Try it" part — add as a sixth part, as the Thinker gave it: "6. **Try it:** 1. <where, what to do, what you should see> …" (1-5 steps that work on main), or one line "Try it: nothing to try by hand — <why>"`);
        }
        const was = raw(alt(d.status, ""));
        d.status = a[0];
        return was;
      });
      // Journal the finish in the Lead's journal (state/<project>/squads/<topic>.json locates it).
      // Best-effort: a note that can't be written warns but never undoes the status write.
      if (a[0] === "done" && prev !== "done") {
        const sd = dirname(file);
        if (basename(sd) !== "squads") return warn(`squad-state: warning: '${file}' is not state/<project>/squads/<topic>.json — skipping journal note`);
        const r = spawnSync(join(dirname(dirname(import.meta.dir)), "role", "journal.sh"), [basename(dirname(sd)), basename(file, ".json"), "lead", "add", "decision",
          "squad set to done", "squad-state.sh set-status done: no unit still open, handed to the operator for /ds-close-squad"], { stdio: "ignore" });
        if (r.status !== 0) warn("squad-state: warning: journal note failed (continuing)");
      }
      return;
    }
    case "enqueue-question": {
      need(4);
      if (a[2] !== "true" && a[2] !== "false") die(2, "squad-state: blocking must be true|false");
      // A bad choices/picker JSON fails as jq's --argjson did.
      const parse = (s: string) => {
        try { return JSON.parse(s); } catch {
          warn("jq: invalid JSON text passed to --argjson\nUse jq --help for help with command-line options,\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq");
          return die(1, "squad-state: refusing to write empty/invalid state");
        }
      };
      const [id, asker, , q, wt = "", sug = "", why = "", opts = "", title = "", , , pr = "", docPath = ""] = a;
      const choices = parse(a[9] || "[]"), picker = parse(a[10] || "{}");
      return set((d) => {
        d.waiting_on_you = [...arr(d.waiting_on_you).filter((e) => e?.id !== id), {
          id, asker, blocking: a[2] === "true", question: q, since: nowDate(),
          ...(wt === "" ? {} : { card_wt: wt }), ...(sug === "" ? {} : { suggestion: sug }), ...(why === "" ? {} : { why }),
          ...(opts === "" ? {} : { options: opts.split("|").filter((x) => x !== "") }), ...(title === "" ? {} : { title }),
          ...(eq(choices, []) ? {} : { choices }), ...(/^[0-9]+$/.test(pr) ? { pr: Number(pr) } : {}), ...(docPath === "" ? {} : { doc_path: docPath }),
          ...Object.fromEntries(Object.entries(picker ?? {}).filter(([, v]) => v !== null && v !== "")) }];
      });
    }
    case "resolve-question": {
      need(1);
      const id = a[0];
      let text = "", via: questions.Via = "terminal";
      for (let i = 1; i < a.length; i++) {
        if (a[i] === "--answer") text = value(i++, "squad-state: resolve-question: --answer needs a value");
        else if (a[i] === "--via") {
          const v = value(i++, "squad-state: resolve-question: --via needs a value (terminal|picker|board|reality)");
          if (!(questions.VIAS as readonly string[]).includes(v)) die(2, `squad-state: resolve-question: invalid --via '${v}' (terminal|picker|board|reality)`);
          via = v as questions.Via;
        }
      }
      const { wt, left } = b.update((d) => {
        const wy = arr(d.waiting_on_you);
        const wt = alt(wy.filter((e) => e?.id === id).map((e) => e.card_wt)[0], "");
        d.waiting_on_you = wy.filter((e) => e?.id !== id);
        // The last answer also ends waiting-on-you (set by ask-operator.sh).
        if (d.status === "waiting-on-you" && d.waiting_on_you.length === 0) d.status = "running";
        return { wt: raw(wt), left: d.waiting_on_you.filter((e: J) => e?.card_wt === wt).length };
      }, { id, text, via });
      // Answered: clear the asker's "NEEDS YOU" card note (set by ask-operator.sh) unless another open
      // question still sits on that card. Best-effort — the board is already right.
      if (wt !== "" && left === 0) {
        const r = spawnSync(process.env.BACKEND || join(dirname(dirname(import.meta.dir)), "backend", "orca.sh"), ["ping", wt, ""], { stdio: "ignore" });
        if (r.status !== 0) warn(`squad-state: answered, but could not clear the NEEDS YOU note on ${wt}`);
      }
      return;
    }
    case "answered-questions": {
      const opts: { limit?: number; before?: number } = {};
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== "--limit" && a[i] !== "--before") die(2, `squad-state: answered-questions: unexpected arg '${a[i]}'`);
        const v = value(i, `squad-state: answered-questions: ${a[i]} needs a value`);
        if (!/^[0-9]+$/.test(v)) die(2, `squad-state: answered-questions: ${a[i]} must be digits`);
        opts[a[i] === "--limit" ? "limit" : "before"] = Number(v);
        i++;
      }
      for (const r of b.answered(opts)) {
        say(tsv([r.seq, r.id, r.answered_at === null ? null : todate(Number(r.answered_at)), r.answered_via, r.title ?? r.question, r.answer]));
      }
      return;
    }
    case "log-assumption":
      need(2);
      return set((d) => { d.lfg_assumptions = [...arr(d.lfg_assumptions), { decision: a[0], rationale: a[1], at: nowDate() }]; });
    default:
      usage();
  }
}

// Fold a unit's work elsewhere: it becomes `cancelled` (recording what superseded it), its Builder row
// stays until the loop closes it, and the sweep's questions about that Builder clear. Every refusal exits 1 having written
// nothing. close-role.sh --cancel calls it (state only; the Builder's terminals and worktree are
// loop's job). Idempotent: a second run on a cancelled unit updates --into/--why only.
function cancelUnit(file: string, a: string[], b: Backend): void {
  if (a.length < 1) usage();
  const slug = a[0];
  let into = "", why = "", check = false;
  for (let i = 1; i < a.length; i++) {
    if (a[i] === "--check") { check = true; continue; }
    if (a[i] !== "--into" && a[i] !== "--why") die(2, `squad-state: cancel-unit: unexpected arg '${a[i]}'`);
    if (i + 1 >= a.length) die(2, `squad-state: cancel-unit: ${a[i]} needs a value`);
    if (a[i] === "--into") into = a[++i]; else why = a[++i];
  }
  // Resolve --into: a unit slug stays it; U<n> resolves to the slug whose plan_unit it is; #N/PR#N
  // becomes PR#N. Absent = the work was dropped, not folded.
  const target = (doc: Doc): string => {
    const us = unitsOf(doc);
    if (!us.some((u) => u?.slug === slug)) die(1, `squad-state: cancel-unit: no unit '${slug}'`);
    if (us.some((u) => u?.slug === slug && u.status === "done")) die(1, `squad-state: cancel-unit: unit '${slug}' is done — merged work can't be cancelled`);
    if (into === "") return "";
    let r: string;
    if (/^(PR)?#[0-9]/.test(into)) {
      const n = (into.startsWith("PR#") ? into.slice(3) : into).replace(/^#/, "");
      if (!/^[0-9]+$/.test(n)) die(1, `squad-state: cancel-unit: --into '${into}' is not a PR number (want #N or PR#N)`);
      r = `PR#${n}`;
    } else if (/^U[0-9]+[a-z]?$/.test(into)) {
      const m = us.filter((u) => u?.plan_unit === into).map((u) => raw(u.slug));
      if (!m.length) die(1, `squad-state: cancel-unit: --into '${into}' matches no unit (no plan_unit ${into} in state)`);
      if (m.length > 1) die(1, `squad-state: cancel-unit: --into '${into}' is ambiguous — use the slug (matches: ${m.join(",")})`);
      r = m[0];
    } else {
      if (!us.some((u) => u?.slug === into)) die(1, `squad-state: cancel-unit: --into '${into}' names no unit in state`);
      r = into;
    }
    if (r === slug) die(1, `squad-state: cancel-unit: --into '${into}' names the unit itself`);
    return r;
  };
  // --check is close-role's preflight: validate everything, print the resolved target, write nothing.
  if (check) { const r = target(b.load()); return say(`into=${r || "none"}`); }
  b.update((d) => {
    const r = target(d), us = unitsOf(d), ms = arr(d.members);
    const bwt = raw(alt(us.filter((u) => u?.slug === slug).map((u) => u.builder_wt)[0], ""));
    const m = bwt === "" ? undefined : ms.find((x) => x?.wt === bwt);
    const label = m ? `${m.role ?? ""}${alt(m.suffix, "") !== "" ? `-${m.suffix}` : ""}` || `builder-${slug}` : `builder-${slug}`;
    d.units = us.map((u) => {
      if (u?.slug !== slug) return u;
      const n = { ...u, status: "cancelled" };
      if (r !== "") n.superseded_by = r;
      if (why !== "") n.cancel_reason = why;
      if (alt(n.cancelled_at, "") === "") n.cancelled_at = nowDate();
      delete n.wait_until;
      return n;
    });
    if (m && b instanceof StoreBackend && !sharedBuilder(b.store, { project: b.project, squad: b.topic, builder_wt: bwt, slug })) {
      const row = b.store.db.query("SELECT id FROM members WHERE project = ? AND squad = ? AND wt = ? ORDER BY id DESC").get(b.project, b.topic, bwt) as Row | null;
      if (row) b.store.want("member", String(row.id), "gone", { by: "cancel-unit", payload: { cancel: { unit: slug, into: r, why } } });
    }
    // U1: a Builder queued for it and not started yet has no worktree to close; it goes now.
    if (b instanceof StoreBackend)
      for (const q of unitWishes(b.store, b.project, b.topic, slug)) withdraw(b.store, q, "cancelled", "cancel-unit", why || undefined);
    // The sweep's questions about this Builder are `sweep-<topic>.<label>-<cksum>` — matched exactly
    // (anchored both ends, so cancelling builder-u2 never touches builder-u2-fix).
    const lit = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "\\$&");
    const re = new RegExp(`^sweep-${lit(basename(file, ".json"))}\\.${lit(label)}(\\|recheck)?-[0-9]+$`);
    d.waiting_on_you = arr(d.waiting_on_you).filter((e) => !re.test(raw(alt(e?.id, ""))));
    if (d.status === "waiting-on-you" && d.waiting_on_you.length === 0) d.status = "running";
  });
  const doc = b.load(), us = unitsOf(doc);
  const fin = alt(us.filter((u) => u?.slug === slug).map((u) => u.superseded_by)[0], "");
  say(fin === "" ? `cancelled ${slug}` : `cancelled ${slug} -> ${raw(fin)}`);
  // One line per planned dependent, so the Lead sees what this unblocked.
  const xd = extDone(file, b, doc), t = Date.now() / 1000;
  for (const d of us.filter((u) => u?.status === "planned" && arr(u.deps).some((x) => eq(x, slug)))) {
    const unmet = arr(d.deps).filter((s) => !satisfied(us, s, d.slug));
    const unmetx = arr(d.ext_deps).filter((e) => !has(xd, e));
    const self = interp(d.slug);
    if (unmet.length) say(`dependent ${self}: now blocked by ${interp(unmet[0])}${dropped(firstUnit(us, unmet[0])) ? ` ${DROPPED}` : ""}`);
    else if (unmetx.length) say(`dependent ${self}: now blocked by ${interp(unmetx[0])}`);
    else if (truthy(alt(d.hold, false))) say(`dependent ${self}: now blocked (held)`);
    else if (cmp(alt(d.wait_until, 0), t) > 0) say(`dependent ${self}: now blocked (waiting)`);
    else say(`dependent ${self}: now ready`);
  }
}

// hold-cancels-queue-undo-approval U2: take back a plan approval recorded by mistake. The plan leaves
// approved_plans (revoked_plans keeps who, when and why), its approved copy is moved aside (never
// deleted) so ask-operator.sh reads it as never approved, and what the approval set off is undone:
// each not-done unit of the plan loses its queued Builder in this write (queued-builder.ts withdraw,
// whoever filed it, as set-unit-hold and cancel-unit do), and a started Builder gets a dependency
// pause on the plan (work and worktree kept) that approve-plan of it releases (dependency-waits).
// The squad's Lead gets one message. The JSON backend has no Builders to touch: the doc change only.
function revokePlan(a: string[], b: Backend): void {
  if (a.length < 1) usage();
  let why = "", keep = false;
  for (let i = 1; i < a.length; i++) {
    if (a[i] === "--keep-started") { keep = true; continue; }
    if (a[i] !== "--why") die(2, `squad-state: revoke-plan: unexpected arg '${a[i]}'`);
    if (i + 1 >= a.length) die(2, "squad-state: revoke-plan: --why needs text");
    why = a[++i];
  }
  if (!why.trim()) die(2, "squad-state: revoke-plan requires --why <text>");
  const p = cliPlanPath(a[0]);
  if (!arr(b.load().approved_plans).some((x) => canon(x) === p)) return say(`not approved: ${p} — nothing to revoke`);
  const st = b instanceof StoreBackend ? b : null, at = now();
  const from = st ? senderAt(st.store, process.cwd()) : null;
  const by = process.env.DS_WHO || (from && from.role !== "unknown" ? from.role : "operator");
  const lines: string[] = [], dropped: string[] = [], toPause: { slug: string; m: Row }[] = [];
  b.update((d) => {
    d.approved_plans = arr(d.approved_plans).filter((x) => canon(x) !== p);
    d.revoked_plans = [...arr(d.revoked_plans), { plan: p, why, at: todate(at), by }];
    if (st) for (const u of unitsOf(d).filter((u) => canon(u?.plan) === p && !["done", "cancelled"].includes(String(u.status)))) {
      const slug = String(u.slug);
      const queued = unitWishes(st.store, st.project, st.topic, slug);
      for (const m of queued) withdraw(st.store, m, "plan not approved", "revoke-plan", why, at);
      if (queued.length) { dropped.push(slug); lines.push(`${slug}: dropped — its queued Builder never starts`); continue; }
      const m = liveBuilder(st.store, st.project, st.topic, slug, String(u.builder_wt ?? ""));
      if (!m) lines.push(`${slug}: left — no Builder`);
      else if (keep) lines.push(`${slug}: left — Builder ${m.suffix} keeps working (--keep-started)`);
      else toPause.push({ slug, m });
    }
  });
  const paused: string[] = [];
  if (st) for (const { slug, m } of toPause) {
    const r = pauseForPlan(st.store, st.project, st.topic, String(m.suffix ?? ""), p, by, at);
    if (r) lines.push(`${slug}: left — Builder ${m.suffix} could not be paused (${r})`);
    else { paused.push(slug); lines.push(`${slug}: paused — Builder ${m.suffix} waits for the plan's approval (work kept)`); }
  }
  const copy = approvedCopyPath(p), stamp = todate(at).replace(/[-:]/g, "").replace("T", "-").replace("Z", "");
  let moved = "";
  if (existsSync(copy)) {
    const to = `${p.replace(/\.md$/, "")}.revoked-${stamp}.md`;
    try { renameSync(copy, to); moved = to; } catch (e) { warn(`squad-state: revoke-plan: warning: could not move ${copy}: ${(e as Error).message}`); }
  }
  say(`revoked: ${p}${moved ? ` (approved copy moved to ${basename(moved)})` : ""}`);
  for (const l of lines) say(l);
  if (!st) return say("note: no loop store here — no Builder was dropped or paused");
  const { store, project, topic } = st;
  store.event("plan_revoked", { project, squad: topic, payload: { plan: p, why, by, keep_started: keep, dropped, paused, moved: moved || null } });
  if (from!.role === "lead" && from!.squad === topic) return;
  sendMessage(store, { to: { project, squad: topic, role: "lead", suffix: "" }, from: from!,
    subject: `Plan approval taken back: ${basename(p)}`,
    body: [`${by} took back the approval of ${p}: ${why}`, ...lines, "approve-plan of it again releases the paused Builders; the ready units get new Builders."].join("\n"),
    key: `plan-revoked:${project}/${topic}:${p}:${at}` }, at);
}

// The unit's Builder that is not a queued wish: the newest member by slug or by the unit's worktree,
// wished running (a stopped or retired one has nothing to pause).
function liveBuilder(store: Store, project: string, squad: string, slug: string, wt: string): Row | null {
  return store.db.query("SELECT * FROM members WHERE project = ? AND squad = ? AND role = 'builder' AND (suffix = ? OR (? != '' AND wt = ?)) AND COALESCE(want, '') = 'running' ORDER BY id DESC LIMIT 1")
    .get(project, squad, slug, wt, wt) as Row | null;
}

// A dependency pause on the plan; a dependency pause already open (a wait-on) takes the plan as one
// more prerequisite. Returns why it could not, or null.
function pauseForPlan(store: Store, project: string, squad: string, suffix: string, plan: string, by: string, at: number): string | null {
  const ref: Prerequisite = { kind: "plan", project, squad, plan };
  const t = { project, squad, role: "builder", suffix };
  const open = intents(store, t).find((r) => r.scope === "member" && r.source === "dependency");
  if (open) {
    const refs = JSON.parse(String(open.prerequisites ?? "[]")) as Prerequisite[];
    if (!refs.some((r) => r.kind === "plan" && r.plan === plan))
      store.upsert("pause_intents", { scope: "member", project, squad, role: "builder", suffix, source: "dependency" }, { prerequisites: [...refs, ref] });
    return null;
  }
  try { pause(store, { scope: "member", ...t }, { source: "dependency", prerequisites: [ref], by: `revoke-plan (${by})` }, at); return null; }
  catch (e) { return (e as Error).message; }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  if (!(e instanceof Exit)) throw e;
  if (e.message) warn(e.message);
  process.exit(e.code);
}
