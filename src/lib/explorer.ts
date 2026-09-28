import { getAddress, pad, type Address, type Hex } from "viem";
import type { Network } from "./networks";
import type { ApiLog } from "./types";

/**
 * Reads chain history from free, Etherscan-compatible explorer APIs.
 * Several sources are tried in order, so one busy explorer doesn't fail the check:
 *   1. Blockscout (keyless)
 *   2. Routescan (keyless)
 *   3. Etherscan V2 (only if NEXT_PUBLIC_ETHERSCAN_API_KEY is set)
 */

export type ExplorerTarget = Pick<Network, "name" | "chain" | "blockscout">;
export type Topics = [Hex, (Hex | null)?, (Hex | null)?, (Hex | null)?];

const ETHERSCAN_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY ?? "";

export const addressTopic = (a: Address) => pad(a, { size: 32 }).toLowerCase() as Hex;

interface Source {
  name: string;
  url: (params: URLSearchParams) => string;
}

function sources(net: ExplorerTarget): Source[] {
  const id = net.chain.id;
  const list: Source[] = [
    { name: new URL(net.blockscout).host, url: (p) => `${net.blockscout}/api?${p}` },
    {
      name: "routescan",
      url: (p) => `https://api.routescan.io/v2/network/mainnet/evm/${id}/etherscan/api?${p}`,
    },
  ];
  if (ETHERSCAN_KEY)
    list.push({
      name: "etherscan",
      url: (p) => {
        const q = new URLSearchParams(p);
        q.set("chainid", String(id));
        q.set("apikey", ETHERSCAN_KEY);
        return `https://api.etherscan.io/v2/api?${q}`;
      },
    });
  return list;
}

/* ───────────── Polite fetching: per-host queue + retry with backoff ───────────── */

const MAX_IN_FLIGHT = 3;
const SPACING_MS = 300;
const RETRIES = 2;
const hosts = new Map<string, { active: number; last: number; waiting: (() => void)[] }>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

class RetryableError extends Error {}

async function fetchOnce<T>(url: string): Promise<T[]> {
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
  if (Array.isArray(json.result)) return json.result as T[];
  // "No logs found" / "No transactions found" come back as status 0 with an empty result.
  if (json.status === "0" && /^no .*found/i.test(json.message ?? "")) return [];
  const msg = typeof json.result === "string" ? json.result : json.message || "bad response";
  if (/rate|too many|busy|try again/i.test(msg)) throw new RetryableError(msg);
  throw new Error(msg);
}

async function fetchResult<T>(url: string): Promise<T[]> {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    try {
      return await withHostSlot(host, () => fetchOnce<T>(url));
    } catch (e) {
      if (!(e instanceof RetryableError) || attempt >= RETRIES) throw e;
      await sleep(800 * 2 ** attempt + Math.random() * 400);
    }
  }
}

/** Runs `fn` against each source until one succeeds. */
async function firstSuccess<R>(net: ExplorerTarget, fn: (src: Source) => Promise<R>): Promise<R> {
  const errors: string[] = [];
  for (const src of sources(net)) {
    try {
      return await fn(src);
    } catch (e) {
      errors.push(`${src.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(errors.join(" · "));
}

/* ───────────── Logs ───────────── */

interface RawLog {
  address: string;
  topics: (string | null)[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  timeStamp: string;
}

const PAGE = 1000;
const MAX_PAGES = 10;

function logParams(address: Address, topics: Topics, fromBlock: bigint) {
  const p = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: fromBlock.toString(), toBlock: "latest", address });
  const set = topics.map((t, i) => [t, i] as const).filter(([t]) => t);
  for (const [t, i] of set) p.set(`topic${i}`, t!);
  // Explorers need an explicit operator between each pair of topics.
  for (let a = 0; a < set.length; a++)
    for (let b = a + 1; b < set.length; b++) p.set(`topic${set[a][1]}_${set[b][1]}_opr`, "and");
  return p;
}

/** All logs of `address` matching `topics`, over the chain's whole history. */
export function getLogs(net: ExplorerTarget, address: Address, topics: Topics): Promise<ApiLog[]> {
  return firstSuccess(net, async (src) => {
    const out: ApiLog[] = [];
    const seen = new Set<string>();
    let from = 0n;
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await fetchResult<RawLog>(src.url(logParams(address, topics, from)));
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
      from = BigInt(raw[raw.length - 1].blockNumber); // duplicates are skipped above
    }
    return out;
  });
}

/* ───────────── Transactions sent by an address ───────────── */

interface RawTx {
  hash: string;
  from: string;
  to: string | null;
  isError?: string;
  txreceipt_status?: string;
  timeStamp: string;
}

/**
 * Transactions `user` sent to one of `targets`, with their timestamps.
 * Uses the explorer's per-address index: one or two requests, even for an old wallet.
 */
export function getTxsTo(net: ExplorerTarget, user: Address, targets: Address[]): Promise<Map<Hex, number>> {
  const want = new Set(targets.map((t) => t.toLowerCase()));
  const me = user.toLowerCase();
  return firstSuccess(net, async (src) => {
    const found = new Map<Hex, number>();
    for (let page = 1; page <= 10; page++) {
      const p = new URLSearchParams({
        module: "account",
        action: "txlist",
        address: getAddress(user),
        startblock: "0",
        endblock: "99999999999",
        page: String(page),
        offset: String(PAGE),
        sort: "asc",
      });
      const raw = await fetchResult<RawTx>(src.url(p));
      for (const tx of raw) {
        if (tx.from?.toLowerCase() !== me || !tx.to || !want.has(tx.to.toLowerCase())) continue;
        if (tx.isError === "1" || tx.txreceipt_status === "0") continue;
        found.set(tx.hash as Hex, Number(BigInt(tx.timeStamp)));
      }
      if (raw.length < PAGE) break;
    }
    return found;
  });
}

/**
 * Finds the user's bridge withdrawal transactions on a network.
 * Fast path: the user's own transaction list, filtered to the bridge contracts.
 * Fallback: searching the bridge contracts' event logs for the user's address.
 */
export async function findBridgeTxs(
  net: ExplorerTarget,
  user: Address,
  opts: { targets: Address[]; logs: [Address, Topics][] },
): Promise<Map<Hex, number>> {
  try {
    return await getTxsTo(net, user, opts.targets);
  } catch (txErr) {
    try {
      const logs = (await Promise.all(opts.logs.map(([a, t]) => getLogs(net, a, t)))).flat();
      const m = new Map<Hex, number>();
      for (const l of logs) m.set(l.transactionHash, l.timestamp);
      return m;
    } catch (logErr) {
      throw new Error(`${(txErr as Error).message} | logs: ${(logErr as Error).message}`);
    }
  }
}
