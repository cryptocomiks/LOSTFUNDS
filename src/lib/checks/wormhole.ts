import { base58 } from "@scure/base";
import {
  BaseError,
  ContractFunctionRevertedError,
  concat,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { l1Client } from "../clients";
import { evmChain, evmClient } from "../evm";
import { accountsData, accountsExist, findProgramAddress, hexBytes, u16be, u64be } from "../solana";
import { mapLimit, tokenMeta } from "../tokens";
import type { Asset, WithdrawalStatus } from "../types";
import { DAY, makeFinding, now, type CheckOutput, type FindingSource } from "./common";

/**
 * Wormhole transfers that were signed by the guardians but never completed on the
 * destination chain, on every route between the EVM chains below and Solana:
 *   - Token Bridge ("Portal"): wrapped / native tokens
 *   - Native Token Transfers (NTT): tokens deployed natively on several chains
 *
 * Wormholescan only helps us *find* the user's transfers: its destination status is
 * unreliable (it often reports nothing for transfers that were redeemed). Every
 * transfer is decoded from its signed VAA and checked on the destination chain:
 *   - Token Bridge to an EVM chain: TokenBridge.isTransferCompleted(vaaHash)
 *   - Token Bridge to Solana:       existence of the transfer's claim account (PDA)
 *   - NTT to an EVM chain:          NttManager.isMessageExecuted(digest)
 * An unredeemed transfer is then simulated (eth_call) or checked against the guardian
 * set, since VAAs signed by an expired guardian set can no longer be redeemed as they are.
 */

export const WORMHOLE: FindingSource = { id: "wormhole", name: "Wormhole", guideId: "wormhole" };

const API = "https://api.wormholescan.io/api/v1";
const SOLANA = 1;
const SOLANA_TOKEN_BRIDGE = "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb";
const SOLANA_CORE = "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth";
/** Emitter of Solana's Token Bridge (32-byte, hex). EVM Token Bridges emit from their own address. */
const SOLANA_EMITTER = "ec7372995d5cc8732397fb0ad35c0121e0eaa90d26f828a534cab54391b3a4f5";

interface WormholeChain {
  name: string;
  /** EVM chain id in the registry (evm.ts); without it the chain can't be checked as a destination. */
  evm?: number;
  /** Portal Token Bridge (none: the chain only carries NTT transfers). */
  tokenBridge?: Address;
}

/**
 * Wormhole chain ids. Every Token Bridge was checked on-chain on Sep 29, 2026: its chainId() is the
 * Wormhole id, evmChainId() the EVM chain id, and wormhole() the chain's core contract. Chains 7–37
 * are deprecated: their Token Bridge still works but their core stayed on an old guardian set.
 */
export const WORMHOLE_CHAINS: Record<number, WormholeChain> = {
  1: { name: "Solana" },
  2: { name: "Ethereum", evm: 1, tokenBridge: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585" },
  4: { name: "BNB Chain", evm: 56, tokenBridge: "0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7" },
  5: { name: "Polygon", evm: 137, tokenBridge: "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE" },
  6: { name: "Avalanche", evm: 43114, tokenBridge: "0x0e082F06FF657D94310cB8cE8B0D9a04541d8052" },
  7: { name: "Oasis Emerald", tokenBridge: "0x5848C791e09901b40A9Ef749f2a6735b418d7564" },
  9: { name: "Aurora", evm: 1313161554, tokenBridge: "0x51b5123a7b0F9b2bA265f9c4C8de7D78D52f510F" },
  10: { name: "Fantom", evm: 250, tokenBridge: "0x7C9Fc5741288cDFdD83CeB07f3ea7e22618D79D2" },
  11: { name: "Karura", evm: 686, tokenBridge: "0xae9d7fe007b3327AA64A32824Aaac52C42a6E624" },
  12: { name: "Acala", evm: 787, tokenBridge: "0xae9d7fe007b3327AA64A32824Aaac52C42a6E624" },
  13: { name: "Kaia", evm: 8217, tokenBridge: "0x5b08ac39EAED75c0439FC750d9FE7E1F9dD0193F" },
  14: { name: "Celo", evm: 42220, tokenBridge: "0x796Dff6D74F3E27060B71255Fe517BFb23C93eed" },
  16: { name: "Moonbeam", evm: 1284, tokenBridge: "0xB1731c586ca89a23809861c6103F0b96B3F57D92" },
  23: { name: "Arbitrum", evm: 42161, tokenBridge: "0x0b2402144Bb366A632D14B83F244D2e0e21bD39c" },
  24: { name: "Optimism", evm: 10, tokenBridge: "0x1D68124e65faFC907325e3EDbF8c4d84499DAa8b" },
  30: { name: "Base", evm: 8453, tokenBridge: "0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627" },
  34: { name: "Scroll", evm: 534352, tokenBridge: "0x24850c6f61C438823F01B7A3BF2B89B72174Fa9d" },
  35: { name: "Mantle", evm: 5000, tokenBridge: "0x24850c6f61C438823F01B7A3BF2B89B72174Fa9d" },
  36: { name: "Blast", evm: 81457, tokenBridge: "0x24850c6f61C438823F01B7A3BF2B89B72174Fa9d" },
  37: { name: "X Layer", evm: 196, tokenBridge: "0x5537857664B0f9eFe38C9f320F75fEf23234D904" },
  38: { name: "Linea", evm: 59144 },
  39: { name: "Berachain", evm: 80094, tokenBridge: "0x3Ff72741fd67D6AD0668d93B41a09248F4700560" },
  40: { name: "Sei", evm: 1329, tokenBridge: "0x3Ff72741fd67D6AD0668d93B41a09248F4700560" },
  44: { name: "Unichain", evm: 130, tokenBridge: "0x3Ff72741fd67D6AD0668d93B41a09248F4700560" },
  45: { name: "World Chain", evm: 480, tokenBridge: "0xc309275443519adca74c9136b02A38eF96E3a1f6" },
  46: { name: "Ink", evm: 57073, tokenBridge: "0x3Ff72741fd67D6AD0668d93B41a09248F4700560" },
  47: { name: "HyperEVM", evm: 999 },
  48: { name: "Monad", evm: 143, tokenBridge: "0x0B2719cdA2F10595369e6673ceA3Ee2EDFa13BA7" },
  50: { name: "Mezo", evm: 31612 },
  52: { name: "Sonic", evm: 146 },
  55: { name: "Plume", evm: 98866 },
  57: { name: "XRPL EVM", evm: 1440000, tokenBridge: "0x47F5195163270345fb4d7B9319Eda8C64C75E278" },
  58: { name: "Plasma", evm: 9745 },
  59: { name: "Creditcoin", evm: 102030 },
  64: { name: "MegaETH", evm: 4326, tokenBridge: "0xF97B81E513f53c7a6B57Bd0b103a6c295b3096C5" },
  67: { name: "0G", evm: 16661, tokenBridge: "0xee12EBDdF6E34A206e1798D185317C846BC21638" },
  71: { name: "Arc", evm: 5042 },
  72: { name: "Robinhood Chain", evm: 4663 },
};

const chainName = (id: number) => WORMHOLE_CHAINS[id]?.name ?? `Wormhole chain ${id}`;

/** The official Token Bridge emitter of a chain (32-byte, hex). */
function tokenBridgeEmitter(chain: number): string | undefined {
  if (chain === SOLANA) return SOLANA_EMITTER;
  const tb = WORMHOLE_CHAINS[chain]?.tokenBridge;
  return tb ? `${"0".repeat(24)}${tb.slice(2).toLowerCase()}` : undefined;
}
const isTokenBridge = (chain: number, emitter: string) => tokenBridgeEmitter(chain) === emitter.toLowerCase();

/** A read-only client for an EVM chain we can check, by Wormhole chain id. */
function clientOf(chain: number): PublicClient | undefined {
  const id = WORMHOLE_CHAINS[chain]?.evm;
  if (id === undefined) return undefined;
  return id === 1 ? l1Client() : evmClient(id);
}

const tokenBridgeAbi = parseAbi([
  "function isTransferCompleted(bytes32 hash) view returns (bool)",
  "function wrappedAsset(uint16 tokenChainId, bytes32 tokenAddress) view returns (address)",
  "function completeTransfer(bytes encodedVm)",
  "function completeTransferWithPayload(bytes encodedVm) returns (bytes)",
]);
const nttManagerAbi = parseAbi([
  "function isMessageExecuted(bytes32 digest) view returns (bool)",
  "function getInboundQueuedTransfer(bytes32 digest) view returns ((uint72 amount, uint64 txTimestamp, address recipient))",
  "function rateLimitDuration() view returns (uint64)",
  "function getTransceivers() view returns (address[])",
  "function getThreshold() view returns (uint8)",
  "function token() view returns (address)",
  "function getMode() view returns (uint8)",
]);
const transceiverAbi = parseAbi([
  "function getWormholePeer(uint16 chainId) view returns (bytes32)",
  "function receiveMessage(bytes encodedMessage)",
]);
const nttTokenAbi = parseAbi([
  "function mint(address account, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
]);

/* ───────────────────────── VAA decoding ───────────────────────── */

interface Vaa {
  guardianSet: number;
  timestamp: number;
  emitterChain: number;
  emitterAddress: string; // 32 bytes, hex without 0x
  sequence: bigint;
  body: Uint8Array;
  payload: Uint8Array;
  /** The whole signed VAA, as passed to the redeem functions. */
  raw: Hex;
}

/** A Token Bridge transfer (payload 1 or 3). */
export interface Transfer {
  emitterChain: number;
  emitterAddress: string;
  sequence: bigint;
  guardianSet: number;
  /** keccak256(keccak256(body)): the key the Token Bridge marks as completed. */
  hash: Hex;
  payloadType: 1 | 3;
  amount: bigint; // normalized to at most 8 decimals
  tokenAddress: Hex; // 32 bytes
  tokenChain: number;
  to: Hex; // 32 bytes
  toChain: number;
  vaa: Hex;
}

/** A Native Token Transfer, as sent by a WormholeTransceiver. */
export interface NttTransfer {
  emitterChain: number;
  emitterAddress: string;
  sequence: bigint;
  guardianSet: number;
  /** NttManager on the destination chain (32 bytes). */
  recipientManager: Hex;
  /** keccak256(uint16 sourceChain ‖ NttManagerMessage): the key the NttManager marks as executed. */
  digest: Hex;
  /** Amount with `decimals` decimals (NTT trims amounts to at most 8). */
  amount: bigint;
  decimals: number;
  to: Hex; // 32 bytes
  toChain: number;
  vaa: Hex;
}

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

function parseVaa(vaaBase64: string): Vaa | null {
  let raw: Uint8Array;
  try {
    raw = fromBase64(vaaBase64);
  } catch {
    return null;
  }
  if (raw.length < 6 || raw[0] !== 1) return null;
  const body = raw.subarray(6 + raw[5] * 66);
  // body: timestamp(4) nonce(4) emitterChain(2) emitterAddress(32) sequence(8) consistency(1) payload
  if (body.length < 51) return null;
  return {
    guardianSet: Number(readUint(raw, 1, 4)),
    timestamp: Number(readUint(body, 0, 4)),
    emitterChain: Number(readUint(body, 8, 2)),
    emitterAddress: toHex(body.subarray(10, 42)).slice(2),
    sequence: readUint(body, 42, 8),
    body,
    payload: body.subarray(51),
    raw: toHex(raw),
  };
}

/** Decodes a signed VAA carrying a Token Bridge transfer (payload 1 or 3). */
export function decodeTransferVaa(vaaBase64: string): Transfer | null {
  const v = parseVaa(vaaBase64);
  const p = v?.payload;
  if (!v || !p || p.length < 133 || (p[0] !== 1 && p[0] !== 3)) return null;
  return {
    emitterChain: v.emitterChain,
    emitterAddress: v.emitterAddress,
    sequence: v.sequence,
    guardianSet: v.guardianSet,
    hash: keccak256(keccak256(toHex(v.body))),
    payloadType: p[0],
    amount: readUint(p, 1, 32),
    tokenAddress: toHex(p.subarray(33, 65)),
    tokenChain: Number(readUint(p, 65, 2)),
    to: toHex(p.subarray(67, 99)),
    toChain: Number(readUint(p, 99, 2)),
    vaa: v.raw,
  };
}

const TRANSCEIVER_PREFIX = "0x9945ff10";
const NTT_PREFIX = "0x994e5454";

/**
 * Decodes a WormholeTransceiver VAA carrying an NTT transfer:
 * prefix(4) sourceManager(32) recipientManager(32) len(2) NttManagerMessage, where
 * NttManagerMessage = id(32) sender(32) len(2) NativeTokenTransfer, and
 * NativeTokenTransfer = prefix(4) decimals(1) amount(8) sourceToken(32) to(32) toChain(2) ….
 */
export function decodeNttVaa(vaaBase64: string): NttTransfer | null {
  const v = parseVaa(vaaBase64);
  const p = v?.payload;
  if (!v || !p || p.length < 70 || toHex(p.subarray(0, 4)) !== TRANSCEIVER_PREFIX) return null;
  const len = Number(readUint(p, 68, 2));
  const message = p.subarray(70, 70 + len);
  if (message.length !== len || len < 66) return null;
  const n = message.subarray(66, 66 + Number(readUint(message, 64, 2)));
  if (n.length < 79 || toHex(n.subarray(0, 4)) !== NTT_PREFIX) return null;
  return {
    emitterChain: v.emitterChain,
    emitterAddress: v.emitterAddress,
    sequence: v.sequence,
    guardianSet: v.guardianSet,
    recipientManager: toHex(p.subarray(36, 68)),
    digest: keccak256(concat([toHex(v.emitterChain, { size: 2 }), toHex(message)])),
    decimals: n[4],
    amount: readUint(n, 5, 8),
    to: toHex(n.subarray(45, 77)),
    toChain: Number(readUint(n, 77, 2)),
    vaa: v.raw,
  };
}

/** The EVM address in a 32-byte Wormhole address (lowercase). */
const evmAddress = (b32: Hex) => `0x${b32.slice(26)}`.toLowerCase() as Address;

/* ───────────────────────── Finding the user's transfers ───────────────────────── */

interface Found {
  id: string; // chain/emitter/sequence
  timestamp?: number;
  vaa: string;
  txHash?: string;
  /** Who sent the source transaction (EVM lowercase or base58), per Wormholescan. */
  from?: string;
  /** Final recipient as Wormholescan reads it (also for payload-3 transfers sent through a relayer). */
  to?: string;
}

async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (res?.ok) return (await res.json()) as T;
    if (res?.status === 404) return null;
    if (attempt >= 3 || (res && res.status < 500 && res.status !== 429)) throw new Error(`wormholescan: ${res ? `HTTP ${res.status}` : "unreachable"}`);
    const retryAfter = Number(res?.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, retryAfter > 0 && retryAfter < 30 ? retryAfter * 1000 : 1000 * 2 ** attempt));
  }
}

