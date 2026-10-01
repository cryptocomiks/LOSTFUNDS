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

/* ───────────── Prices (DefiLlama, keyless, CORS-enabled) ───────────── */

const priceKeyOf = (a: Asset) =>
  a.priceKey ?? (a.token ? `${a.tokenChain ?? "ethereum"}:${a.token.toLowerCase()}` : "coingecko:ethereum");

/**
 * One price lookup per key per page session, and lookups made within a few milliseconds of each
 * other (every check finishing at once) go out as one request: a visitor checking a wallet sends
 * a handful of price requests instead of one per check.
 */
const prices = new Map<string, Promise<number | undefined>>();
let queued = new Map<string, ((p: number | undefined) => void)[]>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const PRICE_BATCH = 80; // keys per request (keeps the URL short)

async function fetchPrices(keys: string[]): Promise<Record<string, { price: number }>> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`https://coins.llama.fi/prices/current/${keys.join(",")}`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return ((await res.json()) as { coins: Record<string, { price: number }> }).coins ?? {};
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt >= 2 || (e as Error).message.startsWith("HTTP")) throw e;
    }
    if (attempt >= 2) throw new Error("prices unavailable");
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt + Math.random() * 400));
  }
}

function flushPrices() {
  flushTimer = undefined;
  const batch = queued;
  queued = new Map();
  const keys = [...batch.keys()];
  for (let i = 0; i < keys.length; i += PRICE_BATCH) {
    const chunk = keys.slice(i, i + PRICE_BATCH);
    fetchPrices(chunk).then(
      (coins) =>
        chunk.forEach((k) => {
          const price = coins[k]?.price;
          if (!price) prices.delete(k); // only real prices are remembered: a missing one may appear later
          batch.get(k)!.forEach((resolve) => resolve(price));
        }),
      () =>
        chunk.forEach((k) => {
          prices.delete(k); // a failed lookup is retried by the next check
          batch.get(k)!.forEach((resolve) => resolve(undefined));
        }),
    );
  }
}

function priceOf(key: string): Promise<number | undefined> {
  if (key === "none:none") return Promise.resolve(undefined); // deliberately unpriced (e.g. look-alike scam tokens)
  let p = prices.get(key);
  if (!p) {
    p = new Promise((resolve) => {
      const waiting = queued.get(key);
      if (waiting) waiting.push(resolve);
      else queued.set(key, [resolve]);
      flushTimer ??= setTimeout(flushPrices, 30);
    });
    prices.set(key, p);
  }
  return p;
}

/** Forgets every remembered price (tests that change prices between lookups). */
export function resetPriceCache() {
  prices.clear();
}

/** Best-effort USD values (sets `usd` on each asset it can price). Never throws. */
export async function addPrices(assets: Asset[]): Promise<void> {
  await Promise.all(
    assets.map(async (a) => {
      const price = await priceOf(priceKeyOf(a));
      if (price) a.usd = (Number(a.amount) / 10 ** a.decimals) * price;
    }),
  );
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
