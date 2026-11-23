#!/usr/bin/env node
// feedback-labels.mjs — the labels a ds-feedback issue gets (ds-feedback-github-issues U3). The loop's
// feedback fulfiller (bin/loop/fulfil/feedback.ts, bin/loop/feedback/post.ts) ends every issue it opens
// with one marker line:
//
//   <!-- ds-feedback v1 area:<area> kind:<kind> -->
//
// Given the `issues` event file (GITHUB_EVENT_PATH) or, with --body, a file holding just a body, this
// prints `ds-feedback`, `area:<area>` and `kind:<kind>`, one per line, when the body holds exactly one
// marker line of that form (each word lowercase letters, digits and dashes, at most 32). No marker, a
// malformed one (any line naming `ds-feedback v…` that is not that form) or two prints nothing. It
// reads only the marker and never prints any other part of the body, so nothing a body says reaches
// the log or the shell. Exit 0 either way; exit 2 for an unreadable input.
import { readFileSync } from "node:fs";

const WORD = "[a-z0-9][a-z0-9-]{0,31}";
const MARKER = new RegExp(`^<!-- ds-feedback v1 area:(${WORD}) kind:(${WORD}) -->$`);
const CLAIMS = /ds-feedback\s+v\d/;

export function labelsOf(body) {
  if (typeof body !== "string") return [];
  const claims = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => CLAIMS.test(l));
  if (claims.length !== 1) return [];
  const m = MARKER.exec(claims[0]);
  return m ? ["ds-feedback", `area:${m[1]}`, `kind:${m[2]}`] : [];
}

function main(argv) {
  const body = argv[0] === "--body";
  const file = body ? argv[1] : argv[0] || process.env.GITHUB_EVENT_PATH;
  if (!file) { console.error("usage: feedback-labels.mjs [<event.json> | --body <file>]"); return 2; }
  let text;
  try { text = readFileSync(file, "utf8"); } catch { console.error("feedback-labels: cannot read the input"); return 2; }
  let issueBody = text;
  if (!body) {
    try { issueBody = JSON.parse(text)?.issue?.body ?? ""; } catch { console.error("feedback-labels: the event is not JSON"); return 2; }
  }
  for (const l of labelsOf(issueBody)) console.log(l);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