const PAGE = 100;
const MAX_PAGES = 20;
const seconds = (iso?: string) => (iso ? Math.floor(Date.parse(iso) / 1000) || undefined : undefined);

interface Operation {
  id: string;
  vaa?: { raw?: string };
  content?: { standarizedProperties?: { toAddress?: string } };
  sourceChain?: { timestamp?: string; from?: string; transaction?: { txHash?: string } };
}
interface Transaction {
  id: string;
  timestamp?: string;
  txHash?: string;
  emitterChain: number;
  emitterAddress: string;
  standardizedProperties?: { appIds?: string[]; toAddress?: string };
  globalTx?: { originTx?: { from?: string; txHash?: string } };
}

/** Every page of a Wormholescan list for this address (newest first). */
async function allPages<T>(list: "operations" | "transactions", user: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await getJson<Record<string, T[] | undefined>>(`${API}/${list}?address=${user}&page=${page}&pageSize=${PAGE}`);
    const items = r?.[list] ?? [];
    out.push(...items);
    if (items.length < PAGE) break;
  }
  return out;
}

/**
 * Every Token Bridge and NTT message involving `user` (as sender or recipient), with its signed VAA.
 * /operations returns the VAAs inline; /transactions also covers old transfers /operations misses,
 * whose VAA is then fetched on its own.
 */
