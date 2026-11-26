// account-kind-muse.test.ts — issue #125 U12: Muse's kind records one login (muse.ts says why), so the
// `account-add` fulfiller refuses a Muse add with that reason before any folder or terminal, and the host scan
// lists only Muse's own folder. A kind that turns `multi` on fails here and brings its folder-login tests.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kindEnv, kindOf } from "../../bin/lib/account-kinds/index.ts";
import { accountsRoot } from "../../bin/lib/account-dirs.ts";
import { scanFolders } from "../../bin/lib/accounts-list.ts";
import { LoopActuator } from "../../bin/loop/core/actuator.ts";
import { open, type Row, type Store } from "../../bin/loop/core/store.ts";
import { Loop } from "../../bin/loop/core/tick.ts";
import { accountAdd, type Terminals } from "../../bin/loop/fulfil/account-add.ts";

const WHY = "Muse keeps one login (~/.config/muse)";
const T = 1_800_000_000;
const temps: string[] = [], stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "zzmuse-")); temps.push(d); return d; };

describe("Muse's account kind", () => {
  const muse = kindOf("muse");

  test("one login, with its reason and no folder variable or login command", () => {
    expect([muse.multi, muse.why, muse.systemId]).toEqual([false, WHY, "default"]);
    expect([muse.envVar, muse.login, muse.links]).toEqual([null, null, []]);
    expect(kindEnv(muse, "/f")).toEqual({});
  });

  test("a folder under the accounts root is no Muse account: only Muse's own folder is scanned", () => {
    const d = tmp(), env = { HOME: join(d, "home"), DS_STATE_ROOT: join(d, "state") };
    for (const f of [join(env.HOME, ".config", "muse"), join(accountsRoot(env), "muse", "second")]) {
      mkdirSync(f, { recursive: true });
      writeFileSync(join(f, "auth.json"), "{}");
    }
    expect(scanFolders(env).filter((l) => l.startsWith("muse\t")))
      .toEqual([`muse\t${join(env.HOME, ".config", "muse")}\t-\t1`]);
  });

  for (const withDir of [false, true]) {
    test(`an add${withDir ? " with a logged-in folder" : ""} is refused with the reason; no folder, terminal or row`, async () => {
      const d = tmp(), state = join(d, "state"), dir = join(d, "logged-in");
      mkdirSync(state);
      mkdirSync(dir);
      writeFileSync(join(dir, "auth.json"), "{}");
      const opened: string[] = [];
      const terms: Terminals = {
        async open(_x, project) { opened.push(project); return { via: "orca", handle: "t1", project }; },
        async read() { return null; },
        async close() {},
      };
      const s = open(state);
      stores.push(s);
      s.upsert("projects", { label: "fx" }, { studio_wt: "wt-studio", observed_at: T });
      const fulfil = accountAdd({ terminals: terms, env: { HOME: join(d, "home"), DS_STATE_ROOT: state } });
      const act = new LoopActuator({ fulfillers: [fulfil] });
      const loop = new Loop(s, { observers: [], reconcilers: [fulfil] }, act, { projects: () => ["fx"] });
      const id = Number(s.requestAny("account-add", { agent: "muse", name: "second", project: "fx", ...(withDir ? { dir } : {}) }, { project: "fx" }).row.id);
      await loop.tick(T);
      await act.drain();
      const row = s.db.query("SELECT result, done_at FROM requests WHERE id = ?").get(id) as Row;
      expect(row.done_at).not.toBeNull();
      expect(JSON.parse(String(row.result))).toMatchObject({ ok: false, state: "failed", error: WHY });
      expect(existsSync(accountsRoot({ DS_STATE_ROOT: state }))).toBe(false);
      expect(opened).toEqual([]);
      expect(s.db.query("SELECT account FROM accounts WHERE agent = 'muse' AND account != 'default'").all()).toEqual([]);
    });
  }
});
