import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    -- Every pons coin, from the factories' TokenLaunched events
    CREATE TABLE IF NOT EXISTS coins (
      token        TEXT PRIMARY KEY,          -- lowercase address
      pool         TEXT NOT NULL,             -- lowercase Uniswap v3 pool address
      deployer     TEXT NOT NULL,             -- the coin's creator (the "dev")
      initial_buy  TEXT NOT NULL DEFAULT '0', -- tokens the dev bought at launch
      is_token0    INTEGER NOT NULL,          -- 1 when the coin is token0 in the pool
      symbol       TEXT,
      name         TEXT,
      supply       TEXT NOT NULL DEFAULT '1000000000000000000000000000',
      launch_block INTEGER NOT NULL,
      launch_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS coins_pool ON coins(pool);

    -- Hourly candles built from the pool's Swap events. Prices are in ETH per whole token.
    CREATE TABLE IF NOT EXISTS hourly (
      token  TEXT NOT NULL,
      hour   INTEGER NOT NULL,               -- unix ms at the start of the hour
      open   REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      vol_eth REAL NOT NULL DEFAULT 0,
      swaps  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (token, hour)
    );

    -- Latest known price per coin (price only moves when someone swaps)
    CREATE TABLE IF NOT EXISTS prices (
      token        TEXT PRIMARY KEY,
      price        REAL NOT NULL,
      last_swap_at INTEGER NOT NULL
    );

    -- The graveyard: coins that died, and whether they can be revived
    CREATE TABLE IF NOT EXISTS graves (
      token       TEXT PRIMARY KEY,
      status      TEXT NOT NULL,            -- ok | wait | fresh | no
      why         TEXT NOT NULL,
      cause       TEXT NOT NULL,            -- dev | fade
      score       INTEGER NOT NULL DEFAULT 0,
      parts       TEXT NOT NULL DEFAULT '{}',
      peak_usd    REAL NOT NULL,
      now_usd     REAL NOT NULL,
      peak_at     INTEGER,
      died_at     INTEGER,
      pool_eth    REAL,
      dev_pct     REAL,
      holders     INTEGER,
      sell_ok     INTEGER,
      checked_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS graves_status ON graves(status, score);

    -- $NECRO balances, for vote weight
    CREATE TABLE IF NOT EXISTS necro_balances (address TEXT PRIMARY KEY, balance TEXT NOT NULL);

    -- One round per hour
    CREATE TABLE IF NOT EXISTS rounds (
      id            INTEGER PRIMARY KEY,      -- hour number since 1970
      ballot        TEXT NOT NULL,            -- JSON list of token addresses
      practice      INTEGER NOT NULL,         -- 1 = before $NECRO launch, one wallet one vote
      locked        INTEGER NOT NULL DEFAULT 0,
      winner        TEXT,
      winner_reason TEXT,
      pump_status   TEXT,                     -- NULL | pending | done | partial | skipped
      pump_note     TEXT,
      pre_price     REAL,
      eth_spent     TEXT,
      tokens_out    TEXT,
      created_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS round_balances (round_id INTEGER NOT NULL, address TEXT NOT NULL, balance TEXT NOT NULL, PRIMARY KEY (round_id, address));
    CREATE TABLE IF NOT EXISTS votes (
      round_id INTEGER NOT NULL,
      address  TEXT NOT NULL,
      token    TEXT NOT NULL,
      weight   TEXT NOT NULL,
      at       INTEGER NOT NULL,
      PRIMARY KEY (round_id, address)
    );

    -- Each pump is split into a few buys. A buy's tx hash is saved before waiting, so nothing is ever bought twice.
    CREATE TABLE IF NOT EXISTS pump_legs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id   INTEGER NOT NULL,
      idx        INTEGER NOT NULL,
      token      TEXT NOT NULL,
      amount_in  TEXT NOT NULL,               -- wei of WETH
      due_at     INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending', -- pending | submitted | done | failed
      tx_hash    TEXT,
      amount_out TEXT,
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      done_at    INTEGER,
      UNIQUE (round_id, idx)
    );

    CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, block TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

/** Run `fn` inside one write transaction. Anything thrown rolls everything back. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getCursor(db: DB, name: string): bigint | null {
  const r = db.prepare("SELECT block FROM cursors WHERE name = ?").get(name) as { block: string } | undefined;
  return r ? BigInt(r.block) : null;
}
export function setCursor(db: DB, name: string, block: bigint) {
  db.prepare("INSERT INTO cursors (name, block) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET block = excluded.block").run(name, block.toString());
}
export function kvGet(db: DB, key: string): string | null {
  const r = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
export function kvSet(db: DB, key: string, value: string) {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
