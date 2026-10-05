// Small Solana helpers with no dependencies: JSON-RPC, base58, ed25519 signature checks, token balances, SOL price.
import { createPublicKey, verify } from "node:crypto";
import { CONFIG, SOL_MINT } from "./config.js";

let id = 0;
export async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(CONFIG.rpcUrl, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 429) throw new Error("RPC rate limited");
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result as T;
}

const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHA.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
export function b58encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) + BigInt(x);
  let s = "";
  while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x === 0) s = "1" + s; else break; }
  return s;
}
export function isAddress(s: unknown): s is string {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try { return b58decode(s).length === 32; } catch { return false; }
}

/** Check a wallet's signature over a message (Phantom / Solflare signMessage). */
export function verifySignature(address: string, message: string, signatureB58: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(b58decode(address))]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(b58decode(signatureB58)));
  } catch { return false; }
}

/** Raw token balance (base units) a wallet holds of a mint, across all its token accounts (both token programs). */
export async function tokenBalance(owner: string, mint: string): Promise<bigint> {
  const res = await rpc<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> }>(
    "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  return res.value.reduce((a, v) => a + BigInt(v.account.data.parsed.info.tokenAmount.amount), 0n);
}

export async function tokenSupply(mint: string): Promise<{ amount: bigint; decimals: number }> {
  const r = await rpc<{ value: { amount: string; decimals: number } }>("getTokenSupply", [mint]);
  return { amount: BigInt(r.value.amount), decimals: r.value.decimals };
}

export async function solBalance(owner: string): Promise<bigint> {
  return BigInt((await rpc<{ value: number }>("getBalance", [owner, { commitment: "confirmed" }])).value);
}

let solCache: { v: number; at: number } | null = null;
/** USD price of 1 SOL (cached 2 minutes). */
export async function solUsd(): Promise<number> {
  if (solCache && Date.now() - solCache.at < 120_000) return solCache.v;
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, { signal: AbortSignal.timeout(10_000) });
  const j = (await r.json()) as Record<string, { usdPrice: number }>;
  const v = j[SOL_MINT]?.usdPrice;
  if (!v) throw new Error("no SOL price");
  solCache = { v, at: Date.now() };
  return v;
}
