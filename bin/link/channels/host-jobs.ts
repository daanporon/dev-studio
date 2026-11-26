// channels/host-jobs.ts — side-loop-host U5 (issue #127): the side answers main's git and folder jobs (clone,
// worktree add and remove, the remove-safety probe, rescue, ref read and set, push). The job is checked again
// here (host-jobs.ts checkJob) and run with this host's own code; see host-jobs.ts for each job and its answer.
import type { Channel } from "../protocol.ts";
import { CHANNEL, runHere } from "../host-jobs.ts";

const hostJobs: Channel = {
  name: CHANNEL,
  answers: "side",
  handle: (body, ctx) => runHere(body, { root: ctx.root, store: ctx.store }),
};
export default hostJobs;
