// The real board page mounted in happy-dom on the pinned React/htm builds (no network); shared by the render
// and event-log tests. `fixtures` maps a URL prefix to the JSON that fetch answers (board.json is `b`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

const root = join(import.meta.dir, "../..");
const nm = (p: string) => readFileSync(join(root, "node_modules", p), "utf8");
const page = readFileSync(join(root, "web/board.html"), "utf8");
const scriptStart = page.indexOf("<script>\n") + "<script>\n".length;
const pageScript = page.slice(scriptStart, page.indexOf("</script>", scriptStart));

export type Run = { errors: string[]; root: HTMLElement; window: any; opened: number; urls: string[] };

type Run = { errors: string[]; root: HTMLElement; window: any; opened: number };

export async function mount(b: any, open = true, fixtures: Record<string, any> = {}): Promise<Run> {
  const window: any = new Window({ url: "http://localhost/", settings: { disableErrorCapturing: true } });
  const errors: string[] = [], urls: string[] = [];
  const log = (...a: any[]) => errors.push(a.map((x) => (x instanceof Error ? x.stack || x.message : String(x))).join(" "));
  window.console.error = log;
  window.addEventListener("error", (e: any) => errors.push("uncaught: " + (e.error?.stack || e.message)));
  window.addEventListener("unhandledrejection", (e: any) => errors.push("unhandled: " + e.reason));
  const json = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = async (url: string) => {
    urls.push(String(url));
    const hit = Object.keys(fixtures).sort((x, y) => y.length - x.length).find((k) => String(url).startsWith(k));
    return json(hit ? fixtures[hit] : String(url).startsWith("board.json") ? b : String(url).startsWith("api/messages") ? { unread: 2, messages: [] } : {});
  };
  window.EventSource = class { onmessage: any; close() {} };
  window.confirm = () => false;
  window.document.write('<!doctype html><html><head></head><body><div id="root"></div></body></html>');
  // The page's three <script src> builds, from the pinned packages instead of unpkg.
  window.eval(nm("react/umd/react.production.min.js"));
  window.eval(nm("react-dom/umd/react-dom.production.min.js"));
  window.eval(nm("htm/dist/htm.umd.js"));
  window.eval(pageScript);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const doc = window.document;
  // The first render waits on the board.json fetch: on a loaded host (a CI runner, CI_JOBS=4) one 30 ms
  // settle can end while the page still shows its `loading…` header, before any section exists.
  const loading = () => { const m = doc.querySelector("#root .hdr .meta"); return !doc.getElementById("root")?.firstChild || m?.textContent === "loading…"; };
  for (const end = Date.now() + 3000; loading() && Date.now() < end;) await new Promise((r) => setTimeout(r, 10));
  await settle();
  let opened = 0;
  for (let round = 0; open && round < 6; round++) {
    const rows = [...doc.querySelectorAll('[role="button"][aria-expanded="false"]')];
    const details = [...doc.querySelectorAll("details:not([open])")];
    if (!rows.length && !details.length) break;
    for (const el of rows) { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); opened++; await settle(); }
    for (const d of details) { d.open = true; d.dispatchEvent(new window.Event("toggle")); opened++; await settle(); }
  }
  return { errors, root: doc.getElementById("root"), window, opened, urls };
}

