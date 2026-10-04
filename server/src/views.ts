// Read-only views the website asks for. Database only (no network), so they're fast and tested.
import { CONFIG } from "./config.js";
import { type DB, kvGet } from "./db.js";
import { DAY, HOUR, roundId, roundTimes } from "./rules.js";
import { ensureRound, getRound, myVote, voteTotals } from "./rounds.js";

const ethUsdOf = (db: DB) => Number(kvGet(db, "eth_usd") ?? "0") || null;
const wholeSupply = (supply: string) => Number(BigInt(supply) / 10n ** 12n) / 1e6;

type GraveJoin = {
  token: string; symbol: string | null; name: string | null; supply: string; launch_at: number; deployer: string; pool: string;
  status: string; why: string; cause: string; score: number; parts: string; peak_usd: number; now_usd: number; peak_at: number | null;
  died_at: number | null; pool_eth: number | null; dev_pct: number | null; holders: number | null;
};
const GRAVE_SQL = `SELECT c.token, c.symbol, c.name, c.supply, c.launch_at, c.deployer, c.pool, g.status, g.why, g.cause, g.score, g.parts,
  g.peak_usd, g.now_usd, g.peak_at, g.died_at, g.pool_eth, g.dev_pct, g.holders
  FROM graves g JOIN coins c ON c.token = g.token`;

export function coinSummary(row: GraveJoin) {
  return {
    token: row.token, symbol: row.symbol ?? row.token.slice(0, 8), name: row.name, status: row.status, why: row.why, cause: row.cause,
    score: row.score, parts: JSON.parse(row.parts), peakUsd: row.peak_usd, nowUsd: row.now_usd,
    fall: row.peak_usd > 0 ? Math.round((1 - row.now_usd / row.peak_usd) * 100) : 0,
    holders: row.holders, poolEth: row.pool_eth, devPct: row.dev_pct, diedAt: row.died_at, peakAt: row.peak_at, launchedAt: row.launch_at,
    deployer: row.deployer, pool: row.pool,
  };
}

function grave(db: DB, token: string) {
  return db.prepare(`${GRAVE_SQL} WHERE g.token = ?`).get(token.toLowerCase()) as GraveJoin | undefined;
}

/** Hourly closes in USD market cap, for a sparkline or chart. */
function history(db: DB, token: string, supply: string, sinceMs: number, maxPoints: number) {
  const usd = ethUsdOf(db) ?? 0;
  const rows = db.prepare("SELECT hour, close FROM hourly WHERE token = ? AND hour >= ? ORDER BY hour").all(token, sinceMs) as Array<{ hour: number; close: number }>;
  const s = wholeSupply(supply);
  const step = Math.max(1, Math.ceil(rows.length / maxPoints));
  const out = rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((r) => ({ t: r.hour, usd: r.close * s * usd }));
  return out;
}

export function roundView(db: DB, now = Date.now(), address?: string, fundEth: number | null = null) {
  const round = ensureRound(db, now);
  const t = roundTimes(round.id, CONFIG.voteLockMinute);
  const totals = voteTotals(db, round.id);
  const ballot = (JSON.parse(round.ballot) as string[]).map((token) => {
    const g = grave(db, token);
    const v = totals.byToken[token] ?? { weight: 0n, voters: 0 };
    const pct = totals.total > 0n ? Number((v.weight * 10_000n) / totals.total) / 100 : 0;
    return g ? { ...coinSummary(g), weight: v.weight.toString(), voters: v.voters, pct } : null;
  }).filter(Boolean) as Array<ReturnType<typeof coinSummary> & { weight: string; voters: number; pct: number }>;
  const leader = [...ballot].sort((a, b) => (BigInt(b.weight) === BigInt(a.weight) ? b.score - a.score : BigInt(b.weight) > BigInt(a.weight) ? 1 : -1))[0] ?? null;
  const lg = leader ? grave(db, leader.token) : undefined;
  const mine = address ? myVote(db, round.id, address) : null;
  return {
    live: true, practice: round.practice === 1, id: round.id, now,
    opensAt: t.opensAt, locksAt: t.locksAt, pumpsAt: t.pumpsAt, phase: now >= t.locksAt || round.locked ? "locked" : "open",
    fundEth, totalWeight: totals.total.toString(), voters: totals.voters,
    ballot, leader: leader?.token ?? null,
    spark: lg ? history(db, lg.token, lg.supply, now - DAY, 48).map((p) => p.usd) : [],
    myVote: mine ? { token: mine.token, weight: mine.weight } : null,
    warming: !ballot.length,
  };
}

export function coinView(db: DB, token: string, now = Date.now()) {
  const g = grave(db, token);
  if (!g) return null;
  const rid = roundId(now);
  const round = getRound(db, rid);
  const onBallot = round ? (JSON.parse(round.ballot) as string[]).includes(g.token) : false;
  const totals = voteTotals(db, rid);
  const v = totals.byToken[g.token];
  const ranked = Object.entries(totals.byToken).sort((a, b) => (a[1].weight === b[1].weight ? 0 : a[1].weight > b[1].weight ? -1 : 1)).map(([k]) => k);
  const pumps = db.prepare("SELECT id, eth_spent FROM rounds WHERE winner = ? AND pump_status IN ('done','partial') ORDER BY id DESC").all(g.token) as Array<{ id: number; eth_spent: string }>;
  return {
    ...coinSummary(g),
    onBallot, votes: v ? { weight: v.weight.toString(), voters: v.voters, pct: totals.total > 0n ? Number((v.weight * 10_000n) / totals.total) / 100 : 0 } : null,
    rank: onBallot && v ? ranked.indexOf(g.token) + 1 : null,
    history: history(db, g.token, g.supply, 0, 140),
    pumps: pumps.map((p) => ({ at: (p.id + 1) * HOUR, eth: Number(BigInt(p.eth_spent ?? "0")) / 1e18 })),
    explorer: `${CONFIG.explorer}/token/${g.token}`,
  };
}

