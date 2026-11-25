// one-shot.ts — one short non-interactive model call with no tools (board-actions-as-wishes U6), on Claude,
// Codex or Muse: the one-shot forms review-unit uses (`claude -p`, `codex exec`, `muse exec`), with every
// tool off or the read-only sandbox and an empty folder as cwd. The caller sets the account's config dir
// (CLAUDE_CONFIG_DIR) in the env; only the answer's text is read back.
export const ONE_SHOT_AGENTS = ["claude", "codex", "muse"] as const;

export type OneShot = {
  argv: string[];
  out: string | null;   // the file the answer lands in (codex), else null: the answer is stdout
};

/** The command line for one call on `agent` with `model` and `effort`, in the empty folder `cwd`; null for another agent. */
export function oneShotArgv(agent: string, o: { model: string; effort?: string | null; prompt: string; cwd: string }): OneShot | null {
  const effort = o.effort || "";
  if (agent === "claude")
    return { out: null, argv: ["claude", "-p", "--model", o.model, ...(effort ? ["--effort", effort] : []),
      "--setting-sources", "user", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
      "--output-format", "text", o.prompt] };
  if (agent === "codex") {
    const out = `${o.cwd}/.answer`;
    return { out, argv: ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--model", o.model,
      ...(effort ? ["--config", `model_reasoning_effort=${effort}`] : []), "--output-last-message", out, o.prompt] };
  }
  if (agent === "muse")
    return { out: null, argv: ["muse", "exec", "--model", o.model, "--workspace", o.cwd, ...(effort ? ["--reasoning-effort", effort] : []),
      "--max-model-steps", "1", "--disable-web-tools", "--disable-request-user-input", o.prompt] };
  return null;
}
