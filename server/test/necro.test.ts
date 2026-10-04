import { test } from "node:test";
import assert from "node:assert/strict";
import { DAY, HOUR, causeOfDeath, isBuried, lifeOf, phaseAt, priceFromSqrt, pumpBudget, revivable, revivalScore, roundId, roundTimes, splitChunks, swapEth, tally } from "../src/rules.ts";
import { openDb, kvSet } from "../src/db.ts";
import { VoteError, castVote, ensureRound, lockDue } from "../src/rounds.ts";
import { coinView, graveyardView, logView, roundView } from "../src/views.ts";

const R = { minPeakUsd: 10_000, minDropPct: 90, quietVol24hEth: 0.05, minDeadDays: 7, minPoolEth: 0.05, maxDevPct: 2, cooldownHours: 24 };
const Q96 = 2n ** 96n;

test("price from sqrtPriceX96, both pool orders", () => {
  // price 1 (token1 per token0)
  assert.equal(priceFromSqrt(Q96, true), 1);
  assert.equal(priceFromSqrt(Q96, false), 1);
  // token1/token0 = 4 → coin as token0 is worth 4 ETH; coin as token1 is worth 0.25 ETH
  assert.equal(priceFromSqrt(Q96 * 2n, true), 4);
  assert.equal(priceFromSqrt(Q96 * 2n, false), 0.25);
});

test("swap ETH volume reads the WETH side", () => {
  assert.equal(swapEth(-5n * 10n ** 18n, 2n * 10n ** 17n, true), 0.2);
  assert.equal(swapEth(-3n * 10n ** 17n, 9n, false), 0.3);
});

test("round clock: opens :00, locks :50, pumps next :00", () => {
  const t = Date.UTC(2026, 9, 4, 15, 20);
  const id = roundId(t);
  const { opensAt, locksAt, pumpsAt } = roundTimes(id);
  assert.equal(opensAt, Date.UTC(2026, 9, 4, 15, 0));
  assert.equal(locksAt, Date.UTC(2026, 9, 4, 15, 50));
  assert.equal(pumpsAt, Date.UTC(2026, 9, 4, 16, 0));
  assert.equal(phaseAt(t), "open");
  assert.equal(phaseAt(Date.UTC(2026, 9, 4, 15, 50)), "locked");
});

test("tally: weight wins, ties go to score, no votes → top score", () => {
  const ballot = [{ token: "a", score: 70 }, { token: "b", score: 90 }, { token: "c", score: 80 }];
  assert.deepEqual(tally(ballot, [{ token: "a", weight: 5n }, { token: "c", weight: 3n }]).winner, "a");
  assert.equal(tally(ballot, [{ token: "a", weight: 5n }, { token: "c", weight: 5n }]).winner, "c");
  const none = tally(ballot, []);
  assert.equal(none.winner, "b"); assert.equal(none.reason, "no_votes");
  assert.equal(tally(ballot, [{ token: "zzz", weight: 99n }]).winner, "b"); // votes off the ballot don't count
  assert.equal(tally([], []).winner, null);
});

test("pump split and budget", () => {
  assert.deepEqual(splitChunks(10n, 3), [3n, 3n, 4n]);
  assert.deepEqual(splitChunks(2n, 5), [2n]);
  assert.deepEqual(splitChunks(0n, 5), []);
  const e = 10n ** 18n;
  assert.equal(pumpBudget({ balanceWei: 2n * e, reserveWei: e / 100n, maxWei: e / 2n, spentTodayWei: 0n, dailyCapWei: 5n * e }), e / 2n);
  assert.equal(pumpBudget({ balanceWei: e / 10n, reserveWei: e / 100n, maxWei: e, spentTodayWei: 0n, dailyCapWei: 5n * e }), e / 10n - e / 100n);
  assert.equal(pumpBudget({ balanceWei: 2n * e, reserveWei: 0n, maxWei: e, spentTodayWei: 5n * e - e / 4n, dailyCapWei: 5n * e }), e / 4n);
  assert.equal(pumpBudget({ balanceWei: e / 1000n, reserveWei: e / 100n, maxWei: e, spentTodayWei: 0n, dailyCapWei: e }), 0n);
});

