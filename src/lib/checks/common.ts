import type { Network } from "../networks";
import type { Asset, Finding, WithdrawalStatus } from "../types";

export const DAY = 86_400;
export const now = () => Math.floor(Date.now() / 1000);

export interface CheckOutput {
  findings: Finding[];
  completed: number;
  /** Part of the check failed: the findings are shown, but the check reads as incomplete. */
  error?: string;
}

/** What a finding needs to know about where it was found (a network or a bridge route). */
export type FindingSource = Pick<Network, "id" | "name" | "guideId"> & { explorer?: string };

export function makeFinding(
  net: FindingSource,
  p: {
    key: string;
    status: WithdrawalStatus;
    asset: Asset;
    txHash: string;
    timestamp: number;
    readyAt?: number;
    note?: string;
    /** Overrides the default `${explorer}/tx/${txHash}` link. */
    txUrl?: string;
    /** Overrides the source's display name (e.g. "Wormhole · Solana → Ethereum"). */
    label?: string;
    /** Where to claim, when it isn't the source's own bridge app. */
    claimAt?: string;
    /** Hide the finding when it's worth less than this many dollars (dust). */
    minUsd?: number;
    /** What `timestamp` is (default "Sent"), e.g. "Requested" or "Lock ended". */
    dateLabel?: string;
  },
): Finding {
  return {
    id: `${net.id}:${p.txHash}:${p.key}`,
    networkId: net.id,
    networkName: p.label ?? net.name,
    guideId: net.guideId,
    status: p.status,
    asset: p.asset,
    txHash: p.txHash,
    txUrl: p.txUrl ?? `${net.explorer}/tx/${p.txHash}`,
    timestamp: p.timestamp,
    dateLabel: p.dateLabel,
    readyAt: p.readyAt,
    note: p.note,
    claimAt: p.claimAt,
    minUsd: p.minUsd,
  };
}

/**
 * Status for a withdrawal that has not been claimed yet, for bridges whose only
 * remaining step is a claim that becomes possible `finality` seconds after the
 * withdrawal was sent.
 */
export function unclaimedStatus(timestamp: number, finality: number): { status: WithdrawalStatus; readyAt?: number } {
  const readyAt = timestamp + finality;
  if (now() >= readyAt) return { status: "ready" };
  return { status: now() - timestamp < 7 * DAY ? "recent" : "waiting", readyAt };
}
