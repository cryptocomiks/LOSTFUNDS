import { base64 } from "@scure/base";
import { bytesToHex, encodeFunctionData, encodePacked, isAddressEqual, keccak256, parseAbi, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { evmChain, evmClient } from "../evm";
import type { Asset } from "../types";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";
import { wouldSucceed } from "./simulate";

/**
 * Celer cBridge: transfers that failed and were refunded, but whose refund was never collected.
 *
 * Transfers come from cBridge's public API (history of the sending address). A refund of a
 * liquidity-pool transfer is a withdrawal from the pool on the source chain, signed by Celer's
 * validators. It is only reported if, on that chain:
 *   - the pool has not paid it yet (`withdraws(wdId)` is false), and
 *   - submitting it right now would succeed (simulated with eth_call).
 * The API alone isn't trusted: it still lists some long-paid transfers as pending.
 */

export const CELER: FindingSource = { id: "celer", name: "Celer cBridge", guideId: "celer" };

const API = "https://cbridge-prod2.celer.app";

/**
 * cBridge liquidity pools on the chains we can reach (`chains[].contract_addr` in
 * /v2/getTransferConfigsForAll, each checked on-chain). Pools on other chains are skipped.
 */
const POOLS: Record<number, Address> = {
  1: "0x5427FEFA711Eff984124bFBB1AB6fbf5E3DA1820",
  10: "0x9D39Fc627A6d9d9F8C831c16995b209548cc3401",
  56: "0xdd90E5E87A2081Dcf0391920868eBc2FFB81a1aF",
  100: "0x3795C36e7D12A8c252A20C5a7B455f7c57b60283",
  137: "0x88DCDC47D2f83a99CF0000FDF667A468bB958a78",
  250: "0x374B8a9f3eC5eB2D97ECA84Ea27aCa45aa1C57EF",
  747: "0x841ce48F9446C8E281D3F1444cB859b4A6D0738C",
  999: "0x9Bb46D5100d2Db4608112026951c9C965b233f4D",
  1088: "0x841ce48F9446C8E281D3F1444cB859b4A6D0738C",
  8453: "0x7d43AABC515C356145049227CeE54B608342c0ad",
  9745: "0x9B36f165baB9ebe611d491180418d8De4b8f3a1f",
  42161: "0x1619DE6B6B20eD217a58d00f37B9d47C7663feca",
  43114: "0xef3c714c9425a8F3697A9C969Dc1af30ba82e5d4",
  59144: "0x9B36f165baB9ebe611d491180418d8De4b8f3a1f",
};

/** Transfer statuses (cBridge API). */
const COMPLETED = 5;
const TO_BE_REFUNDED = 6;
const REQUESTING_REFUND = 7;
const REFUND_TO_BE_CONFIRMED = 8;
const REFUNDED = 10;
/** bridge_type of transfers through the liquidity pools (the others are pegged-token bridges). */
const LIQUIDITY_POOL = 1;

const PAGE = 50;
const MAX_PAGES = 20;

const poolAbi = parseAbi([
  "function withdraws(bytes32) view returns (bool)",
  "function withdraw(bytes _wdmsg, bytes[] _sigs, address[] _signers, uint256[] _powers)",
]);

interface HistoryRow {
  transfer_id: Hex;
  status: number;
  bridge_type: number;
  ts: string;
  src_send_info: { chain: { id: number }; token: { symbol: string; address: string; decimal: number }; amount: string };
  dst_received_info?: { chain?: { id: number } };
  src_block_tx_link?: string;
}

interface TransferStatus {
  status: number;
  bridge_type: number;
  wd_onchain: string | null;
  sorted_sigs: string[];
  signers: string[];
  powers: string[];
}

async function api<T>(path: string, body?: object): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (res?.ok) {
      const json = (await res.json()) as T & { err?: { msg?: string } | null };
      if (json.err) throw new Error(`cBridge API: ${json.err.msg ?? "error"}`);
      return json;
    }
    if (attempt >= 4 || (res && res.status < 500 && res.status !== 429)) throw new Error(`cBridge API: ${res ? `HTTP ${res.status}` : "unreachable"}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

/** Every transfer the address sent, newest first (the API matches the sender). */
async function history(user: Address): Promise<HistoryRow[]> {
  const rows = new Map<string, HistoryRow>();
  let token = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await api<{ history?: HistoryRow[]; next_page_token?: string }>(
      `/v1/transferHistory?acct_addr[]=${user}&page_size=${PAGE}&next_page_token=${token}`,
    );
    const list = r.history ?? [];
    for (const row of list) rows.set(row.transfer_id, row);
    if (list.length < PAGE || !r.next_page_token || r.next_page_token === token) break;
    token = r.next_page_token;
  }
  return [...rows.values()];
}

export interface WithdrawMsg {
  chainId: bigint;
  seqnum: bigint;
  receiver: Address;
  token: Address;
  amount: bigint;
  refId: Hex;
}

/** Decodes a pool withdrawal message (protobuf WithdrawMsg); null if it isn't one. */
export function decodeWithdrawMsg(bytes: Uint8Array): WithdrawMsg | null {
  const fields: Record<number, bigint | Uint8Array> = {};
  let i = 0;
  const varint = () => {
    let x = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (i >= bytes.length || shift > 63n) throw new Error("bad varint");
      const b = bytes[i++];
      x |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return x;
    }
  };
  try {
    while (i < bytes.length) {
      const key = Number(varint());
      const wire = key & 7;
      if (wire === 0) fields[key >> 3] = varint();
      else if (wire === 2) {
        const len = Number(varint());
        if (i + len > bytes.length) return null;
        fields[key >> 3] = bytes.slice(i, i + len);
        i += len;
      } else return null;
    }
  } catch {
    return null;
  }
  const num = (n: number) => (fields[n] === undefined ? 0n : typeof fields[n] === "bigint" ? fields[n] : undefined);
  const raw = (n: number, len?: number) => {
    const v = fields[n];
    return v instanceof Uint8Array && (len === undefined || v.length === len) ? v : undefined;
  };
  const [chainId, seqnum] = [num(1), num(2)];
  const [receiver, token, amount, refId] = [raw(3, 20), raw(4, 20), raw(5), raw(6, 32)];
  if (!chainId || seqnum === undefined || !receiver || !token || !amount || amount.length > 32 || !refId) return null;
  return {
    chainId,
    seqnum,
    receiver: bytesToHex(receiver),
    token: bytesToHex(token),
    amount: amount.length ? BigInt(bytesToHex(amount)) : 0n,
    refId: bytesToHex(refId),
  };
}

/** The id the pool records a withdrawal under (Pool.sol). */
export const withdrawId = (m: WithdrawMsg) =>
  keccak256(encodePacked(["uint64", "uint64", "address", "address", "uint256"], [m.chainId, m.seqnum, m.receiver, m.token, m.amount]));

const b64hex = (s: string) => bytesToHex(base64.decode(s));

async function transferStatus(id: Hex): Promise<TransferStatus> {
  let s = await api<TransferStatus>("/v2/getTransferStatus", { transfer_id: id });
  // The signatures sometimes come back empty: ask once more.
  if (s.status === REFUND_TO_BE_CONFIRMED && !s.sorted_sigs?.length) s = await api<TransferStatus>("/v2/getTransferStatus", { transfer_id: id });
  return s;
}

const chainName = (id: number) => evmChain(id)?.name ?? `chain ${id}`;

/** Symbols made to look like well-known tokens (e.g. "USⅮΤ") are a common scam. */
const looksFake = (symbol?: string) => !!symbol && /[^\x20-\x7e]/.test(symbol);

type Refund = { kind: "paid" } | { kind: "claimable"; msg: WithdrawMsg } | { kind: "unknown" };

/** Where a refund stands on the source chain. */
async function refundState(row: HistoryRow, user: Address): Promise<Refund> {
  const src = row.src_send_info.chain.id;
  const pool = POOLS[src];
  if (!pool) return { kind: "unknown" };
  // The status endpoint is fresher than the history (a row can still say "requesting" there).
  const s = await transferStatus(row.transfer_id);
  if (s.status === REFUNDED) return { kind: "paid" };
  if (s.status !== REFUND_TO_BE_CONFIRMED || s.bridge_type !== LIQUIDITY_POOL || !s.wd_onchain || !s.sorted_sigs?.length) return { kind: "unknown" };
  const msg = decodeWithdrawMsg(base64.decode(s.wd_onchain));
  // Must be this transfer's refund, on its source chain, paid to the user.
  if (!msg || msg.chainId !== BigInt(src) || msg.refId.toLowerCase() !== row.transfer_id.toLowerCase() || !isAddressEqual(msg.receiver, user) || msg.amount === 0n)
    return { kind: "unknown" };

  const client = src === 1 ? l1Client() : evmClient(src);
  if (!client) return { kind: "unknown" };
  try {
    if (await client.readContract({ address: pool, abi: poolAbi, functionName: "withdraws", args: [withdrawId(msg)] })) return { kind: "paid" };
    const data = encodeFunctionData({
      abi: poolAbi,
      functionName: "withdraw",
      args: [b64hex(s.wd_onchain), s.sorted_sigs.map(b64hex), s.signers.map(b64hex), s.powers.map((p) => BigInt(b64hex(p)))],
    });
    // Rejected (pool paused, receiver is a contract that can't take ETH…): nothing the user can do.
    return (await wouldSucceed(client, { from: user, to: pool, data })) ? { kind: "claimable", msg } : { kind: "unknown" };
  } catch (e) {
    if (src === 1) throw e; // Ethereum must answer; other chains' public RPCs are best-effort
    return { kind: "unknown" };
  }
}

function assetOf(row: HistoryRow, msg: WithdrawMsg): Asset {
  const t = row.src_send_info.token;
  const c = evmChain(row.src_send_info.chain.id);
  const fake = looksFake(t.symbol);
  return {
    symbol: t.symbol || "tokens",
    decimals: Number.isInteger(t.decimal) ? t.decimal : 18,
    amount: msg.amount,
    priceKey: c && !fake ? `${c.llama}:${msg.token.toLowerCase()}` : "none:none",
  };
}

function sourceTx(row: HistoryRow): { hash: string; url: string } {
  const hash = row.src_block_tx_link?.match(/\/tx\/(0x[0-9a-fA-F]{64})\/?$/)?.[1];
  const explorer = evmChain(row.src_send_info.chain.id)?.chain.blockExplorers?.default.url;
  if (hash && explorer) return { hash, url: `${explorer}/tx/${hash}` };
  return { hash: row.transfer_id, url: `https://cbridge.celer.network` };
}

export async function checkCeler(user: Address): Promise<CheckOutput> {
  const out: CheckOutput = { findings: [], completed: 0 };
  for (const row of await history(user)) {
    if (row.status === COMPLETED || row.status === REFUNDED) {
      out.completed++;
      continue;
    }
    // Refunds waiting for the user. Other states (delayed, waiting for validators…) need no action,
    // and pegged-token transfers (bridge_type 2-5) use other contracts we don't double-check.
    if (![TO_BE_REFUNDED, REQUESTING_REFUND, REFUND_TO_BE_CONFIRMED].includes(row.status) || row.bridge_type !== LIQUIDITY_POOL) continue;
    const r = await refundState(row, user);
    if (r.kind === "paid") out.completed++;
    if (r.kind !== "claimable") continue;

    const src = row.src_send_info.chain.id;
    const dst = row.dst_received_info?.chain?.id;
    const asset = assetOf(row, r.msg);
    const tx = sourceTx(row);
    out.findings.push(
      makeFinding(CELER, {
        key: row.transfer_id,
        label: `cBridge · ${chainName(src)} → ${dst ? chainName(dst) : "?"}`,
        status: "ready",
        asset,
        txHash: tx.hash,
        txUrl: tx.url,
        timestamp: Math.floor(Number(row.ts) / 1000),
        note:
          `This transfer failed and was refunded on ${chainName(src)}, but the refund was never collected. ` +
          "Open cBridge's transfer history with this wallet and confirm the refund." +
          (asset.priceKey === "none:none" && looksFake(asset.symbol) ? " Warning: this token's symbol imitates a well-known token; it may be a scam token with no value." : ""),
      }),
    );
  }
  return out;
}
