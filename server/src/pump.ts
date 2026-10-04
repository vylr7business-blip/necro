// The pump bot. After each round locks, it spends the pump wallet's ETH on the winning coin,
// in a few small buys a minute apart. Rules: one buy at a time, every tx hash is saved before
// waiting, and after a restart it checks the chain instead of buying again.
import { decodeEventLog, formatEther, parseEther, type Address, type Hex } from "viem";
import { ADDR, CONFIG, PONS_FEE } from "./config.js";
import { ABI, EVENTS, publicClient, pumpAccount, walletClient } from "./chain.js";
import { type DB, tx } from "./db.js";
import { quoteIn } from "./prices.js";
import { alert } from "./alerts.js";
import { HOUR, pumpBudget, roundTimes, splitChunks } from "./rules.js";
import type { Round } from "./rounds.js";

const MAX_ATTEMPTS = 3;
const MISSED_AFTER_MS = 2 * HOUR;
type Leg = { id: number; round_id: number; idx: number; token: string; amount_in: string; due_at: number; status: string; tx_hash: string | null; attempts: number };

const startOfUtcDay = (t = Date.now()) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
export function spentTodayWei(db: DB, now = Date.now()) {
  const rows = db.prepare("SELECT amount_in FROM pump_legs WHERE status = 'done' AND done_at >= ?").all(startOfUtcDay(now)) as Array<{ amount_in: string }>;
  return rows.reduce((a, r) => a + BigInt(r.amount_in), 0n);
}

export async function pumpWalletBalance(): Promise<{ eth: bigint; weth: bigint } | null> {
  if (!pumpAccount) return null;
  const [eth, weth] = await Promise.all([
    publicClient.getBalance({ address: pumpAccount.address }),
    publicClient.readContract({ address: ADDR.weth, abi: ABI.weth, functionName: "balanceOf", args: [pumpAccount.address] }),
  ]);
  return { eth, weth };
}

function skip(db: DB, id: number, note: string) {
  db.prepare("UPDATE rounds SET pump_status = 'skipped', pump_note = ? WHERE id = ? AND pump_status IS NULL").run(note, id);
}

/** Turn locked rounds into a list of buys. */
async function planDue(db: DB, now: number) {
  const due = db.prepare("SELECT * FROM rounds WHERE locked = 1 AND pump_status IS NULL ORDER BY id").all() as Round[];
  for (const r of due) {
    const { pumpsAt } = roundTimes(r.id, CONFIG.voteLockMinute);
    if (now < pumpsAt) continue;
    if (!r.winner) { skip(db, r.id, "No coins on the ballot"); continue; }
    if (now - pumpsAt > MISSED_AFTER_MS) { skip(db, r.id, "Missed while the server was offline. The fund rolls over."); continue; }
    if (!walletClient || !pumpAccount) { skip(db, r.id, "Pump wallet not set up yet"); continue; }
    if (!CONFIG.pumpsEnabled) { skip(db, r.id, "Pumps are switched off"); continue; }
    const bal = await pumpWalletBalance();
    const budget = pumpBudget({
      balanceWei: bal!.eth + bal!.weth, reserveWei: parseEther(String(CONFIG.gasReserveEth)), maxWei: parseEther(String(CONFIG.maxPumpEth)),
      spentTodayWei: spentTodayWei(db, now), dailyCapWei: parseEther(String(CONFIG.dailyPumpCapEth)),
    });
    if (budget < parseEther(String(CONFIG.minPumpEth))) {
      skip(db, r.id, `Fund under ${CONFIG.minPumpEth} ETH. It rolls over to the next hour.`);
      if (bal!.eth < parseEther(String(CONFIG.lowBalanceEth))) await alert("low-balance", `Pump wallet ${pumpAccount.address} is low: ${formatEther(bal!.eth)} ETH. Send fees to it on Robinhood Chain.`);
      continue;
    }
    const chunks = splitChunks(budget, CONFIG.pumpChunks);
    const start = Math.max(now, pumpsAt);
    const pre = db.prepare("SELECT price FROM prices WHERE token = ?").get(r.winner) as { price: number } | undefined;
    tx(db, () => {
      const ins = db.prepare("INSERT OR IGNORE INTO pump_legs (round_id, idx, token, amount_in, due_at) VALUES (?, ?, ?, ?, ?)");
      chunks.forEach((amt, i) => ins.run(r.id, i, r.winner!, amt.toString(), start + i * CONFIG.chunkSpacingSec * 1000));
      db.prepare("UPDATE rounds SET pump_status = 'pending', pre_price = ? WHERE id = ?").run(pre?.price ?? null, r.id);
    });
    console.log(`[pump] round ${r.id}: ${formatEther(budget)} ETH into ${r.winner} over ${chunks.length} buys`);
  }
}

