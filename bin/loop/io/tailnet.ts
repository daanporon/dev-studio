// tailnet.ts — this host's tailnet IP and MagicDNS name, each looked up once per loop process
// (tailscale may be absent: then both are ""). The board fulfiller binds and names the board with them
// (fulfil/board.ts); the exposed probe tries a loopback URL on the IP (observers/exposed.ts).
let ip: string | null = null;
let dns: string | null = null;

export function tailnetIp(): string {
  if (ip !== null) return ip;
  ip = "";
  if (!Bun.which("tailscale")) return ip;
  try { ip = Bun.spawnSync(["tailscale", "ip", "-4"], { timeout: 3000 }).stdout.toString().split("\n")[0].trim(); } catch { /* none */ }
  return ip;
}

export function tailnetDns(): string {
  if (dns !== null) return dns;
  dns = "";
  if (!Bun.which("tailscale")) return dns;
  try { dns = String(JSON.parse(Bun.spawnSync(["tailscale", "status", "--json"], { timeout: 3000 }).stdout.toString())?.Self?.DNSName ?? "").replace(/\.$/, ""); } catch { /* none */ }
  return dns;
}

export function tailscale(): { ip: string; dns: string } {
  return { ip: tailnetIp(), dns: tailnetDns() };
}
