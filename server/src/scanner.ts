// Reads the chain and keeps three things in sync:
//  1. pons TokenLaunched events → every coin and its Uniswap v3 pool
//  2. Swap events on those pools → hourly price candles, volume and the latest price
//  3. $NECRO Transfer events → balances, for vote weight
import { toEventSelector, type Address } from "viem";
import { ADDR, CONFIG, PONS_FACTORIES, PONS_LAUNCH_TOPIC, V3_SWAP_TOPIC } from "./config.js";
import { ABI, EVENTS, blockClock, publicClient } from "./chain.js";
import { type DB, getCursor, setCursor, tx } from "./db.js";
import { hourStart, priceFromSqrt, swapEth } from "./rules.js";
import { alert } from "./alerts.js";

const CONFIRMATIONS = 2n;
const MIN_CHUNK = 500n, MAX_CHUNK = 500_000n;
const PARALLEL = Number(process.env.SCAN_PARALLEL ?? 6);
const chunks: Record<string, bigint> = {};
const ZERO = "0x0000000000000000000000000000000000000000";

// Make sure the event shapes match what the docs publish. If pons ever changes them we hear about it.
if (toEventSelector(EVENTS.ponsLaunched) !== PONS_LAUNCH_TOPIC) {
  void alert("launch-topic", "The pons TokenLaunched event signature doesn't match the documented topic. New coins won't be found until it's fixed.");
}
if (toEventSelector(EVENTS.swap) !== V3_SWAP_TOPIC) void alert("swap-topic", "Uniswap Swap topic mismatch.");

/**
 * Walk [from, head] in block ranges. Several ranges are fetched at once (PARALLEL), then saved strictly in order,
 * so the saved cursor never skips anything. Ranges shrink when the RPC complains and grow when it doesn't.
 */
async function walk<T>(name: string, start: bigint, head: bigint, fetch: (from: bigint, to: bigint) => Promise<T>, commit: (data: T, from: bigint, to: bigint) => void) {
  let from = (getCursor(db_(), name) ?? start - 1n) + 1n;
  chunks[name] ??= 20_000n;
  while (from <= head) {
    const ranges: Array<[bigint, bigint]> = [];
    let f = from;
    for (let i = 0; i < PARALLEL && f <= head; i++) {
      const to = f + chunks[name] - 1n > head ? head : f + chunks[name] - 1n;
      ranges.push([f, to]);
      f = to + 1n;
    }
    const results = await Promise.allSettled(ranges.map(([a, b]) => fetch(a, b)));
    let failed: unknown = null;
    for (let i = 0; i < ranges.length; i++) {
      const r = results[i];
      if (r.status === "rejected") { failed = r.reason; break; }
      commit(r.value, ranges[i][0], ranges[i][1]);
      from = ranges[i][1] + 1n;
    }
    if (failed) {
      if (chunks[name] > MIN_CHUNK) {
        chunks[name] /= 2n;
        console.warn(`[scanner] ${name}: range too big, trying ${chunks[name]} blocks (${(failed as Error).message?.split("\n")[0]})`);
        continue;
      }
      throw failed;
    }
    if (chunks[name] < MAX_CHUNK) chunks[name] += chunks[name] / 4n;
    if (name !== "necro") console.log(`[scanner] ${name} at block ${from - 1n} of ${head}`);
  }
}
let _db: DB;
const db_ = () => _db;

async function syncLaunches(db: DB, head: bigint) {
  const start = PONS_FACTORIES.reduce((m, f) => (f.startBlock < m ? f.startBlock : m), PONS_FACTORIES[0].startBlock);
  const weth = ADDR.weth.toLowerCase();
  await walk("launches", start, head, async (from, to) => {
    const logs = await publicClient.getLogs({ address: PONS_FACTORIES.map((f) => f.address), event: EVENTS.ponsLaunched, fromBlock: from, toBlock: to });
    const fresh = logs.filter((l) => l.args.pairToken?.toLowerCase() === weth && l.args.token && l.args.pool);
    const clock = fresh.length ? await blockClock(from, to) : null;
    return fresh.map((l) => {
      const token = (l.args.token! as string).toLowerCase();
      return {
        token, pool: l.args.pool!.toLowerCase(), deployer: l.args.deployer!.toLowerCase(),
        initialBuy: (l.args.initialBuyAmount ?? 0n).toString(), isToken0: token < weth ? 1 : 0,
        supply: (10n ** 27n).toString(), // pons supply is fixed at 1,000,000,000 tokens
        block: Number(l.blockNumber), at: clock!(l.blockNumber!),
      };
    });
  }, (rows, _from, to) => {
    tx(db, () => {
      const ins = db.prepare(`INSERT OR IGNORE INTO coins (token, pool, deployer, initial_buy, is_token0, symbol, name, supply, launch_block, launch_at)
                              VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`);
      for (const r of rows) ins.run(r.token, r.pool, r.deployer, r.initialBuy, r.isToken0, r.supply, r.block, r.at);
      setCursor(db, "launches", to);
    });
  });
}

