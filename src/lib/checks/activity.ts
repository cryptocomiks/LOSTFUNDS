import type { Address } from "viem";
import { l2Client } from "../clients";
import type { Network } from "../networks";

/**
 * True when `user` has provably never sent a transaction on this network: nonce 0 and no
 * contract code (smart-contract wallets like Safes keep nonce 0 while their owners transact,
 * and EIP-7702 accounts have code, so neither is ever skipped).
 *
 * Withdrawal checks that look for transactions the user sent can then stop after one batched
 * RPC call instead of searching explorers — most visitors have never used most networks, so this
 * saves dozens of requests per visit. Any doubt (RPC error) returns false: the full check runs.
 */
export async function neverActive(net: Network, user: Address): Promise<boolean> {
  try {
    const c = l2Client(net);
    const [nonce, code] = await Promise.all([c.getTransactionCount({ address: user }), c.getCode({ address: user })]);
    return nonce === 0 && (!code || code === "0x");
  } catch {
    return false;
  }
}
