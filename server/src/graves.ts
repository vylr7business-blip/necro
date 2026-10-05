// Decides which bonded pump.fun coins are dead, why, and which can be revived. Runs every few minutes.
import { CONFIG } from "./config.js";
import { type DB, kvSet, tx } from "./db.js";
import { solUsd, tokenBalance, tokenSupply } from "./solana.js";
import { DAY, HOUR, causeOfDeath, isDead, revivable, revivalScore } from "./rules.js";

export const RULES = {
  minAthUsd: CONFIG.minAthUsd, maxAthUsd: CONFIG.maxAthUsd, minDropPct: CONFIG.minDropPct, quietVol24hUsd: CONFIG.quietVol24hUsd,
  minDeadDays: CONFIG.minDeadDays, minPoolSol: CONFIG.minPoolSol, maxDevPct: CONFIG.maxDevPct, cooldownHours: CONFIG.cooldownHours,
};
const RECHECK_MS = 60 * 60_000; // dev wallet checked at most hourly per coin

type Row = { mint: string; creator: string; ath_usd: number | null; ath_at: number | null; created_at: number; m_mcap: number | null; liq_usd: number | null; vol24_usd: number | null;
  g_checked: number | null; g_dev: number | null };

export async function evaluateOnce(db: DB, now = Date.now()) {
  const sol = await solUsd();
  const rows = db.prepare(`SELECT c.mint, c.creator, c.ath_usd, c.ath_at, c.created_at, m.mcap_usd AS m_mcap, m.liq_usd, m.vol24_usd, g.checked_at AS g_checked, g.dev_pct AS g_dev
      FROM coins c JOIN market m ON m.mint = c.mint LEFT JOIN graves g ON g.mint = c.mint`).all() as Row[];
  const lastPump = db.prepare("SELECT MAX(id) AS id FROM rounds WHERE winner = ? AND pump_status IN ('done','partial')");
  const dead = rows.filter((r) => isDead({ athUsd: r.ath_usd, nowUsd: r.m_mcap, vol24Usd: r.vol24_usd }, RULES));
  const alive = rows.filter((r) => !dead.includes(r)).map((r) => r.mint);

  type Out = { mint: string; status: string; why: string; cause: string; score: number; parts: string; peak: number; now: number; peakAt: number | null; poolSol: number | null; devPct: number | null; vol24: number; checkedAt: number };
  async function judge(r: Row): Promise<Out> {
    // PumpSwap pools are SOL/token: about half the liquidity is SOL.
    const poolSol = r.liq_usd ? r.liq_usd / 2 / sol : 0;
    let devPct = r.g_dev, checkedAt = r.g_checked ?? now;
    const needDev = poolSol >= CONFIG.minPoolSol; // only worth an RPC call if the pool passes
    if (needDev && (devPct === null || !r.g_checked || now - r.g_checked > RECHECK_MS)) {
      checkedAt = now;
      try {
        const [bal, sup] = await Promise.all([tokenBalance(r.creator, r.mint), tokenSupply(r.mint)]);
        devPct = sup.amount > 0n ? Number((bal * 1_000_000n) / sup.amount) / 10_000 : 0;
      } catch { devPct = null; }
    }
    const lp = lastPump.get(r.mint) as { id: number | null };
    const v = revivable({ poolSol, devPct, athAt: r.ath_at, lastPumpAt: lp.id ? (lp.id + 1) * HOUR : null }, now, RULES);
    const s = revivalScore({ poolSol, athUsd: r.ath_usd ?? 0, devPct: devPct ?? CONFIG.maxDevPct, deadDays: r.ath_at ? (now - r.ath_at) / DAY : 0, vol24Usd: r.vol24_usd ?? 0 }, RULES);
    return { mint: r.mint, status: v.status, why: v.why, cause: causeOfDeath(devPct), score: s.total, parts: JSON.stringify(s.parts),
      peak: r.ath_usd ?? 0, now: r.m_mcap ?? 0, peakAt: r.ath_at, poolSol, devPct, vol24: r.vol24_usd ?? 0, checkedAt };
  }
  const out: Out[] = [];
  for (let i = 0; i < dead.length; i += 20) out.push(...(await Promise.all(dead.slice(i, i + 20).map(judge))));

  tx(db, () => {
    const up = db.prepare(`INSERT INTO graves (mint, status, why, cause, score, parts, peak_usd, now_usd, peak_at, died_at, pool_sol, dev_pct, vol24_usd, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint) DO UPDATE SET status=excluded.status, why=excluded.why, cause=excluded.cause, score=excluded.score, parts=excluded.parts,
        peak_usd=excluded.peak_usd, now_usd=excluded.now_usd, peak_at=excluded.peak_at, died_at=excluded.died_at, pool_sol=excluded.pool_sol,
        dev_pct=excluded.dev_pct, vol24_usd=excluded.vol24_usd, checked_at=excluded.checked_at`);
    for (const g of out) up.run(g.mint, g.status, g.why, g.cause, g.score, g.parts, g.peak, g.now, g.peakAt, g.peakAt, g.poolSol, g.devPct, g.vol24, g.checkedAt);
    const del = db.prepare("DELETE FROM graves WHERE mint = ?");
    for (const m of alive) del.run(m);
    kvSet(db, "graves_evaluated_at", String(now));
    kvSet(db, "sol_usd", String(sol));
  });
  return out.length;
}

export function startGraves(db: DB, everyMs = 3 * 60_000) {
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try { const n = await evaluateOnce(db); console.log(`[graves] ${n} grave(s) checked`); }
    catch (e) { console.error("[graves]", (e as Error).message); }
    finally { running = false; }
  };
  setTimeout(loop, 30_000);
  return setInterval(loop, everyMs);
}
