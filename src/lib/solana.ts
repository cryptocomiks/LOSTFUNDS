import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

/** Public Solana RPC nodes that answer browser requests, tried in order. */
export const SOLANA_RPCS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

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

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  let last: unknown;
  for (const url of SOLANA_RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as { result?: T; error?: { message?: string } };
      if (json.error || json.result === undefined) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      return json.result;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`Solana RPC: ${(last as Error)?.message ?? "unavailable"}`);
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
