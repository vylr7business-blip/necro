import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { CONFIG } from "./config.js";
import { type DB, kvGet } from "./db.js";
import { isAddress, solBalance, tokenBalance, verifySignature } from "./solana.js";
import { fundLamports, pumpAddress } from "./pump.js";
import { VoteError, castVote } from "./rounds.js";
import { RULES } from "./graves.js";
import { coinView, graveyardView, logView, roundView } from "./views.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SESSION_MS = 7 * 24 * 3_600_000;

export function signInMessage(address: string, nonce: string) {
  return `Sign in to Afterlife\n\nWallet: ${address}\nNonce: ${nonce}\n\nThis only proves you own this wallet. It costs nothing and moves no funds.`;
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

  // What one hour's pump can spend right now (the "pump fund" on the site), in SOL.
  const fund = cached(30_000, async () => {
    const l = await fundLamports(db).catch(() => null);
    return l === null ? null : Number(l) / 1e9;
  });

  // ---------- public ----------
  app.get("/api/config", wrap(async (_req, res) => {
    res.json({
      chain: "solana", explorer: CONFIG.explorer,
      devWallet: CONFIG.devWallet || null, pumpWallet: await pumpAddress(), afterMint: CONFIG.afterMint ?? null,
      afterBuy: CONFIG.afterBuy, pumpsEnabled: CONFIG.pumpsEnabled,
      rules: { ...RULES, ballotSize: CONFIG.ballotSize, voteLockMinute: CONFIG.voteLockMinute, pumpChunks: CONFIG.pumpChunks, maxPumpSol: CONFIG.maxPumpSol },
    });
  }));

  app.get("/api/round", limiter(120, 60_000), wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(roundView(db, Date.now(), sessionAddress(req) ?? undefined, await fund()));
  }));

  // Daily chart for a coin page, from GeckoTerminal (cached 6 hours per pool).
  const charts = new Map<string, { at: number; v: Array<{ t: number; usd: number }> }>();
  async function chart(pool: string | null, supplyMcap: (p: number) => number) {
    if (!pool) return [];
    const hit = charts.get(pool);
    if (hit && Date.now() - hit.at < 6 * 3_600_000) return hit.v;
    try {
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/day?limit=200&currency=usd`, { signal: AbortSignal.timeout(10_000) });
      const j = (await r.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
      const v = (j.data?.attributes?.ohlcv_list ?? []).map((x) => ({ t: x[0] * 1000, usd: supplyMcap(x[4]) })).reverse();
      charts.set(pool, { at: Date.now(), v });
      return v;
    } catch { return []; }
  }

  app.get("/api/coin/:mint", limiter(120, 60_000), wrap(async (req, res) => {
    const mint = String(req.params.mint);
    if (!isAddress(mint)) return res.status(400).json({ error: "bad_address", message: "That isn't a coin address." });
    const view = coinView(db, mint);
    if (!view) return res.status(404).json({ error: "not_found", message: "No grave for that coin. It may still be alive, or it never bonded." });
    // pump.fun coins have 1B supply, so market cap = price x 1e9.
    const history = await chart(view.pool, (p) => p * 1e9);
    const f = await fund();
    const sim = f && view.poolSol ? { fundSol: f, estMovePct: Math.round(((1 + f / view.poolSol) ** 2 - 1) * 100), estMcapUsd: view.nowUsd * (1 + f / view.poolSol) ** 2 } : null;
    res.json({ ...view, history, sim });
  }));

  app.get("/api/graveyard", limiter(120, 60_000), wrap((req, res) => {
    res.json(graveyardView(db, { status: String(req.query.status ?? ""), q: String(req.query.q ?? "").slice(0, 60) }));
  }));

  app.get("/api/log", limiter(120, 60_000), wrap((_req, res) => res.json(logView(db))));

  // Every setting, shown as set or missing. A missing setting is shown as missing, never as green.
  app.get("/api/status", wrap(async (_req, res) => {
    const slot = await fetch(CONFIG.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }) })
      .then((r) => r.json()).then((j: { result?: number }) => j.result ?? null).catch(() => null);
    const me = await pumpAddress();
    const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM coins) AS bondedCoins, (SELECT COUNT(*) FROM market) AS marketChecked,
      (SELECT COUNT(*) FROM graves) AS graves, (SELECT COUNT(*) FROM graves WHERE status='ok') AS revivable`).get();
    res.json({
      rpc: slot !== null ? { ok: true, slot } : { ok: false, note: "Solana RPC unreachable" },
      settings: {
        SOLANA_RPC_URL: /api-key|api_key|helius/i.test(CONFIG.rpcUrl) ? "set (private RPC)" : "public RPC — set a Helius URL, the public one throttles",
        DEV_WALLET: CONFIG.devWallet || "MISSING — the wallet that launches $AFTER",
        AFTER_MINT: CONFIG.afterMint ?? "MISSING — $AFTER not launched yet, voting runs in practice mode (1 wallet = 1 vote)",
        PUMP_PRIVATE_KEY: me ? `set (wallet ${me})` : "MISSING — the pump bot is off",
        PUMPS_ENABLED: CONFIG.pumpsEnabled ? "on" : "off — the bot won't send any buys",
        AFTER_BUY: CONFIG.afterBuy === "burn" ? "burn (bought coins are burned on-chain)" : "hold (bought coins stay in the pump wallet)",
        ALERT_WEBHOOK_URL: CONFIG.alertWebhook ? "set" : "MISSING — alerts only go to the server log",
        MAX_PUMP_SOL: CONFIG.maxPumpSol, DAILY_PUMP_CAP_SOL: CONFIG.dailyPumpCapSol, MAX_SLIPPAGE_BPS: CONFIG.maxSlippageBps,
      },
      data: { ...(counts as object), pumpfunSyncedAt: Number(kvGet(db, "pumpfun_synced_at") ?? 0) || null, gravesCheckedAt: Number(kvGet(db, "graves_evaluated_at") ?? 0) || null, solUsd: Number(kvGet(db, "sol_usd") ?? 0) || null },
      pumpWalletSol: me ? Number(await solBalance(me).catch(() => 0n)) / 1e9 : null,
      fundSol: await fund(),
    });
  }));

  // ---------- sign in with wallet ----------
  app.post("/api/auth/nonce", limiter(20, 60_000), wrap((req, res) => {
    const address = String(req.body?.address ?? "");
    if (!isAddress(address)) return res.status(400).json({ error: "bad_address", message: "That isn't a valid Solana wallet address." });
    const nonce = randomBytes(16).toString("hex");
    db.prepare("DELETE FROM nonces WHERE expires < ?").run(Date.now());
    db.prepare("INSERT INTO nonces (nonce, address, expires) VALUES (?, ?, ?)").run(nonce, address, Date.now() + 10 * 60_000);
    res.json({ nonce, message: signInMessage(address, nonce) });
  }));

  app.post("/api/auth/verify", limiter(20, 60_000), wrap((req, res) => {
    const { address, nonce, signature } = req.body ?? {};
    if (!isAddress(address) || typeof nonce !== "string" || typeof signature !== "string") {
      return res.status(400).json({ error: "bad_request", message: "Missing address, nonce or signature." });
    }
    const row = db.prepare("SELECT address, expires FROM nonces WHERE nonce = ?").get(nonce) as { address: string; expires: number } | undefined;
    db.prepare("DELETE FROM nonces WHERE nonce = ?").run(nonce); // single use
    if (!row || row.expires < Date.now() || row.address !== address) {
      return res.status(400).json({ error: "expired", message: "That sign-in request expired. Try connecting again." });
    }
    if (!verifySignature(address, signInMessage(address, nonce), signature)) return res.status(401).json({ error: "bad_signature", message: "The signature didn't match this wallet." });
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token_hash, address, expires) VALUES (?, ?, ?)").run(sha(token), address, Date.now() + SESSION_MS);
    res.json({ token, address, expiresInMs: SESSION_MS });
  }));

  // ---------- voting ----------
  const weightOf = (a: string) => (CONFIG.afterMint ? tokenBalance(a, CONFIG.afterMint) : Promise.resolve(1n));
  app.post("/api/vote", auth, limiter(30, 60_000), wrap(async (req, res) => {
    const mint = String(req.body?.token ?? "");
    if (!isAddress(mint)) return res.status(400).json({ error: "bad_token", message: "Pick a coin from the ballot." });
    const v = await castVote(db, res.locals.address, mint, weightOf);
    res.json({ ok: true, token: v.mint, weight: v.weight.toString(), round: roundView(db, Date.now(), res.locals.address) });
  }));

  // The website itself (public/index.html), served from the same address as the API.
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { extensions: ["html"] }));

  return app;
}
