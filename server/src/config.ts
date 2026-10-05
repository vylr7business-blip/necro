import type { Address, Hex } from "viem";

const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
};
const num = (k: string, d: number) => Number(env(k, String(d)));
const flag = (k: string) => /^(1|true|yes|on)$/i.test(env(k, "") ?? "");

export const CONFIG = {
  port: num("PORT", 8787),
  dbPath: env("DB_PATH", "./necro.db")!,
  corsOrigin: env("CORS_ORIGIN", "*")!,

  rpcUrl: env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com")!,
  chainId: 4663,
  explorer: "https://robinhoodchain.blockscout.com",
  blockscoutApi: env("BLOCKSCOUT_API", "https://robinhoodchain.blockscout.com/api/v2")!,

  // The dev wallet. Shown on the site so people can follow the money. The server never holds its key.
  devWallet: env("DEV_WALLET", "0x4d3E32aA053582646Dd2b184c15960710Fb2e025") as Address,

  // $NECRO itself. Before launch voting runs in practice mode (1 wallet = 1 vote).
  necroToken: env("NECRO_TOKEN") as Address | undefined,
  necroStartBlock: BigInt(env("NECRO_START_BLOCK", "0")!),

  // Secret key of the small PUMP wallet (never the dev wallet). The bot buys from this wallet.
  // MetaMask exports the key without "0x", so add it if it's missing.
  pumpKey: (() => {
    const k = (env("PUMP_PRIVATE_KEY") ?? "").trim().replace(/^["']|["']$/g, "");
    if (!k) return undefined;
    const hex = k.startsWith("0x") ? k : `0x${k}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
      console.error("[config] PUMP_PRIVATE_KEY doesn't look like a private key (64 hex characters). The pump bot stays off.");
      return undefined;
    }
    return hex as Hex;
  })(),
  // The bot only sends real transactions when this is on. Everything else (scanner, votes) runs without it.
  pumpsEnabled: flag("PUMPS_ENABLED"),
  // What happens to the coins the bot buys: "burn" (sent to the dead address) or "hold" (stay in the pump wallet).
  afterBuy: (env("AFTER_BUY", "hold") === "burn" ? "burn" : "hold") as "burn" | "hold",

  // Pump size and safety rails
  maxPumpEth: num("MAX_PUMP_ETH", 0.5), // most ETH one hour's pump can spend
  minPumpEth: num("MIN_PUMP_ETH", 0.005), // below this the fund rolls over to the next hour
  dailyPumpCapEth: num("DAILY_PUMP_CAP_ETH", 5),
  gasReserveEth: num("GAS_RESERVE_ETH", 0.003),
  lowBalanceEth: num("LOW_BALANCE_ETH", 0.01),
  maxSlippageBps: num("MAX_SLIPPAGE_BPS", 300), // per buy, against a fresh quote taken right before it
  pumpChunks: num("PUMP_CHUNKS", 5),
  chunkSpacingSec: num("CHUNK_SPACING_SEC", 60),

  // Graveyard rules
  minPeakUsd: num("MIN_PEAK_USD", 10_000), // a coin must have lived a little to get a grave
  minDropPct: num("MIN_DROP_PCT", 90), // down at least this much from its peak
  quietVol24hEth: num("QUIET_VOL_24H_ETH", 0.05), // less trading than this in 24h = quiet
  minDeadDays: num("MIN_DEAD_DAYS", 7), // dead at least this long before it can be revived
  minPoolEth: num("MIN_POOL_ETH", 0.05), // ETH left in the pool, so the buy has somewhere to go
  maxDevPct: num("MAX_DEV_PCT", 2), // the coin's creator must hold less than this % of supply
  cooldownHours: num("COOLDOWN_HOURS", 24), // a winner sits out this long
  ballotSize: num("BALLOT_SIZE", 10),
  voteLockMinute: num("VOTE_LOCK_MINUTE", 50),

  alertWebhook: env("ALERT_WEBHOOK_URL"),
  comingSoon: flag("COMING_SOON"),
};

// Verified on robinhoodchain.blockscout.com and docs.ponsfamily.com (Oct 2026).
export const ADDR = {
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address, // Global Dollar, 6 decimals
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address,
  swapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2" as Address,
  quoterV2: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7" as Address,
  dead: "0x000000000000000000000000000000000000dEaD" as Address,
};

// pons launchpad factories. Every coin launches straight into a locked Uniswap v3 pool (1% fee) paired with WETH.
export const PONS_FACTORIES: Array<{ address: Address; startBlock: bigint; name: string }> = [
  { address: "0x0c37a24F5D23A486FA692d1500881d698B1F77a4", startBlock: 8_600_612n, name: "pons (legacy)" },
  { address: "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB", startBlock: 8_991_118n, name: "pons" },
];
export const PONS_LAUNCH_TOPIC = "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a";
export const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
export const PONS_FEE = 10_000;