async function findMessages(user: string): Promise<Found[]> {
  const [ops, txs] = await Promise.all([
    allPages<Operation>("operations", user).catch(() => [] as Operation[]), // /transactions lists them all too
    allPages<Transaction>("transactions", user),
  ]);
  const found = new Map<string, Found>();
  for (const o of ops)
    if (o.vaa?.raw)
      found.set(o.id, {
        id: o.id,
        timestamp: seconds(o.sourceChain?.timestamp),
        vaa: o.vaa.raw,
        txHash: o.sourceChain?.transaction?.txHash,
        from: o.sourceChain?.from,
        to: o.content?.standarizedProperties?.toAddress,
      });
  const missing = txs
    .filter((t) => !found.has(t.id) && (isTokenBridge(t.emitterChain, t.emitterAddress) || t.standardizedProperties?.appIds?.includes("NATIVE_TOKEN_TRANSFER")))
    .map((t) => ({
      id: t.id,
      timestamp: seconds(t.timestamp),
      txHash: t.globalTx?.originTx?.txHash ?? t.txHash,
      from: t.globalTx?.originTx?.from,
      to: t.standardizedProperties?.toAddress,
    }));
  await mapLimit(missing, 4, async (m) => {
    const r = await getJson<{ data?: { vaa?: string; txHash?: string } }>(`${API}/vaas/${m.id}`);
    if (r?.data?.vaa) found.set(m.id, { ...m, vaa: r.data.vaa, txHash: m.txHash ?? r.data.txHash }); // no VAA: not signed yet
  });
  return [...found.values()];
}

