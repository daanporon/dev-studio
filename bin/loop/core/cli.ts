// cli.ts — argument helpers shared by the bin/commands/*.ts subcommands (Bun).
import type { Row } from "./store.ts";

// `--name value` and bare `--flag` options out of args; the rest stay positional.
export function parse(args: string[], valued: string[], bare: string[] = []): { pos: string[]; opt: Record<string, string>; flag: Set<string> } {
  const pos: string[] = [], opt: Record<string, string> = {}, flag = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && valued.includes(a.slice(2))) {
      if (args[i + 1] === undefined) throw new Error(`${a} needs a value`);
      opt[a.slice(2)] = args[++i];
    } else if (a.startsWith("--") && bare.includes(a.slice(2))) flag.add(a.slice(2));
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, opt, flag };
}

export function print(v: unknown): void { console.log(JSON.stringify(v, null, 2)); }

// A row as JSON readers want it: JSON-text columns parsed, `doc` left out unless asked.
const JSON_COLS = new Set(["payload", "want_payload", "deps", "ext_deps", "reasons", "doc"]);
export function shape(row: Row, withDoc = false): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "doc" && !withDoc) continue;
    if (JSON_COLS.has(k) && typeof v === "string") { try { out[k] = JSON.parse(v); continue; } catch { /* plain text */ } }
    out[k] = v;
  }
  return out;
}

export function seconds(s: string | undefined, name = "--wait"): number | null {
  if (s === undefined) return null;
  if (!/^\d+$/.test(s)) throw new Error(`${name} takes whole seconds, not '${s}'`);
  return Number(s);
}

// Poll `done` every 200 ms until it holds or `secs` pass (DS_NOW does not freeze the clock here).
export async function waitFor(secs: number, done: () => boolean): Promise<boolean> {
  const end = Date.now() + secs * 1000;
  for (;;) {
    if (done()) return true;
    if (Date.now() >= end) return false;
    await Bun.sleep(Math.min(200, Math.max(0, end - Date.now())));
  }
}
