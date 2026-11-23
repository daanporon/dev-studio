// feedback/leak.ts — the word-list check a feedback text passes before it can leave the host
// (ds-feedback-github-issues U2; U3's post runs the same check on the final text).
//
//   wordsPath()        where tests/leak-guard.sh reads the host-local word list: DS_LEAK_WORDS, else
//                      ${XDG_CONFIG_HOME:-~/.config}/dev-studio/leak-words.txt, else the old
//                      ~/.dev-studio/state/leak-words.txt when only that one exists
//   hasWords()         that list exists and holds a word (blank and # lines don't count)
//   leakCheck(text)    the guard's `--text` mode on the text: ok, or the kinds of hit it found
//                      (`a word of the host-local list; a gmail address`), never the matched value
//
// The guard is the host checkout's tests/leak-guard.sh (DS_LEAK_GUARD for tests). A guard that cannot
// run is a hit too: a text nobody could check is never posted.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../core/store.ts";
import { childEnv } from "../io/orca.ts";

export function wordsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DS_LEAK_WORDS) return env.DS_LEAK_WORDS;
  const home = env.HOME || homedir();
  const cur = join(env.XDG_CONFIG_HOME || join(home, ".config"), "dev-studio", "leak-words.txt");
  const old = join(home, ".dev-studio", "state", "leak-words.txt");
  return !existsSync(cur) && existsSync(old) ? old : cur;
}

export function hasWords(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return readFileSync(wordsPath(env), "utf8").split("\n").some((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  } catch { return false; }
}

export const guardPath = (): string => process.env.DS_LEAK_GUARD || join(ROOT, "tests", "leak-guard.sh");

export type Leak = { ok: true } | { ok: false; why: string };

// The guard's hit lines read `<file>:<line>: <kind>`; the kinds, each once, are the finding.
export function hitKinds(out: string): string {
  const kinds = new Set<string>();
  for (const l of out.split("\n")) {
    const t = l.trim();
    if (!t || t.startsWith("FAIL leak-guard")) continue;
    const m = t.match(/^[^:]*:\d+: (.+)$/);
    kinds.add(m ? m[1] : t);
  }
  return [...kinds].join("; ").slice(0, 300) || "the guard refused it";
}

export async function leakCheck(text: string): Promise<Leak> {
  const dir = mkdtempSync(join(tmpdir(), "ds-leak-"));
  try {
    const f = join(dir, "text");
    writeFileSync(f, text, { mode: 0o600 });
    const p = Bun.spawn(["bash", guardPath(), "--text", f], { cwd: dir, env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code === 0) return { ok: true };
    return { ok: false, why: code === 1 ? hitKinds(out) : `the guard could not run (exit ${code}): ${(err || out).trim().split("\n")[0].slice(0, 200)}` };
  } catch (e) {
    return { ok: false, why: `the guard could not run: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
