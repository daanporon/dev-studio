// squad/studio-send.ts — type text or press keys in the Studio's adopted terminal, on any backend
// (U52b of orca-backend-alternatives). On Orca the handle is a terminal handle and the adapter's
// `poke-terminal` / `keys` ops reach it; off Orca (a contract Studio, U50) the seat has no Orca ops and the
// handle is the backend's terminal id, so the same text goes through `terminal.send`.
import type { Seat } from "../drivers/types.ts";
import type { Out } from "../io/orca.ts";
import { keyBytes } from "../../backend/contract.ts";

/** `text` typed into the terminal and submitted. Out as the Orca op's: code 0 sent, else err says why. */
export async function studioType(seat: Seat, handle: string, text: string): Promise<Out> {
  if (!seat.contract) return seat.send("poke-terminal", [handle, text]);
  const r = await seat.contract.ask("terminal.send", { id: handle, text, submit: true });
  return r.ok ? { code: 0, out: "", err: "" } : { code: 1, out: "", err: r.error.message };
}

/** Named keys (chat/keys.ts) pressed with no Enter added. */
export async function studioKeys(seat: Seat, handle: string, keys: string[]): Promise<Out> {
  if (!seat.contract) return seat.send("keys", [handle, keys.map(keyBytes).join("")]);
  if (seat.contract.caps.keys === "none") return { code: 1, out: "", err: `backend ${seat.contract.backend} cannot press keys` };
  const r = await seat.contract.ask("terminal.send", { id: handle, keys });
  return r.ok ? { code: 0, out: "", err: "" } : { code: 1, out: "", err: r.error.message };
}
