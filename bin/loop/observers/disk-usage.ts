// disk-usage.ts — what uses the host's disk (disk-pressure U3). Host scope, rows in observed_disk_usage:
// `docker system df --format json` (skipped when there is no docker) and `du -sk` over each disk_watch_paths
// entry. Both reads are async jobs the tick never waits for beyond a short budget (the update.ts pattern),
// one in flight at most, each killed after 60 s. While a disk-pressure spell is open the reads repeat every
// 30 min (DS_LOOP_DISK_OPEN_S), otherwise every hour (DS_LOOP_DISK_S): a card needs fresh sizes, a quiet host does not.
import type { Observer, TickCtx } from "../core/plugins.ts";
import { envInt } from "../core/tick.ts";
import { KIND, parseDockerDf, watchPaths } from "../squad/disk-pressure.ts";

export type Run = (cmd: string[], timeoutMs: number) => Promise<{ rc: number; out: string } | null>;
const TIMEOUT_MS = 60_000;

// One command through Bun.spawn (never spawnSync), killed after timeoutMs; null when it timed out or cannot start.
export const spawnRun: Run = async (cmd, timeoutMs) => {
  let p: ReturnType<typeof Bun.spawn>;
  try { p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" } }); } catch { return null; }
  let killed = false;
  const timer = setTimeout(() => { killed = true; p.kill(); }, timeoutMs);
  try {
    const [out, rc] = await Promise.all([new Response(p.stdout as ReadableStream).text(), p.exited]);
    return killed ? null : { rc, out };
  } finally { clearTimeout(timer); }
};

type Result = { docker: { rows: ReturnType<typeof parseDockerDf>; error: string | null } | null; du: { path: string; kb: number | null; error: string | null }[]; at: number };

export function diskUsageObserver(opts: { run?: Run; hasDocker?: () => boolean; budgetMs?: number } = {}): Observer {
  const run = opts.run ?? spawnRun, hasDocker = opts.hasDocker ?? (() => Bun.which("docker") !== null);
  let flight: { done: boolean; res?: Result } | null = null;
  let lastTry: number | null = null;
  async function read(paths: string[], at: number): Promise<Result> {
    let docker: Result["docker"] = null;
    if (hasDocker()) {
      const r = await run(["docker", "system", "df", "--format", "json"], TIMEOUT_MS);
      docker = !r ? { rows: [], error: "docker system df timed out" } : r.rc !== 0 ? { rows: [], error: `docker system df exited ${r.rc}` } : { rows: parseDockerDf(r.out), error: null };
    }
    const du: Result["du"] = [];
    for (const path of paths) {
      const r = await run(["du", "-sk", "--", path], TIMEOUT_MS);
      const kb = r ? Number(r.out.split(/\s/)[0]) : NaN;
      du.push(Number.isFinite(kb) && r && r.out.trim() !== "" ? { path, kb, error: null } : { path, kb: null, error: r ? `du exited ${r.rc}` : "du timed out" });
    }
    return { docker, du, at };
  }
  return {
    name: "disk-usage",
    scope: "host",
    every: 30,
    async run(ctx: TickCtx) {
      const { store, now } = ctx;
      const apply = () => {
        if (!flight?.done) return;
        const res = flight.res; flight = null;
        if (!res) return;
        store.tx(() => {
          const put = (key: string, f: Record<string, unknown>) => store.upsert("observed_disk_usage", { key }, { read_at: res.at, observed_at: now, ...f });
          if (res.docker) {
            if (!res.docker.error) {
              const live = new Set(res.docker.rows.map((r) => r.key));
              for (const r of res.docker.rows) put(r.key, { label: r.label, size_kb: r.size_kb, reclaimable_kb: r.reclaimable_kb, error: null });
              for (const r of store.db.query("SELECT key FROM observed_disk_usage WHERE key LIKE 'docker:%'").all() as { key: string }[])
                if (!live.has(r.key)) put(r.key, { size_kb: null, reclaimable_kb: null });
            }
            put("meta:docker", { error: res.docker.error });
          } else put("meta:docker", { error: "no docker binary" });
          const watched = new Set(res.du.map((d) => `du:${d.path}`));
          for (const d of res.du) put(`du:${d.path}`, { label: d.path, ...(d.error ? { error: d.error } : { size_kb: d.kb, error: null }) });
          // A path no longer watched keeps no size for a card to name.
          for (const r of store.db.query("SELECT key FROM observed_disk_usage WHERE key LIKE 'du:%'").all() as { key: string }[])
            if (!watched.has(r.key)) put(r.key, { size_kb: null });
        });
      };
      apply();
      const open = !!store.db.query("SELECT 1 FROM episodes WHERE kind = ? AND ended_at IS NULL LIMIT 1").get(KIND);
      const every = open ? envInt("DS_LOOP_DISK_OPEN_S", 1800) : envInt("DS_LOOP_DISK_S", 3600);
      if (lastTry === null) lastTry = Number((store.db.query("SELECT MAX(read_at) AS t FROM observed_disk_usage").get() as { t: number | null } | null)?.t ?? 0);
      if (flight || every <= 0 || now - lastTry < every) return;
      lastTry = now;
      const f: { done: boolean; res?: Result } = { done: false };
      flight = f;
      const p = read(watchPaths(store), now).then((r) => { f.res = r; }, () => { /* a failed read keeps the old rows */ }).finally(() => { f.done = true; });
      await Promise.race([p, Bun.sleep(opts.budgetMs ?? 1500)]);
      apply();
    },
  };
}
export default diskUsageObserver();
