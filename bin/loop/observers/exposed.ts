// exposed.ts — the probe of what squad members expose (expose-hosted-services U2, R6, KTD4). Host scope,
// every DS_LOOP_EXPOSED_S (60 s): one round of TCP connects to the open `exposed` entries, at most
// BATCH (16) entries, oldest probed_at first (never probed first), each connect cut at TIMEOUT_MS (≤ 1 s),
// all at once, so a run costs about one timeout however many entries there are; the rest wait for the
// next run. The tick awaits observers one after another, so a longer run would push the tick over its
// interval.
// Each probed entry gets one observed_exposed row: status up | down, reach remote | host-only | down,
// probed_at, and down_since (the first down probe of the current down run; NULL while up). A loopback
// host (localhost, 127.0.0.0/8, ::1) or 0.0.0.0 is also tried on this host's tailnet IP: answering there is
// `remote`, answering only on loopback `host-only`. Any other host is `remote` when it answers.
// Ending an entry that stays down is the reconciler's (reconcilers/exposed.ts).
import { createConnection } from "node:net";
import type { Observer } from "../core/plugins.ts";
import type { Row } from "../core/store.ts";
import { tailnetIp } from "../io/tailnet.ts";
import { envInt } from "../core/tick.ts";

export const BATCH = 16;
export const TIMEOUT_MS = 1000;

// One TCP connect: true when it opens within `ms`.
export function connect(host: string, port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const s = createConnection({ host, port });
    const end = (ok: boolean) => { if (done) return; done = true; clearTimeout(t); s.destroy(); resolve(ok); };
    const t = setTimeout(() => end(false), ms);
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

// The hosts to try for a loopback URL host, or null when the host is not loopback.
export function loopbackHosts(host: string): string[] | null {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return ["127.0.0.1", "::1"];
  if (h === "0.0.0.0") return ["127.0.0.1"];
  if (h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return [h];
  return null;
}

// host + port of an http(s) URL, or null when it does not parse.
export function target(url: string): { host: string; port: number } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) return null;
  return { host, port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80 };
}

export type Probe = { status: "up" | "down"; reach: "remote" | "host-only" | "down" };
type Connect = (host: string, port: number, ms: number) => Promise<boolean>;

// R6 for one URL. `tailnet` is called only for a loopback host ("" = no tailnet IP).
export async function probe(url: string, o: { tailnet: () => string; connect: Connect; ms: number }): Promise<Probe> {
  const down: Probe = { status: "down", reach: "down" };
  const t = target(url);
  if (!t) return down;
  const loop = loopbackHosts(t.host);
  if (!loop) return (await o.connect(t.host, t.port, o.ms)) ? { status: "up", reach: "remote" } : down;
  const ip = o.tailnet();
  const [onTailnet, ...onLoop] = await Promise.all([ip ? o.connect(ip, t.port, o.ms) : Promise.resolve(false), ...loop.map((h) => o.connect(h, t.port, o.ms))]);
  if (onTailnet) return { status: "up", reach: "remote" };
  return onLoop.some(Boolean) ? { status: "up", reach: "host-only" } : down;
}

export function exposedObserver(opts: { tailnet?: () => string; connect?: Connect; ms?: number; batch?: number } = {}): Observer {
  const o = { tailnet: opts.tailnet ?? tailnetIp, connect: opts.connect ?? connect, ms: Math.min(opts.ms ?? TIMEOUT_MS, TIMEOUT_MS) };
  const batch = opts.batch ?? BATCH;
  return {
    name: "exposed",
    scope: "host",
    every: envInt("DS_LOOP_EXPOSED_S", 60),
    async run({ store, now }) {
      const rows = store.db.query(`SELECT e.id, e.url, o.status, o.down_since FROM exposed e LEFT JOIN observed_exposed o ON o.exposed_id = e.id
        WHERE e.gone_at IS NULL ORDER BY o.probed_at IS NOT NULL, o.probed_at, e.id LIMIT ?`).all(batch) as Row[];
      if (!rows.length) return;
      const got = await Promise.all(rows.map((r) => probe(String(r.url), o)));
      store.tx(() => rows.forEach((r, i) => {
        const p = got[i];
        const downSince = p.status === "up" ? null : r.status === "down" && r.down_since != null ? Number(r.down_since) : now;
        store.upsert("observed_exposed", { exposed_id: Number(r.id) }, { status: p.status, reach: p.reach, probed_at: now, down_since: downSince });
      }));
    },
  };
}

export default exposedObserver();
