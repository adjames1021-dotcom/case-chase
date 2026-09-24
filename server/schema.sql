-- Case Sim cloud schema. Runs on every deploy that changes it, so every
-- statement must be safe to run again (IF NOT EXISTS / IF EXISTS).

-- The first online version kept inventories on players' devices. Its tables
-- are dropped: cloud accounts start fresh.
DROP TABLE IF EXISTS players;
DROP TABLE IF EXISTS trades;
DROP TABLE IF EXISTS battles;

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_lower  TEXT NOT NULL UNIQUE,
  pass        TEXT NOT NULL,                      -- pbkdf2$<iterations>$<salt>$<hash>
  coins       INTEGER NOT NULL DEFAULT 500 CHECK (coins >= 0),
  opened      INTEGER NOT NULL DEFAULT 0,
  best_value  INTEGER NOT NULL DEFAULT 0,
  best_item   INTEGER NOT NULL DEFAULT -1,
  played      INTEGER NOT NULL DEFAULT 0,         -- seconds
  inv_value   INTEGER NOT NULL DEFAULT 0,         -- kept up to date by the item triggers
  inv_count   INTEGER NOT NULL DEFAULT 0,
  rev         INTEGER NOT NULL DEFAULT 0,         -- bumps on any change to coins or items
  last_free   INTEGER NOT NULL DEFAULT 0,         -- ms, free-case cooldown
  last_ping   INTEGER NOT NULL DEFAULT 0,         -- s, time-played heartbeat
  fail_count  INTEGER NOT NULL DEFAULT 0,         -- failed logins in a row
  fail_at     INTEGER NOT NULL DEFAULT 0,
  banned      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_inv    ON accounts (banned, inv_value DESC);
CREATE INDEX IF NOT EXISTS accounts_best   ON accounts (banned, best_value DESC);
CREATE INDEX IF NOT EXISTS accounts_opened ON accounts (banned, opened DESC);
CREATE INDEX IF NOT EXISTS accounts_played ON accounts (banned, played DESC);
CREATE INDEX IF NOT EXISTS accounts_seen   ON accounts (last_seen DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  account     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_account ON sessions (account);

CREATE TABLE IF NOT EXISTS signups (ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS signups_ip ON signups (ip, at);

-- Every item in the game. Item identity is the drop-table index plus wear,
-- float and tracker; value is computed from those when the item is made.
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner       TEXT NOT NULL,
  idx         INTEGER NOT NULL,
  wear        INTEGER NOT NULL,                   -- 0 none, 1-5 FN..BS
  float       INTEGER NOT NULL,                   -- x10000
  tracker     INTEGER NOT NULL,
  value       INTEGER NOT NULL,
  locked      TEXT,                               -- 'o:<offer id>' while offered in a trade
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_owner  ON items (owner, locked);
CREATE INDEX IF NOT EXISTS items_locked ON items (locked);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  UPDATE accounts SET inv_value = inv_value + NEW.value, inv_count = inv_count + 1, rev = rev + 1 WHERE id = NEW.owner;
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  UPDATE accounts SET inv_value = inv_value - OLD.value, inv_count = inv_count - 1, rev = rev + 1 WHERE id = OLD.owner;
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF owner, locked ON items BEGIN
  UPDATE accounts SET inv_value = inv_value - OLD.value, inv_count = inv_count - 1, rev = rev + 1 WHERE id = OLD.owner;
  UPDATE accounts SET inv_value = inv_value + NEW.value, inv_count = inv_count + 1, rev = rev + 1 WHERE id = NEW.owner;
END;
CREATE TRIGGER IF NOT EXISTS accounts_coins AFTER UPDATE OF coins ON accounts BEGIN
  UPDATE accounts SET rev = rev + 1 WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS offers (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  give        TEXT NOT NULL,                      -- [[id, idx, wear, float, tracker], ...] offered by from_id
  give_coins  INTEGER NOT NULL,
  want        TEXT NOT NULL,                      -- the same, asked of to_id
  want_coins  INTEGER NOT NULL,
  message     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,                      -- pending | accepted | declined | cancelled
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS offers_from ON offers (from_id, status);
CREATE INDEX IF NOT EXISTS offers_to   ON offers (to_id, status);

CREATE TABLE IF NOT EXISTS lobbies (
  id           TEXT PRIMARY KEY,
  creator      TEXT NOT NULL,
  case_id      TEXT NOT NULL,
  rounds       INTEGER NOT NULL,
  max_players  INTEGER NOT NULL,
  mode         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  cost         INTEGER NOT NULL,                  -- entry per seat
  players      TEXT NOT NULL,                     -- [{"id","name","bot"?}] in seat order
  status       TEXT NOT NULL,                     -- open | running | cancelled
  seed         TEXT,
  start_at     INTEGER,                           -- ms
  winner       INTEGER,                           -- seat index
  rev          INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS lobbies_status  ON lobbies (status, created_at DESC);
CREATE INDEX IF NOT EXISTS lobbies_creator ON lobbies (creator, status);

CREATE TABLE IF NOT EXISTS gift_claims (
  gift_id     TEXT NOT NULL,
  account     TEXT NOT NULL,
  at          INTEGER NOT NULL,
  PRIMARY KEY (gift_id, account)
);

-- One-row table used as an assertion inside transactions: writing ok = 0
-- breaks the CHECK and rolls the whole transaction back.
CREATE TABLE IF NOT EXISTS guards (k INTEGER PRIMARY KEY, ok INTEGER NOT NULL CHECK (ok = 1));

-- Admin tools
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);        -- announcement, maintenance
CREATE TABLE IF NOT EXISTS admin_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  detail  TEXT
);
CREATE TABLE IF NOT EXISTS admin_nonces (n TEXT PRIMARY KEY, at INTEGER NOT NULL);   -- each signed request works once
CREATE TABLE IF NOT EXISTS revoked_gifts (gift_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ban_reasons (account TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL);