/* ───────────────────────── Destination checks ───────────────────────── */

/**
 * Why an unredeemed transfer can or can't be redeemed right now:
 * redeemable, guardians (signed by a guardian set the destination no longer accepts),
 * unattested (no wrapped token on the destination yet), failing (reverts for another reason).
 */
type Redeem = { kind: "redeemable" } | { kind: "guardians" } | { kind: "unattested" } | { kind: "failing"; reason: string };
/** What happened to a transfer: completed, still waiting, or never redeemable (skip). */
type State = "completed" | "skip" | Redeem;

/** The revert reason of a failed eth_call; rethrows when the node itself failed (no verdict). */
function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted) return reverted.reason ?? reverted.data?.errorName ?? reverted.signature ?? "reverted";
    // Some nodes answer a revert with a generic error code: the reason is in the message.
    if (/revert/i.test(e.message)) return e.details || e.shortMessage;
  }
  throw e;
}

/** null when the call reverts; rethrows when the node itself failed. */
const orRevert = <T>(p: Promise<T>): Promise<T | null> => p.catch((e) => (revertReason(e), null));

/** Maps the revert of a simulated redeem to a verdict. */
function classify(reason: string): State {
  if (/already (completed|executed|redeemed|consumed)/i.test(reason)) return "completed";
  if (/guardian set|no quorum/i.test(reason)) return { kind: "guardians" };
  if (/no wrapper/i.test(reason)) return { kind: "unattested" };
  // Transfers to the chain they came from, or from a bridge the destination doesn't know: never redeemable.
  if (/invalid emitter|invalid target chain/i.test(reason)) return "skip";
  return { kind: "failing", reason };
}

