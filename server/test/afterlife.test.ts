import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { DAY, HOUR, causeOfDeath, isDead, phaseAt, pumpBudget, revivable, revivalScore, roundId, roundTimes, splitChunks, tally } from "../src/rules.ts";
import { openDb, kvSet } from "../src/db.ts";
import { VoteError, castVote, ensureRound, lockDue } from "../src/rounds.ts";
import { coinView, graveyardView, logView, roundView } from "../src/views.ts";
import { b58decode, b58encode, isAddress, verifySignature } from "../src/solana.ts";

const R = { minAthUsd: 60_000, maxAthUsd: 2e9, minDropPct: 90, quietVol24hUsd: 2_000, minDeadDays: 7, minPoolSol: 1, maxDevPct: 2, cooldownHours: 24 };

test("base58 round trip and Solana address check", () => {
  const bytes = Uint8Array.from([0, 0, 1, 2, 255, 128, 7]);
  assert.deepEqual(b58decode(b58encode(bytes)), bytes);
  assert.equal(isAddress("So11111111111111111111111111111111111111112"), true);
  assert.equal(isAddress("0x4d3E32aA053582646Dd2b184c15960710Fb2e025"), false);
});

test("wallet sign-in: a real ed25519 signature verifies, a wrong one doesn't", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const address = b58encode(new Uint8Array(raw));
  const msg = "Sign in to Afterlife\n\nWallet: " + address;
  const sig = b58encode(new Uint8Array(sign(null, Buffer.from(msg), privateKey)));
  assert.equal(verifySignature(address, msg, sig), true);
  assert.equal(verifySignature(address, msg + "x", sig), false);
});

test("round clock: opens :00, locks :50, pumps next :00", () => {
  const t = Date.UTC(2026, 9, 4, 15, 20);
  const { opensAt, locksAt, pumpsAt } = roundTimes(roundId(t));
  assert.equal(opensAt, Date.UTC(2026, 9, 4, 15, 0));
  assert.equal(locksAt, Date.UTC(2026, 9, 4, 15, 50));
  assert.equal(pumpsAt, Date.UTC(2026, 9, 4, 16, 0));
  assert.equal(phaseAt(t), "open");
});

test("tally: weight wins, ties go to score, no votes → top score", () => {
  const ballot = [{ token: "a", score: 70 }, { token: "b", score: 90 }, { token: "c", score: 80 }];
  assert.equal(tally(ballot, [{ token: "a", weight: 5n }, { token: "c", weight: 3n }]).winner, "a");
  assert.equal(tally(ballot, [{ token: "a", weight: 5n }, { token: "c", weight: 5n }]).winner, "c");
  assert.equal(tally(ballot, []).winner, "b");
});

test("pump split and budget (lamports)", () => {
  assert.deepEqual(splitChunks(10n, 3), [3n, 3n, 4n]);
  const s = 1_000_000_000n;
  assert.equal(pumpBudget({ balanceWei: 5n * s, reserveWei: s / 50n, maxWei: 2n * s, spentTodayWei: 0n, dailyCapWei: 20n * s }), 2n * s);
  assert.equal(pumpBudget({ balanceWei: s / 100n, reserveWei: s / 50n, maxWei: 2n * s, spentTodayWei: 0n, dailyCapWei: 20n * s }), 0n);
});

test("dead = real ATH, fell 90%+, quiet; bad ATH data is ignored", () => {
  assert.equal(isDead({ athUsd: 500_000, nowUsd: 20_000, vol24Usd: 300 }, R), true);
  assert.equal(isDead({ athUsd: 500_000, nowUsd: 80_000, vol24Usd: 300 }, R), false); // only -84%
  assert.equal(isDead({ athUsd: 500_000, nowUsd: 20_000, vol24Usd: 50_000 }, R), false); // still trading
  assert.equal(isDead({ athUsd: 30_000, nowUsd: 100, vol24Usd: 0 }, R), false); // never really lived
  assert.equal(isDead({ athUsd: 1.9e23, nowUsd: 100, vol24Usd: 0 }, R), false); // garbage ATH
});

