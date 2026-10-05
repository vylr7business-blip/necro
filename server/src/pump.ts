// The pump bot. After each round locks, it spends the pump wallet's SOL on the winning coin through Jupiter,
// in a few small buys a minute apart, then burns everything it bought (AFTER_BUY=burn).
// Rules: one buy at a time, every signature is saved before sending, and after a restart it checks the chain
// instead of buying again. On Solana a transaction that isn't found after its blockhash expires never landed,
// so a lost buy can be retried safely.
import { CONFIG, SOL_MINT } from "./config.js";
import { type DB, tx } from "./db.js";
import { alert } from "./alerts.js";
import { b58decode, b58encode, rpc, solBalance } from "./solana.js";
import { HOUR, pumpBudget, roundTimes, splitChunks } from "./rules.js";
import type { Round } from "./rounds.js";

const JUP = "https://lite-api.jup.ag/swap/v1";
const MAX_ATTEMPTS = 3;
const MISSED_AFTER_MS = 2 * HOUR;
const LAMPORTS = 1_000_000_000;
type Leg = { id: number; round_id: number; idx: number; mint: string; lamports: string; due_at: number; status: string; sig: string | null; attempts: number; done_at: number | null };

// @solana/web3.js and @solana/spl-token load only when the bot actually needs to sign.
type Web3 = typeof import("@solana/web3.js");
let web3: Web3 | null = null;
let kp: import("@solana/web3.js").Keypair | null = null;
async function wallet() {
  if (!CONFIG.pumpKey) return null;
  if (!web3) web3 = await import("@solana/web3.js");
  if (!kp) {
    const k = CONFIG.pumpKey.trim();
    const bytes = k.startsWith("[") ? Uint8Array.from(JSON.parse(k) as number[]) : b58decode(k);
    kp = web3.Keypair.fromSecretKey(bytes);
  }
  return { web3, kp };
}
export async function pumpAddress(): Promise<string | null> {
  try { return (await wallet())?.kp.publicKey.toBase58() ?? null; } catch (e) { console.error("[pump] bad PUMP_PRIVATE_KEY:", (e as Error).message); return null; }
}

const startOfUtcDay = (t = Date.now()) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
export function spentTodayLamports(db: DB, now = Date.now()) {
  return (db.prepare("SELECT lamports FROM pump_legs WHERE status = 'done' AND done_at >= ?").all(startOfUtcDay(now)) as Array<{ lamports: string }>)
    .reduce((a, r) => a + BigInt(r.lamports), 0n);
}
const sol = (x: number) => BigInt(Math.round(x * LAMPORTS));

export async function fundLamports(db: DB): Promise<bigint | null> {
  const me = await pumpAddress();
  if (!me) return null;
  const bal = await solBalance(me);
  return pumpBudget({ balanceWei: bal, reserveWei: sol(CONFIG.solReserve), maxWei: sol(CONFIG.maxPumpSol), spentTodayWei: spentTodayLamports(db), dailyCapWei: sol(CONFIG.dailyPumpCapSol) });
}

function skip(db: DB, id: number, note: string) {
  db.prepare("UPDATE rounds SET pump_status = 'skipped', pump_note = ? WHERE id = ? AND pump_status IS NULL").run(note, id);
}

async function planDue(db: DB, now: number) {
  const due = db.prepare("SELECT * FROM rounds WHERE locked = 1 AND pump_status IS NULL ORDER BY id").all() as Round[];
  for (const r of due) {
    const { pumpsAt } = roundTimes(r.id, CONFIG.voteLockMinute);
    if (now < pumpsAt) continue;
    if (!r.winner) { skip(db, r.id, "No coins on the ballot"); continue; }
    if (now - pumpsAt > MISSED_AFTER_MS) { skip(db, r.id, "Missed while the server was offline. The fund rolls over."); continue; }
    if (!CONFIG.pumpKey) { skip(db, r.id, "Pump wallet not set up yet"); continue; }
    if (!CONFIG.pumpsEnabled) { skip(db, r.id, "Pumps are switched off"); continue; }
    if (r.practice) { skip(db, r.id, "Practice round: no pump until $AFTER is live"); continue; }
    const budget = (await fundLamports(db)) ?? 0n;
    if (budget < sol(CONFIG.minPumpSol)) {
      skip(db, r.id, `Fund under ${CONFIG.minPumpSol} SOL. It rolls over to the next hour.`);
      await alert("low-balance", `The pump wallet is low. Send creator fees (SOL) to ${await pumpAddress()}.`);
      continue;
    }
    const chunks = splitChunks(budget, CONFIG.pumpChunks);
    const start = Math.max(now, pumpsAt);
    const pre = (db.prepare("SELECT mcap_usd FROM market WHERE mint = ?").get(r.winner) as { mcap_usd: number | null } | undefined)?.mcap_usd ?? null;
    tx(db, () => {
      const ins = db.prepare("INSERT OR IGNORE INTO pump_legs (round_id, idx, mint, lamports, due_at) VALUES (?, ?, ?, ?, ?)");
      chunks.forEach((amt, i) => ins.run(r.id, i, r.winner!, amt.toString(), start + i * CONFIG.chunkSpacingSec * 1000));
      db.prepare("UPDATE rounds SET pump_status = 'pending', pre_usd = ? WHERE id = ?").run(pre, r.id);
    });
    console.log(`[pump] round ${r.id}: ${Number(budget) / LAMPORTS} SOL into ${r.winner} over ${chunks.length} buys`);
  }
}

