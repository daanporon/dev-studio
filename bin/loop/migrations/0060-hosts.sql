-- 0060-hosts.sql — side-loop-host U1 (issue #127, KTD4): the hosts that may run Builder, Tester and Researcher
-- seats for main. A side host asks to join with its name and its Ed25519 public key (`ds join`, U12); the
-- operator accepts it (`ds host accept`, or Accept on the board, U17). No secret is stored: only the public key.
--   name           the host's name (lowercase letters, digits, '-'; never `local`, which is main)
--   status         pending (a join request, expires after 15 minutes), accepted, removed (rejected or removed:
--                  the key is gone, a new join may ask again)
--   public_key     base64 of the SPKI DER of the Ed25519 public key; NULL once removed
--   fingerprint    the first 16 bytes of the SHA-256 of the raw public key, hex in groups of 4 (what both
--                  terminals show so the operator can compare)
--   seats          the host's Builder seats (KTD16), set on accept (default 2)
--   drain          1 while the host takes no new members (U16)
--   last_seen_at, link_version, up_migration, code_rev   what the link last heard (U2, KTD15)
--   unreachable_since, fenced_at                          the host-loss clock (U13, U15, KTD11)
CREATE TABLE hosts (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'removed')),
  public_key TEXT,
  fingerprint TEXT,
  seats INTEGER NOT NULL DEFAULT 2 CHECK (seats >= 0),
  drain INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT,
  removed_at INTEGER,
  removed_by TEXT,
  last_seen_at INTEGER,
  link_version TEXT,
  up_migration TEXT,
  code_rev TEXT,
  unreachable_since INTEGER,
  fenced_at INTEGER,
  CHECK (status = 'removed' OR public_key IS NOT NULL)
);
