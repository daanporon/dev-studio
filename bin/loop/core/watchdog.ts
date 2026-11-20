// watchdog.ts — is the running loop still ticking? (Bun; bin/loop/loop.sh --ensure asks it about a live
// loop process.) Prints one JSON line:
//   {"state":"fresh"|"stale"|"none","ref":<epoch>,"stall":<epoch>,"age":<s>,"pid":…}
// `ref` is the loop's last sign of life, max(tick_at, started_at, progress_at); stale is older than
// DS_LOOP_STALE_TICKS ticks (default 12). A stale loop is a stall episode keyed by its last tick
// (`stall`, tick_at or 0 when it never ticked). Each stale verdict logs a `loop_restart` event, which the
// board reads for its restart count and its keeps-stalling banner. No Studio card is raised.
import { now, open } from "./store.ts";
import { envInt, tickSeconds } from "./tick.ts";

const staleTicks = envInt("DS_LOOP_STALE_TICKS", 12);

const s = open();
const h = s.get("health", { id: 1 });
const t = now();
const ref = Math.max(Number(h?.tick_at ?? 0), Number(h?.started_at ?? 0), Number(h?.progress_at ?? 0));
const stall = Number(h?.tick_at ?? 0);
const out = { state: !h ? "none" : t - ref > staleTicks * tickSeconds() ? "stale" : "fresh", ref, stall, age: t - ref, pid: h?.pid ?? null };
if (out.state === "stale") s.event("loop_restart", { payload: { ref, stall, age: out.age, pid: out.pid } });
s.close();
console.log(JSON.stringify(out));
