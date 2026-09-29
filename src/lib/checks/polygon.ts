import {
  createPublicClient,
  encodeFunctionData,
  fallback,
  fromRlp,
  hexToBigInt,
  http,
  isAddressEqual,
  parseAbi,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";
import { l1Client } from "../clients";
import { addressTopic, getLogs, type ExplorerTarget } from "../explorer";
import { ethAsset, mapLimit, tokenAsset } from "../tokens";
import { makeFinding, type CheckOutput, type FindingSource } from "./common";

/**
 * Polygon PoS bridge: tokens burned on Polygon to withdraw to Ethereum, whose exit was
 * never processed on Ethereum.
 *
 *  1. Burns: ERC20 Transfer(user → 0x0) on Polygon, from the whole history.
 *  2. Only tokens mapped by the PoS bridge (RootChainManager.childToRootToken ≠ 0).
 *  3. Exit proofs from Polygon's official proof generator: one per burn in the transaction, each
 *     naming the exact log it proves (decoded here, so a proof is only used for its own burn).
 *  4. Status: simulate RootChainManager.exit(proof) on Ethereum.
 *     "EXIT_ALREADY_PROCESSED" → claimed; "EXIT_DISABLED" → not a withdrawal (USDT0 sends burn USDT
 *     too); success → the funds are waiting.
 *
 * Not covered: native POL / MATIC withdrawals (Plasma bridge).
 */

export const POLYGON: FindingSource = { id: "polygon", name: "Polygon PoS", guideId: "polygon-pos", explorer: "https://polygonscan.com" };

const ROOT_CHAIN_MANAGER: Address = "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77";
/** childToRootToken of Polygon's WETH: ETH itself, released by the EtherPredicate. */
const ROOT_ETH: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const TRANSFER = toEventSelector("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO_TOPIC = `0x${"0".repeat(64)}` as Hex;
const PROOF_API = "https://proof-generator.polygon.technology/api/v1/matic";

const POLYGON_TARGET: ExplorerTarget = {
  name: "Polygon",
  chain: polygon,
  // Polygon's Blockscout index is incomplete, so it isn't used: a miss there would be silent.
  blockscout: undefined,
  // The only keyless node that searches Polygon's whole history (checked 2026-09: publicnode, dRPC,
  // QuickNode, Tatum cap the block range; the others need a key or are gone).
  logsRpcs: ["https://gateway.tenderly.co/public/polygon"],
  // Tenderly drops the archive part of a query that also covers its last ~500 blocks when that part
  // fails: search the last hours on their own so a failure is reported, never silently missed.
  logsTail: 5_000,
  // Timestamps come from the exit proofs, for the few burns kept (Tenderly rate-limits big batches).
  noTimestamps: true,
};

const rcmAbi = parseAbi([
  "function childToRootToken(address) view returns (address)",
  "function migrationStatus(address) view returns (bool isDepositDisabled, bool isExitDisabled, uint256 lastExitBlockNumber)",
  "function exit(bytes inputData)",
]);

let polygonClient: ReturnType<typeof createPublicClient> | undefined;
const polygonRpc = () =>
  (polygonClient ??= createPublicClient({
    chain: polygon,
    transport: fallback([http("https://polygon-bor-rpc.publicnode.com"), http("https://gateway.tenderly.co/public/polygon")]),
  }));

/** The burn an exit payload proves (payload layout from Polygon's maticjs `buildPayloadForExit`). */
export function decodeExitPayload(payload: Hex): {
  log: { address: Address; topics: Hex[]; data: Hex };
  logIndex: number;
  blockNumber: bigint;
  timestamp: number;
} {
  const items = fromRlp(payload, "hex") as Hex[];
  let receipt = items[6];
  // Typed receipts (EIP-2718) start with their type byte.
  if (parseInt(receipt.slice(2, 4), 16) < 0xc0) receipt = `0x${receipt.slice(4)}`;
  const logs = (fromRlp(receipt, "hex") as unknown as [Hex, Hex, Hex, [Hex, Hex[], Hex][]])[3];
  const logIndex = items[9] === "0x" ? 0 : Number(hexToBigInt(items[9]));
  const [address, topics, data] = logs[logIndex];
  const int = (h: Hex) => (h === "0x" ? 0n : hexToBigInt(h));
  return { log: { address, topics, data }, logIndex, blockNumber: int(items[2]), timestamp: Number(int(items[3])) };
}

/** Exit payloads for every burn in a transaction, or "waiting" before its checkpoint. */
async function exitPayloads(burnTx: Hex): Promise<Hex[] | "waiting" | { error: string }> {
  const url = `${PROOF_API}/all-exit-payloads/${burnTx}?eventSignature=${TRANSFER}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let body: { result?: Hex[]; message?: string } = {};
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      body = await res.json().catch(() => ({}));
    } catch {
      /* network error / timeout: retried below */
    }
    if (res?.ok && Array.isArray(body.result)) return body.result;
    const msg = body.message ?? (res ? `HTTP ${res.status}` : "no answer");
    if (/checkpoint/i.test(msg)) return "waiting";
    if (res && res.status < 500 && res.status !== 429) return { error: msg };
    // Busy or down: retry, then give up loudly rather than guess.
    if (attempt >= 2) throw new Error(`Polygon proof generator: ${msg}`);
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
}

type ExitState = { kind: "claimed" } | { kind: "ready" } | { kind: "disabled" } | { kind: "unknown"; why: string };

async function simulateExit(payload: Hex, from: Address): Promise<ExitState> {
  try {
    await l1Client().call({
      account: from,
      to: ROOT_CHAIN_MANAGER,
      data: encodeFunctionData({ abi: rcmAbi, functionName: "exit", args: [payload] }),
    });
    return { kind: "ready" };
  } catch (e) {
    const text = JSON.stringify((e as { cause?: unknown }).cause ?? e) + String((e as Error).message);
    if (/EXIT_ALREADY_PROCESSED/.test(text)) return { kind: "claimed" };
    if (/EXIT_DISABLED/.test(text)) return { kind: "disabled" };
    // No answer from Ethereum (as opposed to a revert): fail the check instead of guessing.
    if (!/revert/i.test(text)) throw e;
    return { kind: "unknown", why: (e as { shortMessage?: string }).shortMessage ?? "simulation failed" };
  }
}

export async function checkPolygon(user: Address): Promise<CheckOutput> {
  const me = addressTopic(user);
  // ERC20 burns by the user (3 topics; ERC721 transfers have 4).
  const isBurn = (l: { topics: Hex[]; data: Hex }) => {
    const [sig, from, to] = l.topics.map((t) => t.toLowerCase());
    return l.topics.length === 3 && sig === TRANSFER && from === me && to === ZERO_TOPIC && l.data.length === 66;
  };
  const logs = (await getLogs(POLYGON_TARGET, undefined, [TRANSFER, me, ZERO_TOPIC])).filter(isBurn);

  // Keep tokens mapped by the PoS bridge, and note the ones whose exits were switched off
  // (USDT since its USDT0 migration: later burns are LayerZero sends, not withdrawals).
  const children = [...new Set(logs.map((l) => l.address.toLowerCase() as Address))];
  const roots = new Map<string, Address>();
  const lastExitBlock = new Map<string, bigint>();
  await Promise.all(
    children.map(async (c) => {
      const root = await l1Client().readContract({ address: ROOT_CHAIN_MANAGER, abi: rcmAbi, functionName: "childToRootToken", args: [c] });
      if (isAddressEqual(root, zeroAddress)) return;
      roots.set(c, root);
      const [, exitDisabled, lastBlock] = await l1Client().readContract({
        address: ROOT_CHAIN_MANAGER,
        abi: rcmAbi,
        functionName: "migrationStatus",
        args: [root],
      });
      if (exitDisabled) lastExitBlock.set(c, lastBlock);
    }),
  );
  /** A burn by the user of a PoS-bridged token that can still exit. */
  const exitable = (l: { address: Address; topics: Hex[]; data: Hex }, block: bigint) => {
    const c = l.address.toLowerCase();
    const last = lastExitBlock.get(c);
    return isBurn(l) && roots.has(c) && (last === undefined || block <= last);
  };
  const burns = logs.filter((l) => exitable(l, l.blockNumber));
  const txs = new Map<Hex, typeof burns>();
  for (const l of burns) txs.set(l.transactionHash, [...(txs.get(l.transactionHash) ?? []), l]);
  const blockTime = async (block: bigint) => Number((await polygonRpc().getBlock({ blockNumber: block })).timestamp);

  const out: CheckOutput = { findings: [], completed: 0 };
  const asset = (child: string, amount: bigint) => {
    const root = roots.get(child.toLowerCase())!;
    if (isAddressEqual(root, ROOT_ETH)) return ethAsset(amount);
    return tokenAsset([l1Client(), polygonRpc() as never], root, amount, "ethereum");
  };
  const add = async (txHash: Hex, key: string, child: string, amount: bigint, timestamp: number, status: "ready" | "recent" | "manual", note: string) =>
    out.findings.push(
      makeFinding(POLYGON, { key, label: "Polygon PoS → Ethereum", status, asset: await asset(child, amount), txHash, timestamp, note }),
    );

  await mapLimit([...txs], 3, async ([txHash, mine]) => {
    const payloads = await exitPayloads(txHash);
    if (payloads === "waiting" || "error" in payloads) {
      const timestamp = await blockTime(mine[0].blockNumber);
      for (const [i, l] of mine.entries())
        await add(
          txHash,
          `burn-${i}`,
          l.address,
          hexToBigInt(l.data),
          timestamp,
          payloads === "waiting" ? "recent" : "manual",
          payloads === "waiting"
            ? "Waiting for the next Polygon checkpoint on Ethereum (usually under 3 hours)."
            : `Couldn't build its exit proof (${payloads.error}). Check it in the Polygon Portal.`,
        );
      return;
    }
    // Each proof names the log it proves: keep the ones proving this user's burns.
    const exits = payloads.map((p) => ({ payload: p, ...decodeExitPayload(p) })).filter((x) => exitable(x.log, x.blockNumber));
    if (exits.length !== mine.length) throw new Error(`exit proofs don't match the burns in ${txHash}`);
    for (const x of exits) {
      const state = await simulateExit(x.payload, user);
      if (state.kind === "claimed") out.completed++;
      if (state.kind === "claimed" || state.kind === "disabled") continue;
      await add(
        txHash,
        String(x.logIndex),
        x.log.address,
        hexToBigInt(x.log.data),
        x.timestamp,
        state.kind === "ready" ? "ready" : "manual",
        state.kind === "ready"
          ? "Burned on Polygon but never exited on Ethereum. Claim it in the Polygon Portal."
          : `Couldn't confirm its status automatically (${state.why}). Check it in the Polygon Portal.`,
      );
    }
  });
  return out;
}
