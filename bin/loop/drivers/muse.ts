// drivers/muse.ts — Muse. No resume: a handoff always starts it fresh from the squad state, and it
// is woken like any agent, by typing into its terminal with --wait-submit (KTD12).
import { keysVia, pokeVia, startVia, stopVia, type Driver, type DriverModule, type Seat } from "./types.ts";

export const muse: DriverModule = {
  agent: "muse",
  resumes: false,
  make(seat: Seat): Driver {
    return {
      start: (m, model, account, prompt) => startVia(seat, "muse", m, model, account, prompt),
      resume: async () => ({ ok: false, error: "muse has no resume; start it fresh" }),
      poke: (m, text) => pokeVia(seat, m, text),
      keys: (m, keys) => keysVia(seat, m, keys),
      stop: (make, m, run, keep) => stopVia(make, m, run, keep),
      answerMenu: () => null,
    };
  },
};
export default muse;
