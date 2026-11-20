// ds codex-models-ts — Codex's bundled model catalog as one picker entry per line (U272): what bin/lib/codex-models.sh runs.
// A list of choices, not an access check; --bundled never calls the configured provider. A missing or older CLI, a timeout
// or a malformed catalog prints nothing and exits 0, so models.conf stays the fallback.
import { writeOut } from "../lib/shared";

export const help = `— Codex's bundled model catalog as one picker entry per line (codex-models.sh)`;

const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function rows(catalog: any): string[] {
  const models = catalog?.models ?? [];
  const list: any[] = Array.isArray(models) ? models : typeof models === "object" && models !== null ? Object.values(models) : (() => { throw new Error("not iterable"); })();
  const out: string[] = [];
  for (const m of list) {
    if (m.visibility !== "list") continue;
    if (typeof m.slug !== "string" || !/^[A-Za-z0-9._-]+$/.test(m.slug)) continue;
    const levels = m.supported_reasoning_levels === null || m.supported_reasoning_levels === undefined || m.supported_reasoning_levels === false ? [] : m.supported_reasoning_levels;
    if (!Array.isArray(levels)) throw new Error("not iterable");
    const efforts: string[] = levels.map((l: any) => l.effort).filter((e: any) => typeof e === "string");
    const dn = m.display_name === null || m.display_name === undefined || m.display_name === false ? m.slug : m.display_name;
    if (typeof dn !== "string") throw new Error("not a string");
    out.push(JSON.stringify({
      agent: "codex", model: m.slug, label: "Codex · " + dn,
      efforts: [...ORDER.filter((o) => efforts.includes(o)), ...efforts.filter((e) => !ORDER.includes(e))], custom: false,
    }));
  }
  return out;
}

export async function run(_argv: string[]): Promise<number> {
  const cli = process.env.CODEX_BIN || "codex";
  const bin = Bun.which(cli);
  if (!bin) return 0;
  let text = "";
  try {
    const p = Bun.spawn([bin, "debug", "models", "--bundled"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000, killSignal: "SIGTERM" });
    const [o, rc] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    if (rc !== 0) return 0;
    text = o;
  } catch { return 0; }
  let lines: string[];
  try { lines = rows(JSON.parse(text)); } catch { return 0; }
  if (lines.length) writeOut(lines.join("\n") + "\n");
  return 0;
}