test("revival checks, in order", () => {
  const now = 100 * DAY;
  const good = { poolSol: 10, devPct: 0.5, athAt: now - 20 * DAY, lastPumpAt: null };
  assert.equal(revivable(good, now, R).status, "ok");
  assert.match(revivable({ ...good, poolSol: 0.4 }, now, R).why, /Under 1 SOL/);
  assert.equal(revivable({ ...good, devPct: 31 }, now, R).why, "Dev still holds 31.0%");
  assert.equal(revivable({ ...good, athAt: now - 3 * DAY }, now, R).status, "fresh");
  assert.equal(revivable({ ...good, lastPumpAt: now - 3 * HOUR }, now, R).why, "Pumped 3 hours ago");
  assert.equal(causeOfDeath(0.2), "dev");
  assert.equal(causeOfDeath(1.5), "fade");
  assert.equal(revivalScore({ poolSol: 50, athUsd: 6_000_000, devPct: 0, deadDays: 30, vol24Usd: 1_000 }, R).total, 100);
});

const M = ["AfTeRmint1111111111111111111111111111111111", "HoPiUm222222222222222222222222222222222222", "BrRr3333333333333333333333333333333333333333"];
function seed() {
  const db = openDb(":memory:");
  kvSet(db, "sol_usd", "120");
  M.forEach((mint, i) => {
    db.prepare("INSERT INTO coins (mint, symbol, name, creator, pool, created_at, ath_usd, ath_at, mcap_usd, seen_at) VALUES (?, ?, ?, 'Dev1', 'Pool1', 0, 500000, 0, 20000, 0)")
      .run(mint, ["GMGN", "HOPIUM", "BRRR"][i], "x");
    db.prepare(`INSERT INTO graves (mint, status, why, cause, score, parts, peak_usd, now_usd, died_at, pool_sol, dev_pct, checked_at)
                VALUES (?, 'ok', 'On the ballot', 'dev', ?, '{}', 500000, 20000, 0, 10, 0.1, 0)`).run(mint, [80, 90, 70][i]);
  });
  return db;
}

test("a live round: weight from $AFTER held, re-checked at lock (min of the two)", async () => {
  const db = seed();
  const t = Date.UTC(2026, 9, 4, 15, 5);
  const r = ensureRound(db, t, 0);
  assert.deepEqual(JSON.parse(r.ballot), [M[1], M[0], M[2]]); // by score, case kept
  const bal: Record<string, bigint> = { WalletA: 1000n, WalletB: 300n, WalletC: 0n };
  const w = async (a: string) => bal[a] ?? 0n;
  await castVote(db, "WalletA", M[2], w, t);
  await castVote(db, "WalletB", M[0], w, t);
  await assert.rejects(castVote(db, "WalletC", M[0], w, t), (e: unknown) => e instanceof VoteError && e.code === "no_weight");
  await assert.rejects(castVote(db, "WalletB", "Nope", w, t), (e: unknown) => e instanceof VoteError && e.code === "not_on_ballot");
  assert.equal(roundView(db, t, "WalletA").leader, M[2]);
  bal.WalletA = 10n; // A sold before the lock
  const locked = await lockDue(db, w, Date.UTC(2026, 9, 4, 15, 50));
  assert.equal(locked[0].winner, M[0]); // B's 300 now beats A's 10
  await assert.rejects(castVote(db, "WalletB", M[0], w, Date.UTC(2026, 9, 4, 15, 51)), (e: unknown) => e instanceof VoteError && e.code === "locked");
});

test("practice round: one wallet, one vote", async () => {
  const db = seed();
  const t = Date.UTC(2026, 9, 4, 16, 5);
  ensureRound(db, t, 1);
  const v = await castVote(db, "Anyone", M[0], async () => 0n, t);
  assert.equal(v.weight, 1n);
});

test("views: graveyard, search, coin record, log", () => {
  const db = seed();
  const g = graveyardView(db, {});
  assert.equal(g.stats.buried, 3); assert.equal(g.stats.revivable, 3);
  assert.equal(graveyardView(db, { q: "$hop" }).rows[0].symbol, "HOPIUM");
  assert.equal(graveyardView(db, { q: M[2] }).rows[0].symbol, "BRRR");
  const c = coinView(db, M[1], Date.UTC(2026, 9, 4, 15, 5));
  assert.equal(c?.fall, 96); assert.equal(c?.pumpfun, `https://pump.fun/coin/${M[1]}`);
  assert.equal(logView(db).stats.pumps, 0);
});
