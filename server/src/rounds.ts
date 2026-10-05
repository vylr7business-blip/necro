// Hourly rounds: open a ballot at :00, take votes until :50, lock the winner.
// No network calls in here, so the whole flow is unit-tested.
import { CONFIG } from "./config.js";
import { type DB, tx } from "./db.js";
import { roundId, roundTimes, tally } from "./rules.js";

export class VoteError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export type Round = {
  id: number; ballot: string; practice: number; locked: number; winner: string | null; winner_reason: string | null;
  pump_status: string | null; pump_note: string | null; pre_price: number | null; eth_spent: string | null; tokens_out: string | null; created_at: number;
};

export function getRound(db: DB, id: number) {
  return db.prepare("SELECT * FROM rounds WHERE id = ?").get(id) as Round | undefined;
}

export function ballotCandidates(db: DB, n = CONFIG.ballotSize) {
  // Only coins the pump bot can buy today (pons v1, Uniswap v3). pons v2 (Uniswap v4) joins once v4 buying is built.
  return db.prepare("SELECT g.token, g.score FROM graves g JOIN coins c ON c.token = g.token WHERE g.status = 'ok' AND COALESCE(c.venue, 'v3') = 'v3' ORDER BY g.score DESC, g.peak_usd DESC LIMIT ?").all(n) as Array<{ token: string; score: number }>;
}

/** Make sure this hour's round exists. Snapshots $NECRO balances the moment it opens. */
export function ensureRound(db: DB, now = Date.now()): Round {
  const id = roundId(now);
  const have = getRound(db, id);
  if (have && JSON.parse(have.ballot).length) return have;
  return tx(db, () => {
    const ballot = ballotCandidates(db).map((b) => b.token);
    const practice = CONFIG.necroToken ? 0 : 1;
    if (have) {
      // The scanner was still warming up when this round opened. Fill the ballot now, before anyone could vote.
      if (ballot.length) db.prepare("UPDATE rounds SET ballot = ? WHERE id = ?").run(JSON.stringify(ballot), id);
    } else {
      db.prepare("INSERT INTO rounds (id, ballot, practice, created_at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(ballot), practice, now);
      if (!practice) db.prepare("INSERT INTO round_balances (round_id, address, balance) SELECT ?, address, balance FROM necro_balances WHERE balance != '0'").run(id);
    }
    return getRound(db, id)!;
  });
}

/** Vote weight: $NECRO held at the :00 snapshot. Practice mode (before launch): one wallet, one vote. */
export function weightOf(db: DB, round: Round, address: string): bigint {
  if (round.practice) return 1n;
  const r = db.prepare("SELECT balance FROM round_balances WHERE round_id = ? AND address = ?").get(round.id, address.toLowerCase()) as { balance: string } | undefined;
  return r ? BigInt(r.balance) : 0n;
}

export function castVote(db: DB, address: string, token: string, now = Date.now()) {
  const round = ensureRound(db, now);
  const t = roundTimes(round.id, CONFIG.voteLockMinute);
  if (now >= t.locksAt || round.locked) throw new VoteError("locked", "Voting for this hour is closed. A new ballot opens at the top of the hour.");
  const ballot = JSON.parse(round.ballot) as string[];
  const coin = token.toLowerCase();
  if (!ballot.includes(coin)) throw new VoteError("not_on_ballot", "That coin isn't on this hour's ballot.");
  const weight = weightOf(db, round, address);
  if (weight <= 0n) throw new VoteError("no_weight", "You need to hold $NECRO when the round opens at :00 to vote. Buy now and you can vote next hour.");
  db.prepare(`INSERT INTO votes (round_id, address, token, weight, at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(round_id, address) DO UPDATE SET token = excluded.token, weight = excluded.weight, at = excluded.at`)
    .run(round.id, address.toLowerCase(), coin, weight.toString(), now);
  return { round: round.id, token: coin, weight };
}

export function voteTotals(db: DB, roundIdN: number) {
  const rows = db.prepare("SELECT token, weight FROM votes WHERE round_id = ?").all(roundIdN) as Array<{ token: string; weight: string }>;
  const byToken: Record<string, { weight: bigint; voters: number }> = {};
  let total = 0n;
  for (const r of rows) {
    const w = BigInt(r.weight);
    byToken[r.token] ??= { weight: 0n, voters: 0 };
    byToken[r.token].weight += w; byToken[r.token].voters += 1; total += w;
  }
  return { byToken, total, voters: rows.length };
}

/** Lock every round whose voting time is over. Returns the rounds it locked. */
export function lockDue(db: DB, now = Date.now()) {
  const open = db.prepare("SELECT * FROM rounds WHERE locked = 0 ORDER BY id").all() as Round[];
  const locked: Round[] = [];
  for (const r of open) {
    if (now < roundTimes(r.id, CONFIG.voteLockMinute).locksAt) continue;
    const ballot = (JSON.parse(r.ballot) as string[]).map((token) => {
      const g = db.prepare("SELECT score FROM graves WHERE token = ?").get(token) as { score: number } | undefined;
      return { token, score: g?.score ?? 0 };
    });
    const votes = (db.prepare("SELECT token, weight FROM votes WHERE round_id = ?").all(r.id) as Array<{ token: string; weight: string }>)
      .map((v) => ({ token: v.token, weight: BigInt(v.weight) }));
    const res = tally(ballot, votes);
    db.prepare("UPDATE rounds SET locked = 1, winner = ?, winner_reason = ? WHERE id = ? AND locked = 0").run(res.winner, res.reason, r.id);
    locked.push({ ...r, locked: 1, winner: res.winner, winner_reason: res.reason });
  }
  return locked;
}

export function myVote(db: DB, roundIdN: number, address: string) {
  return (db.prepare("SELECT token, weight FROM votes WHERE round_id = ? AND address = ?").get(roundIdN, address.toLowerCase()) as { token: string; weight: string } | undefined) ?? null;
}

/** Keep rounds moving: open the current hour and lock anything past :50. */
export function startRounds(db: DB, everyMs = 10_000) {
  const loop = () => {
    try {
      ensureRound(db);
      for (const r of lockDue(db)) console.log(`[rounds] round ${r.id} locked, winner ${r.winner ?? "none"} (${r.winner_reason})`);
    } catch (e) { console.error("[rounds]", (e as Error).message); }
  };
  loop();
  return setInterval(loop, everyMs);
}
