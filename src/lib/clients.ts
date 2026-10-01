import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { L1, type Network } from "./networks";

const cache = new Map<string, PublicClient>();

const transport = (rpcs: string[]) =>
  fallback(
    rpcs.map((url) => http(url, { timeout: 15_000, retryCount: 1, batch: { wait: 16 } })),
    { rank: false },
  );

export function l1Client(): PublicClient {
  let c = cache.get("l1");
  if (!c) {
    c = createPublicClient({
      chain: L1.chain,
      transport: transport(L1.rpcs),
      batch: { multicall: { wait: 16 } },
    }) as PublicClient;
    cache.set("l1", c);
  }
  return c;
}

/**
 * For large multicalls on Ethereum: no JSON-RPC batching, so a big read travels alone in its own
 * HTTP request instead of swelling a shared batch past the nodes' request-size limit (about 1 MB
 * on publicnode; drpc refuses batches of more than 3 requests).
 */
export function l1BulkClient(): PublicClient {
  let c = cache.get("l1-bulk");
  if (!c) {
    c = createPublicClient({
      chain: L1.chain,
      transport: fallback(
        L1.rpcs.map((url) => http(url, { timeout: 20_000, retryCount: 1 })),
        { rank: false },
      ),
    }) as PublicClient;
    cache.set("l1-bulk", c);
  }
  return c;
}

export function l2Client(net: Network): PublicClient {
  let c = cache.get(net.id);
  if (!c) {
    c = createPublicClient({ chain: net.chain, transport: transport(net.rpcs) }) as PublicClient;
    cache.set(net.id, c);
  }
  return c;
}
