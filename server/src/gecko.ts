// Market data from GeckoTerminal's public API (it indexes every Uniswap pool on Robinhood Chain).
// The public RPC can't serve trade history at this volume, so prices, volume and daily history come from here.
//  - market:  current price (ETH), market cap, 24h volume for every pool with ETH left. 30 pools per request.
//  - history: daily candles (in ETH) since launch, only for coins that look dead. One request per coin.
import { CONFIG } from "./config.js";
import { type DB, kvSet, tx } from "./db.js";
import { DAY, HOUR } from "./rules.js";

const API = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const SPACING_MS = 2_500; // GeckoTerminal's free API allows about 30 requests a minute
const MARKET_EVERY_MS = HOUR;
const HISTORY_EVERY_MS = 12 * HOUR;
let nextAt = 0;
let pausedUntil = 0;

async function get<T>(path: string): Promise<T | null> {
  const wait = Math.max(nextAt, pausedUntil) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextAt = Date.now() + SPACING_MS;
  try {
    const r = await fetch(API + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 429) { pausedUntil = Date.now() + 60_000; console.warn("[gecko] rate limited, pausing 60s"); return null; }
    if (r.status === 404) return null;
    if (!r.ok) { console.warn(`[gecko] ${r.status} on ${path.slice(0, 80)}`); return null; }
    return (await r.json()) as T;
  } catch (e) {
    console.warn(`[gecko] ${(e as Error).message}`);
    return null;
  }
}

type MultiPool = { attributes: { address: string; base_token_price_native_currency: string | null; fdv_usd: string | null; market_cap_usd: string | null; reserve_in_usd: string | null; volume_usd: { h24: string | null } } };

/** v2 coins trade in Uniswap v4 pools; find each one's pool id on GeckoTerminal by token address (a few per pass). */
async function resolveV4(db: DB, perPass = 6) {
  const due = db.prepare("SELECT token FROM coins WHERE venue = 'v4' AND gt_pool IS NULL LIMIT ?").all(perPass) as Array<{ token: string }>;
  for (const c of due) {
    const j = await get<{ data: Array<{ attributes: { address: string } }> }>(`/tokens/${c.token}/pools?page=1`);
    if (!j) continue;
    const id = j.data?.[0]?.attributes?.address?.toLowerCase();
    db.prepare("UPDATE coins SET gt_pool = ? WHERE token = ?").run(id ?? "none", c.token);
  }
}

/** Refresh current price / volume for up to 10 x 30 pools per pass, oldest first. */
export async function refreshMarket(db: DB, ethUsd: number) {
  const due = db.prepare(`SELECT c.token, COALESCE(c.gt_pool, c.pool) AS pool FROM coins c LEFT JOIN market m ON m.token = c.token
                          WHERE c.watched = 1 AND (c.venue = 'v3' OR (c.gt_pool IS NOT NULL AND c.gt_pool != 'none')) AND (m.fetched_at IS NULL OR m.fetched_at < ?) ORDER BY m.fetched_at IS NOT NULL, m.fetched_at LIMIT 300`)
    .all(Date.now() - MARKET_EVERY_MS) as Array<{ token: string; pool: string }>;
  for (let i = 0; i < due.length; i += 30) {
    const batch = due.slice(i, i + 30);
    const j = await get<{ data: MultiPool[] }>(`/pools/multi/${batch.map((b) => b.pool).join(",")}`);
    if (!j) continue;
    const byPool = new Map(j.data.map((p) => [p.attributes.address.toLowerCase(), p.attributes]));
    const now = Date.now();
    tx(db, () => {
      const up = db.prepare(`INSERT INTO market (token, price_eth, mcap_usd, vol24_eth, reserve_usd, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET price_eth = excluded.price_eth, mcap_usd = excluded.mcap_usd, vol24_eth = excluded.vol24_eth, reserve_usd = excluded.reserve_usd, fetched_at = excluded.fetched_at`);
      const px = db.prepare(`INSERT INTO prices (token, price, last_swap_at) VALUES (?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET price = excluded.price, last_swap_at = COALESCE(prices.last_swap_at, excluded.last_swap_at)`);
      for (const b of batch) {
        const a = byPool.get(b.pool);
        if (!a) { up.run(b.token, null, null, 0, null, now); continue; } // not indexed: never traded
        const price = Number(a.base_token_price_native_currency ?? 0);
        const vol = Number(a.volume_usd?.h24 ?? 0) / (ethUsd || 1);
        up.run(b.token, price || null, Number(a.fdv_usd ?? a.market_cap_usd ?? 0) || null, vol, Number(a.reserve_in_usd ?? 0) || null, now);
        if (price > 0) px.run(b.token, price, now);
      }
    });
  }
  if (due.length) console.log(`[gecko] market: ${due.length} pools refreshed`);
}

