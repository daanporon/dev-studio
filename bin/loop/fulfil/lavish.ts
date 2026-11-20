// fulfil/lavish.ts — kind `lavish`: start the Lavish review server (U15). Lavish stops itself after 30
// idle minutes; a click on a review link (the board's GET /lavish/<key>) files this request when
// nothing answers on its port. Payload {port}. The start runs in the background and waits up to
// DS_LOOP_LAVISH_WAIT_MS (default 20 s) for 127.0.0.1:<port>/health; its output goes to
// $TMPDIR/ds-lavish-start.log (the state observer watches that file too), whose tail is the
// failure reason. DS_LAVISH_START replaces the command.
// A loop may run from a shell that never loaded the profile (no node on PATH), so the command also
// looks where Node is usually installed.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failRequest, finishRequest, requestActions, type Fulfiller } from "../core/actuator.ts";
import { lavishUp } from "../io/lavish-up.ts";
import { childEnv } from "../io/orca.ts";
import { envInt } from "../core/tick.ts";

const LOG = () => join(process.env.TMPDIR || "/tmp", "ds-lavish-start.log");
const START = () => process.env.DS_LAVISH_START
  || 'PATH="$PATH:${FNM_DIR:-$HOME/.local/share/fnm}/aliases/default/bin:$HOME/Library/Application Support/fnm/aliases/default/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"; '
  + 'nohup npx -y lavish-axi server >>"$DS_LAVISH_LOG" 2>&1 &';
const waitMs = () => envInt("DS_LOOP_LAVISH_WAIT_MS", 20_000);

const lavish: Fulfiller = {
  name: "lavish",
  scope: "host",
  kinds: ["lavish"],
  run: (ctx) => requestActions(ctx, ["lavish"]),
  async exec(a, x) {
    const port = String((a.payload as { port?: unknown } | undefined)?.port ?? "");
    if (!/^\d{1,5}$/.test(port)) return { failed: "a Lavish start needs its port" };
    const done = () => { finishRequest(x.store, a, { ok: true, port: Number(port) }, x.now); return { done: true as const }; };
    if (await lavishUp(port)) return done();
    const log = LOG();
    writeFileSync(log, `${new Date().toISOString()} starting Lavish\n`);
    Bun.spawn(["sh", "-c", START()], { stdio: ["ignore", "ignore", "ignore"], env: childEnv({ DS_LAVISH_LOG: log }) });
    return {
      background: (async () => {
        const wait = waitMs();
        for (let t = 0; t < wait; t += 500) { if (await lavishUp(port)) return done(); await Bun.sleep(500); }
        let out = ""; try { out = readFileSync(log, "utf8").slice(-1500); } catch { /* no log */ }
        return { failed: `Lavish didn't start within ${wait / 1000}s (nothing answers on 127.0.0.1:${port}): ${out.trim()}` };
      })(),
    };
  },
  giveUp: failRequest,
};
export default lavish;
