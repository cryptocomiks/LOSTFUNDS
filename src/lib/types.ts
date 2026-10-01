import type { Address, Hex } from "viem";

/**
 * Where a withdrawal stands.
 * - ready:   the last step can be done right now (finalize / claim / execute).
 * - prove:   OP Stack only: needs a "prove" tx, then ~7 days, then finalize.
 * - waiting: inside the challenge / finality window; claimable after `readyAt`.
 * - recent:  started less than a week ago, most likely still in progress.
 * - manual:  legacy format we can't verify automatically; check it by hand.
 */
export type WithdrawalStatus = "ready" | "prove" | "waiting" | "recent" | "manual";

export interface Asset {
  symbol: string;
  decimals: number;
  amount: bigint;
  /** Token address (undefined for ETH). */
  token?: Address;
  /** Chain the token address lives on, used for prices. */
  tokenChain?: string;
  /** Explicit DefiLlama price key (e.g. "solana:<mint>"), overrides token/tokenChain. */
  priceKey?: string;
  usd?: number;
}

export interface Finding {
  id: string;
  networkId: string;
  networkName: string;
  guideId: string;
  status: WithdrawalStatus;
  asset: Asset;
  txHash: string;
  txUrl: string;
  /** Unix seconds of the withdrawal tx on the source chain. */
  timestamp: number;
  /** Unix seconds when the withdrawal becomes claimable (status "waiting"). */
  readyAt?: number;
  note?: string;
  /** Where to claim, when it isn't the source's own bridge app (e.g. one airdrop among several). */
  claimAt?: string;
  /** Hidden when its USD value is known and below this (dust). Unpriced findings are always shown. */
  minUsd?: number;
}

export type NetworkCheckState = "queued" | "running" | "done" | "error";

export interface NetworkResult {
  networkId: string;
  state: NetworkCheckState;
  findings: Finding[];
  /** Withdrawals found that were already completed. */
  completed: number;
  error?: string;
}

/** A raw log as returned by the Blockscout / Etherscan logs API. */
export interface ApiLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  transactionHash: Hex;
  blockNumber: bigint;
  timestamp: number;
}
