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

async function syncSwaps(db: DB, head: bigint) {
  const launched = getCursor(db, "launches");
  if (launched === null) return;
  const top = head < launched ? head : launched; // never read swaps for pools we haven't met yet
  const pools = db.prepare("SELECT pool, token, is_token0 FROM coins").all() as Array<{ pool: string; token: string; is_token0: number }>;
  if (!pools.length) { setCursor(db, "swaps", top); return; }
  const byPool = new Map(pools.map((p) => [p.pool, p]));
  const first = PONS_FACTORIES.reduce((m, f) => (f.startBlock < m ? f.startBlock : m), PONS_FACTORIES[0].startBlock);

  await walk("swaps", first, top, async (from, to) => {
    // One request for every Uniswap v3 swap in the range, filtered here. Scales with trades, not with coin count.
    const all = (await publicClient.getLogs({ event: EVENTS.swap, fromBlock: from, toBlock: to })).filter((l) => byPool.has(l.address.toLowerCase()));
    const clock = all.length ? await blockClock(from, to) : null;
    return all.map((l) => ({ pool: l.address.toLowerCase(), sqrt: l.args.sqrtPriceX96, a0: l.args.amount0 ?? 0n, a1: l.args.amount1 ?? 0n, block: l.blockNumber!, idx: l.logIndex!, at: clock!(l.blockNumber!) }));
  }, (all, _from, to) => {
    if (!all.length) { setCursor(db, "swaps", to); return; }
    all.sort((a, b) => (a.block === b.block ? a.idx - b.idx : a.block < b.block ? -1 : 1));
    const candles = new Map<string, Candle & { token: string; hour: number }>();
    const last = new Map<string, { price: number; at: number }>();
    const getRow = db.prepare("SELECT open, high, low, close, vol_eth AS vol, swaps FROM hourly WHERE token = ? AND hour = ?");
    for (const l of all) {
      const p = byPool.get(l.pool);
      if (!p || l.sqrt === undefined) continue;
      const price = priceFromSqrt(l.sqrt, p.is_token0 === 1);
      const eth = swapEth(l.a0, l.a1, p.is_token0 === 1);
      const hour = hourStart(l.at);
      const key = `${p.token}|${hour}`;
      let c = candles.get(key);
      if (!c) {
        const prev = getRow.get(p.token, hour) as Candle | undefined;
        c = prev ? { ...prev, token: p.token, hour } : { open: price, high: price, low: price, close: price, vol: 0, swaps: 0, token: p.token, hour };
        candles.set(key, c);
      }
      c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; c.vol += eth; c.swaps += 1;
      last.set(p.token, { price, at: l.at });
    }
    tx(db, () => {
      const up = db.prepare(`INSERT INTO hourly (token, hour, open, high, low, close, vol_eth, swaps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token, hour) DO UPDATE SET high = excluded.high, low = excluded.low, close = excluded.close, vol_eth = excluded.vol_eth, swaps = excluded.swaps`);
      for (const c of candles.values()) up.run(c.token, c.hour, c.open, c.high, c.low, c.close, c.vol, c.swaps);
      const px = db.prepare(`INSERT INTO prices (token, price, last_swap_at) VALUES (?, ?, ?)
        ON CONFLICT(token) DO UPDATE SET price = excluded.price, last_swap_at = excluded.last_swap_at`);
      for (const [token, v] of last) px.run(token, v.price, v.at);
      setCursor(db, "swaps", to);
    });
  });
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
  await syncSwaps(db, head);
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
