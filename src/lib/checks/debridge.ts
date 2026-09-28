import { isAddressEqual, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import { evmChain, evmClient } from "../evm";
import type { Asset, WithdrawalStatus } from "../types";
import { DAY, makeFinding, now, type CheckOutput, type FindingSource } from "./common";

/**
 * deBridge (DLN) cross-chain orders that are stuck, on any route (EVM chains, Solana, Tron):
 *   - never filled: the funds sit in the source contract until the order is cancelled
 *   - cancelled but the refund was never claimed on the source chain
 *
 * Orders come from deBridge's public API; whenever a side is an EVM chain we can reach,
 * its state is double-checked on the DLN contracts there.
 */

export const DEBRIDGE: FindingSource = { id: "debridge", name: "deBridge", guideId: "debridge" };

const API = "https://stats-api.dln.trade/api";
const SOLANA = 7565164;
const TRON = 100000026;
/** Same addresses on every EVM chain deBridge supports, except the zkSync-based ones. */
const DLN_SOURCE: Address = "0xeF4fB24aD0916217251F553c0596F8Edc630EB66";
const DLN_DESTINATION: Address = "0xE7351Fd770A37282b91D153Ee690B63579D6dd7f";
/** zkSync-based chains, where the DLN contracts live at other addresses: no on-chain double-check. */
const NO_DLN = new Set([388, 2741, 50104]);

/**
 * deBridge gives chains added after 2023 an internal id (100000xxx) instead of their chain id.
 * Checked against the tokens of real orders on each chain (native coin, USDC…).
 */
const INTERNAL_IDS: Record<number, number> = {
  100000001: 245022934, // Neon
  100000002: 100, // Gnosis
  100000003: 1890, // LightLink
  100000004: 1088, // Metis
  100000005: 7171, // Bitrock
  100000006: 4158, // CrossFi
  100000008: 32769, // Zilliqa
  100000009: 747, // Flow EVM
  100000010: 388, // Cronos zkEVM
  100000013: 1514, // Story
  100000014: 146, // Sonic
  100000017: 2741, // Abstract
  100000019: 25, // Cronos
  100000020: 80094, // Berachain
  100000021: 60808, // BOB
  100000022: 999, // HyperEVM
  100000023: 5000, // Mantle
  100000024: 98866, // Plume
  100000025: 50104, // Sophon
  100000027: 1329, // Sei
  100000028: 9745, // Plasma
  100000029: 1776, // Injective
  100000030: 143, // Monad
  100000031: 4326, // MegaETH
};

/** EVM chain id of a deBridge chain id, when it's an EVM chain. */
const evmIdOf = (dlnId: number) => (dlnId === SOLANA || dlnId === TRON ? undefined : (INTERNAL_IDS[dlnId] ?? dlnId));

function chainName(dlnId: number) {
  if (dlnId === SOLANA) return "Solana";
  if (dlnId === TRON) return "Tron";
  const id = evmIdOf(dlnId)!;
  return evmChain(id)?.name ?? `chain ${id}`;
}

const dlnAbi = parseAbi([
  // status: 0 not set, 1 created (funds locked), 2 claimed unlock, 3 claimed cancel
  "function giveOrders(bytes32) view returns (uint8 status, uint160 giveTokenAddress, uint256 giveAmount)",
  // status: 0 not set (not filled), 1 fulfilled, 2 sent unlock, 3 sent cancel
  "function takeOrders(bytes32) view returns (uint8 status, address takerAddress, uint256 giveChainId)",
]);

const STUCK_STATES = new Set(["Created", "OrderCancelled", "SentOrderCancel"]);

type Str = { stringValue: string };
interface Offer {
  chainId: Str;
  tokenAddress: Str;
  amount: Str;
  symbol?: string;
  decimals?: number;
}
interface ListedOrder {
  orderId: Str;
  creationTimestamp: number;
  giveOfferWithMetadata: Offer;
  takeOfferWithMetadata: Offer;
  state: string;
  createEventTransactionHash?: Str | string;
}
interface OrderDetails {
  makerSrc?: Str;
  orderAuthorityAddressDst?: Str;
}

async function api<T>(path: string, body?: object): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (res?.ok) return (await res.json()) as T;
    if (attempt >= 4 || (res && res.status < 500 && res.status !== 429)) throw new Error(`deBridge API: ${res ? `HTTP ${res.status}` : "unreachable"}`);
    const retryAfter = Number(res?.headers.get("retry-after"));
    await new Promise((r) => setTimeout(r, retryAfter > 0 && retryAfter < 30 ? retryAfter * 1000 : 1000 * 2 ** attempt));
  }
}

const str = (v: Str | string | undefined) => (typeof v === "string" ? v : v?.stringValue);

