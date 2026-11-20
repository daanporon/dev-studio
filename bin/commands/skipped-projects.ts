// ds skipped-projects — the test-named projects under the state root that the loop does not tick (U253).
import { stateRoot } from "../loop/core/store.ts";
import { print } from "../loop/core/cli.ts";
import { skippedProjects } from "../loop/settings/projects.ts";

export const help = "— projects the loop skips because their name is a test prefix (zz*, sstate-*, pickseam-*, _*)";
export async function run(): Promise<number> {
  print(skippedProjects(stateRoot()));
  return 0;
}
