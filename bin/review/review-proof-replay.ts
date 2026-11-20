// review-proof-replay.ts — U250: run the review-unit proof over every saved ce-code-review run folder
// and print a table: passed, repaired by field, failed by message. A folder is checked against the HEAD
// and branch its own metadata.json names, so it measures the proof, not the Builder.
//   bun bin/review/review-proof-replay.ts [--root <ce-code-review dir>] [--before] [--wrong-head] [--list <message-prefix>]
//   --before      today's proof: nothing is worked out from the folder (the "before" table)
//   --wrong-head  check each folder against a HEAD that is not the one it names: every one must fail
//   --list <p>    print the folder names whose failure message starts with <p>
// Set CROSS_MODEL_PEERS as the host's review-unit would (default: unset, so peer-less runs need a peer file).
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Rev, proofMatches } from "./review-proof";

const args = process.argv.slice(2);
const opt = (n: string): string | undefined => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const root = opt("--root") ?? `/tmp/compound-engineering-${process.getuid?.() ?? 0}/ce-code-review`;
const before = args.includes("--before");
const wrongHead = args.includes("--wrong-head");
const list = opt("--list");
if (process.env.CROSS_MODEL_PEERS === undefined) process.env.CROSS_MODEL_PEERS = "none"; // the replay cannot know the host's peers

const tmp = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "proof-replay-"));
const passed: string[] = [];
const repaired = new Map<string, string[]>();
const noted = new Map<string, string[]>();
const failed = new Map<string, string[]>();
const norm = (m: string): string => m.replace(/'[^']*'/g, "'…'").replace(/\/\S+/g, "<path>").replace(/\b[0-9a-f]{7,40}\b/g, "<sha>");
const add = (m: Map<string, string[]>, k: string, v: string): void => { m.set(k, [...(m.get(k) ?? []), v]); };

let total = 0;
try {
  for (const name of readdirSync(root).filter((n) => !n.startsWith(".")).sort()) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "review.json")) || !existsSync(join(dir, "metadata.json"))) continue;
    let meta: any;
    try { meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")); } catch { continue; }
    let headSha = typeof meta.head_sha === "string" ? meta.head_sha : "";
    if (!headSha) continue;
    total++;
    const out = join(tmp, "out.json");
    copyFileSync(join(dir, "review.json"), out);
    // metadata may hold an abbreviated sha: stand in for the full HEAD with the longer one the folder shows.
    try {
      const full = JSON.parse(readFileSync(out, "utf8"))?.scope?.head_sha;
      if (typeof full === "string" && full.length > headSha.length && full.startsWith(headSha)) headSha = full;
    } catch { /* the proof reports it */ }
    const sha = wrongHead ? (headSha[0] === "a" ? "b" : "a") + headSha.slice(1) : headSha;
    const rev: Rev = { sha, branch: meta.branch ?? "", base: "", kind: "", deltaBase: "", out, logReason: "", proofError: "", outRunDir: "",
      foundRunDir: before ? "" : dir };
    const stderr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = () => true;
    let ok = false;
    try { ok = proofMatches(rev); } finally { (process.stderr as any).write = stderr; }
    if (!ok) add(failed, norm(rev.proofError), name);
    else {
      if (rev.repaired?.length) add(repaired, rev.repaired.join(", "), name);
      for (const note of rev.slipNotes ?? []) add(noted, norm(note), name);
      if (!rev.repaired?.length && !rev.slipNotes?.length) passed.push(name);
    }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }

const n = (m: Map<string, string[]>): number => [...m.values()].reduce((a, v) => a + v.length, 0);
console.log(`replay of ${total} saved runs in ${root} (${before ? "before: proof as it was" : "after: repairs on"}${wrongHead ? ", wrong HEAD" : ""})`);
console.log(`passed        ${passed.length}`);
console.log(`repaired      ${n(repaired)}`);
for (const [k, v] of [...repaired].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(v.length).padStart(4)}  ${k}`);
console.log(`accepted with a stage-log note (counted above, repaired or passed)  ${n(noted)}`);
for (const [k, v] of [...noted].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(v.length).padStart(4)}  ${k}`);
console.log(`failed        ${n(failed)}`);
for (const [k, v] of [...failed].sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(v.length).padStart(4)}  ${k}`);
if (list) for (const [k, v] of failed) if (k.startsWith(list)) console.log(`${k}\n  ${v.join("\n  ")}`);
