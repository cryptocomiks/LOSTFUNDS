/**
 * A tiny in-memory stand-in for Blockscout, JSON-RPC nodes (incl. Multicall3) and
 * DefiLlama, so the checks can be exercised end-to-end without network access.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  multicall3Abi,
  numberToHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { L1, NETWORKS } from "../src/lib/networks.ts";
import { EVM_CHAINS } from "../src/lib/evm.ts";

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

interface StoredLog {
  chainId: number;
  address: Address;
  topics: Hex[];
  data: Hex;
  txHash: Hex;
  blockNumber: bigint;
  timestamp: number;
}

interface StoredTx {
  chainId: number;
  hash: Hex;
  from: Address;
  to: Address;
  timestamp: number;
  blockNumber: bigint;
  logs: StoredLog[];
  zk?: ZkReceiptFields;
}

/** ZK Stack receipt fields, and the node's zks_getL2ToL1LogProof answers. */
export interface ZkReceiptFields {
  /** null: the batch isn't sealed yet. */
  l1BatchNumber: bigint | null;
  l1BatchTxIndex: number;
  l2ToL1Logs: { sender: Address; key: Hex; value: Hex }[];
  /** Proof for each L2→L1 log, by index (missing or null: no proof yet). */
  proofs?: ({ id: number; proof: Hex[] } | null)[];
}

/** Thrown by a mock contract function to revert with this data (e.g. a custom error selector). */
export class MockRevert extends Error {
  constructor(public data: Hex) {
    super(`revert ${data}`);
  }
}

const STATIC_HOSTS = new Set([
  "raw.githubusercontent.com",
  "api.kamino.finance",
  "governance.1inch.io",
  "safe-claiming-app-data.safe.global",
  "lostfunds.vercel.app",
]);

type ContractFn = (args: readonly unknown[]) => unknown;

export class MockChain {
  logs: StoredLog[] = [];
  txs = new Map<string, StoredTx>();
  /** `${chainId}:${address}` → { abi, fns } */
  contracts = new Map<string, { abi: Abi; fns: Record<string, ContractFn> }>();
  prices: Record<string, number> = {};
  requests: string[] = [];
  /** Wormholescan: transactions by (lowercase) address, VAAs by id. */
  wormhole = { transactions: {} as Record<string, object[]>, vaas: {} as Record<string, { vaa: string; txHash?: string }> };
  /** deBridge API: listed orders and their details. */
  debridge = { orders: [] as Record<string, unknown>[], details: {} as Record<string, object> };
  /** Static JSON files served by URL (e.g. airdrop eligibility lists). */
  static: Record<string, unknown> = {};
  /** Solana accounts (base58 → raw data), missing = doesn't exist. */
  solana: Record<string, Uint8Array> = {};

  addTx(p: {
    chainId: number;
    hash: Hex;
    from: Address;
    to: Address;
    blockNumber: bigint;
    timestamp: number;
    logs: { address: Address; event: AbiEvent; args: Record<string, unknown> }[];
    zk?: ZkReceiptFields;
  }) {
    const logs = p.logs.map((l) => {
      const topics = encodeEventTopics({ abi: [l.event], eventName: l.event.name, args: l.args as never }) as Hex[];
      const nonIndexed = l.event.inputs.filter((i) => !i.indexed);
      const data = encodeAbiParameters(
        nonIndexed,
        nonIndexed.map((i) => l.args[i.name!]),
      );
      return {
        chainId: p.chainId,
        address: l.address.toLowerCase() as Address,
        topics,
        data,
        txHash: p.hash,
        blockNumber: p.blockNumber,
        timestamp: p.timestamp,
      };
    });
    this.logs.push(...logs);
    this.txs.set(`${p.chainId}:${p.hash}`, {
      chainId: p.chainId,
      hash: p.hash,
      from: p.from,
      to: p.to,
      timestamp: p.timestamp,
      blockNumber: p.blockNumber,
      logs,
      zk: p.zk,
    });
  }

  addContract(chainId: number, address: Address, abi: Abi, fns: Record<string, ContractFn>) {
    this.contracts.set(`${chainId}:${address.toLowerCase()}`, { abi, fns });
  }

  private call(chainId: number, to: string, data: Hex): { ok: boolean; data: Hex } {
    const c = this.contracts.get(`${chainId}:${to.toLowerCase()}`);
    if (!c) return { ok: false, data: "0x" };
    try {
      const { functionName, args } = decodeFunctionData({ abi: c.abi, data });
      const fn = c.fns[functionName];
      if (!fn) return { ok: false, data: "0x" };
      const result = fn(args ?? []);
      return { ok: true, data: encodeFunctionResult({ abi: c.abi, functionName, result } as never) };
    } catch (e) {
      return { ok: false, data: e instanceof MockRevert ? e.data : "0x" };
    }
  }