test("life of a coin: peak from hourly closes, death when it falls 90%", () => {
  const h = (i: number) => i * HOUR;
  const candles = [1, 5, 10, 8, 3, 0.9, 0.5].map((close, i) => ({ hour: h(i), close, vol_eth: 1 }));
  const life = lifeOf(candles, 0.4, 90);
  assert.equal(life.peak, 10); assert.equal(life.peakAt, h(2)); assert.equal(life.diedAt, h(5));
});

test("buried = lived, fell 90%+, and went quiet", () => {
  assert.equal(isBuried({ peakUsd: 50_000, nowUsd: 4_000, vol24hEth: 0.01 }, R), true);
  assert.equal(isBuried({ peakUsd: 50_000, nowUsd: 6_000, vol24hEth: 0.01 }, R), false); // only -88%
  assert.equal(isBuried({ peakUsd: 50_000, nowUsd: 4_000, vol24hEth: 2 }, R), false); // still trading
  assert.equal(isBuried({ peakUsd: 5_000, nowUsd: 10, vol24hEth: 0 }, R), false); // never really lived
});

test("revival checks, in order", () => {
  const now = 100 * DAY;
  const good = { poolEth: 1, devPct: 0.5, sellOk: true, diedAt: now - 10 * DAY, lastPumpAt: null };
  assert.equal(revivable(good, now, R).status, "ok");
  assert.match(revivable({ ...good, poolEth: 0.01 }, now, R).why, /Under 0.05 ETH/);
  assert.equal(revivable({ ...good, devPct: 31 }, now, R).why, "Dev still holds 31.0%");
  assert.equal(revivable({ ...good, sellOk: false }, now, R).why, "Failed the sell test");
  assert.equal(revivable({ ...good, diedAt: now - 4 * DAY }, now, R).status, "fresh");
  const w = revivable({ ...good, lastPumpAt: now - 3 * HOUR }, now, R);
  assert.equal(w.status, "wait"); assert.equal(w.why, "Pumped 3 hours ago");
  assert.equal(revivable({ ...good, lastPumpAt: now - 25 * HOUR }, now, R).status, "ok");
});

test("cause of death and revival score", () => {
  assert.equal(causeOfDeath(1000n, 50n), "dev");
  assert.equal(causeOfDeath(1000n, 500n), "fade");
  assert.equal(causeOfDeath(0n, 0n), "fade");
  const s = revivalScore({ poolEth: 2, holders: 2000, devPct: 0, deadDays: 30, vol7dEth: 0.5 }, R);
  assert.equal(s.total, 100);
  const low = revivalScore({ poolEth: 0, holders: 1, devPct: 2, deadDays: 0, vol7dEth: 0 }, R);
  assert.equal(low.total, 0);
});