function finishRoundIfDone(db: DB, roundIdN: number) {
  const legs = db.prepare("SELECT status, amount_in, amount_out FROM pump_legs WHERE round_id = ?").all(roundIdN) as Array<{ status: string; amount_in: string; amount_out: string | null }>;
  if (legs.some((l) => l.status === "pending" || l.status === "submitted")) return;
  const done = legs.filter((l) => l.status === "done");
  const spent = done.reduce((a, l) => a + BigInt(l.amount_in), 0n);
  const out = done.reduce((a, l) => a + BigInt(l.amount_out ?? "0"), 0n);
  const status = done.length === legs.length ? "done" : done.length ? "partial" : "skipped";
  db.prepare("UPDATE rounds SET pump_status = ?, eth_spent = ?, tokens_out = ?, pump_note = COALESCE(pump_note, ?) WHERE id = ?")
    .run(status, spent.toString(), out.toString(), status === "skipped" ? "Every buy failed. The ETH stayed in the pump wallet." : null, roundIdN);
}

function failLeg(db: DB, leg: Leg, err: string) {
  const attempts = leg.attempts + 1;
  tx(db, () => {
    db.prepare("UPDATE pump_legs SET status = ?, attempts = ?, last_error = ?, tx_hash = NULL, due_at = ? WHERE id = ?")
      .run(attempts >= MAX_ATTEMPTS ? "failed" : "pending", attempts, err.slice(0, 500), Date.now() + 30_000, leg.id);
    finishRoundIfDone(db, leg.round_id);
  });
  if (attempts >= MAX_ATTEMPTS) void alert(`leg-${leg.id}`, `Pump buy ${leg.idx + 1} for round ${leg.round_id} failed ${attempts} times: ${err}`);
}

async function tokensReceived(hash: Hex, token: string, recipient: string): Promise<bigint> {
  const r = await publicClient.getTransactionReceipt({ hash });
  let sum = 0n;
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== token) continue;
    try {
      const ev = decodeEventLog({ abi: [EVENTS.transfer], data: l.data, topics: l.topics });
      if ((ev.args.to as string).toLowerCase() === recipient.toLowerCase()) sum += ev.args.value as bigint;
    } catch { /* not a transfer */ }
  }
  return sum;
}

const recipient = () => (CONFIG.afterBuy === "burn" ? ADDR.dead : pumpAccount!.address);

/** After a restart: settle any buy that was sent but not confirmed. Never resend blindly. */
async function recoverSubmitted(db: DB) {
  const legs = db.prepare("SELECT * FROM pump_legs WHERE status = 'submitted'").all() as Leg[];
  for (const leg of legs) {
    const r = await publicClient.getTransactionReceipt({ hash: leg.tx_hash as Hex }).catch(() => null);
    if (r) {
      if (r.status === "success") {
        const got = await tokensReceived(leg.tx_hash as Hex, leg.token, recipient());
        tx(db, () => { db.prepare("UPDATE pump_legs SET status = 'done', amount_out = ?, done_at = ? WHERE id = ?").run(got.toString(), Date.now(), leg.id); finishRoundIfDone(db, leg.round_id); });
      } else failLeg(db, leg, "Transaction reverted");
      continue;
    }
    const pending = await publicClient.getTransaction({ hash: leg.tx_hash as Hex }).catch(() => null);
    if (!pending) {
      tx(db, () => {
        db.prepare("UPDATE pump_legs SET status = 'failed', last_error = ? WHERE id = ?").run(`Tx ${leg.tx_hash} not found; check the explorer before retrying`, leg.id);
        finishRoundIfDone(db, leg.round_id);
      });
      void alert(`lost-${leg.id}`, `Pump buy ${leg.tx_hash} disappeared. Check it on the explorer. If it never landed: npm run retry -- ${leg.round_id}`);
    }
  }
}

