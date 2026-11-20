// io/du.ts — one `du -sk` of a path through Bun.spawn (never spawnSync), killed after its timeout
// (investigate-disk-cleanup U1). It never follows a symlink given as the path and counts a hard link
// once. A tree it can only partly read still prints its total, and that total is the answer.
export type DuResult = { kb: number } | { error: string };
export type Du = (path: string, timeoutS: number) => Promise<DuResult>;

export const du: Du = async (path, timeoutS) => {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn(["du", "-sk", "--", path], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, LC_ALL: "C" } });
  } catch (e) { return { error: `du did not start: ${(e as Error)?.message ?? e}`.slice(0, 200) }; }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); }, Math.max(1, timeoutS) * 1000);
  const text = new Response(p.stdout as ReadableStream).text(), rc = await p.exited;
  clearTimeout(timer);
  if (timedOut) return { error: `du timed out after ${timeoutS} s` }; // its output is never waited for
  const kb = Number(/^(\d+)\s/.exec(await text)?.[1]);
  return Number.isFinite(kb) ? { kb } : { error: `du exited ${rc}` };
};
