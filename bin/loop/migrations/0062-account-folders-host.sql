-- 0062-account-folders-host.sql — side-loop-host U18 (issue #127): each login has a folder per host.
--   account_folders           one row per account and host where that login has a folder. Never copied between
--                             hosts: a side host's row comes from the folders it scanned itself.
--     host                    `local` (main) or a hosts.name
--     dir                     the folder on that host; on a `local` row NULL means the default rule
--                             (bin/lib/account-dirs.ts accountFolder: Orca's profile folder, the agent's own folder,
--                             or <accounts root>/<agent>/<account>)
--     observed_at             when the state observer last wrote the row's dir (epoch s)
--                             Main's state observer keeps the rows each tick (capacity/accounts.ts syncAccountFolders):
--                             `local` rows follow accounts.config_dir, a side host's rows are its scanned folders whose
--                             login id is an account's login id.
--   observed_account_folders  gains `host`: the host whose observer scanned the folder. Main's own scan writes `local`
--                             and replaces only its own rows; a side host's rows come up the link (bin/link/replica.ts)
--                             with `dir` as `<host>::<path>`, so two hosts never share a key.
CREATE TABLE account_folders (
  agent       TEXT NOT NULL,
  account     TEXT NOT NULL,
  host        TEXT NOT NULL DEFAULT 'local',
  dir         TEXT,
  observed_at INTEGER,
  PRIMARY KEY (agent, account, host)
);

-- Seed: every row of today's list is a `local` folder, as its config_dir says.
INSERT INTO account_folders (agent, account, host, dir) SELECT agent, account, 'local', config_dir FROM accounts;

ALTER TABLE observed_account_folders ADD COLUMN host TEXT NOT NULL DEFAULT 'local';
