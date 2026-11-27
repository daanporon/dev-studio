// update-job.ts — where an update job (bin/commands/update-run.ts) keeps its progress and output, shared with
// the loop's update fulfiller (bin/loop/fulfil/update.ts) that starts it and reads it back.
import { join } from "node:path";

export type UpdateState = "pulling" | "refreshing" | "done" | "failed";
export type UpdateFile = {
  id: number; project: string; pid: number; state: UpdateState; started_at: number; at: number; log: string;
  target?: string;
  line?: string; outcome?: string; warnings?: string[]; host_rc?: number;
  squads_line?: string; need?: string; classes?: string[]; squads_rc?: number; error?: string;
};

export const updateDir = (root: string) => join(root, "loop", "update");
export const updateFiles = (root: string, id: number) => ({ out: join(updateDir(root), `${id}.json`), log: join(updateDir(root), `${id}.log`) });
