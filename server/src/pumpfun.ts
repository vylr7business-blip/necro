// Where the coins come from:
//  - pump.fun's own API: every coin that bonded (complete = true), with its creator, PumpSwap pool and all-time-high market cap.
//    The API only pages ~2,000 deep per sort, so several sort orders are combined.
//  - DexScreener: live price, liquidity and 24h volume for the coins that already look dead (30 coins per request).
import { CONFIG, PUMP_API } from "./config.js";
import { type DB, kvSet, tx } from "./db.js";

type PumpCoin = {
  mint: string; name: string; symbol: string; image_uri: string | null; creator: string; created_timestamp: number; complete: boolean;
  market_cap: number | null; usd_market_cap?: number | null; ath_market_cap: number | null; ath_market_cap_timestamp: number | null;
  last_trade_timestamp: number | null; pump_swap_pool: string | null; pool_address?: string | null; token_program?: string | null;
  base_decimals?: number | null; is_banned?: boolean; nsfw?: boolean; chain_id?: string;
};

const HEADERS = { accept: "application/json", origin: "https://pump.fun", referer: "https://pump.fun/" };
const SORTS = ["ath_market_cap", "created_timestamp", "last_trade_timestamp", "market_cap"];
const PAGE = 50, MAX_OFFSET = 1950;

async function page(sort: string, offset: number): Promise<PumpCoin[] | null> {
  try {
    const u = `${PUMP_API}/coins?includeNsfw=false&complete=true&sort=${sort}&order=DESC&limit=${PAGE}&offset=${offset}`;
    const r = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j) ? (j as PumpCoin[]) : null;
  } catch { return null; }
}

/** Pull bonded coins from pump.fun (all sort orders), about every 30 minutes. */
export async function syncPumpFun(db: DB) {
  const seen = new Map<string, PumpCoin>();
  for (const sort of SORTS) {
    for (let off = 0; off <= MAX_OFFSET; off += PAGE) {
      const list = await page(sort, off);
      if (!list || !list.length) break;
      for (const c of list) if (c.complete && !c.is_banned && (!c.chain_id || c.chain_id.startsWith("solana"))) seen.set(c.mint, c);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const now = Date.now();
  tx(db, () => {
    const up = db.prepare(`INSERT INTO coins (mint, symbol, name, image, creator, pool, token_program, decimals, created_at, ath_usd, ath_at, mcap_usd, last_trade_at, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint) DO UPDATE SET symbol=excluded.symbol, name=excluded.name, image=excluded.image, pool=excluded.pool, ath_usd=excluded.ath_usd,
        ath_at=excluded.ath_at, mcap_usd=excluded.mcap_usd, last_trade_at=excluded.last_trade_at, seen_at=excluded.seen_at`);
    for (const c of seen.values()) {
      up.run(c.mint, (c.symbol || "?").slice(0, 24), (c.name || "").slice(0, 64), c.image_uri ?? null, c.creator, c.pump_swap_pool ?? c.pool_address ?? null,
        c.token_program ?? null, c.base_decimals ?? 6, c.created_timestamp, c.ath_market_cap ?? null, c.ath_market_cap_timestamp ?? null,
        c.usd_market_cap ?? c.market_cap ?? null, c.last_trade_timestamp ?? null, now);
    }
  });
  kvSet(db, "pumpfun_synced_at", String(now));
  console.log(`[pump.fun] ${seen.size} bonded coins synced`);
}

type DexPair = { chainId: string; dexId: string; pairAddress: string; baseToken: { address: string }; priceUsd?: string; marketCap?: number; fdv?: number; liquidity?: { usd?: number }; volume?: { h24?: number } };

/** Live data from DexScreener for coins that look dead by pump.fun's numbers. Up to 30 coins per request. */
export async function refreshMarket(db: DB, perPass = 600) {
  const due = db.prepare(`SELECT c.mint FROM coins c LEFT JOIN market m ON m.mint = c.mint
      WHERE c.ath_usd BETWEEN ? AND ? AND c.mcap_usd <= c.ath_usd * ? AND (m.fetched_at IS NULL OR m.fetched_at < ?)
      ORDER BY m.fetched_at IS NOT NULL, m.fetched_at, c.ath_usd DESC LIMIT ?`)
    .all(CONFIG.minAthUsd, CONFIG.maxAthUsd, 1 - CONFIG.minDropPct / 100 + 0.05, Date.now() - 30 * 60_000, perPass) as Array<{ mint: string }>;
  for (let i = 0; i < due.length; i += 30) {
    const batch = due.slice(i, i + 30).map((d) => d.mint);
    let pairs: DexPair[] = [];
    try {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 429) { console.warn("[dexscreener] rate limited"); break; }
      if (r.ok) pairs = (await r.json()) as DexPair[];
    } catch { continue; }
    const best = new Map<string, DexPair>();
    for (const p of pairs) {
      const cur = best.get(p.baseToken.address);
      if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(p.baseToken.address, p);
    }
    const now = Date.now();
    tx(db, () => {
      const up = db.prepare(`INSERT INTO market (mint, price_usd, mcap_usd, liq_usd, vol24_usd, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(mint) DO UPDATE SET price_usd=excluded.price_usd, mcap_usd=excluded.mcap_usd, liq_usd=excluded.liq_usd, vol24_usd=excluded.vol24_usd, fetched_at=excluded.fetched_at`);
      for (const m of batch) {
        const p = best.get(m);
        up.run(m, p?.priceUsd ? Number(p.priceUsd) : null, p ? (p.marketCap ?? p.fdv ?? null) : null, p?.liquidity?.usd ?? 0, p?.volume?.h24 ?? 0, now);
      }
    });
    await new Promise((r) => setTimeout(r, 250)); // DexScreener allows ~300 requests a minute
  }
  if (due.length) console.log(`[dexscreener] ${due.length} coins refreshed`);
}

export function startPumpFun(db: DB) {
  let syncing = false, refreshing = false;
  const sync = async () => { if (syncing) return; syncing = true; try { await syncPumpFun(db); } catch (e) { console.error("[pump.fun]", (e as Error).message); } finally { syncing = false; } };
  const refresh = async () => { if (refreshing) return; refreshing = true; try { await refreshMarket(db); } catch (e) { console.error("[dexscreener]", (e as Error).message); } finally { refreshing = false; } };
  void sync().then(refresh);
  setInterval(sync, 30 * 60_000);
  setInterval(refresh, 60_000);
}
