// fulfil/request.ts — kinds `request-restart` and `request-switch`: a request file for the one above
// a broken or limited member, with the sweep's name and content (R24, the removed sweep handle and
// request_switch), so watch.sh and the role docs read it as today:
//   <state root>/<label>/requests/<target>/<key>-<now>.txt
//   restart <who>[ of <topic>] (<cause> since <HH:MM>)
//   switch: restart <what> on the next pick — run: <command>
// Target `_operator` (nobody above can restart it) is a Studio alert instead. No sweep marker file
// (sweep/<key>.req, .switch) is written: the claim row is the loop's memory (KTD7).
// Kind `request.file` (U20, the liveness reconciler; ported from the removed sweep at origin/main 898381d)
// carries the file already made: payload.text at <state root>/<label>/<payload.path>.
// Kind `run-switch` (U40): the loop runs that same restart-role.sh line itself, for a member out of
// usage or on a removed account. Nobody above it is asked, so a stuck Lead can't block its Builders.
// One at a time, in the background; a failure gets the actuator's retries and then one Studio alert.
// A move can wait its turn longer than its reason lasts: it is dropped once what the reconciler
// checked no longer holds, and a later need is a new try. A Lead hears in one line what moved.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { alert, type Fulfiller } from "../core/actuator.ts";
import { actionBlock } from "../pause/pause.ts";
import { payloadOf, type ActionPayload } from "../core/kinds.ts";

const pad = (n: number) => String(n).padStart(2, "0");
function hhmm(epoch: number): string { const d = new Date(epoch * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

type P = ActionPayload<"request.file">;

const request: Fulfiller = {
  name: "request",
  kinds: ["request-restart", "request-switch", "request.file"],
  run() { return []; },
  stale(a) {
    if (a.kind === "request-switch" && a.episode.startsWith("early|")) return true;
    return false;
  },
  async exec(a, x) {
    const block = actionBlock(x.store, a);
    if (block) return block === "paused" ? { wait: block } : { dropped: block };
    const p = payloadOf<"request.file">(a);
    if (a.kind === "request.file") {
      if (!a.project || !p.path || p.text == null) return { failed: "a request file needs a project, a path and a text" };
      const file = join(x.store.root, a.project, p.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, p.text);
      return { done: true, result: file };
    }
    if (!a.project || !p.target || !p.key) return { failed: "a request file needs a project, a target and a key" };
    const restart = a.kind === "request-restart";
    const what = restart ? `${p.who ?? "?"}${p.topic ? ` of ${p.topic}` : ""} (${p.cause ?? "?"} since ${hhmm(Number(p.since ?? x.now))})` : p.what ?? "?";
    if (p.target === "_operator") {
      const text = `${what} — nobody above it can restart it${restart ? "" : `; run: ${p.command ?? ""}`}`;
      const o = await alert(x.store, a.project, p.key, a.episode, text, { option: "look at it, then restart it by hand (restart-role.sh)" });
      return o.code === 0 ? { done: true, result: "alert" } : { retry: (o.err || o.out).trim() };
    }
    const dir = join(x.store.root, a.project, "requests", p.target), file = join(dir, `${p.key}-${x.now}.txt`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, restart ? `restart ${what}\n` : `switch: restart ${what} on the next pick — run: ${p.command ?? ""}\n`);
    return { done: true, result: file };
  },
};
export default request;
