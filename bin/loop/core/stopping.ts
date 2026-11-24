// Whether this loop process is shutting down (SIGTERM/SIGINT). Its own module so the actuator can read it
// without importing main.ts, the entry point, which would start a loop.
let stopping = false;
export const markStopping = (): void => { stopping = true; };
export const loopStopping = (): boolean => stopping;
export const resetStopping = (): void => { stopping = false; }; // tests only