const addressOf = (a: string) => getAddress(a);

/** Token Bridge transfers to EVM chains: isTransferCompleted, then a simulated redeem. */
async function evmTransferStates(items: Transfer[]): Promise<State[]> {
  const bridge = (t: Transfer) => ({ client: clientOf(t.toChain)!, address: WORMHOLE_CHAINS[t.toChain].tokenBridge! });
  const done = await mapLimit(items, 32, (t) => {
    const { client, address } = bridge(t);
    return client.readContract({ address, abi: tokenBridgeAbi, functionName: "isTransferCompleted", args: [t.hash] });
  });
  return mapLimit(
    items.map((t, i) => ({ t, done: done[i] })),
    4,
    async ({ t, done }): Promise<State> => {
      if (done) return "completed";
      // Payload 1 can be redeemed by anyone (simulated as the recipient), payload 3 only by its `to` contract.
      const { client, address } = bridge(t);
      try {
        await client.simulateContract({
          address,
          abi: tokenBridgeAbi,
          functionName: t.payloadType === 1 ? "completeTransfer" : "completeTransferWithPayload",
          args: [t.vaa],
          account: addressOf(evmAddress(t.to)),
        });
        return { kind: "redeemable" };
      } catch (e) {
        return classify(revertReason(e));
      }
    },
  );
}

const u32be = (n: number) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const u32le = (b: Uint8Array, o: number) => b[o] + b[o + 1] * 2 ** 8 + b[o + 2] * 2 ** 16 + b[o + 3] * 2 ** 24;
const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Token Bridge transfers to Solana: the claim account exists once redeemed. A VAA already
 * posted on Solana can always be redeemed; otherwise its guardian set must still be active there.
 */
async function solanaTransferStates(items: Transfer[]): Promise<State[]> {
  const claimed = await accountsExist(
    items.map((t) => findProgramAddress([hexBytes(t.emitterAddress), u16be(t.emitterChain), u64be(t.sequence)], SOLANA_TOKEN_BRIDGE)),
  );
  const open = items.filter((_, i) => !claimed[i]);
  if (!open.length) return items.map(() => "completed");

  const sets = [...new Set(open.map((t) => t.guardianSet))];
  // A token from another chain needs its wrapped mint on Solana (created when the token is attested).
  const mintOf = (t: Transfer) => findProgramAddress([enc("wrapped"), u16be(t.tokenChain), hexBytes(t.tokenAddress)], SOLANA_TOKEN_BRIDGE);
  const foreign = open.filter((t) => t.tokenChain !== SOLANA);
  const accounts = await accountsData([
    ...open.map((t) => findProgramAddress([enc("PostedVAA"), hexBytes(keccak256(bodyOf(t.vaa)))], SOLANA_CORE)),
    ...sets.map((s) => findProgramAddress([enc("GuardianSet"), u32be(s)], SOLANA_CORE)),
    ...foreign.map(mintOf),
  ]);
  const posted = new Map(open.map((t, i) => [t, !!accounts[i]]));
  // GuardianSet account: index u32, n u32, n × 20-byte keys, creation u32, expiration u32 (little-endian).
  const active = new Map(
    sets.map((s, i) => {
      const d = accounts[open.length + i];
      if (!d || d.length < 8) return [s, false];
      const expiration = u32le(d, 12 + 20 * u32le(d, 4));
      return [s, expiration === 0 || expiration > now()];
    }),
  );
  const unattested = new Set(foreign.filter((_, i) => !accounts[open.length + sets.length + i]));

  return items.map((t, i): State => {
    if (claimed[i]) return "completed";
    if (unattested.has(t)) return { kind: "unattested" };
    return posted.get(t) || active.get(t.guardianSet) ? { kind: "redeemable" } : { kind: "guardians" };
  });
}

/** The VAA body (what the guardians sign) from a raw VAA. */
function bodyOf(vaa: Hex): Hex {
  const sigs = parseInt(vaa.slice(12, 14), 16);
  return `0x${vaa.slice(2 + 2 * (6 + sigs * 66))}`;
}

/* ───────────────────────── Amounts ───────────────────────── */

/** Symbols made to look like well-known tokens (e.g. "USⅮΤ") are a common scam. */
const looksFake = (symbol: string) => /[^\x20-\x7e]/.test(symbol);

async function wrappedOn(chain: number, t: Transfer): Promise<Address | undefined> {
  const client = clientOf(chain);
  const tb = WORMHOLE_CHAINS[chain]?.tokenBridge;
  if (!client || !tb) return undefined;
  if (t.tokenChain === chain) return addressOf(evmAddress(t.tokenAddress));
  const w = await client
    .readContract({ address: tb, abi: tokenBridgeAbi, functionName: "wrappedAsset", args: [t.tokenChain, t.tokenAddress] })
    .catch((e) => (revertReason(e), zeroAddress));
  return isAddressEqual(w, zeroAddress) ? undefined : w;
}