async function ensureWeth(me: Address, need: bigint): Promise<boolean> {
  const weth = await publicClient.readContract({ address: ADDR.weth, abi: ABI.weth, functionName: "balanceOf", args: [me] });
  if (weth >= need) return true;
  const eth = await publicClient.getBalance({ address: me });
  const wrap = need - weth;
  if (eth < wrap + parseEther(String(CONFIG.gasReserveEth))) {
    await alert("low-balance", `Pump wallet ${me} ran short mid-pump: ${formatEther(eth)} ETH + ${formatEther(weth)} WETH.`);
    return false;
  }
  const hash = await walletClient!.writeContract({ address: ADDR.weth, abi: ABI.weth, functionName: "deposit", value: wrap });
  await publicClient.waitForTransactionReceipt({ hash });
  return true;
}

async function ensureAllowance(me: Address, need: bigint) {
  const cur = await publicClient.readContract({ address: ADDR.weth, abi: ABI.erc20, functionName: "allowance", args: [me, ADDR.swapRouter02] });
  if (cur >= need) return;
  const hash = await walletClient!.writeContract({ address: ADDR.weth, abi: ABI.erc20, functionName: "approve", args: [ADDR.swapRouter02, 2n ** 256n - 1n] });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function buy(db: DB, leg: Leg) {
  const me = pumpAccount!.address;
  const token = leg.token as Address;
  const amountIn = BigInt(leg.amount_in);
  const { out } = await quoteIn(ADDR.weth, token, amountIn, PONS_FEE);
  if (out === 0n) { failLeg(db, leg, "Quote returned zero tokens"); return; }
  const minOut = (out * BigInt(10_000 - CONFIG.maxSlippageBps)) / 10_000n;
  if (!(await ensureWeth(me, amountIn))) { db.prepare("UPDATE pump_legs SET due_at = ? WHERE id = ?").run(Date.now() + 60_000, leg.id); return; }
  await ensureAllowance(me, amountIn);
  const params = { tokenIn: ADDR.weth, tokenOut: token, fee: PONS_FEE, recipient: recipient(), amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n };
  try {
    await publicClient.simulateContract({ account: me, address: ADDR.swapRouter02, abi: ABI.router, functionName: "exactInputSingle", args: [params] });
  } catch (e) { failLeg(db, leg, (e as Error).message.split("\n")[0]); return; }

  const hash = await walletClient!.writeContract({ address: ADDR.swapRouter02, abi: ABI.router, functionName: "exactInputSingle", args: [params] });
  db.prepare("UPDATE pump_legs SET status = 'submitted', tx_hash = ? WHERE id = ?").run(hash, leg.id);
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") { failLeg(db, leg, "Swap reverted"); return; }
  const got = await tokensReceived(hash, leg.token, recipient());
  tx(db, () => {
    db.prepare("UPDATE pump_legs SET status = 'done', amount_out = ?, done_at = ? WHERE id = ?").run(got.toString(), Date.now(), leg.id);
    finishRoundIfDone(db, leg.round_id);
  });
  console.log(`[pump] round ${leg.round_id} buy ${leg.idx + 1}: ${formatEther(amountIn)} ETH → ${leg.token} (${hash})`);
}

export async function pumpOnce(db: DB, now = Date.now()) {
  await planDue(db, now);
  if (!walletClient || !pumpAccount) return;
  await recoverSubmitted(db);
  const leg = db.prepare("SELECT * FROM pump_legs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 1").get(now) as Leg | undefined;
  if (leg) await buy(db, leg);
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
