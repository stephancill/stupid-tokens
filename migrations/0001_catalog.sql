CREATE TABLE chains (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  platform_id TEXT NOT NULL UNIQUE,
  synced_at INTEGER
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  image_url TEXT,
  market_cap_usd REAL,
  market_cap_updated_at INTEGER,
  price_usd TEXT,
  price_updated_at INTEGER,
  fetched_at INTEGER,
  last_attempt_at INTEGER,
  refresh_after INTEGER NOT NULL DEFAULT 0,
  price_status TEXT NOT NULL DEFAULT 'price_unavailable'
);

CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  chain_id INTEGER NOT NULL REFERENCES chains(id),
  address TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id),
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL,
  image_url TEXT,
  metadata_updated_at INTEGER NOT NULL,
  UNIQUE(chain_id, address)
);
CREATE INDEX tokens_address ON tokens(address);
CREATE INDEX tokens_asset ON tokens(asset_id);
CREATE INDEX tokens_name ON tokens(name COLLATE NOCASE);
CREATE INDEX tokens_symbol ON tokens(symbol COLLATE NOCASE);

CREATE VIRTUAL TABLE token_search USING fts5(
  name, symbol, content='tokens', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER tokens_insert AFTER INSERT ON tokens BEGIN
  INSERT INTO token_search(rowid, name, symbol) VALUES (new.id, new.name, new.symbol);
END;
CREATE TRIGGER tokens_delete AFTER DELETE ON tokens BEGIN
  INSERT INTO token_search(token_search, rowid, name, symbol)
    VALUES ('delete', old.id, old.name, old.symbol);
END;
CREATE TRIGGER tokens_update AFTER UPDATE OF name, symbol ON tokens
WHEN old.name IS NOT new.name OR old.symbol IS NOT new.symbol BEGIN
  INSERT INTO token_search(token_search, rowid, name, symbol)
    VALUES ('delete', old.id, old.name, old.symbol);
  INSERT INTO token_search(rowid, name, symbol) VALUES (new.id, new.name, new.symbol);
END;

CREATE TABLE app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
