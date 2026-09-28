import type { Hex } from "viem";
import type { Network } from "../networks";
import type { Asset, Finding, WithdrawalStatus } from "../types";

export const DAY = 86_400;
export const now = () => Math.floor(Date.now() / 1000);

export interface CheckOutput {
  findings: Finding[];
  completed: number;
}

export function makeFinding(
  net: Network,
  p: {
    key: string;
    status: WithdrawalStatus;
    asset: Asset;
    txHash: Hex;
    timestamp: number;
    readyAt?: number;
    note?: string;
  },
): Finding {
  return {
    id: `${net.id}:${p.txHash}:${p.key}`,
    networkId: net.id,
    networkName: net.name,
    guideId: net.guideId,
    status: p.status,
    asset: p.asset,
    txHash: p.txHash,
    txUrl: `${net.explorer}/tx/${p.txHash}`,
    timestamp: p.timestamp,
    readyAt: p.readyAt,
    note: p.note,
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
