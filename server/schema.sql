-- Case Opening Sim server schema. Safe to run more than once.

CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  name_lower  TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  played      INTEGER NOT NULL DEFAULT 0,
  opened      INTEGER NOT NULL DEFAULT 0,
  best_value  INTEGER NOT NULL DEFAULT 0,
  best_item   INTEGER NOT NULL DEFAULT -1,
  inv_value   INTEGER NOT NULL DEFAULT 0,
  inventory   TEXT NOT NULL DEFAULT '[]',   -- public copy, for choosing items to ask for in a trade
  stats_at    INTEGER NOT NULL DEFAULT 0,
  banned      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS players_name   ON players (name_lower);
CREATE INDEX IF NOT EXISTS players_seen   ON players (last_seen DESC);
CREATE INDEX IF NOT EXISTS players_inv    ON players (banned, inv_value DESC);
CREATE INDEX IF NOT EXISTS players_best   ON players (banned, best_value DESC);
CREATE INDEX IF NOT EXISTS players_opened ON players (banned, opened DESC);
CREATE INDEX IF NOT EXISTS players_played ON players (banned, played DESC);

CREATE TABLE IF NOT EXISTS trades (
  id            TEXT PRIMARY KEY,
  from_id       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  give          TEXT NOT NULL,        -- {"items":[[uid,idx,wear,float,tracker],...],"coins":n}
  want          TEXT NOT NULL,
  message       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL,        -- pending | accepted | declined | cancelled
  from_settled  INTEGER NOT NULL DEFAULT 0,
  to_settled    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_from ON trades (from_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS trades_to   ON trades (to_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS battles (
  id           TEXT PRIMARY KEY,
  creator      TEXT NOT NULL,
  case_id      TEXT NOT NULL,
  rounds       INTEGER NOT NULL,
  max_players  INTEGER NOT NULL,
  mode         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  players      TEXT NOT NULL,         -- [{"id","name","bot"?}] in seat order
  status       TEXT NOT NULL,         -- open | running | cancelled
  seed         TEXT,
  start_at     INTEGER,               -- milliseconds
  rev          INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS battles_status ON battles (status, created_at DESC);
