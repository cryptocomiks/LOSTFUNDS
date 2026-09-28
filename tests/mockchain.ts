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
  blockNumber: bigint;
  logs: StoredLog[];
}

type ContractFn = (args: readonly unknown[]) => unknown;

export class MockChain {
  logs: StoredLog[] = [];
  txs = new Map<string, StoredTx>();
  /** `${chainId}:${address}` → { abi, fns } */
  contracts = new Map<string, { abi: Abi; fns: Record<string, ContractFn> }>();
  prices: Record<string, number> = {};
  requests: string[] = [];

  addTx(p: {
    chainId: number;
    hash: Hex;
    from: Address;
    blockNumber: bigint;
    timestamp: number;
    logs: { address: Address; event: AbiEvent; args: Record<string, unknown> }[];
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
    this.txs.set(`${p.chainId}:${p.hash}`, { chainId: p.chainId, hash: p.hash, from: p.from, blockNumber: p.blockNumber, logs });
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
    } catch {
      return { ok: false, data: "0x" };
    }
  }

  private rpc(chainId: number, req: { id: number; method: string; params: unknown[] }) {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
    const fail = (message: string) => ({ jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted", data: "0x" + message } });
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
        });
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
        return r.ok ? reply(r.data) : fail("");
      }
      default:
        return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `mock: ${req.method} not supported` } };
    }
  }

  private blockscout(chainId: number, url: URL) {
    const q = url.searchParams;
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

    const scout = [...NETWORKS, { ...L1, id: "l1" }].find((n) => new URL(n.blockscout).host === url.host);
    if (scout && url.pathname === "/api") return json(this.blockscout(scout.chain.id, url));

    const rpcNet = [...NETWORKS, L1].find((n) => n.rpcs.some((r) => r.replace(/\/$/, "") === url.href.replace(/\/$/, "")));
    if (rpcNet) {
      const body = JSON.parse(String(init?.body));
      const out = Array.isArray(body) ? body.map((r) => this.rpc(rpcNet.chain.id, r)) : this.rpc(rpcNet.chain.id, body);
      return json(out);
    }
    return new Response("not found", { status: 404 });
  };
}
