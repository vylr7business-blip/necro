// Read-only views the website asks for. Database only, so they're fast and tested.
import { CONFIG } from "./config.js";
import { type DB, kvGet } from "./db.js";
import { DAY, HOUR, roundId, roundTimes } from "./rules.js";
import { ensureRound, getRound, myVote, voteTotals } from "./rounds.js";

type GraveJoin = {
  mint: string; symbol: string | null; name: string | null; image: string | null; creator: string; pool: string | null; created_at: number;
  status: string; why: string; cause: string; score: number; parts: string; peak_usd: number; now_usd: number; peak_at: number | null;
  died_at: number | null; pool_sol: number | null; dev_pct: number | null; vol24_usd: number | null;
};
const GRAVE_SQL = `SELECT c.mint, c.symbol, c.name, c.image, c.creator, c.pool, c.created_at, g.status, g.why, g.cause, g.score, g.parts,
  g.peak_usd, g.now_usd, g.peak_at, g.died_at, g.pool_sol, g.dev_pct, g.vol24_usd FROM graves g JOIN coins c ON c.mint = g.mint`;

export function coinSummary(r: GraveJoin) {
  return {
    token: r.mint, symbol: r.symbol ?? r.mint.slice(0, 6), name: r.name, image: r.image, status: r.status, why: r.why, cause: r.cause,
    score: r.score, parts: JSON.parse(r.parts), peakUsd: r.peak_usd, nowUsd: r.now_usd,
    fall: r.peak_usd > 0 ? Math.round((1 - r.now_usd / r.peak_usd) * 100) : 0,
    holders: null as number | null, poolSol: r.pool_sol, devPct: r.dev_pct, diedAt: r.died_at, peakAt: r.peak_at, launchedAt: r.created_at,
    deployer: r.creator, pool: r.pool,
  };
}
const grave = (db: DB, mint: string) => db.prepare(`${GRAVE_SQL} WHERE g.mint = ?`).get(mint) as GraveJoin | undefined;

export function roundView(db: DB, now = Date.now(), address?: string, fundSol: number | null = null) {
  const round = ensureRound(db, now);
  const t = roundTimes(round.id, CONFIG.voteLockMinute);
  const totals = voteTotals(db, round.id);
  const ballot = (JSON.parse(round.ballot) as string[]).map((mint) => {
    const g = grave(db, mint);
    const v = totals.byMint[mint] ?? { weight: 0n, voters: 0 };
    const pct = totals.total > 0n ? Number((v.weight * 10_000n) / totals.total) / 100 : 0;
    return g ? { ...coinSummary(g), weight: v.weight.toString(), voters: v.voters, pct } : null;
  }).filter(Boolean) as Array<ReturnType<typeof coinSummary> & { weight: string; voters: number; pct: number }>;
  const leader = [...ballot].sort((a, b) => (BigInt(b.weight) === BigInt(a.weight) ? b.score - a.score : BigInt(b.weight) > BigInt(a.weight) ? 1 : -1))[0] ?? null;
  const mine = address ? myVote(db, round.id, address) : null;
  return {
    live: true, practice: round.practice === 1, id: round.id, now,
    opensAt: t.opensAt, locksAt: t.locksAt, pumpsAt: t.pumpsAt, phase: now >= t.locksAt || round.locked ? "locked" : "open",
    fundSol, totalWeight: totals.total.toString(), voters: totals.voters,
    ballot, leader: leader?.token ?? null, spark: [] as number[],
    myVote: mine ? { token: mine.mint, weight: mine.weight } : null,
    warming: !ballot.length,
  };
}

export function coinView(db: DB, mint: string, now = Date.now()) {
  const g = grave(db, mint);
  if (!g) return null;
  const rid = roundId(now);
  const round = getRound(db, rid);
  const onBallot = round ? (JSON.parse(round.ballot) as string[]).includes(g.mint) : false;
  const totals = voteTotals(db, rid);
  const v = totals.byMint[g.mint];
  const ranked = Object.entries(totals.byMint).sort((a, b) => (a[1].weight === b[1].weight ? 0 : a[1].weight > b[1].weight ? -1 : 1)).map(([k]) => k);
  const pumps = db.prepare("SELECT id, sol_spent FROM rounds WHERE winner = ? AND pump_status IN ('done','partial') ORDER BY id DESC").all(g.mint) as Array<{ id: number; sol_spent: string }>;
  return {
    ...coinSummary(g),
    onBallot, votes: v ? { weight: v.weight.toString(), voters: v.voters, pct: totals.total > 0n ? Number((v.weight * 10_000n) / totals.total) / 100 : 0 } : null,
    rank: onBallot && v ? ranked.indexOf(g.mint) + 1 : null,
    history: [] as Array<{ t: number; usd: number }>,
    pumps: pumps.map((p) => ({ at: (p.id + 1) * HOUR, sol: Number(BigInt(p.sol_spent ?? "0")) / 1e9 })),
    explorer: `${CONFIG.explorer}/token/${g.mint}`,
    pumpfun: `https://pump.fun/coin/${g.mint}`,
  };
}

