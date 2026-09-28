import { isAddressEqual, parseAbi, zeroAddress, type Address, type Hex } from "viem";
import { l1Client } from "../clients";
import type { Asset, WithdrawalStatus } from "../types";
import { DAY, makeFinding, now, type CheckOutput, type FindingSource } from "./common";

/**
 * deBridge (DLN) cross-chain orders between Solana and Ethereum that are stuck:
 *   - never filled: the funds sit in the source contract until the order is cancelled
 *   - cancelled but the refund was never claimed on the source chain
 *
 * Orders come from deBridge's public API; whenever one side is Ethereum, its state is
 * double-checked on the DLN contracts there.
 */

export const DEBRIDGE: FindingSource = { id: "debridge", name: "deBridge", guideId: "debridge" };

const API = "https://stats-api.dln.trade/api";
const ETHEREUM = "1";
const SOLANA = "7565164";
const DLN_SOURCE: Address = "0xeF4fB24aD0916217251F553c0596F8Edc630EB66";
const DLN_DESTINATION: Address = "0xE7351Fd770A37282b91D153Ee690B63579D6dd7f";

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
    if (attempt >= 2 || (res && res.status < 500 && res.status !== 429)) throw new Error(`deBridge API: ${res ? `HTTP ${res.status}` : "unreachable"}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

const str = (v: Str | string | undefined) => (typeof v === "string" ? v : v?.stringValue);

function assetOf(o: Offer): Asset {
  const chain = o.chainId.stringValue;
  const token = o.tokenAddress.stringValue;
  const native = chain === ETHEREUM && isAddressEqual(token as Address, zeroAddress);
  return {
    symbol: o.symbol ?? "tokens",
    decimals: o.decimals ?? 18,
    amount: BigInt(o.amount.stringValue),
    priceKey: native ? "coingecko:ethereum" : `${chain === SOLANA ? "solana" : "ethereum"}:${chain === SOLANA ? token : token.toLowerCase()}`,
  };
}

/** Symbols made to look like well-known tokens (e.g. "USⅮΤ") are a common scam. */
const looksFake = (symbol?: string) => !!symbol && /[^\x20-\x7e]/.test(symbol);

export async function checkDebridge(user: Address): Promise<CheckOutput> {
  // `filter` matches the address as maker, receiver, or order authority (who can cancel);
  // the API also narrows down to stuck states on the Solana ↔ Ethereum routes.
  const candidates: ListedOrder[] = [];
  for (const [give, take] of [
    [SOLANA, ETHEREUM],
    [ETHEREUM, SOLANA],
  ]) {
    for (let skip = 0; skip < 500; skip += 100) {
      const { orders: page = [] } = await api<{ orders?: ListedOrder[] }>("/Orders/filteredList", {
        skip,
        take: 100,
        filter: user,
        orderStates: [...STUCK_STATES],
        giveChainIds: [Number(give)],
        takeChainIds: [Number(take)],
      });
      candidates.push(...page);
      if (page.length < 100) break;
    }
  }

  const out: CheckOutput = { findings: [], completed: 0 };
  for (const o of candidates) {
    const id = o.orderId.stringValue as Hex;
    const details = await api<OrderDetails>(`/Orders/${id}`);
    // Only orders the user funded, or can cancel (the refund goes back to the maker).
    const mine = [details.makerSrc, details.orderAuthorityAddressDst].some((a) => str(a)?.toLowerCase() === user.toLowerCase());
    if (!mine) continue;

    const give = o.giveOfferWithMetadata.chainId.stringValue;
    // Double-check the Ethereum side on-chain.
    if (give === ETHEREUM) {
      const [status] = await l1Client().readContract({ address: DLN_SOURCE, abi: dlnAbi, functionName: "giveOrders", args: [id] });
      if (status !== 1) {
        out.completed++; // unlocked or refunded
        continue;
      }
    } else if (o.state === "Created") {
      const [status] = await l1Client().readContract({ address: DLN_DESTINATION, abi: dlnAbi, functionName: "takeOrders", args: [id] });
      if (status !== 0) {
        out.completed++; // filled after all
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
        label: `deBridge · ${give === SOLANA ? "Solana → Ethereum" : "Ethereum → Solana"}`,
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
