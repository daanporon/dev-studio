// Codex uses its host CLI configuration (including an Azure provider). The loop's
// restarts start fresh from the role brief and journal, just like other agents.
import { pokeVia, startVia, stopVia, type Driver, type DriverModule, type Seat } from "./types.ts";

export const codex: DriverModule = {
  agent: "codex",
  resumes: false,
  make(seat: Seat): Driver {
    return {
      start: (m, model, account, prompt) => startVia(seat, "codex", m, model, account, prompt),
      resume: async () => ({ ok: false, error: "codex restarts start fresh from the squad state" }),
      poke: (m, text) => pokeVia(seat, m, text),
      stop: (make, m, run, keep) => stopVia(make, m, run, keep),
      answerMenu: () => null,
    };
  },
};
export default codex;
