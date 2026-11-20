// lavish-up.ts — is the Lavish review server answering on this port? Lavish always listens on
// loopback too, so check there: no DNS for the tailnet name needed. Used by the board (redirect or
// ask the loop to start it) and fulfil/lavish.ts (wait for the start).
export const lavishUp = (port: string | number) =>
  fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
