-- One row per player: the newest signed stats snapshot they have sent.
CREATE TABLE IF NOT EXISTS players (
  id          TEXT PRIMARY KEY,      -- derived from the player's public key
  name        TEXT NOT NULL,
  t           INTEGER NOT NULL,      -- snapshot time (unix seconds), from the signed entry
  played      INTEGER NOT NULL DEFAULT 0,
  opened      INTEGER NOT NULL DEFAULT 0,
  best_value  INTEGER NOT NULL DEFAULT 0,
  best_item   INTEGER NOT NULL DEFAULT -1,
  inv_value   INTEGER NOT NULL DEFAULT 0,
  entry       TEXT NOT NULL,         -- the full signed entry, so anyone can re-verify it
  updated_at  INTEGER NOT NULL,      -- server time of the last accepted update
  banned      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS players_inv    ON players (banned, inv_value DESC);
CREATE INDEX IF NOT EXISTS players_best   ON players (banned, best_value DESC);
CREATE INDEX IF NOT EXISTS players_opened ON players (banned, opened DESC);
CREATE INDEX IF NOT EXISTS players_played ON players (banned, played DESC);
