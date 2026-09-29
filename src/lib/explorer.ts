import { getAddress, pad, type Address, type Hex } from "viem";
import type { Network } from "./networks";
import type { ApiLog } from "./types";

/**
 * Reads chain history from free sources, trying each in turn so one busy or
 * broken source doesn't fail the check:
 *   - Blockscout's Etherscan-compatible API, then its v2 REST API (keyless)
 *   - the network's own RPC node, for event searches over the whole history,
 *     on nodes that allow it (`logsRpc`)
 *   - Etherscan V2, only if NEXT_PUBLIC_ETHERSCAN_API_KEY is set
 */

export type ExplorerTarget = Pick<Network, "name" | "chain" | "blockscout" | "logsRpcs" | "api"> & {
  /** Try the RPC nodes before the explorer (much faster for busy contracts). */
  preferRpc?: boolean;
};
export type Topics = [Hex, (Hex | null)?, (Hex | null)?, (Hex | null)?];

const ETHERSCAN_KEY = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY ?? "";

export const addressTopic = (a: Address) => pad(a, { size: 32 }).toLowerCase() as Hex;

/** Etherscan-compatible APIs (same query string, different base URL). */
function apiSources(net: ExplorerTarget): { name: string; url: (p: URLSearchParams) => string }[] {
  const list: { name: string; url: (p: URLSearchParams) => string }[] = [];
  if (net.blockscout) list.push({ name: new URL(net.blockscout).host, url: (p) => `${net.blockscout}/api?${p}` });
  if (net.api) list.push({ name: new URL(net.api).host, url: (p) => `${net.api}/api?${p}` });
  if (ETHERSCAN_KEY)
    list.push({
      name: "etherscan",
      url: (p) => {
        const q = new URLSearchParams(p);
        q.set("chainid", String(net.chain.id));
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

const TIMEOUT_MS = 20_000;

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { accept: "application/json", ...init?.headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const err = e as Error;
    // A source that doesn't answer in time is skipped, not retried.
    if (err.name === "TimeoutError" || err.name === "AbortError") throw new Error("no answer (timeout)");
    // Rate-limit replies often lack CORS headers and surface as a network error.
    throw new RetryableError(`network error (${err.message || err.name})`);
  }
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json().catch(() => {
    throw new Error("not JSON");
  });
}

async function fetchOnce<T>(url: string): Promise<T[]> {
  const json = (await fetchJson(url)) as { status?: string; message?: string; result?: unknown };
  if (Array.isArray(json.result)) return json.result as T[];
  // "No logs found" / "No transactions found" come back as status 0 with an empty result.
  if (json.status === "0" && /^no .*found/i.test(json.message ?? "")) return [];
  const msg = typeof json.result === "string" ? json.result : json.message || "bad response";
  if (/rate|too many|busy|try again/i.test(msg)) throw new RetryableError(msg);
  throw new Error(msg);
}

/** Queued + retried request. */
async function polite<T>(url: string, run: () => Promise<T>): Promise<T> {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    try {
      return await withHostSlot(host, run);
    } catch (e) {
      if (!(e instanceof RetryableError) || attempt >= RETRIES) throw e;
      await sleep(1200 * 2 ** attempt + Math.random() * 500);
    }
  }
}

const fetchResult = <T>(url: string) => polite(url, () => fetchOnce<T>(url));

type Attempt<R> = { name: string; run: () => Promise<R> };

/** Tries each source in order until one succeeds; otherwise reports every failure. */
async function firstSuccess<R>(attempts: Attempt<R>[]): Promise<R> {
  if (!attempts.length) throw new NoSource("no data source for this network");
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      return await a.run();
    } catch (e) {
      if (e instanceof TooManyTxs) throw e;
      errors.push(`${a.name}: ${(e as Error).message}`);
    }
  }
  throw new Error(errors.join(" · "));
}

/** The wallet has too many transactions to page through: use event search instead. */
class TooManyTxs extends Error {}
/** This network has no source for that kind of query. */
class NoSource extends Error {}

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

function logParams(address: Address | undefined, topics: Topics, fromBlock: bigint) {
  // Explicit page size: Routescan returns only 100 logs otherwise, which would end the paging below early.
  const p = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: fromBlock.toString(), toBlock: "latest", page: "1", offset: String(PAGE) });
  if (address) p.set("address", address);
  const set = topics.map((t, i) => [t, i] as const).filter(([t]) => t);
  for (const [t, i] of set) p.set(`topic${i}`, t!);
  // Explorers need an explicit operator between each pair of topics.
  for (let a = 0; a < set.length; a++)
    for (let b = a + 1; b < set.length; b++) p.set(`topic${set[a][1]}_${set[b][1]}_opr`, "and");
  return p;
}

