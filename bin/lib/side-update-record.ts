// side-update-record.ts — side-loop-host U24: a side host's one update record, <state root>/link/update.json,
// shared by the job that starts the run (side-update-job.ts) and the run itself (commands/update-host-ts.ts, which
// loads this before it resets the checkout, so it imports nothing of the loop).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type SideUpdateState = "running" | "done" | "failed";
export type SideUpdateRecord = {
  commit: string; run: string; state: SideUpdateState; started_at: number;
  pid?: number | null; unit?: string | null; line?: string;
};

export const sideUpdateFiles = (root: string) => ({ record: join(root, "link", "update.json"), log: join(root, "link", "update.log") });

export function readRecord(root: string): SideUpdateRecord | null {
  try { return JSON.parse(readFileSync(sideUpdateFiles(root).record, "utf8")) as SideUpdateRecord; } catch { return null; }
}
export function writeRecord(root: string, rec: SideUpdateRecord): void {
  const file = sideUpdateFiles(root).record;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec) + "\n");
  renameSync(tmp, file);
}
