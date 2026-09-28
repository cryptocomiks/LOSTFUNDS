import { pad, type Address, type Hex } from "viem";
import type { Network } from "./networks";
import type { ApiLog } from "./types";

export type LogSource = Pick<Network, "name" | "chain" | "blockscout">;

/** Optional: an Etherscan V2 key is used as a fallback when Blockscout is unavailable. */
const ETHERSCAN_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY ?? "";

export type Topics = [Hex, (Hex | null)?, (Hex | null)?, (Hex | null)?];

export const addressTopic = (a: Address) => pad(a, { size: 32 }).toLowerCase() as Hex;

const PAGE = 1000;
const MAX_PAGES = 10;

interface RawLog {
  address: string;
  topics: (string | null)[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  timeStamp: string;
}

function buildParams(address: Address, topics: Topics, fromBlock: bigint) {
  const p = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: fromBlock.toString(),
    toBlock: "latest",
    address,
  });
  const set = topics.map((t, i) => [t, i] as const).filter(([t]) => t);
  for (const [t, i] of set) p.set(`topic${i}`, t!);
  // Blockscout / Etherscan need an explicit operator between each pair of topics.
  for (let a = 0; a < set.length; a++)
    for (let b = a + 1; b < set.length; b++) p.set(`topic${set[a][1]}_${set[b][1]}_opr`, "and");
  return p;
}

/**
 * Free explorer APIs rate-limit per IP, so requests to each host go through a small
 * queue: at most 3 in flight, spaced out, retried with backoff on 429 / 5xx.
 */
const MAX_IN_FLIGHT = 3;
const SPACING_MS = 300;
const RETRIES = 3;
const hosts = new Map<string, { active: number; last: number; waiting: (() => void)[] }>();

async function withHostSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
  let h = hosts.get(host);
  if (!h) hosts.set(host, (h = { active: 0, last: 0, waiting: [] }));
  while (h.active >= MAX_IN_FLIGHT) await new Promise<void>((r) => h!.waiting.push(r));
  h.active++;
  const wait = h.last + SPACING_MS - Date.now();
  h.last = Math.max(Date.now(), h.last + SPACING_MS);
  if (wait > 0) await sleep(wait);
  try {
    return await fn();
  } finally {
    h.active--;
    h.waiting.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RetryableError extends Error {}

async function fetchOnce(url: string): Promise<RawLog[]> {
  // No client-side timeout: full-history searches on free explorers can legitimately take a while.
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (e) {
    // Rate-limit replies often lack CORS headers and surface as a network error.
    throw new RetryableError(`network error (${(e as Error).message || (e as Error).name})`);
  }
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as { status?: string; message?: string; result?: unknown };
  if (Array.isArray(json.result)) return json.result as RawLog[];
  // "No logs found" / "No records found" come back as status 0 with an empty result.
  if (json.status === "0" && /no (logs|records)/i.test(json.message ?? "")) return [];
  const msg = typeof json.result === "string" ? json.result : json.message || "bad response";
  if (/rate|too many|busy|try again/i.test(msg)) throw new RetryableError(msg);
  throw new Error(msg);
}

async function fetchPage(url: string): Promise<RawLog[]> {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    try {
      return await withHostSlot(host, () => fetchOnce(url));
    } catch (e) {
      if (!(e instanceof RetryableError) || attempt >= RETRIES) throw e;
      await sleep(800 * 2 ** attempt + Math.random() * 400);
    }
  }
}

async function query(makeUrl: (from: bigint) => string): Promise<ApiLog[]> {
  const out: ApiLog[] = [];
  const seen = new Set<string>();
  let from = 0n;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await fetchPage(makeUrl(from));
    for (const l of raw) {
      const key = `${l.transactionHash}:${l.topics.join()}:${l.data}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        address: l.address.toLowerCase() as Address,
        topics: l.topics.filter(Boolean) as Hex[],
        data: l.data as Hex,
        transactionHash: l.transactionHash as Hex,
        blockNumber: BigInt(l.blockNumber),
        timestamp: Number(BigInt(l.timeStamp)),
      });
    }
    if (raw.length < PAGE) break;
    // Continue from the last block seen (duplicates are skipped above).
    from = BigInt(raw[raw.length - 1].blockNumber);
  }
  return out;
}

/**
 * All logs of `address` matching `topics`, over the chain's whole history.
 * Blockscout first (free, keyless, CORS-enabled); Etherscan V2 if a key is configured.
 */
export async function getLogs(net: LogSource, address: Address, topics: Topics): Promise<ApiLog[]> {
  const sources: ((from: bigint) => string)[] = [
    (from) => `${net.blockscout}/api?${buildParams(address, topics, from)}`,
  ];
  if (ETHERSCAN_KEY)
    sources.push((from) => {
      const p = buildParams(address, topics, from);
      p.set("chainid", String(net.chain.id));
      p.set("apikey", ETHERSCAN_KEY);
      return `https://api.etherscan.io/v2/api?${p}`;
    });

  let lastError: unknown;
  for (const src of sources) {
    try {
      return await query(src);
    } catch (e) {
      lastError = e;
    }
  }
  const host = new URL(net.blockscout).host;
  throw new Error(`${host}: ${(lastError as Error)?.message ?? "unknown error"}`);
}

/** Unique tx hashes of a set of logs, with the tx timestamp. */
export function uniqueTxs(logs: ApiLog[]): Map<Hex, number> {
  const m = new Map<Hex, number>();
  for (const l of logs) m.set(l.transactionHash, l.timestamp);
  return m;
}
