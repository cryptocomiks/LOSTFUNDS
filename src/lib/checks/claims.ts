import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError, type Address, type Hex, type PublicClient } from "viem";
import type { FindingSource } from "./common";

/**
 * Shared by the "Unclaimed rewards & withdrawals" checks. Every amount they report has been
 * confirmed by a dry run of the exact transaction the user would send (claim, withdraw,
 * vest…), from the user's own address: a view alone can show a balance a contract won't pay.
 */

/** Findings worth less than this (USD) are hidden: claiming them would cost about as much in gas. */
export const DUST_ETHEREUM = 5;
export const DUST_L2 = 1;

export const ETHERSCAN = "https://etherscan.io";

/** Where a rewards check's findings come from; they all open the rewards guide. */
export const rewardSource = (id: string, name: string, explorer = ETHERSCAN): FindingSource => ({ id, name, guideId: "rewards", explorer });

const isRevert = (e: unknown) =>
  e instanceof BaseError && !!e.walk((x) => x instanceof ExecutionRevertedError || x instanceof ContractFunctionRevertedError);

/**
 * Runs a transaction from `from` as an eth_call, without sending anything. Returns what it would
 * return, or null if the contract rejects it. Any other failure (node down, rate limit…) is
 * thrown: it says nothing about the claim.
 */
export async function dryRun(client: PublicClient, tx: { from: Address; to: Address; data: Hex; gas?: bigint }): Promise<Hex | null> {
  try {
    const { data } = await client.call({ account: tx.from, to: tx.to, data: tx.data, gas: tx.gas ?? 3_000_000n });
    return data ?? "0x";
  } catch (e) {
    if (isRevert(e)) return null;
    throw e;
  }
}

/**
 * Runs the same transaction `times` times in a row in one simulated block (eth_simulateV1), each
 * run seeing the state the previous one left. Returns each run's return data, and null from the
 * first rejected one on. Undefined if the nodes can't simulate blocks (not all support it).
 */
export async function dryRunRepeated(
  client: PublicClient,
  tx: { from: Address; to: Address; data: Hex },
  times: number,
): Promise<(Hex | null)[] | undefined> {
  try {
    const [block] = await client.simulateBlocks({
      blocks: [{ calls: Array.from({ length: times }, () => ({ account: tx.from, to: tx.to, data: tx.data })) }],
    });
    let rejected = false;
    return block.calls.map((c) => ((rejected ||= c.status !== "success") ? null : c.data));
  } catch {
    return undefined;
  }
}
