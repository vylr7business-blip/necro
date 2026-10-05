import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { formatEther, isAddress, parseEther, type Address } from "viem";
import { ADDR, CONFIG, PONS_FEE } from "./config.js";
import { publicClient, pumpAccount } from "./chain.js";
import { type DB, getCursor, kvGet } from "./db.js";
import { quoteIn } from "./prices.js";
import { pumpWalletBalance, spentTodayWei } from "./pump.js";
import { VoteError, castVote } from "./rounds.js";
import { pumpBudget } from "./rules.js";
import { RULES } from "./graves.js";
import { coinView, graveyardView, logView, roundView } from "./views.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SESSION_MS = 7 * 24 * 3_600_000;

export function signInMessage(address: string, nonce: string) {
  return `Sign in to Necro\n\nWallet: ${address}\nNonce: ${nonce}\n\nThis only proves you own this wallet. It costs nothing and moves no funds.`;
}

// Tiny per-IP rate limiter: `max` hits per `windowMs`.
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "?";
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
    list.push(now);
    hits.set(key, list);
    if (list.length > max) return res.status(429).json({ error: "too_many_requests", message: "Slow down a little and try again in a minute." });
    next();
  };
}

// Small caches so a busy page doesn't hammer the RPC.
function cached<T>(ms: number, fn: () => Promise<T>) {
  let v: { at: number; val: T } | null = null;
  let inflight: Promise<T> | null = null;
  return async () => {
    if (v && Date.now() - v.at < ms) return v.val;
    inflight ??= fn().then((val) => { v = { at: Date.now(), val }; return val; }).finally(() => { inflight = null; });
    return inflight;
  };
}

