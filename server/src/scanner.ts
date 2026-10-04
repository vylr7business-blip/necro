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
const POOLS_PER_CALL = 400;
const MIN_CHUNK = 500n, MAX_CHUNK = 200_000n;
const chunks: Record<string, bigint> = {};
const ZERO = "0x0000000000000000000000000000000000000000";

// Make sure the event shapes match what the docs publish. If pons ever changes them we hear about it.
if (toEventSelector(EVENTS.ponsLaunched) !== PONS_LAUNCH_TOPIC) {
  void alert("launch-topic", "The pons TokenLaunched event signature doesn't match the documented topic. New coins won't be found until it's fixed.");
}
if (toEventSelector(EVENTS.swap) !== V3_SWAP_TOPIC) void alert("swap-topic", "Uniswap Swap topic mismatch.");

/** Walk [from, head] in block ranges that shrink when the RPC complains and grow when it doesn't. */
async function walk(name: string, start: bigint, head: bigint, step: (from: bigint, to: bigint) => Promise<void>) {
  let from = (getCursor(db_(), name) ?? start - 1n) + 1n;
  chunks[name] ??= 20_000n;
  while (from <= head) {
    const to = from + chunks[name] - 1n > head ? head : from + chunks[name] - 1n;
    try {
      await step(from, to);
    } catch (e) {
      if (chunks[name] > MIN_CHUNK) {
        chunks[name] /= 2n;
        console.warn(`[scanner] ${name}: range too big, trying ${chunks[name]} blocks (${(e as Error).message.split("\n")[0]})`);
        continue;
      }
      throw e;
    }
    from = to + 1n;
    if (chunks[name] < MAX_CHUNK) chunks[name] += chunks[name] / 4n;
  }
}
let _db: DB;
const db_ = () => _db;

async function syncLaunches(db: DB, head: bigint) {
  const start = PONS_FACTORIES.reduce((m, f) => (f.startBlock < m ? f.startBlock : m), PONS_FACTORIES[0].startBlock);
  await walk("launches", start, head, async (from, to) => {
    const logs = await publicClient.getLogs({ address: PONS_FACTORIES.map((f) => f.address), event: EVENTS.ponsLaunched, fromBlock: from, toBlock: to });
    const weth = ADDR.weth.toLowerCase();
    const fresh = logs.filter((l) => l.args.pairToken?.toLowerCase() === weth && l.args.token && l.args.pool);
    const clock = fresh.length ? await blockClock(from, to) : null;
    const rows = await Promise.all(fresh.map(async (l) => {
      const token = l.args.token! as Address;
      const [symbol, name, supply] = await Promise.all([
        publicClient.readContract({ address: token, abi: ABI.erc20, functionName: "symbol" }).catch(() => null),
        publicClient.readContract({ address: token, abi: ABI.erc20, functionName: "name" }).catch(() => null),
        publicClient.readContract({ address: token, abi: ABI.erc20, functionName: "totalSupply" }).catch(() => 10n ** 27n),
      ]);
      return {
        token: token.toLowerCase(), pool: l.args.pool!.toLowerCase(), deployer: l.args.deployer!.toLowerCase(),
        initialBuy: (l.args.initialBuyAmount ?? 0n).toString(), isToken0: token.toLowerCase() < weth ? 1 : 0,
        symbol: symbol ? String(symbol).slice(0, 24) : null, name: name ? String(name).slice(0, 64) : null,
        supply: supply.toString(), block: Number(l.blockNumber), at: clock!(l.blockNumber!),
      };
    }));
    tx(db, () => {
      const ins = db.prepare(`INSERT OR IGNORE INTO coins (token, pool, deployer, initial_buy, is_token0, symbol, name, supply, launch_block, launch_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of rows) ins.run(r.token, r.pool, r.deployer, r.initialBuy, r.isToken0, r.symbol, r.name, r.supply, r.block, r.at);
      setCursor(db, "launches", to);
    });
    if (rows.length) console.log(`[scanner] +${rows.length} coin(s) up to block ${to}`);
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
  const groups: Address[][] = [];
  for (let i = 0; i < pools.length; i += POOLS_PER_CALL) groups.push(pools.slice(i, i + POOLS_PER_CALL).map((p) => p.pool as Address));
  const first = PONS_FACTORIES.reduce((m, f) => (f.startBlock < m ? f.startBlock : m), PONS_FACTORIES[0].startBlock);

  await walk("swaps", first, top, async (from, to) => {
    const all = (await Promise.all(groups.map((address) => publicClient.getLogs({ address, event: EVENTS.swap, fromBlock: from, toBlock: to })))).flat();
    if (!all.length) { setCursor(db, "swaps", to); return; }
    all.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex! - b.logIndex! : a.blockNumber! < b.blockNumber! ? -1 : 1));
    const clock = await blockClock(from, to);
    const candles = new Map<string, Candle & { token: string; hour: number }>();
    const last = new Map<string, { price: number; at: number }>();
    const getRow = db.prepare("SELECT open, high, low, close, vol_eth AS vol, swaps FROM hourly WHERE token = ? AND hour = ?");
    for (const l of all) {
      const p = byPool.get(l.address.toLowerCase());
      if (!p || l.args.sqrtPriceX96 === undefined) continue;
      const price = priceFromSqrt(l.args.sqrtPriceX96, p.is_token0 === 1);
      const eth = swapEth(l.args.amount0 ?? 0n, l.args.amount1 ?? 0n, p.is_token0 === 1);
      const at = clock(l.blockNumber!);
      const hour = hourStart(at);
      const key = `${p.token}|${hour}`;
      let c = candles.get(key);
      if (!c) {
        const prev = getRow.get(p.token, hour) as Candle | undefined;
        c = prev ? { ...prev, token: p.token, hour } : { open: price, high: price, low: price, close: price, vol: 0, swaps: 0, token: p.token, hour };
        candles.set(key, c);
      }
      c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; c.vol += eth; c.swaps += 1;
      last.set(p.token, { price, at });
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
  await walk("necro", CONFIG.necroStartBlock, head, async (from, to) => {
    const logs = await publicClient.getLogs({ address: CONFIG.necroToken!, event: EVENTS.transfer, fromBlock: from, toBlock: to });
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
