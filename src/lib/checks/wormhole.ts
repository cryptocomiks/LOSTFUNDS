import { getAddress, isAddressEqual, keccak256, parseAbi, toHex, zeroAddress, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { base58 } from "@scure/base";
import { accountsExist, findProgramAddress, hexBytes, u16be, u64be } from "../solana";
import { tokenMeta } from "../tokens";
import type { Asset } from "../types";
import { DAY, makeFinding, now, type CheckOutput, type FindingSource } from "./common";

/**
 * Wormhole Token Bridge ("Portal") transfers between Solana and Ethereum that were
 * signed by the guardians but never redeemed on the destination chain.
 *
 * Wormholescan only helps us *find* the user's transfers: its destination status is
 * unreliable (it often reports nothing for transfers that were redeemed). Every
 * transfer is therefore decoded from its signed VAA and checked on-chain:
 *   - to Ethereum: TokenBridge.isTransferCompleted(vaaHash)
 *   - to Solana:   existence of the transfer's claim account (PDA)
 */

export const WORMHOLE: FindingSource = { id: "wormhole", name: "Wormhole", guideId: "wormhole" };

const API = "https://api.wormholescan.io/api/v1";
const SOLANA = 1;
const ETHEREUM = 2;
const TOKEN_BRIDGE_ETH: Address = "0x3ee18B2214AFF97000D974cf647E7C347E8fa585";
const TOKEN_BRIDGE_SOL = "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb";
/** Emitter addresses of the two official Token Bridges (32-byte, hex). */
const EMITTERS: Record<number, string> = {
  [SOLANA]: "ec7372995d5cc8732397fb0ad35c0121e0eaa90d26f828a534cab54391b3a4f5",
  [ETHEREUM]: "0000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585",
};

const tokenBridgeAbi = parseAbi([
  "function isTransferCompleted(bytes32 hash) view returns (bool)",
  "function wrappedAsset(uint16 tokenChainId, bytes32 tokenAddress) view returns (address)",
]);

export interface Transfer {
  emitterChain: number;
  emitterAddress: string;
  sequence: bigint;
  /** keccak256(keccak256(body)): the key the Token Bridge marks as completed. */
  hash: Hex;
  amount: bigint; // normalized to at most 8 decimals
  tokenAddress: Hex; // 32 bytes
  tokenChain: number;
  to: Hex; // 32 bytes
  toChain: number;
}

const hex = (b: Uint8Array) => toHex(b);
const readUint = (b: Uint8Array, off: number, len: number) => {
  let n = 0n;
  for (let i = 0; i < len; i++) n = (n << 8n) | BigInt(b[off + i]);
  return n;
};

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decodes a signed VAA carrying a Token Bridge transfer (payload 1 or 3). */
export function decodeTransferVaa(vaaBase64: string): Transfer | null {
  let raw: Uint8Array;
  try {
    raw = fromBase64(vaaBase64);
  } catch {
    return null;
  }
  if (raw.length < 6 || raw[0] !== 1) return null;
  const body = raw.subarray(6 + raw[5] * 66);
  // 51 bytes of header + 133 bytes of transfer payload at least
  if (body.length < 51 + 133) return null;
  // body: timestamp(4) nonce(4) emitterChain(2) emitterAddress(32) sequence(8) consistency(1) payload
  const emitterChain = Number(readUint(body, 8, 2));
  const emitterAddress = toHex(body.subarray(10, 42)).slice(2);
  const sequence = readUint(body, 42, 8);
  const p = body.subarray(51);
  if (p[0] !== 1 && p[0] !== 3) return null;
  return {
    emitterChain,
    emitterAddress,
    sequence,
    hash: keccak256(keccak256(toHex(body))),
    amount: readUint(p, 1, 32),
    tokenAddress: hex(p.subarray(33, 65)),
    tokenChain: Number(readUint(p, 65, 2)),
    to: hex(p.subarray(67, 99)),
    toChain: Number(readUint(p, 99, 2)),
  };
}

interface Found {
  id: string; // chain/emitter/sequence
  timestamp: number;
  vaa: string;
  txHash?: string;
}

async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (res?.ok) return (await res.json()) as T;
    if (attempt >= 2 || (res && res.status < 500 && res.status !== 429)) throw new Error(`wormholescan: ${res ? `HTTP ${res.status}` : "unreachable"}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/**
 * Every Token Bridge message involving `user` (as sender or recipient), with its signed VAA.
 * Uses /transactions?address=, which, unlike /operations, also covers old transfers.
 */
async function findTransfers(user: Address): Promise<Found[]> {
  const ids: { id: string; timestamp: number }[] = [];
  for (let page = 0; page < 20; page++) {
    const { transactions = [] } = await getJson<{ transactions?: { id: string; timestamp: string; emitterChain: number; emitterAddress: string }[] }>(
      `${API}/transactions?address=${user}&page=${page}&pageSize=50`,
    );
    for (const t of transactions)
      if (EMITTERS[t.emitterChain] === t.emitterAddress) ids.push({ id: t.id, timestamp: Math.floor(Date.parse(t.timestamp) / 1000) });
    if (transactions.length < 50) break;
  }
  const out: Found[] = [];
  for (let i = 0; i < ids.length; i += 4) {
    const batch = await Promise.all(
      ids.slice(i, i + 4).map(async ({ id, timestamp }) => {
        const { data } = await getJson<{ data?: { vaa?: string; txHash?: string } }>(`${API}/vaas/${id}`).catch(() => ({ data: undefined }));
        return data?.vaa ? { id, timestamp, vaa: data.vaa, txHash: data.txHash } : null; // not signed yet
      }),
    );
    out.push(...(batch.filter(Boolean) as Found[]));
  }
  return out;
}

async function assetFor(t: Transfer): Promise<Asset> {
  // The bridge normalizes amounts to at most 8 decimals.
  let token: Address | undefined;
  if (t.tokenChain === ETHEREUM) {
    token = getAddress(`0x${t.tokenAddress.slice(26)}`);
  } else {
    const wrapped = await l1Client()
      .readContract({ address: TOKEN_BRIDGE_ETH, abi: tokenBridgeAbi, functionName: "wrappedAsset", args: [t.tokenChain, t.tokenAddress] })
      .catch(() => zeroAddress);
    if (!isAddressEqual(wrapped, zeroAddress)) token = wrapped;
  }
  const isWeth = token && isAddressEqual(token, "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
  const meta = token ? await tokenMeta([l1Client()], token) : null;
  const decimals = Math.min(meta?.decimals ?? 8, 8);
  return {
    symbol: isWeth ? "WETH" : meta?.symbol ?? (t.tokenChain === SOLANA ? "SPL token" : "tokens"),
    decimals,
    amount: t.amount,
    token,
    tokenChain: token ? "ethereum" : undefined,
    // Wrapped tokens have no price of their own: price the native token instead.
    priceKey: t.tokenChain === SOLANA ? `solana:${base58.encode(hexBytes(t.tokenAddress))}` : undefined,
  };
}

export async function checkWormhole(user: Address): Promise<CheckOutput> {
  const found = await findTransfers(user);
  const me = user.toLowerCase();

  const toEthereum: { t: Transfer; f: Found }[] = [];
  const toSolana: { t: Transfer; f: Found }[] = [];
  for (const f of found) {
    const t = decodeTransferVaa(f.vaa);
    if (!t || EMITTERS[t.emitterChain] !== t.emitterAddress) continue; // not an official Token Bridge transfer
    if (t.emitterChain === SOLANA && t.toChain === ETHEREUM && `0x${t.to.slice(26)}` === me) toEthereum.push({ t, f });
    // A Solana recipient can't be an EVM address, so the user is the Ethereum sender.
    else if (t.emitterChain === ETHEREUM && t.toChain === SOLANA) toSolana.push({ t, f });
  }

  const [ethDone, solDone] = await Promise.all([
    Promise.all(
      toEthereum.map(({ t }) =>
        l1Client().readContract({ address: TOKEN_BRIDGE_ETH, abi: tokenBridgeAbi, functionName: "isTransferCompleted", args: [t.hash] }),
      ),
    ),
    accountsExist(
      toSolana.map(({ t }) => findProgramAddress([hexBytes(t.emitterAddress), u16be(t.emitterChain), u64be(t.sequence)], TOKEN_BRIDGE_SOL)),
    ),
  ]);

  const out: CheckOutput = { findings: [], completed: 0 };
  const report = async (items: typeof toEthereum, done: boolean[], label: string, explorer: string, dest: string) => {
    for (const [i, { t, f }] of items.entries()) {
      if (done[i]) {
        out.completed++;
        continue;
      }
      const tx = f.txHash ? (f.txHash.startsWith("0x") || explorer.includes("solscan") ? f.txHash : `0x${f.txHash}`) : undefined;
      out.findings.push(
        makeFinding(WORMHOLE, {
          key: f.id,
          label,
          status: now() - f.timestamp < DAY ? "recent" : "ready",
          asset: await assetFor(t),
          txHash: tx ?? f.id,
          txUrl: tx ? `${explorer}${tx}` : `https://wormholescan.io/#/tx/${f.id}`,
          timestamp: f.timestamp,
          note: `Signed by the guardians but never redeemed on ${dest}. Redeem it on Wormhole Portal with the source transaction.`,
        }),
      );
    }
  };
  await report(toEthereum, ethDone, "Wormhole · Solana → Ethereum", "https://solscan.io/tx/", "Ethereum");
  await report(toSolana, solDone, "Wormhole · Ethereum → Solana", "https://etherscan.io/tx/", "Solana");
  return out;
}