/** Token Bridge amounts are normalized to min(decimals, 8); prices come from the original token. */
async function transferAsset(t: Transfer): Promise<Asset> {
  let meta: { symbol: string; decimals: number } | null = null;
  // The token received on an EVM destination (native there, or its Wormhole-wrapped version)…
  const received = await wrappedOn(t.toChain, t);
  if (received) meta = await tokenMeta([clientOf(t.toChain)!], received);
  // …or the original token on its home chain…
  const origin = clientOf(t.tokenChain);
  if (!meta && origin) meta = await tokenMeta([origin], addressOf(evmAddress(t.tokenAddress)));
  // …or a Solana mint (decimals only)…
  if (!meta && t.tokenChain === SOLANA) {
    const [mint] = await accountsData([base58.encode(hexBytes(t.tokenAddress))]).catch(() => [null]);
    if (mint && mint.length >= 45) meta = { symbol: "SPL token", decimals: mint[44] };
  }
  // …or the wrapped token that was sent from an EVM chain.
  if (!meta) {
    const sent = await wrappedOn(t.emitterChain, t);
    if (sent) meta = await tokenMeta([clientOf(t.emitterChain)!], sent);
  }
  const symbol = meta?.symbol ?? "tokens";
  const llama = evmChain(WORMHOLE_CHAINS[t.tokenChain]?.evm ?? 0)?.llama;
  const priceKey =
    t.tokenChain === SOLANA ? `solana:${base58.encode(hexBytes(t.tokenAddress))}` : llama ? `${llama}:${evmAddress(t.tokenAddress)}` : "none:none";
  return {
    symbol,
    decimals: Math.min(meta?.decimals ?? 8, 8),
    amount: t.amount,
    priceKey: looksFake(symbol) ? "none:none" : priceKey,
  };
}

/* ───────────────────────── NTT ───────────────────────── */

type NttState = "completed" | "skip" | Redeem | { kind: "queued"; readyAt: number };

/** NTT transfers to EVM chains: executed (and not stuck in the rate-limit queue), or a simulated delivery. */
async function nttStates(items: NttTransfer[]): Promise<NttState[]> {
  const read = <T>(n: NttTransfer, fn: string, args: unknown[] = []) =>
    clientOf(n.toChain)!.readContract({ address: addressOf(evmAddress(n.recipientManager)), abi: nttManagerAbi, functionName: fn, args } as never) as Promise<T>;
  const indexed = items.map((n, i) => ({ n, i }));

  const executed = await mapLimit(items, 32, (n) => orRevert(read<boolean>(n, "isMessageExecuted", [n.digest]))); // null: not an NttManager
  // A transfer over the inbound rate limit is executed but waits in a queue; anyone can release it later.
  const queued = await mapLimit(indexed, 32, async ({ n, i }) =>
    executed[i] ? orRevert(read<{ txTimestamp: bigint }>(n, "getInboundQueuedTransfer", [n.digest])) : null,
  );

  return mapLimit(indexed, 4, async ({ n, i }): Promise<NttState> => {
    if (executed[i] === null) return "skip";
    if (executed[i]) {
      const since = queued[i]?.txTimestamp;
      if (!since) return "completed";
      return { kind: "queued", readyAt: Number(since + (await read<bigint>(n, "rateLimitDuration"))) };
    }
    // Deliver it through the manager's WormholeTransceiver that trusts this VAA's emitter.
    const client = clientOf(n.toChain)!;
    const [threshold, transceivers] = await Promise.all([orRevert(read<number>(n, "getThreshold")), orRevert(read<readonly Address[]>(n, "getTransceivers"))]);
    if (threshold !== 1) return "skip"; // other verifiers must attest too: can't tell
    for (const tr of transceivers ?? []) {
      const peer = await orRevert(client.readContract({ address: tr, abi: transceiverAbi, functionName: "getWormholePeer", args: [n.emitterChain] }));
      if (peer?.slice(2).toLowerCase() !== n.emitterAddress) continue;
      try {
        await client.simulateContract({ address: tr, abi: transceiverAbi, functionName: "receiveMessage", args: [n.vaa], account: addressOf(evmAddress(n.to)) });
        return { kind: "redeemable" };
      } catch (e) {
        const verdict = classify(revertReason(e));
        // Only a guardian-set problem is worth reporting; other reverts can't be told apart from spam.
        return verdict === "completed" || (typeof verdict === "object" && verdict.kind === "guardians") ? verdict : "skip";
      }
    }
    return "skip";
  });
}

/**
 * The token an NTT transfer releases, only when its NttManager is the real thing: in locking mode it
 * holds enough tokens, in burning mode the token lets it mint. Anyone can deploy a manager claiming
 * a well-known token, so the token must also be a known NTT token or have a market price.
 */
