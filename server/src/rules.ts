// Pure rule math. No network, no database, so every rule here is unit-tested.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const Q96 = 2 ** 96;

/** ETH per whole token, from a Uniswap v3 sqrtPriceX96. Both sides have 18 decimals on pons. */
export function priceFromSqrt(sqrtPriceX96: bigint, coinIsToken0: boolean): number {
  const r = Number(sqrtPriceX96) / Q96;
  const token1PerToken0 = r * r;
  if (coinIsToken0) return token1PerToken0; // token1 is WETH
  return token1PerToken0 === 0 ? 0 : 1 / token1PerToken0;
}

/** WETH moved by one swap, in ETH (always positive). */
export function swapEth(amount0: bigint, amount1: bigint, coinIsToken0: boolean): number {
  const w = coinIsToken0 ? amount1 : amount0;
  return Number(w < 0n ? -w : w) / 1e18;
}

export const hourStart = (ms: number) => Math.floor(ms / HOUR) * HOUR;

// ---------------- rounds ----------------
export type Phase = "open" | "locked";
export function roundId(ms: number) { return Math.floor(ms / HOUR); }
export function roundTimes(id: number, lockMinute = 50) {
  const opensAt = id * HOUR;
  return { opensAt, locksAt: opensAt + lockMinute * 60_000, pumpsAt: opensAt + HOUR };
}
export function phaseAt(ms: number, lockMinute = 50): Phase {
  return ms >= roundTimes(roundId(ms), lockMinute).locksAt ? "locked" : "open";
}

/** Weighted tally. Ties go to the higher revival score, then to ballot order. No votes: the top score wins. */
export function tally(
  ballot: Array<{ token: string; score: number }>,
  votes: Array<{ token: string; weight: bigint }>,
): { winner: string | null; reason: "votes" | "no_votes" | "empty"; weights: Record<string, bigint> } {
  const weights: Record<string, bigint> = {};
  for (const b of ballot) weights[b.token] = 0n;
  for (const v of votes) if (v.token in weights) weights[v.token] += v.weight;
  if (!ballot.length) return { winner: null, reason: "empty", weights };
  const anyVotes = Object.values(weights).some((w) => w > 0n);
  const ranked = ballot
    .map((b, i) => ({ ...b, i, w: weights[b.token] }))
    .sort((a, b) => (a.w === b.w ? (b.score - a.score || a.i - b.i) : a.w > b.w ? -1 : 1));
  return { winner: ranked[0].token, reason: anyVotes ? "votes" : "no_votes", weights };
}

/** Split a pump into n buys. Leftover wei goes on the last buy so nothing is lost. */
export function splitChunks(total: bigint, n: number): bigint[] {
  if (n < 1 || total <= 0n) return [];
  const each = total / BigInt(n);
  if (each === 0n) return [total];
  const out = Array.from({ length: n }, () => each);
  out[n - 1] += total - each * BigInt(n);
  return out;
}

/** How much one hour's pump may spend. */
export function pumpBudget(o: { balanceWei: bigint; reserveWei: bigint; maxWei: bigint; spentTodayWei: bigint; dailyCapWei: bigint }): bigint {
  let b = o.balanceWei - o.reserveWei;
  if (b > o.maxWei) b = o.maxWei;
  const left = o.dailyCapWei - o.spentTodayWei;
  if (b > left) b = left;
  return b > 0n ? b : 0n;
}

// ---------------- graveyard ----------------
export type GraveRules = {
  minPeakUsd: number; minDropPct: number; quietVol24hEth: number; minDeadDays: number;
  minPoolEth: number; maxDevPct: number; cooldownHours: number;
};

export type Candle = { hour: number; close: number; vol_eth: number };

/** Peak, current price and when it died, from hourly candles (oldest first). Peak uses hourly closes so one spiky trade can't fake it. */
export function lifeOf(candles: Candle[], lastPrice: number, dropPct: number) {
  let peak = 0, peakAt = 0;
  for (const c of candles) if (c.close > peak) { peak = c.close; peakAt = c.hour; }
  const floor = peak * (1 - dropPct / 100);
  let diedAt: number | null = null;
  for (const c of candles) if (c.hour > peakAt && c.close <= floor) { diedAt = c.hour; break; }
  return { peak, peakAt, now: lastPrice, diedAt };
}

export function isBuried(o: { peakUsd: number; nowUsd: number; vol24hEth: number }, r: GraveRules) {
  return o.peakUsd >= r.minPeakUsd && o.nowUsd <= o.peakUsd * (1 - r.minDropPct / 100) && o.vol24hEth < r.quietVol24hEth;
}

export type Check = { poolEth: number | null; devPct: number | null; sellOk: boolean | null; diedAt: number | null; lastPumpAt: number | null };
export type Verdict = { status: "ok" | "wait" | "fresh" | "no"; why: string };

/** The four checks, in the order people care about. The first one that fails is the reason shown. */
export function revivable(c: Check, now: number, r: GraveRules): Verdict {
  if (c.poolEth === null || c.poolEth < r.minPoolEth) return { status: "no", why: `Under ${r.minPoolEth} ETH left in the pool` };
  if (c.devPct === null || c.devPct >= r.maxDevPct) return { status: "no", why: c.devPct === null ? "Dev wallet couldn't be checked" : `Dev still holds ${c.devPct.toFixed(1)}%` };
  if (c.sellOk === false) return { status: "no", why: "Failed the sell test" };
  if (c.sellOk === null) return { status: "no", why: "Sell test couldn't run" };
  const deadDays = c.diedAt ? (now - c.diedAt) / DAY : 0;
  if (deadDays < r.minDeadDays) return { status: "fresh", why: `Died ${Math.max(0, Math.floor(deadDays))} days ago, needs ${r.minDeadDays}` };
  if (c.lastPumpAt && now - c.lastPumpAt < r.cooldownHours * HOUR) {
    const h = Math.max(1, Math.round((now - c.lastPumpAt) / HOUR));
    return { status: "wait", why: `Pumped ${h} hour${h === 1 ? "" : "s"} ago` };
  }
  return { status: "ok", why: "On the ballot" };
}

export function causeOfDeath(initialBuy: bigint, devBalance: bigint | null): "dev" | "fade" {
  if (devBalance === null || initialBuy === 0n) return "fade";
  return devBalance * 10n < initialBuy ? "dev" : "fade"; // dev dumped 90%+ of their launch bag
}

/** Revival score out of 100: liquidity 30, holders 25, dev wallet 20, time buried 15, recent activity 10. */
export function revivalScore(o: { poolEth: number; holders: number | null; devPct: number; deadDays: number; vol7dEth: number }, r: Pick<GraveRules, "maxDevPct">) {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const parts = {
    Liquidity: [Math.round(clamp(o.poolEth / 2) * 30), 30],
    Holders: [o.holders === null ? 12 : Math.round(clamp(Math.log10(Math.max(1, o.holders)) / Math.log10(2000)) * 25), 25],
    "Dev wallet": [Math.round(clamp(1 - o.devPct / r.maxDevPct) * 20), 20],
    "Time buried": [Math.round(clamp(o.deadDays / 30) * 15), 15],
    "Recent activity": [Math.round(clamp(o.vol7dEth / 0.5) * 10), 10],
  } as Record<string, [number, number]>;
  const total = Object.values(parts).reduce((a, [v]) => a + v, 0);
  return { total, parts };
}
