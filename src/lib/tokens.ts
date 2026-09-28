import { erc20Abi, hexToString, parseAbi, type Address, type PublicClient } from "viem";
import type { Asset } from "./types";

const bytes32SymbolAbi = parseAbi(["function symbol() view returns (bytes32)"]);

const metaCache = new Map<string, Promise<{ symbol: string; decimals: number } | null>>();

async function readMeta(client: PublicClient, token: Address) {
  const [decimals, symbol] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    client
      .readContract({ address: token, abi: erc20Abi, functionName: "symbol" })
      .catch(async () => {
        // Some old tokens (MKR, SAI…) return bytes32.
        const raw = await client.readContract({ address: token, abi: bytes32SymbolAbi, functionName: "symbol" });
        return hexToString(raw, { size: 32 }).replace(/\0/g, "");
      }),
  ]);
  return { symbol: symbol || "tokens", decimals: Number(decimals) };
}

/** Token symbol/decimals, looked up on each client in turn (e.g. L2 first, then L1). */
export function tokenMeta(clients: PublicClient[], token: Address) {
  const key = `${clients.map((c) => c.chain?.id).join(",")}:${token.toLowerCase()}`;
  let p = metaCache.get(key);
  if (!p) {
    p = (async () => {
      for (const c of clients) {
        try {
          return await readMeta(c, token);
        } catch {
          /* try next chain */
        }
      }
      return null;
    })();
    metaCache.set(key, p);
  }
  return p;
}

export const ethAsset = (amount: bigint): Asset => ({ symbol: "ETH", decimals: 18, amount });

export async function tokenAsset(
  clients: PublicClient[],
  token: Address,
  amount: bigint,
  tokenChain: string,
): Promise<Asset> {
  const meta = await tokenMeta(clients, token);
  return {
    symbol: meta?.symbol ?? "tokens",
    decimals: meta?.decimals ?? 18,
    amount,
    token,
    tokenChain,
  };
}

/** Best-effort USD prices from DefiLlama (keyless, CORS-enabled). Never throws. */
export async function addPrices(assets: Asset[]): Promise<void> {
  const keyOf = (a: Asset) =>
    a.token ? `${a.tokenChain ?? "ethereum"}:${a.token.toLowerCase()}` : "coingecko:ethereum";
  const keys = [...new Set(assets.map(keyOf))];
  if (!keys.length) return;
  try {
    const res = await fetch(`https://coins.llama.fi/prices/current/${keys.join(",")}`);
    if (!res.ok) return;
    const { coins } = (await res.json()) as { coins: Record<string, { price: number }> };
    for (const a of assets) {
      const price = coins[keyOf(a)]?.price;
      if (price) a.usd = (Number(a.amount) / 10 ** a.decimals) * price;
    }
  } catch {
    /* prices are optional */
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