async function nttAsset(n: NttTransfer, known: () => Promise<Set<string>>): Promise<Asset | null> {
  const client = clientOf(n.toChain)!;
  const manager = addressOf(evmAddress(n.recipientManager));
  const [token, mode] = await Promise.all([
    orRevert(client.readContract({ address: manager, abi: nttManagerAbi, functionName: "token" })),
    orRevert(client.readContract({ address: manager, abi: nttManagerAbi, functionName: "getMode" })),
  ]);
  if (!token) return null;
  const meta = await tokenMeta([client], token);
  if (!meta) return null;
  const raw = meta.decimals >= n.decimals ? n.amount * 10n ** BigInt(meta.decimals - n.decimals) : n.amount / 10n ** BigInt(n.decimals - meta.decimals);
  if (mode === 0) {
    const held = await orRevert(client.readContract({ address: token, abi: nttTokenAbi, functionName: "balanceOf", args: [manager] }));
    if ((held ?? 0n) < raw) return null;
  } else if (mode === 1) {
    const mint = encodeFunctionData({ abi: nttTokenAbi, functionName: "mint", args: [addressOf(evmAddress(n.to)), raw] });
    if ((await orRevert(client.call({ account: manager, to: token, data: mint }))) === null) return null;
  } else return null;

  const llama = evmChain(WORMHOLE_CHAINS[n.toChain].evm!)!.llama;
  const priceKey = `${llama}:${token.toLowerCase()}`;
  if (looksFake(meta.symbol)) return null;
  if (!(await known()).has(token.toLowerCase()) && !(await hasPrice(priceKey))) return null;
  return { symbol: meta.symbol, decimals: n.decimals, amount: n.amount, priceKey };
}