async function logsFromApi(url: (p: URLSearchParams) => string, address: Address | undefined, topics: Topics): Promise<ApiLog[]> {
  const out: ApiLog[] = [];
  const seen = new Set<string>();
  let from = 0n;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await fetchResult<RawLog>(url(logParams(address, topics, from)));
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
}

/** eth_getLogs over the whole history, on RPC nodes that allow it. */
async function logsFromRpc(rpc: string, address: Address | undefined, topics: Topics): Promise<ApiLog[]> {
  const call = (method: string, params: unknown[]) =>
    polite(rpc, async () => {
      const json = (await fetchJson(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })) as { result?: unknown; error?: { message?: string } };
      if (json.error) {
        const msg = json.error.message ?? "RPC error";
        // Busy / rate-limited nodes are worth a retry; other errors (range limits…) aren't.
        if (/temporar|rate|too many|busy|try again|capacity/i.test(msg)) throw new RetryableError(msg);
        throw new Error(msg);
      }
      return json.result;
    });
  const logs = (await call("eth_getLogs", [
    { fromBlock: "0x0", toBlock: "latest", address, topics: topics.map((t) => t ?? null) },
  ])) as { transactionHash: Hex; blockNumber: Hex; address: Address; topics: Hex[]; data: Hex }[];
  // RPC logs carry no timestamp: read the blocks' timestamps, 50 per batched request.
  const times = new Map<string, number>();
  const blocks = [...new Set(logs.map((l) => l.blockNumber))];
  for (let i = 0; i < blocks.length; i += 50) {
    const chunk = blocks.slice(i, i + 50);
    const replies = (await polite(rpc, () =>
      fetchJson(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(chunk.map((bn, id) => ({ jsonrpc: "2.0", id, method: "eth_getBlockByNumber", params: [bn, false] }))),
      }),
    )) as { id: number; result?: { timestamp: Hex } }[];
    if (!Array.isArray(replies)) throw new Error("RPC batch not supported");
    for (const r of replies) if (r.result) times.set(chunk[r.id], Number(BigInt(r.result.timestamp)));
  }
  if (times.size < blocks.length) throw new Error("missing block timestamps");
  return logs.map((l) => ({
    address: l.address.toLowerCase() as Address,
    topics: l.topics,
    data: l.data,
    transactionHash: l.transactionHash,
    blockNumber: BigInt(l.blockNumber),
    timestamp: times.get(l.blockNumber)!,
  }));
}