const CAUSE_LABELS: Array<[string, (g: { status: string; why: string }) => boolean]> = [
  ["Pool nearly empty", (g) => g.status === "no" && g.why.startsWith("Under")],
  ["Dev still holds", (g) => g.status === "no" && g.why.startsWith("Dev")],
  ["Failed sell test", (g) => g.status === "no" && g.why.includes("ell test")],
  ["Too fresh", (g) => g.status === "fresh"],
  ["Cooling down", (g) => g.status === "wait"],
  ["Revivable", (g) => g.status === "ok"],
];

export function graveyardView(db: DB, opts: { status?: string; q?: string; limit?: number }, now = Date.now()) {
  const all = db.prepare("SELECT status, why, died_at FROM graves").all() as Array<{ status: string; why: string; died_at: number | null }>;
  const dayStart = new Date(now); dayStart.setUTCHours(0, 0, 0, 0);
  const stats = {
    buried: all.length,
    revivable: all.filter((g) => g.status === "ok").length,
    cooling: all.filter((g) => g.status === "wait").length,
    today: all.filter((g) => (g.died_at ?? 0) >= dayStart.getTime()).length,
  };
  const causes = CAUSE_LABELS.map(([label, f]) => [label, all.filter(f).length] as [string, number]).filter(([, n]) => n > 0);
  const where: string[] = [];
  const args: Array<string | number> = [];
  const status = opts.status === "no" ? ["no", "fresh"] : opts.status === "ok" || opts.status === "wait" ? [opts.status] : null;
  if (status) { where.push(`g.status IN (${status.map(() => "?").join(",")})`); args.push(...status); }
  const q = (opts.q ?? "").trim().replace(/^\$/, "");
  if (q) {
    if (/^0x[0-9a-fA-F]{6,40}$/.test(q)) { where.push("g.token LIKE ?"); args.push(`${q.toLowerCase()}%`); }
    else { where.push("(UPPER(c.symbol) LIKE ? OR UPPER(c.name) LIKE ?)"); args.push(`%${q.toUpperCase()}%`, `%${q.toUpperCase()}%`); }
  }
  const sql = `${GRAVE_SQL} ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY CASE g.status WHEN 'ok' THEN 0 WHEN 'wait' THEN 1 WHEN 'fresh' THEN 2 ELSE 3 END, g.peak_usd DESC LIMIT ?`;
  const rows = (db.prepare(sql).all(...args, Math.min(opts.limit ?? 100, 200)) as GraveJoin[]).map(coinSummary);
  return { stats, causes, rows, evaluatedAt: Number(kvGet(db, "graves_evaluated_at") ?? 0) || null };
}

export function logView(db: DB, now = Date.now()) {
  const usd = ethUsdOf(db) ?? 0;
  const rounds = db.prepare(`SELECT r.id, r.winner, r.pre_price, r.eth_spent, r.pump_status, c.symbol, c.supply
    FROM rounds r JOIN coins c ON c.token = r.winner WHERE r.pump_status IN ('done','partial') ORDER BY r.id DESC LIMIT 200`).all() as Array<{
      id: number; winner: string; pre_price: number | null; eth_spent: string; pump_status: string; symbol: string | null; supply: string }>;
  const closeAt = db.prepare("SELECT close FROM hourly WHERE token = ? AND hour <= ? ORDER BY hour DESC LIMIT 1");
  const txOf = db.prepare("SELECT tx_hash FROM pump_legs WHERE round_id = ? AND status = 'done' ORDER BY idx LIMIT 1");
  const rows = rounds.map((r) => {
    const at = (r.id + 1) * HOUR;
    const s = wholeSupply(r.supply);
    const post = (closeAt.get(r.winner, at + HOUR) as { close: number } | undefined)?.close ?? null; // price about an hour after the buy
    const pre = r.pre_price;
    return {
      at, token: r.winner, symbol: r.symbol ?? r.winner.slice(0, 8), eth: Number(BigInt(r.eth_spent ?? "0")) / 1e18, status: r.pump_status,
      preUsd: pre !== null ? pre * s * usd : null, postUsd: post !== null && now >= at + HOUR ? post * s * usd : null,
      move: pre && post && now >= at + HOUR ? Math.round((post / pre - 1) * 100) : null,
      tx: (txOf.get(r.id) as { tx_hash: string } | undefined)?.tx_hash ?? null,
    };
  });
  const moves = rows.map((r) => r.move).filter((m): m is number => m !== null);
  const all = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT winner) AS coins FROM rounds WHERE pump_status IN ('done','partial')").get() as { n: number; coins: number };
  const spent = (db.prepare("SELECT eth_spent FROM rounds WHERE pump_status IN ('done','partial')").all() as Array<{ eth_spent: string }>)
    .reduce((a, r) => a + BigInt(r.eth_spent ?? "0"), 0n);
  const bars: Array<{ at: number; eth: number; symbol: string | null }> = [];
  for (let i = 23; i >= 0; i--) {
    const at = (roundId(now) - i) * HOUR;
    const hit = rows.find((r) => r.at === at);
    bars.push({ at, eth: hit?.eth ?? 0, symbol: hit?.symbol ?? null });
  }
  return {
    stats: { pumps: all.n, ethSpent: Number(spent) / 1e18, avgMove: moves.length ? Math.round(moves.reduce((a, b) => a + b, 0) / moves.length) : null, coins: all.coins },
    rows: rows.slice(0, 100), bars, explorer: CONFIG.explorer,
  };
}