async function hasPrice(key: string): Promise<boolean> {
  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/${key}`, { signal: AbortSignal.timeout(15_000) });
    const { coins } = (await res.json()) as { coins?: Record<string, { price?: number }> };
    return (coins?.[key]?.price ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Addresses of the tokens on Wormholescan's NTT token list, on any chain (lowercase). */
async function nttTokenList(): Promise<Set<string>> {
  const list = await getJson<{ platforms?: Record<string, string> }[]>(`${API}/native-token-transfer/token-list`).catch(() => null);
  return new Set((list ?? []).flatMap((t) => Object.values(t.platforms ?? {}).map((a) => String(a).toLowerCase())));
}

/* ───────────────────────── The check ───────────────────────── */

function txLink(chain: number, f: Found): { txHash: string; txUrl: string } {
  if (!f.txHash) return { txHash: f.id, txUrl: `https://wormholescan.io/#/tx/${f.id}` };
  if (chain === SOLANA) return { txHash: f.txHash, txUrl: `https://solscan.io/tx/${f.txHash}` };
  const tx = f.txHash.startsWith("0x") ? f.txHash : `0x${f.txHash}`;
  const explorer = evmChain(WORMHOLE_CHAINS[chain]?.evm ?? 0)?.chain.blockExplorers?.default.url;
  return { txHash: tx, txUrl: explorer ? `${explorer.replace(/\/$/, "")}/tx/${tx}` : `https://wormholescan.io/#/tx/${tx}` };
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function redeemNote(r: Redeem, dest: string, guardianSet: number): string {
  switch (r.kind) {
    case "redeemable":
      return "";
    case "guardians":
      return `Never redeemed on ${dest}, but it can't be redeemed as it is: it was signed by Wormhole guardian set ${guardianSet}, which ${dest} doesn't accept (any more). The guardians have to sign it again first: ask Wormhole support to re-observe the transfer.`;
    case "unattested":
      return `Never redeemed on ${dest}: the token has no wrapped version there yet. Register it on ${dest} first (attest the token in Portal), then redeem.`;
    case "failing":
      return `Never redeemed on ${dest}, but redeeming it fails right now (${r.reason.slice(0, 80)}). Check it on Portal or Wormholescan.`;
  }
}

/**
 * `user` is an EVM address or a Solana address. Wormholescan's index matches the address as
 * sender or recipient; for an EVM user the VAA's recipient or the source transaction's sender
 * must be the user. For a Solana user every transfer from or to Solana that was found is theirs.
 */
export async function checkWormhole(user: string): Promise<CheckOutput> {
  const found = await findMessages(user);
  const isEvm = user.startsWith("0x");
  const me = isEvm ? user.toLowerCase() : user;
  const sameUser = (a?: string) => !!a && (isEvm ? a.toLowerCase() === me : a === me);

  const evmTransfers: { t: Transfer; f: Found }[] = [];
  const solTransfers: { t: Transfer; f: Found }[] = [];
  const ntts: { n: NttTransfer; f: Found }[] = [];
  for (const f of found) {
    const t = decodeTransferVaa(f.vaa);
    if (t && isTokenBridge(t.emitterChain, t.emitterAddress)) {
      if (t.amount === 0n) continue; // nothing to claim
      const recipient = isEvm
        ? (t.toChain !== SOLANA && evmAddress(t.to) === me) || (t.payloadType === 3 && sameUser(f.to))
        : t.toChain === SOLANA;
      // Old transfers may lack the sender: a Solana recipient can't be an EVM user, so they sent it.
      const sender = isEvm ? sameUser(f.from) || (!f.from && t.toChain === SOLANA) : t.emitterChain === SOLANA;
      if (!recipient && !sender) continue;
      if (t.toChain === SOLANA) solTransfers.push({ t, f });
      else if (WORMHOLE_CHAINS[t.toChain]?.tokenBridge && clientOf(t.toChain)) evmTransfers.push({ t, f });
      // else: a chain we can't check (Sui, Aptos…, or no public RPC)
      continue;
    }
    const n = decodeNttVaa(f.vaa);
    if (n && n.amount > 0n && n.toChain !== SOLANA && clientOf(n.toChain)) {
      const mine = isEvm ? evmAddress(n.to) === me || sameUser(f.from) : n.emitterChain === SOLANA && (!f.from || f.from === me);
      if (mine) ntts.push({ n, f });
    }
    // NTT to Solana uses per-token programs: not covered.
  }

  const [evmStates, solStates, nttResults] = await Promise.all([
    evmTransferStates(evmTransfers.map((x) => x.t)),
    solanaTransferStates(solTransfers.map((x) => x.t)),
    nttStates(ntts.map((x) => x.n)),
  ]);

  const out: CheckOutput = { findings: [], completed: 0 };
  const age = (f: Found, vaaTime: number) => f.timestamp ?? vaaTime;

  const transfers = [...evmTransfers.map((x, i) => ({ ...x, s: evmStates[i] })), ...solTransfers.map((x, i) => ({ ...x, s: solStates[i] }))];
  for (const { t, f, s } of transfers) {
    if (s === "completed") out.completed++;
    if (s === "completed" || s === "skip") continue;
    const from = chainName(t.emitterChain);
    const dest = chainName(t.toChain);
    const timestamp = age(f, parseVaa(f.vaa)!.timestamp);
    const status: WithdrawalStatus = s.kind !== "redeemable" ? "manual" : now() - timestamp < DAY ? "recent" : "ready";
    const asset = await transferAsset(t);
    const recipient = t.toChain === SOLANA ? undefined : evmAddress(t.to);
    const notes = [
      s.kind === "redeemable" ? `Signed by the guardians but never redeemed on ${dest}. Redeem it on Wormhole Portal with the source transaction.` : redeemNote(s, dest, t.guardianSet),
      t.payloadType === 3
        ? `It carries app data, so only ${short(recipient ?? "")} can redeem it: resume it in the app that sent it.`
        : isEvm && recipient && recipient !== me
          ? `The funds go to ${short(recipient)}, the recipient you chose.`
          : "",
      looksFake(asset.symbol) ? "Warning: this token's symbol imitates a well-known token; it may be a scam token with no value." : "",
    ];
    out.findings.push(
      makeFinding(WORMHOLE, {
        key: f.id,
        label: `Wormhole · ${from} → ${dest}`,
        status,
        asset,
        ...txLink(t.emitterChain, f),
        timestamp,
        note: notes.filter(Boolean).join(" "),
      }),
    );
  }

  let tokenList: Promise<Set<string>> | undefined;
  const known = () => (tokenList ??= nttTokenList());
  for (const [i, { n, f }] of ntts.entries()) {
    const s = nttResults[i];
    if (s === "completed") out.completed++;
    if (s === "completed" || s === "skip") continue;
    const asset = await nttAsset(n, known);
    if (!asset) continue; // not a real NttManager / token: ignore
    const from = chainName(n.emitterChain);
    const dest = chainName(n.toChain);
    const timestamp = age(f, parseVaa(f.vaa)!.timestamp);
    let status: WithdrawalStatus;
    let note: string;
    let readyAt: number | undefined;
    if (s.kind === "queued") {
      status = now() >= s.readyAt ? "ready" : "waiting";
      readyAt = status === "waiting" ? s.readyAt : undefined;
      note = `Native Token Transfer (NTT) that reached ${dest} but is held by the token's rate limit. Once released (anyone can do it, from the token's app or Wormholescan), the tokens go to the recipient.`;
    } else if (s.kind === "redeemable") {
      status = now() - timestamp < DAY ? "recent" : "ready";
      note = `Native Token Transfer (NTT) signed by the guardians but never delivered on ${dest}. Complete it in the token's bridge app (or Wormhole Connect) with the source transaction.`;
    } else {
      status = "manual";
      note = `Native Token Transfer (NTT). ${redeemNote(s, dest, n.guardianSet)}`;
    }
    const recipient = evmAddress(n.to);
    if (isEvm && recipient !== me) note += ` The funds go to ${short(recipient)}, the recipient you chose.`;
    out.findings.push(
      makeFinding(WORMHOLE, {
        key: f.id,
        label: `Wormhole · ${from} → ${dest}`,
        status,
        asset,
        ...txLink(n.emitterChain, f),
        timestamp,
        readyAt,
        note,
      }),
    );
  }
  return out;
}
