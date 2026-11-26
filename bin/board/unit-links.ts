// unit-info-link U2: a unit's http(s) links and their short labels, as the board shows them.
// The unit doc carries `links: string[]`; anything else never reaches the page (defence in depth: register-plan checks them too).
import { ticketUrlProblem } from "../loop/squad/plan-lines.ts";

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

const TICKET = "[A-Za-z][A-Za-z0-9_]*-[0-9]+|#?[0-9]+";
const LEADING = new RegExp(`^\\s*\\[(${TICKET})\\]`);
// A single one: `x [A-1] [B-2]` names two tickets, so neither is the unit's.
const TRAILING = new RegExp(`(?<!\\]\\s*)\\[(${TICKET})\\]\\s*$`);

/** The link a project's `ticket_url` gives a unit whose title starts, or else ends, with `[ID]`; null for none. */
export function ticketLink(title: unknown, template: string | null): UnitLink | null {
  if (typeof title !== "string" || !template || template === "-" || ticketUrlProblem(template)) return null;
  const id = (LEADING.exec(title) ?? TRAILING.exec(title))?.[1];
  const url = id ? template.replaceAll("{id}", encodeURIComponent(id.replace(/^#/, ""))) : "";
  return id && URL.canParse(url) ? { url, label: id } : null; // {id} in a host or port may not parse
}

/** The chips of one unit: the ticket link first, then the plan's links, without a second copy of its URL. */
export function unitLinks(links: unknown, ticket: UnitLink | null = null): UnitLink[] {
  const own = !Array.isArray(links) ? [] : links.flatMap((url) =>
    typeof url === "string" && /^https?:\/\//i.test(url) && URL.canParse(url) ? [{ url, label: linkLabel(url) }] : []);
  if (!ticket) return own;
  const href = new URL(ticket.url).href;
  return [ticket, ...own.filter((l) => new URL(l.url).href !== href)];
}