// ---------------- rounds + views against a real (in-memory) database ----------------
function seed() {
  const db = openDb(":memory:");
  kvSet(db, "eth_usd", "2600");
  const coins = ["0xaaa", "0xbbb", "0xccc"].map((p, i) => ({ token: p.padEnd(42, String(i + 1)), sym: ["HOPIUM", "BRRR", "MOONDOG"][i], score: [80, 90, 70][i] }));
  for (const c of coins) {
    db.prepare("INSERT INTO coins (token, pool, deployer, is_token0, symbol, name, launch_block, launch_at) VALUES (?, ?, ?, 1, ?, ?, 1, 0)")
      .run(c.token, c.token.replace("0x", "0xf"), "0xdead000000000000000000000000000000000000", c.sym, c.sym);
    db.prepare(`INSERT INTO graves (token, status, why, cause, score, parts, peak_usd, now_usd, died_at, pool_eth, dev_pct, holders, sell_ok, checked_at)
                VALUES (?, 'ok', 'On the ballot', 'dev', ?, '{}', 100000, 5000, 0, 1, 0.1, 500, 1, 0)`).run(c.token, c.score);
    db.prepare("INSERT INTO hourly (token, hour, open, high, low, close, vol_eth, swaps) VALUES (?, 0, 1e-6, 1e-6, 1e-6, 1e-6, 0, 1)").run(c.token);
  }
  db.prepare("INSERT INTO graves (token, status, why, cause, score, parts, peak_usd, now_usd, checked_at) VALUES ('0xrug', 'no', 'Under 0.05 ETH left in the pool', 'fade', 0, '{}', 9e5, 0, 0)").run();
  db.prepare("INSERT INTO coins (token, pool, deployer, is_token0, symbol, launch_block, launch_at) VALUES ('0xrug', '0xp', '0xd', 1, 'RUGZILLA', 1, 0)").run();
  return { db, coins };
}

test("a round: ballot by score, practice votes, lock picks the winner", () => {
  const { db, coins } = seed();
  const t = Date.UTC(2026, 9, 4, 15, 5);
  const r = ensureRound(db, t);
  assert.deepEqual(JSON.parse(r.ballot), [coins[1].token, coins[0].token, coins[2].token]); // by score
  assert.equal(r.practice, 1); // no $NECRO token configured

  castVote(db, "0x1111111111111111111111111111111111111111", coins[2].token, t);
  castVote(db, "0x2222222222222222222222222222222222222222", coins[2].token, t + 1000);
  castVote(db, "0x3333333333333333333333333333333333333333", coins[0].token, t + 2000);
  castVote(db, "0x3333333333333333333333333333333333333333", coins[2].token, t + 3000); // changing a vote replaces it
  assert.throws(() => castVote(db, "0x4444444444444444444444444444444444444444", "0xrug", t), (e: unknown) => e instanceof VoteError && e.code === "not_on_ballot");

  const view = roundView(db, t, "0x3333333333333333333333333333333333333333");
  assert.equal(view.voters, 3);
  assert.equal(view.leader, coins[2].token);
  assert.equal(view.myVote?.token, coins[2].token);
  assert.equal(view.ballot.find((b) => b.token === coins[2].token)?.pct, 100);

  assert.equal(lockDue(db, t + 10 * 60_000).length, 0); // still open at :15
  assert.throws(() => castVote(db, "0x5555555555555555555555555555555555555555", coins[0].token, Date.UTC(2026, 9, 4, 15, 51)), (e: unknown) => e instanceof VoteError && e.code === "locked");
  const locked = lockDue(db, Date.UTC(2026, 9, 4, 15, 50));
  assert.equal(locked.length, 1);
  assert.equal(locked[0].winner, coins[2].token);
  assert.equal(lockDue(db, Date.UTC(2026, 9, 4, 15, 55)).length, 0); // never locks twice
});

test("views: graveyard stats, search and coin record", () => {
  const { db, coins } = seed();
  const g = graveyardView(db, {});
  assert.equal(g.stats.buried, 4); assert.equal(g.stats.revivable, 3);
  assert.deepEqual(g.causes, [["Pool nearly empty", 1], ["Revivable", 3]]);
  assert.equal(graveyardView(db, { q: "$rug" }).rows[0].symbol, "RUGZILLA");
  assert.equal(graveyardView(db, { status: "no" }).rows.length, 1);
  const c = coinView(db, coins[0].token, Date.UTC(2026, 9, 4, 15, 5));
  assert.equal(c?.symbol, "HOPIUM"); assert.equal(c?.fall, 95);
  assert.equal(coinView(db, "0xnope"), null);
  assert.equal(logView(db).stats.pumps, 0);
});
