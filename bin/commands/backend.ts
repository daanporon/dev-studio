// ds backend — the TypeScript Orca adapter's verbs (U223-U226): bin/backend/orca.sh execs this for every verb,
// and it prints exactly what the shell arm printed.
import { writeSync } from "node:fs";
import { PORTED, runVerb } from "../backend/orca";

export const help = `<verb> [args…] — run an Orca adapter verb (orca.sh execs every one: ${PORTED.join(", ")})`;

/** Write all of it before returning: ds exits right after run(), and a pipe may take it in parts. */
function writeAll(fd: number, b: string | Uint8Array): void {
  const buf = typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b);
  let off = 0;
  while (off < buf.length) {
    try { off += writeSync(fd, buf, off, buf.length - off); }
    catch (e: any) { if (e?.code === "EAGAIN") { Bun.sleepSync(2); continue; } if (e?.code === "EPIPE") return; throw e; }
  }
}

export async function run(argv: string[]): Promise<number> {
  const [verb = "", ...args] = argv;
  const code = await runVerb({ env: process.env, stdin: "inherit", out: (b) => writeAll(1, b), err: (b) => writeAll(2, b) }, verb, args);
  if (code !== null) return code;
  writeAll(2, `orca adapter: unknown op '${verb}'\n`);
  return 2;
}
