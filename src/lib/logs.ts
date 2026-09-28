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

async function fetchPage(url: string): Promise<RawLog[]> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { status?: string; message?: string; result?: unknown };
  if (Array.isArray(json.result)) return json.result as RawLog[];
  // "No logs found" / "No records found" come back as status 0 with an empty result.
  if (json.status === "0" && /no (logs|records)/i.test(json.message ?? "")) return [];
  throw new Error(typeof json.result === "string" ? json.result : json.message || "Bad response");
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
  throw new Error(`Couldn't search ${net.name} history (${(lastError as Error)?.message ?? "unknown error"})`);
}

/** Unique tx hashes of a set of logs, with the tx timestamp. */
export function uniqueTxs(logs: ApiLog[]): Map<Hex, number> {
  const m = new Map<Hex, number>();
  for (const l of logs) m.set(l.transactionHash, l.timestamp);
  return m;
}