export function createApi(db: DB) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "8kb" }));
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", CONFIG.corsOrigin);
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  const sessionAddress = (req: Request) => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return null;
    const row = db.prepare("SELECT address, expires FROM sessions WHERE token_hash = ?").get(sha(token)) as { address: string; expires: number } | undefined;
    return row && row.expires > Date.now() ? row.address : null;
  };
  const auth = (req: Request, res: Response, next: NextFunction) => {
    const a = sessionAddress(req);
    if (!a) return res.status(401).json({ error: "signed_out", message: "Connect your wallet and sign in again." });
    res.locals.address = a;
    next();
  };
  const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
    try { await fn(req, res); }
    catch (e) {
      if (e instanceof VoteError) return res.status(400).json({ error: e.code, message: e.message });
      console.error(e);
      res.status(500).json({ error: "server_error", message: "Something went wrong on our side. Try again in a moment." });
    }
  };

  // What one hour's pump can spend right now (the "pump fund" on the site).
  const fund = cached(30_000, async () => {
    const bal = await pumpWalletBalance().catch(() => null);
    if (!bal) return null;
    const b = pumpBudget({
      balanceWei: bal.eth + bal.weth, reserveWei: parseEther(String(CONFIG.gasReserveEth)), maxWei: parseEther(String(CONFIG.maxPumpEth)),
      spentTodayWei: spentTodayWei(db), dailyCapWei: parseEther(String(CONFIG.dailyPumpCapEth)),
    });
    return Number(formatEther(b));
  });

  // ---------- public ----------
  app.get("/api/config", (_req, res) => {
    res.json({
      chainId: CONFIG.chainId, explorer: CONFIG.explorer,
      devWallet: CONFIG.devWallet, pumpWallet: pumpAccount?.address ?? null, necroToken: CONFIG.necroToken ?? null,
      afterBuy: CONFIG.afterBuy, pumpsEnabled: CONFIG.pumpsEnabled,
      rules: { ...RULES, ballotSize: CONFIG.ballotSize, voteLockMinute: CONFIG.voteLockMinute, pumpChunks: CONFIG.pumpChunks, maxPumpEth: CONFIG.maxPumpEth },
    });
  });

  app.get("/api/round", limiter(120, 60_000), wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(roundView(db, Date.now(), sessionAddress(req) ?? undefined, await fund()));
  }));

  const simCache = new Map<string, { at: number; v: unknown }>();
  app.get("/api/coin/:token", limiter(120, 60_000), wrap(async (req, res) => {
    const token = String(req.params.token).toLowerCase();
    if (!isAddress(token)) return res.status(400).json({ error: "bad_address", message: "That isn't a coin address." });
    const view = coinView(db, token);
    if (!view) return res.status(404).json({ error: "not_found", message: "No grave for that coin. It may still be alive, or it never traded." });
    // "If it wins this hour": quote the current fund into the coin's pool.
    let sim = simCache.get(token);
    if (!sim || Date.now() - sim.at > 120_000) {
      const f = (await fund()) ?? CONFIG.maxPumpEth;
      let v: unknown = null;
      try {
        const amt = parseEther(f.toFixed(6));
        const { out } = await quoteIn(ADDR.weth, token as Address, amt, PONS_FEE);
        const small = await quoteIn(ADDR.weth, token as Address, amt / 1000n || 1n, PONS_FEE);
        // Average price paid vs. the price for a tiny buy. The price after the buy is roughly twice that gap.
        const avgPerToken = Number(amt) / Number(out), spot = Number(amt / 1000n || 1n) / Number(small.out);
        const move = Math.max(0, Math.round(((avgPerToken / spot - 1) * 2) * 100));
        v = { fundEth: f, estMovePct: move, estMcapUsd: view.nowUsd * (1 + move / 100) };
      } catch { v = null; }
      sim = { at: Date.now(), v };
      simCache.set(token, sim);
    }
    res.json({ ...view, sim: sim.v });
  }));

  app.get("/api/graveyard", limiter(120, 60_000), wrap((req, res) => {
    res.json(graveyardView(db, { status: String(req.query.status ?? ""), q: String(req.query.q ?? "").slice(0, 60) }));
  }));

  app.get("/api/log", limiter(120, 60_000), wrap((_req, res) => res.json(logView(db))));

  // Every setting, shown as set or missing. A missing setting is shown as missing, never as green.
  app.get("/api/status", wrap(async (_req, res) => {
    const head = await publicClient.getBlockNumber().catch(() => null);
    const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM coins) AS coins,
      (SELECT COUNT(*) FROM coins WHERE pool_checked_at IS NOT NULL) AS poolsChecked,
      (SELECT COUNT(*) FROM coins WHERE watched = 1) AS poolsWithEth,
      (SELECT COUNT(*) FROM coins WHERE backfill_to IS NOT NULL) AS backfillQueue,
      (SELECT COUNT(*) FROM prices) AS coinsWithTrades,
      (SELECT COUNT(*) FROM graves) AS graves, (SELECT COUNT(*) FROM graves WHERE status='ok') AS revivable`).get();
    res.json({
      rpc: head !== null ? { ok: true, block: head.toString() } : { ok: false, note: "RPC unreachable" },
      settings: {
        NECRO_DEV_WALLET: CONFIG.devWallet,
        NECRO_TOKEN: CONFIG.necroToken ?? "MISSING — $NECRO not launched yet, voting runs in practice mode (1 wallet = 1 vote)",
        PUMP_PRIVATE_KEY: pumpAccount ? `set (wallet ${pumpAccount.address})` : "MISSING — the pump bot is off",
        PUMPS_ENABLED: CONFIG.pumpsEnabled ? "on" : "off — the bot won't send any buys",
        AFTER_BUY: CONFIG.afterBuy === "burn" ? "burn (bought coins go to the dead address)" : "hold (bought coins stay in the pump wallet)",
        ALERT_WEBHOOK_URL: CONFIG.alertWebhook ? "set" : "MISSING — alerts only go to the server log",
        MAX_PUMP_ETH: CONFIG.maxPumpEth, DAILY_PUMP_CAP_ETH: CONFIG.dailyPumpCapEth, MAX_SLIPPAGE_BPS: CONFIG.maxSlippageBps,
      },
      scanner: {
        launches: getCursor(db, "launches")?.toString() ?? null,
        swaps: getCursor(db, "swaps")?.toString() ?? null,
        necro: getCursor(db, "necro")?.toString() ?? null,
        gravesCheckedAt: Number(kvGet(db, "graves_evaluated_at") ?? 0) || null,
        ethUsd: Number(kvGet(db, "eth_usd") ?? 0) || null,
        ...(counts as object),
      },
      fundEth: await fund(),
    });
  }));

  // ---------- sign in with wallet ----------
  app.post("/api/auth/nonce", limiter(20, 60_000), wrap((req, res) => {
    const address = String(req.body?.address ?? "");
    if (!isAddress(address)) return res.status(400).json({ error: "bad_address", message: "That isn't a valid wallet address." });
    const nonce = randomBytes(16).toString("hex");
    db.prepare("DELETE FROM nonces WHERE expires < ?").run(Date.now());
    db.prepare("INSERT INTO nonces (nonce, address, expires) VALUES (?, ?, ?)").run(nonce, address.toLowerCase(), Date.now() + 10 * 60_000);
    res.json({ nonce, message: signInMessage(address, nonce) });
  }));

  app.post("/api/auth/verify", limiter(20, 60_000), wrap(async (req, res) => {
    const { address, nonce, signature } = req.body ?? {};
    if (!isAddress(address) || typeof nonce !== "string" || typeof signature !== "string") {
      return res.status(400).json({ error: "bad_request", message: "Missing address, nonce or signature." });
    }
    const row = db.prepare("SELECT address, expires FROM nonces WHERE nonce = ?").get(nonce) as { address: string; expires: number } | undefined;
    db.prepare("DELETE FROM nonces WHERE nonce = ?").run(nonce); // single use
    if (!row || row.expires < Date.now() || row.address !== address.toLowerCase()) {
      return res.status(400).json({ error: "expired", message: "That sign-in request expired. Try connecting again." });
    }
    const ok = await publicClient.verifyMessage({ address: address as Address, message: signInMessage(address, nonce), signature: signature as `0x${string}` });
    if (!ok) return res.status(401).json({ error: "bad_signature", message: "The signature didn't match this wallet." });
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, address, expires) VALUES (?, ?, ?)").run(sha(token), address.toLowerCase(), Date.now() + SESSION_MS);
    res.json({ token, address: address.toLowerCase(), expiresInMs: SESSION_MS });
  }));

  // ---------- voting ----------
  app.post("/api/vote", auth, limiter(30, 60_000), wrap((req, res) => {
    const token = String(req.body?.token ?? "");
    if (!isAddress(token)) return res.status(400).json({ error: "bad_token", message: "Pick a coin from the ballot." });
    const v = castVote(db, res.locals.address, token);
    res.json({ ok: true, token: v.token, weight: v.weight.toString(), round: roundView(db, Date.now(), res.locals.address) });
  }));

  // The website itself (public/index.html), served from the same address as the API.
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { extensions: ["html"] }));

  return app;
}
