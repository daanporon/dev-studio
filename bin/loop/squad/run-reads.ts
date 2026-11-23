// run-reads.ts — the Run's worker list as the members reconciler read it this tick (one run-workers
// per held Run), kept for the shadow (U10, squad/shadow.ts) so it makes no Orca read of its own.
export type RunWorker = { wt: string; live: boolean; dispatch: string | null; task?: string | null; status?: string | null; reported?: boolean };

const reads = new Map<string, { tick: number; workers: RunWorker[] }>();
const key = (project: string, squad: string) => `${project}\u0000${squad}`;

/** members.ts calls this with each Run it read. */
export function noteRunWorkers(project: string, squad: string, tick: number, workers: RunWorker[]): void {
  reads.set(key(project, squad), { tick, workers });
}
/** The Run's workers read this tick, or null when none was. */
export function runWorkers(project: string, squad: string, tick: number): RunWorker[] | null {
  const r = reads.get(key(project, squad));
  return r && r.tick === tick ? r.workers : null;
}
/** Tests: forget every read. */
export function forgetRunWorkers(): void { reads.clear(); }
