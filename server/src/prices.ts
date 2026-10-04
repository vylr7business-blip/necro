// Live prices from the Uniswap v3 pools on Robinhood Chain, via QuoterV2.
import type { Address } from "viem";
import { ADDR } from "./config.js";
import { ABI, publicClient } from "./chain.js";

const FEE_TIERS = [10000, 3000, 500, 100] as const;
const poolCache = new Map<string, { fee: number; at: number }>();

/** Find the fee tier with the most liquidity for a pair (cached 1 hour). */
export async function bestFee(a: Address, b: Address): Promise<number> {
  const key = [a, b].map((x) => x.toLowerCase()).sort().join("-");
  const hit = poolCache.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.fee;
  let best: { fee: number; liq: bigint } | null = null;
  for (const fee of FEE_TIERS) {
    const pool = await publicClient.readContract({ address: ADDR.v3Factory, abi: ABI.v3Factory, functionName: "getPool", args: [a, b, fee] });
    if (pool === "0x0000000000000000000000000000000000000000") continue;
    const liq = await publicClient.readContract({ address: pool, abi: ABI.pool, functionName: "liquidity" });
    if (!best || liq > best.liq) best = { fee, liq };
  }
  if (!best || best.liq === 0n) throw new Error(`No Uniswap v3 pool with liquidity for ${a} / ${b}`);
  poolCache.set(key, { fee: best.fee, at: Date.now() });
  return best.fee;
}

/** How much `tokenOut` you get for `amountIn` of `tokenIn`. Pass `fee` to skip the pool lookup. */
export async function quoteIn(tokenIn: Address, tokenOut: Address, amountIn: bigint, fee?: number): Promise<{ out: bigint; fee: number }> {
  const f = fee ?? (await bestFee(tokenIn, tokenOut));
  const { result } = await publicClient.simulateContract({
    address: ADDR.quoterV2, abi: ABI.quoter, functionName: "quoteExactInputSingle",
    args: [{ tokenIn, tokenOut, amountIn, fee: f, sqrtPriceLimitX96: 0n }],
  });
  return { out: result[0], fee: f };
}

let ethCache: { v: number; at: number } | null = null;
/** USD price of 1 ETH (cached 2 minutes). */
export async function ethUsd(): Promise<number> {
  if (ethCache && Date.now() - ethCache.at < 120_000) return ethCache.v;
  const { out } = await quoteIn(ADDR.weth, ADDR.usdg, 10n ** 16n); // quote 0.01 ETH to keep impact tiny
  const v = (Number(out) / 1e6) * 100;
  ethCache = { v, at: Date.now() };
  return v;
}
