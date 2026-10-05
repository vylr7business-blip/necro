// Hourly rounds: open a ballot at :00, take votes until :50, lock the winner.
// Vote weight = $AFTER held when you vote, re-checked at :50; you get the smaller of the two,
// so buying, voting and selling before the lock counts for nothing.
import { CONFIG } from "./config.js";
import { type DB, tx } from "./db.js";
import { roundId, roundTimes, tally } from "./rules.js";

export class VoteError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export type Round = {
  id: number; ballot: string; practice: number; locked: number; winner: string | null; winner_reason: string | null;
  pump_status: string | null; pump_note: string | null; pre_usd: number | null; sol_spent: string | null; tokens_out: string | null; burn_sig: string | null; created_at: number;
};
export type WeightFn = (address: string) => Promise<bigint>;

export function getRound(db: DB, id: number) {
  return db.prepare("SELECT * FROM rounds WHERE id = ?").get(id) as Round | undefined;
}

export function ballotCandidates(db: DB, n = CONFIG.ballotSize) {
  return db.prepare("SELECT mint, score FROM graves WHERE status = 'ok' ORDER BY score DESC, peak_usd DESC LIMIT ?").all(n) as Array<{ mint: string; score: number }>;
}

/** Make sure this hour's round exists. */
export function ensureRound(db: DB, now = Date.now(), practice = CONFIG.afterMint ? 0 : 1): Round {
  const id = roundId(now);
  const have = getRound(db, id);
  if (have && JSON.parse(have.ballot).length) return have;
  return tx(db, () => {
    const ballot = ballotCandidates(db).map((b) => b.mint);
    if (have) { if (ballot.length) db.prepare("UPDATE rounds SET ballot = ? WHERE id = ?").run(JSON.stringify(ballot), id); }
    else db.prepare("INSERT INTO rounds (id, ballot, practice, created_at) VALUES (?, ?, ?, ?)").run(id, JSON.stringify(ballot), practice, now);
    return getRound(db, id)!;
  });
}

export async function castVote(db: DB, address: string, mint: string, weightOf: WeightFn, now = Date.now()) {
  const round = ensureRound(db, now);
  const t = roundTimes(round.id, CONFIG.voteLockMinute);
  if (now >= t.locksAt || round.locked) throw new VoteError("locked", "Voting for this hour is closed. A new ballot opens at the top of the hour.");
  if (!(JSON.parse(round.ballot) as string[]).includes(mint)) throw new VoteError("not_on_ballot", "That coin isn't on this hour's ballot.");
  const weight = round.practice ? 1n : await weightOf(address);
  if (weight <= 0n) throw new VoteError("no_weight", "You need to hold $AFTER to vote. Your vote counts by how much you hold.");
  db.prepare(`INSERT INTO votes (round_id, address, mint, weight, at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(round_id, address) DO UPDATE SET mint = excluded.mint, weight = excluded.weight, at = excluded.at`)
    .run(round.id, address, mint, weight.toString(), now);
  return { round: round.id, mint, weight };
}

export function voteTotals(db: DB, rid: number) {
  const rows = db.prepare("SELECT mint, weight FROM votes WHERE round_id = ?").all(rid) as Array<{ mint: string; weight: string }>;
  const byMint: Record<string, { weight: bigint; voters: number }> = {};
  let total = 0n;
  for (const r of rows) {
    const w = BigInt(r.weight);
    byMint[r.mint] ??= { weight: 0n, voters: 0 };
    byMint[r.mint].weight += w; byMint[r.mint].voters += 1; total += w;
  }
  return { byMint, total, voters: rows.length };
}

/** Lock every round whose voting time is over. Re-checks each voter's balance first. */
export async function lockDue(db: DB, weightOf: WeightFn, now = Date.now()) {
  const open = db.prepare("SELECT * FROM rounds WHERE locked = 0 ORDER BY id").all() as Round[];
  const locked: Round[] = [];
  for (const r of open) {
    if (now < roundTimes(r.id, CONFIG.voteLockMinute).locksAt) continue;
    const votes = db.prepare("SELECT address, mint, weight FROM votes WHERE round_id = ?").all(r.id) as Array<{ address: string; mint: string; weight: string }>;
    const final: Array<{ token: string; weight: bigint }> = [];
    for (const v of votes) {
      let w = BigInt(v.weight);
      if (!r.practice) {
        const nowBal = await weightOf(v.address).catch(() => w);
        if (nowBal < w) w = nowBal;
        db.prepare("UPDATE votes SET weight = ? WHERE round_id = ? AND address = ?").run(w.toString(), r.id, v.address);
      }
      final.push({ token: v.mint, weight: w });
    }
    const ballot = (JSON.parse(r.ballot) as string[]).map((mint) => ({ token: mint, score: (db.prepare("SELECT score FROM graves WHERE mint = ?").get(mint) as { score: number } | undefined)?.score ?? 0 }));
    const res = tally(ballot, final);
    db.prepare("UPDATE rounds SET locked = 1, winner = ?, winner_reason = ? WHERE id = ? AND locked = 0").run(res.winner, res.reason, r.id);
    locked.push({ ...r, locked: 1, winner: res.winner, winner_reason: res.reason });
  }
  return locked;
}

export function myVote(db: DB, rid: number, address: string) {
  return (db.prepare("SELECT mint, weight FROM votes WHERE round_id = ? AND address = ?").get(rid, address) as { mint: string; weight: string } | undefined) ?? null;
}

export function startRounds(db: DB, weightOf: WeightFn, everyMs = 10_000) {
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      ensureRound(db);
      for (const r of await lockDue(db, weightOf)) console.log(`[rounds] round ${r.id} locked, winner ${r.winner ?? "none"} (${r.winner_reason})`);
    } catch (e) { console.error("[rounds]", (e as Error).message); }
    finally { running = false; }
  };
  void loop();
  return setInterval(loop, everyMs);
}
