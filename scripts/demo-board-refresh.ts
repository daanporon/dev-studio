// demo-board-refresh.ts <loop.db> — keeps the demo board's temp loop.db looking live while it serves.
// The board reads a loop as down once its health row is older than board_stale_ticks ticks (60 s),
// and Orca's rows as stale likewise, so every few seconds this moves the loop's heartbeat and every
// observed_at to now. It writes only the temp db it is given (scripts/demo-board.sh passes its own).
import { Database } from "bun:sqlite";
const path = process.argv[2];
if (!path) { console.error("usage: demo-board-refresh.ts <loop.db>"); process.exit(2); }
const db = new Database(path);
db.exec("PRAGMA busy_timeout = 5000");
const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
  .map((t) => t.name).filter((n) => (db.query(`PRAGMA table_info(${n})`).all() as { name: string }[]).some((c) => c.name === "observed_at"));
const step = () => {
  const t = Math.floor(Date.now() / 1000);
  for (const n of tables) db.run(`UPDATE ${n} SET observed_at = ?`, [t]);
  db.run("UPDATE health SET tick_at = ?, progress_at = ? WHERE id = 1", [t, t]);
};
const every = Number(process.env.DEMO_REFRESH_S) > 0 ? Number(process.env.DEMO_REFRESH_S) : 5;
step();
setInterval(() => { try { step(); } catch { /* the db is going away */ } }, every * 1000);
