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
CREATE INDEX IF NOT EXISTS signups_at ON signups (at);

-- Rate limits kept in the database: one row per counted request, cleared after a day.
CREATE TABLE IF NOT EXISTS hits (k TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS hits_k  ON hits (k, at);
CREATE INDEX IF NOT EXISTS hits_at ON hits (at);

-- Sign-up checks already used (each works for one account), and the key
-- that signs them. The key is made on first use and never leaves the server.
CREATE TABLE IF NOT EXISTS used_challenges (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS server_keys (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- The device, browser and network each account was used on, as keyed
-- hashes (never raw addresses), so the admin panel can link accounts made
-- on the same device. kind: d device id, f browser fingerprint, n network.
CREATE TABLE IF NOT EXISTS account_devices (
  account   TEXT NOT NULL,
  kind      TEXT NOT NULL,
  value     TEXT NOT NULL,
  label     TEXT NOT NULL DEFAULT '',                 -- e.g. "Chrome on Windows"
  first_at  INTEGER NOT NULL,
  last_at   INTEGER NOT NULL,
  PRIMARY KEY (account, kind, value)
);
CREATE INDEX IF NOT EXISTS account_devices_value ON account_devices (kind, value);
-- Devices, browsers or networks that can't make or log in to accounts.
CREATE TABLE IF NOT EXISTS device_bans (kind TEXT NOT NULL, value TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL,
                                        PRIMARY KEY (kind, value));

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
  locked      TEXT,                               -- 'o:<offer id>' while offered in a trade, 'm:<listing id>' while on the market
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
CREATE TABLE IF NOT EXISTS admin_accounts (account TEXT PRIMARY KEY, at INTEGER NOT NULL);   -- made admin with the key
CREATE TABLE IF NOT EXISTS server_gifts (
  id          TEXT PRIMARY KEY,                   -- the code is GIFT2.<id>
  coins       INTEGER NOT NULL,
  items       TEXT NOT NULL,                      -- [[idx, wear, float, tracker, value], ...]
  message     TEXT NOT NULL DEFAULT '',
  expires     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL
);

-- Market: items listed for coins. The item is locked 'm:<listing id>' while listed.
CREATE TABLE IF NOT EXISTS listings (
  id          TEXT PRIMARY KEY,
  seller      TEXT NOT NULL,
  item        INTEGER NOT NULL,                   -- items.id
  idx         INTEGER NOT NULL,
  wear        INTEGER NOT NULL,
  float       INTEGER NOT NULL,
  tracker     INTEGER NOT NULL,
  value       INTEGER NOT NULL,                   -- the game's value, for "best deal" sorting
  price       INTEGER NOT NULL CHECK (price > 0),
  status      TEXT NOT NULL,                      -- open | sold | cancelled
  buyer       TEXT,
  seen        INTEGER NOT NULL DEFAULT 0,         -- the seller has been told it sold
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_new    ON listings (status, created_at DESC);
CREATE INDEX IF NOT EXISTS listings_price  ON listings (status, price);
CREATE INDEX IF NOT EXISTS listings_idx    ON listings (status, idx);
CREATE INDEX IF NOT EXISTS listings_seller ON listings (seller, status);

-- Suggestions board
CREATE TABLE IF NOT EXISTS suggestions (
  id          TEXT PRIMARY KEY,
  author      TEXT NOT NULL,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',       -- open | planned | done | declined
  reply       TEXT NOT NULL DEFAULT '',           -- from an admin
  votes       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS suggestions_votes ON suggestions (votes DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS suggestions_new   ON suggestions (created_at DESC);
CREATE TABLE IF NOT EXISTS suggestion_votes (suggestion TEXT NOT NULL, account TEXT NOT NULL, PRIMARY KEY (suggestion, account));
CREATE INDEX IF NOT EXISTS suggestion_votes_account ON suggestion_votes (account);

-- Items a player locked so they can't be sold, upgraded, traded, listed or
-- used up by mistake. A lock belongs to the owner: it goes when the item
-- is deleted or changes hands.
CREATE TABLE IF NOT EXISTS item_locks (item INTEGER PRIMARY KEY, account TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS item_locks_account ON item_locks (account);
CREATE TRIGGER IF NOT EXISTS items_unlock_gone AFTER DELETE ON items BEGIN
  DELETE FROM item_locks WHERE item = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS items_unlock_moved AFTER UPDATE OF owner ON items WHEN OLD.owner <> NEW.owner BEGIN
  DELETE FROM item_locks WHERE item = NEW.id;
END;

-- Rewards: one row per reward claimed. period is 'W<day of its Monday>' or 'M<year>-<month>'.
CREATE TABLE IF NOT EXISTS reward_claims (
  account  TEXT NOT NULL,
  period   TEXT NOT NULL,
  slot     INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (account, period, slot)
);

-- Battle invites, and lobbies only invited players can join.
CREATE TABLE IF NOT EXISTS lobby_invites (
  lobby    TEXT NOT NULL,
  account  TEXT NOT NULL,
  from_id  TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (lobby, account)
);
CREATE INDEX IF NOT EXISTS lobby_invites_account ON lobby_invites (account);
CREATE TABLE IF NOT EXISTS private_lobbies (lobby TEXT PRIMARY KEY);