function finishRoundIfDone(db: DB, rid: number) {
  const legs = db.prepare("SELECT status, lamports, amount_out FROM pump_legs WHERE round_id = ?").all(rid) as Array<{ status: string; lamports: string; amount_out: string | null }>;
  if (legs.some((l) => l.status === "pending" || l.status === "submitted")) return;
  const done = legs.filter((l) => l.status === "done");
  const spent = done.reduce((a, l) => a + BigInt(l.lamports), 0n);
  const out = done.reduce((a, l) => a + BigInt(l.amount_out ?? "0"), 0n);
  const status = done.length === legs.length ? "done" : done.length ? "partial" : "skipped";
  db.prepare("UPDATE rounds SET pump_status = ?, sol_spent = ?, tokens_out = ?, pump_note = COALESCE(pump_note, ?) WHERE id = ?")
    .run(status, spent.toString(), out.toString(), status === "skipped" ? "Every buy failed. The SOL stayed in the pump wallet." : null, rid);
}

function failLeg(db: DB, leg: Leg, err: string) {
  const attempts = leg.attempts + 1;
  tx(db, () => {
    db.prepare("UPDATE pump_legs SET status = ?, attempts = ?, last_error = ?, sig = NULL, due_at = ? WHERE id = ?")
      .run(attempts >= MAX_ATTEMPTS ? "failed" : "pending", attempts, err.slice(0, 500), Date.now() + 30_000, leg.id);
    finishRoundIfDone(db, leg.round_id);
  });
  if (attempts >= MAX_ATTEMPTS) void alert(`leg-${leg.id}`, `Buy ${leg.idx + 1} for round ${leg.round_id} failed ${attempts} times: ${err}`);
}

type TxMeta = { meta: { err: unknown; preTokenBalances?: Bal[]; postTokenBalances?: Bal[] } | null } | null;
type Bal = { mint: string; owner?: string; uiTokenAmount: { amount: string } };
async function received(sig: string, mint: string, owner: string): Promise<bigint> {
  const t = await rpc<TxMeta>("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  const sum = (b?: Bal[]) => (b ?? []).filter((x) => x.mint === mint && x.owner === owner).reduce((a, x) => a + BigInt(x.uiTokenAmount.amount), 0n);
  return sum(t?.meta?.postTokenBalances) - sum(t?.meta?.preTokenBalances);
}

async function status(sig: string): Promise<"ok" | "err" | "pending" | "unknown"> {
  const r = await rpc<{ value: Array<{ err: unknown; confirmationStatus: string | null } | null> }>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
  const s = r.value[0];
  if (!s) return "unknown";
  if (s.err) return "err";
  return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "ok" : "pending";
}

/** After a restart: settle buys that were sent but not confirmed. */
async function recoverSubmitted(db: DB) {
  const legs = db.prepare("SELECT * FROM pump_legs WHERE status = 'submitted'").all() as Leg[];
  const me = await pumpAddress();
  for (const leg of legs) {
    const st = await status(leg.sig!);
    if (st === "ok") {
      const got = await received(leg.sig!, leg.mint, me!).catch(() => 0n);
      tx(db, () => { db.prepare("UPDATE pump_legs SET status = 'done', amount_out = ?, done_at = ? WHERE id = ?").run(got.toString(), Date.now(), leg.id); finishRoundIfDone(db, leg.round_id); });
    } else if (st === "err") failLeg(db, leg, "Transaction failed on-chain");
    else if (st === "unknown" && Date.now() - leg.due_at > 3 * 60_000) {
      // Never landed and its blockhash has expired, so it can't land later: safe to try again.
      db.prepare("UPDATE pump_legs SET status = 'pending', sig = NULL WHERE id = ?").run(leg.id);
    }
  }
}

async function buy(db: DB, leg: Leg) {
  const w = (await wallet())!;
  const me = w.kp.publicKey.toBase58();
  const q = await fetch(`${JUP}/quote?inputMint=${SOL_MINT}&outputMint=${leg.mint}&amount=${leg.lamports}&slippageBps=${CONFIG.maxSlippageBps}&restrictIntermediateTokens=true`, { signal: AbortSignal.timeout(15_000) });
  const quote = await q.json() as { outAmount?: string; error?: string };
  if (!q.ok || !quote.outAmount) { failLeg(db, leg, `No route: ${quote.error ?? q.status}`); return; }
  const s = await fetch(`${JUP}/swap`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: me, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "high" } } }),
  });
  const sw = await s.json() as { swapTransaction?: string; error?: string };
  if (!sw.swapTransaction) { failLeg(db, leg, `Swap build failed: ${sw.error ?? s.status}`); return; }
  const t = w.web3.VersionedTransaction.deserialize(Buffer.from(sw.swapTransaction, "base64"));
  t.sign([w.kp]);
  const sig = b58encode(t.signatures[0]);
  // Save the signature first, then send.
  db.prepare("UPDATE pump_legs SET status = 'submitted', sig = ?, due_at = ? WHERE id = ?").run(sig, Date.now(), leg.id);
  try {
    await rpc("sendTransaction", [Buffer.from(t.serialize()).toString("base64"), { encoding: "base64", maxRetries: 5, preflightCommitment: "confirmed" }]);
  } catch (e) { failLeg(db, leg, (e as Error).message.split("\n")[0]); return; }
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await status(sig).catch(() => "pending" as const);
    if (st === "err") { failLeg(db, leg, "Swap failed on-chain"); return; }
    if (st === "ok") {
      const got = await received(sig, leg.mint, me).catch(() => 0n);
      tx(db, () => { db.prepare("UPDATE pump_legs SET status = 'done', amount_out = ?, done_at = ? WHERE id = ?").run(got.toString(), Date.now(), leg.id); finishRoundIfDone(db, leg.round_id); });
      console.log(`[pump] round ${leg.round_id} buy ${leg.idx + 1}: ${Number(leg.lamports) / LAMPORTS} SOL → ${leg.mint} (${sig})`);
      return;
    }
  }
  // Still unconfirmed: recoverSubmitted settles it on a later pass.
}

