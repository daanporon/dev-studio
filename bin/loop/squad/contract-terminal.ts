// U12b: one terminal of a squad off Orca as its backend shows it now: the stray and duplicate
// fulfillers' fresh read before a close (fulfil/stray.ts, fulfil/duplicate.ts). Listed in the member's
// folder, with its last output and, on a backend with `state: native`, its agent state.
import type { ContractSeat } from "../drivers/types.ts";

export type TerminalNow = { id: string; label: string; gen: string | null; out: number | null; state: string | null };

const trim = (p: string) => p.replace(/\/+$/, "");

/** The terminals in `path` now (newest first), or the backend's error. */
export async function folderNow(c: ContractSeat, path: string): Promise<TerminalNow[] | { error: string }> {
  const l = await c.ask("terminal.list", {});
  if (!l.ok) return { error: `terminal.list: ${l.error.message}` };
  const here = l.terminals.filter((t) => trim(t.cwd) === trim(path)).sort((a, b) => b.created_at - a.created_at);
  return Promise.all(here.map(async (t) => {
    const [out, st] = await Promise.all([c.ask("terminal.last_output", { id: t.id }),
      c.caps.state === "native" ? c.ask("agent.state", { id: t.id }) : Promise.resolve(null)]);
    return { id: t.id, label: t.label, gen: t.gen, out: out.ok ? out.at : null, state: st?.ok ? st.state : null };
  }));
}
