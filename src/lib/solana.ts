import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

/** Public Solana RPC nodes that answer browser requests, tried in order. */
export const SOLANA_RPCS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

/**
 * Nodes for index and history queries (getProgramAccounts, getTokenAccountsByOwner,
 * getSignaturesForAddress), which publicnode refuses ("Indexed requests require a personal
 * token") or answers with an empty history. api.mainnet-beta refuses requests sent from a
 * web page (HTTP 403 whenever an Origin header is present), so it only helps outside the
 * browser. solanavibestation rate-limits each connection (a browser tab uses one): a burst
 * of about 3 requests, then about 1 per second; a JSON-RPC batch counts as one per call.
 */
export const SOLANA_INDEX_RPCS = ["https://public.rpc.solanavibestation.com", "https://api.mainnet-beta.solana.com"];

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Same as Solana's `PublicKey.findProgramAddressSync`: returns the base58 PDA. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): string {
  const program = base58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), program, PDA_MARKER];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      buf.set(p, o);
      o += p.length;
    }
    const hash = sha256(buf);
    if (!isOnCurve(hash)) return base58.encode(hash);
  }
  throw new Error("no valid program address");
}

export const u16be = (n: number) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
export function u64be(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
}
export const hexBytes = (hex: string) => Uint8Array.from((hex.replace(/^0x/, "").match(/../g) ?? []).map((h) => parseInt(h, 16)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (e: unknown) => /too many|rate|429|limit/i.test(String((e as Error)?.message ?? e));

/** Retries a Solana call a few times when the public nodes rate-limit us. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 4 || !isRateLimit(e)) throw e;
      await sleep(2000 * 2 ** attempt + Math.random() * 1000);
    }
  }
}

export const rpc = <T>(method: string, params: unknown[], urls = SOLANA_RPCS) => withRetry(() => rpcOnce<T>(method, params, urls));

async function rpcOnce<T>(method: string, params: unknown[], urls: string[]): Promise<T> {
  let last: unknown;
  let limited: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) throw new Error("HTTP 429 Too Many Requests");
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error || json.result === undefined) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      return json.result;
    } catch (e) {
      last = e;
      if (!limited && isRateLimit(e)) limited = e;
    }
  }
  // A node that only rate-limited us is worth waiting for (withRetry), even if the next one refused outright.
  throw new Error(`Solana RPC: ${((limited ?? last) as Error)?.message ?? "unavailable"}`);
}

/** Which of these accounts exist on Solana (batched, 100 per request). */
export async function accountsExist(pubkeys: string[]): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const chunk = pubkeys.slice(i, i + 100);
    const r = await rpc<{ value: (unknown | null)[] }>("getMultipleAccounts", [
      chunk,
      { encoding: "base64", dataSlice: { offset: 0, length: 0 } },
    ]);
    out.push(...r.value.map((v) => v !== null));
  }
  return out;
}

/** Raw data of these accounts (null when the account doesn't exist), batched. */
export async function accountsData(pubkeys: string[]): Promise<(Uint8Array | null)[]> {
  const out: (Uint8Array | null)[] = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const r = await rpc<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [
      pubkeys.slice(i, i + 100),
      { encoding: "base64" },
    ]);
    out.push(...r.value.map((v) => (v ? Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0)) : null)));
  }
  return out;
}

/** Several calls in one JSON-RPC batch request; results in the same order. */
export const rpcBatch = <T>(calls: { method: string; params: unknown[] }[]) => withRetry(() => rpcBatchOnce<T>(calls));

async function rpcBatchOnce<T>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> {
  let last: unknown;
  for (const url of SOLANA_RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: "2.0", id, ...c }))),
        signal: AbortSignal.timeout(30_000),
      });
      const replies = (await res.json()) as { id: number; result?: T; error?: { message?: string } }[];
      if (!Array.isArray(replies)) throw new Error(`HTTP ${res.status}`);
      const errors = replies.filter((r) => r.error);
      if (errors.length) throw new Error(errors[0].error?.message ?? "error");
      const out: (T | null)[] = new Array(calls.length).fill(null);
      for (const r of replies) out[r.id] = r.result ?? null;
      return out;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Solana RPC: ${(last as Error)?.message ?? "unavailable"}`);
}

/** A base58 string that decodes to 32 bytes (a Solana public key). */
export function isSolanaAddress(s: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try {
    return base58.decode(s).length === 32;
  } catch {
    return false;
  }
}

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** The owner's associated token account for `mint`. */
export const associatedTokenAddress = (owner: string, mint: string) =>
  findProgramAddress([base58.decode(owner), base58.decode(TOKEN_PROGRAM), base58.decode(mint)], ATA_PROGRAM);
