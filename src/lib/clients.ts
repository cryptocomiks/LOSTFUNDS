import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { L1, type Network } from "./networks";

const cache = new Map<string, PublicClient>();

const transport = (rpcs: string[]) =>
  fallback(
    rpcs.map((url) => http(url, { timeout: 15_000, retryCount: 2, retryDelay: 400, batch: { wait: 16 } })),
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

export function l2Client(net: Network): PublicClient {
  let c = cache.get(net.id);
  if (!c) {
    c = createPublicClient({ chain: net.chain, transport: transport(net.rpcs) }) as PublicClient;
    cache.set(net.id, c);
  }
  return c;
}
