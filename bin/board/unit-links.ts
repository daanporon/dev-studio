// unit-info-link U2: a unit's http(s) links and their short labels, as the board shows them.
// The unit doc carries `links: string[]`; anything else never reaches the page (defence in depth: register-plan checks them too).
export type UnitLink = { url: string; label: string };

const KEY = /\/(?:issue|browse)\/([A-Za-z][A-Za-z0-9_]*-[0-9]+)(?:\/|$)/; // Linear /issue/<ID>, Jira /browse/<KEY>
const GITHUB = /^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/([0-9]+)(?:\/|$)/;

// A short name for an http(s) URL: the ticket id, `owner/repo#n` for GitHub, else the host name.
export function linkLabel(url: string): string {
  const u = new URL(url);
  if (u.hostname === "github.com" || u.hostname === "www.github.com") {
    const g = GITHUB.exec(u.pathname);
    if (g) return `${g[1]}/${g[2]}#${g[3]}`;
  }
  return KEY.exec(u.pathname)?.[1] ?? u.hostname;
}

export function unitLinks(links: unknown): UnitLink[] {
  if (!Array.isArray(links)) return [];
  return links.flatMap((url) =>
    typeof url === "string" && /^https?:\/\//i.test(url) && URL.canParse(url) ? [{ url, label: linkLabel(url) }] : []);
}
