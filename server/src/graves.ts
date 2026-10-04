// Decides which coins are dead, why, and which ones can be revived. Runs every few minutes.
import type { Address } from "viem";
import { ADDR, CONFIG, PONS_FEE } from "./config.js";
import { ABI, publicClient } from "./chain.js";
import { type DB, kvSet, tx } from "./db.js";
import { ethUsd, quoteIn } from "./prices.js";
import { DAY, HOUR, type Candle, causeOfDeath, isBuried, lifeOf, revivable, revivalScore } from "./rules.js";

export const RULES = {
  minPeakUsd: CONFIG.minPeakUsd, minDropPct: CONFIG.minDropPct, quietVol24hEth: CONFIG.quietVol24hEth,
  minDeadDays: CONFIG.minDeadDays, minPoolEth: CONFIG.minPoolEth, maxDevPct: CONFIG.maxDevPct, cooldownHours: CONFIG.cooldownHours,
};

const RECHECK_MS = 30 * 60_000; // chain checks for one grave at most every 30 minutes
const HOLDERS_MS = 6 * HOUR;
const holdersCache = new Map<string, { n: number | null; at: number }>();

async function holderCount(token: string): Promise<number | null> {
  const hit = holdersCache.get(token);
  if (hit && Date.now() - hit.at < HOLDERS_MS) return hit.n;
  let n: number | null = null;
  try {
    const r = await fetch(`${CONFIG.blockscoutApi}/tokens/${token}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = (await r.json()) as { holders_count?: string | number; holders?: string | number };
      const v = Number(j.holders_count ?? j.holders);
      n = Number.isFinite(v) ? v : null;
    }
  } catch { /* explorer is optional */ }
  holdersCache.set(token, { n, at: Date.now() });
  return n;
}

type CoinRow = { token: string; pool: string; deployer: string; initial_buy: string; supply: string; price: number | null; last_swap_at: number | null };

export async function evaluateOnce(db: DB, now = Date.now()) {
  const usd = await ethUsd();
  const coins = db.prepare(`SELECT c.token, c.pool, c.deployer, c.initial_buy, c.supply, p.price, p.last_swap_at
                            FROM coins c LEFT JOIN prices p ON p.token = c.token`).all() as CoinRow[];
  const candlesOf = db.prepare("SELECT hour, close, vol_eth FROM hourly WHERE token = ? ORDER BY hour");
  const lastPump = db.prepare("SELECT MAX(id) AS id FROM rounds WHERE winner = ? AND pump_status IN ('done','partial')");
  const prevGrave = db.prepare("SELECT checked_at, pool_eth, dev_pct, sell_ok, holders, cause FROM graves WHERE token = ?");

  type Out = { token: string; status: string; why: string; cause: string; score: number; parts: string; peakUsd: number; nowUsd: number; peakAt: number; diedAt: number | null; poolEth: number | null; devPct: number | null; holders: number | null; sellOk: number | null; checkedAt: number };
  const out: Out[] = [];
  const alive: string[] = [];

  for (const c of coins) {
    if (c.price === null) continue; // never traded
    const candles = candlesOf.all(c.token) as Candle[];
    const supply = Number(BigInt(c.supply) / 10n ** 12n) / 1e6; // whole tokens
    const life = lifeOf(candles, c.price, CONFIG.minDropPct);
    const peakUsd = life.peak * supply * usd, nowUsd = life.now * supply * usd;
    const vol24 = candles.filter((x) => x.hour >= now - DAY).reduce((a, x) => a + x.vol_eth, 0);
    if (!isBuried({ peakUsd, nowUsd, vol24hEth: vol24 }, RULES)) { alive.push(c.token); continue; }
    const vol7d = candles.filter((x) => x.hour >= now - 7 * DAY).reduce((a, x) => a + x.vol_eth, 0);
    const diedAt = life.diedAt ?? c.last_swap_at;

    // Chain checks are the slow part, so reuse them for a while.
    const prev = prevGrave.get(c.token) as { checked_at: number; pool_eth: number | null; dev_pct: number | null; sell_ok: number | null; holders: number | null; cause: string } | undefined;
    let checkedAt = prev?.checked_at ?? now;
    let poolEth = prev?.pool_eth ?? null, devPct = prev?.dev_pct ?? null, sellOk: number | null = prev?.sell_ok ?? null, holders = prev?.holders ?? null, cause = prev?.cause ?? "fade";
    if (!prev || now - prev.checked_at > RECHECK_MS) {
      checkedAt = now;
      const [wethInPool, devBal] = await Promise.all([
        publicClient.readContract({ address: ADDR.weth, abi: ABI.weth, functionName: "balanceOf", args: [c.pool as Address] }).catch(() => null),
        publicClient.readContract({ address: c.token as Address, abi: ABI.erc20, functionName: "balanceOf", args: [c.deployer as Address] }).catch(() => null),
      ]);
      poolEth = wethInPool === null ? null : Number(wethInPool) / 1e18;
      devPct = devBal === null ? null : Number((devBal * 1_000_000n) / BigInt(c.supply)) / 10_000;
      cause = causeOfDeath(BigInt(c.initial_buy), devBal);
      // Sell test: can 0.1% of supply be quoted back into ETH through the coin's own pool?
      sellOk = await quoteIn(c.token as Address, ADDR.weth, BigInt(c.supply) / 1000n, PONS_FEE).then((q) => (q.out > 0n ? 1 : 0)).catch(() => 0);
      holders = await holderCount(c.token);
    }
    const lp = lastPump.get(c.token) as { id: number | null };
    const v = revivable({ poolEth, devPct, sellOk: sellOk === null ? null : sellOk === 1, diedAt, lastPumpAt: lp.id ? (lp.id + 1) * HOUR : null }, now, RULES);
    const s = revivalScore({ poolEth: poolEth ?? 0, holders, devPct: devPct ?? CONFIG.maxDevPct, deadDays: diedAt ? (now - diedAt) / DAY : 0, vol7dEth: vol7d }, RULES);
    out.push({ token: c.token, status: v.status, why: v.why, cause, score: s.total, parts: JSON.stringify(s.parts), peakUsd, nowUsd, peakAt: life.peakAt, diedAt, poolEth, devPct, holders, sellOk, checkedAt });
  }

  tx(db, () => {
    const up = db.prepare(`INSERT INTO graves (token, status, why, cause, score, parts, peak_usd, now_usd, peak_at, died_at, pool_eth, dev_pct, holders, sell_ok, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET status=excluded.status, why=excluded.why, cause=excluded.cause, score=excluded.score, parts=excluded.parts,
        peak_usd=excluded.peak_usd, now_usd=excluded.now_usd, peak_at=excluded.peak_at, died_at=excluded.died_at, pool_eth=excluded.pool_eth,
        dev_pct=excluded.dev_pct, holders=excluded.holders, sell_ok=excluded.sell_ok, checked_at=excluded.checked_at`);
    for (const g of out) up.run(g.token, g.status, g.why, g.cause, g.score, g.parts, g.peakUsd, g.nowUsd, g.peakAt, g.diedAt, g.poolEth, g.devPct, g.holders, g.sellOk, g.checkedAt);
    // A coin that came back to life leaves the graveyard.
    const del = db.prepare("DELETE FROM graves WHERE token = ?");
    for (const t of alive) del.run(t);
    kvSet(db, "graves_evaluated_at", String(now));
    kvSet(db, "eth_usd", String(usd));
  });
  return out.length;
}

export function startGraves(db: DB, everyMs = 5 * 60_000) {
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try { const n = await evaluateOnce(db); console.log(`[graves] ${n} grave(s) checked`); }
    catch (e) { console.error("[graves]", (e as Error).message.split("\n")[0]); }
    finally { running = false; }
  };
  setTimeout(loop, 20_000); // let the scanner get a head start
  return setInterval(loop, everyMs);
}

