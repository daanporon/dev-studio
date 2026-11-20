// fulfil/message.ts — kinds `send-peer`, `send-role` and `notify-squads`: the requests those
// scripts write on a migrated state root (U13b). The loop runs the script again with
// DS_LOOP_CHILD=1, as the terminal that asked (replay.ts).
//
// U156: notify-squads.sh no longer queues a request (it writes a reload wish per member, which
// the decider delivers); the kind stays listed so rows queued before the update still drain.
//
// U75: a message that ends failed goes back to its sender. The sender was told "queued", so when
// the request fails (exit 2 or 3, or retries given up) the loop types one line into the terminal in
// the request's `from` (a role terminal the observer knows): what was not delivered, to whom, and why. A card is raised only when that
// poke fails (no live sender terminal). A request with no project gets the sender's (its cwd's worktree name, else its terminal)
// for the card; the claim key keeps the project the request was queued with.
import { basename } from "node:path";
import { alert, failRequest, type Exec } from "../core/actuator.ts";
import type { Action } from "../core/plugins.ts";
import { projectOf, replayOf, requests, wordsOf } from "../messages/replay.ts";
import type { Row } from "../core/store.ts";

const base = requests("message", ["send-peer", "send-role", "notify-squads"]);

export const failureLine = (kind: string, to: string, subject: string, error: string) =>
  `dev-studio loop: your ${kind} to ${to} "${subject.replace(/\s+/g, " ")}" was NOT delivered: ${error.replace(/^\S+ exit \d+: /, "").replace(/\s+/g, " ").trim()}. Fix it and send again.`;

export default {
  ...base,
  async giveUp(a: Action, x: Exec, why: string) {
    failRequest(a, x, why);
    const r = replayOf(a.payload), w = r ? wordsOf(r) : [];
    const project = projectOf(x, a);
    const to = a.kind === "notify-squads" ? `${w[0] ?? project}/*` : `${w[0] ?? "?"}/${w[1] ?? "?"}`;
    const subject = (a.kind === "notify-squads" ? w[1] ?? "reload" : w[2]) ?? "";
    const text = failureLine(a.kind, to, subject, why);
    let told = false;
    // Only a live terminal the observer knows (a role's) is typed into: any other handle may be a shell,
    // which would run the line as a command.
    const live = r?.from ? x.store.db.query("SELECT 1 FROM observed_terminals WHERE handle = ? AND gone_at IS NULL").get(r.from) : null;
    if (r?.from && live) {
      try { told = (await x.act.seat(x.store, project, null, `${a.subject}:${a.episode}`, null, x.now).send("poke-terminal", [r.from, text])).code === 0; } catch { told = false; }
    }
    if (told) return true;   // the request failed and its sender was told: no refusal card
    const sender = `${r?.from ?? "an unknown terminal"}${r?.cwd ? ` (${basename(r.cwd)})` : ""}`;
    const card = `${sender} sent a ${a.kind} to ${to} "${subject}" and it was NOT delivered: ${why}. No live sender terminal to tell.`;
    if (project) await alert(x.store, project, a.subject, a.episode, card, { title: "Message not delivered" });
    else x.store.event("toast", { project: null, squad: a.squad ?? null, member: null, payload: { level: "error", subject: a.subject, kind: a.kind, text: card } });
    return true;
  },
};
