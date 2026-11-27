// fulfil/side-update.ts — side-loop-host U24: main's update reaches every side host. Once an `update` request has
// left main on a commit (`result.target`) and main's checkout is still on it, each accepted host whose link is up
// gets one `update` host job naming that commit (`side.update`, in the background), asked again every few seconds
// until the host says done or failed; the host restarts its own side loop on the way. A host that is unreachable
// gets the job when its link is back, if it is still behind. Each host's step is written into that request's
// result (squad/side-update.ts). A host still behind 10 minutes after its job is marked stuck, which is its
// Needs-you card; the card's Update files `host-update`, which starts the next attempt.
import { finishRequest, failRequest, requestActions, type Exec, type Fulfiller, type Result } from "../core/actuator.ts";
import type { Action, TickCtx } from "../core/plugins.ts";
import { ROOT } from "../core/store.ts";
import { redact } from "../core/redact.ts";
import { hostLink } from "../squad/host-reach.ts";
import { acceptedHosts, behindTarget, latestUpdate, setStep, STUCK_AFTER_S, type HostStep } from "../squad/side-update.ts";
import { updateOn } from "../../link/host-jobs.ts";
import type { SideUpdateAnswer } from "../../lib/side-update-job.ts";

const ASK_S = 10;
const KIND = "side.update";   // in the actuator's BACKGROUND_KINDS

export type SideUpdateOpts = { head?: () => string };   // the commit main's checkout is on

function headHere(): string {
  const r = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

function plan(ctx: TickCtx, head: () => string): Action[] {
  const hosts = acceptedHosts(ctx.store);
  if (!hosts.length) return [];
  const u = latestUpdate(ctx.store);
  // Main moved since (or the next update is mid-pull): sides follow a finished update only.
  if (!u || head() !== u.target) return [];
  const out: Action[] = [];
  for (const h of hosts) {
    const host = String(h.name);
    const step = u.hosts[host];
    const online = hostLink(ctx.store, host).state === "online";
    const behind = behindTarget(h.code_rev, u.target);
    const send = (attempt: number) => out.push({ project: "", subject: `host-update:${host}`, kind: KIND, episode: `${u.id}.${attempt}`, payload: { host, update: u.id, attempt } });
    if (!step) {
      if (online) send(1);
      else if (behind) setStep(ctx.store, u, host, { state: "waiting", attempt: 1 }, ctx.now);
      continue;
    }
    // A host that reports the target by itself is done; while its job runs, the job's answer says so.
    if (!behind && (step.state === "waiting" || step.state === "failed")) {
      setStep(ctx.store, u, host, { state: "done", attempt: step.attempt, rev: String(h.code_rev) }, ctx.now);
      continue;
    }
    if (online && (step.state === "waiting" || step.state === "running")) send(step.attempt);
    if (behind && step.state !== "done" && step.sent_at != null && step.stuck_at == null && ctx.now - step.sent_at >= STUCK_AFTER_S) {
      setStep(ctx.store, u, host, { ...step, stuck_at: ctx.now }, ctx.now);
    }
  }
  return out;
}

export function sideUpdates(opts: SideUpdateOpts = {}): Fulfiller {
  const head = opts.head ?? headHere;

  async function ask(a: Action, x: Exec): Promise<Result> {
    const { host, update, attempt } = a.payload as { host: string; update: number; attempt: number };
    // Read again around the call: a newer update or the card's Update replaces this attempt.
    const current = () => {
      const u = latestUpdate(x.store);
      return u && u.id === update && (u.hosts[host]?.attempt ?? 1) === attempt ? u : null;
    };
    const again = (why: string): Result => ({ wait: why, at: x.now + ASK_S });
    const before = current();
    if (!before) return { dropped: "a newer update or attempt replaced it" };
    if (!acceptedHosts(x.store).some((h) => h.name === host)) return { dropped: `no accepted host ${host}` };
    const had: HostStep = before.hosts[host] ?? { state: "waiting", attempt };
    if (had.state === "done" || had.state === "failed") return { done: true, result: had.state };
    if (hostLink(x.store, host).state !== "online") return again(`host ${host} is unreachable`);
    setStep(x.store, before, host, { ...had, state: "running", sent_at: had.sent_at ?? x.now }, x.now);

    return {
      background: (async (): Promise<Result> => {
        let got: SideUpdateAnswer | null = null, error = "";
        try { got = await updateOn(host, { commit: before.target, run: `${update}.${attempt}` }, { root: x.store.root, ...x.act.hostJobs() }); }
        catch (e) { error = redact((e as Error).message).slice(0, 300); }
        const u = current();
        if (!u) return { dropped: "a newer update or attempt replaced it" };
        const step = u.hosts[host]!;
        const save = (more: Partial<HostStep>) => setStep(x.store, u, host, { ...step, error: undefined, ...more }, x.now);
        if (!got) {
          // A host on code older than this job will never know it: no point asking again.
          const old = error.includes("unknown job");
          save({ state: old ? "failed" : "running", error: old ? `${error} — its code is older than this update: update it by hand once` : error });
          return old ? { done: true, result: "failed" } : again(error);
        }
        const log = redact(got.log);
        if (got.state === "running") { save({ line: got.line, log }); return again(`host ${host}: ${got.line}`); }
        if (got.state === "done" && got.rev === u.target) {
          // Its loop restarts only when loop code changed, so the link's hello may still name the old commit.
          x.store.db.run("UPDATE hosts SET code_rev = ? WHERE name = ?", [got.rev.slice(0, 12), host]);
          save({ state: "done", rev: got.rev.slice(0, 12), line: got.line, log: undefined, stuck_at: undefined });
          return { done: true, result: "done" };
        }
        const why = got.state === "done" ? `it ended on ${got.rev.slice(0, 12) || "an unknown commit"}, not ${u.target.slice(0, 12)}` : got.line;
        save({ state: "failed", error: redact(why).slice(0, 300), line: got.line, log });
        return { done: true, result: "failed" };
      })(),
    };
  }

  // The card's Update.
  function retry(a: Action, x: Exec): Result {
    const host = String((a.payload as { host?: unknown }).host ?? "");
    const refuse = (why: string): Result => { failRequest(a, x, why); return { done: true, result: `failed: ${why}` }; };
    if (!acceptedHosts(x.store).some((h) => h.name === host)) return refuse(`no accepted host ${host}`);
    const u = latestUpdate(x.store);
    if (!u) return refuse("no update to send: run ds update <project>");
    setStep(x.store, u, host, { state: "waiting", attempt: (u.hosts[host]?.attempt ?? 0) + 1 }, x.now);
    finishRequest(x.store, a, { ok: true, host, update: u.id }, x.now);
    return { done: true, result: `host ${host}: update asked again` };
  }

  return {
    name: "side-update",
    scope: "host",
    kinds: [KIND, "host-update"],
    run: (ctx) => [...requestActions(ctx, ["host-update"]), ...plan(ctx, head)],
    exec: (a, x) => (a.kind === KIND ? ask(a, x) : retry(a, x)),
    giveUp: (a, x, why) => (a.kind === KIND ? false : failRequest(a, x, why)),
  };
}

export default sideUpdates();