type Candle = { open: number; high: number; low: number; close: number; vol: number; swaps: number };
type SwapRow = { pool: string; sqrt: bigint | undefined; a0: bigint; a1: bigint; block: bigint; idx: number; at: number };
type PoolInfo = { pool: string; token: string; is_token0: number };

const SWEEP_BATCH = 8000;            // pools checked per scanner pass
const SWEEP_EVERY_MS = 6 * 3_600_000; // re-check each pool's ETH every 6 hours
const POOLS_PER_CALL = 300;

/** Pass 1: read the WETH in every pons pool. Pools with ETH left are "watched" (their trades get read). */
async function sweepPools(db: DB) {
  const due = db.prepare(`SELECT token, pool, launch_block FROM coins WHERE pool_checked_at IS NULL OR pool_checked_at < ?
                          ORDER BY pool_checked_at IS NOT NULL, pool_checked_at LIMIT ?`).all(Date.now() - SWEEP_EVERY_MS, SWEEP_BATCH) as Array<{ token: string; pool: string; launch_block: number }>;
  if (!due.length) return;
  const bals: Array<bigint | null> = [];
  for (let i = 0; i < due.length; i += 500) { // 500 reads at a time (10 batched requests), so the RPC isn't flooded
    bals.push(...(await Promise.all(due.slice(i, i + 500).map((c) => publicClient.readContract({ address: ADDR.weth, abi: ABI.weth, functionName: "balanceOf", args: [c.pool as Address] }).catch(() => null)))));
  }
  const swapsAt = getCursor(db, "swaps");
  let added = 0;
  tx(db, () => {
    const up = db.prepare("UPDATE coins SET pool_eth = ?, pool_checked_at = ? WHERE token = ?");
    const watch = db.prepare("UPDATE coins SET watched = 1, backfill_to = ? WHERE token = ? AND watched = 0");
    const now = Date.now();
    due.forEach((c, i) => {
      const b = bals[i];
      if (b === null) return; // try again next pass
      const eth = Number(b) / 1e18;
      up.run(eth, now, c.token);
      if (eth >= CONFIG.minPoolEth) {
        // Joined after the swap reader already passed its launch: its older trades are read by the backfill.
        const needs = swapsAt !== null && BigInt(c.launch_block) <= swapsAt ? Number(swapsAt) : null;
        added += Number(watch.run(needs, c.token).changes);
      }
    });
  });
  const left = (db.prepare("SELECT COUNT(*) AS n FROM coins WHERE pool_checked_at IS NULL").get() as { n: number }).n;
  console.log(`[scanner] pool sweep: ${due.length} checked, ${added} newly watched, ${left} never checked`);
}

/** Save swaps as hourly candles + latest price. `older` = backfilled history, which must never overwrite newer data. */
function applySwaps(db: DB, rows: SwapRow[], byPool: Map<string, PoolInfo>, older: boolean) {
  rows.sort((a, b) => (a.block === b.block ? a.idx - b.idx : a.block < b.block ? -1 : 1));
  const candles = new Map<string, Candle & { token: string; hour: number; fresh: boolean }>();
  const last = new Map<string, { price: number; at: number }>();
  const getRow = db.prepare("SELECT open, high, low, close, vol_eth AS vol, swaps FROM hourly WHERE token = ? AND hour = ?");
  for (const l of rows) {
    const p = byPool.get(l.pool);
    if (!p || l.sqrt === undefined) continue;
    const price = priceFromSqrt(l.sqrt, p.is_token0 === 1);
    const eth = swapEth(l.a0, l.a1, p.is_token0 === 1);
    const hour = hourStart(l.at);
    const key = `${p.token}|${hour}`;
    let c = candles.get(key);
    if (!c) {
      const prev = getRow.get(p.token, hour) as Candle | undefined;
      c = prev ? { ...prev, token: p.token, hour, fresh: false } : { open: price, high: price, low: price, close: price, vol: 0, swaps: 0, token: p.token, hour, fresh: true };
      if (prev && older) c.open = price;
      candles.set(key, c);
    }
    c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.vol += eth; c.swaps += 1;
    if (!older || c.fresh) c.close = price;
    last.set(p.token, { price, at: l.at });
  }
  const up = db.prepare(`INSERT INTO hourly (token, hour, open, high, low, close, vol_eth, swaps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token, hour) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, vol_eth = excluded.vol_eth, swaps = excluded.swaps`);
  for (const c of candles.values()) up.run(c.token, c.hour, c.open, c.high, c.low, c.close, c.vol, c.swaps);
  const px = db.prepare(`INSERT INTO prices (token, price, last_swap_at) VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET price = excluded.price, last_swap_at = excluded.last_swap_at WHERE excluded.last_swap_at >= prices.last_swap_at`);
  for (const [token, v] of last) px.run(token, v.price, v.at);
}