/** Burn everything the pump wallet holds of a coin, on-chain. */
async function burnAll(db: DB, r: Round) {
  const w = (await wallet())!;
  const { web3: W } = w;
  const spl = await import("@solana/spl-token");
  const accts = await rpc<{ value: Array<{ pubkey: string; account: { owner: string; data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } } } }> }>(
    "getTokenAccountsByOwner", [w.kp.publicKey.toBase58(), { mint: r.winner }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const ixs = accts.value.filter((a) => BigInt(a.account.data.parsed.info.tokenAmount.amount) > 0n).map((a) =>
    spl.createBurnCheckedInstruction(new W.PublicKey(a.pubkey), new W.PublicKey(r.winner!), w.kp.publicKey,
      BigInt(a.account.data.parsed.info.tokenAmount.amount), a.account.data.parsed.info.tokenAmount.decimals, [], new W.PublicKey(a.account.owner)));
  if (!ixs.length) { db.prepare("UPDATE rounds SET burn_sig = 'none' WHERE id = ?").run(r.id); return; }
  const { blockhash } = (await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  const t = new W.Transaction({ feePayer: w.kp.publicKey, recentBlockhash: blockhash }).add(...ixs);
  t.sign(w.kp);
  const sig = b58encode(t.signature!);
  await rpc("sendTransaction", [t.serialize().toString("base64"), { encoding: "base64", maxRetries: 5 }]);
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const st = await status(sig).catch(() => "pending" as const);
    if (st === "ok") { db.prepare("UPDATE rounds SET burn_sig = ? WHERE id = ?").run(sig, r.id); console.log(`[pump] round ${r.id}: burned (${sig})`); return; }
    if (st === "err") throw new Error("Burn failed on-chain");
  }
}

export async function pumpOnce(db: DB, now = Date.now()) {
  await planDue(db, now);
  if (!CONFIG.pumpKey || !(await wallet())) return;
  await recoverSubmitted(db);
  const leg = db.prepare("SELECT * FROM pump_legs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 1").get(now) as Leg | undefined;
  if (leg) { await buy(db, leg); return; }
  if (CONFIG.afterBuy === "burn") {
    const r = db.prepare("SELECT * FROM rounds WHERE pump_status IN ('done','partial') AND burn_sig IS NULL ORDER BY id LIMIT 1").get() as Round | undefined;
    if (r) await burnAll(db, r).catch((e) => alert(`burn-${r.id}`, `Burn for round ${r.id} failed: ${(e as Error).message}. It will retry.`));
  }
}

export function startPump(db: DB, everyMs = 10_000) {
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try { await pumpOnce(db); }
    catch (e) { await alert("pump-loop", `Pump bot error: ${(e as Error).message.split("\n")[0]}`); }
    finally { running = false; }
  };
  void loop();
  return setInterval(loop, everyMs);
}
