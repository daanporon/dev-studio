// ds review-unit-ts — a Builder's code review on the review model (U228): what bin/review/review-unit.sh runs.
import { main } from "../review/review-unit";

export const help = `<project> [<base-ref>] [--full "<reason>"] [--retry "<reason>"] — run a Builder's code review on the review model and write the receipt (review-unit.sh)`;

export async function run(argv: string[]): Promise<number> {
  return main(argv);
}
