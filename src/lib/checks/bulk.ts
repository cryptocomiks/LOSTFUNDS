import type { ContractFunctionParameters } from "viem";
import { l1BulkClient } from "../clients";
import { mapLimit } from "../tokens";

/** Reads per eth_call: about 300 KB of request, far below the public nodes' size and gas limits. */
export const READS_PER_CALL = 700;

/**
 * Many contract reads on Ethereum, through Multicall3, in as few eth_calls as possible (one for up to
 * READS_PER_CALL reads). Any failure throws: a read that didn't happen must never look like "nothing found".
 */
export async function bulkRead(calls: readonly ContractFunctionParameters[]): Promise<unknown[]> {
  const chunks: ContractFunctionParameters[][] = [];
  for (let i = 0; i < calls.length; i += READS_PER_CALL) chunks.push(calls.slice(i, i + READS_PER_CALL));
  const results = await mapLimit(chunks, 3, (chunk) => l1BulkClient().multicall({ contracts: chunk, allowFailure: false, batchSize: 0 }));
  return results.flat() as unknown[];
}