async function swapLogs(pools: string[], from: bigint, to: bigint): Promise<SwapRow[]> {
  const groups: Address[][] = [];
  for (let i = 0; i < pools.length; i += POOLS_PER_CALL) groups.push(pools.slice(i, i + POOLS_PER_CALL) as Address[]);
  const logs = (await Promise.all(groups.map((address) => publicClient.getLogs({ address, event: EVENTS.swap, fromBlock: from, toBlock: to })))).flat();
  if (!logs.length) return [];
  const clock = await blockClock(from, to);
  return logs.map((l) => ({ pool: l.address.toLowerCase(), sqrt: l.args.sqrtPriceX96, a0: l.args.amount0 ?? 0n, a1: l.args.amount1 ?? 0n, block: l.blockNumber!, idx: l.logIndex!, at: clock(l.blockNumber!) }));
}

/** Pass 2: read trades, but only in watched pools. Waits until every pool has been checked once. */
async function syncSwaps(db: DB, head: bigint) {
  const launched = getCursor(db, "launches");
  if (launched === null) return;
  const unchecked = (db.prepare("SELECT COUNT(*) AS n FROM coins WHERE pool_checked_at IS NULL").get() as { n: number }).n;
  if (unchecked > 0 && getCursor(db, "swaps") === null) return; // first full sweep still running
  const top = head < launched ? head : launched;
  const watched = db.prepare("SELECT pool, token, is_token0 FROM coins WHERE watched = 1").all() as PoolInfo[];
  if (!watched.length) { if (unchecked === 0) setCursor(db, "swaps", top); return; }
  const byPool = new Map(watched.map((p) => [p.pool, p]));
  const pools = watched.map((p) => p.pool);
  const first = (db.prepare("SELECT MIN(launch_block) AS b FROM coins WHERE watched = 1").get() as { b: number }).b;
  await walk("swaps", BigInt(first), top, (from, to) => swapLogs(pools, from, to), (rows, _from, to) => {
    tx(db, () => { if (rows.length) applySwaps(db, rows, byPool, false); setCursor(db, "swaps", to); });
  });
}

/** Pools that started being watched after the swap reader passed their launch get their older trades here. */
async function backfill(db: DB) {
  const due = db.prepare("SELECT token, pool, is_token0, launch_block, backfill_to FROM coins WHERE watched = 1 AND backfill_to IS NOT NULL LIMIT 40")
    .all() as Array<PoolInfo & { launch_block: number; backfill_to: number }>;
  for (const c of due) {
    const byPool = new Map([[c.pool, c]]);
    let from = BigInt(c.launch_block);
    const end = BigInt(c.backfill_to);
    let step = 2_000_000n;
    const rows: SwapRow[] = [];
    while (from <= end) {
      const to = from + step - 1n > end ? end : from + step - 1n;
      try { rows.push(...(await swapLogs([c.pool], from, to))); from = to + 1n; }
      catch (e) { if (step > 5_000n) { step /= 4n; continue; } throw e; }
    }
    tx(db, () => {
      applySwaps(db, rows, byPool, true);
      db.prepare("UPDATE coins SET backfill_to = NULL WHERE token = ?").run(c.token);
    });
  }
}

async function syncNecro(db: DB, head: bigint) {
  if (!CONFIG.necroToken) return;
  // Start block: the setting if given, otherwise the launch block the scanner already recorded for $NECRO on pons.
  let start = CONFIG.necroStartBlock;
  if (start === 0n) {
    const row = db.prepare("SELECT launch_block FROM coins WHERE token = ?").get(CONFIG.necroToken.toLowerCase()) as { launch_block: number } | undefined;
    if (!row) return; // wait until the scanner has seen the launch
    start = BigInt(row.launch_block);
  }
  await walk("necro", start, head,
    (from, to) => publicClient.getLogs({ address: CONFIG.necroToken!, event: EVENTS.transfer, fromBlock: from, toBlock: to }) as Promise<Array<{ args: { from?: string; to?: string; value?: bigint } }>>,
    (logs, _from, to) => {
    tx(db, () => {
      const get = db.prepare("SELECT balance FROM necro_balances WHERE address = ?");
      const set = db.prepare("INSERT INTO necro_balances (address, balance) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET balance = excluded.balance");
      for (const l of logs) {
        for (const [addr, delta] of [[l.args.from, -(l.args.value ?? 0n)], [l.args.to, l.args.value ?? 0n]] as const) {
          const a = (addr ?? ZERO).toLowerCase();
          if (a === ZERO) continue;
          const cur = BigInt((get.get(a) as { balance: string } | undefined)?.balance ?? "0");
          const next = cur + delta < 0n ? 0n : cur + delta;
          set.run(a, next.toString());
        }
      }
      setCursor(db, "necro", to);
    });
  });
}

export async function scanOnce(db: DB) {
  _db = db;
  const head = (await publicClient.getBlockNumber()) - CONFIRMATIONS;
  await syncLaunches(db, head);
  await sweepPools(db);
  await syncSwaps(db, head);
  await backfill(db);
  await syncNecro(db, head);
  return head;
}

export function startScanner(db: DB, everyMs = 15_000) {
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try { await scanOnce(db); }
    catch (e) { console.error("[scanner]", (e as Error).message.split("\n")[0]); }
    finally { running = false; }
  };
  void loop();
  return setInterval(loop, everyMs);
}
