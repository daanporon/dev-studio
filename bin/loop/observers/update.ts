// update.ts — the dev-studio update observer (board-update-button U2): is the host's checkout behind its
// upstream, what would the missing commits ask of the workers, and which projects' squads run an older
// commit. Host scope, one observed_update row. Every git and state-file read for the update banner
// happens here; the board reads the row.
//   every 30 s (cheap): HEAD, update-host's outcome file, each project's squads-rev.json.
//   every DS_LOOP_UPDATE_S (600; 0 = never fetch), or when HEAD moved: the check — fetch the branch (the
//   refspec update-host uses), count behind/ahead, list the newest 20 commits with their paths, look for
//   local changes. The check is one async job the tick never waits for beyond a short budget (the
//   github.ts pattern); its answer is applied on the tick it lands, one in flight at most.
// A failed check keeps behind/commits/checked_at from the last good one and says why (state, error).
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Observer, TickCtx } from "../core/plugins.ts";
import { loopProjects } from "../settings/projects.ts";
import { ROOT } from "../core/store.ts";
import { classify, need, type UpdateClass, type UpdateNeed } from "../../lib/update-classes.ts";
export type Git = (args: string[], o?: { timeoutMs?: number }) => Promise<{ rc: number; out: string; err: string }>;
type Commit = { sha: string; title: string; classes: UpdateClass[] };
type Check = {
  state: "ok" | "detached" | "no_upstream" | "fetch_failed"; head: string; branch: string | null; at: number;
  error?: string; fetched?: boolean;
  upstream?: string; behind?: number; ahead?: number; commits?: Commit[]; classes?: UpdateClass[]; need?: UpdateNeed; dirty?: number;
};
const ORDER: UpdateClass[] = ["skills", "instructions", "code"];
const sorted = (s: Iterable<UpdateClass>) => ORDER.filter((c) => new Set(s).has(c));
const oneLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? "";
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
function everyS(): number {
  const raw = process.env.DS_LOOP_UPDATE_S;
  const v = raw === undefined || raw === "" ? 600 : Number(raw);
  return Number.isInteger(v) && v >= 0 ? v : 600;
}
// One git call through Bun.spawn (never spawnSync), no prompts, killed after timeoutMs.
export function gitIn(root: string): Git {
  return async (args, o = {}) => {
    const p = Bun.spawn(["git", ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
    const timer = o.timeoutMs ? setTimeout(() => p.kill(), o.timeoutMs) : null;
    try {
      const [out, err, rc] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { rc, out, err };
    } finally { if (timer) clearTimeout(timer); }
  };
}
const FETCH_TIMEOUT_MS = 60_000;
async function check(git: Git, fetch: boolean, now: number): Promise<Check> {
  const head = (await git(["rev-parse", "HEAD"])).out.trim();
  const sym = await git(["symbolic-ref", "--short", "-q", "HEAD"]);
  const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).out.trim() === "" ? 0 : 1;
  if (sym.rc !== 0) return { state: "detached", head, branch: null, at: now, dirty, behind: 0, ahead: 0, commits: [], classes: [], need: "none" };
  const branch = sym.out.trim();
  const ref = `refs/remotes/origin/${branch}`;
  let fetched = false;
  if (fetch) {
    const f = await git(["fetch", "origin", "-q", `+refs/heads/${branch}:${ref}`], { timeoutMs: FETCH_TIMEOUT_MS });
    if (f.rc !== 0) {
      // A branch gone from origin: git says it could not find the ref (and the stale local ref must not count).
      const gone = /couldn't find remote ref/i.test(f.err);
      return { state: gone ? "no_upstream" : "fetch_failed", head, branch, at: now, dirty, error: oneLine(f.err) || `git fetch exited ${f.rc}` };
    }
    fetched = true;
  }
  const up = await git(["rev-parse", "--verify", "-q", ref]);
  if (up.rc !== 0) return { state: "no_upstream", head, branch, at: now, dirty, error: `no origin/${branch} to compare with` };
  const upstream = up.out.trim();
  const [ahead, behind] = (await git(["rev-list", "--left-right", "--count", `HEAD...${ref}`])).out.trim().split(/\s+/).map(Number);
  let commits: Commit[] = [], classes: UpdateClass[] = [], n: UpdateNeed = "none";
  if (behind > 0) {
    const log = await git(["log", `HEAD..${ref}`, "-n", "20", "--name-only", "--no-renames", "--format=%x01%H%x02%s"]);
    for (const chunk of log.out.split("\x01").filter((c) => c.trim() !== "")) {
      const [h, rest = ""] = chunk.split("\x02");
      const [title, ...paths] = rest.split("\n");
      commits.push({ sha: h.trim(), title: title.trim(), classes: sorted(classify(lines(paths.join("\n")))) });
    }
    const all = classify(lines((await git(["diff", "--name-only", "--no-renames", "HEAD", ref])).out));
    classes = sorted(all); n = need(all);
  }
  return { state: "ok", head, branch, at: now, dirty, fetched, upstream, behind, ahead, commits, classes, need: n };
}
const readJson = (f: string): Record<string, unknown> | null => {
  try { const v = JSON.parse(readFileSync(f, "utf8")); return v && typeof v === "object" ? v : null; } catch { return null; }
};
export function updateObserver(root = ROOT, opts: { git?: Git; budgetMs?: number } = {}): Observer {
  const git = opts.git ?? gitIn(root);
  let flight: { done: boolean; res?: Check } | null = null;
  let lastTry: number | null = null;                       // epoch s of the last check started
  let checkedHead: string | null = null;                   // HEAD the last check ran for
  const pairs = new Map<string, { classes: UpdateClass[]; need: UpdateNeed; behind: number | null; unknown?: boolean }>();
  // What a project's squads (running `rev`) still lack of HEAD. An unknown commit is a full restart.
  async function squadsBehind(label: string, rev: string, head: string) {
    const k = `${rev}..${head}`;
    let e = pairs.get(k);
    if (!e) {
      const d = await git(["diff", "--name-only", "--no-renames", rev, head]);
      if (d.rc !== 0) e = { classes: [], need: "restart", behind: null, unknown: true };
      else {
        const c = classify(lines(d.out));
        const n = Number((await git(["rev-list", "--count", `${rev}..${head}`])).out.trim());
        e = { classes: sorted(c), need: need(c), behind: Number.isFinite(n) ? n : null };
      }
      pairs.set(k, e);
      if (pairs.size > 200) pairs.delete(pairs.keys().next().value as string);
    }
    return { rev, ...e };
  }
  return {
    name: "update",
    scope: "host",
    every: 30,
    async run(ctx: TickCtx) {
      const { store, now } = ctx;
      const host = hostname();
      const prev = store.get("observed_update", { host });
      const every = everyS();
      if (lastTry === null) lastTry = Math.max(Number(prev?.checked_at ?? 0), Number(prev?.error_at ?? 0));
      const set: Record<string, unknown> = { root, every_s: every, observed_at: now };
      const head = (await git(["rev-parse", "HEAD"])).out.trim();
      if (head !== "") set.head = head;
      // update-host's last outcome, and the projects whose squads run another commit than HEAD.
      const lu = readJson(join(store.root, "loop", "host-update.json"));
      set.last_update = lu ? JSON.stringify(lu) : null;
      const squads: Record<string, unknown> = {};
      if (head !== "") for (const label of loopProjects(store.root)) {
        const f = join(store.root, label, "squads-rev.json");
        const rev = existsSync(f) ? readJson(f)?.rev : null;
        if (typeof rev === "string" && rev !== "" && rev !== head) squads[label] = await squadsBehind(label, rev, head);
      }
      set.squads = JSON.stringify(squads);
      // Apply a check that landed since the last tick (or just now, below).
      const apply = (): boolean => {
        if (!flight?.done) return false;
        const c = flight.res; flight = null;
        if (!c) return true;
        set.root = root; set.branch = c.branch; set.head = c.head; set.state = c.state; set.dirty = c.dirty ?? prev?.dirty ?? null;
        if (c.state === "ok" || c.state === "detached") {
          Object.assign(set, { upstream: c.upstream ?? null, behind: c.behind, ahead: c.ahead, commits: JSON.stringify(c.commits), classes: JSON.stringify(c.classes), need: c.need, error: null, error_at: null });
          if (c.fetched) set.checked_at = c.at;
        } else { set.error = c.error ?? null; set.error_at = c.at; }  // the last good behind/commits/checked_at stay
        return true;
      };
      apply();
      // Due: never checked since this loop started, HEAD moved since the last check, or every_s passed.
      if (!flight && head !== "" && (checkedHead !== head || (every > 0 && now - (lastTry ?? 0) >= every))) {
        lastTry = now; checkedHead = head;
        const f: { done: boolean; res?: Check } = { done: false };
        flight = f;
        const p = check(git, every > 0, now).then((r) => { f.res = r; }, (e) => { f.res = { state: "fetch_failed", head, branch: null, at: now, error: oneLine(String(e?.message ?? e)) }; }).finally(() => { f.done = true; });
        await Promise.race([p, Bun.sleep(opts.budgetMs ?? 1500)]);
        apply();
      }
      store.tx(() => store.upsert("observed_update", { host }, set));
    },
  };
}
export default updateObserver();
