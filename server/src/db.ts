import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

const SCHEMA = "afterlife-1";

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const ver = (db.prepare("SELECT value FROM kv WHERE key = 'schema'").get() as { value: string } | undefined)?.value;
  if (ver !== SCHEMA) {
    // Fresh start for the Solana version: drop every table from the old Robinhood build.
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('kv', 'sqlite_sequence')").all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of tables) db.exec(`DROP TABLE IF EXISTS "${t}"`);
    db.exec("DELETE FROM kv");
  }
  db.exec(`
    -- Bonded pump.fun coins (mint addresses are case-sensitive base58)
    CREATE TABLE IF NOT EXISTS coins (
      mint        TEXT PRIMARY KEY,
      symbol      TEXT, name TEXT, image TEXT,
      creator     TEXT NOT NULL,
      pool        TEXT,                    -- PumpSwap pool
      token_program TEXT,
      decimals    INTEGER NOT NULL DEFAULT 6,
      created_at  INTEGER NOT NULL,
      ath_usd     REAL, ath_at INTEGER,
      mcap_usd    REAL,                    -- from pump.fun
      last_trade_at INTEGER,
      seen_at     INTEGER NOT NULL
    );
    -- Live market data from DexScreener
    CREATE TABLE IF NOT EXISTS market (
      mint TEXT PRIMARY KEY, price_usd REAL, mcap_usd REAL, liq_usd REAL, vol24_usd REAL, fetched_at INTEGER NOT NULL
    );
    -- The graveyard
    CREATE TABLE IF NOT EXISTS graves (
      mint TEXT PRIMARY KEY, status TEXT NOT NULL, why TEXT NOT NULL, cause TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0, parts TEXT NOT NULL DEFAULT '{}',
      peak_usd REAL NOT NULL, now_usd REAL NOT NULL, peak_at INTEGER, died_at INTEGER,
      pool_sol REAL, dev_pct REAL, vol24_usd REAL, checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS graves_status ON graves(status, score);

    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY, ballot TEXT NOT NULL, practice INTEGER NOT NULL, locked INTEGER NOT NULL DEFAULT 0,
      winner TEXT, winner_reason TEXT, pump_status TEXT, pump_note TEXT,
      pre_usd REAL, sol_spent TEXT, tokens_out TEXT, burn_sig TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS votes (
      round_id INTEGER NOT NULL, address TEXT NOT NULL, mint TEXT NOT NULL, weight TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (round_id, address)
    );
    -- Each pump is split into a few buys. A buy's signature is saved before waiting, so nothing is bought twice.
    CREATE TABLE IF NOT EXISTS pump_legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER NOT NULL, idx INTEGER NOT NULL, mint TEXT NOT NULL,
      lamports TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      sig TEXT, amount_out TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, done_at INTEGER,
      UNIQUE (round_id, idx)
    );
    CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires INTEGER NOT NULL);
  `);
  db.prepare("INSERT INTO kv (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SCHEMA);
  return db;
}

/** Run `fn` inside one write transaction. Anything thrown rolls everything back. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const out = fn(); db.exec("COMMIT"); return out; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}
export function kvGet(db: DB, key: string): string | null {
  return (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
}
export function kvSet(db: DB, key: string, value: string) {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