function priceKey(dlnId: number, token: string) {
  if (dlnId === SOLANA) return token === "11111111111111111111111111111111" ? "coingecko:solana" : `solana:${token}`;
  const c = evmChain(evmIdOf(dlnId) ?? 0);
  if (!c || !/^0x[0-9a-fA-F]{40}$/.test(token)) return "none:none";
  return isAddressEqual(token as Address, zeroAddress) ? c.nativePrice : `${c.llama}:${token.toLowerCase()}`;
}

function assetOf(o: Offer): Asset {
  const token = o.tokenAddress.stringValue;
  return {
    symbol: o.symbol ?? "tokens",
    decimals: o.decimals ?? 18,
    amount: BigInt(o.amount.stringValue),
    priceKey: priceKey(Number(o.chainId.stringValue), token),
  };
}

/** A DLN contract read on an EVM chain; undefined when the chain can't be checked or doesn't answer. */
async function dlnStatus(dlnId: number, fn: "giveOrders" | "takeOrders", id: Hex): Promise<number | undefined> {
  const evmId = evmIdOf(dlnId);
  if (evmId === undefined || NO_DLN.has(evmId)) return undefined;
  const client = evmId === 1 ? l1Client() : evmClient(evmId);
  if (!client) return undefined;
  const address = fn === "giveOrders" ? DLN_SOURCE : DLN_DESTINATION;
  try {
    const [status] = await client.readContract({ address, abi: dlnAbi, functionName: fn, args: [id] });
    return status;
  } catch (e) {
    if (evmId === 1) throw e; // Ethereum must answer; other chains' public RPCs are best-effort
    return undefined;
  }
}

const sameAddress = (a: string | undefined, b: string) =>
  !!a && (b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Symbols made to look like well-known tokens (e.g. "USⅮΤ") are a common scam. */
const looksFake = (symbol?: string) => !!symbol && /[^\x20-\x7e]/.test(symbol);

/** `user` is an EVM or a Solana address (maker, or order authority on the destination). */
export async function checkDebridge(user: string): Promise<CheckOutput> {
  // `filter` matches the address as maker, receiver, or order authority (who can cancel);
  // the API also narrows down to stuck states.
  const candidates: ListedOrder[] = [];
  for (let skip = 0; skip < 500; skip += 100) {
    const { orders: page = [] } = await api<{ orders?: ListedOrder[] }>("/Orders/filteredList", {
      skip,
      take: 100,
      filter: user,
      orderStates: [...STUCK_STATES],
    });
    candidates.push(...page);
    if (page.length < 100) break;
  }

  const out: CheckOutput = { findings: [], completed: 0 };
  for (const o of candidates) {
    const id = o.orderId.stringValue as Hex;
    const details = await api<OrderDetails>(`/Orders/${id}`);
    // Only orders the user funded, or can cancel (the refund goes back to the maker).
    const mine = [details.makerSrc, details.orderAuthorityAddressDst].some((a) => sameAddress(str(a), user));
    if (!mine) continue;

    const give = Number(o.giveOfferWithMetadata.chainId.stringValue);
    const take = Number(o.takeOfferWithMetadata.chainId.stringValue);
    // Double-check on-chain: the funds must still be locked on the source chain…
    const giveStatus = await dlnStatus(give, "giveOrders", id);
    if (giveStatus !== undefined && giveStatus !== 1) {
      out.completed++; // unlocked or refunded
      continue;
    }
    // …and an order the API still shows as open must not have been filled since.
    if (o.state === "Created") {
      const takeStatus = await dlnStatus(take, "takeOrders", id);
      if (takeStatus !== undefined && takeStatus !== 0) {
        out.completed++;
        continue;
      }
    }

    const age = now() - o.creationTimestamp;
    const cancelled = o.state !== "Created";
    const status: WithdrawalStatus = !cancelled && age < DAY ? "recent" : "ready";
    const asset = assetOf(o.giveOfferWithMetadata);
    const tx = str(o.createEventTransactionHash);
    const fake = looksFake(asset.symbol);
    out.findings.push(
      makeFinding(DEBRIDGE, {
        key: id,
        label: `deBridge · ${chainName(give)} → ${chainName(take)}`,
        status,
        asset: fake ? { ...asset, priceKey: "none:none" } : asset,
        txHash: tx ?? id,
        txUrl: `https://app.debridge.finance/order?orderId=${id}`,
        timestamp: o.creationTimestamp,
        note:
          (cancelled
            ? "The order was cancelled but the refund was never claimed on the source chain. Claim it on deBridge."
            : "This order was never filled. Cancel it on deBridge to get the funds back on the source chain.") +
          (fake ? " Warning: this token's symbol imitates a well-known token; it may be a scam token with no value." : ""),
      }),
    );
  }
  return out;
}
