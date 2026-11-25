// launch-lines.ts — which agents a backend can start (U31). Orca starts every agent; a contract backend
// (tmux, herdr, orca-lite) has a launch line for claude only (bin/loop/drivers/contract.ts). One answer
// for spawn-squad's roster check and the capacity picker's rungs.
export const LAUNCH_LINES = new Set(["claude"]);

/** True when `backend` has a launch line for `agent`; a missing backend is orca. */
export function canLaunch(backend: string | null | undefined, agent: string): boolean {
  return !backend || backend === "orca" || LAUNCH_LINES.has(agent);
}

// The roster's terminal roles (not `elevate`, a one-shot call) whose agent or a fallback's has no launch
// line on a contract backend, as `<role>: <agent>`. Columns: agent model spawn [effort] [fallbacks] …
export function noLaunchLine(roster: Map<string, string>): string[] {
  const out: string[] = [];
  for (const [role, v] of roster) {
    const f = v.trim().split(/\s+/);
    if (f[2] === "elevate") continue;
    const agents = [f[0], ...(f[4] ?? "").split(",").filter((x) => x.includes(":")).map((x) => x.split(":")[0])];
    for (const a of new Set(agents)) if (a && !LAUNCH_LINES.has(a)) out.push(`${role}: ${a}`);
  }
  return out;
}
