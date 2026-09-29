import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError, type Address, type Hex, type PublicClient } from "viem";

/**
 * Runs a transaction as an eth_call, without sending anything.
 * True if it would go through, false if the contract rejects it (reverts).
 * Any other failure (node down, timeout…) is thrown: it says nothing about the claim.
 */
export async function wouldSucceed(client: PublicClient, tx: { from: Address; to: Address; data: Hex }): Promise<boolean> {
  try {
    await client.call({ account: tx.from, to: tx.to, data: tx.data, gas: 3_000_000n });
    return true;
  } catch (e) {
    const reverted =
      e instanceof BaseError && e.walk((x) => x instanceof ExecutionRevertedError || x instanceof ContractFunctionRevertedError);
    if (reverted) return false;
    throw e;
  }
}
