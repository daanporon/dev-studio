// chat/keys.ts — the board's key presses (board chat U19): which keys one press may carry, shared by the
// board's POST /api/keys and the loop's fulfil/keys.ts. The names and bytes are the contract's (contract.ts).
export { KEYS, keyOk } from "../../backend/contract.ts";

export const KEYS_MAX = 8;        // keys in one press
export const KEYS_STALE_S = 60;   // a press the loop reaches later than this is not typed: it would land on whatever shows then
