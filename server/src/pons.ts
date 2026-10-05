// The coin list comes from pons itself: every coin that graduated on pons (it really lived, liquidity is locked,
// no honeypot code). For now only pons v1 coins with a Uniswap v3 WETH pool are used, because that's what the pump bot can buy.
import { ADDR } from "./config.js";
import { type DB, kvSet, tx } from "./db.js";

const PONS = "https://www.ponsfamily.com/api";
type Grad = { token: string; deployer: string; pool: string; pairToken: string; blockNumber: number; launchedAt: string; initialBuyWei: string; name: string; symbol: string; priceUsd: number | null; marketCapUsd: number | null };

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch { return null; }
}

export async function syncPons(db: DB, ethUsd: number) {
  const raw = await getJson<Record<string, Grad> | Grad[]>(`${PONS}/pons-launches/graduations?catalog=1&v=12`);
  if (!raw) { console.warn("[pons] catalog unavailable"); return; }
  const weth = ADDR.weth.toLowerCase();
  const list = (Array.isArray(raw) ? raw : Object.values(raw)).filter((g) => g.pool && !/^0x0+$/.test(g.pool) && g.pairToken?.toLowerCase() === weth);
  const now = Date.now();
  tx(db, () => {
    const ins = db.prepare(`INSERT INTO coins (token, pool, deployer, initial_buy, is_token0, symbol, name, supply, launch_block, launch_at, watched, pons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
      ON CONFLICT(token) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, watched = 1, pons = 1`);
    const mk = db.prepare(`INSERT INTO market (token, price_eth, mcap_usd, vol24_eth, fetched_at) VALUES (?, ?, ?, 0, 0)
      ON CONFLICT(token) DO UPDATE SET mcap_usd = excluded.mcap_usd`);
    for (const g of list) {
      const t = g.token.toLowerCase();
      ins.run(t, g.pool.toLowerCase(), g.deployer.toLowerCase(), g.initialBuyWei || "0", t < weth ? 1 : 0, (g.symbol || "?").slice(0, 24), (g.name || "").slice(0, 64),
        (10n ** 27n).toString(), g.blockNumber, Date.parse(g.launchedAt) || now);
      mk.run(t, g.priceUsd && ethUsd ? g.priceUsd / ethUsd : null, g.marketCapUsd ?? null);
    }
  });
  // Dev check straight from pons: the share of supply each creator still holds.
  for (let i = 0; i < list.length; i += 40) {
    const pairs = list.slice(i, i + 40).map((g) => `${g.token}:${g.deployer}`).join(",");
    const j = await getJson<{ holdings: Array<{ token: string; fraction: number | null }> }>(`${PONS}/pons-creator-holdings?pairs=${encodeURIComponent(pairs)}`);
    if (!j?.holdings) continue;
    const up = db.prepare("UPDATE coins SET dev_frac = ? WHERE token = ?");
    tx(db, () => { for (const h of j.holdings) if (typeof h.fraction === "number") up.run(h.fraction, h.token.toLowerCase()); });
  }
  kvSet(db, "pons_synced_at", String(now));
  console.log(`[pons] ${list.length} graduated v1 coins synced`);
}

export function startPons(db: DB, ethUsd: () => Promise<number>, everyMs = 30 * 60_000) {
  const run = async () => { try { await syncPons(db, await ethUsd().catch(() => 2700)); } catch (e) { console.error("[pons]", (e as Error).message); } };
  void run();
  return setInterval(run, everyMs);
}