/** Daily history for coins that look dead: quiet in the last 24h. Most ETH left in the pool goes first. */
export async function refreshHistory(db: DB, ethUsd: number, perPass = 12) {
  const due = db.prepare(`SELECT c.token, COALESCE(c.gt_pool, c.pool) AS pool FROM coins c JOIN market m ON m.token = c.token
                          WHERE c.watched = 1 AND m.price_eth IS NOT NULL AND (c.venue = 'v3' OR (c.gt_pool IS NOT NULL AND c.gt_pool != 'none')) AND m.vol24_eth < ? AND (m.hist_at IS NULL OR m.hist_at < ?)
                          ORDER BY m.hist_at IS NOT NULL, c.pool_eth DESC LIMIT ?`)
    .all(CONFIG.quietVol24hEth, Date.now() - HISTORY_EVERY_MS, perPass) as Array<{ token: string; pool: string }>;
  for (const c of due) {
    const j = await get<{ data: { attributes: { ohlcv_list: number[][] } } }>(`/pools/${c.pool}/ohlcv/day?limit=1000&currency=token&token=${c.token}`);
    if (!j) continue;
    const list = j.data?.attributes?.ohlcv_list ?? [];
    tx(db, () => {
      db.prepare("DELETE FROM hourly WHERE token = ?").run(c.token);
      const ins = db.prepare("INSERT OR REPLACE INTO hourly (token, hour, open, high, low, close, vol_eth, swaps) VALUES (?, ?, ?, ?, ?, ?, ?, 0)");
      for (const [ts, o, h, l, cl, v] of list) ins.run(c.token, ts * 1000, o, h, l, cl, v);
      // last day with real trading volume = roughly when it last traded
      const lastActive = list.filter((x) => x[5] > 0.0005).reduce((m, x) => Math.max(m, x[0] * 1000), 0);
      if (lastActive) db.prepare("UPDATE prices SET last_swap_at = ? WHERE token = ?").run(lastActive + DAY - 1, c.token);
      db.prepare("UPDATE market SET hist_at = ? WHERE token = ?").run(Date.now(), c.token);
    });
  }
  const left = (db.prepare(`SELECT COUNT(*) AS n FROM coins c JOIN market m ON m.token = c.token WHERE c.watched = 1 AND m.price_eth IS NOT NULL AND m.vol24_eth < ? AND m.hist_at IS NULL`)
    .get(CONFIG.quietVol24hEth) as { n: number }).n;
  if (due.length) console.log(`[gecko] history: ${due.length} coins read, ${left} quiet coins still waiting`);
  kvSet(db, "history_left", String(left));
}

export function startGecko(db: DB, ethUsd: () => Promise<number>, everyMs = 10_000) {
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      const usd = await ethUsd().catch(() => 2700);
      await resolveV4(db);
      await refreshMarket(db, usd);
      await refreshHistory(db, usd);
    } catch (e) { console.error("[gecko]", (e as Error).message); }
    finally { running = false; }
  };
  void loop();
  return setInterval(loop, everyMs);
}
