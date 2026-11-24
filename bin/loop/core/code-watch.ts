// code-watch.ts — the loop restarts itself on new code (chat-multiline-send-fails U1).
//
// The page and the board server pick up new code by themselves; the loop runs the `.ts` it booted with
// until it restarts. A plain `git pull` of the host checkout (no /ds-update, so no restart) once left the
// loop on code from before the board page it served. So main.ts keeps the commit it booted on and,
// between ticks and at most every CODE_CHECK_MS, reads the checkout's HEAD again. A new HEAD whose diff
// touches loop code (`isLoopCode`) is a restart: main.ts drains, logs `loop_code_changed` and exits 75,
// and systemd (Restart=on-failure) or the minutely `loop.sh --ensure` starts the new code. A new HEAD
// that changes no loop code (docs, tests, the page, roles) is adopted with no restart. A failed git read
// skips the check until the next one and never exits. Edits without a commit are not seen, on purpose:
// roles never edit the host checkout.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const CODE_CHECK_MS = 10_000;

// On by default only for the live root, the checkout's own state/ (board-data.ts isLiveRoot's rule,
// copied so the loop loads no board code): a test or Tester loop in a worktree, which nothing restarts,
// keeps running. DS_LOOP_CODE_WATCH=1 forces it on, =0 off.
export function codeWatchOn(stateRoot: string, root: string, env: Record<string, string | undefined> = process.env): boolean {
  if (env.DS_LOOP_CODE_WATCH === "1") return true;
  if (env.DS_LOOP_CODE_WATCH === "0") return false;
  return resolve(stateRoot) === resolve(join(root, "state"));
}

// bin/commands/update-host-ts.ts holds the checkout while it runs (reset, install, maybe a reset back): no
// restart then, so a failed install's rollback never finds a loop already on (and migrated to) the new commit.
// update-host restarts the loop itself when it is done. A hold whose pid is gone counts for nothing.
export function hostUpdateHold(stateRoot: string): string { return join(stateRoot, "loop", "host-update.hold"); }
export function hostUpdateRunning(stateRoot: string): boolean {
  let pid: number;
  try { pid = Number(JSON.parse(readFileSync(hostUpdateHold(stateRoot), "utf8")).pid); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
}

function git(repo: string, args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", repo, ...args], {
      stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch { return null; }
}

// The checkout's full HEAD commit, or null when git cannot say (no repo, a ref mid-update).
export function headRev(repo: string): string | null {
  const s = git(repo, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() ?? "";
  return /^[0-9a-f]{40,64}$/.test(s) ? s : null;
}

// Code the loop runs: any `.ts` under bin/ but tests and fakes, and the migrations.
export function isLoopCode(path: string): boolean {
  if (/^bin\/loop\/migrations\/[^/]+\.sql$/.test(path)) return true;
  if (!path.startsWith("bin/") || !path.endsWith(".ts") || path.endsWith(".test.ts")) return false;
  return !path.split("/").includes("fakes");
}

// The loop-code paths that differ between two commits (both sides of a rename), or null on a failed read.
export function loopCodeChanges(repo: string, from: string, to: string): string[] | null {
  const out = git(repo, ["diff", "--name-only", "--no-renames", "-z", from, to, "--", "bin"]);
  return out === null ? null : out.split("\0").filter((p) => p && isLoopCode(p));
}

export type CodeCheck =
  | { kind: "same" }
  | { kind: "skip"; why: string }
  | { kind: "adopt"; from: string | null; to: string }
  | { kind: "restart"; from: string; to: string; files: string[] };

export class CodeWatch {
  private last: number;
  constructor(readonly repo: string, public rev: string | null, readonly everyMs = CODE_CHECK_MS, at = Date.now(),
    readonly held: () => boolean = () => false) {
    this.last = at;
  }

  // null while no check is due. An adopt moves the running rev on; a restart leaves it for the caller.
  check(at = Date.now()): CodeCheck | null {
    if (at - this.last < this.everyMs) return null;
    this.last = at;
    if (this.held()) return { kind: "skip", why: "host update running" };
    const head = headRev(this.repo);
    if (!head) return { kind: "skip", why: "HEAD unreadable" };
    if (head === this.rev) return { kind: "same" };
    const from = this.rev;
    // Booted with no readable HEAD: nothing to diff against, so take this one as the running code.
    if (!from) { this.rev = head; return { kind: "adopt", from, to: head }; }
    const files = loopCodeChanges(this.repo, from, head);
    if (files === null) return { kind: "skip", why: "diff failed" };
    if (!files.length) { this.rev = head; return { kind: "adopt", from, to: head }; }
    return { kind: "restart", from, to: head, files };
  }
}