/** All logs of `address` (any contract if undefined) matching `topics`, over the chain's whole history. */
export function getLogs(net: ExplorerTarget, address: Address | undefined, topics: Topics): Promise<ApiLog[]> {
  const attempts: Attempt<ApiLog[]>[] = apiSources(net).map((src) => ({
    name: src.name,
    run: () => logsFromApi(src.url, address, topics),
  }));
  const rpcs = (net.logsRpcs ?? []).map((rpc) => ({ name: `rpc ${new URL(rpc).host}`, run: () => logsFromRpc(rpc, address, topics) }));
  return firstSuccess(net.preferRpc ? [...rpcs, ...attempts] : [...attempts, ...rpcs]);
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

/** Beyond this many transactions, event search is cheaper than paging through the wallet. */
const MAX_TX_PAGES = 3;

/**
 * Transactions `user` sent to one of `targets`, with their timestamps.
 * Uses the explorer's per-address index: usually a single request.
 */
export function getTxsTo(net: ExplorerTarget, user: Address, targets: Address[]): Promise<Map<Hex, number>> {
  const want = new Set(targets.map((t) => t.toLowerCase()));
  const me = user.toLowerCase();
  const keep = (found: Map<Hex, number>, from: string | undefined, to: string | null | undefined, ok: boolean, hash: string, ts: number) => {
    if (ok && from?.toLowerCase() === me && to && want.has(to.toLowerCase())) found.set(hash as Hex, ts);
  };

  const attempts: Attempt<Map<Hex, number>>[] = apiSources(net).map((src) => ({
    name: src.name,
    run: async () => {
      const found = new Map<Hex, number>();
      for (let page = 1; ; page++) {
        if (page > MAX_TX_PAGES) throw new TooManyTxs();
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
        for (const tx of raw)
          keep(found, tx.from, tx.to, tx.isError !== "1" && tx.txreceipt_status !== "0", tx.hash, Number(BigInt(tx.timeStamp)));
        if (raw.length < PAGE) return found;
      }
    },
  }));

  // First choice: Blockscout's v2 REST API, which returns only the transactions the user sent
  // (the older API also lists every incoming transfer, spam included).
  if (net.blockscout)
    attempts.unshift({
      name: `${new URL(net.blockscout).host} v2`,
      run: async () => {
        const found = new Map<Hex, number>();
        let next: Record<string, string | number> | null = {};
        for (let page = 0; next; page++) {
          if (page >= (MAX_TX_PAGES * PAGE) / 50) throw new TooManyTxs();
          const q = new URLSearchParams({ filter: "from" });
          for (const [k, v] of Object.entries(next)) q.set(k, String(v));
          const url = `${net.blockscout}/api/v2/addresses/${getAddress(user)}/transactions?${q}`;
          const json = (await polite(url, () => fetchJson(url))) as {
            items: { hash: string; from?: { hash: string }; to?: { hash: string } | null; status?: string; timestamp: string }[];
            next_page_params: Record<string, string | number> | null;
          };
          if (!Array.isArray(json?.items)) throw new Error("bad response");
          for (const tx of json.items)
            keep(found, tx.from?.hash, tx.to?.hash, tx.status !== "error", tx.hash, Math.floor(Date.parse(tx.timestamp) / 1000));
          next = json.next_page_params;
        }
        return found;
      },
    });
  return firstSuccess(attempts);
}

/* ───────────── Token transfers sent by an address ───────────── */

export interface TokenTransfer {
  hash: Hex;
  to: Address;
  timestamp: number;
}

interface RawTokenTx {
  hash: string;
  from: string;
  to: string;
  contractAddress: string;
  timeStamp: string;
}

/** Blockscout's v2 API returns 50 transfers per page. */
const MAX_TRANSFER_PAGES = 20;

/**
 * ERC-20 transfers of `token` sent by `user`, from the explorer's per-address index.
 * Unlike the transaction list, this also covers smart wallets and EIP-7702 accounts,
 * whose token moves happen inside transactions sent by someone else.
 */
export function getTokenTransfersFrom(net: ExplorerTarget, user: Address, token: Address): Promise<TokenTransfer[]> {
  const me = user.toLowerCase();
  const tok = token.toLowerCase();
  const attempts: Attempt<TokenTransfer[]>[] = apiSources(net).map((src) => ({
    name: src.name,
    run: async () => {
      const out: TokenTransfer[] = [];
      for (let page = 1; ; page++) {
        if (page > MAX_TX_PAGES) throw new TooManyTxs();
        const p = new URLSearchParams({
          module: "account",
          action: "tokentx",
          address: getAddress(user),
          contractaddress: getAddress(token),
          startblock: "0",
          endblock: "99999999999",
          page: String(page),
          offset: String(PAGE),
          sort: "asc",
        });
        // This list also has incoming transfers: keep the user's own.
        const raw = await fetchResult<RawTokenTx>(src.url(p));
        for (const t of raw)
          if (t.from?.toLowerCase() === me && t.contractAddress?.toLowerCase() === tok)
            out.push({ hash: t.hash as Hex, to: t.to.toLowerCase() as Address, timestamp: Number(BigInt(t.timeStamp)) });
        if (raw.length < PAGE) return out;
      }
    },
  }));
  // First choice: Blockscout's v2 REST API, which filters by direction and token itself.
  if (net.blockscout)
    attempts.unshift({
      name: `${new URL(net.blockscout).host} v2`,
      run: async () => {
        const out: TokenTransfer[] = [];
        let next: Record<string, string | number> | null = {};
        for (let page = 0; next; page++) {
          if (page >= MAX_TRANSFER_PAGES) throw new TooManyTxs();
          const q = new URLSearchParams({ type: "ERC-20", filter: "from", token: getAddress(token) });
          for (const [k, v] of Object.entries(next)) q.set(k, String(v));
          const url = `${net.blockscout}/api/v2/addresses/${getAddress(user)}/token-transfers?${q}`;
          const json = (await polite(url, () => fetchJson(url))) as {
            items: { transaction_hash: string; from?: { hash: string }; to?: { hash: string }; token?: { address_hash?: string; address?: string }; timestamp: string }[];
            next_page_params: Record<string, string | number> | null;
          };
          if (!Array.isArray(json?.items)) throw new Error("bad response");
          for (const t of json.items) {
            const tokenAddress = (t.token?.address_hash ?? t.token?.address)?.toLowerCase();
            if (t.from?.hash.toLowerCase() !== me || tokenAddress !== tok || !t.to?.hash) continue;
            out.push({ hash: t.transaction_hash as Hex, to: t.to.hash.toLowerCase() as Address, timestamp: Math.floor(Date.parse(t.timestamp) / 1000) });
          }
          next = json.next_page_params;
        }
        return out;
      },
    });
  return firstSuccess(attempts);
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
    // Very active wallet, or no transaction index available: search the bridges' events instead.
    try {
      const logs = (await Promise.all(opts.logs.map(([a, t]) => getLogs(net, a, t)))).flat();
      const m = new Map<Hex, number>();
      for (const l of logs) m.set(l.transactionHash, l.timestamp);
      return m;
    } catch (logErr) {
      if (txErr instanceof NoSource) throw logErr;
      const why = txErr instanceof TooManyTxs ? "very active wallet" : (txErr as Error).message;
      throw new Error(`${why} | events: ${(logErr as Error).message}`);
    }
  }
}
