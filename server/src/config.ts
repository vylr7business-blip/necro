const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
};
const num = (k: string, d: number) => Number(env(k, String(d)));
const flag = (k: string) => /^(1|true|yes|on)$/i.test(env(k, "") ?? "");

export const CONFIG = {
  port: num("PORT", 8787),
  dbPath: env("DB_PATH", "./afterlife.db")!,
  corsOrigin: env("CORS_ORIGIN", "*")!,

  // A Solana RPC that can take some traffic (e.g. Helius). The public endpoint throttles hard.
  rpcUrl: env("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")!,
  explorer: "https://solscan.io",

  // The Afterlife dev wallet: launches $AFTER on pump.fun and collects its creator fees. Shown on the site. Its key never lives here.
  devWallet: env("DEV_WALLET", "") ?? "",
  // $AFTER mint. Until it's set, voting runs in practice mode (1 wallet = 1 vote).
  afterMint: env("AFTER_MINT"),

  // Secret key of the small PUMP wallet (base58 or a JSON byte array). Never the dev wallet.
  pumpKey: env("PUMP_PRIVATE_KEY"),
  pumpsEnabled: flag("PUMPS_ENABLED"),
  // After the buys: "burn" destroys the bought tokens on-chain, "hold" keeps them in the pump wallet.
  afterBuy: (env("AFTER_BUY", "burn") === "hold" ? "hold" : "burn") as "burn" | "hold",

  maxPumpSol: num("MAX_PUMP_SOL", 2),
  minPumpSol: num("MIN_PUMP_SOL", 0.02),
  dailyPumpCapSol: num("DAILY_PUMP_CAP_SOL", 20),
  solReserve: num("SOL_RESERVE", 0.02), // always left for fees and account rent
  lowBalanceSol: num("LOW_BALANCE_SOL", 0.05),
  maxSlippageBps: num("MAX_SLIPPAGE_BPS", 300),
  pumpChunks: num("PUMP_CHUNKS", 5),
  chunkSpacingSec: num("CHUNK_SPACING_SEC", 60),

  // Graveyard rules (pump.fun coins that bonded, then died)
  minAthUsd: num("MIN_ATH_USD", 60_000),
  maxAthUsd: num("MAX_ATH_USD", 2_000_000_000), // anything above this is a bad data point
  minDropPct: num("MIN_DROP_PCT", 90),
  quietVol24hUsd: num("QUIET_VOL_24H_USD", 2_000),
  minDeadDays: num("MIN_DEAD_DAYS", 7),
  minPoolSol: num("MIN_POOL_SOL", 1),
  maxDevPct: num("MAX_DEV_PCT", 2),
  cooldownHours: num("COOLDOWN_HOURS", 24),
  ballotSize: num("BALLOT_SIZE", 10),
  voteLockMinute: num("VOTE_LOCK_MINUTE", 50),

  alertWebhook: env("ALERT_WEBHOOK_URL"),
};

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const PUMP_API = "https://frontend-api-v3.pump.fun";
