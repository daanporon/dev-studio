// demo-board-shot.mjs <url> <dir> — take the README pictures of the demo board over raw CDP (Node 24, no deps).
// Writes <dir>/board.png (the top, down to the end of the Flow chart) and <dir>/board-full.png (the whole
// page, every section open, checkout-flow expanded), 1440 px wide. It checks the page first: every section
// present with content and no "Loop down" banner. If a check fails it exits 1 and writes nothing.
// Chrome: $CHROME, else the newest headless shell under ~/.cache/ms-playwright, else chrome on PATH.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const [url, dir] = process.argv.slice(2);
if (!url || !dir) { console.error("usage: demo-board-shot.mjs <url> <dir>"); process.exit(2); }
const SECTIONS = ["squads", "flow", "accounts", "machine", "briefs", "events"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(base)) {
    for (const d of readdirSync(base).filter((x) => x.startsWith("chromium_headless_shell-")).sort().reverse())
      for (const sub of readdirSync(join(base, d)).filter((x) => x.startsWith("chrom"))) for (const bin of ["chrome-headless-shell", "headless_shell", "chrome"]) { const p = join(base, d, sub, bin); if (existsSync(p)) return p; }
  }
  return "chromium";
}
const prof = mkdtempSync(join(tmpdir(), "demo-shot-"));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(findChrome(), ["--no-sandbox", "--headless", `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, "--window-size=1440,1000", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const done = (code, msg) => { if (msg) console.error(msg); try { chrome.kill(); } catch {} rmSync(prof, { recursive: true, force: true }); process.exit(code); };
chrome.on("error", (e) => done(1, "demo-board-shot: cannot start Chrome: " + e.message));
let ws;
for (let i = 0; i < 60 && !ws; i++) { try { const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page"); if (t) ws = t.webSocketDebuggerUrl; } catch {} if (!ws) await sleep(250); }
if (!ws) done(1, "demo-board-shot: Chrome did not answer");
const sock = new WebSocket(ws); await new Promise((r) => (sock.onopen = r));
let id = 0; const pend = new Map();
sock.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const waitFor = async (expr, ms) => { for (let t = 0; t < ms; t += 500) { if (await ev(expr)) return true; await sleep(500); } return false; };
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await cdp("Page.navigate", { url });
if (!(await waitFor(`!!document.querySelector('#squads .row.squad')`, 30000))) done(1, "demo-board-shot: the squads section never showed a squad");
// Expand checkout-flow and wait for its pipeline graph.
await ev(`(()=>{const r=[...document.querySelectorAll('#squads .row.squad')].find(e=>/checkout-flow/.test(e.textContent));if(r)r.click();return !!r})()`);
await sleep(3000);
await ev(`document.querySelectorAll('details').forEach(d=>{d.open=true})`);
await sleep(4000);
// Every section present with content, no Loop down banner.
const problems = [];
for (const s of SECTIONS) {
  const n = await ev(`(()=>{const d=document.getElementById(${JSON.stringify(s)});if(!d)return -1;return (d.innerText||'').replace(/\\s+/g,' ').trim().length - ((d.querySelector('summary')||{innerText:''}).innerText||'').length})()`);
  if (n === -1) problems.push(`section #${s} is missing`); else if (n < 20) problems.push(`section #${s} has no content`);
}
if (await ev(`!!document.getElementById('loop-down') || /Loop down/.test(document.body.innerText)`)) problems.push('the "Loop down" banner shows');
if (await ev(`!/checkout-flow/.test(document.getElementById('squads').innerText)`)) problems.push("checkout-flow is not in squads");
if (problems.length) done(1, "demo-board-shot: not taking the pictures:\n  " + problems.join("\n  "));
const shoot = async (clip) => Buffer.from((await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, ...(clip ? { clip: { x: 0, y: 0, width: 1440, height: clip, scale: 1 } } : {}) })).result.data, "base64");
const h = await ev(`Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)`);
const flowEnd = await ev(`Math.ceil(document.getElementById('flow').getBoundingClientRect().bottom + window.scrollY)`);
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: h, deviceScaleFactor: 1, mobile: false });
await sleep(1500);
const full = await shoot(), top = await shoot(flowEnd);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "board.png"), top); writeFileSync(join(dir, "board-full.png"), full);
console.log(`demo-board-shot: wrote ${join(dir, "board.png")} (1440x${flowEnd}) and ${join(dir, "board-full.png")} (1440x${h})`);
done(0);
