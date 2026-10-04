import { createPublicClient, createWalletClient, defineChain, http, parseAbi, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CONFIG } from "./config.js";

export const robinhood = defineChain({
  id: CONFIG.chainId,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [CONFIG.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: CONFIG.explorer } },
});

// batch: many small reads in one HTTP request, which keeps the scanner fast and polite to the RPC.
export const publicClient = createPublicClient({
  chain: robinhood,
  transport: http(CONFIG.rpcUrl, { retryCount: 3, batch: { batchSize: 50, wait: 20 } }),
});

export const pumpAccount = CONFIG.pumpKey ? privateKeyToAccount(CONFIG.pumpKey) : null;
export const walletClient = pumpAccount
  ? createWalletClient({ account: pumpAccount, chain: robinhood, transport: http(CONFIG.rpcUrl) })
  : null;

export const ABI = {
  erc20: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ]),
  weth: parseAbi(["function deposit() payable", "function balanceOf(address) view returns (uint256)"]),
  v3Factory: parseAbi(["function getPool(address,address,uint24) view returns (address)"]),
  pool: parseAbi(["function liquidity() view returns (uint128)"]),
  quoter: parseAbi([
    "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160, uint32, uint256)",
  ]),
  router: parseAbi([
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  ]),
};

export const EVENTS = {
  ponsLaunched: parseAbiItem(
    "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)",
  ),
  swap: parseAbiItem(
    "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
  ),
  transfer: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
};

const blockTimes = new Map<bigint, number>();
/** Block timestamp in ms (cached). */
export async function blockTimeMs(blockNumber: bigint): Promise<number> {
  const hit = blockTimes.get(blockNumber);
  if (hit) return hit;
  const b = await publicClient.getBlock({ blockNumber });
  const ms = Number(b.timestamp) * 1000;
  blockTimes.set(blockNumber, ms);
  if (blockTimes.size > 5000) blockTimes.delete(blockTimes.keys().next().value!);
  return ms;
}

/** Time of any block inside [from, to], estimated from the two ends. Avoids one RPC call per log. */
export async function blockClock(from: bigint, to: bigint) {
  const [a, b] = await Promise.all([blockTimeMs(from), blockTimeMs(to)]);
  const span = Number(to - from) || 1;
  return (n: bigint) => Math.round(a + ((b - a) * Number(n - from)) / span);
}