const CAUSES: Array<[string, (g: { status: string; why: string }) => boolean]> = [
  ["Pool nearly empty", (g) => g.status === "no" && g.why.startsWith("Under")],
  ["Dev still holds", (g) => g.status === "no" && g.why.startsWith("Dev")],
  ["Too fresh", (g) => g.status === "fresh"],
  ["Cooling down", (g) => g.status === "wait"],
  ["Revivable", (g) => g.status === "ok"],
];

export function graveyardView(db: DB, opts: { status?: string; q?: string; limit?: number }, now = Date.now()) {
  const all = db.prepare("SELECT status, why, died_at FROM graves").all() as Array<{ status: string; why: string; died_at: number | null }>;
  const stats = {
    buried: all.length, revivable: all.filter((g) => g.status === "ok").length, cooling: all.filter((g) => g.status === "wait").length,
    today: all.filter((g) => (g.died_at ?? 0) >= now - DAY).length,
  };
  const causes = CAUSES.map(([label, f]) => [label, all.filter(f).length] as [string, number]).filter(([, n]) => n > 0);
  const where: string[] = [], args: Array<string | number> = [];
  const st = opts.status === "no" ? ["no", "fresh"] : opts.status === "ok" || opts.status === "wait" ? [opts.status] : null;
  if (st) { where.push(`g.status IN (${st.map(() => "?").join(",")})`); args.push(...st); }
  const q = (opts.q ?? "").trim().replace(/^\$/, "");
  if (q) {
    if (q.length >= 32) { where.push("g.mint = ?"); args.push(q); }
    else { where.push("(UPPER(c.symbol) LIKE ? OR UPPER(c.name) LIKE ?)"); args.push(`%${q.toUpperCase()}%`, `%${q.toUpperCase()}%`); }
  }
  const sql = `${GRAVE_SQL} ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY CASE g.status WHEN 'ok' THEN 0 WHEN 'wait' THEN 1 WHEN 'fresh' THEN 2 ELSE 3 END, g.peak_usd DESC LIMIT ?`;
  const rows = (db.prepare(sql).all(...args, Math.min(opts.limit ?? 100, 200)) as GraveJoin[]).map(coinSummary);
  return { stats, causes, rows, evaluatedAt: Number(kvGet(db, "graves_evaluated_at") ?? 0) || null };
}

export function logView(db: DB, now = Date.now()) {
  const rounds = db.prepare(`SELECT r.id, r.winner, r.pre_usd, r.sol_spent, r.pump_status, r.burn_sig, c.symbol, m.mcap_usd
    FROM rounds r JOIN coins c ON c.mint = r.winner LEFT JOIN market m ON m.mint = r.winner
    WHERE r.pump_status IN ('done','partial') ORDER BY r.id DESC LIMIT 200`).all() as Array<{
      id: number; winner: string; pre_usd: number | null; sol_spent: string; pump_status: string; burn_sig: string | null; symbol: string | null; mcap_usd: number | null }>;
  const sigOf = db.prepare("SELECT sig FROM pump_legs WHERE round_id = ? AND status = 'done' ORDER BY idx LIMIT 1");
  const rows = rounds.map((r) => {
    const at = (r.id + 1) * HOUR;
    const post = now >= at + HOUR ? r.mcap_usd : null;
    return {
      at, token: r.winner, symbol: r.symbol ?? r.winner.slice(0, 6), sol: Number(BigInt(r.sol_spent ?? "0")) / 1e9, status: r.pump_status,
      preUsd: r.pre_usd, postUsd: post, move: r.pre_usd && post ? Math.round((post / r.pre_usd - 1) * 100) : null,
      tx: (sigOf.get(r.id) as { sig: string } | undefined)?.sig ?? null, burnTx: r.burn_sig && r.burn_sig !== "none" ? r.burn_sig : null,
    };
  });
  const moves = rows.map((r) => r.move).filter((m): m is number => m !== null);
  const agg = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT winner) AS coins FROM rounds WHERE pump_status IN ('done','partial')").get() as { n: number; coins: number };
  const spent = (db.prepare("SELECT sol_spent FROM rounds WHERE pump_status IN ('done','partial')").all() as Array<{ sol_spent: string }>).reduce((a, r) => a + BigInt(r.sol_spent ?? "0"), 0n);
  const bars: Array<{ at: number; sol: number; symbol: string | null }> = [];
  for (let i = 23; i >= 0; i--) {
    const at = (roundId(now) - i) * HOUR;
    const hit = rows.find((r) => r.at === at);
    bars.push({ at, sol: hit?.sol ?? 0, symbol: hit?.symbol ?? null });
  }
  return {
    stats: { pumps: agg.n, solSpent: Number(spent) / 1e9, avgMove: moves.length ? Math.round(moves.reduce((a, b) => a + b, 0) / moves.length) : null, coins: agg.coins },
    rows: rows.slice(0, 100), bars, explorer: CONFIG.explorer,
  };
}