  private rpc(chainId: number, req: { id: number; method: string; params: unknown[] }) {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (data: Hex) => ({ jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted", data } });
    switch (req.method) {
      case "eth_chainId":
        return reply(numberToHex(chainId));
      case "eth_blockNumber":
        return reply(numberToHex(30_000_000));
      case "eth_getTransactionReceipt": {
        const tx = this.txs.get(`${chainId}:${req.params[0]}`);
        if (!tx) return reply(null);
        return reply({
          transactionHash: tx.hash,
          transactionIndex: "0x0",
          blockHash: "0x" + "ab".repeat(32),
          blockNumber: numberToHex(tx.blockNumber),
          from: tx.from,
          to: null,
          cumulativeGasUsed: "0x1",
          gasUsed: "0x1",
          effectiveGasPrice: "0x1",
          contractAddress: null,
          logsBloom: "0x" + "00".repeat(256),
          status: "0x1",
          type: "0x2",
          logs: tx.logs.map((l, i) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            logIndex: numberToHex(i),
            blockNumber: numberToHex(tx.blockNumber),
            blockHash: "0x" + "ab".repeat(32),
            transactionHash: tx.hash,
            transactionIndex: "0x0",
            removed: false,
          })),
          ...(tx.zk && {
            l1BatchNumber: tx.zk.l1BatchNumber === null ? null : numberToHex(tx.zk.l1BatchNumber),
            l1BatchTxIndex: tx.zk.l1BatchNumber === null ? null : numberToHex(tx.zk.l1BatchTxIndex),
            l2ToL1Logs: tx.zk.l2ToL1Logs.map((l, i) => ({
              ...l,
              logIndex: numberToHex(i),
              transactionIndex: "0x0", // index in the block, not in the batch
              transactionHash: tx.hash,
              isService: true,
              shardId: "0x0",
            })),
          }),
        });
      }
      case "zks_getL2ToL1LogProof": {
        const [hash, index] = req.params as [Hex, number];
        return reply(this.txs.get(`${chainId}:${hash}`)?.zk?.proofs?.[index] ?? null);
      }
      case "eth_call": {
        const { to, data } = req.params[0] as { to: string; data: Hex };
        if (to.toLowerCase() === MULTICALL3) {
          const { args } = decodeFunctionData({ abi: multicall3Abi, data });
          const calls = args[0] as readonly { target: Address; callData: Hex }[];
          const results = calls.map((c) => {
            const r = this.call(chainId, c.target, c.callData);
            return { success: r.ok, returnData: r.data };
          });
          return reply(encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results }));
        }
        const r = this.call(chainId, to, data);
        return r.ok ? reply(r.data) : fail(r.data);
      }
      case "eth_getLogs": {
        const f = req.params[0] as { address: string; topics: (string | null)[] };
        const logs = this.logs.filter(
          (l) =>
            l.chainId === chainId &&
            (!f.address || l.address === f.address.toLowerCase()) &&
            f.topics.every((t, i) => !t || l.topics[i]?.toLowerCase() === t.toLowerCase()),
        );
        return reply(
          logs.map((l) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            transactionHash: l.txHash,
            blockNumber: numberToHex(l.blockNumber),
          })),
        );
      }
      case "eth_getBlockByNumber": {
        const bn = BigInt(req.params[0] as string);
        const log = this.logs.find((l) => l.chainId === chainId && l.blockNumber === bn);
        return reply({ number: numberToHex(bn), timestamp: numberToHex(log?.timestamp ?? 0) });
      }
      default:
        return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock: ${req.method} not supported` } };
    }
  }

  private explorer(chainId: number, url: URL) {
    const q = url.searchParams;
    if (q.get("action") === "txlist") {
      const me = q.get("address")!.toLowerCase();
      const result = [...this.txs.values()]
        .filter((t) => t.chainId === chainId && (t.from.toLowerCase() === me || t.to.toLowerCase() === me))
        .map((t) => ({
          hash: t.hash,
          from: t.from.toLowerCase(),
          to: t.to.toLowerCase(),
          isError: "0",
          txreceipt_status: "1",
          timeStamp: String(t.timestamp),
          blockNumber: String(t.blockNumber),
        }));
      if (!result.length) return { status: "0", message: "No transactions found", result: [] };
      return { status: "1", message: "OK", result };
    }
    const address = q.get("address")!.toLowerCase();
    const topics = [0, 1, 2, 3].map((i) => q.get(`topic${i}`)?.toLowerCase());
    const result = this.logs
      .filter(
        (l) =>
          l.chainId === chainId &&
          l.address === address &&
          topics.every((t, i) => !t || l.topics[i]?.toLowerCase() === t),
      )
      .map((l) => ({
        address: l.address,
        topics: [...l.topics, ...Array(4 - l.topics.length).fill(null)],
        data: l.data,
        transactionHash: l.txHash,
        blockNumber: numberToHex(l.blockNumber),
        timeStamp: numberToHex(l.timestamp),
        logIndex: "0x0",
      }));
    if (!result.length) return { status: "0", message: "No logs found", result: [] };
    return { status: "1", message: "OK", result };
  }

  /** A drop-in `fetch`. */
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    this.requests.push(url.href);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
        headers: { "content-type": "application/json" },
      });

    if (url.host === "coins.llama.fi") {
      const keys = url.pathname.split("/").pop()!.split(",");
      const coins: Record<string, { price: number }> = {};
      for (const k of keys) if (this.prices[k]) coins[k] = { price: this.prices[k] };
      return json({ coins });
    }

    // Static files and simple JSON APIs, served by URL.
    const hit = this.static[url.href];
    if (hit !== undefined) return typeof hit === "string" ? new Response(hit) : json(hit);
    if (STATIC_HOSTS.has(url.host)) return new Response('{"error":"not found"}', { status: 404 });
    if (url.host === "api.wormholescan.io") {
      const tx = url.pathname.match(/^\/api\/v1\/transactions$/);
      if (tx) return json({ transactions: this.wormhole.transactions[(url.searchParams.get("address") ?? "").toLowerCase()] ?? [] });
      const vaa = url.pathname.match(/^\/api\/v1\/vaas\/(.+)$/);
      if (vaa && this.wormhole.vaas[vaa[1]]) return json({ data: this.wormhole.vaas[vaa[1]] });
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    }
    if (url.host === "stats-api.dln.trade") {
      if (url.pathname === "/api/Orders/filteredList") {
        const b = JSON.parse(String(init?.body)) as { giveChainIds?: number[]; takeChainIds?: number[]; orderStates?: string[]; filter?: string };
        const chain = (o: Record<string, unknown>, k: string) => Number((o[k] as { chainId: { stringValue: string } }).chainId.stringValue);
        const orders = this.debridge.orders.filter(
          (o) =>
            (!b.giveChainIds || b.giveChainIds.includes(chain(o, "giveOfferWithMetadata"))) &&
            (!b.takeChainIds || b.takeChainIds.includes(chain(o, "takeOfferWithMetadata"))) &&
            (!b.orderStates || b.orderStates.includes(o.state as string)),
        );
        return json({ orders, totalCount: orders.length });
      }
      const d = url.pathname.match(/^\/api\/Orders\/(0x[0-9a-f]+)$/i);
      if (d && this.debridge.details[d[1]]) return json(this.debridge.details[d[1]]);
      return new Response("{}", { status: 404 });
    }
    if (url.host === "iris-api.circle.com") return new Response(JSON.stringify({ error: "Message not found" }), { status: 404 });
    if (url.host === "solana-rpc.publicnode.com" || url.host === "api.mainnet-beta.solana.com") {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [string[]] };
      if (body.method !== "getMultipleAccounts") return json({ jsonrpc: "2.0", id: body.id, error: { message: "unsupported" } });
      const b64 = (d: Uint8Array) => btoa(String.fromCharCode(...d));
      const value = body.params[0].map((k) => (this.solana[k] ? { data: [b64(this.solana[k]), "base64"] } : null));
      return json({ jsonrpc: "2.0", id: body.id, result: { context: { slot: 1 }, value } });
    }
    if (url.href.startsWith("https://gateway.tenderly.co/public/polygon") || url.host === "polygon-bor-rpc.publicnode.com") {
      const body = JSON.parse(String(init?.body));
      const out = Array.isArray(body) ? body.map((r) => this.rpc(137, r)) : this.rpc(137, body);
      return json(out);
    }
    if (url.host === "proof-generator.polygon.technology") return new Response(JSON.stringify({ error: true, message: "Burn transaction has not been checkpointed yet" }), { status: 404 });

    const scout = [...NETWORKS, { ...L1, id: "l1" }].find((n) => n.blockscout && new URL(n.blockscout).host === url.host);
    if (scout && url.pathname === "/api") return json(this.explorer(scout.chain.id, url));
    const api = NETWORKS.find((n) => n.api && url.href.startsWith(`${n.api}/api?`));
    if (api) return json(this.explorer(api.chain.id, url));
    const v2 = scout && url.pathname.match(/^\/api\/v2\/addresses\/(0x[0-9a-fA-F]{40})\/transactions$/);
    if (scout && v2) {
      const me = v2[1].toLowerCase();
      const items = [...this.txs.values()]
        .filter((t) => t.chainId === scout.chain.id && t.from.toLowerCase() === me)
        .map((t) => ({
          hash: t.hash,
          from: { hash: t.from },
          to: { hash: t.to },
          status: "ok",
          timestamp: new Date(t.timestamp * 1000).toISOString(),
        }));
      return json({ items, next_page_params: null });
    }

    const rpcNet = [...NETWORKS, L1].find((n) =>
      [...n.rpcs, ...(("logsRpcs" in n && n.logsRpcs) || [])].some((r) => r && r.replace(/\/$/, "") === url.href.replace(/\/$/, "")),
    );
    const rpcChain = rpcNet?.chain.id ?? EVM_CHAINS.find((c) => c.rpcs.some((r) => r.replace(/\/$/, "") === url.href.replace(/\/$/, "")))?.id;
    if (rpcChain) {
      const body = JSON.parse(String(init?.body));
      const out = Array.isArray(body) ? body.map((r) => this.rpc(rpcChain, r)) : this.rpc(rpcChain, body);
      return json(out);
    }
    return new Response("not found", { status: 404 });
  };
}
