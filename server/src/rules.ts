// Pure rule math. No network, no database, so every rule here is unit-tested.

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
const Q96 = 2 ** 96;

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

// ---------------- graveyard (pump.fun coins that bonded, then died) ----------------
export type GraveRules = {
  minAthUsd: number; maxAthUsd: number; minDropPct: number; quietVol24hUsd: number; minDeadDays: number;
  minPoolSol: number; maxDevPct: number; cooldownHours: number;
};

/** Dead = lived (real ATH), fell hard from it, and went quiet. Bad ATH data points are ignored. */
export function isDead(o: { athUsd: number | null; nowUsd: number | null; vol24Usd: number | null }, r: GraveRules) {
  if (!o.athUsd || o.nowUsd === null || o.athUsd < r.minAthUsd || o.athUsd > r.maxAthUsd) return false;
  return o.nowUsd <= o.athUsd * (1 - r.minDropPct / 100) && (o.vol24Usd ?? 0) < r.quietVol24hUsd;
}

export type Check = { poolSol: number | null; devPct: number | null; athAt: number | null; lastPumpAt: number | null };
export type Verdict = { status: "ok" | "wait" | "fresh" | "no"; why: string };

/** The checks, in the order people care about. The first one that fails is the reason shown. */
export function revivable(c: Check, now: number, r: GraveRules): Verdict {
  if (c.poolSol === null || c.poolSol < r.minPoolSol) return { status: "no", why: `Under ${r.minPoolSol} SOL left in the pool` };
  if (c.devPct === null) return { status: "no", why: "Dev wallet couldn't be checked" };
  if (c.devPct >= r.maxDevPct) return { status: "no", why: `Dev still holds ${c.devPct.toFixed(1)}%` };
  const days = c.athAt ? (now - c.athAt) / DAY : 0;
  if (days < r.minDeadDays) return { status: "fresh", why: `Peaked ${Math.max(0, Math.floor(days))} days ago, needs ${r.minDeadDays}` };
  if (c.lastPumpAt && now - c.lastPumpAt < r.cooldownHours * HOUR) {
    const h = Math.max(1, Math.round((now - c.lastPumpAt) / HOUR));
    return { status: "wait", why: `Pumped ${h} hour${h === 1 ? "" : "s"} ago` };
  }
  return { status: "ok", why: "On the ballot" };
}

/** Cause of death: the creator sold (holds under 1%) or it just faded. */
export function causeOfDeath(devPct: number | null): "dev" | "fade" {
  return devPct !== null && devPct < 1 ? "dev" : "fade";
}

/** Revival score out of 100: liquidity 35, how big it got 25, dev wallet 20, time buried 10, recent activity 10. */
export function revivalScore(o: { poolSol: number; athUsd: number; devPct: number; deadDays: number; vol24Usd: number }, r: Pick<GraveRules, "maxDevPct">) {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const parts = {
    Liquidity: [Math.round(clamp(o.poolSol / 50) * 35), 35],
    "All-time high": [Math.round(clamp(Math.log10(Math.max(1, o.athUsd / 60_000)) / 2) * 25), 25],
    "Dev wallet": [Math.round(clamp(1 - o.devPct / r.maxDevPct) * 20), 20],
    "Time buried": [Math.round(clamp(o.deadDays / 30) * 10), 10],
    "Recent activity": [Math.round(clamp(o.vol24Usd / 1_000) * 10), 10],
  } as Record<string, [number, number]>;
  return { total: Object.values(parts).reduce((a, [v]) => a + v, 0), parts };
}
