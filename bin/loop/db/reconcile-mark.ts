// A changed checkout may leave squad files newer than the stored rows.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const RECONCILE = ".loop-reconcile";
export function rowsMayBeBehind(root: string): boolean {
  return existsSync(join(root, RECONCILE));
}
